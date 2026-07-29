import { Platform } from 'react-native';

import type { DaemonReactNativeWebLoaderCapabilityV1 } from '@happier-dev/protocol';

import { createReactNativeWebLoaderBackend } from './webLoaderBackend.web';

/** Node/Vitest bridge; Metro selects the platform-specific sibling files. */
export function resolveReactNativeWebLoaderCapability(params?: Readonly<{
    resolveLoaderBackend?: () => ReturnType<typeof createReactNativeWebLoaderBackend>;
}>): DaemonReactNativeWebLoaderCapabilityV1 | null {
    if (Platform.OS !== 'web') return null;
    try {
        const backend = (params?.resolveLoaderBackend ?? createReactNativeWebLoaderBackend)();
        return Object.freeze({
            integrated: backend.backendId === 'reactNativeWebModule',
            installedArtifactLoaderAvailable:
                backend.available === true && typeof backend.loadInstalledBundle === 'function',
        });
    } catch {
        return Object.freeze({ integrated: false, installedArtifactLoaderAvailable: false });
    }
}
