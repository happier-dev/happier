import { DaemonMachineLiveStreamRelayStartRequestV1Schema, DaemonMachineLiveStreamRelayStartResponseV1Schema } from '@happier-dev/protocol/machines/peer/mediation/stream/relayStartRpcV1';
import type { ActionExecutorContext, DaemonMachineLiveStreamRelayStartResponseV1, MachineLiveStreamStartRequestV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import type { RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';

/**
 * Viewer-triggered server-relay start (SIM-P0-1 fix). The relay socket handler only accepts
 * `start` envelopes from the SOURCE machine socket, so the viewer's server-minted, signed
 * startRequest is delivered here over the canonical machine-RPC channel; the relay terminator
 * starts capture and echoes the start on the daemon's machine-scoped socket, where the server
 * verifies the Ed25519 authorization and creates the relay state. Personal starts also bind the
 * verified RPC actor here; the relay terminator verifies their Home signature before capture.
 */
export type DaemonLiveStreamRelayRoutes = Readonly<{
    start: (startRequest: MachineLiveStreamStartRequestV1, callerAuthority?: ActionExecutorContext['authority']) => Promise<
        Readonly<{ ok: true; streamId: string } | { ok: false; reasonCode: string }>
    >;
}>;

export type DaemonLiveStreamRelayHandlerOptions = Readonly<{
    relay?: DaemonLiveStreamRelayRoutes | null;
}>;

export function registerDaemonLiveStreamRelayHandlers(
    rpc: RpcHandlerRegistrar,
    options: DaemonLiveStreamRelayHandlerOptions = {},
): void {
    for (const method of [RPC_METHODS.DAEMON_LIVE_STREAM_RELAY_START, RPC_METHODS.DAEMON_MACHINE_LIVE_STREAM_PERSONAL_RELAY_START]) {
        rpc.registerHandler(
            method,
            async (raw: unknown, context?: RpcHandlerContext): Promise<DaemonMachineLiveStreamRelayStartResponseV1> => {
                const request = DaemonMachineLiveStreamRelayStartRequestV1Schema.parse(raw);
                if (method === RPC_METHODS.DAEMON_MACHINE_LIVE_STREAM_PERSONAL_RELAY_START) {
                    const payload = request.startRequest.authorization?.payload;
                    const admission = context?.machineAdmission;
                    if (context?.callerAuthority !== 'present_user' || !admission || payload?.v !== 2
                        || payload.viewerAccountId !== admission.actorAccountId
                        || payload.accountId !== admission.custodianAccountId
                        || payload.sourceMachineId !== admission.machineId
                        || payload.sourceMachineInstallationId !== admission.installationId) {
                        return { protocolVersion: 1, result: { ok: false, reasonCode: 'capture_source_denied' } };
                    }
                }
                if (!options.relay) {
                    return DaemonMachineLiveStreamRelayStartResponseV1Schema.parse({
                        protocolVersion: 1,
                        result: { ok: false, reasonCode: 'live_stream_relay_unavailable' },
                    });
                }
                const started = await options.relay.start(request.startRequest, context?.callerAuthority ?? 'account_automation');
                return DaemonMachineLiveStreamRelayStartResponseV1Schema.parse({
                    protocolVersion: 1,
                    result: started.ok
                        ? { ok: true, streamId: started.streamId }
                        : { ok: false, reasonCode: started.reasonCode },
                });
            },
        );
    }
}
