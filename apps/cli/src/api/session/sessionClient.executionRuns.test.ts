import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
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
  fetchSessionByIdCompatMock: vi.fn(),
  importHistoricalSessionTranscriptMock: vi.fn(),
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

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionByIdCompat: (...args: unknown[]) =>
    sessionSocketStubState.fetchSessionByIdCompatMock(...args),
  importHistoricalSessionTranscript: (...args: unknown[]) =>
    sessionSocketStubState.importHistoricalSessionTranscriptMock(...args),
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
    sessionSocketStubState.fetchSessionByIdCompatMock.mockReset();
    sessionSocketStubState.importHistoricalSessionTranscriptMock.mockReset();
    sessionSocketStubState.importHistoricalSessionTranscriptMock.mockResolvedValue({
      imported: 2,
      cursor: '2',
    });
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
    let resolveAdmission!: (result: Readonly<{ persisted: boolean; delivered: boolean }>) => void;
    const enqueueAgentMessageCommitted = vi.fn(() => new Promise<Readonly<{
      persisted: boolean;
      delivered: boolean;
    }>>((resolve) => {
      resolveAdmission = resolve;
    }));

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
      enqueueUserTextMessageCommitted: vi.fn(async () => ({ persisted: true, delivered: false })),
      enqueueVoiceAgentTranscriptTurnCommitted: vi.fn(async () => ({ persisted: true, delivered: true })),
      enqueueAgentMessageCommitted,
      sendAgentMessageEphemeral: vi.fn(),
      getTranscriptQueryContext: () => ({
        encryptionMode: 'e2ee' as const,
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

    const publication = sessionSocketStubState.executionRunHandlerContext.sendAcp(
      'codex',
      { type: 'message', message: 'durable execution output' },
    );
    let publicationSettled = false;
    void Promise.resolve(publication).then(() => {
      publicationSettled = true;
    });
    await Promise.resolve();

    expect(publicationSettled).toBe(false);
    expect(enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'codex',
      { type: 'message', message: 'durable execution output' },
      expect.objectContaining({
        localId: expect.any(String),
        provenance: { kind: 'non_dependent', source: 'external' },
      }),
    );

    resolveAdmission({ persisted: true, delivered: false });
    await publication;
    expect(publicationSettled).toBe(true);

    enqueueAgentMessageCommitted.mockResolvedValueOnce({ persisted: false, delivered: false });
    await expect(sessionSocketStubState.executionRunHandlerContext.sendAcp(
      'codex',
      { type: 'message', message: 'closed outbox output' },
    )).rejects.toThrow('durable custody');
  });

  it('routes the runtime transcript.import RPC through one historical batch request', async () => {
    const rpcHandlerManager = new RpcHandlerManager({
      scopePrefix: 's1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'dataKey',
      encryptionMode: 'plain',
      logger: () => undefined,
    });
    const items = [
      { id: 'history-1', content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'first' } } } },
      { id: 'history-2', content: { t: 'encrypted', c: 'ciphertext' } },
    ] as const;

    registerSessionClientRuntimeHandlers({
      rpcHandlerManager,
      token: 'token-1',
      metadataPath: '/tmp/project',
      metadata: createTestMetadata({ path: '/tmp/project' }),
      sessionId: 's1',
      getSessionMetadata: () => createTestMetadata({ path: '/tmp/project' }),
      enqueueSessionUserMessage: vi.fn(),
      enqueueUserTextMessageCommitted: vi.fn(async () => ({ persisted: true, delivered: false })),
      enqueueVoiceAgentTranscriptTurnCommitted: vi.fn(async () => ({ persisted: true, delivered: true })),
      enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: true, delivered: false })),
      sendAgentMessageEphemeral: vi.fn(),
      getTranscriptQueryContext: () => ({ encryptionMode: 'plain' as const }),
      persistVoiceAgentRunMetadataFromPublicRun: vi.fn(),
      socketEmitExecutionRunUpdated: vi.fn(),
    });

    await expect(rpcHandlerManager.invokeLocal(RPC_METHODS.TRANSCRIPT_IMPORT, {
      sessionId: 's1',
      items,
    })).resolves.toMatchObject({ ok: true, imported: 2, cursor: '2' });
    expect(sessionSocketStubState.importHistoricalSessionTranscriptMock).toHaveBeenCalledTimes(1);
    expect(sessionSocketStubState.importHistoricalSessionTranscriptMock).toHaveBeenCalledWith({
      token: 'token-1',
      sessionId: 's1',
      items: [
        expect.objectContaining({ id: 'history-1', content: items[0].content }),
        expect.objectContaining({ id: 'history-2', content: items[1].content }),
      ],
    });
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
      enqueueUserTextMessageCommitted: vi.fn(async () => ({ persisted: true, delivered: false })),
      enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: true, delivered: false })),
      enqueueVoiceAgentTranscriptTurnCommitted: vi.fn(async () => ({ persisted: true, delivered: true })),
      sendAgentMessageEphemeral: vi.fn(),
      getTranscriptQueryContext: () => ({
        encryptionMode: 'e2ee' as const,
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
      enqueueUserTextMessageCommitted: vi.fn(async () => ({ persisted: true, delivered: false })),
      enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: true, delivered: false })),
      enqueueVoiceAgentTranscriptTurnCommitted: vi.fn(async () => ({ persisted: true, delivered: true })),
      sendAgentMessageEphemeral: vi.fn(),
      getTranscriptQueryContext: () => ({
        encryptionMode: 'e2ee' as const,
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
      enqueueUserTextMessageCommitted: vi.fn(async () => ({ persisted: true, delivered: false })),
      enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: true, delivered: false })),
      enqueueVoiceAgentTranscriptTurnCommitted: vi.fn(async () => ({ persisted: true, delivered: true })),
      sendAgentMessageEphemeral: vi.fn(),
      getTranscriptQueryContext: () => ({
        encryptionMode: 'e2ee' as const,
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
        agentId: 'codex',
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

  it('preserves an installed external Agent runtime descriptor as the execution-run parent provider', async () => {
    const metadata = createTestMetadata({
      path: '/tmp/project',
      flavor: undefined,
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'acme.agent',
        agent: {},
      },
    });
    const client = new ApiSessionClient(
      'tok',
      createPlainSessionFixture({ id: 's1', metadata }),
    );

    expect(sessionSocketStubState.executionRunHandlerContext?.parentProvider).toBe('acme.agent');

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
      ctx: null,
    }));
    expect(sessionSocketStubState.executionRunServiceMocks.listExecutionRuns).toHaveBeenCalledWith(expect.objectContaining({
      token: 'tok',
      sessionId: 's1',
      mode: 'plain',
      request: { status: 'running' },
      ctx: null,
    }));
    expect(sessionSocketStubState.executionRunServiceMocks.getExecutionRun).toHaveBeenCalledWith(expect.objectContaining({
      token: 'tok',
      sessionId: 's1',
      mode: 'plain',
      request: { runId: 'run_1' },
      ctx: null,
    }));
    expect(sessionSocketStubState.executionRunServiceMocks.sendExecutionRunMessage).toHaveBeenCalledWith(expect.objectContaining({
      token: 'tok',
      sessionId: 's1',
      mode: 'plain',
      request: { runId: 'run_1', message: 'hello' },
      ctx: null,
    }));
    expect(sessionSocketStubState.executionRunServiceMocks.stopExecutionRun).toHaveBeenCalledWith(expect.objectContaining({
      token: 'tok',
      sessionId: 's1',
      mode: 'plain',
      request: { runId: 'run_1' },
      ctx: null,
    }));
    expect(sessionSocketStubState.executionRunServiceMocks.executeExecutionRunAction).toHaveBeenCalledWith(expect.objectContaining({
      token: 'tok',
      sessionId: 's1',
      mode: 'plain',
      request: { runId: 'run_1', actionId: 'review.apply' },
      ctx: null,
    }));
    expect(sessionSocketStubState.executionRunServiceMocks.waitForExecutionRun).toHaveBeenCalledWith(expect.objectContaining({
      token: 'tok',
      sessionId: 's1',
      mode: 'plain',
      runId: 'run_1',
      timeoutMs: 2_000,
      pollIntervalMs: 10,
      ctx: null,
    }));
    expect(sessionSocketStubState.executionRunServiceMocks.waitForExecutionRun).toHaveBeenCalledWith(expect.objectContaining({
      token: 'tok',
      sessionId: 's1',
      mode: 'plain',
      runId: 'run_2',
      timeoutMs: null,
      pollIntervalMs: 10,
      ctx: null,
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
    sessionSocketStubState.fetchSessionByIdCompatMock.mockResolvedValue({
      ...session,
      metadataLayoutVersion: 0,
      metadata: JSON.stringify(session.metadata ?? {}),
      agentState: null,
      encryptionMode: 'plain',
      dataEncryptionKey: null,
    });

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

    const client = new ApiSessionClient('tok', session, {
      credentials: { token: 'tok', encryption: null },
    });
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

  it('rejects a durable voice transcript pair whose role metadata does not describe one canonical turn', async () => {
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1', metadata: createTestMetadata({ path: '/tmp/project' }) }));
    const transcriptWriter = sessionSocketStubState.executionRunHandlerContext.transcriptWriter as
      | {
          commitVoiceAgentTranscriptTurn: (turn: Readonly<{
            turnId: string;
            user: Readonly<{ text: string; meta: Record<string, unknown> }>;
            assistant: Readonly<{ text: string; meta: Record<string, unknown> }>;
          }>) => Promise<Readonly<{ persisted: boolean; delivered: boolean }>>;
        }
      | undefined;

    await expect(transcriptWriter?.commitVoiceAgentTranscriptTurn({
      turnId: 'stream-1',
      user: {
        text: 'hello',
        meta: {
          happier: {
            kind: 'voice_agent_turn.v1',
            payload: {
              v: 1,
              epoch: 7,
              role: 'assistant',
              voiceAgentId: 'va_1',
              runId: 'run-1',
              streamId: 'stream-1',
              ts: 123,
            },
          },
        },
      },
      assistant: {
        text: 'world',
        meta: {
          happier: {
            kind: 'voice_agent_turn.v1',
            payload: {
              v: 1,
              epoch: 7,
              role: 'assistant',
              voiceAgentId: 'va_1',
              runId: 'run-1',
              streamId: 'stream-1',
              ts: 456,
            },
          },
        },
      },
    })).rejects.toThrow('one canonical user/assistant turn');
    expect(sessionSocketStubState.sessionSocketStub.emitWithAck).not.toHaveBeenCalledWith(
      'message',
      expect.anything(),
    );

    await client.close();
  });
});
