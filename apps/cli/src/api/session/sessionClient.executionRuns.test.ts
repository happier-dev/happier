import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';

const sessionSocketStubState = vi.hoisted(() => ({
  sessionSocketStub: null as any,
  userSocketStub: null as any,
  executionRunHandlerContext: null as any,
  createExecutionRunBackendMock: vi.fn(),
  executionRunServiceMocks: {
    startExecutionRun: vi.fn(),
    listExecutionRuns: vi.fn(),
    getExecutionRun: vi.fn(),
    sendExecutionRunMessage: vi.fn(),
    stopExecutionRun: vi.fn(),
    executeExecutionRunAction: vi.fn(),
    waitForExecutionRun: vi.fn(),
  },
}));

vi.mock('./sockets', () => ({
  createUserScopedSocket: () => {
    if (!sessionSocketStubState.userSocketStub) {
      throw new Error('Missing user socket stub');
    }
    return sessionSocketStubState.userSocketStub as any;
  },
}));

vi.mock('./connection/createSessionSocketTransport', () => ({
  createSessionSocketTransport: () => {
    if (!sessionSocketStubState.sessionSocketStub) {
      throw new Error('Missing session socket stub');
    }
    return {
      socket: sessionSocketStubState.sessionSocketStub as any,
      transport: {
        connect: async () => {},
        disconnect: async () => {},
        destroy: async () => {},
        isConnected: () => sessionSocketStubState.sessionSocketStub?.connected === true,
        onConnected: () => () => {},
        onDisconnected: () => () => {},
        onError: () => () => {},
      },
    };
  },
}));

vi.mock('@happier-dev/connection-supervisor', () => ({
  DEFAULT_MANAGED_CONNECTION_POLICY: {},
  createManagedConnectionSupervisor: (params: { createTransport: () => unknown; onConnected?: () => Promise<void> | void }) => ({
    start: async () => {
      params.createTransport();
      await params.onConnected?.();
    },
    stop: async () => {},
  }),
}));

vi.mock('@/rpc/handlers/executionRuns', () => ({
  registerExecutionRunHandlers: (_rpc: unknown, ctx: unknown) => {
    sessionSocketStubState.executionRunHandlerContext = ctx;
    return { dispose: async () => {} };
  },
}));

vi.mock('@/agent/executionRuns/runtime/createExecutionRunBackend', () => ({
  createExecutionRunBackend: (...args: unknown[]) => sessionSocketStubState.createExecutionRunBackendMock(...args),
}));

vi.mock('@/session/services/executionRuns', () => ({
  startExecutionRun: (...args: unknown[]) => sessionSocketStubState.executionRunServiceMocks.startExecutionRun(...args),
  listExecutionRuns: (...args: unknown[]) => sessionSocketStubState.executionRunServiceMocks.listExecutionRuns(...args),
  getExecutionRun: (...args: unknown[]) => sessionSocketStubState.executionRunServiceMocks.getExecutionRun(...args),
  sendExecutionRunMessage: (...args: unknown[]) => sessionSocketStubState.executionRunServiceMocks.sendExecutionRunMessage(...args),
  stopExecutionRun: (...args: unknown[]) => sessionSocketStubState.executionRunServiceMocks.stopExecutionRun(...args),
  executeExecutionRunAction: (...args: unknown[]) => sessionSocketStubState.executionRunServiceMocks.executeExecutionRunAction(...args),
  waitForExecutionRun: (...args: unknown[]) => sessionSocketStubState.executionRunServiceMocks.waitForExecutionRun(...args),
}));

vi.mock('@/settings/accountSettings/activeAccountSettingsSnapshot', () => ({
  getActiveAccountSettingsSnapshot: () => null,
}));

describe('ApiSessionClient execution-run backend wiring', () => {
  beforeEach(async () => {
    vi.resetModules();
    const { createApiSessionSocketStub } = await import('@/testkit/backends/apiSessionSocketHarness');
    sessionSocketStubState.sessionSocketStub = createApiSessionSocketStub({ id: 'session-socket', connected: true });
    sessionSocketStubState.userSocketStub = createApiSessionSocketStub({ id: 'user-socket', connected: false });
    sessionSocketStubState.executionRunHandlerContext = null;
    sessionSocketStubState.createExecutionRunBackendMock.mockReset();
    sessionSocketStubState.createExecutionRunBackendMock.mockReturnValue({
      startSession: vi.fn(),
      sendPrompt: vi.fn(),
      cancel: vi.fn(),
      onMessage: vi.fn(),
      offMessage: vi.fn(),
      dispose: vi.fn(),
    });
    for (const mock of Object.values(sessionSocketStubState.executionRunServiceMocks)) {
      mock.mockReset();
      mock.mockResolvedValue({ ok: true, data: {} });
    }
  });

  afterEach(() => {
    sessionSocketStubState.executionRunHandlerContext = null;
  });

  it('forwards handler-resolved account settings into the execution-run backend factory', async () => {
    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1', metadata: createTestMetadata({ path: '/tmp/project' }) }));

    expect(sessionSocketStubState.executionRunHandlerContext).toBeTruthy();
    const createBackend = sessionSocketStubState.executionRunHandlerContext.createBackend as (args: Record<string, unknown>) => unknown;
    const accountSettings = { backendEnabledByTargetKey: { 'acpBackend:review-bot': false } };

    createBackend({
      backendId: 'customAcp',
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      permissionMode: 'read_only',
      accountSettings,
    });

    expect(sessionSocketStubState.createExecutionRunBackendMock).toHaveBeenCalledWith(expect.objectContaining({
      backendId: 'customAcp',
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      permissionMode: 'read_only',
      accountSettings,
      interactivePermissionHandler: expect.objectContaining({
        handleToolCall: expect.any(Function),
        cancelPendingRequest: expect.any(Function),
      }),
    }));

    await client.close();
  });

  it('sends the canonical permission notification for an interactive execution-run request', async () => {
    const { ApiClient } = await import('../api');
    const api = await ApiClient.create({
      token: 'tok',
      encryption: { type: 'legacy', secret: new Uint8Array(32) },
    });
    const sendToAllDevicesAsync = vi.spyOn(api.push(), 'sendToAllDevicesAsync').mockResolvedValue();
    const client = api.sessionSyncClient(
      createPlainSessionFixture({ id: 's1', metadata: createTestMetadata({ path: '/tmp/project' }) }),
    );
    const agentState = { requests: {}, completedRequests: {} } as Record<string, any>;
    vi.spyOn(client, 'getAgentStateSnapshot').mockImplementation(() => agentState as any);
    vi.spyOn(client, 'updateAgentState').mockImplementation(async (updater) => {
      Object.assign(agentState, updater(agentState as any));
    });

    sessionSocketStubState.executionRunHandlerContext.createBackend({
      runId: 'run-1',
      backendId: 'opencode',
      backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
      permissionMode: 'default',
    });
    const backendArgs = sessionSocketStubState.createExecutionRunBackendMock.mock.calls.at(-1)?.[0];
    const pending = backendArgs.interactivePermissionHandler.handleToolCall(
      'execution-run:run-1:occurrence-1:permission-1',
      'bash',
      { command: 'echo hi' },
    );

    await vi.waitFor(() => expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1));
    expect(sendToAllDevicesAsync).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('asks permission to use bash'),
      expect.objectContaining({
        sessionId: 's1',
        requestId: 'execution-run:run-1:occurrence-1:permission-1',
      }),
    );

    await client.rpcHandlerManager.invokeLocal('permission', {
      id: 'execution-run:run-1:occurrence-1:permission-1',
      approved: false,
      decision: 'denied',
    });
    await expect(pending).resolves.toEqual({ decision: 'denied' });
    await client.close();
  });

  it('uses the provider runtime working directory for execution-run backends after resume', async () => {
    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1', metadata: createTestMetadata({ path: '/tmp/original' }) }));

    client.setRuntimeWorkingDirectory('/tmp/resumed-opencode');

    expect(sessionSocketStubState.executionRunHandlerContext.resolveCwd()).toBe('/tmp/resumed-opencode');
    sessionSocketStubState.executionRunHandlerContext.createBackend({
      backendId: 'opencode',
      backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
      permissionMode: 'read_only',
    });
    expect(sessionSocketStubState.createExecutionRunBackendMock).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/tmp/resumed-opencode',
    }));

    await client.close();
  });

  it('routes execution-run completion through the canonical Session user-message ingress', async () => {
    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1', metadata: createTestMetadata({ path: '/tmp/project' }) }));
    const enqueue = vi.spyOn(client, 'enqueueSessionUserMessage').mockResolvedValue(undefined);
    const input = { text: 'run finished', meta: { source: 'execution_run' } };

    await sessionSocketStubState.executionRunHandlerContext.enqueueParentSessionInput(input);

    expect(enqueue).toHaveBeenCalledWith({
      ...input,
      requestedAction: { v: 1, kind: 'steer_if_active' },
      inputOrigin: 'session_generated',
    });
    await client.close();
  });

  it('exposes shared execution-run service helpers with the current session transport context', async () => {
    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1', metadata: createTestMetadata({ path: '/tmp/project' }) }));

    await client.executionRuns.start({ intent: 'review' });
    await client.executionRuns.list({ status: 'running' });
    await client.executionRuns.get({ runId: 'run_1' });
    await client.executionRuns.send({ runId: 'run_1', message: 'hello' });
    await client.executionRuns.stop({ runId: 'run_1' });
    await client.executionRuns.action({ runId: 'run_1', actionId: 'review.apply' });
    expect(typeof (client.executionRuns as any).wait).toBe('function');
    await (client.executionRuns as any).wait({ runId: 'run_1', timeoutSeconds: 2 });
    await (client.executionRuns as any).wait({ runId: 'run_2' });

    expect(sessionSocketStubState.executionRunServiceMocks.startExecutionRun).toHaveBeenCalledWith(expect.objectContaining({
      token: 'tok',
      sessionId: 's1',
      mode: 'plain',
      request: { intent: 'review' },
      ctx: expect.objectContaining({
        encryptionVariant: 'dataKey',
        encryptionKey: expect.any(Uint8Array),
      }),
    }));
    expect(sessionSocketStubState.executionRunServiceMocks.listExecutionRuns).toHaveBeenCalledWith(expect.objectContaining({
      token: 'tok',
      sessionId: 's1',
      mode: 'plain',
      request: { status: 'running' },
      ctx: expect.objectContaining({
        encryptionVariant: 'dataKey',
        encryptionKey: expect.any(Uint8Array),
      }),
    }));
    expect(sessionSocketStubState.executionRunServiceMocks.getExecutionRun).toHaveBeenCalledWith(expect.objectContaining({
      token: 'tok',
      sessionId: 's1',
      mode: 'plain',
      request: { runId: 'run_1' },
      ctx: expect.objectContaining({
        encryptionVariant: 'dataKey',
        encryptionKey: expect.any(Uint8Array),
      }),
    }));
    expect(sessionSocketStubState.executionRunServiceMocks.sendExecutionRunMessage).toHaveBeenCalledWith(expect.objectContaining({
      token: 'tok',
      sessionId: 's1',
      mode: 'plain',
      request: { runId: 'run_1', message: 'hello' },
      ctx: expect.objectContaining({
        encryptionVariant: 'dataKey',
        encryptionKey: expect.any(Uint8Array),
      }),
    }));
    expect(sessionSocketStubState.executionRunServiceMocks.stopExecutionRun).toHaveBeenCalledWith(expect.objectContaining({
      token: 'tok',
      sessionId: 's1',
      mode: 'plain',
      request: { runId: 'run_1' },
      ctx: expect.objectContaining({
        encryptionVariant: 'dataKey',
        encryptionKey: expect.any(Uint8Array),
      }),
    }));
    expect(sessionSocketStubState.executionRunServiceMocks.executeExecutionRunAction).toHaveBeenCalledWith(expect.objectContaining({
      token: 'tok',
      sessionId: 's1',
      mode: 'plain',
      request: { runId: 'run_1', actionId: 'review.apply' },
      ctx: expect.objectContaining({
        encryptionVariant: 'dataKey',
        encryptionKey: expect.any(Uint8Array),
      }),
    }));
    expect(sessionSocketStubState.executionRunServiceMocks.waitForExecutionRun).toHaveBeenCalledWith(expect.objectContaining({
      token: 'tok',
      sessionId: 's1',
      mode: 'plain',
      runId: 'run_1',
      timeoutMs: 2_000,
      ctx: expect.objectContaining({
        encryptionVariant: 'dataKey',
        encryptionKey: expect.any(Uint8Array),
      }),
    }));
    expect(sessionSocketStubState.executionRunServiceMocks.waitForExecutionRun).toHaveBeenCalledWith(expect.objectContaining({
      token: 'tok',
      sessionId: 's1',
      mode: 'plain',
      runId: 'run_2',
      timeoutMs: null,
      ctx: expect.objectContaining({
        encryptionVariant: 'dataKey',
        encryptionKey: expect.any(Uint8Array),
      }),
    }));

    await client.close();
  });
});
