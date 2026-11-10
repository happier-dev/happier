import { DaemonMachineLiveStreamRelayStartRequestV1Schema, DaemonMachineLiveStreamRelayStartResponseV1Schema } from '@happier-dev/protocol/machines/peer/mediation/stream/relayStartRpcV1';
import type { MachineLiveStreamStartRequestV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { isRpcMethodNotFoundResult, RPC_METHODS } from '@happier-dev/protocol/rpc';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { sessionRpcWithServerAccountScope, sessionRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';

export type MachineLiveStreamRelayStartRpcResult = Readonly<
    | { ok: true; streamId: string }
    | { ok: false; reasonCode: string }
>;

/**
 * Deliver the server-minted, signed live-stream startRequest to the capture daemon over the
 * canonical machine-RPC channel (SIM-P0-1). The daemon's relay terminator starts capture and
 * echoes the start on its own machine-scoped socket, where the server verifies the Ed25519
 * relay authorization and creates the per-viewer relay state.
 */
export async function startMachineLiveStreamRelayViaMachineRpc(input: Readonly<{
    machineId: string;
    sessionId?: string;
    serverId?: string | null;
    startRequest: MachineLiveStreamStartRequestV1;
    timeoutMs?: number;
    signal?: AbortSignal;
}>): Promise<MachineLiveStreamRelayStartRpcResult> {
    try {
        const payload = DaemonMachineLiveStreamRelayStartRequestV1Schema.parse({
            protocolVersion: 1,
            machineId: input.machineId,
            startRequest: input.startRequest,
        });
        const accountId = payload.startRequest.authorization?.payload.v === 2
            ? payload.startRequest.authorization.payload.viewerAccountId : undefined;
        const request = {
            method: input.sessionId || payload.startRequest.authorization?.payload.v === 2
                ? RPC_METHODS.DAEMON_MACHINE_LIVE_STREAM_PERSONAL_RELAY_START : RPC_METHODS.DAEMON_LIVE_STREAM_RELAY_START,
            payload, signal: input.signal,
            ...(typeof input.timeoutMs === 'number' ? { timeoutMs: input.timeoutMs } : {}),
        };
        const raw = input.sessionId
            ? await (input.serverId && accountId
                ? sessionRpcWithServerAccountScope<unknown, typeof payload>({ ...request, sessionId: input.sessionId,
                    scope: { serverId: input.serverId, accountId } })
                : sessionRpcWithServerScope<unknown, typeof payload>({ ...request, sessionId: input.sessionId, serverId: input.serverId }))
            : await machineRpcWithServerScope<unknown, typeof payload>({ ...request, machineId: input.machineId,
                serverId: input.serverId, ...(accountId ? { accountId } : {}) });
        if (isRpcMethodNotFoundResult(raw)) {
            return { ok: false, reasonCode: 'live_stream_relay_start_unavailable' };
        }
        const parsed = DaemonMachineLiveStreamRelayStartResponseV1Schema.safeParse(raw);
        if (!parsed.success) {
            return { ok: false, reasonCode: 'live_stream_relay_start_invalid_response' };
        }
        return parsed.data.result;
    } catch {
        return { ok: false, reasonCode: 'live_stream_relay_start_failed' };
    }
}
