from fastapi import APIRouter, HTTPException, UploadFile, File, Depends
from fastapi.responses import StreamingResponse, JSONResponse
from app.features.export.schemas import ExportRequest
from app.common.export_utils import export_to_pdf, export_to_word, export_to_word_with_metadata, export_to_text, extract_subtitle_from_content, export_to_pdf_with_pwc_template
from app.common.document_utils import extract_text_from_pdf, extract_text_from_docx, extract_text_from_txt, extract_text_from_pptx
from io import BytesIO
import logging
import re
from urllib.parse import quote
from app.common.export_utils import export_to_word_pwc_standalone
from app.services.auth_service import validate_jwt_token
from typing import List, Dict, Optional
from html.parser import HTMLParser

router = APIRouter(prefix="/export", tags=["Export"], dependencies=[Depends(validate_jwt_token)])
logger = logging.getLogger(__name__)


# HTML parsing utilities for edit content export
class HTMLTextExtractor(HTMLParser):
    """Simple HTML parser to extract text content"""
    def __init__(self):
        super().__init__()
        self.text = []
        self.skip_tags = {'script', 'style'}
        self.current_tag = None
    
    def handle_starttag(self, tag, attrs):
        self.current_tag = tag
        if tag in ('br', 'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'):
            self.text.append('\n')
    
    def handle_endtag(self, tag):
        if tag in ('p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'):
            self.text.append('\n')
        self.current_tag = None
    
    def handle_data(self, data):
        if self.current_tag not in self.skip_tags:
            self.text.append(data)
    
    def get_text(self):
        return ''.join(self.text).strip()


def parse_html_content(html_content: str) -> str:
    """
    Parse HTML content and convert to plain text while preserving structure.
    This is a fallback - ideally we'd preserve HTML formatting in the document.
    """
    if not html_content:
        return ""
    
    try:
        parser = HTMLTextExtractor()
        parser.feed(html_content)
        text = parser.get_text()
        
        # Clean up excessive whitespace
        text = re.sub(r'\n{3,}', '\n\n', text)
        
        return text.strip()
    except Exception as e:
        logger.warning(f"[EditContentExport] HTML parsing error, using regex fallback: {e}")
        # Fallback: simple regex-based extraction
        text = re.sub(r'<script[^>]*>.*?</script>', '', html_content, flags=re.DOTALL | re.IGNORECASE)
        text = re.sub(r'<style[^>]*>.*?</style>', '', text, flags=re.DOTALL | re.IGNORECASE)
        text = re.sub(r'<[^>]+>', ' ', text)
        text = re.sub(r'\s+', ' ', text)
        return text.strip()


def convert_html_to_formatted_text(html_content: str, block_types: Optional[List[Dict]] = None) -> str:
    """
    Convert HTML content to formatted text preserving block structure and formatting.
    Maintains the formatting from formatFinalArticleWithBlockTypes for export.
    
    Args:
        html_content: HTML formatted content with inline styles
        block_types: Optional list of block type information
        
    Returns:
        str: Formatted text content preserving structure
    """
    if not html_content:
        return ""
    
    try:
        # Remove wrapper divs
        content = html_content
        wrapper_match = re.search(r'<div[^>]*class="[^"]*revised-content-formatted[^"]*"[^>]*>(.*?)</div>', content, re.DOTALL)
        if wrapper_match:
            content = wrapper_match.group(1)
        
        result_lines = []
        
        # Extract h1 tags (titles) - these should be prominent
        h1_pattern = r'<h1[^>]*>(.*?)</h1>'
        h1_matches = list(re.finditer(h1_pattern, content, re.DOTALL | re.IGNORECASE))
        
        # Extract h2-h6 tags (headings)
        heading_pattern = r'<h([2-6])[^>]*>(.*?)</h\1>'
        heading_matches = list(re.finditer(heading_pattern, content, re.DOTALL | re.IGNORECASE))
        
        # Extract paragraphs
        p_pattern = r'<p[^>]*>(.*?)</p>'
        p_matches = list(re.finditer(p_pattern, content, re.DOTALL | re.IGNORECASE))
        
        # Extract lists (ul/ol with li items)
        ul_pattern = r'<ul[^>]*>(.*?)</ul>'
        ol_pattern = r'<ol[^>]*>(.*?)</ol>'
        ul_matches = list(re.finditer(ul_pattern, content, re.DOTALL | re.IGNORECASE))
        ol_matches = list(re.finditer(ol_pattern, content, re.DOTALL | re.IGNORECASE))
        
        # Combine all matches with their positions
        all_matches = []
        for m in h1_matches:
            all_matches.append((m.start(), 'h1', m.group(1)))
        for m in heading_matches:
            level = int(m.group(1))
            all_matches.append((m.start(), f'h{level}', m.group(2)))
        for m in p_matches:
            all_matches.append((m.start(), 'p', m.group(1)))
        for m in ul_matches:
            all_matches.append((m.start(), 'ul', m.group(1)))
        for m in ol_matches:
            all_matches.append((m.start(), 'ol', m.group(1)))
        
        # Sort by position
        all_matches.sort(key=lambda x: x[0])
        
        # Process each match in order
        for pos, tag_type, inner_html in all_matches:
            # Clean inner HTML - remove nested tags but preserve text
            text = re.sub(r'<strong[^>]*>(.*?)</strong>', r'**\1**', inner_html, flags=re.DOTALL | re.IGNORECASE)
            text = re.sub(r'<em[^>]*>(.*?)</em>', r'*\1*', text, flags=re.DOTALL | re.IGNORECASE)
            text = re.sub(r'<[^>]+>', '', text)  # Remove remaining HTML tags
            text = text.strip()
            
            if not text:
                continue
            
            if tag_type == 'h1':
                # Title - make it prominent
                result_lines.append(f"\n# {text}\n")
            elif tag_type.startswith('h'):
                # Heading - use appropriate markdown level
                level = int(tag_type[1])
                result_lines.append(f"\n{'#' * level} {text}\n")
            elif tag_type == 'p':
                # Paragraph
                result_lines.append(f"{text}\n")
            elif tag_type in ('ul', 'ol'):
                # List - extract list items, preserving existing numbering or bullet icons
                li_pattern = r'<li[^>]*>(.*?)</li>'
                li_matches = re.findall(li_pattern, inner_html, re.DOTALL | re.IGNORECASE)
                counter = 1
                for li_text in li_matches:
                    # Remove inner HTML tags but keep raw text (including any existing bullet icons or numbering)
                    li_clean = re.sub(r'<[^>]+>', '', li_text).strip()
                    if not li_clean:
                        counter += 1
                        continue

                    # If the item already starts with a bullet icon or number, keep it as-is
                    if re.match(r'^[•\\-*]\\s+', li_clean) or re.match(r'^\\d+[.)]\\s+', li_clean):
                        result_lines.append(f"- {li_clean}\n" if tag_type == 'ul' else f"{counter}. {li_clean}\n")
                    else:
                        # Prefix based on list type
                        if tag_type == 'ul':
                            result_lines.append(f"- {li_clean}\n")
                        else:
                            result_lines.append(f"{counter}. {li_clean}\n")

                    counter += 1
                result_lines.append("\n")
        
        # If no structured matches found, fall back to simple extraction
        if not result_lines:
            return parse_html_content(html_content)
        
        result = ''.join(result_lines)
        # Clean up excessive blank lines
        result = re.sub(r'\n{3,}', '\n\n', result)
        
        return result.strip()
        
    except Exception as e:
        logger.warning(f"[EditContentExport] HTML to formatted text conversion error: {e}")
        # Fallback to simple parsing
        return parse_html_content(html_content)


def extract_title_from_html(html_content: str, block_types: Optional[List[Dict]] = None) -> str:
    """
    Extract title from HTML content, checking for h1 tags or first block type.
    """
    if not html_content:
        return ""
    
    # Check for h1 tag first using regex
    h1_match = re.search(r'<h1[^>]*>(.*?)</h1>', html_content, re.DOTALL | re.IGNORECASE)
    if h1_match:
        title = h1_match.group(1)
        # Remove any nested HTML tags
        title = re.sub(r'<[^>]+>', '', title)
        title = title.strip()
        if title:
            return title
    
    # Check block types for title block
    if block_types:
        for block in block_types:
            if block.get('type') == 'title':
                # Try to extract from HTML at that index
                # Split by common HTML block separators
                parts = re.split(r'</(?:h[1-6]|p|div|ul|ol)>', html_content)
                idx = block.get('index', 0)
                if idx < len(parts):
                    para_html = parts[idx]
                    # Extract text from this part
                    para_text = re.sub(r'<[^>]+>', '', para_html)
                    para_text = para_text.strip()
                    if para_text:
                        return para_text
    
    # Fallback: extract first meaningful text
    try:
        parser = HTMLTextExtractor()
        parser.feed(html_content)
        text = parser.get_text()
        if text:
            # Get first line or first 100 chars
            first_line = text.split('\n')[0] if '\n' in text else text[:100]
            return first_line.strip()
    except Exception:
        pass
    
    return ""


def export_edit_content_to_word(
    html_content: str,
    title: str,
    block_types: Optional[List[Dict]] = None
) -> bytes:
    """
    Export edit content HTML to Word document preserving formatting.
    Creates title page with title, then formatted body content with block types.
    
    Args:
        html_content: HTML formatted content from formatFinalArticleWithBlockTypes
        title: Document title
        block_types: Optional list of block type information
        
    Returns:
        bytes: Word document as bytes
    """
    try:
        logger.info(f"[EditContentExport] Generating Word document with formatting: {title}")
        
        # Extract title if not provided or empty
        if not title and html_content:
            title = extract_title_from_html(html_content, block_types)
        
        # Convert HTML to formatted content preserving structure
        # Extract text while preserving formatting hints from HTML
        body_content = convert_html_to_formatted_text(html_content, block_types)
        
        # Use existing export function with title and formatted content
        # Title goes on first page, content on subsequent pages
        word_bytes = export_to_word_with_metadata(
            content=body_content,
            title=title,
            subtitle=None,
            content_type=None
        )
        
        logger.info(f"[EditContentExport] Word document generated: {len(word_bytes)} bytes")
        return word_bytes
        
    except Exception as e:
        logger.error(f"[EditContentExport] Word export error: {e}", exc_info=True)
        raise


def export_edit_content_to_pdf(
    html_content: str,
    title: str,
    block_types: Optional[List[Dict]] = None
) -> bytes:
    """
    Export edit content HTML to PDF document with PwC template preserving formatting.
    Creates title page with title, then formatted body content with block types.
    
    Args:
        html_content: HTML formatted content from formatFinalArticleWithBlockTypes
        title: Document title
        block_types: Optional list of block type information
        
    Returns:
        bytes: PDF document as bytes
    """
    try:
        logger.info(f"[EditContentExport] Generating PDF document with formatting: {title}")
        
        # Extract title if not provided or empty
        if not title and html_content:
            title = extract_title_from_html(html_content, block_types)
        
        # Convert HTML to formatted content preserving structure
        # Extract text while preserving formatting hints from HTML
        body_content = convert_html_to_formatted_text(html_content, block_types)
        
        # Use existing export function with title and formatted content
        # Title goes on first page, content on subsequent pages
        pdf_bytes = export_to_pdf_with_pwc_template(
            content=body_content,
            title=title,
            subtitle=None
        )
        
        logger.info(f"[EditContentExport] PDF document generated: {len(pdf_bytes)} bytes")
        return pdf_bytes
        
    except Exception as e:
        logger.error(f"[EditContentExport] PDF export error: {e}", exc_info=True)
        raise

@router.post("/word")
async def export_word(request: ExportRequest):
    """Export content to Word document using PwC template"""
    try:
        logger.info(f"[Export] Generating Word document: {request.title}")
        
        # Extract subtitle from first line of content if not provided
        subtitle = request.subtitle
        content = request.content
        
        if not subtitle and content:
            extracted_subtitle, remaining_content = extract_subtitle_from_content(content)
            if extracted_subtitle:
                subtitle = extracted_subtitle
                content = remaining_content
                logger.info(f"[Export] Extracted subtitle from content: {subtitle[:50]}")
        
        # Clean subtitle by removing markdown asterisks
        if subtitle:
            subtitle = re.sub(r'\*\*(.+?)\*\*', r'\1', subtitle)
            subtitle = subtitle.replace('**', '')
        
        # For draft content, use subtitle as title and remove original title
        title = request.title
        if subtitle:
            # Use subtitle as the main title on the first page
            title = subtitle
            subtitle = None  # Clear subtitle so it doesn't appear twice
            logger.info(f"[Export] Using subtitle as title for draft content export")
        
        # Use enhanced export with metadata if content_type provided
        if subtitle or request.content_type:
            word_bytes = export_to_word_with_metadata(
                content=content, 
                title=title,
                subtitle=subtitle,
                content_type=request.content_type
            )
        else:
            word_bytes = export_to_word(content, title)
        
        buffer = BytesIO(word_bytes)
        
        # Sanitize filename to remove special characters and properly encode
        safe_title = re.sub(r'[^\w\s\-]', '', request.title)  # Remove non-word chars except dash
        safe_title = re.sub(r'\s+', '_', safe_title)  # Replace spaces with underscores
        filename = f"{safe_title}.docx"
        
        # Use RFC 5987 encoding for the filename in Content-Disposition header
        encoded_filename = quote(filename, safe='')
        
        return StreamingResponse(
            buffer,
            media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            headers={"Content-Disposition": f"attachment; filename*=UTF-8''{encoded_filename}"}
        )
    except Exception as e:
        logger.error(f"[Export] Word export error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/ppt")
async def export_ppt(request: ExportRequest):
    """
    Export content to PPT using PlusDocs Slides template
    """
    try:
        logger.info(f"[Export] Generating PPT document: {request.title}")
        from app.features.ddc.services.slide_creation_service import PlusDocsClient
        template_id = "YGw8kjq05qPFKRUpe2cOjY"  # replace later with dropdown mapping
        API_TOKEN = "v1,25g5CI5ZTGyy5m8Rp43BNWL774Mjl8ln2mywgJYpEyA,cm01dho7w0004134q3dfol5vl_cmiqiek6k000fmtgypmd0u2eg,YU644eaMtl5jYdHAWatzT9RzartlZiFE-PfStIHDDrU"
        client = PlusDocsClient(API_TOKEN)
        download_url = client.create_and_wait(
            prompt=request.content,
            template_id=template_id,
            isImage=False
        )
        if not download_url:
            raise HTTPException(status_code=500, detail="PPT generation failed")
        return JSONResponse({
            "status": "success",
            "download_url": download_url
        })
    except Exception as e:
        logger.error(f"[Export] PPT export error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/pdf")
async def export_pdf(request: ExportRequest):
    """Export content to PDF document"""
    try:
        logger.info(f"[Export] Generating PDF document: {request.title}")
        
        pdf_bytes = export_to_pdf(request.content, request.title)
        buffer = BytesIO(pdf_bytes)
        
        # Sanitize filename to remove special characters and properly encode
        safe_title = re.sub(r'[^\w\s\-]', '', request.title)  # Remove non-word chars except dash
        safe_title = re.sub(r'\s+', '_', safe_title)  # Replace spaces with underscores
        filename = f"{safe_title}.pdf"
        
        # Use RFC 5987 encoding for the filename in Content-Disposition header
        encoded_filename = quote(filename, safe='')
        
        return StreamingResponse(
            buffer,
            media_type="application/pdf",
            headers={"Content-Disposition": f"attachment; filename*=UTF-8''{encoded_filename}"}
        )
    except Exception as e:
        logger.error(f"[Export] PDF export error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/pdf-pwc")
async def export_pdf_pwc(request: ExportRequest):
    """Export content to PDF document using PwC template with logo and branding"""
    try:
        logger.info(f"[Export] Generating PDF document with PwC template: {request.title}")
        
        # Extract subtitle from first line of content if not provided
        subtitle = request.subtitle
        content = request.content
        
        if not subtitle and content:
            extracted_subtitle, remaining_content = extract_subtitle_from_content(content)
            if extracted_subtitle:
                subtitle = extracted_subtitle
                content = remaining_content
                logger.info(f"[Export] Extracted subtitle from content: {subtitle[:50]}")
        
        # Clean subtitle by removing markdown asterisks
        if subtitle:
            subtitle = re.sub(r'\*\*(.+?)\*\*', r'\1', subtitle)
            subtitle = subtitle.replace('**', '')
        
        # For draft content, use subtitle as title and remove original title
        title = request.title
        if subtitle:
            # Use subtitle as the main title on the cover page
            title = subtitle
            subtitle = None  # Clear subtitle so it doesn't appear twice
            logger.info(f"[Export] Using subtitle as title for draft content export")
        
        # Generate PWC branded PDF
        pdf_bytes = export_to_pdf_with_pwc_template(
            content=content, 
            title=title,
            subtitle=subtitle
        )
        
        logger.info(f"[Export] PDF generated: {len(pdf_bytes)} bytes")
        
        # Create buffer and reset position
        buffer = BytesIO(pdf_bytes)
        buffer.seek(0)
        
        # Create proper filename with sanitization
        safe_title = re.sub(r'[^\w\s\-]', '', request.title)  # Remove non-word chars except dash
        safe_title = re.sub(r'\s+', '_', safe_title)  # Replace spaces with underscores
        filename = f"{safe_title}.pdf"
        encoded_filename = quote(filename, safe='')
        logger.info(f"[Export] Returning PDF with filename: {encoded_filename}")
        
        return StreamingResponse(
            iter([buffer.getvalue()]),
            media_type="application/pdf",
            headers={
                "Content-Disposition": f"attachment; filename*=UTF-8''{encoded_filename}",
                "Content-Length": str(len(pdf_bytes))
            }
        )
    except Exception as e:
        logger.error(f"[Export] PDF-PWC export error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/text")
async def export_text(request: ExportRequest):
    """Export content to plain text file"""
    try:
        logger.info(f"[Export] Generating text file: {request.title}")
        
        content_with_title = f"{request.title}\n{'='*len(request.title)}\n\n{request.content}"
        text_bytes = export_to_text(content_with_title)
        buffer = BytesIO(text_bytes)
        
        # Sanitize filename to remove special characters and properly encode
        safe_title = re.sub(r'[^\w\s\-]', '', request.title)  # Remove non-word chars except dash
        safe_title = re.sub(r'\s+', '_', safe_title)  # Replace spaces with underscores
        filename = f"{safe_title}.txt"
        encoded_filename = quote(filename, safe='')
        
        return StreamingResponse(
            buffer,
            media_type="text/plain",
            headers={"Content-Disposition": f"attachment; filename*=UTF-8''{encoded_filename}"}
        )
    except Exception as e:
        logger.error(f"[Export] Text export error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/word-standalone")
async def export_word_pwc(request: ExportRequest):
    """
    Standalone Word export (PwC template)
    """
    logger.error("🚨 word-standalone====== IS BEING CALLED",request.title)
    logger.error("🚨 subtitle====== IS BEING CALLED",request.subtitle)
    return StreamingResponse(
        BytesIO(
            export_to_word_pwc_standalone(
                content=request.content,
                title=request.title,
                subtitle=request.subtitle,
                content_type=request.content_type,
                references=request.references
            )
        ),
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )

@router.post("/edit-content/word")
async def export_edit_content_word(request: ExportRequest):
    """Export edit content HTML to Word document with block type formatting"""
    try:
        if not request.html_content:
            raise HTTPException(status_code=400, detail="html_content is required for edit content export")
        
        logger.info(f"[Export] Generating edit content Word document: {request.title}")
        
        word_bytes = export_edit_content_to_word(
            html_content=request.html_content,
            title=request.title,
            block_types=request.block_types
        )
        
        buffer = BytesIO(word_bytes)
        
        # Sanitize filename
        safe_title = re.sub(r'[^\w\s\-]', '', request.title)
        safe_title = re.sub(r'\s+', '_', safe_title)
        filename = f"{safe_title}.docx"
        encoded_filename = quote(filename, safe='')
        
        return StreamingResponse(
            buffer,
            media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            headers={"Content-Disposition": f"attachment; filename*=UTF-8''{encoded_filename}"}
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[Export] Edit content Word export error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/edit-content/pdf-pwc")
async def export_edit_content_pdf_pwc(request: ExportRequest):
    """Export edit content HTML to PDF document with PwC template and block type formatting"""
    try:
        if not request.html_content:
            raise HTTPException(status_code=400, detail="html_content is required for edit content export")
        
        logger.info(f"[Export] Generating edit content PDF document: {request.title}")
        
        pdf_bytes = export_edit_content_to_pdf(
            html_content=request.html_content,
            title=request.title,
            block_types=request.block_types
        )
        
        buffer = BytesIO(pdf_bytes)
        buffer.seek(0)
        
        # Sanitize filename
        safe_title = re.sub(r'[^\w\s\-]', '', request.title)
        safe_title = re.sub(r'\s+', '_', safe_title)
        filename = f"{safe_title}.pdf"
        encoded_filename = quote(filename, safe='')
        
        logger.info(f"[Export] Edit content PDF generated: {len(pdf_bytes)} bytes")
        
        return StreamingResponse(
            iter([buffer.getvalue()]),
            media_type="application/pdf",
            headers={
                "Content-Disposition": f"attachment; filename*=UTF-8''{encoded_filename}",
                "Content-Length": str(len(pdf_bytes))
            }
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[Export] Edit content PDF export error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/extract-text", include_in_schema=True)
@router.post("/extract-text/", include_in_schema=True)
async def extract_text_from_file(file: UploadFile = File(...)):
    """
    Extract text from uploaded document (PDF, DOCX, TXT, MD).
    Extracts content from the document for editing.
    """
    try:
        logger.info(f"[Export] Extracting text from file: {file.filename}")
        
        if not file.filename:
            raise HTTPException(status_code=400, detail="Filename is required")
        
        file_content = await file.read()
        
        if not file_content:
            raise HTTPException(status_code=400, detail="File is empty")
        
        file_extension = file.filename.lower().split('.')[-1] if '.' in file.filename else ''
        
        if not file_extension:
            raise HTTPException(status_code=400, detail="File extension is required")
        
        extracted_text = ""
        
        # Extract content from document
        try:
            if file_extension == 'pdf':
                extracted_text = extract_text_from_pdf(file_content, max_chars=None)
            elif file_extension in ['docx', 'doc']:
                extracted_text = extract_text_from_docx(file_content, max_chars=None)
            elif file_extension in ['txt', 'md']:
                extracted_text = extract_text_from_txt(file_content, max_chars=None)
            elif file_extension in ['pptx', 'ppt']:
                extracted_text = extract_text_from_pptx(file_content, max_chars=None)
            else:
                raise HTTPException(status_code=400, detail=f"Unsupported file type: {file_extension}")
        except HTTPException:
            raise
        except Exception as extraction_error:
            logger.error(f"[Export] Extraction failed for {file.filename}: {extraction_error}")
            raise HTTPException(status_code=500, detail=f"Failed to extract text from file: {str(extraction_error)}")
        
        if not extracted_text:
            logger.warning(f"[Export] No text extracted from {file.filename}")
            # Return empty string instead of error - some files might legitimately be empty
            return JSONResponse(content={"text": ""})
        
        logger.info(f"[Export] Successfully extracted {len(extracted_text)} characters from {file.filename}")
        
        return JSONResponse(content={"text": extracted_text})
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[Export] Text extraction error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

def get_router():
    """Get export router for mounting"""
    return router
