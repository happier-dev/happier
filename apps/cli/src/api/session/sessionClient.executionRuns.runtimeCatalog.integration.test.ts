import { createTestApiSessionClient } from '@/testkit/backends/createTestApiSessionClient';
// The socket-stub factory is stateless and every mock below is reset per test,
// so the registry never needed clearing. Calling vi.resetModules() in beforeEach
// re-instantiated this file's module graph twenty times and exhausted an 8 GiB
// heap before a single result was reported.
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { buildConfiguredAcpBackendSessionMetadata } from '@/agent/acp/catalog/configured/sessionMetadata';
import { createMutableApiSessionClientFixture, createPlainSessionFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { VOICE_AGENT_RUN_TRANSCRIPT_CONTRACT_VERSION } from './voiceAgentRunMetadataV1';
import { registerSessionClientRuntimeHandlers } from './client/executionRuns/registerSessionClientRuntimeHandlers';
import { ApiSessionClient } from './sessionClient';
import { createExecutionRunRpcActionExecutor } from '@/rpc/handlers/executionRuns/dispatchExecutionRunRpcAction';
import { resolveExecutionRunPolicy } from '@/agent/executionRuns/policy/executionRunPolicy';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol';
import { SessionMetadataOwnerMigrationPatchV1Schema, projectSessionOwnerCompatibilityViewV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { randomUUID } from 'node:crypto';

// One runtime, one lifetime: the signal must stay stable across calls so
// subscribers do not accumulate against a fresh controller each read.
const TEST_RUNTIME_LIFETIME_SIGNAL = new AbortController().signal;
const TEST_SESSION_SERVER_BINDING = Object.freeze({
  serverId: 'test-home',
  serverUrl: 'https://test-home.example.test',
});

const sessionSocketStubState = vi.hoisted(() => ({
  sessionSocketStub: null as any,
  userSocketStub: null as any,
  executionRunHandlerContext: null as any,
  createExecutionRunRuntimeMock: vi.fn(),
  fetchSessionByIdCompatMock: vi.fn(),
  patchSessionMetadataEnvelopeTupleMock: vi.fn<typeof import('@/session/transport/http/sessionsHttp').patchSessionMetadataEnvelopeTuple>(),
  fetchSessionByIdMock: vi.fn(),
  importHistoricalSessionTranscriptMock: vi.fn(),
  fetchSessionsPageMock: vi.fn(),
  fetchSessionsQueryPageMock: vi.fn(),
  bootstrapAccountSettingsContextMock: vi.fn(),
  fetchAccountEncryptionCurrentnessMock: vi.fn(),
  resolveRunnerMcpServersMock: vi.fn(),
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

vi.mock('@/mcp/runtime/resolveRunnerMcpServers', () => ({
  resolveRunnerMcpServers: (...args: unknown[]) =>
    sessionSocketStubState.resolveRunnerMcpServersMock(...args),
}));

// Only the HTTP fetchers are substituted; the module's pure readers stay real, and
// the Session-listing service beneath them runs its real admission so this suite
// cannot certify an answer the product would refuse.
vi.mock('@/session/transport/http/sessionsHttp', async (importActual) => ({
  ...await importActual<typeof import('@/session/transport/http/sessionsHttp')>(),
  fetchSessionById: (...args: unknown[]) =>
    sessionSocketStubState.fetchSessionByIdMock(...args),
  fetchSessionByIdCompat: (...args: unknown[]) =>
    sessionSocketStubState.fetchSessionByIdCompatMock(...args),
  patchSessionMetadataEnvelopeTuple: (...args: Parameters<typeof import('@/session/transport/http/sessionsHttp').patchSessionMetadataEnvelopeTuple>) =>
    sessionSocketStubState.patchSessionMetadataEnvelopeTupleMock(...args),
  importHistoricalSessionTranscript: (...args: unknown[]) =>
    sessionSocketStubState.importHistoricalSessionTranscriptMock(...args),
  fetchSessionsPage: (...args: unknown[]) =>
    sessionSocketStubState.fetchSessionsPageMock(...args),
  fetchSessionsQueryPage: (...args: unknown[]) =>
    sessionSocketStubState.fetchSessionsQueryPageMock(...args),
}));

// The two remaining network reads `listSessions` composes beside the page, mocked
// exactly as its own canonical suite mocks them (`listSessions.test.ts:20,24`).
vi.mock('@/settings/accountSettings/bootstrapAccountSettingsContext', async (importActual) => ({
  ...await importActual<typeof import('@/settings/accountSettings/bootstrapAccountSettingsContext')>(),
  bootstrapAccountSettingsContext: (...args: unknown[]) =>
    sessionSocketStubState.bootstrapAccountSettingsContextMock(...args),
}));

vi.mock('@/api/client/connectedServiceCredentialApi', async (importActual) => ({
  ...await importActual<typeof import('@/api/client/connectedServiceCredentialApi')>(),
  fetchAccountEncryptionCurrentness: (...args: unknown[]) =>
    sessionSocketStubState.fetchAccountEncryptionCurrentnessMock(...args),
}));

vi.mock('@/settings/accountSettings/activeAccountSettingsSnapshot', () => ({
  getActiveAccountSettingsSnapshot: () => null,
}));

describe('ApiSessionClient execution-run backend wiring', () => {
  it('keeps an idle worker waiter attached when its real retained source is installed later', async () => {
    const [{ ExecutionRunHostBridge }, registry] = await Promise.all([
      import('@/agent/runtime/bridges/executionRun/ExecutionRunHostBridge'), import('@/daemon/executionRunRegistry'),
    ]);
    const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's1', metadata: createTestMetadata({ path: '/tmp/project' }) }));
    const runId = randomUUID();
    const abort = new AbortController();
    let settled = false;
    const waiting = client.waitForExecutionRunWorkerUpdateChange(abort.signal).then((changed) => {
      settled = true;
      return changed;
    });
    const retained = {
      sessionId: 's1', localId: `worker-update:${runId}`, update: {
        v: 1 as const, workerKind: 'execution_run' as const, workerId: runId, ownerState: 'succeeded' as const,
        wake: 'finished' as const, headline: 'Worker finished', result: 'Actual retained result', canInspect: true,
      },
    };
    try {
      await Promise.resolve();
      expect(settled).toBe(false);
      await registry.retainExecutionRunWorkerUpdate(retained);
      await registry.writeExecutionRunMarker({
        pid: process.pid, happySessionId: 's1', runId, callId: 'call-1', sidechainId: 'side-1',
        intent: 'agent', backendTarget: { kind: 'backend', backendId: 'codex' }, retentionPolicy: 'resumable',
        runClass: 'bounded', ioMode: 'request_response', status: 'succeeded', startedAtMs: 1, updatedAtMs: 2, finishedAtMs: 2,
      });
      const bridge = new ExecutionRunHostBridge({ parentProvider: 'codex', cwd: '/tmp/project', sendAcp: async () => {} });
      client.setExecutionRunWorkerUpdateSource(bridge);
      expect(await waiting).toBe(true);
      expect((await client.takeExecutionRunWorkerUpdate(abort.signal))?.update.result).toBe('Actual retained result');
    } finally {
      abort.abort();
      await registry.acknowledgeExecutionRunWorkerUpdate(retained);
      await registry.removeExecutionRunMarker(runId);
      await client.close();
    }
  });

  function createJwtWithSub(sub: string): string {
    return `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.`;
  }

  beforeEach(async () => {
    sessionSocketStubState.sessionSocketStub = createApiSessionSocketStub({ id: 'session-socket', connected: true });
    sessionSocketStubState.userSocketStub = createApiSessionSocketStub({ id: 'user-socket', connected: false });
    sessionSocketStubState.executionRunHandlerContext = null;
    sessionSocketStubState.createExecutionRunRuntimeMock.mockReset();
    sessionSocketStubState.fetchSessionByIdCompatMock.mockReset();
    sessionSocketStubState.patchSessionMetadataEnvelopeTupleMock.mockReset();
    sessionSocketStubState.fetchSessionByIdMock.mockReset();
    sessionSocketStubState.importHistoricalSessionTranscriptMock.mockReset();
    sessionSocketStubState.fetchSessionsPageMock.mockReset();
    sessionSocketStubState.fetchSessionsQueryPageMock.mockReset();
    sessionSocketStubState.bootstrapAccountSettingsContextMock.mockReset();
    sessionSocketStubState.bootstrapAccountSettingsContextMock.mockResolvedValue({ settings: null });
    sessionSocketStubState.fetchAccountEncryptionCurrentnessMock.mockReset();
    sessionSocketStubState.fetchAccountEncryptionCurrentnessMock.mockResolvedValue({
      mode: 'plain',
      version: 1,
      signingKeyFingerprint: null,
      contentKeyFingerprint: null,
    });
    sessionSocketStubState.resolveRunnerMcpServersMock.mockReset();
    sessionSocketStubState.resolveRunnerMcpServersMock.mockResolvedValue({
      happierMcpServer: {
        supportedSessionReadActions: [],
        stop: vi.fn(),
      },
      mcpServers: {},
    });
    sessionSocketStubState.importHistoricalSessionTranscriptMock.mockResolvedValue({
      imported: 2,
      cursor: '2',
    });
    sessionSocketStubState.createExecutionRunRuntimeMock.mockReturnValue({
      readResumeSupport: vi.fn(async () => false),
      provisionRuntime: vi.fn(async () => ({ runtimeId: 'run-session-1' })),
      deliverInput: vi.fn(async () => ({ status: 'admitted' as const })),
      getRuntimeLifetimeSignal: vi.fn(() => TEST_RUNTIME_LIFETIME_SIGNAL),
      cancel: vi.fn(),
      subscribeMessages: vi.fn(() => () => {}),
      dispose: vi.fn(),
    });
    for (const mock of Object.values(sessionSocketStubState.executionRunServiceMocks)) {
      mock.mockReset();
      mock.mockResolvedValue({ ok: true, data: {} });
    }
  });

  it('opens only the resolved Run Team choice and never infers custody from pending parent intent', async () => {
    const prepareRunTeamCredentialProviderBinding = vi.fn(async () => ({
      providerBinding: {
        source: { kind: 'team_resource' as const, resourceId: 'resource-1', resourceRevision: 3 },
        model: { id: 'model-1', name: 'Model 1' },
        upstream: { protocol: 'openai-responses' as const, normalizedUrl: 'http://127.0.0.1:43123/v1', credential: 'apiKey' as const },
        materialization: { v: 1 as const, kind: 'spawnEnv' as const },
      },
      environmentOverlay: [], additionalRedactionValues: [], cleanup: vi.fn(),
    }));
    const metadata = createTestMetadata({ path: '/tmp/project' }) as Record<string, unknown>;
    metadata.modelSelectionIntentV2 = {
      v: 2, updatedAt: 7,
      ref: {
        source: 'team_resource', resourceId: 'pending-resource', teamId: 'team-1',
        expectedResourceRevision: 3, deliveryMode: 'brokered', agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'model-1',
      },
    };
    const session = createMutableApiSessionClientFixture({ sessionId: 's1', metadata });

    registerSessionClientRuntimeHandlers({
      ...TEST_SESSION_SERVER_BINDING,
      readOwnerAccountCredentials: async () => null,
      rpcHandlerManager: session.rpcHandlerManager,
      token: 'token-1', metadataPath: '/tmp/project', metadata, sessionId: 's1', session: session as never,
      getSessionMetadata: () => metadata as never,
      sessionRuntimeControls: { prepareRunTeamCredentialProviderBinding },
      enqueueSessionUserMessage: vi.fn(),
      enqueueUserTextMessageCommitted: vi.fn(async () => ({ persisted: true, delivered: false })),
      enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: true, delivered: false })),
      enqueueVoiceAgentTranscriptTurnCommitted: vi.fn(async () => ({ persisted: true, delivered: true })),
      sendAgentMessageEphemeral: vi.fn(), getTranscriptQueryContext: () => ({ encryptionMode: 'plain' }),
      persistVoiceAgentRunMetadataFromPublicRun: vi.fn(), socketEmitExecutionRunUpdated: vi.fn(),
    });

    const selection = {
      kind: 'team_credential_provider_model' as const, teamId: 'team-1', resourceId: 'resource-1',
      expectedResourceRevision: 3, deliveryMode: 'brokered' as const,
      agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'model-1',
    };
    await expect(sessionSocketStubState.executionRunHandlerContext.sessionInteractionHost
      .prepareRunTeamCredentialProviderBinding({ runId: 'run-native-reset', agentId: 'codex' }))
      .resolves.toBeNull();
    expect(prepareRunTeamCredentialProviderBinding).not.toHaveBeenCalled();
    await expect(sessionSocketStubState.executionRunHandlerContext.sessionInteractionHost
      .prepareRunTeamCredentialProviderBinding({ runId: 'run-1', agentId: 'codex', selection }))
      .resolves.toMatchObject({ providerBinding: { source: { resourceId: 'resource-1' } } });
    expect(prepareRunTeamCredentialProviderBinding).toHaveBeenCalledWith({
      runId: 'run-1', agentId: 'codex', resourceId: 'resource-1', modelId: 'model-1', selection,
    });
    metadata.modelSelectionIntentV2 = {
      v: 2, updatedAt: 8,
      ref: {
        source: 'account_provider_connection', agentTargetKey: 'agent:happier.agent.codex/codex',
        providerConnectionId: 'pc-1', modelId: 'model-1',
      },
    };
    await expect(sessionSocketStubState.executionRunHandlerContext.sessionInteractionHost
      .prepareRunTeamCredentialProviderBinding({ runId: 'run-2', agentId: 'codex' }))
      .resolves.toBeNull();
    expect(prepareRunTeamCredentialProviderBinding).toHaveBeenCalledOnce();
  });

  it('composes Session-owned Run Actions from restricted runtime authority and its reviewed policy', async () => {
    // The token subject is read through the one canonical account-id reader, which trims it,
    // so a whitespace-padded `sub` still admits the exact Runner principal.
    const runtimeAccountId = 'restricted-runner-account';
    const runtimeToken = createJwtWithSub(` ${runtimeAccountId} `);
    const actionsSettingsProvider = Object.freeze({
      getActionsSettings: () => normalizeActionsSettingsV1({
        v: 1 as const,
        actions: {
          'session.activity.get': { approvalRequiredSurfaces: ['agent'] as const },
        },
      }),
    });
    const metadata = createTestMetadata({
      path: '/tmp/runner-project',
      machineId: 'runner-machine-1',
    });
    const rpcHandlerManager = new RpcHandlerManager({
      scopePrefix: 'runner-session-1',
      encryptionMode: 'plain',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'dataKey',
      logger: () => undefined,
    });
    const session = {
      sessionId: 'runner-session-1',
      rpcHandlerManager,
      getMetadataSnapshot: () => metadata,
      updateMetadata: vi.fn(),
      confirmSessionAction: vi.fn(),
    };

    registerSessionClientRuntimeHandlers({
      ...TEST_SESSION_SERVER_BINDING,
      readOwnerAccountCredentials: async () => null,
      runtimePrincipalAccountId: runtimeAccountId,
      actionsSettingsProvider,
      rpcHandlerManager,
      token: runtimeToken,
      metadataPath: '/tmp/runner-project',
      metadata,
      sessionId: 'runner-session-1',
      session: session as never,
      getSessionMetadata: () => metadata as never,
      enqueueSessionUserMessage: vi.fn(),
      enqueueUserTextMessageCommitted: vi.fn(async () => ({ persisted: true, delivered: false })),
      enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: true, delivered: false })),
      enqueueVoiceAgentTranscriptTurnCommitted: vi.fn(async () => ({ persisted: true, delivered: true })),
      sendAgentMessageEphemeral: vi.fn(),
      getTranscriptQueryContext: () => ({ encryptionMode: 'plain' as const }),
      persistVoiceAgentRunMetadataFromPublicRun: vi.fn(),
      socketEmitExecutionRunUpdated: vi.fn(),
    });

    const runSignal = new AbortController().signal;
    await expect(sessionSocketStubState.executionRunHandlerContext.sessionInteractionHost
      .composeRunToolBinding({
        runId: 'run-1',
        cwd: '/tmp/runner-project/run-1',
        signal: runSignal,
        isCurrent: () => true,
        getPermissionMode: () => 'safe-yolo',
        readActiveTurnAdmissionWitness: () => null,
        readCurrentRunOccurrence: () => null,
      }))
      .resolves.toMatchObject({ supportedSessionReadActions: [] });

    expect(sessionSocketStubState.resolveRunnerMcpServersMock).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: { token: runtimeToken, encryption: null },
        accountCredentials: null,
        sessionList: expect.any(Function),
        accountSettings: null,
        actionsSettingsProvider,
        machineId: 'runner-machine-1',
        directory: '/tmp/runner-project',
        executionRun: expect.objectContaining({
          runId: 'run-1',
          cwd: '/tmp/runner-project/run-1',
          signal: runSignal,
        }),
      }),
    );
    expect(sessionSocketStubState.executionRunHandlerContext.runtimeAccountId).toBe(runtimeAccountId);
  });

  it('composes Session-owned Run listing from the exact Home owner credentials', async () => {
    const runtimeToken = createJwtWithSub('runtime-owner-account');
    let ownerCredentials: { token: string; encryption: null } | null = {
      token: runtimeToken,
      encryption: null,
    };
    let observedServerUrl: string | null = null;
    sessionSocketStubState.fetchSessionByIdMock.mockImplementation(async () => {
      observedServerUrl = resolveServerHttpBaseUrl();
      return createSessionRecordFixture({
        id: 's1',
        active: true,
        encryptionMode: 'plain',
        metadata: '{}',
      });
    });
    registerSessionClientRuntimeHandlers({
      readOwnerAccountCredentials: async () => ownerCredentials,
      serverId: 'home-qualified-a',
      serverUrl: 'https://home-a.example.test',
      rpcHandlerManager: new RpcHandlerManager({
        scopePrefix: 's1',
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'dataKey',
        encryptionMode: 'plain',
        logger: () => undefined,
      }),
      token: runtimeToken,
      metadataPath: '/tmp/project',
      metadata: createTestMetadata({ path: '/tmp/project' }),
      sessionId: 's1',
      getSessionMetadata: () => createTestMetadata({ path: '/tmp/project' }),
      enqueueSessionUserMessage: vi.fn(),
      enqueueUserTextMessageCommitted: vi.fn(async () => ({ persisted: true, delivered: false })),
      enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: true, delivered: false })),
      enqueueVoiceAgentTranscriptTurnCommitted: vi.fn(async () => ({ persisted: true, delivered: true })),
      sendAgentMessageEphemeral: vi.fn(),
      getTranscriptQueryContext: () => ({ encryptionMode: 'plain' as const }),
      persistVoiceAgentRunMetadataFromPublicRun: vi.fn(),
      socketEmitExecutionRunUpdated: vi.fn(),
    });
    const executor = createExecutionRunRpcActionExecutor({
      manager: {
        get: vi.fn(),
        getRunningCount: vi.fn(() => 0),
        getDepthByCallId: vi.fn(() => null),
        listPublicForRequest: vi.fn(() => []),
      } as never,
      context: sessionSocketStubState.executionRunHandlerContext,
      policy: resolveExecutionRunPolicy({
        defaults: {
          maxConcurrentRuns: null,
          boundedTimeoutMs: null,
          reviewBoundedTimeoutMs: null,
          maxTurns: null,
        },
      }),
      isExecutionRunsEnabled: () => true,
    });
    // A Session-bound principal holds one admitted row, so only the arms that row
    // proves by itself are answerable. This one is.
    const supportedQuery = {
      v: 1,
      storage: 'active',
      includeInactive: false,
      attention: 'any',
      scope: 'all_accessible',
      audiences: [],
      tagIds: [],
      limit: 17,
    } as const;

    await expect(executor.execute('session.list', { query: supportedQuery, view: 'summary' }, {
      surface: 'agent',
      authority: 'account_automation',
      defaultSessionId: 's1',
      sessionListAccess: 'current_session',
      runtimeAccountId: 'runtime-owner-account',
      bypassApprovals: true,
    })).resolves.toMatchObject({
      ok: true,
      result: {
        sessions: [expect.objectContaining({ id: 's1' })],
        nextCursor: null,
        hasNext: false,
        attentionNextCursor: null,
        attentionHasNext: false,
        queryVersion: 1,
      },
    });
    // The admitted corpus is read exactly, on the exact Home's credentials and base
    // URL — never by paging that Home's Account corpus.
    expect(sessionSocketStubState.fetchSessionsQueryPageMock).not.toHaveBeenCalled();
    expect(sessionSocketStubState.fetchSessionsPageMock).not.toHaveBeenCalled();
    expect(sessionSocketStubState.fetchSessionByIdMock).toHaveBeenCalledWith(expect.objectContaining({
      token: runtimeToken,
      sessionId: 's1',
    }));
    expect(sessionSocketStubState.executionRunHandlerContext.serverId).toBe('home-qualified-a');
    expect(sessionSocketStubState.executionRunHandlerContext.resolveAccountSettingsSnapshot).toEqual(expect.any(Function));
    expect(observedServerUrl).toBe('https://home-a.example.test');

    // Scope, audiences and tags are the Home's meaning. One admitted row cannot
    // re-derive them, so the caller gets the typed unsupported-arms answer instead
    // of a silently narrowed page.
    await expect(executor.execute('session.list', {
      query: {
        ...supportedQuery,
        scope: 'assigned_to_me',
        audiences: [{ kind: 'team', teamId: 'team-sensitive-selector' }],
        tagIds: ['tag-sensitive-selector'],
      },
      view: 'summary',
    }, {
      surface: 'agent',
      authority: 'account_automation',
      defaultSessionId: 's1',
      sessionListAccess: 'current_session',
      runtimeAccountId: 'runtime-owner-account',
      bypassApprovals: true,
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'unsupported_action',
      details: { unsupportedQueryArms: ['scope', 'audiences', 'tagIds'] },
    });

    const requestsBeforeDeniedCases = sessionSocketStubState.fetchSessionByIdMock.mock.calls.length;
    for (const deniedContext of [
      {
        defaultSessionId: 's1',
        runtimeAccountId: 'spoofed-message-author',
      },
      {
        defaultSessionId: 'owner-private-session',
        runtimeAccountId: 'runtime-owner-account',
      },
    ]) {
      await expect(executor.execute('session.list', {}, {
        surface: 'agent', authority: 'account_automation',
        sessionListAccess: 'current_session', bypassApprovals: true,
        ...deniedContext,
      })).resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    }
    const detachedExecutor = createExecutionRunRpcActionExecutor({
      manager: {
        get: vi.fn(), getRunningCount: vi.fn(() => 0), getDepthByCallId: vi.fn(() => null),
        listPublicForRequest: vi.fn(() => []),
      } as never,
      context: { ...sessionSocketStubState.executionRunHandlerContext, sessionId: null },
      policy: resolveExecutionRunPolicy({ defaults: {
        maxConcurrentRuns: null, boundedTimeoutMs: null, reviewBoundedTimeoutMs: null,
        maxTurns: null,
      } }),
      isExecutionRunsEnabled: () => true,
    });
    await expect(detachedExecutor.execute('session.list', {}, {
      surface: 'agent', authority: 'account_automation', defaultSessionId: 's1',
      sessionListAccess: 'current_session', runtimeAccountId: 'runtime-owner-account',
      bypassApprovals: true,
    })).resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    expect(sessionSocketStubState.fetchSessionByIdMock).toHaveBeenCalledTimes(requestsBeforeDeniedCases);

    ownerCredentials = {
      token: createJwtWithSub('different-account'),
      encryption: null,
    };
    await expect(executor.execute('session.list', {}, {
      surface: 'agent',
      authority: 'account_automation',
      defaultSessionId: 's1',
      sessionListAccess: 'current_session',
      runtimeAccountId: 'runtime-owner-account',
      bypassApprovals: true,
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'not_authenticated',
    });
    expect(sessionSocketStubState.fetchSessionByIdMock).toHaveBeenCalledTimes(requestsBeforeDeniedCases);

    ownerCredentials = null;
    await expect(executor.execute('session.list', {}, {
      surface: 'agent',
      authority: 'account_automation',
      defaultSessionId: 's1',
      sessionListAccess: 'current_session',
      runtimeAccountId: 'runtime-owner-account',
      bypassApprovals: true,
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'not_authenticated',
    });
    expect(sessionSocketStubState.fetchSessionByIdMock).toHaveBeenCalledTimes(requestsBeforeDeniedCases);
  });

  it('uses the admitted restricted runtime principal for only its current Session list', async () => {
    const runtimeToken = createJwtWithSub('runtime-runner-account');
    sessionSocketStubState.fetchSessionByIdMock.mockResolvedValue(createSessionRecordFixture({
      id: 'runner-session',
      encryptionMode: 'plain',
      metadata: '{}',
      active: true,
      activeAt: 1,
    }));
    registerSessionClientRuntimeHandlers({
      ...TEST_SESSION_SERVER_BINDING,
      readOwnerAccountCredentials: async () => null,
      runtimePrincipalAccountId: 'runtime-runner-account',
      serverId: 'runner-home-b',
      serverUrl: 'https://runner-home-b.example.test',
      rpcHandlerManager: new RpcHandlerManager({
        scopePrefix: 'runner-session',
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'dataKey',
        encryptionMode: 'plain',
        logger: () => undefined,
      }),
      token: runtimeToken,
      metadataPath: '/tmp/runner-project',
      metadata: createTestMetadata({ path: '/tmp/runner-project' }),
      sessionId: 'runner-session',
      getSessionMetadata: () => createTestMetadata({ path: '/tmp/runner-project' }),
      enqueueSessionUserMessage: vi.fn(),
      enqueueUserTextMessageCommitted: vi.fn(async () => ({ persisted: true, delivered: false })),
      enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: true, delivered: false })),
      enqueueVoiceAgentTranscriptTurnCommitted: vi.fn(async () => ({ persisted: true, delivered: true })),
      sendAgentMessageEphemeral: vi.fn(),
      getTranscriptQueryContext: () => ({ encryptionMode: 'plain' as const }),
      persistVoiceAgentRunMetadataFromPublicRun: vi.fn(),
      socketEmitExecutionRunUpdated: vi.fn(),
    });
    const executor = createExecutionRunRpcActionExecutor({
      manager: {
        get: vi.fn(), getRunningCount: vi.fn(() => 0), getDepthByCallId: vi.fn(() => null),
        listPublicForRequest: vi.fn(() => []),
      } as never,
      context: sessionSocketStubState.executionRunHandlerContext,
      policy: resolveExecutionRunPolicy({ defaults: {
        maxConcurrentRuns: null, boundedTimeoutMs: null, reviewBoundedTimeoutMs: null,
        maxTurns: null,
      } }),
      isExecutionRunsEnabled: () => true,
    });

    await expect(executor.execute('session.list', {}, {
      surface: 'agent', authority: 'account_automation', bypassApprovals: true,
      defaultSessionId: 'runner-session', sessionListAccess: 'current_session',
      runtimeAccountId: 'runtime-runner-account',
    })).resolves.toMatchObject({
      ok: true,
      result: { sessions: [expect.objectContaining({ id: 'runner-session' })] },
    });
    expect(sessionSocketStubState.fetchSessionByIdMock).toHaveBeenCalledWith({
      token: runtimeToken,
      sessionId: 'runner-session',
      serverUrl: 'https://runner-home-b.example.test',
    });
    expect(sessionSocketStubState.fetchSessionsPageMock).not.toHaveBeenCalled();
    expect(sessionSocketStubState.fetchSessionsQueryPageMock).not.toHaveBeenCalled();
    expect(sessionSocketStubState.executionRunHandlerContext.serverId).toBe('runner-home-b');

    // One detail row cannot prove assignment: the restricted reader reports the
    // shared typed unsupported result instead of a silently empty page.
    await expect(executor.execute('session.list', {
      query: {
        v: 1,
        storage: 'active',
        includeInactive: true,
        scope: 'assigned_to_me',
        attention: 'any',
        audiences: [],
        tagIds: [],
      },
    }, {
      surface: 'agent', authority: 'account_automation', bypassApprovals: true,
      defaultSessionId: 'runner-session', sessionListAccess: 'current_session',
      runtimeAccountId: 'runtime-runner-account',
    })).resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });

    await expect(executor.execute('session.list', {
      query: {
        v: 1,
        storage: 'active',
        includeInactive: true,
        scope: 'all_accessible',
        attention: 'any',
        audiences: [],
        tagIds: [],
      },
    }, {
      surface: 'agent', authority: 'account_automation', bypassApprovals: true,
      defaultSessionId: 'runner-session', sessionListAccess: 'current_session',
      runtimeAccountId: 'runtime-runner-account',
    })).resolves.toMatchObject({
      ok: true,
      result: {
        sessions: [expect.objectContaining({ id: 'runner-session' })],
        nextCursor: null,
        hasNext: false,
        attentionNextCursor: null,
        attentionHasNext: false,
        queryVersion: 1,
      },
    });

    const callsBeforeLegacyCursor = sessionSocketStubState.fetchSessionByIdMock.mock.calls.length;
    await expect(executor.execute('session.list', {
      cursor: 'legacy-next-page',
      includeRows: true,
    }, {
      surface: 'agent', authority: 'account_automation', bypassApprovals: true,
      defaultSessionId: 'runner-session', sessionListAccess: 'current_session',
      runtimeAccountId: 'runtime-runner-account',
    })).resolves.toMatchObject({
      ok: true,
      result: {
        sessions: [],
        rows: [],
        nextCursor: null,
        hasNext: false,
      },
    });
    expect(sessionSocketStubState.fetchSessionByIdMock).toHaveBeenCalledTimes(callsBeforeLegacyCursor);
    expect(sessionSocketStubState.fetchSessionsPageMock).not.toHaveBeenCalled();
    expect(sessionSocketStubState.fetchSessionsQueryPageMock).not.toHaveBeenCalled();

    const callsBeforeAwarenessCursor = sessionSocketStubState.fetchSessionByIdMock.mock.calls.length;
    await expect(executor.execute('session.list', {
      view: 'awareness',
      cursor: 'legacy-next-page',
    }, {
      surface: 'agent', authority: 'account_automation', bypassApprovals: true,
      defaultSessionId: 'runner-session', sessionListAccess: 'current_session',
      runtimeAccountId: 'runtime-runner-account',
    })).resolves.toMatchObject({
      ok: true,
      result: {
        view: 'awareness',
        projectionVersion: 1,
        sessions: [],
        nextCursor: null,
        hasNext: false,
      },
    });
    expect(sessionSocketStubState.fetchSessionByIdMock).toHaveBeenCalledTimes(callsBeforeAwarenessCursor);
    expect(sessionSocketStubState.fetchSessionsPageMock).not.toHaveBeenCalled();
    expect(sessionSocketStubState.fetchSessionsQueryPageMock).not.toHaveBeenCalled();

    const callsAfterAllowed = sessionSocketStubState.fetchSessionByIdMock.mock.calls.length;
    await expect(executor.execute('session.list', {}, {
      surface: 'agent', authority: 'account_automation', bypassApprovals: true,
      defaultSessionId: 'runner-session', sessionListAccess: 'current_session',
      runtimeAccountId: 'another-account',
    })).resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    expect(sessionSocketStubState.fetchSessionByIdMock).toHaveBeenCalledTimes(callsAfterAllowed);
  });

  it('denies a Session-owned Run list without the admitted runtime principal and exact Session corpus', async () => {
    const runtimeToken = createJwtWithSub('runtime-owner-account');
    registerSessionClientRuntimeHandlers({
      readOwnerAccountCredentials: async () => null,
      runtimePrincipalAccountId: 'different-runtime-account',
      serverId: 'home-qualified-a',
      serverUrl: 'https://home-a.example.test',
      rpcHandlerManager: new RpcHandlerManager({
        scopePrefix: 's1',
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'dataKey',
        encryptionMode: 'plain',
        logger: () => undefined,
      }),
      token: runtimeToken,
      metadataPath: '/tmp/project',
      metadata: createTestMetadata({ path: '/tmp/project' }),
      sessionId: 's1',
      getSessionMetadata: () => createTestMetadata({ path: '/tmp/project' }),
      enqueueSessionUserMessage: vi.fn(),
      enqueueUserTextMessageCommitted: vi.fn(async () => ({ persisted: true, delivered: false })),
      enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: true, delivered: false })),
      enqueueVoiceAgentTranscriptTurnCommitted: vi.fn(async () => ({ persisted: true, delivered: true })),
      sendAgentMessageEphemeral: vi.fn(),
      getTranscriptQueryContext: () => ({ encryptionMode: 'plain' as const }),
      persistVoiceAgentRunMetadataFromPublicRun: vi.fn(),
      socketEmitExecutionRunUpdated: vi.fn(),
    });
    const executor = createExecutionRunRpcActionExecutor({
      manager: {
        get: vi.fn(), getRunningCount: vi.fn(() => 0), getDepthByCallId: vi.fn(() => null),
        listPublicForRequest: vi.fn(() => []),
      } as never,
      context: sessionSocketStubState.executionRunHandlerContext,
      policy: resolveExecutionRunPolicy({ defaults: {
        maxConcurrentRuns: null, boundedTimeoutMs: null, reviewBoundedTimeoutMs: null,
        maxTurns: null,
      } }),
      isExecutionRunsEnabled: () => true,
    });

    await expect(executor.execute('session.list', {}, {
      surface: 'agent', authority: 'account_automation', defaultSessionId: 's1',
      sessionListAccess: 'current_session', runtimeAccountId: 'spoofed-message-author',
      bypassApprovals: true,
    })).resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    await expect(executor.execute('session.list', {}, {
      surface: 'agent', authority: 'account_automation', defaultSessionId: 'owner-private-session',
      sessionListAccess: 'current_session', runtimeAccountId: 'runtime-owner-account',
      bypassApprovals: true,
    })).resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    await expect(executor.execute('session.list', {}, {
      surface: 'agent', authority: 'account_automation', defaultSessionId: 's1',
      sessionListAccess: 'current_session', runtimeAccountId: 'runtime-owner-account',
      bypassApprovals: true,
    })).resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    expect(sessionSocketStubState.fetchSessionsPageMock).not.toHaveBeenCalled();
    expect(sessionSocketStubState.fetchSessionsQueryPageMock).not.toHaveBeenCalled();
    expect(sessionSocketStubState.fetchSessionByIdMock).not.toHaveBeenCalled();
  });

  afterEach(() => {
    sessionSocketStubState.executionRunHandlerContext = null;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
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
      ...TEST_SESSION_SERVER_BINDING,
      readOwnerAccountCredentials: async () => null,
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
      ...TEST_SESSION_SERVER_BINDING,
      readOwnerAccountCredentials: async () => null,
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
      ...TEST_SESSION_SERVER_BINDING,
      readOwnerAccountCredentials: async () => null,
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
      ...TEST_SESSION_SERVER_BINDING,
      readOwnerAccountCredentials: async () => null,
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
      ...TEST_SESSION_SERVER_BINDING,
      readOwnerAccountCredentials: async () => null,
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
    const client = createTestApiSessionClient(ApiSessionClient,
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
    const client = createTestApiSessionClient(ApiSessionClient,
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
    const client = createTestApiSessionClient(ApiSessionClient,
      'tok',
      createPlainSessionFixture({ id: 's1', metadata }),
    );

    expect(sessionSocketStubState.executionRunHandlerContext?.parentProvider).toBe('acme.plugin-backed-acp.backend');

    await client.close();
  });

  it('counts current work while retaining idle execution-run handles', async () => {
    const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's1', metadata: createTestMetadata({ path: '/tmp/project' }) }));
    const activeCounts: number[] = [];
    const unsubscribe = client.subscribeExecutionRunActivitySnapshots((count) => activeCounts.push(count));
    const observe = sessionSocketStubState.executionRunHandlerContext.onExecutionRunPublicStateUpdated as
      ((run: Record<string, unknown>) => void);
    try {
      observe({ runId: 'interactive', status: 'running', runClass: 'long_lived' });
      observe({ runId: 'interactive', status: 'running', runClass: 'long_lived', turnInFlight: false });
      observe({ runId: 'interactive', status: 'running', runClass: 'long_lived', turnInFlight: true });
      observe({ runId: 'bounded', status: 'running', runClass: 'bounded', turnInFlight: false });
      observe({ runId: 'interactive', status: 'running', runClass: 'long_lived', turnInFlight: false });
      observe({ runId: 'bounded', status: 'succeeded', runClass: 'bounded', turnInFlight: false });
      expect(activeCounts).toEqual([0, 1, 0, 1, 2, 1, 0]);
    } finally {
      unsubscribe();
      await client.close();
    }
  });

  it('publishes a terminal zero after execution-run activity finishes', async () => {
    const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's1', metadata: createTestMetadata({ path: '/tmp/project' }) }));
    const activeCounts: number[] = [];
    const unsubscribe = client.subscribeExecutionRunActivitySnapshots((activeCount) => {
      activeCounts.push(activeCount);
    });
    const observe = sessionSocketStubState.executionRunHandlerContext.onExecutionRunPublicStateUpdated as
      | ((run: Record<string, unknown>) => void)
      | undefined;

    observe?.({ runId: 'run_1', status: 'running' });
    observe?.({ runId: 'run_2', status: 'running' });
    observe?.({ runId: 'run_1', status: 'succeeded' });
    observe?.({ runId: 'run_2', status: 'failed' });

    expect(activeCounts).toEqual([0, 1, 2, 1, 0]);
    unsubscribe();
    await client.close();
  });

  it('exposes shared execution-run service helpers with the current session transport context', async () => {
    const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's1', metadata: createTestMetadata({ path: '/tmp/project' }) }));

    await client.executionRuns.start({ intent: 'review' });
    await client.executionRuns.list({ status: 'running' });
    await client.executionRuns.get({ runId: 'run_1' });
    await client.executionRuns.send({ runId: 'run_1', message: 'hello' });
    await client.executionRuns.stop({ runId: 'run_1' });
    await client.executionRuns.action({ runId: 'run_1', actionId: 'review.apply' });
    const wait = client.executionRuns.wait;
    expect(wait).toBeDefined();
    if (!wait) throw new Error('Expected executionRuns.wait to be defined');
    await wait({ runId: 'run_1', timeoutSeconds: 2 });
    await wait({ runId: 'run_2' });

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
      ctx: null,
    }));
    expect(sessionSocketStubState.executionRunServiceMocks.waitForExecutionRun).toHaveBeenCalledWith(expect.objectContaining({
      token: 'tok',
      sessionId: 's1',
      mode: 'plain',
      runId: 'run_2',
      timeoutMs: null,
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
    const client = createTestApiSessionClient(ApiSessionClient,
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
    const client = createTestApiSessionClient(ApiSessionClient,
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
    let persistedMetadata: unknown = session.metadata;
    sessionSocketStubState.fetchSessionByIdCompatMock.mockResolvedValue({
      ...session,
      metadataLayoutVersion: 0,
      metadata: JSON.stringify(session.metadata ?? {}),
      agentState: null,
      encryptionMode: 'plain',
      dataEncryptionKey: null,
    });

    // Ordinary owner writes migrate this supported predecessor through the real
    // tuple owner; this fixture substitutes only the Home's HTTP CAS boundary.
    sessionSocketStubState.patchSessionMetadataEnvelopeTupleMock.mockImplementation(async (request) => {
      const patch = SessionMetadataOwnerMigrationPatchV1Schema.parse(request.patch);
      if (patch.target.ownerMetadata.t !== 'plain') throw new Error('Expected plain owner metadata');
      persistedMetadata = projectSessionOwnerCompatibilityViewV1({
        sharedMetadata: JSON.parse(patch.target.sharedMetadata.ciphertext),
        ownerMetadata: patch.target.ownerMetadata.v,
      });
      return {
        success: true, metadataLayoutVersion: 1,
        sharedMetadata: { version: patch.source.metadata.version + 1 },
        agentState: { version: patch.source.agentState.version + 1 },
      };
    });

    const client = createTestApiSessionClient(ApiSessionClient, 'tok', session, {
      metadataAuthority: { kind: 'owner', credentials: { token: 'tok', encryption: null } },
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

    expect(sessionSocketStubState.patchSessionMetadataEnvelopeTupleMock).toHaveBeenCalledWith({
      token: 'tok', sessionId: 's1',
      patch: expect.objectContaining({
        mode: 'owner_migration',
        source: expect.objectContaining({ metadataLayoutVersion: 0, metadata: { version: 0, ciphertext: JSON.stringify(session.metadata) } }),
      }),
    });
    expect(client.getMetadataSnapshot()).toMatchObject({ voiceAgentRunV1: { runId: 'run_voice_1' } });

    await client.close();
  });

  it('rejects a durable voice transcript pair whose role metadata does not describe one canonical turn', async () => {
    const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's1', metadata: createTestMetadata({ path: '/tmp/project' }) }));
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
