import { describe, expect, it, vi } from 'vitest';

import { runStandardAcpProvider, type StandardAcpProviderConfig, type StandardAcpProviderRunOptions } from './runStandardAcpProvider';

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

  const handlers = new Map<string, () => void | Promise<void>>();

  const session: any = {
    sessionId: 'session-1',
    rpcHandlerManager: {
      registerHandler: (name: string, handler: () => void | Promise<void>) => {
        handlers.set(name, handler);
      },
    },
    sendAgentMessage: vi.fn(),
    sendSessionEvent: vi.fn(),
    keepAlive: vi.fn(),
    getMetadataSnapshot: () => ({ path: '/tmp/workspace', permissionMode: 'default' }),
    updateMetadata: vi.fn(),
    sendSessionDeath: vi.fn(),
    flush: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };

  const runtime: any = {
    beginTurn: vi.fn(),
    startOrLoad: vi.fn(async () => undefined),
    sendPrompt: vi.fn(async () => undefined),
    flushTurn: vi.fn(),
    reset: vi.fn(async () => undefined),
    getSessionId: vi.fn(() => null),
    cancel: vi.fn(async () => undefined),
    setSessionMode: vi.fn(async () => undefined),
    setSessionConfigOption: vi.fn(async () => undefined),
    setSessionModel: vi.fn(async () => undefined),
  };

  const opts: StandardAcpProviderRunOptions = {
    credentials: { token: 'x' } as any,
  };

  const config: StandardAcpProviderConfig = {
    flavor: 'qwen',
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
    createRuntime: () => runtime,
    onAfterStart: async () => {
      onAfterStartCalls += 1;
    },
    onAfterReset: async () => {
      onAfterResetCalls += 1;
    },
    formatPromptErrorMessage: (error) => String(error),
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
    createHappierMcpBridgeFn: async () => ({
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
    registerKillSessionHandlerFn: (_manager: unknown, handler: () => void | Promise<void>) => {
      killHandler = handler;
    },
    archiveAndCloseSessionFn: async () => {
      archiveCalls += 1;
    },
    cleanupBackendRunResourcesFn: async ({ keepAliveInterval }: any) => {
      cleanupCalls += 1;
      clearInterval(keepAliveInterval);
    },
  };

  return {
    opts,
    config,
    deps,
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
    },
  };
}

describe('runStandardAcpProvider', () => {
  it('uses default ready sender and runs lifecycle hooks', async () => {
    const harness = createHarness();

    await runStandardAcpProvider(harness.opts, harness.config, harness.deps);

    expect(harness.metrics.beforeInitializeCalls).toBe(1);
    expect(harness.metrics.onAfterStartCalls).toBe(1);
    expect(harness.metrics.onAfterResetCalls).toBe(1);
    expect(harness.metrics.defaultReadyCalls).toBe(1);
    expect(harness.metrics.cleanupCalls).toBe(1);
  });

  it('in-flight steer controller calls steerPrompt with correct receiver', async () => {
    const harness = createHarness();

    const runtime = {
      beginTurn: vi.fn(),
      startOrLoad: vi.fn(async () => undefined),
      sendPrompt: vi.fn(async () => undefined),
      flushTurn: vi.fn(),
      reset: vi.fn(async () => undefined),
      getSessionId: vi.fn(() => null),
      cancel: vi.fn(async () => undefined),
      setSessionMode: vi.fn(async () => undefined),
      setSessionConfigOption: vi.fn(async () => undefined),
      setSessionModel: vi.fn(async () => undefined),
      steerPrompt: vi.fn(async function (this: unknown) {
        if (this !== runtime) {
          throw new Error('steerPrompt called with wrong receiver');
        }
      }),
    };

    harness.config.createRuntime = () => runtime as any;

    let inFlightSteer: any = null;
    harness.deps.createPermissionModeQueueStateFn = (params: any) => {
      inFlightSteer = params.inFlightSteer;
      return {
        messageQueue: {
          reset: () => undefined,
          size: () => 0,
        },
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

    await runStandardAcpProvider(harness.opts, harness.config, harness.deps);

    expect(runtime.steerPrompt).toHaveBeenCalledWith('hello');
  });

  it('uses custom ready sender when provided', async () => {
    const harness = createHarness();
    harness.config.createSendReady = () => () => {
      harness.metrics.bumpCustomReadyCalls();
    };

    await runStandardAcpProvider(harness.opts, harness.config, harness.deps);

    expect(harness.metrics.customReadyCalls).toBe(1);
    expect(harness.metrics.defaultReadyCalls).toBe(0);
  });

  it('invokes abort handler lifecycle when abort RPC fires', async () => {
    const harness = createHarness();
    harness.deps.runPermissionModePromptLoopFn = async () => {
      const abort = harness.handlers.get('abort');
      expect(abort).toBeTypeOf('function');
      await abort?.();
    };

    await runStandardAcpProvider(harness.opts, harness.config, harness.deps);

    expect(harness.metrics.queueResetCalls).toBe(1);
    expect(harness.metrics.permissionResetCalls).toBe(1);
    expect(harness.metrics.archiveCalls).toBe(0);
  });

  it('invokes kill handler lifecycle and archives session', async () => {
    const harness = createHarness();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    harness.deps.runPermissionModePromptLoopFn = async () => {
      expect(harness.metrics.killHandler).toBeTypeOf('function');
      await harness.metrics.killHandler?.();
    };

    try {
      await runStandardAcpProvider(harness.opts, harness.config, harness.deps);
    } finally {
      exitSpy.mockRestore();
    }

    expect(harness.metrics.archiveCalls).toBe(1);
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
        getCurrentPermissionMode: () => 'default',
        setCurrentPermissionMode: () => undefined,
        getCurrentPermissionModeUpdatedAt: () => 0,
        setCurrentPermissionModeUpdatedAt: () => undefined,
      };
    };

    await runStandardAcpProvider(harness.opts, harness.config, harness.deps);
    expect(observed).toBe(resolvePermissionModeQueueKey);
  });
});
