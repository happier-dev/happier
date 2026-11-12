import { io, type Socket } from 'socket.io-client';
import { Server } from 'socket.io';
import { encodeBase64 } from '@happier-dev/protocol';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { buildMachineScopedSocketAuth } from '@happier-dev/protocol/machines/ownership/daemonOwnership';
import { CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    buildAccountStoredContentCompatibilitySocketAuthV1 } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import type { Fastify } from '@/app/api/types';
import { startSocket } from '@/app/api/socket';
import { getMachineSocketRoom } from '@/app/api/socketRooms';
import { initiateShutdown } from '@/utils/process/shutdown';

/** Real daemon sockets, shared by the Home-open preflight and carrier journey. */
export function startTeamCredentialActionSocketPresence(app: Fastify) {
    startSocket(app);
    const server = app.machineDaemonPresence;
    if (!(server instanceof Server)) throw new Error('Real Home Socket.IO presence unavailable');
    const clients: Socket[] = [];
    return {
        async connect(input: Readonly<{ baseUrl: string; token: string; accountId: string; machineId: string;
            installationId: string; keys: Readonly<{ publicKey: Uint8Array; secretKey: Uint8Array }> }>) {
            const room = getMachineSocketRoom(input.accountId, input.machineId);
            const client = io(input.baseUrl, { path: '/v1/updates', transports: ['websocket'],
                autoConnect: false, reconnection: false,
                auth: { ...buildAccountStoredContentCompatibilitySocketAuthV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION),
                    ...buildMachineScopedSocketAuth({ token: input.token, machineId: input.machineId,
                    installationId: input.installationId, installationPublicKey: encodeBase64(input.keys.publicKey, 'base64url'),
                    installationProof: signMachineInstallationProof({ privateKey: input.keys.secretKey,
                        payload: { version: 1, installationId: input.installationId, machineId: input.machineId,
                            accountId: input.accountId } }) }) } });
            clients.push(client);
            await new Promise<void>((resolve, reject) => {
                let joined = false;
                let connected = false;
                const cleanup = () => { server.sockets.adapter.off('join-room', onJoin); client.off('connect_error', onError); };
                const complete = () => { if (joined && connected) { cleanup(); resolve(); } };
                const onJoin = (joinedRoom: string) => { if (joinedRoom === room) { joined = true; complete(); } };
                const onError = (error: Error) => { cleanup(); reject(error); };
                server.sockets.adapter.on('join-room', onJoin);
                client.once('connect_error', onError);
                client.once('connect', () => { connected = true; complete(); });
                client.connect();
            });
            return client;
        },
        async close() {
            for (const client of clients) client.disconnect();
            app.server.closeAllConnections();
            await initiateShutdown('team-credential-action-socket-fixture');
        },
    };
}
