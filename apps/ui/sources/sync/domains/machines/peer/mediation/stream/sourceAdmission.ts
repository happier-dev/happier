import { DaemonMachineLiveStreamSourceAdmitRequestV1Schema, DaemonMachineLiveStreamSourceAdmitResponseV1Schema,
    type DaemonMachineLiveStreamSourceAdmitResponseV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/relayStartRpcV1';
import { isRpcMethodNotFoundResult, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { isRpcError, readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { sessionRpcWithServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';

/** The installed source owner admits the acting viewer before the Home mints its relay grant. */
export async function requestMachineLiveStreamSourceAdmission(input: Readonly<{
    serverId: string;
    accountId: string;
    sessionId?: string;
    sourceMachineId: string;
    sourceId?: string;
    streamFamily: string;
    signal?: AbortSignal;
    timeoutMs?: number;
}>): Promise<DaemonMachineLiveStreamSourceAdmitResponseV1['result']> {
    const payload = DaemonMachineLiveStreamSourceAdmitRequestV1Schema.safeParse({
        protocolVersion: 1, machineId: input.sourceMachineId, sourceId: input.sourceId, streamFamily: input.streamFamily,
    });
    if (!payload.success) return { ok: false, reasonCode: 'capture_source_unavailable' };
    let raw: unknown;
    try {
        const request = { method: RPC_METHODS.DAEMON_MACHINE_LIVE_STREAM_SOURCE_ADMIT,
            payload: payload.data, signal: input.signal,
            ...(typeof input.timeoutMs === 'number' ? { timeoutMs: input.timeoutMs } : {}) };
        raw = input.sessionId
            ? await sessionRpcWithServerAccountScope<unknown, typeof payload.data>({ ...request, sessionId: input.sessionId,
                scope: { serverId: input.serverId, accountId: input.accountId } })
            : await machineRpcWithServerScope<unknown, typeof payload.data>({ ...request,
                machineId: input.sourceMachineId, serverId: input.serverId, accountId: input.accountId });
    } catch (error) {
        if (input.signal?.aborted) throw error;
        return { ok: false, reasonCode: readRpcErrorCode(error) ?? 'capture_source_unavailable',
            ...(isRpcError(error) && error.failureCause ? { failureCause: error.failureCause } : {}),
            ...(error && typeof error === 'object' && 'effectAttempted' in error && typeof error.effectAttempted === 'boolean'
                ? { effectAttempted: error.effectAttempted } : {}) };
    }
    if (isRpcMethodNotFoundResult(raw)) return { ok: false, reasonCode: 'capture_source_unavailable' };
    const parsed = DaemonMachineLiveStreamSourceAdmitResponseV1Schema.safeParse(raw);
    return parsed.success ? parsed.data.result : { ok: false, reasonCode: 'capture_source_unavailable' };
}
