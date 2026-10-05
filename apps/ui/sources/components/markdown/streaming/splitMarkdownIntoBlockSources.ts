import { parser, GFM } from '@lezer/markdown';
import { readIncompleteMarkdownBlockKind, type IncompleteMarkdownBlockKind } from './isIncompleteMarkdownBlockSource';

const markdownBlockParser = parser.configure(GFM);

/** The same grammar owns rendering boundaries and display-to-source projections. */
export function parseMarkdownSyntax(markdown: string) {
    return markdownBlockParser.parse(markdown);
}

export type MarkdownBlockSource = Readonly<{
    index: number;
    source: string;
    sourceStart: number;
    blockType: string;
    referenceDefinitions: string;
    incompleteKind: IncompleteMarkdownBlockKind | null;
}>;

/** One grammar owns boundaries for both grouped rendering and source-range measurement. */
export function splitMarkdownIntoBlockSources(markdown: string): MarkdownBlockSource[] {
    const tree = parseMarkdownSyntax(markdown);
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
        });
    }
    return sources;
}
