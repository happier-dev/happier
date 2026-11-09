import { describe, expect, it } from 'vitest';
import { normalizeActionsSettingsV1 } from './actionSettings.js';
import { isApprovalRequiredByActionsSettings, resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { getActionSpec } from './actionSpecs.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { setScopedActionApprovalPreference } from './actionSettings.js';
import { WorkflowApprovedOperationV1Schema } from './approvedOperationV1.js';
import { readActionApprovalScopeAdmissionV1 } from './executor/approvalScope.js';

describe('admitted scoped Actions approval', () => {
  it('projects only the admitted Environment scope without dormant inheritance or mandatory flags', async () => {
    const scope = { kind: 'environment', environmentId: 'staging' } as const;
    const boundaryAdmission = { scope, previewTemplateEnvironmentId: 'template', mandatoryApprovalRequired: true } as const;
    const admitted = await readActionApprovalScopeAdmissionV1({
      actionId: 'deployments.deploy', spec: getActionSpec('deployments.deploy'), input: {},
      context: { surface: 'cli' }, phase: 'prepare', isSameHome: (left, right) => left === right,
      deps: { resolveEnvironmentApprovalScope: async () => boundaryAdmission },
    });
    expect(admitted).toEqual({ approvalScope: scope });
  });

  it('lets the Environment owner waive deployment confirmation independently of unrelated template preferences', async () => {
    const scope = { kind: 'environment', environmentId: 'staging' } as const;
    const settings = normalizeActionsSettingsV1({ v: 1, actions: {}, scopedApprovalPreferences: [
      { actionId: 'deployments.deploy', scope, approvalRequiredSurfaces: [], approvalWaivedSurfaces: ['cli'] },
      { actionId: 'deployments.deploy', scope: { kind: 'environment', environmentId: 'template' },
        approvalRequiredSurfaces: ['cli'], approvalWaivedSurfaces: [] },
    ] });
    const boundaryAdmission = { scope, previewTemplateEnvironmentId: 'template', mandatoryApprovalRequired: true } as const;
    const effects: unknown[] = [];
    const executor = createActionExecutor({
      resolveEnvironmentApprovalScope: async () => boundaryAdmission,
      deploymentAction: async (_actionId, input) => {
        effects.push(input);
        return { ok: false, errorCode: 'deployment_unavailable', error: 'deployment_unavailable' };
      },
    });
    const result = await executor.prepare('deployments.deploy', {
      serverId: 'home', environmentId: scope.environmentId, expectedRevision: 1,
      targetLinkId: 'target', expectedTargetLinkRevision: 1, requestKey: 'deploy',
      contentArtifactId: 'content', contentHeaderVersion: 1, contentBodyVersion: 1,
    }, { surface: 'cli', serverId: 'home', actionsSettings: settings });
    expect(result.kind).toBe('ready');
    if (result.kind === 'ready') expect(await result.invocation.run())
      .toMatchObject({ ok: false, errorCode: 'deployment_unavailable' });
    expect(effects).toHaveLength(1);
    const required = setScopedActionApprovalPreference({ actionId: 'deployments.deploy', scope,
      surface: 'cli', mode: 'required', settings });
    expect(resolveActionApprovalRouting({ actionId: 'deployments.deploy', spec: getActionSpec('deployments.deploy'),
      context: { surface: 'cli' }, settings: required, approvalScope: scope }).required).toBe(true);
  });

  it('keeps unavailable Environment admission closed even when its approval preference is waived', async () => {
    const effects: unknown[] = [];
    const executor = createActionExecutor({
      resolveEnvironmentApprovalScope: async () => ({ ok: false, errorCode: 'deployment_unavailable', error: 'deployment_unavailable' }),
      deploymentAction: async (_actionId, input) => {
        effects.push(input);
        return { ok: false, errorCode: 'deployment_unavailable', error: 'deployment_unavailable' };
      },
    });
    const result = await executor.prepare('deployments.deploy', {
      serverId: 'home', environmentId: 'staging', expectedRevision: 1,
      targetLinkId: 'target', expectedTargetLinkRevision: 1, requestKey: 'deploy',
      contentArtifactId: 'content', contentHeaderVersion: 1, contentBodyVersion: 1,
    }, { surface: 'cli', serverId: 'home', actionsSettings: setScopedActionApprovalPreference({
      actionId: 'deployments.deploy', scope: { kind: 'environment', environmentId: 'staging' },
      surface: 'cli', mode: 'waived', settings: normalizeActionsSettingsV1({ v: 1, actions: {} }),
    }) });
    expect(result).toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'deployment_unavailable' } });
    expect(effects).toEqual([]);
  });

  it('consumes a token-owned exact operation without inventing Workflow origin and rechecks live stricter policy', async () => {
    const effect = { serverId: 'home', environmentId: 'staging', expectedRevision: 1,
      targetLinkId: 'target', expectedTargetLinkRevision: 1, requestKey: 'deploy',
      contentArtifactId: 'content', contentHeaderVersion: 1, contentBodyVersion: 1 };
    const operation = WorkflowApprovedOperationV1Schema.parse({
      parent: { actionId: 'account.apiTokens.create', input: { tokenId: '11111111-1111-4111-8111-111111111111', label: 'CI' } },
      approvedBy: { accountId: 'owner' }, steps: [{ actionId: 'deployments.deploy', input: effect }],
    });
    let settings = normalizeActionsSettingsV1({ v: 1, actions: {} });
    const reads: string[] = [];
    const effects: unknown[] = [];
    const executor = createActionExecutor(Object.assign({
      resolveEnvironmentApprovalScope: async () => ({ scope: { kind: 'environment' as const, environmentId: 'staging' } }),
      deploymentAction: async (_id: string, value: unknown) => { effects.push(value);
        return { ok: false as const, errorCode: 'deployment_unavailable', error: 'deployment_unavailable' }; },
    }, { readApprovedOperation: async (request: { phase: string; runId?: string }) => {
      expect(request.runId).toBeUndefined(); reads.push(request.phase); return operation;
    } }) as ActionExecutorDeps);
    const context = { surface: 'cli' as const, authority: 'account_automation' as const,
      serverId: 'home', get actionsSettings() { return settings; } };
    const prepared = await executor.prepare('deployments.deploy', effect, context);
    expect(prepared.kind).toBe('ready');
    settings = normalizeActionsSettingsV1({ v: 1, actions: { 'deployments.deploy': { approvalRequiredSurfaces: ['cli'] } } });
    if (prepared.kind === 'ready') expect(await prepared.invocation.run()).toMatchObject({ ok: false });
    expect(effects).toEqual([]);
    expect(reads).toEqual(['prepare', 'dispatch']);
  });
  const scope = { kind: 'environment', environmentId: 'staging' } as const;
  const settings = () => normalizeActionsSettingsV1({ v: 1, actions: {
    'session.stop': { approvalRequiredSurfaces: ['cli'] },
  }, scopedApprovalPreferences: [{ actionId: 'session.stop', scope,
    approvalRequiredSurfaces: ['mcp'], approvalWaivedSurfaces: ['cli'] }] });

  it('uses an explicit exact-scope mode before global/default fallback, across both routing entry points', () => {
    const policy = settings();
    expect(isApprovalRequiredByActionsSettings('session.stop', policy, { surface: 'cli' },
      undefined, undefined, undefined, undefined, undefined, undefined, scope)).toBe(false);
    expect(resolveActionApprovalRouting({ actionId: 'session.stop', spec: getActionSpec('session.stop'),
      settings: policy, context: { surface: 'cli' }, approvalScope: scope }).required).toBe(false);
    expect(resolveActionApprovalRouting({ actionId: 'session.stop', spec: getActionSpec('session.stop'),
      settings: policy, context: { surface: 'mcp' }, approvalScope: scope }).required).toBe(true);
  });

  it('keeps sibling scopes, global-only calls, and separately stricter admitted policy isolated', () => {
    for (const approvalScope of [undefined, { kind: 'environment', environmentId: 'production' } as const,
      { kind: 'machine', machineId: 'staging' } as const]) {
      expect(resolveActionApprovalRouting({ actionId: 'session.stop', spec: getActionSpec('session.stop'),
        settings: settings(), context: { surface: 'cli' }, approvalScope }).required).toBe(true);
    }
    expect(resolveActionApprovalRouting({ actionId: 'session.stop', spec: getActionSpec('session.stop'),
      settings: settings(), context: { surface: 'cli' }, approvalScope: scope, requiredByPolicy: true }).required).toBe(true);
    expect(resolveActionApprovalRouting({ actionId: 'session.stop', spec: getActionSpec('session.stop'),
      settings: settings(), context: { surface: 'cli' }, approvalScope: scope,
      defaultConfirmation: true, requiredByPolicy: true }).required).toBe(true);
  });
});

