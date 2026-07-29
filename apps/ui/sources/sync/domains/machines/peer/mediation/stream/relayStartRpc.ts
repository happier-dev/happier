import {
    DaemonMachineLiveStreamRelayStartRequestV1Schema,
    DaemonMachineLiveStreamRelayStartResponseV1Schema,
    type MachineLiveStreamStartRequestV1,
} from '@happier-dev/protocol';
import { isRpcMethodNotFoundResult, RPC_METHODS } from '@happier-dev/protocol/rpc';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

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
    serverId?: string | null;
    startRequest: MachineLiveStreamStartRequestV1;
    timeoutMs?: number;
}>): Promise<MachineLiveStreamRelayStartRpcResult> {
    try {
        const payload = DaemonMachineLiveStreamRelayStartRequestV1Schema.parse({
            protocolVersion: 1,
            machineId: input.machineId,
            startRequest: input.startRequest,
        });
        const raw = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId: input.machineId,
            serverId: input.serverId,
            method: RPC_METHODS.DAEMON_LIVE_STREAM_RELAY_START,
            payload,
            ...(typeof input.timeoutMs === 'number' ? { timeoutMs: input.timeoutMs } : {}),
        });
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
