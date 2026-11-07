import { isDeepStrictEqual } from 'node:util';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import type { ActionExecutorDeps, HandoffTargetReplacementApprovalV1 } from '@happier-dev/protocol';
import type { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';

export async function requireExecutingWorkspaceActionReceipt(input: Readonly<{
  approvalsGet: NonNullable<ActionExecutorDeps['approvalsGet']>;
  serverId: string;
  actionReceiptId: string;
  actionId: Parameters<typeof getActionSpec>[0];
  actionInput: unknown;
  expectedExecutionAccountId?: string;
  expectedExecutionMachineId?: string;
  expectedExecutionRequestId?: string;
  expectedExecutionSessionId?: string;
  expectedTargetReplacementApproval?: HandoffTargetReplacementApprovalV1;
}>): Promise<void> {
  const artifact = await input.approvalsGet({ artifactId: input.actionReceiptId, serverId: input.serverId });
  const parsed = ApprovalRequestV2Schema.safeParse(artifact);
  const request = parsed.success ? parsed.data : null;
  const origin = request?.executionOriginV1;
  let sameInput = false;
  if (request !== null) {
    try {
      sameInput = createCanonicalJsonSigningInput(request.actionArgs)
        === createCanonicalJsonSigningInput(input.actionInput);
    } catch {
      sameInput = false;
    }
  }
  if (!request
    || !origin
    || request.status !== 'executing'
    || request.decision?.kind !== 'approve'
    || request.actionId !== input.actionId
    || origin.actionId !== input.actionId
    || origin.serverId !== input.serverId
    || (input.expectedExecutionAccountId !== undefined
      && origin.accountId !== input.expectedExecutionAccountId)
    || (input.expectedExecutionMachineId !== undefined
      && origin.machineId !== input.expectedExecutionMachineId)
    || (input.expectedExecutionRequestId !== undefined
      && origin.requestId !== input.expectedExecutionRequestId)
    || (input.expectedExecutionSessionId !== undefined
      && origin.sessionId !== input.expectedExecutionSessionId)
    || !sameInput
    || (input.expectedTargetReplacementApproval !== undefined
      && !isDeepStrictEqual(
        request.handoffTargetReplacementApproval,
        input.expectedTargetReplacementApproval,
      ))) {
    throw Object.assign(new Error('Workspace Action receipt is stale or does not match'), { code: 'approval_stale' });
  }
}
