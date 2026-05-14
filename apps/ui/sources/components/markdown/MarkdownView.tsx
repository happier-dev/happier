import * as React from 'react';
import type { StyleProp, TextStyle } from 'react-native';

import type { Option } from './MarkdownBlockView';
import type { MarkdownSourceRange } from './parseMarkdown';
import {
    normalizeMarkdownRenderingProfile,
    type MarkdownRenderingProfile,
} from './rendering/MarkdownRenderingProfile';
import { MarkdownViewRenderer } from './rendering/MarkdownViewRenderer';
import type { StreamingTextRevealPreset } from './streaming/streamingTextRevealConfig';
import type { MarkdownStreamingMode } from './streaming/useStreamingMarkdownBlocks';

export type { Option };
export type { MarkdownRenderingProfile };
export type { MarkdownSourceRange };

export type MarkdownSourceRangeAction = Readonly<{
    sourceRange: MarkdownSourceRange;
    markdown: string;
}>;

export const MarkdownView = React.memo((props: {
    testID?: string;
    markdown: string;
    onOptionPress?: (option: Option) => void;
    onLinkPress?: (url: string) => boolean | void;
    textStyle?: StyleProp<TextStyle>;
    selectable?: boolean;
    profile?: MarkdownRenderingProfile;
    variant?: 'default' | 'thinking';
    streamingMode?: MarkdownStreamingMode;
    streamingAnimated?: boolean;
    streamingRevealPreset?: StreamingTextRevealPreset;
    staticRenderPlaceholderEnabled?: boolean;
    onPressSourceRange?: (action: MarkdownSourceRangeAction) => void;
    renderAfterSourceRange?: (action: MarkdownSourceRangeAction) => React.ReactNode;
    highlightSourceRange?: MarkdownSourceRange | null;
}) => {
    const profile = normalizeMarkdownRenderingProfile({
        profile: props.profile,
        variant: props.variant,
    });
    const selectable = props.selectable ?? true;

    return (
        <MarkdownViewRenderer
            testID={props.testID}
            markdown={props.markdown}
            onOptionPress={props.onOptionPress}
            onLinkPress={props.onLinkPress}
            textStyle={props.textStyle}
            selectable={selectable}
            profile={profile}
            streamingMode={props.streamingMode === 'streaming' ? 'streaming' : 'static'}
            streamingAnimated={props.streamingAnimated === true}
            streamingRevealPreset={props.streamingRevealPreset}
            staticRenderPlaceholderEnabled={props.staticRenderPlaceholderEnabled}
            onPressSourceRange={props.onPressSourceRange}
            renderAfterSourceRange={props.renderAfterSourceRange}
            highlightSourceRange={props.highlightSourceRange}
        />
    );
});
