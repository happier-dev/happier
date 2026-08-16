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
    onPressSourceRange?: (action: MarkdownSourceRangeAction) => void;
    renderAfterSourceRange?: (action: MarkdownSourceRangeAction) => React.ReactNode;
    highlightSourceRange?: MarkdownSourceRange | null;
    agentTexMath: boolean;
}>;

export const MarkdownSegmentView = React.memo((props: MarkdownSegmentViewProps) => {
    const sourceAction = React.useMemo<MarkdownSourceRangeAction>(() => ({
        sourceRange: props.segment.sourceRange,
        markdown: props.segment.type === 'enriched-markdown'
            ? props.segment.markdown
            : props.segment.markdown,
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

    const after = props.renderAfterSourceRange?.(sourceAction) ?? null;
    if (!props.onPressSourceRange && !after && !highlighted) return content;

    const testID = `markdown-source-range-trigger:${props.segment.sourceRange.startLine}-${props.segment.sourceRange.endLine}`;
    const Wrapper = props.onPressSourceRange ? Pressable : View;
    return (
        <View style={styles.sourceRangeContainer}>
            <Wrapper
                testID={testID}
                accessibilityRole={props.onPressSourceRange ? 'button' : undefined}
                onPress={props.onPressSourceRange ? () => props.onPressSourceRange?.(sourceAction) : undefined}
                style={[styles.sourceRangeTrigger, highlighted ? styles.highlight : null]}
            >
                {content}
            </Wrapper>
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
