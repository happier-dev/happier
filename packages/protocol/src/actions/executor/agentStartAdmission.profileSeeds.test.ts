import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorContext, type ActionExecutorDeps } from '../actionExecutor.js';
import { createProfileActionExecuteV1 } from '../../profiles/profileActionsV1.js';
import { createProfileOperations } from '../../profiles/profileOperations.js';
import { ProfileRecordV1Schema } from '../../profiles/profileRecordSchemaV1.js';
import { SessionCapabilitySelectionAuthoringV1Schema } from '../../reach/sessionCapabilitySelectionV1.js';

describe('Profile seeds at new Session admission', () => {
  it.each([false, true])('refuses an unknown explicit Profile without Session birth or approval (inherited target=%s)', async inherited => {
    let catalogReads = 0;
    let births = 0;
    let approvals = 0;
    const profileActionExecute = createProfileActionExecuteV1({ operations: createProfileOperations({
      // Account catalog persistence is the boundary; Profile read/admission stays real.
      readCatalog: () => {
        catalogReads += 1;
        return { status: 'ready', source: 'destination', authority: 'inactive', control: null,
          controlRevision: 'absent', records: [], diagnostics: [], referenceGuardRevision: 1 };
      },
      writeRecord: async () => { throw new Error('Admission must not change the Profile'); },
      deleteRecord: async () => { throw new Error('Admission must not delete the Profile'); },
    }) });
    const executor = createActionExecutor({ profileActionExecute,
      sessionSpawnNew: async () => { births += 1; return { type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' }; },
      approvalsCreate: async () => { approvals += 1; return { artifactId: 'must-not-create' }; },
      isActionApprovalRequired: () => true,
    });
    const input = { creationKey: 'missing-profile-session', executionTarget: { serverId: 'home', machineId: 'machine' },
      directory: { kind: 'path', path: '/repo' }, profileId: 'unknown-profile',
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } } as const;
    const diagnostics: unknown[] = [];
    const context: ActionExecutorContext = { surface: 'agent', authority: 'account_automation', serverId: 'home', runtimeAccountId: 'account',
      defaultSessionId: 'parent', actionCaller: { kind: 'session', sessionId: 'parent', starterDepth: 0, turnDepth: 0 },
      callerPermissionMode: 'default',
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
      sessionInputSource: { sourceSessionId: 'parent', sourceTurnId: 'turn', via: 'action' },
      agentStartContext: { caller: { kind: 'session', sessionId: 'parent', starterDepth: 0, turnDepth: 0 },
        baseline: { machineId: 'machine', directory: '/repo', configuration: { agentTarget: input.agentTarget } },
        roles: {}, ledSubtreeSessionIds: [], workDepthLimit: 4, callerPermissionCeiling: 'default' },
      recordActionStartDiagnostic: diagnostic => {
        diagnostics.push(diagnostic);
      },
    };
    expect(await executor.execute('session.spawn_new', { ...input, directory: 1 }, context))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(await executor.execute('session.spawn_new', input, { ...context, causalPermissionAuthority: undefined }))
      .toMatchObject({ ok: false, errorCode: 'causal_permission_authority_invalid' });
    expect(catalogReads).toBe(0);
    const { executionTarget, agentTarget, ...withoutTarget } = input;
    for (const surface of ['agent', 'ui'] as const) {
      const result = await executor.execute('session.spawn_new', surface === 'agent' && inherited ? withoutTarget : input,
        surface === 'agent' ? context : { surface, authority: 'present_user', serverId: 'home', actionCaller: { kind: 'host' } });
      expect(result, surface).toMatchObject({ ok: false, errorCode: 'target_unavailable',
        details: { code: 'target_unavailable', reason: 'profile_unavailable' } });
      expect({ births, approvals }).toEqual({ births: 0, approvals: 0 });
    }
    expect(catalogReads).toBeGreaterThan(0);
    expect(diagnostics).toContainEqual({ phase: 'agent_start_context', refusalReason: 'profile_unavailable' });
  });

  it.each(['user', 'inherited', 'role', 'fresh'] as const)('adds the final Profile seeds once and keeps explicit exclusions (%s)', async caller => {
    const profile = { v: 2, id: 'seed-profile', name: 'Seed Profile', createdAt: 1, updatedAt: 1 };
    let record = ProfileRecordV1Schema.parse({ v: 1, id: profile.id, definition: { kind: 'inline', profile },
      enabled: true, promptStack: [], secretBindings: {}, skillSeeds: ['lint', 'review'] });
    let catalogReads = 0;
    const profileActionExecute = createProfileActionExecuteV1({ operations: createProfileOperations({
      readCatalog: () => { catalogReads += 1; return { status: 'ready', source: 'destination', authority: 'inactive', control: null,
        controlRevision: 'absent', records: [{ record, revision: 1 }], diagnostics: [], referenceGuardRevision: 1 }; },
      writeRecord: async () => { throw new Error('Admission must not change the Profile'); },
      deleteRecord: async () => { throw new Error('Admission must not delete the Profile'); },
    }) });
    let spawned: Parameters<NonNullable<ActionExecutorDeps['sessionSpawnNew']>>[0] | undefined;
    const executor = createActionExecutor({ profileActionExecute, sessionSpawnNew: async input => {
      spawned = input;
      return { type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' };
    } });
    const input = { creationKey: 'seed-session', executionTarget: { serverId: 'home', machineId: 'machine' }, directory: { kind: 'path', path: '/repo' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      profileId: profile.id, capabilitySelection: { skills: {
      v: 1, forceIncludeSkillIds: ['custom'], forceExcludeSkillIds: ['lint'], excludeNativeSkillNames: ['native'] },
      mcp: { v: 1, forceIncludeServerIds: [], forceExcludeServerIds: ['server'] } } };
    const agentCaller = { kind: 'session', sessionId: 'parent', starterDepth: 0, turnDepth: 0 } as const;
    const { executionTarget, agentTarget, ...withoutTarget } = input;
    const prepared = await executor.prepare('session.spawn_new', caller === 'inherited' ? withoutTarget
      : caller === 'role' ? { ...input, profileId: 'superseded-unknown-profile', roleId: 'reviewer' } : input,
      caller === 'user' ? { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home' }
      : { surface: 'agent', authority: 'account_automation', serverId: 'home', runtimeAccountId: 'account', defaultSessionId: 'parent',
        actionCaller: agentCaller, callerPermissionMode: 'default',
        causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
        sessionInputSource: { sourceSessionId: 'parent', sourceTurnId: 'turn', via: 'action' },
        agentStartContext: { caller: agentCaller, callerPermissionCeiling: 'default',
          baseline: { machineId: 'machine', directory: '/repo', configuration: { agentTarget } },
          ledSubtreeSessionIds: [], workDepthLimit: 4, roles: caller === 'role' ? {
            reviewer: { roleId: 'reviewer', name: 'Reviewer', instructions: 'Review the work.', profileId: profile.id,
              engine: { agentTargetKey: 'agent:happier.agent.codex/codex' }, runsAs: { kind: 'session' },
              workspaceWrites: 'allow', secondOpinion: 'off', enabled: true },
          } : {} },
      });
    if (prepared.kind !== 'ready') throw new Error(`Expected admitted preparation: ${JSON.stringify(prepared.result)}`);
    // The user may change the Account Profile while approval/preparation is pending.
    if (caller === 'fresh') record = ProfileRecordV1Schema.parse({ ...record, skillSeeds: ['lint', 'format'] });
    const admitted = await prepared.invocation.run();
    expect(admitted, JSON.stringify(admitted)).toMatchObject({ ok: true });
    expect(spawned).toMatchObject({ capabilitySelection: { skills: {
      forceIncludeSkillIds: ['custom', caller === 'fresh' ? 'format' : 'review'], forceExcludeSkillIds: ['lint'], excludeNativeSkillNames: ['native'],
    }, mcp: input.capabilitySelection.mcp } });
    if (!admitted.ok) throw new Error('Expected admission');
    expect(SessionCapabilitySelectionAuthoringV1Schema.safeParse(spawned?.capabilitySelection).success).toBe(true);
    // One actual Account catalog read supplies the final seeds; an early probe
    // must not add a second read to the same new-Session invocation.
    expect(catalogReads).toBe(1);
  });
});
