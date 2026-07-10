import { describe, expect, it, vi } from 'vitest';
import { buildBackendTargetKey, ProviderConnectionIdSchema } from '@happier-dev/protocol';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { runHostSessionRuntime, type HostSessionRuntimeConfig, type HostSessionRuntimeRunOptions } from './runHostSessionRuntime';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { resolveForkInheritedOverridesFromMetadata } from '@/session/fork/resolveForkInheritedOverridesFromMetadata';
import { HAPPIER_DAEMON_INITIAL_PROMPT_ENV_KEY } from '@/agent/runtime/daemonInitialPrompt';

function createSessionFixture(sessionId: string) {
  const handlers = new Map<string, (payload?: unknown) => unknown>();
  const session: any = {
    sessionId,
    rpcHandlerManager: {
      sessionId,
      registerHandler: (name: string, handler: (payload?: unknown) => unknown) => {
        handlers.set(name, handler);
      },
    },
    setSessionRuntimeControls: vi.fn(),
    sendAgentMessage: vi.fn(),
    sendSessionEvent: vi.fn(),
    keepAlive: vi.fn(),
    getMetadataSnapshot: () => ({ path: '/tmp/workspace', permissionMode: 'default' }),
    updateMetadata: vi.fn(),
    enqueueSessionTurnMutation: vi.fn(async () => undefined),
    deferDeliveredUserMessageWatermarkToProviderAcceptance: vi.fn(),
    confirmUserMessageDeliveredToProvider: vi.fn(),
    blockPendingMessageDelivery: vi.fn(async () => true),
    retryPendingMessageDelivery: vi.fn(async () => true),
    sendSessionDeath: vi.fn(),
    flush: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };

  return {
    session,
    handlers,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHarness() {
  let defaultReadyCalls = 0;
  let customReadyCalls = 0;
  let cleanupCalls = 0;
  let beforeInitializeCalls = 0;
  let onAfterStartCalls = 0;
  let onAfterResetCalls = 0;
  let permissionResetCalls = 0;
  let queueResetCalls = 0;
  let archiveCalls = 0;
  let killHandler: (() => void | Promise<void>) | null = null;
  const killHandlersBySessionId = new Map<string, () => void | Promise<void>>();

  const sessionFixture = createSessionFixture('session-1');
  const session = sessionFixture.session;
  const handlers = sessionFixture.handlers;
  const runtimeMessageSubscribers = new Set<(message: unknown) => void>();

  const runtime: any = {
    beginTurn: vi.fn(),
    beginTurnLifecycle: vi.fn(function (this: unknown) {
      if (this !== runtime) {
        throw new Error('beginTurnLifecycle called with wrong receiver');
      }
      runtime.beginTurn();
    }),
    startOrLoad: vi.fn(async () => undefined),
    startOrLoadSession: vi.fn(async function (this: unknown, opts?: { resumeId?: string | null; importHistory?: boolean }) {
      if (this !== runtime) {
        throw new Error('startOrLoadSession called with wrong receiver');
      }
      await runtime.startOrLoad({
        ...(typeof opts?.resumeId === 'string' ? { resumeId: opts.resumeId } : {}),
        ...(typeof opts?.importHistory === 'boolean' ? { importHistory: opts.importHistory } : {}),
      });
    }),
    sendPrompt: vi.fn(async () => undefined),
    sendTurnPrompt: vi.fn(async function (this: unknown, prompt: string) {
      if (this !== runtime) {
        throw new Error('sendTurnPrompt called with wrong receiver');
      }
      await runtime.sendPrompt(prompt);
    }),
    flushTurn: vi.fn(),
    waitForTurnCompletion: vi.fn(async function (this: unknown) {
      if (this !== runtime) {
        throw new Error('waitForTurnCompletion called with wrong receiver');
      }
      await runtime.flushTurn();
    }),
    reset: vi.fn(async () => undefined),
    resetOrDisposeRuntime: vi.fn(async function (this: unknown) {
      if (this !== runtime) {
        throw new Error('resetOrDisposeRuntime called with wrong receiver');
      }
      await runtime.reset();
    }),
    getSessionId: vi.fn(() => null),
    readSessionIdentity: vi.fn(function (this: unknown) {
      if (this !== runtime) {
        throw new Error('readSessionIdentity called with wrong receiver');
      }
      return { sessionId: runtime.getSessionId() };
    }),
    cancel: vi.fn(async () => undefined),
    cancelTurn: vi.fn(async function (this: unknown) {
      if (this !== runtime) {
        throw new Error('cancelTurn called with wrong receiver');
      }
      await runtime.cancel();
    }),
    setSessionMode: vi.fn(async () => undefined),
    setSessionConfigOption: vi.fn(async () => undefined),
    setSessionModel: vi.fn(async () => undefined),
    updateSessionRuntimeConfig: vi.fn(async function (
      this: unknown,
      update: { modeId?: string | null; modelId?: string | null; configOption?: { id: string; value: string | number | boolean | null } | null },
    ) {
      if (this !== runtime) {
        throw new Error('updateSessionRuntimeConfig called with wrong receiver');
      }
      if (typeof update.modeId === 'string') {
        await runtime.setSessionMode(update.modeId);
      }
      if (typeof update.modelId === 'string') {
        await runtime.setSessionModel(update.modelId);
      }
      if (update.configOption) {
        await runtime.setSessionConfigOption(update.configOption.id, update.configOption.value);
      }
    }),
    subscribeRuntimeEvents: vi.fn((handler: (message: unknown) => void) => {
      runtimeMessageSubscribers.add(handler);
      return () => {
        runtimeMessageSubscribers.delete(handler);
      };
    }),
    emitRuntimeMessage: vi.fn((message: unknown) => {
      for (const subscriber of runtimeMessageSubscribers) {
        subscriber(message);
      }
    }),
    steerInFlightTurn: vi.fn(async function (this: unknown, prompt: string) {
      if (this !== runtime) {
        throw new Error('steerInFlightTurn called with wrong receiver');
      }
      if (typeof runtime.steerPrompt !== 'function') return;
      await runtime.steerPrompt(prompt);
    }),
  };

  const opts: HostSessionRuntimeRunOptions = {
    credentials: { token: 'x' } as any,
  };

  const config: HostSessionRuntimeConfig = {
    flavor: 'qwen',
    policyAgentId: 'qwen',
    backendDisplayName: 'Qwen Code',
    uiLogPrefix: '[Qwen]',
    providerName: 'Qwen Code',
    waitingForCommandLabel: 'Qwen Code',
    agentMessageType: 'qwen',
    machineMetadata: {
      host: 'host',
      platform: 'darwin',
      happyCliVersion: '1.0.0',
      homeDir: '/tmp',
      happyHomeDir: '/tmp/.happy',
      happyLibDir: '/tmp/lib',
    },
    terminalDisplay: (() => null) as any,
    beforeInitializeSession: ({ metadata }: any) => {
      beforeInitializeCalls += 1;
      (metadata as any).auggieAllowIndexing = true;
    },
    createSessionRuntime: () => ({
      operations: runtime,
      nativeRuntime: runtime,
    }),
    onAfterStart: async () => {
      onAfterStartCalls += 1;
    },
    onAfterReset: async () => {
      onAfterResetCalls += 1;
    },
    formatPromptErrorMessage: (error) => String(error),
    shouldRenderTerminalDisplay: () => false,
  };

  const deps: any = {
    initializeBackendApiContextFn: async () => ({
      api: {
        push: () => ({
          sendToAllDevices: () => {
            defaultReadyCalls += 1;
          },
        }),
      },
      machineId: 'machine-1',
    }),
    createSessionMetadataFn: () => ({
      state: { controlledByUser: false },
      metadata: { path: '/tmp/workspace', permissionMode: 'default', permissionModeUpdatedAt: Date.now() },
    }),
    initializeBackendRunSessionFn: async ({ metadata }: any) => {
      expect((metadata as any).auggieAllowIndexing).toBe(true);
      return {
        session,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: false,
      };
    },
    resolveRunnerMcpServersFn: async () => ({
      happierMcpServer: { stop: () => undefined },
      mcpServers: {},
    }),
    createProviderEnforcedPermissionHandlerFn: () => ({
      setPermissionMode: () => undefined,
      reset: () => {
        permissionResetCalls += 1;
      },
      updateSession: () => undefined,
    }),
    createPermissionModeQueueStateFn: () => ({
      messageQueue: {
        reset: () => {
          queueResetCalls += 1;
        },
        size: () => 0,
      },
      rebindSession: () => undefined,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => undefined,
      getCurrentPermissionModeUpdatedAt: () => 0,
      setCurrentPermissionModeUpdatedAt: () => undefined,
    }),
    runPermissionModePromptLoopFn: async (params: any) => {
      await params.onAfterStart?.();
      await params.onAfterReset?.();
      params.sendReady();
    },
    sendReadyWithPushNotificationFn: () => {
      defaultReadyCalls += 1;
    },
    registerKillSessionHandlerFn: (manager: unknown, handler: () => void | Promise<void>) => {
      const sessionId =
        typeof (manager as { sessionId?: unknown } | null)?.sessionId === 'string'
          ? String((manager as { sessionId: string }).sessionId)
          : 'unknown';
      (manager as { registerHandler?: (method: string, handler: () => Promise<unknown>) => void } | null)?.registerHandler?.(
        RPC_METHODS.KILL_SESSION,
        async () => {
          await handler();
          return { success: true, message: 'Killing happier process' };
        },
      );
      killHandlersBySessionId.set(sessionId, handler);
      killHandler = handler;
    },
    archiveAndCloseRuntimeSessionFn: async () => {
      archiveCalls += 1;
    },
    cleanupBackendRunResourcesFn: async ({ keepAliveInterval, unmountUi }: any) => {
      cleanupCalls += 1;
      clearInterval(keepAliveInterval);
      unmountUi?.();
    },
  };

  return {
    opts,
    config,
    deps,
    session,
    runtime,
    handlers,
    metrics: {
      get defaultReadyCalls() {
        return defaultReadyCalls;
      },
      get customReadyCalls() {
        return customReadyCalls;
      },
      bumpCustomReadyCalls() {
        customReadyCalls += 1;
      },
      get cleanupCalls() {
        return cleanupCalls;
      },
      get beforeInitializeCalls() {
        return beforeInitializeCalls;
      },
      get onAfterStartCalls() {
        return onAfterStartCalls;
      },
      get onAfterResetCalls() {
        return onAfterResetCalls;
      },
      get permissionResetCalls() {
        return permissionResetCalls;
      },
      get queueResetCalls() {
        return queueResetCalls;
      },
      get archiveCalls() {
        return archiveCalls;
      },
      get killHandler() {
        return killHandler;
      },
      getKillHandler(sessionId: string) {
        return killHandlersBySessionId.get(sessionId) ?? null;
      },
    },
    createSessionFixture,
  };
}

function setSessionRuntimeFactory(
  config: HostSessionRuntimeConfig,
  factory: NonNullable<HostSessionRuntimeConfig['createSessionRuntime']>,
): void {
  config.createSessionRuntime = factory;
}

function createTerminalRemoteModeLoopFixture() {
  return {
    startingMode: 'remote' as const,
    remoteExitCode: 0,
    runTerminal: vi.fn(async () => ({ type: 'exit' as const, code: 0 })),
    runRemote: vi.fn(async () => 'exit' as const),
    onModeChange: vi.fn(),
  };
}

describe('runHostSessionRuntime', () => {
  it('preserves scoped unset environment keys through host option canonicalization', async () => {
    const harness = createHarness();
    harness.opts.unsetEnvironmentVariables = ['OPENAI_API_KEY', 'Gemini_Api_Key'];
    const beforeInitializeSession = harness.config.beforeInitializeSession;
    harness.config.beforeInitializeSession = (params) => {
      expect(params.opts.unsetEnvironmentVariables).toEqual(['OPENAI_API_KEY', 'Gemini_Api_Key']);
      beforeInitializeSession?.(params);
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('rejects invalid unset environment keys at the host runtime boundary', async () => {
    const harness = createHarness();
    harness.opts.unsetEnvironmentVariables = ['OPENAI_API_KEY', 'BAD=NAME'];

    await expect(runHostSessionRuntime(harness.opts, harness.config, harness.deps))
      .rejects.toThrow('Invalid environment variable unset key');
  });

  it('defers the delivered watermark before creating the native runtime', async () => {
    const harness = createHarness();
    harness.config.userMessageDeliveryWatermarkMode = 'providerAcceptance';
    harness.runtime.setOnPromptAcceptedByProvider = vi.fn();
    setSessionRuntimeFactory(harness.config, (params) => {
      expect(params.session.sessionId).toBe(harness.session.sessionId);
      expect(harness.session.deferDeliveredUserMessageWatermarkToProviderAcceptance).toHaveBeenCalledTimes(1);
      return {
        operations: harness.runtime as any,
        nativeRuntime: harness.runtime as any,
      };
    });

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('forwards the provider-acceptance pending materialization policy before creating the native runtime', async () => {
    const harness = createHarness();
    harness.config.userMessageDeliveryWatermarkMode = 'providerAcceptance';
    harness.config.providerAcceptancePendingMaterialization = 'commitAtMaterialize';
    harness.runtime.setOnPromptAcceptedByProvider = vi.fn();

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(harness.session.deferDeliveredUserMessageWatermarkToProviderAcceptance).toHaveBeenCalledWith({
      pendingMaterialization: 'commitAtMaterialize',
    });
  });

  it('marks new provider-acceptance sessions in initial metadata before session creation', async () => {
    const harness = createHarness();
    harness.config.userMessageDeliveryWatermarkMode = 'providerAcceptance';
    harness.runtime.setOnPromptAcceptedByProvider = vi.fn();
    harness.deps.createSessionMetadataFn = ({ augmentMetadata }: any) => {
      const metadata = augmentMetadata?.({ path: '/tmp/workspace', permissionMode: 'default', permissionModeUpdatedAt: Date.now() })
        ?? { path: '/tmp/workspace', permissionMode: 'default', permissionModeUpdatedAt: Date.now() };
      return {
        state: { controlledByUser: false },
        metadata,
      };
    };
    harness.deps.initializeBackendRunSessionFn = async ({ metadata }: any) => {
      expect(metadata.userMessageDeliveryWatermarkModeV1).toBe('providerAcceptance');
      return {
        session: harness.session,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: false,
      };
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('does not emit idle keepAlive heartbeats at the thinking cadence', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    let releaseLoop!: () => void;
    let resolveLoopStarted!: () => void;
    const loopStarted = new Promise<void>((resolve) => {
      resolveLoopStarted = resolve;
    });
    harness.deps.runPermissionModePromptLoopFn = async () => {
      resolveLoopStarted();
      await new Promise<void>((resolve) => {
        releaseLoop = resolve;
      });
    };

    const runtimePromise = runHostSessionRuntime(harness.opts, harness.config, harness.deps);
    try {
      await loopStarted;
      expect(harness.session.keepAlive).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(harness.session.keepAlive).toHaveBeenCalledTimes(1);
    } finally {
      releaseLoop?.();
      await runtimePromise;
      vi.useRealTimers();
    }
  });

  it('does not double-send keepAlive when a thinking update is immediately flushed', async () => {
    const harness = createHarness();
    harness.deps.runPermissionModePromptLoopFn = async (params: any) => {
      params.setThinking(true);
      params.keepAlive();
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(harness.session.keepAlive.mock.calls).toEqual([
      [false, 'remote'],
      [true, 'remote'],
    ]);
  });

  it('delegates the host-owned session lifecycle to the shared session loop scaffold', async () => {
    const harness = createHarness();
    const runSessionLoopLifecycleFn = vi.fn(async (params: unknown) => {
      const lifecycleParams = params as Readonly<{
        opts: unknown;
        config: unknown;
        session: Readonly<{
          sessionId: string;
          getMetadataSnapshot: () => unknown;
        }>;
      }>;
      expect(lifecycleParams.opts).toEqual(expect.objectContaining(harness.opts));
      expect((lifecycleParams.opts as any).agentModeId).toBeUndefined();
      expect((lifecycleParams.opts as any).agentModeUpdatedAt).toBeUndefined();
      expect(lifecycleParams.config).toBe(harness.config);
      expect(lifecycleParams.session.sessionId).toBe(harness.session.sessionId);
      expect(lifecycleParams.session.getMetadataSnapshot()).toEqual(harness.session.getMetadataSnapshot());
    });
    harness.deps.runSessionLoopLifecycleFn = runSessionLoopLifecycleFn;

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(runSessionLoopLifecycleFn).toHaveBeenCalledTimes(1);
    expect((runSessionLoopLifecycleFn.mock.calls[0]?.[0] as { session: unknown } | undefined)?.session).not.toBe(harness.session);
  });

  it('provides the host-owned session-state engine to runtime factories', async () => {
    const harness = createHarness();
    const createSessionRuntime = vi.fn(() => ({
      operations: harness.runtime,
      nativeRuntime: harness.runtime,
    }));
    harness.config.createSessionRuntime = createSessionRuntime;
    harness.config.sessionState = {
      facet: {
        capabilities: {
          display: {
            title: {
              supported: true,
              happierToProvider: { supported: true, transport: 'runtime-hook' },
              providerToHappier: { supported: true, source: 'snapshot' },
            },
          },
        },
        applyHappierField: vi.fn(async () => undefined),
        readField: vi.fn(async () => null),
      },
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(createSessionRuntime).toHaveBeenCalledWith(expect.objectContaining({
      sessionState: expect.objectContaining({
        applyHappierField: expect.any(Function),
        writeHappierField: expect.any(Function),
        readProviderField: expect.any(Function),
      }),
    }));
  });

  it('publishes usage-limit recovery controls from native runtimes', async () => {
    const harness = createHarness();
    harness.runtime.enableUsageLimitWaitResume = vi.fn(async function (
      this: unknown,
      request: Readonly<{ sessionId: string }>,
    ) {
      expect(this).toBe(harness.runtime);
      return { ok: true, recovery: { status: 'waiting', sessionId: request.sessionId } };
    });
    harness.runtime.cancelUsageLimitWaitResume = vi.fn(async function (
      this: unknown,
      request: Readonly<{ sessionId: string }>,
    ) {
      expect(this).toBe(harness.runtime);
      return { ok: true, recovery: { status: 'cancelled', sessionId: request.sessionId } };
    });
    harness.runtime.checkUsageLimitRecoveryNow = vi.fn(async function (
      this: unknown,
      request: Readonly<{ sessionId: string }>,
    ) {
      expect(this).toBe(harness.runtime);
      return { ok: true, status: 'waiting', sessionId: request.sessionId };
    });
    harness.runtime.consumeUsageLimitResetCredit = vi.fn(async function (
      this: unknown,
      request: Readonly<{ sessionId: string; issueFingerprint?: string }>,
    ) {
      expect(this).toBe(harness.runtime);
      return { ok: true, status: 'ready', sessionId: request.sessionId, issueFingerprint: request.issueFingerprint };
    });

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    const controls = harness.session.setSessionRuntimeControls.mock.calls[0]?.[0];
    expect(controls).toMatchObject({
      enableUsageLimitWaitResume: expect.any(Function),
      cancelUsageLimitWaitResume: expect.any(Function),
      checkUsageLimitRecoveryNow: expect.any(Function),
      consumeUsageLimitResetCredit: expect.any(Function),
    });

    await expect(controls.enableUsageLimitWaitResume({ sessionId: 'session-1' })).resolves.toMatchObject({
      ok: true,
      recovery: { status: 'waiting', sessionId: 'session-1' },
    });
    await expect(controls.cancelUsageLimitWaitResume({ sessionId: 'session-1' })).resolves.toMatchObject({
      ok: true,
      recovery: { status: 'cancelled', sessionId: 'session-1' },
    });
    await expect(controls.checkUsageLimitRecoveryNow({ sessionId: 'session-1' })).resolves.toMatchObject({
      ok: true,
      status: 'waiting',
      sessionId: 'session-1',
    });
    await expect(controls.consumeUsageLimitResetCredit({
      sessionId: 'session-1',
      issueFingerprint: 'usage-limit:codex:turn-1',
    })).resolves.toMatchObject({
      ok: true,
      status: 'ready',
      sessionId: 'session-1',
      issueFingerprint: 'usage-limit:codex:turn-1',
    });
  });

  it('publishes terminal composer clear controls from native runtimes', async () => {
    const harness = createHarness();
    harness.runtime.clearTerminalComposer = vi.fn(async function (
      this: unknown,
      request: Readonly<{ sessionId: string; expectedStateAtMs?: number }>,
    ) {
      expect(this).toBe(harness.runtime);
      return { ok: true, status: 'cleared', sessionId: request.sessionId };
    });

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    const controls = harness.session.setSessionRuntimeControls.mock.calls[0]?.[0];
    expect(controls).toMatchObject({
      clearTerminalComposer: expect.any(Function),
    });

    await expect(controls.clearTerminalComposer({
      sessionId: 'session-1',
      expectedStateAtMs: 42,
    })).resolves.toMatchObject({
      ok: true,
      status: 'cleared',
      sessionId: 'session-1',
    });
    expect(harness.session.setSessionRuntimeControls).toHaveBeenLastCalledWith(null);
  });

  it('routes typed runtime turn events through durable session turn mutations', async () => {
    const harness = createHarness();
    harness.deps.runPermissionModePromptLoopFn = async () => {
      harness.runtime.emitRuntimeMessage({
        kind: 'turn-start',
        sessionId: 'session-1',
        turnId: 'turn-1',
        agentTurnId: 'provider-turn-1',
        emittedAtMs: 123,
      });
      harness.runtime.emitRuntimeMessage({
        kind: 'turn-complete',
        sessionId: 'session-1',
        turnId: 'turn-1',
        agentTurnId: 'provider-turn-1',
        emittedAtMs: 456,
      });
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(harness.session.enqueueSessionTurnMutation).toHaveBeenCalledWith(expect.objectContaining({
      action: 'begin',
      turnId: 'turn-1',
      agentTurnId: 'provider-turn-1',
      observedAt: 123,
    }));
    expect(harness.session.enqueueSessionTurnMutation).toHaveBeenCalledWith(expect.objectContaining({
      action: 'complete',
      turnId: 'turn-1',
      agentTurnId: 'provider-turn-1',
      observedAt: 456,
    }));
  });

  it('observes canonical display.title metadata updates through the host session-state engine', async () => {
    const harness = createHarness();
    let metadata: Record<string, unknown> = { path: '/tmp/workspace', permissionMode: 'default' };
    const metadataUpdateResolvers: Array<(value: boolean) => void> = [];
    const applied: string[] = [];
    harness.session.getMetadataSnapshot = () => metadata;
    harness.session.updateMetadata = vi.fn(async (updater: (current: Record<string, unknown>) => Record<string, unknown>) => {
      metadata = updater(metadata);
    });
    harness.session.waitForMetadataUpdate = vi.fn(() => new Promise<boolean>((resolve) => {
      metadataUpdateResolvers.push(resolve);
    }));
    harness.config.sessionState = {
      facet: {
        capabilities: {
          display: {
            title: {
              supported: true,
              happierToProvider: { supported: true, transport: 'runtime-hook' },
              providerToHappier: { supported: true, source: 'snapshot' },
            },
          },
        },
        applyHappierField: vi.fn(async (_ctx, field, value) => {
          applied.push(`${field}:${String(value)}`);
        }),
        readField: vi.fn(async () => null),
      },
    };
    harness.deps.runSessionLoopLifecycleFn = vi.fn(async () => {
      await harness.session.updateMetadata((current: Record<string, unknown>) => ({
        ...current,
        summary: { text: 'Host bridge title', updatedAt: 123 },
      }));
      metadataUpdateResolvers.shift()?.(true);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(applied).toEqual(['display.title:Host bridge title']);
  });

  it('seeds initial daemon-prompt sessions with a canonical display.title before provider startup', async () => {
    const previousInitialPrompt = process.env[HAPPIER_DAEMON_INITIAL_PROMPT_ENV_KEY];
    process.env[HAPPIER_DAEMON_INITIAL_PROMPT_ENV_KEY] = '  Inspect this repo and summarize the modules\nInclude tests.  ';
    const harness = createHarness();
    let initializedMetadata: Record<string, any> | null = null;
    const applied: string[] = [];
    harness.deps.createSessionMetadataFn = ({ augmentMetadata }: any) => {
      const metadata = augmentMetadata?.({ path: '/tmp/workspace', permissionMode: 'default' })
        ?? { path: '/tmp/workspace', permissionMode: 'default' };
      initializedMetadata = metadata;
      return {
        state: { controlledByUser: false },
        metadata,
      };
    };
    harness.deps.initializeBackendRunSessionFn = async ({ metadata }: any) => {
      expect(metadata.summary?.text).toBe('Inspect this repo and summarize the modules');
      expect(JSON.stringify(metadata)).not.toContain('Include tests.');
      return {
        session: harness.session,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: false,
      };
    };
    harness.session.getMetadataSnapshot = () => initializedMetadata;
    harness.config.sessionState = {
      facet: {
        capabilities: {
          display: {
            title: {
              supported: true,
              happierToProvider: { supported: true, transport: 'runtime-hook' },
              providerToHappier: { supported: true, source: 'snapshot' },
            },
          },
        },
        applyHappierField: vi.fn(async (_ctx, field, value) => {
          applied.push(`${field}:${String(value)}`);
        }),
        readField: vi.fn(async () => null),
      },
    };
    harness.deps.runSessionLoopLifecycleFn = vi.fn(async (params: {
      config: { onAfterStart?: () => Promise<void> | void };
    }) => {
      await params.config.onAfterStart?.();
    });

    try {
      await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
    } finally {
      if (previousInitialPrompt === undefined) {
        delete process.env[HAPPIER_DAEMON_INITIAL_PROMPT_ENV_KEY];
      } else {
        process.env[HAPPIER_DAEMON_INITIAL_PROMPT_ENV_KEY] = previousInitialPrompt;
      }
    }

    expect(initializedMetadata).toMatchObject({
      summary: { text: 'Inspect this repo and summarize the modules' },
    });
    expect(applied).toEqual(['display.title:Inspect this repo and summarize the modules']);
  });

  it('mirrors a fork-inherited display.title to the provider after the new runtime starts', async () => {
    const harness = createHarness();
    const applied: string[] = [];
    const forkOverrides = resolveForkInheritedOverridesFromMetadata({
      summary: { text: 'Pre-existing title', updatedAt: 123 },
    }, null);
    harness.session.getMetadataSnapshot = () => ({
      path: '/tmp/workspace',
      permissionMode: 'default',
      ...forkOverrides.metadata,
    });
    harness.config.sessionState = {
      facet: {
        capabilities: {
          display: {
            title: {
              supported: true,
              happierToProvider: { supported: true, transport: 'runtime-hook' },
              providerToHappier: { supported: true, source: 'snapshot' },
            },
          },
        },
        applyHappierField: vi.fn(async (_ctx, field, value) => {
          applied.push(`${field}:${String(value)}`);
        }),
        readField: vi.fn(async () => null),
      },
    };
    harness.deps.runSessionLoopLifecycleFn = vi.fn(async (params: {
      config: { onAfterStart?: () => Promise<void> | void };
      runtime: { startOrLoadSession: (options?: unknown) => Promise<unknown> };
    }) => {
      await params.runtime.startOrLoadSession({});
      await params.config.onAfterStart?.();
    });

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(applied).toEqual(['display.title:Pre-existing title']);
  });

  it('keeps provider startup bootstrap inside the shared session loop instead of early-returning', async () => {
    const harness = createHarness();
    const bootstrapCleanup = vi.fn(async () => undefined);
    const bootstrapStart = vi.fn(async () => undefined);
    const bootstrapPushSender = {
      sendToAllDevices: vi.fn(() => undefined),
      sendToAllDevicesAsync: vi.fn(async () => undefined),
    };
    const runSessionLoopLifecycleFn = vi.fn(async (_params: any) => undefined);
    const initializeBackendApiContextFn = vi.fn(harness.deps.initializeBackendApiContextFn);
    const initializeBackendRunSessionFn = vi.fn(harness.deps.initializeBackendRunSessionFn);

    harness.deps.runSessionLoopLifecycleFn = runSessionLoopLifecycleFn;
    harness.deps.initializeBackendApiContextFn = initializeBackendApiContextFn;
    harness.deps.initializeBackendRunSessionFn = initializeBackendRunSessionFn;
    harness.session.getMetadataSnapshot = () => null;
    harness.config.startupBootstrap = {
      create: async () => ({
        api: {
          push: () => bootstrapPushSender,
        },
        session: harness.session,
        machineId: 'bootstrap-machine',
        metadata: {
          host: 'host',
          homeDir: '/tmp',
          happyHomeDir: '/tmp/.happy',
          happyLibDir: '/tmp/lib',
          happyToolsDir: '/tmp/tools',
          path: '/tmp/bootstrap-workspace',
          permissionMode: 'default',
          permissionModeUpdatedAt: Date.now(),
        },
        attachedToExistingSession: false,
        reconnectionHandle: null,
        start: bootstrapStart,
        cleanup: bootstrapCleanup,
      }),
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(runSessionLoopLifecycleFn).toHaveBeenCalledTimes(1);
    const lifecycleParams = runSessionLoopLifecycleFn.mock.calls[0]?.[0] as Readonly<{
      session: Readonly<{ sessionId: string }>;
      runtimeMetadata: Readonly<{ path?: string }>;
      machineId: string;
      startupCoordinator: Readonly<{
        start: unknown;
        cleanup: unknown;
      }> | null;
    }> | undefined;
    expect(lifecycleParams?.session.sessionId).toBe(harness.session.sessionId);
    expect(lifecycleParams?.runtimeMetadata).toEqual(expect.objectContaining({ path: '/tmp/bootstrap-workspace' }));
    expect(lifecycleParams?.machineId).toBe('bootstrap-machine');
    expect(lifecycleParams?.startupCoordinator).toEqual(expect.objectContaining({
      start: bootstrapStart,
      cleanup: bootstrapCleanup,
    }));
    expect(initializeBackendApiContextFn).not.toHaveBeenCalled();
    expect(initializeBackendRunSessionFn).not.toHaveBeenCalled();
  });

  it('uses default ready sender and runs lifecycle hooks', async () => {
    const harness = createHarness();

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(harness.metrics.beforeInitializeCalls).toBe(1);
    expect(harness.metrics.onAfterStartCalls).toBe(1);
    expect(harness.metrics.onAfterResetCalls).toBe(1);
    expect(harness.metrics.defaultReadyCalls).toBe(1);
    expect(harness.metrics.cleanupCalls).toBe(1);
  });

  it('persists shared runtime publication events into session metadata during the host session lifecycle', async () => {
    const harness = createHarness();
    const runtimeMessageHandlers = new Set<(message: unknown) => void>();

    harness.runtime.subscribeRuntimeEvents.mockImplementation((handler: (message: unknown) => void) => {
      runtimeMessageHandlers.add(handler);
      return () => {
        runtimeMessageHandlers.delete(handler);
      };
    });
    harness.deps.runPermissionModePromptLoopFn = async (params: any) => {
      for (const handler of runtimeMessageHandlers) handler({
        type: 'event',
        name: 'runtime.descriptor',
        payload: {
          v: 1,
          agentId: 'acme.provider',
          agent: {
            backendMode: 'native',
          },
        },
      });
      for (const handler of runtimeMessageHandlers) handler({
        type: 'event',
        name: 'runtime.capabilities',
        payload: {
          backend: {
            sessions: {
              supported: true,
            },
          },
        },
      });
      for (const handler of runtimeMessageHandlers) handler({
        type: 'event',
        name: 'runtime.facets',
        payload: {
          v: 1,
          transcriptSource: {
            supported: true,
          },
        },
      });
      await params.onAfterStart?.();
      await params.onAfterReset?.();
      params.sendReady();
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    const resultingMetadata = harness.session.updateMetadata.mock.calls.reduce(
      (metadata: Record<string, unknown>, [updater]: [(current: Record<string, unknown>) => Record<string, unknown>]) =>
        updater(metadata),
      harness.session.getMetadataSnapshot(),
    );

    expect(resultingMetadata.runtimeDescriptorV1).toEqual({
      v: 1,
      agentId: 'acme.provider',
      agent: {
        backendMode: 'native',
      },
    });
    expect(resultingMetadata).not.toHaveProperty('agentRuntimeDescriptorV1');
    expect(resultingMetadata.agentRuntimeCapabilitiesV1).toEqual({
      backend: {
        sessions: {
          supported: true,
        },
      },
    });
    expect(resultingMetadata.agentRuntimeFacetsV1).toEqual({
      v: 1,
      transcriptSource: {
        supported: true,
      },
    });
  });

  it('passes eager runtime start through to the permission loop when configured', async () => {
    const harness = createHarness();
    harness.config.startRuntimeBeforeFirstPrompt = true;

    let capturedStartRuntimeBeforeFirstPrompt: boolean | undefined;
    harness.deps.runPermissionModePromptLoopFn = async (params: unknown) => {
      capturedStartRuntimeBeforeFirstPrompt = (
        params as Readonly<{ startRuntimeBeforeFirstPrompt?: boolean }>
      ).startRuntimeBeforeFirstPrompt;
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(capturedStartRuntimeBeforeFirstPrompt).toBe(true);
  });

  it('runs terminal remote switching through the shared lifecycle when the runtime exposes a mode loop', async () => {
    const harness = createHarness();
    const runTerminalRemoteSessionModeLoopFn = vi.fn(async () => 0);
    const modeLoop = {
      startingMode: 'remote' as const,
      remoteExitCode: 0,
      runTerminal: vi.fn(async () => ({ type: 'exit', code: 0 } as const)),
      runRemote: vi.fn(async () => 'exit' as const),
      onModeChange: vi.fn(),
    };
    harness.runtime.resolveTerminalRemoteSessionModeLoop = vi.fn(() => modeLoop);
    harness.deps.sessionLoopLifecycleDeps = {
      runTerminalRemoteSessionModeLoopFn,
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(runTerminalRemoteSessionModeLoopFn).toHaveBeenCalledWith(expect.objectContaining({
      startingMode: 'remote',
      remoteExitCode: 0,
      runTerminal: expect.any(Function),
      runRemote: expect.any(Function),
    }));
  });

  it('defers server pending materialization while the primary runtime turn is active', async () => {
    const harness = createHarness();
    harness.session.getPendingQueueState = vi.fn(() => ({ known: true, pendingCount: 1, pendingVersion: 1 }));

    harness.deps.runPermissionModePromptLoopFn = async (params: Readonly<{
      beforePendingMaterialize?: () => boolean | Promise<boolean>;
    }>) => {
      harness.runtime.emitRuntimeMessage({
        kind: 'turn-start',
        sessionId: 'session-1',
        turnId: 'turn-1',
        agentTurnId: 'provider-turn-1',
        emittedAtMs: 123,
      });

      await expect(params.beforePendingMaterialize?.()).resolves.toBe(false);

      harness.runtime.emitRuntimeMessage({
        kind: 'turn-complete',
        sessionId: 'session-1',
        turnId: 'turn-1',
        agentTurnId: 'provider-turn-1',
        emittedAtMs: 456,
      });

      await expect(params.beforePendingMaterialize?.()).resolves.toBe(true);
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('defers server pending materialization while an exclusive terminal turn is active', async () => {
    const harness = createHarness();
    const publishedStates: Array<Record<string, unknown>> = [];
    const emptyAgentState: Record<string, unknown> = {};
    harness.session.peekPendingMessageQueueV2Count = vi.fn(async () => 2);
    harness.session.getPendingQueueState = vi.fn(() => ({ known: true, pendingCount: 2, pendingVersion: 1 }));
    harness.session.updateAgentState = vi.fn(async (
      updater: (state: Record<string, unknown>) => Record<string, unknown>,
    ) => {
      const next = updater(publishedStates.at(-1) ?? emptyAgentState);
      publishedStates.push(next);
    });

    let resolveModeLoop: ((value: number) => void) | null = null;
    const modeLoopDone = new Promise<number>((resolve) => {
      resolveModeLoop = resolve;
    });
    let resolveActiveTurnObserved: (() => void) | null = null;
    const activeTurnObserved = new Promise<void>((resolve) => {
      resolveActiveTurnObserved = resolve;
    });
    const runTerminalRemoteSessionModeLoopFn = vi.fn(async (opts: Readonly<{
      onBeforeIteration?: (mode: 'terminal' | 'remote') => void | Promise<void>;
    }>) => {
      await opts.onBeforeIteration?.('terminal');
      harness.runtime.emitRuntimeMessage?.({ type: 'task_started', id: 'turn-active' });
      resolveActiveTurnObserved?.();
      return await modeLoopDone;
    });
    const modeLoop = {
      startingMode: 'terminal' as const,
      remoteExitCode: 0,
      runTerminal: vi.fn(async () => ({ type: 'switch' } as const)),
      runRemote: vi.fn(async () => 'exit' as const),
      onModeChange: vi.fn(),
    };
    harness.runtime.resolveTerminalRemoteSessionModeLoop = vi.fn(() => modeLoop);
    harness.deps.sessionLoopLifecycleDeps = {
      runTerminalRemoteSessionModeLoopFn,
    };
    harness.deps.runPermissionModePromptLoopFn = async (params: Readonly<{
      beforePendingMaterialize?: () => boolean | Promise<boolean>;
    }>) => {
      try {
        await activeTurnObserved;
        expect(params.beforePendingMaterialize).toBeTypeOf('function');
        const allowed = await params.beforePendingMaterialize?.();
        expect(allowed).toBe(false);
      } finally {
        resolveModeLoop?.(0);
      }
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(harness.session.updateAgentState).toHaveBeenCalled();
    expect(publishedStates.at(-1)).toMatchObject({
      terminalControl: {
        pendingHandoffV1: {
          status: 'deferred_until_terminal_turn_finishes',
          pendingCount: 2,
          interruptRequired: false,
        },
      },
    });
  });

  it('does not inspect server pending rows when local pending state is empty', async () => {
    const harness = createHarness();
    harness.session.shouldAttemptPendingMaterialization = vi.fn(() => false);
    harness.session.getPendingQueueState = vi.fn(() => ({ known: true, pendingCount: 0, pendingVersion: 4 }));
    harness.session.peekPendingMessageQueueV2Count = vi.fn(async () => {
      throw new Error('server pending queue should not be inspected for empty local state');
    });

    const modeLoop = {
      startingMode: 'terminal' as const,
      remoteExitCode: 0,
      runTerminal: vi.fn(async () => ({ type: 'exit', code: 0 } as const)),
      runRemote: vi.fn(async () => 'exit' as const),
      onModeChange: vi.fn(),
    };
    harness.runtime.resolveTerminalRemoteSessionModeLoop = vi.fn(() => modeLoop);
    harness.deps.runPermissionModePromptLoopFn = async (params: Readonly<{
      beforePendingMaterialize?: () => boolean | Promise<boolean>;
    }>) => {
      expect(await params.beforePendingMaterialize?.()).toBe(false);
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(harness.session.peekPendingMessageQueueV2Count).not.toHaveBeenCalled();
  });

  it('does not treat terminal attachment itself as an active terminal turn for pending handoff', async () => {
    const harness = createHarness();
    const requestGracefulRemoteHandoff = vi.fn(async () => ({ ok: true }));
    harness.session.peekPendingMessageQueueV2Count = vi.fn(async () => 1);
    harness.session.getPendingQueueState = vi.fn(() => ({ known: true, pendingCount: 1, pendingVersion: 1 }));
    harness.runtime.getSessionId = vi.fn(() => 'runtime-session-1');

    let terminalIterationStarted: (() => void) | null = null;
    const terminalIteration = new Promise<void>((resolve) => {
      terminalIterationStarted = resolve;
    });
    const runTerminalRemoteSessionModeLoopFn = vi.fn(async (opts: Readonly<{
      onBeforeIteration?: (mode: 'terminal' | 'remote') => void | Promise<void>;
    }>) => {
      await opts.onBeforeIteration?.('terminal');
      terminalIterationStarted?.();
      return 0;
    });
    const modeLoop = {
      startingMode: 'terminal' as const,
      remoteExitCode: 0,
      requestGracefulRemoteHandoff,
      runTerminal: vi.fn(async () => ({ type: 'switch' } as const)),
      runRemote: vi.fn(async () => 'exit' as const),
      onModeChange: vi.fn(),
    };
    harness.runtime.resolveTerminalRemoteSessionModeLoop = vi.fn(() => modeLoop);
    harness.deps.sessionLoopLifecycleDeps = {
      runTerminalRemoteSessionModeLoopFn,
    };
    harness.deps.runPermissionModePromptLoopFn = async (params: Readonly<{
      beforePendingMaterialize?: () => boolean | Promise<boolean>;
    }>) => {
      await terminalIteration;
      expect(await params.beforePendingMaterialize?.()).toBe(false);
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(requestGracefulRemoteHandoff).toHaveBeenCalledWith('pending_queue_after_terminal_boundary');
  });

  it('requests a graceful remote handoff before pending materialization after an exclusive terminal boundary', async () => {
    const harness = createHarness();
    const requestGracefulRemoteHandoff = vi.fn(async () => ({ ok: true }));
    harness.session.peekPendingMessageQueueV2Count = vi.fn(async () => 1);
    harness.session.getPendingQueueState = vi.fn(() => ({ known: true, pendingCount: 1, pendingVersion: 1 }));
    harness.runtime.getSessionId = vi.fn(() => 'runtime-session-1');

    let resolveTerminalBoundary: (() => void) | null = null;
    const terminalBoundary = new Promise<void>((resolve) => {
      resolveTerminalBoundary = resolve;
    });
    const runTerminalRemoteSessionModeLoopFn = vi.fn(async (opts: Readonly<{
      onBeforeIteration?: (mode: 'terminal' | 'remote') => void | Promise<void>;
      runTerminal: (params: { entry: 'initial' | 'switch' }) => Promise<{ type: 'switch' } | { type: 'exit'; code: number }>;
    }>) => {
      await opts.onBeforeIteration?.('terminal');
      harness.runtime.emitRuntimeMessage?.({ type: 'task_started', id: 'turn-complete' });
      harness.runtime.emitRuntimeMessage?.({ type: 'task_complete', id: 'turn-complete' });
      await opts.runTerminal({ entry: 'initial' });
      resolveTerminalBoundary?.();
      return 0;
    });
    const modeLoop = {
      startingMode: 'terminal' as const,
      remoteExitCode: 0,
      requestGracefulRemoteHandoff,
      runTerminal: vi.fn(async () => ({ type: 'switch' } as const)),
      runRemote: vi.fn(async () => 'exit' as const),
      onModeChange: vi.fn(),
    };
    harness.runtime.resolveTerminalRemoteSessionModeLoop = vi.fn(() => modeLoop);
    harness.deps.sessionLoopLifecycleDeps = {
      runTerminalRemoteSessionModeLoopFn,
    };
    harness.deps.runPermissionModePromptLoopFn = async (params: Readonly<{
      beforePendingMaterialize?: () => boolean | Promise<boolean>;
    }>) => {
      await terminalBoundary;
      expect(await params.beforePendingMaterialize?.()).toBe(false);
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(requestGracefulRemoteHandoff).toHaveBeenCalledWith('pending_queue_after_terminal_boundary');
  });

  it('does not silently retry a failed terminal handoff while pending rows remain queued', async () => {
    const harness = createHarness();
    const requestGracefulRemoteHandoff = vi.fn(async () => ({
      ok: false,
      detail: 'switch handler unavailable',
    }));
    const publishedStates: Array<Record<string, unknown>> = [];
    const emptyAgentState: Record<string, unknown> = {};
    harness.session.peekPendingMessageQueueV2Count = vi.fn(async () => 1);
    harness.session.getPendingQueueState = vi.fn(() => ({ known: true, pendingCount: 1, pendingVersion: 1 }));
    harness.session.updateAgentState = vi.fn(async (
      updater: (state: Record<string, unknown>) => Record<string, unknown>,
    ) => {
      const next = updater(publishedStates.at(-1) ?? emptyAgentState);
      publishedStates.push(next);
    });
    harness.runtime.getSessionId = vi.fn(() => 'runtime-session-1');

    let resolveTerminalBoundary: (() => void) | null = null;
    const terminalBoundary = new Promise<void>((resolve) => {
      resolveTerminalBoundary = resolve;
    });
    const runTerminalRemoteSessionModeLoopFn = vi.fn(async (opts: Readonly<{
      onBeforeIteration?: (mode: 'terminal' | 'remote') => void | Promise<void>;
    }>) => {
      await opts.onBeforeIteration?.('terminal');
      harness.runtime.emitRuntimeMessage?.({ type: 'task_started', id: 'turn-failed-switch' });
      harness.runtime.emitRuntimeMessage?.({ type: 'task_complete', id: 'turn-failed-switch' });
      resolveTerminalBoundary?.();
      return 0;
    });
    const modeLoop = {
      startingMode: 'terminal' as const,
      remoteExitCode: 0,
      requestGracefulRemoteHandoff,
      runTerminal: vi.fn(async () => ({ type: 'switch' } as const)),
      runRemote: vi.fn(async () => 'exit' as const),
      onModeChange: vi.fn(),
    };
    harness.runtime.resolveTerminalRemoteSessionModeLoop = vi.fn(() => modeLoop);
    harness.deps.sessionLoopLifecycleDeps = {
      runTerminalRemoteSessionModeLoopFn,
    };
    harness.deps.runPermissionModePromptLoopFn = async (params: Readonly<{
      beforePendingMaterialize?: () => boolean | Promise<boolean>;
    }>) => {
      await terminalBoundary;
      expect(await params.beforePendingMaterialize?.()).toBe(false);
      expect(await params.beforePendingMaterialize?.()).toBe(false);
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(requestGracefulRemoteHandoff).toHaveBeenCalledTimes(1);
    expect(publishedStates.at(-1)).toMatchObject({
      terminalControl: {
        pendingHandoffV1: {
          status: 'manual_action_required',
          pendingCount: 1,
        },
      },
    });
  });

  it('surfaces terminal remote mode loop errors after the prompt loop exits first', async () => {
    const harness = createHarness();
    const modeLoopError = new Error('mode loop failed after prompt exit');
    const modeLoopControl: { reject?: (error: Error) => void } = {};
    const runTerminalRemoteSessionModeLoopFn = vi.fn(() => new Promise<number>((_resolve, reject) => {
      modeLoopControl.reject = reject;
    }));
    const modeLoop = {
      startingMode: 'terminal' as const,
      remoteExitCode: 0,
      runTerminal: vi.fn(async () => ({ type: 'exit', code: 0 } as const)),
      runRemote: vi.fn(async () => 'exit' as const),
      onModeChange: vi.fn(),
    };
    harness.runtime.resolveTerminalRemoteSessionModeLoop = vi.fn(() => modeLoop);
    harness.deps.runPermissionModePromptLoopFn = async () => undefined;
    harness.deps.sessionLoopLifecycleDeps = {
      runTerminalRemoteSessionModeLoopFn,
    };

    const runPromise = runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    await vi.waitFor(() => {
      expect(runTerminalRemoteSessionModeLoopFn).toHaveBeenCalledOnce();
      expect(modeLoopControl.reject).toBeTypeOf('function');
    });
    modeLoopControl.reject?.(modeLoopError);

    await expect(runPromise).rejects.toBe(modeLoopError);
  });

  it('applies lifecycle hook initial model resolution before creating session metadata', async () => {
    const harness = createHarness();
    let capturedModelSelectionIntent: unknown;
    harness.config.lifecycleHooks = {
      resolveInitialModelSelection: async () => ({
        v: 1,
        updatedAt: 123,
        ref: {
          agentTargetKey: 'backend:qwen',
          providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'),
          modelId: 'gemini-2.5-pro',
        },
      }),
    };
    harness.deps.createSessionMetadataFn = (params: Readonly<{ modelSelectionIntent?: unknown }>) => {
      capturedModelSelectionIntent = params.modelSelectionIntent;
      return {
        state: { controlledByUser: false },
        metadata: { path: '/tmp/workspace', permissionMode: 'default', permissionModeUpdatedAt: Date.now() },
      };
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(capturedModelSelectionIntent).toEqual({
      v: 1,
      updatedAt: 123,
      selection: {
        agentTargetKey: 'backend:qwen',
        providerConnectionId: 'pc_work',
        modelId: 'gemini-2.5-pro',
      },
    });
  });

  it('passes the requested directory into session metadata creation', async () => {
    const harness = createHarness();
    Object.assign(harness.opts, { directory: '/tmp/requested-workspace' });
    const createSessionMetadataFn = vi.fn(() => ({
      state: { controlledByUser: false },
      metadata: { path: '/tmp/requested-workspace', permissionMode: 'default', permissionModeUpdatedAt: Date.now() },
    }));
    harness.deps.createSessionMetadataFn = createSessionMetadataFn;

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(createSessionMetadataFn).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/tmp/requested-workspace',
    }));
  });

  it('forwards provider-specific initialize-session options into shared session setup', async () => {
    const harness = createHarness();
    harness.config.initializeSession = {
      startupSideEffectsOrder: 'persist-first',
    };

    let capturedStartupSideEffectsOrder: 'report-first' | 'persist-first' | undefined;
    harness.deps.initializeBackendRunSessionFn = async ({ startupSideEffectsOrder }: any) => {
      capturedStartupSideEffectsOrder = startupSideEffectsOrder;
      return {
        session: harness.session,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: false,
      };
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(capturedStartupSideEffectsOrder).toBe('persist-first');
  });

  it('runs the session-initialized lifecycle hook before runtime creation', async () => {
    const harness = createHarness();
    const callOrder: string[] = [];
    harness.config.lifecycleHooks = {
      onSessionInitialized: async ({ attachedToExistingSession, session }: any) => {
        callOrder.push(`initialized:${attachedToExistingSession}:${session.sessionId}`);
      },
    };
    harness.deps.initializeBackendRunSessionFn = async () => {
      callOrder.push('session-created');
      return {
        session: harness.session,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: true,
      };
    };
    setSessionRuntimeFactory(harness.config, () => {
      callOrder.push('runtime-created');
      return {
        operations: harness.runtime,
        nativeRuntime: harness.runtime,
      };
    });

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(callOrder).toEqual([
      'session-created',
      'initialized:true:session-1',
      'runtime-created',
    ]);
  });

  it('rejects the retirement callback compatibility seam and requires createSessionRuntime', async () => {
    const harness = createHarness();
    harness.config.createSessionRuntime = undefined;

    await expect(runHostSessionRuntime(harness.opts, harness.config, harness.deps)).rejects.toThrow(
      'Host session runtime config must define createSessionRuntime',
    );
  });

  it('rejects legacy loop-compatible runtimes on the shared session path', async () => {
    const harness = createHarness();
    const legacyRuntime = {
      beginTurn: vi.fn(),
      startOrLoad: vi.fn(async () => undefined),
      sendPrompt: vi.fn(async () => undefined),
      supportsInFlightSteer: vi.fn(() => false),
      isTurnInFlight: vi.fn(() => false),
      steerPrompt: vi.fn(async () => undefined),
      flushTurn: vi.fn(async () => undefined),
      reset: vi.fn(async () => undefined),
      getSessionId: vi.fn(() => null),
      cancel: vi.fn(async () => undefined),
      setSessionMode: vi.fn(async () => undefined),
      setSessionConfigOption: vi.fn(async () => undefined),
      setSessionModel: vi.fn(async () => undefined),
    };
    // Intentional test-only invalid fixture: the shared runtime path must reject legacy loop-shaped objects.
    setSessionRuntimeFactory(harness.config, (() => ({
      operations: legacyRuntime as any,
    })) as unknown as NonNullable<HostSessionRuntimeConfig['createSessionRuntime']>);

    await expect(runHostSessionRuntime(harness.opts, harness.config, harness.deps)).rejects.toThrow(
      'Shared host session runtime requires RuntimeTurnOperations',
    );
  });

  it('passes a transcript session port that follows session swaps', async () => {
    const harness = createHarness();
    const initialSession = harness.session;
    initialSession.sendAgentMessageCommitted = vi.fn(async () => undefined);
    initialSession.sendAgentMessageEphemeral = vi.fn();

    const swappedSessionFixture = harness.createSessionFixture('session-2');
    const swappedSession = swappedSessionFixture.session;
    swappedSession.sendAgentMessageCommitted = vi.fn(async () => undefined);
    swappedSession.sendAgentMessageEphemeral = vi.fn();

    let swapSession: ((nextSession: any) => Promise<void> | void) | null = null;
    harness.deps.initializeBackendRunSessionFn = async ({ onSessionSwap }: any) => {
      swapSession = onSessionSwap;
      return {
        session: initialSession,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: false,
      };
    };

    let transcriptSession: any = null;
    setSessionRuntimeFactory(harness.config, (params: any) => {
      transcriptSession = params.transcriptSession;
      return {
        operations: harness.runtime,
        nativeRuntime: harness.runtime,
      };
    });

    harness.deps.runPermissionModePromptLoopFn = async () => {
      await swapSession?.(swappedSession);
      await transcriptSession.sendAgentMessageCommitted(
        'qwen',
        { type: 'message', message: 'final text' },
        { localId: 'segment-1' },
      );
      transcriptSession.sendAgentMessageEphemeral?.(
        'qwen',
        { type: 'message', message: 'live text' },
        { localId: 'segment-1', createdAt: 1, updatedAt: 2 },
      );
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(initialSession.sendAgentMessageCommitted).not.toHaveBeenCalled();
    expect(initialSession.sendAgentMessageEphemeral).not.toHaveBeenCalled();
    expect(swappedSession.sendAgentMessageCommitted).toHaveBeenCalledWith(
      'qwen',
      { type: 'message', message: 'final text' },
      { localId: 'segment-1' },
    );
    expect(swappedSession.sendAgentMessageEphemeral).toHaveBeenCalledWith(
      'qwen',
      { type: 'message', message: 'live text' },
      { localId: 'segment-1', createdAt: 1, updatedAt: 2 },
    );
  });

  it('passes a runtime session client that follows session swaps', async () => {
    const harness = createHarness();
    const initialSession = harness.session;
    initialSession.updateMetadata = vi.fn(async () => undefined);

    const swappedSessionFixture = harness.createSessionFixture('session-2');
    const swappedSession = swappedSessionFixture.session;
    swappedSession.updateMetadata = vi.fn(async () => undefined);

    let swapSession: ((nextSession: any) => Promise<void> | void) | null = null;
    harness.deps.initializeBackendRunSessionFn = async ({ onSessionSwap }: any) => {
      swapSession = onSessionSwap;
      return {
        session: initialSession,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: false,
      };
    };

    let runtimeSession: any = null;
    setSessionRuntimeFactory(harness.config, (params: any) => {
      runtimeSession = params.session;
      return {
        operations: harness.runtime,
        nativeRuntime: harness.runtime,
      };
    });

    harness.deps.runPermissionModePromptLoopFn = async () => {
      await swapSession?.(swappedSession);
      expect(runtimeSession.sessionId).toBe('session-2');
      await runtimeSession.updateMetadata((metadata: Record<string, unknown>) => ({
        ...metadata,
        fromRuntimeSession: true,
      }));
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(initialSession.updateMetadata).not.toHaveBeenCalled();
    expect(swappedSession.updateMetadata).toHaveBeenCalledTimes(1);
  });

  it('registers abort control RPCs on the active swapped session manager', async () => {
    const harness = createHarness();
    const initialSession = harness.session;
    const swappedSessionFixture = harness.createSessionFixture('session-2');
    const swappedSession = swappedSessionFixture.session;

    let swapSession: ((nextSession: any) => Promise<void>) | null = null;
    harness.deps.initializeBackendRunSessionFn = async ({ onSessionSwap }: any) => {
      swapSession = onSessionSwap;
      return {
        session: initialSession,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: false,
      };
    };

    harness.deps.runPermissionModePromptLoopFn = async () => {
      await swapSession?.(swappedSession);
      const abort = swappedSessionFixture.handlers.get('abort');
      expect(abort).toBeTypeOf('function');
      await abort?.();
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(initialSession.sendAgentMessage).not.toHaveBeenCalled();
    expect(swappedSession.sendAgentMessage).toHaveBeenCalledWith(
      'qwen',
      expect.objectContaining({ type: 'turn_cancelled' }),
    );
  });

  it('registers kill control handlers on the active swapped session manager', async () => {
    const harness = createHarness();
    harness.opts.startedBy = 'daemon';
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const swappedSessionFixture = harness.createSessionFixture('session-2');
    const swappedSession = swappedSessionFixture.session;

    let swapSession: ((nextSession: any) => Promise<void>) | null = null;
    harness.deps.initializeBackendRunSessionFn = async ({ onSessionSwap }: any) => {
      swapSession = onSessionSwap;
      return {
        session: harness.session,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: false,
      };
    };

    harness.deps.runPermissionModePromptLoopFn = async () => {
      await swapSession?.(swappedSession);
      const killRpc = swappedSessionFixture.handlers.get(RPC_METHODS.KILL_SESSION);
      expect(killRpc).toBeTypeOf('function');
      await killRpc?.();
    };

    try {
      await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
    } finally {
      exitSpy.mockRestore();
    }

    expect(harness.metrics.archiveCalls).toBe(0);
  });

  it('registers rollback control RPCs by default on the active swapped session manager', async () => {
    const harness = createHarness();
    const swappedSessionFixture = harness.createSessionFixture('session-2');
    const rollbackConversation = vi.fn(async () => ({
      ok: true,
      target: { type: 'latest_turn' as const },
    }));
    const sessionRestore = vi.fn(async () => ({
      ok: true,
      status: 'succeeded' as const,
      source: 'happier_scm' as const,
      restoredScopes: ['workspace' as const],
      receipts: [],
    }));

    setSessionRuntimeFactory(harness.config, () => ({
      operations: {
        ...harness.runtime,
        rollbackConversation,
        sessionRestore,
      },
      nativeRuntime: {
        ...harness.runtime,
        rollbackConversation,
        sessionRestore,
      },
    }));

    let swapSession: ((nextSession: any) => Promise<void>) | null = null;
    harness.deps.initializeBackendRunSessionFn = async ({ onSessionSwap }: any) => {
      swapSession = onSessionSwap;
      return {
        session: harness.session,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: false,
      };
    };

    harness.deps.runPermissionModePromptLoopFn = async () => {
      await swapSession?.(swappedSessionFixture.session);
      const rollback = swappedSessionFixture.handlers.get(SESSION_RPC_METHODS.SESSION_ROLLBACK);
      expect(rollback).toBeTypeOf('function');
      await rollback?.({ v: 1, target: { type: 'latest_turn' } });
      const restore = swappedSessionFixture.handlers.get(SESSION_RPC_METHODS.SESSION_RESTORE);
      expect(restore).toBeTypeOf('function');
      await restore?.({
        v: 1,
        sessionId: 'session-2',
        scopes: ['workspace'],
        candidate: {
          source: 'happier_scm',
          checkpointRef: 'refs/happier/checkpoints/scope/turn-final/turn-1',
        },
        confirmation: { sourceChoiceConfirmed: true },
      });
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(rollbackConversation).toHaveBeenCalledWith({
      v: 1,
      target: { type: 'latest_turn' },
    });
    expect(sessionRestore).toHaveBeenCalledWith({
      v: 1,
      sessionId: 'session-2',
      scopes: ['workspace'],
      candidate: {
        source: 'happier_scm',
        checkpointRef: 'refs/happier/checkpoints/scope/turn-final/turn-1',
      },
      confirmation: { sourceChoiceConfirmed: true },
    });
  });

  it('can defer session swap application until the loop boundary through a shared strategy hook', async () => {
    const harness = createHarness();
    const callOrder: string[] = [];
    let pendingApply: (() => Promise<void>) | null = null;
    harness.config.onSessionSwap = vi.fn(async ({ session }: any) => {
      callOrder.push(`swap:${session.sessionId}`);
    });
    harness.config.lifecycleHooks = {
      createSessionSwapStrategy: () => ({
        requestSessionSwap: ({ applyImmediately }) => {
          callOrder.push('request');
          pendingApply = applyImmediately;
        },
        flushPendingSessionSwap: async () => {
          callOrder.push('flush:start');
          await pendingApply?.();
          pendingApply = null;
          callOrder.push('flush:end');
        },
      }),
    };

    harness.deps.initializeBackendRunSessionFn = async ({ onSessionSwap, metadata }: any) => {
      expect((metadata as any).auggieAllowIndexing).toBe(true);
      await onSessionSwap({
        ...harness.session,
        sessionId: 'session-2',
      });
      callOrder.push('after-notify');
      return {
        session: harness.session,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: false,
      };
    };
    harness.deps.runPermissionModePromptLoopFn = async (params: Readonly<{
      onAfterLoopBoundary?: (args: { reason: 'turn_completed' }) => Promise<void> | void;
    }>) => {
      callOrder.push('before-boundary');
      await params.onAfterLoopBoundary?.({ reason: 'turn_completed' });
      callOrder.push('after-boundary');
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(callOrder).toEqual([
      'request',
      'after-notify',
      'before-boundary',
      'flush:start',
      'swap:session-2',
      'flush:end',
      'after-boundary',
    ]);
  });

  it('trims the initial resume id before enabling strict resume mode', async () => {
    const harness = createHarness();
    harness.opts.resume = '  resume-id  ';

    let receivedInitialResumeId: string | undefined;
    let receivedStrictInitialResume: boolean | undefined;
    harness.deps.runPermissionModePromptLoopFn = async (
      params: Readonly<{ initialResumeId?: string; strictInitialResume?: boolean }>,
    ) => {
      receivedInitialResumeId = params.initialResumeId;
      receivedStrictInitialResume = params.strictInitialResume;
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(receivedInitialResumeId).toBe('resume-id');
    expect(receivedStrictInitialResume).toBe(true);
  });

  it('passes resolved MCP servers to the provider runtime', async () => {
    const harness = createHarness();
    harness.config.flavor = 'claude';
    harness.config.policyAgentId = 'claude';

    let capturedMcpServers: any = null;
    const createRuntimeOriginal = harness.config.createSessionRuntime;
    if (!createRuntimeOriginal) {
      throw new Error('Expected session runtime factory in harness');
    }
    const createRuntime = createRuntimeOriginal;
    setSessionRuntimeFactory(harness.config, (params: any) => {
      capturedMcpServers = params.mcpServers;
      return createRuntime(params);
    });

    harness.deps.resolveRunnerMcpServersFn = async () => ({
      happierMcpServer: { stop: () => undefined },
      mcpServers: { happier: { command: 'built-in' }, extra: { command: 'extra' } },
    });

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(capturedMcpServers).toEqual({ happier: { command: 'built-in' }, extra: { command: 'extra' } });
  });

  it('passes the MCP account settings snapshot to the provider runtime', async () => {
    const harness = createHarness();
    const runnerAccountSettings = {
      actionsSettingsV1: {
        v: 1,
        actions: {
          'session.list': {
            approvalRequiredSurfaces: ['agent'],
          },
        },
      },
    };
    let capturedAccountSettings: unknown = null;
    const createRuntimeOriginal = harness.config.createSessionRuntime;
    if (!createRuntimeOriginal) {
      throw new Error('Expected session runtime factory in harness');
    }
    const createRuntime = createRuntimeOriginal;
    harness.config.resolveRunnerMcpServersAccountSettings = () => runnerAccountSettings as never;
    harness.deps.resolveRunnerMcpServersFn = vi.fn(async (params: any) => {
      expect(params.accountSettings).toBe(runnerAccountSettings);
      return {
        happierMcpServer: { stop: () => undefined },
        mcpServers: { happier: { command: 'built-in' } },
      };
    });
    setSessionRuntimeFactory(harness.config, (params: any) => {
      capturedAccountSettings = params.accountSettings;
      return createRuntime(params);
    });

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(capturedAccountSettings).toBe(runnerAccountSettings);
  });

  it('uses attached session metadata for runtime metadata, runtime directory, and MCP directory resolution', async () => {
    const harness = createHarness();
    harness.config.flavor = 'claude';
    harness.config.policyAgentId = 'claude';
    const attachedMetadata = {
      path: '/srv/attached-workspace',
      permissionMode: 'ask',
      permissionModeUpdatedAt: 42,
      profileId: 'profile-attached',
    };
    harness.session.getMetadataSnapshot = () => attachedMetadata;
    harness.deps.createSessionMetadataFn = () => ({
      state: { controlledByUser: false },
      metadata: { path: '/tmp/local-workspace', permissionMode: 'default', permissionModeUpdatedAt: 1 },
    });
    harness.deps.initializeBackendRunSessionFn = async ({ metadata }: any) => {
      expect(metadata.path).toBe('/tmp/local-workspace');
      return {
        session: harness.session,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: true,
      };
    };

    let capturedRuntimeParams: any = null;
    setSessionRuntimeFactory(harness.config, (params: any) => {
      capturedRuntimeParams = params;
      return {
        operations: harness.runtime,
        nativeRuntime: harness.runtime,
      };
    });

    let capturedShouldRenderMetadata: any = null;
    harness.config.shouldRenderTerminalDisplay = ({ metadata }: any) => {
      capturedShouldRenderMetadata = metadata;
      return false;
    };

    let capturedMcpDirectory: string | null = null;
    let capturedSessionMetadata: any = null;
    let capturedSessionLocation: any = null;
    harness.deps.resolveRunnerMcpServersFn = async (params: any) => {
      capturedMcpDirectory = params.directory;
      capturedSessionMetadata = params.sessionMetadata;
      capturedSessionLocation = params.session.getCurrentSessionLocation?.();
      return {
        happierMcpServer: { stop: () => undefined },
        mcpServers: {},
      };
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(capturedShouldRenderMetadata).toMatchObject({ path: '/srv/attached-workspace' });
    expect(capturedRuntimeParams).toMatchObject({
      directory: '/srv/attached-workspace',
      metadata: expect.objectContaining({ path: '/srv/attached-workspace', profileId: 'profile-attached' }),
    });
    expect(capturedMcpDirectory).toBe('/srv/attached-workspace');
    expect(capturedSessionMetadata).toMatchObject({ path: '/srv/attached-workspace', profileId: 'profile-attached' });
    expect(capturedSessionLocation).toEqual({
      path: '/srv/attached-workspace',
      host: harness.config.machineMetadata.host,
      machineId: 'machine-1',
    });
  });

  it('does not pass attach metadata cleanup keys through the canonical shared startup contract for existing-session attaches', async () => {
    const harness = createHarness();
    harness.opts.existingSessionId = 'existing-123';

    const initializeBackendRunSessionFn = vi.fn(async ({ metadataKeysToUnsetOnAttach }: any) => {
      expect(metadataKeysToUnsetOnAttach).toBeUndefined();
      return {
        session: harness.session,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: true,
      };
    });
    harness.deps.initializeBackendRunSessionFn = initializeBackendRunSessionFn;

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(initializeBackendRunSessionFn).toHaveBeenCalledTimes(1);
  });

  it('does not seed ACP transport metadata from the generic shared host-session path', async () => {
    const harness = createHarness();
    harness.config.augmentSessionMetadata = (metadata) => ({
      ...metadata,
      acpTransportV1: {
        v: 1,
        agentId: 'configured-acp',
      },
    });
    const createSessionMetadataFn = vi.fn(() => ({
      state: { controlledByUser: false },
      metadata: { path: '/tmp/workspace', permissionMode: 'default', permissionModeUpdatedAt: Date.now() },
    }));
    harness.deps.createSessionMetadataFn = createSessionMetadataFn;

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(createSessionMetadataFn).toHaveBeenCalledWith(expect.not.objectContaining({
      acpProviderId: expect.any(String),
    }));
    expect(createSessionMetadataFn).toHaveBeenCalledWith(expect.objectContaining({
      augmentMetadata: expect.any(Function),
    }));
  });

  it('rejects legacy raw createSessionRuntime returns on the canonical host-session path', async () => {
    const harness = createHarness();
    harness.config.createSessionRuntime = () => harness.runtime;

    await expect(runHostSessionRuntime(harness.opts, harness.config, harness.deps))
      .rejects
      .toThrow('Shared host session runtime requires explicit operations/nativeRuntime binding');
  });

  it('uses canonical session-mode carriers and retires the legacy host-session hook boundary', async () => {
    const harness = createHarness();
    (harness.opts as any).sessionModeId = 'plan';
    (harness.opts as any).sessionModeUpdatedAt = 42;
    const createSessionMetadataFn = vi.fn(() => ({
      state: { controlledByUser: false },
      metadata: { path: '/tmp/workspace', permissionMode: 'default', permissionModeUpdatedAt: Date.now() },
    }));
    harness.deps.createSessionMetadataFn = createSessionMetadataFn;

    const initializeBackendRunSessionFn = vi.fn(async ({ startupMetadataOverrides }: any) => {
      expect(startupMetadataOverrides).toBeTruthy();
      expect(startupMetadataOverrides?.acpSessionModeOverride).toBeUndefined();
      expect(startupMetadataOverrides?.sessionModeOverride).toBeUndefined();
      return {
        session: harness.session,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: false,
      };
    });
    harness.deps.initializeBackendRunSessionFn = initializeBackendRunSessionFn;
    harness.config.lifecycleHooks = {
      resolveInitialModelSelection: ({ opts }) => {
        expect((opts as any).agentModeId).toBeUndefined();
        expect((opts as any).agentModeUpdatedAt).toBeUndefined();
        expect((opts as any).sessionModeId).toBe('plan');
        expect((opts as any).sessionModeUpdatedAt).toBe(42);
        return null;
      },
      onSessionInitialized: ({ opts }) => {
        expect((opts as any).agentModeId).toBeUndefined();
        expect((opts as any).agentModeUpdatedAt).toBeUndefined();
        expect((opts as any).sessionModeId).toBe('plan');
        expect((opts as any).sessionModeUpdatedAt).toBe(42);
      },
    };
    harness.config.beforeInitializeSession = ({ opts }: any) => {
      expect((opts as any).agentModeId).toBeUndefined();
      expect((opts as any).agentModeUpdatedAt).toBeUndefined();
      expect((opts as any).sessionModeId).toBe('plan');
      expect((opts as any).sessionModeUpdatedAt).toBe(42);
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(initializeBackendRunSessionFn).toHaveBeenCalledTimes(1);
    expect(createSessionMetadataFn).toHaveBeenCalledWith(expect.objectContaining({
      sessionModeId: 'plan',
      sessionModeUpdatedAt: 42,
    }));
    expect(createSessionMetadataFn).toHaveBeenCalledWith(expect.not.objectContaining({
      agentModeId: 'plan',
      agentModeUpdatedAt: 42,
    }));
  });

  it('skips native MCP resolution for shell-bridge providers', async () => {
    const harness = createHarness();

    let capturedMcpServers: any = null;
    setSessionRuntimeFactory(harness.config, (params: any) => {
      capturedMcpServers = params.mcpServers;
      const nativeRuntime = {
        ...harness.runtime,
        getSessionId: vi.fn(() => null),
      };
      return {
        operations: nativeRuntime,
        nativeRuntime,
      };
    });

    const resolveRunnerMcpServersFn = vi.fn(async () => ({
      happierMcpServer: { stop: () => undefined },
      mcpServers: { happier: { command: 'built-in' } },
    }));

    await runHostSessionRuntime(harness.opts, harness.config, {
      ...harness.deps,
      resolveRunnerMcpServersFn,
    });

    expect(resolveRunnerMcpServersFn).not.toHaveBeenCalled();
    expect(capturedMcpServers).toEqual({});
  });

  it('uses the Happier session id, not the vendor runtime session id, for shell-bridge prompt instructions', async () => {
    const harness = createHarness();

    harness.runtime.getSessionId = vi.fn(() => 'vendor-session-123');

    let resolvedPrompt = '';
    harness.deps.runPermissionModePromptLoopFn = async (params: Readonly<{
      resolveFreshSessionSystemPrompt?: (args: { baseOverride?: string | null }) => Promise<string>;
    }>) => {
      resolvedPrompt = await params.resolveFreshSessionSystemPrompt?.({ baseOverride: 'BASE' }) ?? '';
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(resolvedPrompt).toContain("'--session-id' 'session-1'");
    expect(resolvedPrompt).not.toContain('vendor-session-123');
  });

  it('uses the swapped Happier session id for shell-bridge prompt instructions after a session swap', async () => {
    const harness = createHarness();
    const swappedSession = harness.createSessionFixture('session-2').session;

    let swapSession: ((nextSession: any) => Promise<void>) | null = null;
    harness.deps.initializeBackendRunSessionFn = async ({ onSessionSwap }: any) => {
      swapSession = onSessionSwap;
      return {
        session: harness.session,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: false,
      };
    };

    let resolvedPrompt = '';
    harness.deps.runPermissionModePromptLoopFn = async (params: Readonly<{
      resolveFreshSessionSystemPrompt?: (args: { baseOverride?: string | null }) => Promise<string>;
    }>) => {
      await swapSession?.(swappedSession);
      resolvedPrompt = await params.resolveFreshSessionSystemPrompt?.({ baseOverride: 'BASE' }) ?? '';
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(resolvedPrompt).toContain("'--session-id' 'session-2'");
    expect(resolvedPrompt).not.toContain("'--session-id' 'session-1'");
  });

  it('in-flight steer controller calls steerPrompt with correct receiver', async () => {
    const harness = createHarness();

    const runtime = {
      ...harness.runtime,
      steerPrompt: vi.fn(async function (this: unknown) {
        if (this !== runtime) {
          throw new Error('steerPrompt called with wrong receiver');
        }
      }),
      supportsInFlightSteer: vi.fn(() => true),
    };

    setSessionRuntimeFactory(harness.config, () => ({
      operations: runtime,
      nativeRuntime: runtime,
    }));


    let inFlightSteer: any = null;
    harness.deps.createPermissionModeQueueStateFn = (params: any) => {
      inFlightSteer = params.inFlightSteer;
      return {
        messageQueue: {
          reset: () => undefined,
          size: () => 0,
        },
        rebindSession: () => undefined,
        getCurrentPermissionMode: () => 'default',
        setCurrentPermissionMode: () => undefined,
        getCurrentPermissionModeUpdatedAt: () => 0,
        setCurrentPermissionModeUpdatedAt: () => undefined,
      };
    };

    harness.deps.runPermissionModePromptLoopFn = async (params: any) => {
      expect(inFlightSteer).not.toBeNull();
      await inFlightSteer.steerText('hello');
      params.sendReady();
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(runtime.steerPrompt).toHaveBeenCalledWith('hello');
  });

  it('does not synthesize provider acceptance for native steerPrompt dispatch without an acceptance seam', async () => {
    const harness = createHarness();
    const runtime = {
      ...harness.runtime,
      steerPrompt: vi.fn(async function (this: unknown) {
        expect(this).toBe(runtime);
      }),
      supportsInFlightSteer: vi.fn(() => true),
    };

    setSessionRuntimeFactory(harness.config, () => ({
      operations: runtime,
      nativeRuntime: runtime,
    }));

    let inFlightSteer: any = null;
    harness.deps.createPermissionModeQueueStateFn = (params: any) => {
      inFlightSteer = params.inFlightSteer;
      return {
        messageQueue: {
          reset: () => undefined,
          size: () => 0,
        },
        rebindSession: () => undefined,
        getCurrentPermissionMode: () => 'default',
        setCurrentPermissionMode: () => undefined,
        getCurrentPermissionModeUpdatedAt: () => 0,
        setCurrentPermissionModeUpdatedAt: () => undefined,
      };
    };
    harness.deps.runPermissionModePromptLoopFn = async () => {
      expect(inFlightSteer).not.toBeNull();
      await inFlightSteer.steerText('hello steer', {
        localId: 'local-steer-prompt',
        userMessageSeq: 88,
      });
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(runtime.steerPrompt).toHaveBeenCalledWith('hello steer', {
      localId: 'local-steer-prompt',
      userMessageSeq: 88,
    });
    expect(harness.session.confirmUserMessageDeliveredToProvider).not.toHaveBeenCalled();
  });

  it('passes direct native runtime-turn operations through without adding a synthetic acceptance hook', async () => {
    const harness = createHarness();
    const nativeRuntime = {
      beginTurnLifecycle: vi.fn(),
      startOrLoadSession: vi.fn(async () => undefined),
      sendTurnPrompt: vi.fn(async () => undefined),
      steerInFlightTurn: vi.fn(async () => undefined),
      waitForTurnCompletion: vi.fn(async () => undefined),
      subscribeRuntimeEvents: vi.fn(() => () => undefined),
      cancelTurn: vi.fn(async () => undefined),
      readSessionIdentity: vi.fn(() => ({ sessionId: null })),
      updateSessionRuntimeConfig: vi.fn(async () => undefined),
      resetOrDisposeRuntime: vi.fn(async () => undefined),
      shouldResumeAfterPermissionModeChange: vi.fn(() => false),
    };
    setSessionRuntimeFactory(harness.config, () => ({
      operations: nativeRuntime as any,
      nativeRuntime: nativeRuntime as any,
    }));

    const runSessionLoopLifecycleFn = vi.fn(async () => undefined);
    harness.deps.runSessionLoopLifecycleFn = runSessionLoopLifecycleFn;

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    const lifecycleParams = (runSessionLoopLifecycleFn.mock.calls as unknown as Array<[unknown]>)[0]?.[0] as {
      runtime?: unknown;
      hookRuntime?: { sendTurnPrompt?: unknown; setOnPromptAcceptedByProvider?: unknown };
    } | undefined;
    expect(lifecycleParams?.runtime).toBe(nativeRuntime);
    expect(lifecycleParams?.hookRuntime).toBe(nativeRuntime);
    expect(typeof lifecycleParams?.hookRuntime?.sendTurnPrompt).toBe('function');
    expect(typeof lifecycleParams?.hookRuntime?.setOnPromptAcceptedByProvider).toBe('undefined');
  });

  it('does not infer provider acceptance from successful native prompt dispatch', async () => {
    const harness = createHarness();
    let releaseSend!: () => void;
    const sendCanResolve = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const nativeRuntime = {
      beginTurnLifecycle: vi.fn(),
      startOrLoadSession: vi.fn(async () => undefined),
      sendTurnPrompt: vi.fn(async () => {
        await sendCanResolve;
      }),
      steerInFlightTurn: vi.fn(async () => undefined),
      waitForTurnCompletion: vi.fn(async () => undefined),
      subscribeRuntimeEvents: vi.fn(() => () => undefined),
      cancelTurn: vi.fn(async () => undefined),
      readSessionIdentity: vi.fn(() => ({ sessionId: null })),
      updateSessionRuntimeConfig: vi.fn(async () => undefined),
      resetOrDisposeRuntime: vi.fn(async () => undefined),
    };
    setSessionRuntimeFactory(harness.config, () => ({
      operations: nativeRuntime as any,
      nativeRuntime: nativeRuntime as any,
    }));
    harness.deps.runPermissionModePromptLoopFn = async (params: Readonly<{
      runtime: Readonly<{
        sendTurnPrompt: (
          prompt: string,
          meta?: Readonly<{ localId?: string | null; userMessageSeq?: number | null; userMessageSeqs?: readonly number[] }>,
        ) => Promise<void>;
      }>;
    }>) => {
      expect(harness.session.deferDeliveredUserMessageWatermarkToProviderAcceptance).not.toHaveBeenCalled();
      const dispatch = params.runtime.sendTurnPrompt('queued prompt', {
        localId: 'local-99',
        userMessageSeq: 99,
        userMessageSeqs: [99],
      });
      await Promise.resolve();
      expect(harness.session.confirmUserMessageDeliveredToProvider).not.toHaveBeenCalled();
      releaseSend();
      await dispatch;
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(nativeRuntime.sendTurnPrompt).toHaveBeenCalledWith('queued prompt', {
      localId: 'local-99',
      userMessageSeq: 99,
      userMessageSeqs: [99],
    });
    expect(harness.session.confirmUserMessageDeliveredToProvider).not.toHaveBeenCalled();
  });

  it('does not infer provider acceptance from native meta and steer dispatch surfaces', async () => {
    const harness = createHarness();
    const nativeRuntime = {
      beginTurnLifecycle: vi.fn(),
      startOrLoadSession: vi.fn(async () => undefined),
      sendTurnPrompt: vi.fn(async () => undefined),
      sendPromptWithMeta: vi.fn(async function (this: unknown) {
        expect(this).toBe(nativeRuntime);
      }),
      steerInFlightTurn: vi.fn(async function (this: unknown) {
        expect(this).toBe(nativeRuntime);
      }),
      waitForTurnCompletion: vi.fn(async () => undefined),
      subscribeRuntimeEvents: vi.fn(() => () => undefined),
      cancelTurn: vi.fn(async () => undefined),
      readSessionIdentity: vi.fn(() => ({ sessionId: null })),
      updateSessionRuntimeConfig: vi.fn(async () => undefined),
      resetOrDisposeRuntime: vi.fn(async () => undefined),
    };
    setSessionRuntimeFactory(harness.config, () => ({
      operations: nativeRuntime as any,
      nativeRuntime: nativeRuntime as any,
    }));
    harness.deps.runPermissionModePromptLoopFn = async (params: Readonly<{
      runtime: Readonly<{
        sendPromptWithMeta?: (
          meta: Readonly<{ text: string; localIds?: readonly string[]; userMessageSeq?: number | null }>,
        ) => Promise<void>;
        steerInFlightTurn: (
          prompt: string,
          meta?: Readonly<{ localId?: string | null; userMessageSeq?: number | null }>,
        ) => Promise<void>;
      }>;
    }>) => {
      await params.runtime.sendPromptWithMeta?.({
        text: 'meta prompt',
        localIds: ['local-meta'],
        userMessageSeq: 101,
      });
      await params.runtime.steerInFlightTurn('steer prompt', {
        localId: 'local-steer',
        userMessageSeq: 102,
      });
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(harness.session.deferDeliveredUserMessageWatermarkToProviderAcceptance).not.toHaveBeenCalled();
    expect(harness.session.confirmUserMessageDeliveredToProvider).not.toHaveBeenCalled();
  });

  it('fails closed when provider-acceptance watermarking is requested without an acceptance seam', async () => {
    const harness = createHarness();
    harness.config.userMessageDeliveryWatermarkMode = 'providerAcceptance';
    delete harness.runtime.setOnPromptAcceptedByProvider;
    delete harness.runtime.setOnPromptTerminallyRejectedBeforeProvider;

    await expect(runHostSessionRuntime(harness.opts, harness.config, harness.deps))
      .rejects
      .toThrow(/provider-acceptance delivery watermarking/i);
  });

  it('fails closed when provider-acceptance watermarking has only a rejection seam', async () => {
    const harness = createHarness();
    harness.config.userMessageDeliveryWatermarkMode = 'providerAcceptance';
    delete harness.runtime.setOnPromptAcceptedByProvider;
    harness.runtime.setOnPromptTerminallyRejectedBeforeProvider = vi.fn();

    await expect(runHostSessionRuntime(harness.opts, harness.config, harness.deps))
      .rejects
      .toThrow(/provider-acceptance delivery watermarking/i);
  });

  it('defers the delivered watermark and confirms it only through provider acceptance from the native runtime', async () => {
    const harness = createHarness();
    harness.config.userMessageDeliveryWatermarkMode = 'providerAcceptance';
    let acceptedHandler:
      | ((info: Readonly<{ localInputIds?: readonly string[]; localIds?: readonly string[]; userMessageSeq?: number | null; userMessageSeqs?: readonly number[] }>) => void)
      | null = null;
    harness.runtime.setOnPromptAcceptedByProvider = vi.fn((handler) => {
      acceptedHandler = handler;
    });
    harness.deps.runPermissionModePromptLoopFn = async () => {
      expect(harness.session.deferDeliveredUserMessageWatermarkToProviderAcceptance).toHaveBeenCalledTimes(1);
      expect(harness.session.confirmUserMessageDeliveredToProvider).not.toHaveBeenCalled();
      acceptedHandler?.({ localIds: ['local-42'], userMessageSeq: 42, userMessageSeqs: [42] });
      acceptedHandler?.({ userMessageSeq: null });
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(harness.runtime.setOnPromptAcceptedByProvider).toHaveBeenCalledTimes(1);
    expect(harness.session.confirmUserMessageDeliveredToProvider).toHaveBeenCalledTimes(1);
    expect(harness.session.confirmUserMessageDeliveredToProvider).toHaveBeenCalledWith({
      localIds: ['local-42'],
      userMessageSeq: 42,
      userMessageSeqs: [42],
    });
  });

  it('normalizes plugin SDK localInputIds when confirming native-runtime provider acceptance', async () => {
    const harness = createHarness();
    harness.config.userMessageDeliveryWatermarkMode = 'providerAcceptance';
    let acceptedHandler:
      | ((info: Readonly<{ localInputIds?: readonly string[]; userMessageSeq?: number | null; userMessageSeqs?: readonly number[] }>) => void)
      | null = null;
    harness.runtime.setOnPromptAcceptedByProvider = vi.fn((handler) => {
      acceptedHandler = handler;
    });
    harness.deps.runPermissionModePromptLoopFn = async () => {
      acceptedHandler?.({ localInputIds: ['local-input-42'], userMessageSeq: null });
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(harness.session.confirmUserMessageDeliveredToProvider).toHaveBeenCalledTimes(1);
    expect(harness.session.confirmUserMessageDeliveredToProvider).toHaveBeenCalledWith({
      localIds: ['local-input-42'],
      userMessageSeq: null,
    });
  });

  it('blocks canonical pending delivery when the native runtime terminally rejects a prompt before provider custody', async () => {
    const harness = createHarness();
    harness.config.userMessageDeliveryWatermarkMode = 'providerAcceptance';
    let terminallyRejectedHandler:
      | ((info: Readonly<{ localInputIds?: readonly string[]; localIds?: readonly string[]; userMessageSeq?: number | null; userMessageSeqs?: readonly number[] }>) => void)
      | null = null;
    harness.runtime.setOnPromptAcceptedByProvider = vi.fn();
    harness.runtime.setOnPromptTerminallyRejectedBeforeProvider = vi.fn((handler) => {
      terminallyRejectedHandler = handler;
    });
    harness.deps.runPermissionModePromptLoopFn = async () => {
      expect(harness.session.deferDeliveredUserMessageWatermarkToProviderAcceptance).toHaveBeenCalledTimes(1);
      expect(harness.session.confirmUserMessageDeliveredToProvider).not.toHaveBeenCalled();
      terminallyRejectedHandler?.({ localIds: ['local-84'], userMessageSeq: 84, userMessageSeqs: [84] });
      terminallyRejectedHandler?.({ userMessageSeq: null });
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(harness.runtime.setOnPromptTerminallyRejectedBeforeProvider).toHaveBeenCalledTimes(1);
    expect(harness.session.confirmUserMessageDeliveredToProvider).not.toHaveBeenCalled();
    expect(harness.session.blockPendingMessageDelivery).toHaveBeenCalledTimes(1);
    expect(harness.session.blockPendingMessageDelivery).toHaveBeenCalledWith({
      localIds: ['local-84'],
      reason: 'provider_rejected_before_acceptance',
    });
  });

  it('normalizes plugin SDK localInputIds when blocking terminally rejected native-runtime prompts before provider custody', async () => {
    const harness = createHarness();
    harness.config.userMessageDeliveryWatermarkMode = 'providerAcceptance';
    let terminallyRejectedHandler:
      | ((info: Readonly<{ localInputIds?: readonly string[]; userMessageSeq?: number | null; userMessageSeqs?: readonly number[] }>) => void)
      | null = null;
    harness.runtime.setOnPromptAcceptedByProvider = vi.fn();
    harness.runtime.setOnPromptTerminallyRejectedBeforeProvider = vi.fn((handler) => {
      terminallyRejectedHandler = handler;
    });
    harness.deps.runPermissionModePromptLoopFn = async () => {
      terminallyRejectedHandler?.({ localInputIds: ['local-input-84'], userMessageSeq: null });
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(harness.session.confirmUserMessageDeliveredToProvider).not.toHaveBeenCalled();
    expect(harness.session.blockPendingMessageDelivery).toHaveBeenCalledTimes(1);
    expect(harness.session.blockPendingMessageDelivery).toHaveBeenCalledWith({
      localIds: ['local-input-84'],
      reason: 'provider_rejected_before_acceptance',
    });
  });

  it('preserves native-runtime provider acceptance timeout reason when blocking canonical pending delivery', async () => {
    const harness = createHarness();
    harness.config.userMessageDeliveryWatermarkMode = 'providerAcceptance';
    let terminallyRejectedHandler:
      | ((info: Readonly<{
        localIds?: readonly string[];
        userMessageSeq?: number | null;
        userMessageSeqs?: readonly number[];
        deliveryBlockedReason?: 'provider_acceptance_timeout';
      }>) => void)
      | null = null;
    harness.runtime.setOnPromptAcceptedByProvider = vi.fn();
    harness.runtime.setOnPromptTerminallyRejectedBeforeProvider = vi.fn((handler) => {
      terminallyRejectedHandler = handler as typeof terminallyRejectedHandler;
    });
    harness.deps.runPermissionModePromptLoopFn = async () => {
      terminallyRejectedHandler?.({
        localIds: ['local-timeout-84'],
        userMessageSeq: null,
        deliveryBlockedReason: 'provider_acceptance_timeout',
      });
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(harness.session.confirmUserMessageDeliveredToProvider).not.toHaveBeenCalled();
    expect(harness.session.blockPendingMessageDelivery).toHaveBeenCalledTimes(1);
    expect(harness.session.blockPendingMessageDelivery).toHaveBeenCalledWith({
      localIds: ['local-timeout-84'],
      reason: 'provider_acceptance_timeout',
    });
  });

  it('preserves runtime-config blocked reason when blocking canonical pending delivery', async () => {
    const harness = createHarness();
    harness.config.userMessageDeliveryWatermarkMode = 'providerAcceptance';
    let terminallyRejectedHandler:
      | ((info: Readonly<{
        localIds?: readonly string[];
        userMessageSeq?: number | null;
        deliveryBlockedReason?: 'runtime_config_blocked';
      }>) => void)
      | null = null;
    harness.runtime.setOnPromptAcceptedByProvider = vi.fn();
    harness.runtime.setOnPromptTerminallyRejectedBeforeProvider = vi.fn((handler) => {
      terminallyRejectedHandler = handler as typeof terminallyRejectedHandler;
    });
    harness.deps.runPermissionModePromptLoopFn = async () => {
      terminallyRejectedHandler?.({
        localIds: ['local-runtime-config-blocked'],
        userMessageSeq: null,
        deliveryBlockedReason: 'runtime_config_blocked',
      });
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(harness.session.confirmUserMessageDeliveredToProvider).not.toHaveBeenCalled();
    expect(harness.session.blockPendingMessageDelivery).toHaveBeenCalledTimes(1);
    expect(harness.session.blockPendingMessageDelivery).toHaveBeenCalledWith({
      localIds: ['local-runtime-config-blocked'],
      reason: 'runtime_config_blocked',
    });
  });

  it('retries a draft-blocked pending row once when the native runtime reports the blocker cleared', async () => {
    const harness = createHarness();
    harness.config.userMessageDeliveryWatermarkMode = 'providerAcceptance';
    let terminallyRejectedHandler:
      | ((info: Readonly<{
        localIds?: readonly string[];
        userMessageSeq?: number | null;
        deliveryBlockedReason?: 'terminal_composer_draft';
      }>) => void)
      | null = null;
    let blockerClearedHandler: ((info?: Readonly<{ deliveryBlockedReason?: 'terminal_composer_draft' }>) => void) | null = null;
    harness.runtime.setOnPromptAcceptedByProvider = vi.fn();
    harness.runtime.setOnPromptTerminallyRejectedBeforeProvider = vi.fn((handler) => {
      terminallyRejectedHandler = handler as typeof terminallyRejectedHandler;
    });
    harness.runtime.setOnPromptDeliveryBlockerCleared = vi.fn((handler: typeof blockerClearedHandler) => {
      blockerClearedHandler = handler;
    });
    harness.deps.runPermissionModePromptLoopFn = async () => {
      terminallyRejectedHandler?.({
        localIds: ['local-draft-blocked'],
        userMessageSeq: null,
        deliveryBlockedReason: 'terminal_composer_draft',
      });
      await vi.waitFor(() => {
        expect(harness.session.blockPendingMessageDelivery).toHaveBeenCalledTimes(1);
      });
      blockerClearedHandler?.({ deliveryBlockedReason: 'terminal_composer_draft' });
      blockerClearedHandler?.({ deliveryBlockedReason: 'terminal_composer_draft' });
      await vi.waitFor(() => {
        expect(harness.session.retryPendingMessageDelivery).toHaveBeenCalledTimes(1);
      });
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(harness.session.retryPendingMessageDelivery).toHaveBeenCalledWith({
      localId: 'local-draft-blocked',
    });
  });

  it('retries a runtime-config blocked pending row once when the native runtime reports the blocker cleared', async () => {
    const harness = createHarness();
    harness.config.userMessageDeliveryWatermarkMode = 'providerAcceptance';
    let terminallyRejectedHandler:
      | ((info: Readonly<{
        localIds?: readonly string[];
        userMessageSeq?: number | null;
        deliveryBlockedReason?: 'runtime_config_blocked';
      }>) => void)
      | null = null;
    let blockerClearedHandler: ((info?: Readonly<{ deliveryBlockedReason?: 'runtime_config_blocked' }>) => void) | null = null;
    harness.runtime.setOnPromptAcceptedByProvider = vi.fn();
    harness.runtime.setOnPromptTerminallyRejectedBeforeProvider = vi.fn((handler) => {
      terminallyRejectedHandler = handler as typeof terminallyRejectedHandler;
    });
    harness.runtime.setOnPromptDeliveryBlockerCleared = vi.fn((handler: typeof blockerClearedHandler) => {
      blockerClearedHandler = handler;
    });
    harness.deps.runPermissionModePromptLoopFn = async () => {
      terminallyRejectedHandler?.({
        localIds: ['local-runtime-config-blocked'],
        userMessageSeq: null,
        deliveryBlockedReason: 'runtime_config_blocked',
      });
      await vi.waitFor(() => {
        expect(harness.session.blockPendingMessageDelivery).toHaveBeenCalledTimes(1);
      });
      blockerClearedHandler?.({ deliveryBlockedReason: 'runtime_config_blocked' });
      blockerClearedHandler?.({ deliveryBlockedReason: 'runtime_config_blocked' });
      await vi.waitFor(() => {
        expect(harness.session.retryPendingMessageDelivery).toHaveBeenCalledTimes(1);
      });
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(harness.session.retryPendingMessageDelivery).toHaveBeenCalledWith({
      localId: 'local-runtime-config-blocked',
    });
  });

  it('retries a provider-unavailable pending row once when the native runtime reports the blocker cleared', async () => {
    const harness = createHarness();
    harness.config.userMessageDeliveryWatermarkMode = 'providerAcceptance';
    let terminallyRejectedHandler:
      | ((info: Readonly<{
        localIds?: readonly string[];
        userMessageSeq?: number | null;
        deliveryBlockedReason?: 'provider_unavailable_before_acceptance';
      }>) => void)
      | null = null;
    let blockerClearedHandler:
      | ((info?: Readonly<{ deliveryBlockedReason?: 'provider_unavailable_before_acceptance' }>) => void)
      | null = null;
    harness.runtime.setOnPromptAcceptedByProvider = vi.fn();
    harness.runtime.setOnPromptTerminallyRejectedBeforeProvider = vi.fn((handler) => {
      terminallyRejectedHandler = handler as typeof terminallyRejectedHandler;
    });
    harness.runtime.setOnPromptDeliveryBlockerCleared = vi.fn((handler: typeof blockerClearedHandler) => {
      blockerClearedHandler = handler;
    });
    harness.deps.runPermissionModePromptLoopFn = async () => {
      terminallyRejectedHandler?.({
        localIds: ['local-provider-unavailable'],
        userMessageSeq: null,
        deliveryBlockedReason: 'provider_unavailable_before_acceptance',
      });
      await vi.waitFor(() => {
        expect(harness.session.blockPendingMessageDelivery).toHaveBeenCalledTimes(1);
      });
      blockerClearedHandler?.({ deliveryBlockedReason: 'provider_unavailable_before_acceptance' });
      blockerClearedHandler?.({ deliveryBlockedReason: 'provider_unavailable_before_acceptance' });
      await vi.waitFor(() => {
        expect(harness.session.retryPendingMessageDelivery).toHaveBeenCalledTimes(1);
      });
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(harness.session.retryPendingMessageDelivery).toHaveBeenCalledWith({
      localId: 'local-provider-unavailable',
    });
  });

  it.each([
    'terminal_composer_draft',
    'runtime_config_blocked',
    'provider_unavailable_before_acceptance',
  ] as const)('retries %s once when the native runtime clears it before the block write resolves', async (deliveryBlockedReason) => {
    const harness = createHarness();
    harness.config.userMessageDeliveryWatermarkMode = 'providerAcceptance';
    const blockWrite = createDeferred<boolean>();
    harness.session.blockPendingMessageDelivery = vi.fn(() => blockWrite.promise);
    let terminallyRejectedHandler:
      | ((info: Readonly<{
        localIds?: readonly string[];
        userMessageSeq?: number | null;
        deliveryBlockedReason?: typeof deliveryBlockedReason;
      }>) => void)
      | null = null;
    let blockerClearedHandler:
      | ((info?: Readonly<{ deliveryBlockedReason?: typeof deliveryBlockedReason }>) => void)
      | null = null;
    harness.runtime.setOnPromptAcceptedByProvider = vi.fn();
    harness.runtime.setOnPromptTerminallyRejectedBeforeProvider = vi.fn((handler) => {
      terminallyRejectedHandler = handler as typeof terminallyRejectedHandler;
    });
    harness.runtime.setOnPromptDeliveryBlockerCleared = vi.fn((handler: typeof blockerClearedHandler) => {
      blockerClearedHandler = handler;
    });
    harness.deps.runPermissionModePromptLoopFn = async () => {
      terminallyRejectedHandler?.({
        localIds: [`local-${deliveryBlockedReason}`],
        userMessageSeq: null,
        deliveryBlockedReason,
      });
      await vi.waitFor(() => {
        expect(harness.session.blockPendingMessageDelivery).toHaveBeenCalledTimes(1);
      });

      blockerClearedHandler?.({ deliveryBlockedReason });
      blockerClearedHandler?.({ deliveryBlockedReason });
      expect(harness.session.retryPendingMessageDelivery).not.toHaveBeenCalled();

      blockWrite.resolve(true);
      await vi.waitFor(() => {
        expect(harness.session.retryPendingMessageDelivery).toHaveBeenCalledTimes(1);
      });
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(harness.session.retryPendingMessageDelivery).toHaveBeenCalledWith({
      localId: `local-${deliveryBlockedReason}`,
    });
  });

  it('retries each same-reason pending row whose block write was in flight when the blocker cleared', async () => {
    const harness = createHarness();
    harness.config.userMessageDeliveryWatermarkMode = 'providerAcceptance';
    const firstBlockWrite = createDeferred<boolean>();
    const secondBlockWrite = createDeferred<boolean>();
    harness.session.blockPendingMessageDelivery = vi.fn()
      .mockReturnValueOnce(firstBlockWrite.promise)
      .mockReturnValueOnce(secondBlockWrite.promise);
    let terminallyRejectedHandler:
      | ((info: Readonly<{
        localIds?: readonly string[];
        userMessageSeq?: number | null;
        deliveryBlockedReason?: 'terminal_composer_draft';
      }>) => void)
      | null = null;
    let blockerClearedHandler:
      | ((info?: Readonly<{ deliveryBlockedReason?: 'terminal_composer_draft' }>) => void)
      | null = null;
    harness.runtime.setOnPromptAcceptedByProvider = vi.fn();
    harness.runtime.setOnPromptTerminallyRejectedBeforeProvider = vi.fn((handler) => {
      terminallyRejectedHandler = handler as typeof terminallyRejectedHandler;
    });
    harness.runtime.setOnPromptDeliveryBlockerCleared = vi.fn((handler: typeof blockerClearedHandler) => {
      blockerClearedHandler = handler;
    });
    harness.deps.runPermissionModePromptLoopFn = async () => {
      terminallyRejectedHandler?.({
        localIds: ['local-draft-blocked-a'],
        userMessageSeq: null,
        deliveryBlockedReason: 'terminal_composer_draft',
      });
      terminallyRejectedHandler?.({
        localIds: ['local-draft-blocked-b'],
        userMessageSeq: null,
        deliveryBlockedReason: 'terminal_composer_draft',
      });
      await vi.waitFor(() => {
        expect(harness.session.blockPendingMessageDelivery).toHaveBeenCalledTimes(2);
      });

      blockerClearedHandler?.({ deliveryBlockedReason: 'terminal_composer_draft' });
      firstBlockWrite.resolve(true);
      await vi.waitFor(() => {
        expect(harness.session.retryPendingMessageDelivery).toHaveBeenCalledTimes(1);
      });

      secondBlockWrite.resolve(true);
      await vi.waitFor(() => {
        expect(harness.session.retryPendingMessageDelivery).toHaveBeenCalledTimes(2);
      });
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(harness.session.retryPendingMessageDelivery).toHaveBeenCalledWith({
      localId: 'local-draft-blocked-a',
    });
    expect(harness.session.retryPendingMessageDelivery).toHaveBeenCalledWith({
      localId: 'local-draft-blocked-b',
    });
  });

  it('keeps the deferred watermark policy on session swap and confirms accepted prompts on the active session', async () => {
    const harness = createHarness();
    harness.config.userMessageDeliveryWatermarkMode = 'providerAcceptance';
    const initialSession = harness.session;
    const swappedSessionFixture = harness.createSessionFixture('session-2');
    const swappedSession = swappedSessionFixture.session;
    let swapSession: ((nextSession: any) => Promise<void>) | null = null;
    let acceptedHandler:
      | ((info: Readonly<{ localIds?: readonly string[]; userMessageSeq?: number | null; userMessageSeqs?: readonly number[] }>) => void)
      | null = null;

    harness.runtime.setOnPromptAcceptedByProvider = vi.fn((handler) => {
      acceptedHandler = handler;
    });
    harness.deps.initializeBackendRunSessionFn = async ({ onSessionSwap }: any) => {
      swapSession = onSessionSwap;
      return {
        session: initialSession,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: false,
      };
    };
    harness.deps.runPermissionModePromptLoopFn = async () => {
      await swapSession?.(swappedSession);
      expect(swappedSession.deferDeliveredUserMessageWatermarkToProviderAcceptance).toHaveBeenCalledTimes(1);
      acceptedHandler?.({ localIds: ['local-64'], userMessageSeq: 64, userMessageSeqs: [64] });
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(initialSession.deferDeliveredUserMessageWatermarkToProviderAcceptance).toHaveBeenCalledTimes(1);
    expect(initialSession.confirmUserMessageDeliveredToProvider).not.toHaveBeenCalled();
    expect(swappedSession.confirmUserMessageDeliveredToProvider).toHaveBeenCalledTimes(1);
    expect(swappedSession.confirmUserMessageDeliveredToProvider).toHaveBeenCalledWith({
      localIds: ['local-64'],
      userMessageSeq: 64,
      userMessageSeqs: [64],
    });
  });

  it('hands undeliverable native-runtime prompts back to the mode queue with their seq without confirming the watermark', async () => {
    const harness = createHarness();
    let undeliverableHandler:
      | ((prompts: ReadonlyArray<Readonly<{ text: string; localInputIds?: readonly string[]; localIds?: readonly string[]; userMessageSeq: number | null; userMessageSeqs?: readonly number[] }>>) => void)
      | null = null;
    const messageQueue = {
      reset: vi.fn(),
      size: vi.fn(() => 0),
      unshift: vi.fn(),
    };

    harness.runtime.setOnPromptAcceptedByProvider = vi.fn();
    harness.runtime.setOnUndeliverablePrompts = vi.fn((handler) => {
      undeliverableHandler = handler;
    });
    harness.deps.createPermissionModeQueueStateFn = () => ({
      messageQueue,
      rebindSession: () => undefined,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => undefined,
      getCurrentPermissionModeUpdatedAt: () => 0,
      setCurrentPermissionModeUpdatedAt: () => undefined,
    });
    harness.deps.runPermissionModePromptLoopFn = async () => {
      undeliverableHandler?.([{
        text: 'retry after runtime death',
        localIds: ['local-77'],
        userMessageSeq: 77,
        userMessageSeqs: [77],
      }]);
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(harness.runtime.setOnUndeliverablePrompts).toHaveBeenCalledTimes(1);
    expect(harness.session.confirmUserMessageDeliveredToProvider).not.toHaveBeenCalled();
    expect(messageQueue.unshift).toHaveBeenCalledWith(
      {
        text: 'retry after runtime death',
        localId: 'local-77',
        localIds: ['local-77'],
        userMessageSeq: 77,
        userMessageSeqs: [77],
      },
      { permissionMode: 'default', suppressUserEcho: true, providerPromptAlreadyResolved: true },
    );
  });

  it('does not requeue an undeliverable native-runtime prompt accepted during the same dispatch', async () => {
    const harness = createHarness();
    harness.config.userMessageDeliveryWatermarkMode = 'providerAcceptance';
    let acceptedHandler:
      | ((info: Readonly<{ localInputIds?: readonly string[]; localIds?: readonly string[]; userMessageSeq?: number | null; userMessageSeqs?: readonly number[] }>) => void)
      | null = null;
    let undeliverableHandler:
      | ((prompts: ReadonlyArray<Readonly<{ text: string; localInputIds?: readonly string[]; localIds?: readonly string[]; userMessageSeq: number | null; userMessageSeqs?: readonly number[] }>>) => void)
      | null = null;
    const messageQueue = {
      reset: vi.fn(),
      size: vi.fn(() => 0),
      unshift: vi.fn(),
    };
    const nativeRuntime = {
      ...harness.runtime,
      setOnPromptAcceptedByProvider: vi.fn((handler) => {
        acceptedHandler = handler;
      }),
      setOnUndeliverablePrompts: vi.fn((handler) => {
        undeliverableHandler = handler;
      }),
      sendTurnPrompt: vi.fn(async function (
        this: unknown,
        prompt: string,
        meta?: Readonly<{ localId?: string | null; userMessageSeq?: number | null; userMessageSeqs?: readonly number[] }>,
      ) {
        expect(this).toBe(nativeRuntime);
        undeliverableHandler?.([{
          text: prompt,
          localIds: meta?.localId ? [meta.localId] : [],
          userMessageSeq: meta?.userMessageSeq ?? null,
          userMessageSeqs: meta?.userMessageSeqs,
        }]);
        acceptedHandler?.({
          localIds: meta?.localId ? [meta.localId] : [],
          userMessageSeq: meta?.userMessageSeq ?? null,
          userMessageSeqs: meta?.userMessageSeqs,
        });
      }),
    };
    setSessionRuntimeFactory(harness.config, () => ({
      operations: nativeRuntime as any,
      nativeRuntime: nativeRuntime as any,
    }));
    harness.deps.createPermissionModeQueueStateFn = () => ({
      messageQueue,
      rebindSession: () => undefined,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => undefined,
      getCurrentPermissionModeUpdatedAt: () => 0,
      setCurrentPermissionModeUpdatedAt: () => undefined,
    });
    harness.deps.runPermissionModePromptLoopFn = async (params: Readonly<{
      runtime: Readonly<{
        sendTurnPrompt: (
          prompt: string,
          meta?: Readonly<{ localId?: string | null; userMessageSeq?: number | null; userMessageSeqs?: readonly number[] }>,
        ) => Promise<void>;
      }>;
    }>) => {
      await params.runtime.sendTurnPrompt('internally retried prompt', {
        localId: 'local-internal-retry',
        userMessageSeq: 90,
        userMessageSeqs: [90],
      });
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(harness.session.confirmUserMessageDeliveredToProvider).toHaveBeenCalledWith({
      localIds: ['local-internal-retry'],
      userMessageSeq: 90,
      userMessageSeqs: [90],
    });
    expect(messageQueue.unshift).not.toHaveBeenCalled();
  });

  it('normalizes plugin SDK localInputIds when handing undeliverable native-runtime prompts back to the queue', async () => {
    const harness = createHarness();
    let undeliverableHandler:
      | ((prompts: ReadonlyArray<Readonly<{ text: string; localInputIds?: readonly string[]; userMessageSeq: number | null; userMessageSeqs?: readonly number[] }>>) => void)
      | null = null;
    const messageQueue = {
      reset: vi.fn(),
      size: vi.fn(() => 0),
      unshift: vi.fn(),
    };

    harness.runtime.setOnPromptAcceptedByProvider = vi.fn();
    harness.runtime.setOnUndeliverablePrompts = vi.fn((handler) => {
      undeliverableHandler = handler;
    });
    harness.deps.createPermissionModeQueueStateFn = () => ({
      messageQueue,
      rebindSession: () => undefined,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => undefined,
      getCurrentPermissionModeUpdatedAt: () => 0,
      setCurrentPermissionModeUpdatedAt: () => undefined,
    });
    harness.deps.runPermissionModePromptLoopFn = async () => {
      undeliverableHandler?.([{
        text: 'retry local input id after runtime death',
        localInputIds: ['local-input-77'],
        userMessageSeq: null,
      }]);
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(messageQueue.unshift).toHaveBeenCalledWith(
      {
        text: 'retry local input id after runtime death',
        localId: 'local-input-77',
        localIds: ['local-input-77'],
      },
      { permissionMode: 'default', suppressUserEcho: true, providerPromptAlreadyResolved: true },
    );
  });

  it('preserves native runtime restart policy when driving RuntimeTurnOperations', async () => {
    const harness = createHarness();
    const operations = {
      beginTurnLifecycle: vi.fn(),
      startOrLoadSession: vi.fn(async () => undefined),
      sendTurnPrompt: vi.fn(async () => undefined),
      steerInFlightTurn: vi.fn(async () => undefined),
      waitForTurnCompletion: vi.fn(async () => undefined),
      subscribeRuntimeEvents: vi.fn(() => () => undefined),
      cancelTurn: vi.fn(async () => undefined),
      readSessionIdentity: vi.fn(() => ({ sessionId: null })),
      updateSessionRuntimeConfig: vi.fn(async () => undefined),
      resetOrDisposeRuntime: vi.fn(async () => undefined),
    };
    const nativeRuntime = {
      ...harness.runtime,
      shouldResumeAfterPermissionModeChange: vi.fn(() => false),
    };
    harness.config.createSessionRuntime = vi.fn(() => ({
      operations,
      nativeRuntime,
    }));

    let capturedShouldResume: boolean | undefined;
    harness.deps.runPermissionModePromptLoopFn = async (params: Readonly<{
      runtime: Readonly<{
        shouldResumeAfterPermissionModeChange?: () => boolean;
      }>;
    }>) => {
      capturedShouldResume = params.runtime.shouldResumeAfterPermissionModeChange?.();
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(capturedShouldResume).toBe(false);
    expect(nativeRuntime.shouldResumeAfterPermissionModeChange).toHaveBeenCalledTimes(1);
  });

  it('uses custom ready sender when provided', async () => {
    const harness = createHarness();
    harness.config.createSendReady = () => () => {
      harness.metrics.bumpCustomReadyCalls();
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(harness.metrics.customReadyCalls).toBe(1);
    expect(harness.metrics.defaultReadyCalls).toBe(0);
  });

  it('uses provider-controlled keep-alive mode when configured', async () => {
    const harness = createHarness();
    const keepAliveModes: string[] = [];
    harness.session.keepAlive = vi.fn((_thinking: boolean, mode: string) => {
      keepAliveModes.push(mode);
    });
    (harness.config as any).resolveKeepAliveMode = () => 'terminal';

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(keepAliveModes[0]).toBe('local');
  });

  it('skips terminal rendering when the provider disables the remote terminal UI', async () => {
    const harness = createHarness();
    const renderFn = vi.fn(() => ({ unmount: vi.fn() }));
    (harness.config as any).shouldRenderTerminalDisplay = () => false;

    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });

    try {
      await runHostSessionRuntime(harness.opts, harness.config, {
        ...harness.deps,
        renderFn,
      });
    } finally {
      if (stdoutDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
      if (stdinDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
    }

    expect(renderFn).not.toHaveBeenCalled();
  });

  it('uses static remote control instead of Ink for daemon-started tmux sessions', async () => {
    const harness = createHarness();
    harness.opts.startedBy = 'daemon';
    harness.opts.terminalRuntime = { mode: 'tmux' };
    harness.config.shouldRenderTerminalDisplay = () => true;
    harness.runtime.resolveTerminalRemoteSessionModeLoop = vi.fn(() => createTerminalRemoteModeLoopFixture());

    const renderFn = vi.fn(() => ({ unmount: vi.fn() }));
    const stopStaticControl = vi.fn(async () => undefined);
    const startRemoteModeStaticControlFn = vi.fn(() => ({ stop: stopStaticControl }));

    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });

    try {
      await runHostSessionRuntime(harness.opts, harness.config, {
        ...harness.deps,
        renderFn,
        startRemoteModeStaticControlFn,
      });
    } finally {
      if (stdoutDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
      if (stdinDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
    }

    expect(renderFn).not.toHaveBeenCalled();
    expect(startRemoteModeStaticControlFn).toHaveBeenCalledWith(expect.objectContaining({
      providerName: 'Qwen Code',
      allowSwitchToTerminal: false,
    }));
    expect(stopStaticControl).toHaveBeenCalledTimes(1);
  });

  it('mounts the remote-only terminal display instead of static control for daemon-started tmux sessions without terminal runtime support', async () => {
    const harness = createHarness();
    function InteractiveTerminalDisplay(): null {
      return null;
    }
    function RemoteOnlyTerminalDisplay(_props: Readonly<{
      messageBuffer: MessageBuffer;
      backendDisplayName: string;
      requestedMode: 'terminal' | 'remote';
      logPath?: string;
      onExit: () => void | Promise<void>;
    }>): null {
      return null;
    }
    harness.opts.startedBy = 'daemon';
    harness.opts.terminalRuntime = { mode: 'tmux' };
    (harness.opts as typeof harness.opts & { startingMode: 'terminal' }).startingMode = 'terminal';
    harness.config.terminalDisplay = InteractiveTerminalDisplay;
    harness.config.shouldRenderTerminalDisplay = () => true;

    const renderedElements: Array<Readonly<{
      type: unknown;
      props: Readonly<Record<string, unknown>>;
    }>> = [];
    const renderFn = vi.fn((element: unknown) => {
      renderedElements.push(element as Readonly<{
        type: unknown;
        props: Readonly<Record<string, unknown>>;
      }>);
      return { unmount: vi.fn() };
    });
    const startRemoteModeStaticControlFn = vi.fn(() => ({ stop: vi.fn(async () => undefined) }));

    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });

    try {
      await runHostSessionRuntime(harness.opts, harness.config, {
        ...harness.deps,
        renderFn,
        startRemoteModeStaticControlFn,
        sessionLoopLifecycleDeps: {
          remoteOnlyTerminalDisplayComponent: RemoteOnlyTerminalDisplay,
        },
      });
    } finally {
      if (stdoutDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
      if (stdinDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
    }

    expect(startRemoteModeStaticControlFn).not.toHaveBeenCalled();
    expect(renderFn).toHaveBeenCalledTimes(1);
    const renderedElement = renderedElements[0];
    expect(renderedElement?.type).toBe(RemoteOnlyTerminalDisplay);
    expect(renderedElement?.props).toEqual(expect.objectContaining({
      backendDisplayName: 'Qwen Code',
      requestedMode: 'terminal',
      messageBuffer: expect.any(MessageBuffer),
      onExit: expect.any(Function),
    }));
  });

  it('mounts the remote-only terminal display when terminal mode is requested without terminal runtime support', async () => {
    const harness = createHarness();
    function InteractiveTerminalDisplay(): null {
      return null;
    }
    function RemoteOnlyTerminalDisplay(_props: Readonly<{
      messageBuffer: MessageBuffer;
      backendDisplayName: string;
      requestedMode: 'terminal' | 'remote';
      logPath?: string;
      onExit: () => void | Promise<void>;
    }>): null {
      return null;
    }
    harness.opts.startedBy = 'terminal';
    (harness.opts as typeof harness.opts & { startingMode: 'terminal' }).startingMode = 'terminal';
    harness.config.terminalDisplay = InteractiveTerminalDisplay;
    harness.config.shouldRenderTerminalDisplay = () => true;

    const renderedElements: Array<Readonly<{
      type: unknown;
      props: Readonly<Record<string, unknown>>;
    }>> = [];
    const renderFn = vi.fn((element: unknown) => {
      renderedElements.push(element as Readonly<{
        type: unknown;
        props: Readonly<Record<string, unknown>>;
      }>);
      return { unmount: vi.fn() };
    });
    const startRemoteModeStaticControlFn = vi.fn(() => ({ stop: vi.fn(async () => undefined) }));

    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });

    try {
      await runHostSessionRuntime(harness.opts, harness.config, {
        ...harness.deps,
        renderFn,
        startRemoteModeStaticControlFn,
        sessionLoopLifecycleDeps: {
          remoteOnlyTerminalDisplayComponent: RemoteOnlyTerminalDisplay,
        },
      });
    } finally {
      if (stdoutDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
      if (stdinDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
    }

    expect(startRemoteModeStaticControlFn).not.toHaveBeenCalled();
    expect(renderFn).toHaveBeenCalledTimes(1);
    const renderedElement = renderedElements[0];
    expect(renderedElement?.type).toBe(RemoteOnlyTerminalDisplay);
    expect(renderedElement?.props).toEqual(expect.objectContaining({
      backendDisplayName: 'Qwen Code',
      requestedMode: 'terminal',
      messageBuffer: expect.any(MessageBuffer),
      onExit: expect.any(Function),
    }));
  });

  it('exposes a terminal display controller for provider-managed mount and unmount transitions', async () => {
    const harness = createHarness();
    const renderUnmounts: Array<ReturnType<typeof vi.fn>> = [];
    const renderFn = vi.fn(() => {
      const unmount = vi.fn();
      renderUnmounts.push(unmount);
      return { unmount };
    });
    let controller:
      | {
        mount: () => void;
        unmount: () => Promise<void>;
        isMounted: () => boolean;
      }
      | null = null;

    harness.config.shouldRenderTerminalDisplay = () => false;
    (harness.config as any).onTerminalDisplayControllerReady = (value: typeof controller) => {
      controller = value;
    };
    harness.deps.runPermissionModePromptLoopFn = async (params: any) => {
      if (!controller) throw new Error('Expected terminal display controller');
      expect(controller.isMounted()).toBe(false);
      controller.mount();
      expect(controller.isMounted()).toBe(true);
      await controller.unmount();
      expect(controller.isMounted()).toBe(false);
      controller.mount();
      params.sendReady();
    };

    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });

    try {
      await runHostSessionRuntime(harness.opts, harness.config, {
        ...harness.deps,
        renderFn,
      });
    } finally {
      if (stdoutDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
      if (stdinDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
    }

    expect(renderFn).toHaveBeenCalledTimes(2);
    const firstUnmount = renderUnmounts.at(0);
    const secondUnmount = renderUnmounts.at(1);
    expect(firstUnmount).toBeDefined();
    expect(secondUnmount).toBeDefined();
    expect(firstUnmount).toHaveBeenCalledTimes(1);
    expect(secondUnmount).toHaveBeenCalledTimes(1);
  });

  it('awaits async provider-specific session swap hooks before continuing', async () => {
    const harness = createHarness();
    const callOrder: string[] = [];
    let swappedHookParams: unknown = null;
    let finishHook: (() => void) | null = null;
    const onSessionSwap = vi.fn(async (params: unknown) => {
      swappedHookParams = params;
      callOrder.push('hook:start');
      await new Promise<void>((resolve) => {
        finishHook = () => {
          callOrder.push('hook:end');
          resolve();
        };
      });
    });
    harness.config.onSessionSwap = onSessionSwap as any;

    harness.deps.initializeBackendRunSessionFn = async ({ onSessionSwap: notifySessionSwap, metadata }: any) => {
      expect((metadata as any).auggieAllowIndexing).toBe(true);
      const swappedSession = {
        ...harness.session,
        sessionId: 'session-2',
      };
      callOrder.push('before-notify');
      let notifyFinished = false;
      const notifyPromise = Promise.resolve(notifySessionSwap(swappedSession)).then(() => {
        notifyFinished = true;
        callOrder.push('after-notify');
      });
      await Promise.resolve();
      try {
        expect(notifyFinished).toBe(false);
        expect(finishHook).toBeTypeOf('function');
      } finally {
        finishHook?.();
        await notifyPromise;
      }
      return {
        session: harness.session,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: false,
      };
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(onSessionSwap).toHaveBeenCalledTimes(1);
    expect(swappedHookParams).toMatchObject({
      session: expect.objectContaining({ sessionId: 'session-2' }),
    });
    expect(callOrder).toEqual(['before-notify', 'hook:start', 'hook:end', 'after-notify']);
  });

  it('rebinds permission-mode queue delivery to the swapped session before continuing', async () => {
    const harness = createHarness();
    const rebindSession = vi.fn();
    harness.deps.createPermissionModeQueueStateFn = () => ({
      messageQueue: {
        reset: () => undefined,
        size: () => 0,
      },
      rebindSession,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => undefined,
      getCurrentPermissionModeUpdatedAt: () => 0,
      setCurrentPermissionModeUpdatedAt: () => undefined,
    });

    harness.deps.initializeBackendRunSessionFn = async ({ onSessionSwap: notifySessionSwap, metadata }: any) => {
      expect((metadata as any).auggieAllowIndexing).toBe(true);
      const swappedSession = {
        ...harness.session,
        sessionId: 'session-2',
      };
      await notifySessionSwap(swappedSession);
      return {
        session: harness.session,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: false,
      };
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(rebindSession).toHaveBeenCalledTimes(1);
    expect(rebindSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-2' }));
  });

  it('rebases host lifecycle ready, keepalive, and prompt-loop session reads after a deferred session swap', async () => {
    const harness = createHarness();
    const initialSession = harness.session;
    initialSession.keepAlive = vi.fn();
    initialSession.sendSessionEvent = vi.fn();
    initialSession.getMetadataSnapshot = vi.fn(() => ({ profileId: 'profile-1' }));
    initialSession.waitForMetadataUpdate = vi.fn(async () => false);
    initialSession.popPendingMessage = vi.fn(async () => false);

    const swappedSession = {
      ...initialSession,
      sessionId: 'session-2',
      keepAlive: vi.fn(),
      sendSessionEvent: vi.fn(),
      getMetadataSnapshot: vi.fn(() => ({ profileId: 'profile-2' })),
      waitForMetadataUpdate: vi.fn(async () => true),
      popPendingMessage: vi.fn(async () => true),
    };

    let pendingApply: (() => Promise<void>) | null = null;
    let metadataAfterBoundary: unknown = null;
    let metadataWaitAfterBoundary: boolean | undefined;
    let popPendingAfterBoundary: boolean | undefined;

    harness.config.createSendReady = ({ session }) => () => {
      session.sendSessionEvent({ type: 'ready' });
    };
    harness.config.lifecycleHooks = {
      createSessionSwapStrategy: () => ({
        requestSessionSwap: ({ applyImmediately }) => {
          pendingApply = applyImmediately;
        },
        flushPendingSessionSwap: async () => {
          await pendingApply?.();
          pendingApply = null;
        },
      }),
    };
    harness.deps.initializeBackendRunSessionFn = async ({ onSessionSwap: notifySessionSwap }: any) => {
      await notifySessionSwap(swappedSession);
      return {
        session: initialSession,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: false,
      };
    };
    harness.deps.runPermissionModePromptLoopFn = async (params: Readonly<{
      session: Readonly<{
        getMetadataSnapshot: () => unknown;
        waitForMetadataUpdate: () => Promise<boolean>;
        popPendingMessage: () => Promise<boolean>;
      }>;
      keepAlive: () => void;
      sendReady: () => void;
      onAfterLoopBoundary?: (args: { reason: 'turn_completed' }) => Promise<void> | void;
    }>) => {
      await params.onAfterLoopBoundary?.({ reason: 'turn_completed' });
      params.keepAlive();
      params.sendReady();
      metadataAfterBoundary = params.session.getMetadataSnapshot();
      metadataWaitAfterBoundary = await params.session.waitForMetadataUpdate();
      popPendingAfterBoundary = await params.session.popPendingMessage();
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(swappedSession.keepAlive).toHaveBeenCalledWith(false, 'remote');
    expect(swappedSession.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
    expect(metadataAfterBoundary).toEqual({ profileId: 'profile-2' });
    expect(metadataWaitAfterBoundary).toBe(true);
    expect(popPendingAfterBoundary).toBe(true);
    expect(initialSession.sendSessionEvent).not.toHaveBeenCalledWith({ type: 'ready' });
  });

  it('runs provider-specific dispose hooks during cleanup', async () => {
    const harness = createHarness();
    const callOrder: string[] = [];
    const onDispose = vi.fn(async () => {
      callOrder.push('dispose');
    });
    harness.config.onDispose = onDispose as any;
    harness.config.lifecycleHooks = {
      onBeforeDispose: async () => {
        callOrder.push('beforeDispose');
      },
    };
    harness.deps.cleanupBackendRunResourcesFn = async ({ keepAliveInterval, unmountUi }: any) => {
      callOrder.push('cleanup');
      clearInterval(keepAliveInterval);
      await unmountUi?.();
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(onDispose).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['beforeDispose', 'cleanup', 'dispose']);
  });

  it('invokes abort handler lifecycle when abort RPC fires', async () => {
    const harness = createHarness();
    harness.deps.runPermissionModePromptLoopFn = async () => {
      const abort = harness.handlers.get('abort');
      expect(abort).toBeTypeOf('function');
      await abort?.();
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(harness.metrics.queueResetCalls).toBe(0);
    expect(harness.metrics.permissionResetCalls).toBe(1);
    expect(harness.metrics.archiveCalls).toBe(0);
  });

  it('invokes kill handler lifecycle without archiving the session', async () => {
    const harness = createHarness();
    harness.opts.startedBy = 'daemon';
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    harness.deps.runPermissionModePromptLoopFn = async () => {
      expect(harness.metrics.killHandler).toBeTypeOf('function');
      await harness.metrics.killHandler?.();
    };

    try {
      await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
    } finally {
      exitSpy.mockRestore();
    }

    expect(harness.metrics.archiveCalls).toBe(0);
    expect(harness.metrics.cleanupCalls).toBe(1);
  });

  it('passes a permission-mode queue key resolver when provided', async () => {
    const harness = createHarness();
    const resolvePermissionModeQueueKey = (mode: string) => `key:${mode}`;
    (harness.config as any).resolvePermissionModeQueueKey = resolvePermissionModeQueueKey;

    let observed: unknown = null;
    harness.deps.createPermissionModeQueueStateFn = (params: any) => {
      observed = params.resolvePermissionModeQueueKey ?? null;
      return {
        messageQueue: { reset: () => undefined, size: () => 0 },
        rebindSession: () => undefined,
        getCurrentPermissionMode: () => 'default',
        setCurrentPermissionMode: () => undefined,
        getCurrentPermissionModeUpdatedAt: () => 0,
        setCurrentPermissionModeUpdatedAt: () => undefined,
      };
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
    expect(observed).toBe(resolvePermissionModeQueueKey);
  });

  it('maps configured ACP flavors onto generic ACP permission semantics', async () => {
    const harness = createHarness();
    const createSessionMetadataFn = vi.fn(() => ({
      state: { controlledByUser: false },
      metadata: { path: '/tmp/workspace', permissionMode: 'default', permissionModeUpdatedAt: Date.now() },
    }));

    harness.config.flavor = 'acp:custom-kiro';
    harness.config.policyAgentId = 'customAcp';
    harness.opts.backendTarget = 'backend:acp:configured:custom-kiro';
    harness.opts.accountSettingsContext = {
      source: 'network',
      settings: {
        sessionDefaultPermissionModeByTargetKey: {
          [buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'custom-kiro' })]: 'yolo',
        },
      } as any,
      settingsVersion: 1,
      loadedAtMs: Date.now(),
      settingsSecretsReadKeys: [],
      whenRefreshed: null,
    };
    harness.deps.createSessionMetadataFn = createSessionMetadataFn;

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(createSessionMetadataFn).toHaveBeenCalledWith(expect.objectContaining({
      flavor: 'acp:custom-kiro',
      permissionMode: 'yolo',
    }));
  });

  it('uses an explicit policy agent id instead of inferring customAcp from the flavor', async () => {
    const harness = createHarness();
    const createSessionMetadataFn = vi.fn(() => ({
      state: { controlledByUser: false },
      metadata: { path: '/tmp/workspace', permissionMode: 'default', permissionModeUpdatedAt: Date.now() },
    }));

    harness.config.flavor = 'acp:custom-kiro';
    harness.config.policyAgentId = 'claude';
    harness.opts.accountSettingsContext = {
      source: 'network',
      settings: {
        sessionDefaultPermissionModeByTargetKey: {
          [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'claude' })]: 'read-only',
          [buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'custom-kiro' })]: 'yolo',
        },
      } as any,
      settingsVersion: 1,
      loadedAtMs: Date.now(),
      settingsSecretsReadKeys: [],
      whenRefreshed: null,
    };
    harness.deps.createSessionMetadataFn = createSessionMetadataFn;
    harness.deps.resolveRunnerMcpServersFn = vi.fn(async () => ({
      happierMcpServer: { stop: () => undefined },
      mcpServers: { happier: { command: 'built-in' } },
    }));

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(createSessionMetadataFn).toHaveBeenCalledWith(expect.objectContaining({
      flavor: 'acp:custom-kiro',
      permissionMode: 'read-only',
    }));
    expect(harness.deps.resolveRunnerMcpServersFn).toHaveBeenCalledTimes(1);
  });

  it('treats unknown ACP flavors as custom ACP policy family instead of falling back to the default built-in agent', async () => {
    const harness = createHarness();
    const createSessionMetadataFn = vi.fn(() => ({
      state: { controlledByUser: false },
      metadata: { path: '/tmp/workspace', permissionMode: 'default', permissionModeUpdatedAt: Date.now() },
    }));

    harness.config.flavor = 'custom-kiro';
    harness.config.policyAgentId = 'customAcp';
    harness.opts.backendTarget = 'backend:acp:configured:custom-kiro';
    harness.opts.accountSettingsContext = {
      source: 'network',
      settings: {
        sessionDefaultPermissionModeByTargetKey: {
          [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'claude' })]: 'read-only',
          [buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'custom-kiro' })]: 'yolo',
        },
      } as any,
      settingsVersion: 1,
      loadedAtMs: Date.now(),
      settingsSecretsReadKeys: [],
      whenRefreshed: null,
    };
    harness.deps.createSessionMetadataFn = createSessionMetadataFn;

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(createSessionMetadataFn).toHaveBeenCalledWith(expect.objectContaining({
      flavor: 'custom-kiro',
      permissionMode: 'yolo',
    }));
  });

  it('passes account settings secret read keys into the provider-enforced permission handler', async () => {
    const harness = createHarness();
    let observedGetAccountSettingsSecretsReadKeys:
      | (() => ReadonlyArray<Uint8Array>)
      | undefined;
    const createProviderEnforcedPermissionHandlerFn = vi.fn((params: {
      getAccountSettingsSecretsReadKeys?: () => ReadonlyArray<Uint8Array>;
    }) => {
      observedGetAccountSettingsSecretsReadKeys = params.getAccountSettingsSecretsReadKeys;
      return {
        setPermissionMode: () => undefined,
        reset: () => undefined,
        updateSession: () => undefined,
      };
    });
    harness.deps.createProviderEnforcedPermissionHandlerFn = createProviderEnforcedPermissionHandlerFn;
    const settingsSecretsReadKeys = [new Uint8Array(32).fill(4)];
    harness.opts.accountSettingsContext = {
      source: 'network',
      settings: {} as any,
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys,
      whenRefreshed: null,
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(createProviderEnforcedPermissionHandlerFn).toHaveBeenCalledWith(
      expect.objectContaining({
        getAccountSettingsSecretsReadKeys: expect.any(Function),
      }),
    );
    expect(observedGetAccountSettingsSecretsReadKeys?.()).toEqual(settingsSecretsReadKeys);
  });

  it('passes pending queue delivery timing from account settings into the permission prompt loop', async () => {
    const harness = createHarness();
    let observedPendingQueueDeliveryTiming: unknown;
    harness.opts.accountSettingsContext = {
      source: 'network',
      settings: {
        sessionPendingQueueDeliveryTiming: 'after_runtime_idle',
      } as any,
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      whenRefreshed: null,
    };
    harness.deps.runPermissionModePromptLoopFn = async (params: { pendingQueueDeliveryTiming?: unknown }) => {
      observedPendingQueueDeliveryTiming = params.pendingQueueDeliveryTiming;
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(observedPendingQueueDeliveryTiming).toBe('after_runtime_idle');
  });

  it('does not stamp provider-enforced permission traces from the shared host path by default', async () => {
    const harness = createHarness();
    let observedToolTrace: unknown;
    const createProviderEnforcedPermissionHandlerFn = vi.fn((params: {
      toolTrace?: unknown;
    }) => {
      observedToolTrace = params.toolTrace;
      return {
        setPermissionMode: () => undefined,
        reset: () => undefined,
        updateSession: () => undefined,
      };
    });
    harness.deps.createProviderEnforcedPermissionHandlerFn = createProviderEnforcedPermissionHandlerFn;

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(createProviderEnforcedPermissionHandlerFn).toHaveBeenCalledWith(
      expect.not.objectContaining({
        toolTrace: expect.objectContaining({ protocol: 'acp' }),
      }),
    );
    expect(observedToolTrace).toBeNull();
  });

  it('passes provider-owned permission trace adapters through the shared host path', async () => {
    const harness = createHarness();
    const createProviderEnforcedPermissionHandlerFn = vi.fn(() => ({
      setPermissionMode: () => undefined,
      reset: () => undefined,
      updateSession: () => undefined,
    }));
    harness.deps.createProviderEnforcedPermissionHandlerFn = createProviderEnforcedPermissionHandlerFn;
    harness.config.resolvePermissionToolTrace = () => ({
      protocol: 'claude',
      provider: 'claude',
    });

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(createProviderEnforcedPermissionHandlerFn).toHaveBeenCalledWith(
      expect.objectContaining({
        toolTrace: {
          protocol: 'claude',
          provider: 'claude',
        },
      }),
    );
  });
});
