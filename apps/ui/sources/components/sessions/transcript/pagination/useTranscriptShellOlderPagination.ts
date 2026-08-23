import * as React from 'react';
import { Platform, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';

import { sync } from '@/sync/sync';
import type { TranscriptOlderPageLoadResult } from '@/sync/domains/messages/transcriptOlderPageLoad';

import {
    resolveTranscriptEdgePrefetchThresholdPx,
    TRANSCRIPT_EDGE_PREFETCH_FALLBACK_VIEWPORT_RATIO,
    TRANSCRIPT_EDGE_PREFETCH_MAX_PX,
    TRANSCRIPT_EDGE_PREFETCH_MIN_PX,
} from '@/components/sessions/transcript/scroll/resolveTranscriptEdgePrefetchThresholdPx';
import {
    recordTranscriptViewportTelemetryEvent,
} from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import { resolveItemsToOlderEdge } from '@/components/sessions/transcript/pagination/olderPaginationMachine';
import { useTranscriptOlderPagination } from '@/components/sessions/transcript/pagination/useTranscriptOlderPagination';
import { createNativeStandardListFactSource } from '@/components/sessions/transcript/viewport/driver/nativeStandardListFacts';
import { readNativeAbsoluteScrollOffset } from '@/components/sessions/transcript/viewport/driver/readNativeAbsoluteScrollOffset';
import type {
    TranscriptViewportFactSource,
    TranscriptViewportObservedOffset,
} from '@/components/sessions/transcript/viewport/driver/transcriptViewportFacts';
import { useCommittedTranscriptRef } from '@/components/sessions/transcript/viewport/lifecycle/host/useCommittedTranscriptRef';
import {
    applySidechainCommittedLayoutObservation,
    applySidechainOlderLoadObservation,
    resolveSidechainOlderLoadEdgeReachedObservation,
    resolveSidechainOlderLoadScrollEventObservation,
    type SidechainOlderLoadObservationInput,
} from '@/components/sessions/transcript/viewport/shell/sidechainOlderLoadObservation';
import {
    applySidechainOlderPageLoad,
    applySidechainPaginationOlderPageLoad,
} from '@/components/sessions/transcript/viewport/shell/sidechainOlderPageLoad';
import type {
    TranscriptListShellDataOrder,
} from '@/components/sessions/transcript/viewport/shell/transcriptListShellCapabilities';
import type {
    TranscriptListShellRef,
} from '@/components/sessions/transcript/viewport/shell/TranscriptListShell';

type OlderPageState = {
    datasetKey: string;
    hasMoreOlder: boolean;
    isLoadingOlder: boolean;
};

export type TranscriptShellOlderPaginationInput<TItem> = Readonly<{
    /** Resets every pagination fact when the rendered dataset identity changes. */
    datasetKey: string;
    dataOrder: TranscriptListShellDataOrder;
    /** The caller's page reader. `undefined` disables pagination entirely. */
    loadOlder: (() => Promise<TranscriptOlderPageLoadResult>) | undefined;
    listRef: React.MutableRefObject<TranscriptListShellRef<TItem> | null>;
    /** Canonical (oldest-first) item count backing the rendered rows. */
    readCanonicalItemCount: () => number;
    readRenderedItemCount: () => number;
    /** Canonical oldest-first index for a rendered row, or `null` when unknown. */
    readSourceIndexForRenderedIndex: (renderedIndex: number) => number | null;
    sessionId: string;
}>;

export type TranscriptShellOlderPaginationResult = Readonly<{
    /** Single-flight guarded page read, also usable by an explicit jump walk. */
    loadOlder: () => Promise<TranscriptOlderPageLoadResult | null>;
    isLoadingOlder: boolean;
    loadFailed: boolean;
    /**
     * The web scroll element this hook latched from a real observation. Shells reuse it as
     * the fallback scroller when the renderer cannot hand one back directly.
     */
    readWebScrollElement: () => HTMLElement | null;
    retryLoad: () => void;
    /** Spread onto `TranscriptListShell` — the whole observation surface in one place. */
    shellProps: Readonly<{
        onCommitLayoutEffect: () => void;
        onContentSizeChange: (width: number, height: number) => void;
        onLayout: (event: LayoutChangeEvent) => void;
        onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
        onStartReached: () => void;
        onStartReachedThreshold: number;
        onEndReached: () => void;
        onEndReachedThreshold: number;
    }>;
}>;

/**
 * Single owner of the LIST-SHELL side of older-page pagination: layout/content metrics,
 * the native viewport fact source, the edge thresholds, the single-flight page guard, and
 * every observation ingress that feeds {@link useTranscriptOlderPagination}'s machine.
 *
 * Both read-only transcript shells (the sidechain/tool chain list and the shared public
 * transcript) consume this hook, so the sequencing rules encoded here — attach the
 * item-space proximity signal at ONE choke point, observe every scroll frame because
 * `onStartReached` is unreliable on web, keep `hasMoreOlder` per dataset — exist once.
 */
export function useTranscriptShellOlderPagination<TItem>(
    input: TranscriptShellOlderPaginationInput<TItem>,
): TranscriptShellOlderPaginationResult {
    const {
        datasetKey,
        dataOrder,
        listRef,
        readCanonicalItemCount,
        readRenderedItemCount,
        readSourceIndexForRenderedIndex,
        sessionId,
    } = input;
    const syncTuning = sync.getSyncTuning();
    const configuredBackwardPrefetchThresholdPx = syncTuning.transcriptBackwardPrefetchThresholdPx;

    const readersRef = React.useRef({
        loadOlder: input.loadOlder,
        readCanonicalItemCount,
        readRenderedItemCount,
        readSourceIndexForRenderedIndex,
    });
    useCommittedTranscriptRef(readersRef, {
        loadOlder: input.loadOlder,
        readCanonicalItemCount,
        readRenderedItemCount,
        readSourceIndexForRenderedIndex,
    });

    const olderPageStateRef = React.useRef<OlderPageState>({
        datasetKey,
        hasMoreOlder: true,
        isLoadingOlder: false,
    });
    const committedOlderPageState = olderPageStateRef.current.datasetKey === datasetKey
        ? olderPageStateRef.current
        : {
            datasetKey,
            hasMoreOlder: true,
            isLoadingOlder: false,
        };
    useCommittedTranscriptRef(olderPageStateRef, committedOlderPageState);

    const listLayoutHeightRef = React.useRef(0);
    const listContentHeightRef = React.useRef(0);
    const webScrollElementRef = React.useRef<HTMLElement | null>(null);
    const [listLayoutHeight, setListLayoutHeight] = React.useState(0);

    const nativeFactSourceRef = React.useRef<TranscriptViewportFactSource | null>(null);
    if (Platform.OS !== 'web' && nativeFactSourceRef.current === null) {
        nativeFactSourceRef.current = createNativeStandardListFactSource({
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
            readRenderedItemCount: () => readersRef.current.readRenderedItemCount(),
            readSourceIndexForRenderedIndex: (renderedIndex: number) =>
                readersRef.current.readSourceIndexForRenderedIndex(renderedIndex),
        });
    }

    const resolveTopPrefetchThresholdPx = React.useCallback((viewportPx: number): number => {
        return resolveTranscriptEdgePrefetchThresholdPx({
            configuredPx: configuredBackwardPrefetchThresholdPx,
            viewportPx,
            fallbackViewportRatio: TRANSCRIPT_EDGE_PREFETCH_FALLBACK_VIEWPORT_RATIO,
            minPx: TRANSCRIPT_EDGE_PREFETCH_MIN_PX,
            maxPx: TRANSCRIPT_EDGE_PREFETCH_MAX_PX,
        });
    }, [configuredBackwardPrefetchThresholdPx]);

    const resolveViewportGuardThresholdPx = React.useCallback((viewportPx: number): number => {
        return resolveTranscriptEdgePrefetchThresholdPx({
            configuredPx: Number.NaN,
            viewportPx,
            fallbackViewportRatio: TRANSCRIPT_EDGE_PREFETCH_FALLBACK_VIEWPORT_RATIO,
            minPx: TRANSCRIPT_EDGE_PREFETCH_MIN_PX,
            maxPx: TRANSCRIPT_EDGE_PREFETCH_MAX_PX,
        });
    }, []);

    const startReachedThreshold = React.useMemo(() => {
        const thresholdPx = resolveTopPrefetchThresholdPx(listLayoutHeight);
        if (thresholdPx <= 0) return 0;
        if (!Number.isFinite(listLayoutHeight) || listLayoutHeight <= 0) {
            return TRANSCRIPT_EDGE_PREFETCH_FALLBACK_VIEWPORT_RATIO;
        }
        return thresholdPx / listLayoutHeight;
    }, [listLayoutHeight, resolveTopPrefetchThresholdPx]);

    const loadOlder = React.useCallback(async (): Promise<TranscriptOlderPageLoadResult | null> => {
        const operationState = olderPageStateRef.current;
        return await applySidechainOlderPageLoad({
            hasMoreOlder: operationState.hasMoreOlder,
            isLoadingOlder: operationState.isLoadingOlder,
            isOperationCurrent: () => olderPageStateRef.current === operationState,
            loadOlder: readersRef.current.loadOlder,
            setHasMoreOlder: (hasMore) => {
                operationState.hasMoreOlder = hasMore;
            },
            setLoadingOlder: (loading) => {
                operationState.isLoadingOlder = loading;
            },
        });
    }, []);

    const paginationLoadOlder = React.useCallback(async (): Promise<TranscriptOlderPageLoadResult | null> => {
        return await applySidechainPaginationOlderPageLoad({
            hasMoreOlder: olderPageStateRef.current.hasMoreOlder,
            loadOlder,
        });
    }, [loadOlder]);

    const olderPagination = useTranscriptOlderPagination({
        enabled: typeof input.loadOlder === 'function',
        loadOlder: paginationLoadOlder,
        thresholdPx: resolveTopPrefetchThresholdPx(listLayoutHeight),
        thresholdItems: syncTuning.transcriptBackwardPrefetchThresholdItems,
        cooldownMs: syncTuning.transcriptOlderLoadCooldownMs,
        spinnerDelayMs: syncTuning.transcriptOlderLoadSpinnerDelayMs,
        isFillDone: () => true,
        isTransactionOpen: () => false,
    });
    const resetOlderPagination = olderPagination.reset;

    React.useEffect(() => {
        resetOlderPagination();
    }, [datasetKey, resetOlderPagination]);

    const {
        getSnapshot: getOlderPaginationSnapshot,
        onScrollObservation: dispatchOlderPaginationObservation,
    } = olderPagination;

    const resolveNativeFactSource = React.useCallback((): TranscriptViewportFactSource | null => {
        if (Platform.OS === 'web') return null;
        return nativeFactSourceRef.current;
    }, []);

    const resolveNativeObservedOffset = React.useCallback((
        rawOffsetY: number | null | undefined,
    ): TranscriptViewportObservedOffset | null => {
        if (Platform.OS === 'web') return null;
        if (typeof rawOffsetY !== 'number' || !Number.isFinite(rawOffsetY)) return null;
        return resolveNativeFactSource()?.resolveObservedOffset(rawOffsetY, {
            contentHeight: listContentHeightRef.current,
            layoutHeight: listLayoutHeightRef.current,
        }) ?? null;
    }, [resolveNativeFactSource]);

    const readCurrentNativeObservedOffset = React.useCallback((): TranscriptViewportObservedOffset | null => {
        if (Platform.OS === 'web') return null;
        return resolveNativeObservedOffset(readNativeAbsoluteScrollOffset(listRef.current));
    }, [listRef, resolveNativeObservedOffset]);

    const attachNativeObservedOffset = React.useCallback((
        observation: SidechainOlderLoadObservationInput,
    ): SidechainOlderLoadObservationInput => {
        if (Platform.OS === 'web') return observation;
        const rawOffsetY = typeof observation === 'number' ? observation : observation.offsetY;
        const nativeObservedOffset = resolveNativeObservedOffset(rawOffsetY);
        if (!nativeObservedOffset) return observation;
        if (typeof observation === 'number') {
            return {
                nativeObservedOffset,
                offsetY: nativeObservedOffset.canonicalOffsetY,
            };
        }
        return {
            ...observation,
            nativeObservedOffset,
            offsetY: nativeObservedOffset.canonicalOffsetY,
        };
    }, [resolveNativeObservedOffset]);

    const observeOlderPaginationScroll = React.useCallback((
        observation: SidechainOlderLoadObservationInput,
    ) => {
        // Estimate-immune item-space proximity from the driver fact seam, attached at the ONE
        // observation choke point (scroll + edge-reached callers): the native canonical px
        // offset is derived from estimated content height, so the pagination machine must not
        // depend on it alone (see the machine contract).
        const itemsToOlderEdge = Platform.OS === 'web'
            ? null
            : resolveItemsToOlderEdge(
                resolveNativeFactSource()?.getVisibleSourceRange() ?? null,
                readersRef.current.readCanonicalItemCount(),
            );
        if (
            Platform.OS !== 'web'
            && typeof observation !== 'number'
            && observation.trigger === 'layout-committed'
            && itemsToOlderEdge === null
        ) {
            return;
        }
        const enrichedObservation: SidechainOlderLoadObservationInput =
            itemsToOlderEdge === null
                ? observation
                : (typeof observation === 'number'
                    ? { itemsToOlderEdge, offsetY: observation }
                    : { ...observation, itemsToOlderEdge });
        applySidechainOlderLoadObservation({
            contentHeightPx: listContentHeightRef.current,
            dataOrder,
            listContentHeightPx: listContentHeightRef.current,
            listLayoutHeightPx: listLayoutHeightRef.current,
            getPaginationSnapshot: getOlderPaginationSnapshot,
            itemCount: readersRef.current.readRenderedItemCount(),
            layoutHeightPx: listLayoutHeightRef.current,
            observation: enrichedObservation,
            onScrollObservation: dispatchOlderPaginationObservation,
            platformOS: Platform.OS,
            recordTelemetry: (event) => recordTranscriptViewportTelemetryEvent(event, syncTuning),
            sessionId,
            timestampMs: Date.now(),
            viewportGuardThresholdPx: resolveViewportGuardThresholdPx(listLayoutHeightRef.current),
        });
    }, [
        dataOrder,
        dispatchOlderPaginationObservation,
        getOlderPaginationSnapshot,
        resolveNativeFactSource,
        resolveViewportGuardThresholdPx,
        sessionId,
        syncTuning,
    ]);

    const observeCommittedProjectionLayout = React.useCallback(() => {
        applySidechainCommittedLayoutObservation({
            nativeObservedOffset: readCurrentNativeObservedOffset(),
            onObservation: observeOlderPaginationScroll,
            platformOS: Platform.OS,
            viewportGuardThresholdPx: resolveViewportGuardThresholdPx(listLayoutHeightRef.current),
            webElement: webScrollElementRef.current,
        });
    }, [
        observeOlderPaginationScroll,
        readCurrentNativeObservedOffset,
        resolveViewportGuardThresholdPx,
    ]);

    const observeRenderedOlderEdge = React.useCallback((reachedEdge: 'start' | 'end') => {
        const resolveReachedEdge = Platform.OS === 'web'
            ? (edge: 'start' | 'end') => edge === 'start' ? 'older' as const : 'newer' as const
            : resolveNativeFactSource()?.resolveReachedEdge
                ?? (() => 'newer' as const);
        const ingress = resolveSidechainOlderLoadEdgeReachedObservation({
            nativeObservedOffset: readCurrentNativeObservedOffset(),
            reachedEdge,
            resolveReachedEdge,
            viewportGuardThresholdPx: resolveViewportGuardThresholdPx(listLayoutHeightRef.current),
            webElement: webScrollElementRef.current,
        });
        if (!ingress.ok) return;
        if (ingress.webElement) {
            webScrollElementRef.current = ingress.webElement;
        }
        observeOlderPaginationScroll(ingress.observation);
    }, [
        observeOlderPaginationScroll,
        readCurrentNativeObservedOffset,
        resolveNativeFactSource,
        resolveViewportGuardThresholdPx,
    ]);

    const onStartReached = React.useCallback(() => {
        observeRenderedOlderEdge('start');
    }, [observeRenderedOlderEdge]);
    const onEndReached = React.useCallback(() => {
        observeRenderedOlderEdge('end');
    }, [observeRenderedOlderEdge]);

    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        const height = event?.nativeEvent?.layout?.height;
        if (typeof height !== 'number' || !Number.isFinite(height)) return;
        if (listLayoutHeightRef.current !== height) {
            listLayoutHeightRef.current = height;
            setListLayoutHeight(height);
        }
    }, []);

    const onContentSizeChange = React.useCallback((_width: number, height: number) => {
        if (typeof height !== 'number' || !Number.isFinite(height)) return;
        listContentHeightRef.current = height;
    }, []);

    const onScroll = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        const ingress = resolveSidechainOlderLoadScrollEventObservation({
            event,
            viewportGuardThresholdPx: resolveViewportGuardThresholdPx(listLayoutHeightRef.current),
        });
        if (!ingress.ok) return;
        if (ingress.webElement) {
            webScrollElementRef.current = ingress.webElement;
        }
        // The renderer's `onStartReached` is not reliably fired on all platforms (notably
        // web), so the pagination machine observes every scroll position.
        observeOlderPaginationScroll(attachNativeObservedOffset(ingress.observation));
    }, [
        attachNativeObservedOffset,
        observeOlderPaginationScroll,
        resolveViewportGuardThresholdPx,
    ]);

    const readWebScrollElement = React.useCallback(
        (): HTMLElement | null => webScrollElementRef.current,
        [],
    );

    const shellProps = React.useMemo(() => ({
        onCommitLayoutEffect: observeCommittedProjectionLayout,
        onContentSizeChange,
        onLayout,
        onScroll,
        onStartReached,
        onStartReachedThreshold: startReachedThreshold,
        onEndReached,
        onEndReachedThreshold: startReachedThreshold,
    }), [
        observeCommittedProjectionLayout,
        onContentSizeChange,
        onEndReached,
        onLayout,
        onScroll,
        onStartReached,
        startReachedThreshold,
    ]);

    return {
        loadOlder,
        isLoadingOlder: olderPagination.isLoadingOlder,
        loadFailed: olderPagination.loadFailed,
        readWebScrollElement,
        retryLoad: olderPagination.retryLoad,
        shellProps,
    };
}
