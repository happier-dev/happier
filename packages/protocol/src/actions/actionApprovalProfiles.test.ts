import { describe, expect, it } from 'vitest';
import { normalizeActionsSettingsV1 } from './actionSettings.js';
import { resolveActionApprovalRouting, EGRESS_SENSITIVE_AGENT_FLOOR, SURFACE_AUTHORITY_AGENT_FLOOR } from './actionApprovalPolicy.js';
import { getActionSpec } from './actionSpecs.js';
import { ActionPolicyInputSchemas, ActionPolicyOutputSchemas } from './actionPolicyActionFamily.js';
import { applyActionPolicyMutation } from './actionAudiencePolicy.js';
import { accountSettingsParse } from '../account/settings/accountSettings.js';
import { applyAccountSettingMutationV1 } from '../account/settings/accountSettingMutationV1.js';
import { ApprovalProfileV1Schema } from './approvalProfiles.js';
import { bindApprovalProfileV1 } from './approvalProfileArtifactV1.js';
import { createActionExecutor, invokeHostReviewedChildV1 } from './actionExecutor.js';
import { DeploymentReceiptAcceptedResultV1Schema } from '../deployments/deploymentReceiptResultV1.js';
import { prepareHostReviewedChildPolicyV1 } from './executor/deploymentRoleApproval.js';
import { formatQualifiedPluginActionId } from '../plugins/actions/qualifiedActionId.js';

describe('Account approval profiles at Action admission', () => {
  const settings = normalizeActionsSettingsV1({ v: 1, actions: {},
    approvalWaivedSurfaces: { 'deployments.deploy': ['agent'] },
  });
  const profiles = [
      { id: 'reviewed-deploys', name: 'Only reviewed deploys', actions: { 'deployments.deploy': { approvalRequiredSurfaces: ['agent'] } } },
      { id: 'blank', name: 'Blank' },
      { id: 'off', name: 'Off', actions: { 'deployments.deploy': { enabled: false } } },
      { id: 'allow', name: 'Allow', actions: { 'deployments.deploy': { enabled: true } },
        approvalWaivedSurfaces: { 'deployments.deploy': ['agent'] } },
  ].map(profile => ({ id: profile.id, profile: ApprovalProfileV1Schema.parse(profile), access: 'owner' as const,
    revision: { headerVersion: 1, bodyVersion: 1 } }));
  const deploy = (approvalProfileId: string, policy = settings, catalog = profiles) => resolveActionApprovalRouting({
    actionId: 'deployments.deploy', spec: getActionSpec('deployments.deploy'),
    input: { environmentId: 'env' }, settings: policy,
    context: { surface: 'agent', authority: 'account_automation', approvalProfileId,
      approvalProfile: bindApprovalProfileV1(catalog, approvalProfileId) },
  });

  it('decides with the profile row in place of the Account row, and a blank profile equals Account settings', () => {
    expect(deploy('reviewed-deploys').required).toBe(true);
    expect(deploy('blank')).toMatchObject({ required: false, profile: { status: 'available', requestedId: 'blank' } });
    expect(resolveActionApprovalRouting({ actionId: 'deployments.deploy', spec: getActionSpec('deployments.deploy'),
      input: { environmentId: 'env' }, settings, context: { surface: 'agent', authority: 'account_automation' } }).required).toBe(false);
  });

  it('applies a bound profile Ask when the host has no Account settings override', () => {
    const profile = ApprovalProfileV1Schema.parse({ id: 'reviewed-list', name: 'Review listings',
      actions: { 'machines.list': { approvalRequiredSurfaces: ['agent'] } } });
    const decision = resolveActionApprovalRouting({ actionId: 'machines.list', spec: getActionSpec('machines.list'),
      input: {}, context: { surface: 'agent', authority: 'account_automation', approvalProfileId: profile.id,
        approvalProfile: bindApprovalProfileV1([{ id: profile.id, profile, access: 'owner',
          revision: { headerVersion: 1, bodyVersion: 1 } }], profile.id) } });
    expect(decision).toMatchObject({ required: true, profile: { status: 'available', requestedId: profile.id } });
  });

  it('lets a profile Allowed waive Ask where the Account screen could, so a permissive profile is never a no-op', () => {
    const strict = normalizeActionsSettingsV1({ v: 1, actions: { 'deployments.deploy': { approvalRequiredSurfaces: ['agent'] } } });
    expect(deploy('blank', strict).required).toBe(true);
    expect(deploy('trusted', strict, [{ ...profiles[0]!, id: 'trusted', profile: ApprovalProfileV1Schema.parse({
      id: 'trusted', name: 'Trusted deploys', approvalWaivedSurfaces: { 'deployments.deploy': ['agent'] } }) }]).required).toBe(false);
  });

  it('settles a deleted or legacy built-in reference at Account settings with a visible missing status', () => {
    for (const id of ['deleted', 'builtin:read-propose']) {
      expect(deploy(id)).toMatchObject({ required: false, profile: { status: 'missing', requestedId: id } });
    }
  });

  it.each([
    { profileId: 'off', accountOff: false, derived: false, allowed: false },
    { profileId: 'allow', accountOff: true, derived: false, allowed: true },
    { profileId: 'allow', accountOff: true, derived: true, allowed: false },
  ])('applies selected $profileId before builtin availability (Account Off=$accountOff, derived=$derived)', async ({ profileId, accountOff, derived, allowed }) => {
    let effects = 0;
    const input = { serverId: 'home', environmentId: 'environment', expectedRevision: 3, requestKey: 'deploy-request',
      targetLinkId: 'link', expectedTargetLinkRevision: 4, contentArtifactId: 'definition', contentHeaderVersion: 1, contentBodyVersion: 1 };
    const executor = createActionExecutor({
      readActionApprovalProfileId: async () => ({ approvalProfileId: profileId, approvalProfileTeamOrGroupDerived: derived }),
      readApprovalProfile: id => bindApprovalProfileV1(profiles, id),
      resolveEnvironmentApprovalScope: async () => ({ scope: { kind: 'environment', environmentId: 'environment' } }),
      prepareDeploymentAction: async () => ({ input, preview: { sourceMethod: 'gitIntegration' } }),
      deploymentAction: async () => { effects++; return DeploymentReceiptAcceptedResultV1Schema.parse({ ok: true,
        environmentId: 'environment', revision: 4, kind: 'pending', actionOperationId: 'operation' }); },
    });
    const result = await executor.execute('deployments.deploy', input, { surface: 'agent', authority: 'account_automation',
      serverId: 'home', interactivePresentation: 'unavailable', actionsSettings: accountOff ? normalizeActionsSettingsV1({ ...settings,
        actions: { 'deployments.deploy': { enabled: false } } }) : settings });
    expect(result).toMatchObject(allowed ? { ok: true } : { ok: false, errorCode: 'action_disabled' });
    expect(effects).toBe(allowed ? 1 : 0);
  });

  it('binds the calling Session profile once through composed deploy admission', async () => {
    let sessionProfile = 'reviewed-deploys';
    let reads = 0;
    let effects = 0;
    const input = { serverId: 'home', environmentId: 'environment', expectedRevision: 3, requestKey: 'deploy-request',
      targetLinkId: 'link', expectedTargetLinkRevision: 4, contentArtifactId: 'definition', contentHeaderVersion: 1, contentBodyVersion: 1 };
    const receipt = DeploymentReceiptAcceptedResultV1Schema.parse({ ok: true, environmentId: 'environment',
      revision: 4, kind: 'pending', actionOperationId: 'operation' });
    const executor = createActionExecutor({
      // The Session metadata store and deployment provider are process boundaries.
      readActionApprovalProfileId: async () => { reads++; return { approvalProfileId: sessionProfile, approvalProfileTeamOrGroupDerived: false }; },
      readApprovalProfile: id => bindApprovalProfileV1(profiles, id),
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
    sessionProfile = 'blank';
    expect(await executor.execute('deployments.deploy', input, context)).toMatchObject({ ok: true, result: receipt });
    expect(effects).toBe(1);
    expect(reads).toBe(2);
    // A deleted profile loosens to the Account waiver at the next Action (accepted, visible glitch).
    sessionProfile = 'deleted';
    expect(await executor.execute('deployments.deploy', input, context)).toMatchObject({ ok: true, result: receipt });
    expect(effects).toBe(2);
    expect(reads).toBe(3);
    // An exact reviewed child retains the issuer's decision through native
    // preparation/dispatch, including the live Environment-scoped path.
    const child = { action: 'deployments.deploy' as const, role: 'deploy', input };
    const reviewedResult = await invokeHostReviewedChildV1({
      parent: { actionId: 'machines.setup.apply', input: { homeId: 'home', machineId: 'machine' } },
      context: { ...context, approvalProfileId: 'reviewed-deploys' }, child,
      admittedReview: { ...child, surface: 'agent' },
      execute: (operand, childContext, actionId) => executor.execute(actionId, operand, childContext),
    });
    expect(reviewedResult, JSON.stringify(reviewedResult)).toMatchObject({ ok: true, result: receipt });
    expect(effects).toBe(3);
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
      actionCaller: { kind: 'host' as const }, approvalProfileId: 'careful', ...facts };
    const args = { actionId, spec: getActionSpec(actionId), input, settings, context };
    expect(resolveActionApprovalRouting(args)).toMatchObject({ required: false, uiConfirmationRequired: true });
    // A caller-authored marker cannot answer saved Ask; the executor admits exact consent.
    expect(resolveActionApprovalRouting({ ...args, context: { ...context, presentUserConfirmation: { actionId } } }))
      .toMatchObject({ required: false, uiConfirmationRequired: true });
    const confirmed = resolveActionApprovalRouting({ ...args, reviewAdmitted: true });
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
          settings: currentSettings, context: { surface, approvalProfileId: 'careful' } });
        expect(route({}).required, `${actionId}:${surface}:inherit`).toBe(false);
        expect(route({ approvalProfileId: 'careful' }).required, `${actionId}:${surface}:same`).toBe(false);
        for (const approvalProfileId of [null, 'other']) {
          expect(route({ approvalProfileId }).required, `${actionId}:${surface}:${approvalProfileId}`).toBe(true);
          expect(route({ approvalProfileId }, normalizeActionsSettingsV1({ ...policy,
            approvalWaivedSurfaces: { ...policy.approvalWaivedSurfaces, 'session.approval_profile.set': [surface] },
          })).required).toBe(false);
        }
      }
      for (const surface of ['ui', 'cli'] as const) {
        expect(resolveActionApprovalRouting({ actionId, spec, input: { approvalProfileId: null },
          settings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [actionId]: [surface] } }),
          context: { surface, approvalProfileId: 'careful' } }).required).toBe(false);
      }
    }
  });

  it('uses profile authority for trigger references, including initial Session triggers', () => {
    const context = { surface: 'agent' as const, approvalProfileId: 'careful' };
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

  it('gives a profile waiver exactly the reach of the same Account waiver, floors included', () => {
    for (const actionId of [...EGRESS_SENSITIVE_AGENT_FLOOR, ...SURFACE_AUTHORITY_AGENT_FLOOR, 'settings.set'] as const) {
      const spec = getActionSpec(actionId);
      const viaAccount = resolveActionApprovalRouting({ actionId, spec, context: { surface: 'agent' },
        settings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [actionId]: ['agent'] } }) });
      const viaProfile = resolveActionApprovalRouting({ actionId, spec, context: { surface: 'agent', approvalProfileId: 'p',
        approvalProfile: { profile: ApprovalProfileV1Schema.parse({ id: 'p', name: 'P', approvalWaivedSurfaces: { [actionId]: ['agent'] } }),
          resolution: { status: 'available', requestedId: 'p' } } }, settings: normalizeActionsSettingsV1({ v: 1 }) });
      expect(viaProfile.required, actionId).toBe(viaAccount.required);
    }
  });

  it('applies the profile to a contributed child prepared under an admitted parent review', () => {
    const child = { action: { pluginId: 'acme.deploy', localId: 'publish' }, role: 'publish', input: {} };
    const qualified = formatQualifiedPluginActionId(child.action);
    const context = { surface: 'agent' as const, authority: 'account_automation' as const, bypassApprovals: true,
      actionsSettings: normalizeActionsSettingsV1({ v: 1 }) };
    expect(prepareHostReviewedChildPolicyV1(child, context)?.requiredActionIds).toEqual([]);
    expect(prepareHostReviewedChildPolicyV1(child, { ...context, approvalProfileId: 'careful',
      approvalProfile: { profile: ApprovalProfileV1Schema.parse({ id: 'careful', name: 'Careful agent',
        actions: { [qualified]: { approvalRequiredSurfaces: ['agent'] } } }),
      resolution: { status: 'available', requestedId: 'careful' } } })?.requiredActionIds)
      .toContain(qualified);
  });

  it('asks before an agent edits a profile or a Machine default, even with the policy Action waived', () => {
    const actionId = 'actions.policy.set';
    const spec = getActionSpec(actionId);
    const waived = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [actionId]: ['agent'] } });
    const route = (input: unknown, policy = waived, profile = ApprovalProfileV1Schema.parse({ id: 'blank', name: 'Blank' })) => resolveActionApprovalRouting({ actionId, spec, input, settings: policy,
      context: { surface: 'agent', authority: 'account_automation', approvalProfileId: 'blank',
        approvalProfile: bindApprovalProfileV1([{ id: profile.id, profile, access: 'owner',
          revision: { headerVersion: 1, bodyVersion: 1 } }], profile.id) } });
    expect(route({ profileChange: { kind: 'create', profile: { name: 'Blank',
      approvalWaivedSurfaces: { 'deployments.deploy': ['agent'] } } } }).required).toBe(true);
    expect(route({ profileChange: { kind: 'machine_default', machineId: 'm', id: null } }).required).toBe(true);
    expect(route({ profileChange: { kind: 'delete', id: 'blank' } }).required).toBe(true);
    // Only an Account waiver of profile control answers it; the profile cannot waive its own control.
    expect(route({ profileChange: { kind: 'delete', id: 'blank' } }, normalizeActionsSettingsV1({ ...waived,
      approvalWaivedSurfaces: { ...waived.approvalWaivedSurfaces, 'session.approval_profile.set': ['agent'] } })).required).toBe(false);
    expect(route({ profileChange: { kind: 'delete', id: 'blank' } }, waived,
      ApprovalProfileV1Schema.parse({ id: 'blank', name: 'Blank', approvalWaivedSurfaces: {
        'session.approval_profile.set': ['agent'] } })).required).toBe(true);
  });

  it.each(['agent', 'mcp'] as const)('consumes an exact admitted profile review once on %s', surface => {
    const actionId = 'session.title.set';
    const spec = getActionSpec(actionId);
    const args = { actionId, spec, settings: normalizeActionsSettingsV1({ v: 1 }),
      context: { surface, authority: 'account_automation' as const, approvalProfileId: 'careful',
        approvalProfile: { profile: ApprovalProfileV1Schema.parse({ id: 'careful', name: 'Careful agent',
          actions: { [actionId]: { approvalRequiredSurfaces: [surface] } } }),
        resolution: { status: 'available' as const, requestedId: 'careful' } } } };
    expect(resolveActionApprovalRouting(args).required).toBe(true);
    expect(resolveActionApprovalRouting({ ...args, reviewAdmitted: true }).required).toBe(false);
  });

  it('keeps Machine defaults in the Account mutation owner and clears references after profile deletion', () => {
    expect(ActionPolicyInputSchemas['actions.policy.get'].parse({ profiles: true })).toEqual({ profiles: true });
    expect(ActionPolicyOutputSchemas['actions.policy.get'].parse({ profiles })).toEqual({ profiles });
    const attached = applyActionPolicyMutation(settings, ActionPolicyInputSchemas['actions.policy.set'].parse({
      profileChange: { kind: 'machine_default', machineId: 'machine-a', id: 'custom' } }));
    expect(accountSettingsParse({ actionsSettingsV1: attached.settings }).actionsSettingsV1.machineApprovalProfiles)
      .toEqual({ 'machine-a': 'custom' });
    // An older writer that omits the Machine default root retains the deliberate preference.
    const stale = applyAccountSettingMutationV1({ actionsSettingsV1: attached.settings }, { operations: [
      { op: 'set', key: 'actionsSettingsV1', value: { v: 1, actions: {}, approvalWaivedSurfaces: { 'session.list': ['agent'] } } },
    ] });
    expect(stale.status).toBe('applied');
    if (stale.status === 'applied') expect(accountSettingsParse(stale.raw).actionsSettingsV1).toMatchObject({
      machineApprovalProfiles: { 'machine-a': 'custom' } });
    const removed = applyActionPolicyMutation(attached.settings, ActionPolicyInputSchemas['actions.policy.set'].parse({
      profileChange: { kind: 'delete', id: 'custom', expectedRevision: { headerVersion: 1, bodyVersion: 1 } },
    }));
    expect(removed.settings.machineApprovalProfiles).toEqual({});
    expect(deploy('custom', removed.settings).profile?.status).toBe('missing');
  });
});
