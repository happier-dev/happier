import type { InboxModel } from '@/hooks/inbox/useInboxModel';
import { EMPTY_WORKFLOW_ATTENTION_SOURCE } from '@/hooks/inbox/useWorkflowAttentionSource';
import { ApprovalRequestV2Schema} from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { createAccountNoticeInvestigation } from '@/hooks/inbox/accountNoticeInvestigation';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

/** A real admitted approval for presentation fixtures; grouping never fabricates admission. */
export function createInboxApprovalArtifactFixture(input: Readonly<{
    id: string; title?: string; serverId?: string; serverIdentityId?: string;
    actionId?: string; createdAt?: number;
}>): Extract<DecryptedArtifact, { isDecrypted: true }> {
    const actionId = input.actionId ?? 'account.name.set';
    const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open',
        createdAtMs: input.createdAt ?? 1, updatedAtMs: input.createdAt ?? 1,
        createdBy: { surface: 'agent' }, requestedSurface: 'agent', actionId,
        actionArgs: actionId === 'account.name.set' ? { name: 'Captain' } : {}, summary: input.title ?? 'Approval',
        executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent', caller: { kind: 'host' },
            serverId: input.serverId ?? 'server-a', ...(input.serverIdentityId ? { serverIdentityId: input.serverIdentityId } : {}),
            actionId, requestId: `fixture-${input.id}` } });
    return { id: input.id, isDecrypted: true, header: buildApprovalRequestArtifactHeaderV1(request),
        body: JSON.stringify(request), title: request.summary, headerVersion: 1, bodyVersion: 1,
        seq: 1, createdAt: request.createdAtMs, updatedAt: request.updatedAtMs };
}

/** Complete attention inputs shared by Inbox presentation fixtures. */
export function createInboxAttentionFixture(serverId: string | null = null): Pick<InboxModel, 'workflowAttention' | 'automationAttention' | 'automationAttentionItems'
    | 'items' | 'sessionCandidates' | 'accountNotices' | 'openAccountNotices' | 'dismissAccountNotice' | 'markItemOpened' | 'discussionAttention' | 'executionRunAttention' | 'artifactSource' | 'machineReachabilityEntries' | 'machineDeletionEntries' | 'noticeInvestigation'> {
    return {
        noticeInvestigation: createAccountNoticeInvestigation({ scope: null, isCurrent: () => true,
            execute: createFrontDoorActionExecute() }),
        artifactSource: { scope: null, phase: 'current', retry: () => undefined },
        workflowAttention: { ...EMPTY_WORKFLOW_ATTENTION_SOURCE, serverId, runIds: [] },
        automationAttention: { ...EMPTY_WORKFLOW_ATTENTION_SOURCE, serverId, runIds: [] },
        automationAttentionItems: [],
        machineReachabilityEntries: [],
        machineDeletionEntries: [],
        executionRunAttention: { loading: false, failed: false, retry: () => {} },
        items: [], sessionCandidates: [], accountNotices: [], openAccountNotices: [], dismissAccountNotice: async () => {}, markItemOpened: async () => {},
        discussionAttention: { source: null, coverage: 'unavailable', available: false, loading: false,
            status: 'idle', errorCode: null, markOpened: async () => {}, refresh: () => undefined, loadMore: () => undefined },
    };
}
