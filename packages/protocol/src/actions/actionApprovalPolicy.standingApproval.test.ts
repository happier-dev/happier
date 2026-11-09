import { describe, expect, it } from 'vitest';

import { getActionSpec } from './actionSpecs.js';
import { normalizeActionsSettingsV1 } from './actionSettings.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { MachineSetupApplyInputV1Schema } from '../machines/managed/actionsV1.js';
import { DeploymentDeployIntentInputV1Schema } from '../deployments/deploymentDeployIntentV1.js';
import { WorkflowApprovedOperationV1Schema, matchesApprovedOperationStepV1 } from './approvedOperationV1.js';
import { bindWorkflowApprovedOperationSteps } from './executor/workflowRunActions.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { API_TOKEN_FULL_GRANT_V1 } from '../auth/apiTokenGrant.js';

describe('Workflow exact-input standing approval', () => {
  const actionId = 'machines.setup.apply';
  const input = MachineSetupApplyInputV1Schema.parse({ homeId: 'home', machineId: 'target', targets: [{
    homeId: 'home', machineId: 'target', desiredRevision: 0, recipePlans: [], sources: [
    { kind: 'accountPreset', presetId: 'preset', presetRevision: 1, setup: { scripts: [{ body: 'echo retained', affects: 'none' }],  } },
    { kind: 'direct', setup: {} },
  ] }] });
  const approvedOperation = {
    parent: { actionId: 'machines.setup.apply', input: { targets: ['target', 'other'] } },
    approvedBy: { accountId: 'person' },
    steps: [{ actionId, input }],
  };
  const context = { surface: 'agent', authority: 'account_automation' } as const;
  const resolve = (options: Partial<Parameters<typeof resolveActionApprovalRouting>[0]> = {}) =>
    resolveActionApprovalRouting({ actionId, spec: getActionSpec(actionId), input, context,
      settings: normalizeActionsSettingsV1({ v: 1, actions: {} }), approvedOperation, ...options });

  it('uses the stored approval only for the exact materialized Action and input', () => {
    expect(resolve().required).toBe(false);
    expect(resolve({ input: { ...input, targets: input.targets.map(target => ({ ...target,
      sources: target.sources.map(source => source.kind === 'accountPreset'
        ? { ...source, presetRevision: 2 } : source) })) } }).required).toBe(true);
    expect(resolve({ approvedOperation: { ...approvedOperation,
      steps: [{ actionId: 'machines.setup.resolve', input }] } }).required).toBe(true);
    expect(resolve({ approvedOperation: null }).required).toBe(true);
  });

  it('retains stricter live Settings and independent host policy', () => {
    const settings = normalizeActionsSettingsV1({ v: 1, actions: {
      [actionId]: { approvalRequiredSurfaces: ['agent'] },
    } });
    expect(resolve({ settings }).required).toBe(true);
    expect(resolve({ requiredByPolicy: true }).required).toBe(true);
  });

  it('does not treat an unmaterialized SHA binding as exact consent at execution', () => {
    const deploymentActionId = 'deployments.deploy';
    const authoredInput = { serverId: 'home', environmentId: 'staging', targetLinkId: 'link' };
    const operation = { ...approvedOperation, steps: [{ actionId: deploymentActionId, input: authoredInput,
      binding: { kind: 'deployment_sha' } as const }] };
    expect(resolveActionApprovalRouting({ actionId: deploymentActionId, spec: getActionSpec(deploymentActionId),
      input: authoredInput, context, settings: normalizeActionsSettingsV1({ v: 1, actions: {} }),
      defaultConfirmation: true, approvedOperation: operation }).required).toBe(true);
    const materializedInput = DeploymentDeployIntentInputV1Schema.parse({ ...authoredInput,
      sha: 'a'.repeat(40), requestKey: 'push-occurrence' });
    const resolveMaterialized = (input: unknown) => resolveActionApprovalRouting({ actionId: deploymentActionId,
      spec: getActionSpec(deploymentActionId), input, context,
      settings: normalizeActionsSettingsV1({ v: 1, actions: {} }), defaultConfirmation: true,
      approvedOperation: { ...operation, steps: [{ actionId: deploymentActionId, input: materializedInput }] } });
    expect(resolveMaterialized(materializedInput).required).toBe(false);
    expect(resolveMaterialized({ ...materializedInput, sha: 'b'.repeat(40) }).required).toBe(true);
  });
});

describe('saved deployment SHA approval schema', () => {
  const operation = {
    parent: { actionId: 'workflow.trigger.add', input: { triggerId: 'push' } },
    approvedBy: { accountId: 'owner' },
    steps: [{ actionId: 'deployments.deploy', input: { serverId: 'home', environmentId: 'staging',
      targetLinkId: 'link', sourceMethod: 'gitIntegration', whenBusy: 'supersede' },
      binding: { kind: 'deployment_sha' } }],
  };

  it('retains the declared SHA variable alongside exact authored deployment operands', () => {
    const parsed = WorkflowApprovedOperationV1Schema.safeParse(operation);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(operation);
  });

  it('refuses unknown bindings and bindings on a different Action', () => {
    expect(WorkflowApprovedOperationV1Schema.safeParse({ ...operation,
      steps: [{ ...operation.steps[0], binding: { kind: 'unknown' } }] }).success).toBe(false);
    expect(WorkflowApprovedOperationV1Schema.safeParse({ ...operation,
      steps: [{ ...operation.steps[0], actionId: 'machines.setup.apply' }] }).success).toBe(false);
  });

  it('never erases an unknown consent restriction when opening a stored operation', () => {
    expect(createStoredReadSchema(WorkflowApprovedOperationV1Schema).safeParse({ ...operation,
      steps: [{ ...operation.steps[0], binding: { kind: 'unknown' } }] }).success).toBe(false);
  });
});

describe('deployment token standing approval', () => {
  const actionId = 'deployments.deploy';
  const input = { serverId: 'home', environmentId: 'staging', targetLinkId: 'link',
    sha: 'a'.repeat(40), requestKey: 'ci' };
  const grant = { ...API_TOKEN_FULL_GRANT_V1, approve: false, create: null,
    actions: { ids: ['deployments.deploy', 'action.operations.get'], families: [] },
    targets: { sessions: [], machines: [], environments: ['staging'] },
    deployApproval: 'automatic' as const };
  const context = { surface: 'api', authority: 'account_automation',
    externalActionCredential: { accountId: 'person', principalId: 'person', credentialId: 'deployment-token', grant } } as const;
  const resolve = (options: Partial<Parameters<typeof resolveActionApprovalRouting>[0]> = {}) =>
    resolveActionApprovalRouting({ actionId, spec: getActionSpec(actionId), input, context,
      settings: normalizeActionsSettingsV1({ v: 1, actions: {} }), defaultConfirmation: true, ...options });

  it('applies Automatic only to the authenticated token’s one admitted Environment', () => {
    expect(resolve().required).toBe(false);
    expect(resolve({ input: { ...input, environmentId: 'other-environment' } }).required).toBe(true);
    const { deployApproval: _automatic, ...askGrant } = grant;
    expect(resolve({ context: { ...context,
      externalActionCredential: { ...context.externalActionCredential, grant: askGrant } } }).required).toBe(true);
    expect(resolve({ context: { surface: 'api', authority: 'account_automation' } }).required).toBe(true);
  });

  it('retains the token’s saved choice without a settings document or an Environment-content basis', () => {
    expect(resolve({ settings: null }).required).toBe(false);
    expect(resolve({ settings: null, input: { ...input, sha: 'b'.repeat(40), requestKey: 'next-ci' } }).required).toBe(false);
    expect(resolve({ settings: null, context: { ...context, externalActionCredential: {
      ...context.externalActionCredential, grant: { ...grant, deployApproval: undefined },
    } } }).required).toBe(true);
  });

  it('retains explicit Require and independent policy above the token’s saved choice', () => {
    expect(resolve({ settings: normalizeActionsSettingsV1({ v: 1,
      actions: { [actionId]: { approvalRequiredSurfaces: ['api'] } } }) }).required).toBe(true);
    expect(resolve({ requiredByPolicy: true }).required).toBe(true);
    expect(resolve({ context: { ...context, externalActionCredential: {
      ...context.externalActionCredential, grant: { ...grant, approve: true } } } }).required).toBe(true);
  });
});

describe('saved deployment SHA matching', () => {
  const actionId = 'deployments.deploy';
  const sha = 'a'.repeat(40);
  const semantic = { serverId: 'home', environmentId: 'staging', targetLinkId: 'link',
    sourceMethod: 'gitIntegration', whenBusy: 'supersede' } as const;
  const operation = (input: Record<string, unknown> = semantic) => WorkflowApprovedOperationV1Schema.parse({
    parent: { actionId: 'workflow.trigger.add', input: { triggerId: 'push' } },
    approvedBy: { accountId: 'owner' }, steps: [{ actionId, input, binding: { kind: 'deployment_sha' } }],
  });

  it('varies only the admitted commit and invocation identity', () => {
    const step = operation().steps[0]!;
    const current = { ...semantic, sha, requestKey: 'push' };
    expect(matchesApprovedOperationStepV1(step, actionId, current)).toBe(true);
    expect(matchesApprovedOperationStepV1(step, actionId,
      { ...current, sha: 'b'.repeat(40), requestKey: 'next-push' })).toBe(true);
    expect(matchesApprovedOperationStepV1({ actionId, input: current }, actionId,
      { ...current, sha: 'b'.repeat(40) })).toBe(false);
    expect(matchesApprovedOperationStepV1(step, 'deployments.rollback', current)).toBe(false);
    for (const changed of [
      { ...current, serverId: 'other-home' }, { ...current, environmentId: 'other-environment' },
      { ...current, targetLinkId: 'other-link' }, { ...current, sourceMethod: 'upload' },
      { ...current, whenBusy: 'refuse' }, { ...current, expectedRevision: 2 },
      { ...current, sha: 'not-a-commit' },
    ]) expect(matchesApprovedOperationStepV1(step, actionId, changed)).toBe(false);
  });

  it('preserves the domain default for omitted whenBusy', () => {
    const savedInput = { serverId: 'home', environmentId: 'staging', targetLinkId: 'link' };
    const step = operation(savedInput).steps[0]!;
    const input = { ...savedInput, sha, requestKey: 'ci', whenBusy: 'refuse' };
    expect(matchesApprovedOperationStepV1(step, actionId, input)).toBe(true);
    expect(matchesApprovedOperationStepV1(step, actionId, { ...input, whenBusy: 'supersede' })).toBe(false);
  });

  it('retains the repository and Compose operands while varying its repository commit', () => {
    const sourceIntent = { kind: 'repository', projectSourceId: 'source', sourceRevision: 7, sha,
      compose: { path: 'compose.yaml', profiles: ['web'], services: ['app'], primaryService: 'app' } };
    const savedInput = { ...semantic, sourceIntent };
    const step = operation(savedInput).steps[0]!;
    const current = { ...savedInput, sourceIntent: { ...sourceIntent, sha: 'b'.repeat(40) }, requestKey: 'push' };
    expect(matchesApprovedOperationStepV1(step, actionId, current)).toBe(true);
    for (const changedSource of [
      { ...current.sourceIntent, projectSourceId: 'other-source' },
      { ...current.sourceIntent, sourceRevision: 8 },
      { ...current.sourceIntent, compose: { ...sourceIntent.compose, path: 'other.yaml' } },
      { ...current.sourceIntent, compose: { ...sourceIntent.compose, profiles: ['worker'] } },
      { ...current.sourceIntent, compose: { ...sourceIntent.compose, services: ['worker'] } },
      { ...current.sourceIntent, compose: { ...sourceIntent.compose, primaryService: 'worker' } },
      { ...current.sourceIntent, pullRequestHead: { number: 12 } },
    ]) expect(matchesApprovedOperationStepV1(step, actionId, { ...current, sourceIntent: changedSource })).toBe(false);
  });

  it('returns exact prepared consent to policy without leaving an unresolved variable', () => {
    const saved = operation();
    const prepared = { serverId: 'home', environmentId: 'staging', expectedRevision: 42,
      targetLinkId: 'link', expectedTargetLinkRevision: 12, requestKey: 'push',
      contentArtifactId: 'receipt-content', contentHeaderVersion: 1, contentBodyVersion: 1, whenBusy: 'supersede' };
    const bound = bindWorkflowApprovedOperationSteps({ operation: { ...saved, parent: { actionId, input: prepared } },
      steps: [{ actionId, input: prepared }] });
    expect(bound.steps[0]!.binding).toBeUndefined();
    const resolve = (input: unknown) => resolveActionApprovalRouting({ actionId, spec: getActionSpec(actionId), input,
      context: { surface: 'agent', authority: 'account_automation' }, defaultConfirmation: true,
      settings: normalizeActionsSettingsV1({ v: 1, actions: {} }), approvedOperation: bound });
    expect(resolve(prepared).required).toBe(false);
    expect(resolve({ ...prepared, contentArtifactId: 'different-content' }).required).toBe(true);
    expect(resolve({ ...prepared, environmentId: 'other-environment' }).required).toBe(true);
  });
});
