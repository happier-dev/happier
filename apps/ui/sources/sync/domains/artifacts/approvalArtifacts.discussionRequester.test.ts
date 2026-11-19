import { describe, expect, it } from 'vitest';

import { listDiscussionRequesterApprovals, readOpenApprovalDiscussionAttention } from './approvalArtifacts';
import { buildDiscussionRequesterApprovalArtifact } from '@/dev/testkit/fixtures/discussionRequesterApprovalArtifact';

describe('listDiscussionRequesterApprovals', () => {
    const discussion = { serverId: 'server-1', discussionId: 'discussion-1' };

    it('retains an own-agent uncertain publication at its admitted origin', () => {
        const artifact = buildDiscussionRequesterApprovalArtifact({ requesterAccountId: 'alice', actionId: 'doc.edit.propose', settle: request => ({
            ...request, status: 'outcome_unknown', updatedAtMs: 30,
            decision: { kind: 'approve', decidedAtMs: 20, authority: 'present_user', decidingAccountId: 'alice' },
            execution: { executedAtMs: 30, ok: false, effectAttempted: true, errorCode: 'approval_execution_outcome_unknown', error: 'Publication acknowledgement was lost' },
        }) });
        expect(listDiscussionRequesterApprovals([artifact], discussion)).toHaveLength(1);
    });

    it('links an own-agent Doc redo approval from its admitted ask without inventing requester consent', () => {
        const artifact = buildDiscussionRequesterApprovalArtifact({ requesterAccountId: 'alice', actionId: 'doc.edit.propose' });
        // This is the stored incident shape: no top-level discussionId or requesterConfirmation,
        // and an already-classified empty list-facts header. Do not rewrite it to discover the link.
        expect(artifact.header?.approvalListFacts).toEqual({});
        const storedBody = artifact.body;
        if (typeof storedBody !== 'string') throw new Error('expected the stored approval request body inline');
        expect(JSON.parse(storedBody).requesterConfirmation).toBeUndefined();
        const approvals = listDiscussionRequesterApprovals([artifact], discussion);
        expect(approvals).toHaveLength(1);
        expect(approvals[0]).toMatchObject({ kind: 'request', subject: null,
            originMessageId: 'message-ask', requestRef: 'bob-input' });
        expect(listDiscussionRequesterApprovals([artifact], { ...discussion, discussionId: 'other-thread' })).toEqual([]);
        expect(listDiscussionRequesterApprovals([artifact], { ...discussion, serverId: 'other-home' })).toEqual([]);
        const outsideThread = buildDiscussionRequesterApprovalArtifact({ requesterAccountId: 'alice', actionId: 'doc.edit.propose', origin: null });
        expect(listDiscussionRequesterApprovals([outsideThread], discussion)).toEqual([]);
    });

    it('joins a requester-bound approval to the Discussion message that asked, with its exact cause', () => {
        const approvals = listDiscussionRequesterApprovals([buildDiscussionRequesterApprovalArtifact()], discussion);
        expect(approvals).toHaveLength(1);
        expect(approvals[0]).toMatchObject({
            originMessageId: 'message-ask',
            requestRef: 'bob-input',
            subject: { requesterAccountId: 'bob', executionAccountId: 'alice', personaSessionRef: { serverId: 'server-1', sessionId: 's1' } },
        });
    });

    it('keeps ordinary Discussion publication approvals on their existing waiting card', () => {
        const artifact = buildDiscussionRequesterApprovalArtifact({ requesterAccountId: 'alice', actionId: 'discussion.post' });
        expect(readOpenApprovalDiscussionAttention(artifact)).toMatchObject({ discussionId: discussion.discussionId, reason: 'approval_pending' });
        expect(listDiscussionRequesterApprovals([artifact], discussion)).toHaveLength(0);
        const otherDestination = buildDiscussionRequesterApprovalArtifact({ requesterAccountId: 'alice', actionId: 'discussion.post',
            discussionId: 'other-destination', origin: { kind: 'discussion', discussion, messageId: 'message-ask' } });
        expect(listDiscussionRequesterApprovals([otherDestination], discussion)).toHaveLength(1);
    });

    it('keeps a decided request so its receipt replaces the card in place', () => {
        const declined = buildDiscussionRequesterApprovalArtifact({ settle: (request) => ({
            ...request, status: 'rejected', updatedAtMs: 20,
            decision: { kind: 'reject', decidedAtMs: 20, authority: 'present_user', decidingAccountId: 'bob' },
        }) });
        expect(listDiscussionRequesterApprovals([declined], discussion).map((entry) => entry.parsed.request.status)).toEqual(['rejected']);
        const ownDeclined = buildDiscussionRequesterApprovalArtifact({ requesterAccountId: 'alice', actionId: 'doc.edit.propose', settle: request => ({
            ...request, status: 'rejected', updatedAtMs: 20,
            decision: { kind: 'reject', decidedAtMs: 20, authority: 'present_user', decidingAccountId: 'alice' },
        }) });
        expect(listDiscussionRequesterApprovals([ownDeclined], discussion)).toEqual([]);
    });

    it('ignores requests from another Discussion, from a Session, or with no Discussion origin', () => {
        const otherDiscussion = buildDiscussionRequesterApprovalArtifact({ id: 'a', discussionId: 'discussion-2' });
        const fromSession = buildDiscussionRequesterApprovalArtifact({ id: 'b', origin: {
            kind: 'session', session: { serverId: 'server-1', sessionId: 's9' }, messageId: 'm1' } });
        const noOrigin = buildDiscussionRequesterApprovalArtifact({ id: 'c', origin: null });
        expect(listDiscussionRequesterApprovals([otherDiscussion, fromSession, noOrigin], discussion)).toEqual([]);
    });
});
