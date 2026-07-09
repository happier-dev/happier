import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { buildConfiguredAcpBackendSessionMetadata } from '@/agent/acp/catalog/configured/sessionMetadata';
import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { VOICE_AGENT_RUN_TRANSCRIPT_CONTRACT_VERSION } from './voiceAgentRunMetadataV1';
import { registerSessionClientRuntimeHandlers } from './client/executionRuns/registerSessionClientRuntimeHandlers';
import { ApiSessionClient } from './sessionClient';

const sessionSocketStubState = vi.hoisted(() => ({
  sessionSocketStub: null as any,
  userSocketStub: null as any,
  executionRunHandlerContext: null as any,
  createExecutionRunRuntimeMock: vi.fn(),
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
  },
}));

vi.mock('@/agent/runtime/bridges/executionRun/runtime/create', () => ({
  createExecutionRunRuntime: (...args: unknown[]) => sessionSocketStubState.createExecutionRunRuntimeMock(...args),
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
    sessionSocketStubState.createExecutionRunRuntimeMock.mockReset();
    sessionSocketStubState.createExecutionRunRuntimeMock.mockReturnValue({
      readResumeSupport: vi.fn(async () => false),
      provisionSession: vi.fn(async () => ({ sessionId: 'run-session-1' })),
      sendPrompt: vi.fn(),
      cancel: vi.fn(),
      subscribeMessages: vi.fn(() => () => {}),
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

  it('exposes the canonical permission request store provider to execution-run handlers', async () => {
    let requestStore: unknown = null;

    registerSessionClientRuntimeHandlers({
      rpcHandlerManager: new RpcHandlerManager({
        scopePrefix: 's1',
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'dataKey',
        encryptionMode: 'plain',
        logger: () => undefined,
      }),
      token: 'token-1',
      metadataPath: '/tmp/project',
      metadata: createTestMetadata({ path: '/tmp/project' }),
      sessionId: 's1',
      getSessionMetadata: () => createTestMetadata({ path: '/tmp/project' }),
      enqueueSessionUserMessage: vi.fn(),
      sendUserTextMessage: vi.fn(),
      sendAgentMessage: vi.fn(),
      sendUserTextMessageCommitted: vi.fn(async () => {}),
      sendAgentMessageCommitted: vi.fn(async () => {}),
      sendAgentMessageEphemeral: vi.fn(),
      getTranscriptQueryContext: () => ({
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'dataKey',
      }),
      getAgentStateRequestStore: () => requestStore as never,
      persistVoiceAgentRunMetadataFromPublicRun: vi.fn(),
      socketEmitExecutionRunUpdated: vi.fn(),
    });

    expect(sessionSocketStubState.executionRunHandlerContext).toBeTruthy();
    const getPermissionRequestStore =
      sessionSocketStubState.executionRunHandlerContext.getPermissionRequestStore as () => unknown;
    expect(getPermissionRequestStore()).toBeNull();

    requestStore = {
      publishRequest: vi.fn(),
      registerResponseTargetHandler: vi.fn(),
    };

    expect(getPermissionRequestStore()).toBe(requestStore);
  });

  it('passes simulator preview routes into execution-run handlers when the session runtime owns them', async () => {
    const simulatorPreview = {
      getSnapshot: vi.fn(async () => ({
        v: 1 as const,
        machineId: 'machine_1',
        generatedAt: 2_000,
        refreshState: 'idle' as const,
        resources: [],
        diagnostics: [],
      })),
      dispatchAction: vi.fn(),
    };

    registerSessionClientRuntimeHandlers({
      rpcHandlerManager: new RpcHandlerManager({
        scopePrefix: 's1',
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'dataKey',
        encryptionMode: 'plain',
        logger: () => undefined,
      }),
      token: 'token-1',
      metadataPath: '/tmp/project',
      metadata: createTestMetadata({ path: '/tmp/project' }),
      sessionId: 's1',
      getSessionMetadata: () => createTestMetadata({ path: '/tmp/project' }),
      enqueueSessionUserMessage: vi.fn(),
      sendUserTextMessage: vi.fn(),
      sendAgentMessage: vi.fn(),
      sendUserTextMessageCommitted: vi.fn(async () => {}),
      sendAgentMessageCommitted: vi.fn(async () => {}),
      sendAgentMessageEphemeral: vi.fn(),
      getTranscriptQueryContext: () => ({
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'dataKey',
      }),
      getSimulatorPreviewRoutes: () => simulatorPreview,
      persistVoiceAgentRunMetadataFromPublicRun: vi.fn(),
      socketEmitExecutionRunUpdated: vi.fn(),
    });

    expect(sessionSocketStubState.executionRunHandlerContext?.simulatorPreview).toBe(simulatorPreview);
  });

  it('passes local-service runtime-action routes into execution-run handlers when the session runtime owns them', async () => {
    const localServices = {
      inventoryRoutes: {
        getSnapshot: vi.fn(),
        refreshSnapshot: vi.fn(),
      },
      launcherRoutes: {
        getSnapshot: vi.fn(),
      },
      previewRoutes: {
        getSnapshot: vi.fn(),
      },
      actionRoutes: {
        execute: vi.fn(),
      },
    };

    registerSessionClientRuntimeHandlers({
      rpcHandlerManager: new RpcHandlerManager({
        scopePrefix: 's1',
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'dataKey',
        encryptionMode: 'plain',
        logger: () => undefined,
      }),
      token: 'token-1',
      metadataPath: '/tmp/project',
      metadata: createTestMetadata({ path: '/tmp/project' }),
      sessionId: 's1',
      getSessionMetadata: () => createTestMetadata({ path: '/tmp/project' }),
      enqueueSessionUserMessage: vi.fn(),
      sendUserTextMessage: vi.fn(),
      sendAgentMessage: vi.fn(),
      sendUserTextMessageCommitted: vi.fn(async () => {}),
      sendAgentMessageCommitted: vi.fn(async () => {}),
      sendAgentMessageEphemeral: vi.fn(),
      getTranscriptQueryContext: () => ({
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'dataKey',
      }),
      getLocalServicesRuntimeActionRoutes: () => localServices,
      persistVoiceAgentRunMetadataFromPublicRun: vi.fn(),
      socketEmitExecutionRunUpdated: vi.fn(),
    });

    expect(sessionSocketStubState.executionRunHandlerContext?.localServices).toBe(localServices);
  });

  it('passes browser recording routes and composer attach callback into execution-run handlers', async () => {
    const browserRecording = {
      startRecording: vi.fn(),
      stopRecording: vi.fn(),
      cancelRecording: vi.fn(),
      getRecordingStatus: vi.fn(),
      listRecordingsForView: vi.fn(),
      cleanupExpiredRecordings: vi.fn(),
    };
    const attachBrowserRecordingToComposer = vi.fn();
    const params = {
      rpcHandlerManager: new RpcHandlerManager({
        scopePrefix: 's1',
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'dataKey',
        encryptionMode: 'plain' as const,
        logger: () => undefined,
      }),
      token: 'token-1',
      metadataPath: '/tmp/project',
      metadata: createTestMetadata({ path: '/tmp/project' }),
      sessionId: 's1',
      getSessionMetadata: () => createTestMetadata({ path: '/tmp/project' }),
      enqueueSessionUserMessage: vi.fn(),
      sendUserTextMessage: vi.fn(),
      sendAgentMessage: vi.fn(),
      sendUserTextMessageCommitted: vi.fn(async () => {}),
      sendAgentMessageCommitted: vi.fn(async () => {}),
      sendAgentMessageEphemeral: vi.fn(),
      getTranscriptQueryContext: () => ({
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'dataKey' as const,
      }),
      getBrowserRecordingRoutes: () => browserRecording,
      attachBrowserRecordingToComposer,
      persistVoiceAgentRunMetadataFromPublicRun: vi.fn(),
      socketEmitExecutionRunUpdated: vi.fn(),
    };

    registerSessionClientRuntimeHandlers(params);

    expect(sessionSocketStubState.executionRunHandlerContext?.browserRecording).toBe(browserRecording);
    expect(sessionSocketStubState.executionRunHandlerContext?.attachBrowserRecordingToComposer).toBe(attachBrowserRecordingToComposer);
  });

  it('derives the execution-run parent provider from runtimeDescriptorV1 when flavor is absent', async () => {
    const metadata = createTestMetadata({
      path: '/tmp/project',
      flavor: undefined,
      runtimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: {
          backendMode: 'appServer',
        },
      },
    });
    const client = new ApiSessionClient(
      'tok',
      createPlainSessionFixture({ id: 's1', metadata }),
    );

    expect(sessionSocketStubState.executionRunHandlerContext?.parentProvider).toBe('codex');

    await client.close();
  });

  it('derives the execution-run parent provider from configured ACP backend metadata', async () => {
    const metadata = createTestMetadata({
      path: '/tmp/project',
      flavor: 'acp:acme.plugin-backed-acp.backend',
      ...buildConfiguredAcpBackendSessionMetadata({
        backendId: 'acme.plugin-backed-acp.backend',
        title: 'Plugin backed ACP',
      }),
    });
    const client = new ApiSessionClient(
      'tok',
      createPlainSessionFixture({ id: 's1', metadata }),
    );

    expect(sessionSocketStubState.executionRunHandlerContext?.parentProvider).toBe('acme.plugin-backed-acp.backend');

    await client.close();
  });

  it('exposes shared execution-run service helpers with the current session transport context', async () => {
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1', metadata: createTestMetadata({ path: '/tmp/project' }) }));

    await client.executionRuns.start({ intent: 'review' });
    await client.executionRuns.list({ status: 'running' });
    await client.executionRuns.get({ runId: 'run_1' });
    await client.executionRuns.send({ runId: 'run_1', message: 'hello' });
    await client.executionRuns.stop({ runId: 'run_1' });
    await client.executionRuns.action({ runId: 'run_1', actionId: 'review.apply' });
    const wait = client.executionRuns.wait;
    expect(wait).toBeDefined();
    if (!wait) throw new Error('Expected executionRuns.wait to be defined');
    await wait({ runId: 'run_1', timeoutSeconds: 2, pollIntervalMs: 10 });
    await wait({ runId: 'run_2', pollIntervalMs: 10 });

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
      pollIntervalMs: 10,
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
      pollIntervalMs: 10,
      ctx: expect.objectContaining({
        encryptionVariant: 'dataKey',
        encryptionKey: expect.any(Uint8Array),
      }),
    }));

    await client.close();
  });

  it('passes constructor-provided simulator preview routes into the execution-run registrar', async () => {
    const simulatorPreview = {
      getSnapshot: vi.fn(async () => ({
        v: 1 as const,
        machineId: 'machine_1',
        generatedAt: 2_000,
        refreshState: 'idle' as const,
        resources: [],
        diagnostics: [],
      })),
      dispatchAction: vi.fn(),
    };
    const client = new ApiSessionClient(
      'tok',
      createPlainSessionFixture({ id: 's1', metadata: createTestMetadata({ path: '/tmp/project' }) }),
      { getSimulatorPreviewRoutes: () => simulatorPreview },
    );

    expect(sessionSocketStubState.executionRunHandlerContext?.simulatorPreview).toBe(simulatorPreview);

    await client.close();
  });

  it('passes constructor-provided local-service runtime-action routes into the execution-run registrar', async () => {
    const localServices = {
      inventoryRoutes: {
        getSnapshot: vi.fn(),
        refreshSnapshot: vi.fn(),
      },
      launcherRoutes: {
        getSnapshot: vi.fn(),
      },
      previewRoutes: {
        getSnapshot: vi.fn(),
      },
      actionRoutes: {
        execute: vi.fn(),
      },
    };
    const client = new ApiSessionClient(
      'tok',
      createPlainSessionFixture({ id: 's1', metadata: createTestMetadata({ path: '/tmp/project' }) }),
      { getLocalServicesRuntimeActionRoutes: () => localServices },
    );

    expect(sessionSocketStubState.executionRunHandlerContext?.localServices).toBe(localServices);

    await client.close();
  });

  it('persists voiceAgentRunV1 metadata when the execution-run public state updates', async () => {
    const session = createPlainSessionFixture({
      id: 's1',
      metadata: createTestMetadata({ path: '/tmp/project' }),
    });
    let persistedMetadata = session.metadata;
    let persistedMetadataVersion = session.metadataVersion;

    sessionSocketStubState.sessionSocketStub = (await import('@/testkit/backends/apiSessionSocketHarness')).createApiSessionSocketStub({
      id: 'session-socket',
      connected: true,
      emitWithAck: async (event, payload) => {
        if (event !== 'update-metadata') {
          return { result: 'success', version: persistedMetadataVersion, metadata: JSON.stringify(persistedMetadata) };
        }
        const nextMetadata = JSON.parse(String((payload as { metadata?: string }).metadata ?? 'null'));
        persistedMetadata = nextMetadata;
        persistedMetadataVersion += 1;
        return {
          result: 'success' as const,
          version: persistedMetadataVersion,
          metadata: JSON.stringify(nextMetadata),
        };
      },
    });

    const client = new ApiSessionClient('tok', session);
    const callback = sessionSocketStubState.executionRunHandlerContext.onExecutionRunPublicStateUpdated as
      | ((run: Record<string, unknown>) => void)
      | undefined;

    expect(callback).toBeTypeOf('function');
    callback?.({
      runId: 'run_voice_1',
      callId: 'call_1',
      sidechainId: 'side_1',
      intent: 'voice_agent',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
      status: 'running',
      startedAtMs: 100,
      transcript: { persistenceMode: 'persistent', epoch: 11 },
      resumeHandle: {
        kind: 'provider_session.v1',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        providerSessionId: 'vs_1',
      },
    });

    await vi.waitFor(() => {
      expect(persistedMetadata).toMatchObject({
        voiceAgentRunV1: {
          v: 1,
          runId: 'run_voice_1',
          backendId: 'claude',
          transcriptContractVersion: VOICE_AGENT_RUN_TRANSCRIPT_CONTRACT_VERSION,
          resumeHandle: {
            kind: 'provider_session.v1',
            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
            providerSessionId: 'vs_1',
          },
        },
      });
    });

    expect(sessionSocketStubState.sessionSocketStub.emitWithAck).toHaveBeenCalledWith(
      'update-metadata',
      expect.objectContaining({
        sid: 's1',
        expectedVersion: 0,
      }),
    );

    await client.close();
  });

  it('uses deterministic localIds for committed persistent voice transcript rows', async () => {
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1', metadata: createTestMetadata({ path: '/tmp/project' }) }));

    const transcriptWriter = sessionSocketStubState.executionRunHandlerContext.transcriptWriter as
      | {
          appendUserTextCommitted?: (text: string, meta: Record<string, unknown>) => Promise<void>;
          appendAssistantTextCommitted?: (text: string, meta: Record<string, unknown>) => Promise<void>;
        }
      | undefined;

    expect(transcriptWriter?.appendUserTextCommitted).toBeTypeOf('function');
    expect(transcriptWriter?.appendAssistantTextCommitted).toBeTypeOf('function');

    await transcriptWriter?.appendUserTextCommitted?.('hello', {
      happier: {
        kind: 'voice_agent_turn.v1',
        payload: {
          v: 1,
          epoch: 7,
          role: 'user',
          voiceAgentId: 'va_1',
          ts: 123,
        },
      },
    });

    await transcriptWriter?.appendAssistantTextCommitted?.('world', {
      happier: {
        kind: 'voice_agent_turn.v1',
        payload: {
          v: 1,
          epoch: 7,
          role: 'assistant',
          voiceAgentId: 'va_1',
          ts: 456,
        },
      },
    });

    const messageCalls = sessionSocketStubState.sessionSocketStub.emitWithAck.mock.calls
      .filter((call: unknown[]) => call[0] === 'message')
      .map((call: unknown[]) => call[1] as { localId?: unknown });

    expect(messageCalls).toHaveLength(2);
    expect(messageCalls[0]?.localId).toBe('voice-turn:va_1:7:user:123');
    expect(messageCalls[1]?.localId).toBe('voice-turn:va_1:7:assistant:456');

    await client.close();
  });
});
