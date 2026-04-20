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

export type DaemonMergedProjectionInputs = Readonly<{
    mergedProviderProjectionById: Readonly<Record<string, MergedProviderProjectionEntry>>;
    mergedBackendProjectionById: Readonly<Record<string, MergedBackendProjectionEntry>>;
    discoveredBackendIds: readonly string[];
    pluginProjectionById: Readonly<Record<string, PluginProjectionEntry>>;
    registryDiagnostics: readonly PluginProjectionDiagnostic[];
}>;

type ProjectionCacheEntry =
    | Readonly<{ kind: 'ready'; fetchedAtMs: number; inputs: DaemonMergedProjectionInputs }>
    | Readonly<{ kind: 'unsupported'; fetchedAtMs: number }>
    | Readonly<{ kind: 'error'; fetchedAtMs: number }>;

const PROJECTION_CACHE = new Map<string, ProjectionCacheEntry>();
const PROJECTION_INFLIGHT = new Map<string, Promise<ProjectionCacheEntry>>();

export function clearDaemonMergedProjectionCacheForTests(): void {
    PROJECTION_CACHE.clear();
    PROJECTION_INFLIGHT.clear();
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
    registryDiagnostics: readonly PluginProjectionDiagnostic[];
}>): DaemonMergedProjectionInputs {
    return {
        mergedProviderProjectionById: params.mergedProviderProjectionById,
        mergedBackendProjectionById: params.mergedBackendProjectionById,
        discoveredBackendIds: Object.keys(params.mergedBackendProjectionById ?? {}),
        pluginProjectionById: params.pluginProjectionById,
        registryDiagnostics: params.registryDiagnostics,
    };
}

export async function loadDaemonMergedProjectionCacheEntry(params: Readonly<{
    machineId: string;
    serverId?: string | null;
}>): Promise<ProjectionCacheEntry> {
    const cacheKey = buildCacheKey(params.machineId, params.serverId);
    const inflight = PROJECTION_INFLIGHT.get(cacheKey);
    if (inflight) {
        return await inflight;
    }

    const request = (async (): Promise<ProjectionCacheEntry> => {
        const fetchedAtMs = Date.now();
        const res = await machineContributionRegistryProjectionDescribe(params.machineId, {
            ...(params.serverId ? { serverId: params.serverId } : {}),
            timeoutMs: 10_000,
        });
        if (res.supported !== true) {
            const entry: ProjectionCacheEntry = res.reason === 'not-supported'
                ? { kind: 'unsupported', fetchedAtMs }
                : { kind: 'error', fetchedAtMs };
            PROJECTION_CACHE.set(cacheKey, entry);
            return entry;
        }

        const adapted = adaptDaemonContributionRegistryProjectionToMergedProjectionInputs(res.projection);
        const entry: ProjectionCacheEntry = {
            kind: 'ready',
            fetchedAtMs,
            inputs: toInputs(adapted),
        };
        PROJECTION_CACHE.set(cacheKey, entry);
        return entry;
    })();

    PROJECTION_INFLIGHT.set(cacheKey, request);
    try {
        return await request;
    } finally {
        PROJECTION_INFLIGHT.delete(cacheKey);
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
