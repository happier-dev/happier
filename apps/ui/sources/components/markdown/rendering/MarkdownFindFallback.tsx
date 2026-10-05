import * as React from 'react';
import { MarkdownBlockView } from '../MarkdownBlockView';
import type { MarkdownBlock, MarkdownSpan } from '../parseMarkdown';
import { parseMarkdownSyntax } from '../streaming/splitMarkdownIntoBlockSources';
import { projectMarkdownFindSpans } from '@/components/markdown/rendering/markdownFindProjection';
import type { FindTextRange } from '@happier-dev/plugin-ui/presentation';
import { markdownProfileToLegacyVariant } from './MarkdownRenderingProfile';
import { MarkdownFindDecorationContext, projectLeafRanges } from './MarkdownFindDecorationContext';
import type { MarkdownView } from '../MarkdownView';

type SyntaxNode = ReturnType<typeof parseMarkdownSyntax>['topNode'];

type Props = Pick<React.ComponentProps<typeof MarkdownView>, 'onOptionPress' | 'onOptionLongPress' | 'onLinkPress' | 'textStyle' | 'inlineReferences'> & Readonly<{
    markdown: string;
    sourceStart: number;
    ranges: readonly FindTextRange[];
    profile: NonNullable<React.ComponentProps<typeof MarkdownView>['profile']>;
    selectable: boolean;
    first: boolean;
    last: boolean;
    agentTexMath: boolean;
}>;

/** The native enriched API has no character decoration. Reuse the React block renderer
 * with leaves from the incumbent grammar while Find is active, including nested spans. */
export function MarkdownFindFallback(props: Props) {
    const prepared = React.useMemo(() => {
        const decorations = new Map<MarkdownSpan, readonly FindTextRange[]>();
        const spansAt = (start: number, end: number): MarkdownSpan[] => {
            const leaves = projectMarkdownFindSpans(props.markdown.slice(start, end));
            return leaves.map((leaf) => {
                const span: MarkdownSpan = { text: leaf.text, styles: leaf.styles, url: leaf.url };
                decorations.set(span, projectLeafRanges(leaf, props.sourceStart + start, props.ranges));
                return span;
            });
        };
        const blocks: MarkdownBlock[] = [];
        const visit = (node: SyntaxNode) => {
            if (node.name === 'LinkReference') return;
            if (node.name === 'BulletList' || node.name === 'OrderedList') {
                const items: { depth: number; number: number; spans: MarkdownSpan[] }[] = [];
                const collect = (list: SyntaxNode, depth: number) => {
                    for (let item = list.firstChild; item; item = item.nextSibling) {
                        if (item.name !== 'ListItem') continue;
                        const content: MarkdownSpan[] = [];
                        for (let child = item.firstChild; child; child = child.nextSibling) {
                            if (child.name === 'ListMark') continue;
                            if (child.name === 'BulletList' || child.name === 'OrderedList') continue;
                            content.push(...spansAt(child.from, child.to));
                        }
                        const marker = item.getChild('ListMark');
                        items.push({ depth, number: marker ? Number.parseInt(props.markdown.slice(marker.from, marker.to), 10) || 1 : 1, spans: content });
                        for (let child = item.firstChild; child; child = child.nextSibling) {
                            if (child.name === 'BulletList' || child.name === 'OrderedList') collect(child, depth + 1);
                        }
                    }
                };
                collect(node, 0);
                blocks.push(node.name === 'OrderedList' ? { type: 'numbered-list', items } : { type: 'list', items });
            } else if (node.name.startsWith('ATXHeading') || node.name.startsWith('SetextHeading')) {
                const level = Number(node.name.slice(-1));
                blocks.push({ type: 'header', level: Math.max(1, Math.min(6, level)) as 1 | 2 | 3 | 4 | 5 | 6, content: spansAt(node.from, node.to) });
            } else if (node.name === 'HorizontalRule') {
                blocks.push({ type: 'horizontal-rule' });
            } else {
                blocks.push({ type: 'text', content: spansAt(node.from, node.to) });
            }
        };
        const tree = parseMarkdownSyntax(props.markdown);
        for (let node = tree.topNode.firstChild; node; node = node.nextSibling) visit(node);
        return { blocks, decorations };
    }, [props.markdown, props.ranges, props.sourceStart]);
    return <MarkdownFindDecorationContext.Provider value={prepared.decorations}>
        {prepared.blocks.map((block, index) => <MarkdownBlockView key={index} block={block}
            first={props.first && index === 0} last={props.last && index === prepared.blocks.length - 1}
            selectable={props.selectable} onOptionPress={props.onOptionPress} onOptionLongPress={props.onOptionLongPress}
            onLinkPress={props.onLinkPress} textStyle={props.textStyle} profile={props.profile}
            variant={markdownProfileToLegacyVariant(props.profile)} streamingReveal={false} agentTexMath={props.agentTexMath} />)}
    </MarkdownFindDecorationContext.Provider>;
}
