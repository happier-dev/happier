import { randomUUID } from "node:crypto";

import { PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, type PeerTcpTunnelRelayEnvelope } from "@happier-dev/protocol";

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

    function createTransport(_input: Readonly<{ accountId: string }>): PeerTcpTunnelRelayTransport {
        const relaySocketId = `server_preview_relay_${randomUUID()}`;
        const unsubscribeCallbacks = new Set<() => void>();
        return {
            relaySocketId,
            send(event, envelope) {
                const recipient = envelope.recipient;
                if (recipient.kind === "machine") {
                    // Machine delivery is owned by the registered relay handler and its exact
                    // coordinator attachment. Falling back to a machine room here would bypass it.
                    return;
                }
                // User recipient: deliver to the exact viewer tab when its socket id is known,
                // never the whole-user broadcast room. A user recipient without a socket id is
                // dropped rather than over-broadcast (fail-closed; the prior code dropped ALL user
                // recipients, which silently starved per-tab delivery).
                if (recipient.socketId) {
                    bridgeIo.to(recipient.socketId).emit(event, envelope);
                }
            },
            subscribe(listener) {
                const unsubscribe = subscribe(relaySocketId, listener);
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
