import {
    DaemonLocalServiceInventoryRefreshRequestV1Schema,
    DaemonLocalServiceInventoryRefreshResponseV1Schema,
    DaemonLocalServiceInventorySnapshotRequestV1Schema,
    DaemonLocalServiceInventorySnapshotResponseV1Schema,
    DaemonLocalServiceInventoryWatchRequestV1Schema,
    DaemonLocalServiceInventoryWatchResponseV1Schema,
    LocalServiceInventoryCountResponseV1Schema,
    type LocalServiceMachineSummaryV1,
} from '@happier-dev/protocol/local/services/inventory/v1';
import { isRpcMethodNotFoundResult, RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { isMachineRpcTimeoutError, MACHINE_RPC_TIMEOUT_ERROR_CODE, readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

import {
    type LocalServiceInventorySnapshotClientInput,
    type LocalServiceInventorySnapshotClientResult,
    type LocalServiceInventoryWatchClientInput,
    type LocalServiceInventoryWatchClientResult,
} from './api';

export async function fetchLocalServiceInventorySummaryViaMachineRpc(
    input: Omit<LocalServiceInventorySnapshotClientInput, 'refresh' | 'request'>,
): Promise<LocalServiceMachineSummaryV1 | null> {
    if (input.signal?.aborted) return null;
    try {
        const payload = DaemonLocalServiceInventorySnapshotRequestV1Schema.parse({ machineId: input.machineId, projection: 'count' });
        const raw = await machineRpcWithServerScope<unknown, typeof payload>({ machineId: input.machineId,
            serverId: input.serverId, accountId: input.accountId, method: RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_SNAPSHOT,
            payload, signal: input.signal });
        if (input.signal?.aborted) return null;
        const result = LocalServiceInventoryCountResponseV1Schema.safeParse(raw);
        return result.success ? result.data.summary : null;
    } catch { return null; }
}

export async function fetchLocalServiceInventorySnapshotViaMachineRpc(
    input: LocalServiceInventorySnapshotClientInput,
): Promise<LocalServiceInventorySnapshotClientResult> {
    if (input.signal?.aborted) {
        return { ok: false, reason: 'request_failed' };
    }
    try {
        const request = { machineId: input.machineId };
        const payload = input.refresh
            ? DaemonLocalServiceInventoryRefreshRequestV1Schema.parse(request)
            : DaemonLocalServiceInventorySnapshotRequestV1Schema.parse(request);
        const raw = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId: input.machineId,
            serverId: input.serverId,
            accountId: input.accountId,
            method: input.refresh
                ? RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH
                : RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_SNAPSHOT,
            payload,
            signal: input.signal,
        });
        if (isRpcMethodNotFoundResult(raw)) {
            return { ok: false, reason: 'unavailable', reasonCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
        }
        const parsed = input.refresh
            ? DaemonLocalServiceInventoryRefreshResponseV1Schema.safeParse(raw)
            : DaemonLocalServiceInventorySnapshotResponseV1Schema.safeParse(raw);
        if (!parsed.success || parsed.data.snapshot.machineId !== input.machineId) {
            return { ok: false, reason: 'invalid_response' };
        }
        return { ok: true, snapshot: parsed.data.snapshot };
    } catch (error) {
        const reasonCode = readRpcErrorCode(error)
            ?? (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined);
        return { ok: false, reason: 'request_failed', ...(reasonCode ? { reasonCode } : {}) };
    }
}

/**
 * Park on the daemon's inventory change producer.
 *
 * Omitted operation timeout uses the transport's
 * caller/remote lifetime, while connection setup remains bounded and AbortSignal retires demand.
 */
export async function watchLocalServiceInventorySnapshotViaMachineRpc(
    input: LocalServiceInventoryWatchClientInput,
): Promise<LocalServiceInventoryWatchClientResult> {
    if (input.signal?.aborted) {
        return { ok: false, reason: 'request_failed' };
    }
    try {
        const payload = DaemonLocalServiceInventoryWatchRequestV1Schema.parse({
            machineId: input.machineId,
            ...(input.observationOnly ? { observationOnly: true } : {}),
            ...(typeof input.sinceGeneratedAt === 'number'
                ? { sinceGeneratedAt: input.sinceGeneratedAt }
                : {}),
        });
        const raw = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId: input.machineId,
            serverId: input.serverId,
            accountId: input.accountId,
            method: RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH,
            payload,
            ...(input.signal ? { signal: input.signal } : {}),
        });
        if (isRpcMethodNotFoundResult(raw)) {
            return { ok: false, reason: 'unavailable' };
        }
        const parsed = DaemonLocalServiceInventoryWatchResponseV1Schema.safeParse(raw);
        if (!parsed.success) {
            return { ok: false, reason: 'invalid_response' };
        }
        if (!parsed.data.changed) {
            return { ok: true, changed: false };
        }
        return parsed.data.snapshot.machineId === input.machineId
            ? { ok: true, changed: true, snapshot: parsed.data.snapshot }
            : { ok: false, reason: 'invalid_response' };
    } catch (error) {
        return { ok: false, reason: 'request_failed',
            ...(isMachineRpcTimeoutError(error) ? { reasonCode: MACHINE_RPC_TIMEOUT_ERROR_CODE } : {}) };
    }
}
