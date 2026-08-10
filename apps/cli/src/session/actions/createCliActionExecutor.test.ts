import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockAxiosGet, mockAxiosPost } = vi.hoisted(() => ({
  mockAxiosGet: vi.fn(),
  mockAxiosPost: vi.fn(),
}));

vi.mock('axios', () => ({
  default: {
    get: mockAxiosGet,
    post: mockAxiosPost,
  },
}));

vi.mock('@/configuration', async () => {
  const actual = await vi.importActual<any>('@/configuration');
  return {
    ...actual,
    configuration: {
      ...actual.configuration,
      apiServerUrl: 'http://127.0.0.1:24599',
    },
  };
});

const {
  spawnDaemonSession,
  resolveDaemonSpawnSessionByNonce,
  fetchSessionById,
  fetchSessionsPage,
  updateSessionMetadataWithRetry,
  sendSessionMessage,
  requestSessionStop,
  setSessionTitle,
  setSessionPermissionMode,
  setSessionMode,
  getExecutionRun,
  listExecutionRuns,
  sendExecutionRunMessage,
  startExecutionRun,
  stopExecutionRun,
  executeExecutionRunAction,
  bootstrapAccountSettingsContext,
} = vi.hoisted(() => ({
  spawnDaemonSession: vi.fn(),
  resolveDaemonSpawnSessionByNonce: vi.fn(),
  fetchSessionById: vi.fn(),
  fetchSessionsPage: vi.fn(),
  updateSessionMetadataWithRetry: vi.fn(),
  sendSessionMessage: vi.fn(),
  requestSessionStop: vi.fn(),
  setSessionTitle: vi.fn(),
  setSessionPermissionMode: vi.fn(),
  setSessionMode: vi.fn(),
  getExecutionRun: vi.fn(),
  listExecutionRuns: vi.fn(),
  sendExecutionRunMessage: vi.fn(),
  startExecutionRun: vi.fn(),
  stopExecutionRun: vi.fn(),
  executeExecutionRunAction: vi.fn(),
  bootstrapAccountSettingsContext: vi.fn(),
}));

vi.mock('@/daemon/controlClient', () => ({
  spawnDaemonSession,
  resolveDaemonSpawnSessionByNonce,
}));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionById,
  fetchSessionsPage,
}));

vi.mock('@/session/metadata/updateSessionMetadataWithRetry', () => ({
  updateSessionMetadataWithRetry,
}));

vi.mock('@/session/services/sendSessionMessage', () => ({
  sendSessionMessage,
}));

vi.mock('@/session/services/requestSessionStop', () => ({
  requestSessionStop,
}));

vi.mock('@/session/services/setSessionTitle', () => ({
  setSessionTitle,
}));

vi.mock('@/session/services/setSessionPermissionMode', () => ({
  setSessionPermissionMode,
}));

vi.mock('@/session/services/setSessionMode', () => ({
  setSessionMode,
}));

vi.mock('@/session/services/executionRuns', () => ({
  getExecutionRun,
  listExecutionRuns,
  sendExecutionRunMessage,
  startExecutionRun,
  stopExecutionRun,
  executeExecutionRunAction,
}));

vi.mock('@/settings/accountSettings/bootstrapAccountSettingsContext', () => ({
  bootstrapAccountSettingsContext,
}));

const { callSessionRpc } = vi.hoisted(() => ({
  callSessionRpc: vi.fn(),
}));

vi.mock('@/session/transport/rpc/sessionRpc', () => ({
  callSessionRpc,
}));

import { createCliActionExecutor } from './createCliActionExecutor';
import {
  MENTION_KIND_V1,
  accountSettingsParse,
  buildMentionRefForKindV1,
  deriveBoxPublicKeyFromSeed,
  encodeBase64,
  getActionSpec,
  readMentionRefOpaqueForKindV1,
  sealEncryptedDataKeyEnvelopeV1,
} from '@happier-dev/protocol';
import { createPendingFirstInput } from '@/daemon/spawn/pendingFirstInput';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';

const env = process.env;

function createPlainExecutor(extra: Partial<Parameters<typeof createCliActionExecutor>[0]> = {}) {
  return createCliActionExecutor({
    token: 'token',
    credentials: {
      token: 'token',
      encryption: {
        type: 'legacy',
        secret: new Uint8Array([1, 2, 3, 4]),
      },
    },
    sessionId: 'sess-1',
    mode: 'plain',
    ctx: {
      encryptionKey: new Uint8Array([1, 2, 3, 4]),
      encryptionVariant: 'legacy',
    },
    ...extra,
  });
}

function createDataKeyExecutor(extra: Partial<Parameters<typeof createCliActionExecutor>[0]> = {}) {
  const machineKey = new Uint8Array(32).fill(7);
  const publicKey = deriveBoxPublicKeyFromSeed(machineKey);
  return createCliActionExecutor({
    token: 'token',
    credentials: {
      token: 'token',
      encryption: {
        type: 'dataKey',
        publicKey,
        machineKey,
      },
    },
    sessionId: 'sess-1',
    mode: 'plain',
    ctx: {
      encryptionKey: machineKey,
      encryptionVariant: 'dataKey',
    },
    ...extra,
  });
}

function allowSessionAgentActions(...actionIds: string[]): void {
  process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
    v: 1,
    actions: Object.fromEntries(
      actionIds.map((actionId) => [
        actionId,
        { enabled: true, disabledSurfaces: [], disabledPlacements: [] },
      ]),
    ),
  });
}

function expectSingleSpawnWithPendingFirstInput(text: string): void {
  expect(spawnDaemonSession).toHaveBeenCalledTimes(1);
  const request = spawnDaemonSession.mock.calls[0]?.[0] as {
    spawnNonce?: unknown;
    pendingFirstInput?: unknown;
    initialPrompt?: unknown;
  } | undefined;
  expect(request?.spawnNonce).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/i));
  if (typeof request?.spawnNonce !== 'string') {
    throw new Error('expected spawn nonce');
  }
  expect(request.pendingFirstInput).toEqual(createPendingFirstInput({
    text,
    spawnNonce: request.spawnNonce,
  }));
  expect(request).not.toHaveProperty('initialPrompt');
}

describe('createCliActionExecutor', () => {
  beforeEach(() => {
    spawnDaemonSession.mockReset();
    resolveDaemonSpawnSessionByNonce.mockReset();
    fetchSessionById.mockReset();
    fetchSessionsPage.mockReset();
    updateSessionMetadataWithRetry.mockReset();
    sendSessionMessage.mockReset();
    requestSessionStop.mockReset();
    setSessionTitle.mockReset();
    setSessionPermissionMode.mockReset();
    setSessionMode.mockReset();
    getExecutionRun.mockReset();
    listExecutionRuns.mockReset();
    sendExecutionRunMessage.mockReset();
    startExecutionRun.mockReset();
    stopExecutionRun.mockReset();
    executeExecutionRunAction.mockReset();
    bootstrapAccountSettingsContext.mockReset();
    bootstrapAccountSettingsContext.mockResolvedValue({
      source: 'none',
      settings: accountSettingsParse({}),
      settingsVersion: 0,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      whenRefreshed: null,
    });
    callSessionRpc.mockReset();
    mockAxiosGet.mockReset();
    mockAxiosPost.mockReset();
    process.env = { ...env };
    delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
  });

  it('resolves execution backend options on the MCP surface', async () => {
    const executor = createPlainExecutor();

    const result = await executor.execute(
      'action.options.resolve',
      {
        actionId: 'subagents.plan.start',
        fieldPath: 'backendTargetKeys',
        sessionId: 'sess-1',
      },
      { surface: 'mcp', defaultSessionId: 'sess-1' },
    );

    expect(result).toMatchObject({
      ok: true,
      result: {
        actionId: 'subagents.plan.start',
        fieldPath: 'backendTargetKeys',
        optionsSourceId: 'execution.backends.enabled',
      },
    });
    expect((result as any).result.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: 'agent:claude',
          label: expect.any(String),
        }),
      ]),
    );
  });

  it('resolves review engine options on the MCP surface', async () => {
    const executor = createPlainExecutor();

    const result = await executor.execute(
      'action.options.resolve',
      {
        actionId: 'review.start',
        fieldPath: 'engineIds',
        sessionId: 'sess-1',
      },
      { surface: 'mcp', defaultSessionId: 'sess-1' },
    );

    expect(result).toEqual({
      ok: true,
      result: {
        actionId: 'review.start',
        fieldPath: 'engineIds',
        optionsSourceId: 'review.engines.available',
        options: [{ value: 'coderabbit', label: 'CodeRabbit' }],
      },
    });
  });

  it('resolves session mode options from raw session metadata on the MCP surface', async () => {
    const executor = createPlainExecutor({
      rawSession: {
        metadata: {
          sessionModesV1: {
            currentModeId: 'build',
            availableModes: [
              { id: 'build', name: 'Build' },
              { id: 'plan', name: 'Plan' },
            ],
          },
        },
      },
    });

    const result = await executor.execute(
      'action.options.resolve',
      {
        optionsSourceId: 'session.modes.available',
        sessionId: 'sess-1',
      },
      { surface: 'mcp', defaultSessionId: 'sess-1' },
    );

    expect(result).toEqual({
      ok: true,
      result: {
        actionId: null,
        fieldPath: null,
        optionsSourceId: 'session.modes.available',
        options: [
          { value: 'build', label: 'Build' },
          { value: 'plan', label: 'Plan' },
        ],
      },
    });
  });

  it('resolves session mode options from fetched session metadata when targeting a different session id', async () => {
    const executor = createPlainExecutor();
    fetchSessionById.mockResolvedValue({
      id: 'sess-2',
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: {
        sessionModesV1: {
          availableModes: [
            { id: 'build', name: 'Build' },
            { id: 'plan', name: 'Plan' },
          ],
        },
      },
    });

    const result = await executor.execute(
      'action.options.resolve',
      {
        optionsSourceId: 'session.modes.available',
        sessionId: 'sess-2',
      },
      { surface: 'mcp', defaultSessionId: 'sess-1' },
    );

    expect(result).toEqual({
      ok: true,
      result: {
        actionId: null,
        fieldPath: null,
        optionsSourceId: 'session.modes.available',
        options: [
          { value: 'build', label: 'Build' },
          { value: 'plan', label: 'Plan' },
        ],
      },
    });
    expect(fetchSessionById).toHaveBeenCalledWith({ token: 'token', sessionId: 'sess-2' });
  });

  it('rejects actions disabled on the CLI surface by action settings', async () => {
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'review.start': { enabled: true, disabledSurfaces: ['cli'], disabledPlacements: [] },
      },
    });

    const executor = createPlainExecutor();

    const result = await executor.execute(
      'review.start',
      {
        sessionId: 'sess-1',
        engineIds: ['coderabbit'],
        instructions: 'Review this change.',
        permissionMode: 'read_only',
        changeType: 'committed',
        base: { kind: 'none' },
      },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toEqual({
      ok: false,
      errorCode: 'action_disabled',
      error: 'action_disabled',
      details: expect.objectContaining({
        actionId: 'review.start',
        reason: 'disabled_by_settings',
        settingsState: 'disabled',
        surface: 'cli',
      }),
    });
  });

  it('responds to permission requests via session RPC', async () => {
    const executor = createPlainExecutor();
    fetchSessionsPage.mockResolvedValue({
      sessions: [{ id: 'sess-1', metadata: {} }],
      hasNext: false,
      nextCursor: null,
    });
    fetchSessionById.mockResolvedValue({
      id: 'sess-1',
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: {},
    });
    callSessionRpc.mockResolvedValue({ ok: true });

    const result = await executor.execute(
      'session.permission.respond',
      { sessionId: 'sess-1', decision: 'allow', requestId: 'perm-1' },
      { surface: 'mcp', defaultSessionId: 'sess-1' },
    );

    expect(result).toEqual({ ok: true, result: { ok: true } });
    expect(callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      token: 'token',
      sessionId: 'sess-1',
      method: 'sess-1:permission',
      request: { id: 'perm-1', approved: true },
    }));
  });

  it('responds to the only pending permission request when requestId is omitted', async () => {
    const executor = createPlainExecutor();
    fetchSessionsPage.mockResolvedValue({
      sessions: [{ id: 'sess-1', metadata: {} }],
      hasNext: false,
      nextCursor: null,
    });
    fetchSessionById.mockResolvedValue({
      id: 'sess-1',
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: {},
      encryptionMode: 'plain',
      agentState: JSON.stringify({
        requests: {
          'perm-1': { kind: 'permission', tool: 'Write', createdAt: 1 },
        },
      }),
    });
    callSessionRpc.mockResolvedValue({ ok: true });

    const result = await executor.execute(
      'session.permission.respond',
      { sessionId: 'sess-1', decision: 'allow' },
      { surface: 'mcp', defaultSessionId: 'sess-1' },
    );

    expect(result).toEqual({ ok: true, result: { ok: true } });
    expect(callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      token: 'token',
      sessionId: 'sess-1',
      method: 'sess-1:permission',
      request: { id: 'perm-1', approved: true },
    }));
  });

  it('rejects omitted requestId when multiple permission requests are pending', async () => {
    const executor = createPlainExecutor();
    fetchSessionsPage.mockResolvedValue({
      sessions: [{ id: 'sess-1', metadata: {} }],
      hasNext: false,
      nextCursor: null,
    });
    fetchSessionById.mockResolvedValue({
      id: 'sess-1',
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: {},
      encryptionMode: 'plain',
      agentState: JSON.stringify({
        requests: {
          'perm-1': { kind: 'permission', tool: 'Write', createdAt: 1 },
          'perm-2': { kind: 'permission', tool: 'Edit', createdAt: 2 },
        },
      }),
    });

    const result = await executor.execute(
      'session.permission.respond',
      { sessionId: 'sess-1', decision: 'allow' },
      { surface: 'mcp', defaultSessionId: 'sess-1' },
    );

    expect(result).toEqual({
      ok: true,
      result: {
        ok: false,
        errorCode: 'permission_request_not_found',
        errorMessage: 'permission_request_not_found',
        sessionId: 'sess-1',
      },
    });
    expect(callSessionRpc).not.toHaveBeenCalled();
  });

  it('answers user-action requests via session RPC', async () => {
    const executor = createPlainExecutor();
    fetchSessionsPage.mockResolvedValue({
      sessions: [{ id: 'sess-1', metadata: {} }],
      hasNext: false,
      nextCursor: null,
    });
    fetchSessionById.mockResolvedValue({
      id: 'sess-1',
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: {},
    });
    callSessionRpc.mockResolvedValue({ ok: true });

    const result = await executor.execute(
      'session.user_action.answer',
      {
        sessionId: 'sess-1',
        requestId: 'ua-1',
        decision: 'approve',
        reason: 'ok',
        answers: [{ question: 'Continue?', answer: 'Yes' }],
      },
      { surface: 'mcp', defaultSessionId: 'sess-1' },
    );

    expect(result).toEqual({ ok: true, result: { ok: true } });
    expect(callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      token: 'token',
      sessionId: 'sess-1',
      method: 'sess-1:permission',
      request: expect.objectContaining({
        id: 'ua-1',
        approved: true,
        reason: 'ok',
        answers: { 'Continue?': 'Yes' },
      }),
    }));
  });

  it('answers the only pending user-action request when requestId is omitted', async () => {
    const executor = createPlainExecutor();
    fetchSessionsPage.mockResolvedValue({
      sessions: [{ id: 'sess-1', metadata: {} }],
      hasNext: false,
      nextCursor: null,
    });
    fetchSessionById.mockResolvedValue({
      id: 'sess-1',
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: {},
      encryptionMode: 'plain',
      agentState: JSON.stringify({
        requests: {
          'ua-1': { kind: 'user_action', tool: 'AskUserQuestion', createdAt: 1 },
        },
      }),
    });
    callSessionRpc.mockResolvedValue({ ok: true });

    const result = await executor.execute(
      'session.user_action.answer',
      {
        sessionId: 'sess-1',
        answers: [{ question: 'Continue?', answer: 'Yes' }],
      },
      { surface: 'mcp', defaultSessionId: 'sess-1' },
    );

    expect(result).toEqual({ ok: true, result: { ok: true } });
    expect(callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      token: 'token',
      sessionId: 'sess-1',
      method: 'sess-1:permission',
      request: expect.objectContaining({
        id: 'ua-1',
        approved: true,
        answers: { 'Continue?': 'Yes' },
      }),
    }));
  });

  it('rejects omitted requestId when multiple user-action requests are pending', async () => {
    const executor = createPlainExecutor();
    fetchSessionsPage.mockResolvedValue({
      sessions: [{ id: 'sess-1', metadata: {} }],
      hasNext: false,
      nextCursor: null,
    });
    fetchSessionById.mockResolvedValue({
      id: 'sess-1',
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: {},
      encryptionMode: 'plain',
      agentState: JSON.stringify({
        requests: {
          'ua-1': { kind: 'user_action', tool: 'AskUserQuestion', createdAt: 1 },
          'ua-2': { kind: 'user_action', tool: 'AskUserQuestion', createdAt: 2 },
        },
      }),
    });

    const result = await executor.execute(
      'session.user_action.answer',
      {
        sessionId: 'sess-1',
        answers: [{ question: 'Continue?', answer: 'Yes' }],
      },
      { surface: 'mcp', defaultSessionId: 'sess-1' },
    );

    expect(result).toEqual({
      ok: true,
      result: {
        ok: false,
        errorCode: 'permission_request_not_found',
        errorMessage: 'permission_request_not_found',
        sessionId: 'sess-1',
      },
    });
    expect(callSessionRpc).not.toHaveBeenCalled();
  });

  it('executes execution.run.get against the requested session id (not the executor default)', async () => {
    const executor = createPlainExecutor();
    fetchSessionById.mockResolvedValue({
      id: 'sess-2-aaaaaaaaaaaa',
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      pendingCount: 0,
      metadataVersion: 1,
      encryptionMode: 'plain',
      metadata: {},
    });
    getExecutionRun.mockResolvedValue({ ok: true, runId: 'run-1' });

    const result = await executor.execute(
      'execution.run.get',
      { sessionId: 'sess-2-aaaaaaaaaaaa', runId: 'run-1', includeStructured: false },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toEqual({ ok: true, result: { ok: true, runId: 'run-1' } });
    expect(getExecutionRun).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-2-aaaaaaaaaaaa',
    }));
  });

  it('resolves the stored encryption mode for execution.run.get when targeting a different session id', async () => {
    const executor = createPlainExecutor();
    fetchSessionById.mockResolvedValue({
      id: 'sess-2-aaaaaaaaaaaa',
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      pendingCount: 0,
      metadataVersion: 1,
      encryptionMode: 'e2ee',
      metadata: {},
    });
    getExecutionRun.mockResolvedValue({ ok: true, runId: 'run-1' });

    const result = await executor.execute(
      'execution.run.get',
      { sessionId: 'sess-2-aaaaaaaaaaaa', runId: 'run-1', includeStructured: false },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toEqual({ ok: true, result: { ok: true, runId: 'run-1' } });
    expect(fetchSessionById).toHaveBeenCalledWith(expect.objectContaining({
      token: 'token',
      sessionId: 'sess-2-aaaaaaaaaaaa',
    }));
    expect(getExecutionRun).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-2-aaaaaaaaaaaa',
      mode: 'e2ee',
    }));
  });

  it('spawns a new session from the current session context with account connected-service defaults', async () => {
    const executor = createPlainExecutor({
      rawSession: {
        machineId: 'machine-1',
        path: '/repo/current',
        host: 'leeroy-mbp',
        metadata: {
          machineId: 'machine-1',
          path: '/repo/current',
          host: 'leeroy-mbp',
        },
      },
    });
    bootstrapAccountSettingsContext.mockResolvedValueOnce({
      source: 'network',
      settings: accountSettingsParse({
        connectedServicesDefaultAuthByAgentIdV1: {
          v: 1,
          bindingsByAgentId: {
            claude: {
              v: 1,
              bindingsByServiceId: {
                'claude-subscription': {
                  source: 'connected',
                  selection: 'group',
                  groupId: 'claude',
                },
              },
            },
          },
        },
      }),
      settingsVersion: 7,
      loadedAtMs: 1234,
      settingsSecretsReadKeys: [],
      whenRefreshed: null,
    });
    spawnDaemonSession.mockResolvedValue({ success: true, sessionId: 'sess-new' });
    fetchSessionById.mockResolvedValueOnce({
      id: 'sess-1',
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: {
        machineId: 'machine-1',
        path: '/repo/current',
        host: 'leeroy-mbp',
      },
    });
    fetchSessionById.mockResolvedValue({
      id: 'sess-new',
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: {
        path: '/repo/current',
        host: 'leeroy-mbp',
        tag: 'voice-qa',
        summary: { text: 'Spawned session' },
      },
    });
    updateSessionMetadataWithRetry.mockResolvedValue({
      version: 2,
      metadata: {
        machineId: 'machine-1',
        path: '/repo/current',
        host: 'leeroy-mbp',
        tag: 'voice-qa',
      },
    });
    sendSessionMessage.mockResolvedValue({
      ok: true,
      sessionId: 'sess-new',
      localId: 'local-1',
      waited: false,
    });

    const result = await executor.execute(
      'session.spawn_new',
      {
        tag: 'voice-qa',
        agentId: 'claude',
        modelId: 'gpt-5',
        initialMessage: 'Hello from CLI action',
      },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result.ok).toBe(true);
    expect(spawnDaemonSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/repo/current',
      machineId: 'machine-1',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      modelId: 'gpt-5',
      modelUpdatedAt: expect.any(Number),
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': {
            source: 'connected',
            selection: 'group',
            groupId: 'claude',
          },
          anthropic: { source: 'native' },
        },
      },
      connectedServicesUpdatedAt: expect.any(Number),
    }));
    expectSingleSpawnWithPendingFirstInput('Hello from CLI action');
    expect(updateSessionMetadataWithRetry).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-new',
      token: 'token',
    }));
    expect(sendSessionMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      result: {
        type: 'success',
        sessionId: 'sess-new',
        created: true,
        session: {
          id: 'sess-new',
        },
      },
    });
  });

  it('forwards rich session.spawn_new options through the daemon spawn path', async () => {
    const executor = createPlainExecutor({
      rawSession: {
        machineId: 'machine-1',
        path: '/repo/current',
        host: 'leeroy-mbp',
        metadata: {
          machineId: 'machine-1',
          path: '/repo/current',
          host: 'leeroy-mbp',
          permissionMode: 'safe-yolo',
          permissionModeUpdatedAt: 123,
        },
      },
    });
    spawnDaemonSession.mockResolvedValue({ success: true, sessionId: 'sess-rich' });
    fetchSessionById.mockResolvedValueOnce({
      id: 'sess-1',
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: {
        machineId: 'machine-1',
        path: '/repo/current',
        host: 'leeroy-mbp',
        permissionMode: 'safe-yolo',
        permissionModeUpdatedAt: 123,
      },
    });
    fetchSessionById.mockResolvedValue({
      id: 'sess-rich',
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: {
        path: '/repo/current',
        host: 'leeroy-mbp',
      },
    });

    const result = await executor.execute(
      'session.spawn_new',
      {
        backendTargetKey: 'agent:claude',
        permissionMode: 'acceptEdits',
        agentModeId: 'plan',
        modelId: 'claude-opus-4-8',
        sessionConfigOptionOverrides: {
          v: 1,
          updatedAt: 10,
          overrides: {
            reasoning_effort: { updatedAt: 10, value: 'xhigh' },
            ultracode: { updatedAt: 10, value: true },
          },
        },
        profileId: 'profile-1',
        environmentVariables: { FEATURE_FLAG: 'enabled' },
        mcpSelection: {
          v: 1,
          managedServersEnabled: false,
          forceIncludeServerIds: ['repo-tools'],
          forceExcludeServerIds: ['legacy-tool'],
        },
        transcriptStorage: 'persisted',
        codexBackendMode: 'appServer',
        agentRuntimeDescriptorV1: {
          v: 1,
          providerId: 'codex',
          provider: {
            backendMode: 'appServer',
            providerExtra: {
              owner: 'codex',
              schemaId: 'codex.agentRuntimeDescriptorExtra',
              v: 1,
            },
          },
        },
        initialMessage: 'Rich spawn',
      },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result.ok).toBe(true);
    expect(spawnDaemonSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/repo/current',
      machineId: 'machine-1',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'acceptEdits',
      permissionModeUpdatedAt: expect.any(Number),
      agentModeId: 'plan',
      agentModeUpdatedAt: expect.any(Number),
      modelId: 'claude-opus-4-8',
      modelUpdatedAt: expect.any(Number),
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 10,
        overrides: {
          reasoning_effort: { updatedAt: 10, value: 'xhigh' },
          ultracode: { updatedAt: 10, value: true },
        },
      },
      profileId: 'profile-1',
      environmentVariables: { FEATURE_FLAG: 'enabled' },
      mcpSelection: {
        v: 1,
        managedServersEnabled: false,
        forceIncludeServerIds: ['repo-tools'],
        forceExcludeServerIds: ['legacy-tool'],
      },
      transcriptStorage: 'persisted',
      codexBackendMode: 'appServer',
      agentRuntimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: expect.objectContaining({
          backendMode: 'appServer',
        }),
      },
    }));
    expectSingleSpawnWithPendingFirstInput('Rich spawn');
  });

  it('inherits the current session backend target for session-agent spawn when no explicit target is provided', async () => {
    const executor = createPlainExecutor({
      rawSession: {
        machineId: 'machine-1',
        path: '/repo/current',
        host: 'leeroy-mbp',
        metadata: {
          machineId: 'machine-1',
          path: '/repo/current',
          host: 'leeroy-mbp',
          permissionMode: 'safe-yolo',
          permissionModeUpdatedAt: 123,
          agentRuntimeDescriptorV1: { v: 1, providerId: 'claude' },
        },
      },
      getCurrentSessionBackendTarget: () => ({ kind: 'configuredAcpBackend', backendId: 'review-bot' }),
    });
    spawnDaemonSession.mockResolvedValue({ success: true, sessionId: 'sess-inherited-target' });
    fetchSessionById.mockResolvedValueOnce({
      id: 'sess-1',
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: {
        machineId: 'machine-1',
        path: '/repo/current',
        host: 'leeroy-mbp',
        permissionMode: 'safe-yolo',
        permissionModeUpdatedAt: 123,
        agentRuntimeDescriptorV1: { v: 1, providerId: 'claude' },
      },
    });
    fetchSessionById.mockResolvedValue({
      id: 'sess-inherited-target',
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: {
        path: '/repo/current',
        host: 'leeroy-mbp',
      },
    });

    const result = await executor.execute(
      'session.spawn_new',
      {
        initialMessage: 'Spawn with inherited configured backend',
      },
      { surface: 'session_agent', defaultSessionId: 'sess-1' },
    );

    expect(result.ok).toBe(true);
    expect(spawnDaemonSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/repo/current',
      machineId: 'machine-1',
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      permissionMode: 'safe-yolo',
      permissionModeUpdatedAt: 123,
    }));
    expectSingleSpawnWithPendingFirstInput('Spawn with inherited configured backend');
  });

  it('prefers the live raw-session metadata over stale fetched metadata for session-agent spawn inheritance', async () => {
    const inheritedConfig = {
      v: 1,
      updatedAt: 10,
      overrides: {
        reasoning_effort: { updatedAt: 10, value: 'high' },
        ultracode: { updatedAt: 10, value: false },
      },
    } as const;
    const executor = createPlainExecutor({
      rawSession: {
        machineId: 'machine-1',
        path: '/repo/current',
        host: 'leeroy-mbp',
        metadata: {
          machineId: 'machine-1',
          path: '/repo/current',
          host: 'leeroy-mbp',
          permissionMode: 'safe-yolo',
          permissionModeUpdatedAt: 123,
          modelOverrideV1: { v: 1, updatedAt: 124, modelId: 'claude-opus-parent' },
          sessionConfigOptionOverridesV1: inheritedConfig,
          profileId: 'parent-profile',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'claude-subscription': {
                source: 'connected',
                selection: 'profile',
                profileId: 'claude-profile-1',
              },
            },
          },
          connectedServicesUpdatedAt: 125,
          mcpSelectionV1: {
            v: 1,
            managedServersEnabled: false,
            forceIncludeServerIds: ['repo-tools'],
            forceExcludeServerIds: ['secret-env-server'],
          },
        },
      },
    });
    spawnDaemonSession.mockResolvedValue({ success: true, sessionId: 'sess-raw-session-preferred' });
    fetchSessionById.mockResolvedValueOnce({
      id: 'sess-1',
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: {
        machineId: 'machine-1',
        path: '/repo/current',
        host: 'leeroy-mbp',
        permissionMode: 'default',
        permissionModeUpdatedAt: 1,
      },
    });
    fetchSessionById.mockResolvedValue({
      id: 'sess-raw-session-preferred',
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: {
        path: '/repo/current',
        host: 'leeroy-mbp',
      },
    });

    const result = await executor.execute(
      'session.spawn_new',
      {
        initialMessage: 'Use inherited parent context.',
      },
      { surface: 'session_agent', defaultSessionId: 'sess-1' },
    );

    expect(result.ok).toBe(true);
    expect(spawnDaemonSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/repo/current',
      machineId: 'machine-1',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'safe-yolo',
      permissionModeUpdatedAt: 123,
      modelId: 'claude-opus-parent',
      modelUpdatedAt: 124,
      sessionConfigOptionOverrides: inheritedConfig,
      profileId: 'parent-profile',
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': {
            source: 'connected',
            selection: 'profile',
            profileId: 'claude-profile-1',
          },
        },
      },
      connectedServicesUpdatedAt: 125,
      mcpSelection: {
        v: 1,
        managedServersEnabled: false,
        forceIncludeServerIds: ['repo-tools'],
        forceExcludeServerIds: ['secret-env-server'],
      },
    }));
    expectSingleSpawnWithPendingFirstInput('Use inherited parent context.');
  });

  it('inherits configured ACP backend metadata for session-agent spawn when no live backend target is available', async () => {
    const executor = createPlainExecutor({
      rawSession: {
        machineId: 'machine-1',
        path: '/repo/current',
        host: 'leeroy-mbp',
        metadata: {
          machineId: 'machine-1',
          path: '/repo/current',
          host: 'leeroy-mbp',
          permissionMode: 'safe-yolo',
          permissionModeUpdatedAt: 123,
          acpConfiguredBackendV1: {
            v: 1,
            backendId: 'review-bot',
            title: 'Review Bot',
            updatedAt: 120,
          },
          agentRuntimeDescriptorV1: { v: 1, providerId: 'claude' },
        },
      },
    });
    spawnDaemonSession.mockResolvedValue({ success: true, sessionId: 'sess-configured-metadata' });
    fetchSessionById.mockResolvedValueOnce({
      id: 'sess-1',
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: {
        machineId: 'machine-1',
        path: '/repo/current',
        host: 'leeroy-mbp',
        permissionMode: 'safe-yolo',
        permissionModeUpdatedAt: 123,
        acpConfiguredBackendV1: {
          v: 1,
          backendId: 'review-bot',
          title: 'Review Bot',
          updatedAt: 120,
        },
        agentRuntimeDescriptorV1: { v: 1, providerId: 'claude' },
      },
    });
    fetchSessionById.mockResolvedValue({
      id: 'sess-configured-metadata',
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: {
        path: '/repo/current',
        host: 'leeroy-mbp',
      },
    });

    const result = await executor.execute(
      'session.spawn_new',
      {
        initialMessage: 'Spawn with metadata configured backend',
      },
      { surface: 'session_agent', defaultSessionId: 'sess-1' },
    );

    expect(result.ok).toBe(true);
    expect(spawnDaemonSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/repo/current',
      machineId: 'machine-1',
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      permissionMode: 'safe-yolo',
      permissionModeUpdatedAt: 123,
    }));
    expectSingleSpawnWithPendingFirstInput('Spawn with metadata configured backend');
  });

  it('honors public spawn aliases and terminal launch fields at the CLI action boundary', async () => {
    const executor = createPlainExecutor({
      rawSession: {
        metadata: {
          machineId: 'parent-machine',
          path: '/repo/current',
          host: 'leeroy-mbp',
          permissionMode: 'safe-yolo',
          permissionModeUpdatedAt: 123,
        },
      },
    });
    spawnDaemonSession.mockResolvedValue({ success: true, sessionId: 'sess-terminal' });
    fetchSessionById.mockResolvedValue({
      id: 'sess-terminal',
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: {
        path: '/repo/explicit',
        host: 'leeroy-mbp',
      },
    });

    const result = await executor.execute(
      'session.spawn_new',
      {
        directory: '/repo/explicit',
        machineId: 'explicit-machine',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        prompt: 'Use public prompt alias',
        configOptions: { reasoning_effort: 'xhigh' },
        terminal: {
          mode: 'tmux',
          tmux: { sessionName: 'spawn-qa', isolated: true, tmpDir: null },
        },
        windowsRemoteSessionLaunchMode: 'hidden',
        windowsRemoteSessionConsole: 'hidden',
        windowsTerminalWindowName: 'Happier QA',
      },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result.ok).toBe(true);
    expect(spawnDaemonSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/repo/explicit',
      machineId: 'explicit-machine',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'safe-yolo',
      permissionModeUpdatedAt: 123,
      sessionConfigOptionOverrides: expect.objectContaining({
        v: 1,
        updatedAt: expect.any(Number),
        overrides: expect.objectContaining({
          reasoning_effort: expect.objectContaining({
            updatedAt: expect.any(Number),
            value: 'xhigh',
          }),
        }),
      }),
      terminal: {
        mode: 'tmux',
        tmux: { sessionName: 'spawn-qa', isolated: true, tmpDir: null },
      },
      windowsRemoteSessionLaunchMode: 'hidden',
      windowsRemoteSessionConsole: 'hidden',
      windowsTerminalWindowName: 'Happier QA',
    }));
    expectSingleSpawnWithPendingFirstInput('Use public prompt alias');
  });

  it('denies explicit session-agent spawn overrides disallowed by spawn policy', async () => {
    bootstrapAccountSettingsContext.mockResolvedValue({
      source: 'server',
      settings: accountSettingsParse({
        sessionAgentSpawnPolicyV1: {
          v: 1,
          allowEnvironmentVariables: false,
        },
      }),
      settingsVersion: 2,
      loadedAtMs: 2,
      settingsSecretsReadKeys: [],
      whenRefreshed: null,
    });
    const executor = createPlainExecutor({
      rawSession: {
        metadata: {
          machineId: 'machine-1',
          path: '/repo/current',
          host: 'leeroy-mbp',
          permissionMode: 'safe-yolo',
          permissionModeUpdatedAt: 123,
        },
      },
    });

    const result = await executor.execute(
      'session.spawn_new',
      {
        backendTargetKey: 'agent:claude',
        environmentVariables: { SECRET_TOKEN: 'do-not-log' },
      },
      { surface: 'session_agent', defaultSessionId: 'sess-1' },
    );

    expect(result).toMatchObject({
      ok: true,
      result: {
        type: 'error',
        errorCode: 'spawn_policy_denied',
        errorMessage: 'spawn_policy_denied',
        details: {
          field: 'environmentVariables',
          surface: 'session_agent',
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain('do-not-log');
    expect(spawnDaemonSession).not.toHaveBeenCalled();
  });

  it('does not apply session-agent spawn override policy to CLI spawns', async () => {
    bootstrapAccountSettingsContext.mockResolvedValue({
      source: 'server',
      settings: accountSettingsParse({
        sessionAgentSpawnPolicyV1: {
          v: 1,
          allowEnvironmentVariables: false,
        },
      }),
      settingsVersion: 2,
      loadedAtMs: 2,
      settingsSecretsReadKeys: [],
      whenRefreshed: null,
    });
    const executor = createPlainExecutor({
      rawSession: {
        metadata: {
          machineId: 'machine-1',
          path: '/repo/current',
          host: 'leeroy-mbp',
          permissionMode: 'safe-yolo',
          permissionModeUpdatedAt: 123,
        },
      },
    });
    spawnDaemonSession.mockResolvedValue({ success: true, sessionId: 'sess-policy-cli' });
    fetchSessionById.mockResolvedValue({
      id: 'sess-policy-cli',
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: {
        path: '/repo/current',
        host: 'leeroy-mbp',
      },
    });

    const result = await executor.execute(
      'session.spawn_new',
      {
        backendTargetKey: 'agent:claude',
        environmentVariables: { FEATURE_FLAG: 'enabled' },
      },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toMatchObject({
      ok: true,
      result: {
        type: 'success',
        sessionId: 'sess-policy-cli',
      },
    });
    expect(spawnDaemonSession).toHaveBeenCalledWith(expect.objectContaining({
      environmentVariables: { FEATURE_FLAG: 'enabled' },
    }));
  });

  it('fails closed for session.spawn_new when nonce recovery is unsupported instead of using row-scan heuristics', async () => {
    const executor = createPlainExecutor({
      rawSession: {
        metadata: {
          machineId: 'machine-1',
          path: '/repo/current',
          host: 'leeroy-mbp',
        },
      },
    });
    spawnDaemonSession.mockResolvedValue({
      error: 'Request failed: /spawn-session, The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()',
    });
    resolveDaemonSpawnSessionByNonce.mockResolvedValue({ status: 'unsupported' });
    const result = await executor.execute(
      'session.spawn_new',
      {
        path: '/repo/current',
        backendTargetKey: 'agent:codex',
      },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toMatchObject({
      ok: false,
    });
    expect(resolveDaemonSpawnSessionByNonce).toHaveBeenCalledTimes(1);
    expect(resolveDaemonSpawnSessionByNonce).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f-]{36}$/i));
    expect(fetchSessionsPage).not.toHaveBeenCalled();
  });

  it('resumes an ambiguous action request by stable identity without submitting a second spawn', async () => {
    const executor = createPlainExecutor({
      rawSession: { metadata: { machineId: 'machine-1', path: '/repo/current', host: 'leeroy-mbp' } },
    });
    spawnDaemonSession.mockResolvedValue({
      error: 'Request failed: /spawn-session, The socket connection was closed unexpectedly',
    });
    resolveDaemonSpawnSessionByNonce
      .mockResolvedValueOnce({ status: 'unsupported' })
      .mockResolvedValueOnce({ status: 'success', sessionId: 'sess-resumed-attempt' });
    fetchSessionById.mockResolvedValue({
      id: 'sess-resumed-attempt',
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: { path: '/repo/current', host: 'leeroy-mbp' },
    });
    const context = {
      surface: 'cli' as const,
      defaultSessionId: 'sess-1',
      actionRequestId: 'attempt-1',
    };

    await expect(executor.execute('session.spawn_new', {
      path: '/repo/current',
      backendTargetKey: 'agent:codex',
    }, context)).resolves.toMatchObject({ ok: false });
    const resumed = await executor.execute('session.spawn_new', {
      path: '/repo/current',
      backendTargetKey: 'agent:codex',
    }, context);
    expect(resumed).toMatchObject({
      ok: true,
      result: { type: 'success', sessionId: 'sess-resumed-attempt' },
    });

    expect(spawnDaemonSession).toHaveBeenCalledTimes(1);
    expect(resolveDaemonSpawnSessionByNonce).toHaveBeenCalledTimes(2);
    expect(resolveDaemonSpawnSessionByNonce).toHaveBeenCalledWith('session.spawn_new:sess-1:attempt-1');
  });

  it('recovers session.spawn_new via spawn nonce resolution before fallback row scans', async () => {
    const executor = createPlainExecutor({
      rawSession: {
        metadata: {
          machineId: 'machine-1',
          path: '/repo/current',
          host: 'leeroy-mbp',
        },
      },
    });
    spawnDaemonSession.mockResolvedValue({
      error: 'Request failed: /spawn-session, The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()',
    });
    resolveDaemonSpawnSessionByNonce.mockResolvedValue({
      status: 'success',
      sessionId: 'sess-recovered-nonce',
    });
    fetchSessionById.mockResolvedValue({
      id: 'sess-recovered-nonce',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      active: true,
      activeAt: Date.now(),
      pendingCount: 0,
      metadataVersion: 1,
      metadata: {
        path: '/repo/current',
        host: 'leeroy-mbp',
      },
    });
    updateSessionMetadataWithRetry.mockResolvedValue({
      version: 1,
      metadata: {
        machineId: 'machine-1',
        path: '/repo/current',
        host: 'leeroy-mbp',
      },
    });

    const result = await executor.execute(
      'session.spawn_new',
      {
        path: '/repo/current',
        backendTargetKey: 'agent:codex',
      },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toMatchObject({
      ok: true,
      result: {
        type: 'success',
        sessionId: 'sess-recovered-nonce',
        created: true,
      },
    });
    expect(resolveDaemonSpawnSessionByNonce).toHaveBeenCalledTimes(1);
    expect(fetchSessionsPage).not.toHaveBeenCalled();
  });

  it('recovers session.spawn_new when daemon reports child exited before webhook', async () => {
    const executor = createPlainExecutor({
      rawSession: {
        metadata: {
          machineId: 'machine-1',
          path: '/repo/current',
          host: 'leeroy-mbp',
        },
      },
    });
    spawnDaemonSession.mockResolvedValue({
      error: 'Failed to spawn session: Child process exited before session webhook (pid=1234, code=null, signal=SIGKILL)',
      errorCode: 'CHILD_EXITED_BEFORE_WEBHOOK',
    });
    resolveDaemonSpawnSessionByNonce.mockResolvedValue({
      status: 'success',
      sessionId: 'sess-recovered-webhook-exit',
    });
    fetchSessionById.mockResolvedValue({
      id: 'sess-recovered-webhook-exit',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      active: true,
      activeAt: Date.now(),
      pendingCount: 0,
      metadataVersion: 1,
      metadata: {
        path: '/repo/current',
        host: 'leeroy-mbp',
      },
    });
    updateSessionMetadataWithRetry.mockResolvedValue({
      version: 1,
      metadata: {
        machineId: 'machine-1',
        path: '/repo/current',
        host: 'leeroy-mbp',
      },
    });

    const result = await executor.execute(
      'session.spawn_new',
      {
        path: '/repo/current',
        backendTargetKey: 'agent:codex',
      },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toMatchObject({
      ok: true,
      result: {
        type: 'success',
        sessionId: 'sess-recovered-webhook-exit',
        created: true,
      },
    });
    expect(resolveDaemonSpawnSessionByNonce).toHaveBeenCalledTimes(1);
    expect(fetchSessionsPage).not.toHaveBeenCalled();
  });

  it('recovers session.spawn_new when daemon reports a structured webhook timeout as pending', async () => {
    const executor = createPlainExecutor({
      rawSession: {
        metadata: {
          machineId: 'machine-1',
          path: '/repo/current',
          host: 'leeroy-mbp',
        },
      },
    });
    spawnDaemonSession.mockResolvedValue({
      success: false,
      status: 'pending',
      errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
    });
    resolveDaemonSpawnSessionByNonce.mockResolvedValue({
      status: 'success',
      sessionId: 'sess-recovered-pending-timeout',
    });
    fetchSessionById.mockResolvedValue({
      id: 'sess-recovered-pending-timeout',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      active: true,
      activeAt: Date.now(),
      pendingCount: 0,
      metadataVersion: 1,
      metadata: {
        path: '/repo/current',
        host: 'leeroy-mbp',
      },
    });
    updateSessionMetadataWithRetry.mockResolvedValue({
      version: 1,
      metadata: {
        machineId: 'machine-1',
        path: '/repo/current',
        host: 'leeroy-mbp',
      },
    });

    const result = await executor.execute(
      'session.spawn_new',
      {
        path: '/repo/current',
        backendTargetKey: 'agent:codex',
      },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toMatchObject({
      ok: true,
      result: {
        type: 'success',
        sessionId: 'sess-recovered-pending-timeout',
        created: true,
      },
    });
    expect(resolveDaemonSpawnSessionByNonce).toHaveBeenCalledTimes(1);
    expect(fetchSessionsPage).not.toHaveBeenCalled();
  });

  it('keeps one accepted spawn pending beyond three seconds until its session id resolves', async () => {
    const executor = createPlainExecutor({
      rawSession: {
        metadata: {
          machineId: 'machine-1',
          path: '/repo/current',
          host: 'leeroy-mbp',
        },
      },
    });
    spawnDaemonSession.mockResolvedValue({
      success: true,
      status: 'pending',
      spawnNonce: 'spawn-response-nonce',
      sessionIdStatus: 'pending',
    });
    resolveDaemonSpawnSessionByNonce
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({
        status: 'success',
        sessionId: 'sess-recovered-ack-pending',
      });
    fetchSessionById.mockResolvedValue({
      id: 'sess-recovered-ack-pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      active: true,
      activeAt: Date.now(),
      pendingCount: 0,
      metadataVersion: 1,
      metadata: {
        path: '/repo/current',
        host: 'leeroy-mbp',
      },
    });
    updateSessionMetadataWithRetry.mockResolvedValue({
      version: 1,
      metadata: {
        machineId: 'machine-1',
        path: '/repo/current',
        host: 'leeroy-mbp',
      },
    });

    let nowMs = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      nowMs += 1_000;
      return nowMs;
    });
    const result = await executor.execute(
      'session.spawn_new',
      {
        path: '/repo/current',
        backendTargetKey: 'agent:codex',
      },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    ).finally(() => nowSpy.mockRestore());

    expect(result).toMatchObject({
      ok: true,
      result: {
        type: 'success',
        sessionId: 'sess-recovered-ack-pending',
        created: true,
      },
    });
    expect(spawnDaemonSession).toHaveBeenCalledTimes(1);
    expect(resolveDaemonSpawnSessionByNonce).toHaveBeenCalledTimes(5);
    const sentSpawnNonce = spawnDaemonSession.mock.calls[0]?.[0]?.spawnNonce;
    expect(sentSpawnNonce).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/i));
    expect(resolveDaemonSpawnSessionByNonce).toHaveBeenCalledWith(sentSpawnNonce);
    expect(fetchSessionsPage).not.toHaveBeenCalled();
  });

  it.each([
    'Daemon is not running, file is stale',
    'No daemon running, no state file found',
  ])('preserves direct daemon-down spawn failures for %s', async (daemonError) => {
    const executor = createPlainExecutor({
      rawSession: {
        metadata: {
          machineId: 'machine-1',
          path: '/repo/current',
          host: 'leeroy-mbp',
        },
      },
    });
    spawnDaemonSession.mockResolvedValue({
      error: daemonError,
      errorCode: 'unknown_error',
    });

    const result = await executor.execute(
      'session.spawn_new',
      {
        path: '/repo/current',
        backendTargetKey: 'agent:codex',
      },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toEqual({
      ok: false,
      errorCode: 'unknown_error',
      error: daemonError,
    });
    expect(resolveDaemonSpawnSessionByNonce).not.toHaveBeenCalled();
    expect(fetchSessionsPage).not.toHaveBeenCalled();
  });

  it('returns host_not_found when session.spawn_new targets a different host on the CLI surface', async () => {
    const executor = createPlainExecutor({
      rawSession: {
        metadata: {
          machineId: 'machine-1',
          path: '/repo/current',
          host: 'leeroy-mbp',
        },
      },
    });

    const result = await executor.execute(
      'session.spawn_new',
      {
        host: 'other-host',
        initialMessage: 'Hello',
      },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toEqual({
      ok: true,
      result: {
        type: 'error',
        errorCode: 'host_not_found',
        errorMessage: 'host_not_found',
        host: 'other-host',
      },
    });
    expect(spawnDaemonSession).not.toHaveBeenCalled();
  });

  it('executes session.message.send via the existing sendSessionMessage service', async () => {
    const executor = createPlainExecutor();
    sendSessionMessage.mockResolvedValue({ ok: true, sessionId: 'sess-1', localId: 'local-1', waited: false });

    const result = await executor.execute(
      'session.message.send',
      { sessionId: 'sess-1', message: 'Hello', wait: false, timeoutSeconds: 10 },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toEqual({
      ok: true,
      result: { ok: true, sessionId: 'sess-1', localId: 'local-1', waited: false },
    });
    expect(sendSessionMessage).toHaveBeenCalledWith(expect.objectContaining({
      credentials: expect.objectContaining({ token: 'token' }),
      idOrPrefix: 'sess-1',
      message: 'Hello',
      wait: false,
      timeoutMs: 10_000,
    }));
  });

  it('delivers a composer session reference to the referenced session from a session agent (D-21)', async () => {
    // The deterministic half of EU-7's completion gate. A real-model run *choosing* to call the
    // tool is product QA, not this: a model may validly decline. What must be provable is that
    // the id the reference carries is reachable and lands on that session, under the policy the
    // reference block tells the agent about.
    const referencedSessionId = readMentionRefOpaqueForKindV1(
      MENTION_KIND_V1.session,
      buildMentionRefForKindV1(MENTION_KIND_V1.session, 'sess-referenced'),
    );
    expect(referencedSessionId).toBe('sess-referenced');

    const spec = getActionSpec('session.message.send');
    expect(spec.surfaces.session_agent).toBe(true);
    expect(spec.bindings?.mcpToolName).toBe('session_message_send');

    allowSessionAgentActions('session.message.send');
    const executor = createPlainExecutor();
    sendSessionMessage.mockResolvedValue({
      ok: true, sessionId: 'sess-referenced', localId: 'local-9', waited: false,
    });

    const result = await executor.execute(
      'session.message.send',
      { sessionId: referencedSessionId!, message: 'Ping from the referencing session' },
      { surface: 'session_agent', defaultSessionId: 'sess-1' },
    );

    expect(result).toMatchObject({ ok: true });
    expect(sendSessionMessage).toHaveBeenCalledWith(expect.objectContaining({
      idOrPrefix: 'sess-referenced',
      message: 'Ping from the referencing session',
    }));
  });

  it('rejects session.message.send permission overrides above the caller permission', async () => {
    allowSessionAgentActions('session.message.send');
    const executor = createPlainExecutor({
      rawSession: {
        metadata: {
          permissionMode: 'default',
          permissionModeUpdatedAt: 10,
        },
      },
    });

    const result = await executor.execute(
      'session.message.send',
      {
        sessionId: 'sess-2',
        message: 'Escalate',
        permissionModeOverride: 'yolo',
      },
      { surface: 'session_agent', defaultSessionId: 'sess-1' },
    );

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'permission_escalation_denied',
      error: 'permission_escalation_denied',
    });
    expect(sendSessionMessage).not.toHaveBeenCalled();
  });

  it('rejects invalid session.message.send permission overrides before calling the service', async () => {
    allowSessionAgentActions('session.message.send');
    const executor = createPlainExecutor({
      rawSession: {
        metadata: {
          permissionMode: 'safe-yolo',
          permissionModeUpdatedAt: 10,
        },
      },
    });

    const result = await executor.execute(
      'session.message.send',
      {
        sessionId: 'sess-2',
        message: 'Invalid permission override',
        permissionModeOverride: 'not-a-mode',
      },
      { surface: 'session_agent', defaultSessionId: 'sess-1' },
    );

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'invalid_parameters',
    });
    expect(sendSessionMessage).not.toHaveBeenCalled();
  });

  it('rejects session.permission_mode.set above the caller permission', async () => {
    allowSessionAgentActions('session.permission_mode.set');
    const executor = createPlainExecutor({
      rawSession: {
        metadata: {
          permissionMode: 'default',
          permissionModeUpdatedAt: 10,
        },
      },
    });

    const result = await executor.execute(
      'session.permission_mode.set',
      {
        sessionId: 'sess-2',
        permissionMode: 'bypassPermissions',
      },
      { surface: 'session_agent', defaultSessionId: 'sess-1' },
    );

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'permission_escalation_denied',
      details: {
        surface: 'session_agent',
        requestedMode: 'bypassPermissions',
        callerMode: 'default',
      },
    });
    expect(setSessionPermissionMode).not.toHaveBeenCalled();
  });

  it('fails closed for session-agent non-escalation when live caller permission is not supplied', async () => {
    allowSessionAgentActions('session.permission_mode.set');
    const executor = createPlainExecutor({
      sessionId: 'sess-current',
      rawSession: {
        metadata: {
          permissionMode: 'bypassPermissions',
          permissionModeUpdatedAt: 1,
        },
      },
    });
    fetchSessionById.mockResolvedValueOnce({
      id: 'sess-current',
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      pendingCount: 0,
      metadataVersion: 2,
      metadata: {
        permissionMode: 'default',
        permissionModeUpdatedAt: 2,
      },
    });

    const result = await executor.execute(
      'session.permission_mode.set',
      {
        sessionId: 'sess-2',
        permissionMode: 'bypassPermissions',
      },
      { surface: 'session_agent', defaultSessionId: 'sess-current' },
    );

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'permission_escalation_denied',
      details: {
        surface: 'session_agent',
        requestedMode: 'bypassPermissions',
        callerMode: 'default',
      },
    });
    expect(fetchSessionById).not.toHaveBeenCalled();
    expect(setSessionPermissionMode).not.toHaveBeenCalled();
  });

  it('prefers the running session permission mode over stale server metadata for non-escalation', async () => {
    allowSessionAgentActions('session.permission_mode.set');
    const executor = createPlainExecutor({
      sessionId: 'sess-current',
      getCallerPermissionMode: () => 'yolo',
    } as any);
    fetchSessionById.mockResolvedValueOnce({
      id: 'sess-current',
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      pendingCount: 0,
      metadataVersion: 2,
      metadata: {
        permissionMode: 'default',
        permissionModeUpdatedAt: 2,
      },
    });
    setSessionPermissionMode.mockResolvedValueOnce({ ok: true, sessionId: 'sess-2' });

    const result = await executor.execute(
      'session.permission_mode.set',
      {
        sessionId: 'sess-2',
        permissionMode: 'bypassPermissions',
      },
      { surface: 'session_agent', defaultSessionId: 'sess-current' },
    );

    expect(result).toMatchObject({
      ok: true,
      result: {
        ok: true,
        sessionId: 'sess-2',
        permissionMode: 'yolo',
      },
    });
    expect(fetchSessionById).not.toHaveBeenCalled();
    expect(setSessionPermissionMode).toHaveBeenCalledWith(expect.objectContaining({
      idOrPrefix: 'sess-2',
      permissionMode: 'yolo',
    }));
  });

  it('executes session.mode.set via the setSessionMode service', async () => {
    const executor = createPlainExecutor();
    fetchSessionById.mockResolvedValueOnce({
      id: 'sess-2',
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: {
        sessionModesV1: {
          availableModes: [{ id: 'plan', name: 'Plan' }],
        },
      },
    });
    setSessionMode.mockResolvedValue({
      ok: true,
      sessionId: 'sess-2',
      metadata: {},
      version: 1,
    });

    const result = await executor.execute(
      'session.mode.set',
      { sessionId: 'sess-2', modeId: 'plan' },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toMatchObject({
      ok: true,
      result: {
        ok: true,
        sessionId: 'sess-2',
        modeId: 'plan',
      },
    });
    expect((result as any).result.updatedAt).toEqual(expect.any(Number));
    expect(setSessionMode).toHaveBeenCalledWith(expect.objectContaining({
      credentials: expect.objectContaining({ token: 'token' }),
      idOrPrefix: 'sess-2',
      modeId: 'plan',
      updatedAt: expect.any(Number),
    }));
  });

  it('routes approval-required actions through approvalsCreate when configured for the CLI surface', async () => {
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'session.message.send': { enabled: true, disabledSurfaces: [], disabledPlacements: [], approvalRequiredSurfaces: ['cli'] },
      },
    });

    mockAxiosPost.mockResolvedValueOnce({ status: 200, data: { id: 'artifact-1' } });

    const executor = createDataKeyExecutor();
    sendSessionMessage.mockResolvedValueOnce({ ok: true, sessionId: 'sess-1', localId: 'local-1', waited: false });

    const result = await executor.execute(
      'session.message.send',
      { sessionId: 'sess-1', message: 'hello' },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect((result as any).result).toEqual(expect.objectContaining({
      kind: 'approval_request_created',
      artifactId: 'artifact-1',
      actionId: 'session.message.send',
    }));
    expect(sendSessionMessage).not.toHaveBeenCalled();
  });

  it('routes approval-required actions through approvalsCreate when CLI surface is implicit', async () => {
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'session.message.send': { enabled: true, disabledSurfaces: [], disabledPlacements: [], approvalRequiredSurfaces: ['cli'] },
      },
    });

    mockAxiosPost.mockResolvedValueOnce({ status: 200, data: { id: 'artifact-1' } });

    const executor = createDataKeyExecutor();
    sendSessionMessage.mockResolvedValueOnce({ ok: true, sessionId: 'sess-1', localId: 'local-1', waited: false });

    const result = await executor.execute(
      'session.message.send',
      { sessionId: 'sess-1', message: 'hello' },
      { defaultSessionId: 'sess-1' },
    );

    expect((result as any).result).toEqual(expect.objectContaining({
      kind: 'approval_request_created',
      artifactId: 'artifact-1',
      actionId: 'session.message.send',
    }));
    expect(sendSessionMessage).not.toHaveBeenCalled();
  });

  it('rejects delegate run defaults above the caller permission', async () => {
    const sessionId = 'sess-current-aaaaaaaaaaaa';
    fetchSessionById.mockResolvedValue({
      id: sessionId,
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      metadata: {
        permissionMode: 'default',
        permissionModeUpdatedAt: 10,
      },
    });

    const executor = createPlainExecutor({
      sessionId,
      rawSession: {
        metadata: {
          permissionMode: 'default',
          permissionModeUpdatedAt: 10,
        },
      },
    });

    const result = await executor.execute(
      'subagents.delegate.start',
      {
        sessionId,
        backendTargetKeys: ['agent:claude'],
        instructions: 'Review the implementation',
      },
      { surface: 'session_agent', defaultSessionId: sessionId },
    );

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'permission_escalation_denied',
      details: {
        surface: 'session_agent',
        requestedMode: 'workspace_write',
        callerMode: 'default',
      },
    });
    expect(startExecutionRun).not.toHaveBeenCalled();
  });

  it('uses a session-specific data key encryption context when starting execution runs in other sessions', async () => {
    const machineKey = new Uint8Array(32).fill(7);
    const publicKey = deriveBoxPublicKeyFromSeed(machineKey);
    const sessionDek = new Uint8Array(32).fill(9);
    const encryptedDek = sealEncryptedDataKeyEnvelopeV1({
      dataKey: sessionDek,
      recipientPublicKey: publicKey,
      randomBytes: (length) => new Uint8Array(length).fill(3),
    });
    const dataEncryptionKey = encodeBase64(encryptedDek, 'base64');

    fetchSessionById.mockResolvedValue({
      id: 'sess-2-aaaaaaaaaaaa',
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      encryptionMode: 'e2ee',
      dataEncryptionKey,
      metadata: {},
    });

    startExecutionRun.mockResolvedValueOnce({ ok: true, data: { runId: 'run-1' } });

    const executor = createCliActionExecutor({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'dataKey', publicKey, machineKey },
      },
      sessionId: 'sess-1',
      mode: 'plain',
      ctx: { encryptionKey: machineKey, encryptionVariant: 'dataKey' },
    });

    await executor.execute(
      'execution.run.start',
      {
        sessionId: 'sess-2-aaaaaaaaaaaa',
        intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(startExecutionRun).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-2-aaaaaaaaaaaa',
      ctx: expect.objectContaining({
        encryptionVariant: 'dataKey',
        encryptionKey: sessionDek,
      }),
    }));
  });
});
