import { machineContributionRegistryProjectionDescribe } from '@/sync/ops/machineContributionRegistryProjection';

import {
    adaptDaemonContributionRegistryProjectionToMergedProjectionInputs,
    type PluginProjectionDiagnostic,
    type PluginProjectionEntry,
} from './daemonContributionRegistryProjectionAdapters';
import type {
    MergedBackendProjectionEntry,
    MergedProviderProjectionEntry,
} from './mergedProjectionTypes';
import type { PluginProjectionV2 } from '@happier-dev/protocol';

export type DaemonMergedProjectionInputs = Readonly<{
    mergedProviderProjectionById: Readonly<Record<string, MergedProviderProjectionEntry>>;
    mergedBackendProjectionById: Readonly<Record<string, MergedBackendProjectionEntry>>;
    discoveredBackendIds: readonly string[];
    pluginProjectionById: Readonly<Record<string, PluginProjectionEntry>>;
    pluginProjectionV2: PluginProjectionV2 | null;
    registryDiagnostics: readonly PluginProjectionDiagnostic[];
}>;

type ProjectionCacheEntry =
    | Readonly<{ kind: 'ready'; fetchedAtMs: number; inputs: DaemonMergedProjectionInputs }>
    | Readonly<{ kind: 'unsupported'; fetchedAtMs: number }>
    | Readonly<{
        kind: 'error';
        fetchedAtMs: number;
        inputs?: DaemonMergedProjectionInputs;
    }>;

const PROJECTION_CACHE = new Map<string, ProjectionCacheEntry>();
const LATEST_PROJECTION_REQUEST = new Map<string, Promise<ProjectionCacheEntry>>();

export function clearDaemonMergedProjectionCacheForTests(): void {
    PROJECTION_CACHE.clear();
    LATEST_PROJECTION_REQUEST.clear();
}

function normalizeKeyPart(value: string | null | undefined): string {
    return String(value ?? '').trim();
}

function buildCacheKey(machineId: string, serverId: string | null | undefined): string {
    return `${normalizeKeyPart(serverId)}::${normalizeKeyPart(machineId)}`;
}

export function entryIsFresh(entry: Readonly<{ fetchedAtMs: number }>, staleMs: number): boolean {
    const ageMs = Date.now() - entry.fetchedAtMs;
    return ageMs >= 0 && ageMs <= staleMs;
}

export function readCachedDaemonMergedProjectionCacheEntry(params: Readonly<{
    machineId: string | null | undefined;
    serverId?: string | null;
}>): ProjectionCacheEntry | null {
    const machineId = normalizeKeyPart(params.machineId);
    if (!machineId) {
        return null;
    }
    const serverId = normalizeKeyPart(params.serverId);
    return PROJECTION_CACHE.get(buildCacheKey(machineId, serverId || null)) ?? null;
}

function toInputs(params: Readonly<{
    mergedProviderProjectionById: Readonly<Record<string, MergedProviderProjectionEntry>>;
    mergedBackendProjectionById: Readonly<Record<string, MergedBackendProjectionEntry>>;
    pluginProjectionById: Readonly<Record<string, PluginProjectionEntry>>;
    pluginProjectionV2: PluginProjectionV2 | null;
    registryDiagnostics: readonly PluginProjectionDiagnostic[];
}>): DaemonMergedProjectionInputs {
    return {
        mergedProviderProjectionById: params.mergedProviderProjectionById,
        mergedBackendProjectionById: params.mergedBackendProjectionById,
        discoveredBackendIds: Object.keys(params.mergedBackendProjectionById ?? {}),
        pluginProjectionById: params.pluginProjectionById,
        pluginProjectionV2: params.pluginProjectionV2,
        registryDiagnostics: params.registryDiagnostics,
    };
}

export async function loadDaemonMergedProjectionCacheEntry(params: Readonly<{
    machineId: string;
    serverId?: string | null;
}>): Promise<ProjectionCacheEntry> {
    const cacheKey = buildCacheKey(params.machineId, params.serverId);
    let request!: Promise<ProjectionCacheEntry>;
    const publishIfLatest = (entry: ProjectionCacheEntry): ProjectionCacheEntry => {
        if (LATEST_PROJECTION_REQUEST.get(cacheKey) !== request) {
            return PROJECTION_CACHE.get(cacheKey) ?? entry;
        }
        PROJECTION_CACHE.set(cacheKey, entry);
        return entry;
    };
    request = (async () => {
        const fetchedAtMs = Date.now();
        const res = await machineContributionRegistryProjectionDescribe(params.machineId, {
            ...(params.serverId ? { serverId: params.serverId } : {}),
            timeoutMs: 10_000,
        });
        if (res.supported !== true) {
            const previous = PROJECTION_CACHE.get(cacheKey);
            return publishIfLatest(res.reason === 'not-supported'
                ? { kind: 'unsupported', fetchedAtMs }
                : {
                    kind: 'error',
                    fetchedAtMs,
                    ...(
                        previous?.kind === 'ready' || previous?.kind === 'error'
                            ? { inputs: previous.inputs }
                            : {}
                    ),
                });
        }

        const adapted = adaptDaemonContributionRegistryProjectionToMergedProjectionInputs(res.projection);
        return publishIfLatest({
            kind: 'ready',
            fetchedAtMs,
            inputs: toInputs({
                ...adapted,
                pluginProjectionV2: res.projection.v === 2 ? res.projection : null,
            }),
        });
    })();
    LATEST_PROJECTION_REQUEST.set(cacheKey, request);
    try {
        return await request;
    } finally {
        if (LATEST_PROJECTION_REQUEST.get(cacheKey) === request) {
            LATEST_PROJECTION_REQUEST.delete(cacheKey);
        }
    }
}

export async function loadDaemonMergedProjectionInputs(params: Readonly<{
    machineId: string | null | undefined;
    serverId?: string | null;
    staleMs?: number;
}>): Promise<DaemonMergedProjectionInputs | null> {
    const machineId = normalizeKeyPart(params.machineId);
    if (!machineId) {
        return null;
    }

    const serverId = normalizeKeyPart(params.serverId);
    const staleMs = typeof params.staleMs === 'number' && Number.isFinite(params.staleMs) && params.staleMs >= 0
        ? Math.max(0, Math.floor(params.staleMs))
        : 60_000;
    const cacheKey = buildCacheKey(machineId, serverId || null);
    const cached = PROJECTION_CACHE.get(cacheKey) ?? null;
    if (cached?.kind === 'ready' && entryIsFresh(cached, staleMs)) {
        return cached.inputs;
    }

    const entry = await loadDaemonMergedProjectionCacheEntry({
        machineId,
        ...(serverId ? { serverId } : {}),
    });
    return entry.kind === 'ready' ? entry.inputs : null;
}
