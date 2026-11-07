import { describe, expect, it } from 'vitest';

import { listDiscussionRequesterApprovals } from '@/sync/domains/artifacts/approvalArtifacts';
import { buildDiscussionRequesterApprovalArtifact } from '@/sync/domains/artifacts/approvalArtifacts.discussionRequester.testkit';
import type { ApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import type { ActionOperationCredentialUseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { resolveApprovalRequesterThreadState } from './approvalRequesterThreadState';

function approvalOf(settle?: (request: ApprovalRequestV2) => ApprovalRequestV2) {
    const [entry] = listDiscussionRequesterApprovals([buildDiscussionRequesterApprovalArtifact({ settle })],
        { serverId: 'server-1', discussionId: 'discussion-1' });
    if (!entry) throw new Error('Expected the requester approval');
    return entry;
}

function stateOf(settle?: (request: ApprovalRequestV2) => ApprovalRequestV2, recorded: 'approve' | 'reject' | null = null) {
    return resolveApprovalRequesterThreadState(approvalOf(settle).parsed, recorded);
}

const approved = (request: ApprovalRequestV2): ApprovalRequestV2 => ({ ...request, status: 'approved', updatedAtMs: 20,
    decision: { kind: 'approve', decidedAtMs: 20, authority: 'present_user', decidingAccountId: 'bob' } });

const personalCredentialUse: ActionOperationCredentialUseV1 = {
    v: 1, kind: 'connected_account', label: 'Acme GitHub', owner: { kind: 'account', accountId: 'alice' },
    service: { pluginId: 'happier.integration.github', localId: 'github' },
    why: { kind: 'purpose_binding', purpose: {
        consumer: { pluginId: 'happier.integration.github', localId: 'issues' }, purpose: 'write',
    }, target: 'account' },
    currentness: { kind: 'current_at_materialization' },
};

const teamCredentialUse: ActionOperationCredentialUseV1 = {
    ...personalCredentialUse, kind: 'team_resource', label: 'Release GitHub', owner: { kind: 'team', teamId: 'team-release' },
    why: { ...personalCredentialUse.why, target: 'group' },
    currentness: { kind: 'current_at_materialization', resourceRevision: 7 },
};

describe('resolveApprovalRequesterThreadState', () => {
    it('projects a terminal unknown outcome as uncertain rather than pending or failed', () => {
        expect(stateOf(request => ({ ...approved(request), status: 'outcome_unknown', updatedAtMs: 30,
            execution: { executedAtMs: 30, ok: false, effectAttempted: true, errorCode: 'outcome_unknown', error: 'outcome_unknown' } })))
            .toEqual({ kind: 'uncertain', decidingAccountId: 'bob' });
    });
    it('asks while open, and says the answer this device recorded until the request catches up', () => {
        expect(stateOf()).toEqual({ kind: 'open' });
        expect(stateOf(undefined, 'reject')).toEqual({ kind: 'declined', decidingAccountId: null });
        expect(stateOf(undefined, 'approve')).toEqual({ kind: 'confirmed_pending', decidingAccountId: null });
    });

    it('is a receipt only after effect evidence; an approved request without a result is still pending', () => {
        expect(stateOf(approved)).toEqual({ kind: 'confirmed_pending', decidingAccountId: 'bob' });
        expect(stateOf((request) => ({ ...approved(request), status: 'executed', updatedAtMs: 30,
            execution: { executedAtMs: 30, ok: true, result: { ok: true } } }))).toEqual({ kind: 'done', decidingAccountId: 'bob' });
    });

    it('never reads an unknown effect as success, and says a failure or a refusal plainly', () => {
        expect(stateOf((request) => ({ ...approved(request), status: 'failed', updatedAtMs: 30,
            execution: { executedAtMs: 30, ok: false, errorCode: 'approval_execution_outcome_unknown', error: 'approval_execution_outcome_unknown' } })))
            .toEqual({ kind: 'uncertain', decidingAccountId: 'bob' });
        expect(stateOf((request) => ({ ...approved(request), status: 'failed', updatedAtMs: 30,
            execution: { executedAtMs: 30, ok: false, errorCode: 'action_failed', error: 'GitHub refused the write' } })))
            .toMatchObject({ kind: 'failed', decidingAccountId: 'bob' });
        expect(stateOf((request) => ({ ...request, status: 'rejected', updatedAtMs: 20,
            decision: { kind: 'reject', decidedAtMs: 20, authority: 'present_user', decidingAccountId: 'bob' } })))
            .toEqual({ kind: 'declined', decidingAccountId: 'bob' });
        expect(stateOf((request) => ({ ...request, status: 'canceled', updatedAtMs: 20 }))).toEqual({ kind: 'canceled' });
    });

    it('retains the admitted personal credential use beside the result without changing the request cause', () => {
        const entry = approvalOf((request) => ({ ...approved(request), status: 'executed', updatedAtMs: 30,
            execution: { executedAtMs: 30, ok: true, effectAttempted: true, result: { ok: true },
                operationCredentialUses: [personalCredentialUse] } }));
        expect(resolveApprovalRequesterThreadState(entry.parsed, null)).toEqual({
            kind: 'done', decidingAccountId: 'bob', operationCredentialUses: [personalCredentialUse],
        });
        expect(entry.subject.executionAccountId).toBe('alice');
        if (entry.parsed.family !== 'built_in' || entry.parsed.request.v !== 2) throw new Error('Expected the current built-in request');
        expect(entry.parsed.request.executionOriginV1.actionRequestAttributionV1).toEqual({
            requestRef: 'bob-input', requester: { serverId: 'server-1', accountId: 'bob' },
            persona: { serverId: 'server-1', sessionId: 's1' },
            origin: { kind: 'discussion', discussion: { serverId: 'server-1', discussionId: 'discussion-1' }, messageId: 'message-ask' },
        });
    });

    it('keeps the admitted Team actor and materialization currentness on uncertain and failed effects', () => {
        for (const [errorCode, kind] of [['approval_execution_outcome_unknown', 'uncertain'], ['action_failed', 'failed']] as const) {
            expect(stateOf((request) => ({ ...approved(request), status: 'failed', updatedAtMs: 30,
                execution: { executedAtMs: 30, ok: false, effectAttempted: true, errorCode, error: errorCode,
                    operationCredentialUses: [teamCredentialUse] } }))).toEqual({
                kind, decidingAccountId: 'bob', ...(kind === 'failed' ? { errorCode } : {}),
                operationCredentialUses: [teamCredentialUse],
            });
        }
    });

    it('does not infer a credential actor from execution ownership or arbitrary Action result JSON', () => {
        expect(stateOf((request) => ({ ...approved(request), status: 'executed', updatedAtMs: 30,
            execution: { executedAtMs: 30, ok: true, effectAttempted: true,
                result: { ok: true, operationCredentialUses: [personalCredentialUse] } } })))
            .toEqual({ kind: 'done', decidingAccountId: 'bob' });
        expect(stateOf((request) => ({ ...approved(request), status: 'failed', updatedAtMs: 30,
            execution: { executedAtMs: 30, ok: false, effectAttempted: false, errorCode: 'approval_stale', error: 'approval_stale' } })))
            .toEqual({ kind: 'stale', decidingAccountId: 'bob' });
    });
});
