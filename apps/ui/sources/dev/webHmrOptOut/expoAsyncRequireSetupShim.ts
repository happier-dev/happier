import { installWebHmrOptOutForCurrentWebTab } from './webHmrOptOut';

type ModuleLoaders = {
    loadSetupFastRefresh: () => unknown;
    loadSetupHMR: () => unknown;
    loadMessageSocket: () => unknown;
    loadHmr: () => unknown;
    loadSetup: () => unknown;
};

declare const require: (id: string) => unknown;

const defaultModuleLoaders: ModuleLoaders = {
    // Keep literal require() calls so Metro can statically include these modules.
    loadSetupFastRefresh: () => require('expo/src/async-require/setupFastRefresh'),
    loadSetupHMR: () => require('expo/src/async-require/setupHMR'),
    loadMessageSocket: () => require('expo/src/async-require/messageSocket'),
    loadHmr: () => require('expo/src/async-require/hmr'),
    loadSetup: () => require('expo/src/async-require/setup'),
};

function isModuleResolutionError(error: unknown): boolean {
    if (error == null) {
        return false;
    }
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('unknown module') || message.includes('Cannot find module');
}

export function runExpoAsyncRequireSetupShim({
    isDev,
    hasWindow,
    optOut,
    loaders = defaultModuleLoaders,
}: {
    isDev: boolean;
    hasWindow: boolean;
    optOut: boolean;
    loaders?: ModuleLoaders;
}): void {
    if (!isDev || !hasWindow) {
        return;
    }

    if (!optOut) {
        try {
            loaders.loadSetupFastRefresh();
            loaders.loadSetupHMR();
            loaders.loadMessageSocket();
        } catch (error) {
            // Some runtimes may not expose the split setup modules directly.
            if (!isModuleResolutionError(error)) {
                throw error;
            }
            loaders.loadSetup();
        }
        return;
    }

    // IMPORTANT:
    // Even when opting out, we still initialize the Expo HMR client with isEnabled=false.
    // Expo's bundle-splitting loader calls `HMRClient.registerBundle(...)` in dev mode.
    // If HMRClient isn't set up, that path will throw and break dynamic imports.
    const mod = loaders.loadHmr();
    if (typeof mod !== 'object' || mod === null || !('default' in mod)) {
        return;
    }

    const hmrClient = (mod as { default?: unknown }).default;
    if (typeof hmrClient !== 'object' || hmrClient === null || !('setup' in hmrClient)) {
        return;
    }

    const setup = (hmrClient as { setup?: unknown }).setup;
    if (typeof setup !== 'function') {
        return;
    }

    setup({ isEnabled: false });
}

runExpoAsyncRequireSetupShim({
    isDev: typeof __DEV__ !== 'undefined' ? __DEV__ : false,
    hasWindow: typeof window !== 'undefined',
    // IMPORTANT: This module is imported extremely early on web (via Expo's winter runtime).
    // Initialize the per-tab opt-out *here* so we can disable Fast Refresh/HMR before Expo's
    // setup modules create dev sockets.
    optOut:
        (typeof __DEV__ !== 'undefined' ? __DEV__ : false) &&
        typeof window !== 'undefined'
            ? installWebHmrOptOutForCurrentWebTab()
            : globalThis.__HAPPIER_WEB_HMR_OPT_OUT__ === true,
});
