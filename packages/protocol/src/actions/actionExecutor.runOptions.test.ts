import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { buildAcpConfigOptionOverridesV1 } from '../sessions/metadata/metadataOverridesV1.js';
import { buildBackendTargetKeyV2, parseBackendTargetKeyV2 } from '../backends/targets/backendTargetRefV2.js';
import { ExecutionRunStartRequestSchema } from '../execution/runs/startRequest.js';
import { projectActionWorkflowSelectionInputV1 } from './executor/agentStartAdmission.js';

function createDeps(overrides: Partial<ActionExecutorDeps> = {}): ActionExecutorDeps {
  return {
    executionRunCheckProtocolV2: async () => ({ ok: true, exactMachineId: 'm1' }),
    executionRunStart: vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' })),
    executionRunList: vi.fn(async () => ({})),
    executionRunGet: vi.fn(async () => ({})),
    detachedExecutionRunSend: vi.fn(async () => ({})),
    executionRunStop: vi.fn(async () => ({})),
    executionRunAction: vi.fn(async () => ({})),
    executionRunWait: vi.fn(async () => ({})),
    sessionOpen: vi.fn(async () => ({})),
    sessionFork: vi.fn(async () => ({})),
    sessionRollback: vi.fn(async () => ({})),
    sessionSpawnNew: vi.fn(async () => ({})),
    resolveAgentStartContext: async () => START_CONTEXT,
    pathsListRecent: vi.fn(async () => ({ items: [] })),
    machinesList: vi.fn(async () => ({ items: [] })),
    serversList: vi.fn(async () => ({ items: [] })),
    reviewEnginesList: vi.fn(async () => ({ items: [] })),
    agentsBackendsList: vi.fn(async () => ({ items: [] })),
    agentsModelsList: vi.fn(async () => ({ items: [] })),
    sessionSendMessage: vi.fn(async () => ({})),
    sessionPermissionRespond: vi.fn(async () => ({})),
    sessionUserActionAnswer: vi.fn(async () => ({})),
    sessionModeSet: vi.fn(async () => ({})),
    sessionModesList: vi.fn(async () => ({ items: [] })),
    sessionTargetPrimarySet: vi.fn(async () => ({})),
    sessionTargetTrackedSet: vi.fn(async () => ({})),
    sessionList: vi.fn(async () => ({})),
    sessionActivityGet: vi.fn(async () => ({})),
    sessionRecentMessagesGet: vi.fn(async () => ({})),
    resetGlobalVoiceAgent: vi.fn(),
    ...overrides,
  };
}

/**
 * DEC-2 / INV-1: Action surface resolution fails closed (see `actionSurfaceFailClosed.test.ts`),
 * so a call site must stamp the caller it models. These execution-run tests model the present-user
 * host that owns the executor — `apps/ui/sources/sync/ops/actions/defaultActionExecutor.ts` stamps
 * `'ui'`. The internal envelope-normalization case below models the execution-run RPC dispatcher
 * (`apps/cli/src/rpc/handlers/executionRuns/dispatchExecutionRunRpcAction.ts` stamps `'agent'`
 * together with its exact current-Session corpus), which is the only production caller of the
 * agent-only `execution.run.ensure`.
 */
const UI_CALLER = { surface: 'ui' } as const;
const ACTIVE_TURN_AUTHORITY = {
  kind: 'admittedSessionInputV1',
  admittedPermissionCeiling: 'read-only',
} as const;
const RUN_DISPATCHER_CALLER = {
  surface: 'agent',
  defaultSessionId: 's1',
  sessionListAccess: 'current_session',
  callerPermissionMode: 'yolo',
  causalPermissionAuthority: ACTIVE_TURN_AUTHORITY,
} as const;

const RUN_START_BASE = {
  sessionId: 's1',
  intent: 'delegate',
  backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
  instructions: 'do it',
  permissionMode: 'read_only',
  retentionPolicy: 'ephemeral',
  runClass: 'bounded',
  ioMode: 'request_response',
} as const;

const START_CONTEXT = {
  caller: { kind: 'session', sessionId: 's1', starterDepth: 0, turnDepth: 0 },
  baseline: { machineId: 'm1', directory: '/workspace' },
  ledSubtreeSessionIds: [],
  workDepthLimit: 4,
  roles: {},
  callerPermissionCeiling: 'read-only',
} as const;
const START_TARGET_KEY = buildBackendTargetKeyV2({ kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } });

it('admits a scalar review engine and qualified Team selection through canonical target identity', async () => {
  const deps = createDeps({ reviewEnginesList: async () => ({ items: [{ value: 'claude', label: 'Claude' }] }),
    executionRunCheckProtocolV2: async () => ({ ok: true, exactMachineId: 'm1' }) });
  const selection = { kind: 'team_credential_provider_model', teamId: 'team-1', resourceId: 'resource-1',
    expectedResourceRevision: 3, deliveryMode: 'brokered',
    agentTargetKey: buildBackendTargetKeyV2({ kind: 'backend', backendId: 'claude' }), modelId: 'team-model' } as const;
  const result = await createActionExecutor(deps).execute('review.start', {
    sessionId: 's1', engineIds: ['claude'], instructions: 'Review', modelId: 'team-model', teamCredentialModel: selection,
  }, UI_CALLER);
  expect(result).toMatchObject({ ok: true, result: { results: [{ ok: true }] } });
  expect(vi.mocked(deps.executionRunStart).mock.calls[0]?.[1]).toMatchObject({ teamCredentialModel: selection });
});

it.each([{}, { modelId: 'custom-native' }, { modelSelection: null },
  { modelSelection: { agentTargetKey: START_TARGET_KEY, providerConnectionId: 'connection-1', modelId: 'model-1' } }])(
  'admits attached child choices without a separate inheritance capability: %j', async (selection) => {
    const deps = createDeps({ executionRunCheckProtocolV2: undefined });
    expect(await createActionExecutor(deps).execute('execution.run.start', {
      ...RUN_START_BASE, ...selection,
    }, UI_CALLER)).toMatchObject({ ok: true });
    expect(deps.executionRunStart).toHaveBeenCalledWith('s1', expect.objectContaining(selection), undefined);
  },
);

it('admits fully explicit native selections without an inheritance capability', async () => {
  const deps = createDeps({ executionRunCheckProtocolV2: undefined });
  expect(await createActionExecutor(deps).execute('execution.run.start', {
    ...RUN_START_BASE, modelId: 'custom-native', connectedServices: null,
  }, UI_CALLER)).toMatchObject({ ok: true });
  expect(deps.executionRunStart).toHaveBeenCalledOnce();
});

it.each(['review.start', 'subagents.plan.start', 'subagents.delegate.start', 'voice_agent.start'] as const)(
  'refuses a credential-bearing model tuple at %s ingress before any host effect', async (actionId) => {
    const deps = createDeps();
    const result = await createActionExecutor(deps).execute(actionId, {
      sessionId: 's1', instructions: 'Use this model',
      [actionId === 'review.start' ? 'engineIds' : 'backendTargetKeys']: [actionId === 'review.start' ? 'codex' : START_TARGET_KEY],
      modelSelection: { agentTargetKey: START_TARGET_KEY, providerConnectionId: null, modelId: 'native-model', accessToken: 'must-not-cross' },
    }, UI_CALLER);
    expect(result).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(deps.executionRunStart).not.toHaveBeenCalled();
  },
);

it.each(['execution.run.start', 'review.start', 'subagents.plan.start', 'subagents.delegate.start', 'voice_agent.start'] as const)(
  'preserves a Workflow native reset through %s to the receiving host instead of inheriting', async (actionId) => {
    const received: unknown[] = [];
    const deps = createDeps({ reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex' }] }),
      executionRunStart: async (_sessionId, input) => {
      received.push(ExecutionRunStartRequestSchema.parse(input));
      return { runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' };
    } });
    const input = projectActionWorkflowSelectionInputV1(actionId, actionId === 'execution.run.start'
      ? RUN_START_BASE
      : { sessionId: 's1', instructions: 'Use native settings',
          [actionId === 'review.start' ? 'engineIds' : 'backendTargetKeys']: [actionId === 'review.start' ? 'codex' : START_TARGET_KEY] },
      { modelSelection: null });
    expect(await createActionExecutor(deps).execute(actionId, input, UI_CALLER)).toMatchObject(
      actionId === 'execution.run.start' ? { ok: true } : { ok: true, result: { results: [{ ok: true }] } },
    );
    expect(received).toMatchObject([{ modelSelection: null }]);
  },
);

it.each(['subagents.plan.start', 'subagents.delegate.start', 'voice_agent.start', 'review.start'] as const)(
  'round-trips a contributed Agent option through %s admission and dispatch', async (actionId) => {
    const agentTarget = { kind: 'agent', identity: { pluginId: 'acme.review', localId: 'reviewer' } } as const;
    const key = buildBackendTargetKeyV2(agentTarget);
    const deps = createDeps({
      reviewEnginesList: async () => ({ items: [{ targetKey: key, label: 'Plugin reviewer' }] }),
      agentsBackendsList: async () => ({ items: [{ targetKey: key, label: 'Plugin reviewer', enabled: true,
        agentId: 'acme.review/reviewer', identity: agentTarget.identity }] }),
    });
    const executor = createActionExecutor(deps);
    const fieldPath = actionId === 'review.start' ? 'engineIds' : 'backendTargetKeys';
    const options = await executor.execute('action.options.resolve', { actionId, fieldPath, sessionId: 's1' }, UI_CALLER);
    expect(options).toMatchObject({ ok: true, result: { options: [{ value: key }] } });
    const result = await executor.execute(actionId, { sessionId: 's1', instructions: 'Review the plan',
      [fieldPath]: [key] }, { ...UI_CALLER, agentStartContext: START_CONTEXT });
    expect(result).toMatchObject({ ok: true, result: { results: [{ ok: true }] } });
    expect(vi.mocked(deps.executionRunStart).mock.calls[0]?.[1]).toMatchObject({ backendTarget: agentTarget });
  },
);

it('round-trips the contributed Agent option into session creation and a direct execution run', async () => {
  const identity = { pluginId: 'acme.review', localId: 'reviewer' };
  const key = buildBackendTargetKeyV2({ kind: 'agent', identity });
  const deps = createDeps({
    agentsBackendsList: async () => ({ items: [{ targetKey: key, label: 'Plugin reviewer', enabled: true }] }),
    sessionSpawnNew: vi.fn(async () => ({ type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' })),
  });
  const executor = createActionExecutor(deps);
  expect(await executor.execute('action.options.resolve', {
    actionId: 'session.spawn_new', fieldPath: 'agentTarget',
  }, UI_CALLER)).toMatchObject({ ok: true, result: { options: [{ value: key }] } });
  const target = parseBackendTargetKeyV2(key);
  expect(target).toEqual({ kind: 'agent', identity });
  const spawnResult = await executor.execute('session.spawn_new', {
    creationKey: 'contributed-option-roundtrip',
    executionTarget: { serverId: 'server-1', machineId: 'm1' },
    directory: { kind: 'path', path: '/workspace' },
    organizationPlacement: { folderId: null, tagIds: [] },
    agentTarget: target,
  }, { ...UI_CALLER, authority: 'present_user' });
  expect(spawnResult.ok, JSON.stringify(spawnResult)).toBe(true);
  expect(vi.mocked(deps.sessionSpawnNew).mock.calls[0]?.[0]).toMatchObject({ agentTarget: target });
  expect(await executor.execute('execution.run.start', {
    ...RUN_START_BASE, backendTarget: target,
  }, UI_CALLER)).toMatchObject({ ok: true });
  expect(vi.mocked(deps.executionRunStart).mock.calls[0]?.[1]).toMatchObject({ backendTarget: target });
});

it.each(['subagents.plan.start', 'subagents.delegate.start'] as const)(
  'preserves both report chip values through %s fan-out', async (actionId) => {
    for (const notifyParentOnCompletion of [true, false]) {
      const deps = createDeps();
      const result = await createActionExecutor(deps).execute(actionId, {
        sessionId: 's1', backendTargetKeys: [START_TARGET_KEY], instructions: 'Do the work',
        notifyParentOnCompletion,
      }, UI_CALLER);
      expect(result).toMatchObject({ ok: true });
      expect(vi.mocked(deps.executionRunStart).mock.calls[0]?.[1]).toMatchObject({ notifyParentOnCompletion });
    }
  },
);

it.each(['subagents.plan.start', 'subagents.delegate.start'] as const)(
  'rejects a malformed report value before %s dispatch', async (actionId) => {
    const deps = createDeps();
    expect(await createActionExecutor(deps).execute(actionId, {
      sessionId: 's1', backendTargetKeys: [START_TARGET_KEY], instructions: 'Do the work',
      notifyParentOnCompletion: 'false',
    }, UI_CALLER)).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(deps.executionRunStart).not.toHaveBeenCalled();
  },
);

it('compares actual selections and carries admitted depth only as host context', async () => {
  const deps = createDeps();
  const executor = createActionExecutor(deps);
  const result = await executor.execute('execution.run.start', RUN_START_BASE, {
    ...RUN_DISPATCHER_CALLER,
    sessionAgentSpawnPolicyV1: { allowBackendTargetOverride: false },
    agentStartContext: { ...START_CONTEXT, baseline: {
      ...START_CONTEXT.baseline, configuration: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } },
    }, caller: { ...START_CONTEXT.caller, starterDepth: 2 } },
  });
  expect(result).toMatchObject({ ok: true });
  expect(deps.executionRunStart).toHaveBeenCalledWith('s1', expect.not.objectContaining({ workDepth: expect.anything() }), expect.objectContaining({ workDepth: 3 }));
});

it('fails closed when the host cannot resolve an agent start baseline', async () => {
  const deps = createDeps({ resolveAgentStartContext: async () => null });
  const result = await createActionExecutor(deps).execute('execution.run.start', RUN_START_BASE, RUN_DISPATCHER_CALLER);
  expect(result).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
  expect(deps.executionRunStart).not.toHaveBeenCalled();
});

it('admits the actual per-engine connected-service selections before fan-out dispatch', async () => {
  const deps = createDeps();
  const result = await createActionExecutor(deps).execute('subagents.plan.start', {
    sessionId: 's1', backendTargetKeys: [START_TARGET_KEY], instructions: 'Plan',
    connectedServicesByBackendTargetKey: { [START_TARGET_KEY]: { v: 2, bindingsByServiceId: {
      'happier.service.codex/subscription': { source: 'native' },
    } } },
  }, { ...RUN_DISPATCHER_CALLER, sessionAgentSpawnPolicyV1: { allowConnectedServicesOverride: false } });
  expect(result).toMatchObject({ ok: false, errorCode: 'policy_denied_field', details: { field: 'connectedServices' } });
  expect(deps.executionRunStart).not.toHaveBeenCalled();
});

it.each([
  ['execution.run.start', RUN_START_BASE],
  ['review.start', { sessionId: 's1', engineIds: ['codex'], instructions: 'review' }],
  ['subagents.plan.start', { sessionId: 's1', backendTargetKeys: [START_TARGET_KEY], instructions: 'plan' }],
  ['subagents.delegate.start', { sessionId: 's1', backendTargetKeys: [START_TARGET_KEY], instructions: 'delegate' }],
  ['voice_agent.start', { sessionId: 's1', backendTargetKeys: [START_TARGET_KEY], instructions: 'assist' }],
] as const)('refuses %s before dispatch at the Account work depth limit', async (actionId, input) => {
  const deps = createDeps();
  const executor = createActionExecutor(deps);
  const result = await executor.execute(actionId, input, {
    ...RUN_DISPATCHER_CALLER,
    agentStartContext: { ...START_CONTEXT, caller: { ...START_CONTEXT.caller, turnDepth: 4 } },
  });
  expect(result).toMatchObject({ ok: false, errorCode: 'work_depth_exceeded' });
  expect(deps.executionRunStart).not.toHaveBeenCalled();
});

it('stamps a role engine over the requested engine and refuses a role with incompatible runs-as', async () => {
  const deps = createDeps({ executionRunCheckProtocolV2: async () => ({ ok: true }) });
  const executor = createActionExecutor(deps);
  const role = {
    roleId: 'reviewer', name: 'Reviewer', instructions: 'Inspect', enabled: true,
    engine: { agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'role-model' },
    runsAs: { kind: 'background_run', intent: 'review' },
    workspaceWrites: 'deny', secondOpinion: 'off',
  } as const;
  const result = await executor.execute('execution.run.start', {
    ...RUN_START_BASE, roleId: 'reviewer', modelId: 'caller-model',
  }, { ...RUN_DISPATCHER_CALLER, agentStartContext: { ...START_CONTEXT, roles: { reviewer: role },
    baseline: { ...START_CONTEXT.baseline, configuration: {
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      modelSelection: { agentTargetKey: role.engine.agentTargetKey, providerConnectionId: 'conn-1', modelId: 'base-model' },
    } },
  } });
  expect(result).toMatchObject({ ok: true });
  expect(deps.executionRunStart).toHaveBeenCalledWith('s1', expect.objectContaining({
    intent: 'review', modelId: 'role-model',
    modelSelection: { agentTargetKey: role.engine.agentTargetKey, providerConnectionId: 'conn-1', modelId: 'role-model' },
  }), expect.anything());
  const mismatch = await executor.execute('execution.run.start', {
    ...RUN_START_BASE, roleId: 'reviewer',
  }, { ...RUN_DISPATCHER_CALLER, agentStartContext: {
    ...START_CONTEXT, roles: { reviewer: { ...role, runsAs: { kind: 'session' } } },
  } });
  expect(mismatch).toMatchObject({ ok: false, errorCode: 'role_runs_as_mismatch' });
});

it.each(['execution.run.start', 'review.start', 'subagents.plan.start', 'subagents.delegate.start'] as const)(
  'refuses role-bound %s on a target without run-scoped binding support', async (actionId) => {
    const deps = createDeps({
      executionRunCheckProtocolV2: async () => ({ ok: false, errorCode: 'execution_run_protocol_unsupported', error: 'execution_run_protocol_unsupported' }),
      reviewEnginesList: async () => ({ items: [{ id: START_TARGET_KEY, enabled: true }] }),
    });
    const input = actionId === 'execution.run.start' ? RUN_START_BASE
      : actionId === 'review.start' ? { sessionId: 's1', engineIds: [START_TARGET_KEY], instructions: 'Review' }
      : { sessionId: 's1', backendTargetKeys: [START_TARGET_KEY], instructions: 'Task' };
    for (const binding of [{ roleId: 'scout' }, { launchProfileId: 'launch-profile' }]) {
      expect(await createActionExecutor(deps).execute(actionId, { ...input, ...binding }, {
        ...UI_CALLER, authority: 'present_user', defaultSessionId: 's1',
      })).toMatchObject({ ok: false, errorCode: 'execution_run_protocol_unsupported' });
    }
    expect(deps.executionRunStart).not.toHaveBeenCalled();
  },
);

it.each(['execution.run.start', 'review.start', 'subagents.plan.start', 'subagents.delegate.start'] as const)(
  'binds the resolved role through %s, including the Launch Profile without replacing the execution Profile', async (actionId) => {
    const role = { roleId: 'bounded-worker', name: 'Bounded worker', instructions: 'Resolved role instructions', enabled: true,
      engine: { agentTargetKey: START_TARGET_KEY, modelId: 'role-model', effort: 'high' },
      runsAs: { kind: 'background_run', intent: 'task' }, profileId: 'launch-profile',
      workspaceWrites: 'deny', secondOpinion: 'off' } as const;
    const deps = createDeps({ executionRunCheckProtocolV2: async () => ({ ok: true }),
      reviewEnginesList: vi.fn(async () => ({ items: [{ id: START_TARGET_KEY, enabled: true }] })) });
    const input = actionId === 'execution.run.start' ? RUN_START_BASE
      : actionId === 'review.start' ? { sessionId: 's1', engineIds: ['codex'], instructions: 'Review' }
      : { sessionId: 's1', backendTargetKeys: [START_TARGET_KEY], instructions: 'Task' };
    const profileSourceCustody = { kind: 'development', registeredRootId: 'execution-profile-root' } as const;
    const result = await createActionExecutor(deps).execute(actionId, { ...input, roleId: role.roleId,
      profileId: 'example.execution-profile', profileSourceCustody }, {
      ...RUN_DISPATCHER_CALLER, agentStartContext: { ...START_CONTEXT, roles: { [role.roleId]: role } },
    });
    expect(result).toMatchObject({ ok: true });
    expect(vi.mocked(deps.executionRunStart).mock.calls[0]?.[1]).toMatchObject({
      roleId: role.roleId, intent: 'task', modelId: 'role-model', launchProfileId: 'launch-profile',
      profileId: 'example.execution-profile', profileSourceCustody,
      backendTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
    });
    expect(vi.mocked(deps.executionRunStart).mock.calls[0]?.[2]).toMatchObject({ workspaceWrites: 'deny' });
  },
);

it.each(['missing', 'disabled'] as const)('refuses an unavailable %s role before dispatch', async (roleId) => {
  const deps = createDeps();
  const result = await createActionExecutor(deps).execute('execution.run.start', { ...RUN_START_BASE, roleId }, {
    ...RUN_DISPATCHER_CALLER, agentStartContext: { ...START_CONTEXT, roles: { disabled: {
      roleId: 'disabled', name: 'Disabled', instructions: '', enabled: false, engine: { agentTargetKey: START_TARGET_KEY },
      runsAs: { kind: 'background_run', intent: 'task' }, workspaceWrites: 'deny', secondOpinion: 'off',
    } } },
  });
  expect(result).toMatchObject({ ok: false, errorCode: 'role_target_unavailable' });
  expect(deps.executionRunStart).not.toHaveBeenCalled();
});

it('binds a present-user role start without imposing the agent depth or override policy', async () => {
  const role = { roleId: 'scout', name: 'Scout', instructions: 'Inspect', enabled: true,
    engine: { agentTargetKey: START_TARGET_KEY, modelId: 'scout-model' },
    runsAs: { kind: 'background_run', intent: 'task' }, workspaceWrites: 'deny', secondOpinion: 'off' } as const;
  const deps = createDeps({ executionRunCheckProtocolV2: async () => ({ ok: true }) });
  expect(await createActionExecutor(deps).execute('execution.run.start', { ...RUN_START_BASE, roleId: 'scout' }, {
    ...UI_CALLER, authority: 'present_user', defaultSessionId: 's1', sessionAgentSpawnPolicyV1: { allowModelOverride: false },
    agentStartContext: { ...START_CONTEXT, caller: { ...START_CONTEXT.caller, turnDepth: 9 }, roles: { scout: role } },
  })).toMatchObject({ ok: true });
  expect(vi.mocked(deps.executionRunStart).mock.calls[0]?.[1]).toMatchObject({ roleId: 'scout', intent: 'task', modelId: 'scout-model' });
  expect(vi.mocked(deps.executionRunStart).mock.calls[0]?.[2]).toMatchObject({ workDepth: 0, workspaceWrites: 'deny' });
});

it('applies the Account agent-start policy to execution.run.start before dispatch', async () => {
  const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
  const executor = createActionExecutor(createDeps({ executionRunStart }));
  const result = await executor.execute('execution.run.start', {
    ...RUN_START_BASE, modelId: 'model-1',
  }, {
    ...RUN_DISPATCHER_CALLER,
    sessionAgentSpawnPolicyV1: { v: 1, allowModelOverride: false },
  });
  expect(result).toMatchObject({ ok: false, errorCode: 'policy_denied_field' });
  expect(executionRunStart).not.toHaveBeenCalled();
});

it('threads the host-stamped Workflow start request identity only as execution-run call context', async () => {
  const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
  const executor = createActionExecutor(createDeps({ executionRunStart }));
  const actionCaller = {
    kind: 'workflowRun' as const,
    runId: 'workflow-1',
    authorization: {
      admittedPermissionCeiling: 'safe-yolo' as const,
      principal: { kind: 'host' as const },
    },
  };

  const result = await executor.execute('execution.run.start', {
    ...RUN_START_BASE,
    intent: 'agent',
    instructions: undefined,
    initialInput: { kind: 'deferred_session_pending' },
    retentionPolicy: 'resumable',
    runClass: 'long_lived',
  }, {
    ...RUN_DISPATCHER_CALLER,
    actionCaller,
    actionRequestId: 'workflow-input-v2:stable:execution-run-start',
  });
  expect(executionRunStart).toHaveBeenCalledOnce();
  expect(result).toEqual(expect.objectContaining({ ok: true }));

  expect(executionRunStart).toHaveBeenCalledWith(
    's1',
    expect.objectContaining({
      initialInput: { kind: 'deferred_session_pending' },
    }),
    expect.objectContaining({
      actionCaller,
      actionRequestId: 'workflow-input-v2:stable:execution-run-start',
    }),
  );
  expect(executionRunStart.mock.calls[0]?.[1]).not.toHaveProperty('actionRequestId');
});

const EXECUTION_RUN_WAIT_SUCCEEDED = {
  ok: true,
  status: 'succeeded',
  result: {
    run: {
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'call_1',
      intent: 'task',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      status: 'succeeded',
      startedAtMs: 1,
      finishedAtMs: 2,
      output: { summary: 'structured output', count: 0 },
    },
    latestToolResult: false,
    structuredMeta: { kind: 'execution_result', payload: { accepted: false, count: 0 } },
  },
} as const;

describe('createActionExecutor run options parity (model + effort)', () => {
  it('retains the transport issuance witness on an admitted Stop without putting it in RPC input', async () => {
    let issued = false;
    let receivedInput: unknown;
    // ExecutionRunStop is the host transport boundary; Action admission remains real.
    const executor = createActionExecutor(createDeps({ executionRunStop: async (_sessionId, input, opts) => {
      receivedInput = input;
      opts?.onTransportIssued?.();
      return { ok: false, error: 'Connection lost', errorCode: 'transport_failed' };
    } }));
    const result = await executor.execute('execution.run.stop', { sessionId: 's1', runId: 'run-1' }, {
      surface: 'ui', authority: 'present_user', serverId: 'home-1',
      onTransportIssued: () => { issued = true; },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'transport_failed' });
    expect(issued).toBe(true);
    expect(receivedInput).toEqual({ runId: 'run-1' });
  });

  it('preserves the mounted host Session correlation and exact Machine on an immediate start', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executor = createActionExecutor(createDeps({ executionRunStart }));
    const launchOrigin = { kind: 'session', sessionId: 's1', draftCorrelationId: 'draft_1' } as const;
    const context = { ...UI_CALLER, defaultSessionId: 's1', executionRunTargetMachineId: 'mounted_machine', executionRunLaunchOrigin: launchOrigin };

    await expect(executor.execute('execution.run.start', {
      ...RUN_START_BASE,
      launchOrigin: { kind: 'session', sessionId: 'forged', draftCorrelationId: 'forged' },
    }, context)).resolves.toMatchObject({ ok: true });

    expect(executionRunStart).toHaveBeenCalledWith('s1', expect.objectContaining({ launchOrigin }),
      expect.objectContaining({ targetMachineId: 'mounted_machine' }));
  });

  it('threads modelId + sessionConfigOptionOverrides on execution.run.start', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executor = createActionExecutor(createDeps({ executionRunStart }));
    const overrides = buildAcpConfigOptionOverridesV1({
      updatedAt: 1,
      overrides: { reasoning_effort: { updatedAt: 1, value: 'high' } },
    });

    const res = await executor.execute(
      'execution.run.start' as any,
      { ...RUN_START_BASE, modelId: 'gpt-5.5', sessionConfigOptionOverrides: overrides },
      { ...UI_CALLER, defaultSessionId: 's1' },
    );

    expect(res.ok).toBe(true);
    expect(executionRunStart).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ modelId: 'gpt-5.5', sessionConfigOptionOverrides: overrides }),
      undefined,
    );
  });

  it('preserves a host-stamped Discussion launch origin as provenance only', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executor = createActionExecutor(createDeps({ executionRunStart }));
    const launchOrigin = {
      kind: 'session_discussion',
      sessionId: 's1',
      discussionId: 'discussion_1',
      messageIds: ['message_1'],
      draftCorrelationId: 'draft_1',
    } as const;

    await expect(executor.execute(
      'execution.run.start' as any,
      RUN_START_BASE,
      {
        ...UI_CALLER,
        defaultSessionId: 's1',
        sessionInputSource: launchOrigin,
      },
    )).resolves.toMatchObject({ ok: true });

    expect(executionRunStart).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ launchOrigin }),
      undefined,
    );
  });

  it('resolves the four execution-run Session scope forms at the canonical Action boundary', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executionRunCheckProtocolV2 = vi.fn(async () => ({ ok: true as const }));
    const executor = createActionExecutor(createDeps({ executionRunStart, executionRunCheckProtocolV2 }));
    const { sessionId: _sessionId, ...startWithoutScope } = RUN_START_BASE;

    await executor.execute('execution.run.start' as any, {
      ...RUN_START_BASE,
      sessionId: 'session_explicit',
    }, { ...UI_CALLER, defaultSessionId: 'session_context' });
    await executor.execute('execution.run.start' as any, startWithoutScope, { ...UI_CALLER, defaultSessionId: 'session_context' });
    await executor.execute('execution.run.start' as any, {
      ...RUN_START_BASE,
      sessionId: null,
    }, { ...UI_CALLER, defaultSessionId: 'session_context' });
    await executor.execute('execution.run.start' as any, startWithoutScope, { ...UI_CALLER });

    expect(executionRunStart.mock.calls.map(([scope]) => scope)).toEqual([
      'session_explicit',
      'session_context',
      null,
      null,
    ]);
    expect(executionRunStart.mock.calls.every(([, request]) => !Object.hasOwn(request, 'sessionId'))).toBe(true);
    expect(executionRunCheckProtocolV2.mock.calls.map(([scope]) => scope)).toEqual([null, null]);
    expect(executionRunCheckProtocolV2).toHaveBeenCalledWith(null, expect.objectContaining({ detachedScope: true }), undefined);
  });

  it('defaults an unexpected start-path exception to outcomeUnknown at the canonical Action boundary', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executor = createActionExecutor(createDeps({
      executionRunStart,
      resolveServerIdForSessionId: () => {
        throw new Error('server lookup failed');
      },
    }));

    await expect(executor.execute(
      'execution.run.start' as any,
      RUN_START_BASE,
      { ...UI_CALLER, defaultSessionId: 's1' },
    )).resolves.toEqual({
      ok: false,
      errorCode: 'action_failed',
      error: 'server lookup failed',
      details: { executionRunStart: { v: 1, runCreation: 'outcomeUnknown' } },
    });
    expect(executionRunStart).not.toHaveBeenCalled();
  });

  it('rejects a whitespace-only execution-run Session scope before V2 preflight or start', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executionRunCheckProtocolV2 = vi.fn(async () => ({ ok: true as const }));
    const executor = createActionExecutor(createDeps({ executionRunStart, executionRunCheckProtocolV2 }));

    const res = await executor.execute(
      'execution.run.start' as any,
      { ...RUN_START_BASE, sessionId: '   ' },
      { ...UI_CALLER, defaultSessionId: 'session_context', serverId: 'server_1' },
    );

    expect(res).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
      details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
    });
    expect(executionRunCheckProtocolV2).not.toHaveBeenCalled();
    expect(executionRunStart).not.toHaveBeenCalled();
  });

  it('preserves explicit detached scope and composes start-and-wait through the incumbent waiter', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executionRunWait = vi.fn(async () => EXECUTION_RUN_WAIT_SUCCEEDED);
    const executionRunCheckProtocolV2 = vi.fn(async () => ({ ok: true as const }));
    const executor = createActionExecutor(createDeps({
      executionRunStart,
      executionRunWait,
      executionRunCheckProtocolV2,
    }));

    const res = await executor.execute(
      'execution.run.start' as any,
      {
        ...RUN_START_BASE,
        sessionId: null,
        waitForCompletion: true,
        waitTimeoutSeconds: 12,
      },
      { ...UI_CALLER, defaultSessionId: 's1', serverId: 'server_1' },
    );

    expect(res).toEqual({
      ok: true,
      result: {
        runId: 'run_1',
        callId: 'call_1',
        sidechainId: 'call_1',
        wait: EXECUTION_RUN_WAIT_SUCCEEDED,
      },
    });
    expect(executionRunStart).toHaveBeenCalledWith(
      null,
      expect.not.objectContaining({
        sessionId: expect.anything(),
        waitForCompletion: expect.anything(),
        waitTimeoutSeconds: expect.anything(),
      }),
      { serverId: 'server_1', originSessionId: 's1' },
    );
    expect(executionRunWait).toHaveBeenCalledWith(
      null,
      { runId: 'run_1', timeoutSeconds: 12 },
      { serverId: 'server_1', originSessionId: 's1' },
    );
    expect(executionRunCheckProtocolV2).toHaveBeenCalledWith(
      null,
      {
        detachedScope: true,
        startAndWait: true,
        exactInputResults: false,
        runScopedAgentBindings: false,
        secretReferenceOverlay: false,
      },
      { serverId: 'server_1', originSessionId: 's1' },
    );
  });

  it('keeps a successful start identity when caller cancellation ends only its composed wait', async () => {
    const caller = new AbortController();
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executionRunWait = vi.fn(async (_sessionId: string | null, _request: unknown, opts?: { signal?: AbortSignal }) => {
      expect(opts?.signal).toBe(caller.signal);
      caller.abort();
      opts?.signal?.throwIfAborted();
    });
    const executionRunStop = vi.fn(async () => ({ ok: true }));
    const executionRunCheckProtocolV2 = vi.fn(async () => ({ ok: true as const }));
    const executor = createActionExecutor(createDeps({
      executionRunStart,
      executionRunWait,
      executionRunStop,
      executionRunCheckProtocolV2,
    }));

    await expect(executor.execute(
      'execution.run.start' as any,
      { ...RUN_START_BASE, waitForCompletion: true },
      { ...UI_CALLER, defaultSessionId: 's1', signal: caller.signal },
    )).resolves.toEqual({
      ok: true,
      result: {
        runId: 'run_1',
        callId: 'call_1',
        sidechainId: 'call_1',
        wait: { ok: false, code: 'cancelled' },
      },
    });
    expect(executionRunStart).toHaveBeenCalledTimes(1);
    expect(executionRunStop).not.toHaveBeenCalled();
  });

  it('preserves the canonical get result through the direct public waiter', async () => {
    const executionRunWait = vi.fn(async () => EXECUTION_RUN_WAIT_SUCCEEDED);
    const executor = createActionExecutor(createDeps({ executionRunWait }));

    await expect(executor.execute(
      'execution.run.wait' as any,
      { sessionId: 's1', runId: 'run_1' },
      { ...UI_CALLER, defaultSessionId: 's1' },
    )).resolves.toEqual({
      ok: true,
      result: EXECUTION_RUN_WAIT_SUCCEEDED,
    });
  });

  it('publishes a direct waiter timeout through the strict Action result schema', async () => {
    const observationTimeout = {
      ok: true as const,
      status: 'running' as const,
      disposition: 'observation_timeout' as const,
      runId: 'run_1',
      timeoutMs: 1_000,
      observedAtMs: 2_000,
      deadlineAtMs: 1_500,
    };
    const executionRunWait = vi.fn(async () => observationTimeout);
    const executor = createActionExecutor(createDeps({ executionRunWait }));

    await expect(executor.execute(
      'execution.run.wait' as any,
      { sessionId: 's1', runId: 'run_1' },
      { ...UI_CALLER, defaultSessionId: 's1' },
    )).resolves.toEqual({ ok: true, result: observationTimeout });
  });

  it('unwraps the incumbent Session start service envelope before composing start-and-wait', async () => {
    const executionRunStart = vi.fn(async () => ({
      ok: true as const,
      data: {
        runId: 'run_1',
        callId: 'call_1',
        sidechainId: 'call_1',
        producerMetadata: { version: 2 },
      },
    }));
    const executionRunWait = vi.fn(async () => EXECUTION_RUN_WAIT_SUCCEEDED);
    const executionRunCheckProtocolV2 = vi.fn(async () => ({ ok: true as const, exactMachineId: 'machine_1' }));
    const executor = createActionExecutor(createDeps({
      executionRunStart,
      executionRunWait,
      executionRunCheckProtocolV2,
    }));

    await expect(executor.execute(
      'execution.run.start' as any,
      { ...RUN_START_BASE, waitForCompletion: true },
      { ...UI_CALLER, defaultSessionId: 's1' },
    )).resolves.toEqual({
      ok: true,
      result: {
        runId: 'run_1',
        callId: 'call_1',
        sidechainId: 'call_1',
        producerMetadata: { version: 2 },
        wait: EXECUTION_RUN_WAIT_SUCCEEDED,
      },
    });
    expect(executionRunWait).toHaveBeenCalledWith(
      's1',
      { runId: 'run_1' },
      { exactMachineId: 'machine_1' },
    );
  });

  it('projects the incumbent Session start service failure as a failed Action result', async () => {
    const executionRunStart = vi.fn(async () => ({
      ok: false as const,
      code: 'execution_run_not_allowed',
      message: 'Execution runs disabled',
    }));
    const executor = createActionExecutor(createDeps({ executionRunStart }));

    await expect(executor.execute(
      'execution.run.start' as any,
      RUN_START_BASE,
      { ...UI_CALLER, defaultSessionId: 's1' },
    )).resolves.toEqual({
      ok: false,
      errorCode: 'execution_run_not_allowed',
      error: 'Execution runs disabled',
      details: { executionRunStart: { v: 1, runCreation: 'outcomeUnknown' } },
    });
  });

  it('treats a complete returned Run identity as success even when the service envelope claims failure', async () => {
    const executionRunStart = vi.fn(async () => ({
      ok: false as const,
      code: 'execution_run_failed',
      message: 'contradictory failure',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'call_1',
      details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
    }));
    const executor = createActionExecutor(createDeps({ executionRunStart }));

    await expect(executor.execute(
      'execution.run.start' as any,
      RUN_START_BASE,
      { ...UI_CALLER, defaultSessionId: 's1' },
    )).resolves.toMatchObject({
      ok: true,
      result: {
        runId: 'run_1',
        callId: 'call_1',
        sidechainId: 'call_1',
      },
    });
  });

  it('treats a partial returned Run identity as outcomeUnknown even when failure details claim no run', async () => {
    const executionRunStart = vi.fn(async () => ({
      ok: false as const,
      code: 'execution_run_failed',
      message: 'contradictory partial identity',
      runId: 'run_1',
      details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
    }));
    const executor = createActionExecutor(createDeps({ executionRunStart }));

    await expect(executor.execute(
      'execution.run.start' as any,
      RUN_START_BASE,
      { ...UI_CALLER, defaultSessionId: 's1' },
    )).resolves.toEqual({
      ok: false,
      errorCode: 'execution_run_failed',
      error: 'contradictory partial identity',
      details: { executionRunStart: { v: 1, runCreation: 'outcomeUnknown' } },
    });
  });

  it('applies identity precedence inside a successful service wrapper before reading its nested failure', async () => {
    const executionRunStart = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        data: {
          ok: false,
          code: 'execution_run_failed',
          runId: 'run_1',
          callId: 'call_1',
          sidechainId: 'call_1',
          details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          ok: false,
          code: 'execution_run_failed',
          runId: 'run_2',
          details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
        },
      });
    const executor = createActionExecutor(createDeps({ executionRunStart }));

    await expect(executor.execute(
      'execution.run.start' as any,
      RUN_START_BASE,
      { ...UI_CALLER, defaultSessionId: 's1' },
    )).resolves.toEqual({
      ok: true,
      result: {
        runId: 'run_1',
        callId: 'call_1',
        sidechainId: 'call_1',
      },
    });
    await expect(executor.execute(
      'execution.run.start' as any,
      RUN_START_BASE,
      { ...UI_CALLER, defaultSessionId: 's1' },
    )).resolves.toEqual({
      ok: false,
      errorCode: 'execution_run_failed',
      error: 'execution_run_failed',
      details: { executionRunStart: { v: 1, runCreation: 'outcomeUnknown' } },
    });
  });

  it('preserves owner-proven no-run evidence and defaults malformed or missing start evidence to outcomeUnknown', async () => {
    const executionRunStart = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        code: 'execution_run_budget_exceeded',
        message: 'No budget',
        details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
      })
      .mockResolvedValueOnce({
        ok: false,
        code: 'execution_run_failed',
        message: 'Malformed evidence',
        details: { executionRunStart: { v: 1, runCreation: 'noRunCreated', retryable: true } },
      });
    const executor = createActionExecutor(createDeps({ executionRunStart }));

    await expect(executor.execute(
      'execution.run.start' as any,
      RUN_START_BASE,
      { ...UI_CALLER, defaultSessionId: 's1' },
    )).resolves.toMatchObject({
      ok: false,
      details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
    });
    await expect(executor.execute(
      'execution.run.start' as any,
      RUN_START_BASE,
      { ...UI_CALLER, defaultSessionId: 's1' },
    )).resolves.toMatchObject({
      ok: false,
      details: { executionRunStart: { v: 1, runCreation: 'outcomeUnknown' } },
    });
  });

  it('keeps the returned start identity when wait observation throws after start', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executionRunWait = vi.fn(async () => {
      throw new Error('wait transport lost');
    });
    const executionRunCheckProtocolV2 = vi.fn(async () => ({ ok: true as const }));
    const executor = createActionExecutor(createDeps({
      executionRunStart,
      executionRunWait,
      executionRunCheckProtocolV2,
    }));

    await expect(executor.execute(
      'execution.run.start' as any,
      { ...RUN_START_BASE, waitForCompletion: true },
      { ...UI_CALLER, defaultSessionId: 's1' },
    )).resolves.toEqual({
      ok: true,
      result: {
        runId: 'run_1',
        callId: 'call_1',
        sidechainId: 'call_1',
        wait: { ok: false, code: 'execution_run_failed' },
      },
    });
  });

  it('treats a successful start envelope without a complete run identity as outcome unknown', async () => {
    const executionRunStart = vi.fn(async () => ({ ok: true as const, data: {} }));
    const executor = createActionExecutor(createDeps({ executionRunStart }));

    await expect(executor.execute(
      'execution.run.start' as any,
      RUN_START_BASE,
      { ...UI_CALLER, defaultSessionId: 's1' },
    )).resolves.toEqual({
      ok: false,
      errorCode: 'execution_run_failed',
      error: 'execution_run_invalid_response',
      details: { executionRunStart: { v: 1, runCreation: 'outcomeUnknown' } },
    });
  });

  it('normalizes internal execution-run service envelopes only at the public Action boundary', async () => {
    const executionRunList = vi.fn(async () => ({
      ok: true as const,
      data: { runs: [] },
    }));
    const detachedExecutionRunSend = vi.fn(async () => ({ ok: true as const }));
    const executionRunEnsure = vi.fn(async () => ({
      ok: true as const,
      data: {},
    }));
    const executionRunGet = vi.fn(async () => ({
      ok: false as const,
      code: 'execution_run_not_allowed',
      message: 'Execution runs disabled',
    }));
    const executor = createActionExecutor(createDeps({
      executionRunList,
      detachedExecutionRunSend,
      executionRunCheckProtocolV2: async () => ({ ok: true }),
      executionRunEnsure,
      executionRunGet,
    }));

    await expect(executor.execute(
      'execution.run.list' as any,
      { sessionId: 's1' },
      RUN_DISPATCHER_CALLER,
    )).resolves.toEqual({ ok: true, result: { runs: [] } });
    await expect(executor.execute(
      'execution.run.send' as any,
      { sessionId: null, runId: 'run_1', message: 'Continue' },
      RUN_DISPATCHER_CALLER,
    )).resolves.toEqual({ ok: true, result: { ok: true } });
    await expect(executor.execute(
      'execution.run.ensure' as any,
      { sessionId: 's1', runId: 'run_1' },
      RUN_DISPATCHER_CALLER,
    )).resolves.toEqual({ ok: true, result: { ok: true } });
    await expect(executor.execute(
      'execution.run.get' as any,
      { sessionId: 's1', runId: 'run_1' },
      RUN_DISPATCHER_CALLER,
    )).resolves.toEqual({
      ok: false,
      errorCode: 'execution_run_not_allowed',
      error: 'Execution runs disabled',
    });
  });

  it('requires and threads active-turn authority for every Agent existing-run effect', async () => {
    const detachedExecutionRunSend = vi.fn(async () => ({ ok: true, data: {} }));
    const executionRunEnsure = vi.fn(async () => ({ ok: true, data: {} }));
    const executionRunEnsureOrStart = vi.fn(async () => ({
      ok: true,
      data: { runId: 'run_1', created: false },
    }));
    const executionRunStreamStart = vi.fn(async () => ({
      ok: true,
      data: { streamId: 'stream_1' },
    }));
    const executionRunAction = vi.fn(async () => ({ ok: true, data: {} }));
    const executor = createActionExecutor(createDeps({
      detachedExecutionRunSend,
      executionRunCheckProtocolV2: async () => ({ ok: true }),
      executionRunEnsure,
      executionRunEnsureOrStart,
      executionRunStreamStart,
      executionRunAction,
    }));

    const effects = [
      ['execution.run.send', { sessionId: null, runId: 'run_1', message: 'continue' }, detachedExecutionRunSend],
      ['execution.run.ensure', { sessionId: 's1', runId: 'run_1' }, executionRunEnsure],
      ['execution.run.ensure_or_start', { sessionId: 's1', runId: 'run_1' }, executionRunEnsureOrStart],
      ['execution.run.stream.start', { sessionId: 's1', runId: 'run_1', message: 'continue' }, executionRunStreamStart],
      ['execution.run.action', { sessionId: 's1', runId: 'run_1', actionId: 'task.commit', input: {} }, executionRunAction],
    ] as const;

    for (const [actionId, input, dependency] of effects) {
      await expect(executor.execute(actionId, input, {
        surface: 'agent',
        defaultSessionId: 's1',
        sessionListAccess: 'current_session',
        callerPermissionMode: 'yolo',
      })).resolves.toMatchObject({
        ok: false,
        errorCode: 'causal_permission_authority_invalid',
      });
      expect(dependency).not.toHaveBeenCalled();

      const result = await executor.execute(actionId, input, RUN_DISPATCHER_CALLER);
      expect(result, `${actionId}: ${JSON.stringify(result)}`).toMatchObject({ ok: true });
      expect(dependency).toHaveBeenCalledWith(
        input.sessionId,
        expect.anything(),
        expect.objectContaining({
          causalPermissionAuthority: ACTIVE_TURN_AUTHORITY,
          effectiveCallerPermissionMode: 'read-only',
        }),
      );
      dependency.mockClear();
    }
  });

  it('threads the admitted origin only through nested execution.run.action', async () => {
    const executionRunAction = vi.fn(async () => ({ ok: true, data: {} }));
    const executor = createActionExecutor(createDeps({
      executionRunAction,
      executionRunCheckProtocolV2: async () => ({ ok: true }),
    }));
    const actionCaller = { kind: 'plugin', pluginId: 'example.plugin' } as const;

    await expect(executor.execute('execution.run.action', {
      sessionId: 's1',
      runId: 'run_1',
      actionId: 'task.commit',
      input: {},
    }, {
      ...RUN_DISPATCHER_CALLER,
      authority: 'account_automation',
      actionCaller,
      serverId: 'server_1',
      runtimeAccountId: 'account_1',
      actionRequestId: 'request_1',
      defaultSessionMachineId: 'machine_1',
    })).resolves.toMatchObject({ ok: true });

    expect(executionRunAction).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ runId: 'run_1', actionId: 'task.commit' }),
      expect.objectContaining({
        serverId: 'server_1',
        authority: 'account_automation',
        actionCaller,
        runtimeAccountId: 'account_1',
        actionRequestId: 'request_1',
        defaultSessionMachineId: 'machine_1',
        causalPermissionAuthority: ACTIVE_TURN_AUTHORITY,
        effectiveCallerPermissionMode: 'read-only',
      }),
    );
  });

  it('threads a Workflow Run mediated source through detached continuation admission', async () => {
    const detachedExecutionRunSend = vi.fn(async () => ({ ok: true, data: {} }));
    const permissionRequestStore = Object.freeze({ kind: 'workflow-invocation-b' });
    const executor = createActionExecutor(createDeps({
      detachedExecutionRunSend,
      executionRunCheckProtocolV2: async () => ({ ok: true }),
    }));
    const sourceAuthority = {
      mediatorPluginId: 'happier.channels',
      sourceRef: 'channels:binding:binding-1',
      sourceRevisionOrEpoch: '4:7',
      remoteApprovalMaxScope: 'session' as const,
    };

    const result = await executor.execute('execution.run.send', {
      sessionId: null,
      runId: 'run_1',
      message: 'continue',
      localInputId: 'workflow-input-b',
    }, {
      surface: 'agent',
      authority: 'account_automation',
      executionRunTargetMachineId: 'machine_1',
      executionRunPermissionRequestStore: permissionRequestStore,
      actionCaller: {
        kind: 'workflowRun',
        runId: 'workflow-run-1',
        authorization: {
          admittedPermissionCeiling: 'read-only',
          principal: { kind: 'host' },
          sourceAuthority,
        },
      },
    });
    expect(result).toMatchObject({ ok: true });

    expect(detachedExecutionRunSend).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ runId: 'run_1', message: 'continue', localInputId: 'workflow-input-b' }),
      expect.objectContaining({
        effectiveCallerPermissionMode: 'read-only',
        permissionRequestStore,
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'read-only',
          sourceAuthority: {
            kind: 'mediatedExternal',
            ...sourceAuthority,
            admittedPermissionCeiling: 'read-only',
          },
        },
      }),
    );
  });

  it('fails closed before detached start when the exact target lacks the V2 execution-run capability', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executionRunCheckProtocolV2 = vi.fn(async () => ({
      ok: false as const,
      errorCode: 'execution_run_protocol_unsupported',
      error: 'execution_run_protocol_unsupported',
    }));
    const executor = createActionExecutor(createDeps({ executionRunStart, executionRunCheckProtocolV2 }));

    const res = await executor.execute(
      'execution.run.start' as any,
      { ...RUN_START_BASE, sessionId: null, waitForCompletion: true },
      { ...UI_CALLER, defaultSessionId: 's1', serverId: 'server_1' },
    );

    expect(res).toEqual({
      ok: false,
      errorCode: 'execution_run_protocol_unsupported',
      error: 'execution_run_protocol_unsupported',
      details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
    });
    expect(executionRunCheckProtocolV2).toHaveBeenCalledWith(
      null,
      {
        detachedScope: true,
        startAndWait: true,
        exactInputResults: false,
        runScopedAgentBindings: false,
        secretReferenceOverlay: false,
      },
      { serverId: 'server_1', originSessionId: 's1' },
    );
    expect(executionRunStart).not.toHaveBeenCalled();
  });

  it('fails closed before a V2 start when capability negotiation is unavailable', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executor = createActionExecutor(createDeps({ executionRunStart, executionRunCheckProtocolV2: undefined }));

    for (const input of [
      { ...RUN_START_BASE, sessionId: null },
      { ...RUN_START_BASE, sessionId: 'session_explicit', waitForCompletion: true },
    ]) {
      await expect(executor.execute(
        'execution.run.start' as any,
        input,
        { ...UI_CALLER, defaultSessionId: 's1', serverId: 'server_1' },
      )).resolves.toEqual({
        ok: false,
        errorCode: 'execution_run_protocol_unsupported',
        error: 'execution_run_protocol_unsupported',
        details: {
          executionRunStart: { v: 1, runCreation: 'noRunCreated' },
        },
      });
    }
    expect(executionRunStart).not.toHaveBeenCalled();
  });

  it('requires exact V2 overlay support even for an immediate Session-scoped start', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executionRunCheckProtocolV2 = vi.fn(async () => ({
      ok: false as const,
      errorCode: 'execution_run_protocol_unsupported',
      error: 'execution_run_protocol_unsupported',
    }));
    const executor = createActionExecutor(createDeps({ executionRunStart, executionRunCheckProtocolV2 }));

    await expect(executor.execute(
      'execution.run.start' as any,
      {
        ...RUN_START_BASE,
        sessionId: 's1',
        secretReferenceOverlay: {
          v: 1,
          bindings: { API_KEY: { ref: 'happier:shared-secret:v1:resource', revision: 3 } },
        },
      },
      { ...UI_CALLER, defaultSessionId: 's1', serverId: 'server_1' },
    )).resolves.toEqual({
      ok: false,
      errorCode: 'execution_run_protocol_unsupported',
      error: 'execution_run_protocol_unsupported',
      details: {
        executionRunStart: { v: 1, runCreation: 'noRunCreated' },
        updateRequired: {
          kind: 'update_required',
          operation: 'execution.run.start',
          component: 'daemon',
          reason: 'execution_run_secret_reference_overlay_update_required',
        },
      },
    });
    expect(executionRunCheckProtocolV2).toHaveBeenCalledWith(
      's1',
      {
        detachedScope: false,
        startAndWait: false,
        exactInputResults: false,
        runScopedAgentBindings: false,
        secretReferenceOverlay: true,
      },
      { serverId: 'server_1' },
    );
    expect(executionRunStart).not.toHaveBeenCalled();
  });

  it('preserves the V2 capability owner\'s exact-machine routing through detached start-and-wait', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executionRunWait = vi.fn(async () => EXECUTION_RUN_WAIT_SUCCEEDED);
    const executionRunCheckProtocolV2 = vi.fn(async () => ({ ok: true as const, exactMachineId: 'machine_2' }));
    const executor = createActionExecutor(createDeps({
      executionRunStart,
      executionRunWait,
      executionRunCheckProtocolV2,
    }));

    await expect(executor.execute(
      'execution.run.start' as any,
      { ...RUN_START_BASE, sessionId: null, waitForCompletion: true },
      { ...UI_CALLER, defaultSessionId: 's1', serverId: 'server_1' },
    )).resolves.toEqual(expect.objectContaining({ ok: true }));

    expect(executionRunStart).toHaveBeenCalledWith(
      null,
      expect.any(Object),
      { serverId: 'server_1', originSessionId: 's1', exactMachineId: 'machine_2' },
    );
    expect(executionRunWait).toHaveBeenCalledWith(
      null,
      { runId: 'run_1' },
      { serverId: 'server_1', originSessionId: 's1', exactMachineId: 'machine_2' },
    );
  });

  it('passes a host-stamped detached target to V2 preflight before dispatch uses its exact machine', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executionRunCheckProtocolV2 = vi.fn(async () => ({ ok: true as const, exactMachineId: 'machine_exact' }));
    const executor = createActionExecutor(createDeps({ executionRunStart, executionRunCheckProtocolV2 }));

    await expect(executor.execute(
      'execution.run.start' as any,
      { ...RUN_START_BASE, sessionId: null },
      {
        ...UI_CALLER,
        serverId: 'server_1',
        // The mount host, not Action input, vouches for this selection.
        executionRunTargetMachineId: 'machine_mounted',
      },
    )).resolves.toEqual(expect.objectContaining({ ok: true }));

    expect(executionRunCheckProtocolV2).toHaveBeenCalledWith(
      null,
      {
        detachedScope: true,
        startAndWait: false,
        exactInputResults: false,
        runScopedAgentBindings: false,
        secretReferenceOverlay: false,
      },
      { serverId: 'server_1', targetMachineId: 'machine_mounted' },
    );
    expect(executionRunStart).toHaveBeenCalledWith(
      null,
      expect.any(Object),
      { serverId: 'server_1', targetMachineId: 'machine_mounted', exactMachineId: 'machine_exact' },
    );
  });

  it('merges the configOptions shorthand into sessionConfigOptionOverrides and strips it', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executor = createActionExecutor(createDeps({ executionRunStart }));

    const res = await executor.execute(
      'execution.run.start' as any,
      { ...RUN_START_BASE, configOptions: { reasoning_effort: 'high' } },
      { ...UI_CALLER, defaultSessionId: 's1' },
    );

    expect(res.ok).toBe(true);
    const request = executionRunStart.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(request.configOptions).toBeUndefined();
    const overrides = request.sessionConfigOptionOverrides as { overrides: Record<string, { value: unknown }> };
    expect(overrides.overrides.reasoning_effort.value).toBe('high');
  });

  it('fails closed when configOptions conflicts with sessionConfigOptionOverrides', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executor = createActionExecutor(createDeps({ executionRunStart }));
    const overrides = buildAcpConfigOptionOverridesV1({
      updatedAt: 1,
      overrides: { reasoning_effort: { updatedAt: 1, value: 'low' } },
    });

    const res = await executor.execute(
      'execution.run.start' as any,
      { ...RUN_START_BASE, sessionConfigOptionOverrides: overrides, configOptions: { reasoning_effort: 'high' } },
      { ...UI_CALLER, defaultSessionId: 's1' },
    );

    expect(res).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
      details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
    });
    expect(executionRunStart).not.toHaveBeenCalled();
  });

  it('threads modelId + merged effort into every delegate.start per-target run request', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executor = createActionExecutor(createDeps({ executionRunStart }));

    const res = await executor.execute(
      'subagents.delegate.start' as any,
      {
        sessionId: 's1',
        backendTargetKeys: ['agent:codex', 'agent:claude'],
        instructions: 'do it',
        permissionMode: 'read_only',
        modelId: 'gpt-5.5',
        configOptions: { reasoning_effort: 'high' },
      },
      { ...UI_CALLER, defaultSessionId: 's1', callerPermissionMode: 'workspace_write' },
    );

    expect(res.ok).toBe(true);
    expect(executionRunStart).toHaveBeenCalledTimes(2);
    for (const call of executionRunStart.mock.calls) {
      const request = call[1] as Record<string, unknown>;
      expect(request.modelId).toBe('gpt-5.5');
      const overrides = request.sessionConfigOptionOverrides as { overrides: Record<string, { value: unknown }> };
      expect(overrides.overrides.reasoning_effort.value).toBe('high');
    }
  });

  it('capability-gates and forwards one value-free Saved Secret overlay through delegate.start', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executionRunCheckProtocolV2 = vi.fn(async () => ({ ok: true as const, exactMachineId: 'machine_1' }));
    const executor = createActionExecutor(createDeps({ executionRunStart, executionRunCheckProtocolV2 }));
    const secretReferenceOverlay = {
      v: 1 as const,
      bindings: {
        OPENAI_API_KEY: { ref: 'happier:shared-secret:v1:secret-1', revision: 7 },
      },
    };

    const result = await executor.execute('subagents.delegate.start' as any, {
      sessionId: 's1',
      backendTargetKeys: ['agent:codex'],
      instructions: 'do it',
      permissionMode: 'read_only',
      secretReferenceOverlay,
    }, { ...UI_CALLER, defaultSessionId: 's1', callerPermissionMode: 'workspace_write' });

    expect(result.ok).toBe(true);
    expect(executionRunCheckProtocolV2).toHaveBeenCalledWith('s1', expect.objectContaining({
      secretReferenceOverlay: true,
    }), undefined);
    expect(executionRunStart).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ secretReferenceOverlay }),
      expect.objectContaining({ exactMachineId: 'machine_1' }),
    );
  });

  it('starts no delegate run when the exact target cannot consume a Saved Secret overlay', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executionRunCheckProtocolV2 = vi.fn(async () => ({
      ok: false as const,
      errorCode: 'execution_run_protocol_unsupported',
      error: 'execution_run_protocol_unsupported',
    }));
    const executor = createActionExecutor(createDeps({ executionRunStart, executionRunCheckProtocolV2 }));

    const result = await executor.execute('subagents.delegate.start' as any, {
      sessionId: 's1',
      backendTargetKeys: ['agent:codex'],
      instructions: 'do it',
      permissionMode: 'read_only',
      secretReferenceOverlay: {
        v: 1,
        bindings: { OPENAI_API_KEY: { ref: 'happier:shared-secret:v1:secret-1', revision: 7 } },
      },
    }, { ...UI_CALLER, defaultSessionId: 's1', callerPermissionMode: 'workspace_write' });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'execution_run_protocol_unsupported',
      details: {
        executionRunStart: { v: 1, runCreation: 'noRunCreated' },
        updateRequired: { kind: 'update_required' },
      },
    });
    expect(executionRunStart).not.toHaveBeenCalled();
  });

  it('threads one exact Team credential model selection into the selected delegate run', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executionRunCheckProtocolV2 = vi.fn(async () => ({
      ok: true as const,
      exactMachineId: 'machine-team-capable',
    }));
    const executor = createActionExecutor(createDeps({ executionRunStart, executionRunCheckProtocolV2 }));
    const teamCredentialModel = {
      kind: 'team_credential_provider_model' as const,
      resourceId: 'resource-1',
      teamId: 'team-1',
      expectedResourceRevision: 4,
      deliveryMode: 'brokered' as const,
      agentTargetKey: buildBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' }),
      modelId: 'team-model',
    };
    const teamCredentialSessionBindingConsent = {
      v: 1 as const,
      sessionId: 's1',
      teamId: teamCredentialModel.teamId,
      resourceId: teamCredentialModel.resourceId,
      expectedResourceRevision: teamCredentialModel.expectedResourceRevision,
    };

    const result = await executor.execute('subagents.delegate.start' as any, {
      sessionId: 's1',
      backendTargetKeys: ['agent:happier.agent.codex/codex'],
      instructions: 'do it',
      permissionMode: 'read_only',
      modelId: teamCredentialModel.modelId,
      teamCredentialModel,
      teamCredentialSessionBindingConsent,
    }, { ...UI_CALLER, defaultSessionId: 's1', callerPermissionMode: 'workspace_write' });

    expect(result.ok).toBe(true);
    expect(executionRunStart).toHaveBeenCalledTimes(1);
    expect(executionRunStart).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        modelId: teamCredentialModel.modelId,
        teamCredentialModel,
        teamCredentialSessionBindingConsent,
      }),
      { exactMachineId: 'machine-team-capable' },
    );
    expect(executionRunCheckProtocolV2).toHaveBeenCalledWith(
      's1',
      {
        detachedScope: false,
        startAndWait: false,
        exactInputResults: false,
        runScopedAgentBindings: true,
        secretReferenceOverlay: false,
      },
      undefined,
    );
    const runRequest = executionRunStart.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(runRequest.intentInput).not.toHaveProperty('teamCredentialSessionBindingConsent');
  });

  it.each([
    ['review.start', {
      sessionId: 's1',
      engineIds: ['agent:happier.agent.codex/codex'],
      instructions: 'review it',
      teamCredentialModel: {
        kind: 'team_credential_provider_model',
        resourceId: 'resource-1',
        teamId: 'team-1',
        expectedResourceRevision: 4,
        deliveryMode: 'brokered',
        agentTargetKey: 'agent:happier.agent.codex/codex',
        modelId: 'team-model',
      },
    }],
    ['subagents.plan.start', {
      sessionId: 's1',
      backendTargetKeys: ['agent:happier.agent.codex/codex'],
      instructions: 'plan it',
      teamCredentialModel: {
        kind: 'team_credential_provider_model',
        resourceId: 'resource-1',
        teamId: 'team-1',
        expectedResourceRevision: 4,
        deliveryMode: 'brokered',
        agentTargetKey: 'agent:happier.agent.codex/codex',
        modelId: 'team-model',
      },
    }],
    ['subagents.delegate.start', {
      sessionId: 's1',
      backendTargetKeys: ['agent:happier.agent.codex/codex'],
      instructions: 'do it',
      permissionMode: 'read_only',
      teamCredentialModel: {
        kind: 'team_credential_provider_model',
        resourceId: 'resource-1',
        teamId: 'team-1',
        expectedResourceRevision: 4,
        deliveryMode: 'brokered',
        agentTargetKey: 'agent:happier.agent.codex/codex',
        modelId: 'team-model',
      },
    }],
  ] as const)('starts zero runs when %s cannot prove Team-binding capability', async (actionId, input) => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executionRunCheckProtocolV2 = vi.fn(async () => ({
      ok: false as const,
      errorCode: 'execution_run_protocol_unsupported',
      error: 'execution_run_protocol_unsupported',
    }));
    const executor = createActionExecutor(createDeps({
      executionRunStart,
      executionRunCheckProtocolV2,
      reviewEnginesList: vi.fn(async () => ({ items: [{ value: 'agent:happier.agent.codex/codex', label: 'Codex' }] })),
    }));

    await expect(executor.execute(
      actionId,
      input,
      { ...UI_CALLER, defaultSessionId: 's1', callerPermissionMode: 'workspace_write' },
    )).resolves.toMatchObject({
      ok: false,
      errorCode: 'execution_run_protocol_unsupported',
      details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
    });
    expect(executionRunCheckProtocolV2).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ runScopedAgentBindings: true }),
      undefined,
    );
    expect(executionRunStart).not.toHaveBeenCalled();
  });

  it('starts no delegate run when an exact Team selection is ambiguous or targets another backend', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executor = createActionExecutor(createDeps({ executionRunStart }));
    const teamCredentialModel = {
      kind: 'team_credential_provider_model' as const,
      resourceId: 'resource-1',
      teamId: 'team-1',
      expectedResourceRevision: 4,
      deliveryMode: 'brokered' as const,
      agentTargetKey: buildBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' }),
      modelId: 'team-model',
    };

    for (const backendTargetKeys of [
      ['agent:happier.agent.codex/codex', 'agent:happier.agent.claude/claude'],
      ['agent:happier.agent.claude/claude'],
    ]) {
      const result = await executor.execute('subagents.delegate.start' as any, {
        sessionId: 's1',
        backendTargetKeys,
        instructions: 'do it',
        permissionMode: 'read_only',
        modelId: teamCredentialModel.modelId,
        teamCredentialModel,
      }, { ...UI_CALLER, defaultSessionId: 's1', callerPermissionMode: 'workspace_write' });
      expect(result).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    }
    expect(executionRunStart).not.toHaveBeenCalled();
  });

  it('normalizes a simple-string connectedServices selection on execution.run.start', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executor = createActionExecutor(createDeps({ executionRunStart }));

    const res = await executor.execute(
      'execution.run.start' as any,
      { ...RUN_START_BASE, connectedServices: 'openai-codex:group:happier' },
      { ...UI_CALLER, defaultSessionId: 's1' },
    );

    expect(res.ok).toBe(true);
    const request = executionRunStart.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(request.connectedServices).toEqual({
      v: 2,
      bindingsByServiceId: {
        'happier.agent.codex/openai-codex': { source: 'connected', selection: 'group', groupId: 'happier' },
      },
    });
  });

  it('normalizes the global native shorthand to an explicit account-default opt-out', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executor = createActionExecutor(createDeps({ executionRunStart }));

    const res = await executor.execute(
      'execution.run.start' as any,
      { ...RUN_START_BASE, connectedServices: 'native' },
      { ...UI_CALLER, defaultSessionId: 's1' },
    );

    expect(res.ok).toBe(true);
    const request = executionRunStart.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(request.connectedServices).toBeNull();
  });

  it('fails closed and starts no run when connectedServices is malformed', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executor = createActionExecutor(createDeps({ executionRunStart }));

    const res = await executor.execute(
      'execution.run.start' as any,
      { ...RUN_START_BASE, connectedServices: 'not-a-service:bogus:x' },
      { ...UI_CALLER, defaultSessionId: 's1' },
    );

    expect(res).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
      details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
    });
    expect(executionRunStart).not.toHaveBeenCalled();
  });

  it('normalizes per-target simple-string connectedServices on delegate.start', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executor = createActionExecutor(createDeps({ executionRunStart }));

    const res = await executor.execute(
      'subagents.delegate.start' as any,
      {
        sessionId: 's1',
        backendTargetKeys: ['agent:codex'],
        instructions: 'do it',
        permissionMode: 'read_only',
        connectedServicesByBackendTargetKey: { 'agent:codex': 'openai-codex:native' },
      },
      { ...UI_CALLER, defaultSessionId: 's1', callerPermissionMode: 'workspace_write' },
    );

    expect(res.ok).toBe(true);
    const request = executionRunStart.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(request.connectedServices).toEqual({
      v: 2,
      bindingsByServiceId: { 'happier.agent.codex/openai-codex': { source: 'native' } },
    });
  });
});
