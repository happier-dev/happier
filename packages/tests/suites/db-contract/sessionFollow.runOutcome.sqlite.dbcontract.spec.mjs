import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { decodeBase64 } from 'privacy-kit';
import { resolveExecutionRunFollowOccurrenceV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { SessionFollowPendingObservationV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { resolveSessionFollowActionRequest } from '@happier-dev/protocol/sessions/follow/actionTransport';
import { createLightSqliteHarness } from '../../../../apps/server/sources/testkit/lightSqliteHarness';
import { createAuthenticatedTestApp } from '../../../../apps/server/sources/app/api/testkit/sqliteFastify';
import { db } from '../../../../apps/server/sources/storage/db';
import { inTx } from '../../../../apps/server/sources/storage/inTx';
import { registerSessionFollowSourceRoutes } from '../../../../apps/server/sources/app/api/routes/session/registerSessionFollowSourceRoutes';
import { registerSessionFollowRoutes } from '../../../../apps/server/sources/app/api/routes/session/registerSessionFollowRoutes';
import { sessionPendingRoutes } from '../../../../apps/server/sources/app/api/routes/session/pendingRoutes';
import { observePendingSessionFollowForDestinationInTx } from '../../../../apps/server/sources/app/session/follow/sessionFollowEdgeService';
import { retainCurrentExecutionRunFollowObservations } from '../../../../apps/server/sources/app/session/follow/executionRunFollowSource';
import { createPresentUserSessionAccessAuthentication } from '../../../../apps/server/sources/app/session/access/sessionAccessAuthentication.testkit';
import { createSessionFollowOccurrenceDispatcher } from '../../../../apps/cli/src/agent/runtime/session/follow/sessionFollowOccurrenceDispatcher';
import { projectExecutionRunHostLoss } from '../../../../apps/cli/src/agent/runtime/bridges/executionRun/retainedState';
import { createSessionFollowContextReconciler } from '../../../../apps/cli/src/agent/runtime/session/follow/sessionFollowContextReconciler';
import { createSessionFollowSourceHydrator } from '../../../../apps/cli/src/agent/runtime/session/follow/sessionFollowSourceHydrator';
import { prepareSessionInputForProviderDispatch } from '../../../../apps/cli/src/agent/runtime/turns/prepareSessionInputForProviderDispatch';
import { createMutableApiSessionClientFixture, createSessionNotificationContextFixture,
    createAccountEncryptionCurrentnessFixture } from '../../../../apps/cli/src/testkit/backends/sessionFixtures';

let harness;
beforeAll(async () => {
    harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-follow-run-composed-', env: {
        HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED: 'true', HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
        HAPPIER_SERVER_IDENTITY_ID: 'srv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    } });
}, 180_000);
afterAll(async () => { await harness?.close(); });

it('carries the real host-loss original through dispatcher, server admission, retained Run hydration and final provider input', async () => {
    const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
    const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, installationId: randomUUID(),
        metadata: encodePlainMachineStoredContent({}), dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
        operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1] } }, operationProtocolCapabilitiesRevision: 1 } });
    const sessions = await Promise.all(['source', 'receiver'].map(tag => db.session.create({ data: {
        accountId: owner.id, tag: `${tag}-${randomUUID()}`, metadata: '{}', encryptionMode: 'plain', publisherGeneration: 1n, active: true,
    } })));
    const [sourceSession, receiver] = sessions;
    for (const session of sessions) {
        await db.accessKey.create({ data: { accountId: owner.id, sessionId: session.id, machineId: machine.id, data: 'opaque' } });
        await db.session.update({ where: { id: session.id }, data: { runtimeMachineTarget: {
            homeId: 'srv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', accountId: owner.id, sessionId: session.id,
            machineId: machine.id, installationId: machine.installationId,
        } } });
    }
    const state = { runId: 'followed-host-loss', callId: 'call', sidechainId: 'sidechain', sessionId: sourceSession.id, depth: 0,
        intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, backendId: 'codex', instructions: '',
        permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'bounded', ioMode: 'request_response',
        status: 'running', startedAtMs: 1, notifyParentOnCompletion: true };
    let retained = { state, terminalEventId: null };
    let online = true;
    let frontierReads = 0;
    const authentication = createPresentUserSessionAccessAuthentication({ env: {} });
    const app = createAuthenticatedTestApp();
    app.addHook('onRequest', async request => { request.headers['x-test-user-id'] = owner.id; });
    // Only the daemon network is substituted. Source admission, the current
    // publisher/target, frontier schema, routes and Pending storage remain real.
    app.decorate('forwardRpcForUser', async request => {
        frontierReads++;
        expect(request.params).toEqual({ sessionId: sourceSession.id, runId: state.runId });
        if (!online) return { ok: false, error: 'target_unavailable' };
        return { ok: true, result: { sessionId: sourceSession.id, runId: state.runId,
            status: retained.state.status, terminalEventId: retained.terminalEventId } };
    });
    registerSessionFollowSourceRoutes(app);
    registerSessionFollowRoutes(app);
    sessionPendingRoutes(app);
    // Incumbent CLI network fixtures own these ancillary transport shapes; no
    // source-content route is installed or read to deliver the terminal fact.
    app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ mode: 'plain' }));
    app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 0 }));
    app.get('/v2/sessions/:sessionId', async request => ({ session: {
        ...createSessionNotificationContextFixture(request.params.sessionId), ownerAccountId: owner.id,
        encryptionMode: 'plain', dataEncryptionKey: null, archivedAt: null, active: true,
        metadata: JSON.stringify({ path: '/work', host: 'test', machineId: machine.id }),
    } }));
    app.post('/v2/sessions/lookup-by-tags', async () => ({ sessions: [] }));
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const token = `e30.${Buffer.from(JSON.stringify({ sub: owner.id })).toString('base64url')}.fixture`;
    const dispatcher = createSessionFollowOccurrenceDispatcher({ accountId: owner.id, credentials: { token, encryption: null },
        serverId: 'test-home', serverHttpBaseUrl: baseUrl, machineId: machine.id, installationId: machine.installationId,
        signal: new AbortController().signal, isCurrent: async () => true, subscribeInvalidation: () => () => {},
        resolveSourceKeyContext: async () => null, isPersonalCurrent: () => false, dispatchPersonal: async () => {} });
    try {
        const source = { kind: 'execution_run', sessionId: sourceSession.id, runId: state.runId };
        const set = resolveSessionFollowActionRequest('follow.set', { receiver: { kind: 'session', sessionId: receiver.id },
            source, policy: { preset: 'important' } });
        const response = await app.inject({ method: 'PUT', url: set.path, payload: { policy: { preset: 'important' } } });
        expect(response.statusCode, response.body).toBe(200);
        retained = projectExecutionRunHostLoss({ state, ownerPid: 123 }, 2);
        const occurrence = resolveExecutionRunFollowOccurrenceV1({ sessionId: sourceSession.id, runId: state.runId,
            status: retained.state.status, terminalEventId: retained.terminalEventId });
        expect(occurrence.event).toEqual({ kind: 'failed_or_stopped' });
        await dispatcher.dispatch(occurrence);
        await dispatcher.dispatch(occurrence);
        const pending = await db.sessionPendingMessage.findMany({ where: { sessionId: receiver.id } });
        expect(pending).toHaveLength(1);
        const observe = async () => {
            const observed = await inTx(tx => observePendingSessionFollowForDestinationInTx(tx, { principal: {
                kind: 'destination_runtime', destinationRuntimeAccountId: owner.id, authentication,
            }, destinationSessionId: receiver.id, inputLocalIds: [pending[0].localId] }));
            const observations = await retainCurrentExecutionRunFollowObservations({ app, accountId: owner.id,
                authentication, observations: observed.observations });
            for (const observation of observations) SessionFollowPendingObservationV1Schema.parse(observation);
            return { ok: true, v: 1, sessionId: receiver.id, publisherGeneration: receiver.publisherGeneration.toString(),
                ...observed, observations };
        };
        const observed = await observe();
        expect(observed.observations).toMatchObject([{ kind: 'admitted_run_input', workerUpdate: {
            workerKind: 'execution_run', workerId: state.runId, ownerState: 'failed', canInspect: false,
            transcriptPointer: { kind: 'execution_run', sessionId: sourceSession.id, runId: state.runId },
        } }]);
        const session = createMutableApiSessionClientFixture({ sessionId: receiver.id, overrides: {
            observePendingSessionFollow: observe,
            acknowledgeSessionFollow: async () => { throw new Error('Provider has not accepted this input'); },
        } });
        const reconcile = createSessionFollowContextReconciler({ session, maxFollowContextUtf8Bytes: 8192,
            hydrateObservation: createSessionFollowSourceHydrator({ session, credentials: { token, encryption: null } }) });
        const followDeliveries = [{ delivery: observed.observations[0].delivery, localInputId: pending[0].localId, userMessageSeq: 1 }];
        const prepared = await reconcile({ signal: new AbortController().signal, followDeliveries });
        expect(prepared.workerUpdates).toHaveLength(1);
        const dispatch = await prepareSessionInputForProviderDispatch({ prompt: { text: 'Run changed', followDeliveries },
            transformedUserText: 'Run changed', providerNativeCommand: false, localId: pending[0].localId, signal: new AbortController().signal });
        const text = dispatch.renderPrompt({ workerUpdates: prepared.workerUpdates, runFollowDeliveries: followDeliveries });
        expect(text).toContain('owner_state="failed"');
        expect(text).not.toContain('Read the original Run result.');
        expect(await prepared.recheckAdmission(new AbortController().signal)).toBe(true);
        online = false;
        expect((await observe()).observations).toEqual([]);
        expect(await prepared.recheckAdmission(new AbortController().signal)).toBe(false);
        expect(await db.sessionPendingMessage.count({ where: { sessionId: receiver.id } })).toBe(1);
        expect(frontierReads).toBeGreaterThan(0);
    } finally {
        dispatcher.dispose();
        await app.close();
    }
});
