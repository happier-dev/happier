import type { DaemonReactNativeWebLoaderCapabilityV1 } from '@happier-dev/protocol';

import { createReactNativeWebLoaderBackend } from './webLoaderBackend.web';

export function resolveReactNativeWebLoaderCapability(params?: Readonly<{
    resolveLoaderBackend?: () => ReturnType<typeof createReactNativeWebLoaderBackend>;
}>): DaemonReactNativeWebLoaderCapabilityV1 {
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
