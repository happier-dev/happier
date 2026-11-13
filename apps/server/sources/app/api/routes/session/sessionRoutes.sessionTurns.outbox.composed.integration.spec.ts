import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPlannedSessionTeamCredentialFixture } from '@/app/teams/credentials/sessionBinding.testkit';
import { encodeSessionTeamCredentialSlotKeyV1 } from '@happier-dev/protocol/teams';

import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createAuthenticatedTestApp } from '../../testkit/sqliteFastify';
import { registerSessionTurnMutationRoute } from './registerSessionTurnMutationRoute';
import { createRuntimeSessionClientDurableMutationOutbox } from '../../../../../../cli/src/api/session/client/transport/mutations/createRuntimeSessionClientDurableMutationOutbox';
import { reloadConfiguration } from '../../../../../../cli/src/configuration';
import { loadSessionClientDurableMutationOutbox, loadSessionClientDurableMutationDeadLetters } from '../../../../../../cli/src/api/session/client/transport/mutations/sessionClientDurableMutationPersistence';
import { SessionTurnsProjectionV1Schema } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';

describe('Session turn outbox → real HTTP admission', () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-turnend-', initAuth: false, env: { HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: '1' } });
        harness.resetEnv({ HAPPIER_HOME_DIR: harness.baseDir, HAPPIER_ACTIVE_SERVER_ID: 'turnend' });
        reloadConfiguration();
    }, 120_000);

    afterAll(async () => {
        if (harness) await harness.close();
        reloadConfiguration();
    });

    it('preserves the Team withdrawal refusal through HTTP and awaited Turn publication', async () => {
        const f = await createPlannedSessionTeamCredentialFixture('personal_allowed');
        const session = await db.session.create({ data: { accountId: f.creator.id, tag: randomUUID(),
            encryptionMode: 'plain', metadata: '{}', active: true } });
        await db.sessionTeamCredentialBinding.create({ data: { sessionId: session.id,
            slotKind: 'provider_model:brokered', slotKey: Buffer.from(encodeSessionTeamCredentialSlotKeyV1({ kind: 'provider_model' })),
            resourceId: f.resource.id, resourceRevision: f.resource.revision } });
        const app = createAuthenticatedTestApp();
        app.addHook('onRequest', async (request: FastifyRequest) => { request.headers['x-test-user-id'] = f.creator.id; });
        registerSessionTurnMutationRoute(app);
        const serverUrl = await app.listen({ host: '127.0.0.1', port: 0 });
        const outbox = createRuntimeSessionClientDurableMutationOutbox({ token: 'fixture', serverUrl,
            sessionId: session.id, getSocket: () => null, requestReconnect: () => undefined });
        const begin = (turnId: string, observedAt: number) => outbox.enqueueSessionTurnMutation({
            v: 1, sessionId: session.id, turnId, action: 'begin', mutationId: turnId, observedAt,
            agentId: 'claude', startingInputId: 'e180e7dc-d935-4a19-90a1-e9fe9b65ce8a', initiator: 'user', workDepth: 0,
        }, { awaitDelivery: true });
        try {
            await outbox.awaitReady();
            await begin('admitted-turn', 100);
            await db.teamCredentialMemberGrant.deleteMany({ where: { resourceId: f.resource.id, teamMembershipId: f.creatorMembership.id } });
            // Withdrawal stops the next admission, while already admitted work finishes.
            await outbox.enqueueSessionTurnMutation({ v: 1, sessionId: session.id, turnId: 'admitted-turn',
                action: 'complete', mutationId: 'complete-admitted', observedAt: 200 });
            await outbox.flush('flush');
            expect(await db.sessionTurn.findUniqueOrThrow({ where: {
                sessionId_turnId: { sessionId: session.id, turnId: 'admitted-turn' },
            } })).toMatchObject({ status: 'completed' });
            await expect(begin('withdrawn-turn', 1794531278625)).rejects.toMatchObject({ failureCause: {
                code: 'session_team_credential_binding_rejected', phase: 'turn_start',
                failureReason: 'permission_denied', providerErrorCode: 'access_removed',
            } });
            expect(await db.sessionTurn.count({ where: { sessionId: session.id, turnId: 'withdrawn-turn' } })).toBe(0);
            await db.teamCredentialMemberGrant.create({ data: { resourceId: f.resource.id, teamMembershipId: f.creatorMembership.id, deliveryMode: 'brokered' } });
            await begin('fresh-turn-after-regrant', 1794531279625);
            expect(await db.sessionTurn.count({ where: { sessionId: session.id, turnId: 'fresh-turn-after-regrant' } })).toBe(1);
        } finally { await outbox.close(); await app.close(); }
    });

    it.each(['complete', 'fail', 'cancel'] as const)('retains exact quiet Workflow correspondence after %s through HTTP and the strict reader', async (action) => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const session = await db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}',
        } });
        const app = createAuthenticatedTestApp();
        app.addHook('onRequest', async (request: FastifyRequest) => { request.headers['x-test-user-id'] = account.id; });
        registerSessionTurnMutationRoute(app);
        const serverUrl = await app.listen({ host: '127.0.0.1', port: 0 });
        const outbox = createRuntimeSessionClientDurableMutationOutbox({ token: 'fixture', serverUrl,
            sessionId: session.id, getSocket: () => null, requestReconnect: () => undefined });
        const base = { v: 1 as const, sessionId: session.id, turnId: 'quiet-turn' };
        const facts = { initiator: 'workflow' as const, workDepth: 1,
            workflowInvocation: { runId: 'own-run', invocationRecordId: 'own-input' } };
        try {
            await outbox.awaitReady();
            await outbox.enqueueSessionTurnMutation({ ...base, action: 'begin', mutationId: 'begin', observedAt: 100, ...facts });
            const terminal = { ...base, mutationId: 'terminal', observedAt: 200 };
            await outbox.enqueueSessionTurnMutation(action === 'fail'
                ? { ...terminal, action, issue: { v: 1, scope: 'primary_session', status: 'failed',
                    code: 'claude_error_during_execution', source: 'agent_session_error', occurredAt: 200 } }
                : { ...terminal, action });
            await outbox.flush('flush');
            expect(await loadSessionClientDurableMutationDeadLetters(session.id)).toEqual([]);
            const response = await app.inject({ method: 'GET', url: `/v1/sessions/${session.id}/turns` });
            expect(response.statusCode).toBe(200);
            const projection = SessionTurnsProjectionV1Schema.parse(response.json());
            expect(projection.turns).toEqual([expect.objectContaining({ ...facts,
                status: action === 'complete' ? 'completed' : action === 'fail' ? 'failed' : 'cancelled' })]);
        } finally {
            await outbox.close();
            await app.close();
        }
    });

    it.each([false, true])('settles completion (invalid anchor: %s) and delivers the next turn', async (invalidAnchor) => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const session = await db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}',
        } });
        await db.sessionMessage.createMany({ data: [
            { sessionId: session.id, seq: 1, localId: 'prompt', messageRole: 'user', sidechainId: null, content: '{}' },
            { sessionId: session.id, seq: 2, localId: 'answer', messageRole: 'agent', sidechainId: null, content: '{}' },
        ] });
        const app = createAuthenticatedTestApp();
        // Only authentication is a fixture boundary. HTTP, route validation,
        // turn application, receipts and the disk journal are real.
        app.addHook('onRequest', async (request: FastifyRequest) => {
            request.headers['x-test-user-id'] = account.id;
        });
        registerSessionTurnMutationRoute(app);
        const serverUrl = await app.listen({ host: '127.0.0.1', port: 0 });
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'fixture', serverUrl, sessionId: session.id, getSocket: () => null,
            requestReconnect: () => undefined,
        });
        const base = { v: 1 as const, sessionId: session.id, turnId: 'turn-1' };
        try {
            await outbox.awaitReady();
            await outbox.enqueueSessionTurnMutation({ ...base, action: 'begin', mutationId: 'begin', observedAt: 100 });
            await outbox.flush('flush');
            expect(await loadSessionClientDurableMutationOutbox(session.id)).toEqual([]);
            await outbox.enqueueSessionTurnMutation({ ...base, action: 'complete', mutationId: 'complete', observedAt: 200,
                transcriptAnchors: invalidAnchor
                    ? { finalAssistantMessageSeq: 2 }
                    : { startUserMessageSeq: 1, userMessageSeqs: [1], startSeqInclusive: 1,
                        endSeqInclusive: 2, finalAssistantMessageSeq: 2 },
            });
            await outbox.flush('flush');
            expect(await loadSessionClientDurableMutationOutbox(session.id)).toEqual([]);
            const letters = await loadSessionClientDurableMutationDeadLetters(session.id);
            if (invalidAnchor) {
                expect(letters).toEqual([expect.objectContaining({
                    mutationId: 'complete', reason: 'session_turn_mutation_rejected', attempts: 1,
                    lastAttempt: expect.objectContaining({ reason: 'session_turn_mutation_rejected' }),
                })]);
                expect(await db.sessionTurnMutationReceipt.count({ where: { sessionId: session.id, mutationId: 'complete' } })).toBe(0);
            } else {
                expect(letters).toEqual([]);
                expect(await db.session.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ latestTurnStatus: 'completed' });
                expect(await db.sessionTurnMutationReceipt.findUniqueOrThrow({
                    where: { sessionId_mutationId: { sessionId: session.id, mutationId: 'complete' } },
                })).toMatchObject({ decision: 'applied' });
            }
            await outbox.enqueueSessionTurnMutation({ ...base, turnId: 'turn-2', action: 'begin', mutationId: 'next', observedAt: 300 });
            await outbox.flush('flush');
            expect(await loadSessionClientDurableMutationOutbox(session.id)).toEqual([]);
            expect(await db.session.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({
                latestTurnId: 'turn-2', latestTurnStatus: 'in_progress',
            });
        } finally {
            await outbox.close();
            await app.close();
        }
    });
});
