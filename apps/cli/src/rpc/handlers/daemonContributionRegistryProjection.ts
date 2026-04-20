import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { configuration } from '@/configuration';
import { readInstalledPluginCatalog, type PluginCatalogEntry } from '@/extensions/catalog/installed';
import {
    DaemonContributionRegistryProjectionDescribeRequestSchema,
    DaemonContributionRegistryProjectionDescribeResponseSchema,
    type DaemonContributionRegistryProjectionDescribeResponse,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import {
    resolveMergedContributionRegistry,
} from '@/extensions/registry/createResolvedContributionRegistry';
import type { ResolvedContributionRegistry } from '@/extensions/registry/types';
import { buildExtensionProjectionV2 } from '@/extensions/registry/projection/v2';
import { readPluginReloadStateSnapshot } from '@/extensions/reload/state';
import {
    resolveExecutablePluginRuntimeRegistry,
    type ResolvedExecutablePluginRuntimeRegistry,
} from '@/extensions/runtime/resolveExecutablePluginRuntimeRegistry';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/extensions/reload/runtimeLease';

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
        contributions,
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
        const projection = buildExtensionProjectionV2({
            registry: lease.registry.contributions,
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
