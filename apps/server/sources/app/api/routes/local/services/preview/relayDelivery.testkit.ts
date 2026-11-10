import { EventEmitter } from 'node:events';
import type { Server, Socket } from 'socket.io';
import { decodePeerTcpTunnelBinaryFrameV2, encodePeerTcpTunnelBinaryFrameV2,
    PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, type PeerTcpTunnelRelayEnvelope } from '@happier-dev/protocol';
import { getSocketRooms } from '@/app/api/socketRooms';
import { createPeerTcpTunnelRelayBridge } from '@/app/api/socket/peer/mediation/tunnel/relayBridge';
import { createPeerTcpTunnelRelayCoordinator } from '@/app/api/socket/peer/mediation/tunnel/relayCoordinator';
import { registerPeerTcpTunnelRelaySocketHandler } from '@/app/api/socket/peer/mediation/tunnel/registerRelay';
import { resolvePeerMediationGrantSigningConfig } from '@/app/machines/peer/mediation/mintDirectRouteGrantV1';
import type { PeerTcpTunnelRelayTransportFactory } from '@/app/machines/peer/mediation/tunnel/peerRelayStreamTransport';

/** Socket.IO/remote WORKER are the network boundary. Home relay admission,
 * exact socket attachment, grant verification, bridge and byte stream stay real. */
export function createPreviewRelayDeliveryBoundary(input: Readonly<{
    env: NodeJS.ProcessEnv; machineId: string; custodianAccountId: string; installationId: string;
}>) {
    const requests: string[] = [];
    const machine = Object.assign(new EventEmitter(), {
        id: 'relay_worker_socket', connected: true,
        data: { userId: input.custodianAccountId, clientType: 'machine-scoped',
            machineId: input.machineId, verifiedMachineInstallationId: input.installationId },
        rooms: new Set(getSocketRooms({ userId: input.custodianAccountId, clientType: 'machine-scoped', machineId: input.machineId })),
    });
    const reply = new TextEncoder().encode('HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 24\r\n\r\n<html>guest bytes</html>');
    const replied = new Set<string>();
    const io = Object.assign(new EventEmitter(), {
        sockets: { sockets: new Map([[machine.id, machine as unknown as Socket]]),
            adapter: { rooms: new Map([...machine.rooms].map(room => [room, new Set([machine.id])])) } },
        to(room: string) {
            return { emit(event: string, envelope: PeerTcpTunnelRelayEnvelope) {
                if (room !== machine.id || event !== PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT || envelope.v !== 2) return;
                const decoded = decodePeerTcpTunnelBinaryFrameV2({ frame: envelope.frame, maxHeaderBytes: 65536, maxPayloadBytes: 65536 });
                if (!decoded.ok || decoded.header.kind !== 'data' || !decoded.header.substreamId) return;
                requests.push(new TextDecoder().decode(decoded.payload));
                const { tunnelId, substreamId } = decoded.header;
                if (replied.has(substreamId)) return;
                replied.add(substreamId);
                setImmediate(() => machine.emit(event, {
                    v: 2, scopeUserId: input.custodianAccountId,
                    sender: { kind: 'machine', machineId: input.machineId },
                    recipient: envelope.sender, encoding: 'binary_frame_v2',
                    frame: encodePeerTcpTunnelBinaryFrameV2({ header: { version: 2, kind: 'data', tunnelId,
                        substreamId, direction: 'daemon_to_client', sequence: 0, payloadLength: reply.byteLength }, payload: reply }),
                } satisfies PeerTcpTunnelRelayEnvelope));
            } };
        },
        local: { to: (room: string) => io.to(room) },
    });
    // Socket.IO inventory/remote bytes are represented above; the coordinator is never mocked.
    const coordinator = createPeerTcpTunnelRelayCoordinator({ io: io as unknown as Server, config: { mode: 'memory' } });
    const bridge = createPeerTcpTunnelRelayBridge(io);
    const signing = resolvePeerMediationGrantSigningConfig(input.env, Date.now());
    if (!signing.ok) throw new Error('Test signing configuration unavailable');
    const options = { io: bridge.io, coordinator, serverRoutedEnabled: true, allowedPorts: [5173, 45097],
        relayAuthorizationTrustRoots: [{ keyId: signing.keyId, publicKeyBase64Url: signing.capability.publicKey }],
    };
    registerPeerTcpTunnelRelaySocketHandler(input.custodianAccountId, machine, options);
    const createRelayTransport: PeerTcpTunnelRelayTransportFactory = ({ accountId }) => {
        const transport = bridge.createTransport({ accountId });
        let receive: ((value?: unknown) => void | Promise<void>) | undefined;
        let disconnect: (() => void | Promise<void>) | undefined;
        registerPeerTcpTunnelRelaySocketHandler(accountId, {
            id: transport.relaySocketId, data: { clientType: 'user-scoped' },
            on(event, handler) {
                if (event === PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT) receive = handler;
                if (event === 'disconnect') disconnect = handler;
            }, emit() {},
        }, options);
        return { ...transport,
            send(event, envelope) { if (event === PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT) void receive?.(envelope); },
            close() { void disconnect?.(); transport.close(); },
        };
    };
    return { createRelayTransport, requests, close: () => coordinator.close() };
}
