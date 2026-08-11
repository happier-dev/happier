import * as React from 'react';
import type { StyleProp, TextStyle } from 'react-native';
import { Platform, View } from 'react-native';

import type { Option, OptionLongPressHandler } from '../MarkdownBlockView';
import type { MarkdownSourceRange, MarkdownSourceRangeAction } from '../MarkdownView';
import { usePreparedStreamingMarkdown, type MarkdownStreamingMode } from '../streaming/usePreparedStreamingMarkdown';
import type { StreamingTextRevealPreset } from '../streaming/streamingTextRevealConfig';
import type { MarkdownRenderingProfile } from './MarkdownRenderingProfile';
import type { MarkdownRenderSegment } from './markdownRenderSegmentTypes';
import { MarkdownSegmentView } from './MarkdownSegmentView';
import {
    readMarkdownRenderSegmentsCache,
    writeMarkdownRenderSegmentsCache,
} from './markdownRenderSegmentsCache';
import { splitMarkdownRenderSegments } from './splitMarkdownRenderSegments';
import { StaticMarkdownRenderPlaceholder } from './StaticMarkdownRenderPlaceholder';
import { useDelayedStaticMarkdownRenderPlaceholder } from './useDelayedStaticMarkdownRenderPlaceholder';

type MarkdownViewRendererProps = Readonly<{
    testID?: string;
    markdown: string;
    onOptionPress?: (option: Option) => void;
    onOptionLongPress?: OptionLongPressHandler;
    onLinkPress?: (url: string) => boolean | void;
    textStyle?: StyleProp<TextStyle>;
    selectable: boolean;
    profile: MarkdownRenderingProfile;
    streamingMode: MarkdownStreamingMode;
    streamingAnimated: boolean;
    streamingParseCacheKey?: string | null;
    streamingRevealPreset?: StreamingTextRevealPreset;
    staticRenderPlaceholderEnabled?: boolean;
    onPressSourceRange?: (action: MarkdownSourceRangeAction) => void;
    renderAfterSourceRange?: (action: MarkdownSourceRangeAction) => React.ReactNode;
    highlightSourceRange?: MarkdownSourceRange | null;
}>;

function readStreamingSegmentCache(params: Readonly<{
    parseCacheKey: string | null | undefined;
    preparedMarkdown: string;
    streamingMode: MarkdownStreamingMode;
    splitEnrichedSourceRanges: boolean;
}>): readonly MarkdownRenderSegment[] | null {
    if (params.streamingMode !== 'streaming') return null;
    if (params.splitEnrichedSourceRanges) return null;
    const key = typeof params.parseCacheKey === 'string' && params.parseCacheKey.length > 0
        ? params.parseCacheKey
        : null;
    if (!key) return null;
    return readMarkdownRenderSegmentsCache(`stream:${key}`, params.preparedMarkdown);
}

function writeStreamingSegmentCache(params: Readonly<{
    parseCacheKey: string | null | undefined;
    preparedMarkdown: string;
    streamingMode: MarkdownStreamingMode;
    splitEnrichedSourceRanges: boolean;
    segments: MarkdownRenderSegment[];
}>): void {
    if (params.streamingMode !== 'streaming') return;
    if (params.splitEnrichedSourceRanges) return;
    const key = typeof params.parseCacheKey === 'string' && params.parseCacheKey.length > 0
        ? params.parseCacheKey
        : null;
    if (!key) return;
    writeMarkdownRenderSegmentsCache(`stream:${key}`, params.preparedMarkdown, params.segments);
}

export const MarkdownViewRenderer = React.memo((props: MarkdownViewRendererProps) => {
    const preparedMarkdown = usePreparedStreamingMarkdown({
        markdown: props.markdown,
        mode: props.streamingMode,
    });
    const sourceRangeInteractionsActive = Boolean(
        props.onPressSourceRange ||
        props.renderAfterSourceRange ||
        props.highlightSourceRange,
    );
    const segments = React.useMemo(() => {
        const cached = readStreamingSegmentCache({
            parseCacheKey: props.streamingParseCacheKey,
            preparedMarkdown,
            streamingMode: props.streamingMode,
            splitEnrichedSourceRanges: sourceRangeInteractionsActive,
        });
        if (cached) return cached;

        const nextSegments = splitMarkdownRenderSegments({
            markdown: preparedMarkdown,
            streamingMode: props.streamingMode,
            streamingRepair: 'prepared',
            splitEnrichedSourceRanges: sourceRangeInteractionsActive,
        });
        writeStreamingSegmentCache({
            parseCacheKey: props.streamingParseCacheKey,
            preparedMarkdown,
            streamingMode: props.streamingMode,
            splitEnrichedSourceRanges: sourceRangeInteractionsActive,
            segments: nextSegments,
        });
        return nextSegments;
    }, [preparedMarkdown, props.streamingMode, props.streamingParseCacheKey, sourceRangeInteractionsActive]);
    const streamingReveal = props.streamingMode === 'streaming' && props.streamingAnimated === true;
    const staticRenderPlaceholder = useDelayedStaticMarkdownRenderPlaceholder({
        enabled:
            props.staticRenderPlaceholderEnabled === true &&
            Platform.OS !== 'web' &&
            props.streamingMode === 'static' &&
            props.markdown.trim().length > 0,
        contentKey: props.markdown,
    });

    return (
        <View testID={props.testID} style={styles.root}>
            <View
                testID="markdown-static-render-content"
                onLayout={staticRenderPlaceholder.onContentLayout}
                style={styles.content}
            >
                {segments.map((segment) => (
                    <MarkdownSegmentView
                        key={segment.key}
                        segment={segment}
                        selectable={props.selectable}
                        onOptionPress={props.onOptionPress}
                        onOptionLongPress={props.onOptionLongPress}
                        onLinkPress={props.onLinkPress}
                        textStyle={props.textStyle}
                        profile={props.profile}
                        streamingReveal={streamingReveal}
                        streamingRevealPreset={props.streamingRevealPreset}
                        sourceRangeInteractionsActive={sourceRangeInteractionsActive}
                        onPressSourceRange={props.onPressSourceRange}
                        renderAfterSourceRange={props.renderAfterSourceRange}
                        highlightSourceRange={props.highlightSourceRange}
                    />
                ))}
            </View>
            {staticRenderPlaceholder.visible ? <StaticMarkdownRenderPlaceholder /> : null}
        </View>
    );
});

const styles = {
    root: {
        width: '100%' as const,
    },
    content: {
        width: '100%' as const,
    },
};
