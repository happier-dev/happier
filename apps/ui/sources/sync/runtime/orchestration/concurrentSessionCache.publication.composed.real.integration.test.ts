// Cross-package Server→UI composition uses the integration runner's scoped aliases.
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Server, type Socket } from 'socket.io';
import tweetnacl from 'tweetnacl';
import { createConcurrentCacheNetworkHarness } from '@/dev/testkit/harness/concurrentCacheNetworkHarness';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildAccountStoredContentCompatibilitySocketAuthV1, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { createAccountTokenForTests, createLightSqliteHarness, type LightSqliteHarness } from '../../../../../server/sources/testkit/lightSqliteHarness';
import { createAuthenticatedTestApp } from '../../../../../server/sources/app/api/testkit/sqliteFastify';
import { createAuthenticatedFakeSocket } from '../../../../../server/sources/app/api/testkit/socketHarness';
import { evaluateAccountStoredContentSocketCompatibility, writeAccountStoredContentCompatibilityForSocket } from '../../../../../server/sources/app/clientCompatibility/accountStoredContentCompatibility';
import { eventRouter } from '../../../../../server/sources/app/events/connectionEventRouter';
import type { ClientConnection } from '../../../../../server/sources/app/events/eventPayloadTypes';
import { machinesRoutes } from '../../../../../server/sources/app/api/routes/machines/machinesRoutes';
import { sessionPendingRoutes } from '../../../../../server/sources/app/api/routes/session/pendingRoutes';
import { changesRoutes } from '../../../../../server/sources/app/api/routes/changes/changesRoutes';
import { registerSessionListingRoutes } from '../../../../../server/sources/app/api/routes/session/registerSessionListingRoutes';
import { registerSessionReadBatchRoute } from '../../../../../server/sources/app/api/routes/session/registerSessionReadBatchRoute';
import { startSocket } from '../../../../../server/sources/app/api/socket';
import { removeMachineAccessGrantInTx } from '../../../../../server/sources/app/machines/machineAccess';
import { setEligibleMachineAccessGrantInTx } from '../../../../../server/sources/testkit/machineAccessGrant.testkit';
import { db } from '../../../../../server/sources/storage/db';
import { inTx } from '../../../../../server/sources/storage/inTx';
import { createSessionMachineAccessKeyInTx } from '../../../../../server/sources/app/accessKeys/sessionMachineAccessKeyMutations';
import { enqueuePendingMessage } from '../../../../../server/sources/app/session/pending/pendingMessageService';
import { createPresentUserSessionAccessAuthentication } from '../../../../../server/sources/app/session/access/sessionAccessAuthentication.testkit';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { registerSessionRealtimeTranscriptConsumer } from '@/sync/runtime/sessionRealtimeTranscriptConsumers';
import { resolvePendingActivationBanner } from '@/components/sessions/pending/resolvePendingActivationBanner';
import { SessionReadBatchResponseV1Schema } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

const h = await createConcurrentCacheNetworkHarness('cache-publication');
let database: LightSqliteHarness;
const homeId = `srv_${'e'.repeat(32)}`;
beforeAll(async () => { database = await createLightSqliteHarness({ tempDirPrefix: 'happier-cache-publication-', initAuth: true, initEncrypt: true,
    env: { HAPPIER_SERVER_IDENTITY_ID: homeId, HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
        AUTH_REQUIRED_LOGIN_PROVIDERS: '', HAPPIER_SOCKET_ADAPTER: 'memory' } }); }, 180_000);
beforeEach(() => h.reset());
afterEach(() => h.cleanup());
afterAll(async () => { await h.dispose(); if (database) await database.close(); });

it.each(['secondary', 'focused'] as const)('delivers real grant and activation-failure publications into A’s existing %s-Home store', async mode => {
    const home = mode === 'focused' ? h.homeA : h.homeB;
    const prefix = mode === 'focused' ? 'aab20000' : 'aab10000';
    const requester = await db.account.create({ data: { id: home.accountId, encryptionMode: 'plain' } });
    const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
    const machine = await db.machine.create({ data: { id: `${prefix}-0000-4000-8000-000000000001`, accountId: custodian.id, installationId: `${prefix}-0000-4000-8000-000000000002`,
        installationPublicKey: new Uint8Array(tweetnacl.sign.keyPair().publicKey),
        metadata: encodePlainMachineStoredContent({ host: 'shared', platform: 'linux', happyCliVersion: 'test', homeDir: '/test', happyHomeDir: '/test/.happier' }),
        dataEncryptionKey: new Uint8Array(Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
        operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } }, operationProtocolCapabilitiesRevision: 1 } });
    const controller = await db.machine.create({ data: { ...machine, id: `${prefix}-0000-4000-8000-000000000003`, installationId: `${prefix}-0000-4000-8000-000000000004`, active: true } });
    await db.managedMachine.create({ data: { homeId, custodianAccountId: custodian.id,
        controllerMachineId: controller.id, controllerInstallationId: controller.installationId!,
        admittedActionRequestId: `create-managed-${mode}`, admittedInput: {}, allocation: 'bound', creationState: 'active',
        launch: { provider: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, name: 'Retained', choices: {} },
        resource: { contributionRef: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
        // Exercise manual power permission. Owner-enabled accepted-input wake permits Use.
        enrolledMachineId: machine.id, desired: 'stop', retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        observation: { observedAt: 1, availability: 'present', power: 'stopped', storage: 'retained' } } });
    const grant = async (level: 'view' | 'admin', machineId = machine.id) => {
        const result = await inTx(tx => setEligibleMachineAccessGrantInTx(tx, {
            actorAccountId: custodian.id, machineId, principal: { kind: 'account', accountId: requester.id }, level,
        }));
        expect(result).toMatchObject({ kind: 'saved' });
        return result;
    };
    expect(await grant('view')).toMatchObject({ kind: 'saved' });
    expect(await grant('view', controller.id)).toMatchObject({ kind: 'saved' });
    const requestedAt = 1_000;
    const session = await db.session.create({ data: { accountId: requester.id, tag: 'publication-session', metadata: '{}',
        encryptionMode: 'plain', active: false, lastActiveAt: new Date(0) } });
    expect(await inTx(tx => createSessionMachineAccessKeyInTx(tx, { accountId: requester.id, machineId: machine.id,
        sessionId: session.id, data: 'fixture-key' }))).toMatchObject({ ok: true });
    const admission = await enqueuePendingMessage({ actorUserId: requester.id, authentication: createPresentUserSessionAccessAuthentication(),
        sessionId: session.id, localId: 'retained-input', targetMachineId: machine.id,
        requestedAction: { v: 1, kind: 'enqueue' },
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'retained input' } } } });
    expect(admission, JSON.stringify(admission)).toMatchObject({ ok: true });
    const app = createAuthenticatedTestApp();
    machinesRoutes(app);
    sessionPendingRoutes(app);
    changesRoutes(app);
    registerSessionListingRoutes(app);
    registerSessionReadBatchRoute(app);
    if (mode === 'focused') startSocket(app);
    await app.ready();
    const activeReads = new Set<Promise<Response>>();
    const read = (url: string, init?: RequestInit) => {
        const result = (async () => {
            const response = await app.inject({ method: init?.method === 'POST' ? 'POST' : 'GET', url,
                ...(typeof init?.body === 'string' ? { payload: init.body } : {}),
                headers: { ...Object.fromEntries(new Headers(init?.headers)), 'x-test-user-id': requester.id,
                'x-happier-account-stored-content-protocol': String(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION.protocolVersion) } });
            return new Response(response.body, { status: response.statusCode, headers: { 'Content-Type': 'application/json' } });
        })();
        activeReads.add(result);
        void result.then(() => activeReads.delete(result), () => activeReads.delete(result));
        return result;
    };
    let holdNextPendingRead = false;
    let releaseOlderRead: (() => void) | undefined;
    let olderReadFinished: Promise<void> | undefined;
    let holdNextSessionRead = false;
    let releaseOlderSessionRead: (() => void) | undefined;
    h.setResponder(async (input, init) => {
        const url = new URL(String(input));
        const path = url.pathname;
        if (path === '/v2/sessions/read-batch' && holdNextSessionRead) {
            holdNextSessionRead = false;
            const response = await read(path, init);
            const batch = SessionReadBatchResponseV1Schema.parse(await response.clone().json());
            expect(batch.results.find(row => row.sessionId === session.id)?.detail).toMatchObject({
                status: 200, body: { session: { pendingActivationAuthorization: { status: 'waiting' } } },
            });
            await new Promise<void>(resolve => { releaseOlderSessionRead = resolve; });
            return response;
        }
        if (path === `/v2/sessions/${session.id}/pending` && holdNextPendingRead) {
            holdNextPendingRead = false;
            const response = await read(path);
            const gate = new Promise<void>(resolve => { releaseOlderRead = resolve; });
            olderReadFinished = gate.then(() => undefined);
            await gate;
            return response;
        }
        return path === '/v1/machines' || path === '/v1/machines/read-batch' || path.startsWith('/v2/sessions') || path === '/v2/changes' || path === '/v2/cursor'
            ? read(`${path}${url.search}`, init) : null;
    });
    h.setSessions(home, [h.session({ id: session.id })]);
    if (mode === 'focused') await h.startFocused();
    else { await h.start(); await h.ready(); }
    const machines = () => mode === 'focused' ? Object.values(h.storage.getState().machines)
        : h.storage.getState().machineListByServerId[home.id] ?? [];
    expect(machines().find(row => row.id === machine.id)?.access?.role).toBe('use');
    h.storage.getState().applySessions([createSessionFixture({ id: session.id, serverId: home.id, pendingCount: 1, pendingVersion: 1 })]);
    const releaseConsumer = registerSessionRealtimeTranscriptConsumer(session.id, home.id);
    await getSyncSingleton().fetchPendingMessages(session.id);
    const pending = () => h.storage.getState().sessionPending[session.id]?.messages ?? [];
    expect(pending()[0]?.pendingActivationHoldReason).toBe('managed_power_required');

    // Socket.IO is the transport boundary. Grant/failure writers, commit hooks,
    // audience routing, strict ingress, subscription and Zustand application stay real.
    const socket = createAuthenticatedFakeSocket({ data: { authAuthority: 'present_user' }, emit: vi.fn((event, body) => h.socket(home).trigger(event, body)) });
    const transportSocket = socket as unknown as Socket;
    writeAccountStoredContentCompatibilityForSocket(transportSocket, evaluateAccountStoredContentSocketCompatibility(
        buildAccountStoredContentCompatibilitySocketAuthV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION)));
    const connection: ClientConnection = { connectionType: 'user-scoped', userId: requester.id, socket: transportSocket };
    let client: import('socket.io-client').Socket | undefined;
    try {
        if (mode === 'focused') {
            await app.listen({ port: 0, host: '127.0.0.1' });
            const address = app.server.address();
            if (!address || typeof address === 'string') throw new Error('Missing disposable socket address');
            const { io } = await vi.importActual<typeof import('socket.io-client')>('socket.io-client');
            client = io(`http://127.0.0.1:${address.port}`, { path: '/v1/updates', transports: ['websocket'], reconnection: false,
                autoConnect: false, auth: { ...buildAccountStoredContentCompatibilitySocketAuthV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION),
                    token: await createAccountTokenForTests(requester.id, { kind: 'account', authority: 'present_user' }),
                    clientType: 'user-scoped', clientPurpose: 'sync' } });
            client.onAny((event, body) => h.socket(home).trigger(event, body));
            await new Promise<void>((resolve, reject) => {
                client!.once('connect', resolve); client!.once('connect_error', reject); client!.connect();
            });
            const ioServer = app.machineDaemonPresence;
            if (!(ioServer instanceof Server)) throw new Error('Missing production socket server');
            await vi.waitFor(() => expect(ioServer.sockets.sockets.get(client!.id!)?.rooms.has(`account-stored-content-v3:${requester.id}`)).toBe(true));
        } else eventRouter.addConnection(requester.id, connection);
        const version = h.storage.getState().sessions[session.id]?.pendingVersion;
        holdNextPendingRead = true;
        await grant('admin');
        // This read still sees a Use controller. Hold it across the second grant
        // publication: pendingVersion and transcript do not change on either wake.
        await vi.waitFor(() => expect(releaseOlderRead).toBeTypeOf('function'));
        await grant('admin', controller.id);
        await vi.waitFor(() => expect(machines().find(row => row.id === machine.id)?.access?.role).toBe('manage'));
        await vi.waitFor(() => expect(pending()[0]?.pendingActivationHoldReason).toBe('resume_not_requested'));
        expect(resolvePendingActivationBanner({ active: false, activeAt: 0, machineReachable: false,
            canWrite: true, pendingMessages: pending() })?.primaryAction).toBe('process_when_online');
        releaseOlderRead!();
        await olderReadFinished;
        // Let the held transport continuation reconcile through the actual reader.
        await vi.dynamicImportSettled();
        expect(pending()[0]?.pendingActivationHoldReason).toBe('resume_not_requested');
        await grant('view', controller.id);
        await vi.waitFor(() => expect(pending()[0]?.pendingActivationHoldReason).toBe('managed_power_required'));
        await grant('admin', controller.id);
        await vi.waitFor(() => expect(pending()[0]?.pendingActivationHoldReason).toBe('resume_not_requested'));
        await grant('view');
        expect(await db.machineGrant.findUnique({ where: { machineId_accountId: { machineId: machine.id, accountId: requester.id },
            principalKind: 'account' }, select: { accessLevel: true } })).toEqual({ accessLevel: 'view' });
        // A direct Use grant does not withdraw Manage inherited from the controller.
        // The guest publication must preserve the canonical role-graph decision.
        await vi.waitFor(() => expect(machines().find(row => row.id === machine.id)?.access?.role).toBe('manage'));
        expect(pending()[0]?.pendingActivationHoldReason).toBe('resume_not_requested');
        await grant('admin');
        await vi.waitFor(() => expect(pending()[0]?.pendingActivationHoldReason).toBe('resume_not_requested'));
        expect(h.storage.getState().sessions[session.id]?.pendingVersion).toBe(version);
        await db.session.update({ where: { id: session.id }, data: { pendingActivationRequestId: 'retained-input',
            pendingActivationRequestedAt: new Date(requestedAt), pendingActivationStatus: 'waiting' } });
        const current = h.storage.getState().sessions[session.id]!;
        h.storage.getState().applySessions([{ ...current,
            pendingActivationAuthorization: { requestId: 'retained-input', requestedAt, status: 'waiting' } }]);
        let olderSessionRead: Promise<unknown> | undefined;
        if (mode === 'focused') {
            holdNextSessionRead = true;
            olderSessionRead = getSyncSingleton().ensureSessionVisibleForMessageRoute(session.id, { forceRefresh: true, hydrateMessages: false });
            await vi.waitFor(() => expect(releaseOlderSessionRead).toBeTypeOf('function'));
        }
        const response = await app.inject({ method: 'POST', url: `/v2/sessions/${session.id}/pending/activation/fail`,
            headers: { 'x-test-user-id': requester.id },
            payload: { requestId: 'retained-input', requestedAt, failureCode: 'runtime_start_failed' } });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ didFail: true });
        await vi.waitFor(() => expect(h.storage.getState().sessions[session.id]?.pendingActivationAuthorization)
            .toMatchObject({ status: 'failed', failureCode: 'runtime_start_failed' }));
        if (olderSessionRead) {
            releaseOlderSessionRead!();
            await olderSessionRead;
            expect(h.storage.getState().sessions[session.id]?.pendingActivationAuthorization)
                .toMatchObject({ status: 'failed', failureCode: 'runtime_start_failed' });
            const rearm = await app.inject({ method: 'PATCH', url: `/v2/sessions/${session.id}/pending/retained-input/action`,
                headers: { 'x-test-user-id': requester.id }, payload: { requestedAction: { v: 1, kind: 'enqueue' }, resumeWhenAvailable: true } });
            expect(rearm.statusCode).toBe(200);
            await vi.waitFor(() => expect(h.storage.getState().sessions[session.id]?.pendingActivationAuthorization)
                .toMatchObject({ status: 'waiting', requestId: 'retained-input' }));
            expect(h.storage.getState().sessions[session.id]!.pendingActivationAuthorization!.requestedAt).toBeGreaterThan(requestedAt);
        }
        expect((await db.session.findUniqueOrThrow({ where: { id: session.id } })).pendingCount).toBe(1);
        // Keep the controller visible through Use while removing its inherited Manage.
        await grant('view', controller.id);
        await vi.waitFor(() => expect(machines().find(row => row.id === controller.id)?.access?.role).toBe('use'));
        // Real grant loss publishes AccountChange, then the access-filtered
        // complete census withdraws the unrevoked Machine from either Home.
        expect(machines().some(row => row.id === machine.id)).toBe(true);
        const removed = await inTx(tx => removeMachineAccessGrantInTx(tx, {
            actorAccountId: custodian.id, machineId: machine.id,
            principal: { kind: 'account', accountId: requester.id },
        }));
        expect(removed.kind).toBe('removed');
        await vi.waitFor(() => expect(machines().some(row => row.id === machine.id)).toBe(false));
        expect((await db.machine.findUniqueOrThrow({ where: { id: machine.id } })).revokedAt).toBeNull();
        expect(machines().some(row => row.id === controller.id)).toBe(true);
        if (mode === 'focused') {
            expect(h.storage.getState().machines[machine.id]).toBeUndefined();
            expect(h.storage.getState().machineDisplayById[machine.id]).toBeUndefined();
        }
    } finally {
        releaseOlderRead?.(); releaseOlderSessionRead?.(); releaseConsumer();
        if (client) { client.disconnect(); await (app.machineDaemonPresence as Server).close(); eventRouter.clearIo(); }
        else eventRouter.removeConnection(requester.id, connection);
        await h.cleanup();
        await vi.dynamicImportSettled();
        await Promise.allSettled([...activeReads]);
        await app.close();
    }
});
