import { expect, it } from 'vitest';
import { ApprovalRequestV2Schema, StoredApprovalRequestSchema } from './approvalRequestV1.js';
import { projectApprovalExecutionFailureV2, readApprovalExecutionFailure } from './approvalExecutionFailure.js';
import { projectApprovalRequestForPublicRead } from '../actions/actionApprovalPresentation.js';

it('retains the missing Network posture and recovery guidance through Domain approval/public reads', () => {
  const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
    createdBy: { surface: 'cli' }, requestedSurface: 'cli', actionId: 'deployments.domains.add', summary: 'Add Domain',
    actionArgs: { serverId: 'home', environmentId: 'environment', domainId: 'domain', expectedRevision: 1,
      targetLinkId: 'target', expectedTargetLinkRevision: 1, requestKey: 'domain-add',
      contentArtifactId: 'domain-content', contentHeaderVersion: 1, contentBodyVersion: 1 },
    executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
      serverId: 'home', accountId: 'account', machineId: 'machine', actionId: 'deployments.domains.add', requestId: 'request' } });
  const details = { environmentId: 'environment', domainId: 'domain', step: 'native_execution' as const,
    requiredFact: 'reachabilityPosture', remedy: 'Reconcile native firewall state, then review and apply Network posture.' };
  const failure = { ok: false as const, errorCode: 'machine_network_review_required',
    error: 'machine_network_review_required', effectAttempted: true, details };
  const execution = projectApprovalExecutionFailureV2({ request, failure, executedAtMs: 3 });
  expect(execution).toMatchObject({ details });
  const stored = StoredApprovalRequestSchema.parse({ ...request, status: 'failed', updatedAtMs: 3,
    decision: { kind: 'approve', decidedAtMs: 2 }, execution });
  expect(readApprovalExecutionFailure(stored)).toMatchObject({ details });
  expect(projectApprovalRequestForPublicRead(stored)).toMatchObject({ execution: { details } });
  expect(projectApprovalExecutionFailureV2({ request,
    failure: { ...failure, details: { ...details, token: 'private-fixture' } }, executedAtMs: 3 })).not.toHaveProperty('details');
  expect(projectApprovalExecutionFailureV2({ request,
    failure: { ...failure, details: { ...details, environmentId: 'unrelated-environment' } }, executedAtMs: 3 })).not.toHaveProperty('details');
  expect(projectApprovalExecutionFailureV2({ request,
    failure: { ...failure, details: { ...details, operation: { serverId: 'unrelated-home', machineId: 'machine', operationId: 'operation' } } },
    executedAtMs: 3 })).not.toHaveProperty('details');
  for (const [inputHome, operationHome] of [['home', 'identity'], ['identity', 'home']] as const) {
    const aliasedRequest = ApprovalRequestV2Schema.parse({ ...request,
      actionArgs: { ...request.actionArgs, serverId: inputHome },
      executionOriginV1: { ...request.executionOriginV1, serverIdentityId: 'identity',
        target: { kind: 'machine', machineId: 'machine' } } });
    const aliasedDetails = { ...details,
      operation: { serverId: operationHome, machineId: 'machine', operationId: 'operation' } };
    const aliasedExecution = projectApprovalExecutionFailureV2({ request: aliasedRequest,
      failure: { ...failure, details: aliasedDetails }, executedAtMs: 3 });
    const aliasedStored = StoredApprovalRequestSchema.parse({ ...aliasedRequest, status: 'failed', updatedAtMs: 3,
      decision: { kind: 'approve', decidedAtMs: 2 }, execution: aliasedExecution });
    expect(projectApprovalRequestForPublicRead(aliasedStored)).toMatchObject({ execution: { details: aliasedDetails } });
    for (const operation of [
      { ...aliasedDetails.operation, serverId: 'unrelated-home' },
      { ...aliasedDetails.operation, machineId: 'other-machine' },
    ]) {
      expect(projectApprovalExecutionFailureV2({ request: aliasedRequest,
        failure: { ...failure, details: { ...aliasedDetails, operation } }, executedAtMs: 3 })).not.toHaveProperty('details');
    }
  }
});
