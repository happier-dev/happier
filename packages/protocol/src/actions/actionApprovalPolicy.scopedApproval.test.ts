import { describe, expect, it } from 'vitest';
import { normalizeActionsSettingsV1 } from './actionSettings.js';
import { isApprovalRequiredByActionsSettings, resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { getActionSpec } from './actionSpecs.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { setScopedActionApprovalPreference } from './actionSettings.js';
import { WorkflowApprovedOperationV1Schema } from './approvedOperationV1.js';
import { createDeploymentApprovalScopeResolverV1 } from '../deployments/deploymentApprovalScopeV1.js';

describe('admitted scoped Actions approval', () => {
  // P44-C27: inherited Allow is live; only stricter child policy can override it.
  it('routes a real preview deploy through live parent policy and preserves stricter child Ask', async () => {
    const scope = { kind: 'environment', environmentId: 'pr-one' } as const;
    const parentScope = { kind: 'environment', environmentId: 'template' } as const;
    let templateEnvironmentId: string = parentScope.environmentId;
    let settings = setScopedActionApprovalPreference({ settings: normalizeActionsSettingsV1({ v: 1 }),
      actionId: 'deployments.deploy', scope: parentScope, surface: 'cli', mode: 'waived' });
    const effects: unknown[] = [];
    const deploymentAction: NonNullable<ActionExecutorDeps['deploymentAction']> = async (_actionId, input) => {
      effects.push(input);
      return { ok: false, errorCode: 'deployment_unavailable', error: 'deployment_unavailable' };
    };
    const resolveEnvironmentApprovalScope = createDeploymentApprovalScopeResolverV1(deploymentAction,
      async ({ environmentId }) => ({ ok: true, environment: { id: environmentId, projectSourceId: 'source',
        purpose: environmentId === 'unrelated' ? 'standard' : 'preview',
        ...(environmentId === 'unrelated' ? {} : { previewTemplateEnvironmentId: templateEnvironmentId }) } }));
    const approvals: unknown[] = [];
    const executor = createActionExecutor({
      resolveEnvironmentApprovalScope, deploymentAction,
      approvalsCreate: async ({ request }) => { approvals.push(request); return { artifactId: `approval-${approvals.length}` }; },
    });
    const input = {
      serverId: 'home', environmentId: scope.environmentId, expectedRevision: 1,
      targetLinkId: 'target', expectedTargetLinkRevision: 1, requestKey: 'deploy',
      contentArtifactId: 'content', contentHeaderVersion: 1, contentBodyVersion: 1,
    };
    const context = { surface: 'cli' as const, authority: 'account_automation' as const,
      serverId: 'home', machineId: 'controller', runtimeAccountId: 'owner', actionRequestId: 'preview-policy',
      get actionsSettings() { return settings; } };
    expect(await executor.execute('deployments.deploy', input, context)).toMatchObject({ ok: false, errorCode: 'deployment_unavailable' });
    expect(effects).toHaveLength(1);
    settings = setScopedActionApprovalPreference({ actionId: 'deployments.deploy', scope,
      surface: 'cli', mode: 'required', settings });
    const stricterChild = await executor.execute('deployments.deploy', input, context);
    expect(effects).toHaveLength(1);
    expect(stricterChild, JSON.stringify(stricterChild)).toMatchObject({ ok: true,
      result: { kind: 'approval_request_created' } });
    settings = setScopedActionApprovalPreference({ actionId: 'deployments.deploy', scope,
      surface: 'cli', mode: 'waived', settings });
    settings = setScopedActionApprovalPreference({ actionId: 'deployments.deploy', scope: parentScope,
      surface: 'cli', mode: 'required', settings });
    expect(await executor.execute('deployments.deploy', input, context)).toMatchObject({ ok: true,
      result: { kind: 'approval_request_created' } });
    expect(effects).toHaveLength(1);
    expect(approvals).toHaveLength(2);
    expect(await executor.execute('deployments.deploy', { ...input, environmentId: 'unrelated' }, context))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(effects).toHaveLength(1);
    settings = setScopedActionApprovalPreference({ actionId: 'deployments.deploy', scope: parentScope,
      surface: 'cli', mode: 'waived', settings });
    templateEnvironmentId = 'other-template';
    expect(await executor.execute('deployments.deploy', input, context))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(effects).toHaveLength(1);
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

  it('uses the admitted template policy for preview Create before a child Environment exists', async () => {
    let settings = setScopedActionApprovalPreference({ settings: normalizeActionsSettingsV1({ v: 1 }),
      actionId: 'deployments.environments.create', scope: { kind: 'environment', environmentId: 'template' },
      surface: 'cli', mode: 'waived' });
    let sourceId = 'source';
    const effects: unknown[] = [];
    const deploymentAction: NonNullable<ActionExecutorDeps['deploymentAction']> = async (_actionId, input) => {
      effects.push(input);
      return { ok: false, errorCode: 'deployment_unavailable', error: 'deployment_unavailable' };
    };
    const approvals: unknown[] = [];
    const executor = createActionExecutor({ deploymentAction,
      resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(deploymentAction,
        async ({ environmentId }) => ({ ok: true, environment: {
          id: environmentId, projectSourceId: sourceId, purpose: 'standard',
        } })),
      approvalsCreate: async ({ request }) => { approvals.push(request); return { artifactId: 'create-approval' }; },
    });
    const input = { serverId: 'home', projectSourceId: 'source', requestKey: 'preview-create',
      contentArtifactId: 'content', contentHeaderVersion: 1, contentBodyVersion: 1,
      protection: 'nonProduction' as const, purpose: 'preview' as const, deployerMode: 'managers' as const,
      controllerMachineId: 'controller', preview: { templateEnvironmentId: 'template', expectedTemplateRevision: 1,
        pullRequestId: 'pull-request', runtimeTargetLinkId: 'runtime' } };
    const context = { surface: 'cli' as const, authority: 'account_automation' as const,
      serverId: 'home', machineId: 'controller', runtimeAccountId: 'owner', actionRequestId: 'preview-create-policy',
      get actionsSettings() { return settings; } };
    const allowed = await executor.execute('deployments.environments.create', input, context);
    expect(effects, JSON.stringify(allowed)).toHaveLength(1);
    expect(allowed).toMatchObject({ ok: false, errorCode: 'deployment_unavailable' });
    settings = setScopedActionApprovalPreference({ settings, actionId: 'deployments.environments.create',
      scope: { kind: 'environment', environmentId: 'template' }, surface: 'cli', mode: 'required' });
    expect(await executor.execute('deployments.environments.create', input, context))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(effects).toHaveLength(1);
    expect(approvals).toHaveLength(1);
    sourceId = 'other-source';
    expect(await executor.execute('deployments.environments.create', input, context))
      .toMatchObject({ ok: false, errorCode: 'deployment_access_denied' });
    expect(effects).toHaveLength(1);
    expect(approvals).toHaveLength(1);
  });

  it('consumes a token-owned exact operation without inventing Workflow origin after policy changes', async () => {
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
    if (prepared.kind === 'ready') expect(await prepared.invocation.run())
      .toMatchObject({ ok: false, errorCode: 'deployment_unavailable' });
    // An exact admitted operation finishes; new admissions retain the live-policy checks above.
    expect(effects).toEqual([effect]);
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

