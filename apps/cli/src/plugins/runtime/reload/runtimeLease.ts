import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { configuration } from '@/configuration';

import type { PluginReloadController, PluginRuntimeRegistryLease } from './controller';
import { pluginReloadController } from './singleton';

export function createEphemeralPluginRuntimeRegistryLease(
    registry: ResolvedExecutablePluginRuntimeRegistry,
): PluginRuntimeRegistryLease {
    let released = false;
    return {
        registry,
        source: 'ephemeral',
        resolveCurrentPluginMaterializationRef: registry.resolveCurrentPluginMaterializationRef,
        resolveCurrentMediatorContributionMaterializationRef:
            registry.resolveCurrentMediatorContributionMaterializationRef,
        release: async () => {
            if (released) return;
            released = true;
            await registry.dispose();
        },
    };
}

export async function acquireAuthoritativePluginRuntimeRegistryLease(params?: Readonly<{
    happyHomeDir?: string;
    controller?: PluginReloadController;
}>): Promise<PluginRuntimeRegistryLease> {
    // Callers may scope the registry resolution to a specific home directory (tests, multi-home
    // diagnostics). The singleton controller is global and reads `configuration.happyHomeDir`,
    // so only alternate explicit home-dir requests should bypass it.
    const shouldUseSingletonController = typeof params?.happyHomeDir !== 'string'
        || params.happyHomeDir === configuration.happyHomeDir;
    const controller = params?.controller
        ?? (shouldUseSingletonController ? pluginReloadController : null);
    const lease = controller?.tryAcquireRuntimeRegistry?.() ?? null;
    if (lease) {
        return lease;
    }

    const error = new Error(
        'The canonical daemon-applied plugin runtime is unavailable in this process',
    ) as Error & { code: string };
    error.code = 'PLUGIN_DAEMON_RUNTIME_UNAVAILABLE';
    throw error;
}

export function tryAcquireAuthoritativePluginRuntimeRegistryLease(params?: Readonly<{
    happyHomeDir?: string;
    controller?: PluginReloadController;
}>): PluginRuntimeRegistryLease | null {
    const shouldUseSingletonController = typeof params?.happyHomeDir !== 'string'
        || params.happyHomeDir === configuration.happyHomeDir;
    const controller = params?.controller
        ?? (shouldUseSingletonController ? pluginReloadController : null);
    return controller?.tryAcquireRuntimeRegistry?.() ?? null;
}
