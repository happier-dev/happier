import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
    createMarketplaceSourceV1,
    resolvePreferredMarketplaceSource,
    type MarketplaceSourceOriginV1,
    type MarketplaceSourceRegistryV1,
    type MarketplaceSourceV1,
} from '@happier-dev/protocol';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

type MachineMarketplaceSourceRegistryRpcOpts = Readonly<{
    serverId?: string | null;
    timeoutMs?: number | null;
}>;

export type MachineMarketplaceSourceRegistryInputV1 = Readonly<{
    sourceUrl: string;
    title?: string | null;
    description?: string | null;
    origin?: MarketplaceSourceOriginV1 | null;
    enabled?: boolean;
}>;

function normalizeSourceUrl(sourceUrl: string): string {
    const trimmed = String(sourceUrl ?? '').trim();
    if (!trimmed) {
        throw new Error('Marketplace source URL is required');
    }
    return trimmed;
}

function normalizeOptionalDescription(description: string | null | undefined): string | null | undefined {
    if (description === null) return null;
    if (typeof description === 'string') {
        const trimmed = description.trim();
        return trimmed.length > 0 ? trimmed : null;
    }
    return undefined;
}

function createMarketplaceSourceRecord(
    input: MachineMarketplaceSourceRegistryInputV1,
    existing?: MarketplaceSourceV1 | null,
): MarketplaceSourceV1 {
    return createMarketplaceSourceV1({
        sourceUrl: normalizeSourceUrl(input.sourceUrl),
        title: input.title ?? undefined,
        description: normalizeOptionalDescription(input.description),
        enabled: input.enabled,
        origin: input.origin ?? undefined,
    }, existing);
}

export function resolvePreferredMachineMarketplaceSource(registry: MarketplaceSourceRegistryV1): MarketplaceSourceV1 | null {
    return resolvePreferredMarketplaceSource(registry.sources);
}

export function upsertMachineMarketplaceSourceRegistrySource(
    registry: MarketplaceSourceRegistryV1,
    input: MachineMarketplaceSourceRegistryInputV1,
): Readonly<{ registry: MarketplaceSourceRegistryV1; source: MarketplaceSourceV1 }> {
    const sourceUrl = normalizeSourceUrl(input.sourceUrl);
    const existingIndex = registry.sources.findIndex((entry) => entry.sourceUrl === sourceUrl);
    const existing = existingIndex >= 0 ? registry.sources[existingIndex] : null;
    const source = createMarketplaceSourceRecord(input, existing);
    const sources = existingIndex >= 0
        ? registry.sources.map((entry, index) => (index === existingIndex ? source : entry))
        : [...registry.sources, source];
    return {
        registry: {
            ...registry,
            sources,
        },
        source,
    };
}

export function setMachineMarketplaceSourceRegistrySourceEnabled(
    registry: MarketplaceSourceRegistryV1,
    sourceId: string,
    enabled: boolean,
): Readonly<{ registry: MarketplaceSourceRegistryV1; source: MarketplaceSourceV1 | null }> {
    const normalizedSourceId = String(sourceId ?? '').trim();
    if (!normalizedSourceId) {
        return { registry, source: null };
    }

    let nextSource: MarketplaceSourceV1 | null = null;
    const sources = registry.sources.map((entry) => {
        if (entry.id !== normalizedSourceId) {
            return entry;
        }
        nextSource = {
            ...entry,
            enabled: Boolean(enabled),
            updatedAtMs: Date.now(),
        };
        return nextSource;
    });

    return {
        registry: nextSource
            ? {
                ...registry,
                sources,
            }
            : registry,
        source: nextSource,
    };
}

export function removeMachineMarketplaceSourceRegistrySource(
    registry: MarketplaceSourceRegistryV1,
    sourceId: string,
): Readonly<{ registry: MarketplaceSourceRegistryV1; removed: boolean }> {
    const normalizedSourceId = String(sourceId ?? '').trim();
    if (!normalizedSourceId) {
        return { registry, removed: false };
    }
    const sources = registry.sources.filter((entry) => entry.id !== normalizedSourceId);
    if (sources.length === registry.sources.length) {
        return { registry, removed: false };
    }
    return {
        registry: {
            ...registry,
            sources,
        },
        removed: true,
    };
}

export async function machineMarketplaceSourceRegistryGet(
    machineId: string,
    opts?: MachineMarketplaceSourceRegistryRpcOpts,
): Promise<MarketplaceSourceRegistryV1> {
    return await machineRpcWithServerScope<MarketplaceSourceRegistryV1, Record<string, never>>({
        machineId,
        serverId: opts?.serverId ?? undefined,
        timeoutMs: opts?.timeoutMs ?? undefined,
        method: RPC_METHODS.DAEMON_MARKETPLACE_SOURCE_REGISTRY_GET,
        payload: {},
    });
}

export async function machineMarketplaceSourceRegistrySet(
    machineId: string,
    registry: MarketplaceSourceRegistryV1,
    opts?: MachineMarketplaceSourceRegistryRpcOpts,
): Promise<MarketplaceSourceRegistryV1> {
    return await machineRpcWithServerScope<MarketplaceSourceRegistryV1, MarketplaceSourceRegistryV1>({
        machineId,
        serverId: opts?.serverId ?? undefined,
        timeoutMs: opts?.timeoutMs ?? undefined,
        method: RPC_METHODS.DAEMON_MARKETPLACE_SOURCE_REGISTRY_SET,
        payload: registry,
    });
}
