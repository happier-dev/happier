import * as React from 'react';
import { themeSurfaceDataSet } from '@happier-dev/plugin-ui';
import { themeSurfaceStyles } from '@/theme/css/themeSurfaceStyles';
import { isAssistantMarkdownProfile } from './MarkdownRenderingProfile';
import type { StyleProp, TextStyle } from 'react-native';
import { Platform, View } from 'react-native';

import type { Option, OptionLongPressHandler } from '../MarkdownBlockView';
import type { MarkdownSelectionAction, MarkdownSourceMarkKind, MarkdownSourceRange, MarkdownSourceRangeAction, MarkdownSourceRangeLayoutObserver } from '../MarkdownView';
import { MarkdownSourceMarkKindContext } from './MarkdownFindDecorationContext';
import { MarkdownWorkspaceFileLinksContext } from './MarkdownLinkPolicyContext';
import { usePreparedStreamingMarkdown, type MarkdownStreamingMode } from '../streaming/usePreparedStreamingMarkdown';
import type { StreamingTextRevealPreset } from '../streaming/streamingTextRevealConfig';
import type { MarkdownRenderingProfile } from './MarkdownRenderingProfile';
import type { MarkdownInlineReferences } from '../markdownInlineReferences';
import { buildMarkdownImageDocument, type MarkdownImageResolver } from '../markdownImages';
import { createImagePreviewAcquisition } from '@/components/ui/media/imagePreviewCache';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { MarkdownSegmentView } from './MarkdownSegmentView';
import { MarkdownCodeBlockWrapKeyProvider } from '../MarkdownCodeBlockWrapState';
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
    /** Stable message identity, independent of streaming revisions, for per-block presentation state. */
    codeBlockStateKey?: string;
    renderCacheKey?: string;
    sourceRangeLayoutObserver?: MarkdownSourceRangeLayoutObserver;
    onPressSourceRange?: (action: MarkdownSourceRangeAction) => void;
    sourceRangePressable?: (action: MarkdownSourceRangeAction) => boolean;
    selectionActions?: readonly MarkdownSelectionAction[];
    sourceMarkKind: MarkdownSourceMarkKind;
    renderAfterSourceRange?: (action: MarkdownSourceRangeAction) => React.ReactNode;
    highlightSourceRange?: MarkdownSourceRange | null;
    findSourceRanges?: readonly FindTextRange[];
    findActive?: boolean;
    agentTexMath: boolean;
    inlineReferences?: MarkdownInlineReferences;
    images?: MarkdownImageResolver;
    imageScope?: WorkspaceScopeBase;
}>;

function buildMarkdownRenderSegmentsCacheKey(params: Readonly<{
    renderCacheKey?: string;
    sourceRangeInteractionsActive: boolean;
    streamingMode: MarkdownStreamingMode;
    imagesEnabled?: boolean;
}>): string | null {
    const renderCacheKey = params.renderCacheKey?.trim();
    if (!renderCacheKey) return null;
    if (params.streamingMode !== 'streaming') return null;
    if (params.sourceRangeInteractionsActive) return null;
    return [
        'stream',
        renderCacheKey,
        params.imagesEnabled ? 'images' : 'text',
    ].join('\u0000');
}

export const MarkdownViewRenderer = React.memo((props: MarkdownViewRendererProps) => {
    const imagesEnabled = Boolean(props.images);
    const preparedMarkdown = usePreparedStreamingMarkdown({
        markdown: props.markdown,
        mode: props.streamingMode,
    });
    const blockTargetsActive = Boolean(
        props.onPressSourceRange ||
        props.selectionActions?.length ||
        props.renderAfterSourceRange ||
        props.highlightSourceRange,
    );
    const sourceRangeInteractionsActive = blockTargetsActive || Boolean(props.sourceRangeLayoutObserver);
    // A run-granularity observer measures the existing segments; only block targets split prose runs.
    const splitEnrichedSourceRanges = blockTargetsActive
        || (props.sourceRangeLayoutObserver !== undefined && props.sourceRangeLayoutObserver.granularity !== 'run');
    const segments = React.useMemo(() => {
        const cacheKey = buildMarkdownRenderSegmentsCacheKey({
            renderCacheKey: props.renderCacheKey,
            sourceRangeInteractionsActive,
            streamingMode: props.streamingMode,
            imagesEnabled,
        });
        if (cacheKey) {
            const cached = readMarkdownRenderSegmentsCache(cacheKey, preparedMarkdown);
            if (cached) return cached;
        }
        const next = splitMarkdownRenderSegments({
            markdown: preparedMarkdown,
            streamingMode: props.streamingMode,
            streamingRepair: 'prepared',
            splitEnrichedSourceRanges,
            imagesEnabled,
        });
        if (cacheKey) writeMarkdownRenderSegmentsCache(cacheKey, preparedMarkdown, next);
        return next;
    }, [preparedMarkdown, props.renderCacheKey, props.streamingMode, sourceRangeInteractionsActive, splitEnrichedSourceRanges, imagesEnabled]);
    // Consent and streaming re-project this same reader's gallery, not its admitted local bytes.
    const imageAcquisitionKey = React.useMemo(() => props.images?.resolve ? createImagePreviewAcquisition() : undefined,
        [props.images?.resolve, props.imageScope?.serverId, props.imageScope?.machineId, props.imageScope?.rootPath]);
    const imageDocument = React.useMemo(() => props.images
        ? buildMarkdownImageDocument({ markdown: preparedMarkdown, images: props.images, segments, acquisitionKey: imageAcquisitionKey })
        : undefined, [preparedMarkdown, props.images, segments, imageAcquisitionKey]);
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
        <MarkdownSourceMarkKindContext.Provider value={props.sourceMarkKind}>
        <MarkdownWorkspaceFileLinksContext.Provider value={imagesEnabled}>
        <View testID={props.testID} {...(isAssistantMarkdownProfile(props.profile) ? { dataSet: themeSurfaceDataSet('assistant-text', 'root', 'default') } : {})} style={[styles.root, isAssistantMarkdownProfile(props.profile) ? themeSurfaceStyles.surface({ surface: 'assistant-text', part: 'root', state: 'default' }) : undefined]}>
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
                            sourceRangePressable={props.sourceRangePressable}
                            selectionActions={props.selectionActions}
                            renderAfterSourceRange={props.renderAfterSourceRange}
                            highlightSourceRange={props.highlightSourceRange}
                            findSourceRanges={props.findSourceRanges}
                            findActive={props.findActive}
                            agentTexMath={props.agentTexMath}
                            inlineReferences={props.inlineReferences}
                            images={props.images}
                            imageScope={props.imageScope}
                            imageDocument={imageDocument}
                        />
                    </MarkdownCodeBlockWrapKeyProvider>
                ))}
            </View>
            {staticRenderPlaceholder.visible ? <StaticMarkdownRenderPlaceholder /> : null}
        </View>
        </MarkdownWorkspaceFileLinksContext.Provider>
        </MarkdownSourceMarkKindContext.Provider>
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
