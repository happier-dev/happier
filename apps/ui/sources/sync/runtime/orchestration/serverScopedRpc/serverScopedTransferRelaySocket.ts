import { TRANSFER_RELAY_V2_SOCKET_EVENT, type TransferRelayV2SendEnvelope } from '@happier-dev/protocol';

import { apiSocket } from '@/sync/api/session/apiSocket';
import { storage } from '@/sync/domains/state/storage';

import { createEphemeralServerSocketClient } from './createEphemeralServerSocketClient';
import { resolveServerScopedContext } from './resolveServerScopedContext';

export type ServerScopedTransferRelaySocket = Readonly<{
    scopeUserId: string;
    machineId: string;
    sendEnvelope: (payload: TransferRelayV2SendEnvelope) => void;
    onEnvelope: (listener: (payload: TransferRelayV2SendEnvelope) => void) => () => void;
    disconnect: () => void;
}>;

function readActiveProfileId(): string {
    const profileId = String(storage.getState().profile?.id ?? '').trim();
    if (!profileId) {
        throw new Error('Active account profile id is unavailable for transfer relay');
    }
    return profileId;
}

export async function resolveServerScopedTransferRelaySocket(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    timeoutMs?: number;
}>): Promise<ServerScopedTransferRelaySocket> {
    const context = await resolveServerScopedContext({
        machineId: params.machineId,
        serverId: params.serverId,
        timeoutMs: params.timeoutMs,
    });
    const scopeUserId = readActiveProfileId();

    if (context.scope === 'active') {
        return {
            scopeUserId,
            machineId: context.machineId,
            sendEnvelope: (payload) => {
                apiSocket.sendTransferRelayV2Envelope(payload);
            },
            onEnvelope: (listener) => apiSocket.onTransferRelayV2Envelope(listener),
            disconnect: () => {},
        };
    }

    const socket = await createEphemeralServerSocketClient({
        serverUrl: context.targetServerUrl,
        token: context.token,
        timeoutMs: context.timeoutMs,
    });

    return {
        scopeUserId,
        machineId: context.machineId,
        sendEnvelope: (payload) => {
            socket.emit(TRANSFER_RELAY_V2_SOCKET_EVENT, payload);
        },
        onEnvelope: (listener) => {
            socket.on(TRANSFER_RELAY_V2_SOCKET_EVENT, listener);
            return () => {
                socket.off(TRANSFER_RELAY_V2_SOCKET_EVENT, listener);
            };
        },
        disconnect: () => {
            socket.disconnect();
        },
    };
}
