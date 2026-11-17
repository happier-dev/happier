import { expect, it } from 'vitest';
import { ApprovalRequestV2Schema, StoredApprovalRequestSchema } from './approvalRequestV1.js';
import { projectApprovalExecutionFailureV2, readApprovalExecutionFailure } from './approvalExecutionFailure.js';
import { projectApprovalRequestForPublicRead } from '../actions/actionApprovalPresentation.js';
import { DeploymentEnvironmentCreateInputV1Schema, DeploymentEnvironmentCreateResultV1Schema } from '../deployments/deploymentActionsV1.js';
import { executeDeploymentAction } from '../actions/executor/deploymentAction.js';
import { buildActionExecuteResultFromRecordedApprovalExecution, buildApprovalDecisionResult, projectSettledApprovalExecution } from '../actions/executor/approvalResults.js';

function placementCreateRequest() {
  return ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
    createdBy: { surface: 'cli' }, requestedSurface: 'cli', actionId: 'deployments.environments.create', summary: 'Create Environment',
    actionArgs: { serverId: 'home', projectSourceId: 'source', requestKey: 'create', protection: 'nonProduction',
      purpose: 'standard', deployerMode: 'managers', controllerMachineId: 'machine', buildMachineId: 'builder',
      contentArtifactId: 'environment-content', contentHeaderVersion: 1, contentBodyVersion: 1,
      firstTargetLink: { contentArtifactId: 'target-content', contentHeaderVersion: 1, contentBodyVersion: 1,
        machines: [{ machineId: 'runtime', installationId: 'runtime-installation' }] } },
    executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
      serverId: 'home', accountId: 'account', machineId: 'machine', actionId: 'deployments.environments.create', requestId: 'request' } });
}

it.each([
  { state: 'failed', errorCode: 'deployment_failed' },
  { state: 'cancelled', errorCode: 'cancelled' },
  { state: 'outcome_unknown', errorCode: 'outcome_unknown' },
])('retains terminal receipt recovery in public approval history for $state', ({ state, errorCode }) => {
  const request = ApprovalRequestV2Schema.parse({ ...placementCreateRequest(), actionId: 'deployments.deploy',
    actionArgs: { serverId: 'home', environmentId: 'environment', targetLinkId: 'target', expectedRevision: 3,
      expectedTargetLinkRevision: 1, requestKey: 'held', contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1 },
    executionOriginV1: { ...placementCreateRequest().executionOriginV1, actionId: 'deployments.deploy' } });
  const details = { ok: true, environmentId: 'environment', revision: 3, deploymentId: 'receipt', deploymentRevision: 2,
    state, requiredFact: 'deploymentActionResult', remedy: 'Confirm the previous deployment before retrying.' };
  const requestId = 'failed-operation-request';
  const failure = { ok: false as const, errorCode, error: errorCode, requestId, details };
  const settled = projectSettledApprovalExecution({ request, actionId: 'deployments.deploy', exec: failure,
    dispatchEffectAttempted: true, executedAtMs: 3 });
  const execution = settled.request.execution;
  expect(execution).toMatchObject({ requestId, details });
  const stored = StoredApprovalRequestSchema.parse({ ...settled.request,
    decision: { kind: 'approve', decidedAtMs: 2 }, execution });
  expect(readApprovalExecutionFailure(stored)).toMatchObject({ requestId, details });
  expect(projectApprovalRequestForPublicRead(stored)).toMatchObject({ execution: { requestId, details } });
  expect(buildApprovalDecisionResult(stored)).toMatchObject({ ok: true,
    result: { ok: true, status: state === 'outcome_unknown' ? 'outcome_unknown' : 'failed',
      execution: { ok: false, errorCode, requestId, details } } });
  expect(buildActionExecuteResultFromRecordedApprovalExecution(stored)).toMatchObject({ ok: false, errorCode, requestId, details });
  for (const invalidDetails of [{ ...details, environmentId: 'other-environment' },
    { ...details, state: 'succeeded' }, { ...details, token: 'private-fixture' }]) {
    expect(projectApprovalExecutionFailureV2({ request, failure: { ...failure, details: invalidDetails }, executedAtMs: 3 }))
      .not.toHaveProperty('details');
  }
  expect(projectApprovalExecutionFailureV2({ request,
    failure: { ...failure, errorCode: 'unrelated_failure' }, executedAtMs: 3 })).not.toHaveProperty('details');
});

it.each([
  { name: 'legacy', role: 'controller', machineId: 'machine', sameMachine: false, fields: {} },
  { name: 'Source custody on one Machine for every role', role: 'controller', machineId: 'machine', sameMachine: true, fields: { effectAttempted: false, diagnostic: {
    reason: 'source_machine_access_missing', requiredFact: 'source_machine_use', remedy: 'share_machine_with_source_owner' } } },
  { name: 'build Machine lifecycle', role: 'build', machineId: 'builder', sameMachine: false, fields: { effectAttempted: false, diagnostic: {
    reason: 'machine_revoked', requiredFact: 'machine_registration', remedy: 'register_machine' } } },
  { name: 'first target custody', role: 'target', machineId: 'runtime', sameMachine: false, fields: { effectAttempted: false, diagnostic: {
    reason: 'source_machine_access_missing', requiredFact: 'source_machine_use', remedy: 'share_machine_with_source_owner' } } },
] as const)('retains $name Machine placement refusal through the executor, settlement and public approval read', async ({ fields, role, machineId, sameMachine }) => {
  const request = placementCreateRequest();
  if (sameMachine) request.actionArgs = DeploymentEnvironmentCreateInputV1Schema.parse({ ...DeploymentEnvironmentCreateInputV1Schema.parse(request.actionArgs),
    buildMachineId: 'machine', firstTargetLink: { contentArtifactId: 'target-content', contentHeaderVersion: 1,
      contentBodyVersion: 1, machines: [{ machineId: 'machine', installationId: 'installation' }] } });
  const details = { ok: false as const, error: 'machine_unavailable' as const, role,
    machineIds: [machineId], nextActions: role === 'target'
      ? ['start' as const, 'removeFromEnvironment' as const] : ['start' as const, 'chooseAnother' as const], ...fields };
  expect.soft(DeploymentEnvironmentCreateResultV1Schema.safeParse(details).success).toBe(true);
  const exec = await executeDeploymentAction('deployments.environments.create',
    DeploymentEnvironmentCreateInputV1Schema.parse(request.actionArgs), { surface: 'cli', authority: 'present_user' },
    { deploymentAction: async () => details });
  expect.soft(exec).toMatchObject({ ok: false, errorCode: 'machine_unavailable', details });
  if ('effectAttempted' in fields) expect.soft(exec).toHaveProperty('effectAttempted', false);
  else expect(exec).not.toHaveProperty('effectAttempted');
  const settled = projectSettledApprovalExecution({ request, actionId: 'deployments.environments.create', exec,
    dispatchEffectAttempted: true, executedAtMs: 3 });
  const stored = StoredApprovalRequestSchema.parse({ ...settled.request, decision: { kind: 'approve', decidedAtMs: 2 } });
  expect.soft(readApprovalExecutionFailure(stored)).toMatchObject({ details });
  expect.soft(projectApprovalRequestForPublicRead(stored)).toMatchObject({ execution: { details } });
  expect.soft(buildApprovalDecisionResult(stored)).toMatchObject({ ok: true, result: { status: 'failed', execution: { details } } });
  if ('effectAttempted' in fields) expect.soft(stored.execution).toHaveProperty('effectAttempted', false);
  else expect(stored.execution).not.toHaveProperty('effectAttempted');
});

it('drops malformed, opaque or mismatched Machine placement details from approval history', () => {
  const request = placementCreateRequest();
  const details = { ok: false, error: 'machine_unavailable', role: 'controller', machineIds: ['machine'],
    nextActions: ['start', 'chooseAnother'], effectAttempted: false, diagnostic: {
      reason: 'source_machine_access_missing', requiredFact: 'source_machine_use', remedy: 'share_machine_with_source_owner' } };
  const failure = { ok: false as const, errorCode: 'machine_unavailable', error: 'machine_unavailable', effectAttempted: false, details };
  for (const invalidDetails of [
    { ...details, machineIds: [] }, { ...details, role: 'arbitrary-role' }, { ...details, token: 'private-fixture' },
    { ...details, diagnostic: { ...details.diagnostic, token: 'private-fixture' } },
    { ...details, diagnostic: { ...details.diagnostic, remedy: 'reconnect_machine' } },
    { ...details, effectAttempted: true },
  ]) {
    expect(DeploymentEnvironmentCreateResultV1Schema.safeParse(invalidDetails).success).toBe(false);
    expect(projectApprovalExecutionFailureV2({ request, failure: { ...failure, details: invalidDetails }, executedAtMs: 3 }))
      .not.toHaveProperty('details');
  }
  for (const invalidDetails of [{ ...details, machineIds: ['unrelated-machine'] }, { ...details, role: 'build' }]) {
    expect(projectApprovalExecutionFailureV2({ request, failure: { ...failure, details: invalidDetails }, executedAtMs: 3 }))
      .not.toHaveProperty('details');
  }
  for (const [invalidRequest, errorCode] of [
    [request, 'unrelated_error'],
    [{ ...request, actionArgs: {} }, 'machine_unavailable'],
    [{ ...request, actionId: 'settings.get' as const, actionArgs: {} }, 'machine_unavailable'],
  ] as const) {
    expect(projectApprovalExecutionFailureV2({ request: invalidRequest, failure: { ...failure, errorCode }, executedAtMs: 3 }))
      .not.toHaveProperty('details');
  }
});

it('retains the current reviewed Environment revision and recovery through strict approval reads', () => {
  const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
    createdBy: { surface: 'cli' }, requestedSurface: 'cli', actionId: 'deployments.deploy', summary: 'Deploy',
    actionArgs: { serverId: 'home', environmentId: 'environment', targetLinkId: 'target', expectedRevision: 3,
      expectedTargetLinkRevision: 1, requestKey: 'held', contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1 },
    executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
      serverId: 'home', accountId: 'account', machineId: 'machine', actionId: 'deployments.deploy', requestId: 'request' } });
  const details = { serverId: 'home', environmentId: 'environment', targetLinkId: 'target',
    requiredFact: 'currentEnvironmentRevision', currentEnvironmentRevision: 4,
    remedy: 'Review again against the current Environment revision before approving the deployment.' };
  const failure = { ok: false as const, errorCode: 'deployment_conflict', error: 'deployment_conflict', effectAttempted: false, details };
  const execution = projectApprovalExecutionFailureV2({ request, failure, executedAtMs: 3 });
  expect.soft(execution).toMatchObject({ effectAttempted: false, details });
  const stored = StoredApprovalRequestSchema.parse({ ...request, status: 'failed', updatedAtMs: 3,
    decision: { kind: 'approve', decidedAtMs: 2 }, execution });
  expect.soft(projectApprovalRequestForPublicRead(stored)).toMatchObject({ execution: { effectAttempted: false, details } });
  for (const invalidDetails of [{ ...details, serverId: 'other' }, { ...details, environmentId: 'other' },
    { ...details, targetLinkId: 'other' }, { ...details, token: 'private-fixture' }]) {
    expect(projectApprovalExecutionFailureV2({ request, failure: { ...failure, details: invalidDetails }, executedAtMs: 3 }))
      .not.toHaveProperty('details');
  }
  expect(projectApprovalExecutionFailureV2({ request, failure: { ...failure, errorCode: 'native_failed' }, executedAtMs: 3 }))
    .not.toHaveProperty('details');
});

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
