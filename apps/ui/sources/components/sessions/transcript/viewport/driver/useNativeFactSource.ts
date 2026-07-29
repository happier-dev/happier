import * as React from 'react';
import type { ChatTranscriptListItem } from '@/components/sessions/transcript/chatListTypes';
import { readNativeAbsoluteScrollOffset } from '@/components/sessions/transcript/viewport/driver/readNativeAbsoluteScrollOffset';
import { createNativeStandardListFactSource } from '@/components/sessions/transcript/viewport/driver/nativeStandardListFacts';
import type { TranscriptViewportFactSource } from '@/components/sessions/transcript/viewport/driver/transcriptViewportFacts';
import type { TranscriptRenderWindowProjection } from '@/components/sessions/transcript/viewport/window/resolveTranscriptRenderWindowProjection';
import type { ScrollableChatListRef } from '@/components/sessions/transcript/viewport/transcriptScrollableListTypes';

type MutableRef<T> = { current: T };

export function useNativeFactSource(params: Readonly<{
    canonicalWindowedItemsRef: MutableRef<readonly ChatTranscriptListItem[]>;
    listContentHeightRef: MutableRef<number>;
    listDataRef: MutableRef<readonly ChatTranscriptListItem[]>;
    listLayoutHeightRef: MutableRef<number>;
    listRef: MutableRef<ScrollableChatListRef | null>;
    platformOS: string;
    renderWindowIndexMapRef: MutableRef<TranscriptRenderWindowProjection<ChatTranscriptListItem>['indexMap'] | null>;
}>) {
    const {
        canonicalWindowedItemsRef,
        listContentHeightRef,
        listDataRef,
        listLayoutHeightRef,
        listRef,
        platformOS,
        renderWindowIndexMapRef,
    } = params;
    const nativeStandardFactSourceRef = React.useRef<TranscriptViewportFactSource | null>(null);
    const factReaders = React.useMemo(() => ({
        readRawScrollOffset: () => readNativeAbsoluteScrollOffset(listRef.current) ?? undefined,
        readContentHeight: () => listContentHeightRef.current,
        readLayoutHeight: () => listLayoutHeightRef.current,
        readRenderedVisibleRange: () => {
            try {
                return listRef.current?.computeVisibleIndices?.() ?? null;
            } catch {
                return null;
            }
        },
        readFirstVisibleRenderedIndex: () => {
            try {
                return listRef.current?.getFirstVisibleIndex?.() ?? null;
            } catch {
                return null;
            }
        },
        readRenderedItemCount: () => listDataRef.current.length,
        readSourceIndexForRenderedIndex: (renderedIndex: number) => {
            const projection = renderWindowIndexMapRef.current;
            if (projection) {
                // Explicit null means a synthetic projection row. It is
                // authoritative and must not fall through to identity lookup.
                return projection.renderedToWindowContentIndex(renderedIndex);
            }
            const itemId = listDataRef.current[renderedIndex]?.id;
            if (!itemId) return null;
            const sourceIndex = canonicalWindowedItemsRef.current.findIndex((item) => item.id === itemId);
            return sourceIndex >= 0 ? sourceIndex : null;
        },
    }), [
        canonicalWindowedItemsRef,
        listContentHeightRef,
        listDataRef,
        listLayoutHeightRef,
        listRef,
        renderWindowIndexMapRef,
    ]);
    if (platformOS !== 'web' && nativeStandardFactSourceRef.current === null) {
        nativeStandardFactSourceRef.current = createNativeStandardListFactSource(factReaders);
    }
    const resolveNativeFactSource = React.useCallback((): TranscriptViewportFactSource | null => {
        if (platformOS === 'web') return null;
        return nativeStandardFactSourceRef.current;
    }, [platformOS]);

    const readCurrentNativeDistanceFromBottom = React.useCallback((readParams: {
        contentHeight?: number;
        layoutHeight?: number;
    } = {}): number | null => {
        if (platformOS === 'web') return null;
        return resolveNativeFactSource()?.getDistanceFromLiveTail(readParams) ?? null;
    }, [platformOS, resolveNativeFactSource]);
    const resolveNativeObservedScrollOffset = React.useCallback((rawOffsetY: number, override?: {
        contentHeight?: number;
        layoutHeight?: number;
    }) => {
        if (platformOS === 'web') return null;
        return resolveNativeFactSource()?.resolveObservedOffset(rawOffsetY, override) ?? null;
    }, [platformOS, resolveNativeFactSource]);
    const readViewportContentMetrics = React.useCallback((override?: {
        contentHeight?: number;
        layoutHeight?: number;
    }) => {
        if (platformOS === 'web') {
            const contentHeight = typeof override?.contentHeight === 'number' && Number.isFinite(override.contentHeight)
                ? override.contentHeight
                : listContentHeightRef.current;
            const layoutHeight = typeof override?.layoutHeight === 'number' && Number.isFinite(override.layoutHeight)
                ? override.layoutHeight
                : listLayoutHeightRef.current;
            if (!Number.isFinite(contentHeight) || !Number.isFinite(layoutHeight) || layoutHeight <= 0) return null;
            const normalizedContentHeight = Math.max(0, contentHeight);
            const normalizedLayoutHeight = Math.max(0, layoutHeight);
            return {
                contentHeight: normalizedContentHeight,
                layoutHeight: normalizedLayoutHeight,
                scrollable: normalizedContentHeight > normalizedLayoutHeight,
            };
        }
        return resolveNativeFactSource()?.getContentMetrics(override) ?? null;
    }, [listContentHeightRef, listLayoutHeightRef, platformOS, resolveNativeFactSource]);
    const readViewportVisibleSourceRange = React.useCallback(() => {
        return resolveNativeFactSource()?.getVisibleSourceRange() ?? null;
    }, [resolveNativeFactSource]);
    const resolveViewportReachedEdge = React.useCallback((edge: 'start' | 'end'): 'older' | 'newer' => {
        if (platformOS === 'web') return edge === 'start' ? 'older' : 'newer';
        return resolveNativeFactSource()?.resolveReachedEdge(edge) ?? (edge === 'start' ? 'older' : 'newer');
    }, [platformOS, resolveNativeFactSource]);

    return {
        readCurrentNativeDistanceFromBottom,
        readViewportContentMetrics,
        readViewportVisibleSourceRange,
        resolveNativeObservedScrollOffset,
        resolveViewportReachedEdge,
    };
}
