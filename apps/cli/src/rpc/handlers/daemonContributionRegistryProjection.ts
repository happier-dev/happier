import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { configuration } from '@/configuration';
import { readInstalledPluginCatalog, type PluginCatalogEntry } from '@/plugins/projection/catalog/installed';
import {
    DaemonContributionRegistryProjectionDescribeRequestSchema,
    DaemonContributionRegistryProjectionDescribeResponseSchema,
    type DaemonContributionRegistryProjectionDescribeResponse,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import {
    resolveMergedContributionRegistry,
} from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { buildPluginProjectionV2 } from '@/plugins/projection/registry/projection/v2';
import { readPluginReloadStateSnapshot } from '@/plugins/runtime/reload/state';
import {
    resolveExecutablePluginRuntimeRegistry,
    type ResolvedExecutablePluginRuntimeRegistry,
} from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';

type RegisterOpts = Readonly<{
    resolveRegistry?: () => Promise<ResolvedContributionRegistry>;
    resolveRuntimeRegistry?: () => Promise<ResolvedExecutablePluginRuntimeRegistry>;
    resolveInstalledPackages?: () => Promise<readonly PluginCatalogEntry[]>;
    resolveGeneration?: () => Promise<number>;
}>;

let cachedProjection: DaemonContributionRegistryProjectionDescribeResponse | null = null;
let cachedAtMs = 0;
const CACHE_TTL_MS = 10_000;

export function invalidateDaemonContributionRegistryProjectionCache(): void {
    cachedProjection = null;
    cachedAtMs = 0;
}

async function defaultResolveRegistry(): Promise<ResolvedContributionRegistry> {
    return await resolveMergedContributionRegistry({ happyHomeDir: configuration.happyHomeDir });
}

async function defaultResolveRuntimeRegistry(opts: RegisterOpts | undefined): Promise<ResolvedExecutablePluginRuntimeRegistry> {
    const contributions = await (opts?.resolveRegistry ?? defaultResolveRegistry)();
    return await resolveExecutablePluginRuntimeRegistry({
        happyHomeDir: configuration.happyHomeDir,
        contributes: contributions,
    });
}

async function defaultResolveInstalledPackages(): Promise<readonly PluginCatalogEntry[]> {
    return await readInstalledPluginCatalog({ happyHomeDir: configuration.happyHomeDir });
}

async function defaultResolveGeneration(): Promise<number> {
    const snapshot = await readPluginReloadStateSnapshot(configuration.happyHomeDir);
    return snapshot?.generation ?? 0;
}

async function resolveProjection(opts: RegisterOpts | undefined): Promise<DaemonContributionRegistryProjectionDescribeResponse> {
    const now = Date.now();
    if (cachedProjection && now - cachedAtMs < CACHE_TTL_MS) {
        return cachedProjection;
    }

    const lease = opts?.resolveRuntimeRegistry
        ? {
            registry: await opts.resolveRuntimeRegistry(),
            release: async () => {},
        }
        : await acquireAuthoritativePluginRuntimeRegistryLease({
            happyHomeDir: configuration.happyHomeDir,
            resolveRuntimeRegistry: async () => await defaultResolveRuntimeRegistry(opts),
        });
    try {
        const projection = buildPluginProjectionV2({
            registry: lease.registry.contributes,
            generation: await (opts?.resolveGeneration ?? defaultResolveGeneration)(),
            installedPackages: await (opts?.resolveInstalledPackages ?? defaultResolveInstalledPackages)(),
            pluginDiagnosticsByPluginId: lease.registry.pluginDiagnosticsByPluginId,
        });
        const response = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
            protocolVersion: 1,
            projection,
        });
        cachedProjection = response;
        cachedAtMs = now;
        return response;
    } finally {
        await lease.release();
    }
}

export function registerDaemonContributionRegistryProjectionHandler(
    rpc: RpcHandlerRegistrar,
    opts?: RegisterOpts,
): void {
    rpc.registerHandler(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, async (raw: unknown) => {
        // Parse input for forward compatibility and to avoid accepting accidental session-scoped payloads.
        DaemonContributionRegistryProjectionDescribeRequestSchema.parse(raw);
        return await resolveProjection(opts);
    });
}
