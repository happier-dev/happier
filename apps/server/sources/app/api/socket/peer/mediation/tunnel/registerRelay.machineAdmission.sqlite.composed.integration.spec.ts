import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Server } from 'socket.io';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import {
    MACHINE_PLAIN_DATA_KEY_MARKER, PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2, PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
    createPeerTcpTunnelRelayAuthorizationSigningInputV2, decodeBase64, decodePeerTcpTunnelBinaryFrameV2,
    encodePeerTcpTunnelBinaryFrameV2, encodePlainMachineStoredContent,
    PeerTcpTunnelRelayEnvelopeSchema, type PeerTcpTunnelRelayEnvelope,
} from '@happier-dev/protocol';
import { db } from '@/storage/db';
import { resolveMachineAdmission } from '@/app/machines/machineAccess';
import { revokeMachineInTx } from '@/app/machines/machineMutations';
import { updateMachineInstallationIdentityInTx } from '@/app/machines/installationIdentityUpdate';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createFakeSocket, getSocketHandler } from '../../../../testkit/socketHarness';
import { createPeerTcpTunnelRelayCoordinator } from './relayCoordinator';
import { registerPeerTcpTunnelRelaySocketHandler } from './registerRelay';
import { openPeerTcpTunnelRelayStream } from '../../../../../../../../ui/sources/sync/domains/machines/peer/mediation/tunnel/relayStream';

describe('Tunnel current Machine admission (real SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-tunnel-machine-admission-' }); }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    it('delivers the real revoked-Machine OPEN denial to the UI carrier strict consumer', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: {
            id: randomUUID(), accountId: owner.id, installationId: randomUUID(), active: true, revokedAt: new Date(),
            metadata: encodePlainMachineStoredContent({ host: 'tunnel-host', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/tunnel', happyHomeDir: '/home/tunnel/.happier' }),
            dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
        } });
        const socket = createFakeSocket({ id: randomUUID(), data: { clientType: 'user-scoped' } });
        let receive: ((envelope: PeerTcpTunnelRelayEnvelope) => void) | null = null;
        const produced: PeerTcpTunnelRelayEnvelope[] = [];
        const to = (room: string) => ({ emit: (event: string, envelope: unknown) => {
            if (room !== socket.id || event !== PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT) return;
            const strict = PeerTcpTunnelRelayEnvelopeSchema.parse(envelope);
            produced.push(strict);
            receive?.(strict);
        } });
        const io = Object.assign(new EventEmitter(), { to, local: { to }, sockets: { sockets: new Map() } });
        const coordinator = createPeerTcpTunnelRelayCoordinator({ io: io as unknown as Server, config: { mode: 'memory' } });
        const key = tweetnacl.sign.keyPair();
        const tunnelId = randomUUID();
        const destination = { host: '127.0.0.1', port: 3000 };
        const payload = {
            v: 2 as const, grantId: randomUUID(), accountId: owner.id, targetMachineId: machine.id, flowKind: 'tcp_tunnel' as const,
            routeKind: 'server_relay' as const, tunnelId, relaySocketId: socket.id, destination, capProfileId: 'interactive',
            maxFrameBytes: 64 * 1024, iat: 900, exp: 61_000, aud: 'happier-tcp-tunnel-relay-authorization' as const,
        };
        registerPeerTcpTunnelRelaySocketHandler(owner.id, socket, {
            io, coordinator, nowMs: () => 1000, serverRoutedEnabled: true, allowedPorts: [3000],
            relayAuthorizationTrustRoots: [{ keyId: 'current-admission', publicKeyBase64Url: Buffer.from(key.publicKey).toString('base64url') }],
        });
        const send = getSocketHandler(socket, PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT);
        let pending: Promise<unknown> = Promise.resolve();
        const stream = await openPeerTcpTunnelRelayStream({
            scopeUserId: owner.id, relaySocketId: socket.id,
            open: { v: 1, kind: 'open', tunnelId, targetMachineId: machine.id, routeKind: 'server_relay', destination,
                selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2, relayAuthorization: { payload, signature: {
                    keyId: 'current-admission', alg: 'Ed25519',
                    valueBase64Url: Buffer.from(tweetnacl.sign.detached(new TextEncoder().encode(createPeerTcpTunnelRelayAuthorizationSigningInputV2(payload)), key.secretKey)).toString('base64url'),
                } } },
            send: (_event, envelope) => { pending = Promise.resolve(send(envelope)); },
            onEnvelope: handler => { receive = handler; return () => { receive = null; }; },
        });
        try {
            await pending;
            expect(produced).toMatchObject([{ v: 1, frame: { kind: 'abort', tunnelId, reasonCode: 'route_unavailable' } }]);
            const terminal: unknown[] = [];
            stream.onFrame(frame => terminal.push(frame));
            expect(terminal).toEqual([produced[0]!.frame]);
            expect(() => stream.sendFrame({ v: 1, kind: 'close', tunnelId, halfClose: false, reasonCode: 'closed' }))
                .toThrow(expect.objectContaining({ code: 'peer_tunnel_stream_closed' }));
        } finally {
            await stream.close();
            await getSocketHandler(socket, 'disconnect')();
            await coordinator.close();
        }
    });

    it.each(['revoke', 'installation-replacement'] as const)('closes the open tunnel at %s and does not forward the next data frame', async (transition) => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: {
            id: randomUUID(), accountId: owner.id, installationId: randomUUID(), active: true,
            metadata: encodePlainMachineStoredContent({ host: 'tunnel-host', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/tunnel', happyHomeDir: '/home/tunnel/.happier' }),
            dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
        } });
        // Socket.IO is the network boundary; admission and coordinator logic stay real.
        const machineEvents = new EventEmitter();
        const machineSocket = Object.assign(machineEvents, {
            id: randomUUID(), connected: true, data: { userId: owner.id, clientType: 'machine-scoped', machineId: machine.id, verifiedMachineInstallationId: machine.installationId },
            rooms: new Set([`machine:${machine.id}:${owner.id}`]),
        });
        const forwarded: unknown[] = [];
        const to = (_room: string) => ({ emit: (_event: string, envelope: unknown) => { forwarded.push(envelope); } });
        const io = Object.assign(new EventEmitter(), { to, local: { to }, sockets: {
            sockets: new Map([[machineSocket.id, machineSocket]]),
            adapter: { rooms: new Map([...machineSocket.rooms].map(room => [room, new Set([machineSocket.id])])) },
        } });
        const coordinator = createPeerTcpTunnelRelayCoordinator({ io: io as unknown as Server, config: { mode: 'memory' } });
        const socket = createFakeSocket({ id: randomUUID(), data: { clientType: 'user-scoped' } });
        const key = tweetnacl.sign.keyPair();
        const tunnelId = randomUUID();
        const destination = { host: '127.0.0.1', port: 3000 };
        const payload = {
            v: 2 as const, grantId: randomUUID(), accountId: owner.id, targetMachineId: machine.id, flowKind: 'tcp_tunnel' as const,
            routeKind: 'server_relay' as const, tunnelId, relaySocketId: socket.id, destination, capProfileId: 'interactive',
            maxFrameBytes: 64 * 1024, iat: 900, exp: 61_000, aud: 'happier-tcp-tunnel-relay-authorization' as const,
        };
        const relayAuthorization = { payload, signature: {
            keyId: 'current-admission', alg: 'Ed25519' as const,
            valueBase64Url: Buffer.from(tweetnacl.sign.detached(new TextEncoder().encode(createPeerTcpTunnelRelayAuthorizationSigningInputV2(payload)), key.secretKey)).toString('base64url'),
        } };
        registerPeerTcpTunnelRelaySocketHandler(owner.id, socket, {
            io, coordinator, nowMs: () => 1000, serverRoutedEnabled: true, allowedPorts: [3000],
            relayAuthorizationTrustRoots: [{ keyId: 'current-admission', publicKeyBase64Url: Buffer.from(key.publicKey).toString('base64url') }],
            readMachineAdmission: (machineId) => resolveMachineAdmission({ actorAccountId: owner.id, machineId }),
        });
        const send = getSocketHandler(socket, PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT);
        const envelope = { scopeUserId: owner.id, sender: { kind: 'user' as const, socketId: socket.id }, recipient: { kind: 'machine' as const, machineId: machine.id } };
        const data = (sequence: number) => ({ ...envelope, v: 2, encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
            frame: encodePeerTcpTunnelBinaryFrameV2({ header: {
                version: 2, kind: 'data', tunnelId, direction: 'client_to_daemon', sequence, payloadLength: 3,
            }, payload: new TextEncoder().encode('abc') }),
        });
        const forwardedData = () => forwarded.filter((value) => {
            if (!value || typeof value !== 'object' || !('frame' in value) || !(value.frame instanceof Uint8Array)) return false;
            const decoded = decodePeerTcpTunnelBinaryFrameV2({ frame: value.frame, maxHeaderBytes: 1024, maxPayloadBytes: 64 * 1024 });
            return decoded.ok && decoded.header.kind === 'data';
        });
        try {
            await send({ ...envelope, v: 1, frame: { v: 1, kind: 'open', open: {
                v: 1, kind: 'open', tunnelId, targetMachineId: machine.id, routeKind: 'server_relay', destination, relayAuthorization,
            } } });
            await send(data(0));
            expect(forwardedData()).toHaveLength(1);
            forwarded.length = 0;
            // Losses arrive through their canonical owners, which publish the withdrawal after commit.
            if (transition === 'revoke') await inTx(tx => revokeMachineInTx(tx, { accountId: owner.id, machineId: machine.id }));
            else await inTx(tx => updateMachineInstallationIdentityInTx(tx, machine, { installationId: randomUUID() }));
            expect(forwarded).toContainEqual(expect.objectContaining({
                v: 1, frame: expect.objectContaining({ kind: 'abort', tunnelId, reasonCode: 'route_unavailable' }),
            }));
            await send(data(1));
            expect(forwardedData()).toHaveLength(0);
        } finally {
            await getSocketHandler(socket, 'disconnect')();
            await coordinator.close();
        }
    });
});
