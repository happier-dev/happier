import { Platform } from 'react-native';
import type { TranscriptPrependHost } from './useTranscriptPrependHost';

type MutableRef<T> = { current: T };

export type TranscriptPrependOlderLoadOptions = Readonly<{
    loadingIndicatorDelayMs?: number;
    preservePrependViewport?: boolean;
    showLoadingIndicator?: boolean;
}>;

export type TranscriptPrependOlderLoadResult = Readonly<{
    loaded: number;
    hasMore: boolean;
    status: 'loaded' | 'no_more' | 'not_ready' | 'in_flight';
}>;

export type TranscriptPrependOlderLoadSyncOptions = Readonly<{
    limit: number;
}>;

export async function runTranscriptPrependOlderLoad(params: Readonly<{
    clearOlderLoadSpinnerDelay: () => void;
    hasActiveEntrySliceWindow: () => boolean;
    hasMoreOlder: boolean | null;
    hasMoreOlderRef: MutableRef<boolean | null>;
    hideOlderLoadSpinner: () => void;
    isReady: boolean;
    loadOlderInFlight: MutableRef<boolean>;
    loadOlderMessages: (options: TranscriptPrependOlderLoadSyncOptions | null) => Promise<TranscriptPrependOlderLoadResult>;
    olderLoadSpinnerDelayTimeoutRef: MutableRef<ReturnType<typeof setTimeout> | null>;
    options?: TranscriptPrependOlderLoadOptions;
    prependHost: TranscriptPrependHost;
    revealEntrySliceWindow: () => number;
    resolveSyncLoadOlderOptions: () => TranscriptPrependOlderLoadSyncOptions | null;
    setHasMoreOlder: (value: boolean) => void;
    setIsLoadingOlder: (value: boolean) => void;
    showOlderLoadSpinner: () => void;
}>): Promise<TranscriptPrependOlderLoadResult | null> {
    const options = params.options ?? {};
    if (!params.isReady) return null;
    const showLoadingIndicator = options.showLoadingIndicator !== false;
    const preservePrependViewport = options.preservePrependViewport !== false;
    if (
        params.loadOlderInFlight.current ||
        params.hasMoreOlderRef.current === false ||
        params.hasMoreOlder === false
    ) {
        if (params.loadOlderInFlight.current && showLoadingIndicator && options.loadingIndicatorDelayMs === 0) {
            params.showOlderLoadSpinner();
        }
        return null;
    }
    params.loadOlderInFlight.current = true;
    const loadingIndicatorDelayMs = typeof options.loadingIndicatorDelayMs === 'number' && Number.isFinite(options.loadingIndicatorDelayMs)
        ? Math.max(0, Math.trunc(options.loadingIndicatorDelayMs))
        : 0;
    if (!showLoadingIndicator) {
        params.clearOlderLoadSpinnerDelay();
    } else if (loadingIndicatorDelayMs > 0) {
        params.olderLoadSpinnerDelayTimeoutRef.current = setTimeout(() => {
            params.olderLoadSpinnerDelayTimeoutRef.current = null;
            params.setIsLoadingOlder(true);
        }, loadingIndicatorDelayMs);
    } else {
        params.showOlderLoadSpinner();
    }
    let loadCompleted = false;
    try {
        if (preservePrependViewport && params.hasActiveEntrySliceWindow()) {
            const revealed = params.revealEntrySliceWindow();
            if (revealed > 0) {
                loadCompleted = true;
                return {
                    loaded: revealed,
                    hasMore: params.hasMoreOlderRef.current ?? true,
                    status: 'loaded',
                };
            }
        }
        if (Platform.OS === 'web') {
            params.prependHost.webBeforeLoad({ preservePrependViewport });
        }
        const result = await params.loadOlderMessages(params.resolveSyncLoadOlderOptions());

        if (Platform.OS === 'web') {
            params.prependHost.webAfterLoad({
                loadedRowCount: result.loaded,
                preservePrependViewport,
            });
        }
        loadCompleted = true;
        if (result.status === 'no_more') {
            params.hasMoreOlderRef.current = false;
            params.setHasMoreOlder(false);
        } else if (result.status === 'loaded' || result.status === 'not_ready' || result.status === 'in_flight') {
            params.hasMoreOlderRef.current = result.hasMore;
            params.setHasMoreOlder(result.hasMore);
        }
        return result;
    } finally {
        if (Platform.OS === 'web' && !loadCompleted) {
            params.prependHost.webClear('abandoned-identity');
        }
        if (!loadCompleted && params.prependHost.hasOpenNativeTransaction()) {
            params.prependHost.invalidateNativeTransaction('load-empty');
        }
        params.hideOlderLoadSpinner();
        params.loadOlderInFlight.current = false;
    }
}
