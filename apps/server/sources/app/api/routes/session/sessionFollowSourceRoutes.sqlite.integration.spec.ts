import { createHash, randomUUID } from 'node:crypto';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { decodeBase64 } from 'privacy-kit';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/storage/artifactStoredContent';
import { SessionFollowObserveInactiveResponseV1Schema, SessionFollowAdmittedRunInputAcknowledgeRequestV1Schema, SessionFollowPendingObservationV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { SessionFollowRunOccurrenceRoutesResponseV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourcesApi';
import { SessionFollowRelationWitnessesV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceOccurrenceV1';
import { SessionFollowInputV1Schema, deriveSessionFollowInputLocalIdV1, deriveSessionFollowOriginalOccurrenceKeyV1, type RunFollowOriginalV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { acknowledgeAdmittedSessionFollowInputInTx, observePendingSessionFollowForDestinationInTx } from '@/app/session/follow/sessionFollowEdgeService';
import { inTx } from '@/storage/inTx';
import { enqueuePendingMessage, enqueuePendingMessageByAuthenticatedMachine } from '@/app/session/pending/pendingMessageService';
import { parseSessionFollowActionResponse, resolveSessionFollowActionRequest } from '@happier-dev/protocol/sessions/follow/actionTransport';
import { sourceKeyForSessionFollowSourceV1 } from '@/app/session/follow/sessionFollowSourceIdentity';
import { setSessionManager } from '@/app/session/follow/sessionManagerService';
import { acceptAccountSessionFollowOnceDelivery, getAccountSessionFollow, removeAccountSessionFollow, setAccountSessionFollow } from '@/app/session/follow/accountFollowService';
import { changeDeliveryMute } from '@/app/session/follow/sessionDeliveryMuteService';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { SESSION_FOLLOW_PERSONAL_PROGRESS_ROUTE_V1, SessionFollowPersonalProgressResponseV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';
import type { ExecutionRunFollowFrontierResponse } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { resolveMachineAdmissionInTx, setMachineAccessGrantInTx } from '@/app/machines/machineAccess';
import { retainCurrentExecutionRunFollowObservations } from '@/app/session/follow/executionRunFollowSource';

import type { FastifyRequest } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';

import { createAuthenticatedTestApp } from '../../testkit/sqliteFastify';
import { registerSessionFollowSourceRoutes } from './registerSessionFollowSourceRoutes';
import { registerSessionFollowRoutes } from './registerSessionFollowRoutes';
import type { Fastify as AppFastify } from '@/app/api/types';
import { registerPublicShareReadRoutes } from '../share/registerPublicShareReadRoutes';
import { createPublicShareMessagesAccessToken, PUBLIC_SHARE_MESSAGES_ACCESS_TOKEN_HEADER, requirePublicShareAccessGrantSecret } from '../share/publicShareMessageAccessGrant';

async function createAccount() {
    return await db.account.create({ data: { publicKey: `pk-${randomUUID()}`, encryptionMode: 'plain' } });
}

async function createSession(accountId: string, overrides: Record<string, unknown> = {}) {
    return await db.session.create({
        data: { accountId, tag: `s-${randomUUID()}`, metadata: '{}', encryptionMode: 'plain', ...overrides },
    });
}

async function createPublishedMachine(accountId: string) {
    return await db.machine.create({ data: { id: randomUUID(), accountId,
        installationId: randomUUID(), metadata: encodePlainMachineStoredContent({
            host: 'host', platform: 'linux', happyCliVersion: 'test',
            homeDir: '/home/test', happyHomeDir: '/home/test/.happier',
        }), dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
}

async function buildApp(accountId: string, forwardRpcForUser?: AppFastify['forwardRpcForUser']) {
    const app = createAuthenticatedTestApp();
    if (forwardRpcForUser) app.decorate('forwardRpcForUser', forwardRpcForUser);
    app.addHook('onRequest', async (request: FastifyRequest) => { request.headers['x-test-user-id'] = accountId; });
    registerSessionFollowSourceRoutes(app);
    registerSessionFollowRoutes(app);
    registerPublicShareReadRoutes(app);
    await app.ready();
    return app;
}

describe('Session Follow source routes', () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: 'happier-session-follow-routes-',
            initEncrypt: true,
            env: { HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED: 'true',
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
                HAPPIER_SERVER_IDENTITY_ID: 'srv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        });
    }, 180_000);

    afterEach(async () => {
        await db.userKVStore.deleteMany();
        await db.sessionPendingMessage.deleteMany();
        await db.sessionMessage.deleteMany();
        await db.sessionFollowEdge.deleteMany();
        await db.accessKey.deleteMany();
        await db.machine.deleteMany();
        await db.sessionShare.deleteMany();
        await db.session.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => harness.close());

    it.each([
        { kind: 'terminal', ingress: 'account' }, { kind: 'permission', ingress: 'account' },
        { kind: 'workflow', ingress: 'account' }, { kind: 'permission', ingress: 'machine' },
    ] as const)('settles muted Run $kind originals through $ingress without replay after Undo, leaving another receiver unaffected', async ({ kind, ingress }) => {
        const owner = await createAccount();
        const parent = await createSession(owner.id, { publisherGeneration: 1n });
        const receivers = await Promise.all([createSession(owner.id), createSession(owner.id)]);
        const destination = receivers[0]!;
        const machine = await createPublishedMachine(owner.id);
        await db.machine.update({ where: { id: machine.id }, data: {
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1] } }, operationProtocolCapabilitiesRevision: 1,
        } });
        for (const session of [parent, ...receivers]) {
            await db.accessKey.create({ data: { accountId: owner.id, sessionId: session.id, machineId: machine.id, data: 'opaque' } });
            await db.session.update({ where: { id: session.id }, data: { runtimeMachineTarget: {
                homeId: 'srv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', accountId: owner.id, sessionId: session.id,
                machineId: machine.id, installationId: machine.installationId!,
            } } });
        }
        const workflow = await db.automationRun.create({ data: { accountId: owner.id, originKind: 'direct',
            automationId: null, causeKind: null, causeOccurredAt: null, workflowAcceptedSnapshotEnvelope: '{}',
            state: 'running', workflowCustodyState: 'pending', scheduledAt: new Date(), dueAt: new Date(), revision: 3 } });
        const source = kind === 'workflow' ? { kind: 'workflow_run' as const, runId: workflow.id }
            : { kind: 'execution_run' as const, sessionId: parent.id, runId: 'suppressed-run' };
        let version = 0;
        let online = true;
        const app = await buildApp(owner.id, async () => {
            if (!online) throw new Error('Machine transport disconnected');
            return { ok: true, result: { sessionId: parent.id, runId: source.runId,
                status: kind === 'terminal' && version > 0 ? 'succeeded' : 'running',
                terminalEventId: kind === 'terminal' && version > 0 ? `terminal-${version}` : null,
                ...(kind === 'permission' && version > 0 ? { attention: { kind: 'permission_required',
                    requestIds: ['approval'], requests: [{ requestId: 'approval', createdAt: version }] } } : {}),
            } };
        });
        const authentication = createPresentUserSessionAccessAuthentication({ env: {} });
        const receiver = { kind: 'session' as const, sessionId: destination.id };
        const mute = (operation: 'set' | 'remove') => changeDeliveryMute({ accountId: owner.id, authentication,
            receiver, scope: { kind: 'source', source }, operation });
        const read = async (original?: RunFollowOriginalV1) => {
            const response = await app.inject({ method: 'POST', url: SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1.runOccurrenceRoutes,
                payload: original ? { v: 1, original } : { v: 1, source } });
            expect(response.statusCode, response.body).toBe(200);
            return SessionFollowRunOccurrenceRoutesResponseV1Schema.parse(response.json());
        };
        const enqueue = async (observed: Awaited<ReturnType<typeof read>>, sessionId = destination.id) => {
            if (!observed.ok) throw new Error(observed.error);
            const route = observed.routes.find(row => row.destinationSessionId === sessionId);
            if (!route) throw new Error('Missing authorized Run route');
            const delivery = SessionFollowInputV1Schema.parse({ v: 1, original: observed.original, event: observed.event,
                delivery: kind === 'permission' ? 'wake' : 'next_turn' });
            const input = { sessionId, followSourceApp: app,
                localId: deriveSessionFollowInputLocalIdV1({ destinationSessionId: sessionId, original: delivery.original }),
                content: { t: 'plain' as const, v: { role: 'user', content: { type: 'text', text: 'Followed Run' } } },
                requestedAction: { v: 1 as const, kind: 'enqueue' as const }, followDeliveryV1: delivery,
                followRelations: SessionFollowRelationWitnessesV1Schema.parse([{ relation: route.relation, attachedAt: route.attachedAt,
                    source, ...('expectedRevision' in route ? { expectedRevision: route.expectedRevision }
                        : { expectedTerminalEventId: route.expectedTerminalEventId }) }]),
            };
            return ingress === 'machine' ? enqueuePendingMessageByAuthenticatedMachine({ ...input,
                accountId: owner.id, sourceMachineId: machine.id, targetMachineId: machine.id })
                : enqueuePendingMessage({ ...input, actorUserId: owner.id, authentication, messageRole: 'user' });
        };
        const rejected = ingress === 'machine' ? { status: 'rejected', code: 'session_input_muted' }
            : { ok: false, admissionRejectionCode: 'session_input_muted' };
        const accepted = ingress === 'machine' ? { status: 'accepted' } : { ok: true, didWrite: true };
        const repeated = ingress === 'machine' ? { status: 'alreadyAccepted' } : { ok: true, didWrite: false };
        try {
            for (const session of receivers) {
                const path = resolveSessionFollowActionRequest('follow.set', {
                    receiver: { kind: 'session', sessionId: session.id }, source, policy: { preset: 'important' },
                }).path;
                expect((await app.inject({ method: 'PUT', url: path, payload: { policy: { preset: 'important' } } })).statusCode).toBe(200);
            }
            expect(await mute('set')).toMatchObject({ ok: true });
            version = 1;
            await db.automationRun.update({ where: { id: workflow.id }, data: { revision: 4, state: 'succeeded' } });
            if (kind !== 'workflow') {
                online = false;
                expect((await app.inject({ method: 'POST', url: SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1.runOccurrenceRoutes,
                    payload: { v: 1, source } })).statusCode).toBe(409);
                expect(await db.sessionPendingMessage.count()).toBe(0);
                online = true;
            }
            await db.session.update({ where: { id: destination.id }, data: { deliveryMutes: 'malformed' } });
            const unknown = await read();
            expect(unknown.ok && unknown.routes.map(route => route.destinationSessionId)).toEqual([receivers[1]!.id]);
            await db.session.update({ where: { id: destination.id }, data: { deliveryMutes: null } });
            expect(await mute('set')).toMatchObject({ ok: true });
            const old = await read();
            expect(old.ok && old.routes.map(route => route.destinationSessionId).sort()).toEqual(receivers.map(row => row.id).sort());
            expect(await enqueue(old)).toMatchObject(rejected);
            expect(await enqueue(old, receivers[1]!.id)).toMatchObject(accepted);
            if (!old.ok) throw new Error(old.error);
            if ('output' in old.original) throw new Error('Ready outputs have no Session delivery route');
            const localId = deriveSessionFollowInputLocalIdV1({ destinationSessionId: destination.id, original: old.original });
            expect(await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: destination.id, localId } } }))
                .toMatchObject({ status: 'discarded', discardedReason: 'session_input_muted' });
            expect(await mute('remove')).toMatchObject({ ok: true });
            for (let attempt = 0; attempt < 2; attempt++) {
                const replay = await read(attempt === 0 ? old.original : undefined);
                expect(replay.ok && replay.routes.some(route => route.destinationSessionId === destination.id)).toBe(false);
                expect(await enqueue(old)).toMatchObject(ingress === 'machine' ? { status: 'rejected' } : { ok: false });
            }
            const principal = { kind: 'destination_runtime' as const, destinationRuntimeAccountId: owner.id, authentication };
            const pending = await inTx(tx => observePendingSessionFollowForDestinationInTx(tx, {
                principal, destinationSessionId: destination.id, inputLocalIds: [localId],
            }));
            // Permission originals have no terminal cursor. Retained suppressed
            // custody may still be projected, but can never select native intake.
            expect(pending.observations.every(observation => 'effectiveDelivery' in observation
                && observation.effectiveDelivery === null)).toBe(true);
            expect(await inTx(tx => acknowledgeAdmittedSessionFollowInputInTx(tx, { principal,
                request: SessionFollowAdmittedRunInputAcknowledgeRequestV1Schema.parse({ v: 1, destinationSessionId: destination.id,
                    localInputId: localId, expectedPublisherGeneration: destination.publisherGeneration.toString(), original: old.original,
                    acceptance: { kind: 'admitted_input', localInputId: localId, userMessageSeq: 1 } }),
            }))).toMatchObject({ ok: false });
            expect(await db.sessionMessage.count({ where: { sessionId: destination.id } })).toBe(0);
            version = 2;
            await db.automationRun.update({ where: { id: workflow.id }, data: { revision: 5 } });
            const fresh = await read();
            expect(await enqueue(fresh)).toMatchObject(accepted);
            expect(await enqueue(fresh)).toMatchObject(repeated);
            expect(await db.sessionPendingMessage.findMany({ where: { sessionId: destination.id }, orderBy: { position: 'asc' },
                select: { status: true, discardedReason: true } })).toEqual([
                { status: 'discarded', discardedReason: 'session_input_muted' }, { status: 'queued', discardedReason: null },
            ]);
        } finally { await app.close(); }
    });

    it.each([
        { kind: 'execution_run', outcome: 'succeeded' },
        { kind: 'execution_run', outcome: 'failed' },
        { kind: 'workflow_run', outcome: 'succeeded' },
    ] as const)('reads a stored $kind Follow at its exact $outcome original, respecting mute and removal', async ({ kind, outcome }) => {
        const owner = await createAccount();
        const parent = await createSession(owner.id, { publisherGeneration: 1n });
        const destination = await createSession(owner.id);
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
            installationId: randomUUID(), metadata: encodePlainMachineStoredContent({}),
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1] } }, operationProtocolCapabilitiesRevision: 1,
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
        await db.accessKey.create({ data: { accountId: owner.id, machineId: machine.id, sessionId: parent.id, data: 'opaque' } });
        await db.accessKey.create({ data: { accountId: owner.id, machineId: machine.id, sessionId: destination.id, data: 'opaque' } });
        await db.session.update({ where: { id: destination.id }, data: { runtimeMachineTarget: {
            homeId: 'srv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', accountId: owner.id, sessionId: destination.id,
            machineId: machine.id, installationId: machine.installationId! } } });
        await db.session.update({ where: { id: parent.id }, data: { runtimeMachineTarget: {
            homeId: 'srv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', accountId: owner.id, sessionId: parent.id,
            machineId: machine.id, installationId: machine.installationId! } } });
        const run = await db.automationRun.create({ data: { accountId: owner.id, originKind: 'direct',
            automationId: null, causeKind: null, causeOccurredAt: null,
            workflowAcceptedSnapshotEnvelope: '{}', state: 'running', workflowCustodyState: 'pending',
            scheduledAt: new Date(), dueAt: new Date(), revision: 3 } });
        let terminal = false;
        let online = true;
        let attention: ExecutionRunFollowFrontierResponse['attention'];
        const frontierRequests: string[] = [];
        const runtimeIssueV1 = { v: 1, scope: 'primary_session', status: 'failed', code: 'usage_limit', source: 'usage_limit',
            occurredAt: 1000, usageLimit: { v: 1, resetAtMs: 1_800_000, retryAfterMs: null, quotaScope: 'provider', recoverability: 'wait' } } as const;
        const app = await buildApp(owner.id, async request => {
            const params = request.params as { runId: string };
            frontierRequests.push(params.runId);
            if (!online) throw new Error('Machine transport disconnected');
            return { ok: true, result: {
                sessionId: parent.id, runId: params.runId, status: terminal ? outcome : 'running',
                terminalEventId: terminal ? 'terminal-original' : null,
                ...(terminal && outcome === 'failed' ? { runtimeIssueV1 } : {}),
                ...(attention ? { attention } : {}),
            } };
        });
        const source = kind === 'execution_run' ? { kind, sessionId: parent.id, runId: 'followed-run' }
            : { kind, runId: run.id };
        const receiver = { kind: 'session' as const, sessionId: destination.id };
        const policy = { preset: 'important' as const };
        const path = resolveSessionFollowActionRequest('follow.set', { receiver, source, policy }).path;
        const original = kind === 'execution_run' ? { source, terminalEventId: 'terminal-original' } : { source, revision: 4 };
        const read = () => app.inject({ method: 'POST', url: SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1.runOccurrenceRoutes,
            payload: { v: 1, original } });
        try {
            expect((await app.inject({ method: 'PUT', url: path, payload: { policy } })).statusCode).toBe(200);
            if (kind === 'execution_run') {
                const otherPath = resolveSessionFollowActionRequest('follow.set', { receiver,
                    source: { ...source, runId: 'unrelated-run' }, policy }).path;
                expect((await app.inject({ method: 'PUT', url: otherPath, payload: { policy } })).statusCode).toBe(200);
                frontierRequests.length = 0;
                const current = await app.inject({ method: 'GET', url: path });
                expect(current.statusCode, current.body).toBe(200);
                expect(current.json()).toMatchObject({ source: { sourceAvailability: 'available', hasPendingUpdates: false } });
                expect(frontierRequests).toEqual(['followed-run']);
                online = false;
                expect((await app.inject({ method: 'GET', url: path })).json()).toMatchObject({
                    source: { sourceAvailability: 'unavailable', hasPendingUpdates: null } });
                online = true;
                attention = { kind: 'permission_required', requestIds: ['approval-original'],
                    requests: [{ requestId: 'approval-original', createdAt: 1 }] };
                expect((await app.inject({ method: 'GET', url: path })).json()).toMatchObject({
                    source: { sourceAvailability: 'available', hasPendingUpdates: true } });
                attention = { kind: 'permission_required', requestIds: ['approval-original'] };
                expect((await app.inject({ method: 'GET', url: path })).json()).toMatchObject({
                    source: { sourceAvailability: 'available', hasPendingUpdates: null } });
                attention = undefined;
                frontierRequests.length = 0;
                const page = await app.inject({ method: 'GET', url: `/v2/sessions/${destination.id}/follows/sessions?limit=1` });
                expect(page.statusCode, page.body).toBe(200);
                expect(frontierRequests).toEqual([page.json().sources[0].source.runId]);
            }
            terminal = true;
            await db.automationRun.update({ where: { id: run.id }, data: { revision: 4, state: outcome } });
            const response = await read();
            expect(response.statusCode, response.body).toBe(200);
            if (kind === 'execution_run') {
                expect((await app.inject({ method: 'GET', url: path })).json()).toMatchObject({
                    source: { sourceAvailability: 'available', hasPendingUpdates: true } });
                const list = await app.inject({ method: 'GET', url: `/v2/sessions/${destination.id}/follows/sessions` });
                expect(list.json().sources).toContainEqual(expect.objectContaining({ source,
                    sourceAvailability: 'available', hasPendingUpdates: true }));
                const secondDestination = await createSession(owner.id);
                const secondPath = resolveSessionFollowActionRequest('follow.set', { receiver: { kind: 'session', sessionId: secondDestination.id },
                    source, policy }).path;
                expect((await app.inject({ method: 'PUT', url: secondPath, payload: { policy } })).statusCode).toBe(200);
                const reversePath = resolveSessionFollowActionRequest('follow.list', { direction: 'followers', source }).path;
                frontierRequests.length = 0;
                expect((await app.inject({ method: 'GET', url: reversePath })).json().sources).toContainEqual(
                    expect.objectContaining({ source, sourceAvailability: 'available', hasPendingUpdates: true }));
                expect(frontierRequests).toEqual(['followed-run']);
            }
            expect(SessionFollowRunOccurrenceRoutesResponseV1Schema.parse(response.json())).toMatchObject({
                ok: true, original, routes: [{ destinationSessionId: destination.id, policy,
                    ...(kind === 'execution_run' ? { expectedTerminalEventId: null } : { expectedRevision: 3 }) }],
            });
            const routes = SessionFollowRunOccurrenceRoutesResponseV1Schema.parse(response.json());
            if (!routes.ok) throw new Error('Expected admitted source routes');
            const route = routes.routes[0]!;
            const delivery = SessionFollowInputV1Schema.parse({ v: 1, original,
                event: { kind: outcome === 'succeeded' ? 'finished' : 'failed_or_stopped' },
                delivery: outcome === 'succeeded' ? 'next_turn' : 'wake' });
            const enqueue = () => enqueuePendingMessage({ actorUserId: owner.id, sessionId: destination.id,
                followSourceApp: app, authentication: createPresentUserSessionAccessAuthentication({ env: {} }),
                localId: deriveSessionFollowInputLocalIdV1({ destinationSessionId: destination.id, original: delivery.original }),
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Run finished' } } },
                messageRole: 'user', requestedAction: { v: 1, kind: 'enqueue' }, followDeliveryV1: delivery,
                followRelations: SessionFollowRelationWitnessesV1Schema.parse([{ relation: route.relation, source,
                    attachedAt: route.attachedAt, ...('expectedRevision' in route ? { expectedRevision: route.expectedRevision }
                        : { expectedTerminalEventId: route.expectedTerminalEventId }) }]),
            });
            const admitted = await enqueue();
            expect(admitted, JSON.stringify(admitted)).toMatchObject({ ok: true, didWrite: true });
            expect(await enqueue()).toMatchObject({ ok: true, didWrite: false });
            expect(await db.sessionPendingMessage.count({ where: { sessionId: destination.id } })).toBe(1);
            const pending = await db.sessionPendingMessage.findFirstOrThrow({ where: { sessionId: destination.id } });
            const principal = { kind: 'destination_runtime' as const, destinationRuntimeAccountId: owner.id,
                authentication: createPresentUserSessionAccessAuthentication({ env: {} }) };
            const observe = () => inTx(tx => observePendingSessionFollowForDestinationInTx(tx, {
                principal, destinationSessionId: destination.id, inputLocalIds: [pending.localId] }));
            expect((await observe()).observations).toContainEqual({ kind: 'admitted_run_input',
                destinationSessionId: destination.id, localInputId: pending.localId, delivery, effectiveDelivery: delivery.delivery });
            if (kind === 'execution_run') {
                const hydrate = async () => retainCurrentExecutionRunFollowObservations({ app, accountId: owner.id,
                    authentication: principal.authentication, observations: (await observe()).observations });
                const hydrated = await hydrate();
                expect(hydrated).toMatchObject([{ localInputId: pending.localId, workerUpdate: {
                    workerKind: 'execution_run', workerId: 'followed-run', ownerState: outcome, canInspect: false,
                    transcriptPointer: { kind: 'execution_run', sessionId: parent.id, runId: 'followed-run' },
                    ...(outcome === 'failed' ? { runtimeIssueV1 } : {}),
                } }]);
                for (const observation of hydrated) expect(SessionFollowPendingObservationV1Schema.safeParse(observation).success).toBe(true);
                online = false;
                expect(await hydrate()).toEqual([]);
                online = true;
            }
            const acknowledge = () => inTx(tx => acknowledgeAdmittedSessionFollowInputInTx(tx, { principal,
                request: SessionFollowAdmittedRunInputAcknowledgeRequestV1Schema.parse({ v: 1, destinationSessionId: destination.id, localInputId: pending.localId,
                    expectedPublisherGeneration: destination.publisherGeneration.toString(), original: delivery.original,
                    acceptance: { kind: 'admitted_input', localInputId: pending.localId, userMessageSeq: 1 } }) }));
            expect(await acknowledge()).toMatchObject({ ok: false, rejection: 'provider_acceptance_unverified' });
            // The persistent database is the native transport boundary here:
            // retain the real Pending receipt with its exact original acceptance.
            await db.sessionMessage.create({ data: { sessionId: destination.id, localId: pending.localId, seq: 1,
                messageRole: 'user', content: pending.content, inputAdmissionReceipt: pending.inputAdmissionReceipt!,
                acceptedFollowOriginalKey: deriveSessionFollowOriginalOccurrenceKeyV1(delivery.original),
                deliveryResolution: { v: 1, kind: 'provider_accepted', content: { t: 'plain', v: { v: 1,
                    acceptedAtMs: 1, delivery: { kind: 'newTurn', turnId: 'native-accepted-turn' } } } } } });
            await db.sessionPendingMessage.delete({ where: { id: pending.id } });
            expect(await acknowledge()).toMatchObject({ ok: true });
            expect(await acknowledge()).toMatchObject({ ok: true });
            if (kind === 'execution_run') expect((await app.inject({ method: 'GET', url: path })).json()).toMatchObject({
                source: { sourceAvailability: 'available', hasPendingUpdates: false } });
            expect((await read()).json()).toMatchObject({ ok: true, routes: [] });
            expect(await changeDeliveryMute({ accountId: owner.id, receiver, scope: { kind: 'source', source },
                operation: 'set', authentication: createPresentUserSessionAccessAuthentication({ env: {} }) })).toMatchObject({ ok: true });
            expect((await read()).json()).toMatchObject({ ok: true, routes: [] });
            expect((await app.inject({ method: 'DELETE', url: path })).statusCode).toBe(200);
            expect((await read()).json()).toMatchObject({ ok: true, routes: [] });
        } finally { await app.close(); }
    });

    it.each(['account', 'session'] as const)('keeps an exact retained Execution Run source for a %s receiver', async kind => {
        const owner = await createAccount();
        const parent = await createSession(owner.id, { publisherGeneration: 1n });
        const destination = await createSession(owner.id);
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
            installationId: randomUUID(), metadata: encodePlainMachineStoredContent({}),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
        await db.accessKey.create({ data: { accountId: owner.id, machineId: machine.id, sessionId: parent.id, data: 'opaque' } });
        await db.session.update({ where: { id: parent.id }, data: { runtimeMachineTarget: {
            homeId: 'srv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', accountId: owner.id, sessionId: parent.id,
            machineId: machine.id, installationId: machine.installationId! } } });
        const source = { kind: 'execution_run' as const, sessionId: parent.id, runId: `run_${randomUUID()}` };
        const receiver = kind === 'account' ? { kind: 'account' as const }
            : { kind: 'session' as const, sessionId: destination.id };
        const policy = { preset: 'important' as const };
        let online = true;
        let wrongRun = true;
        let permissionRequest: { requestId: string; createdAt: number } | null = null;
        const app = await buildApp(owner.id, async () => {
            if (!online) throw new Error('Machine transport disconnected');
            return { ok: true, result: {
                sessionId: parent.id, runId: wrongRun ? 'another-run' : source.runId,
                status: permissionRequest ? 'running' : 'succeeded', terminalEventId: permissionRequest ? null : 'retained-terminal',
                ...(permissionRequest ? { attention: { kind: 'permission_required', requestIds: [permissionRequest.requestId],
                    requests: [permissionRequest] } } : {}),
            } };
        });
        const path = resolveSessionFollowActionRequest('follow.set', { receiver, source, policy }).path;
        try {
            // Parent readability alone cannot fabricate Run identity or seed its original frontier.
            expect((await app.inject({ method: 'PUT', url: path, payload: { policy } })).statusCode).toBe(409);
            wrongRun = false;
            const saved = await app.inject({ method: 'PUT', url: path, payload: { policy } });
            expect(saved.statusCode, saved.body).toBe(200);
            const parsed = parseSessionFollowActionResponse('follow.set', { receiver, source, policy }, saved.json());
            expect(parsed).toMatchObject(kind === 'account' ? { follow: { source, policy } } : { source: { source, policy } });
            permissionRequest = { requestId: 'current-permission', createdAt: 1 };
            const permissionOriginal = { source, permissionRequests: [permissionRequest] };
            const permissionObservation = SessionFollowPendingObservationV1Schema.parse({ kind: 'admitted_run_input',
                localInputId: deriveSessionFollowInputLocalIdV1({ destinationSessionId: destination.id, original: permissionOriginal }),
                destinationSessionId: destination.id, effectiveDelivery: 'wake',
                delivery: { v: 1, original: permissionOriginal, delivery: 'wake', event: { kind: 'needs_you', type: 'approval' } } });
            const recheckPermission = () => retainCurrentExecutionRunFollowObservations({ app, accountId: owner.id,
                authentication: createPresentUserSessionAccessAuthentication({ env: {} }), observations: [permissionObservation] });
            expect(await recheckPermission()).toEqual([permissionObservation]);
            permissionRequest = null;
            expect(await recheckPermission()).toEqual([{ ...permissionObservation, disposition: 'withdrawn', effectiveDelivery: null }]);
            const key = sourceKeyForSessionFollowSourceV1(source);
            const row = kind === 'account'
                ? await db.accountSessionFollow.findUnique({ where: { accountId_sourceKey: { accountId: owner.id, sourceKey: key } } })
                : await db.sessionFollowEdge.findUnique({ where: { destinationSessionId_sourceKey_relation: {
                    destinationSessionId: destination.id, sourceKey: key, relation: 'follower' } } });
            expect(row).toMatchObject({ sourceExecutionRunSessionId: parent.id, sourceExecutionRunId: source.runId,
                deliveredExecutionRunTerminalEventId: 'retained-terminal' });
            expect(parseSessionFollowActionResponse('follow.get', { receiver, source },
                (await app.inject({ method: 'GET', url: path })).json()))
                .toMatchObject(kind === 'account' ? { follow: { source } } : { source: { source } });
            const listInput = { direction: 'following' as const, receiver };
            const listed = await app.inject({ method: 'GET', url: resolveSessionFollowActionRequest('follow.list', listInput).path });
            expect(parseSessionFollowActionResponse('follow.list', listInput, { ...listed.json(), rules: [],
                ...(kind === 'account' ? { sources: [] } : { follows: [] }), coverage: 'complete' }))
                .toMatchObject(kind === 'account' ? { follows: [{ source }] } : { sources: [{ source }] });
            const reverseInput = { direction: 'followers' as const, source, limit: 1 };
            const reverse = await app.inject({ method: 'GET', url: resolveSessionFollowActionRequest('follow.list', reverseInput).path });
            expect(reverse.statusCode, reverse.body).toBe(200);
            expect(parseSessionFollowActionResponse('follow.list', reverseInput, reverse.json()))
                .toMatchObject(kind === 'account' ? { peopleCount: 1, follows: [{ source }] }
                    : { sources: [{ source, destinationSessionId: destination.id }] });
            online = false;
            expect((await app.inject({ method: 'PUT', url: path, payload: { policy: { preset: 'quiet' } } })).statusCode).toBe(200);
            expect((await app.inject({ method: 'DELETE', url: path })).json()).toEqual({ changed: true });
            if (kind === 'account') {
                // Restoring an opt-out needs a fresh frontier, while editing an active choice does not.
                expect((await app.inject({ method: 'PUT', url: path, payload: { policy } })).statusCode).toBe(409);
            }
        } finally { await app.close(); }
    });

    it('discloses only the admitted Session Run target to opted-in authorized readers', async () => {
        const owner = await createAccount();
        const other = await createAccount();
        const parent = await createSession(owner.id, { publisherGeneration: 1n,
            metadata: JSON.stringify({ machineId: 'untrusted-metadata-target' }) });
        const target = await createPublishedMachine(owner.id);
        const alternate = await createPublishedMachine(owner.id);
        for (const machine of [alternate, target]) await db.accessKey.create({ data: {
            accountId: owner.id, machineId: machine.id, sessionId: parent.id, data: 'opaque' } });
        const committedTarget = { homeId: 'srv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', accountId: owner.id,
            sessionId: parent.id, machineId: target.id, installationId: target.installationId! };
        await db.session.update({ where: { id: parent.id }, data: { runtimeMachineTarget: committedTarget } });
        const source = { kind: 'execution_run' as const, sessionId: parent.id, runId: `run_${randomUUID()}` };
        let actorId = owner.id;
        let withdrawAccess = false;
        const methods: string[] = [];
        const app = createAuthenticatedTestApp();
        app.addHook('onRequest', async (request: FastifyRequest) => { request.headers['x-test-user-id'] = actorId; });
        app.decorate('forwardRpcForUser', async (request: Parameters<AppFastify['forwardRpcForUser']>[0]) => {
            methods.push(request.method);
            if (withdrawAccess) await db.session.update({ where: { id: parent.id }, data: { accountId: other.id } });
            return { ok: false, error: 'PRIVATE_RPC_FAILURE', errorCode: 'RPC_METHOD_NOT_AVAILABLE' };
        });
        const completions: unknown[] = [];
        app.addHook('onResponse', async (request: FastifyRequest) => { completions.push(request.followSourceRoute); });
        registerSessionFollowSourceRoutes(app);
        const read = (query = '') => app.inject({ method: 'POST',
            url: `${SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1.runOccurrenceRoutes}${query}`,
            headers: { 'x-test-auth-token-kind': 'terminal' }, payload: { v: 1, source } });
        const refusal = { ok: false, v: 1, error: 'source_unavailable' };
        try {
            // No opt-in preserves the refusal admitted by prior strict readers.
            const legacy = await read();
            expect(legacy.statusCode).toBe(409);
            expect(legacy.json()).toEqual(refusal);
            const optedIn = await read('?includeTargetMachineId=true&releaseReason=target_machine');
            expect(optedIn.statusCode).toBe(409);
            expect(optedIn.json()).toEqual({ ...refusal, targetMachineId: target.id });
            expect(SessionFollowRunOccurrenceRoutesResponseV1Schema.safeParse(optedIn.json()).success).toBe(true);
            expect(completions.at(-1)).toMatchObject({ sourceTargetMachineId: target.id, releaseReason: 'target_machine' });
            expect(methods).toEqual(Array.from({ length: 2 }, () => `${target.id}:${SESSION_RPC_METHODS.EXECUTION_RUN_FOLLOW_FRONTIER}`));

            actorId = other.id;
            const denied = await read('?includeTargetMachineId=true');
            expect(denied.statusCode).toBe(403);
            expect(denied.json()).toEqual({ ok: false, v: 1, error: 'forbidden' });
            expect(methods).toHaveLength(2);
            actorId = owner.id;
            withdrawAccess = true;
            const withdrawn = await read('?includeTargetMachineId=true');
            expect(withdrawn.statusCode).toBe(403);
            expect(withdrawn.json()).toEqual({ ok: false, v: 1, error: 'forbidden' });
            withdrawAccess = false;
            await db.session.update({ where: { id: parent.id }, data: { accountId: owner.id,
                runtimeMachineTarget: { ...committedTarget, installationId: 'stale-installation' } } });
            const stale = await read('?includeTargetMachineId=true');
            expect(stale.statusCode).toBe(409);
            expect(stale.json()).toEqual(refusal);
            expect(methods).toHaveLength(3);
            const malformed = await read('?includeTargetMachineId=true&releaseReason=PRIVATE_UNTRUSTED_REASON');
            expect(malformed.statusCode).toBe(400);
            expect(malformed.json()).toEqual({ ok: false, v: 1, error: 'invalid_request' });
            expect(JSON.stringify(completions)).not.toContain('PRIVATE_');
        } finally { await app.close(); }
    });

    it.each(['target_unavailable', 'rpc_unavailable', 'rpc_unknown', 'rpc_exception', 'rpc_invalid', 'frontier_not_current',
        'no_occurrence', 'frontier_incomplete', 'terminal_absent', 'requested_absent', 'original_mismatch', 'terminal'] as const)(
        'attributes a daemon Run route completion for %s without payloads or retries', async state => {
        const owner = await createAccount();
        const parent = await createSession(owner.id, { publisherGeneration: 1n });
        const machine = await createPublishedMachine(owner.id);
        await db.accessKey.create({ data: { accountId: owner.id, machineId: machine.id, sessionId: parent.id, data: 'opaque' } });
        if (state !== 'target_unavailable') await db.session.update({ where: { id: parent.id }, data: { runtimeMachineTarget: {
            homeId: 'srv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', accountId: owner.id, sessionId: parent.id,
            machineId: machine.id, installationId: machine.installationId! } } });
        const source = { kind: 'execution_run' as const, sessionId: parent.id, runId: `run_${randomUUID()}` };
        let rpcReads = 0;
        const app = createAuthenticatedTestApp();
        app.addHook('onRequest', async (request: FastifyRequest) => { request.headers['x-test-user-id'] = owner.id; });
        app.decorate('forwardRpcForUser', async () => {
            rpcReads += 1;
            if (state === 'rpc_unavailable') return { ok: false, error: 'PRIVATE_RPC_FAILURE', errorCode: 'RPC_METHOD_NOT_AVAILABLE' };
            if (state === 'rpc_unknown') return { ok: false, error: 'PRIVATE_RPC_FAILURE', errorCode: 'PRIVATE_RPC_CODE' };
            if (state === 'rpc_exception') throw new Error('PRIVATE_RPC_FAILURE');
            if (state === 'rpc_invalid') return { ok: true, result: { private: 'PRIVATE_RPC_PAYLOAD' } };
            if (state === 'frontier_not_current') await db.session.update({ where: { id: parent.id },
                data: { publisherGeneration: 2n } });
            return { ok: true, result: { sessionId: parent.id, runId: source.runId,
                status: state === 'no_occurrence' || state === 'requested_absent' || state === 'frontier_incomplete' ? 'running' : 'succeeded',
                terminalEventId: state === 'no_occurrence' || state === 'requested_absent' || state === 'frontier_incomplete'
                    || state === 'terminal_absent' ? null : 'terminal-original',
                ...(state === 'frontier_incomplete' ? { attention: { kind: 'permission_required', requestIds: ['unbound-request'] } } : {}) } };
        });
        const completions: unknown[] = [];
        app.addHook('onResponse', async (request: FastifyRequest) => { completions.push(request.followSourceRoute); });
        registerSessionFollowSourceRoutes(app);
        try {
            const response = await app.inject({ method: 'POST', url: SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1.runOccurrenceRoutes,
                headers: { 'x-test-auth-token-kind': 'terminal' }, payload: state === 'original_mismatch' || state === 'requested_absent'
                    ? { v: 1, original: { source, terminalEventId: 'superseded-original' } } : { v: 1, source } });
            expect(response.statusCode).toBe(state === 'terminal' ? 200 : state === 'no_occurrence' ? 204 : 409);
            if (state === 'no_occurrence') expect(response.body).toBe('');
            else expect(response.json()).toMatchObject(state === 'terminal' ? { ok: true, original: { source,
                terminalEventId: 'terminal-original' }, routes: [] } : { ok: false, error: 'source_unavailable' });
            expect(completions).toEqual([{ sourceKind: 'execution_run', sourceSessionId: parent.id, sourceRunId: source.runId,
                ...(state === 'target_unavailable' ? {} : { sourceTargetMachineId: machine.id }),
                ...(state === 'rpc_unavailable' ? { sourceRpcCode: 'RPC_METHOD_NOT_AVAILABLE' }
                    : state === 'rpc_unknown' ? { sourceRpcCode: 'unknown' } : state === 'rpc_exception' ? { sourceRpcCode: 'exception' } : {}),
                resultCode: state === 'terminal' || state === 'no_occurrence' ? 'ok' : 'source_unavailable',
                sourceReadCode: state === 'terminal' ? 'ready' : state === 'no_occurrence' || state === 'requested_absent'
                    ? 'occurrence_absent' : state === 'rpc_unknown' || state === 'rpc_exception' ? 'rpc_unavailable'
                        : state === 'frontier_incomplete' || state === 'terminal_absent' ? 'frontier_unavailable' : state }]);
            expect(rpcReads).toBe(state === 'target_unavailable' ? 0 : 1);
            expect(JSON.stringify(completions)).not.toContain('PRIVATE_');
            expect(await db.sessionPendingMessage.count({ where: { sessionId: parent.id } })).toBe(0);
        } finally { await app.close(); }
    });

    it('reads a Session-backed Run on a shared Machine through its actual custodian transport', async () => {
        const owner = await createAccount();
        const custodian = await createAccount();
        const parent = await createSession(owner.id, { publisherGeneration: 1n });
        const machine = await createPublishedMachine(custodian.id);
        expect(await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: machine.id,
            principal: { kind: 'account', accountId: owner.id }, level: 'view' }))).toMatchObject({ kind: 'saved' });
        expect(await inTx(tx => resolveMachineAdmissionInTx(tx, { actorAccountId: owner.id, machineId: machine.id })))
            .toMatchObject({ kind: 'admitted', custodianAccountId: custodian.id });
        await db.accessKey.create({ data: { accountId: owner.id, machineId: machine.id, sessionId: parent.id, data: 'opaque' } });
        await db.session.update({ where: { id: parent.id }, data: { runtimeMachineTarget: {
            homeId: 'srv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', accountId: owner.id, sessionId: parent.id,
            machineId: machine.id, installationId: machine.installationId! } } });
        const source = { kind: 'execution_run' as const, sessionId: parent.id, runId: `run_${randomUUID()}` };
        const input = { receiver: { kind: 'account' as const }, source, once: [{ kind: 'run_settled' as const }] };
        const forwardedAccounts: string[] = [];
        const app = await buildApp(owner.id, async rpc => {
            forwardedAccounts.push(rpc.userId);
            // The real relay has no method room under the requester's Account.
            if (rpc.userId !== custodian.id) return { ok: false, error: 'RPC target unavailable' };
            expect(rpc.method).toBe(`${machine.id}:${SESSION_RPC_METHODS.EXECUTION_RUN_FOLLOW_FRONTIER}`);
            expect(rpc.params).toEqual({ sessionId: parent.id, runId: source.runId });
            return { ok: true, result: { sessionId: parent.id, runId: source.runId,
                status: 'succeeded', terminalEventId: 'foreign-machine-terminal' } };
        });
        try {
            const response = await app.inject({ method: 'PUT', url: resolveSessionFollowActionRequest('follow.set', input).path,
                payload: { once: input.once } });
            expect(forwardedAccounts).toEqual([custodian.id]);
            expect(response.statusCode, response.body).toBe(200);
            expect(parseSessionFollowActionResponse('follow.set', input, response.json()))
                .toMatchObject({ follow: { source, once: input.once } });
        } finally { await app.close(); }
    });

    it.each(['account', 'session'] as const)('admits a detached Machine Run through the real %s Follow transport', async kind => {
        const owner = await createAccount();
        const foreign = await createAccount();
        const destination = kind === 'session' ? await createSession(owner.id) : null;
        const machine = await createPublishedMachine(owner.id);
        const source = { kind: 'execution_run' as const, machineId: machine.id, runId: `run_${randomUUID()}` };
        const receiver = destination ? { kind: 'session' as const, sessionId: destination.id } : { kind: 'account' as const };
        const policy = { preset: 'important' as const };
        let reads = 0;
        let wrongMachine = true;
        const app = await buildApp(owner.id, async input => {
            reads += 1;
            expect(input.method).toBe(`${machine.id}:${SESSION_RPC_METHODS.EXECUTION_RUN_FOLLOW_FRONTIER}`);
            expect(input.params).toEqual({ machineId: machine.id, runId: source.runId });
            return { ok: true, result: { machineId: wrongMachine ? 'another-machine' : machine.id, sessionId: null, runId: source.runId,
                status: 'succeeded', terminalEventId: 'detached-terminal' } };
        });
        const otherApp = await buildApp(foreign.id, async () => { throw new Error('Foreign Machine must not be read'); });
        try {
            const path = resolveSessionFollowActionRequest('follow.set', { receiver, source, policy }).path;
            expect((await app.inject({ method: 'PUT', url: path, payload: { policy } })).statusCode).toBe(409);
            wrongMachine = false;
            const saved = await app.inject({ method: 'PUT', url: path, payload: { policy } });
            expect(saved.statusCode, saved.body).toBe(200);
            expect(reads).toBe(2);
            const key = sourceKeyForSessionFollowSourceV1(source);
            const row = destination
                ? await db.sessionFollowEdge.findUnique({ where: { destinationSessionId_sourceKey_relation: {
                    destinationSessionId: destination.id, sourceKey: key, relation: 'follower' } } })
                : await db.accountSessionFollow.findUnique({ where: { accountId_sourceKey: { accountId: owner.id, sourceKey: key } } });
            expect(row).toMatchObject({ sourceExecutionRunSessionId: null, sourceExecutionRunMachineId: machine.id,
                sourceExecutionRunId: source.runId, deliveredExecutionRunTerminalEventId: 'detached-terminal' });
            const opened = await app.inject({ method: 'GET', url: path });
            expect(opened.statusCode, opened.body).toBe(200);
            expect(parseSessionFollowActionResponse('follow.get', { receiver, source }, opened.json()))
                .toMatchObject(destination ? { source: { source, sourceAvailability: 'available', hasPendingUpdates: false } } : { follow: { source } });
            // Session-edge availability needs one current retained-source read;
            // the personal Account policy DTO makes no availability claim.
            expect(reads).toBe(destination ? 3 : 2);
            const foreignPath = resolveSessionFollowActionRequest('follow.set', {
                receiver: { kind: 'account' }, source, policy }).path;
            expect((await otherApp.inject({ method: 'PUT', url: foreignPath, payload: { policy } })).statusCode).toBe(404);
            expect(await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: owner.id, machineId: machine.id,
                principal: { kind: 'account', accountId: foreign.id }, level: 'view' }))).toMatchObject({ kind: 'saved' });
            expect(await inTx(tx => resolveMachineAdmissionInTx(tx, { actorAccountId: foreign.id, machineId: machine.id })))
                .toMatchObject({ kind: 'admitted', role: 'use' });
            // General Machine access does not grant the custodian's private Run inventory.
            expect((await otherApp.inject({ method: 'PUT', url: foreignPath, payload: { policy } })).statusCode).toBe(404);
            expect(reads).toBe(destination ? 3 : 2);
            if (destination) {
                await db.sessionShare.create({ data: { sessionId: destination.id, sharedByUserId: owner.id,
                    sharedWithUserId: foreign.id, accessLevel: 'view' } });
                const shared = await app.inject({ method: 'PUT', url: path, payload: { policy } });
                expect(shared.statusCode, shared.body).toBe(403);
                await db.sessionShare.deleteMany({ where: { sessionId: destination.id } });
            }
            const readsBeforeRevoke = reads;
            await db.machine.update({ where: { id: machine.id }, data: { revokedAt: new Date() } });
            const revoked = await app.inject({ method: 'GET', url: path });
            expect(revoked.statusCode).toBe(destination ? 200 : 404);
            if (destination) expect(revoked.json()).toEqual({ source: null });
            expect(reads).toBe(readsBeforeRevoke);
        } finally { await app.close(); await otherApp.close(); }
    });

    it('accepts exactly one selected detached output through HTTP while preserving other intents and persistent policy', async () => {
        const owner = await createAccount();
        const machine = await createPublishedMachine(owner.id);
        const source = { kind: 'execution_run' as const, machineId: machine.id, runId: `run_${randomUUID()}` };
        const receiver = { kind: 'account' as const };
        const policy = { preset: 'important' as const };
        const outputRef = { kind: 'scm_diff_summary' as const, output: 'commitPlan' as const,
            comparisonId: 'selected-comparison', resultId: 'selected-result' };
        const otherRef = { ...outputRef, output: 'walkthrough' as const };
        const selected = { kind: 'output_ready' as const, outputRef, afterRevision: 4 };
        const other = { kind: 'output_ready' as const, outputRef: otherRef, afterRevision: 9 };
        let outputs: NonNullable<ExecutionRunFollowFrontierResponse['outputs']> = [
            { outputRef, revision: 4, state: 'writing' }, { outputRef: otherRef, revision: 9, state: 'writing' },
        ];
        const requestedOutputs: unknown[] = [];
        const app = await buildApp(owner.id, async input => {
            expect(input.method).toBe(`${machine.id}:${SESSION_RPC_METHODS.EXECUTION_RUN_FOLLOW_FRONTIER}`);
            requestedOutputs.push(input.params);
            return { ok: true, result: { machineId: machine.id, sessionId: null, runId: source.runId,
                status: 'running', terminalEventId: null, outputs } };
        });
        const path = resolveSessionFollowActionRequest('follow.set', { receiver, source, policy }).path;
        const read = async () => parseSessionFollowActionResponse('follow.get', { receiver, source },
            (await app.inject({ method: 'GET', url: path })).json());
        const progress = async (revision: number) => {
            const response = await app.inject({ method: 'POST', url: SESSION_FOLLOW_PERSONAL_PROGRESS_ROUTE_V1,
                payload: { original: { source, output: { outputRef, revision, state: 'complete' } } } });
            expect(response.statusCode, response.body).toBe(200);
            return SessionFollowPersonalProgressResponseV1Schema.parse(response.json());
        };
        try {
            expect((await app.inject({ method: 'PUT', url: path, payload: { policy } })).statusCode).toBe(200);
            const armed = await app.inject({ method: 'PUT', url: path, payload: { once: [selected, other] } });
            expect(armed.statusCode, armed.body).toBe(200);
            expect(parseSessionFollowActionResponse('follow.set', { receiver, source, once: [selected, other] }, armed.json()))
                .toMatchObject({ follow: { policy, once: [selected, other] } });
            expect(requestedOutputs.at(-1)).toEqual({ machineId: machine.id, runId: source.runId, outputRefs: [outputRef, otherRef] });
            const observeOutput = () => app.inject({ method: 'POST', url: SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1.runOccurrenceRoutes,
                payload: { v: 1, source, outputRef } });
            const writing = await observeOutput();
            expect(writing.statusCode).toBe(204);
            expect(writing.body).toBe('');
            const knownOutputs = outputs;
            outputs = [];
            expect((await observeOutput()).statusCode).toBe(409);
            outputs = knownOutputs;
            expect(await read()).toMatchObject({ follow: { policy, once: [selected, other] } });
            outputs = [{ outputRef, revision: 5, state: 'complete' }, { outputRef: otherRef, revision: 9, state: 'writing' }];
            const ready = await observeOutput();
            expect(ready.statusCode).toBe(200);
            expect(ready.json()).toMatchObject({ ok: true, original: { source, output: { outputRef, revision: 5, state: 'complete' } }, routes: [] });
            expect(await progress(4)).toEqual({ accepted: false, alreadyRepresented: false });
            expect(await progress(5)).toEqual({ accepted: true, alreadyRepresented: false });
            expect(await progress(5)).toEqual({ accepted: true, alreadyRepresented: true });
            expect(await read()).toMatchObject({ follow: { source, policy, once: [other], onceDeliveries: [{
                original: { source, output: { outputRef, revision: 5, state: 'complete' } }, event: { kind: 'update_posted' },
            }] } });
            // Editing another control is not an acknowledgement of this accepted output.
            expect((await app.inject({ method: 'PUT', url: path, payload: { once: [other] } })).statusCode).toBe(200);
            expect(await read()).toMatchObject({ follow: { onceDeliveries: [{
                original: { source, output: { outputRef, revision: 5, state: 'complete' } },
            }] } });
            // Clearing the accepted receipt must not remove the other selected output or the persistent Follow.
            const cleared = await app.inject({ method: 'PUT', url: path, payload: { once: [other], clearOnceDeliveries: true } });
            expect(cleared.statusCode, cleared.body).toBe(200);
            const remaining = await read();
            expect(remaining).toMatchObject({ follow: { source, policy, once: [other] } });
            expect('follow' in remaining && remaining.follow && 'onceDeliveries' in remaining.follow).toBe(false);
        } finally { await app.close(); }
    });

    it('authors one exact Discussion source through the existing Follow edge', async () => {
        const owner = await createAccount();
        const destination = await createSession(owner.id);
        const discussion = await db.discussion.create({ data: {
            ownerAccountId: owner.id, encryptionMode: 'plain',
            dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER),
            creationLocalId: randomUUID(), creationEqualityEvidenceV1: {},
            titleContent: { t: 'plain', v: 'Discussion' }, lastMessageAt: new Date(), messageSeq: 3,
        } });
        await db.discussionParticipant.create({ data: { discussionId: discussion.id,
            participantSlotId: 'participant-1', sessionId: destination.id } });
        const app = await buildApp(owner.id);
        const source = { kind: 'discussion' as const, discussionId: discussion.id };
        const receiver = { kind: 'session' as const, sessionId: destination.id };
        const input = { receiver, source, policy: { preset: 'everything' as const } };
        const path = resolveSessionFollowActionRequest('follow.set', input).path;
        try {
            const set = await app.inject({ method: 'PUT', url: path, payload: { policy: input.policy } });
            expect(set.statusCode).toBe(200);
            expect(parseSessionFollowActionResponse('follow.set', input, set.json())).toMatchObject({
                changed: true, source: { source, destinationSessionId: destination.id, hasPendingUpdates: false,
                    sourceAvailability: 'available' },
            });
            expect(await db.sessionFollowEdge.findUnique({ where: { destinationSessionId_sourceKey_relation: {
                destinationSessionId: destination.id, sourceKey: sourceKeyForSessionFollowSourceV1(source), relation: 'follower',
            } } })).toMatchObject({ sourceDiscussionId: discussion.id, sourceSessionId: null, deliveredTranscriptSeq: 3 });
            const get = await app.inject({ method: 'GET', url: path });
            expect(parseSessionFollowActionResponse('follow.get', { receiver, source }, get.json())).toMatchObject({
                source: { source, policy: input.policy },
            });
            const listInput = { direction: 'following' as const, receiver };
            const listRequest = resolveSessionFollowActionRequest('follow.list', listInput);
            const listed = await app.inject({ method: listRequest.method, url: listRequest.path });
            expect(listed.statusCode).toBe(200);
            expect(listed.json().sources).toEqual([expect.objectContaining({ source })]);
            const removed = await app.inject({ method: 'DELETE', url: path });
            expect(parseSessionFollowActionResponse('follow.remove', { receiver, source }, removed.json())).toEqual({ changed: true });
            expect((await app.inject({ method: 'GET', url: path })).json()).toEqual({ source: null });
        } finally { await app.close(); }
    });

    it('authors a Workflow Run from its current revision and lists only later progress', async () => {
        const owner = await createAccount();
        const destination = await createSession(owner.id);
        const run = await db.automationRun.create({ data: { accountId: owner.id, originKind: 'direct',
            automationId: null, causeKind: null, causeOccurredAt: null,
            workflowAcceptedSnapshotEnvelope: '{}', state: 'running', workflowCustodyState: 'pending',
            scheduledAt: new Date(), dueAt: new Date(), revision: 3 } });
        const app = await buildApp(owner.id);
        const source = { kind: 'workflow_run' as const, runId: run.id };
        const receiver = { kind: 'session' as const, sessionId: destination.id };
        const policy = { preset: 'everything' as const };
        const path = resolveSessionFollowActionRequest('follow.set', { receiver, source, policy }).path;
        try {
            const saved = await app.inject({ method: 'PUT', url: path, payload: { policy } });
            expect(saved.statusCode, saved.body).toBe(200);
            expect(parseSessionFollowActionResponse('follow.set', { receiver, source, policy }, saved.json()))
                .toMatchObject({ changed: true, source: { source, sourceAvailability: 'available', hasPendingUpdates: false } });
            expect(await db.sessionFollowEdge.findUnique({ where: { destinationSessionId_sourceKey_relation: {
                destinationSessionId: destination.id, sourceKey: sourceKeyForSessionFollowSourceV1(source), relation: 'follower',
            } } })).toMatchObject({ sourceSessionId: null, sourceWorkflowRunId: run.id, deliveredWorkflowRunRevision: 3 });
            await db.automationRun.update({ where: { id: run.id }, data: { revision: 4 } });
            const get = await app.inject({ method: 'GET', url: path });
            expect(parseSessionFollowActionResponse('follow.get', { receiver, source }, get.json()))
                .toMatchObject({ source: { source, hasPendingUpdates: true } });
            const listInput = { direction: 'following' as const, receiver };
            const listRequest = resolveSessionFollowActionRequest('follow.list', listInput);
            const listed = await app.inject({ method: listRequest.method, url: listRequest.path });
            expect(listed.statusCode, listed.body).toBe(200);
            expect(listed.json().sources).toEqual([expect.objectContaining({ source })]);
            expect((await app.inject({ method: 'DELETE', url: path })).json()).toEqual({ changed: true });
            expect((await app.inject({ method: 'GET', url: path })).json()).toEqual({ source: null });
        } finally { await app.close(); }
    });

    it('reads authorized Session followers and anonymous people only, readmitting source and receiver access', async () => {
        const owner = await createAccount();
        const viewer = await createAccount();
        const source = await createSession(owner.id);
        const visible = await createSession(owner.id);
        const hidden = await createSession(owner.id);
        const authentication = createPresentUserSessionAccessAuthentication({ env: {} });
        const app = await buildApp(owner.id);
        const viewerApp = await buildApp(viewer.id);
        try {
            for (const destination of [visible, hidden]) expect((await app.inject({ method: 'PUT',
                url: `/v2/sessions/${destination.id}/follows/sessions/${source.id}`, payload: { policy: { preset: 'quiet' } } })).statusCode).toBe(200);
            expect(await setSessionManager({ accountId: owner.id, sessionId: source.id, managerSessionId: visible.id,
                expectedManagerSessionId: null, authentication })).toMatchObject({ ok: true });
            for (const session of [source, visible]) await db.sessionShare.create({ data: { sessionId: session.id,
                sharedByUserId: owner.id, sharedWithUserId: viewer.id, accessLevel: 'view' } });
            for (const account of [owner, viewer]) expect(await setAccountSessionFollow({ accountId: account.id,
                sessionId: source.id, preferences: { policy: { preset: 'quiet' } }, authentication })).toMatchObject({ ok: true });
            const input = { direction: 'followers' as const, source: { kind: 'session' as const, sessionId: source.id } };
            const request = resolveSessionFollowActionRequest('follow.list', input);
            const result = await viewerApp.inject({ method: request.method, url: request.path });
            expect(result.statusCode).toBe(200);
            const body = parseSessionFollowActionResponse('follow.list', input, result.json());
            expect(body.peopleCount).toBe(2);
            expect(body.follows).toHaveLength(1);
            expect(body.follows[0]).toMatchObject({ sessionId: source.id });
            expect(body.sources).toHaveLength(2);
            expect(body.sources.every(row => row.destinationSessionId === visible.id)).toBe(true);
            expect(body.sources.map(row => row.relation).sort()).toEqual(['follower', 'manager']);
            expect(body.rules).toEqual([]);
            const pageInput = { ...input, limit: 1 };
            const firstRequest = resolveSessionFollowActionRequest('follow.list', pageInput);
            const firstPage = parseSessionFollowActionResponse('follow.list', pageInput,
                (await viewerApp.inject({ method: firstRequest.method, url: firstRequest.path })).json());
            expect(firstPage.sources).toHaveLength(1);
            expect(firstPage).toMatchObject({ coverage: 'partial', continuation: expect.any(String), peopleCount: 2 });
            const nextInput = { ...pageInput, cursor: firstPage.continuation };
            const nextRequest = resolveSessionFollowActionRequest('follow.list', nextInput);
            const nextPage = parseSessionFollowActionResponse('follow.list', nextInput,
                (await viewerApp.inject({ method: nextRequest.method, url: nextRequest.path })).json());
            expect(nextPage.sources).toHaveLength(1);
            expect(nextPage.sources[0]?.relation).not.toBe(firstPage.sources[0]?.relation);
            expect(nextPage).toMatchObject({ coverage: 'complete', peopleCount: 2 });
            expect(nextPage.continuation).toBeUndefined();
            expect(JSON.stringify(body)).not.toContain(owner.id);
            expect(JSON.stringify(body)).not.toContain(viewer.id);
            const personal = { accountId: viewer.id, sessionId: source.id, authentication };
            expect(await removeAccountSessionFollow(personal)).toMatchObject({ ok: true });
            const unfollowed = await viewerApp.inject({ method: request.method, url: request.path });
            expect(unfollowed.statusCode).toBe(200);
            expect(parseSessionFollowActionResponse('follow.list', input, unfollowed.json()))
                .toMatchObject({ peopleCount: 1, follows: [] });
            expect(await db.accountSessionFollow.findUnique({ where: { accountId_sessionId: {
                accountId: viewer.id, sessionId: source.id,
            } } })).toMatchObject({ following: false, hasPersistentFollow: true });
            expect(await getAccountSessionFollow(personal)).toMatchObject({ ok: true, value: { follow: { following: false } } });
            expect(await setAccountSessionFollow({ ...personal, preferences: { policy: { preset: 'quiet' } } })).toMatchObject({ ok: true });
            await db.account.update({ where: { id: viewer.id }, data: { status: 'suspended' } });
            expect((await app.inject({ method: request.method, url: request.path })).json().peopleCount).toBe(1);
            await db.account.update({ where: { id: viewer.id }, data: { status: 'active' } });
            await db.sessionShare.deleteMany({ where: { sessionId: visible.id, sharedWithUserId: viewer.id } });
            expect(parseSessionFollowActionResponse('follow.list', input,
                (await viewerApp.inject({ method: request.method, url: request.path })).json()).sources).toEqual([]);
            expect((await viewerApp.inject({ method: nextRequest.method, url: nextRequest.path })).json())
                .toMatchObject({ sources: [], coverage: 'complete' });
            await db.sessionShare.deleteMany({ where: { sessionId: source.id, sharedWithUserId: viewer.id } });
            expect((await viewerApp.inject({ method: request.method, url: request.path })).json()).toEqual({ error: 'session_not_found' });
            const ownerBody = (await app.inject({ method: request.method, url: request.path })).json();
            expect(ownerBody.peopleCount).toBe(1);
            const empty = await createSession(owner.id);
            expect((await app.inject({ method: 'GET', url: `/v2/sessions/${empty.id}/follows/followers` })).json())
                .toEqual({ follows: [], sources: [], rules: [], coverage: 'complete', peopleCount: 0 });
        } finally { await app.close(); await viewerApp.close(); }
    });

    it('counts an armed personal one-shot but not its retained fulfilled-only witness', async () => {
        const owner = await createAccount();
        const viewer = await createAccount();
        const source = await createSession(owner.id, { latestTurnId: 'once-turn', latestTurnStatus: 'in_progress' });
        await db.sessionShare.create({ data: { sessionId: source.id, sharedByUserId: owner.id,
            sharedWithUserId: viewer.id, accessLevel: 'view' } });
        const authentication = createPresentUserSessionAccessAuthentication({ env: {} });
        const personal = { accountId: viewer.id, sessionId: source.id, authentication };
        expect(await setAccountSessionFollow({ ...personal,
            preferences: { once: { kind: 'turn_finished', sourceTurnId: 'once-turn' } } })).toMatchObject({ ok: true });
        const app = await buildApp(viewer.id);
        const input = { direction: 'followers' as const, source: { kind: 'session' as const, sessionId: source.id } };
        const request = resolveSessionFollowActionRequest('follow.list', input);
        try {
            const armed = parseSessionFollowActionResponse('follow.list', input,
                (await app.inject({ method: request.method, url: request.path })).json());
            expect(armed).toMatchObject({ peopleCount: 1, follows: [expect.objectContaining({ persistent: false,
                once: { kind: 'turn_finished', sourceTurnId: 'once-turn' } })] });
            const row = await db.accountSessionFollow.findUniqueOrThrow({ where: { accountId_sessionId: {
                accountId: viewer.id, sessionId: source.id,
            } } });
            if (!row.notifyOnce) throw new Error('Expected armed one-shot');
            await db.sessionTurn.create({ data: { sessionId: source.id, turnId: 'once-turn', status: 'completed', startedAt: 1,
                updatedAt: 2, terminalAt: 2 } });
            expect(await acceptAccountSessionFollowOnceDelivery({ accountId: viewer.id, sessionId: source.id,
                expectedOnce: row.notifyOnce, occurrence: { event: 'ready', turnId: 'once-turn', agentStateVersion: 0 } })).toBe(true);
            expect(parseSessionFollowActionResponse('follow.list', input,
                (await app.inject({ method: request.method, url: request.path })).json())).toMatchObject({ peopleCount: 0, follows: [] });
            expect(await getAccountSessionFollow(personal)).toMatchObject({ ok: true, value: { follow: {
                persistent: false, once: null, onceDelivery: { event: 'ready', turnId: 'once-turn' },
            } } });
        } finally { await app.close(); }
    });

    it('discovers only current authorized ordinary and manager routes for one original source occurrence', async () => {
        const owner = await createAccount();
        const other = await createAccount();
        const fence = new Date(1_800_000_000_000);
        const source = await createSession(owner.id, { active: true, seq: 1, lastActiveAt: fence,
            publisherGeneration: 1n, publisherGenerationLastActiveAt: fence, agentStateVersion: 2 });
        const destination = await createSession(owner.id);
        const foreignDestination = await createSession(other.id);
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
            installationId: randomUUID(), dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            metadata: encodePlainMachineStoredContent({}) } });
        await db.accessKey.create({ data: { accountId: owner.id, machineId: machine.id, sessionId: source.id, data: 'opaque' } });
        const authentication = createPresentUserSessionAccessAuthentication({ env: {} });
        const app = await buildApp(owner.id);
        const foreignApp = await buildApp(other.id);
        const url = `/v2/sessions/${source.id}/follows/occurrence-routes`;
        const publisher = { machineId: machine.id, committedFenceMs: fence.getTime(), publisherGeneration: '1' };
        const payload = { v: 1, sourcePublisher: publisher, sourceMessage: { localId: 'original', seq: 2 } };
        try {
            expect((await app.inject({ method: 'PUT', url: `/v2/sessions/${destination.id}/follows/sessions/${source.id}`,
                payload: { policy: { preset: 'everything' } } })).statusCode).toBe(200);
            expect(await setSessionManager({ accountId: owner.id, sessionId: source.id,
                managerSessionId: destination.id, expectedManagerSessionId: null, authentication })).toMatchObject({ ok: true });
            await db.sessionShare.create({ data: { sessionId: source.id, sharedByUserId: owner.id,
                sharedWithUserId: other.id, accessLevel: 'view' } });
            await db.sessionShare.create({ data: { sessionId: foreignDestination.id, sharedByUserId: other.id,
                sharedWithUserId: owner.id, accessLevel: 'edit' } });
            expect((await foreignApp.inject({ method: 'PUT', url: `/v2/sessions/${foreignDestination.id}/follows/sessions/${source.id}`,
                payload: { policy: { preset: 'important' } } })).statusCode).toBe(200);
            expect(await setAccountSessionFollow({ accountId: other.id, sessionId: source.id,
                preferences: { policy: { preset: 'quiet' } }, authentication })).toMatchObject({ ok: true });
            await db.userKVStore.create({ data: { accountId: other.id, key: 'private-rule-definition',
                value: new TextEncoder().encode('private-rule-secret') } });
            const originalCreatedAt = fence.getTime() - 10;
            await db.sessionMessage.create({ data: { sessionId: source.id, seq: 2, localId: 'original', createdAt: new Date(originalCreatedAt),
                messageRole: 'user', content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Original update' } } } } });
            await db.session.update({ where: { id: source.id }, data: { seq: 3 } });
            const edgesBefore = await db.sessionFollowEdge.findMany({ where: { sourceSessionId: source.id } });
            const result = await app.inject({ method: 'POST', url, payload });
            expect(result.statusCode).toBe(200);
            const body = result.json();
            expect(body.originalCreatedAt).toBe(originalCreatedAt);
            expect(Object.keys(body).sort()).toEqual(['currentAccountFacts', 'ok', 'originalCreatedAt', 'routes', 'sourceSessionId', 'v']);
            expect(body.currentAccountFacts).toEqual({ defaultRelationships: {
                assigned: false, direct: false, team: false, group: false,
            }, personalFollowSuppressed: false, hasPersistentFollow: false });
            expect(body).toMatchObject({ ok: true, v: 1, sourceSessionId: source.id });
            expect(body.routes).toHaveLength(3);
            expect(body.routes).toEqual(expect.arrayContaining([
                expect.objectContaining({ destinationSessionId: destination.id, relation: 'follower', policy: { preset: 'everything' } }),
                expect.objectContaining({ destinationSessionId: destination.id, relation: 'manager', attachedAt: expect.any(Number) }),
                expect.objectContaining({ destinationSessionId: foreignDestination.id, relation: 'follower', policy: { preset: 'important' } }),
            ]));
            expect(new Set(body.routes.map((route: { destinationSessionId: string; relation: string }) => `${route.destinationSessionId}:${route.relation}`)).size).toBe(3);
            expect(body.routes.every((route: { observed: { transcriptSeq: number }; delivered: { transcriptSeq: number } }) =>
                route.delivered.transcriptSeq === 1 && route.observed.transcriptSeq === 2)).toBe(true);
            expect(JSON.stringify(body)).not.toContain('private-rule');
            expect(body.routes.every((route: object) => !('rule' in route) && !('accountId' in route))).toBe(true);
            expect(await db.sessionFollowEdge.findMany({ where: { sourceSessionId: source.id } })).toEqual(edgesBefore);
            // Source notifications can outlive a heartbeat, but never their
            // registered publisher. A foreign/legacy touch must still refuse.
            const renewedFence = new Date(fence.getTime() + 1);
            await db.session.update({ where: { id: source.id }, data: { lastActiveAt: renewedFence } });
            expect((await app.inject({ method: 'POST', url, payload })).json())
                .toEqual({ ok: false, v: 1, error: 'forbidden' });
            await db.session.update({ where: { id: source.id }, data: { publisherGenerationLastActiveAt: renewedFence } });
            const afterHeartbeat = await app.inject({ method: 'POST', url, payload });
            expect(afterHeartbeat.statusCode, afterHeartbeat.body).toBe(200);
            expect(afterHeartbeat.json()).toEqual(body);
            const receiverPayload = { v: 1, destinationSessionId: foreignDestination.id,
                sourceMessage: payload.sourceMessage };
            const receiverResult = await foreignApp.inject({ method: 'POST', url, payload: receiverPayload });
            expect(receiverResult.statusCode).toBe(200);
            expect(receiverResult.json().currentAccountFacts).toEqual({ defaultRelationships: {
                assigned: false, direct: true, team: false, group: false,
            }, personalFollowSuppressed: false, hasPersistentFollow: true });
            expect(receiverResult.json()).toMatchObject({ ok: true, originalCreatedAt, routes: [{ destinationSessionId: foreignDestination.id }] });
            expect(receiverResult.json().routes).toHaveLength(1);
            const ruleOnlyDestination = await createSession(other.id);
            expect((await foreignApp.inject({ method: 'POST', url,
                payload: { ...receiverPayload, destinationSessionId: ruleOnlyDestination.id } })).json())
                .toMatchObject({ ok: true, v: 1, sourceSessionId: source.id, routes: [] });
            expect((await foreignApp.inject({ method: 'POST', url,
                payload: { ...receiverPayload, destinationSessionId: destination.id } })).json())
                .toEqual({ ok: false, v: 1, error: 'forbidden' });
            expect((await foreignApp.inject({ method: 'POST', url,
                payload: { ...receiverPayload, sourcePublisher: publisher } })).json())
                .toEqual({ ok: false, v: 1, error: 'invalid_request' });
            // Receiver-owned recovery does not impersonate a foreign/offline publisher Machine.
            await db.session.update({ where: { id: source.id }, data: { active: false } });
            await db.machine.update({ where: { id: machine.id }, data: { revokedAt: new Date() } });
            expect((await foreignApp.inject({ method: 'POST', url, payload: receiverPayload })).json())
                .toMatchObject({ ok: true, routes: [{ destinationSessionId: foreignDestination.id }] });
            expect((await app.inject({ method: 'POST', url, payload })).json()).toEqual({ ok: false, v: 1, error: 'forbidden' });
            await db.session.update({ where: { id: source.id }, data: { active: true } });
            await db.machine.update({ where: { id: machine.id }, data: { revokedAt: null } });
            await db.sessionShare.deleteMany({ where: { sessionId: source.id, sharedWithUserId: other.id } });
            expect((await foreignApp.inject({ method: 'POST', url, payload: receiverPayload })).json())
                .toEqual({ ok: false, v: 1, error: 'forbidden' });
            await db.sessionShare.create({ data: { sessionId: source.id, sharedByUserId: owner.id,
                sharedWithUserId: other.id, accessLevel: 'view' } });
            const requests = { v: 1, sourcePublisher: publisher,
                sourceRequests: { agentStateVersion: 2, requests: [{ requestId: 'question', createdAt: fence.getTime() }] } };
            const requestRoutes = (await app.inject({ method: 'POST', url, payload: requests })).json();
            expect(requestRoutes).toMatchObject({ ok: true, originalCreatedAt: fence.getTime(), routes: [{ destinationSessionId: destination.id, relation: 'manager',
                delivered: { agentStateVersion: 1 }, observed: { agentStateVersion: 2 } }] });
            expect(requestRoutes.routes).toHaveLength(1);
            expect((await app.inject({ method: 'POST', url, payload: { ...requests,
                sourceRequests: { ...requests.sourceRequests, agentStateVersion: 1 } } })).json())
                .toEqual({ ok: false, v: 1, error: 'forbidden' });
            const mute = { accountId: owner.id, receiver: { kind: 'session', sessionId: destination.id } as const,
                scope: { kind: 'sender_session', sessionId: source.id } as const, authentication };
            expect(await changeDeliveryMute({ ...mute, operation: 'set' })).toMatchObject({ ok: true });
            // Muted routes still demand final Pending settlement as suppressed;
            // filtering them here would replay the original after mute removal.
            const mutedRoutes = (await app.inject({ method: 'POST', url, payload })).json();
            expect(mutedRoutes.ok).toBe(true);
            expect(mutedRoutes.routes).toEqual(body.routes);
            expect(await changeDeliveryMute({ ...mute, operation: 'remove' })).toMatchObject({ ok: true });
            for (const invalid of [
                { ...payload, sourcePublisher: { ...publisher, machineId: randomUUID() } },
                { ...payload, sourcePublisher: { ...publisher, publisherGeneration: '2' } },
                { ...payload, sourceMessage: { localId: 'original', seq: 3 } },
                { ...payload, sourceMessage: { localId: 'missing', seq: 2 } },
            ]) expect((await app.inject({ method: 'POST', url, payload: invalid })).json()).toEqual({ ok: false, v: 1, error: 'forbidden' });
            expect((await foreignApp.inject({ method: 'POST', url, payload })).json()).toEqual({ ok: false, v: 1, error: 'forbidden' });
            expect((await app.inject({ method: 'POST', url, payload: { ...payload, rules: [] } })).json())
                .toEqual({ ok: false, v: 1, error: 'invalid_request' });
            expect((await app.inject({ method: 'POST', url, payload, headers: { 'x-test-auth-token-kind': 'api_token' } })).statusCode).toBe(403);
            // A retained relation never replaces current caller or pairwise disclosure authority.
            await db.sessionShare.deleteMany({ where: { sessionId: foreignDestination.id } });
            const revoked = (await app.inject({ method: 'POST', url, payload })).json();
            expect(revoked.routes).toHaveLength(2);
            expect(revoked.routes.every((route: { destinationSessionId: string }) => route.destinationSessionId === destination.id)).toBe(true);
            await db.session.update({ where: { id: destination.id }, data: { archivedAt: new Date() } });
            expect((await app.inject({ method: 'POST', url, payload })).json()).toMatchObject({ ok: true, routes: [] });
            await db.session.update({ where: { id: source.id }, data: { archivedAt: new Date() } });
            expect((await app.inject({ method: 'POST', url, payload })).json()).toEqual({ ok: false, v: 1, error: 'forbidden' });
        } finally { await app.close(); await foreignApp.close(); }
    });

    it('observes pending follower and manager relations without a publisher only at the exact committed own machine', async () => {
        const owner = await createAccount();
        const source = await createSession(owner.id, { seq: 1 });
        const worker = await createSession(owner.id, { seq: 1 });
        await createSession(owner.id, { seq: 99 });
        const destination = await createSession(owner.id, { active: false });
        const machine = await db.machine.create({ data: {
            id: randomUUID(), accountId: owner.id, installationId: randomUUID(),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER), metadata: encodePlainMachineStoredContent({}),
        } });
        const target = { homeId: 'srv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', accountId: owner.id,
            sessionId: destination.id, machineId: machine.id, installationId: machine.installationId! };
        await db.accessKey.create({ data: { accountId: owner.id, machineId: machine.id, sessionId: destination.id, data: 'opaque' } });
        await db.session.update({ where: { id: destination.id }, data: { runtimeMachineTarget: target } });
        const app = await buildApp(owner.id);
        try {
            expect((await app.inject({ method: 'PUT', url: `/v2/sessions/${destination.id}/follows/sessions/${source.id}`,
                payload: { policy: { preset: 'important' } } })).statusCode).toBe(200);
            await db.sessionFollowEdge.create({ data: { sourceSessionId: worker.id, destinationSessionId: destination.id,
                sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: worker.id }),
                policyJson: JSON.stringify({ preset: 'important' }),
                relation: 'manager', managerSourceSessionId: worker.id } });
            await db.session.updateMany({ where: { id: { in: [source.id, worker.id] } }, data: { seq: 2 } });
            const url = `/v2/sessions/${destination.id}/follows/inactive-observations`;
            const payload = { v: 1, machineId: machine.id, installationId: machine.installationId };
            const beforeRead = await db.account.findUniqueOrThrow({ where: { id: owner.id }, select: { seq: true } });
            const result = await app.inject({ method: 'POST', url, payload });
            expect(result.statusCode).toBe(200);
            expect(result.json()).toMatchObject({ ok: true, v: 1, sessionId: destination.id, target,
                currentSourceSessionIds: expect.arrayContaining([source.id, worker.id]) });
            expect(result.json().observations).toHaveLength(2);
            expect(result.json().observations.every((observation: { policy?: unknown }) =>
                JSON.stringify(observation.policy) === JSON.stringify({ preset: 'important' }))).toBe(true);
            expect(SessionFollowObserveInactiveResponseV1Schema.safeParse(result.json()).success).toBe(true);
            expect((await db.sessionFollowEdge.findFirstOrThrow({ where: { sourceSessionId: source.id, relation: 'follower' } })).deliveredTranscriptSeq).toBe(1);
            expect((await db.sessionFollowEdge.findUniqueOrThrow({ where: { managerSourceSessionId: worker.id } })).deliveredTranscriptSeq).toBe(0);
            expect(await db.account.findUniqueOrThrow({ where: { id: owner.id }, select: { seq: true } })).toEqual(beforeRead);
            // Host loss can leave this projection true across a daemon restart;
            // the daemon's canonical process census decides whether to spawn.
            await db.session.update({ where: { id: destination.id }, data: { active: true } });
            expect((await app.inject({ method: 'POST', url, payload })).json()).toMatchObject({ ok: true, target });
            await db.session.update({ where: { id: destination.id }, data: { active: false } });
            for (const invalid of [{ ...payload, machineId: randomUUID() }, { ...payload, installationId: randomUUID() }]) {
                expect((await app.inject({ method: 'POST', url, payload: invalid })).json()).toEqual({ ok: false, v: 1, error: 'forbidden' });
            }
            const restricted = await app.inject({ method: 'POST', url, payload, headers: { 'x-test-auth-token-kind': 'api_token' } });
            expect(restricted.statusCode).toBe(403);
            expect((await app.inject({ method: 'POST', url, payload,
                headers: { 'x-test-auth-token-kind': 'terminal' } })).json()).toMatchObject({ ok: true, target });
            expect((await app.inject({ method: 'POST', url, payload: { ...payload, target } })).json())
                .toEqual({ ok: false, v: 1, error: 'invalid_request' });
            // A destination audience change is re-admitted on each read; the
            // retained edge does not authorize disclosing a private source.
            const viewer = await createAccount();
            await db.sessionShare.create({ data: { sessionId: destination.id, sharedByUserId: owner.id,
                sharedWithUserId: viewer.id, accessLevel: 'admin' } });
            const deniedSources = await app.inject({ method: 'POST', url, payload });
            expect(deniedSources.json()).toMatchObject({ ok: true, currentSourceSessionIds: [], observations: [] });
            const sharedAdminApp = await buildApp(viewer.id);
            try {
                expect((await sharedAdminApp.inject({ method: 'POST', url, payload })).json()).toEqual({ ok: false, v: 1, error: 'forbidden' });
            } finally { await sharedAdminApp.close(); }
            await db.sessionShare.deleteMany({ where: { sessionId: destination.id } });
            // Retained placement cannot borrow an uncommitted key tuple, nor
            // follow the same Machine id onto its replacement installation.
            await db.session.update({ where: { id: destination.id }, data: { runtimeMachineTarget: null } });
            expect((await app.inject({ method: 'POST', url, payload })).json()).toEqual({ ok: false, v: 1, error: 'forbidden' });
            await db.session.update({ where: { id: destination.id }, data: { runtimeMachineTarget: target } });
            await db.machine.update({ where: { id: machine.id }, data: { installationId: randomUUID() } });
            expect((await app.inject({ method: 'POST', url, payload })).json()).toEqual({ ok: false, v: 1, error: 'forbidden' });
            await db.machine.update({ where: { id: machine.id }, data: { installationId: target.installationId } });
            await db.session.update({ where: { id: destination.id }, data: { archivedAt: new Date() } });
            expect((await app.inject({ method: 'POST', url, payload })).json()).toEqual({ ok: false, v: 1, error: 'forbidden' });
        } finally { await app.close(); }
    });

    it('exposes only the nested authoring resource and maps the closed failure vocabulary', async () => {
        const owner = await createAccount();
        const source = await createSession(owner.id, { seq: 7, latestTurnId: 'turn-a', latestTurnStatus: 'completed' });
        const destination = await createSession(owner.id);
        const archived = await createSession(owner.id, { archivedAt: new Date() });
        const app = await buildApp(owner.id);

        const base = `/v2/sessions/${destination.id}/follows/sessions`;

        expect((await app.inject({ method: 'GET', url: base })).json()).toEqual({ sources: [] });

        const created = await app.inject({ method: 'PUT', url: `${base}/${source.id}`, payload: { policy: { preset: 'important' } } });
        expect(created.statusCode).toBe(200);
        expect(created.json()).toEqual({
            changed: true,
            source: {
                sourceSessionId: source.id,
                destinationSessionId: destination.id,
                policy: { preset: 'important' as const },
                deliveryState: 'eligible',
                hasPendingUpdates: false,
            },
        });

        const listed = await app.inject({ method: 'GET', url: base });
        expect(listed.json()).toEqual({ sources: [{
            sourceSessionId: source.id,
            destinationSessionId: destination.id,
            policy: { preset: 'important' as const },
            deliveryState: 'eligible',
            hasPendingUpdates: false,
        }] });

        // Same Session, unknown Session and an archived endpoint each map to
        // their exact code without leaking existence.
        const same = await app.inject({ method: 'PUT', url: `${base}/${destination.id}`, payload: { policy: { preset: 'important' } } });
        expect([same.statusCode, same.json().error]).toEqual([400, 'session_follow_same_session']);

        const unknown = await app.inject({ method: 'PUT', url: `${base}/missing-session`, payload: { policy: { preset: 'important' } } });
        expect([unknown.statusCode, unknown.json().error]).toEqual([404, 'session_not_found']);

        const archivedResponse = await app.inject({
            method: 'PUT',
            url: `/v2/sessions/${archived.id}/follows/sessions/${source.id}`,
            payload: { policy: { preset: 'important' } },
        });
        expect([archivedResponse.statusCode, archivedResponse.json().error]).toEqual([409, 'session_archived']);

        // The strict source writer preserves its explicit shared policy and
        // refuses missing policy, retired mode and unknown fields.
        const explicitMode = await app.inject({ method: 'PUT', url: `${base}/${source.id}`, payload: { policy: { preset: 'important' as const } } });
        expect(explicitMode.statusCode).toBe(200);
        expect(explicitMode.json()).toEqual({
            changed: false,
            source: {
                sourceSessionId: source.id,
                destinationSessionId: destination.id,
                policy: { preset: 'important' as const },
                deliveryState: 'eligible',
                hasPendingUpdates: false,
            },
        });

        const invalidMode = await app.inject({ method: 'PUT', url: `${base}/${source.id}`, payload: { mode: 'always' } });
        expect([invalidMode.statusCode, invalidMode.json()]).toEqual([400, { error: 'invalid_parameters' }]);
        const missingPolicy = await app.inject({ method: 'PUT', url: `${base}/${source.id}`, payload: {} });
        expect([missingPolicy.statusCode, missingPolicy.json()]).toEqual([400, { error: 'invalid_parameters' }]);

        const unexpectedField = await app.inject({ method: 'PUT', url: `${base}/${source.id}`, payload: { executionAccountId: 'other' } });
        expect([unexpectedField.statusCode, unexpectedField.json()]).toEqual([400, { error: 'invalid_parameters' }]);

        // Removal is idempotent and there is no delivery surface to reach.
        expect((await app.inject({ method: 'DELETE', url: `${base}/${source.id}` })).json()).toEqual({ changed: true });
        expect((await app.inject({ method: 'DELETE', url: `${base}/${source.id}` })).json()).toEqual({ changed: false });
        expect((await app.inject({ method: 'POST', url: `${base}/${source.id}/wake` })).statusCode).toBe(404);

        await app.close();
    });

    it('conceals an inaccessible destination and refuses a caller without destination input authority', async () => {
        const owner = await createAccount();
        const viewer = await createAccount();
        const stranger = await createAccount();
        const source = await createSession(owner.id);
        const destination = await createSession(owner.id);
        await db.sessionShare.create({
            data: {
                session: { connect: { id: destination.id } },
                sharedByUser: { connect: { id: owner.id } },
                sharedWithUser: { connect: { id: viewer.id } },
                accessLevel: 'view',
            },
        });
        await db.sessionShare.create({
            data: {
                session: { connect: { id: source.id } },
                sharedByUser: { connect: { id: owner.id } },
                sharedWithUser: { connect: { id: viewer.id } },
                accessLevel: 'view',
            },
        });

        const base = `/v2/sessions/${destination.id}/follows/sessions`;

        const strangerApp = await buildApp(stranger.id);
        const concealed = await strangerApp.inject({ method: 'GET', url: base });
        expect([concealed.statusCode, concealed.json().error]).toEqual([404, 'session_not_found']);
        await strangerApp.close();

        const viewerApp = await buildApp(viewer.id);
        const forbidden = await viewerApp.inject({ method: 'PUT', url: `${base}/${source.id}`, payload: { policy: { preset: 'important' } } });
        expect([forbidden.statusCode, forbidden.json().error]).toEqual([403, 'session_follow_source_forbidden']);
        await viewerApp.close();
    });

    it('refuses an exhausted public destination while its issued message token can still read, then admits after expiry', async () => {
        const owner = await createAccount();
        const source = await createSession(owner.id);
        const destination = await createSession(owner.id);
        const token = randomUUID();
        const tokenHash = createHash('sha256').update(token, 'utf8').digest();
        const publication = await db.publicSessionShare.create({ data: {
            sessionId: destination.id,
            createdByUserId: owner.id,
            tokenHash,
            maxUses: 1,
            useCount: 1,
            isConsentRequired: false,
            expiresAt: new Date(Date.now() + 60_000),
        } });
        const messagesAccessToken = createPublicShareMessagesAccessToken({
            secret: requirePublicShareAccessGrantSecret(),
            publicShareId: publication.id,
            sessionId: destination.id,
            tokenHashHex: tokenHash.toString('hex'),
        });
        const app = await buildApp(owner.id);
        try {
            const readPublicMessages = () => app.inject({
                method: 'GET',
                url: `/v1/public-share/${token}/messages`,
                headers: { [PUBLIC_SHARE_MESSAGES_ACCESS_TOKEN_HEADER]: messagesAccessToken },
            });
            expect((await readPublicMessages()).statusCode).toBe(200);

            const setSource = () => app.inject({
                method: 'PUT',
                url: `/v2/sessions/${destination.id}/follows/sessions/${source.id}`,
                payload: { policy: { preset: 'important' } },
            });
            const denied = await setSource();
            expect([denied.statusCode, denied.json()]).toEqual([403, { error: 'session_follow_source_forbidden' }]);
            expect(await db.sessionFollowEdge.count()).toBe(0);

            await db.publicSessionShare.update({ where: { id: publication.id }, data: { expiresAt: new Date(0) } });
            expect((await readPublicMessages()).statusCode).toBe(404);
            expect((await setSource()).statusCode).toBe(200);
        } finally {
            await app.close();
        }
    });
});
