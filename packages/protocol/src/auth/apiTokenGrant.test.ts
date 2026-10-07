import { describe, expect, it } from 'vitest';
import {
  API_TOKEN_FULL_GRANT_V1 as full, ApiTokenGrantV1Schema,
  evaluateApiTokenGrantV1 as evaluate, isApiTokenGrantWithinV1 as within,
  isModelRefGrantedV1, isPermissionModeGrantedV1, isOriginAllowedByApiTokenGrantV1,
  resolveApiTokenSessionCapabilityCeilingV1,
  resolveEffectiveApiTokenModelRefV1,
  resolveEffectiveApiTokenPermissionModeV1,
  type ApiTokenGrantV1,
} from './apiTokenGrant.js';

const modelA = { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'a' };
const modelB = { ...modelA, modelId: 'b' };
const session = { kind: 'session', sessionId: 's1' } as const;
const machine = { kind: 'machine', machineId: 'm1' } as const;
const create = { machineId: 'm1', agentTargetKey: modelA.agentTargetKey, directory: 'managed', placement: { folderId: 'leads', tagIds: ['inbound'] } } as const;
const spawn = {
  executionTarget: { serverId: 'home', machineId: 'm1' },
  agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
  directory: { kind: 'managed' }, organizationPlacement: create.placement,
} as const;
const grant = (patch: Partial<ApiTokenGrantV1> = {}): ApiTokenGrantV1 => ApiTokenGrantV1Schema.parse({ ...full, ...patch });

describe('API token grant admission', () => {
  it('chooses only models for the requested agent and refuses an empty agent-specific grant', () => {
    const other = { ...modelA, agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'codex-model' };
    expect(resolveEffectiveApiTokenModelRefV1({ models: [modelA, other] }, undefined, other.agentTargetKey)).toEqual(other);
    expect(resolveEffectiveApiTokenModelRefV1({ models: [modelA, other] }, modelA, other.agentTargetKey)).toEqual(other);
    expect(resolveEffectiveApiTokenModelRefV1({ models: [modelA] }, undefined, other.agentTargetKey)).toBeNull();
    expect(resolveEffectiveApiTokenModelRefV1(full, undefined, other.agentTargetKey)).toBe('automatic');
  });
  it('shares permission defaults, retains permitted choices and falls back in grant order', () => {
    expect(resolveEffectiveApiTokenPermissionModeV1({ permissionModes: null })).toBe('default');
    expect(resolveEffectiveApiTokenPermissionModeV1({ permissionModes: ['plan', 'default'] })).toBe('plan');
    expect(resolveEffectiveApiTokenPermissionModeV1({ permissionModes: ['plan', 'default'] }, 'default')).toBe('default');
    expect(resolveEffectiveApiTokenPermissionModeV1({ permissionModes: ['plan'] }, 'bypassPermissions')).toBe('plan');
    expect(resolveEffectiveApiTokenPermissionModeV1({ permissionModes: ['default'] }, 'safe-yolo')).toBe('default');
    expect(resolveEffectiveApiTokenPermissionModeV1({ permissionModes: [] })).toBeNull();
  });
  it('requires the bound creation machine to belong to restricted targets', () => {
    expect(ApiTokenGrantV1Schema.safeParse({ ...full, create,
      targets: { sessions: ['s1'], machines: ['m2'] } }).success).toBe(false);
    expect(ApiTokenGrantV1Schema.safeParse({ ...full, create,
      targets: { sessions: [], machines: ['m1'] } }).success).toBe(true);
    expect(ApiTokenGrantV1Schema.safeParse({ ...full, create }).success).toBe(true);
  });
  it('does not impose a grant-local capacity on canonical target identities', () => {
    const sessionId = 'session-'.repeat(80);
    const machineId = 'machine-'.repeat(80);
    const admitted = ApiTokenGrantV1Schema.safeParse({ ...full,
      targets: { sessions: [sessionId], machines: [machineId] },
    });
    expect(admitted.success).toBe(true);
    if (!admitted.success) throw new Error('Expected unrestricted-length target identities');
    expect(evaluate({ grant: admitted.data, actionId: 'session.message.send',
      target: { kind: 'session', sessionId } })).toEqual({ ok: true });
    expect(within(admitted.data, full)).toBe(true);
  });
  it('uses action ids, canonical families and explicit contributed ids', () => {
    const g = grant({ actions: { families: ['messaging'], ids: ['example/action'] } });
    expect(evaluate({ grant: g, actionId: 'session.message.send', target: session })).toEqual({ ok: true });
    expect(evaluate({ grant: g, actionId: 'session.goal.set', target: session })).toEqual({ ok: false, reason: 'action_not_granted' });
    expect(evaluate({ grant: full, actionId: 'action.invoke', contributedQualifiedId: 'example/action', target: session })).toEqual({ ok: true });
    expect(evaluate({ grant: g, actionId: 'action.invoke', contributedQualifiedId: 'example/action', target: session })).toEqual({ ok: true });
    expect(evaluate({ grant: g, actionId: 'action.spec.search' })).toEqual({ ok: true });
  });

  it('requires targets and resolves session membership through the granted machine', () => {
    const g = grant({ targets: { sessions: ['s1'], machines: ['m1'] } });
    expect(evaluate({ grant: g, actionId: 'session.message.send' })).toEqual({ ok: false, reason: 'target_required' });
    expect(evaluate({ grant: g, actionId: 'session.message.send', target: { kind: 'session', sessionId: 's2' } })).toEqual({ ok: false, reason: 'target_not_granted' });
    expect(evaluate({ grant: g, actionId: 'session.message.send', target: { kind: 'session', sessionId: 's2' }, targetMachineId: 'm1' })).toEqual({ ok: true });
  });

  it('admits opaque contributed requests only at the pre-open stage and still requires exact resolved identity', () => {
    const allowedId = 'acme.workflow/actions/update-team';
    const g = grant({ actions: { families: [], ids: [allowedId] }, targets: { sessions: ['s1'], machines: [] } });
    const opaque = { actionId: 'action.invoke', contributedActionAdmission: 'pre_open' as const, target: session };
    expect(evaluate({ ...opaque, grant: g })).toEqual({ ok: true });
    expect(evaluate({ ...opaque, grant: full })).toEqual({ ok: true });
    for (const ids of [['action.invoke'], ['example/action'], ['acme.workflow/actions/']]) {
      expect(evaluate({ ...opaque, grant: grant({ actions: { families: [], ids } }) }).ok).toBe(false);
    }
    expect(evaluate({ ...opaque, grant: g, target: { kind: 'session', sessionId: 's2' } }).ok).toBe(false);
    expect(evaluate({ grant: g, actionId: 'action.invoke', target: session }).ok).toBe(false);
    expect(evaluate({ ...opaque, grant: g, contributedQualifiedId: 'acme.workflow/actions/delete-team' }).ok).toBe(false);
    expect(evaluate({ grant: g, actionId: 'action.invoke', contributedQualifiedId: allowedId, target: session }).ok).toBe(true);
  });

  it('treats approve as the sole decision switch, while preserving target membership', () => {
    const g = grant({ actions: { families: [], ids: ['session.message.send'] }, approve: true, targets: { sessions: ['s1'], machines: [] } });
    expect(evaluate({ grant: g, actionId: 'approval.request.decide', target: session })).toEqual({ ok: true });
    expect(evaluate({ grant: { ...g, approve: false }, actionId: 'approval.request.decide', target: session }).ok).toBe(false);
    expect(evaluate({ grant: g, actionId: 'session.permission.respond', target: { kind: 'session', sessionId: 's2' } }).ok).toBe(false);
  });

  it('admits agent-question answers exactly when Send is admitted', () => {
    for (const actions of [
      { families: [], ids: ['session.message.send'] },
      { families: [], ids: ['session.user_action.answer'] },
      { families: ['messaging'], ids: [] },
      null,
    ]) {
      const g = ApiTokenGrantV1Schema.parse({ ...full, actions });
      expect(evaluate({ grant: g, actionId: 'session.user_action.answer', target: session }).ok)
        .toBe(evaluate({ grant: g, actionId: 'session.message.send', target: session }).ok);
    }
  });

  it('enforces all creation bindings through the same evaluator', () => {
    const g = grant({ create: { ...create, placement: { ...create.placement, tagIds: [...create.placement.tagIds] } }, targets: { sessions: [], machines: ['m1'] } });
    expect(evaluate({ grant: g, actionId: 'session.spawn_new', target: machine, spawnInput: spawn })).toEqual({ ok: true });
    for (const changed of [
      { ...spawn, executionTarget: { ...spawn.executionTarget, machineId: 'm2' } },
      { ...spawn, directory: { kind: 'path', path: '/home/x' } },
      { ...spawn, organizationPlacement: { ...create.placement, folderId: 'other' } },
      { ...spawn, organizationPlacement: { ...create.placement, tagIds: ['other'] } },
      { ...spawn, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } },
    ]) {
      expect(evaluate({ grant: g, actionId: 'session.spawn_new', target: machine, spawnInput: changed })).toEqual({ ok: false, reason: 'create_not_granted' });
    }
    expect(evaluate({ grant: g, actionId: 'session.spawn_new', target: { kind: 'machine', machineId: 'm2' }, spawnInput: spawn }).ok).toBe(false);
  });

  it('rejects automatic/native defaults and ungranted effective modes/models', () => {
    const c = grant({ models: [modelA], permissionModes: ['default'] });
    expect(isModelRefGrantedV1(c, 'automatic')).toBe(false);
    expect(isModelRefGrantedV1(c, modelB)).toBe(false);
    expect(isModelRefGrantedV1(c, modelA)).toBe(true);
    expect(isPermissionModeGrantedV1(c, 'bypassPermissions')).toBe(false);
    expect(isPermissionModeGrantedV1(c, 'default')).toBe(true);
    expect(isModelRefGrantedV1(full, 'automatic')).toBe(true);
  });

  it('fails closed on malformed/duplicate constraints and noncanonical browser origins', () => {
    for (const patch of [{ models: [] }, { models: [modelA, modelA] }, { permissionModes: ['invalid'] }, { origins: ['not an origin'] }, { origins: ['http://example.com'] }, { origins: ['https://example.com/'] }, { targets: { sessions: ['s1', 's1'], machines: [] } }]) {
      expect(ApiTokenGrantV1Schema.safeParse({ ...full, ...patch }).success).toBe(false);
    }
    const g = grant({ origins: ['https://example.com', 'http://localhost:5173', 'http://[::1]:5173'] });
    expect(isOriginAllowedByApiTokenGrantV1(g, 'https://example.com')).toBe(true);
    expect(isOriginAllowedByApiTokenGrantV1(g, 'https://other.example')).toBe(false);
    expect(isOriginAllowedByApiTokenGrantV1(g, 'https://example.com/')).toBe(false);
  });

  it('never treats the native default reset as a finite model identity', () => {
    const nativeDefault = { ...modelA, modelId: 'default' };
    const providerDefault = { ...nativeDefault, providerConnectionId: 'provider-1' };
    expect(isModelRefGrantedV1(grant({ models: [nativeDefault] }), nativeDefault)).toBe(false);
    expect(isModelRefGrantedV1(grant({ models: [providerDefault] }), providerDefault)).toBe(true);
    expect(isModelRefGrantedV1(full, nativeDefault)).toBe(true);
    expect(resolveEffectiveApiTokenModelRefV1({ models: [nativeDefault, modelA] })).toEqual(modelA);
    expect(resolveEffectiveApiTokenModelRefV1({ models: [nativeDefault] })).toBeNull();
    expect(resolveEffectiveApiTokenModelRefV1({ models: [providerDefault] })).toEqual(providerDefault);
    expect(resolveEffectiveApiTokenModelRefV1({ models: [modelA, modelB] }, modelB)).toEqual(modelB);
    expect(resolveEffectiveApiTokenModelRefV1({ models: [modelA] }, modelB)).toEqual(modelA);
    expect(resolveEffectiveApiTokenModelRefV1(full)).toBe('automatic');
  });


  it('uses the canonical permission intent for legacy and effective spellings', () => {
    const c = grant({ permissionModes: ['acceptEdits', 'bypassPermissions'] });
    expect(isPermissionModeGrantedV1(c, 'safe-yolo')).toBe(true);
    expect(isPermissionModeGrantedV1(c, 'yolo')).toBe(true);
    expect(isPermissionModeGrantedV1(c, 'read-only')).toBe(false);
    expect(within(grant({ permissionModes: ['yolo'] }), grant({ permissionModes: ['bypassPermissions'] }))).toBe(true);
  });

  it('projects capability ceilings from admitted actions', () => {
    const g = grant({ actions: { families: [], ids: ['session.message.send'] }, approve: true });
    expect([...resolveApiTokenSessionCapabilityCeilingV1(g)].sort()).toEqual(['approveRuntimePermissions', 'readTranscript', 'submitAgentInput']);
  });
});

describe('monotonic child attenuation', () => {
  it('uses the same conversational admission when attenuating explicit action ids', () => {
    const send = grant({ actions: { families: [], ids: ['session.message.send'] } });
    const sendAndAnswer = grant({ actions: { families: [], ids: ['session.message.send', 'session.user_action.answer'] } });
    expect(within(sendAndAnswer, send)).toBe(true);
    for (const actionId of ['session.message.send', 'session.user_action.answer']) {
      expect(evaluate({ grant: sendAndAnswer, actionId, target: session })).toEqual({ ok: true });
      expect(evaluate({ grant: send, actionId, target: session })).toEqual({ ok: true });
    }
    expect(within(send, grant({ actions: { families: [], ids: ['session.user_action.answer'] } }))).toBe(false);
  });
  it('does not introduce contributed actions absent from the parent', () => {
    const contributed = grant({ actions: { families: [], ids: ['example/action'] } });
    expect(within(contributed, full)).toBe(true);
    expect(within(contributed, grant({ actions: { families: [], ids: ['other/action'] } }))).toBe(false);
    expect(within(contributed, contributed)).toBe(true);
  });
  it('rejects widening nullable sets, approve, origins and create bindings', () => {
    const bound = grant({ create: { ...create, placement: { folderId: 'leads', tagIds: ['inbound'] } }, targets: { sessions: [], machines: ['m1'] } });
    expect(within({ ...bound, create: null }, bound)).toBe(false);
    expect(within({ ...bound, create: null, actions: { families: [], ids: ['session.message.send'] } }, bound)).toBe(true);
    expect(within({ ...bound, create: { ...bound.create!, agentTargetKey: 'other' } }, bound)).toBe(false);
    expect(within(grant({ approve: true }), full)).toBe(false);
    expect(within(grant({ origins: ['https://example.com'] }), full)).toBe(false);
    for (const field of ['actions', 'targets', 'models', 'permissionModes'] as const) {
      const parent = grant({ actions: { families: ['messaging'], ids: [] }, targets: { sessions: ['s1'], machines: ['m1'] }, models: [modelA], permissionModes: ['default'] });
      expect(within({ ...parent, [field]: null }, parent)).toBe(false);
      expect(within(parent, { ...parent, [field]: null })).toBe(true);
    }
  });

  it('every accepted nullable transition admits only parent outcomes', () => {
    const variants = [full, grant({ actions: { families: ['messaging'], ids: [] } }), grant({ actions: { families: [], ids: ['example/action'] } }), grant({ targets: { sessions: ['s1'], machines: ['m1'] } }), grant({ models: [modelA] }), grant({ permissionModes: ['default'] }), grant({ create: { ...create, placement: { folderId: 'leads', tagIds: ['inbound'] } } })];
    const requests = [
      { actionId: 'action.invoke', contributedQualifiedId: 'example/action', target: session },
      { actionId: 'session.spawn_new', target: machine, spawnInput: spawn },
      { actionId: 'session.spawn_new', target: { kind: 'machine', machineId: 'm2' } as const, spawnInput: { ...spawn, executionTarget: { ...spawn.executionTarget, machineId: 'm2' } } },
      ...['s1', 's2'].flatMap((sessionId) => ['session.message.send', 'approval.request.decide'].map((actionId) => ({ actionId, target: { kind: 'session', sessionId } as const }))),
    ];
    for (const parent of variants) for (const child of variants) {
      if (!within(child, parent)) continue;
      for (const r of requests) if (evaluate({ ...r, grant: child }).ok) expect(evaluate({ ...r, grant: parent }).ok).toBe(true);
      for (const ref of [modelA, modelB, 'automatic'] as const) if (isModelRefGrantedV1(child, ref)) expect(isModelRefGrantedV1(parent, ref)).toBe(true);
      for (const mode of ['default', 'bypassPermissions'] as const) if (isPermissionModeGrantedV1(child, mode)) expect(isPermissionModeGrantedV1(parent, mode)).toBe(true);
    }
  });
});
