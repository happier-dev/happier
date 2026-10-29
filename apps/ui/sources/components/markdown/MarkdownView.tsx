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
import type { MarkdownImageResolver } from './markdownImages';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
export type { MarkdownImageResolver } from './markdownImages';
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
    /** The renderer input, including this Doc's reference definitions when needed. */
    renderMarkdown?: string;
    /** The block's place in the whole Markdown source (UTF-16 offsets). */
    sourceStart: number;
    sourceLength: number;
}>;

/**
 * An action offered on the reader's text selection where the platform renderer has a selection menu
 * (native). Offsets index the actual native text, including renderer spacing.
 */
export type MarkdownRenderedSelection = Readonly<{
    renderedText?: string;
    text: string;
    start: number;
    end: number;
}>;
export type MarkdownSelectionAction = Readonly<{
    label: string;
    onPress: (block: MarkdownSourceRangeAction, selection?: MarkdownRenderedSelection) => void;
}>;

/** What `findSourceRanges` marks: Find matches, or commented passages (a Doc's comment marks). */
export type MarkdownSourceMarkKind = 'find' | 'passage';

export type MarkdownSourceRangeLayoutObserver = Readonly<{
    onRanges: (ranges: readonly MarkdownSourceRangeAction[]) => void;
    onLayout: (range: MarkdownSourceRangeAction, layout: Readonly<{ y: number; height: number }>) => void;
    /**
     * `block` (default) measures every block on its own. `run` measures the segments the renderer
     * already draws, so a native prose run stays one selectable text view (cross-paragraph selection)
     * and a range may span several blocks.
     */
    granularity?: 'block' | 'run';
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
    /** Stable message identity, independent of streaming revisions, for per-block presentation state. */
    codeBlockStateKey?: string;
    renderCacheKey?: string;
    sourceRangeLayoutObserver?: MarkdownSourceRangeLayoutObserver;
    onPressSourceRange?: (action: MarkdownSourceRangeAction) => void;
    /** Which blocks `onPressSourceRange` applies to; every block when absent. */
    sourceRangePressable?: (action: MarkdownSourceRangeAction) => boolean;
    selectionActions?: readonly MarkdownSelectionAction[];
    sourceMarkKind?: MarkdownSourceMarkKind;
    renderAfterSourceRange?: (action: MarkdownSourceRangeAction) => React.ReactNode;
    highlightSourceRange?: MarkdownSourceRange | null;
    findSourceRanges?: readonly FindTextRange[];
    findActive?: boolean;
    agentTexMath?: boolean;
    /** Citations the caller owns, drawn inline where the author placed them (`[text](scheme:target)`). */
    inlineReferences?: MarkdownInlineReferences;
    /** Image rendering is opt-in; transcript destinations remain stripped when absent. */
    images?: MarkdownImageResolver;
    /** Explicit Machine context for workspace image bytes; never inferred from a Session. */
    imageScope?: WorkspaceScopeBase;
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
            codeBlockStateKey={props.codeBlockStateKey}
            renderCacheKey={props.renderCacheKey}
            sourceRangeLayoutObserver={props.sourceRangeLayoutObserver}
            onPressSourceRange={props.onPressSourceRange}
            sourceRangePressable={props.sourceRangePressable}
            selectionActions={props.selectionActions}
            sourceMarkKind={props.sourceMarkKind ?? 'find'}
            renderAfterSourceRange={props.renderAfterSourceRange}
            highlightSourceRange={props.highlightSourceRange}
            findSourceRanges={props.findSourceRanges}
            findActive={props.findActive}
            agentTexMath={props.agentTexMath === true}
            inlineReferences={props.inlineReferences}
            images={props.images}
            imageScope={props.imageScope}
        />
    );
});
