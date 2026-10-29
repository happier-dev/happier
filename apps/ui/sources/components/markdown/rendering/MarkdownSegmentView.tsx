import * as React from 'react';
import type { StyleProp, TextStyle } from 'react-native';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { EnrichedMarkdownTextAdapter } from '../enriched/EnrichedMarkdownTextAdapter';
import type { Option, OptionLongPressHandler } from '../MarkdownBlockView';
import type { MarkdownSelectionAction, MarkdownSourceRange, MarkdownSourceRangeAction, MarkdownSourceRangeLayoutObserver } from '../MarkdownView';
import type { StreamingTextRevealPreset } from '../streaming/streamingTextRevealConfig';
import type { MarkdownRenderingProfile } from './MarkdownRenderingProfile';
import type { MarkdownInlineReferences } from '../markdownInlineReferences';
import type { MarkdownImageResolver, MarkdownImageDocument } from '../markdownImages';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import type { MarkdownRenderSegment } from './markdownRenderSegmentTypes';
import { SpecialMarkdownBlockView } from './SpecialMarkdownBlockView';
import { MarkdownContainerView } from './MarkdownContainerView';
import { MarkdownFindFallback } from './MarkdownFindFallback';
import { useMarkdownSelectionMenu } from './useMarkdownSelectionMenu';
import type { FindTextRange } from '@happier-dev/plugin-ui/presentation';

type MarkdownSegmentViewProps = Readonly<{
    segment: MarkdownRenderSegment;
    selectable: boolean;
    onOptionPress?: (option: Option) => void;
    onOptionLongPress?: OptionLongPressHandler;
    onLinkPress?: (url: string) => boolean | void;
    textStyle?: StyleProp<TextStyle>;
    profile: MarkdownRenderingProfile;
    streamingReveal: boolean;
    streamingRevealPreset?: StreamingTextRevealPreset;
    /**
     * Whether this renderer splits and wraps source ranges at all — owned by `MarkdownViewRenderer`,
     * which already uses the same value to decide how the markdown is segmented. It is the wrapper's
     * identity: the wrapper exists exactly when this is true, and never changes shape or element
     * type because a live handler, highlight or comment came and went.
     */
    sourceRangeInteractionsActive: boolean;
    sourceRangeLayoutObserver?: MarkdownSourceRangeLayoutObserver;
    onPressSourceRange?: (action: MarkdownSourceRangeAction) => void;
    sourceRangePressable?: (action: MarkdownSourceRangeAction) => boolean;
    selectionActions?: readonly MarkdownSelectionAction[];
    renderAfterSourceRange?: (action: MarkdownSourceRangeAction) => React.ReactNode;
    highlightSourceRange?: MarkdownSourceRange | null;
    findSourceRanges?: readonly FindTextRange[];
    findActive?: boolean;
    agentTexMath: boolean;
    inlineReferences?: MarkdownInlineReferences;
    images?: MarkdownImageResolver;
    imageScope?: WorkspaceScopeBase;
    imageDocument?: MarkdownImageDocument;
}>;

export const MarkdownSegmentView = React.memo((props: MarkdownSegmentViewProps) => {
    const sourceAction = React.useMemo<MarkdownSourceRangeAction>(() => ({
        sourceRange: props.segment.sourceRange,
        markdown: props.segment.markdown,
        renderMarkdown: props.segment.type === 'enriched-markdown' ? props.segment.renderMarkdown ?? props.segment.markdown : props.segment.markdown,
        sourceStart: props.segment.sourceStart,
        sourceLength: props.segment.sourceLength,
    }), [props.segment]);
    const highlighted = rangesOverlap(props.segment.sourceRange, props.highlightSourceRange ?? null);
    // Only a block a mark touches leaves the native renderer for the decorating one (it has no
    // character decoration); the rest keep native text and its selection menu.
    const segmentEnd = props.segment.sourceStart + props.segment.sourceLength;
    const marked = props.findSourceRanges?.some((range) => range.start < segmentEnd && range.end > props.segment.sourceStart) === true;
    // The renderer's selection menu (native) offers the caller's actions for this block.
    const selectionActions = props.selectionActions;
    const contextMenuItems = useMarkdownSelectionMenu(selectionActions, sourceAction);
    const content = props.segment.type === 'enriched-markdown' && (props.findActive || marked)
        ? <MarkdownFindFallback markdown={props.segment.markdown} sourceStart={props.segment.sourceStart}
            renderMarkdown={props.segment.renderMarkdown} contextMenuItems={contextMenuItems}
            ranges={props.findSourceRanges ?? EMPTY_FIND_RANGES} profile={props.profile} selectable={props.selectable}
            first={props.segment.first} last={props.segment.last} onLinkPress={props.onLinkPress}
            onOptionPress={props.onOptionPress} onOptionLongPress={props.onOptionLongPress} textStyle={props.textStyle}
            agentTexMath={props.agentTexMath} inlineReferences={props.inlineReferences} />
        : props.segment.type === 'enriched-markdown'
        ? (
            <EnrichedMarkdownTextAdapter
                markdown={props.segment.renderMarkdown ?? props.segment.markdown}
                profile={props.profile}
                selectable={props.selectable}
                onLinkPress={props.onLinkPress}
                textStyle={props.textStyle}
                streamingAnimated={props.streamingReveal}
                streamingRevealPreset={props.streamingRevealPreset}
                testID="markdown-enriched-run"
                contextMenuItems={contextMenuItems}
                suppressLeadingTopMargin={props.segment.first}
                keepTrailingMargin={!props.segment.last}
                agentTexMath={props.agentTexMath}
                inlineReferences={props.inlineReferences}
            />
        )
        : props.segment.type === 'container-block' ? (
            <MarkdownContainerView
                block={props.segment.container}
                sourceStart={props.segment.sourceStart}
                sourceAction={sourceAction}
                selectionActions={selectionActions}
                selectable={props.selectable}
                profile={props.profile}
                onLinkPress={props.onLinkPress}
                textStyle={props.textStyle}
                streamingReveal={props.streamingReveal}
                streamingRevealPreset={props.streamingRevealPreset}
                agentTexMath={props.agentTexMath}
                findActive={props.findActive}
                findSourceRanges={props.findSourceRanges}
                inlineReferences={props.inlineReferences}
            />
        ) : (
            <SpecialMarkdownBlockView
                blocks={props.segment.blocks}
                images={props.images}
                imageScope={props.imageScope}
                imageDocument={props.imageDocument}
                findSourceRanges={props.findSourceRanges}
                sourceStart={props.segment.sourceStart}
                markdown={props.segment.markdown}
                first={props.segment.first}
                last={props.segment.last}
                selectable={props.selectable}
                onOptionPress={props.onOptionPress}
                onOptionLongPress={props.onOptionLongPress}
                onLinkPress={props.onLinkPress}
                textStyle={props.textStyle}
                profile={props.profile}
                streamingReveal={props.streamingReveal}
                streamingRevealPreset={props.streamingRevealPreset}
                agentTexMath={props.agentTexMath}
            />
        );

    if (!props.sourceRangeInteractionsActive) return content;

    const after = props.renderAfterSourceRange?.(sourceAction) ?? null;
    const testID = `markdown-source-range-trigger:${props.segment.sourceRange.startLine}-${props.segment.sourceRange.endLine}`;
    // One element type, always. Review-comment mode flips `onPressSourceRange` for every segment of
    // the open file at once; swapping `Pressable` for `View` on that flip would remount all of them.
    // An inactive range passes pointer handling to its descendants. Disabling the wrapper would
    // also mark loaded image/link controls inside it disabled for assistive technologies.
    const pressable = props.onPressSourceRange !== undefined && (props.sourceRangePressable?.(sourceAction) ?? true);
    const requestSelection = marked && selectionActions?.length === 1;
    const interactive = pressable || Boolean(requestSelection);
    return (
        <View style={styles.sourceRangeContainer}
            onLayout={props.sourceRangeLayoutObserver
                ? (event) => props.sourceRangeLayoutObserver?.onLayout(sourceAction, event.nativeEvent.layout)
                : undefined}
        >
            <Pressable
                testID={testID}
                accessibilityRole={pressable ? 'button' : undefined}
                pointerEvents={interactive ? 'auto' : 'box-none'}
                accessible={interactive}
                focusable={interactive}
                tabIndex={interactive ? undefined : -1}
                onPress={pressable ? () => props.onPressSourceRange?.(sourceAction) : undefined}
                onLongPress={requestSelection ? () => selectionActions[0]!.onPress(sourceAction) : undefined}
                style={[styles.sourceRangeTrigger, highlighted ? styles.highlight : null]}
            >
                {content}
            </Pressable>
            {after}
        </View>
    );
});

const EMPTY_FIND_RANGES: readonly FindTextRange[] = [];

function rangesOverlap(a: MarkdownSourceRange, b: MarkdownSourceRange | null): boolean {
    if (!b) return false;
    return a.startLine <= b.endLine && b.startLine <= a.endLine;
}

const styles = StyleSheet.create((theme) => ({
    sourceRangeContainer: {
        width: '100%',
        alignSelf: 'stretch',
        alignItems: 'stretch',
    },
    sourceRangeTrigger: {
        width: '100%',
        alignSelf: 'stretch',
        alignItems: 'stretch',
        justifyContent: 'flex-start',
        textAlign: 'left',
    },
    highlight: {
        borderRadius: 8,
        backgroundColor: theme.colors.surface.selected,
    },
}));
