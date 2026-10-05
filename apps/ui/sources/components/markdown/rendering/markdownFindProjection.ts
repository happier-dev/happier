import type { MarkdownSpan } from '@/components/markdown/parseMarkdown';
import { parseMarkdownSyntax } from '@/components/markdown/streaming/splitMarkdownIntoBlockSources';
import { splitMarkdownRenderSegments } from '@/components/markdown/rendering/splitMarkdownRenderSegments';
import { normalizeLooseListContinuations } from '@/components/markdown/rendering/normalizeLooseListContinuations';

type SyntaxNode = ReturnType<typeof parseMarkdownSyntax>['topNode'];

export type FindDisplayText = Readonly<{
    text: string;
    sourceOffsets: readonly number[];
    sourceEnds: readonly number[];
    /** A known displayable body was omitted; callers must retain partial coverage. */
    incomplete?: true;
}>;

export type TranscriptFindMarkdownSpan = FindDisplayText & Readonly<{
    styles: MarkdownSpan['styles'];
    url: string | null;
}>;

export function projectPlainFindText(text: string, sourceStart = 0): FindDisplayText {
    return {
        text,
        sourceOffsets: Array.from({ length: text.length }, (_, index) => sourceStart + index),
        sourceEnds: Array.from({ length: text.length }, (_, index) => sourceStart + index + 1),
    };
}

const hiddenMarks = new Set([
    'HeaderMark', 'EmphasisMark', 'StrikethroughMark', 'CodeMark', 'LinkMark',
    'LinkLabel', 'LinkTitle', 'ListMark', 'QuoteMark', 'TaskMarker',
]);

type MarkdownFindDisplay = Readonly<{
    spans: readonly TranscriptFindMarkdownSpan[];
}>;

/** Display leaves use the rendering boundary's existing grammar, not a second Markdown parser. */
function projectMarkdownFindDisplay(markdown: string): MarkdownFindDisplay {
    const spans: TranscriptFindMarkdownSpan[] = [];
    const normalized = normalizeLooseListContinuations(markdown);
    const append = (text: string, start: number, styles: MarkdownSpan['styles'] = [], url: string | null = null) => {
        if (text.length > 0) spans.push({ ...projectPlainFindText(text, start), styles, url });
    };
    const separator = (offset: number) => {
        if (spans.length > 0 && !spans[spans.length - 1]!.text.endsWith('\n')) append('\n', offset);
    };
    const appendText = (source: string, from: number, to: number, base: number, styles: MarkdownSpan['styles'], url: string | null) => {
        let cursor = from;
        while (cursor < to) {
            if (cursor > 0 && source[cursor - 1] === '\n') {
                while (cursor < to && /[ \t]/.test(source[cursor]!)) cursor++;
            }
            const newline = source.indexOf('\n', cursor);
            if (newline < 0 || newline >= to) {
                append(source.slice(cursor, to), base + cursor, styles, url);
                return;
            }
            let lineEnd = newline;
            if (source[lineEnd - 1] === '\r') lineEnd--;
            while (lineEnd > cursor && /[ \t]/.test(source[lineEnd - 1]!)) lineEnd--;
            append(source.slice(cursor, lineEnd), base + cursor, styles, url);
            append('\n', base + newline, styles, url);
            cursor = newline + 1;
        }
    };
    const visit = (node: SyntaxNode, source: string, base: number, styles: MarkdownSpan['styles'] = [], url: string | null = null): void => {
        if (hiddenMarks.has(node.name) || node.name === 'LinkReference' || node.name === 'HorizontalRule') return;
        // md4c 0.5.0's actual Text projection omits entities outside code; Find
        // follows displayed glyphs, including that renderer behavior.
        if (node.name === 'Entity') return;
        if (node.name === 'Escape') {
            append(source.slice(node.from + 1, node.to), base + node.from + 1, styles, url);
            return;
        }
        if (node.name === 'HardBreak') {
            append('\n', base + node.to - 1, styles, url);
            return;
        }
        if (node.name === 'InlineCode') {
            const marks = node.getChildren('CodeMark');
            const from = marks[0]?.to ?? node.from;
            const to = marks[marks.length - 1]?.from ?? node.to;
            let text = source.slice(from, to).replace(/\n/g, ' ');
            let start = from;
            if (text.startsWith(' ') && text.endsWith(' ') && /\S/.test(text)) {
                text = text.slice(1, -1);
                start++;
            }
            append(text, base + start, [...styles, 'code'], url);
            return;
        }
        if (node.name === 'StrongEmphasis') styles = [...styles, 'bold'];
        if (node.name === 'Emphasis') styles = [...styles, 'italic'];
        if (node.name === 'Strikethrough') styles = [...styles, 'strikethrough'];
        if (node.name === 'Link' || node.name === 'Image') {
            const marks = node.getChildren('LinkMark');
            const start = marks[0]?.to ?? node.from;
            const end = marks[1]?.from ?? node.to;
            const destination = node.getChild('URL');
            const linkUrl = node.name === 'Link' && destination ? source.slice(destination.from, destination.to) : null;
            visitRange(node, source, base, start, end, styles, linkUrl);
            return;
        }
        if (node.name === 'Autolink') {
            const destination = node.getChild('URL');
            if (destination) append(source.slice(destination.from, destination.to), base + destination.from, styles, source.slice(destination.from, destination.to));
            return;
        }
        if (node.name === 'BulletList' || node.name === 'OrderedList' || node.name === 'Document') {
            for (let child = node.firstChild; child; child = child.nextSibling) {
                if (child.name === 'LinkReference' || child.name === 'HorizontalRule') continue;
                separator(base + child.from);
                visit(child, source, base, styles, url);
            }
            return;
        }
        if ((node.name === 'Blockquote' || node.name === 'ListItem') && node.getChild('Paragraph')) {
            for (let child = node.firstChild; child; child = child.nextSibling) {
                if (hiddenMarks.has(child.name)) continue;
                separator(base + child.from);
                visit(child, source, base, styles, url);
            }
            return;
        }
        let displayEnd = node.to;
        if (node.name === 'Paragraph' || node.name.includes('Heading')) {
            // md4c excludes trailing block whitespace from displayed text leaves.
            while (displayEnd > node.from && /[ \t]/.test(source[displayEnd - 1]!)) displayEnd--;
        }
        visitRange(node, source, base, node.from, displayEnd, styles, url);
    };
    const visitRange = (node: SyntaxNode, source: string, base: number, start: number, end: number, styles: MarkdownSpan['styles'], url: string | null) => {
        let cursor = start;
        const structural = node.name.startsWith('ATXHeading') || node.name === 'ListItem' || node.name === 'Task' || node.name === 'Blockquote';
        for (let child = node.firstChild; child; child = child.nextSibling) {
            if (child.to <= start || child.from >= end) continue;
            if (child.from > cursor) {
                let gapStart = cursor;
                let gapEnd = Math.min(child.from, end);
                const previousMark = child.prevSibling?.name;
                if ((structural && cursor === start) || previousMark === 'HeaderMark' || previousMark === 'ListMark' || previousMark === 'QuoteMark' || previousMark === 'TaskMarker') {
                    while (gapStart < gapEnd && /[ \t]/.test(source[gapStart]!)) gapStart++;
                }
                if (child.name === 'HeaderMark') {
                    while (gapEnd > gapStart && /\s/.test(source[gapEnd - 1]!)) gapEnd--;
                }
                appendText(source, gapStart, gapEnd, base, styles, url);
            }
            visit(child, source, base, styles, url);
            cursor = Math.max(cursor, child.to);
        }
        if (cursor < end) {
            let from = cursor;
            const previousMark = node.lastChild?.name;
            if ((structural && cursor === start) || previousMark === 'HeaderMark' || previousMark === 'ListMark' || previousMark === 'QuoteMark' || previousMark === 'TaskMarker') {
                while (from < end && /[ \t]/.test(source[from]!)) from++;
            }
            appendText(source, from, end, base, styles, url);
        }
    };

    for (const segment of splitMarkdownRenderSegments({ markdown, streamingMode: 'static' })) {
        separator(segment.sourceStart);
        if (segment.type === 'enriched-markdown') {
            const renderMarkdown = segment.renderMarkdown ?? segment.markdown;
            const definitionPrefixLength = renderMarkdown.length - segment.markdown.length;
            visit(parseMarkdownSyntax(renderMarkdown).topNode, renderMarkdown, segment.sourceStart - definitionPrefixLength);
            continue;
        }
        let sourceCursor = 0;
        const appendSpecial = (text: string, styles: MarkdownSpan['styles'] = []) => {
            let found = segment.markdown.indexOf(text, sourceCursor);
            if (found < 0) found = sourceCursor;
            append(text, segment.sourceStart + found, styles);
            sourceCursor = found + text.length;
        };
        for (const block of segment.blocks) {
            if (block.type === 'code-block') {
                sourceCursor = segment.markdown.indexOf('\n') + 1;
                const lines = block.content.split('\n');
                for (let index = 0; index < lines.length; index++) {
                    const line = lines[index]!;
                    const end = segment.markdown.indexOf('\n', sourceCursor);
                    const sourceEnd = end >= 0 ? end : segment.markdown.length;
                    // The parser removes only the opening fence's indentation.
                    const removed = sourceEnd - sourceCursor - line.length;
                    append(line, segment.sourceStart + sourceCursor + removed, ['code']);
                    if (index < lines.length - 1) append('\n', segment.sourceStart + sourceEnd, ['code']);
                    sourceCursor = sourceEnd + 1;
                }
            } else if (block.type === 'mermaid') {
                // Diagrams are non-text media, including their error-source fallback.
                continue;
            } else if (block.type === 'text' || block.type === 'header') {
                for (const span of block.content) appendSpecial(span.text, span.styles);
            } else if (block.type === 'options') {
                for (const item of block.items) {
                    separator(segment.sourceStart + sourceCursor);
                    appendSpecial(item);
                }
            } else if (block.type === 'list' || block.type === 'numbered-list') {
                for (const item of block.items) {
                    separator(segment.sourceStart + sourceCursor);
                    for (const span of item.spans) appendSpecial(span.text, span.styles);
                }
            } else if (block.type === 'table') {
                for (const row of [block.headers, ...block.rows]) {
                    separator(segment.sourceStart + sourceCursor);
                    for (const cell of row) {
                        separator(segment.sourceStart + sourceCursor);
                        const start = segment.markdown.indexOf(cell, sourceCursor);
                        if (start >= 0) {
                            visit(parseMarkdownSyntax(cell).topNode, cell, segment.sourceStart + start);
                            sourceCursor = start + cell.length;
                        }
                    }
                }
            }
        }
    }
    if (normalized === markdown) return { spans };
    // The render owner only inserts leading indentation. Corresponding line
    // offsets recover original source coordinates without guessing by text.
    const sourceLines = markdown.split('\n');
    const renderedLines = normalized.split('\n');
    const offsets: number[] = [];
    let sourceStart = 0;
    for (let line = 0; line < renderedLines.length; line++) {
        const source = sourceLines[line] ?? '';
        const rendered = renderedLines[line]!;
        const inserted = rendered.length - source.length;
        for (let column = 0; column < rendered.length; column++) {
            offsets.push(sourceStart + Math.max(0, column - inserted));
        }
        if (line < renderedLines.length - 1) offsets.push(sourceStart + source.length);
        sourceStart += source.length + 1;
    }
    return {
        spans: spans.map((span) => ({
            ...span,
            sourceOffsets: span.sourceOffsets.map((offset) => offsets[offset] ?? markdown.length),
            sourceEnds: span.sourceEnds.map((end) => end > 0 ? (offsets[end - 1] ?? markdown.length - 1) + 1 : 0),
        })),
    };
}

export function projectMarkdownFindSpans(markdown: string): readonly TranscriptFindMarkdownSpan[] {
    return projectMarkdownFindDisplay(markdown).spans;
}

export function projectMarkdownFindText(markdown: string): FindDisplayText {
    const { spans } = projectMarkdownFindDisplay(markdown);
    return {
        text: spans.map((span) => span.text).join(''),
        sourceOffsets: spans.flatMap((span) => span.sourceOffsets),
        sourceEnds: spans.flatMap((span) => span.sourceEnds),
    };
}
