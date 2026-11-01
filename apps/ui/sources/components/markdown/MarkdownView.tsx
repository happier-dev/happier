import * as React from 'react';
import type { StyleProp, TextStyle } from 'react-native';

import type { Option, OptionLongPressHandler } from './MarkdownBlockView';
import type { MarkdownSourceRange } from './parseMarkdown';
import {
    normalizeMarkdownRenderingProfile,
    type MarkdownRenderingProfile,
} from './rendering/MarkdownRenderingProfile';
import { MarkdownViewRenderer } from './rendering/MarkdownViewRenderer';
import type { StreamingTextRevealPreset } from './streaming/streamingTextRevealConfig';
import type { MarkdownStreamingMode } from './streaming/usePreparedStreamingMarkdown';

export type { Option };
export type { OptionLongPressHandler };
export type { MarkdownRenderingProfile };
export type { MarkdownSourceRange };

export type MarkdownSourceRangeAction = Readonly<{
    sourceRange: MarkdownSourceRange;
    markdown: string;
}>;

/**
 * An action offered in the platform text-selection menu of rendered prose (native renderers; on web
 * the surface hosting the Markdown owns its own selection affordance).
 */
export type MarkdownSelectionAction = Readonly<{
    label: string;
    onPress: (selection: Readonly<{ text: string }>) => void;
}>;

export type MarkdownSourceRangeLayoutObserver = Readonly<{
    onRanges: (ranges: readonly MarkdownSourceRangeAction[]) => void;
    onLayout: (range: MarkdownSourceRangeAction, layout: Readonly<{ y: number; height: number }>) => void;
}>;

export const MarkdownView = React.memo((props: {
    testID?: string;
    markdown: string;
    onOptionPress?: (option: Option) => void;
    onOptionLongPress?: OptionLongPressHandler;
    onLinkPress?: (url: string) => boolean | void;
    textStyle?: StyleProp<TextStyle>;
    selectable?: boolean;
    profile?: MarkdownRenderingProfile;
    variant?: 'default' | 'thinking';
    streamingMode?: MarkdownStreamingMode;
    streamingAnimated?: boolean;
    streamingParseCacheKey?: string | null;
    /** Stable message identity, independent of streaming revisions, for per-block presentation state. */
    codeBlockStateKey?: string;
    streamingRevealPreset?: StreamingTextRevealPreset;
    staticRenderPlaceholderEnabled?: boolean;
    sourceRangeLayoutObserver?: MarkdownSourceRangeLayoutObserver;
    onPressSourceRange?: (action: MarkdownSourceRangeAction) => void;
    renderAfterSourceRange?: (action: MarkdownSourceRangeAction) => React.ReactNode;
    highlightSourceRange?: MarkdownSourceRange | null;
    selectionActions?: readonly MarkdownSelectionAction[];
    agentTexMath?: boolean;
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
            onOptionLongPress={props.onOptionLongPress}
            onLinkPress={props.onLinkPress}
            textStyle={props.textStyle}
            selectable={selectable}
            profile={profile}
            streamingMode={props.streamingMode === 'streaming' ? 'streaming' : 'static'}
            streamingAnimated={props.streamingAnimated === true}
            streamingParseCacheKey={props.streamingParseCacheKey}
            codeBlockStateKey={props.codeBlockStateKey}
            streamingRevealPreset={props.streamingRevealPreset}
            staticRenderPlaceholderEnabled={props.staticRenderPlaceholderEnabled}
            sourceRangeLayoutObserver={props.sourceRangeLayoutObserver}
            onPressSourceRange={props.onPressSourceRange}
            renderAfterSourceRange={props.renderAfterSourceRange}
            highlightSourceRange={props.highlightSourceRange}
            selectionActions={props.selectionActions}
            agentTexMath={props.agentTexMath === true}
        />
    );
});
