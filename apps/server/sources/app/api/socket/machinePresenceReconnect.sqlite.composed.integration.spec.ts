import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Server } from 'socket.io';
import { decodeBase64, encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { callSocketRpc } from '@happier-dev/sync-client';
import { auth } from '@/app/auth/auth';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { startSocket } from '@/app/api/socket';
import { registerAuthPingRoute } from '@/app/api/routes/auth/registerAuthPingRoute';
import { registerAccountEncryptionRoutes } from '@/app/api/routes/account/registerAccountEncryptionRoutes';
import { registerAccountProfileRoute } from '@/app/api/routes/account/registerAccountProfileRoute';
import { featuresRoutes } from '@/app/api/routes/features/featuresRoutes';
import { classifyMachineDaemonPresence, getMachineDaemonPresenceInventory } from '@/app/machines/machineDaemonPresence';
import { stopLocalMachinePresenceTimeout } from '@/app/presence/timeout';
import { machinesRoutes } from '@/app/api/routes/machines/machinesRoutes';
import { ApiClient } from '../../../../../cli/src/api/api';
import { readOrCreateInstallationIdentity } from '../../../../../cli/src/daemon/identity/store';
import { activateSessionsRoleForMachineClient } from '../../../../../cli/src/daemon/testkit/sessionsRole.testkit';
import { withConfiguredDaemonTestHome } from '../../../../../cli/src/daemon/testkit/fakeDaemonLifecycle.testkit';
import { withUserScopedRpcSocket } from '../../../../../cli/src/session/transport/rpc/withUserScopedRpcSocket';
import { runWithServerHttpBaseUrl } from '../../../../../cli/src/api/client/serverHttpBaseUrl';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';

describe('Machine presence and RPCs after reconnect (real SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: 'machine-presence-negotiation-',
            initAuth: true,
            env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' },
        });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it('restores Home presence and RPCs after a socket drop and a transient Machine snapshot failure', async () => {
        await withConfiguredDaemonTestHome({ prefix: 'machine-presence-reconnect-',
            env: { HAPPY_ENABLE_V2_CHANGES: 'false', HAPPIER_SOCKET_TRANSPORTS: 'websocket' } }, async () => {
            const account = await db.account.create({ data: { encryptionMode: 'plain' } });
            const installation = await readOrCreateInstallationIdentity();
            const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id,
                installationId: installation.installationId, installationPublicKey: Uint8Array.from(decodeBase64(installation.publicKey, 'base64url')), active: false,
                metadata: encodePlainMachineStoredContent({ host: 'reconnect-fixture', platform: 'linux',
                    happyCliVersion: 'test', homeDir: '/home/fixture', happyHomeDir: '/home/fixture/.happier' }),
                dataEncryptionKey: Uint8Array.from(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER)),
            } });
            const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
            const app = createAuthenticatedTestApp({ authentication: 'real' });
            let failNextSnapshot = false;
            let snapshotFailures = 0;
            app.addHook('onRequest', async (request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
                if (failNextSnapshot && request.method === 'GET' && request.url === `/v1/machines/${machine.id}`) {
                    failNextSnapshot = false;
                    snapshotFailures++;
                    return reply.code(503).send({ error: 'fixture-snapshot-unavailable' });
                }
            });
            registerAuthPingRoute(app);
            registerAccountProfileRoute(app);
            registerAccountEncryptionRoutes(app);
            featuresRoutes(app);
            machinesRoutes(app);
            const closeSockets = startSocket(app);
            const io = app.machineDaemonPresence;
            if (!(io instanceof Server)) throw new Error('Expected the Home Socket.IO server');
            const socketIds: string[] = [];
            io.on('connection', socket => {
                if (socket.data.machineId === machine.id) socketIds.push(socket.id);
            });
            const origin = await app.listen({ port: 0, host: '127.0.0.1' });
            const api = await runWithServerHttpBaseUrl(origin, () => ApiClient.create({ token, encryption: null }));
            const readMachine = () => runWithServerHttpBaseUrl(origin, () => api.getMachine(machine.id));
            const opened = await readMachine();
            if (!opened) throw new Error('Machine snapshot fixture was not readable');
            const client = await runWithServerHttpBaseUrl(origin, () => api.machineSyncClient(opened));
            const registration = client.setRPCHandlers({
                spawnSession: async () => { throw new Error('Unexpected Session spawn'); },
                stopSession: async () => false,
                requestShutdown() {},
            });
            const roles = await activateSessionsRoleForMachineClient(client, registration);
            const method = RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V2_GET;
            const call = () => withUserScopedRpcSocket({ token, serverUrl: origin, connectTimeoutMs: 5_000,
                disconnectMessage: 'Home test caller disconnected' }, async (socket, ready) => {
                await ready();
                return await callSocketRpc({ socket, target: { kind: 'machine', id: machine.id },
                    method, params: {}, content: { mode: 'plain' }, timeoutMs: 2_000 });
            });
            const readPresence = async () => classifyMachineDaemonPresence(
                await getMachineDaemonPresenceInventory({ accountId: account.id, io, machineIds: [machine.id] }), machine.id);
            try {
                runWithServerHttpBaseUrl(origin, () => client.connect());
                await vi.waitFor(() => expect(client.isMachineControlRegistrationReady()).toBe(true), { timeout: 8_000 });
                expect(await readPresence()).toBe('connected');
                expect((await readMachine())?.active).toBe(true);
                const before = await call();
                expect(before).toMatchObject({ ok: false, errorCode: 'handoff_update_required' });

                failNextSnapshot = true;
                io.sockets.sockets.get(socketIds[0]!)!.conn.close();
                await vi.waitFor(() => expect(socketIds).toHaveLength(2), { timeout: 8_000 });
                expect(socketIds[1]).not.toBe(socketIds[0]);
                await vi.waitFor(() => expect(snapshotFailures).toBe(1));
                expect(await readPresence()).toBe('connected');
                await vi.waitFor(() => expect(client.isMachineControlRegistrationReady()).toBe(true), { timeout: 8_000 });
                expect((await readMachine())?.active).toBe(true);
                expect(await call()).toEqual(before);
            } finally {
                await roles.stop();
                await client.shutdown();
                await closeSockets();
                await stopLocalMachinePresenceTimeout();
                await app.close();
            }
        });
    });
});
