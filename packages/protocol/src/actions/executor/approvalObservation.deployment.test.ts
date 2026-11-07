import { expect, it } from 'vitest';
import { ApprovalRequestV2Schema } from '../../approvals/approvalRequestV1.js';
import { ApprovalRequestGetResultV1Schema } from '../../approvals/approvalRequestPublicRead.js';
import { decideApprovalRequestTransition, settleApprovalRequestReplayInputs } from '../../approvals/approvalRequestTransition.js';
import { executeApprovalObservationAction } from './approvalObservation.js';

it('reads the existing deployment Ask as a waiting receipt and advances with the approval owner', async () => {
  let stored = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
    createdBy: { surface: 'agent' }, requestedSurface: 'agent', actionId: 'deployments.deploy',
    actionArgs: { serverId: 'home', environmentId: 'environment', expectedRevision: 1,
      targetLinkId: 'link', expectedTargetLinkRevision: 1, requestKey: 'request',
      contentArtifactId: 'content', contentHeaderVersion: 1, contentBodyVersion: 1 }, summary: 'Deploy',
    executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent', caller: { kind: 'host' },
      serverId: 'home', actionId: 'deployments.deploy', requestId: 'request' } });
  let reads = 0;
  const read = async () => {
    const result = await executeApprovalObservationAction({ actionId: 'approval.request.get', input: { artifactId: 'approval' },
      context: { surface: 'agent', serverId: 'home' }, deps: { approvalsGet: async () => { reads++; return stored; } } });
    if (!result.ok) throw new Error(result.errorCode);
    return ApprovalRequestGetResultV1Schema.parse(result.result);
  };
  expect(await read()).toMatchObject({ deploymentReceipt: {
    state: 'waiting-for-approval', approvalId: 'approval', environmentId: 'environment', operation: 'deploy' } });
  const advance = (next: unknown) => {
    const parsed = ApprovalRequestV2Schema.parse(next);
    expect(decideApprovalRequestTransition(stored, parsed)).toMatchObject({ ok: true });
    stored = parsed;
  };
  const open = stored;
  advance({ ...stored, status: 'approved', updatedAtMs: 2, decision: { kind: 'approve', decidedAtMs: 2 } });
  expect(await read()).toMatchObject({ deploymentReceipt: { state: 'approved', approvalId: 'approval' } });
  advance({ ...stored, status: 'executing', updatedAtMs: 3 });
  expect(await read()).toMatchObject({ deploymentReceipt: { state: 'executing', approvalId: 'approval' } });
  advance({ ...settleApprovalRequestReplayInputs(stored), status: 'executed', updatedAtMs: 4, execution: { executedAtMs: 4, ok: true,
    result: { ok: true, environmentId: 'environment', revision: 2, deploymentId: 'receipt', deploymentRevision: 1, state: 'queued' } } });
  expect(await read()).toMatchObject({ deploymentReceipt: { state: 'admitted', approvalId: 'approval',
    receipt: { deploymentId: 'receipt', state: 'queued' } } });
  stored = open;
  advance({ ...settleApprovalRequestReplayInputs(stored), status: 'rejected', updatedAtMs: 2, decision: { kind: 'reject', decidedAtMs: 2 } });
  expect(await read()).toMatchObject({ deploymentReceipt: { state: 'rejected', approvalId: 'approval' } });
  expect(reads).toBe(5);
});
