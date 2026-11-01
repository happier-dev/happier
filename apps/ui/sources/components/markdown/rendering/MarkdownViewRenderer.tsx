import * as React from 'react';
import type { StyleProp, TextStyle } from 'react-native';
import { Platform, View } from 'react-native';

import type { Option, OptionLongPressHandler } from '../MarkdownBlockView';
import type { MarkdownSelectionAction, MarkdownSourceRange, MarkdownSourceRangeAction, MarkdownSourceRangeLayoutObserver } from '../MarkdownView';
import { usePreparedStreamingMarkdown, type MarkdownStreamingMode } from '../streaming/usePreparedStreamingMarkdown';
import type { StreamingTextRevealPreset } from '../streaming/streamingTextRevealConfig';
import type { MarkdownRenderingProfile } from './MarkdownRenderingProfile';
import type { MarkdownRenderSegment } from './markdownRenderSegmentTypes';
import { MarkdownSegmentView } from './MarkdownSegmentView';
import { MarkdownCodeBlockWrapKeyProvider } from '../MarkdownCodeBlockWrapState';
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
    codeBlockStateKey?: string;
    streamingRevealPreset?: StreamingTextRevealPreset;
    staticRenderPlaceholderEnabled?: boolean;
    sourceRangeLayoutObserver?: MarkdownSourceRangeLayoutObserver;
    onPressSourceRange?: (action: MarkdownSourceRangeAction) => void;
    renderAfterSourceRange?: (action: MarkdownSourceRangeAction) => React.ReactNode;
    highlightSourceRange?: MarkdownSourceRange | null;
    selectionActions?: readonly MarkdownSelectionAction[];
    agentTexMath: boolean;
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
        props.sourceRangeLayoutObserver ||
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
    const segmentKeys = React.useMemo(() => {
        if (!props.sourceRangeLayoutObserver) return segments.map((segment) => segment.key);
        const occurrences = new Map<string, number>();
        return segments.map((segment) => {
            const occurrence = occurrences.get(segment.sourceHash) ?? 0;
            occurrences.set(segment.sourceHash, occurrence + 1);
            return `${segment.sourceHash}:${occurrence}`;
        });
    }, [segments, props.sourceRangeLayoutObserver]);
    const contentRef = React.useRef<View>(null);
    const measureSourceRanges = React.useCallback(() => {
        if (Platform.OS !== 'web' || !props.sourceRangeLayoutObserver) return;
        // RNW View refs expose the DOM node. ResizeObserver does not report pure position changes.
        const element = contentRef.current as unknown as HTMLElement | null;
        if (typeof element?.getBoundingClientRect !== 'function') return;
        const top = element.getBoundingClientRect().top;
        const layouts = Array.from(element.children).map((child) => {
            const rectangle = child.getBoundingClientRect();
            return { y: rectangle.top - top, height: rectangle.height };
        });
        // Read all geometry before the scroll owner writes its corrected offset.
        layouts.forEach((layout, index) => {
            const segment = segments[index];
            if (segment) props.sourceRangeLayoutObserver?.onLayout(segment, layout);
        });
    }, [segments, props.sourceRangeLayoutObserver]);
    React.useLayoutEffect(() => {
        props.sourceRangeLayoutObserver?.onRanges(segments);
        measureSourceRanges();
    }, [segments, props.sourceRangeLayoutObserver, measureSourceRanges]);
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
                ref={contentRef}
                testID="markdown-static-render-content"
                onLayout={(event) => {
                    staticRenderPlaceholder.onContentLayout(event);
                    measureSourceRanges();
                }}
                style={styles.content}
            >
                {segments.map((segment, index) => (
                    <MarkdownCodeBlockWrapKeyProvider
                        key={segmentKeys[index]}
                        value={props.codeBlockStateKey ? JSON.stringify([props.codeBlockStateKey, segment.sourceStart]) : null}
                    >
                        <MarkdownSegmentView
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
                            sourceRangeLayoutObserver={props.sourceRangeLayoutObserver}
                            onPressSourceRange={props.onPressSourceRange}
                            renderAfterSourceRange={props.renderAfterSourceRange}
                            highlightSourceRange={props.highlightSourceRange}
                            selectionActions={props.selectionActions}
                            agentTexMath={props.agentTexMath}
                        />
                    </MarkdownCodeBlockWrapKeyProvider>
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
