import * as React from 'react';
import type { StyleProp, TextStyle } from 'react-native';

import { MarkdownBlockView, type Option, type OptionLongPressHandler } from '../MarkdownBlockView';
import type { MarkdownBlock } from '../parseMarkdown';
import type { StreamingTextRevealPreset } from '../streaming/streamingTextRevealConfig';
import { markdownProfileToLegacyVariant, type MarkdownRenderingProfile } from './MarkdownRenderingProfile';

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
}>;

export const SpecialMarkdownBlockView = React.memo((props: SpecialMarkdownBlockViewProps) => {
    const variant = markdownProfileToLegacyVariant(props.profile);

    return (
        <>
            {props.blocks.map((block, index) => (
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
                    streamingReveal={props.streamingReveal}
                    streamingRevealPreset={props.streamingRevealPreset}
                />
            ))}
        </>
    );
});
