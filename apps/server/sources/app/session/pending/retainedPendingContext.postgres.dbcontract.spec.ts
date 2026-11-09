import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MACHINE_PLAIN_DATA_KEY_MARKER, decodeBase64, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { SessionFollowInputV1Schema, deriveSessionFollowInputLocalIdV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { buildTrustedHostSessionInputAdmissionV1, SessionInputRequestV1Schema, withSessionInputRequestV1,
    SESSION_MESSAGE_PROVENANCE_META_KEY } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';

import { db, initDbPostgres } from '@/storage/db';
import { getDbProviderFromEnv } from '@/storage/prisma';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { sourceKeyForSessionFollowSourceV1 } from '@/app/session/follow/sessionFollowSourceIdentity';
import { blockPendingDelivery, enqueuePendingMessage, enqueuePendingMessageByAuthenticatedMachine, resolveAcceptedPendingDelivery } from './pendingMessageService';
import { materializeNextPendingMessage } from './materializeNextPendingMessage';
import { hasCanonicalFollowProviderInputAcceptanceInTx } from '@/app/session/follow/providerInputAcceptance';
import { inTx } from '@/storage/inTx';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('retained Pending context (disposable PostgreSQL)', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Use the disposable Docker PostgreSQL contract harness');
        }
        vi.stubEnv('HAPPIER_SERVER_IDENTITY_ID', 'srv_01234567890123456789012345678901');
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY', 'optional');
        vi.stubEnv('HAPPIER_FEATURE_SESSIONS__ENABLED', 'true');
        vi.stubEnv('HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED', 'true');
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); vi.unstubAllEnvs(); });

    it('accepts fresh Run input while retaining an earlier unclaimed unavailable refusal', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, installationId: randomUUID(),
            metadata: encodePlainMachineStoredContent({ host: 'host', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
            dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER)),
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } },
            operationProtocolCapabilitiesRevision: 1 } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        await db.accessKey.create({ data: { accountId: account.id, sessionId: session.id, machineId: machine.id, data: randomUUID() } });
        const presence = createSessionPublisherPresence();
        const binding = { accountId: account.id, sessionId: session.id, machineId: machine.id };
        const registration = await presence.registerPublisher({ socket: {}, binding,
            completeActivitySnapshot: { state: 'idle', activeCount: 0 } });
        if (registration.status !== 'registered') throw new Error(`Publisher fixture refused: ${registration.reason}`);
        const publisherAuthority = { ...binding, committedFence: registration.committedFence };
        const runId = randomUUID();
        const input = { actorUserId: account.id, sessionId: session.id, targetExecutionRunId: runId,
            authentication: createPresentUserSessionAccessAuthentication(), targetMachineId: machine.id,
            requestedAction: { v: 1, kind: 'enqueue' }, content: { t: 'plain', v: {
                role: 'user', content: { type: 'text', text: 'Continue' },
                meta: { happier: { kind: 'participant_message.v1', payload: { recipient: { kind: 'execution_run', runId } } } },
            } } } as const;
        const blockedId = randomUUID();
        expect(await enqueuePendingMessage({ ...input, localId: blockedId })).toMatchObject({ ok: true, didWrite: true });
        expect(await blockPendingDelivery({ ...binding, actorUserId: account.id, targetExecutionRunId: runId,
            publisherAuthority, localId: blockedId, reason: 'session_input_target_unavailable' })).toMatchObject({ ok: true, didUpdate: true });
        const localId = randomUUID();
        expect(await enqueuePendingMessage({ ...input, localId })).toMatchObject({ ok: true, didWrite: true });
        expect(await materializeNextPendingMessage({ actorUserId: account.id, sessionId: session.id,
            publisherAuthority, targetExecutionRunId: runId, expectedSidechainId: runId,
            deliveryState: 'provider', deliveryTiming: 'after_foreground_ready', foregroundState: 'ready' }))
            .toMatchObject({ ok: true, didMaterialize: true, message: { localId } });
        expect(await resolveAcceptedPendingDelivery({ actorUserId: account.id, sessionId: session.id, localId,
            publisherAuthority, targetExecutionRunId: runId, expectedSidechainId: runId,
            acceptedTurn: { kind: 'followUp', turnId: randomUUID() } })).toMatchObject({ ok: true, didResolve: true });
        expect(await db.sessionMessage.findMany({ where: { sessionId: session.id }, select: { localId: true } })).toEqual([{ localId }]);
        expect(await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId: blockedId } } }))
            .toMatchObject({ status: 'queued', deliveryState: 'blocked', deliveryBlockedReason: 'session_input_target_unavailable', providerAction: null });
    });

    it.each(['delivering', 'reconnect', 'ordinary-head', 'successor'] as const)(
        'accepts only the natural input while retaining omitted information (%s)', async scenario => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, installationId: randomUUID(),
            metadata: encodePlainMachineStoredContent({ host: 'host', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
            dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER)),
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1] }, sessionFollow: { contextV1: true } },
            operationProtocolCapabilitiesRevision: 1 } });
        const [session, source] = await Promise.all([0, 1].map(seq => db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain', seq,
        } })));
        await db.accessKey.create({ data: { accountId: account.id, sessionId: session.id, machineId: machine.id, data: 'key' } });
        const presence = createSessionPublisherPresence();
        const binding = { accountId: account.id, sessionId: session.id, machineId: machine.id };
        const socket = {};
        const registration = await presence.registerPublisher({ socket, binding,
            completeActivitySnapshot: { state: 'idle', activeCount: 0 } });
        expect(registration).toMatchObject({ status: 'registered' });
        if (registration.status !== 'registered') throw new Error('Publisher fixture refused');
        let publisherAuthority = { ...binding, committedFence: registration.committedFence };
        const materialize = (localIds?: string[]) => materializeNextPendingMessage({ actorUserId: account.id,
            sessionId: session.id, publisherAuthority, deliveryState: 'provider', deliveryTiming: 'after_foreground_ready',
            foregroundState: 'ready', ...(localIds ? { retainedContext: { localIds } } : {}) });
        const ordinaryId = randomUUID();
        const humanId = randomUUID();
        const enqueue = (localId: string) => enqueuePendingMessage({ actorUserId: account.id,
            authentication: createPresentUserSessionAccessAuthentication(), sessionId: session.id, localId,
            targetMachineId: machine.id, requestedAction: { v: 1, kind: 'enqueue' },
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Continue' } } } });
        const edge = await db.sessionFollowEdge.create({ data: { destinationSessionId: session.id, sourceSessionId: source.id,
            sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: source.id }),
            relation: 'manager', managerSourceSessionId: source.id, policyJson: JSON.stringify({ preset: 'important' }) } });
        const original = await db.sessionMessage.create({ data: { sessionId: source.id, seq: 1, localId: randomUUID(),
            messageRole: 'agent', content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Original result' } } } } });
        const delivery = SessionFollowInputV1Schema.parse({ v: 1, delivery: 'next_turn', event: { kind: 'update_posted' },
            original: { sourceSessionId: source.id, sourceMessage: { localId: original.localId, seq: original.seq } } });
        const quietId = deriveSessionFollowInputLocalIdV1({ destinationSessionId: session.id, original: delivery.original });
        const host = buildTrustedHostSessionInputAdmissionV1('agent');
        const request = SessionInputRequestV1Schema.parse({ ...host.request, followDeliveryV1: delivery });
        expect(await enqueuePendingMessageByAuthenticatedMachine({ accountId: account.id, sourceMachineId: machine.id,
            targetMachineId: machine.id, sessionId: session.id, localId: quietId,
            requestedAction: { v: 1, kind: 'enqueue' }, followDeliveryV1: delivery,
            followRelations: [{ relation: 'manager', attachedAt: edge.attachedAt.getTime() }],
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: '' },
                meta: withSessionInputRequestV1({ [SESSION_MESSAGE_PROVENANCE_META_KEY]: host.provenance }, request) } },
        })).toMatchObject({ status: 'accepted', localId: quietId });
        expect(await materialize()).toMatchObject({ ok: true, didMaterialize: true, message: { localId: quietId } });

        if (scenario === 'reconnect' || scenario === 'successor') {
            const next = await presence.registerPublisher({ socket: scenario === 'reconnect' ? socket : {}, binding,
                completeActivitySnapshot: { state: 'idle', activeCount: 0 } });
            if (next.status !== 'registered') throw new Error('Replacement publisher fixture refused');
            publisherAuthority = { ...binding, committedFence: next.committedFence };
            expect(await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: {
                sessionId: session.id, localId: quietId } } })).toMatchObject({
                deliveryState: 'blocked', deliveryBlockedReason: 'delivery_outcome_uncertain' });
        }
        if (scenario === 'ordinary-head') {
            expect(await enqueue(ordinaryId)).toMatchObject({ ok: true });
            expect(await materialize([quietId])).toMatchObject({ ok: true, didMaterialize: true, message: { localId: ordinaryId } });
            expect(await materialize([quietId, ordinaryId])).toMatchObject({ ok: false, error: 'invalid-params' });
        }
        expect(await enqueue(humanId)).toMatchObject({ ok: true });
        if (scenario === 'successor') {
            expect(await materialize()).toMatchObject({ ok: true, didMaterialize: false });
            expect(await db.sessionMessage.count({ where: { sessionId: session.id } })).toBe(0);
            return;
        }
        if (scenario === 'ordinary-head') {
            expect(await materialize([quietId])).toMatchObject({ ok: true, didMaterialize: true, message: { localId: ordinaryId } });
            // Model a late provider result at the storage boundary. Even a claimed
            // later input cannot settle past ordinary unresolved FIFO custody.
            await db.sessionPendingMessage.update({ where: { sessionId_localId: { sessionId: session.id, localId: humanId } },
                data: { deliveryState: 'delivering' } });
            expect(await resolveAcceptedPendingDelivery({ actorUserId: account.id, sessionId: session.id,
                localId: humanId, publisherAuthority })).toMatchObject({ ok: false, error: 'blocked-by-earlier-pending' });
            expect(await db.sessionMessage.count({ where: { sessionId: session.id } })).toBe(0);
            return;
        }
        expect(await materialize([quietId])).toMatchObject({ ok: true, didMaterialize: true, message: { localId: humanId } });
        const accepted = { actorUserId: account.id, sessionId: session.id, localId: humanId, publisherAuthority,
            acceptedTurn: { kind: 'newTurn' as const, turnId: randomUUID() } };
        expect(await resolveAcceptedPendingDelivery(accepted)).toEqual({ ok: false, error: 'turn-publication-pending' });
        expect(await db.sessionMessage.count({ where: { sessionId: session.id } })).toBe(0);
        expect(await db.sessionPendingMessage.count({ where: { sessionId: session.id } })).toBe(2);
        await db.sessionTurn.create({ data: { sessionId: session.id, turnId: accepted.acceptedTurn.turnId,
            status: 'in_progress', startedAt: 1n, updatedAt: 1n } });
        expect(await resolveAcceptedPendingDelivery(accepted)).toMatchObject({ ok: true, didResolve: true });
        expect(await resolveAcceptedPendingDelivery(accepted)).toMatchObject({ ok: true, didResolve: false });
        expect(await db.sessionMessage.findMany({ where: { sessionId: session.id }, select: { localId: true } }))
            .toEqual([{ localId: humanId }]);
        expect(await db.sessionPendingMessage.findMany({ where: { sessionId: session.id }, select: { localId: true, status: true } }))
            .toEqual([{ localId: quietId, status: 'queued' }]);
        expect(await inTx(tx => hasCanonicalFollowProviderInputAcceptanceInTx(tx, { destinationSessionId: session.id,
            localInputId: humanId, userMessageSeq: null, requireProviderAccepted: true }))).toBe(true);
        expect(await inTx(tx => hasCanonicalFollowProviderInputAcceptanceInTx(tx, { destinationSessionId: session.id,
            localInputId: quietId, userMessageSeq: null, requireProviderAccepted: true }))).toBe(false);
        expect((await db.sessionFollowEdge.findUniqueOrThrow({ where: { managerSourceSessionId: source.id } }))
            .deliveredTranscriptSeq).toBe(0);
    });
});
