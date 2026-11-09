import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '../../../generated/sqlite-client';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import type { StrictSessionStoredMessageContentEnvelope } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { decodeBase64 } from 'privacy-kit';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { observePrismaReads } from '@/testkit/observePrismaReads';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import * as storage from '@/storage/prisma';
import { observePendingSessionFollowForDestinationInTx, acknowledgeDiscussionFollowInputInTx } from '@/app/session/follow/sessionFollowEdgeService';
import { createSessionInputReplyProgressInTx } from '@/app/session/messages/sessionMessageReply';
import { deriveDiscussionFollowInputLocalIdV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { DEFAULT_PENDING_REQUESTED_ACTION_V1 } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import { createDiscussion, postDiscussionMessage } from './mutations';
import { inviteDiscussionParticipant } from './accessService';
import { listDiscussions } from './queries';
import { encodeDiscussionListCursorV1 } from './pagination';
import { setDiscussionReadCursor } from './readState';
import type { DiscussionDocSource } from './docPassages';
import { discussionFollowPublicationCostContracts } from './discussionFollowCosts.testkit';

const authentication = createPresentUserSessionAccessAuthentication();
const body = (text: string) => ({ t: 'plain', v: { v: 1, parts: [{ t: 'text', text }] } } satisfies StrictSessionStoredMessageContentEnvelope);

describe('Discussion owner cost contracts (SQLite; not PostgreSQL lock evidence)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-discussion-costs-', initAuth: false, initEncrypt: true });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    discussionFollowPublicationCostContracts();

    it('measures physical append/read-marker SQL and suppresses publications on retries and equal or older reads', async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const created = await createDiscussion({ authentication, actorAccountId: owner.id, request: {
            creationLocalId: randomUUID(), titleContent: { t: 'plain', v: { v: 1, title: 'Costs' } },
            firstMessage: { localId: randomUUID(), content: body('First'), mentionedAccountIds: [] },
        } });
        if (!created.ok) throw new Error(created.error);
        const input = { authentication, actorAccountId: owner.id, discussionId: created.value.discussion.id };
        const request = { localId: randomUUID(), content: body('Second'), mentionedAccountIds: [] };
        const statements: string[] = [];
        const client = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
        client.$on('query', event => statements.push(event.query));
        await client.$connect();
        const original = db.$transaction;
        // Observe the native DB transport; every domain/transaction/publication owner stays real.
        db.$transaction = new Proxy(original, { apply(_target, _receiver, args) {
            return Reflect.apply(client.$transaction, client, args);
        } });
        try {
            const measure = async <T>(operation: string, run: () => Promise<T>, publications: number) => {
                const before = await db.account.findUniqueOrThrow({ where: { id: owner.id }, select: { seq: true } });
                statements.length = 0;
                const result = await run();
                const sql = [...statements];
                const after = await db.account.findUniqueOrThrow({ where: { id: owner.id }, select: { seq: true } });
                const cursorDelta = after.seq - before.seq;
                console.info('DISCUSSION_SQL_COST', JSON.stringify({ operation, statements: sql.length,
                    accountUpdates: sql.filter(query => /^UPDATE.*["`]Account["`]/.test(query)).length,
                    publications: cursorDelta }));
                expect(result).toMatchObject({ ok: true });
                expect(cursorDelta).toBe(publications);
                return result;
            };
            await measure('append', () => postDiscussionMessage({ ...input, request }), 1);
            await measure('append_retry', () => postDiscussionMessage({ ...input, request }), 0);
            await measure('read_advance', () => setDiscussionReadCursor({ ...input, lastReadSeq: 2 }), 1);
            const changedAt = (await db.discussionReadState.findUniqueOrThrow({ where: {
                discussionId_accountId: { discussionId: input.discussionId, accountId: owner.id },
            } })).updatedAt;
            await measure('read_equal', () => setDiscussionReadCursor({ ...input, lastReadSeq: 2 }), 0);
            await measure('read_older', () => setDiscussionReadCursor({ ...input, lastReadSeq: 1 }), 0);
            expect(await db.discussionReadState.findUniqueOrThrow({ where: {
                discussionId_accountId: { discussionId: input.discussionId, accountId: owner.id },
            } })).toMatchObject({ lastReadSeq: 2, updatedAt: changedAt });
            const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
            expect(await inviteDiscussionParticipant({ ...input, request: { participant: { kind: 'session', sessionId: session.id } } }))
                .toMatchObject({ ok: true });
            const uninvolved = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
            expect(await inviteDiscussionParticipant({ ...input, request: { participant: { kind: 'session', sessionId: uninvolved.id } } }))
                .toMatchObject({ ok: true });
            const uninvolvedChange = await db.accountChange.findUniqueOrThrow({ where: {
                accountId_kind_entityId: { accountId: owner.id, kind: 'session', entityId: uninvolved.id },
            } });
            const addressed = await measure('addressed_append', () => postDiscussionMessage({ ...input, request: {
                localId: randomUUID(), content: { t: 'plain', v: { v: 1, parts: [
                    { t: 'mention', participant: { kind: 'session', sessionId: session.id } },
                    { t: 'text', text: 'Question' },
                ] } }, mentionedAccountIds: [], mentionedSessionIds: [session.id],
            } }), 2);
            expect(addressed).toMatchObject({ ok: true });
            expect(await db.accountChange.findUniqueOrThrow({ where: {
                accountId_kind_entityId: { accountId: owner.id, kind: 'session', entityId: uninvolved.id },
            } })).toEqual(uninvolvedChange);
            const observation = () => inTx(tx => observePendingSessionFollowForDestinationInTx(tx, {
                principal: { kind: 'destination_runtime', destinationRuntimeAccountId: owner.id, authentication }, destinationSessionId: session.id,
            }));
            await measure('follow_observe', async () => {
                const observed = await observation();
                expect(observed.observations).toHaveLength(1);
                return { ok: true };
            }, 0);
            if (!addressed.ok) throw new Error(addressed.error);
            const addressing = { discussionId: input.discussionId, messageId: addressed.value.message.id,
                throughSeq: 3, participantSessionId: session.id };
            const localId = deriveDiscussionFollowInputLocalIdV1(addressing);
            // This isolates C3's accepted-Pending ACK boundary. It does not claim
            // to measure the containing Machine admission/transport operation.
            await measure('follow_pending_fixture_and_ack', () => inTx(async tx => {
                const progress = await createSessionInputReplyProgressInTx(tx, { accountId: owner.id, reply: { mode: 'return', discussion: addressing } });
                if (!progress) throw new Error('Reply custody unavailable');
                await tx.sessionPendingMessage.create({ data: { sessionId: session.id, localId, position: 1,
                    content: { t: 'plain', v: {} }, requestedAction: DEFAULT_PENDING_REQUESTED_ACTION_V1, replyProgress: progress,
                    inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine', discussionAddressing: addressing,
                        admittedTarget: { homeId: 'home', accountId: owner.id, sessionId: session.id, machineId: 'machine', installationId: 'installation' } } } });
                const beforeAck = statements.length;
                await acknowledgeDiscussionFollowInputInTx(tx, { addressing, localInputId: localId });
                const ackStatements = statements.length - beforeAck;
                console.info('DISCUSSION_FOLLOW_ACK_SQL', ackStatements);
                expect(ackStatements).toBe(2);
                return { ok: true };
            }), 0);
            await measure('follow_observe_after_ack', async () => {
                expect((await observation()).observations).toEqual([]);
                return { ok: true };
            }, 0);
        } finally {
            db.$transaction = original;
            await client.$disconnect();
        }
    });

    it('fetches only Doc-scoped candidates despite a thousand unrelated newer Discussions', async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const artifact = await createArtifact({ actorUserId: owner.id, artifactId: randomUUID(),
            header: decodeBase64(encodePlainArtifactStoredContent({ title: 'Source', kind: 'markdown' })),
            body: decodeBase64(encodePlainArtifactStoredContent({ body: 'Text' })),
            dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!artifact.ok) throw new Error(artifact.error);
        const doc: DiscussionDocSource = { ref: { kind: 'doc', serverId: 'test-home', artifactId: artifact.artifact.id },
            revision: { headerVersion: artifact.artifact.headerVersion, bodyVersion: artifact.artifact.bodyVersion } };
        const created = await createDiscussion({ authentication, actorAccountId: owner.id, request: {
            creationLocalId: randomUUID(), anchor: { kind: 'doc', doc },
            titleContent: { t: 'plain', v: { v: 1, title: 'Scoped' } },
            firstMessage: { localId: randomUUID(), content: { t: 'plain', v: { kind: 'doc_passage_comment',
                passage: { ...doc, range: { start: 0, end: 4 }, quote: 'Text' }, content: body('Comment').v } },
                replyTarget: { kind: 'doc_passage', doc }, mentionedAccountIds: [] },
        } });
        if (!created.ok) throw new Error(created.error);
        const outsider = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        await db.discussion.createMany({ data: Array.from({ length: 1_001 }, (_, index) => ({
            ownerAccountId: index % 2 === 0 ? owner.id : outsider.id, encryptionMode: 'plain',
            createdByAccountId: index % 2 === 0 ? owner.id : outsider.id,
            ...(index % 2 === 0 ? {} : { anchorV1: { kind: 'doc', doc } }),
            dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER),
            creationLocalId: randomUUID(), creationEqualityEvidenceV1: { kind: 'plainDigest', digest: 'A'.repeat(43) },
            titleContent: { t: 'plain', v: { v: 1, title: 'Unrelated' } }, messageSeq: 0,
            lastMessageAt: new Date(Date.now() + 1_000),
        })) });
        const original = storage.withSqliteReadSnapshot;
        let fetched = 0;
        // Observe rows at the database adapter without replacing the real snapshot or queries.
        const observation = vi.spyOn(storage, 'withSqliteReadSnapshot').mockImplementation((read, options) => original(async tx => {
            const observed = observePrismaReads(tx, ['discussion']);
            try { return await read(observed.tx); }
            finally { fetched += observed.rows.reduce((count, row) => count + row.ids.length, 0); }
        }, options));
        try {
            const result = await listDiscussions({ authentication, actorAccountId: owner.id, anchorDocArtifactId: doc.ref.artifactId, limit: 1,
                cursor: encodeDiscussionListCursorV1({ v: 1, at: Date.now() + 2_000, id: 'start' }) });
            expect(result).toMatchObject({ ok: true, value: { discussions: [{ id: created.value.discussion.id }], nextCursor: null } });
            console.info('DISCUSSION_DOC_CANDIDATE_ROWS', fetched);
            // One matching candidate plus its access admission; unrelated rows never leave storage.
            expect(fetched).toBe(2);
        } finally { observation.mockRestore(); }
    });
});
