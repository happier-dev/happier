import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import Fastify from 'fastify';
import { io, type Socket } from 'socket.io-client';
import { callSocketRpc } from '@happier-dev/sync-client';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { ExternalActionDaemonDispatchRequestSchema, EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1 } from '@happier-dev/protocol/actions/externalActionApi';
import { OpenProjectInputV1Schema, OpenProjectResultV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { ProjectAccountRowListResponseV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { Fastify as AppFastify } from '../../../../../server/sources/app/api/types';
import { createLightSqliteHarness, type LightSqliteHarness } from '../../../../../server/sources/testkit/lightSqliteHarness';
import { enableSchemaValidation } from '../../../../../server/sources/app/api/utils/enableSchemaValidation';
import { enableErrorHandlers } from '../../../../../server/sources/app/api/utils/enableErrorHandlers';
import { enableAuthentication } from '../../../../../server/sources/app/api/utils/enableAuthentication';
import { enableMonitoring } from '../../../../../server/sources/app/api/utils/enableMonitoring';
import { enableOptionalStatics } from '../../../../../server/sources/app/api/utils/enableOptionalStatics';
import { currentAccountStoredContentCompatibilitySocketAuth } from '../../../../../server/sources/app/api/testkit/accountStoredContentCompatibility';
import { registerAuthPingRoute } from '../../../../../server/sources/app/api/routes/auth/registerAuthPingRoute';
import { registerAccountApiTokenManagementRoutes } from '../../../../../server/sources/app/api/routes/auth/registerAccountApiTokenManagementRoutes';
import { registerAccountSecurityRoutes } from '../../../../../server/sources/app/api/routes/auth/registerAccountSecurityRoutes';
import { accountRoutes } from '../../../../../server/sources/app/api/routes/account/accountRoutes';
import { machinesRoutes } from '../../../../../server/sources/app/api/routes/machines/machinesRoutes';
import { featuresRoutes } from '../../../../../server/sources/app/api/routes/features/featuresRoutes';
import { registerExternalActionRoutes } from '../../../../../server/sources/app/api/routes/actions/registerExternalActionRoutes';
import { startSocket } from '../../../../../server/sources/app/api/socket';
import { auth } from '../../../../../server/sources/app/auth/auth';
import { db } from '../../../../../server/sources/storage/db';
import { getOrCreateServerIdentityId, initializeServerIdentityCache } from '../../../../../server/sources/app/serverIdentity/serverIdentity';
import { resolveMachineAdmission } from '../../../../../server/sources/app/machines/machineAccess';
import { ApiClient } from '../../../../../cli/src/api/api';
import { dispatchOriginalAccountAction } from '../../../../../cli/src/api/externalActionExecutionAuthorization';
import type { ApiMachineClient } from '../../../../../cli/src/api/apiMachine';
import { createCurrentMachineExecutionOriginContextResolver } from '../../../../../cli/src/api/machine/resolveCurrentMachineExecutionOriginContext';
import { runWithServerHttpBaseUrl } from '../../../../../cli/src/api/client/serverHttpBaseUrl';
import { createRequesterSessionControlRuntimeFixture } from '../../../../../cli/src/daemon/testkit/requesterSessionControlRuntimeFixture';
import { ConnectedServiceRuntimeRegistry } from '../../../../../cli/src/daemon/connectedServices/runtimeRegistry/registry';
import { configuration, reloadConfiguration } from '../../../../../cli/src/configuration';
import { updateSettings, writeCredentialsTokenOnlyForServerId } from '../../../../../cli/src/persistence';
import { createEnvKeyScope } from '../../../../../cli/src/testkit/env/envScope';
import { withdrawActiveProjectAccountRowsSnapshot } from '../../../../../cli/src/workspaces/projectAccountRows';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { removeServerProfile, setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { createDefaultActionExecutor } from './defaultActionExecutor';

describe('recipient Project Open through the real UI, Home, installed daemon and Account rows', () => {
    let database: LightSqliteHarness;
    let app: AppFastify;
    let endpoint: string;
    beforeAll(async () => {
        database = await createLightSqliteHarness({ tempDirPrefix: 'happier-recipient-project-', initAuth: true, initEncrypt: true,
            env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', AUTH_REQUIRED_LOGIN_PROVIDERS: '' } });
        await initializeServerIdentityCache();
        app = Fastify({ logger: false }) as unknown as AppFastify;
        enableSchemaValidation(app); enableErrorHandlers(app); enableAuthentication(app); enableMonitoring(app); enableOptionalStatics(app);
        registerAuthPingRoute(app); registerAccountApiTokenManagementRoutes(app); registerAccountSecurityRoutes(app);
        accountRoutes(app); machinesRoutes(app); featuresRoutes(app);
        startSocket(app); registerExternalActionRoutes(app);
        endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
    }, 180_000);
    afterAll(async () => { await app?.close(); await database?.close(); });

    it('opens an existing shared-Machine folder into the recipient Account while outsider, revocation and raw forwarding stay refused', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const requester = await db.account.create({ data: { encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        const ownerToken = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const requesterToken = await auth.createToken(requester.id, undefined, { kind: 'account', authority: 'present_user' });
        const outsiderToken = await auth.createToken(outsider.id, undefined, { kind: 'account', authority: 'present_user' });
        const installationId = crypto.randomUUID();
        const homeId = await getOrCreateServerIdentityId();
        const root = join(database.baseDir, 'existing-project');
        await mkdir(root);
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id, active: true,
            installationId,
            metadata: encodePlainMachineStoredContent({ host: 'recipient-project', platform: 'linux', happyCliVersion: '0.3',
                homeDir: database.baseDir, happyHomeDir: database.baseDir }),
            dataEncryptionKey: Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64') } });
        await db.machineAccountGrant.create({ data: { machineId: machine.id, accountId: requester.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        expect(await resolveMachineAdmission({ actorAccountId: requester.id, machineId: machine.id, actionId: 'projects.open' }))
            .toMatchObject({ kind: 'admitted', role: 'use' });

        const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID']);
        env.patch({ HAPPIER_HOME_DIR: join(database.baseDir, 'daemon'), HAPPIER_ACTIVE_SERVER_ID: homeId });
        reloadConfiguration();
        let apiMachine: ApiMachineClient | null = null;
        let daemon: Awaited<ReturnType<typeof createRequesterSessionControlRuntimeFixture>> | null = null;
        onTestFinished(async () => {
            try { await apiMachine?.shutdown(); await daemon?.dispose(); }
            finally { withdrawActiveProjectAccountRowsSnapshot(); env.restore(); reloadConfiguration(); }
        });
        await updateSettings(settings => ({ ...settings, activeServerId: homeId, servers: { ...settings.servers,
            [homeId]: { id: homeId, name: 'Project Home', serverUrl: endpoint, webappUrl: endpoint,
                createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact',
                homeConnectionDescriptor: HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: homeId,
                    canonicalServerUrl: endpoint, revision: 1, endpoints: [{ kind: 'https', url: endpoint }] }) } } }));
        const ownerCredentials = { token: ownerToken, encryption: null };
        daemon = await createRequesterSessionControlRuntimeFixture({ happyHomeDir: configuration.happyHomeDir,
            activeServerDir: configuration.activeServerDir, serverId: homeId, serverHttpBaseUrl: endpoint,
            machineId: machine.id, custodianAccountId: owner.id, credentials: ownerCredentials,
            connectedServicesMaterializationBaseDir: join(database.baseDir, 'connected-services'),
            registry: new ConnectedServiceRuntimeRegistry(), trackedSessions: new Map(), getRequester: () => null,
            getApiMachineForSessions: () => apiMachine,
            resolveQualifiedConnectedAccountV4Support: () => 'advertised',
            startup: { resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({
                serverUrl: endpoint, resolveCurrentMachineId: () => machine.id }) },
        });
        const runtime = daemon.runtime;
        if (!daemon.installation || !runtime?.externalActionIngressOwner) throw new Error('Installed Action owner is unavailable');
        await db.machine.update({ where: { id: machine.id }, data: { installationId: daemon.installation.installationId,
            installationPublicKey: new Uint8Array(decodeBase64(daemon.installation.publicKey, 'base64url')) } });
        await writeCredentialsTokenOnlyForServerId(homeId, { token: ownerToken });
        const ownerApi = await runWithServerHttpBaseUrl(endpoint, () => ApiClient.create(ownerCredentials));
        const publishedMachine = await runWithServerHttpBaseUrl(endpoint, () => ownerApi.getMachine(machine.id));
        if (!publishedMachine) throw new Error('Published Machine is unavailable');
        apiMachine = await runWithServerHttpBaseUrl(endpoint, () => ownerApi.machineSyncClient(publishedMachine));
        const installedApiMachine = apiMachine;
        await runWithServerHttpBaseUrl(endpoint, async () => installedApiMachine.setRPCHandlers({
            spawnSession: runtime.spawnSession, stopSession: runtime.stopSession,
            isSessionActive: runtime.isSessionAlreadyRunning,
            requestShutdown: () => { throw new Error('Unexpected daemon shutdown'); },
        }, { currentMachineId: machine.id, currentServerId: homeId, workingDirectory: root,
            externalActionIngressOwner: runtime.externalActionIngressOwner }));
        const receipts: string[] = [];
        const carriedRequests: ReturnType<typeof ExternalActionDaemonDispatchRequestSchema.parse>[] = [];
        await runWithServerHttpBaseUrl(endpoint, () => new Promise<void>(resolve => installedApiMachine.connect({ onConnect: resolve })));
        await vi.waitFor(async () => {
            const ready = await runWithServerHttpBaseUrl(endpoint, () => ownerApi.getMachine(machine.id));
            expect(ready?.daemonState?.status).toBe('running');
        }, { timeout: 180_000 });
        // Observe the real connected Socket.IO boundary; its installed request
        // listener and registration owner dispatch unchanged.
        const daemonSocket = Reflect.get(installedApiMachine, 'socket') as Socket;
        if (!daemonSocket?.connected) throw new Error('Installed Machine socket is not connected');
        daemonSocket.on(SOCKET_RPC_EVENTS.REQUEST, (request: SocketRpcRequestPayload) => {
            const method = request.method.slice(machine.id.length + 1);
            receipts.push(method);
            if (method === EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1) {
                carriedRequests.push(ExternalActionDaemonDispatchRequestSchema.parse(request.params));
            }
        });
        const homes = await serveActionHomes({ homes: [{ key: 'home', serverUrl: endpoint, accountId: requester.id, currentAccount: true }],
            route: async request => {
                const method = request.method;
                if (method !== 'GET' && method !== 'POST' && method !== 'PUT' && method !== 'PATCH'
                    && method !== 'DELETE' && method !== 'HEAD' && method !== 'OPTIONS') {
                    throw new Error(`Unsupported Home HTTP method: ${method}`);
                }
                const response = await app.inject({ method, url: request.url.pathname + request.url.search,
                    headers: Object.fromEntries(request.headers), ...(request.body === undefined ? {} : { payload: JSON.stringify(request.body) }) });
                return new Response(response.body, { status: response.statusCode, headers: { 'Content-Type': 'application/json' } });
            } });
        const profile = await setServerProfileIdentityForUrl(endpoint, homeId);
        if (!profile) throw new Error('Home identity was not learned');
        const credentials = await TokenStorage.setCredentialsForServerUrlWithRollback(endpoint, { serverId: profile.id }, { token: requesterToken });
        if (!credentials) throw new Error('Requester credentials unavailable');
        onTestFinished(async () => { expect(await credentials.rollback()).toBe(true); await homes.dispose(); await removeServerProfile(profile.id); });
        const input = OpenProjectInputV1Schema.parse({ serverId: homeId, machineId: machine.id,
            source: { kind: 'folder', path: root }, materialization: { kind: 'attach' } });
        const result = await createDefaultActionExecutor().execute('projects.open', input, {
            serverId: profile.id, expectedAccountId: requester.id, surface: 'ui', authority: 'present_user', actionRequestId: crypto.randomUUID(),
        });
        expect(result, JSON.stringify({ result, receipts })).toMatchObject({ ok: true, result: { kind: 'opened', directory: root } });
        expect(carriedRequests).toHaveLength(1);
        expect(carriedRequests[0]).toMatchObject({ actionId: 'projects.open', principal: { accountId: requester.id }, envelope: { v: 1 } });
        if (carriedRequests[0]!.envelope.v === 1) expect(OpenProjectInputV1Schema.parse(carriedRequests[0]!.envelope.input).source)
            .toEqual({ kind: 'folder', path: root });
        if (!result.ok) throw new Error(result.errorCode);
        const opened = OpenProjectResultV1Schema.parse(result.result);
        if (opened.kind !== 'opened') throw new Error('Project was not opened');
        expect(opened.workspace).toMatchObject({ serverId: homeId, machineId: machine.id, rootPath: root });
        const readRows = async (token: string) => {
            const response = await app.inject({ method: 'POST', url: '/v1/account/project-rows/list',
                headers: { authorization: `Bearer ${token}` }, payload: {} });
            expect(response.statusCode).toBe(200);
            const rows = ProjectAccountRowListResponseV1Schema.parse(response.json());
            if (rows.status !== 'listed') throw new Error('Project rows are unavailable');
            return rows;
        };
        expect((await readRows(requesterToken)).rows.some(row => row.key.kind === 'workspace-ref' && row.key.id === opened.workspace.workspaceId)).toBe(true);
        expect((await readRows(ownerToken)).rows).toEqual([]);
        for (const token of [requesterToken, outsiderToken]) {
            const rawSocket = io(endpoint, { path: '/v1/updates', transports: ['websocket'], reconnection: false, autoConnect: false,
                auth: { ...currentAccountStoredContentCompatibilitySocketAuth, token, clientType: 'user-scoped' } });
            onTestFinished(() => { rawSocket.disconnect(); });
            await new Promise<void>((resolve, reject) => { rawSocket.once('connect', resolve); rawSocket.once('connect_error', reject); rawSocket.connect(); });
            const raw = callSocketRpc({ socket: rawSocket, target: { kind: 'machine', id: machine.id }, method: RPC_METHODS.PROJECTS_OPEN,
                params: input, content: { mode: 'plain' }, timeoutMs: 10_000 });
            if (token === requesterToken) expect(OpenProjectResultV1Schema.parse(await raw))
                .toEqual({ kind: 'refused', code: 'requester_account_unavailable' });
            else await expect(raw).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
        }
        const receiptsBeforeOutsider = receipts.length;
        const outsiderAction = await dispatchOriginalAccountAction({ credentials: { token: outsiderToken, encryption: null },
            actionId: 'projects.open', input, target: { kind: 'machine', machineId: machine.id },
            serverHttpBaseUrl: endpoint, serverIdentityId: homeId, requestId: crypto.randomUUID(), authority: 'present_user' });
        expect(outsiderAction).toMatchObject({ ok: false });
        expect(receipts).toHaveLength(receiptsBeforeOutsider);
        const receiptsBeforeRevocation = receipts.length;
        await db.machineAccountGrant.deleteMany({ where: { machineId: machine.id, accountId: requester.id } });
        const revoked = await createDefaultActionExecutor().execute('projects.open', input, {
            serverId: profile.id, expectedAccountId: requester.id, surface: 'ui', authority: 'present_user', actionRequestId: crypto.randomUUID(),
        });
        expect(revoked).toMatchObject({ ok: false });
        expect(receipts).toHaveLength(receiptsBeforeRevocation);
        expect((await readRows(outsiderToken)).rows).toEqual([]);
        expect((await readRows(ownerToken)).rows).toEqual([]);
        expect((await readRows(requesterToken)).rows.filter(row => row.key.kind === 'workspace-ref')).toHaveLength(1);
    }, 180_000);
});
