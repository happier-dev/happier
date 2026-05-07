import { Platform } from 'react-native';

type EnrichedMarkdownRuntimeModule = Readonly<{
    preloadMarkdownRuntime?: () => Promise<void>;
}>;

let preloadPromise: Promise<void> | null = null;

function readPreloadMarkdownRuntime(
    module: object,
): EnrichedMarkdownRuntimeModule['preloadMarkdownRuntime'] {
    if (!('preloadMarkdownRuntime' in module)) return undefined;

    const runtimeModule = module as EnrichedMarkdownRuntimeModule;
    return runtimeModule.preloadMarkdownRuntime;
}

export function preloadEnrichedMarkdownRuntime(): Promise<void> {
    if (Platform.OS !== 'web') return Promise.resolve();

    if (!preloadPromise) {
        preloadPromise = import('react-native-enriched-markdown')
            .then((module) => {
                return readPreloadMarkdownRuntime(module)?.() ?? undefined;
            })
            .catch((error: unknown) => {
                preloadPromise = null;
                throw error;
            });
    }

    return preloadPromise;
}
