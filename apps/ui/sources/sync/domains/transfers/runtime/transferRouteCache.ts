import type { TransferEndpointCandidate } from '@happier-dev/protocol';
import {
    createMachineTransferRouteCache,
    DEFAULT_MACHINE_TRANSFER_ROUTE_CACHE_NEGATIVE_TTL_MS,
    DEFAULT_MACHINE_TRANSFER_ROUTE_CACHE_POSITIVE_TTL_MS,
    type TransferRouteViabilityRecord,
} from '@happier-dev/transfers';

const DEFAULT_SERVER_SCOPE_ID = '__default__';

function readPositiveIntEnv(name: string, fallback: number): number {
    const raw = String(process.env[name] ?? '').trim();
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return parsed;
}

function normalizeServerScopeId(serverId: string | null | undefined): string {
    const trimmed = String(serverId ?? '').trim();
    return trimmed.length > 0 ? trimmed : DEFAULT_SERVER_SCOPE_ID;
}

type DirectPeerRouteInput = Readonly<{
    serverId?: string | null;
    remoteMachineId: string;
    endpointCandidates: readonly TransferEndpointCandidate[];
}>;

type MachineRpcDirectRouteInput = Readonly<{
    serverId?: string | null;
    remoteMachineId: string;
}>;

function createScopedTransferRouteCache(serverId: string | null | undefined) {
    return createMachineTransferRouteCache({
        serverId: normalizeServerScopeId(serverId),
        now: Date.now,
        positiveTtlMs: readPositiveIntEnv(
            'EXPO_PUBLIC_HAPPIER_MACHINE_TRANSFER_ROUTE_CACHE_POSITIVE_TTL_MS',
            DEFAULT_MACHINE_TRANSFER_ROUTE_CACHE_POSITIVE_TTL_MS,
        ),
        negativeTtlMs: readPositiveIntEnv(
            'EXPO_PUBLIC_HAPPIER_MACHINE_TRANSFER_ROUTE_CACHE_NEGATIVE_TTL_MS',
            DEFAULT_MACHINE_TRANSFER_ROUTE_CACHE_NEGATIVE_TTL_MS,
        ),
    });
}

const transferRouteCachesByServerScopeId = new Map<string, ReturnType<typeof createMachineTransferRouteCache>>();

function getScopedTransferRouteCache(serverId: string | null | undefined) {
    const normalizedServerId = normalizeServerScopeId(serverId);
    const existingCache = transferRouteCachesByServerScopeId.get(normalizedServerId);
    if (existingCache) {
        return existingCache;
    }
    const nextCache = createScopedTransferRouteCache(normalizedServerId);
    transferRouteCachesByServerScopeId.set(normalizedServerId, nextCache);
    return nextCache;
}

export function readCachedDirectPeerRoute(input: DirectPeerRouteInput): TransferRouteViabilityRecord {
    return getScopedTransferRouteCache(input.serverId).readDirectPeerRoute({
        remoteMachineId: input.remoteMachineId,
        endpointCandidates: input.endpointCandidates,
    });
}

export function recordCachedDirectPeerRouteUnavailable(
    input: DirectPeerRouteInput,
    failureReason: string,
): void {
    getScopedTransferRouteCache(input.serverId).recordDirectPeerRouteUnavailable({
        remoteMachineId: input.remoteMachineId,
        endpointCandidates: input.endpointCandidates,
    }, failureReason);
}

export function recordCachedDirectPeerRouteViable(input: DirectPeerRouteInput): void {
    getScopedTransferRouteCache(input.serverId).recordDirectPeerRouteViable({
        remoteMachineId: input.remoteMachineId,
        endpointCandidates: input.endpointCandidates,
    });
}

export function readCachedMachineRpcDirectRoute(
    input: MachineRpcDirectRouteInput,
): TransferRouteViabilityRecord {
    return getScopedTransferRouteCache(input.serverId).readMachineRpcDirectRoute({
        remoteMachineId: input.remoteMachineId,
    });
}

export function recordCachedMachineRpcDirectRouteUnavailable(
    input: MachineRpcDirectRouteInput,
    failureReason: string,
): void {
    getScopedTransferRouteCache(input.serverId).recordMachineRpcDirectRouteUnavailable({
        remoteMachineId: input.remoteMachineId,
    }, failureReason);
}

export function recordCachedMachineRpcDirectRouteViable(input: MachineRpcDirectRouteInput): void {
    getScopedTransferRouteCache(input.serverId).recordMachineRpcDirectRouteViable({
        remoteMachineId: input.remoteMachineId,
    });
}
