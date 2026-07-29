import {
    MACHINE_LIVE_STREAM_SOCKET_EVENT,
    type MachineLiveStreamRelayEnvelopeV1,
} from '@happier-dev/protocol';

import { apiSocket } from '@/sync/api/session/apiSocket';

import { createServerScopedRelaySocket, type ServerScopedRelaySocket } from './serverScopedRelaySocket';

/**
 * Production live-stream relay transport. The shared server-scoped relay helper chooses
 * the active authenticated `apiSocket` or an ephemeral target-server socket; this binding
 * only supplies the live-stream envelope event and viewer metadata.
 */
export type ServerScopedMachineLiveStreamRelaySocket = Readonly<{
    scopeUserId: string;
    machineId: string;
    /**
     * The viewer's account/profile id. This is the watcher identity — NOT a machine id. The
     * previous relay surface mis-used `scopeUserId` as `targetMachineId`; callers must thread
     * this as the viewer id and never as a machine id (C4).
     */
    viewerId: string;
    /**
     * The per-tab socket id of THIS viewer connection. When present the server relay delivers
     * frames to exactly this tab via `io.to(socketId)`. If unavailable, the simulator product
     * path fails closed before opening the relay. May change across reconnects — read at
     * relay-open time.
     */
    socketId: string;
    sendEnvelope: (payload: MachineLiveStreamRelayEnvelopeV1) => void;
    onEnvelope: (listener: (payload: MachineLiveStreamRelayEnvelopeV1) => void) => () => void;
    disconnect: () => void;
}>;

export async function resolveServerScopedMachineLiveStreamRelaySocket(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    timeoutMs?: number;
}>): Promise<ServerScopedMachineLiveStreamRelaySocket> {
    const socket = await createServerScopedRelaySocket<MachineLiveStreamRelayEnvelopeV1>({
        machineId: params.machineId,
        serverId: params.serverId,
        timeoutMs: params.timeoutMs,
        missingScopeUserProfileErrorMessage: 'Active account profile id is unavailable for machine live-stream relay',
        getActiveSocketId: () => apiSocket.getSocketId(),
        createActiveTransport: {
            send: (payload) => {
                apiSocket.sendMachineLiveStreamRelayEnvelope(payload);
            },
            on: (listener) => apiSocket.onMachineLiveStreamRelayEnvelope(listener),
        },
        createScopedTransport: (scopedSocket) => ({
            send: (payload) => {
                scopedSocket.emit(MACHINE_LIVE_STREAM_SOCKET_EVENT, payload);
            },
            on: (listener) => {
                scopedSocket.on(MACHINE_LIVE_STREAM_SOCKET_EVENT, listener);
                return () => {
                    scopedSocket.off(MACHINE_LIVE_STREAM_SOCKET_EVENT, listener);
                };
            },
        }),
    }) as ServerScopedRelaySocket<MachineLiveStreamRelayEnvelopeV1>;

    return {
        scopeUserId: socket.scopeUserId,
        machineId: socket.machineId,
        viewerId: socket.scopeUserId,
        socketId: socket.socketId ?? '',
        sendEnvelope: socket.sendEnvelope,
        onEnvelope: socket.onEnvelope,
        disconnect: socket.disconnect,
    };
}
