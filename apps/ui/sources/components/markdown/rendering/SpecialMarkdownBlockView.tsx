import * as React from 'react';
import type { StyleProp, TextStyle } from 'react-native';

import { MarkdownBlockView, type Option, type OptionLongPressHandler } from '../MarkdownBlockView';
import type { MarkdownBlock } from '../parseMarkdown';
import type { StreamingTextRevealPreset } from '../streaming/streamingTextRevealConfig';
import { markdownProfileToLegacyVariant, type MarkdownRenderingProfile } from './MarkdownRenderingProfile';
import type { FindTextRange } from '@happier-dev/plugin-ui/presentation';
import { sliceFindRanges } from '@/components/ui/text/FindHighlightedText';

type SpecialMarkdownBlockViewProps = Readonly<{
    blocks: readonly MarkdownBlock[];
    first: boolean;
    last: boolean;
    selectable: boolean;
    onOptionPress?: (option: Option) => void;
    onOptionLongPress?: OptionLongPressHandler;
    onLinkPress?: (url: string) => boolean | void;
    textStyle?: StyleProp<TextStyle>;
    profile: MarkdownRenderingProfile;
    streamingReveal: boolean;
    streamingRevealPreset?: StreamingTextRevealPreset;
    agentTexMath: boolean;
    findSourceRanges?: readonly FindTextRange[];
    sourceStart?: number;
    markdown?: string;
}>;

export const SpecialMarkdownBlockView = React.memo((props: SpecialMarkdownBlockViewProps) => {
    const variant = markdownProfileToLegacyVariant(props.profile);
    let cursor = 0;

    return (
        <>
            {props.blocks.map((block, index) => {
                let ranges: readonly FindTextRange[] | undefined;
                const locateRanges = (text: string) => {
                    const start = props.markdown?.indexOf(text, cursor) ?? -1;
                    if (start < 0) return [];
                    cursor = start + text.length;
                    return sliceFindRanges(props.findSourceRanges, (props.sourceStart ?? 0) + start, text.length) ?? [];
                };
                const optionRanges = block.type === 'options' && props.findSourceRanges?.length ? block.items.map(locateRanges) : undefined;
                const tableRanges = block.type === 'table' && props.findSourceRanges?.length ? {
                    headers: block.headers.map(locateRanges),
                    rows: block.rows.map((row) => row.map(locateRanges)),
                } : undefined;
                if (block.type === 'code-block' && props.markdown && props.findSourceRanges?.length) {
                    cursor = props.markdown.indexOf('\n', cursor) + 1;
                    const start = props.markdown.indexOf(block.content, cursor);
                    if (start >= 0) ranges = sliceFindRanges(props.findSourceRanges, (props.sourceStart ?? 0) + start, block.content.length);
                    cursor = Math.max(cursor, start + block.content.length);
                }
                return (
                <MarkdownBlockView
                    key={`${block.type}:${index}`}
                    block={block}
                    first={props.first && index === 0}
                    last={props.last && index === props.blocks.length - 1}
                    selectable={props.selectable}
                    onOptionPress={props.onOptionPress}
                    onOptionLongPress={props.onOptionLongPress}
                    onLinkPress={props.onLinkPress}
                    textStyle={props.textStyle}
                    variant={variant}
                    profile={props.profile}
                    streamingReveal={props.streamingReveal}
                    streamingRevealPreset={props.streamingRevealPreset}
                    agentTexMath={props.agentTexMath}
                    findRanges={ranges}
                    findOptionRanges={optionRanges}
                    findTableRanges={tableRanges}
                />
            ); })}
        </>
    );
});
