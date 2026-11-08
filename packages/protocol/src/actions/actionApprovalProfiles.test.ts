import { describe, expect, it } from 'vitest';
import { normalizeActionsSettingsV1 } from './actionSettings.js';
import { resolveActionApprovalRouting, EGRESS_SENSITIVE_AGENT_FLOOR, SURFACE_AUTHORITY_AGENT_FLOOR } from './actionApprovalPolicy.js';
import { getActionSpec } from './actionSpecs.js';
import { ActionPolicyInputSchemas, ActionPolicyOutputSchemas } from './actionPolicyActionFamily.js';
import { applyActionPolicyMutation } from './actionAudiencePolicy.js';
import { accountSettingsParse } from '../account/settings/accountSettings.js';
import { applyAccountSettingMutationV1 } from '../account/settings/accountSettingMutationV1.js';
import { listApprovalProfilesV1 } from './approvalProfiles.js';
import { createActionExecutor, invokeHostReviewedChildV1 } from './actionExecutor.js';
import { DeploymentReceiptAcceptedResultV1Schema } from '../deployments/deploymentReceiptResultV1.js';

describe('Account approval profiles at Action admission', () => {
  const settings = normalizeActionsSettingsV1({ v: 1, actions: {},
    approvalWaivedSurfaces: { 'deployments.deploy': ['agent'] },
    approvalProfiles: [{ id: 'custom', name: 'Only reviewed deploys', defaultMode: 'allow',
      actions: { 'deployments.deploy': 'require' } }],
  });
  const deploy = (approvalProfileId: string, policy = settings) => resolveActionApprovalRouting({
    actionId: 'deployments.deploy', spec: getActionSpec('deployments.deploy'),
    input: { environmentId: 'env' }, settings: policy,
    context: { surface: 'agent', authority: 'account_automation', approvalProfileId },
  });

  it('routes the same Session deploy to Ask under read/propose and executes with the existing waiver under safe actions', () => {
    expect(deploy('builtin:read-propose').required).toBe(true);
    expect(deploy('builtin:apply-safe').required).toBe(false);
    expect(deploy('builtin:apply-safe', normalizeActionsSettingsV1({ v: 1, actions: {} })).required).toBe(true);
    expect(deploy('custom').required).toBe(true);
  });

  it('settles a deleted reference visibly and more strictly than a saved waiver', () => {
    expect(deploy('deleted')).toMatchObject({ required: true,
      profile: { status: 'missing', requestedId: 'deleted', effectiveId: 'builtin:read-propose' } });
  });

  it('binds the calling Session profile once through composed deploy admission', async () => {
    let sessionProfile = 'builtin:read-propose';
    let reads = 0;
    let effects = 0;
    const input = { serverId: 'home', environmentId: 'environment', expectedRevision: 3, requestKey: 'deploy-request',
      targetLinkId: 'link', expectedTargetLinkRevision: 4, contentArtifactId: 'definition', contentHeaderVersion: 1, contentBodyVersion: 1 };
    const receipt = DeploymentReceiptAcceptedResultV1Schema.parse({ ok: true, environmentId: 'environment',
      revision: 4, kind: 'pending', actionOperationId: 'operation' });
    const executor = createActionExecutor({
      // The Session metadata store and deployment provider are process boundaries.
      readActionApprovalProfileId: async () => { reads++; return sessionProfile; },
      resolveEnvironmentApprovalScope: async () => ({ scope: { kind: 'environment', environmentId: 'environment' } }),
      prepareDeploymentAction: async () => ({ input, preview: { sourceMethod: 'gitIntegration' } }),
      deploymentAction: async () => { effects++; return receipt; },
    });
    const context = { surface: 'agent' as const, authority: 'account_automation' as const,
      actionCaller: { kind: 'session' as const, sessionId: 'cmvbeu0ig0040m203zcysq5v8' },
      serverId: 'home', actionsSettings: settings, interactivePresentation: 'unavailable' as const };
    expect(await executor.execute('deployments.deploy', input, context)).toMatchObject({
      ok: false, errorCode: 'action_interactive_review_required',
    });
    expect(effects).toBe(0);
    expect(reads).toBe(1);
    sessionProfile = 'builtin:apply-safe';
    expect(await executor.execute('deployments.deploy', input, context)).toMatchObject({ ok: true, result: receipt });
    expect(effects).toBe(1);
    expect(reads).toBe(2);
    sessionProfile = 'deleted';
    expect(await executor.execute('deployments.deploy', input, context)).toMatchObject({ ok: false,
      errorCode: 'action_interactive_review_required', details: { approvalProfile: { status: 'missing', requestedId: 'deleted' } } });
    expect(effects).toBe(1);
    expect(reads).toBe(3);
    // An exact reviewed child retains the issuer's decision through native
    // preparation/dispatch, including the live Environment-scoped path.
    const child = { action: 'deployments.deploy' as const, role: 'deploy', input };
    const reviewedResult = await invokeHostReviewedChildV1({
      parent: { actionId: 'machines.setup.apply', input: { homeId: 'home', machineId: 'machine' } },
      context: { ...context, approvalProfileId: 'builtin:read-propose' }, child,
      admittedReview: { ...child, surface: 'agent' },
      execute: (operand, childContext, actionId) => executor.execute(actionId, operand, childContext),
    });
    expect(reviewedResult, JSON.stringify(reviewedResult)).toMatchObject({ ok: true, result: receipt });
    expect(effects).toBe(2);
    expect(reads).toBe(3);
  });

  it('keeps profile changes separate from the broad Run control waiver', () => {
    const spec = getActionSpec('execution.run.action');
    const request = { runId: 'run', actionId: 'approval_profile.set', input: { approvalProfileId: null } };
    expect(resolveActionApprovalRouting({ actionId: 'execution.run.action', spec, input: request,
      context: { surface: 'agent' } }).required).toBe(true);
    expect(resolveActionApprovalRouting({ actionId: 'execution.run.action', spec, input: request,
      context: { surface: 'agent' }, settings: normalizeActionsSettingsV1({ v: 1,
        approvalWaivedSurfaces: { 'execution.run.action': ['agent'] } }) }).required).toBe(true);
    expect(resolveActionApprovalRouting({ actionId: 'execution.run.action', spec, input: request,
      context: { surface: 'agent' }, settings: normalizeActionsSettingsV1({ v: 1,
        approvalWaivedSurfaces: { 'session.approval_profile.set': ['agent'] } }) }).required).toBe(false);
    expect(resolveActionApprovalRouting({ actionId: 'execution.run.action', spec,
      input: { runId: 'run', actionId: 'stop' }, context: { surface: 'agent' },
      settings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { 'execution.run.action': ['agent'] } }) }).required).toBe(false);
  });

  it('uses the same waivable profile authority default for MCP Session controls', () => {
    const actionId = 'session.approval_profile.set';
    const spec = getActionSpec(actionId);
    expect(resolveActionApprovalRouting({ actionId, spec, context: { surface: 'mcp' } }).required).toBe(true);
    expect(resolveActionApprovalRouting({ actionId, spec, context: { surface: 'mcp' },
      settings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [actionId]: ['mcp'] } }) }).required).toBe(false);
  });

  it.each([
    { actionId: 'session.spawn_new', input: { approvalProfileId: null } },
    { actionId: 'session.spawn_new', input: { initialTriggers: [{ approvalProfileId: null }] } },
    { actionId: 'execution.run.action', input: { runId: 'run', actionId: 'approval_profile.set', input: { approvalProfileId: null } } },
    { actionId: 'workflow.trigger.update', input: { patch: { approvalProfileId: null } } },
    { actionId: 'session.approval_profile.set', input: { approvalProfileId: null } },
    { actionId: 'session.title.set', input: {}, approvalProfileChange: true },
  ] as const)('uses one native confirmation for a saved UI profile-control Ask through $actionId / $input', ({ actionId, input, ...facts }) => {
    const settings = normalizeActionsSettingsV1({ v: 1, actions: {
      'session.approval_profile.set': { approvalRequiredSurfaces: ['ui'] },
    }, approvalWaivedSurfaces: actionId === 'session.approval_profile.set' ? {} : { [actionId]: ['ui'] } });
    const context = { surface: 'ui' as const, authority: 'present_user' as const,
      actionCaller: { kind: 'host' as const }, approvalProfileId: 'builtin:apply-safe', ...facts };
    const args = { actionId, spec: getActionSpec(actionId), input, settings, context };
    expect(resolveActionApprovalRouting(args)).toMatchObject({ required: false, uiConfirmationRequired: true });
    const confirmed = resolveActionApprovalRouting({ ...args, context: { ...context, presentUserConfirmation: { actionId } } });
    expect(confirmed.required).toBe(false);
    expect(confirmed.uiConfirmationRequired).toBeUndefined();
  });

  it('asks for an agent or MCP child profile override, including detach, through the profile-control preference', () => {
    const starts = ['session.spawn_new', 'session.fork', 'session.continue_with_replay', 'execution.run.start', 'execution.run.ensure_or_start',
      'subagents.plan.start', 'subagents.delegate.start', 'voice_agent.start', 'review.start'] as const;
    for (const actionId of starts) {
      const spec = getActionSpec(actionId);
      for (const surface of ['agent', 'mcp'] as const) {
        const policy = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [actionId]: [surface] } });
        const route = (input: unknown, currentSettings = policy) => resolveActionApprovalRouting({ actionId, spec, input,
          settings: currentSettings, context: { surface, approvalProfileId: 'builtin:apply-safe' } });
        expect(route({}).required, `${actionId}:${surface}:inherit`).toBe(false);
        expect(route({ approvalProfileId: 'builtin:apply-safe' }).required, `${actionId}:${surface}:same`).toBe(false);
        for (const approvalProfileId of [null, 'builtin:full-trust']) {
          expect(route({ approvalProfileId }).required, `${actionId}:${surface}:${approvalProfileId}`).toBe(true);
          expect(route({ approvalProfileId }, normalizeActionsSettingsV1({ ...policy,
            approvalWaivedSurfaces: { ...policy.approvalWaivedSurfaces, 'session.approval_profile.set': [surface] },
          })).required).toBe(false);
        }
      }
      for (const surface of ['ui', 'cli'] as const) {
        expect(resolveActionApprovalRouting({ actionId, spec, input: { approvalProfileId: null },
          settings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [actionId]: [surface] } }),
          context: { surface, approvalProfileId: 'builtin:apply-safe' } }).required).toBe(false);
      }
    }
  });

  it('uses profile authority for trigger references, including initial Session triggers', () => {
    const context = { surface: 'agent' as const, approvalProfileId: 'builtin:apply-safe' };
    for (const actionId of ['workflow.trigger.add', 'workflow.trigger.update'] as const) {
      const spec = getActionSpec(actionId);
      const input = actionId === 'workflow.trigger.update'
        ? { patch: { approvalProfileId: null } } : { approvalProfileId: null };
      expect(resolveActionApprovalRouting({ actionId, spec, input, context,
        settings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [actionId]: ['agent'] } }) }).required).toBe(true);
    }
    const actionId = 'session.spawn_new';
    expect(resolveActionApprovalRouting({ actionId, spec: getActionSpec(actionId),
      input: { initialTriggers: [{ approvalProfileId: null }] }, context,
      settings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [actionId]: ['agent'] } }) }).required).toBe(true);
  });

  it('does not let allow waive an egress, authority or person-class default', () => {
    for (const actionId of [...EGRESS_SENSITIVE_AGENT_FLOOR, ...SURFACE_AUTHORITY_AGENT_FLOOR, 'settings.set'] as const) {
      const spec = getActionSpec(actionId);
      const normal = resolveActionApprovalRouting({ actionId, spec, context: { surface: 'agent' } });
      const full = resolveActionApprovalRouting({ actionId, spec, settings,
        context: { surface: 'agent', approvalProfileId: 'builtin:full-trust' } });
      expect(full.required, actionId).toBe(normal.required);
    }
  });

  it.each(['agent', 'mcp'] as const)('consumes an exact admitted profile review once on %s', surface => {
    const actionId = 'session.title.set';
    const spec = getActionSpec(actionId);
    const args = { actionId, spec, settings,
      context: { surface, authority: 'account_automation' as const, approvalProfileId: 'builtin:read-propose' } } as const;
    expect(resolveActionApprovalRouting(args).required).toBe(true);
    expect(resolveActionApprovalRouting({ ...args, reviewAdmitted: true }).required).toBe(false);
  });

  it('preserves the Account profile collection through normalization', () => {
    expect(normalizeActionsSettingsV1(settings).approvalProfiles).toEqual(settings.approvalProfiles);
    expect(settings.approvalProfiles).toHaveLength(1);
  });

  it('creates, edits and deletes profiles through the existing policy Action and Account mutation owner', () => {
    expect(ActionPolicyInputSchemas['actions.policy.get'].parse({ profiles: true })).toEqual({ profiles: true });
    expect(ActionPolicyOutputSchemas['actions.policy.get'].parse({ profiles: listApprovalProfilesV1(settings) }))
      .toMatchObject({ profiles: expect.arrayContaining(settings.approvalProfiles ?? []) });
    const request = ActionPolicyInputSchemas['actions.policy.set'].parse({ profileChange: { kind: 'upsert',
      profile: { id: 'custom', name: 'Reviewed changes', defaultMode: 'require' } } });
    const changed = applyActionPolicyMutation(settings, request);
    expect(ActionPolicyOutputSchemas['actions.policy.set'].parse(changed.result)).toEqual(request);
    expect(accountSettingsParse({ actionsSettingsV1: changed.settings }).actionsSettingsV1.approvalProfiles)
      .toEqual([{ id: 'custom', name: 'Reviewed changes', defaultMode: 'require' }]);
    const stale = applyAccountSettingMutationV1({ actionsSettingsV1: changed.settings }, { operations: [
      { op: 'set', key: 'actionsSettingsV1', value: { v: 1, actions: {} } },
    ] });
    expect(stale.status).toBe('applied');
    if (stale.status === 'applied') expect(accountSettingsParse(stale.raw).actionsSettingsV1.approvalProfiles)
      .toEqual(changed.settings.approvalProfiles);
    const removed = applyActionPolicyMutation(changed.settings, ActionPolicyInputSchemas['actions.policy.set'].parse({
      profileChange: { kind: 'delete', id: 'custom' },
    }));
    expect(removed.settings.approvalProfiles).toEqual([]);
    expect(deploy('custom', removed.settings).profile?.status).toBe('missing');
  });
});
