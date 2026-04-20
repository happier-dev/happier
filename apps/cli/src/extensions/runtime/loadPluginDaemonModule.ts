import type { ExtensionSourceTrustPolicyV1 } from '@happier-dev/protocol';

import { loadExtensionModule } from './loadExtensionModule';
import type { PluginDaemonModuleNamespace } from './types';

/**
 * Transitional wrapper maintained for internal call sites until PS-03 callers
 * are fully migrated to `loadExtensionModule(...)`.
 */
export async function loadPluginDaemonModule(params: Readonly<{
    daemonEntryPath: string;
    cacheKey?: string;
    trustPolicy?: ExtensionSourceTrustPolicyV1;
}>): Promise<PluginDaemonModuleNamespace> {
    return await loadExtensionModule({
        source: {
            kind: 'file_backed',
            entryPath: params.daemonEntryPath,
            trustPolicy: params.trustPolicy,
        },
        cacheKey: params.cacheKey,
    }) as PluginDaemonModuleNamespace;
}
