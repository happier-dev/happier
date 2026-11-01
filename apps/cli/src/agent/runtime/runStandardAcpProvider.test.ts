import { describe, expect, it, vi } from 'vitest';
import type { AgentState, Metadata } from '@/api/types';
import { createProviderEnforcedPermissionHandler } from '@/agent/permissions/createProviderEnforcedPermissionHandler';
import { buildBackendTargetKey } from '@happier-dev/protocol';
import { createTestAcpRuntime } from '@/testkit/backends/acpRuntime';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createMockSession, createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { reloadConfiguration } from '@/configuration';
import * as daemonControlClient from '@/daemon/controlClient';
import { runPermissionModePromptLoop } from './runPermissionModePromptLoop';
import { createPermissionModeQueueState } from './createPermissionModeQueueState';

import { runStandardAcpProvider, type StandardAcpProviderConfig, type StandardAcpProviderRunOptions } from './runStandardAcpProvider';

/**
 * Observes the Session itself rather than any single archive helper: every archive
 * path ultimately writes an `archived` lifecycle through `updateMetadata`, so this
 * catches a re-introduced archive-on-termination however it is wired.
 */
function sessionWasArchived(session: { updateMetadata: ReturnType<typeof vi.fn> }): boolean {
  return session.updateMetadata.mock.calls.some((call: readonly unknown[]) => {
    const updater = call[0];
    if (typeof updater !== 'function') return false;
    let next: unknown;
    try {
      next = (updater as (metadata: Record<string, unknown>) => unknown)({});
    } catch {
      return false;
    }
    return typeof next === 'object'
      && next !== null
      && (next as Record<string, unknown>).lifecycleState === 'archived';
  });
}

function createHarness() {
  let defaultReadyCalls = 0;
  let customReadyCalls = 0;
  let cleanupCalls = 0;
  let beforeInitializeCalls = 0;
  let onAfterStartCalls = 0;
  let onAfterResetCalls = 0;
  let permissionResetCalls = 0;
  let permissionAbortCalls = 0;
  let queueResetCalls = 0;
  let lastReadyNotificationPayload: Record<string, unknown> | null = null;
  let killHandler: (() => void | Promise<void>) | null = null;
  let permissionAbortError: Error | null = null;
  const callOrder: string[] = [];
  const permissionAbortReasons: string[] = [];

  const handlers = new Map<string, (request?: unknown) => unknown | Promise<unknown>>();

  const session: any = {
    sessionId: 'session-1',
    rpcHandlerManager: {
      registerHandler: (name: string, handler: (request: unknown) => unknown | Promise<unknown>) => {
        handlers.set(name, (request) => handler(request));
      },
    },
    sendAgentMessage: vi.fn(),
    bindProviderInputOutcomeProducer: vi.fn(() => vi.fn()),
    sendSessionEvent: vi.fn(),
    keepAlive: vi.fn(),
    getMetadataSnapshot: () => ({
      path: '/tmp/workspace',
      permissionMode: 'default',
      connectedServiceMaterializationIdentityV1: {
        v: 1,
        id: 'csm_standard_acp_test',
        createdAtMs: 1,
      },
    }),
    getLastObservedMessageSeq: vi.fn(() => 0),
    beginTurnAssistantTextSnapshot: vi.fn(() => 'turn-1'),
    getTurnAssistantTextSnapshot: vi.fn(() => null),
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
    loadTerminalDisplay: async () => () => null,
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
    resolveRunnerMcpServersFn: async () => ({
      happierMcpServer: { stop: () => undefined },
      mcpServers: {},
    }),
    createProviderEnforcedPermissionHandlerFn: () => ({
      setPermissionMode: () => undefined,
      abortPendingRequestsAndFlush: async (reason: string) => {
        permissionAbortCalls += 1;
        permissionAbortReasons.push(reason);
        callOrder.push(`permission:${reason}`);
        if (permissionAbortError) {
          throw permissionAbortError;
        }
      },
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
    sendReadyWithPushNotificationFn: (payload: Record<string, unknown>) => {
      defaultReadyCalls += 1;
      lastReadyNotificationPayload = payload;
    },
    registerKillSessionHandlerFn: (_manager: unknown, handler: () => void | Promise<void>) => {
      killHandler = handler;
    },
    cleanupBackendRunResourcesFn: async ({ keepAliveInterval, unmountUi }: any) => {
      cleanupCalls += 1;
      callOrder.push('backend-cleanup');
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
      get permissionAbortCalls() {
        return permissionAbortCalls;
      },
      get permissionAbortReasons() {
        return permissionAbortReasons;
      },
      get queueResetCalls() {
        return queueResetCalls;
      },
      get lastReadyNotificationPayload() {
        return lastReadyNotificationPayload;
      },
      get killHandler() {
        return killHandler;
      },
      get callOrder() {
        return callOrder;
      },
      setPermissionAbortError(error: Error | null) {
        permissionAbortError = error;
      },
    },
  };
}

describe('runStandardAcpProvider', () => {
  it.each(['runtime', 'startup'] as const)('respects %s ownership when reporting tmux startup fallback', async (terminalHostOwner) => {
    const harness = createHarness();
    const home = await createTempDir('happier-provider-terminal-owner-');
    const env = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    env.patch({ HAPPIER_HOME_DIR: home });
    reloadConfiguration();
    const daemonReport = vi.spyOn(daemonControlClient, 'notifyDaemonSessionStarted').mockResolvedValue({});
    harness.opts.startedBy = 'daemon';
    harness.opts.terminalRuntime = { mode: 'plain', requested: 'tmux', tmuxTarget: 'happy' };
    harness.config.terminalHostOwner = terminalHostOwner;
    // Exercise the real metadata factory, initializer, warning builder, and local persistence.
    // The API/session transport, daemon IPC, and provider loop use harness boundaries.
    harness.deps.createSessionMetadataFn = undefined;
    harness.deps.initializeBackendRunSessionFn = undefined;
    harness.session.updateAgentState = vi.fn(async () => undefined);
    harness.deps.initializeBackendApiContextFn = async () => ({
      machineId: 'machine-1',
      api: {
        getOrCreateSession: async ({ metadata }: { metadata: Metadata }) => createMockSession({ id: 'session-1', metadata }),
        sessionSyncClient: () => harness.session,
        push: () => ({ sendToAllDevices: () => undefined }),
      },
    });

    try {
      await runStandardAcpProvider(harness.opts, harness.config, harness.deps);
      const warning = expect.objectContaining({ type: 'message', message: expect.stringContaining('tmux') });
      if (terminalHostOwner === 'runtime') {
        expect(harness.session.sendSessionEvent).not.toHaveBeenCalledWith(warning);
      } else {
        expect(harness.session.sendSessionEvent).toHaveBeenCalledWith(warning);
      }
    } finally {
      daemonReport.mockRestore();
      env.restore();
      reloadConfiguration();
      await removeTempDir(home);
    }
  });

  it('preserves an ordinary manifest resume identity when no matching local return exists', async () => {
    const harness = createHarness();
    harness.opts.resume = 'qwen-native-1';
    harness.deps.createLocalAgentNativeResumeRecordStoreFn = () => ({
      readAgentNativeResumeRecord: async () => null,
      writeAgentNativeResumeRecord: async () => undefined,
    });
    const observed = { loopParams: null as Record<string, unknown> | null };
    harness.deps.runPermissionModePromptLoopFn = async (params: Record<string, unknown>) => {
      observed.loopParams = params;
    };

    await runStandardAcpProvider(harness.opts, harness.config, harness.deps);

    const projectedMetadata = harness.session.updateMetadata.mock.calls
      .map(([updater]: [(metadata: Record<string, unknown>) => Record<string, unknown>]) =>
        updater({ qwenSessionId: 'qwen-native-1', unrelated: 'kept' }),
      );
    expect(projectedMetadata).not.toContainEqual({ unrelated: 'kept' });
    expect(observed.loopParams).toMatchObject({
      initialResumeId: 'qwen-native-1',
      strictInitialResume: true,
      onStrictInitialResumeFailure: undefined,
    });
  });

  it('clears and invalidates only a matching local native return', async () => {
    const harness = createHarness();
    harness.opts.resume = 'qwen-native-1';
    const writes: Array<Record<string, unknown>> = [];
    harness.deps.createLocalAgentNativeResumeRecordStoreFn = () => ({
      readAgentNativeResumeRecord: async () => ({
        identity: { v: 1, vendorResumeId: 'qwen-native-1' },
        departureSeqInclusive: 42,
      }),
      writeAgentNativeResumeRecord: async (write: Record<string, unknown>) => {
        writes.push(write);
      },
    });
    const observed = { loopParams: null as Record<string, unknown> | null };
    harness.deps.runPermissionModePromptLoopFn = async (params: Record<string, unknown>) => {
      observed.loopParams = params;
    };

    await runStandardAcpProvider(harness.opts, harness.config, harness.deps);

    const projectedMetadata = harness.session.updateMetadata.mock.calls
      .map(([updater]: [(metadata: Record<string, unknown>) => Record<string, unknown>]) =>
        updater({ qwenSessionId: 'qwen-native-1', unrelated: 'kept' }),
      );
    expect(projectedMetadata).toContainEqual({ unrelated: 'kept' });
    const onStrictInitialResumeFailure = observed.loopParams?.onStrictInitialResumeFailure;
    expect(onStrictInitialResumeFailure).toEqual(expect.any(Function));
    await (onStrictInitialResumeFailure as () => Promise<void>)();
    expect(writes).toContainEqual({
      happierSessionId: 'session-1',
      agentId: 'qwen',
      identity: null,
      departureSeqInclusive: 42,
    });
  });

  it('does not let a generic ACP provider configure Runtime Activity participation or a producer', async () => {
    const harness = createHarness();
    let initializeOptions: Record<string, unknown> | null = null;
    let runtimeOptions: Record<string, unknown> | null = null;
    const initializeBackendRunSessionFn = harness.deps.initializeBackendRunSessionFn;
    harness.deps.initializeBackendRunSessionFn = async (options: Record<string, unknown>) => {
      initializeOptions = options;
      return initializeBackendRunSessionFn(options);
    };
    harness.config.createRuntime = (options: Record<string, unknown>) => {
      runtimeOptions = options;
      return harness.runtime;
    };

    await runStandardAcpProvider(harness.opts, harness.config, harness.deps);

    expect(initializeOptions).not.toHaveProperty('runtimeActivityPreparation');
    expect(runtimeOptions).not.toHaveProperty('runtimeActivityContributionHandle');
  });

  it('binds the managed Happier session id into every standard ACP provider environment', async () => {
    const harness = createHarness();
    let runtimeOptions: Record<string, unknown> | null = null;
    harness.config.createRuntime = (options: Record<string, unknown>) => {
      runtimeOptions = options;
      return harness.runtime;
    };

    await runStandardAcpProvider(harness.opts, harness.config, harness.deps);

    expect(runtimeOptions).toMatchObject({
      processEnv: {
        HAPPIER_SESSION_ID: 'session-1',
      },
    });
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

    const providerPromise = runStandardAcpProvider(harness.opts, harness.config, harness.deps);
    await loopStarted;

    expect(harness.session.keepAlive).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(harness.session.keepAlive).toHaveBeenCalledTimes(1);

    releaseLoop();
    await providerPromise;
    vi.useRealTimers();
  });

  it('does not double-send keepAlive when a thinking update is immediately flushed', async () => {
    const harness = createHarness();
    harness.deps.runPermissionModePromptLoopFn = async (params: any) => {
      params.setThinking(true);
      params.keepAlive();
    };

    await runStandardAcpProvider(harness.opts, harness.config, harness.deps);

    expect(harness.session.keepAlive.mock.calls).toEqual([
      [false, 'remote'],
      [true, 'remote'],
    ]);
  });

  it('uses the runtime-owned turn assistant preview for ready pushes', async () => {
    const harness = createHarness();
    harness.config.createRuntime = () => ({
      ...harness.runtime,
    });
    const originalCreateRuntime = harness.config.createRuntime;
    harness.config.createRuntime = (params) => {
      params.turnAssistantPreviewTracker.replace('Structured final response');
      return originalCreateRuntime(params);
    };

    await runStandardAcpProvider(harness.opts, harness.config, harness.deps);

    expect(harness.metrics.lastReadyNotificationPayload).toMatchObject({
      assistantPreviewText: 'Structured final response',
    });
  });

  it('falls back to the session-owned turn assistant snapshot for ready pushes', async () => {
    const harness = createHarness();
    harness.session.getTurnAssistantTextSnapshot = vi.fn(() => ({
      turnToken: 'turn-1',
      text: 'Central snapshot response',
      observedAtMs: 123,
      seq: 12,
      localId: 'message-1',
      sidechainId: null,
      provider: 'qwen',
      source: 'committed',
    }));
    harness.deps.runPermissionModePromptLoopFn = async (params: any) => {
      params.sendReady({ turnToken: 'turn-1', startSeqExclusive: 10 });
    };

    await runStandardAcpProvider(harness.opts, harness.config, harness.deps);

    expect(harness.session.getTurnAssistantTextSnapshot).toHaveBeenCalledWith({
      turnToken: 'turn-1',
      startSeqExclusive: 10,
    });
    expect(harness.metrics.lastReadyNotificationPayload).toMatchObject({
      assistantPreviewText: 'Central snapshot response',
    });
  });

  it('does not read the session snapshot when ready message text is disabled', async () => {
    const harness = createHarness();
    harness.opts.accountSettingsContext = {
      settings: {
        notificationsSettingsV1: {
          readyIncludeMessageText: false,
        },
      },
      settingsSecretsReadKeys: [],
    } as any;
    harness.session.getTurnAssistantTextSnapshot = vi.fn(() => {
      throw new Error('snapshot should not be read');
    });
    harness.deps.runPermissionModePromptLoopFn = async (params: any) => {
      params.sendReady({ turnToken: 'turn-1', startSeqExclusive: 10 });
    };

    await runStandardAcpProvider(harness.opts, harness.config, harness.deps);

    expect(harness.session.getTurnAssistantTextSnapshot).not.toHaveBeenCalled();
    expect(harness.metrics.lastReadyNotificationPayload).toMatchObject({
      assistantPreviewText: null,
      includeAssistantPreviewText: false,
    });
  });

  it('uses default ready sender and runs lifecycle hooks', async () => {
    const harness = createHarness();

    await runStandardAcpProvider(harness.opts, harness.config, harness.deps);

    expect(harness.metrics.beforeInitializeCalls).toBe(1);
    expect(harness.metrics.onAfterStartCalls).toBe(1);
    expect(harness.metrics.onAfterResetCalls).toBe(1);
    expect(harness.metrics.defaultReadyCalls).toBe(1);
    expect(harness.metrics.cleanupCalls).toBe(1);
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

    await runStandardAcpProvider(harness.opts, harness.config, harness.deps);

    expect(capturedStartRuntimeBeforeFirstPrompt).toBe(true);
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

    await runStandardAcpProvider(harness.opts, harness.config, harness.deps);

    expect(receivedInitialResumeId).toBe('resume-id');
    expect(receivedStrictInitialResume).toBe(true);
  });

  it('passes resolved MCP servers to the provider runtime', async () => {
    const harness = createHarness();
    harness.config.flavor = 'claude';

    let capturedMcpServers: any = null;
    const createRuntimeOriginal = harness.config.createRuntime;
    harness.config.createRuntime = (params: any) => {
      capturedMcpServers = params.mcpServers;
      return createRuntimeOriginal(params);
    };

    harness.deps.resolveRunnerMcpServersFn = async () => ({
      happierMcpServer: { stop: () => undefined },
      mcpServers: { happier: { command: 'built-in' }, extra: { command: 'extra' } },
    });

    await runStandardAcpProvider(harness.opts, harness.config, harness.deps);

    expect(capturedMcpServers).toEqual({ happier: { command: 'built-in' }, extra: { command: 'extra' } });
  });

  it('uses attached session metadata for runtime metadata, runtime directory, and MCP directory resolution', async () => {
    const harness = createHarness();
    harness.config.flavor = 'claude';
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
    harness.config.createRuntime = (params: any) => {
      capturedRuntimeParams = params;
      return harness.runtime;
    };

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

    await runStandardAcpProvider(harness.opts, harness.config, harness.deps);

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

  it('skips native MCP resolution for shell-bridge providers', async () => {
    const harness = createHarness();
    harness.config.flavor = 'pi';

    let capturedMcpServers: any = null;
    harness.config.createRuntime = (params: any) => {
      capturedMcpServers = params.mcpServers;
      return {
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
      } as any;
    };

    const resolveRunnerMcpServersFn = vi.fn(async () => ({
      happierMcpServer: { stop: () => undefined },
      mcpServers: { happier: { command: 'built-in' } },
    }));

    await runStandardAcpProvider(harness.opts, harness.config, {
      ...harness.deps,
      resolveRunnerMcpServersFn,
    });

    expect(resolveRunnerMcpServersFn).not.toHaveBeenCalled();
    expect(capturedMcpServers).toEqual({});
  });

  it('uses the Happier session id, not the vendor runtime session id, for shell-bridge prompt instructions', async () => {
    const harness = createHarness();
    harness.config.flavor = 'pi';

    harness.runtime.getSessionId = vi.fn(() => 'vendor-session-123');

    let resolvedPrompt = '';
    harness.deps.runPermissionModePromptLoopFn = async (params: Readonly<{
      resolveFreshSessionSystemPrompt?: (args: { baseOverride?: string | null }) => Promise<string>;
    }>) => {
      resolvedPrompt = await params.resolveFreshSessionSystemPrompt?.({ baseOverride: 'BASE' }) ?? '';
    };

    await runStandardAcpProvider(harness.opts, harness.config, harness.deps);

    expect(resolvedPrompt).toContain("'--session-id' 'session-1'");
    expect(resolvedPrompt).not.toContain('vendor-session-123');
  });

  it('does not duplicate a spawn-delivered system prompt on the first message', async () => {
    const harness = createHarness();
    harness.config.deliversSystemPromptAtSpawn = true;
    let firstMessagePrompt = '';
    harness.deps.runPermissionModePromptLoopFn = async (params: any) => {
      await params.runtime.startOrLoad({});
      firstMessagePrompt = await params.resolveFreshSessionSystemPrompt({ baseOverride: 'EXPLICIT BASE' });
    };

    await runStandardAcpProvider(harness.opts, harness.config, harness.deps);

    expect(firstMessagePrompt).toBe('EXPLICIT BASE');
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

    expect(runtime.steerPrompt).toHaveBeenCalledWith('hello', {
      onProviderPromptAccepted: expect.any(Function),
    });
  });

  it('in-flight action controller cancels the active runtime with the correct receiver', async () => {
    const harness = createHarness();
    const runtime = {
      ...harness.runtime,
      cancel: vi.fn(async function (this: unknown) {
        if (this !== runtime) {
          throw new Error('cancel called with wrong receiver');
        }
      }),
    };
    harness.config.createRuntime = () => runtime as any;

    let inFlightSteer: any = null;
    harness.deps.createPermissionModeQueueStateFn = (params: any) => {
      inFlightSteer = params.inFlightSteer;
      return {
        messageQueue: { reset: () => undefined, size: () => 0 },
        getCurrentPermissionMode: () => 'default',
        setCurrentPermissionMode: () => undefined,
        getCurrentPermissionModeUpdatedAt: () => 0,
        setCurrentPermissionModeUpdatedAt: () => undefined,
      };
    };
    harness.deps.runPermissionModePromptLoopFn = async (params: any) => {
      await inFlightSteer.cancelActiveTurn();
      params.sendReady();
    };

    await runStandardAcpProvider(harness.opts, harness.config, harness.deps);

    expect(runtime.cancel).toHaveBeenCalledTimes(1);
  });

  it('resolves pending foreground steerability from the current runtime turn and steer capability', async () => {
    const harness = createHarness();
    harness.opts.accountSettingsContext = {
      settings: { sessionBusySteerSendPolicy: 'server_pending' },
    } as any;
    let turnInFlight = true;
    let steerSupported = false;
    const runtime = {
      ...harness.runtime,
      isTurnInFlight: vi.fn(() => turnInFlight),
      supportsInFlightSteer: vi.fn(() => steerSupported),
      steerPrompt: vi.fn(async () => undefined),
    };
    harness.config.createRuntime = () => runtime as any;

    let consumerOptions: any = null;
    harness.deps.createSessionProviderInputConsumerFn = (options: any) => {
      consumerOptions = options;
      return {
        drainPending: vi.fn(async () => ({ type: 'empty' })),
        closeProviderInputAdmissionAndWaitForDispatches: vi.fn(async () => undefined),
      };
    };
    harness.deps.runPermissionModePromptLoopFn = async (params: any) => {
      expect(consumerOptions.resolveActiveTurnSteerability()).toBe('unsteerable');
      steerSupported = true;
      expect(consumerOptions.resolveActiveTurnSteerability()).toBe('steerable');
      turnInFlight = false;
      steerSupported = false;
      expect(consumerOptions.resolveActiveTurnSteerability()).toBe('steerable');
      params.sendReady();
    };

    await runStandardAcpProvider(harness.opts, harness.config, harness.deps);
  });

  it('in-flight steer controller forwards delivery identity to runtime steerPrompt', async () => {
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
      steerPrompt: vi.fn(async () => undefined),
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
      await inFlightSteer.steerText('hello', {
        localId: 'local-1',
        localIds: ['local-1'],
        userMessageSeq: 1,
        userMessageSeqs: [1],
      });
      params.sendReady();
    };

    await runStandardAcpProvider(harness.opts, harness.config, harness.deps);

    expect(runtime.steerPrompt).toHaveBeenCalledWith('hello', {
      localId: 'local-1',
      localIds: ['local-1'],
      onProviderPromptAccepted: expect.any(Function),
      userMessageSeq: 1,
      userMessageSeqs: [1],
    });
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

  it('binds one exact ACP provider-outcome producer without a selectable custody policy', async () => {
    const harness = createHarness();

    await runStandardAcpProvider(harness.opts, harness.config, harness.deps);

    expect(harness.session.bindProviderInputOutcomeProducer).toHaveBeenCalledTimes(1);
    expect(harness.session.bindProviderInputOutcomeProducer).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'qwen',
      mode: 'acp',
      matchesCurrentSession: expect.any(Function),
    }));
  });

  it('uses provider-controlled keep-alive mode when configured', async () => {
    const harness = createHarness();
    const keepAliveModes: string[] = [];
    harness.session.keepAlive = vi.fn((_thinking: boolean, mode: string) => {
      keepAliveModes.push(mode);
    });
    (harness.config as any).resolveKeepAliveMode = () => 'local';

    await runStandardAcpProvider(harness.opts, harness.config, harness.deps);

    expect(keepAliveModes[0]).toBe('local');
  });

  it.each([
    ['loading', { loadFails: true, renderFails: false }],
    ['rendering', { loadFails: false, renderFails: true }],
  ])('keeps the session running when %s the terminal display fails', async (_phase, failure) => {
    const harness = createHarness();
    harness.config.loadTerminalDisplay = async () => {
      if (failure.loadFails) throw new Error('display chunk missing');
      return () => null;
    };
    const renderFn = vi.fn(() => {
      if (failure.renderFails) throw new Error('render failed');
      return { unmount: vi.fn() };
    });
    let readySent = false;
    harness.deps.runPermissionModePromptLoopFn = async (params: any) => {
      await vi.dynamicImportSettled();
      if (failure.renderFails) {
        await vi.waitFor(() => expect(renderFn).toHaveBeenCalledTimes(1));
      }
      params.sendReady();
      readySent = true;
    };

    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });

    try {
      await runStandardAcpProvider(harness.opts, harness.config, { ...harness.deps, renderFn });
    } finally {
      if (stdoutDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
      if (stdinDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }

    expect(readySent).toBe(true);
  });

  it('does not load the terminal display without an attached TTY', async () => {
    const harness = createHarness();
    const loadTerminalDisplay = vi.fn(async () => () => null);
    harness.config.loadTerminalDisplay = loadTerminalDisplay;

    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });

    try {
      await runStandardAcpProvider(harness.opts, harness.config, harness.deps);
    } finally {
      if (stdoutDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
      if (stdinDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }

    expect(loadTerminalDisplay).not.toHaveBeenCalled();
  });

  it('skips loading and rendering the terminal UI when the provider disables it', async () => {
    const harness = createHarness();
    const renderFn = vi.fn(() => ({ unmount: vi.fn() }));
    const loadTerminalDisplay = vi.fn(async () => () => null);
    harness.config.loadTerminalDisplay = loadTerminalDisplay;
    (harness.config as any).shouldRenderTerminalDisplay = () => false;

    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });

    try {
      await runStandardAcpProvider(harness.opts, harness.config, {
        ...harness.deps,
        renderFn,
      });
    } finally {
      if (stdoutDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
      if (stdinDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
    }

    expect(renderFn).not.toHaveBeenCalled();
    expect(loadTerminalDisplay).not.toHaveBeenCalled();
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
      const terminalDisplay = controller;
      if (!terminalDisplay) throw new Error('Expected terminal display controller');
      expect(terminalDisplay.isMounted()).toBe(false);
      // The first mount loads the terminal UI; later mounts render synchronously.
      terminalDisplay.mount();
      await vi.waitFor(() => expect(terminalDisplay.isMounted()).toBe(true));
      await terminalDisplay.unmount();
      expect(terminalDisplay.isMounted()).toBe(false);
      terminalDisplay.mount();
      expect(terminalDisplay.isMounted()).toBe(true);
      params.sendReady();
    };

    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });

    try {
      await runStandardAcpProvider(harness.opts, harness.config, {
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
    const rebindSession = vi.fn();
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

    await runStandardAcpProvider(harness.opts, harness.config, harness.deps);

    expect(onSessionSwap).toHaveBeenCalledTimes(1);
    expect(rebindSession).toHaveBeenCalledTimes(1);
    expect(swappedHookParams).toMatchObject({
      session: expect.objectContaining({ sessionId: 'session-2' }),
    });
    expect(callOrder).toEqual(['before-notify', 'hook:start', 'hook:end', 'after-notify']);
  });

  it('runs provider-specific dispose hooks during cleanup', async () => {
    const harness = createHarness();
    const onDispose = vi.fn(async () => undefined);
    harness.config.onDispose = onDispose as any;

    await runStandardAcpProvider(harness.opts, harness.config, harness.deps);

    expect(onDispose).toHaveBeenCalledTimes(1);
  });

  it('cancels pending permissions before backend resource cleanup on natural completion', async () => {
    const harness = createHarness();

    await runStandardAcpProvider(harness.opts, harness.config, harness.deps);

    expect(harness.metrics.permissionAbortReasons).toEqual(['Session ended']);
    expect(harness.metrics.callOrder).toEqual(['permission:Session ended', 'backend-cleanup']);
  });

  it('closes the API session during cleanup so unresolved provider claims can be blocked', async () => {
    const harness = createHarness();

    await runStandardAcpProvider(harness.opts, harness.config, harness.deps);

    expect(harness.session.close).toHaveBeenCalledTimes(1);
  });

  it('stops the ACP provider and aborts its controller when cancellation journal admission fails', async () => {
    const harness = createHarness();
    let state: AgentState = { requests: {}, completedRequests: {} };
    Object.assign(harness.session, {
      getAgentStateSnapshot: () => state,
      updateAgentState: async (updater: (current: AgentState) => AgentState) => { state = updater(state); },
      updateAgentStateRequestSettlement: async () => { throw Object.assign(new Error('journal disk full'), { code: 'ENOSPC' }); },
    });
    const handler = createProviderEnforcedPermissionHandler({ session: harness.session, logPrefix: '[AcpStopTest]' });
    harness.deps.createProviderEnforcedPermissionHandlerFn = () => handler;
    let stoppedSignal: AbortSignal | undefined;
    harness.deps.runPermissionModePromptLoopFn = async (params: { getAbortSignal: () => AbortSignal }) => {
      stoppedSignal = params.getAbortSignal();
      const pending = handler.handleToolCall('acp-stop', 'Bash', { command: ['echo pending'] });
      const rejected = expect(pending).rejects.toThrow('Aborted by user');
      await harness.handlers.get('abort')?.();
      await rejected;
    };
    await runStandardAcpProvider(harness.opts, harness.config, harness.deps);
    expect(stoppedSignal?.aborted).toBe(true);
    expect(harness.runtime.cancel).toHaveBeenCalledTimes(1);
    expect(state.requests?.['acp-stop']).toBeDefined();
    expect(state.completedRequests?.['acp-stop']).toBeUndefined();
  });

  it('invokes abort handler lifecycle when abort RPC fires', async () => {
    const harness = createHarness();
    harness.deps.runPermissionModePromptLoopFn = async () => {
      const abort = harness.handlers.get('abort');
      expect(abort).toBeTypeOf('function');
      await abort?.();
    };

    await runStandardAcpProvider(harness.opts, harness.config, harness.deps);

    expect(harness.metrics.queueResetCalls).toBe(0);
    expect(harness.metrics.permissionAbortReasons).toEqual(['Aborted by user', 'Session ended']);
    expect(harness.metrics.permissionResetCalls).toBe(0);
    expect(sessionWasArchived(harness.session)).toBe(false);
  });

  it('keeps final cleanup idempotent after abort cancels pending permissions', async () => {
    const harness = createHarness();
    harness.deps.runPermissionModePromptLoopFn = async () => {
      const abort = harness.handlers.get('abort');
      expect(abort).toBeTypeOf('function');
      await abort?.();
    };

    await runStandardAcpProvider(harness.opts, harness.config, harness.deps);

    expect(harness.metrics.permissionAbortReasons).toEqual(['Aborted by user', 'Session ended']);
    expect(harness.metrics.cleanupCalls).toBe(1);
    expect(harness.metrics.callOrder).toEqual([
      'permission:Aborted by user',
      'permission:Session ended',
      'backend-cleanup',
    ]);
  });

  it('continues backend resource cleanup when permission cleanup fails', async () => {
    const harness = createHarness();
    const onDispose = vi.fn(async () => undefined);
    harness.config.onDispose = onDispose as any;
    harness.metrics.setPermissionAbortError(new Error('permission cleanup failed'));

    await expect(runStandardAcpProvider(harness.opts, harness.config, harness.deps)).resolves.toBeUndefined();

    expect(harness.metrics.permissionAbortReasons).toEqual(['Session ended']);
    expect(harness.metrics.cleanupCalls).toBe(1);
    expect(onDispose).toHaveBeenCalledTimes(1);
    expect(harness.metrics.callOrder).toEqual(['permission:Session ended', 'backend-cleanup']);
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
      await runStandardAcpProvider(harness.opts, harness.config, harness.deps);
    } finally {
      exitSpy.mockRestore();
    }

    expect(sessionWasArchived(harness.session)).toBe(false);
    expect(harness.metrics.cleanupCalls).toBe(1);
  });

  // Archiving is a user-intent action, never a lifecycle consequence. A terminal-started
  // Session whose runtime terminates must stay unarchived so it remains listed and
  // resumable, exactly like a daemon-started one.
  it('leaves a terminal-started session unarchived and closed when its runtime terminates', async () => {
    const harness = createHarness();
    harness.opts.startedBy = 'terminal';
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

    expect(sessionWasArchived(harness.session)).toBe(false);
    expect(harness.session.close).toHaveBeenCalled();
    expect(harness.metrics.cleanupCalls).toBe(1);
  });

  it.each(['completed', 'failed', 'flush-failed'] as const)(
    'resumes queued input immediately after %s Stop cancellation without polling',
    async (cancelOutcome) => {
      // Only the provider transport and Session API are faked; the runtime, permissions,
      // input consumer, queue and prompt loop execute their real production paths.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const harness = createHarness();
      const session = createMutableApiSessionClientFixture({
        metadata: createTestMetadata({ path: '/tmp/workspace', permissionMode: 'default' }),
        overrides: {
          ...harness.session,
          onUserMessage: () => undefined,
          flush: async () => {
            if (cancelOutcome === 'flush-failed') throw new Error('Session transport flush failed');
          },
          shouldAttemptPendingMaterialization: () => false,
          waitForMetadataUpdate: (signal) => new Promise<boolean>((resolve) => {
            if (signal?.aborted) resolve(false);
            else signal?.addEventListener('abort', () => resolve(false), { once: true });
          }),
          waitForPendingEligibilityUpdate: (signal) => new Promise<boolean>((resolve) => {
            if (signal?.aborted) resolve(false);
            else signal?.addEventListener('abort', () => resolve(false), { once: true });
          }),
        },
      });
      harness.deps.initializeBackendRunSessionFn = async () => ({
        session, reconnectionHandle: null, reportedSessionId: session.sessionId, attachedToExistingSession: false,
      });
      delete harness.deps.createProviderEnforcedPermissionHandlerFn;
      let queueState: ReturnType<typeof createPermissionModeQueueState>;
      harness.deps.createPermissionModeQueueStateFn = (params: Parameters<typeof createPermissionModeQueueState>[0]) => {
        queueState = createPermissionModeQueueState(params);
        queueState.messageQueue.push({ text: 'first prompt', localId: 'local-first' }, { permissionMode: 'default' });
        return queueState;
      };
      let completeResponse!: () => void;
      const response = new Promise<void>((resolve) => { completeResponse = resolve; });
      let releaseCancel!: () => void;
      const cancellation = new Promise<void>((resolve) => { releaseCancel = resolve; });
      let notifyCancelStarted!: () => void;
      const cancelStarted = new Promise<void>((resolve) => { notifyCancelStarted = resolve; });
      let notifyFirstSent!: () => void;
      const firstSent = new Promise<void>((resolve) => { notifyFirstSent = resolve; });
      let completed = false;
      const sent: string[] = [];
      const backend = createFakeAcpRuntimeBackend({
        sendPrompt: async (_sessionId, prompt) => { sent.push(prompt); notifyFirstSent(); },
        waitForResponseComplete: async () => { if (sent.length === 1) await response; },
        cancel: async () => {
          notifyCancelStarted();
          // ACP cancellation can release the turn before the transport cancellation settles.
          completeResponse();
          await cancellation;
          if (cancelOutcome === 'failed') throw new Error('Provider cancel failed');
        },
      });
      harness.config.deliversSystemPromptAtSpawn = true;
      harness.config.createRuntime = (params: Parameters<StandardAcpProviderConfig['createRuntime']>[0]) =>
        createTestAcpRuntime({
          provider: 'qwen', directory: params.directory, session: params.session,
          messageBuffer: params.messageBuffer, mcpServers: {}, permissionHandler: params.permissionHandler,
          onThinkingChange: params.setThinking, ensureBackend: async () => backend,
        });
      harness.deps.runPermissionModePromptLoopFn = (params: Parameters<typeof runPermissionModePromptLoop>[0]) =>
        runPermissionModePromptLoop({
          ...params,
          shouldExit: () => completed || params.shouldExit(),
          sendReady: () => { if (sent.length === 2) completed = true; },
        });
      const tick = async () => { await new Promise<void>((resolve) => setImmediate(resolve)); };
      const run = runStandardAcpProvider(harness.opts, harness.config, harness.deps);
      let abort: Promise<unknown> | undefined;
      try {
        await Promise.race([firstSent, run.then(() => { throw new Error('Runner exited before first prompt'); })]);
        expect(sent).toEqual(['first prompt']);
        abort = Promise.resolve(harness.handlers.get('abort')?.());
        await cancelStarted;
        const repeatedAbort = Promise.resolve(harness.handlers.get('abort')?.());
        queueState!.messageQueue.push({ text: 'after Stop', localId: 'local-after-stop' }, { permissionMode: 'default' });
        for (let i = 0; i < 10; i++) await tick();
        expect(sent).toEqual(['first prompt']);
        expect(queueState!.messageQueue.size()).toBe(1);
        releaseCancel();
        await Promise.all([abort, repeatedAbort]);
        // No timeout is advanced: recovery must follow cancellation completion itself.
        for (let i = 0; i < 100 && !completed; i++) await tick();
        expect(sent).toEqual(['first prompt', 'after Stop']);
        expect(completed).toBe(true);
        await run;
      } finally {
        completed = true;
        releaseCancel();
        completeResponse();
        await abort;
        await vi.runAllTimersAsync();
        await run;
        vi.useRealTimers();
      }
    },
  );

  it('awaits explicit Stop cancellation before API close and backend disposal', async () => {
    const harness = createHarness();
    harness.opts.startedBy = 'daemon';
    const order = harness.metrics.callOrder;
    let releaseCancelReceipt!: () => void;
    const cancelReceipt = new Promise<void>((resolve) => {
      releaseCancelReceipt = resolve;
    });
    let cancelStarted = false;
    let backendDisposed = false;
    harness.runtime.cancel = vi.fn(async () => {
      cancelStarted = true;
      order.push('cancel:start');
      await cancelReceipt;
      if (backendDisposed) {
        throw new Error('Pi backend disposed');
      }
      order.push('cancel:receipt');
    });
    harness.runtime.reset = vi.fn(async () => {
      backendDisposed = true;
      order.push('backend:dispose');
    });
    harness.session.close = vi.fn(async () => {
      order.push('api:close');
    });
    harness.deps.cleanupBackendRunResourcesFn = async ({ keepAliveInterval, resetRuntime, unmountUi }: any) => {
      clearInterval(keepAliveInterval);
      await resetRuntime();
      await unmountUi?.();
      order.push('backend-cleanup');
    };

    let killRequest: Promise<void> | null = null;
    harness.deps.runPermissionModePromptLoopFn = async () => {
      expect(harness.metrics.killHandler).toBeTypeOf('function');
      killRequest = Promise.resolve(harness.metrics.killHandler?.());
      await vi.waitFor(() => expect(cancelStarted).toBe(true));
      // Model the in-flight provider loop unwinding as soon as explicit Stop is observed.
      // Final cleanup must join the typed cancellation receipt instead of disposing underneath it.
    };

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const run = runStandardAcpProvider(harness.opts, harness.config, harness.deps);
    try {
      await vi.waitFor(() => expect(cancelStarted).toBe(true));
      const cleanupBeforeCancelReceipt = await Promise.race([
        vi.waitFor(() => {
          expect(
            harness.session.close.mock.calls.length + harness.runtime.reset.mock.calls.length,
          ).toBeGreaterThan(0);
        }).then(() => 'cleanup-started'),
        new Promise<'cancel-still-exclusive'>((resolve) => {
          setTimeout(() => resolve('cancel-still-exclusive'), 100);
        }),
      ]);
      expect(cleanupBeforeCancelReceipt).toBe('cancel-still-exclusive');

      releaseCancelReceipt();
      await run;
      await killRequest;

      expect(order.indexOf('cancel:receipt')).toBeGreaterThan(order.indexOf('cancel:start'));
      expect(order.indexOf('api:close')).toBeGreaterThan(order.indexOf('cancel:receipt'));
      expect(order.indexOf('backend:dispose')).toBeGreaterThan(order.indexOf('cancel:receipt'));
      expect(harness.session.sendAgentMessage).not.toHaveBeenCalledWith(
        harness.config.agentMessageType,
        expect.objectContaining({ type: 'turn_failed' }),
      );
    } finally {
      releaseCancelReceipt();
      await run.catch(() => undefined);
      await Promise.resolve(killRequest).catch(() => undefined);
      exitSpy.mockRestore();
    }
  });

  it('awaits cleanup already started by the provider loop before terminating the runner', async () => {
    const harness = createHarness();
    harness.opts.startedBy = 'daemon';

    let releaseSessionEndedCleanup!: () => void;
    const sessionEndedCleanupGate = new Promise<void>((resolve) => {
      releaseSessionEndedCleanup = resolve;
    });
    let sessionEndedCleanupStarted = false;
    harness.deps.createProviderEnforcedPermissionHandlerFn = () => ({
      setPermissionMode: () => undefined,
      abortPendingRequestsAndFlush: async (reason: string) => {
        if (reason !== 'Session ended') return;
        sessionEndedCleanupStarted = true;
        await sessionEndedCleanupGate;
      },
      reset: () => undefined,
      updateSession: () => undefined,
    });

    let killRequest: Promise<void> | null = null;
    harness.deps.runPermissionModePromptLoopFn = async () => {
      expect(harness.metrics.killHandler).toBeTypeOf('function');
      killRequest = Promise.resolve(harness.metrics.killHandler?.());
      // Model the provider subprocess exiting at the same time as termination begins: the
      // provider loop unwinds and starts final cleanup before the termination callback joins it.
    };

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const run = runStandardAcpProvider(harness.opts, harness.config, harness.deps);
    try {
      await vi.waitFor(() => expect(sessionEndedCleanupStarted).toBe(true));
      await Promise.resolve();

      expect(exitSpy).not.toHaveBeenCalled();
      expect(harness.session.close).not.toHaveBeenCalled();

      releaseSessionEndedCleanup();
      await run;
      await killRequest;

      expect(harness.session.close).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(harness.session.close.mock.invocationCallOrder[0]).toBeLessThan(
        exitSpy.mock.invocationCallOrder[0]!,
      );
    } finally {
      releaseSessionEndedCleanup();
      await run.catch(() => undefined);
      exitSpy.mockRestore();
    }
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

  it('composes the standard-provider prompt loop around one input consumer', async () => {
    const harness = createHarness();
    harness.deps.runPermissionModePromptLoopFn = async (params: any) => {
      expect(params.inputConsumer).toEqual(expect.objectContaining({
        waitForNextInput: expect.any(Function),
        drainPending: expect.any(Function),
      }));
    };

    await runStandardAcpProvider(harness.opts, harness.config, harness.deps);
  });

  it('maps configured ACP flavors onto generic ACP permission semantics', async () => {
    const harness = createHarness();
    const createSessionMetadataFn = vi.fn(() => ({
      state: { controlledByUser: false },
      metadata: { path: '/tmp/workspace', permissionMode: 'default', permissionModeUpdatedAt: Date.now() },
    }));

    harness.config.flavor = 'acp:custom-kiro';
    harness.opts.accountSettingsContext = {
      source: 'network',
      settings: {
        sessionDefaultPermissionModeByTargetKey: {
          [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'customAcp' })]: 'yolo',
        },
      } as any,
      settingsVersion: 1,
      loadedAtMs: Date.now(),
      settingsSecretsReadKeys: [],
      whenRefreshed: null,
    };
    harness.deps.createSessionMetadataFn = createSessionMetadataFn;

    await runStandardAcpProvider(harness.opts, harness.config, harness.deps);

    expect(createSessionMetadataFn).toHaveBeenCalledWith(expect.objectContaining({
      flavor: 'acp:custom-kiro',
      permissionMode: 'yolo',
    }));
  });

  it('treats unknown ACP flavors as custom ACP policy family instead of falling back to the default built-in agent', async () => {
    const harness = createHarness();
    const createSessionMetadataFn = vi.fn(() => ({
      state: { controlledByUser: false },
      metadata: { path: '/tmp/workspace', permissionMode: 'default', permissionModeUpdatedAt: Date.now() },
    }));

    harness.config.flavor = 'custom-kiro';
    harness.opts.accountSettingsContext = {
      source: 'network',
      settings: {
        sessionDefaultPermissionModeByTargetKey: {
          [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'claude' })]: 'read-only',
          [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'customAcp' })]: 'yolo',
        },
      } as any,
      settingsVersion: 1,
      loadedAtMs: Date.now(),
      settingsSecretsReadKeys: [],
      whenRefreshed: null,
    };
    harness.deps.createSessionMetadataFn = createSessionMetadataFn;

    await runStandardAcpProvider(harness.opts, harness.config, harness.deps);

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

    await runStandardAcpProvider(harness.opts, harness.config, harness.deps);

    expect(createProviderEnforcedPermissionHandlerFn).toHaveBeenCalledWith(
      expect.objectContaining({
        getAccountSettingsSecretsReadKeys: expect.any(Function),
      }),
    );
    expect(observedGetAccountSettingsSecretsReadKeys?.()).toEqual(settingsSecretsReadKeys);
  });

  /**
   * The prompt loop's new-session fallback is the only path that can turn an explicit vendor
   * resume into a fresh vendor session. This runner is its single policy owner: the declared
   * `session/load` support decides, so no provider leaf can forget to opt in.
   */
  it('fails closed on explicit resume for a backend that declares vendor session load support', async () => {
    const harness = createHarness();
    harness.config.declaredSessionLoadSupport = true;
    let observedFailClosed: unknown;
    harness.deps.runPermissionModePromptLoopFn = async (params: any) => {
      observedFailClosed = params.failClosedOnResumeFailure;
    };

    await runStandardAcpProvider(harness.opts, harness.config, harness.deps);

    expect(observedFailClosed).toBe(true);
  });

  it('keeps the new-session fallback for a backend that never claims vendor session load support', async () => {
    const harness = createHarness();
    let observedFailClosed: unknown;
    harness.deps.runPermissionModePromptLoopFn = async (params: any) => {
      observedFailClosed = params.failClosedOnResumeFailure;
    };

    await runStandardAcpProvider(harness.opts, harness.config, harness.deps);

    expect(harness.config.declaredSessionLoadSupport).toBeUndefined();
    expect(observedFailClosed).toBe(false);
  });
});
