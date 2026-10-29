import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { deriveDiscussionFollowInputLocalIdV1, deriveSessionFollowWakeEventLocalIdV1, SESSION_FOLLOW_WAKE_EVENT_MESSAGE } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { buildDiscussionMutationRequestBodyV1 } from '@happier-dev/protocol/discussions/api';
import { buildTrustedHostSessionInputAdmissionV1, SessionInputRequestV1Schema, withSessionInputRequestV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { MACHINE_PLAIN_DATA_KEY_MARKER, TranscriptRawAgentEventV1Schema } from '@happier-dev/protocol';
import { decodeBase64 } from 'privacy-kit';
import { PrismaClient } from '@prisma/client';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';

import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { db, initDbPostgres } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { getDbProviderFromEnv } from '@/storage/prisma';
import { acknowledgeSessionFollowFrontierInTx, observePendingSessionFollowForDestinationInTx, observeSessionFollowSourceRoutes, setSessionFollowSource } from './sessionFollowEdgeService';
import { setSessionManager } from './sessionManagerService';
import { assertConcurrentFailedTurnRouteAcknowledgements } from './sessionFollowAcknowledgement.testkit';
import { acceptAccountFollowPersonalProgress } from './accountFollowPersonalProgress';
import { getAccountFollowRule, setAccountFollowRule } from './accountFollowRuleService';
import { createDiscussion, postDiscussionMessage } from '@/app/discussions/mutations';
import { enqueuePendingMessage, enqueuePendingMessageByAuthenticatedMachine } from '@/app/session/pending/pendingMessageService';
import { changeDeliveryMute } from './sessionDeliveryMuteService';
import { readAdmittedSessionFollowInputInTx } from './sessionFollowRuleProgress';
import { deriveSessionFollowInputLocalIdV1, type SessionFollowInputV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { readStalledSessionFollowRulesInTx } from './sessionFollowStalledRule';
import { retainSuppressedFollowInputInTx } from './sessionFollowSuppression';
import { hasPendingRunFollowOccurrenceInTx } from './sessionFollowSourceProjection';
import { buildSessionInputAdmissionReceipt } from '@/app/session/messages/sessionInputAdmission';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Follow accepted-prefix ACK on PostgreSQL', () => {
    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error('Missing DATABASE_URL for disposable PostgreSQL contract');
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    it('ends permission Run demand only for the exact discarded original and receiver on PostgreSQL', async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL)
            throw new Error('Use the disposable PostgreSQL DB-contract harness');
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const destination = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const other = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const original = { source: { kind: 'execution_run' as const, sessionId: randomUUID(), runId: 'permission-run' },
            permissionRequests: [{ requestId: 'approval', createdAt: 1 }] };
        const edge = { destinationSessionId: destination.id, deliveredExecutionRunTerminalEventId: null, deliveredWorkflowRunRevision: null };
        const pending = (candidate = original, destinationSessionId = destination.id) => inTx(tx => hasPendingRunFollowOccurrenceInTx(tx,
            { ...edge, destinationSessionId }, candidate));
        expect(await pending()).toBe(true);
        const localId = deriveSessionFollowInputLocalIdV1({ destinationSessionId: destination.id, original });
        await inTx(tx => retainSuppressedFollowInputInTx(tx, { destinationSessionId: destination.id, localId,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Run attention' } } },
            requestedAction: { v: 1, kind: 'enqueue' }, receipt: buildSessionInputAdmissionReceipt({
                issuer: 'authenticatedMachine',
            }), position: 1 }));
        expect(await pending()).toBe(false);
        expect(await pending(original, other.id)).toBe(true);
        expect(await pending({ ...original, permissionRequests: [{ requestId: 'approval', createdAt: 2 }] })).toBe(true);
        // Other discards and queued inputs remain distinct from settled mute.
        await db.sessionPendingMessage.update({ where: { sessionId_localId: { sessionId: destination.id, localId } },
            data: { discardedReason: 'user_deleted' } });
        expect(await pending()).toBe(true);
        await db.sessionPendingMessage.update({ where: { sessionId_localId: { sessionId: destination.id, localId } },
            data: { status: 'queued', discardedReason: null, discardedAt: null } });
        expect(await pending()).toBe(true);
        expect(await db.sessionMessage.count({ where: { sessionId: destination.id } })).toBe(0);
    });

    it('keeps source occurrence route reads constant across 128 receivers and rechecks changed access', async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL)
            throw new Error('Use the disposable PostgreSQL DB-contract harness');
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const authentication = createPresentUserSessionAccessAuthentication({ env: {} });
        const fence = new Date();
        const source = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}',
            encryptionMode: 'plain', active: true, seq: 2, publisherGeneration: 1n,
            lastActiveAt: fence, publisherGenerationLastActiveAt: fence } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, installationId: randomUUID(),
            metadata: encodePlainMachineStoredContent({}), dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
        await db.accessKey.create({ data: { accountId: owner.id, sessionId: source.id, machineId: machine.id, data: 'opaque' } });
        const destinationIds = Array.from({ length: 128 }, () => randomUUID());
        await db.session.createMany({ data: destinationIds.map(id => ({ id, accountId: owner.id, tag: id,
            metadata: '{}', encryptionMode: 'plain' })) });
        await db.sessionMessage.create({ data: { sessionId: source.id, seq: 2, localId: 'original', messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Original' } } } } });
        const edge = (destinationSessionId: string) => ({ sourceSessionId: source.id, sourceKey: `session:${source.id}`,
            destinationSessionId, relation: 'follower' as const, policyJson: '{"preset":"everything"}' });
        await db.sessionFollowEdge.create({ data: edge(destinationIds[0]!) });
        const statements: string[] = [];
        const traced = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
        traced.$on('query', event => statements.push(event.query));
        await traced.$connect();
        const originalTransaction = db.$transaction;
        // Observe real PostgreSQL queries beneath the complete admission owner.
        db.$transaction = new Proxy(originalTransaction, { apply(_target, _receiver, args) {
            return Reflect.apply(traced.$transaction, traced, args);
        } });
        const read = () => observeSessionFollowSourceRoutes({ accountId: owner.id, sourceSessionId: source.id, authentication,
            request: { v: 1, sourcePublisher: { machineId: machine.id, publisherGeneration: '1', committedFenceMs: fence.getTime() },
                sourceMessage: { localId: 'original', seq: 2 } } });
        const readCount = () => statements.filter(query => /^SELECT\b/.test(query)).length;
        try {
            statements.length = 0;
            expect(await read()).toMatchObject({ ok: true, routes: [{ destinationSessionId: destinationIds[0] }] });
            const single = readCount();
            await db.sessionFollowEdge.createMany({ data: destinationIds.slice(1).map(edge) });
            statements.length = 0;
            const many = await read();
            expect(many.ok).toBe(true);
            if (!many.ok) throw new Error(many.error);
            expect(many.routes).toHaveLength(128);
            const scaled = readCount();
            console.info('FOLLOW_SOURCE_ROUTE_SELECTS', JSON.stringify({ single, receivers128: scaled }));
            expect(scaled).toBe(single);
            await db.session.update({ where: { id: destinationIds[0]! }, data: { archivedAt: new Date() } });
            const archived = await read();
            expect(archived.ok && archived.routes).toHaveLength(127);
            expect(archived.ok && archived.routes.some(route => route.destinationSessionId === destinationIds[0])).toBe(false);
            await db.session.update({ where: { id: destinationIds[0]! }, data: { archivedAt: null } });
            const restored = await read();
            expect(restored.ok && restored.routes).toHaveLength(128);
            await db.session.update({ where: { id: source.id }, data: { publisherGeneration: 2n } });
            expect(await read()).toEqual({ ok: false, v: 1, error: 'forbidden' });
        } finally {
            db.$transaction = originalTransaction;
            await traced.$disconnect();
            // The disposable PostgreSQL harness owns all seeded-row teardown.
        }
    });

    it('settles muted Discussion originals in discarded custody without an accepted frontier on PostgreSQL', async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL)
            throw new Error('Use the disposable PostgreSQL DB-contract harness');
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const authentication = createPresentUserSessionAccessAuthentication({ env: {} });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, installationId: randomUUID(),
            metadata: encodePlainMachineStoredContent({}), dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            operationProtocolCapabilitiesRevision: 1, operationProtocolCapabilities: {
                sessionInputAdmission: { protocolVersions: [1] }, sessionMessageReply: { protocolVersions: [1] },
            } } });
        const destination = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), encryptionMode: 'plain',
            metadata: JSON.stringify({ machineId: machine.id }) } });
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY', 'optional');
        try {
            const homeId = await getOrCreateServerIdentityId();
            await db.accessKey.create({ data: { accountId: owner.id, machineId: machine.id, sessionId: destination.id, data: 'opaque' } });
            await db.session.update({ where: { id: destination.id }, data: { runtimeMachineTarget: {
                homeId, accountId: owner.id, sessionId: destination.id, machineId: machine.id, installationId: machine.installationId!,
            } } });
            const content = { v: 1 as const, parts: [{ t: 'text' as const, text: 'Discussion' }] };
            const created = await createDiscussion({ actorAccountId: owner.id, authentication, request: buildDiscussionMutationRequestBodyV1({
                kind: 'create', creationLocalId: randomUUID(), titleContent: { t: 'plain', v: { v: 1, title: 'Suppression' } },
                participants: [{ kind: 'session', sessionId: destination.id }],
                firstMessage: { localId: randomUUID(), content: { t: 'plain', v: content }, authoredContent: content, mentionedAccountIds: [] },
            }) });
            if (!created.ok) throw new Error(created.error);
            const discussionId = created.value.discussion.id;
            const initialFrontier = await db.sessionFollowEdge.findFirstOrThrow({
                where: { destinationSessionId: destination.id, sourceDiscussionId: discussionId },
                select: { deliveredTranscriptSeq: true },
            });
            const mute = (operation: 'set' | 'remove') => changeDeliveryMute({ accountId: owner.id, authentication, operation,
                receiver: { kind: 'session', sessionId: destination.id }, scope: { kind: 'source', source: { kind: 'discussion', discussionId } } });
            const observe = () => inTx(tx => observePendingSessionFollowForDestinationInTx(tx, { destinationSessionId: destination.id,
                principal: { kind: 'destination_runtime', destinationRuntimeAccountId: owner.id, authentication } }));
            const post = async () => {
                const authoredContent = { v: 1 as const, parts: [{ t: 'mention' as const,
                    participant: { kind: 'session' as const, sessionId: destination.id } }] };
                const result = await postDiscussionMessage({ actorAccountId: owner.id, authentication, discussionId,
                    request: buildDiscussionMutationRequestBodyV1({ kind: 'post', localId: randomUUID(), content: { t: 'plain', v: authoredContent },
                        authoredContent, mentionedAccountIds: [], mentionedSessionIds: [destination.id] }) });
                if (!result.ok) throw new Error(result.error);
                return result.value.message;
            };
            const enqueue = (message: Awaited<ReturnType<typeof post>>) => {
                const discussion = { discussionId, messageId: message.id, throughSeq: message.seq, participantSessionId: destination.id };
                const request = SessionInputRequestV1Schema.parse({ ...buildTrustedHostSessionInputAdmissionV1('agent').request,
                    discussionAddressing: discussion, replyIntent: { mode: 'return' } });
                return enqueuePendingMessageByAuthenticatedMachine({ accountId: owner.id, sourceMachineId: machine.id,
                    targetMachineId: machine.id, sessionId: destination.id, localId: deriveDiscussionFollowInputLocalIdV1(discussion),
                    requestedAction: { v: 1, kind: 'enqueue' }, reply: { mode: 'return', discussion },
                    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Question' }, meta: withSessionInputRequestV1({}, request) } } });
            };
            expect(await mute('set')).toMatchObject({ ok: true });
            const old = await post();
            expect((await observe()).observations).toHaveLength(1);
            expect(await enqueue(old)).toEqual({ status: 'rejected', code: 'session_input_muted' });
            expect(await mute('remove')).toMatchObject({ ok: true });
            expect((await observe()).observations).toEqual([]);
            expect(await enqueue(old)).toEqual({ status: 'rejected', code: 'session_input_muted' });
            expect(await db.sessionFollowEdge.findFirstOrThrow({ where: { destinationSessionId: destination.id, sourceDiscussionId: discussionId } }))
                .toMatchObject(initialFrontier);
            const fresh = await post();
            expect(await enqueue(fresh)).toMatchObject({ status: 'accepted' });
            expect(await enqueue(fresh)).toMatchObject({ status: 'alreadyAccepted' });
            expect(await db.sessionPendingMessage.findMany({ where: { sessionId: destination.id }, orderBy: { position: 'asc' },
                select: { status: true, discardedReason: true } })).toEqual([
                { status: 'discarded', discardedReason: 'session_input_muted' }, { status: 'queued', discardedReason: null },
            ]);
            expect(await db.sessionMessage.count({ where: { sessionId: destination.id } })).toBe(0);
        } finally {
            vi.unstubAllEnvs();
            // The disposable PostgreSQL harness owns related-row teardown.
        }
    });

    it('merges private stalled selections and advances only accepted Turn progress on PostgreSQL', async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL)
            throw new Error('Use the disposable PostgreSQL DB-contract harness');
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const authentication = createPresentUserSessionAccessAuthentication({ env: {} });
        const source = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}',
            encryptionMode: 'plain', latestTurnId: 'live-turn', latestTurnStatus: 'in_progress', active: false } });
        const destination = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const receiver = { kind: 'session' as const, sessionId: destination.id };
        const rules = ['important', 'quiet'].map(preset => ({ ruleId: randomUUID(), ruleVersion: 0,
            selectedDelivery: preset === 'important' ? 'wake' as const : 'next_turn' as const }));
        try {
            for (const rule of rules) expect(await setAccountFollowRule({ accountId: account.id, authentication, ruleId: rule.ruleId,
                mutation: { receiver, expectedVersion: -1, content: { t: 'plain', v: { v: 1, enabled: true,
                    filter: normalizeSessionListFilterV1(), policy: { preset: rule.selectedDelivery === 'wake' ? 'important' : 'quiet' } } } } }))
                .toMatchObject({ ok: true });
            const presence = { turnId: 'live-turn', publisherFence: source.lastActiveAt.getTime() };
            expect(await acceptAccountFollowPersonalProgress({ accountId: account.id, authentication,
                occurrence: { kind: 'session_stalled', sourceSessionId: source.id, destinationSessionId: destination.id, presence, rules } }))
                .toMatchObject({ ok: true, value: { accepted: true, alreadyRepresented: false } });
            const selections = await inTx(tx => readStalledSessionFollowRulesInTx(tx, { accountId: account.id, destinationSessionId: destination.id }));
            expect(selections).toHaveLength(1);
            expect(selections[0]!.progress).toHaveLength(2);
            const observation = selections[0]!.observation;
            expect(observation).toMatchObject({ relation: 'rule', effectiveDelivery: 'wake', presence,
                delivered: { transcriptSeq: 0, turn: null }, observed: { turn: { id: 'live-turn', status: 'stalled' } } });
            const principal = { kind: 'destination_runtime' as const, destinationRuntimeAccountId: account.id, authentication };
            const localInputId = randomUUID();
            const acknowledge = () => inTx(tx => acknowledgeSessionFollowFrontierInTx(tx, { principal,
                destinationSessionId: destination.id, sourceSessionId: source.id, relation: 'rule',
                effectiveDelivery: observation.effectiveDelivery, presence, expectedPublisherGeneration: destination.publisherGeneration,
                expected: observation.delivered, observed: observation.observed, consumed: observation.observed,
                acceptance: { kind: 'admitted_input', localInputId, userMessageSeq: 1 } }));
            expect(await acknowledge()).toMatchObject({ ok: false, rejection: 'provider_acceptance_unverified' });
            for (const rule of rules) expect(await getAccountFollowRule({ accountId: account.id, authentication, ruleId: rule.ruleId }))
                .toMatchObject({ ok: true, value: { rule: { sources: [{ delivered: { turn: null } }] } } });
            await db.sessionMessage.create({ data: { sessionId: destination.id, seq: 1, localId: localInputId,
                messageRole: 'user', acceptedTurnId: 'receiver-turn', acceptedTurnKind: 'newTurn',
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Continue' } } } } });
            expect(await acknowledge()).toMatchObject({ ok: true });
            for (const rule of rules) expect(await getAccountFollowRule({ accountId: account.id, authentication, ruleId: rule.ruleId }))
                .toMatchObject({ ok: true, value: { rule: { sources: [{ delivered: { transcriptSeq: 0,
                    turn: { id: 'live-turn', status: 'stalled' } } }] } } });
            expect(await inTx(tx => readStalledSessionFollowRulesInTx(tx, { accountId: account.id, destinationSessionId: destination.id }))).toEqual([]);
            expect(await db.sessionFollowEdge.count({ where: { destinationSessionId: destination.id } })).toBe(0);
            expect(await db.sessionPendingMessage.count({ where: { sessionId: destination.id } })).toBe(0);
        } finally {
            await db.sessionMessage.deleteMany({ where: { sessionId: destination.id } });
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it('retains muted originals as non-executable discarded custody and admits only a fresh original after removal', async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL)
            throw new Error('Use the disposable PostgreSQL DB-contract harness');
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const authentication = createPresentUserSessionAccessAuthentication({ env: {} });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, installationId: randomUUID(),
            metadata: encodePlainMachineStoredContent({}), dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1] } } } });
        const source = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const destination = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), encryptionMode: 'plain',
            metadata: JSON.stringify({ machineId: machine.id }) } });
        // This fixture deliberately exercises plain input, as the SQLite composition does.
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY', 'optional');
        try {
            const homeId = await getOrCreateServerIdentityId();
            await db.accessKey.create({ data: { accountId: owner.id, machineId: machine.id, sessionId: destination.id, data: 'opaque' } });
            await db.session.update({ where: { id: destination.id }, data: { runtimeMachineTarget: {
                homeId, accountId: owner.id, sessionId: destination.id, machineId: machine.id, installationId: machine.installationId!,
            } } });
            expect(await setSessionFollowSource({ accountId: owner.id, destinationSessionId: destination.id,
                sourceSessionId: source.id, policy: { preset: 'everything' }, authentication })).toMatchObject({ ok: true });
            const original = async (id: string): Promise<SessionFollowInputV1> => {
                const terminalAt = BigInt(Date.now());
                await db.sessionTurn.create({ data: { sessionId: source.id, turnId: id, status: 'failed',
                    startedAt: terminalAt, updatedAt: terminalAt, terminalAt } });
                await db.session.update({ where: { id: source.id }, data: { latestTurnId: id, latestTurnStatus: 'failed' } });
                return { v: 1, delivery: 'wake', original: { sourceSessionId: source.id, sourceTurn: { id, status: 'failed' } },
                    event: { kind: 'failed_or_stopped' } };
            };
            const enqueue = (delivery: SessionFollowInputV1) => enqueuePendingMessage({ actorUserId: owner.id,
                sessionId: destination.id, targetMachineId: machine.id, authentication,
                localId: deriveSessionFollowInputLocalIdV1({ destinationSessionId: destination.id, original: delivery.original }),
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Follow source changed' } } },
                requestedAction: { v: 1, kind: 'enqueue' }, followDeliveryV1: delivery, followRelations: [{ relation: 'follower' }],
            });
            const mute = (operation: 'set' | 'remove') => changeDeliveryMute({ accountId: owner.id, authentication,
                receiver: { kind: 'session', sessionId: destination.id }, scope: { kind: 'sender_session', sessionId: source.id }, operation });
            expect(await mute('set')).toMatchObject({ ok: true });
            const old = await original('muted-turn');
            expect(await enqueue(old)).toMatchObject({ ok: false, admissionRejectionCode: 'session_input_muted' });
            expect(await mute('remove')).toMatchObject({ ok: true });
            expect(await enqueue(old)).toMatchObject({ ok: false, admissionRejectionCode: 'session_input_muted' });
            const rows = await db.sessionPendingMessage.findMany({ where: { sessionId: destination.id } });
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ status: 'discarded', discardedReason: 'session_input_muted' });
            expect(await inTx(tx => readAdmittedSessionFollowInputInTx(tx, { accountId: owner.id,
                destinationSessionId: destination.id, localInputId: rows[0]!.localId,
                authority: { kind: 'account', authentication } }))).toMatchObject({ nativeAccepted: false, effectiveDelivery: null });
            expect(await enqueue(await original('fresh-turn'))).toMatchObject({ ok: true, pending: { status: 'queued' } });
            expect(await db.sessionPendingMessage.count({ where: { sessionId: destination.id, status: 'queued' } })).toBe(1);
            expect(await db.sessionMessage.count({ where: { sessionId: destination.id } })).toBe(0);
        } finally {
            vi.unstubAllEnvs();
            await db.sessionPendingMessage.deleteMany({ where: { sessionId: destination.id } });
            await db.accessKey.deleteMany({ where: { accountId: owner.id } });
            await db.session.deleteMany({ where: { accountId: owner.id } });
            await db.machine.deleteMany({ where: { accountId: owner.id } });
            await db.account.delete({ where: { id: owner.id } });
        }
    });

    it('enforces one exact Session or Machine anchor for execution Run sources in both Follow adapters', async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL)
            throw new Error('Use the disposable PostgreSQL DB-contract harness');
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const source = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const destination = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id,
            metadata: encodePlainMachineStoredContent({}) } });
        const machineKey = `execution_run:${'a'.repeat(64)}`;
        const sessionKey = `execution_run:${'b'.repeat(64)}`;
        try {
            await db.$executeRaw`INSERT INTO "AccountSessionFollow" ("id", "accountId", "sourceKey", "sourceExecutionRunMachineId", "sourceExecutionRunId", "following", "hasPersistentFollow", "notifyOnce", "deliveredExecutionRunTerminalEventId", "deliveredExecutionRunPermissionKey")
                VALUES (${randomUUID()}, ${account.id}, ${machineKey}, ${machine.id}, 'run', false, false, '{"kind":"run_settled"}', 'terminal', 'permission')`;
            await db.$executeRaw`INSERT INTO "SessionFollowEdge" ("sourceKey", "sourceExecutionRunMachineId", "sourceExecutionRunId", "destinationSessionId", "policyJson", "deliveredExecutionRunTerminalEventId")
                VALUES (${machineKey}, ${machine.id}, 'run', ${destination.id}, '{"preset":"quiet"}', 'terminal')`;
            await db.accountSessionFollow.create({ data: { accountId: account.id, sourceKey: sessionKey,
                sourceExecutionRunSessionId: source.id, sourceExecutionRunId: 'run', followPolicy: '{"preset":"important"}' } });
            await db.sessionFollowEdge.create({ data: { sourceKey: sessionKey, sourceExecutionRunSessionId: source.id,
                sourceExecutionRunId: 'run', destinationSessionId: destination.id, policyJson: '{"preset":"important"}' } });
            for (const table of ['AccountSessionFollow', 'SessionFollowEdge']) {
                for (const mutation of [
                    `"sourceExecutionRunSessionId" = '${source.id}'`,
                    '"sourceExecutionRunMachineId" = NULL',
                    '"sourceExecutionRunId" = NULL',
                    `"${table === 'AccountSessionFollow' ? 'sessionId' : 'sourceSessionId'}" = '${source.id}'`,
                    '"sourceWorkflowRunId" = \'workflow\'',
                    '"sourceKey" = \'workflow_run:wrong\'',
                    '"sourceKey" = \'executionXrun:wrong\'',
                    '"deliveredWorkflowRunRevision" = 1',
                ]) await expect(db.$executeRawUnsafe(`UPDATE "${table}" SET ${mutation} WHERE "sourceKey" = $1`, machineKey))
                    .rejects.toThrow(new RegExp(`${table}_source_identity_check`));
                await expect(db.$executeRawUnsafe(`UPDATE "${table}" SET "sourceExecutionRunMachineId" = $1 WHERE "sourceKey" = $2`, machine.id, sessionKey))
                    .rejects.toThrow(new RegExp(`${table}_source_identity_check`));
                await expect(db.$executeRawUnsafe(`UPDATE "${table}" SET "sourceExecutionRunMachineId" = 'missing-machine' WHERE "sourceKey" = $1`, machineKey))
                    .rejects.toThrow(new RegExp(`${table}_sourceExecutionRunMachineId_fkey`));
            }
            await expect(db.$executeRaw`UPDATE "SessionFollowEdge" SET "relation" = 'manager', "managerSourceSessionId" = ${source.id}
                WHERE "sourceKey" = ${machineKey}`).rejects.toThrow(/SessionFollowEdge_manager_relation_check/);
            expect(await db.accountSessionFollow.findFirst({ where: { accountId: account.id, sourceKey: machineKey } }))
                .toMatchObject({ deliveredExecutionRunTerminalEventId: 'terminal', deliveredExecutionRunPermissionKey: 'permission',
                    following: false, hasPersistentFollow: false, followPolicy: null, notifyOnce: '{"kind":"run_settled"}' });
            await db.machine.delete({ where: { id: machine.id } });
            expect(await db.accountSessionFollow.count({ where: { accountId: account.id } })).toBe(1);
            expect(await db.sessionFollowEdge.count({ where: { destinationSessionId: destination.id } })).toBe(1);
            expect(await db.accountSessionFollow.findFirst({ where: { accountId: account.id } }))
                .toMatchObject({ sourceKey: sessionKey, sourceExecutionRunSessionId: source.id, followPolicy: '{"preset":"important"}' });
        } finally {
            await db.sessionFollowEdge.deleteMany({ where: { destinationSessionId: destination.id } });
            await db.accountSessionFollow.deleteMany({ where: { accountId: account.id } });
            await db.machine.deleteMany({ where: { id: machine.id } });
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it.each([1, 128])('reads one destination mute snapshot across %i Session and Discussion candidates', async count => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const destination = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const sourceIds = Array.from({ length: count }, () => randomUUID());
        await db.session.createMany({ data: sourceIds.map(id => ({ id, accountId: owner.id, tag: id, metadata: '{}', encryptionMode: 'plain', seq: 1 })) });
        await db.sessionFollowEdge.createMany({ data: sourceIds.map(id => ({ sourceSessionId: id,
            sourceKey: `session:${id}`, destinationSessionId: destination.id, policyJson: '{"preset":"everything"}' })) });
        const created = await createDiscussion({ actorAccountId: owner.id,
            authentication: createPresentUserSessionAccessAuthentication({ env: {} }), request: {
                creationLocalId: randomUUID(), titleContent: { t: 'plain', v: { v: 1, title: 'Mute observation' } },
                participants: [{ kind: 'session', sessionId: destination.id }],
                firstMessage: { localId: randomUUID(), content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Opening' }] } }, mentionedAccountIds: [] },
            } });
        expect(created).toMatchObject({ ok: true });
        if (!created.ok) throw new Error(created.error);
        const discussion = created.value.discussion;
        // The canonical creator establishes key readiness, membership and Follow
        // attachment. Only the scale-shaped immutable message rows are supplied.
        await db.discussionMessage.createMany({ data: Array.from({ length: count + 1 }, (_, index) => ({
            discussionId: discussion.id, localId: randomUUID(), requestEqualityEvidenceV1: {}, seq: index + 2,
            authorAccountId: owner.id, content: { t: 'plain', v: { v: 1, parts: [
                { t: 'mention', participant: { kind: 'session', sessionId: destination.id } },
            ] } },
            ...(index < count ? { producerV1: { v: 1, kind: 'agent', sessionId: sourceIds[0]! } } : {}),
            addressingV1: { throughSeq: index + 2, participantSessionIds: [destination.id] },
        })) });
        await db.discussion.update({ where: { id: discussion.id }, data: { messageSeq: count + 2 } });
        await db.session.update({ where: { id: destination.id }, data: { deliveryMutes: JSON.stringify([
            { kind: 'sender_session', sessionId: sourceIds[0] },
        ]) } });
        const statements: string[] = [];
        const traced = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
        traced.$on('query', event => statements.push(event.query));
        await traced.$connect();
        const originalTransaction = db.$transaction;
        // Observe engine-emitted SQL; all observation/access/reply decisions stay real.
        db.$transaction = new Proxy(originalTransaction, { apply(_target, _receiver, args) {
            return Reflect.apply(traced.$transaction, traced, args);
        } });
        const observe = () => inTx(tx => observePendingSessionFollowForDestinationInTx(tx, {
            destinationSessionId: destination.id,
            principal: { kind: 'destination_runtime', destinationRuntimeAccountId: owner.id,
                authentication: createPresentUserSessionAccessAuthentication({ env: {} }) },
        }));
        try {
            statements.length = 0;
            const selected = await observe();
            expect(selected.currentSourceSessionIds).toHaveLength(count);
            expect(selected.observations.filter(row => 'sourceSessionId' in row)).toHaveLength(count);
            expect(selected.observations.filter(row => 'source' in row)).toEqual([
                // A confirmed mute is still source demand for discarded custody.
                expect.objectContaining({ addressing: expect.objectContaining({ discussionId: discussion.id, throughSeq: 2 }) }),
            ]);
            const muteReads = statements.filter(query => /^SELECT\b/.test(query) && query.includes('"deliveryMutes"'));
            console.info('FOLLOW_OBSERVATION_MUTE_SQL', JSON.stringify({ sessionSources: count, discussionCandidates: count + 1, muteReads: muteReads.length }));
            expect(muteReads).toHaveLength(1);
            await db.session.update({ where: { id: destination.id }, data: { deliveryMutes: '{malformed' } });
            expect((await observe()).observations).toEqual([]);
            await db.session.update({ where: { id: destination.id }, data: { deliveryMutes: null } });
            const unmuted = await observe();
            expect(unmuted.observations.filter(row => 'sourceSessionId' in row)).toHaveLength(count);
            expect(unmuted.observations.filter(row => 'source' in row)).toEqual([
                expect.objectContaining({ addressing: expect.objectContaining({ throughSeq: 2 }) }),
            ]);
            await db.discussionParticipant.update({ where: { discussionId_sessionId: { discussionId: discussion.id, sessionId: destination.id } }, data: { removedAt: new Date() } });
            expect((await observe()).observations.filter(row => 'source' in row)).toEqual([]);
        } finally {
            db.$transaction = originalTransaction;
            await traced.$disconnect();
            // The disposable PostgreSQL harness owns related-row teardown.
        }
    });

    it('admits personal progress before a Session deletion lock can wait on its Account publication', async () => {
        const account = await db.account.create({ data: { id: `z-${randomUUID()}`, publicKey: randomUUID(), encryptionMode: 'plain' } });
        const viewer = await db.account.create({ data: { id: `a-${randomUUID()}`, publicKey: randomUUID(), encryptionMode: 'plain' } });
        const previousHome = process.env.HAPPIER_SERVER_IDENTITY_ID;
        const homeId = `srv_${'f'.repeat(32)}`;
        process.env.HAPPIER_SERVER_IDENTITY_ID = homeId;
        try {
            const authentication = createPresentUserSessionAccessAuthentication({ env: {} });
            const installationId = randomUUID();
            const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, metadata: encodePlainMachineStoredContent({}), installationId,
                dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER)) } });
            const source = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain',
                agentStateVersion: 1, pendingUserActionRequestCount: 1 } });
            await db.sessionShare.create({ data: { sessionId: source.id, sharedByUserId: account.id, sharedWithUserId: viewer.id, accessLevel: 'view' } });
            await db.accessKey.create({ data: { accountId: account.id, sessionId: source.id, machineId: machine.id,
                data: MACHINE_PLAIN_DATA_KEY_MARKER } });
            await db.session.update({ where: { id: source.id }, data: { runtimeMachineTarget: {
                homeId, accountId: account.id, sessionId: source.id, machineId: machine.id, installationId,
            } } });
            await db.accountSessionFollow.create({ data: { accountId: account.id, sessionId: source.id,
                following: true, followPolicy: JSON.stringify({ preset: "important" }) } });
            const scope = { accountId: account.id, authentication, ruleId: randomUUID() };
            const created = await setAccountFollowRule({ ...scope, mutation: { receiver: { kind: 'account' }, expectedVersion: -1,
                content: { t: 'plain', v: { v: 1, enabled: true, filter: normalizeSessionListFilterV1(), policy: { preset: 'important' } } } } });
            if (!created.ok) throw new Error(created.error);
            const requestId = randomUUID();
            const occurrence = { sourceSessionId: source.id, expectedSourcePublisherGeneration: source.publisherGeneration.toString(),
                machineId: machine.id, installationId, rules: [{ ruleId: scope.ruleId, ruleVersion: created.value.rule.version, requestIds: [requestId] }],
                sourceRequests: { agentStateVersion: 1, requests: [{ requestId, createdAt: Date.now() }] } };
            // Establish the actual public admission and reserved-row writer,
            // rather than accepting a fixture that exits before publication.
            expect(await acceptAccountFollowPersonalProgress({ accountId: account.id, authentication, occurrence }))
                .toEqual({ ok: true, value: { accepted: true, alreadyRepresented: false } });
            await db.session.update({ where: { id: source.id }, data: { agentStateVersion: 2 } });
            // Exercise a new FK insertion, not an existing coalesced row whose
            // unchanged Session reference need not be revalidated by PostgreSQL.
            await db.accountChange.deleteMany({ where: { accountId: account.id, kind: 'session', entityId: source.id } });

            let release!: () => void;
            let acquired!: (pid: number) => void;
            const gate = new Promise<void>(resolve => { release = resolve; });
            const ready = new Promise<number>(resolve => { acquired = resolve; });
            // Physical deletion takes this same strong Session lock before its
            // Account tail. NOWAIT makes the inverted edge observable without
            // relying on a deadlock victim or changing production retry policy.
            const holder = db.$transaction(async tx => {
                await tx.$queryRaw`SELECT "id" FROM "Session" WHERE "id" = ${source.id} FOR UPDATE`;
                const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                acquired(backend!.pid);
                await gate;
                await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id" = ${account.id} FOR NO KEY UPDATE NOWAIT`;
            }, { timeout: 30_000 }).then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
            let progress: ReturnType<typeof acceptAccountFollowPersonalProgress> | undefined;
            try {
                const pid = await ready;
                progress = acceptAccountFollowPersonalProgress({ accountId: account.id, authentication,
                    occurrence: { ...occurrence, sourceRequests: { ...occurrence.sourceRequests, agentStateVersion: 2 } } });
                void progress.catch(() => undefined);
                await vi.waitFor(async () => {
                    const [waiting] = await db.$queryRaw<Array<{ blocked: boolean }>>`
                        SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))) AS blocked`;
                    expect(waiting?.blocked).toBe(true);
                });
                release();
                expect(await holder).toEqual({ ok: true });
                expect(await progress).toEqual({ ok: true, value: { accepted: true, alreadyRepresented: false } });
                expect(await getAccountFollowRule(scope)).toMatchObject({ ok: true, value: { rule: {
                    sources: [{ sourceSessionId: source.id, delivered: { agentStateVersion: 2 } }],
                } } });
                expect(await db.accountChange.findFirst({ where: { accountId: account.id, kind: 'session', entityId: source.id } }))
                    .toMatchObject({ sessionId: source.id });
            } finally {
                release();
                await holder;
                await progress?.catch(() => undefined);
            }
        } finally {
            if (previousHome === undefined) delete process.env.HAPPIER_SERVER_IDENTITY_ID;
            else process.env.HAPPIER_SERVER_IDENTITY_ID = previousHome;
            // The disposable database harness owns teardown of this connected
            // Session/Machine fixture, as it does the socket ACK fixtures below.
        }
    });

    it('observes pending Follow work while the same socket heartbeat waits on Account publication', async () => {
        const previousSessions = process.env.HAPPIER_FEATURE_SESSIONS__ENABLED;
        const previousFollowing = process.env.HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED;
        process.env.HAPPIER_FEATURE_SESSIONS__ENABLED = '1';
        process.env.HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED = '1';
        try {
            await assertConcurrentFailedTurnRouteAcknowledgements({
                duringObservation: async ({ accountId, presence, socket, observe }) => {
                    let release!: () => void;
                    let locked!: (pid: number) => void;
                    const gate = new Promise<void>(resolve => { release = resolve; });
                    const acquired = new Promise<number>(resolve => { locked = resolve; });
                    const holder = db.$transaction(async tx => {
                        await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id" = ${accountId} FOR NO KEY UPDATE`;
                        const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                        locked(backend!.pid);
                        await gate;
                    }, { timeout: 30_000 });
                    let heartbeat: ReturnType<typeof presence.touchPublisher> | undefined;
                    let observation: Awaited<ReturnType<typeof observe>> | undefined;
                    let pendingObservation: ReturnType<typeof observe> | undefined;
                    try {
                        const pid = await acquired;
                        heartbeat = presence.touchPublisher({ socket });
                        await vi.waitFor(async () => {
                            const [waiting] = await db.$queryRaw<Array<{ blocked: boolean }>>`
                                SELECT EXISTS(SELECT 1 FROM pg_stat_activity
                                    WHERE ${pid}::int = ANY(pg_blocking_pids(pid))) AS blocked`;
                            expect(waiting?.blocked).toBe(true);
                        });
                        pendingObservation = observe();
                        void pendingObservation.then(value => { observation = value; });
                        await vi.waitFor(() => expect(observation).toBeDefined(), { timeout: 1_000 });
                        return observation!;
                    } finally {
                        release();
                        await holder;
                        await heartbeat;
                        await pendingObservation?.catch(() => undefined);
                    }
                },
            });
        } finally {
            if (previousSessions === undefined) delete process.env.HAPPIER_FEATURE_SESSIONS__ENABLED;
            else process.env.HAPPIER_FEATURE_SESSIONS__ENABLED = previousSessions;
            if (previousFollowing === undefined) delete process.env.HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED;
            else process.env.HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED = previousFollowing;
        }
    });

    it('commits both concurrent socket routes for one accepted input and a failed source turn', async () => {
        const previousSessions = process.env.HAPPIER_FEATURE_SESSIONS__ENABLED;
        const previousFollowing = process.env.HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED;
        process.env.HAPPIER_FEATURE_SESSIONS__ENABLED = '1';
        process.env.HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED = '1';
        try { await assertConcurrentFailedTurnRouteAcknowledgements({
            duringAcknowledgements: async ({ accountId, presence, socket, acknowledge }) => {
                let release!: () => void;
                let locked!: (pid: number) => void;
                const gate = new Promise<void>(resolve => { release = resolve; });
                const acquired = new Promise<number>(resolve => { locked = resolve; });
                const holder = db.$transaction(async tx => {
                    await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id" = ${accountId} FOR NO KEY UPDATE`;
                    const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                    locked(backend!.pid);
                    await gate;
                }, { timeout: 30_000 });
                let heartbeat: ReturnType<typeof presence.touchPublisher> | undefined;
                try {
                    const pid = await acquired;
                    heartbeat = presence.touchPublisher({ socket });
                    // Prove the same socket's heartbeat is actually waiting for
                    // this Account holder, rather than inferring from elapsed time.
                    await vi.waitFor(async () => {
                        const [waiting] = await db.$queryRaw<Array<{ blocked: boolean }>>`
                            SELECT EXISTS(SELECT 1 FROM pg_stat_activity
                                WHERE ${pid}::int = ANY(pg_blocking_pids(pid))) AS blocked`;
                        expect(waiting?.blocked).toBe(true);
                    });
                    await acknowledge(); // Must commit both routes before releasing Account.
                } finally {
                    release();
                    await holder;
                    await heartbeat;
                }
            },
        }); }
        finally {
            if (previousSessions === undefined) delete process.env.HAPPIER_FEATURE_SESSIONS__ENABLED;
            else process.env.HAPPIER_FEATURE_SESSIONS__ENABLED = previousSessions;
            if (previousFollowing === undefined) delete process.env.HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED;
            else process.env.HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED = previousFollowing;
        }
    });

    it('settles a covered ordinary prefix after manager ACK, preserving attachment, publisher and live-turn fences', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        try {
            const source = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}',
                encryptionMode: 'plain', seq: 0, latestTurnId: 'previous', latestTurnStatus: 'completed' } });
            const destination = await db.session.create({ data: { accountId: account.id, tag: randomUUID(),
                metadata: '{}', encryptionMode: 'plain', publisherGeneration: 1n } });
            const authentication = createPresentUserSessionAccessAuthentication({ env: {} });
            const principal = { kind: 'destination_runtime' as const, destinationRuntimeAccountId: account.id, authentication };
            expect(await setSessionFollowSource({ policy: { preset: 'quiet' as const }, accountId: account.id, sourceSessionId: source.id,
                destinationSessionId: destination.id, authentication })).toMatchObject({ ok: true });
            expect(await setSessionManager({ accountId: account.id, sessionId: source.id, managerSessionId: destination.id,
                expectedManagerSessionId: null, authentication })).toMatchObject({ ok: true });
            await db.session.update({ where: { id: source.id }, data: { seq: 3, latestTurnId: 'current', latestTurnStatus: 'failed' } });
            const result = await inTx(tx => observePendingSessionFollowForDestinationInTx(tx, {
                principal, destinationSessionId: destination.id, includeManager: true,
            }));
            const observations = result.observations.filter(row => 'relation' in row && row.relation !== 'rule');
            const manager = observations.find(row => row.relation === 'manager');
            const follower = observations.find(row => row.relation === 'follower');
            if (!manager || !follower) throw new Error('Expected independently admitted manager and ordinary routes');
            const represented = observations.map(row => ({ policy: row.policy, sourceSessionId: row.sourceSessionId, relation: row.relation,
                ...(row.relation === 'manager' ? { attachedAt: row.attachedAt } : {}),
                expected: row.delivered, consumed: { ...row.delivered, transcriptSeq: 1 } }));
            const eventLocalId = deriveSessionFollowWakeEventLocalIdV1({ destinationSessionId: destination.id,
                publisherGeneration: destination.publisherGeneration.toString(), observations: represented });
            // The durable host-event boundary is real; no admitted-input witness is substituted.
            await db.sessionMessage.create({ data: { sessionId: destination.id, seq: 1, localId: eventLocalId,
                messageRole: 'event', content: { t: 'plain', v: { role: 'agent', content: { type: 'event',
                    data: TranscriptRawAgentEventV1Schema.parse({ type: 'message', message: SESSION_FOLLOW_WAKE_EVENT_MESSAGE }) } } },
                transcriptObservationProvenance: { kind: 'non_dependent', source: 'external' } } });
            const base = { principal, sourceSessionId: source.id, destinationSessionId: destination.id,
                expectedPublisherGeneration: destination.publisherGeneration,
                acceptance: { kind: 'context_only_wake' as const, eventLocalId, observations: represented } };
            const managerConsumed = { ...manager.delivered, transcriptSeq: 1 };
            expect(await inTx(tx => acknowledgeSessionFollowFrontierInTx(tx, { ...base, relation: 'manager',
                policy: manager.policy,
                attachedAt: manager.attachedAt, expected: manager.delivered, observed: manager.observed, consumed: managerConsumed })))
                .toEqual({ ok: true, delivered: managerConsumed });
            const followerConsumed = { ...follower.delivered, transcriptSeq: 1 };
            const followerAck = { ...base, policy: follower.policy, relation: 'follower' as const, expected: follower.delivered,
                observed: follower.observed, consumed: followerConsumed };
            expect(await inTx(tx => acknowledgeSessionFollowFrontierInTx(tx, {
                ...followerAck, expectedPublisherGeneration: destination.publisherGeneration + 1n,
            }))).toEqual({ ok: false, rejection: 'stale_publisher_generation' });
            await db.session.update({ where: { id: source.id }, data: { latestTurnId: 'successor' } });
            expect(await inTx(tx => acknowledgeSessionFollowFrontierInTx(tx, followerAck)))
                .toEqual({ ok: false, rejection: 'stale_terminal_turn' });
            await db.session.update({ where: { id: source.id }, data: { latestTurnId: 'current' } });
            expect(await inTx(tx => acknowledgeSessionFollowFrontierInTx(tx, followerAck)))
                .toEqual({ ok: true, delivered: followerConsumed });
            const pending = (await inTx(tx => observePendingSessionFollowForDestinationInTx(tx, {
                principal, destinationSessionId: destination.id, includeManager: true,
            }))).observations.filter(row => 'relation' in row && row.relation !== 'rule');
            expect(pending).toHaveLength(2);
            expect(pending.every(row => row.delivered.transcriptSeq === 1 && row.observed.transcriptSeq === 3)).toBe(true);
            expect(pending.find(row => row.relation === 'follower')?.delivered.turn).toEqual(follower.delivered.turn);
            const nextRepresented = pending.map(row => ({ policy: row.policy, sourceSessionId: row.sourceSessionId, relation: row.relation,
                ...(row.relation === 'manager' ? { attachedAt: row.attachedAt } : {}),
                expected: row.delivered, consumed: { ...row.delivered, transcriptSeq: 2 } }));
            const nextEventLocalId = deriveSessionFollowWakeEventLocalIdV1({ destinationSessionId: destination.id,
                publisherGeneration: destination.publisherGeneration.toString(), observations: nextRepresented });
            await db.sessionMessage.create({ data: { sessionId: destination.id, seq: 2, localId: nextEventLocalId,
                messageRole: 'event', content: { t: 'plain', v: { role: 'agent', content: { type: 'event',
                    data: TranscriptRawAgentEventV1Schema.parse({ type: 'message', message: SESSION_FOLLOW_WAKE_EVENT_MESSAGE }) } } },
                transcriptObservationProvenance: { kind: 'non_dependent', source: 'external' } } });
            expect(await setSessionManager({ accountId: account.id, sessionId: source.id, managerSessionId: null,
                expectedManagerSessionId: destination.id, authentication })).toMatchObject({ ok: true });
            expect(await setSessionManager({ accountId: account.id, sessionId: source.id, managerSessionId: destination.id,
                expectedManagerSessionId: null, authentication })).toMatchObject({ ok: true });
            // The accepted batch cannot settle even its unchanged ordinary route after reattachment.
            expect(await inTx(tx => acknowledgeSessionFollowFrontierInTx(tx, { ...followerAck,
                expected: followerConsumed, consumed: { ...followerConsumed, transcriptSeq: 2 },
                acceptance: { kind: 'context_only_wake', eventLocalId: nextEventLocalId, observations: nextRepresented },
            })))
                .toEqual({ ok: false, rejection: 'provider_acceptance_unverified' });
        } finally {
            await db.sessionMessage.deleteMany({ where: { session: { accountId: account.id } } });
            await db.sessionFollowEdge.deleteMany({ where: { sourceSession: { accountId: account.id } } });
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });
});
