import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor as createRawActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import type { ActionDefinitionV1 } from './actionDefinitionV1.js';
import { getActionSpec, PUBLIC_ACTION_OUTPUT_SCHEMAS } from './actionSpecs.js';
import { ActionIdSchema } from './actionIds.js';
import type { MachinesAgentsListInput } from '../capabilities/machineAgentInventory.js';
import { getActionRequiredServerFeatureId } from './actionRequiredServerFeature.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { SPAWN_SESSION_ERROR_CODES } from '../sessions/spawnSession.js';
import { SessionDirectoryIntentV1Schema } from '../sessions/creation/sessionDirectoryIntentV1.js';
import { ExecutionRunLaunchOriginSchema } from '../execution/runs/startRequest.js';
import { AgentStartSessionCallerV1Schema, type AgentStartContextV1 } from '../account/settings/admitAgentStartV1.js';
import {
  ExecutionRunTransportErrorCodeSchema,
  type ExecutionRunTransportErrorCode,
} from '../execution/runs/responseSchemas.js';

function createDeps(): ActionExecutorDeps {
  return {
    executionRunStart: vi.fn(async () => ({})),
    executionRunList: vi.fn(async () => ({ runs: [] })),
    executionRunGet: vi.fn(async () => ({})),
    detachedExecutionRunSend: vi.fn(async () => ({ ok: true })),
    executionRunStop: vi.fn(async () => ({})),
    executionRunAction: vi.fn(async () => ({})),
    executionRunWait: vi.fn(async () => ({})),

    sessionOpen: vi.fn(async () => ({})),
    sessionFork: vi.fn(async () => ({})),
    sessionRollback: vi.fn(async () => ({})),
    sessionSpawnNew: vi.fn(async () => ({})),

    pathsListRecent: vi.fn(async () => ({ items: [] })),
    projectsList: vi.fn(async () => ({ items: [] })),
    machinesList: vi.fn(async () => ({ items: [] })),
    serversList: vi.fn(async () => ({ items: [] })),
    reviewEnginesList: vi.fn(async () => ({ items: [] })),
    agentsBackendsList: vi.fn(async () => ({ items: [] })),
    agentsModelsList: vi.fn(async () => ({ items: [] })),
    agentsConfigOptionsList: vi.fn(async () => ({ items: [] })),
    agentsSessionModesList: vi.fn(async () => ({ items: [] })),
    spawnProfilesList: vi.fn(async () => ({ items: [] })),
    spawnConnectedServicesList: vi.fn(async () => ({ items: [] })),
    spawnMcpServersPreview: vi.fn(async () => ({ items: [] })),

    sessionSendMessage: vi.fn(async () => ({})),
    sessionPermissionRespond: vi.fn(async () => ({})),
    sessionUserActionAnswer: vi.fn(async () => ({ ok: true })),
    sessionModeSet: vi.fn(async () => ({})),
    sessionModesList: vi.fn(async () => ({ items: [] })),

    sessionTargetPrimarySet: vi.fn(async () => ({})),
    sessionTargetTrackedSet: vi.fn(async () => ({})),
    sessionList: vi.fn(async () => ({})),
    sessionActivityGet: vi.fn(async () => ({})),
    sessionRecentMessagesGet: vi.fn(async () => ({})),

    resetGlobalVoiceAgent: vi.fn(),
    teleportVoiceAgentToSessionRoot: vi.fn(async () => ({ ok: true })),
  };
}

function createActionExecutor(deps: ActionExecutorDeps): ReturnType<typeof createRawActionExecutor> {
  const executor = createRawActionExecutor(deps);
  return {
    ...executor,
    execute: (actionId, input, context) => executor.execute(
      actionId,
      input,
      { surface: 'ui', authority: 'present_user', ...context },
    ),
  };
}

describe('machine Agent inventory execution', () => {
  it('reads bound B options declaration while retaining physical A widget scope', async () => {
    const surface = { serverId: 'home', accountId: 'viewer', owner: { kind: 'sessionBoard' as const, sessionId: 'A' } };
    const definition = { kind: 'installed' as const, surface: { pluginId: 'com.acme.widgets', localId: 'checks' } };
    const executor = createActionExecutor({ ...createDeps(), widgetAccountScope: () => ({ serverId: 'home', accountId: 'viewer' }),
      pathsListRecent: async () => ({ items: [{ path: '/from-A', label: 'A' }] }),
      notificationChannelsList: async () => ({ items: [{ id: 'from-B', label: 'B' }] }),
      widgetCatalog: { list: async (_surface, _context, _signal, boundSession?: { serverId: string; sessionId: string }) => [{
        definition, title: 'Checks', availability: 'available', instanceCount: 0,
        fields: [{ path: 'choice', title: 'Choice', widget: 'select', optionsSourceId: boundSession?.sessionId === 'B' ? 'notifications.channels.available' : 'paths.list_recent' }],
      }] },
    });
    await expect(executor.execute('action.options.resolve', {
      consumer: { kind: 'widget', surface, definition, selectedSession: { serverId: 'home', sessionId: 'B' } }, fieldPath: 'choice',
    })).resolves.toMatchObject({ ok: true, result: { options: [{ value: 'from-B' }] } });
  });
  it('resolves a widget consuming descriptor through the shared source front door', async () => {
    const surface = { serverId: 'home', accountId: 'viewer', owner: { kind: 'home' as const } };
    const definition = { kind: 'builtin' as const, id: 'checks' };
    const executor = createActionExecutor({ ...createDeps(),
      widgetAccountScope: () => ({ serverId: 'home', accountId: 'viewer' }),
      widgetCatalog: { list: async () => [{ definition, title: 'Checks', availability: 'available', instanceCount: 0,
        fields: [{ path: 'choice', title: 'Choice', widget: 'select', options: [{ value: 'current', label: 'Current' }] }] }] },
    });
    await expect(executor.execute('action.options.resolve', {
      consumer: { kind: 'widget', surface, definition }, fieldPath: 'choice',
    })).resolves.toMatchObject({ ok: true, result: { fieldPath: 'choice', options: [{ value: 'current', label: 'Current' }] } });
  });
  it('preserves exact machine, Home and refresh targeting through every inventory surface', async () => {
    const machinesAgentsList = vi.fn(async (_args: MachinesAgentsListInput) => ({ items: [] }));
    const executor = createActionExecutor({ ...createDeps(), machinesAgentsList });
    const input = { machineId: 'machine-1', serverId: 'home-1', agentId: 'acme/helper', refresh: true };
    for (const surface of ['ui', 'cli', 'mcp', 'agent'] as const) {
      await expect(executor.execute(ActionIdSchema.parse('machines.agents.list'), input, {
        surface, authority: surface === 'ui' ? 'present_user' : 'account_automation',
      })).resolves.toEqual({ ok: true, result: { items: [] } });
    }
    expect(machinesAgentsList.mock.calls.map(([args]) => args)).toEqual([input, input, input, input]);
  });

  it('fails closed when the inventory adapter is unavailable', async () => {
    await expect(createActionExecutor(createDeps()).execute(ActionIdSchema.parse('machines.agents.list'), {
      machineId: 'machine-1',
    })).resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
  });
});

const canonicalSessionSpawnInput = {
  creationKey: 'inventory:session-create-1',
  executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
  directory: { kind: 'path', path: '/repo/project' },
  agentTarget: {
    kind: 'agent',
    identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
  },
} as const;

const presentUserActionLaunchOrigin = ExecutionRunLaunchOriginSchema.parse({ kind: 'external', source: 'action' });
const inventoryAgentStartContext = {
  caller: AgentStartSessionCallerV1Schema.parse({ kind: 'session', sessionId: 'session_1', starterDepth: 1, turnDepth: 2 }),
  baseline: {
    machineId: 'machine-1', directory: '/repo/project',
    configuration: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
  },
  ledSubtreeSessionIds: [], roles: {}, workDepthLimit: 4, callerPermissionCeiling: 'default',
} satisfies AgentStartContextV1;

describe('createActionExecutor (inventory/discovery)', () => {
  it('resolves declared plugin input options only through the granted consuming field', async () => {
    const inputType = { pluginId: 'com.acme.inputs', localId: 'repository' };
    const definition: ActionDefinitionV1 = {
      kindVersion: 1, id: 'com.acme.inputs/actions/check', title: 'Check', description: 'Check repository',
      safety: 'safe', placements: [], slash: null, bindings: null, examples: null,
      surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false, api: true, plugin: true },
      inputHints: { fields: [{ path: 'repository', title: 'Repository', widget: 'select', inputType }] },
      inputSchema: { type: 'object', properties: { repository: { type: 'string' } }, additionalProperties: false },
    };
    const reads: unknown[] = [];
    const deps = { ...createDeps(), listContributedActionDefinitions: () => [definition],
      resolveInputType: async () => ({ identity: inputType, occurrenceId: 'serving-1',
        definition: { id: 'repository', title: 'Repository', semantic: 'com.acme.repository',
          valueSchema: { type: 'string', minLength: 1 }, options: { resource: 'repositories' } } }),
      readInputTypeResource: async (request: unknown) => {
        reads.push(request);
        return [{ value: 'repo-one', label: 'One' }];
      },
    };
    const executor = createActionExecutor(deps);
    await expect(executor.execute('action.options.resolve', {
      actionId: definition.id, fieldPath: 'repository',
    }, { surface: 'agent', authority: 'account_automation' })).resolves.toMatchObject({
      ok: true, result: { options: [{ value: 'repo-one', label: 'One' }] },
    });
    expect(reads).toHaveLength(1);
    const surface = { serverId: 'home', accountId: 'account', owner: { kind: 'home' as const } };
    const widgetDefinition = { kind: 'installed' as const, surface: { pluginId: inputType.pluginId, localId: 'repository-widget' } };
    const workflow = 'plugin:com.acme.inputs/review';
    const consumerExecutor = createActionExecutor({ ...deps,
      widgetAccountScope: () => ({ serverId: 'home', accountId: 'account' }),
      widgetCatalog: { list: async () => [{ definition: widgetDefinition, title: 'Repository',
        fields: definition.inputHints!.fields, availability: 'available', instanceCount: 0 }] },
      workflowAction: async () => ({ definitions: [], pluginWorkflows: [{ workflow, pluginId: inputType.pluginId,
        version: '1.0.0', title: 'Review', definition: { version: 1, inputs: [{ name: 'repository', valueType: 'string', required: true, inputType }],
          defaults: {}, blocks: [{ kind: 'wait', id: 'review', document: { text: 'Review', references: [], attachments: [] }, result: { kind: 'text' } }] } }] }),
    });
    for (const consumer of [{ kind: 'workflow', workflow }, { kind: 'widget', surface, definition: widgetDefinition }]) {
      await expect(consumerExecutor.execute('action.options.resolve', { consumer, fieldPath: 'repository' },
        { surface: 'agent', authority: 'account_automation' })).resolves.toMatchObject({ ok: true,
        result: { options: [{ value: 'repo-one', label: 'One' }] } });
    }
    await expect(executor.execute('action.options.resolve', {
      optionsSourceId: 'plugin-input:com.acme.inputs/repository',
    }, { surface: 'agent', authority: 'account_automation' })).resolves.toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(reads).toHaveLength(3);
    const grantedContext = { surface: 'api' as const, authority: 'account_automation' as const,
      externalActionCredential: { accountId: 'account', principalId: 'principal', credentialId: 'credential', grant: {
        v: 1 as const, actions: { families: [], ids: [definition.id] }, targets: { sessions: [], machines: [] },
        approve: false, origins: [], models: null, permissionModes: null, create: null,
      } } };
    await expect(executor.execute('action.options.resolve', { actionId: definition.id, fieldPath: 'repository' }, grantedContext))
      .resolves.toMatchObject({ ok: true, result: { options: [{ value: 'repo-one', label: 'One' }] } });
    for (const consumer of [{ kind: 'workflow', workflow }, { kind: 'widget', surface, definition: widgetDefinition }]) {
      await expect(consumerExecutor.execute('action.options.resolve', { consumer, fieldPath: 'repository' }, grantedContext))
        .resolves.toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    }
    expect(reads).toHaveLength(4);
  });
  it('resolves the Workflow-admitted notification source through headless Action discovery', async () => {
    const executor = createActionExecutor({ ...createDeps(), notificationChannelsList: async () => ({
      items: [{ id: 'push', label: 'Phone' }],
    }) });
    await expect(executor.execute('action.options.resolve', {
      optionsSourceId: 'notifications.channels.available',
    }, { surface: 'agent', authority: 'account_automation' })).resolves.toMatchObject({
      ok: true, result: { options: [{ value: 'push', label: 'Phone' }] },
    });
  });
  it('returns no options source for an admitted picker-only Action field without reading a Resource', async () => {
    const inputType = { pluginId: 'com.acme.inputs', localId: 'repository' };
    const definition: ActionDefinitionV1 = {
      kindVersion: 1, id: 'com.acme.inputs/actions/check', title: 'Check', description: 'Check repository',
      safety: 'safe', placements: [], slash: null, bindings: null, examples: null,
      surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false, api: true, plugin: true },
      inputHints: { fields: [{ path: 'repository', title: 'Repository', widget: 'select', inputType }] },
      inputSchema: { type: 'object', properties: { repository: { type: 'string' } }, additionalProperties: false },
    };
    const reads: unknown[] = [];
    const executor = createActionExecutor({ ...createDeps(), listContributedActionDefinitions: () => [definition],
      resolveInputType: async () => ({ identity: inputType, occurrenceId: 'serving-1', definition: {
        id: 'repository', title: 'Repository', semantic: 'repository', valueSchema: { type: 'string' }, picker: 'picker',
      } }),
      readInputTypeResource: async request => { reads.push(request); return []; },
    });
    await expect(executor.execute('action.options.resolve', { actionId: definition.id, fieldPath: 'repository' }))
      .resolves.toMatchObject({ ok: true, result: { options: [], optionsSourceId: null } });
    expect(reads).toEqual([]);
  });
  it('does not reinterpret a refused dynamic inventory as an empty successful selection', async () => {
    const executor = createActionExecutor({
      ...createDeps(),
      sessionModesList: async () => ({ ok: false, errorCode: 'session_access_denied', error: 'session_access_denied' }),
    });
    await expect(executor.execute('action.options.resolve', {
      optionsSourceId: 'session.modes.available', draftInput: { sessionId: 'session-1' },
    })).resolves.toMatchObject({ ok: false, errorCode: 'session_access_denied' });
  });
  it('cancels only the addressed response through the existing cancel-turn RPC Action', async () => {
    const request = { runId: 'run-1', occurrenceId: 'occurrence-1', turnId: 'turn-1' };
    const output = { ok: true as const, status: 'requested' as const, ...request };
    const requests: unknown[] = [];
    const deps = {
      ...createDeps(),
      executionRunCancelTurn: async (sessionId: string | null, input: unknown) => {
        requests.push({ sessionId, input });
        return output;
      },
    };
    const executor = createActionExecutor(deps);
    const id = ActionIdSchema.parse('execution.run.cancel_turn');
    const caller = { surface: 'agent', authority: 'account_automation', defaultSessionId: 'session-1' } as const;
    const result = await executor.execute(id, { sessionId: 'session-1', ...request }, caller);
    expect(result).toEqual({ ok: true, result: output });
    expect(requests).toEqual([{ sessionId: 'session-1', input: request }]);
    expect(getActionSpec(id).bindings?.rpcMethod).toBe('execution.run.cancelTurn.v1');
    await expect(executor.execute(id, { sessionId: 'session-1', runId: 'run-1', turnId: 'turn-1' }))
      .resolves.toMatchObject({ ok: false });
    await expect(executor.execute(id, { sessionId: 'another-session', ...request }, caller))
      .resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    expect(requests).toHaveLength(1);
  });

  it('uses the canonical feature map for Action search, get, and admission', async () => {
    const homeDomainAction = vi.fn(async () => ({ resources: [] }));
    const enabledFeatures = new Set(['teams', 'teams.credentialResources']);
    const executor = createActionExecutor({
      ...createDeps(),
      homeDomainAction,
      isActionEnabled: (actionId) => {
        const featureId = getActionRequiredServerFeatureId(actionId);
        return featureId === null || enabledFeatures.has(featureId);
      },
    } as ActionExecutorDeps);

    const credentialSearch = await executor.execute(
      'action.spec.search',
      { query: 'teams.credentials.create', limit: 20 },
      { surface: 'api' },
    );
    expect(credentialSearch).toMatchObject({ ok: true });
    if (!credentialSearch.ok) throw new Error('Expected credential Action search to succeed');
    expect(credentialSearch.result.actionSpecs.map((spec) => spec.id)).toContain('teams.credentials.create');

    const externalSearch = await executor.execute(
      'action.spec.search',
      { query: 'teams.credentials.externalKeys.create', limit: 20 },
      { surface: 'api' },
    );
    expect(externalSearch).toMatchObject({ ok: true });
    if (!externalSearch.ok) throw new Error('Expected external-key Action search to succeed');
    expect(externalSearch.result.actionSpecs.map((spec) => spec.id))
      .not.toContain('teams.credentials.externalKeys.create');

    await expect(executor.execute(
      'action.spec.get',
      { id: 'teams.credentials.externalKeys.create' },
      { surface: 'api' },
    )).resolves.toMatchObject({ ok: false, errorCode: 'action_disabled' });

    await expect(executor.execute(
      'teams.credentials.externalKeys.create',
      {
        resourceId: 'resource-1',
        teamMembershipId: 'membership-1',
        label: 'CI runner',
        expiresAt: null,
      },
      { surface: 'api' },
    )).resolves.toMatchObject({ ok: false, errorCode: 'action_disabled' });
    expect(homeDomainAction).not.toHaveBeenCalled();
  });

  it('selects the nearest non-escalating delegate permission when permissionMode is omitted', async () => {
    const deps = createDeps();
    deps.executionRunStart = vi.fn(async () => ({ runId: 'run-1', callId: 'call-1', sidechainId: 'side-1' }));
    const executor = createActionExecutor(deps);

    const res = await executor.execute('subagents.delegate.start', {
      backendTargetKeys: ['agent:claude'],
      instructions: 'Delegate this task.',
    }, { surface: 'agent', authority: 'account_automation', defaultSessionId: 'session_1', agentStartContext: inventoryAgentStartContext });

    expect(res).toMatchObject({ ok: true, result: {
      results: [{ key: 'agent:claude', ok: true, result: { runId: 'run-1' } }],
    } });
    expect(deps.executionRunStart).toHaveBeenCalledWith(
      'session_1',
      expect.objectContaining({ permissionMode: 'default', launchOrigin: { kind: 'session', sessionId: 'session_1' } }),
      expect.objectContaining({ workDepth: 3 }),
    );
  });

  it('rejects an explicit delegate escalation under host-stamped causal authority', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('subagents.delegate.start', {
      backendTargetKeys: ['agent:claude'],
      instructions: 'Delegate this task.',
      permissionMode: 'workspace_write',
    }, {
      surface: 'agent',
      authority: 'account_automation',
      defaultSessionId: 'session_1',
      agentStartContext: inventoryAgentStartContext,
      callerPermissionMode: 'workspace_write',
      causalPermissionAuthority: {
        kind: 'admittedSessionInputV1',
        admittedPermissionCeiling: 'default',
      },
    });

    expect(res).toMatchObject({
      ok: false,
      errorCode: 'permission_exceeds_ceiling',
      details: { code: 'permission_exceeds_ceiling' },
    });
    expect(deps.executionRunStart).not.toHaveBeenCalled();
  });

  it('fails closed when causal permission authority is malformed', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('subagents.delegate.start', {
      backendTargetKeys: ['agent:claude'],
      instructions: 'Delegate this task.',
    }, {
      surface: 'agent',
      defaultSessionId: 'session_1',
      callerPermissionMode: 'workspace_write',
      causalPermissionAuthority: { kind: 'invalid' },
    });

    expect(res).toMatchObject({ ok: false, errorCode: 'causal_permission_authority_invalid' });
    expect(deps.executionRunStart).not.toHaveBeenCalled();
  });

  it('rejects agent execution.run.start above the caller permission ordinal', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('execution.run.start', {
      sessionId: 'session_1',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Run this task.',
      permissionMode: 'workspace_write',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    }, { surface: 'agent', authority: 'account_automation', defaultSessionId: 'session_1', agentStartContext: inventoryAgentStartContext });

    expect(res).toEqual(expect.objectContaining({
      ok: false,
      errorCode: 'permission_exceeds_ceiling',
      error: 'permission_exceeds_ceiling',
      details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
    }));
    expect(deps.executionRunStart).not.toHaveBeenCalled();
  });

  it('uses workspace_write as the default permission mode for subagents.delegate.start', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('subagents.delegate.start', {
      sessionId: 'session_1',
      backendTargetKeys: ['agent:claude'],
      instructions: 'Delegate this task.',
    });

    expect(res.ok).toBe(true);
    expect(deps.executionRunStart).toHaveBeenCalledWith(
      'session_1',
      expect.objectContaining({
        intent: 'delegate',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        permissionMode: 'workspace_write',
        launchOrigin: presentUserActionLaunchOrigin,
        intentInput: expect.objectContaining({
          backendTargetKey: 'agent:claude',
        }),
      }),
      { authority: 'present_user' },
    );
  });

  it('threads per-target connectedServices selections through delegate fanout starts', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const codexSelection = {
      v: 1,
      bindingsByServiceId: {
        'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'profile_1' },
      },
    };
    const blanketSelection = {
      v: 1,
      bindingsByServiceId: {
        'happier.agent.claude/anthropic': { source: 'native' },
      },
    };

    const res = await executor.execute('subagents.delegate.start', {
      sessionId: 'session_1',
      backendTargetKeys: ['agent:codex', 'agent:claude'],
      instructions: 'Delegate this task.',
      connectedServices: blanketSelection,
      connectedServicesByBackendTargetKey: {
        'agent:codex': codexSelection,
      },
    });

    expect(res.ok).toBe(true);
    expect(deps.executionRunStart).toHaveBeenCalledWith(
      'session_1',
      expect.objectContaining({
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        launchOrigin: presentUserActionLaunchOrigin,
        connectedServices: expect.objectContaining({
          bindingsByServiceId: expect.objectContaining({
            'happier.agent.codex/openai-codex': expect.objectContaining({ profileId: 'profile_1' }),
          }),
        }),
      }),
      { authority: 'present_user' },
    );
    const claudeCall = (deps.executionRunStart as ReturnType<typeof vi.fn>).mock.calls
      .find((call) => (call[1] as { backendTarget?: { agentId?: string } }).backendTarget?.agentId === 'claude');
    expect(claudeCall?.[1]).toMatchObject({
      launchOrigin: presentUserActionLaunchOrigin,
      connectedServices: {
        ...blanketSelection,
        v: 2,
      },
    });
    expect(claudeCall?.[2]).toEqual({ authority: 'present_user' });
  });

  it('treats successful execution-run service envelopes as successful fanout results', async () => {
    const deps = createDeps();
    deps.executionRunStart = vi.fn(async () => ({
      ok: true,
      data: {
        runId: 'run_1',
        callId: 'call_1',
        sidechainId: 'side_1',
        requestedConfiguration: { modelId: '  model_1  ', reasoningEffort: 'high' },
      },
    }));
    const executor = createActionExecutor(deps);

    const res = await executor.execute('subagents.plan.start', {
      sessionId: 'session_1',
      backendTargetKeys: ['agent:codex'],
      instructions: 'Plan this task.',
    });

    expect(res).toEqual({
      ok: true,
      result: {
        intent: 'plan',
        sessionId: 'session_1',
        results: [
          {
            key: 'agent:codex',
            ok: true,
            result: {
              runId: 'run_1',
              callId: 'call_1',
              sidechainId: 'side_1',
              requestedConfiguration: { modelId: '  model_1  ', reasoningEffort: 'high' },
            },
          },
        ],
      },
    });
  });

  it('executes subagent starts with V2 backend target keys returned by backend inventory', async () => {
    const deps = createDeps();
    deps.executionRunStart = vi.fn(async () => ({
      ok: true,
      data: {
        runId: 'run_1',
      },
    }));
    const executor = createActionExecutor(deps);

    const res = await executor.execute('subagents.plan.start', {
      sessionId: 'session_1',
      backendTargetKeys: ['backend:codex', 'backend:review-bot:configured:review-bot'],
      instructions: 'Plan this task.',
    });

    expect(res.ok).toBe(true);
    expect(deps.executionRunStart).toHaveBeenNthCalledWith(
      1,
      'session_1',
      expect.objectContaining({
        intent: 'plan',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        launchOrigin: presentUserActionLaunchOrigin,
        intentInput: expect.objectContaining({
          backendTargetKey: 'backend:codex',
        }),
      }),
      { authority: 'present_user' },
    );
    expect(deps.executionRunStart).toHaveBeenNthCalledWith(
      2,
      'session_1',
      expect.objectContaining({
        intent: 'plan',
        backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
        launchOrigin: presentUserActionLaunchOrigin,
        intentInput: expect.objectContaining({
          backendTargetKey: 'backend:review-bot:configured:review-bot',
        }),
      }),
      { authority: 'present_user' },
    );
  });

  it.each(['returned', 'thrown', 'unknown', 'malformed', 'contradictory'] as const)('preserves native launch creation evidence for %s fanout failures', async (failureKind) => {
    const deps = createDeps();
    deps.reviewEnginesList = vi.fn(async () => ({
      items: [{ value: 'coderabbit', label: 'CodeRabbit' }],
    }));
    const message = 'Unable to resolve a default base branch for CodeRabbit review.';
    const details = {
      executionRunStart: { v: failureKind === 'malformed' ? 2 : 1, runCreation: 'noRunCreated' },
      privateBridgeField: 'must-not-escape',
    };
    deps.executionRunStart = vi.fn(async () => {
      if (failureKind === 'thrown') {
        throw Object.assign(new Error(message), { code: 'execution_run_not_allowed', details });
      }
      return {
        ok: false,
        code: 'execution_run_not_allowed',
        message,
        ...(failureKind === 'unknown' ? {} : { details }),
        ...(failureKind === 'contradictory' ? { runId: 'partially-created-run' } : {}),
      };
    });
    const executor = createActionExecutor(deps);

    const res = await executor.execute('review.start', {
      sessionId: 'session_1',
      engineIds: ['coderabbit'],
      instructions: 'Review this task.',
      changeType: 'committed',
      base: { kind: 'none' },
    });

    expect(res).toEqual({
      ok: true,
      result: {
        intent: 'review',
        sessionId: 'session_1',
        results: [
          {
            key: 'coderabbit',
            ok: false,
            errorCode: 'execution_run_not_allowed',
            error: 'Unable to resolve a default base branch for CodeRabbit review.',
            details: { executionRunStart: { v: 1, runCreation: failureKind === 'returned' || failureKind === 'thrown' ? 'noRunCreated' : 'outcomeUnknown' } },
          },
        ],
      },
    });
    if (!res.ok) throw new Error('Review Action did not dispatch');
    expect(getActionSpec('review.start').completion?.launched(res.result)).toEqual({
      runs: [],
      failed: [{ key: 'coderabbit', errorCode: 'execution_run_not_allowed' }],
    });
  });

  it('rejects attached execution.run.send before dispatch even with a default Session', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);
    const result = await executor.execute('execution.run.send', {
      sessionId: 'session_1', runId: 'run_1', message: 'Continue',
    }, { defaultSessionId: 'session_1' });
    expect(result).toMatchObject({ ok: false, errorCode: 'session_input_target_update_required' });
    expect(deps.detachedExecutionRunSend).not.toHaveBeenCalled();
    const schema = getActionSpec('execution.run.send').inputSchema;
    expect(schema.safeParse({ runId: 'run_1', message: 'Continue' }).success).toBe(false);
    expect(schema.safeParse({ sessionId: null, runId: 'run_1', message: 'Continue', unknown: true }).success).toBe(false);
    expect(schema.safeParse({ sessionId: null, runId: 'run_1', message: 'Continue', delivery: 'interrupt' }).success).toBe(true);
  });

  it('returns the typed update requirement for the released Session-scoped send body without weakening detached input', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);
    const releasedBody = {
      runId: 'run_1',
      message: 'Continue',
      delivery: 'steer_if_supported' as const,
    };

    await expect(executor.execute('execution.run.send', releasedBody, {
      defaultSessionId: 'session_1',
      surface: 'rpc',
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'session_input_target_update_required',
    });
    await expect(executor.execute('execution.run.send', releasedBody, {
      surface: 'rpc',
    })).resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(deps.detachedExecutionRunSend).not.toHaveBeenCalled();
  });

  it('defaults execution.run.send delivery to steer_if_supported and omits resume when unset', async () => {
    const deps = createDeps();
    deps.executionRunCheckProtocolV2 = async () => ({ ok: true });
    const executor = createActionExecutor(deps);

    const res = await executor.execute('execution.run.send', {
      sessionId: null,
      runId: 'run_1',
      message: 'Continue and summarize what changed.',
    });

    expect(res.ok).toBe(true);
    expect(deps.detachedExecutionRunSend).toHaveBeenCalledWith(
      null,
      {
        runId: 'run_1',
        message: 'Continue and summarize what changed.',
        delivery: 'steer_if_supported',
      },
      { authority: 'present_user' },
    );
  });

  it('preserves send outcome-unknown admission through the public Action failure envelope', async () => {
    const canonicalCode = 'execution_run_send_outcome_unknown' satisfies ExecutionRunTransportErrorCode;
    const deps = createDeps();
    deps.executionRunCheckProtocolV2 = async () => ({ ok: true });
    deps.detachedExecutionRunSend = vi.fn(async () => ({
      ok: false as const,
      errorCode: canonicalCode,
      error: 'Provider admission outcome is unknown; inspect the retained run before retrying.',
    }));
    const executor = createActionExecutor(deps);

    const result = await executor.execute('execution.run.send', {
      sessionId: null,
      runId: 'run_1',
      message: 'Continue and summarize what changed.',
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'execution_run_send_outcome_unknown',
      error: 'Provider admission outcome is unknown; inspect the retained run before retrying.',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(ExecutionRunTransportErrorCodeSchema.parse(result.errorCode)).toBe('execution_run_send_outcome_unknown');
    }
  });

  it('preserves protocol-owned spawn error codes thrown by action dependencies', async () => {
    const deps = createDeps();
    deps.sessionSpawnNew = vi.fn(async () => {
      const error = new Error('Provider preflight failed before spawning.');
      (error as Error & { code: string }).code = SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED;
      throw error;
    });
    const executor = createActionExecutor(deps);

    const res = await executor.execute('session.spawn_new', canonicalSessionSpawnInput, { authority: 'present_user' });

    expect(res).toEqual({
      ok: false,
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      error: 'Provider preflight failed before spawning.',
    });
  });

  it('prefers protocol-owned errorCode over generic thrown code fields', async () => {
    const deps = createDeps();
    deps.sessionSpawnNew = vi.fn(async () => {
      const error = new Error('Provider preflight failed before spawning.');
      (error as Error & { code: string; errorCode: string }).code = 'ERR_BAD_RESPONSE';
      (error as Error & { code: string; errorCode: string }).errorCode = SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED;
      throw error;
    });
    const executor = createActionExecutor(deps);

    const res = await executor.execute('session.spawn_new', canonicalSessionSpawnInput, { authority: 'present_user' });

    expect(res).toEqual({
      ok: false,
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      error: 'Provider preflight failed before spawning.',
    });
  });

  it('treats returned spawn-result errors as failed action results', async () => {
    const deps = createDeps();
    deps.sessionSpawnNew = vi.fn(async () => ({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: 'OhMyPi has no chat-capable models.',
    }));
    const executor = createActionExecutor(deps);

    const res = await executor.execute('session.spawn_new', canonicalSessionSpawnInput, { authority: 'present_user' });

    expect(res).toEqual({
      ok: false,
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      error: 'OhMyPi has no chat-capable models.',
    });
  });

  it('treats returned spawn-shaped local validation errors as failed action results', async () => {
    const deps = createDeps();
    deps.sessionSpawnNew = vi.fn(async () => ({
      type: 'error',
      errorCode: 'host_not_found',
      errorMessage: 'host_not_found',
      host: 'other-host',
    }));
    const executor = createActionExecutor(deps);

    const res = await executor.execute('session.spawn_new', canonicalSessionSpawnInput, { authority: 'present_user' });

    expect(res).toEqual({
      ok: false,
      errorCode: 'host_not_found',
      error: 'host_not_found',
    });
  });

  it('routes paths.list_recent to deps.pathsListRecent', async () => {
    const deps = createDeps();
    const items = [{ path: '/repo', label: 'Repo' }, { label: 'Private workspace' }];
    const pathsListRecent = vi.fn(async () => ({ items }));
    const executor = createActionExecutor({ ...deps, pathsListRecent });

    const res = await executor.execute('paths.list_recent', { machineId: 'm1', limit: 3 });
    expect(res).toEqual({ ok: true, result: { items } });
    expect(pathsListRecent).toHaveBeenCalledWith({ machineId: 'm1', limit: 3 });
  });

  it('routes projects.list to deps.projectsList', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    // The spec surfaces this on `ui` alone: its only caller is a mounted
    // client surface reading the registry that client already holds.
    const res = await executor.execute('projects.list', { machineId: 'm1', limit: 5 }, { surface: 'ui' });
    expect(res.ok).toBe(true);
    expect(deps.projectsList).toHaveBeenCalledWith({ machineId: 'm1', limit: 5 });
  });

  /**
   * A client that holds no project registry says so. Answering an empty list
   * would tell a caller "you have no matching project" when the truth is "this
   * client cannot answer that question", and those need different words in
   * front of a reader.
   */
  it('reports projects.list unsupported when the host installs no dependency', async () => {
    const deps = createDeps();
    const { projectsList: _omitted, ...withoutProjectsList } = deps;
    const executor = createActionExecutor(withoutProjectsList as typeof deps);

    const res = await executor.execute('projects.list', {}, { surface: 'ui' });
    expect(res).toMatchObject({ ok: false, errorCode: 'unsupported_action' });
  });

  it('routes machines.list to deps.machinesList', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('machines.list', { limit: 20 });
    expect(res.ok).toBe(true);
    expect(deps.machinesList).toHaveBeenCalledWith({ limit: 20 });
  });

  it('routes servers.list to deps.serversList', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('servers.list', { limit: 20 });
    expect(res.ok).toBe(true);
    expect(deps.serversList).toHaveBeenCalledWith({ limit: 20 });
  });

  it('routes review.engines.list to deps.reviewEnginesList', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('review.engines.list', { sessionId: 's1', includeDisabled: true });
    expect(res.ok).toBe(true);
    expect(deps.reviewEnginesList).toHaveBeenCalledWith({ sessionId: 's1', includeDisabled: true });
  });

  it('routes exact-path review scope to the shared engine inventory', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('review.engines.list', { sessionId: 's1', scope: 'paths' });

    expect(res.ok).toBe(true);
    expect(deps.reviewEnginesList).toHaveBeenCalledWith({ sessionId: 's1', scope: 'paths' });
  });

  it('keeps execution-run list scope out of the transport request', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('execution.run.list', {
      sessionId: 'session_1',
      status: 'running',
      limit: 5,
    });

    expect(res.ok).toBe(true);
    expect(deps.executionRunList).toHaveBeenCalledWith(
      'session_1',
      expect.objectContaining({
        status: 'running',
        limit: 5,
      }),
      { authority: 'present_user' },
    );
    expect((deps.executionRunList as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).not.toHaveProperty('sessionId');
  });

  it('routes voice_agent.start to deps.executionRunStart', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('voice_agent.start', {
      sessionId: 'session_1',
      backendTargetKeys: ['agent:codex'],
      instructions: 'Start the voice agent run.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'long_lived',
      ioMode: 'streaming',
    });

    expect(res.ok).toBe(true);
    expect(deps.executionRunStart).toHaveBeenCalledWith(
      'session_1',
      expect.objectContaining({
        intent: 'voice_agent',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'long_lived',
        ioMode: 'streaming',
        launchOrigin: presentUserActionLaunchOrigin,
        intentInput: expect.objectContaining({
          backendTargetKey: 'agent:codex',
        }),
      }),
      { authority: 'present_user' },
    );
  });

  it('routes agents.backends.list to deps.agentsBackendsList', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('agents.backends.list', { includeDisabled: false, limit: 2, machineId: 'm1' });
    expect(res.ok).toBe(true);
    expect(deps.agentsBackendsList).toHaveBeenCalledWith({ includeDisabled: false, limit: 2, machineId: 'm1' });
  });

  it('routes agents.models.list to deps.agentsModelsList', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('agents.models.list', { agentId: 'claude', machineId: 'm1', limit: 3 });
    expect(res.ok).toBe(true);
    expect(deps.agentsModelsList).toHaveBeenCalledWith({ agentId: 'claude', machineId: 'm1', limit: 3 });
  });

  it('routes agents.config_options.list to deps.agentsConfigOptionsList', async () => {
    const deps = createDeps() as ActionExecutorDeps & {
      agentsConfigOptionsList: ReturnType<typeof vi.fn>;
    };
    deps.agentsConfigOptionsList.mockResolvedValueOnce({
      items: [{ id: 'reasoning_effort', label: 'Thinking', type: 'select' }],
    });
    const executor = createActionExecutor(deps);

    const res = await executor.execute('agents.config_options.list' as any, {
      agentId: 'claude',
      backendTargetKey: 'backend:claude',
      machineId: 'm1',
      modelId: 'claude-opus-4-8',
      limit: 5,
    }, { serverId: 'local' });

    expect(res.ok).toBe(true);
    expect(deps.agentsConfigOptionsList).toHaveBeenCalledWith({
      agentId: 'claude',
      backendTargetKey: 'backend:claude',
      machineId: 'm1',
      serverId: 'local',
      modelId: 'claude-opus-4-8',
      limit: 5,
    });
    expect((res as any).result.items).toEqual([
      { id: 'reasoning_effort', label: 'Thinking', type: 'select' },
    ]);
  });

  it('routes agents.session_modes.list to deps.agentsSessionModesList', async () => {
    const deps = createDeps() as ActionExecutorDeps & {
      agentsSessionModesList: ReturnType<typeof vi.fn>;
    };
    deps.agentsSessionModesList.mockResolvedValueOnce({
      items: [{ id: 'plan', label: 'Plan' }],
    });
    const executor = createActionExecutor(deps);

    const res = await executor.execute('agents.session_modes.list' as any, {
      agentId: 'codex',
      backendTargetKey: 'backend:codex',
      machineId: 'm1',
      limit: 5,
    });

    expect(res.ok).toBe(true);
    expect(deps.agentsSessionModesList).toHaveBeenCalledWith({
      agentId: 'codex',
      backendTargetKey: 'backend:codex',
      machineId: 'm1',
      limit: 5,
    });
    expect((res as any).result.items).toEqual([{ id: 'plan', label: 'Plan' }]);
  });

  const hostStampedServerInventoryCases = [
    ['agents.models.list', 'agentsModelsList', {
      agentId: 'claude',
      backendTargetKey: 'backend:claude',
      machineId: 'm1',
    }],
    ['agents.config_options.list', 'agentsConfigOptionsList', {
      agentId: 'claude',
      backendTargetKey: 'backend:claude',
      machineId: 'm1',
    }],
    ['agents.session_modes.list', 'agentsSessionModesList', {
      agentId: 'codex',
      backendTargetKey: 'backend:codex',
      machineId: 'm1',
    }],
    ['sessions.spawn.connected_services.list', 'spawnConnectedServicesList', {
      agentId: 'codex',
      backendTargetKey: 'backend:codex',
      machineId: 'm1',
    }],
  ] as const;

  it.each(hostStampedServerInventoryCases)(
    'rejects caller-supplied server identity before inventory dispatch for %s',
    async (actionId, dependencyName, actionInput) => {
      const deps = createDeps();
      const executor = createActionExecutor(deps);

      await expect(executor.execute(
        actionId,
        { ...actionInput, serverId: 'caller-controlled' },
        { serverId: 'host-stamped' },
      )).resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
      expect(deps[dependencyName]).not.toHaveBeenCalled();
    },
  );

  it.each(hostStampedServerInventoryCases)(
    'binds host-stamped server identity for %s',
    async (actionId, dependencyName, actionInput) => {
      const deps = createDeps();
      const executor = createActionExecutor(deps);

      const result = await executor.execute(
        actionId,
        actionInput,
        { serverId: 'host-stamped' },
      );

      expect(result.ok).toBe(true);
      expect(deps[dependencyName]).toHaveBeenCalledWith(expect.objectContaining({
        serverId: 'host-stamped',
      }));
    },
  );

  it('lists spawn profiles with no agent scope, because a profile supplies the agent', async () => {
    // A Triage action selects a profile FIRST and the profile then supplies the
    // agent, so the profiles catalog is the one spawn-option source whose agent
    // scope is a FILTER rather than a requirement. Requiring it here made an
    // unscoped read fail validation, which every caller could only observe as
    // "the catalog did not answer".
    const deps = createDeps() as ActionExecutorDeps & {
      spawnProfilesList: ReturnType<typeof vi.fn>;
    };
    deps.spawnProfilesList.mockResolvedValueOnce({
      items: [{ id: 'profile-1', label: 'Focused' }],
    });
    const executor = createActionExecutor(deps);

    await expect(executor.execute('sessions.spawn.profiles.list' as any, {}))
      .resolves.toMatchObject({ ok: true });
    expect(deps.spawnProfilesList).toHaveBeenCalledWith({});
  });

  it('still refuses a spawn profiles read whose agent scope contradicts itself', async () => {
    const deps = createDeps() as ActionExecutorDeps & {
      spawnProfilesList: ReturnType<typeof vi.fn>;
    };
    const executor = createActionExecutor(deps);

    await expect(executor.execute('sessions.spawn.profiles.list' as any, {
      agentId: 'codex',
      backendTargetKey: 'backend:claude',
    })).resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(deps.spawnProfilesList).not.toHaveBeenCalled();
  });

  it('routes spawn option inventory actions through their matching deps', async () => {
    const deps = createDeps() as ActionExecutorDeps & {
      spawnProfilesList: ReturnType<typeof vi.fn>;
      spawnConnectedServicesList: ReturnType<typeof vi.fn>;
      spawnMcpServersPreview: ReturnType<typeof vi.fn>;
    };
    deps.spawnProfilesList.mockResolvedValueOnce({
      items: [{ id: 'default', label: 'Default', builtIn: true }],
    });
    deps.spawnConnectedServicesList.mockResolvedValueOnce({
      items: [{ serviceId: 'openai', label: 'OpenAI', profiles: [] }],
    });
    deps.spawnMcpServersPreview.mockResolvedValueOnce({
      items: [{ id: 'managed:repo', label: 'Repo MCP', selected: true }],
    });
    const executor = createActionExecutor(deps);

    await expect(executor.execute('sessions.spawn.profiles.list' as any, {
      agentId: 'codex',
      backendTargetKey: 'backend:codex',
      limit: 10,
    })).resolves.toMatchObject({ ok: true });
    expect(deps.spawnProfilesList).toHaveBeenCalledWith({
      agentId: 'codex',
      backendTargetKey: 'backend:codex',
      limit: 10,
    });

    await expect(executor.execute('sessions.spawn.connected_services.list' as any, {
      agentId: 'codex',
      backendTargetKey: 'backend:codex',
      includeUnavailable: true,
    })).resolves.toMatchObject({ ok: true });
    expect(deps.spawnConnectedServicesList).toHaveBeenCalledWith({
      agentId: 'codex',
      backendTargetKey: 'backend:codex',
      includeUnavailable: true,
    });

    await expect(executor.execute('sessions.spawn.mcp_servers.preview' as any, {
      agentId: 'codex',
      machineId: 'm1',
      directory: '/repo',
    })).resolves.toMatchObject({ ok: true });
    expect(deps.spawnMcpServersPreview).toHaveBeenCalledWith({
      agentId: 'codex',
      machineId: 'm1',
      directory: '/repo',
    });
  });

  it('drops additive undeclared fields for agents.models.list', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('agents.models.list', {
      backendTargetKey: 'backend:codex',
      machineId: 'm1',
      limit: 2,
      providerTraceId: 'preview-field',
    });

    expect(res.ok).toBe(true);
    expect(deps.agentsModelsList).toHaveBeenCalledWith({
      agentId: 'codex',
      backendTargetKey: 'backend:codex',
      machineId: 'm1',
      limit: 2,
    });
  });

  it('routes configured ACP backendTargetKey through agents.models.list', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('agents.models.list', {
      backendTargetKey: 'acpBackend:review-bot',
      machineId: 'm1',
      limit: 2,
    });

    expect(res.ok).toBe(true);
    expect(deps.agentsModelsList).toHaveBeenCalledWith({
      backendTargetKey: 'acpBackend:review-bot',
      machineId: 'm1',
      limit: 2,
    });
  });

  it('does not forward legacy configured ACP agentId carriers when backendTargetKey is configured', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('agents.models.list', {
      agentId: 'acp:review-bot',
      backendTargetKey: 'backend:review-bot:configured:review-bot',
      machineId: 'm1',
      limit: 2,
    });

    expect(res.ok).toBe(true);
    expect(deps.agentsModelsList).toHaveBeenCalledWith({
      backendTargetKey: 'backend:review-bot:configured:review-bot',
      machineId: 'm1',
      limit: 2,
    });
  });

  it('routes canonical plugin backendTargetKey plus runtime carrier through agents.models.list', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('agents.models.list', {
      agentId: 'claude',
      backendTargetKey: 'backend:plugin-review-bot',
      machineId: 'm1',
      limit: 2,
    });

    expect(res.ok).toBe(true);
    expect(deps.agentsModelsList).toHaveBeenCalledWith({
      agentId: 'claude',
      backendTargetKey: 'backend:plugin-review-bot',
      machineId: 'm1',
      limit: 2,
    });
  });

  it('rejects ambiguous customAcp agentId for agents.models.list without backendTargetKey', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('agents.models.list', {
      agentId: 'customAcp',
      machineId: 'm1',
    });

    expect(res).toEqual({ ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' });
    expect(deps.agentsModelsList).not.toHaveBeenCalled();
  });

  it('rejects agent:customAcp as a concrete backend target for agents.models.list', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('agents.models.list', {
      backendTargetKey: 'agent:customAcp',
      machineId: 'm1',
    });

    expect(res).toEqual({ ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' });
    expect(deps.agentsModelsList).not.toHaveBeenCalled();
  });

  it('opens a session by exact title when sessionId is omitted', async () => {
    const deps = createDeps();
    deps.resolveSessionReference = vi.fn(async () => ({
      kind: 'unique' as const,
      address: { serverId: 'server-b', sessionId: 's2' },
    }));
    const executor = createActionExecutor(deps);

    const res = await executor.execute('session.open', { sessionTitle: 'Target Session' });

    expect(res.ok).toBe(true);
    expect(deps.resolveSessionReference).toHaveBeenCalledWith(expect.objectContaining({
      sessionTitle: 'Target Session',
    }));
    expect(deps.sessionOpen).toHaveBeenCalledWith({ sessionId: 's2', serverId: 'server-b' });
  });

  it('delegates deep title resolution once without imposing the former pagination cap', async () => {
    const deps = createDeps();
    deps.resolveSessionReference = vi.fn(async () => ({
      kind: 'unique' as const,
      address: { serverId: 'server-deep', sessionId: 'after-2000' },
    }));
    const executor = createActionExecutor(deps);

    const res = await executor.execute('session.open', { sessionTitle: 'Deep result' });

    expect(res.ok).toBe(true);
    expect(deps.resolveSessionReference).toHaveBeenCalledOnce();
    expect(deps.sessionList).not.toHaveBeenCalled();
    expect(deps.sessionOpen).toHaveBeenCalledWith({
      sessionId: 'after-2000',
      serverId: 'server-deep',
    });
  });

  it('passes the resolved server scope when opening a session', async () => {
    const deps = createDeps();
    deps.resolveServerIdForSessionId = vi.fn(() => 'server-b');
    const executor = createActionExecutor(deps);

    const signal = new AbortController().signal;
    const res = await executor.execute(
      'session.open',
      { sessionId: 's2' },
      { serverId: 'server-a', signal, actionRequestId: 'plugin-call-1' },
    );

    expect(res.ok).toBe(true);
    expect(deps.resolveServerIdForSessionId).not.toHaveBeenCalled();
    expect(deps.sessionOpen).toHaveBeenCalledWith({
      sessionId: 's2',
      serverId: 'server-a',
      signal,
      actionRequestId: 'plugin-call-1',
    });
  });

  it('does not open a session when the requested title is ambiguous', async () => {
    const deps = createDeps();
    deps.resolveSessionReference = vi.fn(async () => ({
      kind: 'ambiguous' as const,
      candidates: [
        { serverId: 'server-a', sessionId: 'same' },
        { serverId: 'server-b', sessionId: 'same' },
      ],
    }));
    const executor = createActionExecutor(deps);

    const res = await executor.execute('session.open', { sessionTitle: 'Target Session' });

    expect(res).toEqual({ ok: false, errorCode: 'session_id_ambiguous', error: 'session_id_ambiguous' });
    expect(deps.sessionOpen).not.toHaveBeenCalled();
  });

  it('rejects legacy bare and title primary targets before mutation', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    await expect(executor.execute('session.target.primary.set', { sessionId: 'same' }))
      .resolves.toEqual({ ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' });
    await expect(executor.execute('session.target.primary.set', { sessionTitle: 'Target Session' }))
      .resolves.toEqual({ ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' });
    expect(deps.sessionTargetPrimarySet).not.toHaveBeenCalled();
  });

  it('fails closed without opening when the authoritative Session corpus is incomplete', async () => {
    const deps = createDeps();
    deps.resolveSessionReference = vi.fn(async () => ({ kind: 'incomplete' as const }));
    const executor = createActionExecutor(deps);

    const res = await executor.execute('session.open', { sessionTitle: 'Target Session' });

    expect(res).toEqual({ ok: false, errorCode: 'session_lookup_incomplete', error: 'session_lookup_incomplete' });
    expect(deps.sessionOpen).not.toHaveBeenCalled();
  });

  it('keeps an explicit Home-qualified Session target exact without consulting the corpus resolver', async () => {
    const deps = createDeps();
    deps.resolveSessionReference = vi.fn(async () => ({ kind: 'incomplete' as const }));
    const executor = createActionExecutor(deps);

    const res = await executor.execute(
      'session.target.primary.set',
      { sessionId: 'same', serverId: 'server-b' },
    );

    expect(res.ok).toBe(true);
    expect(deps.resolveSessionReference).not.toHaveBeenCalled();
    expect(deps.sessionTargetPrimarySet).toHaveBeenCalledWith({ sessionId: 'same', serverId: 'server-b' });
  });

  it('rejects session targeting when no client target owner is supplied', async () => {
    const deps: ActionExecutorDeps = {
      ...createDeps(),
      sessionTargetPrimarySet: undefined,
      sessionTargetTrackedSet: undefined,
    };
    const executor = createActionExecutor(deps);

    await expect(executor.execute(
      'session.target.primary.set',
      { sessionId: 's2', serverId: 'server-a' },
      { surface: 'ui' },
    )).resolves.toEqual({
      ok: false,
      errorCode: 'unsupported_action',
      error: 'unsupported_action:session.target.primary.set',
    });
    await expect(executor.execute(
      'session.target.tracked.set',
      { sessionAddresses: [{ serverId: 'server-a', sessionId: 's2' }] },
      { surface: 'ui' },
    )).resolves.toEqual({
      ok: false,
      errorCode: 'unsupported_action',
      error: 'unsupported_action:session.target.tracked.set',
    });
  });

  it('preserves a typed partial tracked-target settlement instead of reporting full success', async () => {
    const deps = createDeps();
    deps.sessionTargetTrackedSet = vi.fn(async () => ({
      ok: false,
      status: 'partial' as const,
      sessionIds: [],
      sessionAddresses: [],
      sessions: [],
      error: {
        code: 'session_follow_partial' as const,
        message: 'Retry the remaining operation.',
        operation: 'include' as const,
        address: { serverId: 'server-a', sessionId: 's2' },
        reason: 'unavailable' as const,
      },
    }));
    const executor = createActionExecutor(deps);

    await expect(executor.execute(
      'session.target.tracked.set',
      { sessionAddresses: [{ serverId: 'server-a', sessionId: 's2' }] },
      { surface: 'voice' },
    )).resolves.toEqual({
      ok: true,
      result: {
        ok: false,
        status: 'partial',
        sessionIds: [],
        sessionAddresses: [],
        sessions: [],
        error: {
          code: 'session_follow_partial',
          message: 'Retry the remaining operation.',
          operation: 'include',
          address: { serverId: 'server-a', sessionId: 's2' },
          reason: 'unavailable',
        },
      },
    });
    expect(deps.sessionTargetTrackedSet).toHaveBeenCalledWith(expect.objectContaining({
      sessionAddresses: [{ serverId: 'server-a', sessionId: 's2' }],
    }));
  });

  it('forwards the released tracked-target bare ids to the compatibility resolver', async () => {
    const deps = createDeps();
    deps.sessionTargetTrackedSet = vi.fn(async () => ({
      ok: true,
      status: 'ok' as const,
      sessionIds: ['s2'],
      sessionAddresses: [{ serverId: 'server-a', sessionId: 's2' }],
      sessions: [],
    }));
    const executor = createActionExecutor(deps);

    await expect(executor.execute(
      'session.target.tracked.set',
      { sessionIds: ['s2'] },
      { surface: 'voice' },
    )).resolves.toMatchObject({ ok: true });
    expect(deps.sessionTargetTrackedSet).toHaveBeenCalledWith(expect.objectContaining({ sessionIds: ['s2'] }));
  });

  it('delivers a more than 50-target replacement to the dependency and settles its result', async () => {
    const deps = createDeps();
    const sessionAddresses = Array.from({ length: 51 }, (_, index) => ({
      serverId: 'server-a',
      sessionId: `session-${index}`,
    }));
    deps.sessionTargetTrackedSet = vi.fn(async () => ({
      ok: true,
      status: 'ok' as const,
      sessionIds: sessionAddresses.map(address => address.sessionId),
      sessionAddresses,
      sessions: [],
    }));
    const executor = createActionExecutor(deps);

    await expect(executor.execute(
      'session.target.tracked.set',
      { sessionAddresses },
      { surface: 'voice' },
    )).resolves.toEqual({
      ok: true,
      result: {
        ok: true,
        status: 'ok',
        sessionIds: sessionAddresses.map(address => address.sessionId),
        sessionAddresses,
        sessions: [],
      },
    });
    expect(deps.sessionTargetTrackedSet).toHaveBeenCalledWith(expect.objectContaining({ sessionAddresses }));
  });

  it('routes session.user_action.answer to deps.sessionUserActionAnswer', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('session.user_action.answer', {
      sessionId: 's1',
      requestId: 'req_1',
      answers: [{
        question: 'Where should this run?',
        values: ['Washington, D.C.', 'Virginia', 'A custom, exact answer'],
      }],
    });
    expect(res.ok).toBe(true);
    expect(deps.sessionUserActionAnswer).toHaveBeenCalledWith({
      sessionId: 's1',
      requestId: 'req_1',
      context: { surface: 'ui', authority: 'present_user' },
      answers: [{
        question: 'Where should this run?',
        values: ['Washington, D.C.', 'Virginia', 'A custom, exact answer'],
      }],
    });
  });

  it('normalizes the released scalar session.user_action.answer shape at the ActionSpec boundary', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('session.user_action.answer', {
      sessionId: 's1',
      requestId: 'req_legacy',
      answers: [{ question: 'What next?', answer: 'Proceed' }],
    });

    expect(res.ok).toBe(true);
    expect(deps.sessionUserActionAnswer).toHaveBeenCalledWith({
      sessionId: 's1',
      requestId: 'req_legacy',
      context: { surface: 'ui', authority: 'present_user' },
      answers: [{ question: 'What next?', values: ['Proceed'] }],
    });
  });

  it('routes session.user_action.answer decisions to deps.sessionUserActionAnswer', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('session.user_action.answer', {
      sessionId: 's1',
      requestId: 'req_1',
      decision: 'request_changes',
      reason: 'Revise the plan before exiting plan mode.',
    });

    expect(res.ok).toBe(true);
    expect(deps.sessionUserActionAnswer).toHaveBeenCalledWith({
      sessionId: 's1',
      requestId: 'req_1',
      context: { surface: 'ui', authority: 'present_user' },
      decision: 'request_changes',
      reason: 'Revise the plan before exiting plan mode.',
      answers: [],
    });
    expect(vi.mocked(deps.sessionUserActionAnswer!).mock.calls[0]?.[0]).not.toHaveProperty('updatedPermissions');
  });

  it('searches enabled action specs through action.spec.search', async () => {
    const deps = createDeps();
    const executor = createActionExecutor({
      ...deps,
      isActionEnabled: (actionId) => actionId !== 'review.start',
    });

    for (const [actionId, expected] of [
      ['subagents.plan.start', true],
      ['review.start', false],
      ['session.mode.set', true],
      ['execution.run.cancel_turn', false],
    ] as const) {
      const res = await executor.execute('action.spec.search', { query: actionId, limit: 50 }, { surface: 'voice' });
      expect(res).toMatchObject({ ok: true });
      if (!res.ok) throw new Error('Action search did not complete');
      expect(res.result.actionSpecs.some((spec) => spec.id === actionId)).toBe(expected);
    }
  });

  it('discovers current contributed Action definitions through the shared catalog operations', async () => {
    const contributedAction: ActionDefinitionV1 = {
      kindVersion: 1,
      id: 'acme.triage/actions/refresh-issue',
      title: 'Refresh issue',
      description: 'Refresh the selected issue.',
      safety: 'safe',
      approval: { result: 'none' },
      placements: [],
      slash: null,
      bindings: null,
      examples: null,
      surfaces: {
        ui: false,
        voice: false,
        agent: false,
        mcp: false,
        cli: false,
        rpc: false,
        api: true,
        plugin: false,
      },
      inputHints: {
        title: 'Refresh issue',
        fields: [{
          path: 'depth',
          title: 'Depth',
          widget: 'select',
          options: [
            { value: 'summary', label: 'Summary' },
            { value: 'full', label: 'Full' },
          ],
          }, {
            path: 'assignee',
            title: 'Assignee',
            widget: 'select',
            optionsSourceId: 'acme.triage/assignees',
          }],
      },
      inputSchema: {
        type: 'object',
        properties: {
          depth: { type: 'string', enum: ['summary', 'full'] },
          schemaOnly: { type: 'string', enum: ['one', 'two'] },
        },
        required: ['depth'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: { refreshed: { type: 'boolean' } },
        required: ['refreshed'],
        additionalProperties: false,
      },
    };
    // The bulk listing carries no schemas; spec.get reads them per Action.
    const {
      kindVersion: _kindVersion,
      inputSchema: contributedInputSchema,
      outputSchema: contributedOutputSchema,
      ...contributedSummary
    } = contributedAction;
    const listContributedActionDefinitions = vi.fn(() => [contributedSummary]);
    const readContributedActionSchemas = vi.fn(async (id: string) => (
      id === contributedAction.id
        ? { inputSchema: contributedInputSchema, outputSchema: contributedOutputSchema }
        : null
    ));
    const executor = createActionExecutor({
      ...createDeps(),
      listContributedActionDefinitions,
      readContributedActionSchemas,
    } as ActionExecutorDeps);

    const searchResult = await executor.execute(
      'action.spec.search',
      { query: contributedAction.id, limit: 5 },
      { surface: 'api' },
    );
    expect(listContributedActionDefinitions).toHaveBeenCalledTimes(1);
    expect(searchResult.ok).toBe(true);
    if (!searchResult.ok) throw new Error('Expected contributed Action search to succeed');
    expect(searchResult.result.actionSpecs.map((definition) => definition.id)).toContain(contributedAction.id);
    const approvalRequiredSettings = ActionsSettingsV1Schema.parse({
      v: 1,
      actions: {
        [contributedAction.id]: {
          approvalRequiredSurfaces: ['api'],
        },
      },
    });
    const approvalRequiredSearchResult = await executor.execute(
      'action.spec.search',
      { query: contributedAction.id, limit: 5 },
      { surface: 'api', actionsSettings: approvalRequiredSettings },
    );
    expect(approvalRequiredSearchResult.ok).toBe(true);
    if (!approvalRequiredSearchResult.ok) throw new Error('Expected approval-required Action search to succeed');
    expect(approvalRequiredSearchResult.result.actionSpecs.map((definition) => definition.id))
      .toContain(contributedAction.id);
    await expect(executor.execute(
      'action.spec.get',
      { id: contributedAction.id },
      { surface: 'api', actionsSettings: approvalRequiredSettings },
    )).resolves.toEqual({
      ok: true,
      result: { actionSpec: contributedAction },
    });
    expect(readContributedActionSchemas).toHaveBeenCalledWith(contributedAction.id, undefined);
    await expect(executor.execute(
      'action.options.resolve',
      { actionId: contributedAction.id, fieldPath: 'depth', query: 'full' },
      { surface: 'api' },
    )).resolves.toEqual({
      ok: true,
      result: {
        actionId: contributedAction.id,
        fieldPath: 'depth',
        optionsSourceId: null,
        options: [{ value: 'full', label: 'Full' }],
      },
    });
    await expect(executor.execute(
      'action.options.resolve',
      { actionId: contributedAction.id, fieldPath: 'assignee' },
      { surface: 'api' },
    )).resolves.toEqual({
      ok: false,
      errorCode: 'unavailable',
      error: 'unavailable',
    });
    await expect(executor.execute(
      'action.options.resolve',
      { actionId: contributedAction.id, fieldPath: 'schemaOnly' },
      { surface: 'api' },
    )).resolves.toEqual({
      ok: false,
      errorCode: 'unavailable',
      error: 'unavailable',
    });

    const disabledSettings = ActionsSettingsV1Schema.parse({
      v: 1,
      actions: {
        [contributedAction.id]: {
          disabledSurfaces: ['api'],
        },
      },
    });
    const disabledSearchResult = await executor.execute(
      'action.spec.search',
      { query: contributedAction.id, limit: 5 },
      { surface: 'api', actionsSettings: disabledSettings },
    );
    expect(disabledSearchResult.ok).toBe(true);
    if (!disabledSearchResult.ok) throw new Error('Expected disabled contributed Action search to succeed');
    expect(disabledSearchResult.result.actionSpecs.map((definition) => definition.id))
      .not.toContain(contributedAction.id);
    await expect(executor.execute(
      'action.spec.get',
      { id: contributedAction.id },
      { surface: 'api', actionsSettings: disabledSettings },
    )).resolves.toMatchObject({
      ok: false,
      errorCode: 'action_disabled',
    });
    await expect(executor.execute(
      'action.options.resolve',
      { actionId: contributedAction.id, fieldPath: 'depth' },
      { surface: 'api', actionsSettings: disabledSettings },
    )).resolves.toMatchObject({
      ok: false,
      errorCode: 'action_disabled',
    });
  });

  it('filters action.spec.search by surfaced availability for the current surface', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    // Query by id so the assertion measures surface filtering rather than where a
    // growing catalog happens to paginate.
    const surfaced = await executor.execute('action.spec.search', { query: 'session.mode.set', limit: 50 }, { surface: 'cli' });
    expect(surfaced.ok).toBe(true);
    expect((surfaced as any).result.actionSpecs.some((spec: any) => spec.id === 'session.mode.set')).toBe(true);

    const unsurfaced = await executor.execute('action.spec.search', { query: 'ui.voice_global.reset', limit: 50 }, { surface: 'cli' });
    expect(unsurfaced.ok).toBe(true);
    expect((unsurfaced as any).result.actionSpecs.some((spec: any) => spec.id === 'ui.voice_global.reset')).toBe(false);
  });

  it('routes ui.voice_agent.teleport to deps.teleportVoiceAgentToSessionRoot using the default session fallback', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('ui.voice_agent.teleport', {}, { defaultSessionId: 's1' });

    expect(res.ok).toBe(true);
    expect(deps.teleportVoiceAgentToSessionRoot).toHaveBeenCalledWith({ sessionId: 's1' });
  });

  it('resolves action options for dynamic option sources through action.options.resolve', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);
    (deps.agentsBackendsList as any).mockResolvedValueOnce({
      items: [
        { targetKey: 'backend:codex', title: 'Codex' },
        { targetKey: 'backend:review-bot:configured:review-bot', title: 'Review Bot' },
      ],
    });

    const res = await executor.execute('action.options.resolve', {
      actionId: 'subagents.plan.start',
      fieldPath: 'backendTargetKeys',
      sessionId: 's1',
    });

    expect(res.ok).toBe(true);
    expect(deps.agentsBackendsList).toHaveBeenCalledWith({ includeDisabled: false, limit: undefined });
    expect((res as any).result).toEqual({
      actionId: 'subagents.plan.start',
      fieldPath: 'backendTargetKeys',
      optionsSourceId: 'execution.backends.enabled',
      options: [
        { value: 'backend:codex', label: 'Codex' },
        { value: 'backend:review-bot:configured:review-bot', label: 'Review Bot' },
      ],
    });
  });

  it('resolves spawn dynamic option sources through the same deps as their list actions', async () => {
    const resolveSessionSpawnAgentInventorySelection = vi.fn(() => ({
      agentId: 'claude',
      backendTargetKey: 'backend:claude',
    }));
    const deps = {
      ...createDeps(),
      resolveSessionSpawnAgentInventorySelection,
    } as ActionExecutorDeps & {
      resolveSessionSpawnAgentInventorySelection: ReturnType<typeof vi.fn>;
      agentsConfigOptionsList: ReturnType<typeof vi.fn>;
      agentsSessionModesList: ReturnType<typeof vi.fn>;
      spawnProfilesList: ReturnType<typeof vi.fn>;
      spawnConnectedServicesList: ReturnType<typeof vi.fn>;
      spawnMcpServersPreview: ReturnType<typeof vi.fn>;
    };
    deps.agentsBackendsList.mockResolvedValueOnce({
      items: [{ id: 'claude', label: 'Claude' }],
    });
    deps.agentsModelsList.mockResolvedValueOnce({
      items: [{ id: 'claude-opus-4-8', label: 'Claude Opus' }],
    });
    deps.agentsSessionModesList.mockResolvedValueOnce({
      items: [{ id: 'plan', label: 'Plan' }],
    });
    deps.agentsConfigOptionsList.mockResolvedValueOnce({
      items: [{ id: 'reasoning_effort', label: 'Thinking' }],
    });
    deps.pathsListRecent.mockResolvedValueOnce({
      items: [{ path: '/repo', label: 'Repo' }],
    });
    deps.machinesList.mockResolvedValueOnce({
      items: [{ id: 'm1', label: 'Laptop' }],
    });
    deps.serversList.mockResolvedValueOnce({
      items: [{ id: 'local', label: 'Local' }],
    });
    deps.spawnProfilesList.mockResolvedValueOnce({
      items: [{ id: 'profile-default', label: 'Default profile' }],
    });
    deps.spawnConnectedServicesList.mockResolvedValueOnce({
      items: [{ id: 'openai:work', label: 'OpenAI work' }],
    });
    deps.spawnMcpServersPreview.mockResolvedValueOnce({
      items: [{ id: 'managed:repo', label: 'Repo MCP' }],
    });
    const executor = createActionExecutor(deps);

    const sessionSpawnOptionContext = {
      executionTarget: { serverId: 'local', machineId: 'm1' },
      directory: { kind: 'path', path: '/repo' },
      agentTarget: {
        kind: 'agent',
        identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
      },
      modelSelection: {
        v: 1,
        updatedAt: 1,
        ref: { agentTargetKey: 'backend:claude', modelId: 'claude-opus-4-8' },
      },
      mcpSelection: {
        managedServersEnabled: true,
        forceIncludeServerIds: [],
        forceExcludeServerIds: [],
      },
    } as const;

    const cases = [
      ['agents.backends.enabled', 'agentTarget', [{ value: 'agent:claude', label: 'Claude' }]],
      ['agents.models.available', 'modelSelection', [{ value: 'claude-opus-4-8', label: 'Claude Opus' }]],
      ['agents.session_modes.available', 'agentModeId', [{ value: 'plan', label: 'Plan' }]],
      ['agents.config_options.available', 'configuration', [{ value: 'reasoning_effort', label: 'Thinking' }]],
      ['sessions.spawn.paths.recent', 'directory', [
        { value: '{"kind":"managed"}', label: 'No folder' },
        { value: '{"kind":"path","path":"/repo"}', label: 'Repo' },
      ]],
      ['sessions.spawn.machines.available', 'executionTarget.machineId', [{ value: 'm1', label: 'Laptop' }]],
      ['sessions.spawn.servers.available', 'executionTarget.serverId', [{ value: 'local', label: 'Local' }]],
      ['sessions.spawn.profiles.available', 'profileId', [{ value: 'profile-default', label: 'Default profile' }]],
      ['sessions.spawn.connected_services.available', 'connectedServices', [{ value: 'openai:work', label: 'OpenAI work' }]],
      ['sessions.spawn.mcp_servers.preview', 'mcpSelection', [{ value: 'managed:repo', label: 'Repo MCP' }]],
    ] as const;

    for (const [optionsSourceId, fieldPath, options] of cases) {
      const res = await executor.execute('action.options.resolve', {
        actionId: 'session.spawn_new',
        fieldPath,
        optionsSourceId,
        ...sessionSpawnOptionContext,
        limit: 10,
      });
      expect(res).toEqual({
        ok: true,
        result: {
          actionId: 'session.spawn_new',
          fieldPath,
          optionsSourceId,
          options,
          ...(fieldPath === 'modelSelection' ? { modelCatalog: { nativeModels: options, providerProjection: null } } : {}),
        },
      });
    }

    expect(deps.resolveSessionSpawnAgentInventorySelection).toHaveBeenCalledWith({
      agentTarget: sessionSpawnOptionContext.agentTarget,
      machineId: 'm1',
      serverId: 'local',
    });
    expect(deps.agentsBackendsList).toHaveBeenCalledWith({
      includeDisabled: false,
      limit: 10,
      machineId: 'm1',
    });
    expect(deps.agentsModelsList).toHaveBeenCalledWith({
      agentId: 'claude',
      backendTargetKey: 'backend:claude',
      machineId: 'm1',
      serverId: 'local',
      limit: 10,
      includeProviderProjection: true,
    });
    expect(deps.agentsConfigOptionsList).toHaveBeenCalledWith({
      agentId: 'claude',
      backendTargetKey: 'backend:claude',
      machineId: 'm1',
      serverId: 'local',
      modelId: 'claude-opus-4-8',
      limit: 10,
    });
    expect(deps.pathsListRecent).toHaveBeenCalledWith({ machineId: 'm1', limit: 10 });
    expect(deps.spawnMcpServersPreview).toHaveBeenCalledWith({
      agentId: 'claude',
      backendTargetKey: 'backend:claude',
      machineId: 'm1',
      directory: '/repo',
      selection: sessionSpawnOptionContext.mcpSelection,
      limit: 10,
    });
  });

  it('returns Session spawn directory JSON options without selecting redacted or invalid paths', async () => {
    const executor = createActionExecutor({
      ...createDeps(),
      pathsListRecent: async () => ({ items: [
        { path: ' /repo ', label: 'Repo' },
        { label: 'Private workspace' },
        { path: ' ', label: 'Invalid path' },
      ] }),
    });
    const result = await executor.execute('action.options.resolve', {
      actionId: 'session.spawn_new',
      fieldPath: 'directory',
      draftInput: { executionTarget: { serverId: 'local', machineId: 'm1' } },
    });

    expect(result).toEqual({ ok: true, result: {
      actionId: 'session.spawn_new',
      fieldPath: 'directory',
      optionsSourceId: 'sessions.spawn.paths.recent',
      options: [
        { value: '{"kind":"managed"}', label: 'No folder' },
        { value: '{"kind":"path","path":"/repo"}', label: 'Repo' },
      ],
    } });
    if (!result.ok) throw new Error('Expected directory options');
    const output = PUBLIC_ACTION_OUTPUT_SCHEMAS['action.options.resolve'].parse(result.result);
    for (const option of output.options) {
      if (typeof option.value !== 'string') throw new Error('Expected JSON completion text');
      expect(SessionDirectoryIntentV1Schema.safeParse(JSON.parse(option.value)).success).toBe(true);
    }
  });

  it.each([
    [{ kind: 'path', path: ' /repo ' }, '/repo'],
    [{ kind: 'managed' }, undefined],
    ['/retired-flat-directory', undefined],
  ] as const)('reads Session spawn directory %j for dependent options', async (directory, expectedPath) => {
    const spawnMcpServersPreview = vi.fn(async () => ({ items: [] }));
    const executor = createActionExecutor({
      ...createDeps(),
      resolveSessionSpawnAgentInventorySelection: () => ({ agentId: 'claude', backendTargetKey: 'backend:claude' }),
      spawnMcpServersPreview,
    });
    await expect(executor.execute('action.options.resolve', {
      actionId: 'session.spawn_new',
      fieldPath: 'mcpSelection',
      draftInput: {
        executionTarget: { serverId: 'local', machineId: 'm1' },
        directory,
        path: '/retired-path',
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
      },
    })).resolves.toMatchObject({ ok: true });
    expect(spawnMcpServersPreview).toHaveBeenCalledWith({
      agentId: 'claude', backendTargetKey: 'backend:claude', machineId: 'm1',
      ...(expectedPath === undefined ? {} : { directory: expectedPath }),
    });
  });

  it('retains the declared flat directory context for direct MCP preview options', async () => {
    const spawnMcpServersPreview = vi.fn(async () => ({ items: [] }));
    const executor = createActionExecutor({ ...createDeps(), spawnMcpServersPreview });
    await expect(executor.execute('action.options.resolve', {
      optionsSourceId: 'sessions.spawn.mcp_servers.preview',
      draftInput: { agentId: 'claude', directory: '/repo' },
    })).resolves.toMatchObject({ ok: true });
    expect(spawnMcpServersPreview).toHaveBeenCalledWith({ agentId: 'claude', directory: '/repo' });
  });

  it('resolves dependent ergonomic-run options from the canonical draftInput target', async () => {
    const deps = createDeps() as ActionExecutorDeps & {
      agentsModelsList: ReturnType<typeof vi.fn>;
      agentsConfigOptionsList: ReturnType<typeof vi.fn>;
      spawnConnectedServicesList: ReturnType<typeof vi.fn>;
    };
    const executor = createActionExecutor(deps);

    for (const fieldPath of ['modelId', 'configOptions', 'connectedServicesByBackendTargetKey'] as const) {
      const res = await executor.execute('action.options.resolve', {
        actionId: 'subagents.delegate.start',
        fieldPath,
        draftInput: {
          backendTargetKeys: ['agent:pi'],
          modelId: 'zai/glm-5.3-flash',
        },
      });
      expect(res.ok, fieldPath).toBe(true);
    }

    expect(deps.agentsModelsList).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'pi',
      backendTargetKey: 'agent:pi',
    }));
    expect(deps.agentsConfigOptionsList).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'pi',
      backendTargetKey: 'agent:pi',
      modelId: 'zai/glm-5.3-flash',
    }));
    expect(deps.spawnConnectedServicesList).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'pi',
      backendTargetKey: 'agent:pi',
    }));
  });

  it('returns a typed missing dependency for ergonomic-run options without a selected target', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('action.options.resolve', {
      actionId: 'subagents.delegate.start',
      fieldPath: 'modelId',
    });

    expect(res).toMatchObject({
      ok: false,
      errorCode: 'missing_option_dependency',
      details: { requiredDraftPath: 'backendTargetKeys' },
    });
    expect(deps.agentsModelsList).not.toHaveBeenCalled();
  });

  it('fails closed when a V2 session spawn target cannot be resolved, even if retired flat selection fields are supplied', async () => {
    const resolveSessionSpawnAgentInventorySelection = vi.fn(() => null);
    const deps = {
      ...createDeps(),
      resolveSessionSpawnAgentInventorySelection,
    } as ActionExecutorDeps & {
      resolveSessionSpawnAgentInventorySelection: ReturnType<typeof vi.fn>;
    };
    const executor = createActionExecutor(deps);

    const res = await executor.execute('action.options.resolve', {
      actionId: 'session.spawn_new',
      fieldPath: 'modelSelection',
      executionTarget: { serverId: 'local', machineId: 'm1' },
      directory: '/repo',
      agentTarget: {
        kind: 'agent',
        identity: { pluginId: 'happier.agent.unavailable', localId: 'unavailable' },
      },
      // These retired fields must not become an authority bypass for V2 inputs.
      agentId: 'claude',
      backendTargetKey: 'backend:claude',
    });

    expect(res).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(deps.resolveSessionSpawnAgentInventorySelection).toHaveBeenCalledWith({
      agentTarget: {
        kind: 'agent',
        identity: { pluginId: 'happier.agent.unavailable', localId: 'unavailable' },
      },
      machineId: 'm1',
      serverId: 'local',
    });
    expect(deps.agentsModelsList).not.toHaveBeenCalled();
  });

  it('filters resolved dynamic action options by query and limit', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);
    (deps.agentsBackendsList as any).mockResolvedValueOnce({
      items: [
        { id: 'codex', title: 'Codex' },
        { id: 'claude', title: 'Claude' },
        { id: 'cursor', title: 'Cursor' },
      ],
    });

    const res = await executor.execute('action.options.resolve', {
      optionsSourceId: 'execution.backends.enabled',
      query: 'cl',
      limit: 1,
    });

    expect(res.ok).toBe(true);
    expect((res as any).result).toEqual({
      actionId: null,
      fieldPath: null,
      optionsSourceId: 'execution.backends.enabled',
      options: [{ value: 'agent:claude', label: 'Claude' }],
    });
  });

  it('preserves unlimited dynamic choices through the public result parser and honors an explicit limit', async () => {
    const items = Array.from({ length: 257 }, (_, index) => ({ id: `agent${index}`, title: `Agent ${index}` }));
    const executor = createActionExecutor({ ...createDeps(), agentsBackendsList: async () => ({ items }) });
    const request = { optionsSourceId: 'execution.backends.enabled' };
    const unlimited = await executor.execute('action.options.resolve', request);
    if (!unlimited.ok) throw new Error(unlimited.error);
    expect(PUBLIC_ACTION_OUTPUT_SCHEMAS['action.options.resolve'].parse(unlimited.result).options)
      .toEqual(items.map(item => ({ value: `agent:${item.id}`, label: item.title })));
    const limited = await executor.execute('action.options.resolve', { ...request, query: 'Agent', limit: 200 });
    if (!limited.ok) throw new Error(limited.error);
    expect(PUBLIC_ACTION_OUTPUT_SCHEMAS['action.options.resolve'].parse(limited.result).options).toHaveLength(200);
  });

  it('filters resolved static action options by query and limit', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('action.options.resolve', {
      actionId: 'session.user_action.answer',
      fieldPath: 'decision',
      query: 'req',
      limit: 1,
    });

    expect(res.ok).toBe(true);
    expect((res as any).result).toEqual({
      actionId: 'session.user_action.answer',
      fieldPath: 'decision',
      optionsSourceId: null,
      options: [{ value: 'request_changes', label: 'Request changes' }],
    });
  });

  it('uses a direct optionsSourceId fallback when actionId + fieldPath are also provided', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);
    (deps.sessionModesList as any).mockResolvedValueOnce({
      items: [{ id: 'plan', label: 'Plan' }],
    });

    const res = await executor.execute('action.options.resolve', {
      actionId: 'session.mode.set',
      fieldPath: 'modeId',
      optionsSourceId: 'session.modes.available',
      sessionId: 's1',
    });

    expect(res.ok).toBe(true);
    expect((res as any).result).toEqual({
      actionId: 'session.mode.set',
      fieldPath: 'modeId',
      optionsSourceId: 'session.modes.available',
      options: [{ value: 'plan', label: 'Plan' }],
    });
  });

  it('routes session.mode.set to deps.sessionModeSet', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);
    (deps.sessionModesList as any).mockResolvedValueOnce({
      items: [{ id: 'plan', label: 'Plan' }],
    });

    const res = await executor.execute('session.mode.set', {
      sessionId: 's1',
      modeId: 'plan',
    });

    expect(res.ok).toBe(true);
    expect(deps.sessionModeSet).toHaveBeenCalledWith({ sessionId: 's1', modeId: 'plan' });
  });

  it('allows session.mode.set when the available modes list is empty', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('session.mode.set', {
      sessionId: 's1',
      modeId: 'plan',
    });

    expect(res.ok).toBe(true);
    expect(deps.sessionModeSet).toHaveBeenCalledWith({ sessionId: 's1', modeId: 'plan' });
  });

  it('preserves default as a real mode id when the available modes literally include default', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);
    (deps.sessionModesList as any).mockResolvedValueOnce({
      items: [{ id: 'default', label: 'Default' }, { id: 'plan', label: 'Plan' }],
    });

    const res = await executor.execute('session.mode.set', {
      sessionId: 's1',
      modeId: 'default',
    });

    expect(res.ok).toBe(true);
    expect(deps.sessionModeSet).toHaveBeenCalledWith({ sessionId: 's1', modeId: 'default' });
  });

  it('rejects session.mode.set when the requested mode is unavailable', async () => {
    const deps = createDeps();
    const executor = createActionExecutor({
      ...deps,
      sessionModesList: vi.fn(async () => ({
        items: [{ id: 'plan', label: 'Plan' }],
      })),
    });

    const res = await executor.execute('session.mode.set', {
      sessionId: 's1',
      modeId: 'not-a-real-mode',
    });

    expect(res).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(deps.sessionModeSet).not.toHaveBeenCalled();
  });

  it('returns canonical input schemas when agents discover Action specs', async () => {
    const executor = createActionExecutor(createDeps());

    const planResult = await executor.execute('action.spec.get', {
      id: 'subagents.plan.start',
    }, { surface: 'agent' });

    expect(planResult).toEqual(expect.objectContaining({
      ok: true,
      result: expect.objectContaining({
        actionSpec: expect.objectContaining({
          kindVersion: 1,
          inputSchema: expect.objectContaining({
            type: 'object',
            properties: expect.objectContaining({
              backendTargetKeys: expect.objectContaining({
                type: 'array',
                minItems: 1,
                items: expect.objectContaining({
                  anyOf: expect.arrayContaining([
                    expect.objectContaining({
                      type: 'string',
                      pattern: '^(agent|acpBackend):.+$',
                    }),
                  ]),
                }),
              }),
              permissionMode: expect.objectContaining({
                description: expect.any(String),
              }),
            }),
          }),
        }),
      }),
    }));

    const spawnResult = await executor.execute('action.spec.get', {
      id: 'session.spawn_new',
    }, { surface: 'agent' });

    expect(spawnResult).toEqual(expect.objectContaining({
      ok: true,
      result: expect.objectContaining({
        actionSpec: expect.objectContaining({
          kindVersion: 1,
          inputSchema: expect.objectContaining({
            properties: expect.objectContaining({
              executionTarget: expect.objectContaining({
                properties: expect.objectContaining({
                  serverId: expect.objectContaining({ minLength: 1, maxLength: 191 }),
                }),
              }),
              organizationPlacement: expect.objectContaining({
                properties: expect.objectContaining({
                  tagIds: expect.objectContaining({ type: 'array', maxItems: 500 }),
                }),
              }),
              agentSessionStartupInstructionsV1: expect.objectContaining({
                properties: expect.objectContaining({
                  revision: expect.objectContaining({ exclusiveMinimum: 0, maximum: 2_147_483_647 }),
                }),
              }),
            }),
          }),
        }),
      }),
    }));
  });

  it('rejects action.spec.get for actions that are not surfaced on the current surface', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('action.spec.get', { id: 'ui.voice_global.reset' }, { surface: 'cli' });

    expect(res).toEqual({
      ok: false,
      errorCode: 'action_disabled',
      error: 'action_disabled',
      details: expect.objectContaining({
        actionId: 'ui.voice_global.reset',
        surface: 'cli',
        reason: 'unsupported_surface',
      }),
    });
  });

  it('serves action.spec.search on the credential-aware CLI surface', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('action.spec.search', { query: '', limit: 5 }, { surface: 'cli' });

    expect(res.ok).toBe(true);
    expect((res as any).result.actionSpecs).toBeInstanceOf(Array);
  });

  it('rejects executing actions that are not surfaced on the current surface', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('ui.voice_global.reset', {}, { surface: 'cli' });

    expect(res).toEqual({
      ok: false,
      errorCode: 'action_disabled',
      error: 'action_disabled',
      details: expect.objectContaining({
        actionId: 'ui.voice_global.reset',
        surface: 'cli',
        reason: 'unsupported_surface',
      }),
    });
  });

  it('rejects executing actions disabled by settings with structured settings details', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute(
      'session.message.send',
      { sessionId: 's1', message: 'Hello' },
      {
        surface: 'agent',
        actionsSettings: {
          v: 1,
          actions: {
            'session.message.send': {
              disabledSurfaces: ['agent'],
            },
          },
        },
      } as any,
    );

    expect(res).toEqual({
      ok: false,
      errorCode: 'action_disabled',
      error: 'action_disabled',
      details: expect.objectContaining({
        actionId: 'session.message.send',
        surface: 'agent',
        reason: 'disabled_by_settings',
        settingsState: 'disabled',
      }),
    });
    expect(deps.sessionSendMessage).not.toHaveBeenCalled();
  });

  it('preserves allowlisted thrown error codes and messages when deps throw plain objects', async () => {
    const deps = createDeps();
    deps.sessionSendMessage = vi.fn(async () => {
      throw { code: 'session_not_found', message: 'Session was not found.' };
    });
    const executor = createActionExecutor(deps);

    const res = await executor.execute('session.message.send', { sessionId: 's1', message: 'Hello' });

    expect(res).toEqual({
      ok: false,
      errorCode: 'session_not_found',
      error: 'Session was not found.',
    });
  });
});
