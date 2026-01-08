import os
from typing import Dict, List, Callable, Annotated, TypedDict, Any
from pydantic import BaseModel, Field

from langgraph.graph import StateGraph, END, START
from langgraph.prebuilt import ToolNode
from langchain_core.messages import SystemMessage, HumanMessage, AIMessage, ToolMessage
from fastapi.encoders import jsonable_encoder

from tavily import TavilyClient
from app.core.deps import get_llm_client_agent
from .tools import get_proprietary_tools_for_sources, PROPRIETARY_TOOLS_MAP
import logging

logger = logging.getLogger(__name__)


# =========================================================
# 1. CLIENTS
# =========================================================

llm = get_llm_client_agent()
# tavily = TavilyClient(api_key=os.environ["TAVILY_API_KEY"])


# =========================================================
# 2. MODELS
# =========================================================

class ResearchSignals(BaseModel):
    facts: List[str] = Field(default_factory=list)
    statistics: List[str] = Field(default_factory=list)
    trends: List[str] = Field(default_factory=list)
    risks: List[str] = Field(default_factory=list)
    opportunities: List[str] = Field(default_factory=list)
    citations: List[str] = Field(default_factory=list)


def merge_tool_results(
    left: Dict[str, Dict[str, ResearchSignals]],
    right: Dict[str, Dict[str, ResearchSignals]],
) -> Dict[str, Dict[str, ResearchSignals]]:
    merged = dict(left)
    for area, tools in right.items():
        merged.setdefault(area, {})
        merged[area].update(tools)
    return merged


class GraphState(BaseModel):
    input: dict

    tool_results: Annotated[
        Dict[str, Dict[str, ResearchSignals]],
        merge_tool_results
    ] = Field(default_factory=dict)


# =========================================================
# 3. SYSTEM PROMPT
# =========================================================

SYSTEM_PROMPT = """
You are a market intelligence research agent.

TASK:
Extract STRUCTURED market intelligence signals.

RULES:
- Output MUST follow the schema exactly
- No prose or explanations
- Best-effort, factual, professional intelligence
"""


# =========================================================
# 4. LLM CALL
# =========================================================

def call_llm(prompt: str) -> ResearchSignals:
    structured_llm = llm.with_structured_output(ResearchSignals)
    return structured_llm.invoke(
        [
            SystemMessage(content=SYSTEM_PROMPT),
            HumanMessage(content=prompt),
        ]
    )


# =========================================================
# 5. PROMPT BUILDERS
# =========================================================

def pwc_document_prompt(input_data: dict) -> str:
    pwc = input_data["pwc_content"]
    return f"""
Analyze the following internal document and extract market intelligence.

DOCUMENT:
{pwc["supportingDoc"]}

INSTRUCTIONS:
{pwc.get("supportingDoc_instructions", "")}
"""


def generic_tool_prompt(tool_name: str, input_data: dict) -> str:
    return f"""
SOURCE: {tool_name}
TOPIC: {input_data.get("research_topics")}
GUIDELINES: {input_data.get("research_guidelines")}
"""


# =========================================================
# 6. GENERIC TOOL NODE (LLM-ONLY)
# =========================================================

def make_llm_tool_node(
    area: str,
    tool_name: str,
    prompt_builder: Callable[[dict], str],
):
    def node(state: GraphState) -> dict:
        signals = call_llm(prompt_builder(state.input))
        return {
            "tool_results": {
                area: {
                    tool_name: signals
                }
            }
        }

    return node


# =========================================================
# 7. PROPRIETARY AGENT NODE
# =========================================================

PROPRIETARY_AGENT_PROMPT = """You are a proprietary research agent that searches PwC proprietary sources.

Your task:
1. Analyze the research topic and guidelines provided
2. Call ALL available proprietary source tools to gather comprehensive information
3. Each tool requires:
   - query: The research topic
   - guidelines: The research guidelines

IMPORTANT:
- You MUST call ALL available tools to get complete research coverage
- Use the same query and guidelines for all tools
- Process all tool results systematically

Research Topic: {research_topics}
Research Guidelines: {research_guidelines}
Available Sources: {selected_sources}
"""


def proprietary_agent_node(state: GraphState) -> dict:
    """
    Proprietary agent node that:
    1. Parses research_topics, research_guidelines, and proprietary.sources from input
    2. Creates a proprietary agent with only selected source tools
    3. Agent processes and calls tools based on user selection
    4. Converts tool results to ResearchSignals format
    5. Returns results in format that graph.py will merge automatically
    """
    # Parse input
    research_topics = state.input.get("research_topics", "")
    research_guidelines = state.input.get("research_guidelines", "")
    
    # Get proprietary configuration
    proprietary_config = state.input.get("proprietary", {})
    is_selected = proprietary_config.get("isSelected", False)
    
    if not is_selected:
        logger.info("[Proprietary Agent] isSelected is False, skipping")
        return {
            "tool_results": {
                "proprietary": {}
            }
        }
    
    # Get selected sources array
    selected_sources = proprietary_config.get("sources", [])
    
    if not selected_sources:
        logger.warning("[Proprietary Agent] isSelected is True but sources array is empty")
        return {
            "tool_results": {
                "proprietary": {}
            }
        }
    
    logger.info(f"[Proprietary Agent] Processing {len(selected_sources)} sources")
    logger.info(f"[Proprietary Agent] Research Topics: {research_topics}")
    logger.info(f"[Proprietary Agent] Research Guidelines: {research_guidelines}")
    logger.info(f"[Proprietary Agent] Selected Sources: {selected_sources}")
    
    # Get tools for selected sources only
    available_tools = get_proprietary_tools_for_sources(selected_sources)
    
    if not available_tools:
        logger.error("[Proprietary Agent] No tools available for selected sources")
        return {
            "tool_results": {
                "proprietary": {}
            }
        }
    
    # Build system prompt
    tool_names = [tool.name for tool in available_tools]
    system_prompt = PROPRIETARY_AGENT_PROMPT.format(
        research_topics=research_topics,
        research_guidelines=research_guidelines,
        selected_sources=", ".join(selected_sources)
    )
    
    # Create initial messages for agent
    messages = [
        SystemMessage(content=system_prompt),
        HumanMessage(content=f"""
Please search ALL available proprietary sources for the following research:

Research Topic: {research_topics}
Research Guidelines: {research_guidelines}

Call each available tool to gather comprehensive information from all selected sources.
Use the same query and guidelines for all tools.
""")
    ]
    
    # Build and run proprietary agent graph
    agent_graph = _build_proprietary_agent_graph(available_tools)
    
    try:
        # Execute agent graph
        agent_state = {"messages": messages}
        final_state = agent_graph.invoke(agent_state)
        
        # Extract tool results from agent execution
        results = {}
        
        # Get all AI messages with tool calls
        ai_messages = [msg for msg in final_state["messages"] if isinstance(msg, AIMessage)]
        tool_messages = [msg for msg in final_state["messages"] if isinstance(msg, ToolMessage)]
        
        # Create mapping of tool_call_id to tool_name
        tool_call_to_name = {}
        for ai_msg in ai_messages:
            if hasattr(ai_msg, 'tool_calls') and ai_msg.tool_calls:
                for tool_call in ai_msg.tool_calls:
                    tool_call_id = tool_call.get('id', '')
                    tool_name = tool_call.get('name', '')
                    tool_call_to_name[tool_call_id] = tool_name
        
        # Map tool messages to source names
        tool_result_map = {}
        for tool_msg in tool_messages:
            tool_call_id = tool_msg.tool_call_id
            tool_name = tool_call_to_name.get(tool_call_id, '')
            if tool_name:
                tool_result_map[tool_name] = tool_msg.content
        
        # Convert each tool result to ResearchSignals
        # Map tool names (which match source names exactly) to source names
        # Tool names are set to match source names exactly via @tool(name="...")
        # Only process tools that are in the selected sources list (no duplicates)
        processed_sources = set()  # Track processed sources to avoid duplicates
        
        for tool_name, tool_result_content in tool_result_map.items():
            # Tool name matches source name exactly, so use it directly
            source_name = tool_name
            
            # Validate: Only process if source is in selected sources list
            if source_name not in selected_sources:
                logger.warning(f"[Proprietary Agent] Tool {source_name} not in selected sources, skipping")
                continue
            
            # Check for duplicates
            if source_name in processed_sources:
                logger.warning(f"[Proprietary Agent] Duplicate tool result for {source_name}, skipping")
                continue
            
            processed_sources.add(source_name)
            
            # Build prompt to extract ResearchSignals from tool result
            prompt = f"""
Analyze the following proprietary source research data and extract market intelligence signals.

SOURCE: {source_name}
RESEARCH TOPIC: {research_topics}
RESEARCH GUIDELINES: {research_guidelines}

TOOL RESULT DATA:
{tool_result_content}

Extract structured market intelligence signals:
- facts: Key factual information
- statistics: Numerical data, metrics, percentages
- trends: Emerging patterns, directional changes
- risks: Potential threats, concerns, challenges
- opportunities: Growth areas, potential benefits
- citations: Source references, URLs, document links

Output MUST follow the ResearchSignals schema exactly.
"""
            
            # Use LLM to extract structured signals
            signals = call_llm(prompt)
            results[source_name] = signals
            
            logger.info(f"[Proprietary Agent] Processed {source_name}")
        
        logger.info(f"[Proprietary Agent] Completed. Results for {len(results)} sources")
        
        # Return in format that graph.py will merge automatically
        # The merge_tool_results function will merge this with results from other nodes
        return {
            "tool_results": {
                "proprietary": results
            }
        }
        
    except Exception as e:
        logger.error(f"[Proprietary Agent] Error: {e}", exc_info=True)
        return {
            "tool_results": {
                "proprietary": {}
            }
        }


def _build_proprietary_agent_graph(tools: List):
    """Build LangGraph for proprietary agent with tool calling."""
    
    class AgentState(TypedDict):
        messages: Annotated[List, lambda x, y: x + y]
    
    graph = StateGraph(AgentState)
    
    # Agent node - decides which tools to call
    def agent_node(state: AgentState) -> Dict[str, Any]:
        llm_with_tools = llm.bind_tools(tools)
        messages = state["messages"]
        response = llm_with_tools.invoke(messages)
        return {"messages": [response]}
    
    # Tools node - executes tool calls
    tool_node = ToolNode(tools)
    
    # Should continue function - checks if more tool calls needed
    def should_continue(state: AgentState) -> str:
        last_message = state["messages"][-1]
        if hasattr(last_message, "tool_calls") and last_message.tool_calls:
            return "continue"
        return "end"
    
    # Build graph
    graph.add_node("agent", agent_node)
    graph.add_node("tools", tool_node)
    
    graph.set_entry_point("agent")
    
    graph.add_conditional_edges(
        "agent",
        should_continue,
        {
            "continue": "tools",
            "end": END
        }
    )
    
    graph.add_edge("tools", "agent")
    
    return graph.compile()


# =========================================================
# 8. TAVILY TOOL NODE (REAL EXTERNAL SEARCH)
# =========================================================

def tavily_tool_node(state: GraphState) -> dict:
    query = state.input.get("research_topics")
    guidelines = state.input.get("research_guidelines", "")

    response = tavily.search(
        query=query,
        search_depth="advanced",
        max_results=5,
    )

    contents = [
        r.get("content", "")
        for r in response.get("results", [])
        if r.get("content")
    ]

    prompt = f"""
Analyze the following external web research content.

GUIDELINES:
{guidelines}

CONTENT:
{chr(10).join(contents)}
"""

    signals = call_llm(prompt)

    return {
        "tool_results": {
            "externalResearch": {
                "tavily": signals
            }
        }
    }


# =========================================================
# 9. ROUTER
# =========================================================

def router_node(state: GraphState) -> dict:
    return {}


def router_decision(state: GraphState) -> List[str]:
    routes = []

    # Check pwc_content selection
    pwc_content_selected = state.input.get("pwc_content", {}).get("isSelected", False)
    if pwc_content_selected:
        routes.append("pwc_document")
        # Auto-select proprietary if pwc_content is selected
        proprietary_config = state.input.get("proprietary", {})
        if not proprietary_config.get("isSelected", False):
            proprietary_config["isSelected"] = True
            # If sources array is empty, add default sources
            if not proprietary_config.get("sources"):
                proprietary_config["sources"] = [
                    "PwC Industry Edge",
                    "PwC Insights",
                    "s+b Journal",
                    "Executive Leadership Hub",
                    "The Exchange",
                    "PwC Connected Source",
                    "PwC Benchmarking",
                    "Insights Factory",
                    "PwC Intelligence",
                    "Client Success Stories",
                    "Inside Industries",
                    "Value Store"
                ]
            logger.info("[Router] Auto-selected proprietary because pwc_content is selected")

    # If proprietary is selected, route to proprietary agent
    proprietary_selected = state.input.get("proprietary", {}).get("isSelected", False)
    if proprietary_selected:
        routes.append("proprietary")

    if state.input.get("thirdParty", {}).get("isSelected"):
        routes.append("thirdParty")

    if state.input.get("externalResearch", {}).get("isSelected"):
        routes.append("externalResearch")

    return routes


# =========================================================
# 10. BUILD GRAPH
# =========================================================

def build_graph():
    graph = StateGraph(GraphState)

    # Router
    graph.add_node("router", router_node)

    # PwC internal document
    graph.add_node(
        "pwc_document",
        make_llm_tool_node(
            "pwc_content",
            "document_llm",
            pwc_document_prompt,
        )
    )

    # Proprietary agent with dynamic tool calling
    graph.add_node("proprietary", proprietary_agent_node)

    # Third-party (placeholder: Factiva / Capital IQ APIs)
    graph.add_node(
        "thirdParty",
        make_llm_tool_node(
            "thirdParty",
            "Factiva",
            lambda inp: generic_tool_prompt("Factiva", inp),
        )
    )

    # External Research (REAL Tavily)
    graph.add_node("externalResearch", tavily_tool_node)

    # Entry
    graph.set_entry_point("router")

    # Conditional fan-out
    graph.add_conditional_edges(
        "router",
        router_decision,
        {
            "pwc_document": "pwc_document",
            "proprietary": "proprietary",
            "thirdParty": "thirdParty",
            "externalResearch": "externalResearch",
        },
    )

    # Fan-out ends
    graph.add_edge("pwc_document", END)
    graph.add_edge("proprietary", END)
    graph.add_edge("thirdParty", END)
    graph.add_edge("externalResearch", END)

    return graph.compile()


# =========================================================
# 10. TEST DATA
# =========================================================

def get_test_input() -> dict:
    """Returns sample test input data for graph execution."""
    return {
        "research_topics": "AI in finance",
        "research_guidelines": "focus on agentic systems",
        "pwc_content": {
            "isSelected": True,
            "supportingDoc": "The integration of Artificial Intelligence (AI) into financial services represents a developmental shift in the industry, presenting unprecedented opportunities and challenges. This scientometric review examines the evolution of AI in finance from 1989 to 2024, analyzing its pivotal applications in credit scoring, fraud detection, digital insurance, robo-advisory services, and financial inclusion. The analysis reveals significant trends, particularly the growing adoption of machine learning, natural language processing, and blockchain technologies in reshaping financial operations and decision-making processes. The review addresses critical regulatory and ethical challenges, emphasizing the imperative for explainable AI (XAI) and robust governance frameworks to ensure transparency, fairness, and accountability in AI-driven systems. Despite rapid advancements, persistent gaps remain, the most notable of which is the lack of standardized frameworks for AI implementation across financial sectors. The findings support the need for a balanced approach that promotes innovation while addressing ethical, regulatory, and societal concerns. This comprehensive synthesis maps the trajectory of AI in finance, identifies key areas for future research, and recommends interdisciplinary collaboration to advance responsible and sustainable AI integration within the financial ecosystem.\nSimilar content being viewed by others\nFinance centralization—research on enterprise intelligence\nArticle Open access13 November 2024\nAI reshaping financial modeling\nArticle Open access01 October 2025\nRevolutionizing finance with conversational AI: a focus on ChatGPT implementation and challenges\nArticle Open access19 March 2025\nIntroduction\nArtificial Intelligence (AI) has emerged as a disruptive force in modern finance and has almost completely overhauled how operations are carried out in the industry (Tao et al., 2021). AI, which typically involves technologies such as machine learning, deep learning, and natural language processing, now dictates the mediums for financial functions. Its impact cuts across a wide range of applications—from algorithmic trading and fraud detection to customer service chatbots and robo-advisors (Ranković et al., 2023).\nThis rise in adoption is also evident in the projected doubling of financial institutions' AI expenditure, expected to reach $97 billion by 2027 (Kearns, 2023). With an estimated compound annual growth rate (CAGR) of 29.6%, the financial sector is now the fastest-growing industry globally in terms of AI investment (La Croce, 2023). This exponential growth has prompted leading financial firms such as JPMorgan and Morgan Stanley Wealth Management to establish their AI infrastructures, recognizing the technology's transformative potential (Kearns, 2023). However, this transformative potential presents a paradox: while AI is capable of driving breakthrough performances, it also harbors systemic risks that depends primarily on how it is regulated and ethically deployed (Ahern, 2021; Arner et al., 2020; Berdiyeva et al., 2021).\nRecent developments in advanced AI models, such as ChatGPT and DeepSeek, reinforce the argument for the immense benefits that can be derived from AI technologies; however, their cross-border and pervasive nature also introduces novel risks that demand careful scrutiny to prevent potential widespread crises (Bahoo et al., 2024). One such critical risk is the issue of human oversight. Effective oversight requires that human decision-makers possess the ability to interpret and evaluate AI-generated outputs, to accept, reject, or modify AI recommendations based on ethical, legal, and practical considerations (Černevičienė & Kabašinskas, 2024). This ensures that ultimate responsibility remains with human operators, who can intervene to mitigate adverse outcomes and align AI applications with ethical standards. Such oversight not only ensures accountability but also enhances the responsible use of AI technologies, guarding against risks while fostering trust in AI-driven financial systems (Max et al., 2021).\nAs AI in finance continues through its adoption and growth phase, it is expected that its full benefits and potential threats will become more apparent over time. This dynamic has spurred a significant surge in AI finance publications in recent years, as researchers strive to address literature gaps and identify emerging trajectories to advance the field (Goodell et al., 2023). Over the past two decades, the volume of publications has risen considerably, from an annual average of 29 to 178 articles, based on our dataset. These studies explore a wide range of topics, including optimal financial models, associated risks, and diverse applications across various facets of finance.\nSince the early 1990s, when scientific research on AI in finance first emerged, numerous technologies have been adopted, redefined or replaced in response to the evolving needs of financial markets. Concurrently, the terminology and focus of research have shifted to mirror this changing landscape (Leone & de Medeiros, 2015). For researchers and finance professionals, understanding both foundational and niche themes in AI is crucial to developing technologies and research that align with current trends and dynamics. Against this backdrop, this study examines trends in AI finance research to identify key stakeholders, influential topics, and areas that are prime for further exploration to provide a structured analysis of research gaps and development trajectories.\nMajor research gaps remain in the literature, particularly in understanding the evolving regulatory landscape and ethical considerations surrounding AI-based finance (Brummer and Gorfine). The fast pace of AI application adoption demands that current regulatory frameworks and ethical dilemmas are critically examined, including issues of algorithmic bias and fairness (Friedler et al., 2019). Addressing these issues is essential to ensuring the responsible development and deployment of AI technologies in finance and protecting the interests of both financial institutions and consumers (Pithadia, 2021).\nRegulators face considerable challenges in understanding the underlying mechanisms of complex AI systems, complicating their efforts to establish effective oversight. Similarly, consumers struggle to decipher the reasoning behind AI-generated outputs in their decision-making process. These challenges led to the emergence of Explainable Artificial Intelligence (XAI), which prioritizes transparency and interpretability in AI models (Chen et al., 2023). Moreover, the rapid pace of AI technology advancements implies that regulatory frameworks are continuously updated, which imposes substantial costs on regulatory bodies. Other regulatory challenges include ambiguous regulations (Arner, 2019), data privacy and security concerns (Lopez & Alcaide, 2020), and the lack of global regulatory harmonization (Erdélyi & Goldsmith, 2018) —factors that collectively threaten the effective and ethical use of AI in finance. The 2008 financial crisis—triggered by lax oversight, complex financial products and inadequate risk assessment—serve as a stark reminder of the consequences of regulatory failures (Vukovic et al., 2019; Gorton & Metrick, 2012). The 2010 Flash Crash also further exemplifies the risks posed by inadequately regulated AI-driven systems in causing sudden and severe market disruptions (Frömmel, 2022).\nThis study addresses these critical gaps through a comprehensive literature review, employing a scientometric approach to analyze the existing body of research on AI in finance. The primary objectives are twofold: (1) to identify prevailing research trends and prospects in AI finance, and (2) to investigate the applications, regulatory frameworks, and ethical considerations associated with AI in finance. The scientometric methodology provides a robust, objective framework for analyzing trends and identifying gaps in AI-based finance research. Through this approach, the study makes several novel contributions to literature. First, it employs a larger and more recent dataset to provide an up-to-date perspective on AI in finance developments. Second, it analyzes evolving trends in AI techniques, offering insights into the field's technological progression, influential contributors, and potential areas for research (Bahoo et al., 2024). Third, by examining regulatory frameworks and ethical considerations, the study provides a guiding framework for responsible AI integration in finance. These insights are crucial for promoting innovative financial technology, robust governance standards and enhancing trust in AI-driven financial systems.\nThe next parts of this paper are structured as follows: Section 2 reviews the relevant literature, to provide a foundation for understanding the key themes and developments. Section 3 outlines the research methodology to describe the data sources and analytical approaches employed in this study. Section 4 presents the main findings, combining scientometric and content analyses to reveal trends and patterns in AI finance research. Section 5 delves into the regulation of AI in finance, synthesizing critical studies and highlighting key gaps. Finally, Section 6 concludes the paper by discussing the implications of the findings and proposing avenues for future research.\nLiterature background\nArtificial intelligence in finance: evolution, impact, and regulatory perspectives\nEarly literature conceptualized AI primarily as a tool for automation. However, with the introduction of advanced algorithms and computational models, AI has evolved into a more comprehensive tool in recent studies (Johnson et al., 2019; Arslanian & Fischer, 2019). This evolution has resulted in the development of several theoretical frameworks for understanding AI's role in finance. The mechanistic viewpoint focuses on AI's capacity for automating routine tasks through rule-based systems to streamline operational efficiency within financial institutions. In contrast, the predictive analytics viewpoint highlights AI's ability to support market analysis and decision-making, particularly through machine learning applications (Wang et al., 2021). These divergent conceptualizations demonstrate AI's complexity and its varied applications across different financial domains.\nThe technological foundation underlying AI financial applications has evolved through distinct phases, each marked by significant advances in computing power, data availability, and algorithmic sophistication (Arner et al., 2020). Contemporary AI systems in finance are distinguished by their ability to process and analyze vast datasets in real-time, leveraging multiple technological components that work in concert. Machine learning models extract patterns from historical data, while natural language processing (NLP) algorithms decode unstructured textual information. Neural networks, designed to mimic human cognitive processes, enable these systems to handle increasingly complex analytical tasks (Zhang et al., 2021). This technological convergence has enabled AI to transcend its initial role in basic process automation and emerge as a sophisticated tool for financial analysis and decision-making.\nThe historical trajectory of AI in finance demonstrates how technological advancement has fundamentally altered financial services delivery and operations. The evolution progressed from basic rule-based automation systems in the initial stages to increasingly sophisticated applications incorporating predictive analytics and machine learning (Johnson et al., 2019). This change was more than just technical; it represented a vital shift in how financial institutions approached data analysis, risk assessment, and decision-making processes. The progression from automated task execution to complex predictive modeling shows the technology's expanding capabilities and its growing strategic significance in financial operations.\nContemporary developments in AI finance are marked by several interconnected trends that are reshaping industry practices. Natural Language Processing (NLP) and sentiment analysis are used to understand textual data, enabling financial institutions to gauge market sentiment and make informed investment decisions (Gao et al., 2021). Explainable AI (XAI) has gained prominence as a critical factor in ensuring regulatory compliance and building user trust by making AI algorithms more interpretable (Chen et al., 2023). Robotic Process Automation (RPA) is streamlining back-office operations, reducing costs, and improving efficiency (Madakam et al., 2019). Additionally, AI-driven chatbots and virtual assistants are enhancing customer interactions by providing personalized services and resolving queries more efficiently (Iovine et al., 2023). Algorithmic trading, powered by AI, is optimizing investment strategies, offering greater precision and speed in executing trades (Arner, 2019). These trends collectively reflect the integration of different AI applications to improve the financial sector.\nLooking ahead, the financial industry is set to be influenced by a number of new developments in AI. For instance, quantum computing promises to deliver unmatched computational power for complex financial modeling and optimization (Woerner & Egger, 2019). AI-based fraud detection systems are evolving through advanced anomaly detection algorithms to enhance security and mitigate risks (El Hajj & Hammoud, 2023). Continuous advancements in neural networks and deep learning are expanding AI's ability to analyze unstructured data, such as images and audio, for applications in fraud prevention and customer service. Augmented Intelligence, which emphasizes collaboration between humans and AI, is gaining traction as a decision-support tool in complex financial scenarios (Tao et al., 2021). Furthermore, the integration of blockchain and AI is paving the way for decentralized, transparent, and secure solutions, particularly in areas such as smart contracts and digital identity (Kshetri, 2021). These emerging trends highlight the ongoing evolution of AI in finance, pointing to a future where its influence will be more pervasive and transformative.\nThese developments of AI in finance have also been extensively studied through bibliometric approaches. Seminal works by Chen et al. (2023), Tao et al. (2021), Goodell et al. (2021), and Ahmed et al. (2022) have explored the foundational elements, thematic underpinnings, and research clusters in AI literature. These studies employ techniques such as co-citation analysis, bibliometric coupling, NLP-based bibliometric approaches, and integrated CiteSpace analysis to uncover evolving research trends in AI-based finance. Chen et al. (2023), for instance, focus on Explainable AI (XAI) in finance, noting a significant increase in publications since 2013. Their research notes a transition from traditional finance research toward more inclusive and diversified applications, accompanied by improvements in non-interpretable models and a growing emphasis on risk and ethical considerations. Other studies also identify three principal literature clusters within AI finance: (1) portfolio construction, computation, and investor behavior; (2) financial fraud and distress; and (3) sentiment inference, forecasting, and planning. These clusters show the major applications of AI in finance (Goodell et al., 2021). Ahmed et al. (2022) observe a surge in literature on Machine Learning (ML) and AI finance, with the United States, China, and the United Kingdom emerging as the top contributors. This global distribution of research highlights the international significance and interest in AI applications within finance, and the leading role these countries play in its exploration and development.\nThe global perspectives, however, vary on how AI is regulated. Efforts to address ethical concerns, regulatory gaps, and privacy issues related to AI applications have revealed divergent views across different regions, with limited literature available to quantitatively or qualitatively determine the best approaches (Lee, 2020). The European Banking Institute advocates for robust and centralized governance to address risks and regulatory fragmentation, particularly in cross-border FinTech trade, while the United States has adopted a more decentralized approach that raises concerns about standardization and harmonization (Azzutti et al., 2022; Ahern, 2021). The issue of regulatory arbitrage has also emerged from this disconnect, with AI platforms for tokenization, crowdfunding and cryptocurrencies being at the forefront of providing unfair advantages to some users. Explainable AI (XAI) has been proposed to help regulators access sufficient information for better-informed regulations. Regulatory Technology (RegTech) is also emerging as a potential solution to streamline AI compliance, while regulatory sandboxes are facilitating innovation and testing in controlled environments (Boukherouaa et al., 2021; Lee, 2020). Nevertheless, measuring the performance of AI regulation remains challenging due to the lack of standardized metrics. Current trends suggest a shift toward risk-oriented regulatory approaches that prioritizes flexibility and adaptability in governing AI in finance. As the financial industry continues to embrace AI, the literature on AI regulation is expected to evolve, offering new insights into the ongoing transformation of the financial landscape and addressing the critical balance between innovation and ethics. This study aims to explore this dynamic, laying the groundwork for future research, policy discussions, and AI development in finance. By doing so, it seeks to make a pioneering contribution to the field.",
            "supportingDoc_instructions": "focus on first 3 modules in the document",
            "research_links": "http://localhost:8080/docs#/Chat/chat_api_v1_chat_post"
        },
        "proprietary": {"isSelected": False},
        "thirdParty": {"isSelected": False},
        "externalResearch": {"isSelected": False},
    }


# =========================================================
# 11. RUN
# =========================================================

if __name__ == "__main__":
    graph = build_graph()
    raw_input = get_test_input()
    result = graph.invoke(GraphState(input=raw_input))
    print(jsonable_encoder(result["tool_results"]))
