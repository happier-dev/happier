import { describe, expect, it } from 'vitest';
import { admitActionAgentStartV1, resolveActionAgentStartRequestsV1, resolveRunStartModelAndConfig, stampAgentStartSelectionV1 } from './agentStartAdmission.js';
import { ProviderBoundModelRefSchema } from '../../providers/selection/v1.js';
import { DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1 } from '../../account/settings/sessionAgentSpawnPolicyV1.js';
import { ExecutionRunStartRequestSchema } from '../../execution/runs/startRequest.js';
import type { AgentStartContextV1 } from '../../account/settings/admitAgentStartV1.js';

const nativeTarget = { kind: 'agent' as const, identity: { pluginId: 'native.agent', localId: 'agent' } };
const roleTarget = { kind: 'agent' as const, identity: { pluginId: 'role.agent', localId: 'agent' } };

describe('canonical Action agent-start adapter', () => {
  it('binds a task role engine and Launch Profile through real execution-run admission', () => {
    const context: AgentStartContextV1 = {
      caller: { kind: 'session', sessionId: 'lead', starterDepth: 0, turnDepth: 0 },
      baseline: { machineId: 'machine', directory: '/repo', configuration: { agentTarget: nativeTarget } },
      roles: { approval_reviewer: { roleId: 'approval_reviewer', name: 'Approval reviewer', instructions: 'Role review instructions',
        engine: { agentTargetKey: 'agent:role.agent/agent', modelId: 'review-model', effort: 'high' },
        profileId: 'review-launch-profile', runsAs: { kind: 'background_run', intent: 'task' },
        workspaceWrites: 'deny', secondOpinion: 'off', enabled: true } },
      ledSubtreeSessionIds: [], workDepthLimit: 4, callerPermissionCeiling: 'default',
    };
    const requested = { roleId: 'approval_reviewer', backendTarget: nativeTarget, intent: 'task',
      instructions: 'Assess this pending tool request.', permissionMode: 'no_tools',
      retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response' };
    const resolved = resolveActionAgentStartRequestsV1({ actionId: 'execution.run.start',
      input: requested, context: {}, baseline: context.baseline });
    if (!resolved.ok) throw new Error(resolved.errorCode);
    const request = resolved.requests[0];
    if (!request) throw new Error('expected_execution_start');
    const admitted = admitActionAgentStartV1({}, request, context);
    if (!admitted.ok) throw new Error(admitted.refusal.code);
    const bound = stampAgentStartSelectionV1(resolved.effectiveInput, admitted.stamped, 'execution_run', context);
    expect(ExecutionRunStartRequestSchema.safeParse(bound).success).toBe(true);
    expect(bound).toMatchObject({ roleId: 'approval_reviewer', backendTarget: roleTarget,
      modelId: 'review-model', launchProfileId: 'review-launch-profile', permissionMode: 'no_tools',
      sessionConfigOptionOverrides: { overrides: { reasoning_effort: { value: 'high' } } },
      instructions: requested.instructions });
    expect(bound).not.toHaveProperty('profileId');
    expect(admitted.stamped).toMatchObject({ workDepth: 1, workspaceWrites: 'deny' });
  });

  it('normalizes shorthand scalar configuration through the shared alias contract', () => {
    expect(resolveRunStartModelAndConfig({ modelId: '  model  ', configOptions: {
      text: 'value', count: 3, enabled: false, unset: null,
    } })).toMatchObject({ ok: true, options: { modelId: 'model', sessionConfigOptionOverrides: {
      overrides: { text: { value: 'value' }, count: { value: 3 }, enabled: { value: false }, unset: { value: null } },
    } } });
    for (const value of [NaN, Infinity, undefined, {}]) {
      expect(resolveRunStartModelAndConfig({ configOptions: { invalid: value } })).toEqual({ ok: true, options: {} });
    }
    expect(resolveRunStartModelAndConfig({ configOptions: { text: 'alias' },
      sessionConfigOptionOverrides: { v: 1, updatedAt: 1, overrides: { text: { updatedAt: 1, value: 'canonical' } } },
    })).toEqual({ ok: false });
  });
  it('passes deferred workflow selection to the owner and returns a typed frozen-depth child refusal', () => {
    const request = { kind: 'workflow_run_leaf', selection: 'deferred', leaf: {
      blockId: 'panel', kind: 'action', actionId: 'subagents.plan.start',
      runsAs: { kind: 'background_run', intent: 'plan' }, workspaceWrites: 'deny',
      facts: { agentTarget: { kind: 'unresolved' } },
    } } as const;
    const context = { caller: { kind: 'session', sessionId: 'lead', starterDepth: 3, turnDepth: 0 },
      baseline: { machineId: 'run-machine', directory: '/repo' }, roles: {},
      ledSubtreeSessionIds: [], workDepthLimit: 4, callerPermissionCeiling: 'default',
    } as const;
    const result = admitActionAgentStartV1({}, request, context);
    expect(result).toEqual({ ok: true, stamped: { workDepth: 4 } });
    if (!result.ok) throw new Error(result.refusal.code);
    expect(admitActionAgentStartV1({}, { kind: 'workflow_run_leaf', leaf: {
      ...request.leaf, facts: { agentTarget: nativeTarget },
    } }, { ...context, caller: { kind: 'originless', runId: 'frozen-run', runDepth: result.stamped.workDepth } }))
      .toMatchObject({ ok: false, refusal: { code: 'work_depth_exceeded' },
        error: { errorCode: 'work_depth_exceeded', details: { code: 'work_depth_exceeded' } } });
  });

  it.each([{ FEATURE_FLAG: 'enabled' }, {}])('keeps explicit spawn environments subject to the single admission owner: %j', (environmentVariables) => {
    const result = resolveActionAgentStartRequestsV1({ actionId: 'session.spawn_new', input: {
      executionTarget: { serverId: 'server', machineId: 'run-machine' }, directory: { kind: 'path', path: '/repo' },
      agentTarget: nativeTarget, environmentVariables,
    }, context: {}, baseline: { machineId: 'run-machine', directory: '/repo' } });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.errorCode);
    const request = result.requests[0];
    if (!request) throw new Error('expected_spawn_request');
    expect(admitActionAgentStartV1({ sessionAgentSpawnPolicyV1: {
      ...DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, allowEnvironmentVariables: false,
    } }, request, {
      caller: { kind: 'session', sessionId: 'lead', starterDepth: 0, turnDepth: 0 },
      baseline: { machineId: 'run-machine', directory: '/repo', configuration: { agentTarget: nativeTarget } },
      roles: {}, ledSubtreeSessionIds: [], workDepthLimit: 4, callerPermissionCeiling: 'default',
    })).toMatchObject({ ok: false, refusal: { code: 'policy_denied_field', field: 'environmentVariables' },
      error: { errorCode: 'policy_denied_field', details: { field: 'environmentVariables' } } });
  });

  it('preserves a typed ORC refusal for shared materializer admission', () => {
    expect(admitActionAgentStartV1({}, { kind: 'session_target', targetSessionId: 'target' }, null))
      .toMatchObject({ ok: false, refusal: { code: 'target_unavailable' }, error: { errorCode: 'target_unavailable' } });
  });

  it.each([false, true])('projects frozen selection while respecting explicit native Action targets: role=%s', (overrideEngine) => {
    const result = resolveActionAgentStartRequestsV1({ actionId: 'execution.run.start',
      input: { backendTarget: nativeTarget, intent: 'delegate', modelId: 'native-model', profileId: 'native-execution-profile' }, context: {},
      baseline: { machineId: 'run-machine', directory: '/repo' },
      effectiveSelection: { overrideEngine, selection: { agentTarget: roleTarget, profileId: 'portable-profile',
        modelSelection: { v: 1, updatedAt: 0, ref: { agentTargetKey: 'agent:role.agent/agent', providerConnectionId: null, modelId: 'role-model' } } } },
    });
    expect(result).toMatchObject({ ok: true, requests: [{ kind: 'execution_run', backendTargets: [overrideEngine ? roleTarget : nativeTarget],
      facts: { agentTarget: overrideEngine ? roleTarget : nativeTarget, profileId: 'portable-profile',
        modelSelection: { modelId: overrideEngine ? 'role-model' : 'native-model' } } }] });
    expect(result).toMatchObject({ ok: true, effectiveInput: { backendTarget: overrideEngine ? roleTarget : nativeTarget,
      profileId: 'native-execution-profile', modelId: overrideEngine ? 'role-model' : 'native-model' } });
  });

  it('supplies a missing native spawn target from the frozen selection', () => {
    const result = resolveActionAgentStartRequestsV1({ actionId: 'session.spawn_new', input: {
      executionTarget: { serverId: 'server', machineId: 'run-machine' }, directory: { kind: 'path', path: '/repo' },
    }, context: {},
      baseline: { machineId: 'run-machine', directory: '/repo' }, effectiveSelection: { selection: { agentTarget: roleTarget } } });
    expect(result).toMatchObject({ ok: true, requests: [{ kind: 'spawn_new', facts: { agentTarget: roleTarget } }] });
  });

  it('admits known spawn policy facts while its nonauthority initial input remains dynamic', () => {
    const result = resolveActionAgentStartRequestsV1({ actionId: 'session.spawn_new', input: {
      executionTarget: { serverId: 'server', machineId: 'run-machine' }, directory: { kind: 'path', path: '/repo' },
      agentTarget: nativeTarget, initialInput: { text: { kind: 'input', name: 'task' } },
    }, context: {}, baseline: { machineId: 'run-machine', directory: '/repo' } });
    expect(result).toMatchObject({ ok: true, requests: [{ kind: 'spawn_new', facts: {
      agentTarget: nativeTarget, machineId: 'run-machine', directory: '/repo',
    } }], effectiveInput: { initialInput: { text: { kind: 'input', name: 'task' } } } });
  });

  it('does not borrow a Workflow default model from another explicit Action Agent', () => {
    const result = resolveActionAgentStartRequestsV1({ actionId: 'execution.run.start',
      input: { backendTarget: nativeTarget, intent: 'delegate' }, context: {},
      baseline: { machineId: 'run-machine', directory: '/repo' }, effectiveSelection: { selection: {
        agentTarget: roleTarget, modelSelection: { v: 1, updatedAt: 0,
          ref: { agentTargetKey: 'agent:role.agent/agent', providerConnectionId: null, modelId: 'other-agent-model' } },
      } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.errorCode);
    expect(result.requests[0]).toMatchObject({ facts: { agentTarget: nativeTarget } });
    const request = result.requests[0];
    if (!request || request.kind !== 'execution_run') throw new Error('expected_execution_start');
    expect(request.facts.modelSelection).toBeUndefined();
    expect(result.effectiveInput.modelSelection).toBeUndefined();
  });

  it('freezes a native-compatible flat execution Action model from the Workflow selection', () => {
    const model = { agentTargetKey: 'agent:native.agent/agent', providerConnectionId: null, modelId: 'workflow-model' };
    const result = resolveActionAgentStartRequestsV1({ actionId: 'execution.run.start',
      input: { backendTarget: nativeTarget, intent: 'delegate' }, context: {},
      baseline: { machineId: 'run-machine', directory: '/repo' },
      effectiveSelection: { selection: { agentTarget: nativeTarget, modelSelection: { v: 1, updatedAt: 0, ref: model } } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.errorCode);
    expect(ProviderBoundModelRefSchema.safeParse(result.effectiveInput.modelSelection).success).toBe(true);
    expect(result.effectiveInput.modelSelection).toEqual(model);
    expect(result.requests[0]).toMatchObject({ facts: { modelSelection: model } });
  });

  it('refuses a role fanout whose distinct keyed connections cannot survive its target projection', () => {
    const result = resolveActionAgentStartRequestsV1({ actionId: 'subagents.delegate.start', context: {},
      baseline: { machineId: 'run-machine', directory: '/repo' },
      input: { backendTargetKeys: ['agent:native.agent/agent', 'agent:other.agent/agent'],
        connectedServicesByBackendTargetKey: { 'agent:native.agent/agent': 'openai:profile-a',
          'agent:other.agent/agent': 'anthropic:profile-b' } },
      effectiveSelection: { overrideEngine: true, selection: { agentTarget: roleTarget } },
    });
    expect(result).toEqual({ ok: false, errorCode: 'target_unavailable' });
  });
});
