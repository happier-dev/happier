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
  fetchSessionById,
  fetchSessionsPage,
  updateSessionMetadataWithRetry,
  sendSessionMessage,
  requestSessionStop,
  setSessionTitle,
  setSessionMode,
  getExecutionRun,
  listExecutionRuns,
  sendExecutionRunMessage,
  startExecutionRun,
  stopExecutionRun,
  executeExecutionRunAction,
} = vi.hoisted(() => ({
  spawnDaemonSession: vi.fn(),
  fetchSessionById: vi.fn(),
  fetchSessionsPage: vi.fn(),
  updateSessionMetadataWithRetry: vi.fn(),
  sendSessionMessage: vi.fn(),
  requestSessionStop: vi.fn(),
  setSessionTitle: vi.fn(),
  setSessionMode: vi.fn(),
  getExecutionRun: vi.fn(),
  listExecutionRuns: vi.fn(),
  sendExecutionRunMessage: vi.fn(),
  startExecutionRun: vi.fn(),
  stopExecutionRun: vi.fn(),
  executeExecutionRunAction: vi.fn(),
}));

vi.mock('@/daemon/controlClient', () => ({
  spawnDaemonSession,
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

const { callSessionRpc } = vi.hoisted(() => ({
  callSessionRpc: vi.fn(),
}));

vi.mock('@/session/transport/rpc/sessionRpc', () => ({
  callSessionRpc,
}));

import { createCliActionExecutor } from './createCliActionExecutor';
import { deriveBoxPublicKeyFromSeed, encodeBase64, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';

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

describe('createCliActionExecutor', () => {
  beforeEach(() => {
    spawnDaemonSession.mockReset();
    fetchSessionById.mockReset();
    fetchSessionsPage.mockReset();
    updateSessionMetadataWithRetry.mockReset();
    sendSessionMessage.mockReset();
    requestSessionStop.mockReset();
    setSessionTitle.mockReset();
    setSessionMode.mockReset();
    getExecutionRun.mockReset();
    listExecutionRuns.mockReset();
    sendExecutionRunMessage.mockReset();
    startExecutionRun.mockReset();
    stopExecutionRun.mockReset();
    executeExecutionRunAction.mockReset();
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

  it('spawns a new session from the current session context on the CLI surface', async () => {
    const executor = createPlainExecutor({
      rawSession: {
        metadata: {
          machineId: 'machine-1',
          path: '/repo/current',
          host: 'leeroy-mbp',
        },
      },
    });
    spawnDaemonSession.mockResolvedValue({ success: true, sessionId: 'sess-new' });
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
      initialPrompt: 'Hello from CLI action',
    }));
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
