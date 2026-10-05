import { describe, expect, it } from 'vitest';
import { admitAgentStartV1, type AgentStartContextV1, type AgentStartFactsV1, type AgentStartRequestV1, type MaterializedWorkflowLeafV1 } from './admitAgentStartV1.js';
import { DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, SessionAgentSpawnPolicyV1StrictSchema } from './sessionAgentSpawnPolicyV1.js';
import type { AgentExecutionTargetV1 } from '../../agents/executionTargetV1.js';
import type { ResolvedRoleV1 } from '../../prompts/roles/rolesV1.js';
import { buildBackendTargetKeyV2 } from '../../backends/targets/backendTargetRefV2.js';
import { accountSettingsParse } from './accountSettings.js';
import { SessionSpawnNewInputV2Schema } from '../../sessions/creation/sessionSpawnNewInputV2.js';
import { ExecutionRunStartRequestBaseSchema } from '../../execution/runs/startRequest.js';
import { z } from 'zod';

// Pinned predecessor schema: ../0.2 @17ba05df68, accountSettings.ts:94–126.
// This is an old-reader contract vector, never a production policy decision.
const predecessorPolicySchema = z.object({
  v: z.literal(1).default(1),
  allowCustomDirectory: z.boolean().default(true),
  allowCrossMachine: z.boolean().default(true),
  allowBackendTargetOverride: z.boolean().default(true),
  allowModelOverride: z.boolean().default(true),
  allowPermissionModeOverride: z.boolean().default(true),
  allowAgentModeOverride: z.boolean().default(true),
  allowConfigOptionOverrides: z.boolean().default(true),
  allowProfileOverride: z.boolean().default(true),
  allowEnvironmentVariables: z.boolean().default(true),
  allowConnectedServicesOverride: z.boolean().default(true),
  allowMcpSelectionOverride: z.boolean().default(true),
  allowTranscriptStorageOverride: z.boolean().default(true),
  permissionCeiling: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'read-only', 'safe-yolo', 'yolo']).nullable().default(null),
}).strict();

const target: AgentExecutionTargetV1 = { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } };
const otherTarget: AgentExecutionTargetV1 = { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } };
const engine = { agentTargetKey: buildBackendTargetKeyV2(target), modelId: 'base-model' };
const modelSelection = { agentTargetKey: engine.agentTargetKey, providerConnectionId: null, modelId: 'base-model' } as const;
const role: ResolvedRoleV1 = { roleId: 'builder', name: 'Builder', instructions: 'Build', engine, runsAs: { kind: 'session' }, workspaceWrites: 'allow', secondOpinion: 'off', enabled: true };
const baseline: AgentStartContextV1 = {
  caller: { kind: 'session', sessionId: 'lead', starterDepth: 0, turnDepth: 0 },
  baseline: { machineId: 'machine', directory: '/workspace', configuration: { agentTarget: target, modelSelection, permissionMode: 'default', agentModeId: 'code', configOptions: { effort: { value: 'medium', updatedAtMs: 1 } }, profileId: 'profile', connectedServices: { v: 2, bindingsByServiceId: {} }, mcpSelection: { v: 1, managedServersEnabled: true, forceIncludeServerIds: [], forceExcludeServerIds: [] }, transcriptStorage: 'persisted' } },
  ledSubtreeSessionIds: ['worker'], workDepthLimit: 4, roles: { builder: role }, callerPermissionCeiling: 'default',
};
const leaf = (facts: AgentStartFactsV1 = {}): MaterializedWorkflowLeafV1 => ({ blockId: 'block', kind: 'session', engine, runsAs: { kind: 'session' }, workspaceWrites: 'allow', facts });
const spawn = (facts: AgentStartFactsV1 = {}): AgentStartRequestV1 => ({ kind: 'spawn_new', facts });

describe('admitAgentStartV1', () => {
  it('enforces environment presence across start arms while preserving permitted and human starts', () => {
    const policy = accountSettingsParse({ sessionAgentSpawnPolicyV1: { allowEnvironmentVariables: false } }).sessionAgentSpawnPolicyV1;
    // ../0.2 @17ba05df68 normalizeSessionAgentSpawnActionRequest.ts:234
    // uses hasValue: an empty bag is supplied; null and undefined are absent.
    const facts = { hasEnvironmentVariables: true };
    for (const request of [spawn(facts), {
      kind: 'execution_run', source: 'execution_run', intent: 'delegate', backendTargets: [target], facts,
    } satisfies AgentStartRequestV1, { kind: 'workflow_run_leaf', leaf: leaf(facts) } satisfies AgentStartRequestV1]) {
      expect(admitAgentStartV1(policy, request, baseline)).toMatchObject({
        ok: false, refusal: { code: 'policy_denied_field', field: 'environmentVariables' },
      });
    }
    expect(admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, spawn(facts), baseline)).toMatchObject({ ok: true });
    expect(admitAgentStartV1(policy, spawn(facts), { ...baseline, initiator: 'user' })).toMatchObject({ ok: true });
    for (const hasEnvironmentVariables of [undefined, false]) {
      expect(admitAgentStartV1(policy, spawn({ hasEnvironmentVariables }), baseline)).toMatchObject({ ok: true });
    }
  });

  it('refuses unresolved environment selections and environment-bearing authored leaves', () => {
    const policy = { ...DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, allowEnvironmentVariables: false };
    const facts = { hasEnvironmentVariables: { kind: 'unresolved' } } as const;
    expect(admitAgentStartV1(policy, spawn(facts), baseline)).toMatchObject({
      ok: false, refusal: { code: 'policy_denied_field', field: 'environmentVariables' },
    });
    for (const kind of ['definition_write', 'trigger_write'] as const) {
      const request: AgentStartRequestV1 = kind === 'definition_write'
        ? { kind, leaves: [leaf(facts)] } : { kind, scope: 'workflow', leaves: [leaf(facts)] };
      expect(admitAgentStartV1(policy, request, baseline)).toMatchObject({
        ok: false, refusal: { code: 'definition_exceeds_authority', blockId: 'block',
          cause: { code: 'policy_denied_field', field: 'environmentVariables' } },
      });
    }
  });

  it('preserves predecessor-saved restrictions through settings parsing and admission', () => {
    // Fixture bytes from ../0.2 accountSettings.test.ts:693–701, plus cross-machine deny.
    const savedPolicy = {
      v: 1,
      allowCustomDirectory: false,
      allowEnvironmentVariables: false,
      allowMcpSelectionOverride: false,
      permissionCeiling: 'acceptEdits',
    };
    const settings = accountSettingsParse({ sessionAgentSpawnPolicyV1: { ...savedPolicy, allowCrossMachine: false } });
    expect(settings.sessionAgentSpawnPolicyV1).toMatchObject({ ...savedPolicy, allowCrossMachine: false });
    expect(admitAgentStartV1(settings.sessionAgentSpawnPolicyV1, spawn({ machineId: 'another-machine' }), baseline))
      .toMatchObject({ ok: false, refusal: { code: 'policy_denied_field', field: 'executionTarget.machineId' } });
  });

  it('writes V1 policy readable by the strict predecessor without losing restrictions', () => {
    const settings = accountSettingsParse({
      sessionAgentSpawnPolicyV1: { allowCrossMachine: false, allowEnvironmentVariables: false },
      sessionAgentStartAllowListsV1: { allowedRoleIds: ['builder'], allowedAgentTargetKeys: [engine.agentTargetKey] },
    });
    const restored = predecessorPolicySchema.safeParse(JSON.parse(JSON.stringify(settings.sessionAgentSpawnPolicyV1)));
    expect(restored.success).toBe(true);
    if (restored.success) expect(restored.data).toMatchObject({ allowCrossMachine: false, allowEnvironmentVariables: false });
  });

  it('normalizes unknown and malformed fields independently without erasing deny rules', () => {
    const settings = accountSettingsParse({ sessionAgentSpawnPolicyV1: {
      allowCrossMachine: false, allowEnvironmentVariables: false,
      allowModelOverride: 'invalid', unknownFutureField: true,
    } });
    expect(settings.sessionAgentSpawnPolicyV1).toMatchObject({ allowCrossMachine: false, allowEnvironmentVariables: false, allowModelOverride: true });
    expect(settings.sessionAgentSpawnPolicyV1).not.toHaveProperty('unknownFutureField');
    expect(SessionAgentSpawnPolicyV1StrictSchema.safeParse({ allowCrossMachine: false, unknownFutureField: true }).success).toBe(false);
    expect(SessionAgentSpawnPolicyV1StrictSchema.safeParse({ allowCrossMachine: false, allowModelOverride: 'invalid' }).success).toBe(false);
  });
  it('stamps the selected role workspace policy rather than the starter policy', () => {
    const reviewer: ResolvedRoleV1 = { ...role, roleId: 'reviewer', runsAs: { kind: 'background_run', intent: 'review' }, workspaceWrites: 'deny' };
    expect(admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, {
      kind: 'execution_run', source: 'review', roleId: 'reviewer', facts: {}, backendTargets: [target], intent: 'review',
    }, { ...baseline, roles: { reviewer } })).toMatchObject({ ok: true, stamped: { workspaceWrites: 'deny' } });
    expect(admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, {
      kind: 'spawn_new', roleId: 'builder', facts: {},
    }, baseline)).toMatchObject({ ok: true, stamped: { workspaceWrites: 'allow' } });
    expect(admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, {
      kind: 'workflow_run_leaf', leaf: { ...leaf(), workspaceWrites: 'deny' },
    }, baseline)).toMatchObject({ ok: true, stamped: { workspaceWrites: 'deny' } });
  });
  it('derives directory and machine overrides from the actual selections', () => {
    const policy = { ...DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, allowCustomDirectory: false, allowCrossMachine: false };
    expect(admitAgentStartV1(policy, spawn({ directory: '/different' }), baseline)).toMatchObject({ ok: false, refusal: { code: 'policy_denied_field', field: 'directory' } });
    expect(admitAgentStartV1(policy, spawn({ machineId: 'different' }), baseline)).toMatchObject({ ok: false, refusal: { code: 'policy_denied_field', field: 'executionTarget.machineId' } });
    expect(admitAgentStartV1(policy, spawn({ directory: '/workspace', machineId: 'machine' }), baseline)).toMatchObject({ ok: true });
  });

  it('uses structural selections, including object key order and semantic model refs', () => {
    const policy = { ...DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, allowBackendTargetOverride: false, allowModelOverride: false, allowConfigOptionOverrides: false };
    expect(admitAgentStartV1(policy, spawn({ agentTarget: { identity: { localId: 'codex', pluginId: 'happier.agent.codex' }, kind: 'agent' }, modelSelection: { v: 1, ref: { ...modelSelection }, updatedAt: 42 }, configOptions: { effort: { updatedAtMs: 1, value: 'medium' } } }), baseline)).toMatchObject({ ok: true });
    expect(admitAgentStartV1(policy, spawn({ configOptions: { effort: { value: 'high', updatedAtMs: 1 } } }), baseline)).toMatchObject({ ok: false, refusal: { code: 'policy_denied_field', field: 'configuration.options' } });
  });

  it('treats an explicit cleared Agent mode as an override rather than an omitted selection', () => {
    const policy = { ...DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, allowAgentModeOverride: false };
    expect(admitAgentStartV1(policy, spawn({ agentModeId: null }), baseline))
      .toMatchObject({ ok: false, refusal: { code: 'policy_denied_field', field: 'agentModeId' } });
    expect(admitAgentStartV1(policy, spawn(), baseline)).toMatchObject({ ok: true });
    expect(admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, spawn({ agentModeId: null }), baseline))
      .toMatchObject({ ok: true });
  });

  it('checks subtree before role, overrides, permissions and depth', () => {
    const context = { ...baseline, caller: { kind: 'session', sessionId: 'lead', starterDepth: 4, turnDepth: 4 } } as const;
    expect(admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, { kind: 'spawn_new', targetSessionId: 'stranger', roleId: 'missing', facts: { permissionMode: 'yolo' } }, context)).toMatchObject({ ok: false, refusal: { code: 'subtree_denied' } });
    for (const targetSessionId of ['lead', 'worker']) {
      expect(admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, { kind: 'session_target', targetSessionId }, context)).toMatchObject({ ok: true });
    }
  });

  it('uses an honest originless caller and permits its proved origin subtree only', () => {
    const originless: AgentStartContextV1 = { ...baseline, caller: { kind: 'originless', runId: 'workflow-run', runDepth: 2 }, baseline: { machineId: 'machine', directory: '/workspace' }, ledSubtreeSessionIds: [] };
    expect(admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, spawn({ agentTarget: target }), originless)).toMatchObject({ ok: true, stamped: { workDepth: 3 } });
    expect(admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, { kind: 'session_target', targetSessionId: 'worker' }, originless)).toMatchObject({ ok: false, refusal: { code: 'subtree_denied' } });
    const withOrigin: AgentStartContextV1 = { ...originless, caller: { ...originless.caller, kind: 'originless', runId: 'workflow-run', runDepth: 2, runOriginSessionId: 'lead' }, ledSubtreeSessionIds: ['worker'] };
    for (const targetSessionId of ['lead', 'worker']) expect(admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, { kind: 'session_target', targetSessionId }, withOrigin)).toMatchObject({ ok: true });
    expect(admitAgentStartV1({ ...DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, allowModelOverride: false }, spawn({ modelSelection }), originless)).toMatchObject({ ok: false, refusal: { code: 'policy_denied_field', field: 'modelSelection' } });
  });

  it('stamps the role over caller choices before applying restrictions', () => {
    const request = { kind: 'spawn_new', roleId: 'builder', facts: { agentTarget: otherTarget, modelSelection: { ...modelSelection, modelId: 'caller-model' }, profileId: 'caller-profile' } } as const;
    const context = { ...baseline, roles: { builder: { ...role, profileId: 'profile' } } };
    const policy = { ...DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, allowBackendTargetOverride: false, allowModelOverride: false, allowProfileOverride: false };
    expect(admitAgentStartV1(policy, request, context)).toEqual({ ok: true, stamped: { workDepth: 1, engine, profileId: 'profile', roleId: 'builder', workspaceWrites: 'allow' } });
    expect(admitAgentStartV1(policy, request, { ...context, roles: { builder: { ...role, engine: { ...engine, modelId: 'role-model' } } } })).toMatchObject({ ok: false, refusal: { code: 'policy_denied_field', field: 'modelSelection' } });
  });

  it('refuses unavailable roles, missing engines, and direct runs-as mismatches', () => {
    expect(admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, { kind: 'spawn_new', roleId: 'missing', facts: {} }, baseline)).toMatchObject({ ok: false, refusal: { code: 'role_target_unavailable' } });
    for (const changed of [{ enabled: false }, { engine: undefined }]) expect(admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, { kind: 'spawn_new', roleId: 'builder', facts: {} }, { ...baseline, roles: { builder: { ...role, ...changed } } })).toMatchObject({ ok: false, refusal: { code: changed.enabled === false ? 'role_target_unavailable' : 'target_unavailable' } });
    expect(admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, { kind: 'execution_run', source: 'execution_run', roleId: 'builder', facts: {}, backendTargets: [target], intent: 'delegate' }, baseline)).toMatchObject({ ok: false, refusal: { code: 'role_runs_as_mismatch' } });
    const reviewer: ResolvedRoleV1 = { ...role, roleId: 'reviewer', runsAs: { kind: 'background_run', intent: 'review' } };
    expect(admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, { kind: 'spawn_new', roleId: 'reviewer', facts: {} }, { ...baseline, roles: { reviewer } })).toMatchObject({ ok: false, refusal: { code: 'role_runs_as_mismatch' } });
    expect(admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, { kind: 'execution_run', source: 'review', roleId: 'reviewer', facts: { agentTarget: otherTarget }, backendTargets: [otherTarget], intent: 'delegate' }, { ...baseline, roles: { reviewer } })).toEqual({ ok: true, stamped: { workDepth: 1, engine, intent: 'review', roleId: 'reviewer', workspaceWrites: 'allow' } });
  });

  it('preserves FIN materialized precedence and never runs-as rejects a workflow leaf', () => {
    const materialized: MaterializedWorkflowLeafV1 = { ...leaf(), roleId: 'builder', engine: { ...engine, modelId: 'run-model' }, runsAs: { kind: 'background_run', intent: 'review' } };
    expect(admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, { kind: 'workflow_run_leaf', leaf: materialized }, baseline)).toEqual({ ok: true, stamped: { workDepth: 1, engine: materialized.engine, intent: 'review', roleId: 'builder', workspaceWrites: 'allow' } });
  });

  it('reserves a direct workflow run layer without adding one to an originless frozen run', () => {
    const request: AgentStartRequestV1 = { kind: 'workflow_run_leaf', leaf: leaf() };
    const session = (depth: number): AgentStartContextV1 => ({ ...baseline, caller: { kind: 'session', sessionId: 'lead', starterDepth: depth, turnDepth: depth } });
    const originless = (depth: number): AgentStartContextV1 => ({ ...baseline, caller: { kind: 'originless', runId: 'run', runDepth: depth } });
    expect(admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, request, session(2))).toMatchObject({ ok: true, stamped: { workDepth: 3 } });
    expect(admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, request, session(3))).toMatchObject({ ok: false, refusal: { code: 'work_depth_exceeded' } });
    expect(admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, request, originless(3))).toMatchObject({ ok: true, stamped: { workDepth: 4 } });
    expect(admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, request, originless(4))).toMatchObject({ ok: false, refusal: { code: 'work_depth_exceeded' } });
    for (const kind of ['definition_write', 'trigger_write'] as const) {
      const authored: AgentStartRequestV1 = kind === 'definition_write'
        ? { kind, leaves: [leaf()] } : { kind, scope: 'workflow', leaves: [leaf()] };
      expect(admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, authored, session(3))).toMatchObject({ ok: true, stamped: { workDepth: 4 } });
    }
  });

  it('admits a deferred workflow selection without approving a future child engine', () => {
    const request = { kind: 'workflow_run_leaf', selection: 'deferred', leaf: {
      blockId: 'review', kind: 'action', actionId: 'review.start',
      runsAs: { kind: 'background_run', intent: 'review' }, workspaceWrites: 'deny',
      facts: { machineId: 'machine', directory: '/workspace', permissionMode: 'default',
        agentTarget: { kind: 'unresolved' }, modelSelection: { kind: 'unresolved' } },
    } } as const;
    const context: AgentStartContextV1 = { ...baseline, allowLists: {
      v: 1, allowedRoleIds: [], allowedAgentTargetKeys: [],
    } };
    const policy = { ...DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
      allowBackendTargetOverride: false, allowModelOverride: false };
    expect(admitAgentStartV1(policy, request, context)).toEqual({ ok: true, stamped: { workDepth: 1 } });
    // Ordinary unresolved starts and authored definitions still fail closed.
    expect(admitAgentStartV1(policy, { kind: 'workflow_run_leaf', leaf: request.leaf }, context))
      .toMatchObject({ ok: false, refusal: { code: 'policy_denied_field', field: 'agentTarget' } });
    expect(admitAgentStartV1(policy, { kind: 'definition_write', leaves: [request.leaf] }, context))
      .toMatchObject({ ok: false, refusal: { code: 'definition_exceeds_authority' } });
    expect(admitAgentStartV1(policy, { ...request, leaf: { ...request.leaf, facts: {
      ...request.leaf.facts, agentTarget: otherTarget,
    } } }, context)).toMatchObject({ ok: false, refusal: { code: 'policy_denied_field', field: 'agentTarget' } });
  });

  it('admits a deferred run at the limit but refuses its later child at the frozen run depth', () => {
    const context: AgentStartContextV1 = { ...baseline,
      caller: { kind: 'session', sessionId: 'lead', starterDepth: 1, turnDepth: 3 } };
    const request = { kind: 'workflow_run_leaf', selection: 'deferred', leaf: {
      ...leaf(), kind: 'action', engine: undefined, actionId: 'review.start',
      facts: { agentTarget: { kind: 'unresolved' } },
    } } as const;
    const run = admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, request, context);
    expect(run).toEqual({ ok: true, stamped: { workDepth: 4 } });
    if (!run.ok) throw new Error(run.refusal.code);
    expect(admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
      { kind: 'workflow_run_leaf', leaf: leaf() }, { ...baseline,
        caller: { kind: 'originless', runId: 'frozen-run', runDepth: run.stamped.workDepth },
      })).toMatchObject({ ok: false, refusal: { code: 'work_depth_exceeded' } });
  });

  it('refuses decidable authority, policy, ceiling and depth violations before deferred selection', () => {
    const request = { kind: 'workflow_run_leaf', selection: 'deferred', targetSessionId: 'worker', leaf: {
      ...leaf(), kind: 'action', engine: undefined, actionId: 'review.start',
      facts: { agentTarget: { kind: 'unresolved' } },
    } } as const;
    expect(admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
      { ...request, targetSessionId: 'stranger' }, baseline))
      .toMatchObject({ ok: false, refusal: { code: 'subtree_denied' } });
    expect(admitAgentStartV1({ ...DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, allowCustomDirectory: false },
      { ...request, leaf: { ...request.leaf, facts: { ...request.leaf.facts, directory: '/elsewhere' } } }, baseline))
      .toMatchObject({ ok: false, refusal: { code: 'policy_denied_field', field: 'directory' } });
    expect(admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
      { ...request, leaf: { ...request.leaf, facts: { ...request.leaf.facts, permissionMode: 'yolo' } } }, baseline))
      .toMatchObject({ ok: false, refusal: { code: 'permission_exceeds_ceiling' } });
    expect(admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, request, { ...baseline,
      caller: { kind: 'session', sessionId: 'lead', starterDepth: 4, turnDepth: 0 },
    })).toMatchObject({ ok: false, refusal: { code: 'work_depth_exceeded' } });
    expect(admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
      { ...request, leaf: { ...request.leaf, roleId: 'missing' } }, baseline))
      .toMatchObject({ ok: false, refusal: { code: 'role_target_unavailable' } });
  });

  it('compares role effort through the canonical reasoning-effort option used by Session and Run starts', () => {
    const context: AgentStartContextV1 = { ...baseline,
      baseline: { ...baseline.baseline, configuration: { ...baseline.baseline.configuration,
        configOptions: { reasoning_effort: { value: 'medium', updatedAtMs: 1 } },
      } },
      roles: { builder: { ...role, engine: { ...engine, effort: 'medium' } } },
    };
    const request: AgentStartRequestV1 = { kind: 'spawn_new', roleId: 'builder', facts: {} };
    const policy = { ...DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, allowConfigOptionOverrides: false };
    expect(admitAgentStartV1(policy, request, context)).toMatchObject({ ok: true, stamped: { engine: { effort: 'medium' } } });
    expect(admitAgentStartV1(policy, request, { ...context,
      roles: { builder: { ...role, engine: { ...engine, effort: 'high' } } },
    })).toMatchObject({ ok: false, refusal: { code: 'policy_denied_field', field: 'configuration.options' } });
  });

  it('enforces allow lists against the effective role and every fan-out engine', () => {
    const denied = accountSettingsParse({ sessionAgentStartAllowListsV1: { allowedRoleIds: [] } });
    expect(admitAgentStartV1(denied.sessionAgentSpawnPolicyV1, { kind: 'spawn_new', roleId: 'builder', facts: {} }, { ...baseline, allowLists: denied.sessionAgentStartAllowListsV1 })).toMatchObject({ ok: false, refusal: { code: 'policy_denied_field', field: 'roleId' } });
    const allowed = accountSettingsParse({ sessionAgentStartAllowListsV1: { allowedRoleIds: ['builder'], allowedAgentTargetKeys: [engine.agentTargetKey] } });
    const context = { ...baseline, allowLists: allowed.sessionAgentStartAllowListsV1 };
    expect(admitAgentStartV1(allowed.sessionAgentSpawnPolicyV1, { kind: 'spawn_new', roleId: 'builder', facts: { agentTarget: otherTarget } }, context)).toMatchObject({ ok: true });
    expect(admitAgentStartV1(allowed.sessionAgentSpawnPolicyV1, { kind: 'execution_run', source: 'review', facts: {}, backendTargets: [target, otherTarget], intent: 'review' }, context)).toMatchObject({ ok: false, refusal: { code: 'policy_denied_field', field: 'agentTarget' } });
  });

  it('checks the Account policy ceiling before caller ceiling, and permissions before depth', () => {
    const request = spawn({ permissionMode: 'yolo' });
    expect(admitAgentStartV1({ ...DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, permissionCeiling: 'default' }, request, baseline)).toMatchObject({ ok: false, refusal: { code: 'policy_denied_field', field: 'permissionMode' } });
    expect(admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, request, { ...baseline, caller: { kind: 'session', sessionId: 'lead', starterDepth: 4, turnDepth: 0 } })).toMatchObject({ ok: false, refusal: { code: 'permission_exceeds_ceiling' } });
    expect(admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, spawn(), { ...baseline, baseline: { ...baseline.baseline, configuration: { ...baseline.baseline.configuration, permissionMode: 'yolo' } } })).toMatchObject({ ok: false, refusal: { code: 'permission_exceeds_ceiling' } });
  });

  it('fails closed on unresolved choices even under unrestricted policy', () => {
    expect(admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, spawn({ machineId: { kind: 'unresolved' } }), baseline)).toMatchObject({ ok: false, refusal: { code: 'target_unavailable' } });
    expect(admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, spawn(), { ...baseline, baseline: { machineId: 'machine', directory: '/workspace' } })).toMatchObject({ ok: false, refusal: { code: 'target_unavailable' } });
  });

  it('derives engine overrides from every actual execution target, not just facts', () => {
    const policy = { ...DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, allowBackendTargetOverride: false };
    const request = { kind: 'execution_run', source: 'review', facts: {}, backendTargets: [target, otherTarget], intent: 'review' } as const;
    expect(admitAgentStartV1(policy, request, baseline)).toMatchObject({ ok: false, refusal: { code: 'policy_denied_field', field: 'agentTarget' } });
    expect(admitAgentStartV1(policy, { ...request, backendTargets: [target] }, baseline)).toMatchObject({ ok: true });
  });

  const restrictions = [
    ['allowCustomDirectory', 'directory', { directory: '/different' }, { directory: { kind: 'unresolved' } }],
    ['allowCrossMachine', 'executionTarget.machineId', { machineId: 'different' }, { machineId: { kind: 'unresolved' } }],
    ['allowBackendTargetOverride', 'agentTarget', { agentTarget: otherTarget }, { agentTarget: { kind: 'unresolved' } }],
    ['allowModelOverride', 'modelSelection', { modelSelection: { ...modelSelection, modelId: 'different' } }, { modelSelection: { kind: 'unresolved' } }],
    ['allowPermissionModeOverride', 'permissionMode', { permissionMode: 'read-only' }, { permissionMode: { kind: 'unresolved' } }],
    ['allowAgentModeOverride', 'agentModeId', { agentModeId: 'plan' }, { agentModeId: { kind: 'unresolved' } }],
    ['allowConfigOptionOverrides', 'configuration.options', { configOptions: { effort: { value: 'high', updatedAtMs: 1 } } }, { configOptions: { kind: 'unresolved' } }],
    ['allowProfileOverride', 'profileId', { profileId: 'different' }, { profileId: { kind: 'unresolved' } }],
    ['allowConnectedServicesOverride', 'connectedServices', { connectedServices: { v: 2, bindingsByServiceId: { 'happier.service.codex/subscription': { source: 'native' } } } }, { connectedServices: { kind: 'unresolved' } }],
    ['allowMcpSelectionOverride', 'mcpSelection', { mcpSelection: { v: 1, managedServersEnabled: false, forceIncludeServerIds: [], forceExcludeServerIds: [] } }, { mcpSelection: { kind: 'unresolved' } }],
    ['allowTranscriptStorageOverride', 'transcriptStorage', { transcriptStorage: 'direct' }, { transcriptStorage: { kind: 'unresolved' } }],
  ] satisfies ReadonlyArray<readonly [keyof typeof DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, string, AgentStartFactsV1, AgentStartFactsV1]>;
  it.each(restrictions)('checks authoring %s facts and unresolved selections per leaf', (flag, field, changed, unresolved) => {
    for (const kind of ['definition_write', 'trigger_write'] as const) {
      for (const facts of [changed, unresolved]) {
        const request: AgentStartRequestV1 = kind === 'definition_write' ? { kind, leaves: [leaf(), leaf(facts)] } : { kind, scope: 'workflow', leaves: [leaf(), leaf(facts)] };
        expect(admitAgentStartV1({ ...DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, [flag]: false }, request, baseline)).toMatchObject({ ok: false, refusal: { code: 'definition_exceeds_authority', blockId: 'block', cause: { code: 'policy_denied_field', field } } });
      }
    }
  });

  it('checks authoring role, engine allow-list and permission ceiling per leaf', () => {
    const request = (value: MaterializedWorkflowLeafV1): AgentStartRequestV1 => ({ kind: 'definition_write', leaves: [leaf(), value] });
    expect(admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, request({ ...leaf(), roleId: 'missing' }), baseline)).toMatchObject({ ok: false, refusal: { code: 'definition_exceeds_authority', cause: { code: 'role_target_unavailable' } } });
    const restricted = accountSettingsParse({ sessionAgentStartAllowListsV1: { allowedAgentTargetKeys: [engine.agentTargetKey] } });
    expect(admitAgentStartV1(restricted.sessionAgentSpawnPolicyV1, request({ ...leaf({ agentTarget: otherTarget }), engine: { agentTargetKey: buildBackendTargetKeyV2(otherTarget) } }), { ...baseline, allowLists: restricted.sessionAgentStartAllowListsV1 })).toMatchObject({ ok: false, refusal: { code: 'definition_exceeds_authority', cause: { code: 'policy_denied_field', field: 'agentTarget' } } });
    expect(admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, request(leaf({ permissionMode: 'yolo' })), baseline)).toMatchObject({ ok: false, refusal: { code: 'definition_exceeds_authority', cause: { code: 'permission_exceeds_ceiling' } } });
  });

  it('follows the two depth examples and refuses the fifth session or run edge', () => {
    for (let depth = 0; depth <= 4; depth++) {
      for (const caller of [{ kind: 'session', sessionId: 'lead', starterDepth: depth, turnDepth: 0 }, { kind: 'originless', runId: 'run', runDepth: depth }] as const) {
        const result = admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, spawn({ agentTarget: target }), { ...baseline, caller });
        expect(result).toMatchObject(depth === 4 ? { ok: false, refusal: { code: 'work_depth_exceeded' } } : { ok: true, stamped: { workDepth: depth + 1 } });
      }
    }
    const caller = { kind: 'session', sessionId: 'lead', starterDepth: 1, turnDepth: 4 } as const;
    expect(admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, spawn(), { ...baseline, caller })).toMatchObject({ ok: false, refusal: { code: 'work_depth_exceeded' } });
  });

  it('applies depth to workflow leaves and trigger writes but exempts definition writes', () => {
    const context: AgentStartContextV1 = { ...baseline, caller: { kind: 'originless', runId: 'run', runDepth: 4 } };
    for (const request of [{ kind: 'workflow_run_leaf', leaf: leaf() }, { kind: 'trigger_write', scope: 'workflow', leaves: [] }] satisfies AgentStartRequestV1[]) expect(admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, request, context)).toMatchObject({ ok: false, refusal: { code: 'work_depth_exceeded' } });
    expect(admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, { kind: 'definition_write', leaves: [leaf()] }, context)).toMatchObject({ ok: true });
  });

  it.each(['execution_run', 'review', 'subagents_plan', 'subagents_delegate', 'voice_agent'] as const)('admits the %s request through the same ceiling and depth owner', (source) => {
    const request: AgentStartRequestV1 = { kind: 'execution_run', source, facts: {}, backendTargets: [target], intent: 'delegate' };
    expect(admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, request, baseline)).toMatchObject({ ok: true, stamped: { engine: { agentTargetKey: engine.agentTargetKey }, intent: 'delegate', workDepth: 1 } });
    expect(admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, request, { ...baseline, caller: { kind: 'session', sessionId: 'lead', starterDepth: 4, turnDepth: 0 } })).toMatchObject({ ok: false, refusal: { code: 'work_depth_exceeded' } });
  });

  it('defaults work depth to four and retains user-selected nonnegative limits', () => {
    expect(accountSettingsParse({}).workDepthLimit).toBe(4);
    expect(accountSettingsParse({ workDepthLimit: 0 }).workDepthLimit).toBe(0);
    expect(accountSettingsParse({ workDepthLimit: 8 }).workDepthLimit).toBe(8);
  });

  it('admits role identity through the canonical Session and Run request boundaries', () => {
    const session = { executionTarget: { serverId: 'server', machineId: 'machine' }, directory: { kind: 'path', path: '/workspace' } as const, agentTarget: target };
    const run = { intent: 'delegate', backendTarget: target, permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response' };
    expect(SessionSpawnNewInputV2Schema.parse({ ...session, roleId: 'builder' }).roleId).toBe('builder');
    expect(ExecutionRunStartRequestBaseSchema.parse({ ...run, roleId: 'reviewer' }).roleId).toBe('reviewer');
    expect(SessionSpawnNewInputV2Schema.safeParse({ ...session, roleId: '' }).success).toBe(false);
    expect(ExecutionRunStartRequestBaseSchema.safeParse({ ...run, roleId: '' }).success).toBe(false);
  });
});
