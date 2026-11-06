import { expect, it } from 'vitest';
import { ApprovalRequestV2Schema, StoredApprovalRequestSchema } from './approvalRequestV1.js';
import { projectApprovalExecutionFailureV2, readApprovalExecutionFailure } from './approvalExecutionFailure.js';
import { projectApprovalRequestForPublicRead } from '../actions/actionApprovalPresentation.js';

it('retains the failed Promote receipt, activation phase and cleanup refusal through approval settlement', () => {
  const actionArgs = { serverId: 'home', environmentId: 'destination', sourceEnvironmentId: 'source',
    sourceDeploymentId: 'source-receipt', artifact: 'image', requestKey: 'promote' };
  const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
    createdBy: { surface: 'cli' }, requestedSurface: 'cli', actionId: 'deployments.promote', summary: 'Promote',
    actionArgs,
    executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
      serverId: 'home', accountId: 'account', machineId: 'machine', actionId: 'deployments.promote', requestId: 'request' } });
  const details = { serverId: 'home', environmentId: 'destination', targetLinkId: 'target', deploymentId: 'receipt',
    failure: { code: 'target_mismatch', phase: 'activate' as const },
    cleanupFailure: { code: 'target_mismatch', phase: 'cleanup' as const } };
  const failure = { ok: false as const, errorCode: 'target_mismatch', error: 'Activation and candidate cleanup failed',
    effectAttempted: true, details };
  const execution = projectApprovalExecutionFailureV2({ request, failure, executedAtMs: 3 });
  expect(execution).toMatchObject({ effectAttempted: true, details });
  const stored = StoredApprovalRequestSchema.parse({ ...request, status: 'failed', updatedAtMs: 3,
    decision: { kind: 'approve', decidedAtMs: 2 }, execution });
  expect(readApprovalExecutionFailure(stored)).toMatchObject({ details });
  expect(projectApprovalRequestForPublicRead(stored)).toMatchObject({ execution: { details } });
  const prepared = { ...request, actionArgs: { ...actionArgs, targetLinkId: 'target', expectedRevision: 1,
    expectedTargetLinkRevision: 1, contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1,
    destinationContent: { contentArtifactId: 'destination-content', contentHeaderVersion: 1, contentBodyVersion: 1 } } };
  expect(projectApprovalExecutionFailureV2({ request: prepared, failure, executedAtMs: 3 })).toMatchObject({ details });
  for (const [inputHome, receiptHome] of [['home', 'identity'], ['identity', 'home']] as const) {
    const aliasedRequest = ApprovalRequestV2Schema.parse({ ...request,
      actionArgs: { ...actionArgs, serverId: inputHome },
      executionOriginV1: { ...request.executionOriginV1, serverIdentityId: 'identity' } });
    const aliasedDetails = { ...details, serverId: receiptHome };
    const execution = projectApprovalExecutionFailureV2({ request: aliasedRequest,
      failure: { ...failure, details: aliasedDetails }, executedAtMs: 3 });
    const stored = StoredApprovalRequestSchema.parse({ ...aliasedRequest, status: 'failed', updatedAtMs: 3,
      decision: { kind: 'approve', decidedAtMs: 2 }, execution });
    expect(projectApprovalRequestForPublicRead(stored)).toMatchObject({ execution: { details: aliasedDetails } });
    expect(projectApprovalExecutionFailureV2({ request: aliasedRequest,
      failure: { ...failure, details: { ...details, serverId: 'other-home' } }, executedAtMs: 3 })).not.toHaveProperty('details');
  }
  for (const [invalidRequest, invalidDetails, errorCode] of [
    [request, { ...details, environmentId: 'other-environment' }, failure.errorCode],
    [request, { ...details, serverId: 'other-home' }, failure.errorCode],
    [prepared, { ...details, targetLinkId: 'other-target' }, failure.errorCode],
    [request, { ...details, token: 'private-fixture' }, failure.errorCode],
    [request, details, 'unrelated_error'],
    [{ ...request, actionId: 'settings.get' as const, actionArgs: {} }, details, failure.errorCode],
  ] as const) {
    expect(projectApprovalExecutionFailureV2({ request: invalidRequest,
      failure: { ...failure, details: invalidDetails, errorCode }, executedAtMs: 3 })).not.toHaveProperty('details');
  }
});

it('retains request-bound teardown proof details through stored and public approval reads', () => {
  const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
    createdBy: { surface: 'cli' }, requestedSurface: 'cli', actionId: 'deployments.teardown', summary: 'Teardown',
    actionArgs: { serverId: 'home', environmentId: 'environment', requestKey: 'teardown', reason: 'manual' },
    executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
      serverId: 'home', accountId: 'account', machineId: 'machine', actionId: 'deployments.teardown', requestId: 'request' } });
  const details = { environmentId: 'environment', revision: 3, deploymentId: 'receipt', deploymentRevision: 2,
    state: 'outcome_unknown', step: 'removeTarget', reason: 'plugin_exec_system_tool_unavailable' };
  const failure = { ok: false as const, errorCode: 'outcome_unknown', error: 'removeTarget: outcome_unknown', details,
    failureCause: { phase: 'deployment.teardown.observe', errorClass: 'Error' as const,
      errorCode: 'plugin_exec_system_tool_unavailable', httpStatus: null } };
  const execution = projectApprovalExecutionFailureV2({ request, failure, executedAtMs: 3 });
  expect(execution).toMatchObject({ details, failureCause: failure.failureCause });
  expect(execution).not.toHaveProperty('effectAttempted');
  const stored = StoredApprovalRequestSchema.parse({ ...request, status: 'failed', updatedAtMs: 3,
    decision: { kind: 'approve', decidedAtMs: 2 }, execution });
  expect(readApprovalExecutionFailure(stored)).toMatchObject({ details, failureCause: failure.failureCause });
  expect(projectApprovalRequestForPublicRead(stored)).toMatchObject({ execution: { details } });
  for (const invalidDetails of [
    { ...details, environmentId: 'other-environment' },
    { ...details, state: 'succeeded' },
    { ...details, step: 'arbitrary-step' },
    { ...details, token: 'private-fixture' },
  ]) {
    expect(projectApprovalExecutionFailureV2({ request, failure: { ...failure, details: invalidDetails }, executedAtMs: 3 }))
      .not.toHaveProperty('details');
  }
});

it('retains the native teardown refusal before any receipt exists', () => {
  const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
    createdBy: { surface: 'cli' }, requestedSurface: 'cli', actionId: 'deployments.teardown', summary: 'Teardown',
    actionArgs: { serverId: 'home', environmentId: 'environment', requestKey: 'teardown', reason: 'manual' },
    executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
      serverId: 'home', accountId: 'account', machineId: 'machine', actionId: 'deployments.teardown', requestId: 'request' } });
  const details = { reason: 'target_placement_unsupported', remedy: 'Run teardown on the sole native target Machine.' };
  const failure = { ok: false as const, errorCode: 'unsupported_action', error: 'unsupported_action', details,
    effectAttempted: false, failureCause: { phase: 'deployment.teardown.admission', errorClass: 'Error' as const,
      errorCode: null, httpStatus: null } };
  const execution = projectApprovalExecutionFailureV2({ request, failure, executedAtMs: 3 });
  expect(execution).toMatchObject({ details, failureCause: failure.failureCause, effectAttempted: false });
  const stored = StoredApprovalRequestSchema.parse({ ...request, status: 'failed', updatedAtMs: 3,
    decision: { kind: 'approve', decidedAtMs: 2 }, execution });
  expect(readApprovalExecutionFailure(stored)).toMatchObject({ details, failureCause: failure.failureCause });
  expect(projectApprovalRequestForPublicRead(stored)).toMatchObject({ execution: { details, effectAttempted: false } });
  for (const invalidDetails of [{ ...details, token: 'private-fixture' }, { ...details, reason: '' }]) {
    expect(projectApprovalExecutionFailureV2({ request, failure: { ...failure, details: invalidDetails }, executedAtMs: 3 }))
      .not.toHaveProperty('details');
  }
});
