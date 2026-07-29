import {
    DaemonBrowserDiagnosticsSnapshotRequestV1Schema,
    DaemonBrowserDiagnosticsSnapshotResponseV1Schema,
    type BrowserDiagnosticsSnapshotV1,
} from '@happier-dev/protocol';
import { isRpcMethodNotFoundResult, RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';

import { callGuardedMachineRpcWithPolicy } from '@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc';

export type BrowserDiagnosticsSnapshotClientInput = Readonly<{
    machineId: string;
    serverId?: string | null;
    signal?: AbortSignal;
}>;

export type BrowserDiagnosticsSnapshotClientResult =
    | Readonly<{ ok: true; snapshot: BrowserDiagnosticsSnapshotV1 }>
    | Readonly<{ ok: false; reason: 'unavailable' | 'request_failed' | 'invalid_response' }>;

function isRpcMethodNotFoundError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const carrier = error as { rpcErrorCode?: unknown };
    return carrier.rpcErrorCode === RPC_ERROR_CODES.METHOD_NOT_FOUND;
}

export async function fetchBrowserDiagnosticsSnapshotViaMachineRpc(
    input: BrowserDiagnosticsSnapshotClientInput,
): Promise<BrowserDiagnosticsSnapshotClientResult> {
    if (input.signal?.aborted) {
        return { ok: false, reason: 'request_failed' };
    }
    try {
        const payload = DaemonBrowserDiagnosticsSnapshotRequestV1Schema.parse({
            machineId: input.machineId,
        });
        const raw = await callGuardedMachineRpcWithPolicy<unknown, typeof payload>({
            machineId: input.machineId,
            serverId: input.serverId ?? undefined,
            method: RPC_METHODS.DAEMON_BROWSER_DIAGNOSTICS_SNAPSHOT,
            payload,
        });
        if (isRpcMethodNotFoundResult(raw)) {
            return { ok: false, reason: 'unavailable' };
        }

        const parsed = DaemonBrowserDiagnosticsSnapshotResponseV1Schema.safeParse(raw);
        if (!parsed.success || parsed.data.snapshot.machineId !== input.machineId) {
            return { ok: false, reason: 'invalid_response' };
        }

        return { ok: true, snapshot: parsed.data.snapshot };
    } catch (error) {
        if (isRpcMethodNotFoundError(error)) {
            return { ok: false, reason: 'unavailable' };
        }
        return { ok: false, reason: 'request_failed' };
    }
}
