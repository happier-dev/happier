import * as React from 'react';
import { Platform } from 'react-native';
import { loadSyncTuning } from '@/sync/runtime/syncTuning';
import { fireAndForget } from '@/utils/system/fireAndForget';

type EnrichedMarkdownRuntimeModule = Readonly<{
    preloadMarkdownRuntime?: () => Promise<void>;
}>;

let preloadPromise: Promise<void> | null = null;
let preloadResolved = Platform.OS !== 'web';
let preloadFailure: unknown = null;
let preloadFailureAtMs = 0;
const runtimeStatusListeners = new Set<() => void>();

export type EnrichedMarkdownRuntimeStatus = 'pending' | 'ready' | 'failed';

let runtimeStatus: EnrichedMarkdownRuntimeStatus = preloadResolved ? 'ready' : 'pending';

function publishRuntimeStatus(nextStatus: EnrichedMarkdownRuntimeStatus): void {
    if (runtimeStatus === nextStatus) return;
    runtimeStatus = nextStatus;
    for (const listener of runtimeStatusListeners) {
        listener();
    }
}

function subscribeToRuntimeStatus(listener: () => void): () => void {
    runtimeStatusListeners.add(listener);
    return () => {
        runtimeStatusListeners.delete(listener);
    };
}

function readRuntimeStatus(): EnrichedMarkdownRuntimeStatus {
    return runtimeStatus;
}

function readPreloadMarkdownRuntime(
    module: object,
): EnrichedMarkdownRuntimeModule['preloadMarkdownRuntime'] {
    if (!('preloadMarkdownRuntime' in module)) return undefined;

    const runtimeModule = module as EnrichedMarkdownRuntimeModule;
    return runtimeModule.preloadMarkdownRuntime;
}

export function preloadEnrichedMarkdownRuntime(): Promise<void> {
    if (Platform.OS !== 'web') {
        preloadResolved = true;
        publishRuntimeStatus('ready');
        return Promise.resolve();
    }

    if (!preloadPromise && preloadFailure) {
        const retryAtMs = preloadFailureAtMs + loadSyncTuning().enrichedMarkdownRuntimePreloadRetryDelayMs;
        if (Date.now() < retryAtMs) {
            return Promise.reject(preloadFailure);
        }
    }

    if (!preloadPromise) {
        preloadFailure = null;
        preloadFailureAtMs = 0;
        preloadPromise = import('react-native-enriched-markdown')
            .then((module) => {
                return readPreloadMarkdownRuntime(module)?.() ?? undefined;
            })
            .then(() => {
                preloadResolved = true;
                preloadFailure = null;
                preloadFailureAtMs = 0;
                publishRuntimeStatus('ready');
            })
            .catch((error: unknown) => {
                preloadPromise = null;
                preloadResolved = false;
                preloadFailure = error;
                preloadFailureAtMs = Date.now();
                publishRuntimeStatus('failed');
                throw error;
            });
    }

    return preloadPromise;
}

export function isEnrichedMarkdownRuntimePreloaded(): boolean {
    return Platform.OS !== 'web' || preloadResolved;
}

export function useEnrichedMarkdownRuntimeStatus(): EnrichedMarkdownRuntimeStatus {
    const status = React.useSyncExternalStore(
        subscribeToRuntimeStatus,
        readRuntimeStatus,
        readRuntimeStatus,
    );

    React.useEffect(() => {
        if (status !== 'pending') return;
        fireAndForget(preloadEnrichedMarkdownRuntime(), {
            tag: 'EnrichedMarkdownRuntime.preload',
        });
    }, [status]);

    return status;
}
