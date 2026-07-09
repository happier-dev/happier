import type { PluginSourceTrustPolicyV1 } from '@happier-dev/protocol';

import { loadPluginModule } from './loadPluginModule';
import type { PluginDaemonModuleNamespace } from './types';

/**
 * Transitional wrapper maintained for internal call sites until PS-03 callers
 * are fully migrated to `loadPluginModule(...)`.
 */
export async function loadPluginDaemonModule(params: Readonly<{
    daemonEntryPath: string;
    devDaemonEntryPath?: string | null;
    cacheKey?: string;
    trustPolicy?: PluginSourceTrustPolicyV1;
}>): Promise<PluginDaemonModuleNamespace> {
    return await loadPluginModule({
        source: {
            kind: 'file_backed',
            entryPath: params.daemonEntryPath,
            devEntryPath: params.devDaemonEntryPath,
            trustPolicy: params.trustPolicy,
        },
        cacheKey: params.cacheKey,
    }) as PluginDaemonModuleNamespace;
}
