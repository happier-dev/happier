import { parser, GFM } from '@lezer/markdown';
import { readIncompleteMarkdownBlockKind, type IncompleteMarkdownBlockKind } from './isIncompleteMarkdownBlockSource';
import type { MarkdownBlock } from '../parseMarkdown';
import { containsMarkdownCode, readMarkdownCodeBlock, readMarkdownContainerBlock, type MarkdownContainerBlock } from './readMarkdownContainerBlock';

const markdownBlockParser = parser.configure(GFM);

export type MarkdownBlockSource = Readonly<{
    index: number;
    source: string;
    sourceStart: number;
    blockType: string;
    referenceDefinitions: string;
    incompleteKind: IncompleteMarkdownBlockKind | null;
    container?: MarkdownContainerBlock;
    codeBlock?: MarkdownBlock;
}>;

/** One grammar owns boundaries for both grouped rendering and source-range measurement. */
export function splitMarkdownIntoBlockSources(markdown: string): MarkdownBlockSource[] {
    const tree = markdownBlockParser.parse(markdown);
    const definitions: string[] = [];
    tree.iterate({ enter(node) {
        if (node.name !== 'LinkReference') return;
        // Container markers are grammar tokens, not part of a global definition.
        let cursor = node.from;
        let definition = '';
        for (const marker of node.node.getChildren('QuoteMark')) {
            definition += markdown.slice(cursor, marker.from);
            cursor = marker.to;
        }
        definitions.push(definition + markdown.slice(cursor, node.to));
    } });
    const referenceDefinitions = definitions.join('\n');
    const sources: MarkdownBlockSource[] = [];
    for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
        if (node.name === 'LinkReference') continue;
        const sourceStart = markdown.lastIndexOf('\n', node.from - 1) + 1;
        const source = markdown.slice(sourceStart, node.to);
        sources.push({
            index: sources.length,
            source,
            sourceStart,
            blockType: node.name,
            referenceDefinitions,
            incompleteKind: readIncompleteMarkdownBlockKind(source),
            ...((node.name === 'BulletList' || node.name === 'OrderedList' || node.name === 'Blockquote') && containsMarkdownCode(node)
                ? { container: readMarkdownContainerBlock(markdown, node, referenceDefinitions) } : null),
            ...(node.name === 'CodeBlock' ? { codeBlock: readMarkdownCodeBlock(markdown, node) } : null),
        });
    }
    return sources;
}
