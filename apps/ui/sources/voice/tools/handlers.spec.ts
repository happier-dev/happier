import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { registerStorageStateReader } from '@/sync/domains/state/storageStateReaderBridge';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';

const trackPermissionResponse = vi.fn();
const sendMessage = vi.fn();
const submitMessage = vi.fn();
const ensureSessionVisibleForMessageRoute = vi.fn();
const refreshSessionMessages = vi.fn();
const getSessionEncryption = vi.fn<(sessionId: string) => unknown>((_sessionId) => ({}));
const executionRunStart = vi.fn();
const executionRunList = vi.fn();
const executionRunGet = vi.fn();
const executionRunSend = vi.fn();
const executionRunStop = vi.fn();
const executionRunAction = vi.fn();
const machineRpcWithServerScope = vi.fn();
const setActiveServerAndSwitch = vi.fn(async (_params?: any) => false);
const routerNavigate = vi.fn();
const refreshFromActiveServer = vi.fn(async () => {});
const applySettingsLocal = vi.fn();
const sendSessionMessageWithServerScope = vi.fn();
const sessionRpcWithServerScope = vi.fn();
const teleportVoiceAgentToSessionRoot = vi.fn();

function createBaseState(): any {
  return {
    sessions: {
      s1: {
        id: 's1',
        serverId: 'server-a',
        active: true,
        updatedAt: 200,
        presence: 'online',
        agentState: {
          requests: {
            req_a: { id: 'req_a', tool: 'Bash', kind: 'permission' },
            req_b: { id: 'req_b', tool: 'Read', kind: 'permission' },
          },
        },
        metadata: { path: '/Users/alice/project-alpha', homeDir: '/Users/alice', machineId: 'm1', host: 'a-host', summary: { text: 'S1 summary' } },
      },
      s2: {
        id: 's2',
        serverId: 'server-a',
        active: true,
        updatedAt: 100,
        presence: 'offline',
        agentState: {
          requests: {
            req_c: { id: 'req_c', tool: 'Bash', kind: 'permission' },
          },
        },
        metadata: { path: '/tmp/s2', machineId: 'm1', host: 'a-host', summary: { text: 'S2 summary' } },
      },
      sys_voice: {
        id: 'sys_voice',
        serverId: 'server-a',
        active: false,
        updatedAt: 300,
        presence: 'offline',
        agentState: { requests: {} },
        metadata: { path: '/tmp/sys', machineId: 'm1', host: 'a-host', systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true } },
      },
      s_matrix: {
        id: 's_matrix',
        serverId: 'server-a',
        active: false,
        updatedAt: 60,
        presence: 'offline',
        agentState: { requests: {} },
        metadata: { path: '/tmp/matrix', machineId: 'm1', host: 'a-host', name: 'leeroy' },
      },
    },
    sessionListIndexByServerId: {
      'server-a': [
        { type: 'session', sessionId: 's1', serverId: 'server-a', serverName: 'Server A' },
        { type: 'session', sessionId: 's2', serverId: 'server-a', serverName: 'Server A' },
        { type: 'session', sessionId: 's_visible_only', serverId: 'server-a', serverName: 'Server A' },
        { type: 'session', sessionId: 's_matrix', serverId: 'server-a', serverName: 'Server A' },
      ],
      'server-b': [
        { type: 'session', sessionId: 's_other', serverId: 'server-b', serverName: 'Server B' },
      ],
    },
    sessionListRenderables: {
      s_visible_only: {
        id: 's_visible_only',
        active: true,
        updatedAt: 75,
        activeAt: 75,
        createdAt: 70,
        seq: 2,
        metadataVersion: 1,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        metadata: { summaryText: 'Visible only in current list', path: '/tmp/visible-only' },
      },
      s_matrix: {
        id: 's_matrix',
        active: false,
        updatedAt: 60,
        activeAt: 60,
        createdAt: 50,
        seq: 1,
        metadataVersion: 1,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'offline',
        metadata: { summaryText: 'Session QA Voice Matrix', path: '/tmp/matrix' },
      },
    },
    concurrentSessionListCacheByServerId: {
      'server-b': {
        serverName: 'Server B',
        sessions: {
          s_other: {
            id: 's_other',
            active: false,
            updatedAt: 50,
            presence: 'offline',
            agentState: { requests: {} },
            metadata: { path: '/tmp/other', host: 'b-host', summary: { text: 'Other summary' } },
          },
        },
      },
    },
    machines: {
      m1: { id: 'm1', active: true, metadata: { host: 'a-host' } },
      m2: { id: 'm2', active: true, metadata: { host: 'b-host' } },
    },
    sessionMessages: {
      s1: {
        isLoaded: true,
        messages: [
          { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, text: 'u1' },
          { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, text: 'a2' },
        ],
      },
      s2: {
        isLoaded: true,
        messages: [
          { kind: 'agent-text', id: 'm3', localId: null, createdAt: 3, text: 's2 latest' },
          {
            kind: 'tool-call',
            id: 'm4',
            localId: null,
            createdAt: 4,
            children: [],
            tool: {
              name: 'read',
              description: 'Read a file',
              state: 'completed',
              input: { path: '/Users/alice/SecretRepo/README.md' },
              createdAt: 4,
              startedAt: 4,
              completedAt: 5,
            },
          },
        ],
      },
    },
    settings: {
      ...settingsDefaults,
      voice: {
        ...settingsDefaults.voice,
        ui: {
          ...settingsDefaults.voice.ui,
          updates: {
            ...settingsDefaults.voice.ui.updates,
            snippetsMaxMessages: 3,
            includeUserMessagesInSnippets: false,
            otherSessionsSnippetsMode: 'on_demand_only',
          },
        },
        privacy: {
          ...settingsDefaults.voice.privacy,
          shareRecentMessages: true,
          shareToolNames: true,
          shareDeviceInventory: true,
        },
      },
      recentMachinePaths: [
        { machineId: 'm1', path: '/tmp/s1' },
        { machineId: 'm1', path: '/tmp/s2' },
      ],
    },
  };
}

let state: any = createBaseState();
const readMockStorageState = () => ({ ...state, applySettingsLocal });

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    storage: {
    getState: () => ({ ...state, applySettingsLocal }),
  },
});
});

vi.mock('@/sync/ops', () => ({
  // Permission RPC is executed via server-scoped session RPC in the action executor.
}));

vi.mock('@/track', () => ({
  trackPermissionResponse: (...args: any[]) => trackPermissionResponse(...args),
}));

vi.mock('@/sync/sync', () => ({
  sync: {
    sendMessage: (sessionId: string, message: string) => sendMessage(sessionId, message),
    submitMessage: (...args: any[]) => submitMessage(...args),
    ensureSessionVisibleForMessageRoute: (sessionId: string, options?: { forceRefresh?: boolean }) =>
      ensureSessionVisibleForMessageRoute(sessionId, options),
    refreshSessionMessages: (sessionId: string) => refreshSessionMessages(sessionId),
    encryption: {
      getSessionEncryption: (sessionId: string) => getSessionEncryption(sessionId),
    },
  },
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionSendMessage', () => ({
  sendSessionMessageWithServerScope: (args: any) => sendSessionMessageWithServerScope(args),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({
  sessionRpcWithServerScope: (args: any) => sessionRpcWithServerScope(args),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
  machineRpcWithServerScope: (args: any) => machineRpcWithServerScope(args),
}));

vi.mock('@/voice/agent/teleportVoiceAgentToSessionRoot', () => ({
  teleportVoiceAgentToSessionRoot: (args: any) => teleportVoiceAgentToSessionRoot(args),
}));

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
  sessionExecutionRunStart: (sessionId: string, request: any, opts?: any) => executionRunStart(sessionId, request, opts),
  sessionExecutionRunList: (sessionId: string, request: any, opts?: any) => executionRunList(sessionId, request, opts),
  sessionExecutionRunGet: (sessionId: string, request: any, opts?: any) => executionRunGet(sessionId, request, opts),
  sessionExecutionRunSend: (sessionId: string, request: any, opts?: any) => executionRunSend(sessionId, request, opts),
  sessionExecutionRunStop: (sessionId: string, request: any, opts?: any) => executionRunStop(sessionId, request, opts),
  sessionExecutionRunAction: (sessionId: string, request: any, opts?: any) => executionRunAction(sessionId, request, opts),
}));

vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
  setActiveServerAndSwitch: (params: any) => setActiveServerAndSwitch(params),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
  getActiveServerSnapshot: () => ({ serverId: 'server-a' }),
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
  areServerProfileIdentifiersEquivalent: (left: unknown, right: unknown) => String(left ?? '').trim() === String(right ?? '').trim(),
  getServerProfileById: (_serverId: unknown) => null,
}));

vi.mock('@/auth/context/AuthContext', () => ({
  getCurrentAuth: () => ({ refreshFromActiveServer }),
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const expoRouterMock = createExpoRouterMock({
        router: { navigate: (...args: any[]) => routerNavigate(...args) },
    });
    return expoRouterMock.module;
});

describe('voice tool handlers', () => {
  beforeEach(() => {
    state = createBaseState();
    registerStorageStateReader(readMockStorageState);
    trackPermissionResponse.mockReset();
    sendMessage.mockReset();
    submitMessage.mockReset();
    submitMessage.mockResolvedValue(undefined);
    ensureSessionVisibleForMessageRoute.mockReset();
    refreshSessionMessages.mockReset();
    sendSessionMessageWithServerScope.mockReset();
    sessionRpcWithServerScope.mockReset();
    executionRunStart.mockReset();
    executionRunList.mockReset();
    executionRunGet.mockReset();
    executionRunSend.mockReset();
    executionRunStop.mockReset();
    executionRunAction.mockReset();
    machineRpcWithServerScope.mockReset();
    setActiveServerAndSwitch.mockReset();
    routerNavigate.mockReset();
    refreshFromActiveServer.mockReset();
    applySettingsLocal.mockReset();
    teleportVoiceAgentToSessionRoot.mockReset();
    useVoiceTargetStore.getState().setPrimaryActionSessionId(null);
    useVoiceTargetStore.getState().setTrackedSessionIds([]);
  });

  it('routes sendSessionMessage through canonical Voice Message admission for the resolved session', async () => {
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const result = await tools.sendSessionMessage({ message: 'hi' });

    expect(JSON.parse(result)).toMatchObject({ ok: true });
    expect(submitMessage).toHaveBeenCalledWith('s1', 'hi', undefined, undefined, {
      callerSurface: 'voice_turn',
      forceImmediate: true,
      hostAdmissionOrigin: 'voice',
    });
    expect(sendSessionMessageWithServerScope).not.toHaveBeenCalled();

  });

  it('does not admit a Voice session message after its invocation was cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const result = await (tools.sendSessionMessage as any)({ message: 'hi' }, { signal: controller.signal });

    expect(JSON.parse(result)).toMatchObject({ ok: false, errorCode: 'tool_cancelled' });
    expect(submitMessage).not.toHaveBeenCalled();
  });

  it('reports a target update requirement from canonical Voice admission without retaining an unknown outcome', async () => {
    submitMessage.mockRejectedValueOnce(Object.assign(
      new Error('The selected remote session requires an updated agent runtime before Voice can send a message.'),
      { code: 'session_input_target_update_required' },
    ));
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const result = await tools.sendSessionMessage({ message: 'hi' });

    expect(JSON.parse(result)).toEqual({
      ok: false,
      errorCode: 'session_input_target_update_required',
      errorMessage: 'session_input_target_update_required',
      sessionId: 's1',
    });
  });

  it('exposes review.start through the catalog voice binding', async () => {
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });
    expect(tools.startReview).toEqual(expect.any(Function));
  });

  it('starts an execution run through the canonical Voice Action binding', async () => {
    const startArgs = {
      intent: 'voice_agent',
      backendTarget: {
        kind: 'backend',
        backendId: 'codex',
        sourceKind: 'built_in',
      },
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    };
    executionRunStart.mockResolvedValue({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' });

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const result = await tools.startExecutionRun(startArgs);

    expect(executionRunStart).toHaveBeenCalledWith(
      's1',
      expect.objectContaining(startArgs),
      { serverId: 'server-a' },
    );
    expect(JSON.parse(result)).toMatchObject({ ok: true, runId: 'run_1' });
  });

  it('can apply an execution run action via sessionExecutionRunAction', async () => {
    executionRunAction.mockResolvedValue({ ok: true, updatedToolResult: { ok: true } });

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const res = await tools.actionExecutionRun({ runId: 'run_1', actionId: 'review.triage', input: { findings: [] } });
    expect(executionRunAction).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ runId: 'run_1', actionId: 'review.triage' }),
      { serverId: 'server-a' },
    );
    expect(JSON.parse(res)).toMatchObject({ ok: true });
  });

  it('can list execution runs via sessionExecutionRunList', async () => {
    executionRunList.mockResolvedValue({ runs: [] });

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const res = await tools.listExecutionRuns({});
    expect(executionRunList).toHaveBeenCalledWith('s1', {}, { serverId: 'server-a' });
    expect(JSON.parse(res)).toMatchObject({ runs: [] });
  });

  it('can get an execution run via sessionExecutionRunGet', async () => {
    executionRunGet.mockResolvedValue({ run: { runId: 'run_1', availableActionIds: ['voice_agent.welcome'] } });

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const res = await tools.getExecutionRun({ runId: 'run_1' });
    expect(executionRunGet).toHaveBeenCalledWith('s1', { runId: 'run_1', includeStructured: false }, { serverId: 'server-a' });
    expect(JSON.parse(res)).toMatchObject({ run: { runId: 'run_1', availableActionIds: ['voice_agent.welcome'] } });
  });

  it('can send to an execution run via sessionExecutionRunSend', async () => {
    executionRunSend.mockResolvedValue({ ok: true });

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const res = await tools.sendExecutionRunMessage({ runId: 'run_1', message: 'hello' });
    expect(executionRunSend).toHaveBeenCalledWith(
      's1',
      { runId: 'run_1', message: 'hello', delivery: 'steer_if_supported' },
      { serverId: 'server-a' },
    );
    expect(JSON.parse(res)).toMatchObject({ ok: true });
  });

  it('can stop an execution run via sessionExecutionRunStop', async () => {
    executionRunStop.mockResolvedValue({ ok: true });

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const res = await tools.stopExecutionRun({ runId: 'run_1' });
    expect(executionRunStop).toHaveBeenCalledWith('s1', { runId: 'run_1' }, { serverId: 'server-a' });
    expect(JSON.parse(res)).toMatchObject({ ok: true });
  });

  it('routes strict V2 session creation through the canonical Voice Action executor', async () => {
    const spawnInput = {
      creationKey: 'manual:voice-v2-contract',
      executionTarget: {
        serverId: 'server-a',
        machineId: 'm1',
      },
      directory: '/tmp/s1',
      agentTarget: {
        kind: 'agent',
        identity: {
          pluginId: 'happier.agent.codex',
          localId: 'codex',
        },
      },
      initialMessage: 'Inspect this project.',
    };
    const spawnResult = {
      type: 'success' as const,
      disposition: 'created' as const,
      sessionId: 's_new',
      executionTarget: {
        serverId: 'server-a',
        machineId: 'm1',
      },
      organizationPlacement: {
        folderId: null,
        tagIds: [],
      },
      initialInput: {
        status: 'notRequested' as const,
      },
    };
    machineRpcWithServerScope.mockResolvedValue(spawnResult);

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const response = JSON.parse(await tools.spawnSession(spawnInput));

    expect(machineRpcWithServerScope).toHaveBeenCalledWith({
      serverId: 'server-a',
      machineId: 'm1',
      method: RPC_METHODS.SESSION_SPAWN_NEW,
      payload: spawnInput,
      signal: undefined,
    });
    expect(response).toEqual({ ok: true, ...spawnResult });
  });

  it('rejects retired flat spawnSession arguments before dispatching', async () => {
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const response = JSON.parse(await tools.spawnSession({ tag: 't1' }));

    expect(response).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(machineRpcWithServerScope).not.toHaveBeenCalled();
  });

  it('lists recent paths without exposing raw paths', async () => {
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const res = await tools.listRecentPaths({ limit: 10 });
    const parsed = JSON.parse(res);
    expect(parsed).toMatchObject({ ok: true });
    expect(Array.isArray(parsed.items)).toBe(true);
    expect(parsed.items.length).toBeGreaterThan(0);
    expect(parsed.items.every((item: any) => typeof item.label === 'string')).toBe(true);
    expect(parsed.items.every((item: any) => !String(item.label ?? '').includes('/tmp/'))).toBe(true);
    expect(parsed.items.every((item: any) => !String(item.label ?? '').includes('/Users/alice/'))).toBe(true);
  });

  it('disambiguates duplicate path labels with human-readable path tails', async () => {
    state.settings.recentMachinePaths = [
      { machineId: 'm1', path: '/Users/leeroy/workspaces/apps/leeroy' },
      { machineId: 'm1', path: '/Users/leeroy/workspaces/docs/leeroy' },
    ];
    state.sessions = {
      ...state.sessions,
      s3: {
        id: 's3',
        active: true,
        presence: 'online',
        updatedAt: 3000,
        metadata: { path: '/Users/leeroy/workspaces/apps/leeroy', machineId: 'm1', host: 'a-host', summary: { text: 'Apps session' } },
      },
      s4: {
        id: 's4',
        active: true,
        presence: 'online',
        updatedAt: 4000,
        metadata: { path: '/Users/leeroy/workspaces/docs/leeroy', machineId: 'm1', host: 'a-host', summary: { text: 'Docs session' } },
      },
    };

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const res = await tools.listRecentPaths({ limit: 10 });
    const parsed = JSON.parse(res);

    expect(parsed).toMatchObject({ ok: true });
    expect(parsed.items.map((item: any) => item.label)).toEqual(
      expect.arrayContaining([
        'apps/leeroy — a-host',
        'docs/leeroy — a-host',
      ]),
    );
  });

  it('lists only the requested machine paths when another machine shares the same collapsed label', async () => {
    state.settings.voice.privacy.shareDeviceInventory = true;
    state.settings.recentMachinePaths = [
      { machineId: 'm1', path: '/Users/leeroy' },
      { machineId: 'm1_alias', path: '/Users/leeroy' },
    ];
    state.machines = {
      ...state.machines,
      m1_alias: { id: 'm1_alias', metadata: { host: 'a-host' } },
    };
    state.sessions = {
      ...state.sessions,
      s5: {
        id: 's5',
        active: true,
        presence: 'online',
        updatedAt: 5000,
        metadata: { path: '/Users/leeroy', machineId: 'm1_alias', host: 'a-host', summary: { text: 'Alias workspace session' } },
      },
    };

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const res = await tools.listRecentPaths({ limit: 10, machineId: 'm1' });
    const parsed = JSON.parse(res);

    expect(parsed).toMatchObject({ ok: true });
    expect(parsed.items.some((item: any) => item.label === 'leeroy — a-host')).toBe(true);
    expect(parsed.items.every((item: any) => item.machineId === undefined)).toBe(true);
    expect(parsed.items.every((item: any) => !String(item.label ?? '').includes('m1_alias'))).toBe(true);
  });

  it('can list machines and servers for voice discovery', async () => {
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const machinesRaw = await tools.listMachines({ limit: 10 });
    const machines = JSON.parse(machinesRaw);
    expect(machines).toMatchObject({ ok: true });
    expect(Array.isArray(machines.items)).toBe(true);
    expect(machines.items.map((m: any) => m.machineId)).toContain('m1');

    const serversRaw = await tools.listServers({ limit: 10 });
    const servers = JSON.parse(serversRaw);
    expect(servers).toMatchObject({ ok: true });
    expect(Array.isArray(servers.items)).toBe(true);
    expect(servers.items.map((s: any) => s.serverId)).toContain('server-a');
  });

  it('fails closed for inventory tools when shareDeviceInventory is disabled', async () => {
    state.settings.voice.privacy = { ...state.settings.voice.privacy, shareDeviceInventory: false };

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const machinesRaw = await tools.listMachines({ limit: 10 });
    expect(JSON.parse(machinesRaw)).toMatchObject({ ok: false, errorCode: 'privacy_disabled' });

    const pathsRaw = await tools.listRecentPaths({ limit: 10 });
    expect(JSON.parse(pathsRaw)).toMatchObject({ ok: false, errorCode: 'privacy_disabled' });
  });

  it('can list agent backends and models for spawning via voice', async () => {
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const backendsRaw = await tools.listAgentBackends({});
    const backends = JSON.parse(backendsRaw);
    expect(backends).toMatchObject({ ok: true });
    expect(Array.isArray(backends.items)).toBe(true);
    expect(backends.items.length).toBeGreaterThan(0);

    const modelsRaw = await tools.listAgentModels({ agentId: 'claude' });
    const models = JSON.parse(modelsRaw);
    expect(models).toMatchObject({ ok: true });
    expect(Array.isArray(models.items)).toBe(true);
    expect(models.items.map((m: any) => m.modelId)).toContain('default');
  });

  it('still redacts recent paths when a raw voice privacy blob tries to enable file path sharing', async () => {
    state.settings.voice.privacy = {
      ...state.settings.voice.privacy,
      shareDeviceInventory: true,
      shareFilePaths: true,
    };

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const pathsRaw = await tools.listRecentPaths({ limit: 10 });
    const parsed = JSON.parse(pathsRaw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok !== true) {
      expect(parsed.errorCode).toBe('privacy_disabled');
    }
    expect(Array.isArray(parsed.items)).toBe(true);
    expect(parsed.items.length).toBeGreaterThan(0);
    expect(parsed.items.every((item: any) => item.machineId === undefined && item.path === undefined)).toBe(true);
    expect(parsed.items.every((item: any) => !String(item.label ?? '').includes('/tmp/'))).toBe(true);
  });

  it('opens a session by switching server when the session is known on another server cache', async () => {
    setActiveServerAndSwitch.mockResolvedValue(true);

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => null });

    const res = await tools.openSession({ sessionId: 's_other' });
    expect(JSON.parse(res)).toMatchObject({ ok: true, sessionId: 's_other' });
    expect(setActiveServerAndSwitch).toHaveBeenCalledWith({
      serverId: 'server-b',
      scope: 'device',
      refreshAuth: refreshFromActiveServer,
    });
    expect(routerNavigate).toHaveBeenCalledWith('/session/s_other', expect.any(Object));
  });

  it('exposes review.start for cross-server sessions through the catalog voice binding', async () => {
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : null) });
    expect(tools.startReview).toEqual(expect.any(Function));
  });

  it('increments agent transcript epoch when resetting the global agent and persistence is enabled', async () => {
    const current = state.settings.voice.providers.local_conversation;
    state.settings.voice.providers.local_conversation = {
      ...current,
      config: {
        ...current.config,
        agent: {
          ...current.config.agent,
          transcript: { persistenceMode: 'persistent', epoch: 2 },
        },
      },
    };

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => null });

    const res = await tools.resetGlobalVoiceAgent({});
    expect(JSON.parse(res)).toMatchObject({ ok: true });
    expect(applySettingsLocal).toHaveBeenCalledWith(
      expect.objectContaining({
        voice: expect.objectContaining({
          providers: expect.objectContaining({
            local_conversation: expect.objectContaining({
              config: expect.objectContaining({
                agent: expect.objectContaining({
                  transcript: expect.objectContaining({ epoch: 3 }),
                }),
              }),
            }),
          }),
        }),
      }),
    );
  });

  it('teleports the voice agent to the resolved session root', async () => {
    teleportVoiceAgentToSessionRoot.mockResolvedValue({ ok: true });

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const res = await tools.teleportVoiceAgentToSessionRoot({});
    expect(JSON.parse(res)).toMatchObject({ ok: true });
    expect(teleportVoiceAgentToSessionRoot).toHaveBeenCalledWith({ sessionId: 's1' });
  });

  it('does not answer a covered user-action request', async () => {
    const questionPayload = { questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }] };
    state.sessions.s1.agentState.requests = {
      req_question_done: {
        id: 'req_question_done',
        tool: 'AskUserQuestion',
        kind: 'user_action',
        arguments: questionPayload,
        createdAt: 10,
      },
    };
    state.sessions.s1.agentState.completedRequests = {
      req_question_done: {
        tool: 'AskUserQuestion',
        kind: 'user_action',
        arguments: questionPayload,
        completedAt: 11,
        status: 'approved',
      },
    };
    sessionRpcWithServerScope.mockResolvedValue({ ok: true });

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const result = await (tools as any).answerUserActionRequest({
      answers: [{ question: 'Continue?', values: ['Yes'] }],
    });

    expect(JSON.parse(result)).toMatchObject({
      ok: false,
      errorCode: 'no_permission_request',
      sessionId: 's1',
    });
    expect(sessionRpcWithServerScope).not.toHaveBeenCalled();
  });

  it('answers a pending AskUserQuestion request with structured answers', async () => {
    state.sessions.s1.agentState.requests = {
      req_question: { id: 'req_question', tool: 'AskUserQuestion', kind: 'user_action' },
      req_permission: { id: 'req_permission', tool: 'Bash', kind: 'permission' },
    };
    sessionRpcWithServerScope.mockResolvedValue({ ok: true });

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const result = await (tools as any).answerUserActionRequest({
      answers: [{ question: 'Continue?', values: ['Yes'] }],
    });

    expect(JSON.parse(result)).toMatchObject({ ok: true });
    expect(sessionRpcWithServerScope).toHaveBeenCalledWith({
      sessionId: 's1',
      serverId: 'server-a',
      method: RPC_METHODS.SESSION_USER_ACTION_ANSWER,
      payload: { id: 'req_question', approved: true, answers: { 'Continue?': ['Yes'] } },
    });
  });

  it('maps allow-or-deny decisions onto AskUserQuestion option labels when no structured answers are provided', async () => {
    state.sessions.s1.agentState.requests = {
      req_question: {
        id: 'req_question',
        tool: 'AskUserQuestion',
        kind: 'user_action',
        arguments: {
          questions: [
            {
              question: 'May I create QA_DENY_PATH.txt?',
              header: 'Permission',
              options: [
                { label: 'Yes, create it', description: 'Create the file' },
                { label: `No, don't create it`, description: 'Skip file creation' },
              ],
            },
          ],
        },
      },
    };
    sessionRpcWithServerScope.mockResolvedValue({ ok: true });

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const result = await (tools as any).answerUserActionRequest({
      decision: 'reject',
    });

    expect(JSON.parse(result)).toMatchObject({ ok: true, sessionId: 's1', requestId: 'req_question' });
    expect(sessionRpcWithServerScope).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's1',
        method: RPC_METHODS.SESSION_USER_ACTION_ANSWER,
        payload: {
          id: 'req_question',
          approved: false,
          answers: { 'May I create QA_DENY_PATH.txt?': [`No, don't create it`] },
        },
      }),
    );
  });

  it('responds to ExitPlanMode through the generalized user-action response action', async () => {
    state.sessions.s1.agentState.requests = {
      req_exit_plan: { id: 'req_exit_plan', tool: 'ExitPlanMode', kind: 'user_action' },
    };
    sessionRpcWithServerScope.mockResolvedValue({ ok: true });

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const result = await (tools as any).answerUserActionRequest({
      decision: 'request_changes',
      reason: 'The plan needs another pass before exiting plan mode.',
    });

    expect(JSON.parse(result)).toMatchObject({ ok: true });
    expect(sessionRpcWithServerScope).toHaveBeenCalledWith({
      sessionId: 's1',
      serverId: 'server-a',
      method: RPC_METHODS.SESSION_USER_ACTION_ANSWER,
      payload: {
        id: 'req_exit_plan',
        approved: false,
        reason: 'The plan needs another pass before exiting plan mode.',
      },
    });
  });

  it('surfaces a user-action response failure when the scoped RPC returns ok false', async () => {
    state.sessions.s1.agentState.requests = {
      req_question: { id: 'req_question', tool: 'AskUserQuestion', kind: 'user_action' },
    };
    sessionRpcWithServerScope.mockResolvedValue({ ok: false, errorCode: 'permission_request_not_found', errorMessage: 'permission_request_not_found' });

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const result = await (tools as any).answerUserActionRequest({
      answers: [{ question: 'Continue?', values: ['Yes'] }],
    });

    expect(JSON.parse(result)).toMatchObject({ ok: false, errorCode: 'permission_request_not_found' });
  });

  it('answers a transcript-backed user-action request in the resolved session', async () => {
    state.sessions.sys_voice.agentState.requests = {};
    state.sessions.s1.agentState.requests = {};
    state.sessions.s2.agentState.requests = {};
    state.sessionMessages.s1.messages = [
      {
        kind: 'tool-call',
        id: 'm_pending_question',
        localId: null,
        createdAt: 11,
        children: [],
        tool: {
          id: 'req_question',
          name: 'AskUserQuestion',
          description: 'Ask the user a question',
          state: 'running',
          input: { questions: [{ question: 'Continue?' }] },
          createdAt: 11,
          startedAt: null,
          completedAt: null,
          permission: { id: 'req_question', status: 'pending', kind: 'user_action' },
        },
      },
    ];
    sessionRpcWithServerScope.mockResolvedValue({ ok: true });

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const result = await (tools as any).answerUserActionRequest({
      answers: [{ question: 'Continue?', values: ['Yes'] }],
    });

    expect(JSON.parse(result)).toMatchObject({ ok: true, sessionId: 's1', requestId: 'req_question' });
    expect(sessionRpcWithServerScope).toHaveBeenCalledWith({
      sessionId: 's1',
      serverId: 'server-a',
      method: RPC_METHODS.SESSION_USER_ACTION_ANSWER,
      payload: { id: 'req_question', approved: true, answers: { 'Continue?': ['Yes'] } },
    });
  });

  it('refreshes the resolved target session messages before failing a user-action response', async () => {
    state.sessions.s1.agentState.requests = {};
    state.sessionMessages.s1.messages = [];
    refreshSessionMessages.mockImplementation(async (sessionId: string) => {
      if (sessionId !== 's1') return;
      state.sessionMessages.s1.messages = [
        {
          kind: 'tool-call',
          id: 'm_pending_question_after_refresh',
          localId: null,
          createdAt: 16,
          children: [],
          tool: {
            id: 'req_question_after_refresh',
            name: 'AskUserQuestion',
            description: 'Ask the user a question',
            state: 'running',
            input: { questions: [{ question: 'Continue with the write?' }] },
            createdAt: 16,
            startedAt: null,
            completedAt: null,
            permission: { id: 'req_question_after_refresh', status: 'pending', kind: 'user_action' },
          },
        },
      ];
    });
    sessionRpcWithServerScope.mockResolvedValue({ ok: true });

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const result = await (tools as any).answerUserActionRequest({
      answers: [{ question: 'Continue with the write?', values: ['Yes'] }],
    });

    expect(refreshSessionMessages).toHaveBeenCalledWith('s1');
    expect(JSON.parse(result)).toMatchObject({ ok: true, sessionId: 's1', requestId: 'req_question_after_refresh' });
  });

  it('forces a session refresh before failing a user-action response when the known session state is stale', async () => {
    state.sessions.s1.agentState.requests = {};
    state.sessionMessages.s1.messages = [];
    ensureSessionVisibleForMessageRoute.mockImplementation(async (sessionId: string, options?: { forceRefresh?: boolean }) => {
      if (sessionId !== 's1' || options?.forceRefresh !== true) return;
      state.sessions.s1.agentState.requests = {
        req_question_after_force_refresh: {
          id: 'req_question_after_force_refresh',
          tool: 'AskUserQuestion',
          kind: 'user_action',
          arguments: { questions: [{ question: 'Continue with local voice QA?' }] },
        },
      };
    });
    sessionRpcWithServerScope.mockResolvedValue({ ok: true });

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const result = await (tools as any).answerUserActionRequest({
      answers: [{ question: 'Continue with local voice QA?', values: ['Yes'] }],
    });

    expect(ensureSessionVisibleForMessageRoute).toHaveBeenCalledWith('s1', { forceRefresh: true });
    expect(JSON.parse(result)).toMatchObject({ ok: true, sessionId: 's1', requestId: 'req_question_after_force_refresh' });
  });

  it('routes sendSessionMessage to an explicit sessionId through canonical Voice admission', async () => {
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const result = await tools.sendSessionMessage({ sessionId: 's2', message: 'hello' });

    expect(JSON.parse(result)).toMatchObject({ ok: true });
    expect(submitMessage).toHaveBeenCalledWith('s2', 'hello', undefined, undefined, {
      callerSurface: 'voice_turn',
      forceImmediate: true,
      hostAdmissionOrigin: 'voice',
    });
    expect(sendSessionMessageWithServerScope).not.toHaveBeenCalled();
  });

  it('can set the primary action session', async () => {
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const result = await tools.setPrimaryActionSession({ sessionId: 's2' });

    expect(JSON.parse(result)).toMatchObject({ ok: true });
    expect(useVoiceTargetStore.getState().primaryActionSessionId).toBe('s2');
  });

  it('can set tracked sessions (deduped and normalized)', async () => {
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const result = await tools.setTrackedSessions({ sessionIds: ['s2', ' s1 ', 's2'] });

    expect(JSON.parse(result)).toMatchObject({ ok: true });
    expect(useVoiceTargetStore.getState().trackedSessionIds).toEqual(['s1', 's2']);
  });

  it('lists sessions as JSON', async () => {
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const defaultRes = await tools.listSessions({ limit: 1 });
    const defaultParsed = JSON.parse(defaultRes) as any;
    expect(defaultParsed.sessions[0].lastMessagePreview).toBeUndefined();

    const res = await tools.listSessions({ limit: 1, includeLastMessagePreview: true });
    const parsed = JSON.parse(res) as any;
    expect(Array.isArray(parsed.sessions)).toBe(true);
    expect(parsed.sessions.length).toBe(1);
    expect(parsed.sessions[0].id).toBe('s1');
    expect(parsed.sessions.some((s: any) => s.id === 'sys_voice')).toBe(false);
    expect(typeof parsed.sessions[0].title).toBe('string');
    expect(parsed.sessions[0].lastMessagePreview?.text).toContain('a2');
    expect(typeof parsed.nextCursor === 'string').toBe(true);

    const res2 = await tools.listSessions({ limit: 10, cursor: parsed.nextCursor, includeLastMessagePreview: true });
    const parsed2 = JSON.parse(res2) as any;
    expect(parsed2.sessions.some((s: any) => s.id === 's2')).toBe(true);
    const s2 = parsed2.sessions.find((s: any) => s.id === 's2');
    expect(s2?.lastMessagePreview?.role).toBe('tool');
    expect(s2?.lastMessagePreview?.text).toContain('Tool: read');
    expect(s2?.lastMessagePreview?.text).not.toContain('/Users/alice/SecretRepo/README.md');
    expect(s2?.lastMessagePreview?.text).not.toContain('Args:');

  });

  it('includes cached sessions from other servers in listSessions (with serverId)', async () => {
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const res = await tools.listSessions({ limit: 10, includeLastMessagePreview: false });
    const parsed = JSON.parse(res) as any;

    const other = parsed.sessions.find((s: any) => s.id === 's_other');
    expect(other).toBeTruthy();
    expect(other.serverId).toBe('server-b');
  });

  it('includes sessions that only exist in the current visible session list', async () => {
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const res = await tools.listSessions({ limit: 20, includeLastMessagePreview: false });
    const parsed = JSON.parse(res) as any;

    const visibleOnly = parsed.sessions.find((s: any) => s.id === 's_visible_only');
    expect(visibleOnly).toBeTruthy();
    expect(visibleOnly).toMatchObject({
      title: 'Visible only in current list',
      active: true,
      presence: 'online',
    });
  });

  it('omits the location label from listSessions results because file-path sharing is hardened off', async () => {
    // `voiceSettingsParse` force-disables shareFilePaths over the voice transport, so the
    // workspace location label must not be surfaced to the provider.
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const res = await tools.listSessions({ limit: 20, includeLastMessagePreview: false });
    const parsed = JSON.parse(res) as any;

    const session = parsed.sessions.find((entry: any) => entry.id === 's1');
    expect(session).toMatchObject({ id: 's1' });
    expect(session.locationLabel).toBeUndefined();
  });

  it('prefers the visible human title over a stale raw session title for the same session id', async () => {
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const res = await tools.listSessions({ limit: 20, includeLastMessagePreview: false });
    const parsed = JSON.parse(res) as any;

    const matrix = parsed.sessions.find((s: any) => s.id === 's_matrix');
    expect(matrix).toBeTruthy();
    expect(matrix).toMatchObject({
      id: 's_matrix',
      title: 'Session QA Voice Matrix',
    });
  });

  it('uses session list renderables as a fallback human title source when raw sessions are stale', async () => {
    state.sessionListViewData = null;

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const res = await tools.listSessions({ limit: 20, includeLastMessagePreview: false });
    const parsed = JSON.parse(res) as any;

    const matrix = parsed.sessions.find((s: any) => s.id === 's_matrix');
    expect(matrix).toBeTruthy();
    expect(matrix).toMatchObject({
      id: 's_matrix',
      title: 'Session QA Voice Matrix',
    });
  });

  it('uses a larger default session list page when limit is omitted so older visible titles stay discoverable', async () => {
    state.sessionListViewData = [
      ...Array.from({ length: 30 }, (_, index) => ({
        type: 'session',
        session: {
          id: `s_recent_${index + 1}`,
          active: true,
          updatedAt: 1000 - index,
          presence: 'online',
          metadata: { summaryText: `Recent session ${index + 1}`, path: `/tmp/recent-${index + 1}` },
        },
      })),
      {
        type: 'session',
        session: {
          id: 's_matrix',
          active: false,
          updatedAt: 60,
          presence: 'offline',
          metadata: { summaryText: 'Session QA Voice Matrix', path: '/tmp/matrix' },
        },
      },
    ];

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const res = await tools.listSessions({ includeLastMessagePreview: false });
    const parsed = JSON.parse(res) as any;

    expect(parsed.sessions.find((session: any) => session.id === 's_matrix')).toMatchObject({
      id: 's_matrix',
      title: 'Session QA Voice Matrix',
    });
  });

  it('redacts tool args in previews when shareToolArgs is false', async () => {
    state.settings.voice.privacy.shareToolArgs = false;

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const res = await tools.listSessions({ limit: 10, includeLastMessagePreview: true });
    const parsed = JSON.parse(res) as any;
    const s2 = parsed.sessions.find((s: any) => s.id === 's2');
    expect(s2?.lastMessagePreview?.text).toContain('Tool: read');
    expect(s2?.lastMessagePreview?.text).not.toContain('/Users/alice/SecretRepo/README.md');
    expect(s2?.lastMessagePreview?.text).not.toContain('Args:');
  });

  it('does not include user/assistant text previews in listSessions when shareRecentMessages is false', async () => {
    state.settings.voice.privacy.shareRecentMessages = false;

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const res = await tools.listSessions({ limit: 10, includeLastMessagePreview: true });
    const parsed = JSON.parse(res) as any;

    const s1 = parsed.sessions.find((s: any) => s.id === 's1');
    expect(s1?.lastMessagePreview).toBeUndefined();

    const s2 = parsed.sessions.find((s: any) => s.id === 's2');
    expect(s2?.lastMessagePreview?.role).toBe('tool');
    expect(s2?.lastMessagePreview?.text).toContain('Tool: read');
  });

  it('returns transcript messages for a session when allowed', async () => {
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const res = await tools.getSessionTranscript({ sessionId: 's1', limit: 2 });
    const parsed = JSON.parse(res) as any;
    expect(Array.isArray(parsed.items)).toBe(true);
    expect(parsed.items.length).toBe(2);
    expect(parsed.items[0].role).toBe('user');
    expect(parsed.items[1].role).toBe('assistant');
    expect(tools.getSessionRecentMessages).toBeUndefined();
  });

  it('accepts larger on-demand limits for getSessionTranscript (up to 50)', async () => {
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const res = await tools.getSessionTranscript({ sessionId: 's1', limit: 20 });
    const parsed = JSON.parse(res) as any;
    expect(parsed.error).toBeUndefined();
    expect(Array.isArray(parsed.items)).toBe(true);
  });

  it('treats tracked sessions as active for otherSessions snippets gating', async () => {
    state.settings.voice.ui.updates.otherSessionsSnippetsMode = 'never';
    useVoiceTargetStore.getState().setTrackedSessionIds(['s2']);

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const res = await tools.getSessionTranscript({ sessionId: 's2', limit: 1 });
    const parsed = JSON.parse(res) as any;
    expect(parsed.error).toBeUndefined();
    expect(parsed.sessionId).toBe('s2');
  });

  it('redacts file paths in message text when shareFilePaths is false', async () => {
    state.settings.voice.privacy.shareFilePaths = false;
    (state.sessionMessages.s1.messages as any[]).push({
      kind: 'agent-text',
      id: 'm_path',
      localId: null,
      createdAt: 10,
      text: 'See /Users/alice/SecretRepo/README.md for details.',
    });

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const res = await tools.getSessionTranscript({ sessionId: 's1', limit: 1, roles: ['assistant'], maxCharsPerMessage: null });
    const parsed = JSON.parse(res) as any;
    expect(parsed.items[0].text).toContain('<path_redacted>');
    expect(parsed.items[0].text).not.toContain('/Users/alice/SecretRepo/README.md');
  });

  it('does not clamp message text by default', async () => {
    const long = 'x'.repeat(9001);
    state.sessionMessages.s1.messages = [
      { kind: 'agent-text', id: 'm_long', localId: null, createdAt: 100, text: long },
    ];

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const res = await tools.getSessionTranscript({ sessionId: 's1', limit: 1, roles: ['assistant'] });
    const parsed = JSON.parse(res) as any;
    expect(parsed.items[0].text.length).toBe(9001);
  });

  it('returns a session activity digest without transcript content', async () => {
    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: (explicit) => (explicit ? (explicit as any) : 's1') });

    const res = await tools.getSessionActivity({ sessionId: 's1' });
    const parsed = JSON.parse(res) as any;

    expect(parsed.sessionId).toBe('s1');
    expect(Array.isArray(parsed.permissionRequestIds)).toBe(true);
    expect(parsed.permissionRequestIds).toContain('req_a');
    expect(parsed.messageCounts).toEqual(expect.any(Object));
    expect(parsed.messageCounts).toEqual({ total: 2, assistant: 1, user: 1 });
    expect(parsed.recentMessages).toBeUndefined();
  });

  it('respects actionsSettingsV1 disabledSurfaces for voice_tool surface', async () => {
    // Configure settings to disable session.message.send for voice_tool surface
    state.settings.actionsSettingsV1 = {
      v: 1,
      actions: {
        'session.message.send': {
          disabledSurfaces: ['voice_tool'],
        },
      },
    };

    const { createVoiceToolHandlers } = await import('./handlers');
    const tools = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    const result = await tools.sendSessionMessage({ message: 'hi' });
    const parsed = JSON.parse(result);

    // Should fail because action is disabled for voice_tool surface
    expect(parsed.ok).toBe(false);
    expect(parsed.errorCode).toBe('action_disabled');
    expect(sendSessionMessageWithServerScope).not.toHaveBeenCalled();
    expect(submitMessage).not.toHaveBeenCalled();
  });
});
