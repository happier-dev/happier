import * as React from 'react';
import type { StyleProp, TextStyle } from 'react-native';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { EnrichedMarkdownTextAdapter } from '../enriched/EnrichedMarkdownTextAdapter';
import type { Option, OptionLongPressHandler } from '../MarkdownBlockView';
import type { MarkdownSourceRange, MarkdownSourceRangeAction } from '../MarkdownView';
import type { StreamingTextRevealPreset } from '../streaming/streamingTextRevealConfig';
import type { MarkdownRenderingProfile } from './MarkdownRenderingProfile';
import type { MarkdownRenderSegment } from './markdownRenderSegmentTypes';
import { SpecialMarkdownBlockView } from './SpecialMarkdownBlockView';

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
    onPressSourceRange?: (action: MarkdownSourceRangeAction) => void;
    renderAfterSourceRange?: (action: MarkdownSourceRangeAction) => React.ReactNode;
    highlightSourceRange?: MarkdownSourceRange | null;
    agentTexMath: boolean;
}>;

export const MarkdownSegmentView = React.memo((props: MarkdownSegmentViewProps) => {
    const sourceAction = React.useMemo<MarkdownSourceRangeAction>(() => ({
        sourceRange: props.segment.sourceRange,
        markdown: props.segment.markdown,
    }), [props.segment]);
    const highlighted = rangesOverlap(props.segment.sourceRange, props.highlightSourceRange ?? null);
    const content = props.segment.type === 'enriched-markdown'
        ? (
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
                agentTexMath={props.agentTexMath}
            />
        )
        : (
            <SpecialMarkdownBlockView
                blocks={props.segment.blocks}
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
    // A disabled `Pressable` claims no touch responder, so the non-review pass behaves like the
    // plain container it replaces and selection and link presses inside still reach the content.
    const pressable = props.onPressSourceRange !== undefined;
    return (
        <View style={styles.sourceRangeContainer}>
            <Pressable
                testID={testID}
                accessibilityRole={pressable ? 'button' : undefined}
                disabled={!pressable}
                onPress={pressable ? () => props.onPressSourceRange?.(sourceAction) : undefined}
                style={[styles.sourceRangeTrigger, highlighted ? styles.highlight : null]}
            >
                {content}
            </Pressable>
            {after}
        </View>
    );
});

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
