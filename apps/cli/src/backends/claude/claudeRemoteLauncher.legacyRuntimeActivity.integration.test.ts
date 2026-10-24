import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import type { SessionClientPort } from '@/api/session/sessionClientPort';
import type { AgentState, Metadata } from '@/api/types';
import { createSessionRuntimeActivity } from '@/session/runtimeActivity/createSessionRuntimeActivity';
import type { SessionRuntimeActivityContributionHandle } from '@/session/runtimeActivity/types';
import type { SessionRuntimeActivitySnapshot } from '@happier-dev/protocol';
import { AccountSettingsSchema } from '@happier-dev/protocol';

import type { EnhancedMode } from './loop';
import { claudeRemoteLauncher } from './claudeRemoteLauncher';
import { hashClaudeEnhancedModeForQueue } from './remote/modeHash';
import { Session } from './session';
import { logger } from '@/ui/logger';
import { reloadConfiguration } from '@/configuration';
import { completedNativeChildTranscript } from './workflows/claudeWorkflowActivitySource.testkit';
import type { SessionWorkflowRunSnapshotV1 } from '@happier-dev/protocol';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { SessionHookData } from './utils/startHookServer';

const mockQuery = vi.hoisted(() => vi.fn());
const mockClaudeRemote = vi.hoisted(() => vi.fn());
const mockClaudeRemoteAgentSdk = vi.hoisted(() => vi.fn());
const mockRunClaudeUnifiedTerminalSession = vi.hoisted(() => vi.fn());
const notifyDaemonSessionStarted = vi.hoisted(() => vi.fn(async () => ({})));

// Daemon HTTP boundary; keep capability reporting and launcher selection real.
vi.mock('@/daemon/controlClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/daemon/controlClient')>(),
  notifyDaemonSessionStarted,
}));

vi.mock('@/backends/claude/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/backends/claude/sdk')>();
  return { ...actual, query: mockQuery };
});

vi.mock('./remote/claudeRemoteAgentSdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./remote/claudeRemoteAgentSdk')>();
  return { ...actual, claudeRemoteAgentSdk: mockClaudeRemoteAgentSdk };
});

vi.mock('./claudeRemote', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./claudeRemote')>();
  return { ...actual, claudeRemote: mockClaudeRemote };
});

vi.mock('./unifiedTerminal/runClaudeUnifiedTerminalSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./unifiedTerminal/runClaudeUnifiedTerminalSession')>();
  return { ...actual, runClaudeUnifiedTerminalSession: mockRunClaudeUnifiedTerminalSession };
});

vi.mock('@/runtime/js/ensureJavaScriptRuntimeExecutable', () => ({
  ensureJavaScriptRuntimeExecutable: vi.fn(async () => '/managed/js-runtime'),
}));

vi.mock('./utils/resolveClaudeCliPath', () => ({
  resolveClaudeCliPath: vi.fn(() => '/resolved/claude-cli.js'),
}));

const actualClaudeRemote = await vi.importActual<typeof import('./claudeRemote')>('./claudeRemote');
const actualClaudeRemoteAgentSdk = await vi.importActual<typeof import('./remote/claudeRemoteAgentSdk')>('./remote/claudeRemoteAgentSdk');

type RpcHandler = (params?: unknown) => unknown | Promise<unknown>;

const createdSessions: Session[] = [];

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveFn: ((value: T) => void) | null = null;
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve;
  });
  return {
    promise,
    resolve: (value: T) => resolveFn?.(value),
  };
}

function createHarness(providerTasks?: SessionRuntimeActivityContributionHandle, opts?: Readonly<{ providerSessionId: string | null }>): Readonly<{
  session: Session;
  switchHandlerReady: Promise<RpcHandler>;
}> {
  const switchDeferred = createDeferred<RpcHandler>();
  let agentState: AgentState = { requests: Object.create(null), completedRequests: Object.create(null) };
  let metadata: Metadata = {
    path: '/tmp',
    host: 'localhost',
    homeDir: '/tmp/home',
    happyHomeDir: '/tmp/.happier',
    happyLibDir: '/tmp/.happier/lib',
    happyToolsDir: '/tmp/.happier/tools',
  };
  let hasMetadata = false;

  const client = {
    sessionId: 'happier-session-1',
    sendAgentMessage: vi.fn(),
    sendAgentMessageCommitted: vi.fn(async () => {}),
    recordClaudeJsonlMessageConsumed: vi.fn(),
    keepAlive: vi.fn(),
    sessionTurnLifecycle: {
      beginTurn: vi.fn(async () => ({ turnId: 'turn-1' })),
      attachProviderTurnId: vi.fn(async () => {}),
      appendTranscriptAnchors: vi.fn(async () => {}),
      completeTurn: vi.fn(async () => {}),
      failTurn: vi.fn(async () => {}),
      cancelTurn: vi.fn(async () => {}),
      endSession: vi.fn(async () => {}),
      markRollbackEligible: vi.fn(async () => {}),
      markRolledBack: vi.fn(async () => {}),
      touchActiveTurn: vi.fn(async () => {}),
      hasActiveTurn: vi.fn(() => false),
      observeAcpLifecycleMarker: vi.fn((input: { body: unknown }) => ({ body: input.body, pendingWrite: null })),
    },
    updateMetadata: vi.fn((updater: (current: Metadata) => Metadata) => {
      metadata = updater(metadata);
      hasMetadata = true;
    }),
    updateAgentStateRequestSettlement: vi.fn(async () => {}),
      updateAgentState: vi.fn((updater: (current: AgentState) => AgentState) => {
      agentState = updater(agentState);
    }),
    getAgentStateSnapshot: vi.fn(() => agentState),
    rpcHandlerManager: {
      registerHandler: vi.fn((method: string, handler: RpcHandler) => {
        if (method === 'switch') switchDeferred.resolve(handler);
      }),
      invokeLocal: vi.fn(async () => ({})),
    },
    sendClaudeSessionMessage: vi.fn(),
    blockPendingMessageDelivery: vi.fn(async () => false),
    registerSessionRuntimeControls: vi.fn(() => vi.fn()),
    fetchRecentTranscriptTextItemsForAcpImport: vi.fn(async () => []),
    sendSessionEvent: vi.fn(),
    getMetadataSnapshot: vi.fn(() => hasMetadata ? metadata : null),
    waitForMetadataUpdate: vi.fn(async () => false),
    waitForPendingEligibilityUpdate: vi.fn(async () => false),
    popPendingMessage: vi.fn(async () => false),
    peekPendingMessageQueueV2Count: vi.fn(async () => 0),
    discardPendingMessageQueueV2All: vi.fn(async () => 0),
    discardCommittedMessageLocalIds: vi.fn(async () => 0),
    sendSessionDeath: vi.fn(),
    flush: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as SessionClientPort;

  const session = new Session({
    client,
    path: '/tmp',
    logPath: '/tmp/claude-remote.log',
    sessionId: opts ? opts.providerSessionId : 'claude-current',
    messageQueue: new MessageQueue2<EnhancedMode>(hashClaudeEnhancedModeForQueue),
    onModeChange: () => {},
    hookSettingsPath: '/tmp/claude-hooks.json',
    hookPluginDir: '/tmp/claude-hook-plugin',
    precomputedMcpBridge: { mcpServers: {}, stop: vi.fn() },
    runtimeActivityContributions: {
      providerTasks: providerTasks ?? {
        report: vi.fn(async () => {}),
        markUnknown: vi.fn(async () => {}),
        dispose: vi.fn(async () => {}),
      },
      // Keep this true after launcher exit: post-exit inertness must come from
      // subscriber disposal rather than being masked by the runtime fence.
      isCurrentRuntime: () => true,
    },
  });
  session.transcriptPath = '/tmp/claude-current.jsonl';
  createdSessions.push(session);

  return { session, switchHandlerReady: switchDeferred.promise };
}

describe.sequential('claudeRemoteLauncher legacy Runtime Activity subscriber', () => {
  const previousGraceMs = process.env.HAPPIER_CLAUDE_REMOTE_INTERRUPT_THEN_TEARDOWN_GRACE_MS;

  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockReset();
    mockClaudeRemote.mockReset();
    mockClaudeRemoteAgentSdk.mockReset();
    mockRunClaudeUnifiedTerminalSession.mockReset();
    process.env.HAPPIER_CLAUDE_REMOTE_INTERRUPT_THEN_TEARDOWN_GRACE_MS = '0';
  });

  it('records a pre-spawn resume failure in the normal file log while preserving the conversation', async () => {
    const { session } = createHarness();
    const transcriptDir = await mkdtemp(join(tmpdir(), 'claude-missing-resume-'));
    session.transcriptPath = join(transcriptDir, 'claude-current.jsonl');
    // Execute the real SDK runner and its filesystem resume check, stopping before
    // any external provider launch because the requested transcript is absent.
    mockClaudeRemoteAgentSdk.mockImplementation(actualClaudeRemoteAgentSdk.claudeRemoteAgentSdk);
    const infoFile = vi.spyOn(logger, 'infoFile');
    session.queue.push('continue the conversation', {
      permissionMode: 'default',
      claudeRemoteAgentSdkEnabled: true,
      claudeUnifiedTerminalEnabled: false,
    }, { userMessageLocalId: 'missing-resume-input' });

    try {
      await expect(claudeRemoteLauncher(session)).resolves.toBe('exit');
      expect(session.sessionId).toBe('claude-current');
      expect(session.client.sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'message',
        message: expect.stringContaining('transcript is unavailable'),
      }));
      expect(infoFile).toHaveBeenCalledWith('[remote]: launch error', expect.objectContaining({
        error: expect.stringContaining('ClaudeResumeSessionUnavailableError'),
        disposition: 'preserve-resume-and-exit',
      }));
    } finally {
      infoFile.mockRestore();
      await rm(transcriptDir, { recursive: true, force: true });
    }
  });

  it('applies SDK permission metadata during startup and while idle without another prompt', async () => {
    const { session, switchHandlerReady } = createHarness();
    const transcriptDir = await mkdtemp(join(tmpdir(), 'claude-live-permission-mode-'));
    session.transcriptPath = join(transcriptDir, 'claude-current.jsonl');
    await writeFile(session.transcriptPath, '{"type":"summary"}\n');
    session.client.updateMetadata(metadata => ({ ...metadata, flavor: 'claude', claudeSessionId: 'claude-current' }));
    Object.assign(session.client, {
      getStoredContentEncryptionContext: () => ({ mode: 'plain' }),
      upsertSessionSystemRecord: async () => {},
    });
    let metadataWake = createDeferred<boolean>();
    Object.assign(session.client, {
      waitForMetadataUpdate: (signal?: AbortSignal) => {
        const pending = metadataWake;
        if (signal?.aborted) return Promise.resolve(false);
        signal?.addEventListener('abort', () => pending.resolve(false), { once: true });
        return pending.promise;
      },
    });
    const updatePermission = (permissionMode: 'yolo' | 'default', permissionModeUpdatedAt: number) => {
      session.client.updateMetadata(current => ({ ...current, permissionMode, permissionModeUpdatedAt }));
      const pending = metadataWake;
      metadataWake = createDeferred<boolean>();
      pending.resolve(true);
    };
    const finishQuery = createDeferred<void>();
    let queryIdle = false;
    const appliedModes: string[] = [];
    const createQuery: NonNullable<Parameters<typeof actualClaudeRemoteAgentSdk.claudeRemoteAgentSdk>[0]['createQuery']> = () => {
      // Query creation and its controls are the external SDK boundary. The real launcher,
      // metadata consumer, mode arbitration and SDK runtime remain under test.
      updatePermission('yolo', Date.now() + 1);
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'result' };
          queryIdle = true;
          await finishQuery.promise;
        },
        close: () => finishQuery.resolve(undefined),
        setPermissionMode: async (permissionMode: string) => { appliedModes.push(permissionMode); },
        setModel: async () => {}, setMaxThinkingTokens: async () => {},
        supportedCommands: async () => [], supportedModels: async () => [],
      } as unknown as Query;
    };
    mockClaudeRemoteAgentSdk.mockImplementation((opts: Parameters<typeof actualClaudeRemoteAgentSdk.claudeRemoteAgentSdk>[0]) => (
      actualClaudeRemoteAgentSdk.claudeRemoteAgentSdk({ ...opts, claudeExecutablePath: '/tmp/claude', createQuery })
    ));
    session.queue.push('hello', { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true, claudeUnifiedTerminalEnabled: false },
      { userMessageLocalId: 'live-permission-mode' });
    const launcher = claudeRemoteLauncher(session);
    const switchHandler = await switchHandlerReady;
    try {
      await vi.waitFor(() => expect(queryIdle).toBe(true));
      await vi.waitFor(() => expect(appliedModes).toEqual(['bypassPermissions']));
      updatePermission('default', Date.now() + 2);
      await vi.waitFor(() => expect(appliedModes).toEqual(['bypassPermissions', 'default']));
      expect(session.queue.size()).toBe(0);
      expect(mockClaudeRemoteAgentSdk).toHaveBeenCalledTimes(1);
    } finally {
      finishQuery.resolve(undefined);
      await Promise.all([Promise.resolve(switchHandler({ to: 'local' })), session.cleanup(), launcher]);
      await rm(transcriptDir, { recursive: true, force: true });
    }
    updatePermission('yolo', Date.now() + 3);
    expect(appliedModes).toEqual(['bypassPermissions', 'default']);
  });

  it('ends an idle Agent SDK launch and its provider dispatch when runner termination aborts the launcher', async () => {
    const { session } = createHarness(undefined, { providerSessionId: null });
    Object.assign(session.client, {
      getStoredContentEncryptionContext: () => ({ mode: 'plain' }),
      upsertSessionSystemRecord: async () => {},
    });
    let queryIdle = false;
    let providerAbortObserved = false;
    const createQuery: NonNullable<Parameters<typeof actualClaudeRemoteAgentSdk.claudeRemoteAgentSdk>[0]['createQuery']> = (params) => {
      // The SDK query is the external child-process boundary: it ends its stream only when its
      // abort controller kills the Claude child. Everything above it stays real.
      const abortController = params.options?.abortController;
      if (!(abortController instanceof AbortController)) throw new Error('SDK query requires an abortController');
      const abortSignal = abortController.signal;
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'result' };
          queryIdle = true;
          await new Promise<void>((resolve) => {
            if (abortSignal.aborted) return resolve();
            abortSignal.addEventListener('abort', () => resolve(), { once: true });
          });
          providerAbortObserved = true;
        },
        close: () => {},
        setPermissionMode: async () => {}, setModel: async () => {}, setMaxThinkingTokens: async () => {},
        supportedCommands: async () => [], supportedModels: async () => [],
      } as unknown as Query;
    };
    mockClaudeRemoteAgentSdk.mockImplementation((opts: Parameters<typeof actualClaudeRemoteAgentSdk.claudeRemoteAgentSdk>[0]) => (
      actualClaudeRemoteAgentSdk.claudeRemoteAgentSdk({ ...opts, claudeExecutablePath: '/tmp/claude', createQuery })
    ));
    session.queue.push('hello', { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true, claudeUnifiedTerminalEnabled: false },
      { userMessageLocalId: 'termination-idle' });
    const termination = new AbortController();
    const launcher = claudeRemoteLauncher(session, { signal: termination.signal });
    await vi.waitFor(() => expect(queryIdle).toBe(true));

    termination.abort('claude-runner-termination');

    const settled = await Promise.race([
      launcher.then((reason) => ({ reason })),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2_000)),
    ]);
    expect(settled).toEqual({ reason: 'exit' });
    expect(providerAbortObserved).toBe(true);
    await expect(session.closeProviderInputAdmissionAndWaitForDispatches()).resolves.toBeUndefined();
  });

  it('projects authenticated legacy hooks into the real workflow source while the child runs', async () => {
    const { session, switchHandlerReady } = createHarness();
    const transcriptDir = await mkdtemp(join(tmpdir(), 'claude-legacy-workflow-hook-'));
    session.transcriptPath = join(transcriptDir, 'claude-current.jsonl');
    await writeFile(session.transcriptPath, JSON.stringify({ type: 'user', uuid: 'previous-prompt', sessionId: 'claude-current',
      message: { role: 'user', content: 'previous prompt' } }) + '\n');
    await session.client.updateMetadata(metadata => ({ ...metadata, flavor: 'claude', claudeSessionId: 'claude-current' }));
    const snapshots: SessionWorkflowRunSnapshotV1[] = [];
    Object.assign(session.client, {
      getStoredContentEncryptionContext: () => ({ mode: 'plain' }),
      upsertSessionSystemRecord: async (record: { content: { t: string; v?: SessionWorkflowRunSnapshotV1 } }) => {
        if (record.content.t === 'plain' && record.content.v?.agents) snapshots.push(record.content.v);
      },
    });
    mockClaudeRemote.mockImplementation(actualClaudeRemote.claudeRemote);
    const queryStarted = createDeferred<void>();
    let queryDone = false;
    let queryError: unknown;
    mockQuery.mockImplementation((params: { onMessageReceived?: (row: unknown) => void }) => ({
      async *[Symbol.asyncIterator]() {
        queryStarted.resolve(undefined);
        try {
          for (const row of completedNativeChildTranscript('claude-current')) {
            params.onMessageReceived?.(row);
            yield row;
          }
          await vi.waitFor(() => expect(snapshots.at(-1)?.status).toBe('complete'));
          session.onClaudeSessionHook({ hook_event_name: 'SubagentStart', agent_id: 'native-a', session_id: 'claude-current' });
          await vi.waitFor(() => expect(snapshots.some(snapshot => snapshot.status === 'active'
            && snapshot.agents.find(agent => agent.id === 'a')?.status === 'active'
            && snapshot.agents.find(agent => agent.id === 'b')?.status === 'complete')).toBe(true));
        } catch (error) { queryError = error; }
        finally { queryDone = true; }
      },
    }));
    session.queue.push('hello', { permissionMode: 'default', claudeRemoteAgentSdkEnabled: false, claudeUnifiedTerminalEnabled: false },
      { userMessageLocalId: 'legacy-workflow-hook' });
    const launcher = claudeRemoteLauncher(session);
    const switchHandler = await switchHandlerReady;
    try {
      await queryStarted.promise;
      await vi.waitFor(() => expect(queryDone).toBe(true), { timeout: 3000 });
      if (queryError) throw queryError;
    } finally {
      await switchHandler({ to: 'local' });
      await launcher;
      await rm(transcriptDir, { recursive: true, force: true });
    }
  });

  it.each(['matching cache', 'cached predecessor'] as const)('rebuilds cold SDK workflow aliases beyond the history tail before admitting an authenticated resume (%s)', async (identity) => {
    const activity = createSessionRuntimeActivity('supported');
    let published: SessionRuntimeActivitySnapshot = { state: 'unknown', activeCount: 0 };
    await activity.bindPublisher({ publish: async snapshot => { published = snapshot; }, close: async () => {} });
    const providerTasks = activity.agentRuntimeContributionHandle;
    if (!providerTasks) throw new Error('Expected provider contribution');
    const { session, switchHandlerReady } = createHarness(providerTasks, { providerSessionId: identity === 'cached predecessor' ? null : 'claude-current' });
    const transcriptDir = await mkdtemp(join(tmpdir(), 'claude-cold-sdk-history-'));
    session.transcriptPath = join(transcriptDir, 'claude-current.jsonl');
    const history = [
      ...completedNativeChildTranscript('claude-current'),
      ...Array.from({ length: 1100 }, (_, index) => ({
        type: 'assistant', uuid: `later-history-${index}`, sessionId: 'claude-current',
        message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(1024) }] },
      })),
    ].map(row => JSON.stringify(row)).join('\n') + '\n';
    expect(Buffer.byteLength(history)).toBeGreaterThan(1_000_000);
    await writeFile(session.transcriptPath, history);
    if (identity === 'cached predecessor') {
      session.claudeArgs = ['--resume', 'claude-current'];
    }
    await session.client.updateMetadata(metadata => ({ ...metadata, flavor: 'claude', claudeSessionId: identity === 'cached predecessor' ? 'claude-predecessor' : 'claude-current' }));
    const snapshots: SessionWorkflowRunSnapshotV1[] = [];
    Object.assign(session.client, {
      getStoredContentEncryptionContext: () => ({ mode: 'plain' }),
      upsertSessionSystemRecord: async (record: { content: { t: string; v?: SessionWorkflowRunSnapshotV1 } }) => {
        if (record.content.t === 'plain' && record.content.v?.agents) snapshots.push(record.content.v);
      },
    });
    const hookObserved = createDeferred<void>();
    const finishQuery = createDeferred<void>();
    const sdkAttemptFinished = createDeferred<Readonly<{ error?: unknown }>>();
    type ObservationHooks = Record<string, Array<{ hooks: Array<(data: SessionHookData) => Promise<unknown>> }>>;
    const createQuery: NonNullable<Parameters<typeof actualClaudeRemoteAgentSdk.claudeRemoteAgentSdk>[0]['createQuery']> = params => {
      // This fixture implements the consumed external SDK query/hook boundary only.
      const hooks = params.options?.hooks as ObservationHooks;
      return {
        async *[Symbol.asyncIterator]() {
          await hooks.SubagentStart[0].hooks[0]({ hook_event_name: 'SubagentStart', session_id: 'claude-current', agent_id: 'native-a' });
          hookObserved.resolve(undefined);
          await finishQuery.promise;
          yield { type: 'result' };
        },
        close: () => { finishQuery.resolve(undefined); },
        setPermissionMode: async () => {}, setModel: async () => {}, setMaxThinkingTokens: async () => {},
        supportedCommands: async () => [], supportedModels: async () => [],
      } as unknown as Query;
    };
    mockClaudeRemoteAgentSdk.mockImplementation(async (opts: Parameters<typeof actualClaudeRemoteAgentSdk.claudeRemoteAgentSdk>[0]) => {
      try {
        await actualClaudeRemoteAgentSdk.claudeRemoteAgentSdk({ ...opts, claudeExecutablePath: '/tmp/claude', createQuery });
        sdkAttemptFinished.resolve({});
      } catch (error) {
        sdkAttemptFinished.resolve({ error });
        throw error;
      }
    });
    session.queue.push('continue', { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true, claudeUnifiedTerminalEnabled: false },
      { userMessageLocalId: 'cold-sdk-workflow-resume' });
    const launcher = claudeRemoteLauncher(session);
    const switchHandler = await switchHandlerReady;
    try {
      await Promise.race([
        hookObserved.promise,
        sdkAttemptFinished.promise.then(({ error }) => {
          throw error ?? new Error('Agent SDK attempt finished before observing the authenticated resume hook');
        }),
      ]);
      const ledger = session.getProviderTaskActivityLedger();
      if (!ledger) throw new Error('Expected actual session ledger');
      await vi.waitFor(() => expect({
        runtime: published,
        nativeTasks: ledger.getActiveProviderTaskBlockers().map(task => task.taskId),
        agents: snapshots.at(-1)?.agents.map(agent => [agent.id, agent.status]),
      }).toEqual({
        runtime: { state: 'active', activeCount: 1 }, nativeTasks: ['native-a'],
        agents: [['a', 'active'], ['b', 'complete']],
      }), { timeout: 3000 });
    } finally {
      finishQuery.resolve(undefined);
      await switchHandler({ to: 'local' });
      await launcher;
      await activity.dispose();
      await rm(transcriptDir, { recursive: true, force: true });
    }
  });

  it('surfaces incomplete cold SDK startup history and keeps actual runtime activity unknown', async () => {
    const activity = createSessionRuntimeActivity('supported');
    let published: SessionRuntimeActivitySnapshot = { state: 'unknown', activeCount: 0 };
    await activity.bindPublisher({ publish: async snapshot => { published = snapshot; }, close: async () => {} });
    const providerTasks = activity.agentRuntimeContributionHandle;
    if (!providerTasks) throw new Error('Expected provider contribution');
    const { session, switchHandlerReady } = createHarness(providerTasks);
    const transcriptDir = await mkdtemp(join(tmpdir(), 'claude-cold-sdk-incomplete-'));
    session.transcriptPath = join(transcriptDir, 'claude-current.jsonl');
    await writeFile(session.transcriptPath, '{"type":"attachment"');
    await session.client.updateMetadata(metadata => ({ ...metadata, flavor: 'claude', claudeSessionId: 'claude-current' }));
    Object.assign(session.client, {
      getStoredContentEncryptionContext: () => ({ mode: 'plain' }),
      upsertSessionSystemRecord: async () => {},
    });
    session.queue.push('continue', { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true, claudeUnifiedTerminalEnabled: false },
      { userMessageLocalId: 'cold-sdk-incomplete' });
    const launcher = claudeRemoteLauncher(session);
    const switchHandler = await switchHandlerReady;
    try {
      await vi.waitFor(() => expect(session.client.sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'message', message: expect.stringMatching(/startup transcript history is incomplete/),
      })));
      expect(published).toEqual({ state: 'unknown', activeCount: 0 });
      expect(mockClaudeRemoteAgentSdk).not.toHaveBeenCalled();
    } finally {
      await switchHandler({ to: 'local' });
      await launcher;
      await activity.dispose();
      await rm(transcriptDir, { recursive: true, force: true });
    }
  });

  it.each(['claude-current', null])('keeps daemon registration under the Happier identity (provider ID: %s)', async (providerSessionId) => {
    const { session, switchHandlerReady } = createHarness();
    session.sessionId = providerSessionId;
    const transcriptDir = await mkdtemp(join(tmpdir(), 'claude-daemon-identity-'));
    session.transcriptPath = join(transcriptDir, 'claude-current.jsonl');
    await writeFile(session.transcriptPath, `${JSON.stringify({
      type: 'user', uuid: 'previous-prompt', sessionId: providerSessionId,
      message: { role: 'user', content: 'previous prompt' },
    })}\n`);
    await session.client.updateMetadata((metadata) => ({ ...metadata, flavor: 'claude' }));
    const providerEntered = createDeferred<void>();
    const finishProvider = createDeferred<void>();
    mockClaudeRemote.mockImplementation(actualClaudeRemote.claudeRemote);
    mockQuery.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        providerEntered.resolve(undefined);
        await finishProvider.promise;
      },
    }));
    session.queue.push('hello', {
      permissionMode: 'default',
      claudeRemoteAgentSdkEnabled: false,
      claudeUnifiedTerminalEnabled: false,
    }, { userMessageLocalId: 'local-daemon-identity' });

    const launcher = claudeRemoteLauncher(session);
    const switchHandler = await switchHandlerReady;
    try {
      await providerEntered.promise;
      expect(notifyDaemonSessionStarted).toHaveBeenCalledWith(
        'happier-session-1',
        expect.objectContaining({
          claudeSubscriptionAccessTokenRefreshV1: { v: 1, mode: 'unavailable' },
        }),
        expect.anything(),
      );
    } finally {
      const switching = Promise.resolve(switchHandler({ to: 'local' }));
      finishProvider.resolve(undefined);
      await Promise.all([switching, session.cleanup(), launcher]);
      await rm(transcriptDir, { recursive: true, force: true });
    }
  });

  it.each([true, false])('offers known prelaunch activity before reading durable Pending input (Agent SDK: %s)', async (agentSdkEnabled) => {
    const activity = createSessionRuntimeActivity('supported');
    let published: SessionRuntimeActivitySnapshot = { state: 'unknown', activeCount: 0 };
    await activity.bindPublisher({
      publish: async (snapshot) => { published = snapshot; },
      close: async () => {},
    });
    const providerTasks = activity.agentRuntimeContributionHandle;
    if (!providerTasks) throw new Error('Expected supported provider contribution');
    const { session, switchHandlerReady } = createHarness(providerTasks);
    session.accountSettings = AccountSettingsSchema.parse({ sessionPendingQueueDeliveryTiming: 'after_runtime_idle' });
    const materializationStates: SessionRuntimeActivitySnapshot[] = [];
    // This is the server boundary. Capture the state that authorizes the first durable
    // row without preloading the local queue or invoking any mocked provider runner.
    session.client.materializeNextPendingMessageSafely = async () => {
      materializationStates.push(published);
      return { type: 'deferred', reason: 'runtime_activity_unknown' };
    };

    const launcherPromise = claudeRemoteLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeRemoteAgentSdkEnabled: agentSdkEnabled,
        claudeUnifiedTerminalEnabled: false,
      },
    });
    const switchHandler = await switchHandlerReady;
    try {
      await vi.waitFor(() => expect(materializationStates.length).toBeGreaterThan(0));
      expect(materializationStates[0]).toEqual({ state: 'idle', activeCount: 0 });
      expect(mockClaudeRemote).not.toHaveBeenCalled();
      expect(mockClaudeRemoteAgentSdk).not.toHaveBeenCalled();
    } finally {
      await Promise.all([
        Promise.resolve(switchHandler({ to: 'local' })),
        session.cleanup(),
        launcherPromise,
      ]);
      await activity.dispose();
    }
  });

  it('offers idle before reading Pending input after a local provider stops and remote SDK takes over', async () => {
    const activity = createSessionRuntimeActivity('supported');
    let published: SessionRuntimeActivitySnapshot = { state: 'unknown', activeCount: 0 };
    await activity.bindPublisher({
      publish: async (snapshot) => { published = snapshot; },
      close: async () => {},
    });
    const providerTasks = activity.agentRuntimeContributionHandle;
    if (!providerTasks) throw new Error('Expected supported provider contribution');
    const { session, switchHandlerReady } = createHarness(providerTasks);
    session.accountSettings = AccountSettingsSchema.parse({ sessionPendingQueueDeliveryTiming: 'after_runtime_idle' });
    const adapter = session.getProviderTaskRuntimeActivityAdapter();
    if (!adapter) throw new Error('Expected Claude provider activity adapter');
    await adapter.activateObservation('local-observer-installed');
    await adapter.handleRuntimeLoss('claude_process_exit');
    expect(published).toEqual({ state: 'unknown', activeCount: 0 });

    const materializationStates: SessionRuntimeActivitySnapshot[] = [];
    session.client.materializeNextPendingMessageSafely = async () => {
      materializationStates.push(published);
      return { type: 'deferred', reason: 'runtime_activity_unknown' };
    };
    const launcherPromise = claudeRemoteLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeRemoteAgentSdkEnabled: true,
        claudeUnifiedTerminalEnabled: false,
      },
    });
    const switchHandler = await switchHandlerReady;
    try {
      await vi.waitFor(() => expect(materializationStates.length).toBeGreaterThan(0));
      expect(materializationStates[0]).toEqual({ state: 'idle', activeCount: 0 });
      expect(mockClaudeRemoteAgentSdk).not.toHaveBeenCalled();
    } finally {
      await Promise.all([
        Promise.resolve(switchHandler({ to: 'local' })),
        session.cleanup(),
        launcherPromise,
      ]);
      await activity.dispose();
    }
  });

  it('publishes Agent SDK steer support and clears it when authentication falls back to legacy', async () => {
    const { session, switchHandlerReady } = createHarness();
    const agentSdkState = createDeferred<AgentState>();
    const legacyState = createDeferred<AgentState>();
    const finishLegacy = createDeferred<void>();

    mockClaudeRemoteAgentSdk.mockImplementationOnce(async () => {
      agentSdkState.resolve(session.client.getAgentStateSnapshot?.() ?? {});
      throw new Error('API Error: 401 OAuth access token has expired');
    });
    mockClaudeRemote.mockImplementationOnce(async () => {
      legacyState.resolve(session.client.getAgentStateSnapshot?.() ?? {});
      await finishLegacy.promise;
    });

    session.queue.push(
      'initial prompt',
      {
        permissionMode: 'default',
        claudeRemoteAgentSdkEnabled: true,
        claudeUnifiedTerminalEnabled: false,
      },
      { userMessageLocalId: 'local-initial' },
    );

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);
    const switchHandler = await switchHandlerReady;
    try {
      await expect(agentSdkState.promise).resolves.toMatchObject({
        capabilities: {
          inFlightSteer: true,
          inFlightSteerSupported: true,
          inFlightSteerAvailable: false,
          inFlightSteerUnavailableReason: 'unsafe_window',
        },
      });
      await expect(legacyState.promise).resolves.toMatchObject({
        capabilities: {
          inFlightSteer: false,
          inFlightSteerSupported: false,
          inFlightSteerAvailable: false,
          inFlightSteerUnavailableReason: 'backend_unsupported',
        },
      });
    } finally {
      finishLegacy.resolve(undefined);
      await Promise.all([
        Promise.resolve(switchHandler({ to: 'local' })),
        session.cleanup(),
        launcherPromise,
      ]);
    }
  });

  afterEach(() => {
    if (previousGraceMs === undefined) {
      delete process.env.HAPPIER_CLAUDE_REMOTE_INTERRUPT_THEN_TEARDOWN_GRACE_MS;
    } else {
      process.env.HAPPIER_CLAUDE_REMOTE_INTERRUPT_THEN_TEARDOWN_GRACE_MS = previousGraceMs;
    }
    for (const session of createdSessions.splice(0)) session.cleanup();
  });

  it('releases the previous Agent SDK input wait before a provider relaunch', async () => {
    const awaitPhase = async <T>(label: string, promise: Promise<T>): Promise<T> => {
      let timeout: ReturnType<typeof setTimeout> | null = null;
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 5_000);
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    };
    const { session, switchHandlerReady } = createHarness();
    const firstLaunchStarted = createDeferred<void>();
    const firstWaitArmed = createDeferred<void>();
    const finishFirstLaunch = createDeferred<void>();
    const secondLaunchStarted = createDeferred<void>();
    const secondPromptOutcome = createDeferred<Readonly<{
      status: 'fulfilled' | 'rejected';
      message?: string;
      error?: unknown;
    }>>();
    let launchCall = 0;

    mockClaudeRemoteAgentSdk.mockImplementation(async (opts: Readonly<{
      nextMessage: () => Promise<Readonly<{ message: string }> | null>;
    }>) => {
      launchCall += 1;
      if (launchCall === 1) {
        firstLaunchStarted.resolve(undefined);
        await expect(opts.nextMessage()).resolves.toEqual(expect.objectContaining({ message: 'initial prompt' }));
        void opts.nextMessage().catch(() => undefined);
        firstWaitArmed.resolve(undefined);
        await finishFirstLaunch.promise;
        return;
      }
      if (launchCall === 2) {
        secondLaunchStarted.resolve(undefined);
        try {
          const next = await opts.nextMessage();
          if (!next) return;
          secondPromptOutcome.resolve({
            status: 'fulfilled',
            message: next.message,
          });
        } catch (error) {
          secondPromptOutcome.resolve({ status: 'rejected', error });
          throw error;
        }
        return;
      }
      const next = await opts.nextMessage();
      if (next) {
        secondPromptOutcome.resolve({
          status: 'fulfilled',
          message: next.message,
        });
      }
    });

    session.queue.push(
      'initial prompt',
      {
        permissionMode: 'default',
        claudeRemoteAgentSdkEnabled: true,
        claudeUnifiedTerminalEnabled: false,
      },
      { userMessageLocalId: 'local-initial' },
    );

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);
    const launcherOutcome = launcherPromise.then(
      (value) => ({ status: 'resolved' as const, value }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    const switchHandler = await switchHandlerReady;
    try {
      await expect(awaitPhase('first Agent SDK launch', Promise.race([
        firstLaunchStarted.promise.then(() => ({ status: 'launch-started' as const })),
        launcherOutcome,
      ]))).resolves.toEqual({ status: 'launch-started' });
      await awaitPhase('first input wait', firstWaitArmed.promise);
      finishFirstLaunch.resolve(undefined);
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      session.client.updateMetadata((current) => ({
        ...current,
        replaySeedV1: {
          v: 1,
          seedText: 'CARRY-OVER',
          sourceSessionId: 'source-session',
          sourceCutoffSeqInclusive: 10,
          createdAtMs: 123,
        },
      }));
      session.queue.pushIsolateAndClear(
        'recovery prompt',
        {
          permissionMode: 'default',
          claudeRemoteAgentSdkEnabled: true,
          claudeUnifiedTerminalEnabled: false,
        },
        { userMessageLocalId: 'local-recovery' },
      );

      await awaitPhase('second Agent SDK launch', secondLaunchStarted.promise);
      await expect(awaitPhase('second prompt', secondPromptOutcome.promise)).resolves.toEqual({
        status: 'fulfilled',
        message: 'CARRY-OVER\n\nrecovery prompt',
      });
    } finally {
      await awaitPhase('launcher shutdown', Promise.all([
        Promise.resolve(switchHandler({ to: 'local' })),
        session.cleanup(),
        launcherPromise,
      ]));
    }
  }, 60_000);

  it('keeps the active Agent SDK runtime when a later queued prompt selects unified terminal', async () => {
    const awaitPhase = async <T>(label: string, promise: Promise<T>): Promise<T> => {
      let timeout: ReturnType<typeof setTimeout> | null = null;
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 5_000);
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    };
    const { session, switchHandlerReady } = createHarness();
    const firstPromptConsumed = createDeferred<void>();
    const secondPromptOutcome = createDeferred<Readonly<{
      runtime: 'agentSdk' | 'unifiedTerminal';
      message: string | null;
    }>>();

    mockClaudeRemoteAgentSdk.mockImplementationOnce(async (opts: Readonly<{
      nextMessage: () => Promise<Readonly<{ message: string }> | null>;
    }>) => {
      await expect(opts.nextMessage()).resolves.toEqual(expect.objectContaining({ message: 'initial SDK prompt' }));
      firstPromptConsumed.resolve(undefined);
      const next = await opts.nextMessage();
      if (next) {
        secondPromptOutcome.resolve({ runtime: 'agentSdk', message: next.message });
      }
    });
    mockRunClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: Readonly<{
      nextMessage: () => Promise<Readonly<{ message: string }> | null>;
    }>) => {
      const next = await opts.nextMessage();
      secondPromptOutcome.resolve({ runtime: 'unifiedTerminal', message: next?.message ?? null });
    });

    session.queue.push(
      'initial SDK prompt',
      {
        permissionMode: 'default',
        claudeRemoteAgentSdkEnabled: true,
        claudeUnifiedTerminalEnabled: false,
      },
      { userMessageLocalId: 'local-sdk-initial' },
    );

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);
    const switchHandler = await switchHandlerReady;
    try {
      await awaitPhase('initial Agent SDK prompt', firstPromptConsumed.promise);
      session.queue.push(
        'prompt after account runtime change',
        {
          permissionMode: 'default',
          claudeRemoteAgentSdkEnabled: true,
          claudeUnifiedTerminalEnabled: true,
        },
        { userMessageLocalId: 'local-after-runtime-change' },
      );

      await expect(awaitPhase('second prompt dispatch', secondPromptOutcome.promise)).resolves.toEqual({
        runtime: 'agentSdk',
        message: 'prompt after account runtime change',
      });
      expect(mockClaudeRemoteAgentSdk).toHaveBeenCalledTimes(1);
      expect(mockRunClaudeUnifiedTerminalSession).not.toHaveBeenCalled();
    } finally {
      await awaitPhase('launcher shutdown', Promise.all([
        Promise.resolve(switchHandler({ to: 'local' })),
        session.cleanup(),
        launcherPromise,
      ]));
    }
  }, 60_000);

  describe('idle provider exit', () => {
    const previousIdleExitMs = process.env.HAPPIER_CLAUDE_REMOTE_IDLE_EXIT_MS;
    const idleExitMs = 50;

    beforeEach(() => {
      process.env.HAPPIER_CLAUDE_REMOTE_IDLE_EXIT_MS = String(idleExitMs);
      reloadConfiguration();
    });

    afterEach(() => {
      if (previousIdleExitMs === undefined) delete process.env.HAPPIER_CLAUDE_REMOTE_IDLE_EXIT_MS;
      else process.env.HAPPIER_CLAUDE_REMOTE_IDLE_EXIT_MS = previousIdleExitMs;
      reloadConfiguration();
    });

    const agentSdkMode = {
      permissionMode: 'default',
      claudeRemoteAgentSdkEnabled: true,
      claudeUnifiedTerminalEnabled: false,
    } as const;

    type LaunchRecord = { sessionId: unknown; firstMessage: string | null; idleNext: 'pending' | 'ended' | 'message' };

    // The Agent SDK runner owns the Claude child process. Each launch reads its prompts through the
    // real launcher `nextMessage`; returning from the runner is the child exiting.
    function recordLaunches(): LaunchRecord[] {
      const launches: LaunchRecord[] = [];
      mockClaudeRemoteAgentSdk.mockImplementation(async (opts: Readonly<{
        sessionId?: unknown;
        nextMessage: () => Promise<Readonly<{ message: string }> | null>;
      }>) => {
        const launch: LaunchRecord = { sessionId: opts.sessionId, firstMessage: null, idleNext: 'pending' };
        launches.push(launch);
        launch.firstMessage = (await opts.nextMessage())?.message ?? null;
        const next = await opts.nextMessage();
        launch.idleNext = next ? 'message' : 'ended';
      });
      return launches;
    }

    // The harness client omits the optional turn query; the production SessionClient implements it,
    // and idle exit treats a missing answer as busy.
    function markCanonicalTurnIdle(session: Session): void {
      Object.assign(session.client, { hasActiveCanonicalTurn: () => false });
    }

    it('stops an idle provider child and resumes the same Claude session on the next prompt', async () => {
      const { session, switchHandlerReady } = createHarness();
      markCanonicalTurnIdle(session);
      const launches = recordLaunches();
      session.queue.push('first prompt', agentSdkMode, { userMessageLocalId: 'idle-first' });

      const launcher = claudeRemoteLauncher(session);
      const switchHandler = await switchHandlerReady;
      try {
        await vi.waitFor(() => expect(launches[0]?.idleNext).toBe('ended'), { timeout: 2_000 });
        // No child is spawned again until a prompt arrives.
        await new Promise<void>((resolve) => setTimeout(resolve, idleExitMs * 4));
        expect(launches).toHaveLength(1);

        session.queue.push('after idle', agentSdkMode, { userMessageLocalId: 'idle-second' });

        await vi.waitFor(() => expect(launches[1]?.firstMessage).toBe('after idle'), { timeout: 2_000 });
        expect(launches[0]).toMatchObject({ sessionId: 'claude-current', firstMessage: 'first prompt' });
        expect(launches[1]?.sessionId).toBe('claude-current');
      } finally {
        await Promise.all([Promise.resolve(switchHandler({ to: 'local' })), session.cleanup(), launcher]);
      }
    }, 30_000);

    it('keeps the provider child alive while a background task is still running', async () => {
      const { session, switchHandlerReady } = createHarness();
      markCanonicalTurnIdle(session);
      session.onSessionFound('claude-current');
      expect(session.getProviderTaskActivityLedger()?.apply({
        type: 'started',
        sessionId: 'claude-current',
        taskId: 'background-agent',
      })).toBe(true);
      const launches = recordLaunches();
      session.queue.push('start background work', agentSdkMode, { userMessageLocalId: 'busy-first' });

      const launcher = claudeRemoteLauncher(session);
      const switchHandler = await switchHandlerReady;
      try {
        await vi.waitFor(() => expect(launches[0]?.firstMessage).toBe('start background work'));
        await new Promise<void>((resolve) => setTimeout(resolve, idleExitMs * 6));
        expect(launches).toHaveLength(1);
        expect(launches[0]?.idleNext).toBe('pending');

        session.queue.push('check on it', agentSdkMode, { userMessageLocalId: 'busy-second' });
        await vi.waitFor(() => expect(launches[0]?.idleNext).toBe('message'));
        expect(launches).toHaveLength(1);
      } finally {
        await Promise.all([Promise.resolve(switchHandler({ to: 'local' })), session.cleanup(), launcher]);
      }
    }, 30_000);

    it('measures idle time from the end of the turn when the provider waits for input mid-turn', async () => {
      const turnIdleExitMs = 300;
      process.env.HAPPIER_CLAUDE_REMOTE_IDLE_EXIT_MS = String(turnIdleExitMs);
      reloadConfiguration();
      const { session, switchHandlerReady } = createHarness();
      markCanonicalTurnIdle(session);
      const turnEnd = createDeferred<void>();
      let idleNext: 'pending' | 'ended' | 'message' = 'pending';
      let turnEndedAt = 0;
      let endedAt = 0;
      // Like the Agent SDK pump, ask for the next prompt while the first turn is still running.
      mockClaudeRemoteAgentSdk.mockImplementation(async (opts: Readonly<{
        nextMessage: () => Promise<Readonly<{ message: string }> | null>;
      }>) => {
        await opts.nextMessage();
        session.onThinkingChange(true);
        void turnEnd.promise.then(() => {
          turnEndedAt = Date.now();
          session.onThinkingChange(false);
        });
        const next = await opts.nextMessage();
        endedAt = Date.now();
        idleNext = next ? 'message' : 'ended';
      });
      session.queue.push('long turn', agentSdkMode, { userMessageLocalId: 'turn-first' });

      const launcher = claudeRemoteLauncher(session);
      const switchHandler = await switchHandlerReady;
      try {
        await new Promise<void>((resolve) => setTimeout(resolve, turnIdleExitMs * 0.8));
        turnEnd.resolve(undefined);
        await vi.waitFor(() => expect(idleNext).toBe('ended'), { timeout: 5_000 });
        expect(endedAt - turnEndedAt).toBeGreaterThanOrEqual(turnIdleExitMs - 20);
      } finally {
        await Promise.all([Promise.resolve(switchHandler({ to: 'local' })), session.cleanup(), launcher]);
      }
    }, 30_000);

    it('keeps the provider child alive while file checkpoints exist only in that runner', async () => {
      const { session, switchHandlerReady } = createHarness();
      markCanonicalTurnIdle(session);
      const launches = recordLaunches();
      session.queue.push('edit with checkpoints', { ...agentSdkMode, claudeRemoteEnableFileCheckpointing: true },
        { userMessageLocalId: 'checkpoint-first' });

      const launcher = claudeRemoteLauncher(session);
      const switchHandler = await switchHandlerReady;
      try {
        await vi.waitFor(() => expect(launches[0]?.firstMessage).toBe('edit with checkpoints'));
        await new Promise<void>((resolve) => setTimeout(resolve, idleExitMs * 6));
        expect(launches).toHaveLength(1);
        expect(launches[0]?.idleNext).toBe('pending');
      } finally {
        await Promise.all([Promise.resolve(switchHandler({ to: 'local' })), session.cleanup(), launcher]);
      }
    }, 30_000);

    it('keeps the provider child alive after Claude scheduled its own wakeup', async () => {
      const { session, switchHandlerReady } = createHarness();
      markCanonicalTurnIdle(session);
      let idleNext: 'pending' | 'ended' | 'message' = 'pending';
      mockClaudeRemoteAgentSdk.mockImplementation(async (opts: Readonly<{
        nextMessage: () => Promise<Readonly<{ message: string }> | null>;
        onMessage: (message: unknown) => void;
      }>) => {
        await opts.nextMessage();
        // A session cron or /loop wakeup lives inside the Claude child; stopping it would drop it.
        opts.onMessage({
          type: 'assistant',
          message: {
            id: 'msg-cron',
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu-cron', name: 'CronCreate', input: { cron: '*/5 * * * *', prompt: 'check' } }],
          },
          parent_tool_use_id: null,
          session_id: 'claude-current',
          uuid: 'assistant-cron',
        });
        const next = await opts.nextMessage();
        idleNext = next ? 'message' : 'ended';
      });
      session.queue.push('watch every 5 minutes', agentSdkMode, { userMessageLocalId: 'cron-first' });

      const launcher = claudeRemoteLauncher(session);
      const switchHandler = await switchHandlerReady;
      try {
        await new Promise<void>((resolve) => setTimeout(resolve, idleExitMs * 6));
        expect(idleNext).toBe('pending');
        expect(mockClaudeRemoteAgentSdk).toHaveBeenCalledTimes(1);
      } finally {
        await Promise.all([Promise.resolve(switchHandler({ to: 'local' })), session.cleanup(), launcher]);
      }
    }, 30_000);
  });
});
