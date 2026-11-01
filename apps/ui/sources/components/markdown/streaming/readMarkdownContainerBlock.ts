import type { parser } from '@lezer/markdown';
import type { MarkdownBlock } from '../parseMarkdown';
import { parseMarkdownBlock } from '../parseMarkdownBlock';
import { parseMarkdownSpans } from '../parseMarkdownSpans';

type SyntaxNode = ReturnType<typeof parser.parse>['topNode'];

export type MarkdownContainerBlock = Readonly<{ sourceStart: number }> & (
    | Readonly<{ type: 'code'; block: MarkdownBlock }>
    | Readonly<{ type: 'prose'; markdown: string }>
    | Readonly<{ type: 'quote'; children: readonly MarkdownContainerBlock[] }>
    | Readonly<{ type: 'list'; items: readonly Readonly<{
        sourceStart: number;
        marker: string;
        checked?: boolean;
        label?: string;
        children: readonly MarkdownContainerBlock[];
    }>[] }>
);

export function containsMarkdownCode(node: SyntaxNode): boolean {
    if (node.name === 'FencedCode' || node.name === 'CodeBlock') return true;
    for (let child = node.firstChild; child; child = child.nextSibling) {
        if (containsMarkdownCode(child)) return true;
    }
    return false;
}

export function readMarkdownCodeBlock(markdown: string, node: SyntaxNode): MarkdownBlock {
    if (node.name === 'FencedCode') {
        // The existing fence parser owns indentation, language and diagram policy.
        const block = parseMarkdownBlock(readProse(markdown, node))[0];
        if (!block) throw new Error('Markdown grammar produced a code fence without a block');
        return block;
    }
    let content = '';
    let previousEnd: number | null = null;
    for (const text of node.getChildren('CodeText')) {
        if (previousEnd !== null) {
            // The grammar removes container indentation and exposes quote markers
            // separately. Preserve line breaks between its exact code-text slices.
            content += markdown.slice(previousEnd, text.from).match(/\r\n|\n|\r/g)?.join('') ?? '';
        }
        content += markdown.slice(text.from, text.to);
        previousEnd = text.to;
    }
    return { type: 'code-block', content, language: null };
}

function stripIndent(line: string, width: number): string {
    let column = 0;
    let offset = 0;
    while (offset < line.length && column < width) {
        if (line[offset] === ' ') column++;
        else if (line[offset] === '\t') column += 4 - column % 4;
        else break;
        offset++;
    }
    return ' '.repeat(Math.max(0, column - width)) + line.slice(offset);
}

function readProse(markdown: string, node: SyntaxNode): string {
    const start = markdown.lastIndexOf('\n', node.from - 1) + 1;
    const prefix = markdown.slice(start, node.from).replace(/> ?/g, '');
    const indent = Array.from(prefix).reduce((column, character) => character === '\t' ? column + 4 - column % 4 : column + 1, 0);
    const taskMarker = node.getChild('TaskMarker');
    let cursor = taskMarker ? taskMarker.to + (markdown[taskMarker.to] === ' ' ? 1 : 0) : node.from;
    let source = '';
    for (const marker of node.getChildren('QuoteMark')) {
        source += markdown.slice(cursor, marker.from);
        cursor = marker.to + (markdown[marker.to] === ' ' ? 1 : 0);
    }
    source += markdown.slice(cursor, node.to);
    return source.split('\n').map((line, index) => index === 0 ? line : stripIndent(line, indent)).join('\n');
}

export function readMarkdownContainerBlock(markdown: string, node: SyntaxNode, referenceDefinitions: string): MarkdownContainerBlock {
    const sourceStart = node.from;
    if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
        return { type: 'code', sourceStart, block: readMarkdownCodeBlock(markdown, node) };
    }
    const readChildren = (parent: SyntaxNode) => {
        const children: MarkdownContainerBlock[] = [];
        for (let child = parent.firstChild; child; child = child.nextSibling) {
            if (child.name === 'QuoteMark' || child.name === 'ListMark' || child.name === 'LinkReference') continue;
            children.push(readMarkdownContainerBlock(markdown, child, referenceDefinitions));
        }
        return children;
    };
    if (node.name === 'Blockquote') return { type: 'quote', sourceStart, children: readChildren(node) };
    if (node.name === 'BulletList' || node.name === 'OrderedList') {
        const ordered = node.name === 'OrderedList';
        const items = node.getChildren('ListItem');
        const firstMarker = items[0]?.getChild('ListMark');
        const firstNumber = firstMarker ? Number.parseInt(markdown.slice(firstMarker.from, firstMarker.to), 10) : 1;
        return {
            type: 'list', sourceStart,
            items: items.map((item, index) => {
                const taskNode = item.getChild('Task');
                const task = taskNode?.getChild('TaskMarker');
                return {
                    sourceStart: item.from,
                    marker: ordered ? `${firstNumber + index}.` : '•',
                    checked: task ? markdown.slice(task.from, task.to).toLowerCase() === '[x]' : undefined,
                    label: task && taskNode ? parseMarkdownSpans(readProse(markdown, taskNode), true).map(span => span.text).join('') : undefined,
                    children: readChildren(item),
                };
            }),
        };
    }
    const source = readProse(markdown, node);
    return { type: 'prose', sourceStart, markdown: referenceDefinitions ? `${referenceDefinitions}\n\n${source}` : source };
}
