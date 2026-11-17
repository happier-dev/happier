import { afterAll, beforeAll, describe, expect, it, onTestFailed, onTestFinished, vi } from 'vitest';
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
import { setEligibleMachineAccessGrantInTx } from '../../../../../server/sources/testkit/machineAccessGrant.testkit';
import { inTx } from '../../../../../server/sources/storage/inTx';
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
import { changesRoutes } from '../../../../../server/sources/app/api/routes/changes/changesRoutes';
import { sessionRoutes } from '../../../../../server/sources/app/api/routes/session/sessionRoutes';
import { registerPluginAvailabilityRoutes } from '../../../../../server/sources/app/plugins/availability/routes';
import { machinesRoutes } from '../../../../../server/sources/app/api/routes/machines/machinesRoutes';
import { featuresRoutes } from '../../../../../server/sources/app/api/routes/features/featuresRoutes';
import { registerExternalActionRoutes } from '../../../../../server/sources/app/api/routes/actions/registerExternalActionRoutes';
import { startSocket } from '../../../../../server/sources/app/api/socket';
import { auth } from '../../../../../server/sources/app/auth/auth';
import { db } from '../../../../../server/sources/storage/db';
import { getOrCreateServerIdentityId, initializeServerIdentityCache } from '../../../../../server/sources/app/serverIdentity/serverIdentity';
import { removeMachineAccessGrantInTx, resolveMachineAdmission } from '../../../../../server/sources/app/machines/machineAccess';
import { ApiClient } from '../../../../../cli/src/api/api';
import { dispatchOriginalAccountAction } from '../../../../../cli/src/api/externalActionExecutionAuthorization';
import type { ApiMachineClient } from '../../../../../cli/src/api/apiMachine';
import { createCurrentMachineExecutionOriginContextResolver } from '../../../../../cli/src/api/machine/resolveCurrentMachineExecutionOriginContext';
import { runWithServerHttpBaseUrl } from '../../../../../cli/src/api/client/serverHttpBaseUrl';
import { createRequesterSessionControlRuntimeFixture } from '../../../../../cli/src/daemon/testkit/requesterSessionControlRuntimeFixture';
import { activateSessionsRoleForMachineClient } from '../../../../../cli/src/daemon/testkit/sessionsRole.testkit';
import { observeServerFeaturesSnapshot } from '../../../../../cli/src/features/serverFeaturesClient';
import { createAgentIsolationMemberPreparationBoundary, runAgentIsolationMemberReadinessBoundary } from '../../../../../cli/src/daemon/agentIsolation/agentIsolationEffects.testkit';
import { deriveAgentIsolationMemberIdentity, buildAgentIsolationProvisioningSteps } from '../../../../../cli/src/daemon/agentIsolation/provisioning';
import { writeAgentIsolationMemberBinding } from '../../../../../cli/src/daemon/agentIsolation/memberBindings';
import { workspaceCheckoutNativeBoundary as nativeBoundary } from '../../../../../cli/src/workspaces/activation/workspaceCheckoutNative.testkit';
import { readAgentLaunchFrame } from '../../../../../cli/src/daemon/agentIsolation/agentLaunchFrame';
import { runWorkspaceEffectWorker } from '../../../../../cli/src/workspaces/activation/workspaceEffectWorker';
import { createAdmittedPluginRuntimeFixture } from '../../../../../cli/src/plugins/testkit/admittedRuntime';
import { createResolvedContributionRegistry } from '../../../../../cli/src/plugins/projection/registry/createResolvedContributionRegistry';
import { pluginReloadController } from '../../../../../cli/src/plugins/runtime/reload/singleton';
import { ConnectedServiceRuntimeRegistry } from '../../../../../cli/src/daemon/connectedServices/runtimeRegistry/registry';
import { configuration, reloadConfiguration } from '../../../../../cli/src/configuration';
import { updateSettings, writeCredentialsTokenOnlyForServerId } from '../../../../../cli/src/persistence';
import { createEnvKeyScope } from '../../../../../cli/src/testkit/env/envScope';
import { withdrawActiveProjectAccountRowsSnapshot } from '../../../../../cli/src/workspaces/projectAccountRows';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { removeServerProfile } from '@/sync/domains/server/serverProfiles';
import { createDefaultActionExecutor } from './defaultActionExecutor';

// Virtual native uid/home and process pipes; provisioning and the framed Workspace worker stay real.
vi.mock('node:fs/promises', async original => {
    const { workspaceCheckoutFilesystemBoundary } = await import('../../../../../cli/src/workspaces/activation/workspaceCheckoutNative.testkit');
    return workspaceCheckoutFilesystemBoundary(await original<typeof import('node:fs/promises')>());
});
vi.mock('node:child_process', async original => {
    const actual = await original<typeof import('node:child_process')>();
    const { workspaceCheckoutNativeBoundary: boundary, spawnWorkspaceCheckoutNativeBoundary } = await import('../../../../../cli/src/workspaces/activation/workspaceCheckoutNative.testkit');
    const execFile = (...args: unknown[]) => {
        if (args[0] === 'sudo' && Array.isArray(args[1]) && args[1].at(-1) === 'agent-launch' && boundary.launch) {
            const commandArgs = args[1], callback = args.at(-1), home = boundary.mounts[0];
            if (typeof callback !== 'function' || !home) throw new Error('Missing native readiness boundary');
            return Reflect.apply(actual.execFile, actual, ['/bin/cat', [], {
                ...(typeof args[2] === 'object' && args[2] !== null ? args[2] : {}), encoding: 'buffer',
            }, (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => {
                if (error) { callback(error, stdout, stderr); return; }
                void runAgentIsolationMemberReadinessBoundary({ request: ['sudo', commandArgs, { inputBytes: Buffer.from(stdout) }],
                    nativeHome: { path: home.path, uid: home.uid } }).then(result => {
                    if (!result) throw new Error('Missing native readiness result');
                    callback(null, result.stdout, result.stderr);
                }).catch(failure => callback(failure, '', ''));
            }]);
        }
        const lookup = args[0] === 'getent' && Array.isArray(args[1]) ? boundary.accountLookups.get(JSON.stringify(args[1])) : undefined;
        return Reflect.apply(actual.execFile, actual, lookup === undefined ? args : ['/usr/bin/printf', ['%s', lookup], ...args.slice(2)]);
    };
    Object.defineProperties(execFile, Object.getOwnPropertyDescriptors(actual.execFile));
    return { ...actual, execFile, spawn: (command: string, args: readonly string[], options: import('node:child_process').SpawnOptions) => {
        if (command !== 'sudo' || !boundary.launch) return actual.spawn(command, args, options);
        expect(args.slice(-2)).toEqual(['/opt/happier/cli/current/happier', 'agent-launch']);
        boundary.runAsUsers.push(args[2]!);
        return spawnWorkspaceCheckoutNativeBoundary();
    } };
});

describe('recipient Project Open through the real UI, Home, installed daemon and Account rows', () => {
    let database: LightSqliteHarness;
    let app: AppFastify;
    let endpoint: string;
    let rawProjectAdmissionRequests = 0;
    beforeAll(async () => {
        database = await createLightSqliteHarness({ tempDirPrefix: 'happier-recipient-project-', initAuth: true, initEncrypt: true,
            env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', AUTH_REQUIRED_LOGIN_PROVIDERS: '' } });
        await initializeServerIdentityCache();
        app = Fastify({ logger: false }) as unknown as AppFastify;
        enableSchemaValidation(app); enableErrorHandlers(app); enableAuthentication(app); enableMonitoring(app); enableOptionalStatics(app);
        registerAuthPingRoute(app); registerAccountApiTokenManagementRoutes(app); registerAccountSecurityRoutes(app);
        accountRoutes(app); machinesRoutes(app); featuresRoutes(app);
        changesRoutes(app); sessionRoutes(app); registerPluginAvailabilityRoutes(app);
        startSocket(app); registerExternalActionRoutes(app);
        app.addHook('preHandler', async request => {
            const method = request.body && typeof request.body === 'object' ? Reflect.get(request.body, 'method') : undefined;
            if (request.url.endsWith('/admission/verify') && typeof method === 'string'
                && method.endsWith(`:${RPC_METHODS.PROJECTS_OPEN}`)) rawProjectAdmissionRequests += 1;
        });
        endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
    }, 180_000);
    afterAll(async () => { await app?.close(); await database?.close(); });

    it('opens an existing shared-Machine folder into the recipient Account while outsider, revocation and raw forwarding stay refused', async () => {
        let phase = 'prepare';
        onTestFailed(() => { console.error('Project Open boundary phase:', phase); });
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const requester = await db.account.create({ data: { encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        const ownerToken = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const requesterToken = await auth.createToken(requester.id, undefined, { kind: 'account', authority: 'present_user' });
        const outsiderToken = await auth.createToken(outsider.id, undefined, { kind: 'account', authority: 'present_user' });
        const installationId = crypto.randomUUID();
        const homeId = await getOrCreateServerIdentityId();
        const ownerRoot = join(database.baseDir, 'owner-control-project');
        await mkdir(ownerRoot);
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id, active: true,
            installationId,
            metadata: encodePlainMachineStoredContent({ host: 'recipient-project', platform: 'linux', happyCliVersion: '0.3',
                homeDir: database.baseDir, happyHomeDir: database.baseDir }),
            dataEncryptionKey: Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64') } });
        expect(await inTx(tx => setEligibleMachineAccessGrantInTx(tx, {
            actorAccountId: owner.id, machineId: machine.id,
            principal: { kind: 'account', accountId: requester.id }, level: 'view',
        }))).toMatchObject({ kind: 'saved' });
        expect(await resolveMachineAdmission({ actorAccountId: requester.id, machineId: machine.id, actionId: 'projects.open' }))
            .toMatchObject({ kind: 'admitted', role: 'use' });

        const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID']);
        env.patch({ HAPPIER_HOME_DIR: join(database.baseDir, 'daemon'), HAPPIER_ACTIVE_SERVER_ID: homeId });
        reloadConfiguration();
        let apiMachine: ApiMachineClient | null = null;
        let daemon: Awaited<ReturnType<typeof createRequesterSessionControlRuntimeFixture>> | null = null;
        onTestFinished(async () => {
            try { await apiMachine?.shutdown(); await daemon?.dispose(); }
            finally { nativeBoundary.reset(); withdrawActiveProjectAccountRowsSnapshot(); env.restore(); reloadConfiguration(); }
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
        const requesterIdentity = { kind: 'isolated' as const, separationRequired: true, homeServerIdentityId: homeId,
            requester: { serverId: homeId, accountId: requester.id, machineId: machine.id, installationId: daemon.installation.installationId } };
        const member = deriveAgentIsolationMemberIdentity(requesterIdentity);
        const memberPreparation = createAgentIsolationMemberPreparationBoundary({ activeServerDir: configuration.activeServerDir,
            requesterIdentity, custodianAccountId: owner.id, encryptionMode: 'plain', uid: 2401 });
        for (const step of buildAgentIsolationProvisioningSteps({ requesterIdentity, daemonUsername: 'happier', daemonPrimaryGroup: 'happier',
            binaryPath: '/opt/happier/cli/current/happier' })) memberPreparation.installed.add(step.id);
        const backingHome = join(database.baseDir, 'native-home'), backingWorkspace = join(database.baseDir, 'native-workspace');
        await mkdir(backingHome); await mkdir(backingWorkspace);
        nativeBoundary.mounts = [{ path: member.home, backing: backingHome, uid: 2401, gid: 2401, mode: 0o40700 },
            { path: member.workspaceRoot, backing: backingWorkspace, uid: 2401, gid: 1001, mode: 0o42770 }];
        nativeBoundary.accountLookups.set(JSON.stringify(['--service=files', 'passwd', member.username]),
            `${member.username}:x:2401:2401:${member.ownershipMarker}:${member.home}:/usr/sbin/nologin\n`);
        nativeBoundary.accountLookups.set(JSON.stringify(['--service=files', 'group', 'happier']), 'happier:x:1001:\n');
        await writeAgentIsolationMemberBinding(configuration.activeServerDir, { ...member, agentUid: 2401, agentGid: 2401 });
        const root = join(member.workspaceRoot, 'existing-project');
        await mkdir(root);
        nativeBoundary.privateRoot = root;
        nativeBoundary.launch = async (input, output) => {
            const frame = await readAgentLaunchFrame(input);
            expect(frame.nativeIdentity).toEqual({ username: member.username, agentUid: 2401, agentGid: 2401, home: member.home });
            expect(frame.args).toEqual(['workspace-effect']);
            await runWorkspaceEffectWorker([], { input, output, signal: new AbortController().signal,
                currentDirectory: () => member.workspaceRoot });
        };
        const pluginRuntime = await createAdmittedPluginRuntimeFixture({ happyHomeDir: configuration.happyHomeDir,
            controller: pluginReloadController, runtimeOptions: { pluginIds: [], contributes: createResolvedContributionRegistry({}) } });
        onTestFinished(() => pluginRuntime.dispose());
        await db.machine.update({ where: { id: machine.id }, data: { installationId: daemon.installation.installationId,
            installationPublicKey: new Uint8Array(decodeBase64(daemon.installation.publicKey, 'base64url')) } });
        await writeCredentialsTokenOnlyForServerId(homeId, { token: ownerToken });
        const ownerApi = await runWithServerHttpBaseUrl(endpoint, () => ApiClient.create(ownerCredentials));
        const publishedMachine = await runWithServerHttpBaseUrl(endpoint, () => ownerApi.getMachine(machine.id));
        if (!publishedMachine) throw new Error('Published Machine is unavailable');
        const snapshot = await observeServerFeaturesSnapshot({ serverUrl: endpoint });
        if (snapshot.status !== 'ready') throw new Error('Machine Home features did not settle');
        ownerApi.setServerFeaturesSnapshotProvider(() => snapshot);
        apiMachine = await runWithServerHttpBaseUrl(endpoint, () => ownerApi.machineSyncClient(publishedMachine, undefined, { agentIsolation: {
            managedHappierBinaryPath: '/opt/happier/cli/current/happier',
            read: () => ({ enabled: true, memberProvisioning: 'linuxUsersV1',
                status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' }, workspaceRoots: [] }),
            readMember: input => memberPreparation.members.read(input),
            prepareMember: async input => {
                const result = await memberPreparation.members.prepare(input);
                if (result.kind !== 'ready') throw new Error('Member preparation refused');
                return result;
            },
        } }));
        const installedApiMachine = apiMachine;
        const registration = await runWithServerHttpBaseUrl(endpoint, async () => installedApiMachine.setRPCHandlers({
            spawnSession: runtime.spawnSession, stopSession: runtime.stopSession,
            isSessionActive: runtime.isSessionAlreadyRunning,
            requestShutdown: () => { throw new Error('Unexpected daemon shutdown'); },
        }, { currentMachineId: machine.id, currentServerId: homeId, workingDirectory: root,
            externalActionIngressOwner: runtime.externalActionIngressOwner }));
        const sessionsRole = await activateSessionsRoleForMachineClient(installedApiMachine, registration);
        onTestFinished(() => sessionsRole.stop());
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
        const homes = await serveActionHomes({ homes: [{ key: 'home', serverUrl: endpoint, serverIdentityId: homeId,
            accountId: requester.id, credentials: { token: requesterToken }, currentAccount: true }],
            route: async request => {
                const method = request.method;
                if (method !== 'GET' && method !== 'POST' && method !== 'PUT' && method !== 'PATCH'
                    && method !== 'DELETE' && method !== 'HEAD' && method !== 'OPTIONS') {
                    throw new Error(`Unsupported Home HTTP method: ${method}`);
                }
                const response = await app.inject({ method, url: request.url.pathname + request.url.search,
                    headers: Object.fromEntries(request.headers), ...(request.body === undefined ? {} : { payload: JSON.stringify(request.body) }) });
                const headers = new Headers();
                for (const [name, value] of Object.entries(response.headers)) {
                    if (value !== undefined) for (const item of Array.isArray(value) ? value : [value]) headers.append(name, String(item));
                }
                return new Response(response.body, { status: response.statusCode, headers });
            } });
        const profile = homes.homes.home!;
        onTestFinished(async () => { await homes.dispose(); await removeServerProfile(profile.profileId); });
        const input = OpenProjectInputV1Schema.parse({ serverId: homeId, machineId: machine.id,
            source: { kind: 'folder', path: root }, materialization: { kind: 'attach' } });
        const readRows = async (token: string) => {
            const response = await app.inject({ method: 'POST', url: '/v1/account/project-rows/list',
                headers: { authorization: `Bearer ${token}` }, payload: {} });
            expect(response.statusCode).toBe(200);
            const rows = ProjectAccountRowListResponseV1Schema.parse(response.json());
            if (rows.status !== 'listed') throw new Error('Project rows are unavailable');
            return rows;
        };
        phase = 'custodian signed Action';
        const ownerControl = await dispatchOriginalAccountAction({ credentials: ownerCredentials,
            actionId: 'projects.open', input: { ...input, source: { kind: 'folder', path: ownerRoot } }, target: { kind: 'machine', machineId: machine.id },
            serverHttpBaseUrl: endpoint, serverIdentityId: homeId, requestId: crypto.randomUUID(), authority: 'present_user' });
        expect(ownerControl, JSON.stringify(ownerControl)).toMatchObject({ ok: true, result: { kind: 'opened', directory: ownerRoot } });
        const ownerRows = (await readRows(ownerToken)).rows;
        expect(ownerRows.some(row => row.key.kind === 'workspace-ref')).toBe(true);
        phase = 'guest signed Action and pushed row materialization';
        const result = await createDefaultActionExecutor().execute('projects.open', input, {
            serverId: profile.id, expectedAccountId: requester.id, surface: 'ui', authority: 'present_user', actionRequestId: crypto.randomUUID(),
        });
        expect(result, JSON.stringify({ result, receipts })).toMatchObject({ ok: true, result: { kind: 'opened', directory: root } });
        // The signed roots were admitted by Home; local handoff must not request a new raw-RPC grant.
        expect(rawProjectAdmissionRequests).toBe(0);
        expect(carriedRequests).toHaveLength(2);
        expect(carriedRequests[1]).toMatchObject({ actionId: 'projects.open', principal: { accountId: requester.id }, envelope: { v: 1 } });
        if (carriedRequests[1]!.envelope.v === 1) expect(OpenProjectInputV1Schema.parse(carriedRequests[1]!.envelope.input).source)
            .toEqual({ kind: 'folder', path: root });
        if (!result.ok) throw new Error(result.errorCode);
        const opened = OpenProjectResultV1Schema.parse(result.result);
        if (opened.kind !== 'opened') throw new Error('Project was not opened');
        expect(opened.workspace).toMatchObject({ serverId: homeId, machineId: machine.id, rootPath: root });
        expect((await readRows(requesterToken)).rows.some(row => row.key.kind === 'workspace-ref' && row.key.id === opened.workspace.workspaceId)).toBe(true);
        expect((await readRows(ownerToken)).rows).toEqual(ownerRows);
        for (const token of [requesterToken, outsiderToken]) {
            phase = token === requesterToken ? 'guest raw RPC refusal' : 'outsider raw RPC refusal';
            const rawSocket = io(endpoint, { path: '/v1/updates', transports: ['websocket'], reconnection: false, autoConnect: false,
                auth: { ...currentAccountStoredContentCompatibilitySocketAuth, token, clientType: 'user-scoped' } });
            onTestFinished(() => { rawSocket.disconnect(); });
            await new Promise<void>((resolve, reject) => { rawSocket.once('connect', resolve); rawSocket.once('connect_error', reject); rawSocket.connect(); });
            const raw = callSocketRpc({ socket: rawSocket, target: { kind: 'machine', id: machine.id }, method: RPC_METHODS.PROJECTS_OPEN,
                params: input, content: { mode: 'plain' }, timeoutMs: 10_000 });
            if (token === requesterToken) expect(OpenProjectResultV1Schema.parse(await raw))
                .toMatchObject({ kind: 'refused', code: 'requester_account_unavailable', effectAttempted: false,
                    failureCause: { phase: 'projects.open', errorCode: 'requester_account_unavailable' } });
            else await expect(raw).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
        }
        phase = 'outsider signed Action refusal';
        const receiptsBeforeOutsider = receipts.length;
        const outsiderAction = await dispatchOriginalAccountAction({ credentials: { token: outsiderToken, encryption: null },
            actionId: 'projects.open', input, target: { kind: 'machine', machineId: machine.id },
            serverHttpBaseUrl: endpoint, serverIdentityId: homeId, requestId: crypto.randomUUID(), authority: 'present_user' });
        expect(outsiderAction).toMatchObject({ ok: false });
        expect(receipts).toHaveLength(receiptsBeforeOutsider);
        phase = 'revoked signed Action refusal';
        const receiptsBeforeRevocation = receipts.length;
        expect(await inTx(tx => removeMachineAccessGrantInTx(tx, {
            actorAccountId: owner.id, machineId: machine.id,
            principal: { kind: 'account', accountId: requester.id },
        }))).toMatchObject({ kind: 'removed' });
        const revoked = await createDefaultActionExecutor().execute('projects.open', input, {
            serverId: profile.id, expectedAccountId: requester.id, surface: 'ui', authority: 'present_user', actionRequestId: crypto.randomUUID(),
        });
        expect(revoked).toMatchObject({ ok: false });
        expect(receipts).toHaveLength(receiptsBeforeRevocation);
        expect((await readRows(outsiderToken)).rows).toEqual([]);
        expect((await readRows(ownerToken)).rows).toEqual(ownerRows);
        expect((await readRows(requesterToken)).rows.filter(row => row.key.kind === 'workspace-ref')).toHaveLength(1);
    }, 180_000);
});
