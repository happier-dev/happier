import {
    DaemonMachineLiveStreamRelayStartRequestV1Schema,
    DaemonMachineLiveStreamRelayStartResponseV1Schema,
    type DaemonMachineLiveStreamRelayStartResponseV1,
    type MachineLiveStreamStartRequestV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';

/**
 * Viewer-triggered server-relay start (SIM-P0-1 fix). The relay socket handler only accepts
 * `start` envelopes from the SOURCE machine socket, so the viewer's server-minted, signed
 * startRequest is delivered here over the canonical machine-RPC channel; the relay terminator
 * starts capture and echoes the start on the daemon's machine-scoped socket, where the server
 * verifies the Ed25519 authorization and creates the relay state. The daemon never trusts the
 * request beyond schema shape + the terminator's own source-machine/route checks — signature
 * verification stays server-owned.
 */
export type DaemonLiveStreamRelayRoutes = Readonly<{
    start: (startRequest: MachineLiveStreamStartRequestV1) => Promise<
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
    rpc.registerHandler(
        RPC_METHODS.DAEMON_LIVE_STREAM_RELAY_START,
        async (raw: unknown): Promise<DaemonMachineLiveStreamRelayStartResponseV1> => {
            const request = DaemonMachineLiveStreamRelayStartRequestV1Schema.parse(raw);
            if (!options.relay) {
                return DaemonMachineLiveStreamRelayStartResponseV1Schema.parse({
                    protocolVersion: 1,
                    result: { ok: false, reasonCode: 'live_stream_relay_unavailable' },
                });
            }
            const started = await options.relay.start(request.startRequest);
            return DaemonMachineLiveStreamRelayStartResponseV1Schema.parse({
                protocolVersion: 1,
                result: started.ok
                    ? { ok: true, streamId: started.streamId }
                    : { ok: false, reasonCode: started.reasonCode },
            });
        },
    );
}
