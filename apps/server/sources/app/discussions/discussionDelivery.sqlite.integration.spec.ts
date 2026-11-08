import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildDiscussionMutationRequestBodyV1 } from '@happier-dev/protocol/discussions/api';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { inTx } from '@/storage/inTx';
import { observeDiscussionFollowSourcesInTx } from '@/app/session/follow/discussionFollowSource';
import { sourceKeyForSessionFollowSourceV1 } from '@/app/session/follow/sessionFollowSourceIdentity';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { decodeBase64 } from 'privacy-kit';
import { buildTrustedHostSessionInputAdmissionV1, SessionInputRequestV1Schema, withSessionInputRequestV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { DEFAULT_PENDING_REQUESTED_ACTION_V1 } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import { deriveDiscussionFollowInputLocalIdV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { enqueuePendingMessageByAuthenticatedMachine } from '@/app/session/pending/pendingMessageService';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { createDiscussion, postDiscussionMessage } from './mutations';
import { inviteDiscussionParticipant } from './accessService';
import { readDiscussionMessages } from './queries';
import { projectDiscussionMessageDeliveriesInTx } from './deliveryProjection';

const authentication = createPresentUserSessionAccessAuthentication();
const document = (text: string) => ({ v: 1 as const, parts: [{ t: 'text' as const, text }] });

describe('Discussion delivery custody (SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-discussion-delivery-', env: {
            HAPPIER_FEATURE_SESSIONS__ENABLED: '1', HAPPIER_FEATURE_SESSIONS_CONVERSATIONS__ENABLED: '1',
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
        } });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it('keeps every addressed receiver across the portable database bind boundary', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const created = await createDiscussion({ authentication, actorAccountId: owner.id, request: {
            creationLocalId: randomUUID(), titleContent: { t: 'plain', v: { v: 1, title: 'Many receivers' } },
            firstMessage: { localId: randomUUID(), content: { t: 'plain', v: document('Start') }, mentionedAccountIds: [] },
        } });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        const sessions = Array.from({ length: 1000 }, () => ({ id: `c${randomUUID().replaceAll('-', '').slice(0, 23)}`,
            accountId: owner.id, tag: randomUUID(), encryptionMode: 'plain' as const, metadata: '{}' }));
        await db.session.createMany({ data: sessions });
        await db.sessionFollowEdge.createMany({ data: sessions.map(session => ({ destinationSessionId: session.id,
            sourceDiscussionId: discussionId, sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'discussion', discussionId }),
            relation: 'follower', policyJson: '{"preset":"important"}', deliveredTranscriptSeq: 0 })) });
        const addresses = sessions.map(session => ({ discussionId, messageId: created.value.firstMessage.id,
            participantSessionId: session.id, throughSeq: 1 }));
        const boundValues = (value: unknown): number => Array.isArray(value) ? value.reduce((sum, item) => sum + boundValues(item), 0)
            : value !== null && typeof value === 'object' ? Object.values(value).reduce<number>((sum, item) => sum + boundValues(item), 0) : 1;
        const pending = await inTx(async tx => {
            // Observe the real database boundary; all reads still execute against SQLite.
            const edgeRead = tx.sessionFollowEdge.findMany.bind(tx.sessionFollowEdge);
            const pendingRead = tx.sessionPendingMessage.findMany.bind(tx.sessionPendingMessage);
            const messageRead = tx.sessionMessage.findMany.bind(tx.sessionMessage);
            const edgeSpy = vi.spyOn(tx.sessionFollowEdge, 'findMany').mockImplementation(args => {
                expect.soft(boundValues(args?.where)).toBeLessThanOrEqual(999);
                return edgeRead(args);
            });
            const pendingSpy = vi.spyOn(tx.sessionPendingMessage, 'findMany').mockImplementation(args => {
                expect.soft(boundValues(args?.where)).toBeLessThanOrEqual(999);
                return pendingRead(args);
            });
            const messageSpy = vi.spyOn(tx.sessionMessage, 'findMany').mockImplementation(args => {
                expect.soft(boundValues(args?.where)).toBeLessThanOrEqual(999);
                return messageRead(args);
            });
            try {
                const [message] = await projectDiscussionMessageDeliveriesInTx(tx, [{ ...created.value.firstMessage,
                    addressingV1: { throughSeq: 1, participantSessionIds: sessions.map(session => session.id) } }]);
                return new Set(message!.participantDeliveryV1?.map(delivery => deriveDiscussionFollowInputLocalIdV1({
                    discussionId, messageId: message!.id, throughSeq: message!.seq, participantSessionId: delivery.participantSessionId })));
            }
            finally { edgeSpy.mockRestore(); pendingSpy.mockRestore(); messageSpy.mockRestore(); }
        });
        expect(pending).toEqual(new Set(addresses.map(deriveDiscussionFollowInputLocalIdV1)));
    });

    it('projects pending custody on an initial addressed question and its idempotent create response', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const content = { v: 1 as const, parts: [{ t: 'mention' as const, participant: { kind: 'session' as const, sessionId: session.id } }] };
        const input = { authentication, actorAccountId: owner.id, request: buildDiscussionMutationRequestBodyV1({ kind: 'create',
            creationLocalId: randomUUID(), titleContent: { t: 'plain', v: { v: 1, title: 'Initial delivery' } },
            participants: [{ kind: 'session', sessionId: session.id }],
            firstMessage: { localId: randomUUID(), content: { t: 'plain', v: content }, authoredContent: content,
                mentionedAccountIds: [], mentionedSessionIds: [session.id] } }) };
        const created = await createDiscussion(input);
        expect.soft(created).toMatchObject({ ok: true, value: { firstMessage: {
            participantDeliveryV1: [{ participantSessionId: session.id, disposition: 'pending' }] } } });
        expect(await createDiscussion(input)).toMatchObject({ ok: true, value: { firstMessage: {
            participantDeliveryV1: [{ participantSessionId: session.id, disposition: 'pending' }] } } });
    });

    it('keeps an unaccepted ask visible and retries the exact original without another message', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const created = await createDiscussion({ authentication, actorAccountId: owner.id, request: {
            creationLocalId: randomUUID(), titleContent: { t: 'plain', v: { v: 1, title: 'Delivery' } },
            firstMessage: { localId: randomUUID(), content: { t: 'plain', v: document('Start') }, mentionedAccountIds: [] },
        } });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'session', sessionId: session.id }, answerPolicy: 'drafts_for_approval' } })).toMatchObject({ ok: true });
        const content = { v: 1 as const, parts: [{ t: 'mention' as const, participant: { kind: 'session' as const, sessionId: session.id } },
            { t: 'text' as const, text: 'Please inspect this' }] };
        const input = { authentication, actorAccountId: owner.id, discussionId,
            request: buildDiscussionMutationRequestBodyV1({ kind: 'post', localId: randomUUID(), content: { t: 'plain', v: content },
                authoredContent: content, mentionedAccountIds: [], mentionedSessionIds: [session.id] }) };
        const posted = await postDiscussionMessage(input);
        if (!posted.ok) throw new Error(posted.error);
        const pending = [{ participantSessionId: session.id, disposition: 'pending' }];
        expect.soft(posted.value.message.participantDeliveryV1).toEqual(pending);
        // A refused enqueue has no accepted Pending row: the committed original
        // and unacknowledged Follow frontier are its durable recovery authority.
        expect(await db.sessionPendingMessage.count({ where: { sessionId: session.id } })).toBe(0);
        const page = await readDiscussionMessages({ authentication, actorAccountId: owner.id, discussionId });
        if (!page.ok) throw new Error(page.error);
        expect.soft(page.value.messages.find(message => message.id === posted.value.message.id)?.participantDeliveryV1).toEqual(pending);
        const observations = await inTx(tx => observeDiscussionFollowSourcesInTx(tx, {
            destinationSessionId: session.id, destinationRuntimeAccountId: owner.id }));
        expect(observations.map(observation => observation.addressing.messageId)).toEqual([posted.value.message.id]);
        const retried = await postDiscussionMessage(input);
        expect(retried).toMatchObject({ ok: true, value: { message: { id: posted.value.message.id, participantDeliveryV1: pending } } });
        expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(2);
        await getOrCreateServerIdentityId();
        const machine = await db.machine.create({ data: { id: randomUUID(), installationId: randomUUID(), accountId: owner.id,
            metadata: encodePlainMachineStoredContent({ host: 'host', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] }, sessionMessageReply: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1 } });
        await db.accessKey.create({ data: { accountId: owner.id, machineId: machine.id, sessionId: session.id, data: 'encrypted' } });
        const discussion = observations[0]!.addressing;
        const request = SessionInputRequestV1Schema.parse({ ...buildTrustedHostSessionInputAdmissionV1('agent').request,
            discussionAddressing: discussion, replyIntent: { mode: 'return' } });
        const admission = { accountId: owner.id, sourceMachineId: machine.id, targetMachineId: machine.id, sessionId: session.id,
            localId: deriveDiscussionFollowInputLocalIdV1(discussion), requestedAction: DEFAULT_PENDING_REQUESTED_ACTION_V1,
            reply: { mode: 'return' as const, discussion },
            content: { t: 'plain' as const, v: { role: 'user', content: { type: 'text', text: 'Please inspect this' }, meta: withSessionInputRequestV1({}, request) } } };
        const cursor = async () => (await db.accountChange.findUniqueOrThrow({ where: { accountId_kind_entityId: {
            accountId: owner.id, kind: 'discussion', entityId: discussionId } } })).cursor;
        const before = await cursor();
        expect(await enqueuePendingMessageByAuthenticatedMachine(admission)).toMatchObject({ status: 'accepted' });
        expect.soft(await cursor()).toBeGreaterThan(before);
        const accepted = await readDiscussionMessages({ authentication, actorAccountId: owner.id, discussionId });
        if (!accepted.ok) throw new Error(accepted.error);
        expect(accepted.value.messages.find(message => message.id === discussion.messageId)).not.toHaveProperty('participantDeliveryV1');
        expect(await inTx(tx => observeDiscussionFollowSourcesInTx(tx, { destinationSessionId: session.id, destinationRuntimeAccountId: owner.id }))).toEqual([]);
        const acceptedCursor = await cursor();
        expect(await enqueuePendingMessageByAuthenticatedMachine(admission)).toMatchObject({ status: 'alreadyAccepted' });
        expect(await cursor()).toBe(acceptedCursor);
    });
});
