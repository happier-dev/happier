import type { MarkdownSpan } from "./parseMarkdown";

// Updated pattern to handle nested markdown and asterisks
const pattern = /(\*\*(.*?)(?:\*\*|$))|(\*(.*?)(?:\*|$))|(\[([^\]]+)\](?:\(([^)]+)\))?)|(`(.*?)(?:`|$))/g;

const autoLinkPattern = /\b((?:https?:\/\/|www\.)[^\s<]+)/g;
const trailingPunctuationPattern = /[.,)\]}]+$/;

function splitPlainTextWithAutoLinks(text: string): MarkdownSpan[] {
    const out: MarkdownSpan[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = autoLinkPattern.exec(text)) !== null) {
        const full = match[1] ?? '';
        const start = match.index;

        if (start > lastIndex) {
            out.push({ styles: [], text: text.slice(lastIndex, start), url: null });
        }

        let urlText = full;
        const trimmed = urlText.replace(trailingPunctuationPattern, '');
        urlText = trimmed || urlText;

        const trailing = full.slice(urlText.length);

        const href = urlText.startsWith('www.') ? `https://${urlText}` : urlText;
        out.push({ styles: [], text: urlText, url: href });

        if (trailing) {
            out.push({ styles: [], text: trailing, url: null });
        }

        lastIndex = start + full.length;
    }

    if (lastIndex < text.length) {
        out.push({ styles: [], text: text.slice(lastIndex), url: null });
    }

    return out;
}

export function parseMarkdownSpans(markdown: string, header: boolean) {
    const spans: MarkdownSpan[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(markdown)) !== null) {
        // Capture the text between the end of the last match and the start of this match as plain text
        const plainText = markdown.slice(lastIndex, match.index);
        if (plainText) {
            spans.push(...splitPlainTextWithAutoLinks(plainText));
        }

        if (match[1]) {
            // Bold
            if (header) {
                spans.push({ styles: [], text: match[2], url: null });
            } else {
                spans.push({ styles: ['bold'], text: match[2], url: null });
            }
        } else if (match[3]) {
            // Italic
            if (header) {
                spans.push({ styles: [], text: match[4], url: null });
            } else {
                spans.push({ styles: ['italic'], text: match[4], url: null });
            }
        } else if (match[5]) {
            // Link - handle incomplete links (no URL part)
            if (match[7]) {
                spans.push({ styles: [], text: match[6], url: match[7] });
            } else {
                // If no URL part, treat as plain text with brackets
                spans.push({ styles: [], text: `[${match[6]}]`, url: null });
            }
        } else if (match[8]) {
            // Inline code
            spans.push({ styles: ['code'], text: match[9], url: null });
        }

        lastIndex = pattern.lastIndex;
    }

    // If there's any text remaining after the last match, treat it as plain
    if (lastIndex < markdown.length) {
        spans.push(...splitPlainTextWithAutoLinks(markdown.slice(lastIndex)));
    }

    return spans;
}
