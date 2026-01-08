"""
Proprietary Source Tools
Each tool represents a separate PwC proprietary source.
Tool names match exactly with the source names from user selection.
"""

from langchain_core.tools import tool
from typing import Dict, List
import logging

logger = logging.getLogger(__name__)


@tool(name="PwC Industry Edge")
def search_pwc_industry_edge(query: str, guidelines: str = "") -> str:
    """Search PwC Industry Edge for industry-specific insights and data.
    
    Args:
        query: Research topic or query
        guidelines: Additional research guidelines
        
    Returns:
        Research data from PwC Industry Edge
    """
    logger.info(f"[Tool: PwC Industry Edge] Query: {query}, Guidelines: {guidelines}")
    # TODO: Implement actual API call to PwC Industry Edge
    return f"Research data from PwC Industry Edge for: {query}\nGuidelines: {guidelines}"


@tool(name="PwC Insights")
def search_pwc_insights(query: str, guidelines: str = "") -> str:
    """Search PwC Insights for research content.
    
    Args:
        query: Research topic or query
        guidelines: Additional research guidelines
        
    Returns:
        Research data from PwC Insights
    """
    logger.info(f"[Tool: PwC Insights] Query: {query}, Guidelines: {guidelines}")
    return f"Research data from PwC Insights for: {query}\nGuidelines: {guidelines}"


@tool(name="s+b Journal")
def search_sb_journal(query: str, guidelines: str = "") -> str:
    """Search s+b Journal for articles and insights.
    
    Args:
        query: Research topic or query
        guidelines: Additional research guidelines
        
    Returns:
        Research data from s+b Journal
    """
    logger.info(f"[Tool: s+b Journal] Query: {query}, Guidelines: {guidelines}")
    return f"Research data from s+b Journal for: {query}\nGuidelines: {guidelines}"


@tool(name="Executive Leadership Hub")
def search_executive_leadership_hub(query: str, guidelines: str = "") -> str:
    """Search Executive Leadership Hub for leadership insights.
    
    Args:
        query: Research topic or query
        guidelines: Additional research guidelines
        
    Returns:
        Research data from Executive Leadership Hub
    """
    logger.info(f"[Tool: Executive Leadership Hub] Query: {query}, Guidelines: {guidelines}")
    return f"Research data from Executive Leadership Hub for: {query}\nGuidelines: {guidelines}"


@tool(name="The Exchange")
def search_the_exchange(query: str, guidelines: str = "") -> str:
    """Search The Exchange for content.
    
    Args:
        query: Research topic or query
        guidelines: Additional research guidelines
        
    Returns:
        Research data from The Exchange
    """
    logger.info(f"[Tool: The Exchange] Query: {query}, Guidelines: {guidelines}")
    return f"Research data from The Exchange for: {query}\nGuidelines: {guidelines}"


@tool(name="PwC Connected Source")
def search_pwc_connected_source(query: str, guidelines: str = "") -> str:
    """Search PwC Connected Source for knowledge base content.
    
    Args:
        query: Research topic or query
        guidelines: Additional research guidelines
        
    Returns:
        Research data from PwC Connected Source
    """
    logger.info(f"[Tool: PwC Connected Source] Query: {query}, Guidelines: {guidelines}")
    return f"Research data from PwC Connected Source for: {query}\nGuidelines: {guidelines}"


@tool(name="PwC Benchmarking")
def search_pwc_benchmarking(query: str, guidelines: str = "") -> str:
    """Search PwC Benchmarking for benchmarking data.
    
    Args:
        query: Research topic or query
        guidelines: Additional research guidelines
        
    Returns:
        Research data from PwC Benchmarking
    """
    logger.info(f"[Tool: PwC Benchmarking] Query: {query}, Guidelines: {guidelines}")
    return f"Research data from PwC Benchmarking for: {query}\nGuidelines: {guidelines}"


@tool(name="Insights Factory")
def search_insights_factory(query: str, guidelines: str = "") -> str:
    """Search Insights Factory for insights.
    
    Args:
        query: Research topic or query
        guidelines: Additional research guidelines
        
    Returns:
        Research data from Insights Factory
    """
    logger.info(f"[Tool: Insights Factory] Query: {query}, Guidelines: {guidelines}")
    return f"Research data from Insights Factory for: {query}\nGuidelines: {guidelines}"


@tool(name="PwC Intelligence")
def search_pwc_intelligence(query: str, guidelines: str = "") -> str:
    """Search PwC Intelligence for intelligence data.
    
    Args:
        query: Research topic or query
        guidelines: Additional research guidelines
        
    Returns:
        Research data from PwC Intelligence
    """
    logger.info(f"[Tool: PwC Intelligence] Query: {query}, Guidelines: {guidelines}")
    return f"Research data from PwC Intelligence for: {query}\nGuidelines: {guidelines}"


@tool(name="Client Success Stories")
def search_client_success_stories(query: str, guidelines: str = "") -> str:
    """Search Client Success Stories for case studies.
    
    Args:
        query: Research topic or query
        guidelines: Additional research guidelines
        
    Returns:
        Research data from Client Success Stories
    """
    logger.info(f"[Tool: Client Success Stories] Query: {query}, Guidelines: {guidelines}")
    return f"Research data from Client Success Stories for: {query}\nGuidelines: {guidelines}"


@tool(name="Inside Industries")
def search_inside_industries(query: str, guidelines: str = "") -> str:
    """Search Inside Industries for industry-specific content.
    
    Args:
        query: Research topic or query
        guidelines: Additional research guidelines
        
    Returns:
        Research data from Inside Industries
    """
    logger.info(f"[Tool: Inside Industries] Query: {query}, Guidelines: {guidelines}")
    return f"Research data from Inside Industries for: {query}\nGuidelines: {guidelines}"


@tool(name="Value Store")
def search_value_store(query: str, guidelines: str = "") -> str:
    """Search Value Store for content.
    
    Args:
        query: Research topic or query
        guidelines: Additional research guidelines
        
    Returns:
        Research data from Value Store
    """
    logger.info(f"[Tool: Value Store] Query: {query}, Guidelines: {guidelines}")
    return f"Research data from Value Store for: {query}\nGuidelines: {guidelines}"


# Mapping of source names (exact match from user selection) to tool functions
PROPRIETARY_TOOLS_MAP = {
    "PwC Industry Edge": search_pwc_industry_edge,
    "PwC Insights": search_pwc_insights,
    "s+b Journal": search_sb_journal,
    "Executive Leadership Hub": search_executive_leadership_hub,
    "The Exchange": search_the_exchange,
    "PwC Connected Source": search_pwc_connected_source,
    "PwC Benchmarking": search_pwc_benchmarking,
    "Insights Factory": search_insights_factory,
    "PwC Intelligence": search_pwc_intelligence,
    "Client Success Stories": search_client_success_stories,
    "Inside Industries": search_inside_industries,
    "Value Store": search_value_store,
}


def get_proprietary_tools_for_sources(selected_sources: List[str]):
    """
    Get LangChain tool objects for selected sources only.
    
    Args:
        selected_sources: List of source names selected by user (exact match required)
        
    Returns:
        List of LangChain tool objects
    """
    tools = []
    for source_name in selected_sources:
        tool_func = PROPRIETARY_TOOLS_MAP.get(source_name)
        if tool_func:
            tools.append(tool_func)
            logger.info(f"[Tools] Added tool for source: {source_name}")
        else:
            logger.warning(f"[Tools] Tool not found for source: {source_name}")
    return tools

