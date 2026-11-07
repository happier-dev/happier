import { describe, expect, it } from 'vitest';
import { ApprovalRequestPublicReadSchema } from '@happier-dev/protocol/approvals/approvalRequestPublicRead';
import { readWorkflowActionApprovalSettlement } from './actionApproval';

describe('admitted Workflow receipt settlement', () => {
  it.each(['none', 'run', 'invocation', 'receipt'] as const)(
    'settles only the admitted Run, invocation and receipt (%s changed)', async changed => {
      const runId = 'admitted-run';
      const actionRequestId = `${runId}/admitted-invocation/0`;
      // Public Artifact reads carry recorded outcome and attribution, without private replay custody.
      const request = ApprovalRequestPublicReadSchema.parse({ v: 1, kind: 'plugin_target_action',
        status: 'executed', createdAtMs: 1, updatedAtMs: 3, createdBy: { surface: 'agent' },
        requestedSurface: 'agent', summary: 'Update', qualifiedActionId: 'example.workflow/actions/update',
        input: {}, secretInputPaths: [], sourceCustody: { kind: 'development', registeredRootId: 'root' },
        policyFingerprint: 'a'.repeat(64), subjectFingerprint: 'b'.repeat(64),
        executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent',
          serverId: 'home', serverIdentityId: 'home-identity', accountId: 'owner', machineId: 'machine',
          actionId: 'action.invoke', requestId: changed === 'invocation' ? `${runId}/other/0` : actionRequestId,
          caller: { kind: 'workflowRun', runId: changed === 'run' ? 'other-run' : runId,
            authorization: { principal: { kind: 'api', accountId: 'owner', principalId: 'owner', credentialId: 'old-pat' },
              admittedPermissionCeiling: 'default' } } },
        decision: { kind: 'approve', decidedAtMs: 2 },
        execution: { executedAtMs: 3, ok: true, effectAttempted: true, result: { updated: true } },
      });
      const settled = await readWorkflowActionApprovalSettlement({ runId, execution: {
        kind: 'action', actionId: 'example.workflow/actions/update', actionRequestId,
        localInputId: 'input', input: {}, output: {
          kind: 'approval_request_created', artifactId: 'admitted-receipt', actionId: 'action.invoke' },
      }, read: async () => ({ artifactId: changed === 'receipt' ? 'other-receipt' : 'admitted-receipt', request }) });
      expect(settled).toEqual(changed === 'none' ? { kind: 'completed', result: { updated: true } }
        : { kind: 'unresolved', code: 'approval_unavailable' });
    });
});
