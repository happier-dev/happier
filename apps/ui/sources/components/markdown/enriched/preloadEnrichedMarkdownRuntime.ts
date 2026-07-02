import { Platform } from 'react-native';
import { loadSyncTuning } from '@/sync/runtime/syncTuning';

type EnrichedMarkdownRuntimeModule = Readonly<{
    preloadMarkdownRuntime?: () => Promise<void>;
}>;

let preloadPromise: Promise<void> | null = null;
let preloadResolved = Platform.OS !== 'web';
let preloadFailure: unknown = null;
let preloadFailureAtMs = 0;

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
            })
            .catch((error: unknown) => {
                preloadPromise = null;
                preloadResolved = false;
                preloadFailure = error;
                preloadFailureAtMs = Date.now();
                throw error;
            });
    }

    return preloadPromise;
}

export function isEnrichedMarkdownRuntimePreloaded(): boolean {
    return Platform.OS !== 'web' || preloadResolved;
}
