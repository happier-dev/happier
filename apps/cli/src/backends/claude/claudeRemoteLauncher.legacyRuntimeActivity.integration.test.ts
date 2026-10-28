import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fs from 'node:fs';
import { ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import psList from 'ps-list';

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
import { completedNativeChildTranscript } from './workflows/claudeWorkflowActivitySource.testkit';
import type { SessionWorkflowRunSnapshotV1 } from '@happier-dev/protocol';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { SessionHookData } from './utils/startHookServer';
import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';
import type { SessionTurnMutationV1 } from '@/api/session/mutations/sessionMutationTypes';
import { waitForProcessExit } from '@/testkit/process/spawn';
import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';

const mockQuery = vi.hoisted(() => vi.fn());
const mockClaudeRemote = vi.hoisted(() => vi.fn());
const mockClaudeRemoteAgentSdk = vi.hoisted(() => vi.fn());
const mockRunClaudeUnifiedTerminalSession = vi.hoisted(() => vi.fn());
const notifyDaemonSessionStarted = vi.hoisted(() => vi.fn(async () => ({})));

// Process enumeration is an OS boundary. All tests retain the real implementation unless explicitly denied.
vi.mock('ps-list', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ps-list')>();
  return { default: vi.fn(actual.default) };
});

// Replace only the OS filesystem operation; keep Session identity and launcher recovery real.
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, statSync: vi.fn(actual.statSync) };
});

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

  it.each(['before launch', 'during launch'] as const)('exits once without consuming input when transcript inspection is denied for an identity observed %s', async observation => {
    const { session } = createHarness(undefined, { providerSessionId: null });
    const transcriptDir = await mkdtemp(join(tmpdir(), 'claude-denied-resume-'));
    const transcriptPath = join(transcriptDir, 'claude-observed.jsonl');
    const observeIdentity = async () => {
      session.onSessionFound('claude-observed', { transcript_path: transcriptPath });
      await session.drainCriticalMetadataWrites({ timeoutMs: 500 });
    };
    const echoSeedStarted = createDeferred<void>();
    const finishEchoSeed = createDeferred<void>();
    if (observation === 'before launch') {
      await observeIdentity();
    } else {
      Object.assign(session.client, {
        fetchRecentTranscriptTextItemsForAcpImport: vi.fn(async () => {
          // This transport read runs after launch-start identity capture, before the resume decision.
          echoSeedStarted.resolve(undefined);
          await finishEchoSeed.promise;
          return [];
        }),
      });
    }
    const denied = Object.assign(new Error('Transcript access denied'), { code: 'EACCES' });
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const stat = vi.mocked(fs.statSync).mockImplementation((...args) => {
      if (args[0] === transcriptPath) throw denied;
      return Reflect.apply(actualFs.statSync, actualFs, args);
    });
    const termination = new AbortController();
    let launchErrors = 0;
    const originalInfoFile = logger.infoFile.bind(logger);
    const infoFile = vi.spyOn(logger, 'infoFile').mockImplementation((...args) => {
      originalInfoFile(...args);
      if (args[0] === '[remote]: launch error' && ++launchErrors > 1) {
        // Bound a regressed busy loop without replacing its recovery decision or adding a timer.
        termination.abort('repeated-transcript-inspection-failure');
      }
    });
    session.queue.push('continue the observed conversation', {
      permissionMode: 'default', claudeRemoteAgentSdkEnabled: true, claudeUnifiedTerminalEnabled: false,
    }, { userMessageLocalId: 'denied-resume-input' });

    try {
      const launcher = claudeRemoteLauncher(session, { signal: termination.signal });
      if (observation === 'during launch') {
        await echoSeedStarted.promise;
        await observeIdentity();
        finishEchoSeed.resolve(undefined);
      }
      await expect(launcher).resolves.toBe('exit');
      expect(launchErrors).toBe(1);
      expect(termination.signal.aborted).toBe(false);
      expect(session.sessionId).toBe('claude-observed');
      expect(session.transcriptPath).toBe(transcriptPath);
      expect(session.queue.size()).toBe(1);
      expect(mockClaudeRemoteAgentSdk).not.toHaveBeenCalled();
      expect(infoFile).toHaveBeenCalledWith('[remote]: launch error', expect.objectContaining({
        error: expect.stringContaining('ClaudeResumeSessionUnavailableError'),
        disposition: 'preserve-resume-and-exit',
      }));
      expect(session.client.sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'message', message: expect.stringContaining('transcript is unavailable'),
      }));
    } finally {
      finishEchoSeed.resolve(undefined);
      stat.mockImplementation(actualFs.statSync);
      infoFile.mockRestore();
      await rm(transcriptDir, { recursive: true, force: true });
    }
  });

  it('keeps SDK presentation-only model annotations out of Running metadata', async () => {
    const { session, switchHandlerReady } = createHarness(undefined, { providerSessionId: null });
    Object.assign(session.client, {
      getStoredContentEncryptionContext: () => ({ mode: 'plain' }),
      upsertSessionSystemRecord: async () => {},
    });
    const finishQuery = createDeferred<void>();
    let queryIdle = false;
    const createQuery: NonNullable<Parameters<typeof actualClaudeRemoteAgentSdk.claudeRemoteAgentSdk>[0]['createQuery']> = () => ({
      // Only the external SDK query is replaced. The launcher, stream projection,
      // effective-model owner and Session metadata remain real.
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', model: 'claude-requested', session_id: 'model-proof-session' };
        yield { type: 'result', subtype: 'success', is_error: false, result: 'Result-only response' };
        queryIdle = true;
        await finishQuery.promise;
      },
      close: () => finishQuery.resolve(undefined),
      setPermissionMode: async () => {}, setModel: async () => {}, setMaxThinkingTokens: async () => {},
      supportedCommands: async () => [], supportedModels: async () => [],
    } as unknown as Query);
    mockClaudeRemoteAgentSdk.mockImplementation((opts: Parameters<typeof actualClaudeRemoteAgentSdk.claudeRemoteAgentSdk>[0]) => (
      actualClaudeRemoteAgentSdk.claudeRemoteAgentSdk({ ...opts, claudeExecutablePath: '/tmp/claude', createQuery })
    ));
    session.queue.push('hello', {
      permissionMode: 'default', model: 'sonnet', reasoningEffort: 'low',
      claudeRemoteAgentSdkEnabled: true, claudeUnifiedTerminalEnabled: false,
    }, { userMessageLocalId: 'model-proof-input' });
    const launcher = claudeRemoteLauncher(session);
    const switchHandler = await switchHandlerReady;
    try {
      await vi.waitFor(() => expect(queryIdle).toBe(true));
      expect(session.client.getMetadataSnapshot()?.sessionAppliedModelV1).toBeUndefined();
    } finally {
      finishQuery.resolve(undefined);
      await Promise.all([Promise.resolve(switchHandler({ to: 'local' })), session.cleanup(), launcher]);
    }
  });

  it('starts a fresh Claude session for the first remote message when the observed terminal id never materialized', async () => {
    const { session, switchHandlerReady } = createHarness(undefined, { providerSessionId: null });
    Object.assign(session.client, {
      getStoredContentEncryptionContext: () => ({ mode: 'plain' }),
      upsertSessionSystemRecord: async () => {},
    });
    const finishQuery = createDeferred<void>();
    let queryIdle = false;
    let receivedPrompt: unknown;
    const createQuery: NonNullable<Parameters<typeof actualClaudeRemoteAgentSdk.claudeRemoteAgentSdk>[0]['createQuery']> = ({ prompt, options }) => ({
      // Only the external SDK query is replaced. The launcher, start-plan resolution and
      // Session identity owner run for real, so a ghost resume id would fail before this
      // query ever starts.
      async *[Symbol.asyncIterator]() {
        expect(options?.resume).toBeUndefined();
        if (typeof prompt === 'string') {
          receivedPrompt = prompt;
        } else {
          const first = await prompt[Symbol.asyncIterator]().next();
          if (first.done) throw new Error('Expected the first queued remote prompt');
          receivedPrompt = first.value.message.content;
        }
        yield { type: 'system', subtype: 'init', model: 'claude-requested', session_id: 'claude-fresh-start' };
        yield { type: 'result', subtype: 'success', is_error: false, result: 'First remote message handled' };
        queryIdle = true;
        await finishQuery.promise;
      },
      close: () => finishQuery.resolve(undefined),
      setPermissionMode: async () => {}, setModel: async () => {}, setMaxThinkingTokens: async () => {},
      supportedCommands: async () => [], supportedModels: async () => [],
    } as unknown as Query);
    mockClaudeRemoteAgentSdk.mockImplementation((opts: Parameters<typeof actualClaudeRemoteAgentSdk.claudeRemoteAgentSdk>[0]) => (
      actualClaudeRemoteAgentSdk.claudeRemoteAgentSdk({ ...opts, claudeExecutablePath: '/tmp/claude', createQuery })
    ));
    const transcriptDir = await mkdtemp(join(tmpdir(), 'claude-zero-turn-takeover-'));
    const infoFile = vi.spyOn(logger, 'infoFile');
    try {
      // Zero-turn terminal birth: the SessionStart hook observed an id whose transcript
      // never materialized (no turn ran locally before the App took over).
      session.onSessionFound('claude-ghost', {
        transcript_path: join(transcriptDir, 'claude-ghost.jsonl'),
      } as SessionHookData);
      await session.drainCriticalMetadataWrites({ timeoutMs: 500 });
      session.queue.push('first message from the app', {
        permissionMode: 'default',
        claudeRemoteAgentSdkEnabled: true, claudeUnifiedTerminalEnabled: false,
      }, { userMessageLocalId: 'zero-turn-input' });
      const launcher = claudeRemoteLauncher(session);
      const switchHandler = await switchHandlerReady;
      try {
        await vi.waitFor(() => expect(queryIdle).toBe(true));
        expect(JSON.stringify(receivedPrompt)).toContain('first message from the app');
        expect(infoFile).not.toHaveBeenCalledWith('[remote]: launch error', expect.objectContaining({
          error: expect.stringContaining('ClaudeResumeSessionUnavailableError'),
        }));
        expect(session.client.sendSessionEvent).not.toHaveBeenCalledWith(expect.objectContaining({
          type: 'message',
          message: expect.stringContaining('transcript is unavailable'),
        }));
      } finally {
        finishQuery.resolve(undefined);
        await Promise.all([Promise.resolve(switchHandler({ to: 'local' })), session.cleanup(), launcher]);
      }
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

  it.each([false, true])('surfaces idle process cleanup failure and exits without replacement when issue publication fails: %s', async (publicationFails) => {
    const { session } = createHarness();
    const transcriptDir = await mkdtemp(join(tmpdir(), 'claude-cleanup-health-'));
    session.transcriptPath = join(transcriptDir, 'claude-current.jsonl');
    await writeFile(session.transcriptPath, JSON.stringify({ type: 'user', uuid: 'previous-prompt', sessionId: 'claude-current',
      message: { role: 'user', content: 'previous prompt' } }) + '\n');
    const mutations: SessionTurnMutationV1[] = [];
    const lifecycle = createSessionTurnLifecycle({
      sessionId: session.client.sessionId,
      // The durable session mutation transport is the boundary; classification and lifecycle stay real.
      enqueueSessionTurn: async (mutation) => {
        mutations.push(mutation);
        if (publicationFails && mutation.action === 'fail') throw new Error('Session mutation transport unavailable');
      },
    });
    const markerWrites: Promise<void>[] = [];
    Object.assign(session.client, { sessionTurnLifecycle: lifecycle,
      // Mirror SessionClient's transport boundary by forwarding markers to the real lifecycle owner.
      sendAgentMessage: (provider: ACPProvider, body: ACPMessageData) => {
        const marker = lifecycle.observeAcpLifecycleMarker({ provider, body });
        if (marker.pendingWrite) markerWrites.push(marker.pendingWrite);
      },
      getStoredContentEncryptionContext: () => ({ mode: 'plain' }), upsertSessionSystemRecord: async () => {} });
    const queryIdle = createDeferred<void>();
    const finishQuery = createDeferred<void>();
    const children: ChildProcess[] = [];
    const infoFile = vi.spyOn(logger, 'infoFile');
    let queryStarts = 0;
    const createQuery: NonNullable<Parameters<typeof actualClaudeRemoteAgentSdk.claudeRemoteAgentSdk>[0]['createQuery']> = ({ prompt, options }) => {
      queryStarts += 1;
      const spawnProcess = options?.spawnClaudeCodeProcess;
      if (typeof spawnProcess !== 'function') throw new Error('Expected SDK owned-process boundary');
      const owned: unknown = spawnProcess({ command: process.execPath, args: [], env: process.env });
      if (!(owned instanceof ChildProcess) || !owned.stdout) throw new Error('Expected real owned fixture child');
      children.push(owned);
      const childReady = once(owned.stdout, 'data');
      return {
        async *[Symbol.asyncIterator]() {
          await childReady;
          if (typeof prompt === 'string') throw new Error('Expected SDK prompt stream');
          const first = await prompt[Symbol.asyncIterator]().next();
          if (first.done) throw new Error('Expected first queued prompt');
          yield { ...first.value, session_id: 'claude-current' };
          yield { type: 'result', subtype: 'success', is_error: false, result: 'Turn completed', session_id: 'claude-current' };
          queryIdle.resolve(undefined);
          await finishQuery.promise;
        },
        // SDK close can finish before its owned child exits. Canonical cleanup must still run.
        close: () => {},
        setPermissionMode: async () => {}, setModel: async () => {}, setMaxThinkingTokens: async () => {},
        supportedCommands: async () => [], supportedModels: async () => [],
      } as unknown as Query;
    };
    mockClaudeRemoteAgentSdk.mockImplementation((opts: Parameters<typeof actualClaudeRemoteAgentSdk.claudeRemoteAgentSdk>[0]) => (
      actualClaudeRemoteAgentSdk.claudeRemoteAgentSdk({ ...opts, claudeExecutablePath: '/tmp/claude', createQuery,
        spawnClaudeCodeProcess: () => spawn(process.execPath, ['-e', "console.log('ready'); setInterval(() => {}, 1000)"], { stdio: 'pipe' }),
      })
    ));
    const mode = { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true, claudeUnifiedTerminalEnabled: false } as const;
    session.queue.push('complete before cleanup', mode, { userMessageLocalId: 'cleanup-health-input' });
    let restoreEnumeration = () => {};
    const launcher = claudeRemoteLauncher(session);
    try {
      await queryIdle.promise;
      await Promise.all(markerWrites);
      expect(lifecycle.hasActiveTurn()).toBe(false);
      const originalEnumeration = vi.mocked(psList).getMockImplementation();
      if (!originalEnumeration) throw new Error('Expected real process enumeration default');
      vi.mocked(psList).mockRejectedValue(new Error('Private process-list failure'));
      restoreEnumeration = () => { vi.mocked(psList).mockImplementation(originalEnumeration); };
      finishQuery.resolve(undefined);
      await expect(launcher).resolves.toBe('exit');
      expect(infoFile).toHaveBeenCalledWith('[process-tree] Owned process cleanup could not be verified', {
        code: 'process_tree_termination_incomplete', discoveryFailed: true, probeFailed: false, signallingFailed: false,
      });
      expect(mutations.find(mutation => mutation.action === 'fail')).toMatchObject({
        provider: 'claude', issue: { scope: 'primary_session', status: 'failed', source: 'provider_session_error' },
      });
      expect(session.sessionId).toBe('claude-current');
      expect(queryStarts).toBe(1);
      expect(session.client.discardPendingMessageQueueV2All).not.toHaveBeenCalled();
      expect(session.client.blockPendingMessageDelivery).not.toHaveBeenCalled();
      if (publicationFails) {
        expect(infoFile).toHaveBeenCalledWith('[remote]: failed to record unverified provider termination runtime issue', expect.any(Object));
      }
    } finally {
      restoreEnumeration();
      finishQuery.resolve(undefined);
      for (const owned of children) {
        owned.kill('SIGKILL');
        if (owned.pid) await waitForProcessExit(owned.pid);
      }
      await session.cleanup();
      await launcher;
      infoFile.mockRestore();
      await rm(transcriptDir, { recursive: true, force: true });
    }
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
});
