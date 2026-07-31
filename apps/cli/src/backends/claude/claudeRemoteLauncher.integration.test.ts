import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SessionClientPort } from '@/api/session/sessionClientPort';
import type { Metadata } from '@/api/types';
import type { TerminalRuntimeFlags } from '@/terminal/runtime/terminalRuntimeFlags';
import type { startRemoteModeStaticControl as startRemoteModeStaticControlFn } from '@/ui/remoteControl/remoteModeControl';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { CHANGE_TITLE_INSTRUCTION } from '@/agent/runtime/changeTitleInstruction';
import { Session } from './session';
import type { EnhancedMode } from './loop';
import { hashClaudeEnhancedModeForQueue } from './remote/modeHash';
import { readFile } from 'node:fs/promises';
import { accountSettingsParse } from '@happier-dev/protocol';
import { setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { AgentState } from '@/api/types';
import type { SessionProviderInputConsumerOptions } from '@/agent/runtime/sessionInput/SessionProviderInputConsumer';
import { ClaudeUnifiedTerminalReadinessTimeoutError } from './unifiedTerminal/createClaudeUnifiedTerminalReadinessBridge';
import { ClaudeUnifiedTerminalInjectionFailureError } from './unifiedTerminal/terminalInjectionFailureError';
import { createFakeControlPort } from './unifiedTerminal/tuiControls/fakeControlPort';
import { parseClaudeScreenState } from './unifiedTerminal/tuiControls/screenState';

vi.mock('@/agent/runtime/createHappierMcpBridge', () => ({
  createHappierMcpBridge: vi.fn(async () => ({
    happierMcpServer: { url: 'http://127.0.0.1:1234', stop: vi.fn() },
    mcpServers: {
      happier: {
        command: 'node',
        args: ['happier-mcp.mjs', '--url', 'http://127.0.0.1:1234'],
      },
    },
  })),
}));

type RpcHandler = (params?: any) => any | Promise<any>;
type SessionFoundHookData = NonNullable<Parameters<Session['onSessionFound']>[1]>;
type RemoteDispatchMockOptions = {
  signal?: AbortSignal;
  onSessionFound?: (sessionId: string) => void;
};
type UnifiedTerminalDispatchMockOptions = RemoteDispatchMockOptions & {
  nextMessage?: () => Promise<unknown>;
  onMessage?: (message: unknown) => void;
  onTerminalPromptInjected?: (accepted: unknown) => Promise<void>;
  onProviderPromptStarted?: () => void;
  onThinkingChange?: (thinking: boolean) => void;
};
type UnifiedTerminalDispatchDeps = {
  claudeUnifiedTerminal?: (opts: unknown) => Promise<void>;
};
type StartRemoteModeStaticControlParams = Parameters<typeof startRemoteModeStaticControlFn>[0];

const mockInkRender = vi.fn(() => ({ unmount: vi.fn() }));
vi.mock('ink', () => ({
  render: mockInkRender,
}));

const mockClaudeRemoteDispatch = vi.fn<(opts: unknown, deps?: unknown) => Promise<void>>();
vi.mock('./remote/claudeRemoteDispatch', () => ({
  claudeRemoteDispatch: mockClaudeRemoteDispatch,
}));

const RESUME_CHOICE_DIALOG = [
  'This session is 18h 2m old and 560.4k tokens.',
  'To reduce startup time, Claude can resume from the saved summary or load the full session.',
  '',
  '❯ 1. Resume from summary',
  '  2. Resume full session',
].join('\n');

const IDLE_COMPOSER = [
  '──────────────────────────────',
  '❯ ',
  '──────────────────────────────',
].join('\n');

const createSessionProviderInputConsumerSpy = vi.hoisted(() => vi.fn());
vi.mock('@/agent/runtime/sessionInput/SessionProviderInputConsumer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agent/runtime/sessionInput/SessionProviderInputConsumer')>();
  return {
    ...actual,
    createSessionProviderInputConsumer: <Mode, Message>(
      opts: SessionProviderInputConsumerOptions<Mode, Message>,
    ) => {
      createSessionProviderInputConsumerSpy(opts);
      return actual.createSessionProviderInputConsumer(opts);
    },
  };
});

const mockNotifyDaemonConnectedServiceRuntimeAuthFailure = vi.hoisted(() => vi.fn(async () => ({})));
const mockNotifyDaemonConnectedServiceQuotaSnapshot = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock('@/daemon/controlClient', () => ({
  notifyDaemonConnectedServiceRuntimeAuthFailure: mockNotifyDaemonConnectedServiceRuntimeAuthFailure,
  notifyDaemonConnectedServiceQuotaSnapshot: mockNotifyDaemonConnectedServiceQuotaSnapshot,
}));

const mockResetParentChain = vi.fn();
const mockUpdateSessionId = vi.fn();
const mockConvert = vi.fn();
const mockConvertSidechainUserMessage = vi.fn();
const mockGenerateInterruptedToolResult = vi.fn();
vi.mock('./utils/sdkToLogConverter', () => ({
  SDKToLogConverter: vi.fn().mockImplementation(() => ({
    resetParentChain: mockResetParentChain,
    updateSessionId: mockUpdateSessionId,
    convert: (...args: any[]) => mockConvert(...args),
    convertSidechainUserMessage: (...args: any[]) => mockConvertSidechainUserMessage(...args),
    generateInterruptedToolResult: (...args: any[]) => mockGenerateInterruptedToolResult(...args),
  })),
}));

vi.mock('@/integrations/watcher/startFileWatcher', () => ({
  startFileWatcher: (_file: string, onFileChange: (file: string) => void) => {
    // Match the real watcher contract ("watch + read once" consumers are race-free)
    // without spawning long-lived FS watchers in integration tests.
    onFileChange(_file);
    return () => {};
  },
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: () => undefined,
    debugLargeJson: () => undefined,
    warn: () => undefined,
  },
}));

vi.mock('@/lib', () => ({
  logger: {
    debug: () => undefined,
    debugLargeJson: () => undefined,
    warn: () => undefined,
  },
}));

type SessionClientStub = SessionClientPort & {
  agentState: AgentState;
  getAgentStateSnapshot: () => AgentState;
  rpcHandlerManager: {
    registerHandler: (method: string, handler: any) => void;
    invokeLocal: (method: string, params: unknown) => Promise<unknown>;
  };
};

type RemoteHarness = {
  session: Session;
  client: SessionClientStub;
  sendToAllDevices: ReturnType<typeof vi.fn>;
  sendClaudeSessionMessage: ReturnType<typeof vi.fn>;
  abortHandlerReady: Promise<RpcHandler>;
  switchHandlerReady: Promise<RpcHandler>;
};

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

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!signal || signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function hookWithTranscript(transcriptPath: string): SessionFoundHookData {
  return { transcript_path: transcriptPath };
}

function createRemoteHarness(options?: {
  sessionId?: string | null;
  metadata?: Metadata | null;
  applyMetadataUpdates?: boolean;
  startedBy?: 'daemon' | 'terminal';
  terminalRuntime?: TerminalRuntimeFlags | null;
  hookPluginDir?: string | null;
  defaultSystemPromptText?: string;
  claudeArgs?: string[];
}): RemoteHarness {
  const switchDeferred = createDeferred<RpcHandler>();
  const abortDeferred = createDeferred<RpcHandler>();
  const sendClaudeSessionMessage = vi.fn();
  let agentState: AgentState = { requests: Object.create(null), completedRequests: Object.create(null) };
  let metadataState = options?.metadata ?? null;

  const client: SessionClientStub = {
    sessionId: 'happy_sess_1',
    sendAgentMessage: vi.fn(),
    sendAgentMessageCommitted: vi.fn(async () => {}),
    recordClaudeJsonlMessageConsumed: vi.fn(),
    keepAlive: vi.fn(),
    sessionTurnLifecycle: {
      beginTurn: vi.fn(async () => ({ turnId: 'session-turn-1' })),
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
      observeAcpLifecycleMarker: vi.fn((input) => ({ body: input.body, pendingWrite: null })),
    },
    updateMetadata: vi.fn((updater: (current: Metadata) => Metadata) => {
      if (!options?.applyMetadataUpdates) return undefined;
      metadataState = updater((metadataState ?? {}) as Metadata);
      return undefined;
    }),
    updateAgentState: vi.fn((updater) => {
      agentState = updater(agentState);
      client.agentState = agentState;
      return undefined;
    }),
    agentState,
    getAgentStateSnapshot: () => agentState,
    rpcHandlerManager: {
      registerHandler: vi.fn((method: string, handler: any) => {
        if (method === 'abort') {
          abortDeferred.resolve(handler);
        }
        if (method === 'switch') {
          switchDeferred.resolve(handler);
        }
      }),
      invokeLocal: vi.fn(async () => ({})),
    },
    sendClaudeSessionMessage,
    deferDeliveredUserMessageWatermarkToProviderAcceptance: vi.fn(),
    confirmUserMessageDeliveredToProvider: vi.fn(),
    hasUserMessageProviderAcceptance: vi.fn(() => false),
    registerSessionRuntimeControls: vi.fn(() => vi.fn()),
    fetchRecentTranscriptTextItemsForAcpImport: vi.fn(async () => []),
    sendSessionEvent: vi.fn(),
    getMetadataSnapshot: () => metadataState,
    waitForMetadataUpdate: vi.fn(async () => false),
    popPendingMessage: vi.fn(async () => false),
    peekPendingMessageQueueV2Count: vi.fn(async () => 0),
    discardPendingMessageQueueV2All: vi.fn(async () => 0),
    discardCommittedMessageLocalIds: vi.fn(async () => 0),
    sendSessionDeath: vi.fn(),
    flush: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    on: vi.fn(),
    off: vi.fn(),
  };

  const sendToAllDevices = vi.fn();
  const session = new Session({
    client,
    pushSender: { sendToAllDevices } as any,
    path: '/tmp',
    logPath: '/tmp/log',
    sessionId: options?.sessionId ?? null,
    claudeArgs: options?.claudeArgs,
    messageQueue: new MessageQueue2<EnhancedMode>(hashClaudeEnhancedModeForQueue),
    onModeChange: () => {},
    hookSettingsPath: '/tmp/hooks.json',
    hookPluginDir: options?.hookPluginDir ?? null,
    startedBy: options?.startedBy,
    terminalRuntime: options?.terminalRuntime ?? null,
    defaultSystemPromptText: options?.defaultSystemPromptText,
  });

  createdSessions.push(session);

  return {
    session,
    client,
    sendToAllDevices,
    sendClaudeSessionMessage,
    abortHandlerReady: abortDeferred.promise,
    switchHandlerReady: switchDeferred.promise,
  };
}

	describe.sequential('claudeRemoteLauncher', () => {
	  const previousGraceMsEnv = process.env.HAPPIER_CLAUDE_REMOTE_INTERRUPT_THEN_TEARDOWN_GRACE_MS;

	  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    createSessionProviderInputConsumerSpy.mockClear();
	    // Keep integration tests fast: disable the switch/exit grace window by default.
	    // Individual tests can opt back in by setting the env var before importing the launcher.
	    process.env.HAPPIER_CLAUDE_REMOTE_INTERRUPT_THEN_TEARDOWN_GRACE_MS = '0';
	    setActiveAccountSettingsSnapshot({
	      source: 'none',
	      settings: accountSettingsParse({}),
	      settingsVersion: 0,
	      loadedAtMs: 0,
      settingsSecretsReadKeys: [],
    });
    mockConvert.mockReturnValue(null);
    mockConvertSidechainUserMessage.mockReturnValue(null);
    mockGenerateInterruptedToolResult.mockReturnValue(null);
    mockNotifyDaemonConnectedServiceQuotaSnapshot.mockReset();
    mockNotifyDaemonConnectedServiceQuotaSnapshot.mockResolvedValue({ ok: true });
    mockClaudeRemoteDispatch.mockImplementation(async (opts: unknown) => {
      const dispatchOpts = opts as RemoteDispatchMockOptions;
      await waitForAbort(dispatchOpts.signal);
	    });
	  });
	
	  afterEach(() => {
	    if (previousGraceMsEnv === undefined) {
	      delete process.env.HAPPIER_CLAUDE_REMOTE_INTERRUPT_THEN_TEARDOWN_GRACE_MS;
	    } else {
	      process.env.HAPPIER_CLAUDE_REMOTE_INTERRUPT_THEN_TEARDOWN_GRACE_MS = previousGraceMsEnv;
	    }
  });

  it('passes the concrete unified terminal runner to Claude remote dispatch', async () => {
    const harness = createRemoteHarness({
      sessionId: 'sess_unified_dispatch',
      hookPluginDir: '/tmp/hook-plugin',
    });
    const mode = {
      permissionMode: 'default',
      claudeUnifiedTerminalEnabled: true,
      claudeUnifiedTerminalHost: 'auto',
    } satisfies EnhancedMode;
    harness.session.queue.push('hello from ui', mode);
    const dispatchStarted = createDeferred<void>();

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as UnifiedTerminalDispatchMockOptions;
      dispatchStarted.resolve(undefined);
      await dispatchOpts.nextMessage?.();
      await waitForAbort(dispatchOpts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(harness.session);

    await dispatchStarted.promise;
    expect(mockClaudeRemoteDispatch.mock.calls[0]?.[0]).toMatchObject({
      hookSettingsPath: '/tmp/hooks.json',
      hookPluginDir: '/tmp/hook-plugin',
    });
    expect(mockClaudeRemoteDispatch.mock.calls[0]?.[1]).toMatchObject({
      claudeUnifiedTerminal: expect.any(Function),
    });
    const switchHandler = await harness.switchHandlerReady;
    await expect(switchHandler({ to: 'local' })).resolves.toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  });

  it('passes terminal injection failure projection into remote unified terminal dispatch', async () => {
    const harness = createRemoteHarness({ sessionId: 'sess_unified_injection_failure_projection' });
    const mode = {
      permissionMode: 'default',
      claudeUnifiedTerminalEnabled: true,
      claudeUnifiedTerminalHost: 'auto',
    } satisfies EnhancedMode;
    harness.session.queue.push('hello from ui', mode);
    const dispatchStarted = createDeferred<void>();

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as UnifiedTerminalDispatchMockOptions & {
        onTerminalInjectionFailure?: (error: unknown) => Promise<void> | void;
      };
      expect(dispatchOpts.onTerminalInjectionFailure).toBeTypeOf('function');
      dispatchStarted.resolve(undefined);
      await waitForAbort(dispatchOpts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(harness.session);

    await dispatchStarted.promise;
    const switchHandler = await harness.switchHandlerReady;
    await expect(switchHandler({ to: 'local' })).resolves.toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  });

  it('surfaces unified terminal startup readiness failures as primary turn runtime issues', async () => {
    const harness = createRemoteHarness({ sessionId: 'sess_unified_readiness_timeout' });
    const mode = {
      permissionMode: 'default',
      claudeUnifiedTerminalEnabled: true,
      claudeUnifiedTerminalHost: 'zellij',
    } satisfies EnhancedMode;
    harness.session.queue.push('hello from ui', mode);
    mockClaudeRemoteDispatch.mockImplementationOnce(async () => {
      throw new ClaudeUnifiedTerminalReadinessTimeoutError({
        timeoutMs: 250,
        handle: {
          kind: 'zellij',
          sessionName: 'happier-claude-session-test',
          paneId: '1',
          attachMetadata: {
            attachStrategy: 'terminal_host',
            topology: 'shared',
            locality: 'same_machine',
            liveProbe: 'required',
          },
        },
      });
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(harness.session);

    await vi.waitFor(() => {
      expect(harness.client.sessionTurnLifecycle?.failTurn).toHaveBeenCalled();
    }, { timeout: 2_000 });
    expect(harness.client.sessionTurnLifecycle?.failTurn).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'claude',
      issue: expect.objectContaining({
        provider: 'claude',
        source: 'provider_session_error',
        code: 'provider_session_error',
      }),
    }));

    const switchHandler = await harness.switchHandlerReady;
    await expect(switchHandler({ to: 'local' })).resolves.toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  });

  it('surfaces a failed_terminal steer injection failure and parks for the next message instead of killing the runner (incident pid-82626)', async () => {
    // Escape route under regression: a ui_pending in-flight steer is injected mid-turn, its
    // provider acceptance times out, and the arbiter escalates to failed_terminal — the unified
    // session rejects with the classified ClaudeUnifiedTerminalInjectionFailureError. The remote
    // launcher must surface a structured runtime issue and re-enter its existing
    // waitForMessageBeforeNextLaunch park loop (re-launching only on a NEW message), never
    // letting the classified error escape as a process-killing fatal rejection.
    const steerAcceptanceFailure = new ClaudeUnifiedTerminalInjectionFailureError({
      batch: {
        message: 'steered prompt never accepted',
        origin: { kind: 'ui_pending' },
      },
      result: {
        status: 'failed',
        reason: 'timeout',
        phase: 'after_enter_unknown',
        duplicateRisk: 'likely',
        recoverable: true,
      },
      failureState: 'failed_terminal',
    });
    const mode = {
      permissionMode: 'default',
      claudeUnifiedTerminalEnabled: true,
      claudeUnifiedTerminalHost: 'zellij',
    } satisfies EnhancedMode;
    const firstDispatchDone = createDeferred<void>();
    const relaunchedMessageSeen = createDeferred<any>();

    mockClaudeRemoteDispatch
      .mockImplementationOnce(async (opts: unknown) => {
        const dispatchOpts = opts as UnifiedTerminalDispatchMockOptions;
        await dispatchOpts.nextMessage?.();
        firstDispatchDone.resolve(undefined);
        throw steerAcceptanceFailure;
      })
      .mockImplementationOnce(async (opts: unknown) => {
        const dispatchOpts = opts as UnifiedTerminalDispatchMockOptions;
        relaunchedMessageSeen.resolve(await dispatchOpts.nextMessage?.());
        await waitForAbort(dispatchOpts.signal);
      });

    const harness = createRemoteHarness({ sessionId: 'sess_unified_steer_failed_terminal' });
    // Match the real client contract: waitForMetadataUpdate BLOCKS until a metadata update or
    // abort. The default harness mock resolves false immediately, which parks the input
    // consumer in its 30s defensive idle poll and would stall the post-failure relaunch wait.
    harness.client.waitForMetadataUpdate = vi.fn(
      (signal?: AbortSignal) => new Promise<boolean>((resolve) => {
        if (signal?.aborted) {
          resolve(false);
          return;
        }
        signal?.addEventListener('abort', () => resolve(false), { once: true });
      }),
    );
    harness.session.queue.push('steered prompt never accepted', mode);

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(harness.session);

    await firstDispatchDone.promise;

    // Surfaced as a structured primary runtime issue (failTurn), not a silent drop.
    await vi.waitFor(() => {
      expect(harness.client.sessionTurnLifecycle?.failTurn).toHaveBeenCalled();
    }, { timeout: 2_000 });
    expect(harness.client.sessionTurnLifecycle?.failTurn).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'claude',
      issue: expect.objectContaining({
        provider: 'claude',
        source: 'provider_session_error',
        code: 'provider_session_error',
      }),
    }));

    // Parked: no eager relaunch without a new message.
    expect(mockClaudeRemoteDispatch).toHaveBeenCalledTimes(1);

    // A new queued message re-enters the SAME launch loop and is delivered to the relaunch.
    harness.session.queue.push('hello again after failure', mode);
    const relaunched = await relaunchedMessageSeen.promise;
    expect(relaunched?.message).toContain('hello again after failure');
    expect(mockClaudeRemoteDispatch).toHaveBeenCalledTimes(2);

    // The launcher never rejects with the classified error; it stays alive until switch/exit.
    const switchHandler = await harness.switchHandlerReady;
    await expect(switchHandler({ to: 'local' })).resolves.toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  }, 30_000);

  it('stops repeated classified unified relaunches after the bounded budget and leaves the requeued batch redeliverable', async () => {
    const injectionFailure = new ClaudeUnifiedTerminalInjectionFailureError({
      batch: {
        message: 'poison prompt',
        origin: { kind: 'ui_pending' },
      },
      result: {
        status: 'failed',
        reason: 'timeout',
        phase: 'after_enter_unknown',
        duplicateRisk: 'likely',
        recoverable: true,
      },
      failureState: 'failed_terminal',
    });
    const mode = {
      permissionMode: 'default',
      claudeUnifiedTerminalEnabled: true,
      claudeUnifiedTerminalHost: 'zellij',
    } satisfies EnhancedMode;
    const harness = createRemoteHarness({ sessionId: 'sess_unified_relaunch_budget' });
    harness.client.waitForMetadataUpdate = vi.fn(
      (signal?: AbortSignal) => new Promise<boolean>((resolve) => {
        if (signal?.aborted) {
          resolve(false);
          return;
        }
        signal?.addEventListener('abort', () => resolve(false), { once: true });
      }),
    );
    harness.session.queue.push('poison prompt', mode, { userMessageSeq: 44 });

    mockClaudeRemoteDispatch.mockImplementation(async (opts: unknown) => {
      const dispatchOpts = opts as UnifiedTerminalDispatchMockOptions & {
        returnUnconsumedMessage?: (batch: { message: string; mode: EnhancedMode; maxUserMessageSeq?: number | null }) => void;
      };
      const batch = await dispatchOpts.nextMessage?.() as { message?: string; mode?: EnhancedMode; maxUserMessageSeq?: number | null } | null;
      if (batch?.message && batch.mode) {
        dispatchOpts.returnUnconsumedMessage?.({
          message: batch.message,
          mode: batch.mode,
          maxUserMessageSeq: batch.maxUserMessageSeq ?? null,
        });
      }
      throw injectionFailure;
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');

    await expect(claudeRemoteLauncher(harness.session)).resolves.toBe('exit');

    expect(mockClaudeRemoteDispatch).toHaveBeenCalledTimes(4);
    expect(harness.session.queue.queue).toHaveLength(1);
    expect(harness.session.queue.queue[0]).toMatchObject({
      message: 'poison prompt',
      userMessageSeq: 44,
    });
    expect(harness.client.sendSessionEvent).toHaveBeenCalledWith({
      type: 'message',
      message: expect.stringContaining('Not retrying automatically'),
    });
  }, 30_000);

  it('passes the resolved default coding prompt to remote unified terminal dispatch', async () => {
    const harness = createRemoteHarness({
      sessionId: 'sess_unified_default_prompt',
      defaultSystemPromptText: 'Resolved default coding prompt',
    });
    const mode = {
      permissionMode: 'default',
      claudeUnifiedTerminalEnabled: true,
      claudeUnifiedTerminalHost: 'auto',
    } satisfies EnhancedMode;
    harness.session.queue.push('hello from ui', mode);
    const dispatchStarted = createDeferred<void>();

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as UnifiedTerminalDispatchMockOptions;
      dispatchStarted.resolve(undefined);
      await waitForAbort(dispatchOpts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(harness.session);

    await dispatchStarted.promise;
    expect(mockClaudeRemoteDispatch.mock.calls[0]?.[0]).toMatchObject({
      systemPromptText: 'Resolved default coding prompt',
    });
    const switchHandler = await harness.switchHandlerReady;
    await expect(switchHandler({ to: 'local' })).resolves.toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  });

  it('passes the Happy session id to the unified terminal runner for local attach metadata', async () => {
    const harness = createRemoteHarness({ sessionId: 'claude_vendor_session' });
    const mode = {
      permissionMode: 'default',
      claudeUnifiedTerminalEnabled: true,
      claudeUnifiedTerminalHost: 'auto',
    } satisfies EnhancedMode;
    harness.session.queue.push('hello from ui', mode);
    const runnerCalled = createDeferred<void>();
    const runnerSignal = new AbortController();
    const persistTerminalHostAttachmentInfo = vi.fn(async () => {});

    let queuedPromptConsumed = false;

    mockClaudeRemoteDispatch.mockImplementationOnce(async (_opts: unknown, deps: unknown) => {
      const unified = (deps as UnifiedTerminalDispatchDeps).claudeUnifiedTerminal;
      expect(unified).toEqual(expect.any(Function));
      await unified?.({
        path: '/workspace/project',
        sessionId: null,
        transcriptPath: '/tmp/claude-unified-transcript.jsonl',
        signal: runnerSignal.signal,
        nextMessage: async () => {
          if (queuedPromptConsumed) return null;
          queuedPromptConsumed = true;
          return {
            message: 'hello from ui',
            mode,
          };
        },
        resolveHostAdapter: async () => ({
          status: 'resolved',
          reason: 'test',
          adapter: {
            kind: 'tmux',
            createOrAttachHost: vi.fn(async () => ({
              kind: 'tmux',
              sessionName: 'happier-claude-session-test',
              paneId: 'unified-window',
              attachMetadata: {
                attachStrategy: 'terminal_host',
                topology: 'shared',
                locality: 'same_machine',
                liveProbe: 'required',
              },
            })),
            injectUserPrompt: vi.fn(async (_handle, input) => {
              runnerSignal.abort();
              return { status: 'injected', at: Date.now(), bytesWritten: input.text.length };
            }),
            evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
            captureInputState: vi.fn(async () => ({
              stable: true,
              currentInput: 'What would you like to work on?\n> ',
              observedAt: Date.now(),
            })),
            interruptTurn: vi.fn(async () => {}),
            dispose: vi.fn(async () => {}),
          },
        }),
        buildSpawn: async () => ({
          spawnArgv: ['/bin/claude'],
          spawnEnv: {},
        }),
        createSessionName: () => 'happier-claude-session-test',
        persistTerminalHostAttachmentInfo,
      });
      runnerCalled.resolve(undefined);
      await waitForAbort((_opts as RemoteDispatchMockOptions).signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(harness.session);

    await runnerCalled.promise;
    expect(persistTerminalHostAttachmentInfo).toHaveBeenCalledWith({
      sessionId: 'happy_sess_1',
      terminal: {
        mode: 'tmux',
        tmux: {
          target: 'happier-claude-session-test:unified-window',
        },
      },
    });

    const switchHandler = await harness.switchHandlerReady;
    await expect(switchHandler({ to: 'local' })).resolves.toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  });

  it('defers unified terminal turn start until terminal prompt injection succeeds', async () => {
    const harness = createRemoteHarness({ sessionId: 'sess_unified_turn_start' });
    const mode = {
      permissionMode: 'default',
      claudeUnifiedTerminalEnabled: true,
      claudeUnifiedTerminalHost: 'auto',
    } satisfies EnhancedMode;
    harness.session.queue.push('hello from ui', mode);
    const promptRead = createDeferred<void>();

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as UnifiedTerminalDispatchMockOptions;
      await dispatchOpts.nextMessage?.();
      promptRead.resolve();
      await waitForAbort(dispatchOpts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(harness.session);

    await promptRead.promise;
    expect(harness.client.sessionTurnLifecycle?.beginTurn).not.toHaveBeenCalled();
    expect(harness.client.sendAgentMessage).not.toHaveBeenCalledWith('claude', expect.objectContaining({
      type: 'task_started',
    }));

    const dispatchOpts = mockClaudeRemoteDispatch.mock.calls[0]?.[0] as {
      onTerminalPromptInjected?: (accepted: unknown) => Promise<void>;
      onThinkingChange?: (thinking: boolean) => void;
    };
    expect(dispatchOpts.onTerminalPromptInjected).toEqual(expect.any(Function));
    await dispatchOpts.onTerminalPromptInjected?.({
      message: 'hello from ui',
      mode: {
        permissionMode: 'default',
        claudeUnifiedTerminalEnabled: true,
        claudeUnifiedTerminalHost: 'auto',
      },
      acceptedAs: 'new_turn',
      turnStateAtInjection: 'idle',
    });
    expect(harness.client.sessionTurnLifecycle?.beginTurn).toHaveBeenCalledTimes(1);
    expect(harness.client.sessionTurnLifecycle?.beginTurn).toHaveBeenCalledWith({ provider: 'claude' });
    expect(harness.client.sendAgentMessage).not.toHaveBeenCalledWith('claude', expect.objectContaining({
      type: 'task_started',
    }));

    dispatchOpts.onThinkingChange?.(true);
    expect(harness.client.sendAgentMessage).not.toHaveBeenCalledWith('claude', expect.objectContaining({
      type: 'task_started',
    }));

    dispatchOpts.onThinkingChange?.(false);
    expect(harness.client.sendAgentMessage).not.toHaveBeenCalledWith('claude', expect.objectContaining({
      type: 'task_complete',
    }));

    const switchHandler = await harness.switchHandlerReady;
    await expect(switchHandler({ to: 'local' })).resolves.toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  });

  it('defers the remote unified delivered watermark until provider acceptance and preserves seq on handback', async () => {
    const harness = createRemoteHarness({ sessionId: 'sess_unified_watermark_acceptance' });
    const mode = {
      permissionMode: 'default',
      claudeUnifiedTerminalEnabled: true,
      claudeUnifiedTerminalHost: 'auto',
    } satisfies EnhancedMode;
    harness.session.queue.push('watermarked remote prompt', mode, {
      userMessageSeq: 31,
      userMessageLocalId: 'remote-local-31',
    });
    const runnerCompleted = createDeferred<void>();

    const runClaudeUnifiedTerminalSession = vi.fn(async (opts: {
      nextMessage?: () => Promise<{
        message: string;
        mode: EnhancedMode;
        maxUserMessageSeq: number | null;
        userMessageLocalIds?: readonly string[] | null;
      } | null>;
      returnUnconsumedMessage?: (input: {
        message: string;
        mode: EnhancedMode;
        maxUserMessageSeq?: number | null;
        userMessageLocalIds?: readonly string[] | null;
      }) => void;
      onPromptAcceptedByProvider?: (input: {
        message: string;
        maxUserMessageSeq: number | null;
        userMessageLocalIds: readonly string[];
      }) => void;
    }) => {
      const batch = await opts.nextMessage?.();
      expect(batch).toMatchObject({
        message: 'watermarked remote prompt',
        maxUserMessageSeq: 31,
        userMessageLocalIds: ['remote-local-31'],
      });
      expect(harness.client.confirmUserMessageDeliveredToProvider).not.toHaveBeenCalled();

      opts.returnUnconsumedMessage?.({
        message: 'watermarked remote prompt',
        mode,
        maxUserMessageSeq: batch?.maxUserMessageSeq ?? null,
        userMessageLocalIds: batch?.userMessageLocalIds ?? [],
      });
      expect(harness.client.confirmUserMessageDeliveredToProvider).not.toHaveBeenCalled();

      opts.onPromptAcceptedByProvider?.({
        message: 'watermarked remote prompt',
        maxUserMessageSeq: batch?.maxUserMessageSeq ?? null,
        userMessageLocalIds: batch?.userMessageLocalIds ?? [],
      });
      runnerCompleted.resolve(undefined);
    });
    vi.doMock('./unifiedTerminal/runClaudeUnifiedTerminalSession', () => ({
      runClaudeUnifiedTerminalSession,
    }));
    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown, deps?: unknown) => {
      const dispatchDeps = deps as UnifiedTerminalDispatchDeps | undefined;
      expect(dispatchDeps?.claudeUnifiedTerminal).toEqual(expect.any(Function));
      await dispatchDeps?.claudeUnifiedTerminal?.(opts);
      await waitForAbort((opts as UnifiedTerminalDispatchMockOptions).signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(harness.session);
    vi.doUnmock('./unifiedTerminal/runClaudeUnifiedTerminalSession');

    await runnerCompleted.promise;
    expect(harness.client.deferDeliveredUserMessageWatermarkToProviderAcceptance).toHaveBeenCalledTimes(1);
    expect(harness.session.queue.queue[0]).toMatchObject({
      message: 'watermarked remote prompt',
      userMessageSeq: 31,
      userMessageLocalIds: ['remote-local-31'],
    });
    expect(harness.client.confirmUserMessageDeliveredToProvider).toHaveBeenCalledTimes(1);
    expect(harness.client.confirmUserMessageDeliveredToProvider).toHaveBeenCalledWith(31, {
      localIds: ['remote-local-31'],
    });

    const switchHandler = await harness.switchHandlerReady;
    await expect(switchHandler({ to: 'local' })).resolves.toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  });

  it('passes provider-accepted delivery state into remote unified terminal ambiguous-retry gating', async () => {
    const harness = createRemoteHarness({ sessionId: 'sess_unified_remote_delivery_gate' });
    const runnerCompleted = createDeferred<void>();
    const hasUserMessageProviderAcceptance = harness.client.hasUserMessageProviderAcceptance as ReturnType<typeof vi.fn>;
    hasUserMessageProviderAcceptance.mockReturnValueOnce(true);
    let capturedIsPromptDeliveryAccepted:
      | ((batch: {
        maxUserMessageSeq?: number | null;
        userMessageLocalIds?: readonly string[] | null;
      }) => boolean)
      | undefined;

    const runClaudeUnifiedTerminalSession = vi.fn(async (opts: {
      isPromptDeliveryAccepted?: (batch: {
        maxUserMessageSeq?: number | null;
        userMessageLocalIds?: readonly string[] | null;
      }) => boolean;
    }) => {
      capturedIsPromptDeliveryAccepted = opts.isPromptDeliveryAccepted;
      runnerCompleted.resolve(undefined);
    });
    vi.doMock('./unifiedTerminal/runClaudeUnifiedTerminalSession', () => ({
      runClaudeUnifiedTerminalSession,
    }));
    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown, deps?: unknown) => {
      const dispatchDeps = deps as UnifiedTerminalDispatchDeps | undefined;
      expect(dispatchDeps?.claudeUnifiedTerminal).toEqual(expect.any(Function));
      await dispatchDeps?.claudeUnifiedTerminal?.(opts);
      await waitForAbort((opts as UnifiedTerminalDispatchMockOptions).signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(harness.session);
    vi.doUnmock('./unifiedTerminal/runClaudeUnifiedTerminalSession');

    await runnerCompleted.promise;
    expect(typeof capturedIsPromptDeliveryAccepted).toBe('function');
    expect(capturedIsPromptDeliveryAccepted?.({
      maxUserMessageSeq: 44,
      userMessageLocalIds: ['remote-local-44'],
    })).toBe(true);
    expect(hasUserMessageProviderAcceptance).toHaveBeenCalledWith({
      userMessageSeq: 44,
      localIds: ['remote-local-44'],
    });
    const switchHandler = await harness.switchHandlerReady;
    await expect(switchHandler({ to: 'local' })).resolves.toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  });

  it('registers remote unified terminal composer clear through additive session runtime controls', async () => {
    const harness = createRemoteHarness({ sessionId: 'sess_unified_composer_clear' });
    const mode = {
      permissionMode: 'default',
      claudeUnifiedTerminalEnabled: true,
      claudeUnifiedTerminalHost: 'auto',
    } satisfies EnhancedMode;
    harness.session.queue.push('clearable remote prompt', mode);
    const unregister = vi.fn();
    const registerSessionRuntimeControls = harness.client.registerSessionRuntimeControls as ReturnType<typeof vi.fn>;
    registerSessionRuntimeControls.mockReturnValueOnce(unregister);
    const runnerCompleted = createDeferred<void>();

    const runClaudeUnifiedTerminalSession = vi.fn(async (opts: {
      registerTerminalComposerClearRuntimeControl?: (
        handler: (request: Readonly<{ sessionId: string }>) => Promise<unknown>,
      ) => (() => void) | void;
    }) => {
      expect(typeof opts.registerTerminalComposerClearRuntimeControl).toBe('function');
      const handler = vi.fn(async () => ({ ok: true, status: 'already_empty', sessionId: 'happy_sess_1' }));
      const dispose = opts.registerTerminalComposerClearRuntimeControl?.(handler);

      expect(registerSessionRuntimeControls).toHaveBeenCalledWith({
        clearTerminalComposer: handler,
      });
      dispose?.();
      expect(unregister).toHaveBeenCalledTimes(1);
      runnerCompleted.resolve(undefined);
    });
    vi.doMock('./unifiedTerminal/runClaudeUnifiedTerminalSession', () => ({
      runClaudeUnifiedTerminalSession,
    }));
    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown, deps?: unknown) => {
      const dispatchDeps = deps as UnifiedTerminalDispatchDeps | undefined;
      expect(dispatchDeps?.claudeUnifiedTerminal).toEqual(expect.any(Function));
      await dispatchDeps?.claudeUnifiedTerminal?.(opts);
      await waitForAbort((opts as UnifiedTerminalDispatchMockOptions).signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(harness.session);
    vi.doUnmock('./unifiedTerminal/runClaudeUnifiedTerminalSession');

    await runnerCompleted.promise;
    const switchHandler = await harness.switchHandlerReady;
    await expect(switchHandler({ to: 'local' })).resolves.toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  });

  it('surfaces remote blocked-apply user drafts as clearable terminal composer events', async () => {
    const harness = createRemoteHarness({ sessionId: 'sess_unified_blocked_apply_draft' });
    const mode = {
      permissionMode: 'default',
      claudeUnifiedTerminalEnabled: true,
      claudeUnifiedTerminalHost: 'auto',
    } satisfies EnhancedMode;
    harness.session.queue.push('runtime control draft blocker', mode);
    const runnerCompleted = createDeferred<void>();

    const runClaudeUnifiedTerminalSession = vi.fn(async (opts: {
      tuiRuntimeControl?: {
        onBlockedApplyStarvation?: (info: {
          consecutiveBlockedApplies: number;
          blockedReason?: string | null;
        }) => void;
      };
    }) => {
      opts.tuiRuntimeControl?.onBlockedApplyStarvation?.({
        consecutiveBlockedApplies: 6,
        blockedReason: 'stuck_unsafe_window:user_draft',
      });
      runnerCompleted.resolve(undefined);
    });
    vi.doMock('./unifiedTerminal/runClaudeUnifiedTerminalSession', () => ({
      runClaudeUnifiedTerminalSession,
    }));
    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown, deps?: unknown) => {
      const dispatchDeps = deps as UnifiedTerminalDispatchDeps | undefined;
      expect(dispatchDeps?.claudeUnifiedTerminal).toEqual(expect.any(Function));
      await dispatchDeps?.claudeUnifiedTerminal?.(opts);
      await waitForAbort((opts as UnifiedTerminalDispatchMockOptions).signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(harness.session);
    vi.doUnmock('./unifiedTerminal/runClaudeUnifiedTerminalSession');

    await runnerCompleted.promise;
    expect(harness.client.sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal-composer-draft-blocked',
      reason: 'idle_draft_guard',
    }));
    expect(harness.client.getAgentStateSnapshot()?.capabilities).toMatchObject({
      terminalComposerDraftPresent: true,
      terminalComposerClearSupported: true,
    });

    const switchHandler = await harness.switchHandlerReady;
    await expect(switchHandler({ to: 'local' })).resolves.toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  });

  it('passes a startup resume-choice resolver to the remote unified terminal runner', async () => {
    const harness = createRemoteHarness({ sessionId: 'sess_unified_resume_choice_resolver' });
    const mode = {
      permissionMode: 'default',
      claudeUnifiedTerminalEnabled: true,
      claudeUnifiedTerminalHost: 'auto',
      claudeUnifiedTerminalResumeChoice: 'resume_full_session',
    } satisfies EnhancedMode;
    harness.session.queue.push('resume-choice prompt', mode);
    const runnerCompleted = createDeferred<void>();

    const runClaudeUnifiedTerminalSession = vi.fn(async (opts: {
      nextMessage?: () => Promise<{ message: string; mode: EnhancedMode } | null>;
      createStartupDialogResolver?: (params: {
        controlPort: ReturnType<typeof createFakeControlPort>;
        startupMode: EnhancedMode;
      }) => ((input: {
        screenState: ReturnType<typeof parseClaudeScreenState>;
        observedAtMs: number;
        abortSignal: AbortSignal;
      }) => Promise<{ status: string }> | { status: string }) | null | undefined;
    }) => {
      const batch = await opts.nextMessage?.();
      expect(batch?.mode.claudeUnifiedTerminalResumeChoice).toBe('resume_full_session');
      expect(opts.createStartupDialogResolver).toEqual(expect.any(Function));

      const port = createFakeControlPort({ captures: [RESUME_CHOICE_DIALOG, IDLE_COMPOSER] });
      const resolver = opts.createStartupDialogResolver?.({
        controlPort: port,
        startupMode: batch?.mode ?? mode,
      });
      expect(resolver).toEqual(expect.any(Function));
      await resolver?.({
        screenState: parseClaudeScreenState(RESUME_CHOICE_DIALOG),
        observedAtMs: 1,
        abortSignal: new AbortController().signal,
      });
      expect(port.sentLiteral).toEqual(['2']);
      expect(port.sentKeys).toEqual(['Enter']);
      runnerCompleted.resolve(undefined);
    });
    vi.doMock('./unifiedTerminal/runClaudeUnifiedTerminalSession', () => ({
      runClaudeUnifiedTerminalSession,
    }));
    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown, deps?: unknown) => {
      const dispatchDeps = deps as UnifiedTerminalDispatchDeps | undefined;
      expect(dispatchDeps?.claudeUnifiedTerminal).toEqual(expect.any(Function));
      await dispatchDeps?.claudeUnifiedTerminal?.(opts);
      await waitForAbort((opts as UnifiedTerminalDispatchMockOptions).signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(harness.session);
    vi.doUnmock('./unifiedTerminal/runClaudeUnifiedTerminalSession');

    await runnerCompleted.promise;
    const switchHandler = await harness.switchHandlerReady;
    await expect(switchHandler({ to: 'local' })).resolves.toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  });

  it('surfaces hook-lifecycle usage-limit details as usage-limit runtime issues on the remote unified path', async () => {
    const harness = createRemoteHarness({ sessionId: 'sess_unified_usage_limit' });
    const mode = {
      permissionMode: 'default',
      claudeUnifiedTerminalEnabled: true,
      claudeUnifiedTerminalHost: 'auto',
    } satisfies EnhancedMode;
    harness.session.queue.push('hello from ui', mode);
    const handledUsageLimit = createDeferred<void>();

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as UnifiedTerminalDispatchMockOptions & {
        onUsageLimitDetails?: (details: unknown) => Promise<void>;
      };
      await dispatchOpts.nextMessage?.();
      expect(dispatchOpts.onUsageLimitDetails).toBeTypeOf('function');
      await dispatchOpts.onUsageLimitDetails?.({
        v: 1,
        resetAtMs: 4_321_000,
        retryAfterMs: null,
        quotaScope: 'account',
        recoverability: 'wait',
        providerLimitId: 'messages',
        planType: null,
        utilization: 100,
        overage: {
          status: 'rejected',
          resetAtMs: 4_321_000,
        },
        action: null,
        connectedService: null,
      });
      handledUsageLimit.resolve();
      await waitForAbort(dispatchOpts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(harness.session);

    await handledUsageLimit.promise;
    expect(harness.client.sessionTurnLifecycle?.failTurn).toHaveBeenCalledWith({
      provider: 'claude',
      issue: expect.objectContaining({
        source: 'usage_limit',
        provider: 'claude',
        usageLimit: expect.objectContaining({
          resetAtMs: 4_321_000,
          providerLimitId: 'messages',
          utilization: 100,
        }),
      }),
    });

    const switchHandler = await harness.switchHandlerReady;
    await expect(switchHandler({ to: 'local' })).resolves.toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  });

  it('projects an aborted unified terminal turn as a cancelled canonical turn on the remote path', async () => {
    const harness = createRemoteHarness({ sessionId: 'sess_unified_prompt_turn_terminal' });
    const mode = {
      permissionMode: 'default',
      claudeUnifiedTerminalEnabled: true,
      claudeUnifiedTerminalHost: 'auto',
    } satisfies EnhancedMode;
    harness.session.queue.push('hello from ui', mode);
    const turnProjected = createDeferred<void>();

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as UnifiedTerminalDispatchMockOptions & {
        onPromptTurnTerminal?: (event: { reason: string; source: string; detail?: string }) => Promise<void>;
      };
      await dispatchOpts.nextMessage?.();
      await dispatchOpts.onTerminalPromptInjected?.({
        message: 'hello from ui',
        mode: {
          permissionMode: 'default',
          claudeUnifiedTerminalEnabled: true,
          claudeUnifiedTerminalHost: 'auto',
        },
        acceptedAs: 'new_turn',
        turnStateAtInjection: 'idle',
      });
      expect(dispatchOpts.onPromptTurnTerminal).toBeTypeOf('function');
      await dispatchOpts.onPromptTurnTerminal?.({ reason: 'aborted', source: 'claude_hook' });
      turnProjected.resolve();
      await waitForAbort(dispatchOpts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(harness.session);

    await turnProjected.promise;
    expect(harness.client.sessionTurnLifecycle?.cancelTurn).toHaveBeenCalledWith({ provider: 'claude' });
    expect(harness.client.sessionTurnLifecycle?.completeTurn).not.toHaveBeenCalled();
    const agentMessages = (harness.client.sendAgentMessage as any).mock.calls.map((call: any[]) => call?.[1]);
    expect(agentMessages.some((msg: any) => msg?.type === 'turn_aborted')).toBe(true);

    const switchHandler = await harness.switchHandlerReady;
    await expect(switchHandler({ to: 'local' })).resolves.toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  });

  it('cancels the canonical unified terminal turn on remote abort so it is not recorded completed', async () => {
    const waitWithin = async <T,>(promise: Promise<T>, label: string, ms: number = 5000): Promise<T> => {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(label)), ms);
          timer.unref?.();
        }),
      ]);
    };

    const harness = createRemoteHarness({ sessionId: 'sess_unified_abort_cancel_turn' });
    const mode = {
      permissionMode: 'default',
      claudeUnifiedTerminalEnabled: true,
      claudeUnifiedTerminalHost: 'auto',
    } satisfies EnhancedMode;
    harness.session.queue.push('hello from ui', mode);
    const turnOpened = createDeferred<void>();
    const interruptObserved = createDeferred<void>();

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as UnifiedTerminalDispatchMockOptions & {
        setTurnInterrupt?: (handler: (() => Promise<void>) | null) => void;
      };
      await dispatchOpts.nextMessage?.();
      dispatchOpts.setTurnInterrupt?.(async () => {
        interruptObserved.resolve(undefined);
      });
      await dispatchOpts.onTerminalPromptInjected?.({
        message: 'hello from ui',
        mode: {
          permissionMode: 'default',
          claudeUnifiedTerminalEnabled: true,
          claudeUnifiedTerminalHost: 'auto',
        },
        acceptedAs: 'new_turn',
        turnStateAtInjection: 'idle',
      });
      turnOpened.resolve();
      await waitForAbort(dispatchOpts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(harness.session);

    await waitWithin(turnOpened.promise, 'unified terminal turn was not opened');
    expect(harness.client.sessionTurnLifecycle?.beginTurn).toHaveBeenCalledTimes(1);

    const abortHandler = await waitWithin(harness.abortHandlerReady, 'abort handler was not registered');
    await abortHandler();
    await waitWithin(interruptObserved.promise, 'turn interrupt was not invoked during abort');

    expect(harness.client.sessionTurnLifecycle?.cancelTurn).toHaveBeenCalledWith({ provider: 'claude' });
    expect(harness.client.sessionTurnLifecycle?.completeTurn).not.toHaveBeenCalled();

    const switchHandler = await waitWithin(harness.switchHandlerReady, 'switch handler was not registered');
    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(waitWithin(launcherPromise, 'launcher did not terminate')).resolves.toBe('switch');
  });

  it('does not begin a new turn for unified terminal in-flight steering prompts', async () => {
    const harness = createRemoteHarness({ sessionId: 'sess_unified_in_flight_steer' });
    const mode = {
      permissionMode: 'default',
      claudeUnifiedTerminalEnabled: true,
      claudeUnifiedTerminalHost: 'auto',
    } satisfies EnhancedMode;
    harness.session.queue.push('steer the running turn', mode);
    const dispatchReady = createDeferred<void>();

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as UnifiedTerminalDispatchMockOptions;
      dispatchReady.resolve();
      await waitForAbort(dispatchOpts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(harness.session);

    await dispatchReady.promise;
    const dispatchOpts = mockClaudeRemoteDispatch.mock.calls[0]?.[0] as {
      onTerminalPromptInjected?: (accepted: unknown) => Promise<void>;
    };
    expect(dispatchOpts.onTerminalPromptInjected).toEqual(expect.any(Function));
    await dispatchOpts.onTerminalPromptInjected?.({
      message: 'steer the running turn',
      mode,
      acceptedAs: 'in_flight_steer',
      turnStateAtInjection: 'running',
    });

    expect(harness.client.sessionTurnLifecycle?.beginTurn).not.toHaveBeenCalled();

    const switchHandler = await harness.switchHandlerReady;
    await expect(switchHandler({ to: 'local' })).resolves.toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  });

  it('opens a ready assistant snapshot for terminal-originated unified prompts in remote dispatch', async () => {
    const harness = createRemoteHarness({ sessionId: 'sess_unified_terminal_origin_ready' });
    const mode = {
      permissionMode: 'default',
      claudeUnifiedTerminalEnabled: true,
      claudeUnifiedTerminalHost: 'auto',
    } satisfies EnhancedMode;
    harness.session.queue.push('hello from ui', mode);
    const dispatchReady = createDeferred<void>();
    const beginTurnAssistantTextSnapshot = vi.fn(() => 'remote-terminal-turn-1');
    (harness.client as any).getLastObservedMessageSeq = vi.fn(() => 12);
    (harness.client as any).beginTurnAssistantTextSnapshot = beginTurnAssistantTextSnapshot;

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as UnifiedTerminalDispatchMockOptions;
      dispatchReady.resolve();
      await waitForAbort(dispatchOpts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(harness.session);

    await dispatchReady.promise;
    const dispatchOpts = mockClaudeRemoteDispatch.mock.calls[0]?.[0] as UnifiedTerminalDispatchMockOptions;
    expect(dispatchOpts.onProviderPromptStarted).toEqual(expect.any(Function));
    dispatchOpts.onProviderPromptStarted?.();

    expect(beginTurnAssistantTextSnapshot).toHaveBeenCalledWith({ startSeqExclusive: 12 });

    const switchHandler = await harness.switchHandlerReady;
    await expect(switchHandler({ to: 'local' })).resolves.toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  });

  it('suppresses transcript user echoes for unified terminal prompts accepted from the UI', async () => {
    const harness = createRemoteHarness({ sessionId: 'sess_unified_prompt_echo' });
    const mode = {
      permissionMode: 'default',
      claudeUnifiedTerminalEnabled: true,
      claudeUnifiedTerminalHost: 'auto',
    } satisfies EnhancedMode;
    harness.session.queue.push('hello from ui', mode);
    const dispatchStarted = createDeferred<void>();

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as UnifiedTerminalDispatchMockOptions;
      dispatchStarted.resolve(undefined);
      await dispatchOpts.nextMessage?.();
      await dispatchOpts.onTerminalPromptInjected?.({
        message: 'hello from ui',
        mode: {
          permissionMode: 'default',
          claudeUnifiedTerminalEnabled: true,
          claudeUnifiedTerminalHost: 'auto',
        },
      });
      mockConvert.mockReturnValueOnce({
        type: 'user',
        message: { role: 'user', content: 'hello from ui' },
      });
      dispatchOpts.onMessage?.({
        type: 'user',
        message: { role: 'user', content: 'hello from ui' },
      });
      await waitForAbort(dispatchOpts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(harness.session);

    await dispatchStarted.promise;
    await sleep(10);
    expect(harness.sendClaudeSessionMessage).not.toHaveBeenCalled();

    const switchHandler = await harness.switchHandlerReady;
    await expect(switchHandler({ to: 'local' })).resolves.toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  });

  it('does not suppress matching non-unified transcript messages when the unified binding is inactive', async () => {
    const harness = createRemoteHarness({ sessionId: 'sess_legacy_persisted_echo' });
    const fetchRecentTranscriptTextItemsForAcpImport = harness.client.fetchRecentTranscriptTextItemsForAcpImport;
    if (!fetchRecentTranscriptTextItemsForAcpImport) {
      throw new Error('test fixture missing fetchRecentTranscriptTextItemsForAcpImport');
    }
    vi.mocked(fetchRecentTranscriptTextItemsForAcpImport).mockResolvedValueOnce([
      { role: 'user', text: 'legacy prompt' },
    ]);
    const legacyMode = {
      permissionMode: 'default',
      claudeRemoteAgentSdkEnabled: true,
    } satisfies EnhancedMode;
    harness.session.queue.push('legacy prompt', legacyMode);
    const legacyMessageObserved = createDeferred<void>();

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as UnifiedTerminalDispatchMockOptions;
      const legacyBatch = await dispatchOpts.nextMessage?.();
      expect(legacyBatch).toMatchObject({
        message: 'legacy prompt',
        mode: legacyMode,
      });
      mockConvert.mockReturnValueOnce({
        type: 'user',
        uuid: 'legacy-user-row',
        timestamp: '2000-01-01T00:00:00.000Z',
        message: { role: 'user', content: 'legacy prompt' },
      });
      dispatchOpts.onMessage?.({
        type: 'user',
        message: { role: 'user', content: 'legacy prompt' },
      });
      legacyMessageObserved.resolve();
      await waitForAbort(dispatchOpts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(harness.session);

    await legacyMessageObserved.promise;
    await sleep(10);
    expect(harness.sendClaudeSessionMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'user',
        uuid: 'legacy-user-row',
        message: { role: 'user', content: 'legacy prompt' },
      }),
      undefined,
    );

    const switchHandler = await harness.switchHandlerReady;
    await expect(switchHandler({ to: 'local' })).resolves.toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  });

  it('suppresses historical persisted user echoes during unified terminal resume replay without suppressing fresh terminal input', async () => {
    const harness = createRemoteHarness({ sessionId: 'sess_unified_resume_echo' });
    const mode = {
      permissionMode: 'default',
      claudeUnifiedTerminalEnabled: true,
      claudeUnifiedTerminalHost: 'auto',
    } satisfies EnhancedMode;
    harness.session.queue.push('repeatable prompt', mode);
    const fetchRecentTranscriptTextItemsForAcpImport = harness.client.fetchRecentTranscriptTextItemsForAcpImport;
    if (!fetchRecentTranscriptTextItemsForAcpImport) {
      throw new Error('test fixture missing fetchRecentTranscriptTextItemsForAcpImport');
    }
    vi.mocked(fetchRecentTranscriptTextItemsForAcpImport).mockResolvedValueOnce([
      { role: 'user', text: 'repeatable prompt' },
      { role: 'agent', text: 'old reply' },
    ]);
    const dispatchStarted = createDeferred<void>();

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as UnifiedTerminalDispatchMockOptions;
      const queuedPrompt = await dispatchOpts.nextMessage?.();
      expect(queuedPrompt).toMatchObject({
        message: 'repeatable prompt',
        mode,
      });
      dispatchStarted.resolve(undefined);
      expect(dispatchOpts.onMessage).toEqual(expect.any(Function));
      mockConvert
        .mockReturnValueOnce({
          type: 'user',
          uuid: 'historical-user-echo',
          timestamp: '2000-01-01T00:00:00.000Z',
          message: { role: 'user', content: 'repeatable prompt' },
        })
        .mockReturnValueOnce({
          type: 'user',
          uuid: 'fresh-terminal-user',
          timestamp: new Date(Date.now() + 1_000).toISOString(),
          message: { role: 'user', content: 'repeatable prompt' },
        })
        .mockReturnValueOnce({
          type: 'assistant',
          uuid: 'assistant-reply',
          message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        });
      dispatchOpts.onMessage?.({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [] } });
      dispatchOpts.onMessage?.({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [] } });
      dispatchOpts.onMessage?.({ type: 'assistant', message: { content: [] } });
      await waitForAbort(dispatchOpts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(harness.session);

    await dispatchStarted.promise;
    await sleep(10);
    expect(harness.client.fetchRecentTranscriptTextItemsForAcpImport).toHaveBeenCalledWith({ take: 500 });
    expect(harness.client.recordClaudeJsonlMessageConsumed).toHaveBeenCalledWith(expect.objectContaining({
      type: 'user',
      uuid: 'historical-user-echo',
    }));
    expect(harness.sendClaudeSessionMessage).toHaveBeenCalledTimes(2);
    expect(harness.sendClaudeSessionMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({
      type: 'user',
      uuid: 'fresh-terminal-user',
    }), undefined);
    expect(harness.sendClaudeSessionMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
      type: 'assistant',
      uuid: 'assistant-reply',
    }), undefined);

    const switchHandler = await harness.switchHandlerReady;
    await expect(switchHandler({ to: 'local' })).resolves.toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  });

  it('exits instead of relaunching when the remote input queue closes during dispatch teardown', async () => {
    const harness = createRemoteHarness({ sessionId: 'sess_0' });
    harness.session.queue.push('hello', { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true } as any);

    mockClaudeRemoteDispatch.mockImplementation(async (opts: unknown) => {
      if (mockClaudeRemoteDispatch.mock.calls.length > 1) {
        void harness.switchHandlerReady.then((switchHandler) => switchHandler({ to: 'local' }));
        return;
      }

      const dispatchOpts = opts as any;
      await dispatchOpts.nextMessage?.();
      dispatchOpts.onSessionFound?.('sess_agent_sdk', hookWithTranscript('/tmp/sess_agent_sdk.jsonl'));
      harness.session.queue.close();
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(harness.session);

    let settled: 'pending' | 'exit' | 'switch' | 'rejected' = 'pending';
    launcherPromise.then(
      (value) => {
        settled = value;
      },
      () => {
        settled = 'rejected';
      },
    );

    await sleep(50);
    const dispatchCallCount = mockClaudeRemoteDispatch.mock.calls.length;

    if (settled === 'pending') {
      const switchHandler = await harness.switchHandlerReady;
      await switchHandler({ to: 'local' });
      await launcherPromise.catch(() => undefined);
    }

    expect(dispatchCallCount).toBe(1);
    expect(settled).toBe('exit');
  });

  it('routes Claude remote input through the session provider input consumer with queue-prioritized pending materialization', async () => {
    const { session, client, switchHandlerReady } = createRemoteHarness({ sessionId: 'sess_0' });
    const mode = {
      permissionMode: 'safe-yolo',
      agentModeId: 'plan',
      replaySeedAllowed: false,
      localId: 'local-claude-1',
      model: 'claude-opus-4-6',
      fallbackModel: 'claude-sonnet-4-6',
      customSystemPrompt: 'custom system prompt',
      appendSystemPrompt: 'append system prompt',
      reasoningEffort: 'max',
      claudeRemoteAgentSdkEnabled: true,
      claudeRemoteSettingSourcesV2: ['user', 'project'],
      claudeRemoteSettingSources: 'user_project',
      claudeCodeExperimentalAgentTeamsEnabled: true,
      claudeRemoteEnableFileCheckpointing: true,
      claudeRemoteMaxThinkingTokens: 4096,
      claudeRemoteDisableTodos: true,
      claudeRemoteStrictMcpServerConfig: true,
      claudeRemoteDebugEnabled: true,
      claudeRemoteVerboseEnabled: true,
      claudeRemoteDebugCategories: ['api', 'mcp'],
      claudeRemoteAdvancedOptionsJson: '{"dangerouslySkipPermissions":true}',
    } satisfies EnhancedMode;
    const materializeNextPendingMessageSafely = vi.fn(async () => ({
      type: 'materialized' as const,
      localId: 'pending-local',
      seq: 17,
      content: null,
    }));
    client.materializeNextPendingMessageSafely = materializeNextPendingMessageSafely;
    session.queue.push('queued prompt', mode);

    const firstMessageSeen = createDeferred<unknown>();
    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as RemoteDispatchMockOptions & {
        nextMessage?: () => Promise<unknown>;
      };
      firstMessageSeen.resolve(await dispatchOpts.nextMessage?.());
      await waitForAbort(dispatchOpts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);

    const firstMessage = await firstMessageSeen.promise;
    const switchHandler = await switchHandlerReady;
    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');

    expect(firstMessage).toMatchObject({
      message: 'queued prompt',
      mode,
    });
    expect(createSessionProviderInputConsumerSpy).toHaveBeenCalled();

    const consumerOptions = createSessionProviderInputConsumerSpy.mock.calls.at(-1)?.[0] as
      | SessionProviderInputConsumerOptions<EnhancedMode, string>
      | undefined;
    expect(consumerOptions?.session.materializeNextPendingMessageSafely).toEqual(expect.any(Function));

    await expect(consumerOptions?.session.popPendingMessage()).resolves.toBe(true);
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledWith({ reconcileWhenEmpty: 'force' });
    expect(client.popPendingMessage).not.toHaveBeenCalled();
    materializeNextPendingMessageSafely.mockClear();

    session.queue.push('queued guard prompt', mode);
    await expect(
      consumerOptions?.session.materializeNextPendingMessageSafely?.({ reconcileWhenEmpty: 'force' }),
    ).resolves.toEqual({ type: 'no_pending' });
    expect(materializeNextPendingMessageSafely).not.toHaveBeenCalled();
  });

  it('preserves legacy Claude remote pending pop fallback when safe materialization is unavailable', async () => {
    const { session, client, switchHandlerReady } = createRemoteHarness({ sessionId: 'sess_0' });
    const mode = {
      permissionMode: 'safe-yolo',
      agentModeId: 'plan',
      replaySeedAllowed: false,
      localId: 'local-claude-legacy-pop',
      model: 'claude-opus-4-6',
      fallbackModel: 'claude-sonnet-4-6',
      customSystemPrompt: 'custom system prompt',
      appendSystemPrompt: 'append system prompt',
      reasoningEffort: 'max',
      claudeRemoteAgentSdkEnabled: true,
      claudeRemoteSettingSourcesV2: ['user', 'project'],
      claudeRemoteSettingSources: 'user_project',
      claudeCodeExperimentalAgentTeamsEnabled: true,
      claudeRemoteEnableFileCheckpointing: true,
      claudeRemoteMaxThinkingTokens: 4096,
      claudeRemoteDisableTodos: true,
      claudeRemoteStrictMcpServerConfig: true,
      claudeRemoteDebugEnabled: true,
      claudeRemoteVerboseEnabled: true,
      claudeRemoteDebugCategories: ['api', 'mcp'],
      claudeRemoteAdvancedOptionsJson: '{"dangerouslySkipPermissions":true}',
    } satisfies EnhancedMode;
    client.popPendingMessage = vi.fn(async () => true);
    session.queue.push('queued prompt', mode);

    const firstMessageSeen = createDeferred<unknown>();
    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as RemoteDispatchMockOptions & {
        nextMessage?: () => Promise<unknown>;
      };
      firstMessageSeen.resolve(await dispatchOpts.nextMessage?.());
      await waitForAbort(dispatchOpts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);

    await firstMessageSeen.promise;
    const switchHandler = await switchHandlerReady;
    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');

    const consumerOptions = createSessionProviderInputConsumerSpy.mock.calls.at(-1)?.[0] as
      | SessionProviderInputConsumerOptions<EnhancedMode, string>
      | undefined;
    expect(consumerOptions?.session.materializeNextPendingMessageSafely).toBeUndefined();

    await expect(consumerOptions?.session.popPendingMessage()).resolves.toBe(true);
    expect(client.popPendingMessage).toHaveBeenCalledTimes(1);
  });

  it('surfaces terminal Claude rate-limit events as usage-limit runtime issues', async () => {
    const harness = createRemoteHarness({ sessionId: 'sess_0' });
    const handledRateLimit = createDeferred<void>();

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as RemoteDispatchMockOptions & {
        onRateLimitEvent?: (details: unknown) => Promise<void>;
      };
      expect(dispatchOpts.onRateLimitEvent).toBeTypeOf('function');
      await dispatchOpts.onRateLimitEvent?.({
        v: 1,
        resetAtMs: 1_234_000,
        retryAfterMs: null,
        quotaScope: 'account',
        recoverability: 'wait',
        providerLimitId: 'messages',
        planType: null,
        utilization: 100,
        overage: {
          status: 'rejected',
          resetAtMs: 1_234_000,
        },
        action: null,
        connectedService: null,
      });
      handledRateLimit.resolve();
      await waitForAbort(dispatchOpts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(harness.session);

    await handledRateLimit.promise;
    expect(harness.client.sessionTurnLifecycle?.failTurn).toHaveBeenCalledWith({
      provider: 'claude',
      issue: expect.objectContaining({
        source: 'usage_limit',
        provider: 'claude',
        usageLimit: expect.objectContaining({
          resetAtMs: 1_234_000,
          providerLimitId: 'messages',
          utilization: 100,
          connectedService: {
            serviceId: 'claude-subscription',
            profileId: expect.stringMatching(/^native:[a-f0-9]{48}$/u),
            groupId: null,
          },
        }),
      }),
    });
    expect(mockNotifyDaemonConnectedServiceQuotaSnapshot).toHaveBeenCalledWith({
      sessionId: 'happy_sess_1',
      serviceId: 'claude-subscription',
      snapshot: expect.objectContaining({
        serviceId: 'claude-subscription',
        profileId: expect.stringMatching(/^native:[a-f0-9]{48}$/u),
        providerId: 'claude',
        meters: [
          expect.objectContaining({
            meterId: 'messages',
            utilizationPct: 100,
            resetsAt: 1_234_000,
          }),
        ],
      }),
    });
    expect(mockNotifyDaemonConnectedServiceRuntimeAuthFailure).not.toHaveBeenCalled();

    const switchHandler = await harness.switchHandlerReady;
    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  });

  it('only records Claude remote prompt completion from the SDK lifecycle release', async () => {
    const harness = createRemoteHarness({ sessionId: 'sess_0' });
    const resultObserved = createDeferred<void>();
    const releaseSdkCompletion = createDeferred<void>();
    const completionObserved = createDeferred<void>();
    harness.session.queue.push('continue', { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true } as any);

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as RemoteDispatchMockOptions & {
        nextMessage?: () => Promise<{ message: string } | null>;
        onMessage?: (message: unknown) => void;
        onThinkingChange?: (thinking: boolean) => void;
      };

      await expect(dispatchOpts.nextMessage?.()).resolves.toMatchObject({ message: 'continue' });
      dispatchOpts.onThinkingChange?.(true);
      dispatchOpts.onMessage?.({ type: 'result', subtype: 'success' });
      resultObserved.resolve();
      await releaseSdkCompletion.promise;
      dispatchOpts.onThinkingChange?.(false);
      completionObserved.resolve();
      await waitForAbort(dispatchOpts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(harness.session);

    await resultObserved.promise;
    expect(harness.client.sessionTurnLifecycle?.beginTurn).toHaveBeenCalledWith({
      provider: 'claude',
    });
    expect(harness.client.sessionTurnLifecycle?.completeTurn).not.toHaveBeenCalled();
    expect(harness.client.sendAgentMessage).not.toHaveBeenCalledWith(
      'claude',
      expect.objectContaining({ type: 'task_complete' }),
    );

    releaseSdkCompletion.resolve();
    await completionObserved.promise;
    expect(harness.client.sendAgentMessage).toHaveBeenCalledWith(
      'claude',
      expect.objectContaining({ type: 'task_complete' }),
    );
    expect(harness.client.sessionTurnLifecycle?.completeTurn).not.toHaveBeenCalled();

    const switchHandler = await harness.switchHandlerReady;
    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  });

  it('surfaces header-only Claude rate-limit details as runtime issues and daemon notifications', async () => {
    const harness = createRemoteHarness({ sessionId: 'sess_0' });
    const handledRateLimit = createDeferred<void>();

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as RemoteDispatchMockOptions & {
        onRateLimitEvent?: (details: unknown) => Promise<void>;
      };
      expect(dispatchOpts.onRateLimitEvent).toBeTypeOf('function');
      await dispatchOpts.onRateLimitEvent?.({
        v: 1,
        resetAtMs: 1_768_718_400_000,
        retryAfterMs: 30_000,
        quotaScope: 'account',
        recoverability: 'wait',
        planType: null,
        utilization: null,
        overage: null,
        action: null,
        connectedService: null,
      });
      handledRateLimit.resolve();
      await waitForAbort(dispatchOpts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(harness.session);

    await handledRateLimit.promise;
    expect(harness.client.sessionTurnLifecycle?.failTurn).toHaveBeenCalledWith({
      provider: 'claude',
      issue: expect.objectContaining({
        source: 'usage_limit',
        provider: 'claude',
        usageLimit: expect.objectContaining({
          resetAtMs: 1_768_718_400_000,
          retryAfterMs: 30_000,
          utilization: null,
          overage: null,
          connectedService: {
            serviceId: 'claude-subscription',
            profileId: expect.stringMatching(/^native:[a-f0-9]{48}$/u),
            groupId: null,
          },
        }),
      }),
    });
    expect(mockNotifyDaemonConnectedServiceQuotaSnapshot).toHaveBeenCalledWith({
      sessionId: 'happy_sess_1',
      serviceId: 'claude-subscription',
      snapshot: expect.objectContaining({
        serviceId: 'claude-subscription',
        profileId: expect.stringMatching(/^native:[a-f0-9]{48}$/u),
        providerId: 'claude',
        meters: [
          expect.objectContaining({
            meterId: 'account',
            utilizationPct: null,
            resetsAt: 1_768_718_400_000,
          }),
        ],
      }),
    });
    expect(mockNotifyDaemonConnectedServiceRuntimeAuthFailure).not.toHaveBeenCalled();

    const switchHandler = await harness.switchHandlerReady;
    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  });

  it('emits abort against the same active Claude turn id', async () => {
    const harness = createRemoteHarness({ sessionId: 'sess_abort_same_turn' });
    const activeTurnStarted = createDeferred<void>();
    let didSignalActiveTurn = false;

    mockClaudeRemoteDispatch.mockImplementation(async (opts: unknown) => {
      const dispatchOpts = opts as RemoteDispatchMockOptions & {
        onThinkingChange?: (thinking: boolean) => void;
      };
      if (!didSignalActiveTurn) {
        didSignalActiveTurn = true;
        dispatchOpts.onThinkingChange?.(true);
        activeTurnStarted.resolve();
      }
      await waitForAbort(dispatchOpts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(harness.session);

    await activeTurnStarted.promise;
    const sendAgentMessageMock = harness.client.sendAgentMessage as unknown as {
      mock: { calls: Array<[string, { type?: string; id?: unknown }]> };
    };
    const startedMarker = sendAgentMessageMock.mock.calls.find(
      (call) => call[0] === 'claude' && call[1]?.type === 'task_started',
    )?.[1] as { id?: unknown } | undefined;
    expect(startedMarker?.id).toEqual(expect.any(String));

    const abortHandler = await harness.abortHandlerReady;
    await abortHandler();

    expect(harness.client.sendAgentMessage).toHaveBeenCalledWith('claude', {
      type: 'turn_aborted',
      id: startedMarker?.id,
    });

    const switchHandler = await harness.switchHandlerReady;
    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  });

	  it('interrupts the current turn before switching to local mode when a turn interrupt handler is available', async () => {
    const waitWithin = async <T,>(promise: Promise<T>, label: string, ms: number = 5000): Promise<T> => {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(label)), ms);
          timer.unref?.();
        }),
      ]);
    };

    const harness = createRemoteHarness();
    harness.session.queue.push('hello', { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true } as any);

    const dispatchObserved = createDeferred<void>();
    const interruptObserved = createDeferred<void>();

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: any) => {
      opts.onRunnerSelected?.('agentSdk');
      opts.onSessionFound?.('sess_agent_sdk', hookWithTranscript('/tmp/sess_agent_sdk.jsonl'));
      opts.setTurnInterrupt?.(async () => {
        interruptObserved.resolve();
      });
      dispatchObserved.resolve();
      await waitForAbort(opts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(harness.session);

    const switchHandler = await waitWithin(harness.switchHandlerReady, 'switch handler was not registered');
    await waitWithin(dispatchObserved.promise, 'remote dispatch mock did not run');

    await waitWithin(Promise.resolve(switchHandler({ to: 'local' })), 'switch handler did not resolve');
    await waitWithin(interruptObserved.promise, 'turn interrupt was not invoked during switch');

    await expect(waitWithin(launcherPromise, 'launcher did not terminate')).resolves.toBe('switch');
  });

  it('does not force-abort the remote runner when switching if the turn interrupt causes the runner to exit quickly (grace window)', async () => {
    const previousGraceMsEnv = process.env.HAPPIER_CLAUDE_REMOTE_INTERRUPT_THEN_TEARDOWN_GRACE_MS;
    try {
      process.env.HAPPIER_CLAUDE_REMOTE_INTERRUPT_THEN_TEARDOWN_GRACE_MS = '1500';

      const waitWithin = async <T,>(promise: Promise<T>, label: string, ms: number = 5000): Promise<T> => {
        return await Promise.race([
          promise,
          new Promise<T>((_resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(label)), ms);
            timer.unref?.();
          }),
        ]);
      };

      const harness = createRemoteHarness();
      harness.session.queue.push('hello', { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true } as any);

      const dispatchObserved = createDeferred<void>();
      const interruptGate = createDeferred<void>();
      let observedSignalAborted: boolean | null = null;

      mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: any) => {
        observedSignalAborted =
          opts.signal && typeof opts.signal === 'object' && typeof (opts.signal as any).aborted === 'boolean'
            ? (opts.signal as any).aborted
            : null;
        opts.onRunnerSelected?.('agentSdk');
        opts.onSessionFound?.('sess_agent_sdk', hookWithTranscript('/tmp/sess_agent_sdk.jsonl'));
        opts.setTurnInterrupt?.(async () => {
          interruptGate.resolve(undefined);
        });
        dispatchObserved.resolve(undefined);
        await interruptGate.promise;
        // Simulate the runner exiting cleanly after interrupt without requiring a process abort.
        return;
      });

      const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
      const launcherPromise = claudeRemoteLauncher(harness.session);

      const switchHandler = await waitWithin(harness.switchHandlerReady, 'switch handler was not registered');
      await waitWithin(dispatchObserved.promise, 'remote dispatch mock did not run');

      await waitWithin(Promise.resolve(switchHandler({ to: 'local' })), 'switch handler did not resolve');
      await expect(waitWithin(launcherPromise, 'launcher did not terminate')).resolves.toBe('switch');

      if (observedSignalAborted === null) throw new Error('observed signal aborted state was unexpectedly null');
      expect(observedSignalAborted).toBe(false);
    } finally {
      if (previousGraceMsEnv === undefined) {
        delete process.env.HAPPIER_CLAUDE_REMOTE_INTERRUPT_THEN_TEARDOWN_GRACE_MS;
      } else {
        process.env.HAPPIER_CLAUDE_REMOTE_INTERRUPT_THEN_TEARDOWN_GRACE_MS = previousGraceMsEnv;
      }
    }
  });

  it('surfaces a turn_aborted agent message when abort is requested and a turn interrupt handler is available', async () => {
    const waitWithin = async <T,>(promise: Promise<T>, label: string, ms: number = 5000): Promise<T> => {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(label)), ms);
          timer.unref?.();
        }),
      ]);
    };

    const harness = createRemoteHarness();
    harness.session.queue.push('hello', { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true } as any);

    const dispatchObserved = createDeferred<void>();
    const interruptObserved = createDeferred<void>();

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: any) => {
      opts.onRunnerSelected?.('agentSdk');
      opts.onSessionFound?.('sess_agent_sdk', hookWithTranscript('/tmp/sess_agent_sdk.jsonl'));
      opts.setTurnInterrupt?.(async () => {
        interruptObserved.resolve(undefined);
      });
      dispatchObserved.resolve(undefined);
      await waitForAbort(opts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(harness.session);

    await waitWithin(dispatchObserved.promise, 'remote dispatch mock did not run');
    const abortHandler = await waitWithin(harness.abortHandlerReady, 'abort handler was not registered');
    await abortHandler();
    await waitWithin(interruptObserved.promise, 'turn interrupt was not invoked during abort');

    const agentMessages = (harness.client.sendAgentMessage as any).mock.calls.map((call: any[]) => call?.[1]);
    const hasTurnAborted = agentMessages.some((msg: any) => msg?.type === 'turn_aborted');
    expect(hasTurnAborted).toBe(true);

    const switchHandler = await waitWithin(harness.switchHandlerReady, 'switch handler was not registered');
    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(waitWithin(launcherPromise, 'launcher did not terminate')).resolves.toBe('switch');
  });

  it('does not surface a raw process error when Claude returns an execution error after user abort', async () => {
    const waitWithin = async <T,>(promise: Promise<T>, label: string, ms: number = 5000): Promise<T> => {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(label)), ms);
          timer.unref?.();
        }),
      ]);
    };

    const harness = createRemoteHarness();
    harness.session.queue.push('hello', { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true } as any);

    const dispatchObserved = createDeferred<void>();
    const interruptObserved = createDeferred<void>();

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: any) => {
      opts.onRunnerSelected?.('agentSdk');
      opts.onSessionFound?.('sess_agent_sdk', hookWithTranscript('/tmp/sess_agent_sdk.jsonl'));
      opts.setTurnInterrupt?.(async () => {
        interruptObserved.resolve(undefined);
      });
      dispatchObserved.resolve(undefined);
      await interruptObserved.promise;
      throw new Error('error_during_execution');
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(harness.session);

    await waitWithin(dispatchObserved.promise, 'remote dispatch mock did not run');
    const abortHandler = await waitWithin(harness.abortHandlerReady, 'abort handler was not registered');
    await abortHandler();
    await waitWithin(interruptObserved.promise, 'turn interrupt was not invoked during abort');

    await expect.poll(() => {
      const messages = (harness.client.sendSessionEvent as any).mock.calls
        .map((call: any[]) => call?.[0]?.message)
        .filter((message: unknown): message is string => typeof message === 'string');
      return messages.includes('Aborted by user');
    }, { timeout: 1_000 }).toBe(true);

    const emittedMessages: string[] = (harness.client.sendSessionEvent as any).mock.calls
      .map((call: any[]) => call?.[0]?.message)
      .filter((message: unknown): message is string => typeof message === 'string');
    expect(emittedMessages.some((message) => message.startsWith('Claude process error:'))).toBe(false);

    const switchHandler = await waitWithin(harness.switchHandlerReady, 'switch handler was not registered');
    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(waitWithin(launcherPromise, 'launcher did not terminate')).resolves.toBe('switch');
  });

  it('marks the session as abort-requested when abort is requested, even if handled via a turn interrupt handler', async () => {
    const waitWithin = async <T,>(promise: Promise<T>, label: string, ms: number = 5000): Promise<T> => {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(label)), ms);
          timer.unref?.();
        }),
      ]);
    };

    const harness = createRemoteHarness();
    const noteAbortRequestedSpy = vi.spyOn(harness.session, 'noteUserAbortRequested');
    harness.session.queue.push('hello', { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true } as any);

    const dispatchObserved = createDeferred<void>();
    const interruptObserved = createDeferred<void>();

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: any) => {
      opts.onRunnerSelected?.('agentSdk');
      opts.onSessionFound?.('sess_agent_sdk', hookWithTranscript('/tmp/sess_agent_sdk.jsonl'));
      opts.setTurnInterrupt?.(async () => {
        interruptObserved.resolve(undefined);
      });
      dispatchObserved.resolve(undefined);
      await waitForAbort(opts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(harness.session);

    await waitWithin(dispatchObserved.promise, 'remote dispatch mock did not run');
    const abortHandler = await waitWithin(harness.abortHandlerReady, 'abort handler was not registered');
    await abortHandler();
    await waitWithin(interruptObserved.promise, 'turn interrupt was not invoked during abort');

    expect(noteAbortRequestedSpy).toHaveBeenCalled();

    const switchHandler = await waitWithin(harness.switchHandlerReady, 'switch handler was not registered');
    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(waitWithin(launcherPromise, 'launcher did not terminate')).resolves.toBe('switch');
  });

  it('terminalizes pending permission requests immediately when abort is requested', async () => {
    const waitWithin = async <T,>(promise: Promise<T>, label: string, ms: number = 5000): Promise<T> => {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(label)), ms);
          timer.unref?.();
        }),
      ]);
    };

    const harness = createRemoteHarness();
    harness.session.queue.push('hello', { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true } as any);

    const dispatchObserved = createDeferred<void>();
    const interruptObserved = createDeferred<void>();
    const pendingPermissionObserved = createDeferred<void>();

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: any) => {
      opts.onRunnerSelected?.('agentSdk');
      opts.onSessionFound?.('sess_agent_sdk', hookWithTranscript('/tmp/sess_agent_sdk.jsonl'));
      opts.setTurnInterrupt?.(async () => {
        interruptObserved.resolve(undefined);
      });
      dispatchObserved.resolve(undefined);

      const permissionPromise = opts.canCallTool(
        'Bash',
        { command: 'echo hi' },
        { permissionMode: 'default' },
        { signal: opts.signal as AbortSignal, toolUseId: 'perm-abort-1' },
      );

      await Promise.resolve();
      pendingPermissionObserved.resolve(undefined);

      await waitForAbort(opts.signal);
      await permissionPromise.catch(() => undefined);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(harness.session);

    await waitWithin(dispatchObserved.promise, 'remote dispatch mock did not run');
    await waitWithin(pendingPermissionObserved.promise, 'pending permission was not observed');
    expect(harness.client.getAgentStateSnapshot()?.requests?.['perm-abort-1']).toBeTruthy();

    const abortHandler = await waitWithin(harness.abortHandlerReady, 'abort handler was not registered');
    await abortHandler();
    await waitWithin(interruptObserved.promise, 'turn interrupt was not invoked during abort');

    const stateAfterAbort = harness.client.getAgentStateSnapshot();
    expect(stateAfterAbort?.requests?.['perm-abort-1']).toBeUndefined();
    expect(stateAfterAbort?.completedRequests?.['perm-abort-1']).toMatchObject({
      status: 'canceled',
      reason: 'Aborted by user',
      decision: 'abort',
    });

    const switchHandler = await waitWithin(harness.switchHandlerReady, 'switch handler was not registered');
    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(waitWithin(launcherPromise, 'launcher did not terminate')).resolves.toBe('switch');
  });

  it('clears the stored Claude session id after an exit-code-1 resume failure so subsequent launches do not loop on a dead session', async () => {
    const waitWithin = async <T,>(promise: Promise<T>, label: string, ms: number = 5000): Promise<T> => {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(label)), ms);
          timer.unref?.();
        }),
      ]);
    };

    const deadSessionId = 'dead-session-id';
    const harness = createRemoteHarness({ sessionId: deadSessionId });
    harness.session.queue.push('first', { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true } as any);

    const firstDispatchObserved = createDeferred<void>();
    const secondDispatchObserved = createDeferred<void>();
    const secondDispatchSessionIdObserved = createDeferred<string | null>();

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: any) => {
      opts.onRunnerSelected?.('agentSdk');
      firstDispatchObserved.resolve();
      expect(opts.sessionId).toBe(deadSessionId);
      throw new Error('Claude Code process exited with code 1');
    });

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: any) => {
      opts.onRunnerSelected?.('agentSdk');
      opts.onSessionFound?.('fresh-session-id', hookWithTranscript('/tmp/fresh-session.jsonl'));
      secondDispatchSessionIdObserved.resolve(opts.sessionId ?? null);
      secondDispatchObserved.resolve();
      await waitForAbort(opts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(harness.session);

    const switchHandler = await waitWithin(harness.switchHandlerReady, 'switch handler was not registered');
    await waitWithin(firstDispatchObserved.promise, 'first dispatch did not run');

    harness.session.queue.push('second', { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true } as any);
    await waitWithin(secondDispatchObserved.promise, 'second dispatch did not run');

    await expect(waitWithin(secondDispatchSessionIdObserved.promise, 'did not observe second dispatch session id')).resolves.toBeNull();

    await waitWithin(Promise.resolve(switchHandler({ to: 'local' })), 'switch handler did not resolve');
    await expect(waitWithin(launcherPromise, 'launcher did not terminate')).resolves.toBe('switch');
  });

  it('does not strip assistant text/thinking blocks when the legacy runner is selected (even if streamed transcript writer is available)', async () => {
    const waitWithin = async <T,>(promise: Promise<T>, label: string, ms: number = 5000): Promise<T> => {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(label)), ms);
          timer.unref?.();
        }),
      ]);
    };

    const harness = createRemoteHarness();

    // Ensure the remote launcher considers streamed transcript writing available.
    (harness.client as any).sendAgentMessageCommitted = vi.fn(async () => {});

    // Seed a first queued message that disables the Agent SDK runner (legacy path).
    harness.session.queue.push('hello', { permissionMode: 'default', claudeRemoteAgentSdkEnabled: false } as any);

    const dispatchObserved = createDeferred<void>();
    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: any) => {
      const first = await opts.nextMessage();
      expect(first?.mode?.claudeRemoteAgentSdkEnabled).toBe(false);

      // Ensure switch/exit handlers have session info to work with.
      opts.onSessionFound?.('sess_legacy', hookWithTranscript('/tmp/sess_legacy.jsonl'));

      // Emit a plain assistant message (no tool blocks) as the legacy runner would.
      opts.onMessage?.({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Thinking...' },
            { type: 'text', text: 'Hello from legacy.' },
          ],
        },
      });

      dispatchObserved.resolve();
      await waitForAbort(opts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(harness.session);

    const switchHandler = await waitWithin(harness.switchHandlerReady, 'switch handler was not registered');
    await waitWithin(dispatchObserved.promise, 'remote dispatch mock did not run');

    await waitWithin(Promise.resolve(switchHandler({ to: 'local' })), 'switch handler did not resolve');

    await expect(waitWithin(launcherPromise, 'launcher did not terminate')).resolves.toBe('switch');

    // The legacy runner must keep text/thinking content intact when converting.
    const convertedArg = mockConvert.mock.calls[0]?.[0] as any;
    const blocks = Array.isArray(convertedArg?.message?.content) ? convertedArg.message.content : [];
    expect(blocks.some((b: any) => b?.type === 'text' && b?.text === 'Hello from legacy.')).toBe(true);
    expect(blocks.some((b: any) => b?.type === 'thinking' && b?.thinking === 'Thinking...')).toBe(true);
  });

  it('creates a streamed transcript writer even when sendAgentMessageCommitted is unavailable', async () => {
    const waitWithin = async <T,>(promise: Promise<T>, label: string, ms: number = 5000): Promise<T> => {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(label)), ms);
          timer.unref?.();
        }),
      ]);
    };

    const harness = createRemoteHarness();
    Reflect.deleteProperty(harness.client, 'sendAgentMessageCommitted');
    harness.session.queue.push('hello', { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true } as any);

    let capturedWriter: any = null;
    const dispatchObserved = createDeferred<void>();
    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: any) => {
      opts.onRunnerSelected?.('agentSdk');
      capturedWriter = (opts as any).streamedTranscriptWriter as any;
      dispatchObserved.resolve(undefined);
      await waitForAbort(opts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(harness.session);

    const switchHandler = await waitWithin(harness.switchHandlerReady, 'switch handler was not registered');
    await waitWithin(dispatchObserved.promise, 'remote dispatch mock did not run');

    expect(capturedWriter).toBeTruthy();
    capturedWriter.appendAssistantDelta('Hello');
    await capturedWriter.flushAll({ reason: 'turn-end' });

    expect(harness.client.sendAgentMessage).not.toHaveBeenCalled();

    await waitWithin(Promise.resolve(switchHandler({ to: 'local' })), 'switch handler did not resolve');
    await expect(waitWithin(launcherPromise, 'launcher did not terminate')).resolves.toBe('switch');
  });

  it('does not strip assistant text/thinking blocks when the Agent SDK runner is selected', async () => {
    const waitWithin = async <T,>(promise: Promise<T>, label: string, ms: number = 5000): Promise<T> => {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(label)), ms);
          timer.unref?.();
        }),
      ]);
    };

    const harness = createRemoteHarness();
    (harness.client as any).sendAgentMessageCommitted = vi.fn(async () => {});
    harness.session.queue.push('hello', { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true } as any);

    const dispatchObserved = createDeferred<void>();
    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: any) => {
      opts.onRunnerSelected?.('agentSdk');
      const first = await opts.nextMessage();
      expect(first?.mode?.claudeRemoteAgentSdkEnabled).toBe(true);

      opts.onSessionFound?.('sess_agentsdk', hookWithTranscript('/tmp/sess_agentsdk.jsonl'));
      opts.onMessage?.({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Agent SDK thinking...' },
            { type: 'text', text: 'Hello from Agent SDK.' },
          ],
        },
      });

      dispatchObserved.resolve(undefined);
      await waitForAbort(opts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(harness.session);

    const switchHandler = await waitWithin(harness.switchHandlerReady, 'switch handler was not registered');
    await waitWithin(dispatchObserved.promise, 'remote dispatch mock did not run');

    await waitWithin(Promise.resolve(switchHandler({ to: 'local' })), 'switch handler did not resolve');
    await expect(waitWithin(launcherPromise, 'launcher did not terminate')).resolves.toBe('switch');

    const convertedArg = mockConvert.mock.calls[0]?.[0] as any;
    const blocks = Array.isArray(convertedArg?.message?.content) ? convertedArg.message.content : [];
    expect(blocks.some((b: any) => b?.type === 'text' && b?.text === 'Hello from Agent SDK.')).toBe(true);
    expect(blocks.some((b: any) => b?.type === 'thinking' && b?.thinking === 'Agent SDK thinking...')).toBe(true);
  });

  it('does not strip assistant text/thinking blocks in the launcher when the Agent SDK runner is selected', async () => {
    const waitWithin = async <T,>(promise: Promise<T>, label: string, ms: number = 5000): Promise<T> => {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(label)), ms);
          timer.unref?.();
        }),
      ]);
    };

    const harness = createRemoteHarness();
    (harness.client as any).sendAgentMessageCommitted = vi.fn(async () => {});

    harness.session.queue.push('hello', { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true } as any);

    const dispatchObserved = createDeferred<void>();
    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: any) => {
      opts.onRunnerSelected?.('agentSdk');
      const first = await opts.nextMessage();
      expect(first?.mode?.claudeRemoteAgentSdkEnabled).toBe(true);
      opts.onSessionFound?.('sess_agent_sdk', hookWithTranscript('/tmp/sess_agent_sdk.jsonl'));
      opts.onMessage?.({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Thinking...' },
            { type: 'text', text: 'Hello from agent sdk.' },
          ],
        },
      });
      dispatchObserved.resolve(undefined);
      await waitForAbort(opts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(harness.session);

    const switchHandler = await waitWithin(harness.switchHandlerReady, 'switch handler was not registered');
    await waitWithin(dispatchObserved.promise, 'remote dispatch mock did not run');

    await waitWithin(Promise.resolve(switchHandler({ to: 'local' })), 'switch handler did not resolve');
    await expect(waitWithin(launcherPromise, 'launcher did not terminate')).resolves.toBe('switch');

    const convertedArg = mockConvert.mock.calls[0]?.[0] as any;
    const blocks = Array.isArray(convertedArg?.message?.content) ? convertedArg.message.content : [];
    expect(blocks.some((b: any) => b?.type === 'text' && b?.text === 'Hello from agent sdk.')).toBe(true);
    expect(blocks.some((b: any) => b?.type === 'thinking' && b?.thinking === 'Thinking...')).toBe(true);
  });

  afterEach(() => {
    for (const session of createdSessions.splice(0)) {
      session.cleanup();
    }
  });

  it('flushes agent-team inbox messages on shutdown', async () => {
    const prevClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const tmpRoot = await mkdtemp(join(tmpdir(), 'happier-claude-team-inbox-'));
    const claudeConfigDir = join(tmpRoot, 'claude-config');
    const teamName = 'happier-ui-test';
    const inboxDir = join(claudeConfigDir, 'teams', teamName, 'inboxes');
    const leadInboxPath = join(inboxDir, 'team-lead.json');

    try {
      process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
      await mkdir(inboxDir, { recursive: true });
      await writeFile(
        leadInboxPath,
        JSON.stringify(
          [
            {
              from: 'Alpha',
              text: 'hello from alpha',
              timestamp: 't1',
              read: false,
            },
          ],
          null,
          2,
        ),
        'utf-8',
      );

      const { session, switchHandlerReady } = createRemoteHarness({ sessionId: 'sess_0' });
      const dispatchStarted = createDeferred<void>();

      const toolUseIdAlpha = 'toolu_alpha_1';

      mockConvert
        .mockReturnValueOnce({
          type: 'assistant',
          uuid: 'u_team_create',
          message: {
            role: 'assistant',
            model: 'test',
            content: [{ type: 'tool_use', id: 'toolu_team_create_1', name: 'AgentTeamCreate', input: { team_name: teamName } }],
          },
        })
        .mockReturnValueOnce({
          type: 'assistant',
          uuid: 'u_spawn_alpha',
          message: {
            role: 'assistant',
            model: 'test',
            content: [{ type: 'tool_use', id: toolUseIdAlpha, name: 'Agent', input: { team_name: teamName, name: 'Alpha' } }],
          },
        })
        .mockReturnValue(null);

      mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
        const dispatchOpts = opts as any;
        dispatchStarted.resolve(undefined);
        // Minimal SDK messages; converter is mocked so shape doesn't matter beyond type checks.
        dispatchOpts.onMessage?.({ type: 'assistant', uuid: 'sdk_u1', message: { role: 'assistant', content: [] } });
        dispatchOpts.onMessage?.({ type: 'assistant', uuid: 'sdk_u2', message: { role: 'assistant', content: [] } });
        await waitForAbort(dispatchOpts.signal);
      });

      const { claudeRemoteDispatch } = await import('./remote/claudeRemoteDispatch');
      expect(claudeRemoteDispatch).toBe(mockClaudeRemoteDispatch);

      const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
      const launcherPromise = claudeRemoteLauncher(session);

      await vi.waitFor(() => {
        expect(mockClaudeRemoteDispatch).toHaveBeenCalled();
      }, { timeout: 2000 });

      const switchHandler = await switchHandlerReady;
      await dispatchStarted.promise;

      expect(await switchHandler({ to: 'local' })).toBe(true);
      await expect(launcherPromise).resolves.toBe('switch');

      const afterRaw = await readFile(leadInboxPath, 'utf-8');
      const after = JSON.parse(afterRaw);
      expect(Array.isArray(after)).toBe(true);
      expect(after[0]?.read).toBe(true);
    } finally {
      if (prevClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prevClaudeConfigDir;
      await rm(tmpRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('backfills agent-team inbox mapping from transcriptPath on startup', async () => {
    const prevClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const tmpRoot = await mkdtemp(join(tmpdir(), 'happier-claude-team-inbox-seed-'));
    const claudeConfigDir = join(tmpRoot, 'claude-config');
    const teamName = 'happier-ui-test';
    const inboxDir = join(claudeConfigDir, 'teams', teamName, 'inboxes');
    const leadInboxPath = join(inboxDir, 'team-lead.json');
    const transcriptPath = join(tmpRoot, 'sess_0.jsonl');

    try {
      process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
      await mkdir(inboxDir, { recursive: true });
      await writeFile(
        leadInboxPath,
        JSON.stringify(
          [
            {
              from: 'Alpha',
              text: 'hello from alpha (seed)',
              timestamp: 't1',
              read: false,
            },
          ],
          null,
          2,
        ),
        'utf-8',
      );

      // Minimal transcript history that establishes the team name + maps Alpha -> tool_use id.
      const transcriptLines = [
        JSON.stringify({
          type: 'assistant',
          uuid: 'u_team_create',
          message: {
            role: 'assistant',
            model: 'test',
            content: [{ type: 'tool_use', id: 'toolu_team_create_1', name: 'AgentTeamCreate', input: { team_name: teamName } }],
          },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'u_spawn_alpha',
          message: {
            role: 'assistant',
            model: 'test',
            content: [{ type: 'tool_use', id: 'toolu_alpha_1', name: 'Agent', input: { team_name: teamName, name: 'Alpha' } }],
          },
        }),
        '',
      ].join('\n');
      await writeFile(transcriptPath, transcriptLines, 'utf-8');

      const { session, switchHandlerReady } = createRemoteHarness({ sessionId: 'sess_0' });
      session.transcriptPath = transcriptPath;

      const dispatchStarted = createDeferred<void>();
      mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
        const dispatchOpts = opts as RemoteDispatchMockOptions;
        dispatchStarted.resolve(undefined);
        await waitForAbort(dispatchOpts.signal);
      });

      const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
      const launcherPromise = claudeRemoteLauncher(session);

      const switchHandler = await switchHandlerReady;
      await dispatchStarted.promise;

      expect(await switchHandler({ to: 'local' })).toBe(true);
      await expect(launcherPromise).resolves.toBe('switch');

      const afterRaw = await readFile(leadInboxPath, 'utf-8');
      const after = JSON.parse(afterRaw);
      expect(Array.isArray(after)).toBe(true);
      expect(after[0]?.read).toBe(true);
    } finally {
      if (prevClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prevClaudeConfigDir;
      await rm(tmpRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('does not double-reset parent chain when sessionId changes during a remote run', async () => {
    const { session, switchHandlerReady } = createRemoteHarness({ sessionId: 'sess_0' });
    const secondDispatchStarted = createDeferred<void>();

    mockClaudeRemoteDispatch
      .mockImplementationOnce(async (opts: unknown) => {
        const dispatchOpts = opts as RemoteDispatchMockOptions;
        dispatchOpts.onSessionFound?.('sess_1');
      })
      .mockImplementationOnce(async (opts: unknown) => {
        const dispatchOpts = opts as RemoteDispatchMockOptions;
        secondDispatchStarted.resolve(undefined);
        await waitForAbort(dispatchOpts.signal);
      });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);

    const switchHandler = await switchHandlerReady;
    await secondDispatchStarted.promise;

    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');

    expect(mockClaudeRemoteDispatch).toHaveBeenCalledTimes(2);
    expect(mockResetParentChain).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('passes through user --mcp-config args and does not parse/merge them into happier MCP config before dispatch', async () => {
    const { session, switchHandlerReady } = createRemoteHarness({ sessionId: 'sess_0' });
    const dispatchStarted = createDeferred<void>();

    const userMcpConfig = JSON.stringify({
      mcpServers: {
        custom: { type: 'http', url: 'http://127.0.0.1:9999' },
      },
    });
    session.claudeArgs = ['--mcp-config', userMcpConfig, '--max-turns', '3'];

    let captured: any = null;
    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      captured = opts as any;
      dispatchStarted.resolve(undefined);
      await waitForAbort((captured as any)?.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);

    await dispatchStarted.promise;
    expect(mockClaudeRemoteDispatch).toHaveBeenCalledTimes(1);

    expect(Array.isArray(captured?.claudeArgs)).toBe(true);
    expect(captured?.claudeArgs).toEqual(['--mcp-config', userMcpConfig, '--max-turns', '3']);

    const parsed = JSON.parse(String(captured?.happierMcpConfigJson ?? 'null'));
    expect(parsed?.mcpServers?.happier).toBeTruthy();
    expect(parsed?.mcpServers?.custom).toBeUndefined();

    expect(Object.prototype.hasOwnProperty.call(captured?.happierMcpServers ?? {}, 'happier')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(captured?.happierMcpServers ?? {}, 'custom')).toBe(false);

    const switchHandler = await switchHandlerReady;
    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  }, 30_000);

  it('passes an explicit Claude resume id into unified terminal dispatch before SessionStart on attached sessions', async () => {
    const resumeSessionId = '5b0592f3-b5cb-4368-9ace-bd4004ee87de';
    const { session, switchHandlerReady } = createRemoteHarness({
      sessionId: null,
      startedBy: 'daemon',
      claudeArgs: ['--resume', resumeSessionId],
    });
    const mode = {
      permissionMode: 'default',
      claudeUnifiedTerminalEnabled: true,
      claudeUnifiedTerminalHost: 'tmux',
    } as any;
    session.queue.push('resume follow-up', mode);

    const runnerCalled = createDeferred<void>();
    const runnerSignal = new AbortController();
    let capturedDispatchOpts: any = null;
    let capturedUnifiedSessionId: string | null = null;
    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown, deps: unknown) => {
      capturedDispatchOpts = opts as any;
      const unified = (deps as UnifiedTerminalDispatchDeps).claudeUnifiedTerminal;
      expect(unified).toEqual(expect.any(Function));
      capturedUnifiedSessionId = capturedDispatchOpts?.sessionId ?? null;
      await unified?.({
        path: '/workspace/project',
        sessionId: capturedDispatchOpts?.sessionId ?? null,
        transcriptPath: '/tmp/claude-unified-transcript.jsonl',
        signal: runnerSignal.signal,
        nextMessage: async () => ({
          message: 'resume follow-up',
          mode,
        }),
        resolveHostAdapter: async () => ({
          status: 'resolved',
          reason: 'test',
          adapter: {
            kind: 'tmux',
            createOrAttachHost: vi.fn(async () => ({
              kind: 'tmux',
              sessionName: 'happier-claude-session-test',
              paneId: 'resume-pane',
              attachMetadata: {
                attachStrategy: 'terminal_host',
                topology: 'shared',
                locality: 'same_machine',
                liveProbe: 'required',
              },
            })),
            injectUserPrompt: vi.fn(async (_handle, input) => {
              runnerSignal.abort();
              return { status: 'injected', at: Date.now(), bytesWritten: input.text.length };
            }),
            evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
            captureInputState: vi.fn(async () => ({
              stable: true,
              currentInput: 'What would you like to work on?\n> ',
              observedAt: Date.now(),
            })),
            interruptTurn: vi.fn(async () => {}),
            dispose: vi.fn(async () => {}),
          },
        }),
        buildSpawn: async () => ({
          spawnArgv: ['/bin/claude'],
          spawnEnv: {},
        }),
        createSessionName: () => 'happier-claude-session-test',
        persistTerminalHostAttachmentInfo: vi.fn(async () => {}),
      });
      runnerCalled.resolve(undefined);
      await waitForAbort((opts as RemoteDispatchMockOptions).signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);

    await runnerCalled.promise;
    expect(capturedDispatchOpts?.sessionId).toBe(resumeSessionId);
    expect(capturedDispatchOpts?.claudeArgs).toEqual(['--resume', resumeSessionId]);
    expect(capturedUnifiedSessionId).toBe(resumeSessionId);

    const switchHandler = await switchHandlerReady;
    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  }, 30_000);

  it('does not pass stored assistant UUID metadata as a normal resumeSessionAt anchor', async () => {
    const { session, switchHandlerReady } = createRemoteHarness({
      sessionId: 'sess_0',
      metadata: { claudeLastAssistantUuid: 'asst_uuid_1' },
    } as any);

    const dispatchStarted = createDeferred<void>();
    let capturedOpts: any = null;
    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      capturedOpts = opts as any;
      dispatchStarted.resolve(undefined);
      await waitForAbort((capturedOpts as any).signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);

    const switchHandler = await switchHandlerReady;
    await dispatchStarted.promise;

    expect(capturedOpts?.resumeSessionAt ?? null).toBeNull();

    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  }, 30_000);

  it('forwards structured Claude completion events to the session transcript', async () => {
    const structuredEvent = {
      type: 'context-compaction' as const,
      phase: 'started' as const,
      provider: 'claude',
      source: 'user-command' as const,
      trigger: 'manual' as const,
      lifecycleId: 'claude:context-compaction:test',
    };

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: any) => {
      opts.onCompletionEvent(structuredEvent);
    });

    const { session, switchHandlerReady } = createRemoteHarness({ sessionId: 'sess_0' });
    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');

    const launcherPromise = claudeRemoteLauncher(session);
    const switchHandler = await switchHandlerReady;
    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');

    expect(session.client.sendSessionEvent).toHaveBeenCalledWith(structuredEvent);
    expect(session.client.sendSessionEvent).not.toHaveBeenCalledWith({
      type: 'message',
      message: structuredEvent,
    });
  }, 30_000);

  it('includes Claude Code debug/stderr tails and keeps the launcher alive on exit code 1 (no tight retries)', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'happy-claude-exit1-'));
    try {
      const debugFilePath = join(tmpRoot, 'claude-code-debug.log');
      const stderrFilePath = join(tmpRoot, 'claude-code-stderr.log');
      await writeFile(debugFilePath, ['debug one', 'debug two', 'debug tail'].join('\n') + '\n');
      await writeFile(stderrFilePath, ['stderr one', 'stderr tail'].join('\n') + '\n');

      const exitError = new Error('Claude Code process exited with code 1');
      (exitError as any).happierClaudeCodeArtifacts = {
        debugFilePath,
        stderrFilePath,
      };

      mockClaudeRemoteDispatch.mockRejectedValueOnce(exitError);

      const { session, switchHandlerReady } = createRemoteHarness({ sessionId: 'sess_0' });
      const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');

      const launcherPromise = claudeRemoteLauncher(session);

      const deadlineMs = Date.now() + 1500;
      while (Date.now() < deadlineMs) {
        const sent = (session.client.sendSessionEvent as any).mock.calls
          .map((call: any[]) => call?.[0]?.message)
          .filter((value: unknown) => typeof value === 'string')
          .join('\n');
        if (sent.includes('Claude Code process exited with code 1')) break;
        await new Promise((r) => setTimeout(r, 10));
      }

      expect(mockClaudeRemoteDispatch).toHaveBeenCalledTimes(1);

      const sent = (session.client.sendSessionEvent as any).mock.calls
        .map((call: any[]) => call?.[0]?.message)
        .filter((value: unknown) => typeof value === 'string')
        .join('\n');

      expect(sent).toContain('Claude Code process exited with code 1');
      expect(sent).toContain('debug tail');
      expect(sent).toContain('stderr tail');

      const switchHandler = await switchHandlerReady;
      expect(await switchHandler({ to: 'local' })).toBe(true);
      await expect(launcherPromise).resolves.toBe('switch');
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('retries after exit code 1 and still delivers subsequent queued prompts', async () => {
    const exitError = new Error('Claude Code process exited with code 1');
    const firstProcessed = createDeferred<void>();
    const restartedFirstSeen = createDeferred<any>();
    const restartedSecondSeen = createDeferred<any>();

    mockClaudeRemoteDispatch
      .mockImplementationOnce(async (opts: unknown) => {
        const dispatchOpts = opts as any;
        await dispatchOpts.nextMessage?.();
        firstProcessed.resolve(undefined);
        throw exitError;
      })
      .mockImplementationOnce(async (opts: unknown) => {
        const dispatchOpts = opts as any;
        restartedFirstSeen.resolve(await dispatchOpts.nextMessage?.());
        restartedSecondSeen.resolve(await dispatchOpts.nextMessage?.());
        await waitForAbort(dispatchOpts.signal);
      });

    const { session, switchHandlerReady } = createRemoteHarness({ sessionId: 'sess_0' });
    session.queue.push('hello', { permissionMode: 'default' } satisfies EnhancedMode);

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);

    await firstProcessed.promise;
    session.queue.push('again', { permissionMode: 'default' } satisfies EnhancedMode);

    const restartedFirst = await restartedFirstSeen.promise;
    expect(restartedFirst?.message).toContain('again');

    session.queue.push('third', { permissionMode: 'default' } satisfies EnhancedMode);

    const restartedSecond = await restartedSecondSeen.promise;
    expect(restartedSecond?.message).toContain('third');

    const switchHandler = await switchHandlerReady;
    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  }, 30_000);

  it('clears the Claude session id after an abort-triggered exit code 1 so the next launch does not keep resuming a dead session', async () => {
    const exitError = new Error('Claude Code process exited with code 1');

    const firstDispatchStarted = createDeferred<void>();
    const secondDispatchObserved = createDeferred<any>();

    // Simulate a long delay between user abort and the eventual exit-code-1 failure, which can happen
    // in practice when Claude is still shutting down. The launcher must still clear the dead session id.
    const dateNowSpy = vi.spyOn(Date, 'now');
    let nowMs = 1_000;
    dateNowSpy.mockImplementation(() => nowMs);

    mockClaudeRemoteDispatch
      .mockImplementationOnce(async (opts: any) => {
        firstDispatchStarted.resolve(undefined);
        await waitForAbort(opts.signal);
        nowMs += 20_000;
        throw exitError;
      })
      .mockImplementationOnce(async (opts: any) => {
        secondDispatchObserved.resolve({ sessionId: opts.sessionId, transcriptPath: opts.transcriptPath });
        await waitForAbort(opts.signal);
      });

    const { session, abortHandlerReady, switchHandlerReady } = createRemoteHarness({ sessionId: 'dead-session-id' });
    session.queue.push('hello', { permissionMode: 'default' } satisfies EnhancedMode);

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);

    try {
      await firstDispatchStarted.promise;
      const abortHandler = await abortHandlerReady;
      await abortHandler();

      session.queue.push('after abort', { permissionMode: 'default' } satisfies EnhancedMode);

      const secondDispatch = await secondDispatchObserved.promise;
      expect(secondDispatch.sessionId).toBeNull();

      const switchHandler = await switchHandlerReady;
      expect(await switchHandler({ to: 'local' })).toBe(true);
      await expect(launcherPromise).resolves.toBe('switch');
    } finally {
      dateNowSpy.mockRestore();
    }
  }, 30_000);

  it('relaunches between turns when a spawn-only setting changes (reasoning effort), preserving message order', async () => {
    const firstSeen = createDeferred<any>();
    const secondDispatchFirstSeen = createDeferred<any>();
    const firstDispatchSawRestartBoundary = createDeferred<void>();

    mockClaudeRemoteDispatch
      .mockImplementationOnce(async (opts: unknown) => {
        const dispatchOpts = opts as any;
        const first = await dispatchOpts.nextMessage?.();
        firstSeen.resolve(first);
        const second = await dispatchOpts.nextMessage?.();
        expect(second).toBeNull();
        firstDispatchSawRestartBoundary.resolve(undefined);
      })
      .mockImplementationOnce(async (opts: unknown) => {
        const dispatchOpts = opts as any;
        secondDispatchFirstSeen.resolve(await dispatchOpts.nextMessage?.());
        await waitForAbort(dispatchOpts.signal);
      });

    const { session, switchHandlerReady } = createRemoteHarness({ sessionId: 'sess_0' });

    session.queue.push('first', {
      permissionMode: 'default',
      claudeRemoteAgentSdkEnabled: true,
      model: 'claude-opus-4-6',
    } satisfies EnhancedMode);

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);

    const first = await firstSeen.promise;
    expect(first?.message).toContain('first');

    // Change reasoning effort: this must restart between turns (Agent SDK effort is spawn-only),
    // but the message must be preserved and delivered after restart.
    session.queue.push('second', {
      permissionMode: 'default',
      claudeRemoteAgentSdkEnabled: true,
      model: 'claude-opus-4-6',
      reasoningEffort: 'low',
    } satisfies EnhancedMode);

    await firstDispatchSawRestartBoundary.promise;

    const second = await secondDispatchFirstSeen.promise;
    expect(second?.message).toContain('second');

    const switchHandler = await switchHandlerReady;
    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  }, 30_000);

  it('continues to detect mode changes after a relaunch boundary by updating the current mode hash when replaying a pending message', async () => {
    const firstDispatchFirstSeen = createDeferred<any>();
    const firstDispatchSawRestartBoundary = createDeferred<void>();

    const secondDispatchFirstSeen = createDeferred<any>();
    const secondDispatchSawRestartBoundary = createDeferred<void>();

    const thirdDispatchFirstSeen = createDeferred<any>();

    mockClaudeRemoteDispatch
      .mockImplementationOnce(async (opts: unknown) => {
        const dispatchOpts = opts as any;
        firstDispatchFirstSeen.resolve(await dispatchOpts.nextMessage?.());
        expect(await dispatchOpts.nextMessage?.()).toBeNull();
        firstDispatchSawRestartBoundary.resolve(undefined);
      })
      .mockImplementationOnce(async (opts: unknown) => {
        const dispatchOpts = opts as any;
        secondDispatchFirstSeen.resolve(await dispatchOpts.nextMessage?.());
        expect(await dispatchOpts.nextMessage?.()).toBeNull();
        secondDispatchSawRestartBoundary.resolve(undefined);
      })
      .mockImplementationOnce(async (opts: unknown) => {
        const dispatchOpts = opts as any;
        thirdDispatchFirstSeen.resolve(await dispatchOpts.nextMessage?.());
        await waitForAbort(dispatchOpts.signal);
      });

    const { session, switchHandlerReady } = createRemoteHarness({ sessionId: 'sess_0' });

    session.queue.push('low1', {
      permissionMode: 'default',
      claudeRemoteAgentSdkEnabled: true,
      model: 'claude-opus-4-6',
      reasoningEffort: 'low',
    } satisfies EnhancedMode);

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);

    const firstDispatchFirst = await firstDispatchFirstSeen.promise;
    expect(firstDispatchFirst?.message).toContain('low1');

    session.queue.push('max2', {
      permissionMode: 'default',
      claudeRemoteAgentSdkEnabled: true,
      model: 'claude-opus-4-6',
      reasoningEffort: 'max',
    } satisfies EnhancedMode);

    await firstDispatchSawRestartBoundary.promise;

    const secondDispatchFirst = await secondDispatchFirstSeen.promise;
    expect(secondDispatchFirst?.message).toContain('max2');

    session.queue.push('low3', {
      permissionMode: 'default',
      claudeRemoteAgentSdkEnabled: true,
      model: 'claude-opus-4-6',
      reasoningEffort: 'low',
    } satisfies EnhancedMode);

    await secondDispatchSawRestartBoundary.promise;

    const thirdDispatchFirst = await thirdDispatchFirstSeen.promise;
    expect(thirdDispatchFirst?.message).toContain('low3');

    const switchHandler = await switchHandlerReady;
    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  }, 30_000);

  it('delivers changed unified spawn-option follow-ups without restart-only notices when TUI runtime control is enabled (default)', async () => {
    // RD-CLD-9: with the TUI runtime-control gate ON by default, the controller applies
    // model/permission/effort live, so those keys must NOT also ride the blanket restart notice.
    const firstSeen = createDeferred<any>();
    const secondSeen = createDeferred<any>();

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as any;
      firstSeen.resolve(await dispatchOpts.nextMessage?.());
      secondSeen.resolve(await dispatchOpts.nextMessage?.());
      session.queue.close();
    });

    const { session, client } = createRemoteHarness({ sessionId: 'sess_unified' });
    session.queue.push('first unified prompt', {
      permissionMode: 'default',
      claudeUnifiedTerminalEnabled: true,
      claudeUnifiedTerminalHost: 'auto',
      model: 'claude-opus-4-6',
      reasoningEffort: 'low',
    } satisfies EnhancedMode);

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);

    const first = await firstSeen.promise;
    expect(first?.message).toContain('first unified prompt');

    session.queue.push('follow-up unified prompt', {
      permissionMode: 'default',
      claudeUnifiedTerminalEnabled: true,
      claudeUnifiedTerminalHost: 'auto',
      model: 'claude-opus-4-7',
      reasoningEffort: 'max',
    } satisfies EnhancedMode);

    const second = await secondSeen.promise;
    expect(second?.message).toContain('follow-up unified prompt');
    expect(second?.mode?.claudeUnifiedTerminalEnabled).toBe(true);
    expect(client.sendSessionEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'runtime-config-outcome',
      status: 'requires_restart',
    }));
    expect(client.sendSessionEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'runtime-config-outcome',
      status: 'unsupported',
    }));

    await expect(launcherPromise).resolves.toBe('exit');
  }, 30_000);

  it('treats an agentModeId-only follow-up change (plan toggle) as a live-applied permission-mode change, not an unclassified restart notice', async () => {
    // Plan-mode rides the cyclable permission-mode control (ShiftTab), so toggling agentModeId
    // between turns must register as a permissionMode-class change the TUI controller owns —
    // never fall through to `unclassified_launch_option_hash_change` requires_restart noise.
    const firstSeen = createDeferred<any>();
    const secondSeen = createDeferred<any>();

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as any;
      firstSeen.resolve(await dispatchOpts.nextMessage?.());
      secondSeen.resolve(await dispatchOpts.nextMessage?.());
      session.queue.close();
    });

    const { session, client } = createRemoteHarness({ sessionId: 'sess_unified_plan_toggle' });
    session.queue.push('first unified prompt', {
      permissionMode: 'safe-yolo',
      agentModeId: 'plan',
      claudeUnifiedTerminalEnabled: true,
      claudeUnifiedTerminalHost: 'auto',
      model: 'claude-opus-4-6',
    } satisfies EnhancedMode);

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);

    const first = await firstSeen.promise;
    expect(first?.message).toContain('first unified prompt');

    session.queue.push('follow-up unified prompt', {
      permissionMode: 'safe-yolo',
      agentModeId: null,
      claudeUnifiedTerminalEnabled: true,
      claudeUnifiedTerminalHost: 'auto',
      model: 'claude-opus-4-6',
    } satisfies EnhancedMode);

    const second = await secondSeen.promise;
    expect(second?.message).toContain('follow-up unified prompt');
    expect(client.sendSessionEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'runtime-config-outcome',
      status: 'requires_restart',
    }));
    expect(client.sendSessionEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'runtime-config-outcome',
      status: 'unsupported',
    }));

    await expect(launcherPromise).resolves.toBe('exit');
  }, 30_000);

  it('suppresses the blanket unsupported notice for max-thinking-token follow-ups when TUI runtime control is enabled (default)', async () => {
    const firstSeen = createDeferred<any>();
    const secondSeen = createDeferred<any>();

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as any;
      firstSeen.resolve(await dispatchOpts.nextMessage?.());
      secondSeen.resolve(await dispatchOpts.nextMessage?.());
      session.queue.close();
    });

    const { session, client } = createRemoteHarness({ sessionId: 'sess_unified_unsupported_max_thinking' });
    session.queue.push('first unified prompt', {
      permissionMode: 'default',
      claudeUnifiedTerminalEnabled: true,
      claudeUnifiedTerminalHost: 'auto',
      model: 'claude-opus-4-6',
    } satisfies EnhancedMode);

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);

    const first = await firstSeen.promise;
    expect(first?.message).toContain('first unified prompt');

    session.queue.push('follow-up unified prompt', {
      permissionMode: 'default',
      claudeUnifiedTerminalEnabled: true,
      claudeUnifiedTerminalHost: 'auto',
      model: 'claude-opus-4-6',
      claudeRemoteMaxThinkingTokens: 4096,
    } satisfies EnhancedMode);

    const second = await secondSeen.promise;
    expect(second?.message).toContain('follow-up unified prompt');
    expect(client.sendSessionEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'runtime-config-outcome',
      status: 'unsupported',
      changes: expect.arrayContaining([
        expect.objectContaining({ key: 'maxThinkingTokens' }),
      ]),
    }));
    expect(client.sendSessionEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'runtime-config-outcome',
      status: 'requires_restart',
      changes: expect.arrayContaining([
        expect.objectContaining({ key: 'maxThinkingTokens' }),
      ]),
    }));

    await expect(launcherPromise).resolves.toBe('exit');
  }, 30_000);

  it('restores legacy restart-only and unsupported notices when the TUI runtime-control kill-switch is set', async () => {
    const previousKillSwitch = process.env.HAPPIER_FEATURE_CLAUDE_UNIFIED_TUI_RUNTIME_CONTROL__ENABLED;
    process.env.HAPPIER_FEATURE_CLAUDE_UNIFIED_TUI_RUNTIME_CONTROL__ENABLED = '0';
    try {
      const firstSeen = createDeferred<any>();
      const secondSeen = createDeferred<any>();

      mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
        const dispatchOpts = opts as any;
        firstSeen.resolve(await dispatchOpts.nextMessage?.());
        secondSeen.resolve(await dispatchOpts.nextMessage?.());
        session.queue.close();
      });

      const { session, client } = createRemoteHarness({ sessionId: 'sess_unified_killswitch' });
      session.queue.push('first unified prompt', {
        permissionMode: 'default',
        claudeUnifiedTerminalEnabled: true,
        claudeUnifiedTerminalHost: 'auto',
        model: 'claude-opus-4-6',
        reasoningEffort: 'low',
      } satisfies EnhancedMode);

      const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
      const launcherPromise = claudeRemoteLauncher(session);

      const first = await firstSeen.promise;
      expect(first?.message).toContain('first unified prompt');

      session.queue.push('follow-up unified prompt', {
        permissionMode: 'default',
        claudeUnifiedTerminalEnabled: true,
        claudeUnifiedTerminalHost: 'auto',
        model: 'claude-opus-4-7',
        reasoningEffort: 'max',
        claudeRemoteMaxThinkingTokens: 4096,
      } satisfies EnhancedMode);

      const second = await secondSeen.promise;
      expect(second?.message).toContain('follow-up unified prompt');
      expect(client.sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'runtime-config-outcome',
        provider: 'claude',
        runtime: 'claude-unified-terminal',
        status: 'requires_restart',
        reason: 'unified_terminal_launch_options_changed',
        message: expect.stringContaining('Claude unified terminal'),
        changes: expect.arrayContaining([
          expect.objectContaining({ key: 'model' }),
          expect.objectContaining({ key: 'reasoningEffort' }),
        ]),
      }));
      expect(client.sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'runtime-config-outcome',
        provider: 'claude',
        runtime: 'claude-unified-terminal',
        status: 'unsupported',
        reason: 'unified_terminal_unsupported_options_changed',
        changes: [
          expect.objectContaining({
            key: 'maxThinkingTokens',
            requested: 4096,
            previous: null,
            reason: 'unsupported_by_claude_unified_terminal',
          }),
        ],
      }));
      expect(client.sendSessionEvent).not.toHaveBeenCalledWith(expect.objectContaining({
        type: 'runtime-config-outcome',
        status: 'requires_restart',
        changes: expect.arrayContaining([
          expect.objectContaining({ key: 'maxThinkingTokens' }),
        ]),
      }));

      await expect(launcherPromise).resolves.toBe('exit');
    } finally {
      if (previousKillSwitch === undefined) {
        delete process.env.HAPPIER_FEATURE_CLAUDE_UNIFIED_TUI_RUNTIME_CONTROL__ENABLED;
      } else {
        process.env.HAPPIER_FEATURE_CLAUDE_UNIFIED_TUI_RUNTIME_CONTROL__ENABLED = previousKillSwitch;
      }
    }
  }, 30_000);

  it('does not surface unified restart-only notices for routing-only follow-up changes', async () => {
    const firstSeen = createDeferred<any>();
    const secondSeen = createDeferred<any>();

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as any;
      firstSeen.resolve(await dispatchOpts.nextMessage?.());
      secondSeen.resolve(await dispatchOpts.nextMessage?.());
      session.queue.close();
    });

    const { session, client } = createRemoteHarness({ sessionId: 'sess_unified_routing_only' });
    session.queue.push('first unified prompt', {
      permissionMode: 'default',
      claudeUnifiedTerminalEnabled: true,
      claudeUnifiedTerminalHost: 'auto',
      replaySeedAllowed: true,
    } satisfies EnhancedMode);

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);

    expect(await firstSeen.promise).toMatchObject({ message: expect.stringContaining('first unified prompt') });

    session.queue.push('routing-only unified prompt', {
      permissionMode: 'default',
      claudeUnifiedTerminalEnabled: true,
      claudeUnifiedTerminalHost: 'auto',
      replaySeedAllowed: false,
    } satisfies EnhancedMode);

    expect(await secondSeen.promise).toMatchObject({ message: expect.stringContaining('routing-only unified prompt') });
    expect(client.sendSessionEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'message',
      message: expect.stringContaining('restart'),
    }));

    await expect(launcherPromise).resolves.toBe('exit');
  }, 30_000);

  it('does not persist assistant UUIDs from remote messages as resume anchors', async () => {
    const { session, client, switchHandlerReady } = createRemoteHarness({
      sessionId: 'sess_0',
      applyMetadataUpdates: true,
    });

    const dispatchStarted = createDeferred<void>();
    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as any;
      dispatchStarted.resolve(undefined);
      dispatchOpts.onMessage?.({
        type: 'assistant',
        uuid: 'asst_uuid_2',
        session_id: 'sess_0',
        parent_tool_use_id: null,
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      });
      await waitForAbort(dispatchOpts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);

    const switchHandler = await switchHandlerReady;
    await dispatchStarted.promise;

    const updateCalls = (client.updateMetadata as any).mock.calls ?? [];
    for (const [updater] of updateCalls) {
      expect(typeof updater).toBe('function');
      expect(updater({})).not.toHaveProperty('claudeLastAssistantUuid');
    }

    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  }, 30_000);

  it('does not persist assistant uuids from sidechain messages (parent_tool_use_id)', async () => {
    const { session, client, switchHandlerReady } = createRemoteHarness({
      sessionId: 'sess_0',
      applyMetadataUpdates: true,
    });

    const dispatchStarted = createDeferred<void>();
    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as any;
      dispatchStarted.resolve(undefined);
      dispatchOpts.onMessage?.({
        type: 'assistant',
        uuid: 'asst_uuid_sidechain',
        session_id: 'sess_0',
        parent_tool_use_id: 'toolu_parent',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi from sidechain' }] },
      });
      await waitForAbort(dispatchOpts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);

    const switchHandler = await switchHandlerReady;
    await dispatchStarted.promise;

    const updateCalls = (client.updateMetadata as any).mock.calls ?? [];
    for (const [updater] of updateCalls) {
      expect(typeof updater).toBe('function');
      expect(updater({})).not.toHaveProperty('claudeLastAssistantUuid');
    }

    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  }, 30_000);

  it('persists supported Claude models from remote capabilities into session model metadata', async () => {
    const { session, client, switchHandlerReady } = createRemoteHarness({
      sessionId: 'sess_0',
      metadata: {
        modelOverrideV1: {
          v: 1,
          updatedAt: 1,
          modelId: 'sonnet[1m]',
        },
      } as Metadata,
      applyMetadataUpdates: true,
    });
    session.queue.push('hello', { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true } as any);

    const dispatchStarted = createDeferred<void>();
    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as any;
      dispatchStarted.resolve(undefined);
      dispatchOpts.onCapabilities?.({
        models: [
          {
            value: 'sonnet[1m]',
            displayName: 'Sonnet 4.6 1M',
            description: '1 million token context window',
          },
          {
            value: 'claude-sonnet-4-6',
            displayName: 'Sonnet 4.6',
          },
        ],
      });
      await waitForAbort(dispatchOpts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);

    const switchHandler = await switchHandlerReady;
    await dispatchStarted.promise;

    await vi.waitFor(() => {
      expect(client.getMetadataSnapshot()).toEqual(expect.objectContaining({
        sessionModelsV1: {
          v: 1,
          provider: 'claude',
          updatedAt: expect.any(Number),
          currentModelId: 'sonnet[1m]',
          availableModels: [
            {
              id: 'sonnet[1m]',
              name: 'Sonnet 4.6 1M',
              description: '1 million token context window',
              contextWindowTokens: 1_000_000,
            },
            {
              id: 'claude-sonnet-4-6',
              name: 'Sonnet 4.6',
            },
          ],
        },
        acpSessionModelsV1: {
          v: 1,
          provider: 'claude',
          updatedAt: expect.any(Number),
          currentModelId: 'sonnet[1m]',
          availableModels: [
            {
              id: 'sonnet[1m]',
              name: 'Sonnet 4.6 1M',
              description: '1 million token context window',
              contextWindowTokens: 1_000_000,
            },
            {
              id: 'claude-sonnet-4-6',
              name: 'Sonnet 4.6',
            },
          ],
        },
      }));
    });

    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  }, 30_000);

  it('updates Claude session model metadata from runtime system init before capabilities arrive', async () => {
    const { session, client, switchHandlerReady } = createRemoteHarness({
      sessionId: 'sess_0',
      applyMetadataUpdates: true,
    });
    session.queue.push('hello', { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true } as any);

    const dispatchStarted = createDeferred<void>();
    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as any;
      dispatchStarted.resolve(undefined);
      dispatchOpts.onMessage?.({
        type: 'system',
        subtype: 'init',
        session_id: 'sess_runtime_model',
        model: 'claude-opus-4-6',
      });
      dispatchOpts.onCapabilities?.({
        models: [
          {
            value: 'claude-opus-4-6',
            displayName: 'Opus 4.6',
            description: '1 million token context window',
          },
        ],
      });
      await waitForAbort(dispatchOpts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);

    const switchHandler = await switchHandlerReady;
    await dispatchStarted.promise;

    await vi.waitFor(() => {
      expect(client.getMetadataSnapshot()).toEqual(expect.objectContaining({
        sessionModelsV1: {
          v: 1,
          provider: 'claude',
          updatedAt: expect.any(Number),
          currentModelId: 'claude-opus-4-6',
          availableModels: [
            {
              id: 'claude-opus-4-6',
              name: 'Opus 4.6',
              description: '1 million token context window',
              contextWindowTokens: 1_000_000,
            },
          ],
        },
        acpSessionModelsV1: {
          v: 1,
          provider: 'claude',
          updatedAt: expect.any(Number),
          currentModelId: 'claude-opus-4-6',
          availableModels: [
            {
              id: 'claude-opus-4-6',
              name: 'Opus 4.6',
              description: '1 million token context window',
              contextWindowTokens: 1_000_000,
            },
          ],
        },
      }));
    });

    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  }, 30_000);

  it('persists Claude remote work-state snapshots into session metadata', async () => {
    const { session, client, switchHandlerReady } = createRemoteHarness({
      sessionId: 'sess_0',
      applyMetadataUpdates: true,
    });
    session.queue.push('hello', { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true } as any);

    const dispatchStarted = createDeferred<void>();
    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as any;
      dispatchStarted.resolve(undefined);
      dispatchOpts.onWorkStateSnapshot?.({
        v: 1,
        backendId: 'claude',
        agentId: 'claude',
        updatedAt: 123,
        primaryItemId: 'task:claude:task-1',
        items: [
          {
            id: 'task:claude:task-1',
            kind: 'task',
            origin: 'vendor',
            source: 'claude.task',
            status: 'active',
            title: 'Investigate flakes',
            backendId: 'claude',
            agentId: 'claude',
            vendorRef: 'task-1',
            updatedAt: 123,
          },
        ],
      });
      await waitForAbort(dispatchOpts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);

    const switchHandler = await switchHandlerReady;
    await dispatchStarted.promise;

    await vi.waitFor(() => {
      expect(client.getMetadataSnapshot()).toEqual(expect.objectContaining({
        sessionWorkStateV1: expect.objectContaining({
          backendId: 'claude',
          agentId: 'claude',
          primaryItemId: 'task:claude:task-1',
          items: [
            expect.objectContaining({
              id: 'task:claude:task-1',
              kind: 'task',
              status: 'active',
              title: 'Investigate flakes',
            }),
          ],
        }),
      }));
    });

    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  }, 30_000);

  it('uses explicit work-state ownership when persisting empty Claude remote snapshots', async () => {
    const { session, client, switchHandlerReady } = createRemoteHarness({
      sessionId: 'sess_0',
      applyMetadataUpdates: true,
    });
    session.queue.push('hello', { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true } as any);

    const dispatchStarted = createDeferred<void>();
    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as any;
      dispatchStarted.resolve(undefined);
      dispatchOpts.onWorkStateSnapshot?.({
        v: 1,
        backendId: 'claude',
        agentId: 'claude',
        updatedAt: 123,
        primaryItemId: 'todo:derived:claude.todo:Run%20tests%7C0',
        ownedSourceFamilies: ['todo:derived:claude.todo'],
        items: [
          {
            id: 'todo:derived:claude.todo:Run%20tests%7C0',
            kind: 'todo',
            origin: 'vendor',
            status: 'pending',
            title: 'Run tests',
            backendId: 'claude',
            agentId: 'claude',
            updatedAt: 123,
          },
        ],
      });
      dispatchOpts.onWorkStateSnapshot?.({
        v: 1,
        backendId: 'claude',
        agentId: 'claude',
        updatedAt: 124,
        primaryItemId: null,
        ownedSourceFamilies: ['todo:derived:claude.todo'],
        items: [],
      });
      await waitForAbort(dispatchOpts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);

    const switchHandler = await switchHandlerReady;
    await dispatchStarted.promise;

    await vi.waitFor(() => {
      expect(client.getMetadataSnapshot()).toEqual(expect.objectContaining({
        sessionWorkStateV1: expect.objectContaining({
          backendId: 'claude',
          agentId: 'claude',
          primaryItemId: null,
          items: [],
        }),
      }));
    });

    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  }, 30_000);

  it('uses Claude session account settings for ready webhook dispatch when no active snapshot is available', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 202,
    }));
    vi.stubGlobal('fetch', fetchSpy);

    const { session, sendToAllDevices, switchHandlerReady } = createRemoteHarness({ sessionId: 'sess_0' });
    session.accountSettings = accountSettingsParse({
      notificationChannelsV1: [
        {
          v: 1,
          id: 'webhook-ready',
          kind: 'webhook',
          enabled: true,
          url: 'https://hooks.example.test/ready',
          topics: {
            ready: true,
            permissionRequest: false,
            userActionRequest: false,
          },
          readyIncludeMessageText: false,
        },
      ],
    });

    const dispatchStarted = createDeferred<void>();
    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as any;
      dispatchStarted.resolve(undefined);
      await dispatchOpts.onReady?.();
      await waitForAbort(dispatchOpts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);

    const switchHandler = await switchHandlerReady;
    await dispatchStarted.promise;

    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
    expect(sendToAllDevices).not.toHaveBeenCalled();

    const url = fetchSpy.mock.calls.at(0)?.at(0);
    expect(url).toBe('https://hooks.example.test/ready');

    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  }, 30_000);

  it('flushes queued subagent output without emitting ready', async () => {
    const { session, client, sendToAllDevices, sendClaudeSessionMessage, switchHandlerReady } = createRemoteHarness({ sessionId: 'sess_0' });
    session.queue.push('hello', { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true } satisfies EnhancedMode);

    const dispatchStarted = createDeferred<void>();
    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      dispatchStarted.resolve(undefined);
      await waitForAbort((opts as RemoteDispatchMockOptions).signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);

    const switchHandler = await switchHandlerReady;
    await dispatchStarted.promise;
    type SubagentFlushDispatchOptions = RemoteDispatchMockOptions & {
      nextMessage?: () => Promise<unknown>;
      onMessage?: (message: unknown) => void;
      onSubagentFlush?: () => Promise<void>;
    };
    const dispatchOpts = mockClaudeRemoteDispatch.mock.calls[0]?.[0] as SubagentFlushDispatchOptions | undefined;
    expect(typeof dispatchOpts?.onSubagentFlush).toBe('function');

    await dispatchOpts?.nextMessage?.();

    const queuedMessage = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_delayed', name: 'Bash', input: {} }],
      },
    };
    mockConvert.mockReturnValueOnce(queuedMessage);

    dispatchOpts?.onMessage?.({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_delayed', name: 'Bash', input: {} }],
      },
    });

    expect(sendClaudeSessionMessage).not.toHaveBeenCalled();

    await dispatchOpts?.onSubagentFlush?.();

    expect(sendClaudeSessionMessage).toHaveBeenCalledWith(queuedMessage, undefined);
    expect(client.sendSessionEvent).not.toHaveBeenCalledWith({ type: 'ready' });
    expect(sendToAllDevices).not.toHaveBeenCalled();

    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  }, 30_000);

  it('does not mount Ink UI for daemon-started sessions even when a TTY is available', async () => {
    // `process.stdout.isTTY` is not reliably writable across Node versions. Mock the decision helper
    // instead to simulate a TTY-capable environment.
    vi.doMock('@/ui/tty/resolveHasTTY', () => ({
      resolveHasTTY: () => true,
    }));

    const { session, switchHandlerReady } = createRemoteHarness({ sessionId: 'sess_0' });
    (session as any).startedBy = 'daemon';

    mockInkRender.mockClear();
    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as RemoteDispatchMockOptions;
      await waitForAbort(dispatchOpts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);

    await vi.waitFor(() => {
      expect(mockClaudeRemoteDispatch).toHaveBeenCalledTimes(1);
    });

    expect(mockInkRender).not.toHaveBeenCalled();

    const switchHandler = await switchHandlerReady;
    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  }, 30_000);

  it('starts the static remote-control surface for daemon-started tmux sessions', async () => {
    const stopStaticControl = vi.fn(async () => {});
    const startStaticControl = vi.fn((_params: StartRemoteModeStaticControlParams) => ({ stop: stopStaticControl }));
    vi.doMock('@/ui/remoteControl/remoteModeControl', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/ui/remoteControl/remoteModeControl')>();
      return {
        ...actual,
        resolveRemoteModeControlSurface: vi.fn(() => 'static'),
        startRemoteModeStaticControl: startStaticControl,
      };
    });

    const { session, switchHandlerReady } = createRemoteHarness({
      sessionId: 'sess_0',
      startedBy: 'daemon',
      terminalRuntime: { mode: 'tmux' },
    });

    mockInkRender.mockClear();
    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as RemoteDispatchMockOptions;
      await waitForAbort(dispatchOpts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);

    await vi.waitFor(() => {
      expect(startStaticControl).toHaveBeenCalledTimes(1);
    });
    expect(startStaticControl.mock.calls[0]?.[0]).toMatchObject({
      providerName: 'Claude',
      allowSwitchToLocal: true,
    });
    expect(mockInkRender).not.toHaveBeenCalled();

    const switchHandler = await switchHandlerReady;
    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
    expect(stopStaticControl).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('starts the static remote-control surface from synced tmux metadata when terminal runtime flags are absent', async () => {
    const stopStaticControl = vi.fn(async () => {});
    const resolveRemoteModeControlSurface = vi.fn(() => 'static');
    const startStaticControl = vi.fn((_params: StartRemoteModeStaticControlParams) => ({ stop: stopStaticControl }));
    vi.doMock('@/ui/remoteControl/remoteModeControl', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/ui/remoteControl/remoteModeControl')>();
      return {
        ...actual,
        resolveRemoteModeControlSurface,
        startRemoteModeStaticControl: startStaticControl,
      };
    });

    const { session, switchHandlerReady } = createRemoteHarness({
      sessionId: 'sess_0',
      startedBy: 'daemon',
      terminalRuntime: null,
      metadata: {
        terminal: {
          mode: 'tmux',
          requested: 'tmux',
          tmux: { target: 'happy:session-from-metadata' },
        },
      } as Metadata,
    });

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as RemoteDispatchMockOptions;
      await waitForAbort(dispatchOpts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);

    await vi.waitFor(() => {
      expect(startStaticControl).toHaveBeenCalledTimes(1);
    });
    expect(resolveRemoteModeControlSurface).toHaveBeenCalledWith(expect.objectContaining({
      startedBy: 'daemon',
      terminalMode: 'tmux',
    }));

    const switchHandler = await switchHandlerReady;
    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
    expect(stopStaticControl).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('starts the static remote-control surface when only a tmux target is available', async () => {
    const stopStaticControl = vi.fn(async () => {});
    const startStaticControl = vi.fn((_params: StartRemoteModeStaticControlParams) => ({ stop: stopStaticControl }));
    vi.doMock('@/ui/remoteControl/remoteModeControl', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/ui/remoteControl/remoteModeControl')>();
      return {
        ...actual,
        startRemoteModeStaticControl: startStaticControl,
      };
    });

    const stdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const stdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });

    try {
      const { session, switchHandlerReady } = createRemoteHarness({
        sessionId: 'sess_0',
        startedBy: 'daemon',
        terminalRuntime: { tmuxTarget: 'happy:session-from-target-only' },
      });

      mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
        const dispatchOpts = opts as RemoteDispatchMockOptions;
        await waitForAbort(dispatchOpts.signal);
      });

      const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
      const launcherPromise = claudeRemoteLauncher(session);

      await vi.waitFor(() => {
        expect(startStaticControl).toHaveBeenCalledTimes(1);
      });

      const switchHandler = await switchHandlerReady;
      expect(await switchHandler({ to: 'local' })).toBe(true);
      await expect(launcherPromise).resolves.toBe('switch');
      expect(stopStaticControl).toHaveBeenCalledTimes(1);
    } finally {
      if (stdinIsTTY) {
        Object.defineProperty(process.stdin, 'isTTY', stdinIsTTY);
      } else {
        delete (process.stdin as { isTTY?: unknown }).isTTY;
      }
      if (stdoutIsTTY) {
        Object.defineProperty(process.stdout, 'isTTY', stdoutIsTTY);
      } else {
        delete (process.stdout as { isTTY?: unknown }).isTTY;
      }
    }
  }, 30_000);

  it('respects switch RPC params and is idempotent', async () => {
    const { session, switchHandlerReady } = createRemoteHarness();

    session.onSessionFound('sess_1', hookWithTranscript('/tmp/sess_1.jsonl'));

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as RemoteDispatchMockOptions;
      await waitForAbort(dispatchOpts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');

    const launcherPromise = claudeRemoteLauncher(session);
    const switchHandler = await switchHandlerReady;

    expect(await switchHandler({ to: 'remote' })).toBe(true);
    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  });

  it('does not append hidden change-title instructions to queued prompts', async () => {
    const { session, switchHandlerReady } = createRemoteHarness({ sessionId: 'sess_0' });

    const firstSeen = createDeferred<any>();
    const secondSeen = createDeferred<any>();

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as any;
      const first = await dispatchOpts.nextMessage?.();
      firstSeen.resolve(first);
      const second = await dispatchOpts.nextMessage?.();
      secondSeen.resolve(second);
      await waitForAbort(dispatchOpts.signal);
    });

    // Push one message at a time so MessageQueue2 doesn't batch both into a single prompt.
    session.queue.push('hello', { permissionMode: 'default' } satisfies EnhancedMode);

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);

    const first = await firstSeen.promise;
    expect(first?.message).toBe('hello');
    expect(first?.message).not.toContain(CHANGE_TITLE_INSTRUCTION);

    session.queue.push('again', { permissionMode: 'default' } satisfies EnhancedMode);

    const second = await secondSeen.promise;
    expect(second?.message).toBe('again');
    expect(second?.message).not.toContain(CHANGE_TITLE_INSTRUCTION);

    const switchHandler = await switchHandlerReady;
    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  });

  it('injects Happier MCP servers into the remote dispatch options', async () => {
    const { session, switchHandlerReady } = createRemoteHarness({ sessionId: 'sess_0' });

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as any;
      expect(dispatchOpts?.happierMcpServers?.happier).toBeTruthy();
      await waitForAbort(dispatchOpts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);

    await vi.waitFor(() => {
      expect(mockClaudeRemoteDispatch).toHaveBeenCalledTimes(1);
    });

    const switchHandler = await switchHandlerReady;
    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  });

  it('treats null sessionId as a new session boundary', async () => {
    const { session, switchHandlerReady } = createRemoteHarness({ sessionId: null });

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as RemoteDispatchMockOptions;
      await waitForAbort(dispatchOpts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');

    const launcherPromise = claudeRemoteLauncher(session);
    const switchHandler = await switchHandlerReady;

    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');

    expect(mockResetParentChain).toHaveBeenCalledTimes(1);
  });

  it('replaces TaskOutput tool_result transcript payloads with an empty string (content is streamed via sidechain)', async () => {
        const { session, sendClaudeSessionMessage, switchHandlerReady } = createRemoteHarness();

    const taskOutputToolUseId = 'tool_taskoutput_1';

    // Emit a "TaskOutput" tool_use followed by its tool_result.
    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as RemoteDispatchMockOptions & { onMessage?: (m: unknown) => void };

      dispatchOpts.onMessage?.({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: taskOutputToolUseId,
              name: 'TaskOutput',
              input: { task_id: 'task_1' },
            },
          ],
        },
      });

      // Valid RawJSONLinesSchema record; includes agentId so TaskOutput importer considers it.
      const jsonl = JSON.stringify({ type: 'assistant', uuid: 'uuid_1', agentId: 'agent_1' });

      dispatchOpts.onMessage?.({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: taskOutputToolUseId,
              content: jsonl,
            },
          ],
        },
      });

      await waitForAbort(dispatchOpts.signal);
    });

    // Convert the SDK user message into a RawJSONLines-ish shape that claudeRemoteLauncher rewrites.
    mockConvert.mockImplementation((message: any) => {
      if (message?.type !== 'user') return null;
      const content = Array.isArray(message?.message?.content)
        ? message.message.content.map((item: any) => ({ ...item }))
        : message?.message?.content;
      return {
        type: 'user',
        uuid: 'happy_uuid_1',
        message: { content },
      };
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
        const launcherPromise = claudeRemoteLauncher(session);

        await vi.waitFor(() => {
          expect(sendClaudeSessionMessage).toHaveBeenCalled();
        });

        const sent = sendClaudeSessionMessage.mock.calls
          .map((c: any[]) => c[0])
          .find((m: any) => {
          const blocks = m?.message?.content;
          if (!Array.isArray(blocks)) return false;
          return blocks.some((b: any) => b?.type === 'tool_result' && b?.tool_use_id === taskOutputToolUseId);
        });
    expect(sent).toBeTruthy();

    const blocks = (sent as any).message.content as any[];
    const toolResult = blocks.find((b) => b?.type === 'tool_result' && b?.tool_use_id === taskOutputToolUseId);
    expect(toolResult?.content).toBe('');
    expect(String(toolResult?.content)).not.toContain('TaskOutput');
    expect(String(toolResult?.content)).not.toContain('imported=');
    expect(String(toolResult?.content)).not.toContain('buffered=');

    const switchHandler = await switchHandlerReady;
    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  }, 30_000);

  it('imports TaskOutput JSONL records into the Task sidechain with claude-taskoutput metadata', async () => {
    const { session, sendClaudeSessionMessage, switchHandlerReady } = createRemoteHarness();

    const taskToolUseId = 'tool_task_1';
    const taskOutputToolUseId = 'tool_taskoutput_1';
    const agentId = 'agent_1';

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as RemoteDispatchMockOptions & { onMessage?: (m: unknown) => void };

      dispatchOpts.onMessage?.({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: taskToolUseId,
              name: 'Task',
              input: { prompt: 'do work' },
            },
            {
              type: 'tool_use',
              id: taskOutputToolUseId,
              name: 'TaskOutput',
              input: { task_id: agentId, block: true, timeout: 2000 },
            },
          ],
        },
      });

      dispatchOpts.onMessage?.({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: taskToolUseId, content: `agentId: ${agentId}` }],
        },
      });

      dispatchOpts.onMessage?.({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: taskOutputToolUseId,
              content: `${JSON.stringify({
                type: 'assistant',
                uuid: 'uuid_1',
                parentUuid: null,
                timestamp: new Date().toISOString(),
                sessionId: 'sess_1',
                userType: 'external',
                cwd: '/tmp',
                version: '0.0.0',
                gitBranch: 'main',
                isSidechain: true,
                agentId,
                message: { role: 'assistant', content: [{ type: 'text', text: 'SUBTASK_OK' }] },
              })}\n`,
            },
          ],
        },
      });

      dispatchOpts.onMessage?.({
        type: 'result',
        subtype: 'success',
        result: 'DONE_1',
        num_turns: 1,
        total_cost_usd: 0,
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
      });

      await waitForAbort(dispatchOpts.signal);
    });

    mockConvert.mockImplementation((message: any) => {
      if (message?.type !== 'assistant' && message?.type !== 'user') return null;
      const content = Array.isArray(message?.message?.content)
        ? message.message.content.map((item: any) => ({ ...item }))
        : message?.message?.content;
      return {
        type: message.type,
        uuid: `happy_${message.type}_${Math.random().toString(36).slice(2)}`,
        message: { role: message?.message?.role ?? message.type, content },
      };
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);

    await vi.waitFor(() => {
      const imported = sendClaudeSessionMessage.mock.calls.find(
        (c: any[]) => c?.[1]?.importedFrom === 'claude-taskoutput' && c?.[0]?.sidechainId === taskToolUseId,
      );
      expect(imported).toBeTruthy();
    });

    const importedCall = sendClaudeSessionMessage.mock.calls.find(
      (c: any[]) => c?.[1]?.importedFrom === 'claude-taskoutput' && c?.[0]?.sidechainId === taskToolUseId,
    );
    expect(importedCall?.[1]).toMatchObject({
      importedFrom: 'claude-taskoutput',
      claudeTaskOutputToolUseId: taskOutputToolUseId,
      claudeTaskId: agentId,
      claudeAgentId: agentId,
      claudeRemoteSessionId: 'sess_1',
    });
    expect(importedCall?.[0]).toMatchObject({
      type: 'assistant',
      isSidechain: true,
      sidechainId: taskToolUseId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'SUBTASK_OK' }] },
    });

    const switchHandler = await switchHandlerReady;
    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  }, 30_000);

  it('imports Task subagent output_file JSONL as sidechain messages (without TaskOutput)', async () => {
    const { session, client, switchHandlerReady } = createRemoteHarness();

    const dir = await mkdtemp(join(tmpdir(), 'happy-remote-subagent-jsonl-'));
    const agentId = 'aa5e728';
    const jsonlPath = join(dir, `agent-${agentId}.jsonl`);
    const outputSymlinkPath = join(dir, `${agentId}.output`);

    const rootPrompt = {
      type: 'user',
      uuid: 'u1',
      isSidechain: true,
      agentId,
      message: { role: 'user', content: 'Do work' },
    };
    const assistant = {
      type: 'assistant',
      uuid: 'a1',
      isSidechain: true,
      agentId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    };

    await writeFile(jsonlPath, `${JSON.stringify(rootPrompt)}\n${JSON.stringify(assistant)}\n`, 'utf8');
    await symlink(jsonlPath, outputSymlinkPath);

    try {
      mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
        const dispatchOpts = opts as RemoteDispatchMockOptions & { onMessage?: (m: unknown) => void };

        dispatchOpts.onMessage?.({
          type: 'assistant',
          parent_tool_use_id: null,
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'tool_task_1',
                name: 'Task',
                input: { prompt: 'do work' },
              },
            ],
          },
        });

        dispatchOpts.onMessage?.({
          type: 'user',
          parent_tool_use_id: null,
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool_task_1',
                content: `Async agent launched successfully.\nagentId: ${agentId}\noutput_file: ${outputSymlinkPath}\n`,
              },
            ],
          },
        });

        // Simulate file growth and ensure the collector can import incrementally.
        await appendFile(jsonlPath, `${JSON.stringify({ ...assistant, uuid: 'a2' })}\n`, 'utf8');

        await waitForAbort(dispatchOpts.signal);
      });

      // Ignore normal SDK-to-log conversions; we only care about imported file records.
      mockConvert.mockReturnValue(null);

      const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
      const launcherPromise = claudeRemoteLauncher(session);

      await vi.waitFor(() => {
        expect(client.sendClaudeSessionMessage).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'assistant', uuid: 'a1', sidechainId: 'tool_task_1' }),
          expect.objectContaining({ importedFrom: 'claude-subagent-file', claudeAgentId: agentId, sidechainId: 'tool_task_1' }),
        );
      });

      await vi.waitFor(() => {
        expect(client.sendClaudeSessionMessage).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'assistant', uuid: 'a2', sidechainId: 'tool_task_1' }),
          expect.objectContaining({ importedFrom: 'claude-subagent-file', claudeAgentId: agentId, sidechainId: 'tool_task_1' }),
        );
      });

      const switchHandler = await switchHandlerReady;
      expect(await switchHandler({ to: 'local' })).toBe(true);
      await expect(launcherPromise).resolves.toBe('switch');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('emits a canonical Diff transcript tool after a successful write-like turn', async () => {
    const { session, client, switchHandlerReady } = createRemoteHarness();

    mockConvert.mockImplementation((message: any) => {
      if (message?.type === 'assistant') {
        const content = Array.isArray(message?.message?.content) ? message.message.content : [];
        return {
          type: 'assistant',
          uuid: `assistant-${content[0]?.id ?? 'msg'}`,
          isSidechain: false,
          message: { role: 'assistant', content },
        };
      }
      if (message?.type === 'user') {
        const content = Array.isArray(message?.message?.content) ? message.message.content : [];
        return {
          type: 'user',
          uuid: `user-${content[0]?.tool_use_id ?? 'msg'}`,
          isSidechain: false,
          message: { role: 'user', content },
        };
      }
      return null;
    });

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as RemoteDispatchMockOptions & { onMessage?: (m: unknown) => void };

      dispatchOpts.onMessage?.({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool_edit_1',
              name: 'Edit',
              input: { file_path: 'src/app.ts', old_string: 'old', new_string: 'new' },
            },
          ],
        },
      });

      dispatchOpts.onMessage?.({
        type: 'user',
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_edit_1',
              content: 'OK',
              is_error: false,
            },
          ],
        },
      });

      dispatchOpts.onMessage?.({
        type: 'result',
        subtype: 'success',
        session_id: 'sess_1',
      });

      await waitForAbort(dispatchOpts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);
    const sendClaudeSessionMessageMock = client.sendClaudeSessionMessage as ReturnType<typeof vi.fn>;

    await vi.waitFor(() => {
      const diffCall = sendClaudeSessionMessageMock.mock.calls.find((call: any[]) => {
        const content = Array.isArray(call?.[0]?.message?.content) ? call[0].message.content : [];
        return content.some((block: any) => block?.type === 'tool_use' && block?.name === 'Diff');
      });
      expect(diffCall).toBeTruthy();
    });

    const diffCall = sendClaudeSessionMessageMock.mock.calls.find((call: any[]) => {
      const content = Array.isArray(call?.[0]?.message?.content) ? call[0].message.content : [];
      return content.some((block: any) => block?.type === 'tool_use' && block?.name === 'Diff');
    });
    const diffCallBlock = diffCall?.[0]?.message?.content?.find((block: any) => block?.type === 'tool_use' && block?.name === 'Diff');
    expect(diffCallBlock?.input?._happier).toMatchObject({
      protocol: 'claude',
      provider: 'claude',
      canonicalToolName: 'Diff',
      sessionChangeScope: 'turn',
      source: 'provider_tool',
    });

    const diffResult = sendClaudeSessionMessageMock.mock.calls.find((call: any[]) => {
      const content = Array.isArray(call?.[0]?.message?.content) ? call[0].message.content : [];
      return content.some((block: any) => block?.type === 'tool_result' && typeof block?.tool_use_id === 'string');
    });
    expect(diffResult).toBeTruthy();

    const switchHandler = await switchHandlerReady;
    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  }, 30_000);

  it('inserts a synthetic sidechain prompt root for Agent tool uses (Claude Agent Teams)', async () => {
    const { session, client, switchHandlerReady } = createRemoteHarness();

    mockConvert.mockReturnValue(null);
    mockConvertSidechainUserMessage.mockReturnValue({
      type: 'user',
      uuid: 'u_side_1',
      isSidechain: true,
      sidechainId: 'tool_agent_1',
      message: { role: 'user', content: 'Agent prompt' },
    });

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as RemoteDispatchMockOptions & { onMessage?: (m: unknown) => void };

      dispatchOpts.onMessage?.({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool_agent_1',
              name: 'Agent',
              input: { prompt: 'Agent prompt' },
            },
          ],
        },
      });

      await waitForAbort(dispatchOpts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);

    await vi.waitFor(() => {
      expect(mockConvertSidechainUserMessage).toHaveBeenCalledWith('tool_agent_1', 'Agent prompt');
    });

    await vi.waitFor(() => {
      expect(client.sendClaudeSessionMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'user', sidechainId: 'tool_agent_1', isSidechain: true }),
        undefined,
      );
    });

    const switchHandler = await switchHandlerReady;
    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  }, 30_000);

  it('imports Task subagent JSONL from inferred ~/.claude projects path when output_file is missing', async () => {
    const { session, client, switchHandlerReady } = createRemoteHarness();

    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happy-claude-config-'));
    const agentId = 'aa5e728';
    const claudeSessionId = 'claude_session_1';

    const { getProjectPath } = await import('./utils/path');
    const projectDir = getProjectPath(session.path, claudeConfigDir);
    const subagentsDir = join(projectDir, claudeSessionId, 'subagents');
    await mkdir(subagentsDir, { recursive: true });

    const jsonlPath = join(subagentsDir, `agent-${agentId}.jsonl`);

    const rootPrompt = {
      type: 'user',
      uuid: 'u1',
      isSidechain: true,
      agentId,
      message: { role: 'user', content: 'Do work' },
    };
    const assistant = {
      type: 'assistant',
      uuid: 'a1',
      isSidechain: true,
      agentId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    };

        await writeFile(jsonlPath, `${JSON.stringify(rootPrompt)}\n${JSON.stringify(assistant)}\n`, 'utf8');

        const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
        try {
          process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;

          mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
            const dispatchOpts = opts as RemoteDispatchMockOptions & { onMessage?: (m: unknown) => void };

        dispatchOpts.onMessage?.({
          type: 'assistant',
          session_id: claudeSessionId,
          parent_tool_use_id: null,
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'tool_task_1',
                name: 'Task',
                input: { prompt: 'do work' },
              },
            ],
          },
        });

        dispatchOpts.onMessage?.({
          type: 'user',
          session_id: claudeSessionId,
          parent_tool_use_id: null,
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool_task_1',
                content: `Async agent launched successfully.\nagentId: ${agentId}\n`,
              },
            ],
          },
        });

        await waitForAbort(dispatchOpts.signal);
      });

      // Ignore normal SDK-to-log conversions; we only care about imported file records.
      mockConvert.mockReturnValue(null);

      const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
      const launcherPromise = claudeRemoteLauncher(session);

      await vi.waitFor(() => {
        expect(client.sendClaudeSessionMessage).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'assistant', uuid: 'a1', sidechainId: 'tool_task_1' }),
          expect.objectContaining({ importedFrom: 'claude-subagent-file', claudeAgentId: agentId, sidechainId: 'tool_task_1' }),
        );
      });

          const switchHandler = await switchHandlerReady;
          expect(await switchHandler({ to: 'local' })).toBe(true);
          await expect(launcherPromise).resolves.toBe('switch');
        } finally {
          if (typeof previousClaudeConfigDir === 'string') {
            process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
          } else {
            delete process.env.CLAUDE_CONFIG_DIR;
          }
          await rm(claudeConfigDir, { recursive: true, force: true });
        }
      }, 30_000);
});
