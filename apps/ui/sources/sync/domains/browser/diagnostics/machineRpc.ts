import {
    DaemonBrowserDiagnosticsSnapshotRequestV1Schema,
    DaemonBrowserDiagnosticsSnapshotResponseV1Schema,
    type BrowserDiagnosticsSnapshotV1,
    type BrowserDiagnosticsRequestDetailV1,
} from '@happier-dev/protocol/browser/diagnostics/v1';
import { isRpcMethodNotFoundResult, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { projectMachineDaemonRpcFailure, type MachineDaemonRpcFailure } from '@/sync/domains/machines/machineDaemonRpcErrors';

import { callGuardedMachineRpcWithPolicy } from '@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc';

export type BrowserDiagnosticsSnapshotClientInput = Readonly<{
    machineId: string;
    serverId?: string | null;
    signal?: AbortSignal;
    view?: Readonly<{ browserSessionId: string; viewId: string; navigationGeneration: number }>;
    sinceRevision?: number;
    requestId?: string;
}>;

export type BrowserDiagnosticsSnapshotClientResult =
    | Readonly<{ ok: true; snapshot: BrowserDiagnosticsSnapshotV1; revision?: number; requestDetail?: BrowserDiagnosticsRequestDetailV1 }>
    | (Readonly<{ ok: false; reason: 'unavailable' | 'request_failed' | 'invalid_response' }>
        & Pick<MachineDaemonRpcFailure, 'errorCode' | 'failureCause' | 'details'>);

export async function fetchBrowserDiagnosticsSnapshotViaMachineRpc(
    input: BrowserDiagnosticsSnapshotClientInput,
): Promise<BrowserDiagnosticsSnapshotClientResult> {
    if (input.signal?.aborted) {
        return { ok: false, reason: 'request_failed' };
    }
    try {
        const payload = DaemonBrowserDiagnosticsSnapshotRequestV1Schema.parse({
            machineId: input.machineId,
            ...(input.view ? { view: input.view } : {}),
            ...(input.sinceRevision === undefined ? {} : { sinceRevision: input.sinceRevision }),
            ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
        });
        const raw = await callGuardedMachineRpcWithPolicy<unknown, typeof payload>({
            machineId: input.machineId,
            serverId: input.serverId ?? undefined,
            method: RPC_METHODS.DAEMON_BROWSER_DIAGNOSTICS_SNAPSHOT,
            payload,
            signal: input.signal,
            ...(input.sinceRevision === undefined ? {} : { operationTimeoutMs: null }),
        });
        if (isRpcMethodNotFoundResult(raw)) {
            return { ok: false, reason: 'unavailable' };
        }

        const parsed = DaemonBrowserDiagnosticsSnapshotResponseV1Schema.safeParse(raw);
        if (!parsed.success || parsed.data.snapshot.machineId !== input.machineId) {
            return { ok: false, reason: 'invalid_response' };
        }

        return { ok: true, snapshot: parsed.data.snapshot,
            ...(parsed.data.requestDetail === undefined ? {} : { requestDetail: parsed.data.requestDetail }),
            ...(parsed.data.revision === undefined ? {} : { revision: parsed.data.revision }) };
    } catch (error) {
        const failure = projectMachineDaemonRpcFailure(error);
        return { ...failure, reason: failure.reason === 'older_happier' ? 'unavailable' : 'request_failed' };
    }
}

export type BrowserDiagnosticsRequestDetailClientInput = BrowserDiagnosticsSnapshotClientInput & Readonly<{
    view: NonNullable<BrowserDiagnosticsSnapshotClientInput['view']>;
    requestId: string;
}>;
export type BrowserDiagnosticsRequestDetailClientResult =
    | Readonly<{ ok: true; detail: BrowserDiagnosticsRequestDetailV1 }>
    | Extract<BrowserDiagnosticsSnapshotClientResult, { ok: false }>;

export async function fetchBrowserDiagnosticsRequestDetailViaMachineRpc(
    input: BrowserDiagnosticsRequestDetailClientInput,
): Promise<BrowserDiagnosticsRequestDetailClientResult> {
    const result = await fetchBrowserDiagnosticsSnapshotViaMachineRpc(input);
    if (!result.ok) return result;
    if (!result.requestDetail || result.requestDetail.status === 'available' && result.requestDetail.requestId !== input.requestId) {
        return { ok: false, reason: 'invalid_response' };
    }
    return { ok: true, detail: result.requestDetail };
}
