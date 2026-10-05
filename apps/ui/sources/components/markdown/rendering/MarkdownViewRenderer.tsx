import * as React from 'react';
import type { StyleProp, TextStyle } from 'react-native';
import { Platform, View } from 'react-native';

import type { Option, OptionLongPressHandler } from '../MarkdownBlockView';
import type { MarkdownSourceRange, MarkdownSourceRangeAction, MarkdownSourceRangeLayoutObserver } from '../MarkdownView';
import { usePreparedStreamingMarkdown, type MarkdownStreamingMode } from '../streaming/usePreparedStreamingMarkdown';
import type { StreamingTextRevealPreset } from '../streaming/streamingTextRevealConfig';
import type { MarkdownRenderingProfile } from './MarkdownRenderingProfile';
import type { MarkdownInlineReferences } from '../markdownInlineReferences';
import { MarkdownSegmentView } from './MarkdownSegmentView';
import {
    readMarkdownRenderSegmentsCache,
    writeMarkdownRenderSegmentsCache,
} from './markdownRenderSegmentsCache';
import { splitMarkdownRenderSegments } from './splitMarkdownRenderSegments';
import { StaticMarkdownRenderPlaceholder } from './StaticMarkdownRenderPlaceholder';
import { useDelayedStaticMarkdownRenderPlaceholder } from './useDelayedStaticMarkdownRenderPlaceholder';
import type { FindTextRange } from '@happier-dev/plugin-ui/presentation';

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
    streamingRevealPreset?: StreamingTextRevealPreset;
    staticRenderPlaceholderEnabled?: boolean;
    renderCacheKey?: string;
    sourceRangeLayoutObserver?: MarkdownSourceRangeLayoutObserver;
    onPressSourceRange?: (action: MarkdownSourceRangeAction) => void;
    renderAfterSourceRange?: (action: MarkdownSourceRangeAction) => React.ReactNode;
    highlightSourceRange?: MarkdownSourceRange | null;
    findSourceRanges?: readonly FindTextRange[];
    findActive?: boolean;
    agentTexMath: boolean;
    inlineReferences?: MarkdownInlineReferences;
}>;

function buildMarkdownRenderSegmentsCacheKey(params: Readonly<{
    renderCacheKey?: string;
    sourceRangeInteractionsActive: boolean;
    streamingMode: MarkdownStreamingMode;
}>): string | null {
    const renderCacheKey = params.renderCacheKey?.trim();
    if (!renderCacheKey) return null;
    if (params.streamingMode !== 'streaming') return null;
    if (params.sourceRangeInteractionsActive) return null;
    return [
        'stream',
        renderCacheKey,
    ].join('\u0000');
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
        const cacheKey = buildMarkdownRenderSegmentsCacheKey({
            renderCacheKey: props.renderCacheKey,
            sourceRangeInteractionsActive,
            streamingMode: props.streamingMode,
        });
        if (cacheKey) {
            const cached = readMarkdownRenderSegmentsCache(cacheKey, preparedMarkdown);
            if (cached) return cached;
        }
        const next = splitMarkdownRenderSegments({
            markdown: preparedMarkdown,
            streamingMode: props.streamingMode,
            streamingRepair: 'prepared',
            splitEnrichedSourceRanges: sourceRangeInteractionsActive,
        });
        if (cacheKey) writeMarkdownRenderSegmentsCache(cacheKey, preparedMarkdown, next);
        return next;
    }, [preparedMarkdown, props.renderCacheKey, props.streamingMode, sourceRangeInteractionsActive]);
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
                    <MarkdownSegmentView
                        key={segmentKeys[index]}
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
                        findSourceRanges={props.findSourceRanges}
                        findActive={props.findActive}
                        agentTexMath={props.agentTexMath}
                        inlineReferences={props.inlineReferences}
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
