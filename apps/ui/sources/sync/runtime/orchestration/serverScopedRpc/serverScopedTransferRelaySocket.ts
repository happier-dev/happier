import { TRANSFER_RELAY_V2_SOCKET_EVENT } from '@happier-dev/protocol/transfers/relay/v2/socketEvents';
import type { TransferRelayV2SendEnvelope } from '@happier-dev/protocol/transfers/relay/v2/transferRelayEnvelopeSchema';

import { apiSocket } from '@/sync/api/session/apiSocket';

import {
    createServerScopedRelaySocket,
    type ServerScopedRelaySocket,
} from './serverScopedRelaySocket';

export type ServerScopedTransferRelaySocket = Readonly<{
    scopeUserId: string;
    machineId: string;
    sendEnvelope: (payload: TransferRelayV2SendEnvelope) => void;
    onEnvelope: (listener: (payload: TransferRelayV2SendEnvelope) => void) => () => void;
    disconnect: () => Promise<void>;
}>;

export async function resolveServerScopedTransferRelaySocket(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    timeoutMs?: number;
}>): Promise<ServerScopedTransferRelaySocket> {
    const socket = await createServerScopedRelaySocket<TransferRelayV2SendEnvelope>({
        machineId: params.machineId,
        serverId: params.serverId,
        timeoutMs: params.timeoutMs,
        missingScopeUserProfileErrorMessage: 'Active account profile id is unavailable for transfer relay',
        createActiveTransport: {
            send: (payload) => {
                apiSocket.sendTransferRelayV2Envelope(payload);
            },
            on: (listener) => apiSocket.onTransferRelayV2Envelope(listener),
        },
        createScopedTransport: (scopedSocket) => ({
            send: (payload) => {
                scopedSocket.emit(TRANSFER_RELAY_V2_SOCKET_EVENT, payload);
            },
            on: (listener) => {
                scopedSocket.on(TRANSFER_RELAY_V2_SOCKET_EVENT, listener);
                return () => {
                    scopedSocket.off(TRANSFER_RELAY_V2_SOCKET_EVENT, listener);
                };
            },
        }),
    }) as ServerScopedTransferRelaySocket;

    return {
        scopeUserId: socket.scopeUserId,
        machineId: socket.machineId,
        sendEnvelope: socket.sendEnvelope,
        onEnvelope: socket.onEnvelope,
        disconnect: socket.disconnect,
    };
}
