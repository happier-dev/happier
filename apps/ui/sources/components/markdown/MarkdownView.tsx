import * as React from 'react';
import type { StyleProp, TextStyle } from 'react-native';

import type { Option, OptionLongPressHandler } from './MarkdownBlockView';
import type { MarkdownSourceRange } from './parseMarkdown';
import {
    normalizeMarkdownRenderingProfile,
    type MarkdownRenderingProfile,
} from './rendering/MarkdownRenderingProfile';
import { MarkdownViewRenderer } from './rendering/MarkdownViewRenderer';
import type { MarkdownInlineReferences } from './markdownInlineReferences';
export type { MarkdownInlineReference, MarkdownInlineReferences } from './markdownInlineReferences';
import type { StreamingTextRevealPreset } from './streaming/streamingTextRevealConfig';
import type { MarkdownStreamingMode } from './streaming/usePreparedStreamingMarkdown';
import type { FindTextRange } from '@happier-dev/plugin-ui/presentation';

export type { Option };
export type { OptionLongPressHandler };
export type { MarkdownRenderingProfile };
export type { MarkdownSourceRange };

export type MarkdownSourceRangeAction = Readonly<{
    sourceRange: MarkdownSourceRange;
    markdown: string;
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
    streamingRevealPreset?: StreamingTextRevealPreset;
    staticRenderPlaceholderEnabled?: boolean;
    renderCacheKey?: string;
    sourceRangeLayoutObserver?: MarkdownSourceRangeLayoutObserver;
    onPressSourceRange?: (action: MarkdownSourceRangeAction) => void;
    renderAfterSourceRange?: (action: MarkdownSourceRangeAction) => React.ReactNode;
    highlightSourceRange?: MarkdownSourceRange | null;
    findSourceRanges?: readonly FindTextRange[];
    findActive?: boolean;
    agentTexMath?: boolean;
    /** Citations the caller owns, drawn inline where the author placed them (`[text](scheme:target)`). */
    inlineReferences?: MarkdownInlineReferences;
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
            streamingRevealPreset={props.streamingRevealPreset}
            staticRenderPlaceholderEnabled={props.staticRenderPlaceholderEnabled}
            renderCacheKey={props.renderCacheKey}
            sourceRangeLayoutObserver={props.sourceRangeLayoutObserver}
            onPressSourceRange={props.onPressSourceRange}
            renderAfterSourceRange={props.renderAfterSourceRange}
            highlightSourceRange={props.highlightSourceRange}
            findSourceRanges={props.findSourceRanges}
            findActive={props.findActive}
            agentTexMath={props.agentTexMath === true}
            inlineReferences={props.inlineReferences}
        />
    );
});
