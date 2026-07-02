import { PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, type PeerTcpTunnelRelayEnvelope } from "@happier-dev/protocol";

import { getSocketRooms } from "@/app/api/socketRooms";
import type {
    PeerTcpTunnelRelayTransport,
    PeerTcpTunnelRelayTransportFactory,
} from "@/app/local/services/preview/tunnel";

type RelayBridgeIoTarget = Readonly<{
    emit(event: string, payload: unknown): unknown;
}>;

type RelayBridgeIo = Readonly<{
    to(room: string): RelayBridgeIoTarget;
}>;

type LocalRelayListener = (envelope: PeerTcpTunnelRelayEnvelope) => void;

export type PeerTcpTunnelRelayBridge = Readonly<{
    io: RelayBridgeIo;
    createTransport: PeerTcpTunnelRelayTransportFactory;
}>;

export function createPeerTcpTunnelRelayBridge(realIo: RelayBridgeIo): PeerTcpTunnelRelayBridge {
    const listenersByRoom = new Map<string, Set<LocalRelayListener>>();

    function publishLocal(room: string, event: string, payload: unknown): void {
        if (event !== PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT) return;
        const listeners = listenersByRoom.get(room);
        if (!listeners || listeners.size === 0) return;
        for (const listener of [...listeners]) {
            listener(payload as PeerTcpTunnelRelayEnvelope);
        }
    }

    function subscribe(room: string, listener: LocalRelayListener): () => void {
        let listeners = listenersByRoom.get(room);
        if (!listeners) {
            listeners = new Set();
            listenersByRoom.set(room, listeners);
        }
        listeners.add(listener);
        return () => {
            listeners?.delete(listener);
            if (listeners?.size === 0) listenersByRoom.delete(room);
        };
    }

    const bridgeIo: RelayBridgeIo = {
        to(room) {
            return {
                emit(event, payload) {
                    const result = realIo.to(room).emit(event, payload);
                    publishLocal(room, event, payload);
                    return result;
                },
            };
        },
    };

    function createTransport({ accountId }: Readonly<{ accountId: string }>): PeerTcpTunnelRelayTransport {
        const userRoom = getSocketRooms({
            userId: accountId,
            clientType: "user-scoped",
        })[0] ?? `user:${accountId}`;
        const unsubscribeCallbacks = new Set<() => void>();
        return {
            send(event, envelope) {
                const machineId = envelope.recipient.kind === "machine" ? envelope.recipient.machineId : null;
                if (!machineId) return;
                const machineRoom = getSocketRooms({
                    userId: accountId,
                    clientType: "machine-scoped",
                    machineId,
                })[0] ?? `machine:${machineId}:${accountId}`;
                bridgeIo.to(machineRoom).emit(event, envelope);
            },
            subscribe(listener) {
                const unsubscribe = subscribe(userRoom, listener);
                unsubscribeCallbacks.add(unsubscribe);
                return () => {
                    unsubscribeCallbacks.delete(unsubscribe);
                    unsubscribe();
                };
            },
            close() {
                for (const unsubscribe of [...unsubscribeCallbacks]) {
                    unsubscribe();
                }
                unsubscribeCallbacks.clear();
            },
        };
    }

    return {
        io: bridgeIo,
        createTransport,
    };
}
