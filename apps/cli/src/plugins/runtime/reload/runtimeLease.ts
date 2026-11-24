import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { PluginRuntimeSlotOccurrence } from '@/plugins/runtime/runtimeSlots';
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
        durableRevision: registry.durableRevision ?? -1,
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

type AuthoritativeControllerParams = Readonly<{
    happyHomeDir?: string;
    controller?: PluginReloadController;
    signal?: AbortSignal;
}>;

function resolveAuthoritativeController(params?: AuthoritativeControllerParams): PluginReloadController | null {
    // Callers may scope the registry resolution to a specific home directory (tests, multi-home
    // diagnostics). The singleton controller is global and reads `configuration.happyHomeDir`,
    // so only alternate explicit home-dir requests should bypass it.
    const shouldUseSingletonController = typeof params?.happyHomeDir !== 'string'
        || params.happyHomeDir === configuration.happyHomeDir;
    return params?.controller
        ?? (shouldUseSingletonController ? pluginReloadController : null);
}

/**
 * The occurrence one plugin's slot serves now, read from the runtime owner's
 * slot map. Reading a per-plugin identity fact needs no registry lease.
 */
export function readAuthoritativePluginSlotOccurrence(
    pluginId: string,
    params?: AuthoritativeControllerParams,
): PluginRuntimeSlotOccurrence | null {
    return resolveAuthoritativeController(params)?.readPluginSlot?.(pluginId)?.current ?? null;
}

export class PluginDaemonRuntimeUnavailableError extends Error {
    readonly code = 'PLUGIN_DAEMON_RUNTIME_UNAVAILABLE';

    constructor() {
        super('The daemon-applied plugin runtime is unavailable. Check the Machine daemon log for the cause.');
        this.name = 'PluginDaemonRuntimeUnavailableError';
    }
}

export async function acquireAuthoritativePluginRuntimeRegistryLease(
    params?: AuthoritativeControllerParams,
): Promise<PluginRuntimeRegistryLease> {
    const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease(params);
    if (lease) return lease;

    throw new PluginDaemonRuntimeUnavailableError();
}

/** Executable demand joins daemon restoration; advisory reads never wait on it. */
export async function acquireExecutableAuthoritativePluginRuntimeRegistryLease(
    params?: AuthoritativeControllerParams,
): Promise<PluginRuntimeRegistryLease> {
    const lease = await resolveAuthoritativeController(params)?.acquireExecutableRuntimeRegistry(
        params?.signal, { recoverAccountCensus: true },
    );
    if (lease) return lease;
    throw new PluginDaemonRuntimeUnavailableError();
}

export function tryAcquireAuthoritativePluginRuntimeRegistryLease(
    params?: AuthoritativeControllerParams,
): PluginRuntimeRegistryLease | null {
    return resolveAuthoritativeController(params)?.tryAcquireRuntimeRegistry() ?? null;
}
