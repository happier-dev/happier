import { describe, expect, it } from 'vitest';
import { accountSettingsParse, admitAgentStartV1, buildBackendTargetKeyV2, BUILT_IN_ROLES_V1, ConnectedServiceBindingsV2Schema, createRoleSourceReaderV1, resolveRolesSnapshotV1, snapshotSessionRolesAtSpawnV1 } from '@happier-dev/protocol';
import { resolveCliAgentStartContextV1 } from './resolveCliAgentStartContextV1';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';

const backendTarget = { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } as const;
const input = {
  sessionId: 'lead', machineId: 'machine', directory: '/repo', backendTarget,
  metadata: {}, starterDepth: 3, turnDepth: 0, callerPermissionMode: 'read-only', settings: accountSettingsParse({}),
  appliedChildSelection: { status: 'applied', backendTarget, modelId: null, connectedServices: null },
  accountRoleOverrides: { status: 'ready', overrides: {} },
  roleSourceInventory: await createRoleSourceReaderV1({})(),
} as const;

function requireContext(value: Parameters<typeof resolveCliAgentStartContextV1>[0]) {
  const context = resolveCliAgentStartContextV1(value);
  if (!context || 'ok' in context) throw new Error('Expected available host context');
  return context;
}

describe('host agent-start snapshots', () => {
  it('preserves applied native authentication in the Session baseline instead of reopening Account defaults', () => {
    const context = requireContext({ ...input, metadata: { connectedServices: {
      v: 2, bindingsByServiceId: { 'example.accounts/service': { source: 'connected', profileId: 'pending' } },
    } }, appliedChildSelection: { status: 'applied', backendTarget, modelId: 'native-model',
      modelSelection: { agentTargetKey: buildBackendTargetKeyV2(backendTarget), providerConnectionId: null, modelId: 'native-model' },
      connectedServices: null } });
    expect(context?.baseline.configuration?.connectedServices).toBeNull();
  });

  it('leaves applied Team custody to host child admission instead of projecting a native role route', () => {
    const context = requireContext({ ...input, appliedChildSelection: {
      status: 'applied', backendTarget, modelId: 'team-model', connectedServices: null,
      teamCredentialModel: { kind: 'team_credential_provider_model', resourceId: 'resource', teamId: 'team',
        expectedResourceRevision: 2, agentTargetKey: buildBackendTargetKeyV2(backendTarget), modelId: 'team-model', deliveryMode: 'brokered' },
    } });
    expect(context?.baseline.configuration?.modelSelection).toBeUndefined();
    expect(context?.baseline.configuration?.connectedServices).toBeUndefined();
    expect(context?.roles.reviewer.engine).not.toHaveProperty('modelId');
  });
  it('builds live role defaults from the applied child selection rather than pending parent intent', () => {
    const agentTargetKey = buildBackendTargetKeyV2(backendTarget);
    const applied = { agentTargetKey, providerConnectionId: ProviderConnectionIdSchema.parse('applied-provider'), modelId: 'applied-model' };
    const pending = { agentTargetKey, providerConnectionId: 'pending-provider', modelId: 'pending-model' };
    const context = requireContext({ ...input,
      metadata: { modelSelectionIntentV1: { v: 1, selection: pending, updatedAt: 10 },
        connectedServices: { v: 2, bindingsByServiceId: { 'example.accounts/service': { source: 'connected', profileId: 'pending' } } } },
      appliedChildSelection: { status: 'applied', backendTarget, modelId: applied.modelId, modelSelection: applied, connectedServices: null },
    });
    expect(context?.baseline.configuration?.modelSelection).toEqual(applied);
    expect(context?.roles.reviewer.engine).toMatchObject({ modelId: 'applied-model' });
    expect(context?.baseline.configuration?.connectedServices).toBeNull();
    const binding = ConnectedServiceBindingsV2Schema.parse({ v: 2,
      bindingsByServiceId: { 'example.accounts/service': { source: 'connected', profileId: 'applied' } } });
    const connected = requireContext({ ...input,
      appliedChildSelection: { status: 'applied', backendTarget, modelId: applied.modelId, modelSelection: applied, connectedServices: binding } });
    expect(connected?.baseline.configuration?.connectedServices).toEqual(binding);
  });

  it.each([undefined, { status: 'unavailable' } as const])('does not project pending route without a live applied selection (%j)', appliedChildSelection => {
    const context = resolveCliAgentStartContextV1({ ...input,
      metadata: { modelSelectionIntentV1: { v: 1, selection: {
        agentTargetKey: buildBackendTargetKeyV2(backendTarget), providerConnectionId: 'pending-provider', modelId: 'pending-model',
      }, updatedAt: 10 } }, appliedChildSelection,
    });
    expect(context).toMatchObject({ ok: false, details: { reason: 'caller_agent_unavailable' } });
  });
  it('inherits fully frozen Roles without fabricating a live baseline and refuses a newly unfrozen source', () => {
    const roles = resolveRolesSnapshotV1({ defaultEngine: { agentTargetKey: buildBackendTargetKeyV2(backendTarget), modelId: 'frozen-model' } });
    const contextInput = { ...input, appliedChildSelection: undefined,
      availableAgentTargetKeys: [buildBackendTargetKeyV2(backendTarget)], metadata: {
      modelSelectionIntentV1: { v: 1, selection: { agentTargetKey: buildBackendTargetKeyV2(backendTarget),
        providerConnectionId: null, modelId: 'pending-model' }, updatedAt: 10 },
      work: { sessionRolesV1: snapshotSessionRolesAtSpawnV1({ leadSessionId: 'prior-lead', roles, notes: 'Frozen notes' }) },
    } };
    const context = requireContext(contextInput);
    expect(context?.roles.reviewer.engine?.modelId).toBe('frozen-model');
    expect(context?.baseline).toEqual({ machineId: 'machine', directory: '/repo' });
    expect(resolveCliAgentStartContextV1({ ...contextInput, roleSourceInventory: {
      status: 'ready', diagnostics: [], entries: [...input.roleSourceInventory.entries,
        { roleId: 'plugin:external.roles/new-role', role: BUILT_IN_ROLES_V1.builder,
          shared: false, viewOnly: false, migratedFromV0_2: false }],
    } })).toMatchObject({ ok: false, details: { reason: 'caller_agent_unavailable' } });
  });
  it('uses the explicit Workflow child engine only for unfrozen Roles without certifying origin intent', () => {
    const childEngine = { agentTargetKey: buildBackendTargetKeyV2({ kind: 'backend', backendId: 'claude' }), modelId: 'child-model' };
    const frozen = { ...BUILT_IN_ROLES_V1.builder, roleId: 'builder',
      engine: { agentTargetKey: buildBackendTargetKeyV2(backendTarget), modelId: 'frozen-model' } };
    const origin = { ...input, appliedChildSelection: undefined,
      roleSourceInventory: { status: 'ready' as const, diagnostics: [], entries: [...input.roleSourceInventory.entries,
        { roleId: 'plugin:external.roles/unfrozen', role: BUILT_IN_ROLES_V1.reviewer,
          shared: false, viewOnly: false, migratedFromV0_2: false }] }, metadata: {
      modelSelectionIntentV1: { v: 1, selection: { agentTargetKey: buildBackendTargetKeyV2(backendTarget),
        providerConnectionId: null, modelId: 'origin-pending-model' }, updatedAt: 2 },
      work: { sessionRolesV1: { overrides: {}, sessionRoles: { builder: frozen }, notes: '' } },
    } };
    const context = requireContext({ ...origin, workflowStepRoleDefaultEngine: childEngine });
    expect(context?.roles.builder.engine).toEqual(frozen.engine);
    expect(context?.roles.reviewer.engine).toEqual(childEngine);
    expect(context?.roles['plugin:external.roles/unfrozen'].engine).toEqual(childEngine);
    expect(context?.baseline).toEqual({ machineId: 'machine', directory: '/repo' });
    expect(resolveCliAgentStartContextV1(origin)).toMatchObject({ ok: false, details: { reason: 'caller_agent_unavailable' } });
  });
  it('preserves a complete frozen snapshot without borrowing current Account authority', () => {
    const frozen = { ...BUILT_IN_ROLES_V1.builder, roleId: 'builder', workspaceWrites: 'deny' as const,
      engine: { agentTargetKey: buildBackendTargetKeyV2(backendTarget) } };
    const context = requireContext({ ...input,
      roles: { builder: frozen }, accountRoleOverrides: { status: 'unavailable', reason: 'scope-retired' },
      roleSourceInventory: { status: 'partial', entries: [], diagnostics: [{ source: 'legacy-guidance', reason: 'unavailable' }] },
    });
    expect(context?.roles).toEqual({ builder: frozen });
  });

  it('uses destination Role deny and refuses an unavailable Account authority', () => {
    const context = requireContext({ ...input, accountRoleOverrides: { status: 'ready', overrides: {
      builder: { roleId: 'builder', workspaceWrites: 'deny' },
    } } });
    expect(context?.roles.builder.workspaceWrites).toBe('deny');
    expect(resolveCliAgentStartContextV1({ ...input, accountRoleOverrides: {
      status: 'unavailable', reason: 'catalog-loading',
    } })).toMatchObject({ ok: false, details: { reason: 'role_overrides_unavailable' } });
  });
  it('distinguishes an incomplete Role source from absent caller identity without exposing content', () => {
    const reasons: unknown[] = [];
    const recordActionStartDiagnostic = (event: unknown) => reasons.push(event);
    expect(resolveCliAgentStartContextV1({ ...input, recordActionStartDiagnostic,
      roleSourceInventory: { status: 'partial', entries: input.roleSourceInventory.entries,
        diagnostics: [{ source: 'artifact', artifactId: 'unavailable-role', reason: 'unavailable' }] },
    })).toEqual({ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable',
      details: { code: 'target_unavailable', reason: 'role_source_incomplete' } });
    expect(reasons).toEqual([{ phase: 'agent_start_context', refusalReason: 'role_source_incomplete' }]);
    reasons.length = 0;
    expect(resolveCliAgentStartContextV1({ ...input, recordActionStartDiagnostic, backendTarget: null }))
      .toEqual({ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable',
        details: { code: 'target_unavailable', reason: 'caller_agent_unavailable' } });
    expect(reasons).toEqual([{ phase: 'agent_start_context', refusalReason: 'caller_agent_unavailable' }]);
  });
  it('reads allow-lists from their separate Account setting on each fresh host snapshot', () => {
    const settings = accountSettingsParse({ sessionAgentStartAllowListsV1: { allowedAgentTargetKeys: [] } });
    const context = requireContext({ ...input, settings });
    if (!context) throw new Error('host snapshot unavailable');
    expect(admitAgentStartV1(settings.sessionAgentSpawnPolicyV1, {
      kind: 'spawn_new', facts: {},
    }, context)).toMatchObject({ ok: false, refusal: { code: 'policy_denied_field', field: 'agentTarget' } });
  });
  it('resolves newly read user/plugin source fields and current overrides instead of a stale dispatch projection', () => {
    const context = requireContext({ ...input,
      roleSourceInventory: { status: 'ready', diagnostics: [], entries: [...input.roleSourceInventory.entries,
        { roleId: 'user-role', role: { ...BUILT_IN_ROLES_V1.builder, instructions: 'Current Artifact instructions' },
          shared: false, viewOnly: false, migratedFromV0_2: false }] },
      metadata: { work: { sessionRolesV1: { overrides: { 'user-role': { roleId: 'user-role', workspaceWrites: 'deny' } }, sessionRoles: {}, notes: '' } } },
    });
    expect(context?.roles['user-role']).toMatchObject({ instructions: 'Current Artifact instructions', workspaceWrites: 'deny',
      engine: { agentTargetKey: buildBackendTargetKeyV2(backendTarget) } });
  });
  it('uses background Run depth over the hosting Session and refuses the next start at the limit', () => {
    const context = requireContext({ ...input, starterDepth: 0,
      runCaller: { hostSessionId: 'lead', callingRunId: 'background-run', callingRunDepth: 4 },
    });
    expect(context?.caller).toEqual({ kind: 'session', sessionId: 'lead', starterDepth: 4, turnDepth: 0 });
    if (!context) throw new Error('run caller unavailable');
    expect(admitAgentStartV1(input.settings.sessionAgentSpawnPolicyV1, {
      kind: 'spawn_new', facts: {},
    }, context)).toMatchObject({ ok: false, refusal: { code: 'work_depth_exceeded' } });
  });

  it('keeps a detached Workflow step originless at its host-stamped step depth', () => {
    const context = requireContext({ ...input, starterDepth: undefined,
      runCaller: { runId: 'workflow-run', runDepth: 3 },
    });
    expect(context?.caller).toEqual({ kind: 'originless', runId: 'workflow-run', runDepth: 3 });
    expect(context?.baseline).toEqual({ machineId: 'machine', directory: '/repo' });
    if (!context) throw new Error('workflow caller unavailable');
    expect(admitAgentStartV1(input.settings.sessionAgentSpawnPolicyV1, {
      kind: 'execution_run', source: 'execution_run', intent: 'review', facts: {}, backendTargets: [backendTarget],
    }, context)).toMatchObject({ ok: true, stamped: { workDepth: 4 } });
  });

  it('cannot borrow a different host Session or reset malformed Run depth', () => {
    expect(resolveCliAgentStartContextV1({ ...input,
      runCaller: { hostSessionId: 'other', callingRunId: 'run', callingRunDepth: 1 },
    })).toMatchObject({ ok: false, details: { reason: 'caller_run_unavailable' } });
    expect(resolveCliAgentStartContextV1({ ...input,
      runCaller: { runId: 'workflow-run', runDepth: -1 },
    })).toMatchObject({ ok: false, details: { reason: 'caller_depth_unavailable' } });
  });
  it('resolves the Second opinion default from the enabled host inventory before admission', () => {
    const other = buildBackendTargetKeyV2({ kind: 'backend', backendId: 'claude' });
    const context = requireContext({ ...input,
      availableAgentTargetKeys: [buildBackendTargetKeyV2(backendTarget), other],
    });
    expect(context?.roles.second_opinion.engine).toEqual({ agentTargetKey: other });
  });
  it('cannot reset a missing persisted starter depth to zero', () => {
    expect(resolveCliAgentStartContextV1({ ...input, starterDepth: undefined }))
      .toMatchObject({ ok: false, details: { reason: 'caller_depth_unavailable' } });
    expect(resolveCliAgentStartContextV1({ ...input, starterDepth: -1 }))
      .toMatchObject({ ok: false, details: { reason: 'caller_depth_unavailable' } });
  });
  it('uses the Account limit and existing role/model owners, preserving inherited choices', () => {
    const selection = { agentTargetKey: buildBackendTargetKeyV2(backendTarget), providerConnectionId: null, modelId: 'model' };
    const context = requireContext({ ...input, turnDepth: 4,
      appliedChildSelection: { status: 'applied', backendTarget, modelId: selection.modelId, modelSelection: selection, connectedServices: null }, metadata: {
      modelSelectionIntentV1: { v: 1, selection: { ...selection, modelId: 'pending-other-model' }, updatedAt: 10 },
    } });
    expect(context?.baseline.configuration?.modelSelection).toEqual(selection);
    expect(context?.roles.reviewer.engine).toMatchObject({ modelId: 'model' });
    expect(context).not.toBeNull();
    if (!context) throw new Error('host snapshot unavailable');
    expect(admitAgentStartV1(input.settings.sessionAgentSpawnPolicyV1, {
      kind: 'execution_run', source: 'review', intent: 'review', facts: {}, backendTargets: [backendTarget],
    }, context)).toMatchObject({ ok: false, refusal: { code: 'work_depth_exceeded' } });
  });
});
