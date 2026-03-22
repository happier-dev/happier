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
    }));

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

    await client.close();
  });
});
