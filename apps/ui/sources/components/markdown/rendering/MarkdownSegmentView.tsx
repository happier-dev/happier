import * as React from 'react';
import type { StyleProp, TextStyle } from 'react-native';

import { EnrichedMarkdownTextAdapter } from '../enriched/EnrichedMarkdownTextAdapter';
import type { Option } from '../MarkdownBlockView';
import type { StreamingTextRevealPreset } from '../streaming/streamingTextRevealConfig';
import type { MarkdownRenderingProfile } from './MarkdownRenderingProfile';
import type { MarkdownRenderSegment } from './markdownRenderSegmentTypes';
import { SpecialMarkdownBlockView } from './SpecialMarkdownBlockView';

type MarkdownSegmentViewProps = Readonly<{
    segment: MarkdownRenderSegment;
    selectable: boolean;
    onOptionPress?: (option: Option) => void;
    onLinkPress?: (url: string) => boolean | void;
    textStyle?: StyleProp<TextStyle>;
    profile: MarkdownRenderingProfile;
    streamingReveal: boolean;
    streamingRevealPreset?: StreamingTextRevealPreset;
}>;

export const MarkdownSegmentView = React.memo((props: MarkdownSegmentViewProps) => {
    if (props.segment.type === 'enriched-markdown') {
        return (
            <EnrichedMarkdownTextAdapter
                markdown={props.segment.markdown}
                profile={props.profile}
                selectable={props.selectable}
                onLinkPress={props.onLinkPress}
                textStyle={props.textStyle}
                streamingAnimated={props.streamingReveal}
                streamingRevealPreset={props.streamingRevealPreset}
                testID="markdown-enriched-run"
                suppressLeadingTopMargin={props.segment.first}
            />
        );
    }

    return (
        <SpecialMarkdownBlockView
            blocks={props.segment.blocks}
            first={props.segment.first}
            last={props.segment.last}
            selectable={props.selectable}
            onOptionPress={props.onOptionPress}
            onLinkPress={props.onLinkPress}
            textStyle={props.textStyle}
            profile={props.profile}
            streamingReveal={props.streamingReveal}
            streamingRevealPreset={props.streamingRevealPreset}
        />
    );
});
