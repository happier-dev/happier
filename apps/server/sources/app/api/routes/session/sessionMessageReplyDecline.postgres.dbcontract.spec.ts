import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { auth } from '@/app/auth/auth';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { createDiscussion, postDiscussionMessage } from '@/app/discussions/mutations';
import { inviteDiscussionParticipant } from '@/app/discussions/accessService';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { createSessionInputReplyProgressInTx } from '@/app/session/messages/sessionMessageReply';
import { db, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { buildDiscussionMutationRequestBodyV1 } from '@happier-dev/protocol/discussions/api';
import { SessionMessageReplyProgressV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { registerSessionMessageRoutes } from './registerSessionMessageRoutes';

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== 'postgres')('reply draft decline on PostgreSQL', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Requires the disposable PostgreSQL DB-contract harness');
        }
        vi.stubEnv('HANDY_MASTER_SECRET', 'reply-decline-disposable-secret');
        vi.stubEnv('AUTH_REQUIRED_LOGIN_PROVIDERS', '');
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY', 'optional');
        initDbPostgres(); await db.$connect(); await auth.init();
    });
    afterAll(async () => { await shutdownDbClient(); vi.unstubAllEnvs(); });

    it.each([
        ['transcript', 'discussion_review'], ['pending', 'discussion_review'],
        ['transcript', 'discussion_publication'], ['pending', 'discussion_publication'],
    ] as const)('declines %s custody through %s durably without publishing the draft', async (custody, kind) => {
        const authentication = createPresentUserSessionAccessAuthentication();
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const reader = await db.account.create({ data: { encryptionMode: 'plain' } });
        await makeShareEligibleForTest(account.id, [reader.id]);
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const document = { v: 1 as const, parts: [{ t: 'text' as const, text: 'Please draft a reply' }] };
        const created = await createDiscussion({ authentication, actorAccountId: account.id, request: buildDiscussionMutationRequestBodyV1({
            kind: 'create', creationLocalId: randomUUID(), titleContent: { t: 'plain', v: { v: 1, title: 'Reply decline' } },
            participants: [{ kind: 'account', accountId: reader.id }],
            firstMessage: { localId: randomUUID(), content: { t: 'plain', v: document }, authoredContent: document, mentionedAccountIds: [] },
        }) });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: account.id, discussionId,
            request: { participant: { kind: 'session', sessionId: session.id }, answerPolicy: 'drafts_for_approval' } })).toMatchObject({ ok: true });
        const questionContent = { v: 1 as const, parts: [{ t: 'mention' as const,
            participant: { kind: 'session' as const, sessionId: session.id } }, { t: 'text' as const, text: 'Question' }] };
        const question = await postDiscussionMessage({ authentication, actorAccountId: account.id, discussionId,
            request: buildDiscussionMutationRequestBodyV1({ kind: 'post', localId: randomUUID(),
                content: { t: 'plain', v: questionContent }, authoredContent: questionContent,
                mentionedAccountIds: [], mentionedSessionIds: [session.id] }) });
        if (!question.ok) throw new Error(question.error);
        const discussion = { discussionId, messageId: question.value.message.id, throughSeq: question.value.message.seq, participantSessionId: session.id };
        const admitted = await inTx(tx => createSessionInputReplyProgressInTx(tx, { accountId: account.id, authentication,
            requestSessionId: session.id, reply: { mode: 'return', discussion } }));
        expect(admitted).not.toBeNull();
        const localId = randomUUID(), acceptedTurnId = randomUUID();
        const artifactId = randomUUID();
        const progress = SessionMessageReplyProgressV1Schema.parse({ ...admitted, acceptedTurnId,
            returnPublication: { kind: 'approval_pending', artifactId },
            outcome: { kind: 'answer', result: { sessionId: session.id, messageId: 'private-answer' } } });
        const publication = { kind: 'failed' as const, failure: { code: 'approval_rejected', phase: 'action_admission' as const, retryable: false } };
        const expected = kind === 'discussion_review' ? { disposition: 'released', outcome: { kind: 'declined' } }
            : { disposition: 'released', returnPublication: publication };
        const row = { sessionId: session.id, localId, content: { t: 'plain', v: {} }, replyProgress: progress, replyDisposition: progress.disposition };
        await db.sessionMessage.create({ data: { ...row, seq: 1, messageRole: 'user' } });
        if (custody === 'pending') await db.sessionPendingMessage.create({ data: { ...row, position: 0, requestedAction: { v: 1, kind: 'enqueue' } } });
        const before = await db.discussionMessage.count({ where: { discussionId } });
        await withAuthenticatedTestApp(registerSessionMessageRoutes, async app => {
            const url = `/v2/sessions/${session.id}/messages/by-local-id/${localId}/reply`;
            const headers = { 'x-test-user-id': account.id };
            for (let attempt = 0; attempt < 2; attempt++) {
                const response = await app.inject({ method: 'POST', url, headers, payload: { kind, discussionId,
                    messageId: discussion.messageId, acceptedTurnId, ...(kind === 'discussion_review' ? { decision: 'reject' }
                        : { approvalArtifactId: artifactId, publication }) } });
                expect(response.statusCode, response.body).toBe(200);
                expect(response.json()).toMatchObject({ ok: true, progress: expected });
            }
            const read = await app.inject({ method: 'GET', url, headers });
            expect(read.json()).toMatchObject({ status: 'available', progress: expected });
        });
        expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(before);
        expect((await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId } } })).replyProgress)
            .toMatchObject(expected);
        if (custody === 'pending') expect((await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId } } })).replyProgress)
            .toMatchObject(expected);
    });
});
