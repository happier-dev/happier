import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { createDiscussion } from '@/app/discussions/mutations';
import { inviteDiscussionParticipant } from '@/app/discussions/accessService';
import { buildDiscussionMutationRequestBodyV1 } from '@happier-dev/protocol/discussions/api';
import { deriveWorkflowSessionInputLocalIdV2 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { SessionMessageReplyProgressV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerSessionMessageRoutes } from '@/app/api/routes/session/registerSessionMessageRoutes';
import { createSessionInputReplyProgressInTx, readSessionMessageReplyInTx } from './sessionMessageReply';

/** Same original-custody contract on the canonical SQLite and disposable PostgreSQL harnesses. */
export function workflowReplyCustodyContract(): void {
    it.each(['refused', 'approval_pending'] as const)('reads archived Workflow original custody without changing its %s fact', async state => {
        const authentication = createPresentUserSessionAccessAuthentication();
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const document = { v: 1 as const, parts: [{ t: 'text' as const, text: 'Workflow question' }] };
        const created = await createDiscussion({ authentication, actorAccountId: account.id, request: buildDiscussionMutationRequestBodyV1({
            kind: 'create', creationLocalId: randomUUID(), titleContent: { t: 'plain', v: { v: 1, title: 'Custody' } },
            firstMessage: { localId: randomUUID(), content: { t: 'plain', v: document }, authoredContent: document, mentionedAccountIds: [] },
        }) });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: account.id, discussionId,
            request: { participant: { kind: 'session', sessionId: session.id } } })).toMatchObject({ ok: true });
        const run = await db.automationRun.create({ data: { accountId: account.id, originKind: 'direct', causeKind: null,
            scheduledAt: new Date(), dueAt: new Date(), workflowAcceptedSnapshotEnvelope: 'accepted-by-workflow-owner', workflowCustodyState: 'pending' } });
        const invocation = await db.workflowRunInvocation.create({ data: { runId: run.id, sequence: 1n, memberOrdinal: 0n,
            lifecycle: 'completed', contentEnvelope: 'sealed-workflow-result' } });
        const workflow = { purpose: 'invocation' as const, runId: run.id, invocationRecordId: invocation.id };
        const discussion = { discussionId, messageId: created.value.firstMessage.id, throughSeq: created.value.firstMessage.seq, participantSessionId: session.id };
        const admitted = await inTx(tx => createSessionInputReplyProgressInTx(tx, { accountId: account.id, requestSessionId: session.id,
            reply: { mode: 'wait', discussion, workflow } }));
        if (!admitted) throw new Error('Canonical Workflow original admission failed');
        const localId = deriveWorkflowSessionInputLocalIdV2(workflow);
        const progress = SessionMessageReplyProgressV1Schema.parse({ ...admitted, acceptedTurnId: 'native-turn',
            disposition: state === 'refused' ? 'released' : 'observing', outcome: state === 'refused' ? { kind: 'terminal_no_result' }
                : { kind: 'answer', result: { sessionId: session.id, messageId: 'retained-native-answer' } },
            returnPublication: state === 'refused'
                ? { kind: 'failed', failure: { code: 'approval_rejected', phase: 'action_admission', retryable: false } }
                : { kind: 'approval_pending', artifactId: 'open-publication-approval' } });
        const original = await db.sessionMessage.create({ data: { sessionId: session.id, localId, seq: 1, messageRole: 'user',
            content: { t: 'plain', v: {} }, replyProgress: progress, replyDisposition: progress.disposition } });
        const read = (requestedLocalId = localId) => inTx(tx => readSessionMessageReplyInTx(tx, {
            accountId: account.id, sessionId: session.id, localId: requestedLocalId, authentication }));
        expect(await read()).toEqual({ v: 1, status: 'available', progress });
        await db.automationRun.update({ where: { id: run.id }, data: { state: 'cancelled' } });
        await db.session.update({ where: { id: session.id }, data: { archivedAt: new Date() } });

        // Exercise the actual Account HTTP reader and its second access/read snapshot too.
        await withAuthenticatedTestApp(app => registerSessionMessageRoutes(app), async app => {
            const response = await app.inject({ method: 'GET', url: `/v2/sessions/${session.id}/messages/by-local-id/${localId}/reply`,
                headers: { 'x-test-user-id': account.id } });
            expect(response.statusCode).toBe(200);
            expect.soft(response.json()).toEqual({ v: 1, status: 'available', progress });
        });
        expect.soft(await read()).toEqual({ v: 1, status: 'available', progress });
        expect(await read('missing-original')).toEqual({ v: 1, status: 'unavailable' });
        expect(await db.sessionMessage.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original);

        // A different retained invocation cannot authenticate this original's local id.
        const another = await db.workflowRunInvocation.create({ data: { runId: run.id, sequence: 2n, memberOrdinal: 1n,
            lifecycle: 'completed', contentEnvelope: 'different-sealed-result' } });
        await db.sessionMessage.update({ where: { id: original.id }, data: { replyProgress: {
            ...progress, workflow: { ...workflow, invocationRecordId: another.id },
        } } });
        expect(await read()).toEqual({ v: 1, status: 'unavailable' });
        expect(await inTx(tx => createSessionInputReplyProgressInTx(tx, { accountId: account.id, requestSessionId: session.id,
            reply: { mode: 'wait', discussion, workflow } }))).toBeNull();
    });
}
