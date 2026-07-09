import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { configuration } from '@/configuration';

import type { PluginReloadController, PluginRuntimeRegistryLease } from './controller';
import { pluginReloadController } from './singleton';

export async function acquireAuthoritativePluginRuntimeRegistryLease(params?: Readonly<{
    happyHomeDir?: string;
    controller?: PluginReloadController;
    resolveRuntimeRegistry?: () => Promise<Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>>>;
}>): Promise<PluginRuntimeRegistryLease> {
    // Callers may scope the registry resolution to a specific home directory (tests, multi-home
    // diagnostics). The singleton controller is global and reads `configuration.happyHomeDir`,
    // so only alternate explicit home-dir requests should bypass it.
    const shouldUseSingletonController = typeof params?.happyHomeDir !== 'string'
        || params.happyHomeDir === configuration.happyHomeDir;
    const controller = params?.controller
        ?? (shouldUseSingletonController ? pluginReloadController : null);
    if (controller && typeof controller.acquireRuntimeRegistry === 'function') {
        return await controller.acquireRuntimeRegistry({
            resolveRuntimeRegistry: params?.resolveRuntimeRegistry,
        });
    }

    if (params?.resolveRuntimeRegistry) {
        const registry = await params.resolveRuntimeRegistry();
        return {
            registry,
            source: 'ephemeral',
            release: async () => {
                await registry.dispose();
            },
        };
    }

    const registry = await resolveExecutablePluginRuntimeRegistry({
        happyHomeDir: params?.happyHomeDir,
    });
    return {
        registry,
        source: 'ephemeral',
        release: async () => {
            await registry.dispose();
        },
    };
}
