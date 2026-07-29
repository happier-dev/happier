import {
    DaemonLocalServiceManagedSnapshotRequestV1Schema,
    DaemonLocalServiceManagedSnapshotResponseV1Schema,
} from '@happier-dev/protocol';
import {
    isRpcMethodNotFoundResult,
    RPC_ERROR_CODES,
    RPC_ERROR_MESSAGES,
    RPC_METHODS,
} from '@happier-dev/protocol/rpc';
import {
    isRpcMethodNotAvailableError,
    isRpcMethodNotFoundError,
} from '@happier-dev/protocol/rpcErrors';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

import {
    managedSnapshotFromProtocolSnapshot,
    type LocalServiceManagedSnapshotClientInput,
    type LocalServiceManagedSnapshotClientResult,
} from './api';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isRpcUnavailableResult(value: unknown): boolean {
    if (isRpcMethodNotFoundResult(value)) {
        return true;
    }
    if (!isRecord(value)) {
        return false;
    }
    return value.errorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
        || value.error === RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE;
}

export async function fetchLocalServiceManagedSnapshotViaMachineRpc(
    input: LocalServiceManagedSnapshotClientInput,
): Promise<LocalServiceManagedSnapshotClientResult> {
    if (input.signal?.aborted) {
        return { ok: false, reason: 'request_failed' };
    }
    try {
        const payload = DaemonLocalServiceManagedSnapshotRequestV1Schema.parse({
            machineId: input.machineId,
        });
        const raw = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId: payload.machineId,
            serverId: input.serverId,
            method: RPC_METHODS.DAEMON_LOCAL_SERVICES_MANAGED_SNAPSHOT,
            payload,
        });
        if (isRpcUnavailableResult(raw)) {
            return { ok: false, reason: 'unavailable' };
        }
        const parsed = DaemonLocalServiceManagedSnapshotResponseV1Schema.safeParse(raw);
        if (!parsed.success || parsed.data.snapshot.machineId !== payload.machineId) {
            return { ok: false, reason: 'invalid_response' };
        }
        return {
            ok: true,
            snapshot: managedSnapshotFromProtocolSnapshot(parsed.data.snapshot),
        };
    } catch (error) {
        if (isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error)) {
            return { ok: false, reason: 'unavailable' };
        }
        return { ok: false, reason: 'request_failed' };
    }
}
