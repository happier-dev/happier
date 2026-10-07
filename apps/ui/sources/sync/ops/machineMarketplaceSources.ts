import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { HostPrivateMarketplaceSourceRegistryMutationResponseV1Schema } from '@happier-dev/protocol/marketplace/internal';
import {
    resolvePreferredMarketplaceSource,
    MarketplaceSourceRegistryMutationV1Schema,
    type MarketplaceSourceRegistryMutationV1,
    type MarketplaceSourceRegistryV1,
    type MarketplaceSourceV1,
    type MarketplaceIndexQueryV1,
    type MarketplaceIndexQueryResultV1,
    MarketplaceIndexQueryResultV1Schema,
} from '@happier-dev/protocol/marketplace';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

type MachineMarketplaceSourceRegistryRpcOpts = Readonly<{
    serverId?: string | null;
    timeoutMs?: number | null;
}>;

export type MachineMarketplaceSourceRegistryMutationResult =
    | Readonly<{ status: 'success'; registry: MarketplaceSourceRegistryV1 }>
    | Readonly<{ status: 'unavailable' }>
    | Readonly<{ status: 'outcomeUnknown' }>;

export function resolvePreferredMachineMarketplaceSource(registry: MarketplaceSourceRegistryV1): MarketplaceSourceV1 | null {
    return resolvePreferredMarketplaceSource(registry.sources);
}

export async function machineMarketplaceSourceRegistryGet(
    machineId: string,
    opts?: MachineMarketplaceSourceRegistryRpcOpts,
): Promise<MarketplaceSourceRegistryV1> {
    return await machineRpcWithServerScope<MarketplaceSourceRegistryV1, Record<string, never>>({
        machineId,
        serverId: opts?.serverId ?? undefined,
        timeoutMs: opts?.timeoutMs ?? undefined,
        ...(opts?.timeoutMs === null ? { operationTimeoutMs: null } : {}),
        method: RPC_METHODS.DAEMON_MARKETPLACE_SOURCE_REGISTRY_GET,
        payload: {},
    });
}

export async function machineMarketplaceSourceRegistryMutate(
    machineId: string,
    mutation: MarketplaceSourceRegistryMutationV1,
    opts?: MachineMarketplaceSourceRegistryRpcOpts,
): Promise<MachineMarketplaceSourceRegistryMutationResult> {
    const payload = MarketplaceSourceRegistryMutationV1Schema.parse(mutation);
    let issued = false;
    try {
        const response = await machineRpcWithServerScope<unknown, MarketplaceSourceRegistryMutationV1>({
            machineId,
            serverId: opts?.serverId ?? undefined,
            timeoutMs: opts?.timeoutMs ?? undefined,
            ...(opts?.timeoutMs === null ? { operationTimeoutMs: null } : {}),
            method: RPC_METHODS.DAEMON_MARKETPLACE_SOURCE_REGISTRY_MUTATE,
            payload,
            onIssued: () => { issued = true; },
        });
        const parsed = HostPrivateMarketplaceSourceRegistryMutationResponseV1Schema.safeParse(response);
        if (!parsed.success) {
            if (issued) return { status: 'outcomeUnknown' };
            throw new Error('Invalid marketplace source registry response from daemon');
        }
        if ('ok' in parsed.data) return { status: 'unavailable' };
        return { status: 'success', registry: parsed.data };
    } catch (error) {
        if (issued) return { status: 'outcomeUnknown' };
        throw error;
    }
}

/**
 * One incremental Discover page. The caller owns the cursor: it renders the
 * page immediately and asks for the next page only when the user wants more,
 * comparing `revision` across loads to detect a changed index instead of
 * silently mixing pages from different revisions.
 */
export async function machineMarketplaceIndexQuery(
    machineId: string,
    query: MarketplaceIndexQueryV1,
    opts?: MachineMarketplaceSourceRegistryRpcOpts,
): Promise<MarketplaceIndexQueryResultV1> {
    const raw = await machineRpcWithServerScope<unknown, MarketplaceIndexQueryV1>({
        machineId,
        serverId: opts?.serverId ?? undefined,
        timeoutMs: opts?.timeoutMs ?? undefined,
        ...(opts?.timeoutMs === null ? { operationTimeoutMs: null } : {}),
        method: RPC_METHODS.DAEMON_MARKETPLACE_INDEX_QUERY,
        payload: query,
    });
    const parsed = MarketplaceIndexQueryResultV1Schema.safeParse(raw);
    if (!parsed.success) throw new Error('Invalid marketplace index response from daemon');
    return parsed.data;
}
