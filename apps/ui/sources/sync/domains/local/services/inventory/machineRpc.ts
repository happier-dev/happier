import {
    DaemonLocalServiceInventoryRefreshRequestV1Schema,
    DaemonLocalServiceInventoryRefreshResponseV1Schema,
    DaemonLocalServiceInventorySnapshotRequestV1Schema,
    DaemonLocalServiceInventorySnapshotResponseV1Schema,
    DaemonLocalServiceInventoryWatchRequestV1Schema,
    DaemonLocalServiceInventoryWatchResponseV1Schema,
    LOCAL_SERVICE_INVENTORY_WATCH_WINDOW_MS,
} from '@happier-dev/protocol';
import { isRpcMethodNotFoundResult, RPC_METHODS } from '@happier-dev/protocol/rpc';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

import {
    type LocalServiceInventorySnapshotClientInput,
    type LocalServiceInventorySnapshotClientResult,
    type LocalServiceInventoryWatchClientInput,
    type LocalServiceInventoryWatchClientResult,
} from './api';

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
            method: input.refresh
                ? RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH
                : RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_SNAPSHOT,
            payload,
        });
        if (isRpcMethodNotFoundResult(raw)) {
            return { ok: false, reason: 'unavailable' };
        }
        const parsed = input.refresh
            ? DaemonLocalServiceInventoryRefreshResponseV1Schema.safeParse(raw)
            : DaemonLocalServiceInventorySnapshotResponseV1Schema.safeParse(raw);
        if (!parsed.success || parsed.data.snapshot.machineId !== input.machineId) {
            return { ok: false, reason: 'invalid_response' };
        }
        return { ok: true, snapshot: parsed.data.snapshot };
    } catch {
        return { ok: false, reason: 'request_failed' };
    }
}

/**
 * Park on the daemon's inventory change producer.
 *
 * The call deliberately outlives the default RPC budget: it is a long poll, so its timeout is the
 * daemon's park window plus a round-trip margin, mirroring the plugin-UI resource watch that
 * already runs this shape over the same transport. The server forwards a caller-requested timeout
 * up to its own maximum, so no server-side registration is required.
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
            ...(typeof input.sinceGeneratedAt === 'number'
                ? { sinceGeneratedAt: input.sinceGeneratedAt }
                : {}),
        });
        const raw = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId: input.machineId,
            serverId: input.serverId,
            method: RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH,
            payload,
            timeoutMs: LOCAL_SERVICE_INVENTORY_WATCH_WINDOW_MS + 10_000,
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
    } catch {
        return { ok: false, reason: 'request_failed' };
    }
}
