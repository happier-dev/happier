import { parseMarkdownBlock } from "./parseMarkdownBlock"

export type MarkdownTableAlignment = 'left' | 'center' | 'right' | 'default';

export type MarkdownBlock = {
    type: 'text'
    content: MarkdownSpan[]
} | {
    type: 'header'
    level: 1 | 2 | 3 | 4 | 5 | 6
    content: MarkdownSpan[]
} | {
    type: 'list',
    items: { depth: number, spans: MarkdownSpan[] }[]
} | {
    type: 'numbered-list',
    items: { depth: number, number: number, spans: MarkdownSpan[] }[]
} | {
    type: 'code-block',
    language: string | null,
    content: string
} | {
    type: 'mermaid',
    content: string
} | {
    type: 'horizontal-rule'
} | {
    type: 'options',
    items: string[]
} | {
    type: 'table',
    headers: string[],
    rows: string[][],
    alignments: MarkdownTableAlignment[],
}

export type MarkdownSpan = {
    styles: ('italic' | 'bold' | 'semibold' | 'code')[],
    text: string,
    url: string | null
}

export function parseMarkdown(markdown: string) {
    return parseMarkdownBlock(markdown);
}
