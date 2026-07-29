import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  buildBackendTargetKey,
  ProviderConnectionIdSchema,
  redactBugReportSensitiveText,
  type PluginVoiceProviderContributionV1,
} from '@happier-dev/protocol';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import type {
  AgentSessionRealtimeConversation,
  AgentSessionRealtimeHandle,
  AgentSessionRealtimeLifecycleEvent,
  PluginVoiceAgentSessionRealtimeService,
} from '@happier-dev/plugin-sdk/experimental/agent-runtime/realtime';

const { loggerDebugMock } = vi.hoisted(() => ({
  loggerDebugMock: vi.fn(),
}));

vi.mock('@/ui/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/ui/logger')>();
  return {
    ...actual,
    logger: new Proxy(actual.logger, {
      get(target, property, receiver) {
        if (property === 'debug') return loggerDebugMock;
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
  };
});

import { runHostSessionRuntime, type HostSessionRuntimeConfig, type HostSessionRuntimeRunOptions } from './runHostSessionRuntime';
import type { HostSessionTerminalRemoteModeLoop } from './terminalRemoteModeRuntime';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { resolveForkInheritedOverridesFromMetadata } from '@/session/fork/resolveForkInheritedOverridesFromMetadata';
import {
  HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY,
  serializeProviderBindingLaunchHandoffForEnv,
} from '@/plugins/runtime/providerBindings/handoff';
import {
  HAPPIER_PERSISTED_TAKEOVER_ADMISSION_ENV_KEY,
  serializePersistedTakeoverAdmissionForEnv,
} from '@/daemon/spawn/persistedTakeoverAdmission';
import { setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { getResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { Metadata, PermissionMode } from '@/api/types';
import { resolveAgentSessionRealtimeVoiceAuthority } from '@/agent/runtime/session/realtime/resolveAgentSessionRealtimeVoiceAuthority';
import { ApiSessionClient } from '@/api/session/sessionClient';
import { resolveSessionClientDurableMutationOutboxPath } from '@/api/session/client/transport/mutations/sessionClientDurableMutationPersistence';
import { resetSessionClientDurableMutationOutboxStateForTests } from '@/api/session/client/transport/mutations/createSessionClientDurableMutationOutbox';
import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createAcpRuntime } from '@/agent/acp/runtime/createAcpRuntime';
import type { AgentMessage } from '@/agent/core/AgentMessage';

vi.mock('@/api/session/client/transport/initializeSessionClientConnection', () => ({
  initializeSessionClientConnection: (params: {
    setSessionSocket(socket: unknown): void;
    onStateChange(state: {
      phase: 'online';
      reason: null;
      attempt: number;
      nextRetryAt: null;
      lastConnectedAt: number;
      lastDisconnectedAt: null;
      lastErrorMessage: null;
    }): void;
    markConnected(): Readonly<{ reason: 'connect' | 'reconnect'; epoch: number }> | 'connect' | 'reconnect';
    setSessionSyncPendingInputServerContractResult?(result: Readonly<{
      mode: 'released_server_v0_2_1';
      sessionConnectionEpoch: number;
      socket: unknown;
    }>): Promise<void> | void;
  }) => {
    const userSocket = {
      connected: false,
      on: () => userSocket,
      off: () => userSocket,
      emit: () => undefined,
      disconnect: () => undefined,
      close: () => undefined,
      volatile: {
        emit: () => undefined,
      },
    };
    const sessionSocket = {
      connected: true,
      on: () => sessionSocket,
      off: () => sessionSocket,
      emit: () => undefined,
      timeout: () => sessionSocket,
      emitWithAck: async (event: string, payload: unknown) => {
        if (event === 'update-metadata') {
          const request = payload as {
            expectedVersion: number;
            metadata: string;
          };
          return {
            result: 'success',
            version: request.expectedVersion + 1,
            metadata: request.metadata,
          };
        }
        return { ok: false };
      },
    };
    params.setSessionSocket(sessionSocket);
    const state = {
      phase: 'online' as const,
      reason: null,
      attempt: 0,
      nextRetryAt: null,
      lastConnectedAt: Date.now(),
      lastDisconnectedAt: null,
      lastErrorMessage: null,
    };
    return {
      userSocket,
      sessionConnectionSupervisor: {
        start: async () => {
          params.onStateChange(state);
          const markedConnected = params.markConnected();
          await params.setSessionSyncPendingInputServerContractResult?.({
            mode: 'released_server_v0_2_1',
            sessionConnectionEpoch:
              typeof markedConnected === 'string' ? 0 : markedConnected.epoch,
            socket: sessionSocket,
          });
        },
        stop: async () => undefined,
        getState: () => state,
        captureProbeReportScope: () => null,
        reportProbeResult: () => undefined,
      },
    };
  },
}));

const providerModelDescriptor = Object.freeze({
  id: 'provider-model',
  name: 'Provider Model',
});

type CreateAgentSessionRealtimeService = (input: Readonly<{
  provider: Readonly<{ pluginId: string; localId: string }>;
  conversationSessionId: string;
  applicationAttemptId: string;
  signal: AbortSignal;
  sessionRpc(input: Readonly<{
    sessionId: string;
    method: string;
    payload: unknown;
    signal: AbortSignal;
  }>): Promise<unknown>;
  onTerminal(event: AgentSessionRealtimeLifecycleEvent): void;
}>) => PluginVoiceAgentSessionRealtimeService;

async function loadAgentSessionRealtimeService(): Promise<CreateAgentSessionRealtimeService> {
  // This is an explicit cross-package composition seam; keep the CLI compiler
  // from adopting UI source outside its rootDir while Vitest loads the real module.
  const modulePath: string =
    '../../../../../../ui/sources/voice/runtime/agentRealtime/createAgentSessionRealtimeService';
  const loaded: unknown = await import(modulePath);
  if (
    typeof loaded !== 'object'
    || loaded === null
    || !('createAgentSessionRealtimeService' in loaded)
    || typeof loaded.createAgentSessionRealtimeService !== 'function'
  ) {
    throw new Error('expected the real UI Agent-realtime service factory');
  }
  return loaded.createAgentSessionRealtimeService as CreateAgentSessionRealtimeService;
}

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
    on: vi.fn(),
    off: vi.fn(),
    refreshSessionSnapshotFromServerRequired: vi.fn(async () => undefined),
    enqueueSessionTurnMutation: vi.fn(async () => undefined),
    enqueueRegisteredSessionStateFieldMutation: vi.fn(async () => undefined),
    subscribeExecutionRunActivitySnapshots: vi.fn(() => () => undefined),
    wakePendingMaterialization: vi.fn(),
    claimCurrentSessionPublisherAuthorityForStartup: vi.fn(
      async () => ({ status: 'claimed' as const }),
    ),
    activateDurableMutationDelivery: vi.fn(async () => undefined),
    deactivateDurableMutationDelivery: vi.fn(),
    stageInitialDurableMutationSnapshots: vi.fn(async () => undefined),
    flushDurableMutationDelivery: vi.fn(async () => undefined),
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
    runtimeActivityApplicability: 'not_applicable',
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

function setAgentSessionRealtimeVoiceAuthority(
  config: HostSessionRuntimeConfig,
  authority: NonNullable<
    HostSessionRuntimeConfig['agentSessionRealtimeVoiceAuthority']
  >,
): void {
  config.agentSessionRealtimeVoiceAuthority = authority;
}

function setTerminalRemoteModeLoop(
  config: HostSessionRuntimeConfig,
  terminalRemoteModeLoop: HostSessionTerminalRemoteModeLoop,
): void {
  const createSessionRuntime = config.createSessionRuntime;
  if (!createSessionRuntime) throw new Error('expected session runtime factory');
  config.createSessionRuntime = async (params) => ({
    ...await createSessionRuntime(params),
    terminalRemoteModeLoop,
  });
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
  let runtimeRegistryLease: PluginRuntimeRegistryLease | null = null;

  beforeAll(async () => {
    runtimeRegistryLease = await pluginReloadController.acquireRuntimeRegistry({
      resolveRuntimeRegistry: async () => await resolveExecutablePluginRuntimeRegistry({
        contributes: getResolvedContributionRegistry(),
        pluginIds: [],
      }),
    });
  });

  afterAll(async () => {
    await runtimeRegistryLease?.release();
    runtimeRegistryLease = null;
    await pluginReloadController.shutdown({ timeoutMs: 5_000 });
  });

  it('composes the bound UI Agent-realtime service through the host runtime RPC producer', async () => {
    const createAgentSessionRealtimeService = await loadAgentSessionRealtimeService();
    const harness = createHarness();
    harness.config.policyAgentId = 'codex';
    const provider = {
      pluginId: 'happier.agent.codex',
      localId: 'realtime-codex',
    } as const;
    const bundledAuthority = resolveAgentSessionRealtimeVoiceAuthority({
      runtimeRegistry: runtimeRegistryLease?.registry ?? null,
      policyAgentRef: { pluginId: 'happier.agent.codex', localId: 'codex' },
      agentRuntimeIdentity: {
        pluginId: 'happier.agent.codex',
        agentId: 'codex',
        generation: 'bundled-registry-generation',
        isCurrent: () => true,
      },
    });
    if (!bundledAuthority) {
      throw new Error('expected bundled Voice authority');
    }
    setAgentSessionRealtimeVoiceAuthority(harness.config, bundledAuthority);
    const runtimeTerminalListeners = new Set<
      (event: AgentSessionRealtimeLifecycleEvent) => void
    >();
    const startGate = createDeferred<void>();
    let runtimeTerminal: AgentSessionRealtimeLifecycleEvent | null = null;
    const runtimeHandle: AgentSessionRealtimeHandle = {
      stop: vi.fn(async () => ({ status: 'stopped' as const })),
      watch(listener) {
        if (runtimeTerminal) listener(runtimeTerminal);
        else runtimeTerminalListeners.add(listener);
        return {
          dispose() {
            runtimeTerminalListeners.delete(listener);
          },
        };
      },
      dispose: vi.fn(),
    };
    const inspect = vi.fn(async () => ({
      status: 'available' as const,
      transport: 'webrtc' as const,
    }));
    const start = vi.fn<AgentSessionRealtimeConversation['start']>(async () => {
      await startGate.promise;
      return {
        status: 'started' as const,
        transport: {
          kind: 'webrtc' as const,
          answerSdp: 'v=0\r\na=answer:host-runtime\r\n',
        },
        handle: runtimeHandle,
      };
    });
    const nativeRuntime = {
      ...harness.runtime,
      send: vi.fn(async () => ({ status: 'admitted' as const })),
      watch: vi.fn(() => ({ dispose() {} })),
      dispose: vi.fn(),
      realtimeConversation: { inspect, start },
    };
    setSessionRuntimeFactory(harness.config, () => ({
      operations: harness.runtime,
      nativeRuntime,
    }));

    const rpcCalls: Array<Readonly<{
      sessionId: string;
      method: string;
      payload: unknown;
    }>> = [];
    const onTerminal = vi.fn();
    harness.deps.runSessionLoopLifecycleFn = async () => {
      const service = createAgentSessionRealtimeService({
        provider,
        conversationSessionId: 'session-1',
        applicationAttemptId: 'voice:host-runtime-composition',
        signal: new AbortController().signal,
        sessionRpc: async ({ sessionId, method, payload }) => {
          rpcCalls.push({ sessionId, method, payload });
          const handler = harness.handlers.get(method);
          if (!handler) throw new Error(`missing host runtime RPC producer: ${method}`);
          return await handler(payload);
        },
        onTerminal,
      });

      await expect(service.inspect()).resolves.toEqual({
        status: 'available',
        transport: 'webrtc',
      });
      const startedPromise = service.start({
        transport: {
          kind: 'webrtc',
          offerSdp: 'v=0\r\na=offer:ui-service\r\n',
        },
      });
      const startSettled = vi.fn();
      void startedPromise.then(startSettled, startSettled);
      await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
      expect(startSettled).not.toHaveBeenCalled();

      startGate.resolve();
      const started = await startedPromise;
      expect(started).toMatchObject({
        status: 'started',
        transport: {
          kind: 'webrtc',
          answerSdp: 'v=0\r\na=answer:host-runtime\r\n',
        },
      });
      await vi.waitFor(() => {
        expect(rpcCalls.map((call) => call.method)).toContain(
          SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_WATCH,
        );
      });

      runtimeTerminal = {
        kind: 'terminal',
        reason: 'upstream_closed',
      };
      for (const listener of [...runtimeTerminalListeners]) {
        listener(runtimeTerminal);
      }
      runtimeTerminalListeners.clear();
      await vi.waitFor(() => {
        expect(onTerminal).toHaveBeenCalledWith(runtimeTerminal);
      });

      if (started.status !== 'started') {
        throw new Error('expected the composed Agent-realtime attempt to start');
      }
      await expect(started.handle.stop()).resolves.toEqual({
        status: 'already_stopped',
      });
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(inspect).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledWith(
      {
        transport: {
          kind: 'webrtc',
          offerSdp: 'v=0\r\na=offer:ui-service\r\n',
        },
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(rpcCalls).toEqual([
      {
        sessionId: 'session-1',
        method: SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_INSPECT,
        payload: { v: 1, provider },
      },
      {
        sessionId: 'session-1',
        method: SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START,
        payload: {
          v: 1,
          provider,
          applicationAttemptId: 'voice:host-runtime-composition',
          transport: {
            kind: 'webrtc',
            offerSdp: 'v=0\r\na=offer:ui-service\r\n',
          },
        },
      },
      {
        sessionId: 'session-1',
        method: SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_WATCH,
        payload: {
          v: 1,
          provider,
          applicationAttemptId: 'voice:host-runtime-composition',
        },
      },
      {
        sessionId: 'session-1',
        method: SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_STOP,
        payload: {
          v: 1,
          provider,
          applicationAttemptId: 'voice:host-runtime-composition',
        },
      },
    ]);
    expect(JSON.stringify(rpcCalls)).not.toMatch(
      /audio|pcm|voice_media|appendAudio|appendInputAudio|fallback/iu,
    );
    expect(runtimeHandle.stop).not.toHaveBeenCalled();
    expect(runtimeHandle.dispose).toHaveBeenCalledOnce();
  });

  it('preempts a delayed matching start when the bound Voice attempt aborts before daemon admission', async () => {
    const createAgentSessionRealtimeService = await loadAgentSessionRealtimeService();
    const harness = createHarness();
    harness.config.policyAgentId = 'codex';
    const provider = {
      pluginId: 'happier.agent.codex',
      localId: 'realtime-codex',
    } as const;
    const bundledAuthority = resolveAgentSessionRealtimeVoiceAuthority({
      runtimeRegistry: runtimeRegistryLease?.registry ?? null,
      policyAgentRef: { pluginId: 'happier.agent.codex', localId: 'codex' },
      agentRuntimeIdentity: {
        pluginId: 'happier.agent.codex',
        agentId: 'codex',
        generation: 'bundled-registry-generation',
        isCurrent: () => true,
      },
    });
    if (!bundledAuthority) {
      throw new Error('expected bundled Voice authority');
    }
    setAgentSessionRealtimeVoiceAuthority(harness.config, bundledAuthority);

    const runtimeWatchDispose = vi.fn();
    const runtimeHandle: AgentSessionRealtimeHandle = {
      stop: vi.fn(async () => ({ status: 'stopped' as const })),
      watch: vi.fn(() => ({ dispose: runtimeWatchDispose })),
      dispose: vi.fn(),
    };
    const start = vi.fn<AgentSessionRealtimeConversation['start']>(async () => ({
      status: 'started',
      transport: {
        kind: 'webrtc',
        answerSdp: 'v=0\r\na=late-answer\r\n',
      },
      handle: runtimeHandle,
    }));
    const nativeRuntime = {
      ...harness.runtime,
      send: vi.fn(async () => ({ status: 'admitted' as const })),
      watch: vi.fn(() => ({ dispose() {} })),
      dispose: vi.fn(),
      realtimeConversation: {
        inspect: vi.fn(async () => ({
          status: 'available' as const,
          transport: 'webrtc' as const,
        })),
        start,
      },
    };
    setSessionRuntimeFactory(harness.config, () => ({
      operations: harness.runtime,
      nativeRuntime,
    }));

    const delayedStart = createDeferred<void>();
    const boundAttempt = new AbortController();
    const callerOperation = new AbortController();
    const rpcMethods: string[] = [];
    const stopResults: unknown[] = [];
    const startRpcSignals: AbortSignal[] = [];
    const onTerminal = vi.fn();
    harness.deps.runSessionLoopLifecycleFn = async () => {
      const service = createAgentSessionRealtimeService({
        provider,
        conversationSessionId: 'session-1',
        applicationAttemptId: 'voice:stop-before-start',
        signal: boundAttempt.signal,
        sessionRpc: async ({ method, payload, signal }) => {
          rpcMethods.push(method);
          const handler = harness.handlers.get(method);
          if (!handler) throw new Error(`missing host runtime RPC producer: ${method}`);
          if (method === SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START) {
            startRpcSignals.push(signal);
            await delayedStart.promise;
          }
          const result = await handler(payload);
          if (method === SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_STOP) {
            stopResults.push(result);
          }
          return result;
        },
        onTerminal,
      });

      const startedPromise = service.start(
        {
          transport: {
            kind: 'webrtc',
            offerSdp: 'v=0\r\na=delayed-offer\r\n',
          },
        },
        { signal: callerOperation.signal },
      );
      await vi.waitFor(() => {
        expect(rpcMethods).toEqual([
          SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START,
        ]);
      });

      boundAttempt.abort();
      await vi.waitFor(() => {
        expect(rpcMethods).toEqual([
          SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START,
          SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_STOP,
        ]);
      });
      await vi.waitFor(() => {
        expect(stopResults).toEqual([
          { ok: true, status: 'already_stopped' },
        ]);
      });
      const startObservedBoundAbort = startRpcSignals[0]?.aborted;
      delayedStart.resolve();

      await expect(startedPromise).resolves.toEqual({ status: 'aborted' });
      expect(startObservedBoundAbort).toBe(true);
      expect(callerOperation.signal.aborted).toBe(false);
      expect(onTerminal).toHaveBeenCalledOnce();
      expect(onTerminal).toHaveBeenCalledWith({
        kind: 'terminal',
        reason: 'aborted',
      });
      expect(rpcMethods).toEqual([
        SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START,
        SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_STOP,
        SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_STOP,
      ]);
      await vi.waitFor(() => {
        expect(stopResults).toEqual([
          { ok: true, status: 'already_stopped' },
          { ok: true, status: 'stopped' },
        ]);
      });
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(start).toHaveBeenCalledOnce();
    expect(runtimeHandle.stop).toHaveBeenCalledOnce();
    expect(runtimeHandle.watch).toHaveBeenCalledOnce();
    expect(runtimeWatchDispose).toHaveBeenCalledOnce();
    expect(runtimeHandle.dispose).toHaveBeenCalledOnce();
  });

  it('authorizes a never-before-seen installed Agent-session Voice declaration from the selected runtime generation and fails closed otherwise', async () => {
    const createAgentSessionRealtimeService = await loadAgentSessionRealtimeService();
    const harness = createHarness();
    harness.config.policyAgentId = 'codex';
    const selectedAgent = {
      pluginId: 'happier.agent.codex',
      localId: 'codex',
    } as const;
    const installedProvider = {
      pluginId: 'example.voice.never-seen',
      localId: 'agent-session-conversation',
    } as const;
    const wrongAgentProvider = {
      pluginId: installedProvider.pluginId,
      localId: 'wrong-agent',
    } as const;
    const malformedProvider = {
      pluginId: installedProvider.pluginId,
      localId: 'malformed',
    } as const;
    const installedDeclaration = {
      id: installedProvider.localId,
      title: 'Never-seen installed Voice',
      kind: 'conversation',
      roles: ['realtime_conversation'],
      platforms: ['web'],
      capabilities: {
        readiness: { requirements: [] },
        turn: { cancelResponse: false, bargeIn: false },
      },
      execution: {
        kind: 'experimental_agent_session_realtime',
        agent: selectedAgent,
      },
      client: {
        artifactId: 'installed-voice-runtime',
        modulePath: './voice',
        exportName: 'activate',
      },
    } satisfies PluginVoiceProviderContributionV1;
    const wrongAgentDeclaration = {
      ...installedDeclaration,
      id: wrongAgentProvider.localId,
      execution: {
        kind: 'experimental_agent_session_realtime',
        agent: { pluginId: 'happier.agent.other', localId: 'other' },
      },
    } satisfies PluginVoiceProviderContributionV1;
    const malformedDeclaration = {
      ...installedDeclaration,
      id: malformedProvider.localId,
      execution: {
        kind: 'experimental_agent_session_realtime',
        agent: 'happier.agent.codex/codex',
      },
    } as unknown as Extract<
      PluginVoiceProviderContributionV1,
      Readonly<{ kind: 'conversation' }>
    >;
    let generationCurrent = true;
    const generationRetirement = new AbortController();
    const installedAuthority = resolveAgentSessionRealtimeVoiceAuthority({
      runtimeRegistry: {
        contributes: {
          voiceProviders: [
            {
              pluginId: installedProvider.pluginId,
              identity: installedProvider,
              manifestDigest: 'manifest:installed-voice',
              definition: installedDeclaration,
            },
            {
              pluginId: wrongAgentProvider.pluginId,
              identity: wrongAgentProvider,
              manifestDigest: 'manifest:installed-voice',
              definition: wrongAgentDeclaration,
            },
            {
              pluginId: malformedProvider.pluginId,
              identity: malformedProvider,
              manifestDigest: 'manifest:installed-voice',
              definition: malformedDeclaration,
            },
          ],
        },
        resolveContributionRuntimeLifecycle: () => ({
          generation: 'installed-provider-generation:42',
          isCurrent: () => generationCurrent,
          retirementSignal: generationRetirement.signal,
        }),
      },
      policyAgentRef: selectedAgent,
      agentRuntimeIdentity: {
        pluginId: selectedAgent.pluginId,
        agentId: selectedAgent.localId,
        generation: 'installed-generation:42',
        isCurrent: () => generationCurrent,
      },
      agentRetirementSignal: generationRetirement.signal,
    });
    if (!installedAuthority) {
      throw new Error('expected installed Voice authority');
    }
    setAgentSessionRealtimeVoiceAuthority(harness.config, installedAuthority);

    const runtimeHandle: AgentSessionRealtimeHandle = {
      stop: vi.fn(async () => ({ status: 'stopped' as const })),
      watch: vi.fn(() => ({ dispose() {} })),
      dispose: vi.fn(),
    };
    const inspect = vi.fn(async () => ({
      status: 'available' as const,
      transport: 'webrtc' as const,
    }));
    const start = vi.fn<AgentSessionRealtimeConversation['start']>(async () => ({
      status: 'started',
      transport: {
        kind: 'webrtc',
        answerSdp: 'v=0\r\na=answer:installed\r\n',
      },
      handle: runtimeHandle,
    }));
    const nativeRuntime = {
      ...harness.runtime,
      send: vi.fn(async () => ({ status: 'admitted' as const })),
      watch: vi.fn(() => ({ dispose() {} })),
      dispose: vi.fn(),
      realtimeConversation: { inspect, start },
    };
    setSessionRuntimeFactory(harness.config, () => ({
      operations: harness.runtime,
      nativeRuntime,
    }));

    harness.deps.runSessionLoopLifecycleFn = async () => {
      const invoke = async (method: string, payload: unknown) => {
        const handler = harness.handlers.get(method);
        if (!handler) throw new Error(`missing host runtime RPC producer: ${method}`);
        return await handler(payload);
      };
      for (const provider of [
        { pluginId: 'example.voice.unknown', localId: installedProvider.localId },
        wrongAgentProvider,
        malformedProvider,
      ]) {
        await expect(invoke(
          SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_INSPECT,
          { v: 1, provider },
        )).resolves.toMatchObject({
          ok: false,
          status: 'unavailable',
          code: 'agent_realtime_declaration_unavailable',
        });
      }
      expect(inspect).not.toHaveBeenCalled();

      const service = createAgentSessionRealtimeService({
        provider: installedProvider,
        conversationSessionId: 'session-1',
        applicationAttemptId: 'voice:installed-generation',
        signal: new AbortController().signal,
        sessionRpc: async ({ sessionId, method, payload }) => {
          expect(sessionId).toBe('session-1');
          return await invoke(method, payload);
        },
        onTerminal: vi.fn(),
      });
      await expect(service.inspect()).resolves.toEqual({
        status: 'available',
        transport: 'webrtc',
      });
      await expect(service.start({
        transport: {
          kind: 'webrtc',
          offerSdp: 'v=0\r\na=offer:installed\r\n',
        },
      })).resolves.toMatchObject({
        status: 'started',
        transport: {
          kind: 'webrtc',
          answerSdp: 'v=0\r\na=answer:installed\r\n',
        },
      });

      generationCurrent = false;
      generationRetirement.abort();
      await expect(invoke(
        SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_INSPECT,
        { v: 1, provider: installedProvider },
      )).resolves.toMatchObject({
        ok: false,
        status: 'unavailable',
        code: 'agent_realtime_declaration_unavailable',
      });
      expect(inspect).toHaveBeenCalledTimes(1);
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
    expect(start).toHaveBeenCalledOnce();
    expect(runtimeHandle.dispose).toHaveBeenCalledOnce();
  });

  it('does not seed current-runtime Activity from an existing session tuple', async () => {
    const harness = createHarness();
    harness.opts.existingSessionId = 'session-1';
    harness.config.runtimeActivityApplicability = 'not_applicable';
    let initialRuntimeActivityMutation: unknown = null;

    harness.deps.initializeBackendApiContextFn = async () => ({
      api: {
        push: () => ({ sendToAllDevices: () => undefined }),
        sessionSyncClient: (_sessionRow: unknown, options: { initialRegisteredSessionStateFieldMutations?: readonly unknown[] }) => {
          initialRuntimeActivityMutation = options.initialRegisteredSessionStateFieldMutations?.[0] ?? null;
          return harness.session;
        },
      },
      machineId: 'machine-1',
    });
    harness.deps.initializeBackendRunSessionFn = async ({ api }: any) => {
      api.sessionSyncClient({
        id: 'session-1',
        runtimeActivityState: 'active',
        runtimeActivityActiveCount: 3,
        runtimeActivityObservedAt: 10,
        runtimeActivityRevision: 8,
      });
      return {
        session: harness.session,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: true,
      };
    };
    setSessionRuntimeFactory(harness.config, () => {
      expect(initialRuntimeActivityMutation).toEqual(expect.objectContaining({
        fieldId: 'runtime.activity',
        op: { kind: 'set', value: { state: 'idle', activeCount: 0 } },
      }));
      return { operations: harness.runtime, nativeRuntime: harness.runtime };
    });

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('routes session-input transforms through the scoped daemon bridge', async () => {
    const harness = createHarness();
    const transformSessionInput = vi.fn(async (
      params: Readonly<{
        sessionId: string;
        payload: Readonly<Record<string, unknown>>;
      }>,
    ) => ({
      ...params.payload,
      text: 'transformed by daemon',
    }));
    harness.deps.sessionLoopLifecycleDeps = {
      daemonTurnContributionsBridge: {
        resolvePrompt: vi.fn(async () => ({
          kind: 'prompt' as const,
          toolContributions: [],
          assetContributions: [],
        })),
        transformAgentContext: vi.fn(async ({ payload }) => payload),
        transformSessionInput,
      },
    };

    let capturedTransformer:
      | ((payload: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>)
      | undefined;
    harness.deps.initializeBackendApiContextFn = async () => ({
      api: {
        push: () => ({ sendToAllDevices: () => undefined }),
        sessionSyncClient: (
          _sessionRow: unknown,
          options: Readonly<{
            transformSessionInputBeforeCommit?: typeof capturedTransformer;
          }>,
        ) => {
          capturedTransformer = options.transformSessionInputBeforeCommit;
          return harness.session;
        },
      },
      machineId: 'machine-1',
    });
    let deferredPendingFirstInputCommit = false;
    harness.deps.initializeBackendRunSessionFn = async ({
      api,
      deferPendingFirstInputCommitUntilRuntimeReady,
    }: any) => {
      deferredPendingFirstInputCommit =
        deferPendingFirstInputCommitUntilRuntimeReady === true;
      api.sessionSyncClient({ id: 'session-1' });
      return {
        session: harness.session,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: true,
      };
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    if (!capturedTransformer) {
      throw new Error('expected scoped session-input transformer');
    }
    const payload = {
      sessionId: 'session-1',
      localId: 'local-1',
      text: 'original',
      meta: {},
      timestampMs: 1,
    };
    await expect(capturedTransformer(payload)).resolves.toEqual({
      ...payload,
      text: 'transformed by daemon',
    });
    expect(transformSessionInput).toHaveBeenCalledWith({
      sessionId: 'session-1',
      payload,
    });
    expect(deferredPendingFirstInputCommit).toBe(true);
  });

  it('commits retained daemon-bridge first input after runtime open and before prompt admission', async () => {
    const harness = createHarness();
    const order: string[] = [];
    const runtimeOpenStarted = createDeferred<void>();
    const releaseRuntimeOpen = createDeferred<void>();
    const commitPendingFirstInputAfterRuntimeReady = vi.fn(async () => {
      order.push('pending-input:commit');
    });
    harness.deps.initializeBackendRunSessionFn = async () => ({
      session: harness.session,
      reconnectionHandle: null,
      reportedSessionId: 'session-1',
      attachedToExistingSession: false,
      commitPendingFirstInputAfterRuntimeReady,
    });
    setSessionRuntimeFactory(harness.config, async () => {
      order.push('runtime:open-started');
      runtimeOpenStarted.resolve();
      await releaseRuntimeOpen.promise;
      order.push('runtime:opened');
      return { operations: harness.runtime, nativeRuntime: harness.runtime };
    });
    harness.deps.runSessionLoopLifecycleFn = async (params: Readonly<{
      startupCoordinator?: Readonly<{ start?: () => Promise<void> }> | null;
    }>) => {
      order.push('lifecycle:entered');
      await params.startupCoordinator?.start?.();
      order.push('prompt:admitted');
    };

    const running = runHostSessionRuntime(
      harness.opts,
      harness.config,
      harness.deps,
    );
    await runtimeOpenStarted.promise;
    expect(commitPendingFirstInputAfterRuntimeReady).not.toHaveBeenCalled();
    releaseRuntimeOpen.resolve();
    await running;

    expect(commitPendingFirstInputAfterRuntimeReady).toHaveBeenCalledOnce();
    expect(order).toEqual([
      'runtime:open-started',
      'runtime:opened',
      'lifecycle:entered',
      'pending-input:commit',
      'prompt:admitted',
    ]);
  });

  it('does not commit retained daemon-bridge first input when runtime open fails', async () => {
    const harness = createHarness();
    const commitPendingFirstInputAfterRuntimeReady = vi.fn();
    harness.deps.initializeBackendRunSessionFn = async () => ({
      session: harness.session,
      reconnectionHandle: null,
      reportedSessionId: 'session-1',
      attachedToExistingSession: false,
      commitPendingFirstInputAfterRuntimeReady,
    });
    setSessionRuntimeFactory(harness.config, async () => {
      throw new Error('daemon session.open failed');
    });

    await expect(runHostSessionRuntime(
      harness.opts,
      harness.config,
      harness.deps,
    )).rejects.toThrow('daemon session.open failed');
    expect(commitPendingFirstInputAfterRuntimeReady).not.toHaveBeenCalled();
  });

  it('binds the supported current-runtime observer and publishes idle before provider input starts', async () => {
    const harness = createHarness();
    harness.config.runtimeActivityApplicability = 'supported';
    let observerBound = false;
    harness.runtime.subscribeCanonicalAgentSessionEvents = vi.fn((handler: (event: any) => void) => {
      observerBound = true;
      handler({
        kind: 'runtime-activity-snapshot',
        sequence: 1,
        sessionId: 'session-1',
        emittedAtMs: 1,
        state: 'idle',
        activeCount: 0,
      });
      return () => undefined;
    });
    harness.deps.runPermissionModePromptLoopFn = async () => {
      expect(observerBound).toBe(true);
      await vi.waitFor(() => expect(harness.session.enqueueRegisteredSessionStateFieldMutation)
        .toHaveBeenLastCalledWith(expect.objectContaining({
          op: { kind: 'set', value: { state: 'idle', activeCount: 0 } },
        })));
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('waits for the initial Runtime Activity authority settlement before provider input starts', async () => {
    const harness = createHarness();
    const authoritySettlement = createDeferred<void>();
    harness.session.enqueueRegisteredSessionStateFieldMutation = vi.fn(
      async () => await authoritySettlement.promise,
    );
    const runPermissionModePromptLoopFn = vi.fn(async () => undefined);
    harness.deps.runPermissionModePromptLoopFn = runPermissionModePromptLoopFn;

    const runPromise = runHostSessionRuntime(harness.opts, harness.config, harness.deps);
    await vi.waitFor(() => {
      expect(harness.session.enqueueRegisteredSessionStateFieldMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          fieldId: 'runtime.activity',
          op: { kind: 'set', value: { state: 'idle', activeCount: 0 } },
        }),
      );
    });
    await Promise.resolve();

    expect(runPermissionModePromptLoopFn).not.toHaveBeenCalled();

    authoritySettlement.resolve();
    await runPromise;
    expect(runPermissionModePromptLoopFn).toHaveBeenCalledOnce();
  });

  it('does not publish idle when supported observer installation fails', async () => {
    const harness = createHarness();
    const observerFailure = new Error('observer installation failed');
    harness.config.runtimeActivityApplicability = 'supported';
    harness.runtime.subscribeCanonicalAgentSessionEvents = vi.fn(() => {
      throw observerFailure;
    });

    await expect(runHostSessionRuntime(harness.opts, harness.config, harness.deps)).rejects.toBe(observerFailure);
    await Promise.resolve();
    expect(harness.session.enqueueRegisteredSessionStateFieldMutation.mock.calls)
      .not.toContainEqual([
        expect.objectContaining({
          op: { kind: 'set', value: { state: 'idle', activeCount: 0 } },
        }),
      ]);
  });

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

  it('consumes provider binding materialization at the host-runtime ingress and passes it to the runtime factory', async () => {
    const harness = createHarness();
    harness.config.policyAgentId = 'codex';
    harness.opts.backendTarget = { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' };
    harness.opts.modelSelection = {
      v: 1, updatedAt: 1,
      ref: { agentTargetKey: 'backend:codex', providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'), modelId: 'provider-model' },
    };
    const materialization = {
      v: 1 as const,
      kind: 'engineConfig' as const,
      engineConfig: { model_provider: { name: 'gateway' } },
    };
    const sessionBindingMetadata = {
      v: 1 as const,
      connectionId: ProviderConnectionIdSchema.parse('pc_work'),
      contributionKey: 'plugin.openrouter/openrouter',
      connectionRevision: 3,
      model: providerModelDescriptor,
      protocol: 'openai-responses' as const,
      materialization: 'engineConfig' as const,
      adapterBindingKey: 'openrouter',
      compatibilityFingerprint: 'compatibility-v1',
      bindingSecurityFingerprint: 'security-v1',
      displaySnapshot: {
        providerName: 'OpenRouter',
        connectionName: 'Work',
        connectionRole: 'named' as const,
        connectionDisplayNameMode: 'custom' as const,
      },
    };
    const createSessionRuntime = vi.fn(() => ({
      operations: harness.runtime,
      nativeRuntime: harness.runtime,
    }));
    harness.config.createSessionRuntime = createSessionRuntime;
    let persistedMetadata: Record<string, unknown> = { path: '/tmp/workspace', permissionMode: 'default' };
    harness.deps.createSessionMetadataFn = (params: any) => {
      persistedMetadata = params.augmentMetadata(persistedMetadata);
      return {
        state: { controlledByUser: false },
        metadata: persistedMetadata,
      };
    };
    harness.session.getMetadataSnapshot = () => persistedMetadata;
    const previousHandoff = process.env[HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY];
    delete process.env[HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY];
    harness.opts.environmentVariables = {
      [HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY]:
        serializeProviderBindingLaunchHandoffForEnv(
          materialization,
          sessionBindingMetadata,
        ),
    };

    try {
      await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

      expect(createSessionRuntime).toHaveBeenCalledWith(expect.objectContaining({
        providerBindingMaterialization: materialization,
        metadata: expect.objectContaining({ providerBindingV1: sessionBindingMetadata }),
      }));
      expect(process.env[HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY]).toBeUndefined();
    } finally {
      if (previousHandoff === undefined) delete process.env[HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY];
      else process.env[HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY] = previousHandoff;
    }
  });

  it('does not construct a provider-bound runtime before fresh daemon session initialization ACKs', async () => {
    const createProviderBoundHarness = () => {
      const harness = createHarness();
      harness.config.policyAgentId = 'codex';
      harness.opts.startedBy = 'daemon';
      harness.opts.backendTarget = {
        kind: 'backend',
        backendId: 'codex',
        sourceKind: 'built_in',
      };
      harness.opts.modelSelection = {
        v: 1,
        updatedAt: 1,
        ref: {
          agentTargetKey: 'backend:codex',
          providerConnectionId:
            ProviderConnectionIdSchema.parse('pc_work'),
          modelId: providerModelDescriptor.id,
        },
      };
      harness.opts.environmentVariables = {
        [HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY]:
          serializeProviderBindingLaunchHandoffForEnv(
            {
              v: 1,
              kind: 'engineConfig',
              engineConfig: { model_provider: { name: 'managed-gateway' } },
            },
            {
              v: 1,
              connectionId: ProviderConnectionIdSchema.parse('pc_work'),
              contributionKey: 'happier.provider.cliproxyapi/cliproxyapi',
              connectionRevision: 1,
              model: providerModelDescriptor,
              protocol: 'openai-responses',
              materialization: 'engineConfig',
              adapterBindingKey: 'cliproxyapi',
              compatibilityFingerprint: 'compatibility-v1',
              bindingSecurityFingerprint: 'security-v1',
              displaySnapshot: {
                providerName: 'CLIProxyAPI',
                connectionName: 'CLIProxyAPI',
                connectionRole: 'default',
                connectionDisplayNameMode: 'automatic',
              },
            },
          ),
      };
      const createSessionRuntime = vi.fn(() => ({
        operations: harness.runtime,
        nativeRuntime: harness.runtime,
      }));
      harness.config.createSessionRuntime = createSessionRuntime;
      const createDeferredBootstrap = vi.fn();
      harness.config.startupBootstrap = {
        shouldCreate: ({ seed }) =>
          seed.modelSelection?.ref.providerConnectionId === null,
        create: createDeferredBootstrap,
      };
      return {
        harness,
        createSessionRuntime,
        createDeferredBootstrap,
      };
    };

    const pending = createProviderBoundHarness();
    const daemonAck = createDeferred<Awaited<
      ReturnType<typeof pending.harness.deps.initializeBackendRunSessionFn>
    >>();
    pending.harness.deps.initializeBackendRunSessionFn =
      vi.fn(async () => await daemonAck.promise);
    const run = runHostSessionRuntime(
      pending.harness.opts,
      pending.harness.config,
      pending.harness.deps,
    );

    await vi.waitFor(() => {
      expect(
        pending.harness.deps.initializeBackendRunSessionFn,
      ).toHaveBeenCalledOnce();
    });
    expect(pending.createDeferredBootstrap).not.toHaveBeenCalled();
    expect(pending.createSessionRuntime).not.toHaveBeenCalled();

    daemonAck.resolve({
      session: pending.harness.session,
      reconnectionHandle: null,
      reportedSessionId: 'canonical-session',
      attachedToExistingSession: false,
    });
    await expect(run).resolves.toBeUndefined();
    expect(pending.createSessionRuntime).toHaveBeenCalledOnce();

    const failed = createProviderBoundHarness();
    failed.harness.deps.initializeBackendRunSessionFn =
      vi.fn(async () => {
        throw new Error('required daemon ACK failed');
      });
    await expect(runHostSessionRuntime(
      failed.harness.opts,
      failed.harness.config,
      failed.harness.deps,
    )).rejects.toThrow('required daemon ACK failed');
    expect(failed.createDeferredBootstrap).not.toHaveBeenCalled();
    expect(failed.createSessionRuntime).not.toHaveBeenCalled();
  });

  it('fails closed before runtime creation when a Provider handoff omits or mismatches the selected exact model', async () => {
    for (const model of [
      undefined,
      { id: 'different-provider-model', name: 'Different Provider Model' },
    ] as const) {
      const harness = createHarness();
      harness.config.policyAgentId = 'codex';
      harness.opts.backendTarget = { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' };
      harness.opts.modelSelection = {
        v: 1,
        updatedAt: 1,
        ref: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'),
          modelId: providerModelDescriptor.id,
        },
      };
      const createSessionRuntime = vi.fn(() => ({
        operations: harness.runtime,
        nativeRuntime: harness.runtime,
      }));
      harness.config.createSessionRuntime = createSessionRuntime;
      harness.opts.environmentVariables = {
        [HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY]:
          serializeProviderBindingLaunchHandoffForEnv(
            { v: 1, kind: 'engineConfig', engineConfig: { model_provider: { name: 'gateway' } } },
            {
              v: 1,
              connectionId: ProviderConnectionIdSchema.parse('pc_work'),
              contributionKey: 'plugin.openrouter/openrouter',
              connectionRevision: 3,
              ...(model ? { model } : {}),
              protocol: 'openai-responses',
              materialization: 'engineConfig',
              adapterBindingKey: 'openrouter',
              compatibilityFingerprint: 'compatibility-v1',
              bindingSecurityFingerprint: 'security-v1',
              displaySnapshot: {
                providerName: 'OpenRouter',
                connectionName: 'Work',
                connectionRole: 'named',
                connectionDisplayNameMode: 'custom',
              },
            },
          ),
      };

      await expect(runHostSessionRuntime(harness.opts, harness.config, harness.deps))
        .rejects.toThrow('Provider binding handoff model does not match the selected model');
      expect(createSessionRuntime).not.toHaveBeenCalled();
    }
  });

  it('keeps provider-owned child credentials redacted for the whole runtime lifetime and releases them on factory failure', async () => {
    const harness = createHarness();
    const credential = 'provider-runtime-redaction-secret-value';
    harness.config.policyAgentId = 'codex';
    harness.opts.backendTarget = { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' };
    harness.opts.modelSelection = {
      v: 1,
      updatedAt: 1,
      ref: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'),
        modelId: 'provider-model',
      },
    };
    process.env.HAPPIER_CODEX_PROVIDER_API_KEY = credential;
    process.env[HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY] =
      serializeProviderBindingLaunchHandoffForEnv(
        { v: 1, kind: 'engineConfig', engineConfig: { model_provider: { name: 'gateway' } } },
        {
          v: 1,
          connectionId: ProviderConnectionIdSchema.parse('pc_work'),
          contributionKey: 'plugin.openrouter/openrouter',
          connectionRevision: 3,
          model: providerModelDescriptor,
          protocol: 'openai-responses',
          materialization: 'engineConfig',
          adapterBindingKey: 'openrouter',
          compatibilityFingerprint: 'compatibility-v1',
          bindingSecurityFingerprint: 'security-v1',
          displaySnapshot: {
            providerName: 'OpenRouter',
            connectionName: 'Work',
            connectionRole: 'named',
            connectionDisplayNameMode: 'custom',
          },
        },
      );
    harness.config.createSessionRuntime = () => {
      expect(redactBugReportSensitiveText(credential)).toBe('[REDACTED]');
      throw new Error('factory failed');
    };

    try {
      await expect(runHostSessionRuntime(harness.opts, harness.config, harness.deps))
        .rejects.toThrow('factory failed');
      expect(redactBugReportSensitiveText(credential)).toBe(credential);
    } finally {
      delete process.env.HAPPIER_CODEX_PROVIDER_API_KEY;
      delete process.env[HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY];
    }
  });

  it('closes the current session when required continuation verification refuses during runtime creation', async () => {
    const harness = createHarness();
    harness.config.policyAgentId = 'codex';
    const continuationError = new Error('Agent session continuation is unreachable.');
    continuationError.name = 'AgentSessionContinuationUnreachableError';
    const reconnectionCancel = vi.fn(() => {
      throw new Error('injected reconnection cleanup failure');
    });
    const stopMcpServer = vi.fn(() => {
      throw new Error('injected MCP cleanup failure');
    });
    harness.deps.initializeBackendRunSessionFn = vi.fn(async () => ({
      session: harness.session,
      reconnectionHandle: { cancel: reconnectionCancel },
      reportedSessionId: 'session-1',
      attachedToExistingSession: false,
    }));
    harness.deps.resolveRunnerMcpServersFn = vi.fn(async () => ({
      happierMcpServer: { stop: stopMcpServer },
      mcpServers: {},
    }));
    const runSessionLoopLifecycleFn = vi.fn(async () => undefined);
    harness.deps.runSessionLoopLifecycleFn = runSessionLoopLifecycleFn;
    harness.config.createSessionRuntime = vi.fn(async () => {
      throw continuationError;
    });

    await expect(
      runHostSessionRuntime(harness.opts, harness.config, harness.deps),
    ).rejects.toBe(continuationError);

    expect(harness.session.close).toHaveBeenCalledOnce();
    expect(reconnectionCancel).toHaveBeenCalledOnce();
    expect(stopMcpServer).toHaveBeenCalledOnce();
    expect(runSessionLoopLifecycleFn).not.toHaveBeenCalled();
  });

  it('keeps provider-owned child credentials redacted while the session lifecycle is running', async () => {
    const harness = createHarness();
    const credential = 'provider-runtime-live-lifetime-secret';
    const lifecycleEntered = createDeferred<void>();
    const releaseLifecycle = createDeferred<void>();
    harness.config.policyAgentId = 'codex';
    harness.opts.backendTarget = { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' };
    harness.opts.modelSelection = {
      v: 1,
      updatedAt: 1,
      ref: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'),
        modelId: 'provider-model',
      },
    };
    const previousCredential = process.env.HAPPIER_CODEX_PROVIDER_API_KEY;
    const previousHandoff = process.env[HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY];
    delete process.env.HAPPIER_CODEX_PROVIDER_API_KEY;
    delete process.env[HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY];
    harness.opts.environmentVariables = {
      HAPPIER_CODEX_PROVIDER_API_KEY: credential,
      [HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY]: serializeProviderBindingLaunchHandoffForEnv(
        { v: 1, kind: 'engineConfig', engineConfig: { model_provider: { name: 'gateway' } } },
        {
          v: 1,
          connectionId: ProviderConnectionIdSchema.parse('pc_work'),
          contributionKey: 'plugin.openrouter/openrouter',
          connectionRevision: 3,
          model: providerModelDescriptor,
          protocol: 'openai-responses',
          materialization: 'engineConfig',
          adapterBindingKey: 'openrouter',
          compatibilityFingerprint: 'compatibility-v1',
          bindingSecurityFingerprint: 'security-v1',
          displaySnapshot: {
            providerName: 'OpenRouter',
            connectionName: 'Work',
            connectionRole: 'named',
            connectionDisplayNameMode: 'custom',
          },
        },
      ),
    };
    harness.deps.runSessionLoopLifecycleFn = async () => {
      lifecycleEntered.resolve();
      await releaseLifecycle.promise;
    };

    try {
      const running = runHostSessionRuntime(harness.opts, harness.config, harness.deps);
      await lifecycleEntered.promise;
      expect(redactBugReportSensitiveText(credential)).toBe('[REDACTED]');
      releaseLifecycle.resolve();
      await running;
      expect(redactBugReportSensitiveText(credential)).toBe(credential);
    } finally {
      releaseLifecycle.resolve();
      if (previousCredential === undefined) delete process.env.HAPPIER_CODEX_PROVIDER_API_KEY;
      else process.env.HAPPIER_CODEX_PROVIDER_API_KEY = previousCredential;
      if (previousHandoff === undefined) delete process.env[HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY];
      else process.env[HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY] = previousHandoff;
    }
  });

  it('fails closed when a provider-bound model selection reaches the host without its validated binding handoff', async () => {
    const harness = createHarness();
    harness.opts.backendTarget = { kind: 'backend', backendId: 'qwen', sourceKind: 'built_in' };
    harness.opts.modelSelection = {
      v: 1,
      updatedAt: 1,
      ref: { agentTargetKey: 'backend:qwen', providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'), modelId: 'provider-model' },
    };

    await expect(runHostSessionRuntime(harness.opts, harness.config, harness.deps))
      .rejects.toThrow('Provider-bound model selection requires a validated provider binding handoff');
  });

  it('fails closed when a provider handoff is paired with an explicit native model selection', async () => {
    const harness = createHarness();
    harness.opts.backendTarget = { kind: 'backend', backendId: 'qwen', sourceKind: 'built_in' };
    harness.opts.modelSelection = {
      v: 1,
      updatedAt: 1,
      ref: { agentTargetKey: 'backend:qwen', providerConnectionId: null, modelId: 'native-model' },
    };
    process.env[HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY] =
      serializeProviderBindingLaunchHandoffForEnv(
        { v: 1, kind: 'engineConfig', engineConfig: { provider: 'gateway' } },
        {
          v: 1, connectionId: ProviderConnectionIdSchema.parse('pc_work'), contributionKey: 'plugin.gateway/gateway', connectionRevision: 1,
          protocol: 'openai-responses', materialization: 'engineConfig', adapterBindingKey: 'gateway',
          compatibilityFingerprint: 'compatibility-v1', bindingSecurityFingerprint: 'security-v1',
          displaySnapshot: { providerName: 'Gateway', connectionName: 'Gateway', connectionRole: 'default', connectionDisplayNameMode: 'automatic' },
        },
      );

    try {
      await expect(runHostSessionRuntime(harness.opts, harness.config, harness.deps))
        .rejects.toThrow('Native model selection cannot include a provider binding handoff');
    } finally {
      delete process.env[HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY];
    }
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
    }) => {
      await params.config.onAfterStart?.();
    });

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(applied).toEqual(['display.title:Pre-existing title']);
  });

  it('keeps provider startup bootstrap inside the shared session loop instead of early-returning', async () => {
    const harness = createHarness();
    const resolvedModelSelection = {
      v: 1 as const,
      updatedAt: 123,
      ref: {
        agentTargetKey: 'backend:qwen',
        providerConnectionId: null,
        modelId: 'qwen-fast',
      },
    };
    const bootstrapCleanup = vi.fn(async () => undefined);
    const bootstrapStart = vi.fn(async () => undefined);
    const bootstrapPushSender = {
      sendToAllDevices: vi.fn(() => undefined),
      sendToAllDevicesAsync: vi.fn(async () => undefined),
    };
    let currentPermissionMode: PermissionMode | undefined;
    let currentPermissionModeUpdatedAt = 0;
    const writeRuntimeOverrides = vi.fn();
    const runSessionLoopLifecycleFn = vi.fn(async (params: any) => {
      await params.config.onAfterStart?.({
        session: params.session,
        runtime: params.hookRuntime,
      });
      params.permissionModeState.setCurrentPermissionMode('yolo');
      params.permissionModeState.setCurrentPermissionModeUpdatedAt(999);
      await params.transitionModelSelection({
        agentTargetKey: 'backend:qwen',
        providerConnectionId: null,
        modelId: 'qwen-live',
      }, 'command');
    });
    const initializeBackendApiContextFn = vi.fn(harness.deps.initializeBackendApiContextFn);
    const initializeBackendRunSessionFn = vi.fn(harness.deps.initializeBackendRunSessionFn);

    harness.deps.runSessionLoopLifecycleFn = runSessionLoopLifecycleFn;
    harness.deps.initializeBackendApiContextFn = initializeBackendApiContextFn;
    harness.deps.initializeBackendRunSessionFn = initializeBackendRunSessionFn;
    harness.deps.createPermissionModeQueueStateFn = (params: any) => {
      currentPermissionMode = params.initialPermissionMode;
      return {
        messageQueue: {
          reset: () => undefined,
          size: () => 0,
        },
        rebindSession: () => undefined,
        getCurrentPermissionMode: () => currentPermissionMode,
        setCurrentPermissionMode: (mode: PermissionMode | undefined) => {
          currentPermissionMode = mode;
        },
        getCurrentPermissionModeUpdatedAt: () => currentPermissionModeUpdatedAt,
        setCurrentPermissionModeUpdatedAt: (updatedAt: number) => {
          currentPermissionModeUpdatedAt = updatedAt;
        },
      };
    };
    harness.runtime.updateSessionRuntimeConfig.mockResolvedValue({ status: 'applied' });
    harness.opts.permissionMode = 'acceptEdits';
    harness.config.lifecycleHooks = {
      resolveInitialModelSelection: async () => resolvedModelSelection,
    };
    harness.session.getMetadataSnapshot = () => null;
    type StartupBootstrapCreate = NonNullable<
      HostSessionRuntimeConfig['startupBootstrap']
    >['create'];
    const createBootstrap = vi.fn<StartupBootstrapCreate>(async (params) => {
      expect(params.seed).toEqual({
        permissionMode: 'safe-yolo',
        permissionModeUpdatedAt: expect.any(Number),
        permissionModeSource: 'explicit',
        modelSelection: resolvedModelSelection,
      });
      return {
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
          permissionMode: 'acceptEdits' as const,
          permissionModeUpdatedAt: Date.now(),
        },
        attachedToExistingSession: false,
        reconnectionHandle: null,
        start: bootstrapStart,
        cleanup: bootstrapCleanup,
      };
    });
    harness.config.startupBootstrap = {
      create: createBootstrap,
      writeRuntimeOverrides,
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(runSessionLoopLifecycleFn).toHaveBeenCalledTimes(1);
    const lifecycleParams = runSessionLoopLifecycleFn.mock.calls[0]?.[0] as Readonly<{
      session: Readonly<{ sessionId: string }>;
      runtimeMetadata: Readonly<{ path?: string }>;
      machineId: string;
      startupCoordinator: Readonly<{
        start: () => Promise<void>;
        cleanup: unknown;
      }> | null;
    }> | undefined;
    expect(lifecycleParams?.session.sessionId).toBe(harness.session.sessionId);
    expect(lifecycleParams?.runtimeMetadata).toEqual(expect.objectContaining({ path: '/tmp/bootstrap-workspace' }));
    expect(lifecycleParams?.machineId).toBe('bootstrap-machine');
    expect(lifecycleParams?.startupCoordinator).toEqual(expect.objectContaining({
      start: expect.any(Function),
      cleanup: bootstrapCleanup,
    }));
    await lifecycleParams?.startupCoordinator?.start();
    expect(bootstrapStart).toHaveBeenCalledWith({
      prepareSession: expect.any(Function),
    });
    expect(initializeBackendApiContextFn).not.toHaveBeenCalled();
    expect(initializeBackendRunSessionFn).not.toHaveBeenCalled();
    expect(createBootstrap).toHaveBeenCalledOnce();
    expect(writeRuntimeOverrides).toHaveBeenLastCalledWith({
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 999,
      modelSelection: {
        v: 1,
        updatedAt: expect.any(Number),
        ref: {
          agentTargetKey: 'backend:qwen',
          providerConnectionId: null,
          modelId: 'qwen-fast',
        },
      },
    });
  });

  it('uses the resolved startup seed for the synchronous path when deferred creation is ineligible', async () => {
    const harness = createHarness();
    const lifecycleModelSelection = {
      v: 1 as const,
      updatedAt: 120,
      ref: {
        agentTargetKey: 'backend:qwen',
        providerConnectionId: null,
        modelId: 'qwen-account',
      },
    };
    const cachedModelSelection = {
      v: 1 as const,
      updatedAt: 121,
      ref: {
        agentTargetKey: 'backend:qwen',
        providerConnectionId: null,
        modelId: 'qwen-released-cache',
      },
    };
    const createSessionMetadataFn = vi.fn(harness.deps.createSessionMetadataFn);
    const initializeBackendRunSessionFn = vi.fn(harness.deps.initializeBackendRunSessionFn);
    const createBootstrap = vi.fn();
    harness.deps.createSessionMetadataFn = createSessionMetadataFn;
    harness.deps.initializeBackendRunSessionFn = initializeBackendRunSessionFn;
    harness.config.lifecycleHooks = {
      resolveInitialModelSelection: async () => lifecycleModelSelection,
    };
    harness.config.startupBootstrap = {
      resolveSeed: ({ seed }) => ({
        ...seed,
        permissionMode: 'safe-yolo',
        permissionModeUpdatedAt: 122,
        permissionModeSource: 'released_cache_v1',
        modelSelection: cachedModelSelection,
      }),
      shouldCreate: () => false,
      create: createBootstrap,
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(createBootstrap).not.toHaveBeenCalled();
    expect(createSessionMetadataFn).toHaveBeenCalledWith(expect.objectContaining({
      permissionMode: 'safe-yolo',
      permissionModeUpdatedAt: 122,
      modelSelectionIntent: {
        v: 1,
        updatedAt: 121,
        selection: cachedModelSelection.ref,
      },
    }));
    expect(initializeBackendRunSessionFn).toHaveBeenCalledWith(expect.objectContaining({
      startupMetadataOverrides: {
        permissionModeOverride: {
          mode: 'safe-yolo',
          updatedAt: 122,
        },
        modelOverride: {
          v: 1,
          updatedAt: 121,
          selection: cachedModelSelection.ref,
        },
      },
    }));
  });

  it('commits a fallback-derived live permission override only after its paired timestamp update', async () => {
    const harness = createHarness();
    const writeRuntimeOverrides = vi.fn();
    let fallbackSeed:
      | Readonly<{ permissionMode: PermissionMode; permissionModeUpdatedAt: number }>
      | null = null;
    let currentPermissionMode: PermissionMode | undefined;
    let currentPermissionModeUpdatedAt = 0;
    harness.deps.createPermissionModeQueueStateFn = (params: any) => {
      currentPermissionMode = params.initialPermissionMode;
      return {
        messageQueue: {
          reset: () => undefined,
          size: () => 0,
        },
        rebindSession: () => undefined,
        getCurrentPermissionMode: () => currentPermissionMode,
        setCurrentPermissionMode: (mode: PermissionMode | undefined) => {
          currentPermissionMode = mode;
        },
        getCurrentPermissionModeUpdatedAt: () => currentPermissionModeUpdatedAt,
        setCurrentPermissionModeUpdatedAt: (updatedAt: number) => {
          currentPermissionModeUpdatedAt = updatedAt;
        },
      };
    };
    harness.config.startupBootstrap = {
      resolveSeed: ({ seed }) => {
        fallbackSeed = seed;
        return seed;
      },
      shouldCreate: () => false,
      create: vi.fn(),
      writeRuntimeOverrides,
    };
    harness.deps.runSessionLoopLifecycleFn = async (params: any) => {
      await params.config.onAfterStart?.({
        session: params.session,
        runtime: params.hookRuntime,
      });
      if (!fallbackSeed) throw new Error('expected fallback startup seed');
      params.permissionModeState.setCurrentPermissionMode(fallbackSeed.permissionMode);
      params.permissionModeState.setCurrentPermissionModeUpdatedAt(
        fallbackSeed.permissionModeUpdatedAt,
      );
      expect(writeRuntimeOverrides).not.toHaveBeenCalled();

      params.permissionModeState.setCurrentPermissionMode('yolo');
      expect(writeRuntimeOverrides).not.toHaveBeenCalled();
      params.permissionModeState.setCurrentPermissionModeUpdatedAt(
        fallbackSeed.permissionModeUpdatedAt + 1,
      );
      expect(writeRuntimeOverrides).toHaveBeenCalledWith(expect.objectContaining({
        permissionMode: 'yolo',
        permissionModeUpdatedAt: fallbackSeed.permissionModeUpdatedAt + 1,
      }));
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(writeRuntimeOverrides).toHaveBeenCalledOnce();
  });

  it('persists an authoritative account-default startup override', async () => {
    const harness = createHarness();
    const writeRuntimeOverrides = vi.fn();
    harness.config.startupBootstrap = {
      resolveSeed: ({ seed }) => ({
        ...seed,
        permissionModeSource: 'account_default',
      }),
      shouldCreate: () => false,
      create: vi.fn(),
      writeRuntimeOverrides,
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(writeRuntimeOverrides).toHaveBeenCalledOnce();
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

  it('runs terminal remote switching through the shared lifecycle when the session factory binds a mode loop', async () => {
    const harness = createHarness();
    const runTerminalRemoteSessionModeLoopFn = vi.fn(async () => 0);
    const modeLoop = {
      startingMode: 'remote' as const,
      remoteExitCode: 0,
      runTerminal: vi.fn(async () => ({ type: 'exit', code: 0 } as const)),
      runRemote: vi.fn(async () => 'exit' as const),
      onModeChange: vi.fn(),
    };
    setTerminalRemoteModeLoop(harness.config, modeLoop);
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

  it('does not infer terminal remote switching from runtime method presence', async () => {
    const harness = createHarness();
    const runTerminalRemoteSessionModeLoopFn = vi.fn(async () => 0);
    (
      harness.runtime as unknown as Record<string, unknown>
    ).resolveTerminalRemoteSessionModeLoop = () => createTerminalRemoteModeLoopFixture();
    harness.deps.sessionLoopLifecycleDeps = {
      runTerminalRemoteSessionModeLoopFn,
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(runTerminalRemoteSessionModeLoopFn).not.toHaveBeenCalled();
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
    setTerminalRemoteModeLoop(harness.config, modeLoop);
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
    setTerminalRemoteModeLoop(harness.config, modeLoop);
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
    setTerminalRemoteModeLoop(harness.config, modeLoop);
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
    setTerminalRemoteModeLoop(harness.config, modeLoop);
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
    setTerminalRemoteModeLoop(harness.config, modeLoop);
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
    expect(publishedStates).toContainEqual(expect.objectContaining({
      terminalControl: {
        pendingHandoffV1: expect.objectContaining({
          status: 'switch_failed',
          pendingCount: 1,
          detail: 'remote_handoff_rejected',
        }),
      },
    }));
    expect(JSON.stringify(publishedStates)).not.toContain('switch handler unavailable');
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
    setTerminalRemoteModeLoop(harness.config, modeLoop);
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

  it('does not create the provider runtime while backend session initialization is pending', async () => {
    const harness = createHarness();
    let resolveInitialization!: () => void;
    const initializationGate = new Promise<void>((resolve) => {
      resolveInitialization = resolve;
    });
    const initializeBackendRunSessionFn = vi.fn(async () => {
      await initializationGate;
      return {
        session: harness.session,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: false,
      };
    });
    harness.deps.initializeBackendRunSessionFn = initializeBackendRunSessionFn;
    const createSessionRuntime = vi.fn(() => ({
      operations: harness.runtime,
      nativeRuntime: harness.runtime,
    }));
    setSessionRuntimeFactory(harness.config, createSessionRuntime);

    const runPromise = runHostSessionRuntime(harness.opts, harness.config, harness.deps);
    await vi.waitFor(() => {
      expect(initializeBackendRunSessionFn).toHaveBeenCalledOnce();
      expect(createSessionRuntime).not.toHaveBeenCalled();
    });

    resolveInitialization();
    await runPromise;
    expect(createSessionRuntime).toHaveBeenCalledOnce();
  });

  it('waits for exact persisted-takeover admission after input setup and before native runtime creation', async () => {
    const harness = createHarness();
    const admission = createDeferred<void>();
    const admit = vi.fn(async (correlation: Readonly<{ operationId: string; attemptId: string }>) => {
      expect(correlation).toEqual({
        operationId: 'operation-1',
        attemptId: 'attempt-1',
      });
      expect(
        harness.handlers.has(SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION),
      ).toBe(true);
      await admission.promise;
    });
    harness.opts.persistedTakeoverAdmission = {
      operationId: 'operation-1',
      attemptId: 'attempt-1',
    };
    harness.deps.admitPersistedTakeoverBeforeRuntimeFn = admit;
    harness.deps.reportPersistedTakeoverRuntimeBoundFn =
      vi.fn(async () => undefined);
    harness.session.materializeNextPendingMessageSafely = vi.fn(async () => ({
      type: 'no_pending' as const,
    }));
    const createSessionRuntime = vi.fn(() => ({
      operations: harness.runtime,
      nativeRuntime: harness.runtime,
    }));
    setSessionRuntimeFactory(harness.config, createSessionRuntime);

    const runPromise = runHostSessionRuntime(harness.opts, harness.config, harness.deps);
    await vi.waitFor(() => {
      expect(admit).toHaveBeenCalledOnce();
      expect(createSessionRuntime).not.toHaveBeenCalled();
    });
    expect(harness.session.materializeNextPendingMessageSafely).not.toHaveBeenCalled();
    expect(harness.session.wakePendingMaterialization).not.toHaveBeenCalled();
    expect(harness.session.sendAgentMessage).not.toHaveBeenCalled();
    expect(harness.metrics.defaultReadyCalls).toBe(0);

    admission.resolve();
    await runPromise;

    expect(createSessionRuntime).toHaveBeenCalledOnce();
    expect(createSessionRuntime).toHaveBeenCalledWith(
      expect.not.objectContaining({
        persistedTakeoverAdmission: expect.anything(),
      }),
    );
  });

  it('reports runtime_bound after required host bindings and before the long-lived loop', async () => {
    const harness = createHarness();
    const runtimeBound = createDeferred<void>();
    const reportRuntimeBound = vi.fn(async (
      correlation: Readonly<{ operationId: string; attemptId: string }>,
    ) => {
      expect(correlation).toEqual({
        operationId: 'operation-1',
        attemptId: 'attempt-1',
      });
      expect(harness.session.setSessionRuntimeControls).toHaveBeenCalledOnce();
      await runtimeBound.promise;
    });
    harness.opts.persistedTakeoverAdmission = {
      operationId: 'operation-1',
      attemptId: 'attempt-1',
    };
    harness.deps.admitPersistedTakeoverBeforeRuntimeFn = vi.fn(async () => undefined);
    harness.deps.reportPersistedTakeoverRuntimeBoundFn = reportRuntimeBound;
    harness.session.materializeNextPendingMessageSafely = vi.fn(async () => ({
      type: 'no_pending' as const,
    }));
    const runSessionLoopLifecycleFn = vi.fn(async () => undefined);
    harness.deps.runSessionLoopLifecycleFn = runSessionLoopLifecycleFn;
    setSessionRuntimeFactory(harness.config, vi.fn(() => ({
      operations: harness.runtime,
      nativeRuntime: harness.runtime,
    })));

    const runPromise = runHostSessionRuntime(harness.opts, harness.config, harness.deps);
    await vi.waitFor(() => {
      expect(reportRuntimeBound).toHaveBeenCalledOnce();
      expect(runSessionLoopLifecycleFn).not.toHaveBeenCalled();
    });
    expect(harness.session.materializeNextPendingMessageSafely).not.toHaveBeenCalled();
    expect(harness.session.wakePendingMaterialization).not.toHaveBeenCalled();
    expect(harness.session.sendAgentMessage).not.toHaveBeenCalled();

    runtimeBound.resolve();
    await runPromise;
    expect(runSessionLoopLifecycleFn).toHaveBeenCalledOnce();
  });

  it('does not enter the long-lived loop when runtime_bound remains ambiguous', async () => {
    const harness = createHarness();
    const ambiguousFailure = new Error(
      'persisted takeover runtime_bound response remained ambiguous',
    );
    harness.opts.persistedTakeoverAdmission = {
      operationId: 'operation-1',
      attemptId: 'attempt-1',
    };
    harness.deps.admitPersistedTakeoverBeforeRuntimeFn =
      vi.fn(async () => undefined);
    harness.deps.reportPersistedTakeoverRuntimeBoundFn = vi.fn(async () => {
      throw ambiguousFailure;
    });
    harness.session.materializeNextPendingMessageSafely = vi.fn(async () => ({
      type: 'no_pending' as const,
    }));
    const runSessionLoopLifecycleFn = vi.fn(async () => undefined);
    harness.deps.runSessionLoopLifecycleFn = runSessionLoopLifecycleFn;
    const createSessionRuntime = vi.fn(() => ({
      operations: harness.runtime,
      nativeRuntime: harness.runtime,
    }));
    setSessionRuntimeFactory(harness.config, createSessionRuntime);

    await expect(
      runHostSessionRuntime(harness.opts, harness.config, harness.deps),
    ).rejects.toBe(ambiguousFailure);

    expect(createSessionRuntime).toHaveBeenCalledOnce();
    expect(harness.session.setSessionRuntimeControls).toHaveBeenCalledOnce();
    expect(runSessionLoopLifecycleFn).not.toHaveBeenCalled();
    expect(harness.session.materializeNextPendingMessageSafely).not.toHaveBeenCalled();
    expect(harness.session.wakePendingMaterialization).not.toHaveBeenCalled();
    expect(harness.session.sendAgentMessage).not.toHaveBeenCalled();
  });

  it('routes the first persisted-takeover Agent output after runtime_bound through the hosted durable outbox', async () => {
    const previousHome = process.env.HAPPIER_HOME_DIR;
    const tempHome = await mkdtemp(join(tmpdir(), 'happier-persisted-takeover-output-'));
    process.env.HAPPIER_HOME_DIR = tempHome;
    const sessionId = 'persisted-takeover-hosted-output';
    const session = new ApiSessionClient(
      'token',
      createPlainSessionFixture({ id: sessionId }),
      { durableMutationDeliveryInitiallyActive: false },
    );

    try {
      const harness = createHarness();
      const correlation = {
        operationId: 'operation-hosted-output',
        attemptId: 'attempt-hosted-output',
      } as const;
      const order: string[] = [];
      const backend = createFakeAcpRuntimeBackend({ sessionId: 'native-session-1' });
      const initialSessionMetadata = session.getMetadataSnapshot();
      if (!initialSessionMetadata) {
        throw new Error('expected the canonical plain-session fixture metadata');
      }
      let sessionMetadata: Metadata = initialSessionMetadata;
      session.updateMetadata = async (update: (metadata: Metadata) => Metadata) => {
        sessionMetadata = update(sessionMetadata);
      };
      session.getMetadataSnapshot = () => sessionMetadata;
      session.enqueueRegisteredSessionStateFieldMutation = async () => undefined;
      session.refreshSessionSnapshotFromServerRequired = async () => undefined;

      harness.opts.persistedTakeoverAdmission = correlation;
      harness.deps.initializeBackendRunSessionFn = async () => ({
        session,
        reconnectionHandle: null,
        reportedSessionId: sessionId,
        attachedToExistingSession: true,
      });
      harness.deps.admitPersistedTakeoverBeforeRuntimeFn = vi.fn(async (actual) => {
        expect(actual).toEqual(correlation);
        order.push('admit');
      });
      harness.deps.reportPersistedTakeoverRuntimeBoundFn = vi.fn(async (actual) => {
        expect(actual).toEqual(correlation);
        order.push('runtime_bound');
      });
      harness.config.policyAgentId = 'claude';
      harness.config.providerName = 'Claude';
      harness.config.agentMessageType = 'claude';
      setSessionRuntimeFactory(harness.config, (params) => {
        const runtime = createAcpRuntime({
          provider: 'claude',
          directory: params.directory,
          happierSessionId: sessionId,
          session: params.session,
          transcriptSession: params.transcriptSession,
          messageBuffer: params.messageBuffer,
          mcpServers: params.mcpServers,
          permissionHandler: createApprovedPermissionHandler(),
          onThinkingChange: params.setThinking,
          ensureBackend: async () => backend,
        });
        return {
          operations: runtime,
          nativeRuntime: runtime,
        };
      });
      harness.deps.runSessionLoopLifecycleFn = async ({
        runtime,
      }: Readonly<{ runtime: ReturnType<typeof createAcpRuntime> }>) => {
        expect(order).toEqual(['admit', 'runtime_bound']);
        await runtime.sendTurnPrompt('Begin the hosted turn');
        runtime.beginTurnLifecycle();
        backend.emit({
          type: 'model-output',
          textDelta: 'First hosted answer',
        } satisfies AgentMessage);
        order.push('provider_output');
        await runtime.waitForTurnCompletion();
      };

      await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

      const persisted = JSON.parse(
        await readFile(resolveSessionClientDurableMutationOutboxPath(sessionId), 'utf8'),
      ) as { mutations?: unknown[] };
      const mutations = Array.isArray(persisted.mutations) ? persisted.mutations : [];
      const transcriptMutations = mutations.filter((entry) => (
        entry
        && typeof entry === 'object'
        && (entry as { kind?: unknown }).kind === 'transcript_message_append'
      ));

      expect(order).toEqual(['admit', 'runtime_bound', 'provider_output']);
      expect(transcriptMutations).toHaveLength(1);
      expect(transcriptMutations[0]).toMatchObject({
        kind: 'transcript_message_append',
        payload: {
          sessionId,
          source: 'transcript_message_append',
          messageRole: 'agent',
          content: {
            t: 'plain',
            v: {
              role: 'agent',
              content: {
                data: {
                  type: 'message',
                  message: 'First hosted answer',
                },
              },
            },
          },
        },
      });
      expect(JSON.stringify(mutations)).not.toContain('external_session_historical_import');
    } finally {
      await resetSessionClientDurableMutationOutboxStateForTests();
      await rm(tempHome, { recursive: true, force: true });
      if (previousHome === undefined) {
        delete process.env.HAPPIER_HOME_DIR;
      } else {
        process.env.HAPPIER_HOME_DIR = previousHome;
      }
    }
  });

  it('consumes the one-shot persisted-takeover environment handoff even when an injected correlation wins', async () => {
    const previousAdmission =
      process.env[HAPPIER_PERSISTED_TAKEOVER_ADMISSION_ENV_KEY];
    process.env[HAPPIER_PERSISTED_TAKEOVER_ADMISSION_ENV_KEY] =
      serializePersistedTakeoverAdmissionForEnv({
        operationId: 'stale-operation',
        attemptId: 'stale-attempt',
      });
    try {
      const harness = createHarness();
      const admit = vi.fn(async () => undefined);
      harness.opts.persistedTakeoverAdmission = {
        operationId: 'operation-1',
        attemptId: 'attempt-1',
      };
      harness.deps.admitPersistedTakeoverBeforeRuntimeFn = admit;
      harness.deps.reportPersistedTakeoverRuntimeBoundFn =
        vi.fn(async () => undefined);

      await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

      expect(admit).toHaveBeenCalledWith({
        operationId: 'operation-1',
        attemptId: 'attempt-1',
      });
      expect(
        process.env[HAPPIER_PERSISTED_TAKEOVER_ADMISSION_ENV_KEY],
      ).toBeUndefined();
    } finally {
      if (previousAdmission === undefined) {
        delete process.env[HAPPIER_PERSISTED_TAKEOVER_ADMISSION_ENV_KEY];
      } else {
        process.env[HAPPIER_PERSISTED_TAKEOVER_ADMISSION_ENV_KEY] =
          previousAdmission;
      }
    }
  });

  it('opens no native runtime when persisted-takeover admission fails ambiguously', async () => {
    const harness = createHarness();
    const ambiguousFailure = new Error('persisted takeover admission response was ambiguous');
    const admit = vi.fn(async () => {
      throw ambiguousFailure;
    });
    harness.opts.persistedTakeoverAdmission = {
      operationId: 'operation-2',
      attemptId: 'attempt-2',
    };
    harness.deps.admitPersistedTakeoverBeforeRuntimeFn = admit;
    harness.session.materializeNextPendingMessageSafely = vi.fn(async () => ({
      type: 'no_pending' as const,
    }));
    const createSessionRuntime = vi.fn(() => ({
      operations: harness.runtime,
      nativeRuntime: harness.runtime,
    }));
    setSessionRuntimeFactory(harness.config, createSessionRuntime);

    await expect(
      runHostSessionRuntime(harness.opts, harness.config, harness.deps),
    ).rejects.toBe(ambiguousFailure);

    expect(admit).toHaveBeenCalledOnce();
    expect(createSessionRuntime).not.toHaveBeenCalled();
    expect(harness.session.materializeNextPendingMessageSafely).not.toHaveBeenCalled();
    expect(harness.session.wakePendingMaterialization).not.toHaveBeenCalled();
    expect(harness.session.sendAgentMessage).not.toHaveBeenCalled();
    expect(harness.metrics.defaultReadyCalls).toBe(0);
  });

  it('fails closed as upgrade-required when the daemon reports persisted-takeover admission unsupported', async () => {
    const harness = createHarness();
    harness.opts.persistedTakeoverAdmission = {
      operationId: 'operation-3',
      attemptId: 'attempt-3',
    };
    harness.deps.admitPersistedTakeoverBeforeRuntimeFn = async () => {
      throw Object.assign(
        new Error('Persisted takeover admission requires a current daemon'),
        { code: 'persisted_takeover_admission_upgrade_required' },
      );
    };
    const createSessionRuntime = vi.fn(() => ({
      operations: harness.runtime,
      nativeRuntime: harness.runtime,
    }));
    setSessionRuntimeFactory(harness.config, createSessionRuntime);

    await expect(
      runHostSessionRuntime(harness.opts, harness.config, harness.deps),
    ).rejects.toMatchObject({
      code: 'persisted_takeover_admission_upgrade_required',
    });

    expect(createSessionRuntime).not.toHaveBeenCalled();
  });

  it('does not invoke persisted-takeover admission for an ordinary host runtime start', async () => {
    const harness = createHarness();
    const admit = vi.fn(async () => undefined);
    const reportRuntimeBound = vi.fn(async () => undefined);
    harness.deps.admitPersistedTakeoverBeforeRuntimeFn = admit;
    harness.deps.reportPersistedTakeoverRuntimeBoundFn = reportRuntimeBound;

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(admit).not.toHaveBeenCalled();
    expect(reportRuntimeBound).not.toHaveBeenCalled();
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

    expect(initialSession.updateMetadata).toHaveBeenCalledTimes(1);
    expect(swappedSession.updateMetadata).toHaveBeenCalledTimes(1);
  });

  it('binds exact and legacy provider outcomes to the one current-session host normalizer', async () => {
    const harness = createHarness();
    let deliveryHandler: ((outcome: any) => void) | null = null;
    let acceptedHandler: ((info: any) => void) | null = null;
    let rejectedHandler: ((info: any) => void) | null = null;
    let blockerClearedHandler: ((info: any) => void) | null = null;
    const observedSettlements: unknown[] = [];
    harness.session.hasPendingProviderInput = vi.fn(() => true);
    harness.session.observeProviderInputSettlement = vi.fn((outcome: unknown) => {
      observedSettlements.push(outcome);
    });
    const runtime = {
      ...harness.runtime,
      setOnPromptDeliveryOutcome: vi.fn((handler: ((outcome: any) => void) | null) => {
        deliveryHandler = handler;
      }),
      setOnPromptAcceptedByProvider: vi.fn((handler: ((info: any) => void) | null) => {
        acceptedHandler = handler;
      }),
      setOnPromptTerminallyRejectedBeforeProvider: vi.fn((handler: ((info: any) => void) | null) => {
        rejectedHandler = handler;
      }),
      setOnPromptDeliveryBlockerCleared: vi.fn((handler: ((info: any) => void) | null) => {
        blockerClearedHandler = handler;
      }),
    };
    setSessionRuntimeFactory(harness.config, () => ({ operations: runtime, nativeRuntime: runtime }));
    harness.deps.runSessionLoopLifecycleFn = async (params: any) => {
      params.onProviderPromptDispatchPrepared({
        localIds: ['local-exact'],
        selection: {
          agentTargetKey: 'backend:qwen',
          providerConnectionId: null,
          modelId: 'model-at-dispatch',
        },
      });
      deliveryHandler?.({
        type: 'input-accepted',
        localId: 'local-exact',
        userMessageSeq: 21,
        userMessageSeqs: [21],
        delivery: { kind: 'newTurn', turnId: 'turn-exact' },
      });
      acceptedHandler?.({
        localIds: ['local-legacy'],
        userMessageSeq: 22,
        userMessageSeqs: [22],
      });
      rejectedHandler?.({
        localIds: ['local-blocked'],
        userMessageSeq: 23,
        userMessageSeqs: [23],
        deliveryBlockedReason: 'runtime_config_blocked',
      });
      blockerClearedHandler?.({ deliveryBlockedReason: 'runtime_config_blocked' });
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(observedSettlements).toEqual([
      {
        kind: 'accepted',
        localId: 'local-exact',
        userMessageSeq: 21,
        userMessageSeqs: [21],
        providerTurnId: 'turn-exact',
        providerDeliveryKind: 'newTurn',
        appliedModel: {
          provider: 'qwen',
          selection: {
            agentTargetKey: 'backend:qwen',
            providerConnectionId: null,
            modelId: 'model-at-dispatch',
          },
        },
      },
      {
        kind: 'accepted',
        localId: 'local-legacy',
        userMessageSeq: 22,
        userMessageSeqs: [22],
      },
      {
        kind: 'rejected_before_effect',
        localId: 'local-blocked',
        userMessageSeq: 23,
        userMessageSeqs: [23],
        reason: 'runtime_config_blocked',
        diagnostic: { code: 'runtime_config_blocked', severity: 'error' },
        retryable: true,
      },
    ]);
    expect(harness.session.wakePendingMaterialization).toHaveBeenCalledTimes(1);
    expect(runtime.setOnPromptDeliveryOutcome).toHaveBeenLastCalledWith(null);
    expect(runtime.setOnPromptAcceptedByProvider).toHaveBeenLastCalledWith(null);
    expect(runtime.setOnPromptTerminallyRejectedBeforeProvider).toHaveBeenLastCalledWith(null);
    expect(runtime.setOnPromptDeliveryBlockerCleared).toHaveBeenLastCalledWith(null);
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

  it('registers the exact model-transition RPC on the active swapped session manager', async () => {
    const harness = createHarness();
    const swappedSessionFixture = harness.createSessionFixture('session-2');
    let swappedMetadata: any = {
      path: '/tmp/workspace',
      permissionMode: 'default',
    };
    swappedSessionFixture.session.getMetadataSnapshot = () => swappedMetadata;
    swappedSessionFixture.session.updateMetadata.mockImplementation(
      async (update: unknown) => {
        swappedMetadata = typeof update === 'function'
          ? (update as (metadata: typeof swappedMetadata) => typeof swappedMetadata)(swappedMetadata)
          : update;
      },
    );

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
      const transition = swappedSessionFixture.handlers.get(
        SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION,
      );
      expect(transition).toBeTypeOf('function');
      const runtimeUpdateCount = harness.runtime.updateSessionRuntimeConfig.mock.calls.length;
      const selection = {
        agentTargetKey: 'backend:qwen',
        providerConnectionId: null,
        modelId: 'default',
      } as const;

      await expect(transition?.({ v: 1, selection })).resolves.toEqual({
        ok: true,
        status: 'already_active',
        activeSelection: selection,
      });
      expect(swappedMetadata.modelSelectionIntentV1).toMatchObject({
        v: 1,
        selection,
      });
      expect(harness.runtime.updateSessionRuntimeConfig).toHaveBeenCalledTimes(
        runtimeUpdateCount,
      );
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('binds the model coordinator before refresh, then reconciles fresh intent before activating durable delivery and entering the loop', async () => {
    const harness = createHarness();
    const order: string[] = [];
    const freshSelection = {
      agentTargetKey: 'backend:qwen',
      providerConnectionId: null,
      modelId: 'fresh-model',
    } as const;
    let metadata: any = {
      path: '/tmp/workspace',
      permissionMode: 'default',
    };
    harness.session.getMetadataSnapshot = () => metadata;
    harness.session.updateMetadata.mockImplementation(async (update: unknown) => {
      metadata = typeof update === 'function'
        ? (update as (current: typeof metadata) => typeof metadata)(metadata)
        : update;
    });
    harness.session.rpcHandlerManager.registerHandler = vi.fn(
      (name: string, handler: (payload?: unknown) => unknown) => {
        harness.handlers.set(name, handler);
        if (name === SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION) {
          order.push('handler');
        }
      },
    );
    harness.session.claimCurrentSessionPublisherAuthorityForStartup = vi.fn(
      async () => {
        expect(harness.handlers.has(
          SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION,
        )).toBe(true);
        order.push('claim');
        return { status: 'claimed' as const };
      },
    );
    harness.session.activateDurableMutationDelivery = vi.fn(async () => {
      expect(harness.handlers.has(
        SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION,
      )).toBe(true);
      expect(order).toEqual([
        'runtime',
        'handler',
        'claim',
        'refresh',
        'reconcile',
      ]);
      order.push('durable-delivery');
    });
    harness.session.refreshSessionSnapshotFromServerRequired = vi.fn(
      async () => {
        order.push('refresh');
        metadata = {
          ...metadata,
          modelSelectionIntentV1: {
            v: 1,
            updatedAt: 41,
            selection: freshSelection,
          },
        };
      },
    );
    harness.runtime.updateSessionRuntimeConfig.mockImplementation(
      async (update: { modelId?: string | null }) => {
        if (update.modelId === freshSelection.modelId) {
          order.push('reconcile');
        }
        return { status: 'applied' as const };
      },
    );
    setSessionRuntimeFactory(harness.config, () => {
      order.push('runtime');
      return {
        operations: harness.runtime,
        nativeRuntime: harness.runtime,
      };
    });
    harness.deps.runSessionLoopLifecycleFn = async () => {
      order.push('loop');
      expect(order).toEqual([
        'runtime',
        'handler',
        'claim',
        'refresh',
        'reconcile',
        'durable-delivery',
        'loop',
      ]);
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(harness.session.refreshSessionSnapshotFromServerRequired).toHaveBeenCalledWith({
      reason: 'startup-drain',
    });
  });

  it('holds active model-transition RPC effects until the claimed owner reconciles the required authoritative refresh', async () => {
    const harness = createHarness();
    const refreshEntered = createDeferred<void>();
    const releaseRefresh = createDeferred<void>();
    const releaseLoop = createDeferred<void>();
    const order: string[] = [];
    const persistedSelection = {
      agentTargetKey: 'backend:qwen',
      providerConnectionId: null,
      modelId: 'persisted-before-claim',
    } as const;
    const commandSelection = {
      agentTargetKey: 'backend:qwen',
      providerConnectionId: null,
      modelId: 'command-after-claim',
    } as const;
    let metadata: any = {
      path: '/tmp/workspace',
      permissionMode: 'default',
    };
    harness.session.getMetadataSnapshot = () => metadata;
    harness.session.updateMetadata.mockImplementation(async (update: unknown) => {
      metadata = typeof update === 'function'
        ? (update as (current: typeof metadata) => typeof metadata)(metadata)
        : update;
    });
    harness.session.claimCurrentSessionPublisherAuthorityForStartup = vi.fn(
      async () => {
        order.push('claim');
        return { status: 'claimed' as const };
      },
    );
    harness.session.refreshSessionSnapshotFromServerRequired = vi.fn(
      async () => {
        order.push('refresh:start');
        refreshEntered.resolve();
        await releaseRefresh.promise;
        metadata = {
          ...metadata,
          modelSelectionIntentV1: {
            v: 1,
            updatedAt: 41,
            selection: persistedSelection,
          },
        };
        order.push('refresh:end');
      },
    );
    harness.runtime.updateSessionRuntimeConfig.mockImplementation(
      async (update: { modelId?: string | null }) => {
        if (typeof update.modelId === 'string') {
          order.push(`apply:${update.modelId}`);
        }
        return { status: 'applied' as const };
      },
    );
    harness.session.activateDurableMutationDelivery = vi.fn(async () => {
      order.push('durable-delivery');
    });
    harness.deps.runSessionLoopLifecycleFn = async () => {
      order.push('loop');
      await releaseLoop.promise;
    };

    const run = runHostSessionRuntime(
      harness.opts,
      harness.config,
      harness.deps,
    );
    await refreshEntered.promise;

    const transition = harness.handlers.get(
      SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION,
    );
    expect(transition).toBeTypeOf('function');
    let commandSettled = false;
    const command = Promise.resolve(
      transition?.({ v: 1, selection: commandSelection }),
    ).then((result) => {
      commandSettled = true;
      order.push('command:settled');
      return result;
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const commandSettledBeforeRefresh = commandSettled;
    const commandAppliedBeforeRefresh = order.includes(
      `apply:${commandSelection.modelId}`,
    );

    releaseRefresh.resolve();
    const commandResult = await command.finally(() => {
      releaseLoop.resolve();
    });
    await run;

    expect(commandSettledBeforeRefresh).toBe(false);
    expect(commandAppliedBeforeRefresh).toBe(false);
    expect(order.indexOf(`apply:${persistedSelection.modelId}`)).toBeLessThan(
      order.indexOf(`apply:${commandSelection.modelId}`),
    );
    expect(commandResult).toMatchObject({
      ok: true,
      activeSelection: commandSelection,
    });
    expect(order).toContain('durable-delivery');
    expect(order).toContain('loop');
  });

  it('keeps released-server startup compatible while refusing model-transition RPCs without authoritative routing', async () => {
    const harness = createHarness();
    harness.session.claimCurrentSessionPublisherAuthorityForStartup = vi.fn(
      async () => ({ status: 'unsupported' as const }),
    );
    let transitionRejection: unknown = null;
    harness.deps.runSessionLoopLifecycleFn = async () => {
      const transition = harness.handlers.get(
        SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION,
      );
      expect(transition).toBeTypeOf('function');
      try {
        await transition?.({
          v: 1,
          selection: {
            agentTargetKey: 'backend:qwen',
            providerConnectionId: null,
            modelId: 'must-not-apply',
          },
        });
      } catch (error) {
        transitionRejection = error;
      }
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(transitionRejection).toBeInstanceOf(Error);
    expect(harness.runtime.updateSessionRuntimeConfig).not.toHaveBeenCalled();
    expect(
      harness.session.activateDurableMutationDelivery,
    ).toHaveBeenCalledTimes(1);
  });

  it('strictly refreshes before immediate runtime-model publication and activates durable delivery after publication', async () => {
    const harness = createHarness();
    const order: string[] = [];
    let metadata: any = {
      path: '/tmp/workspace',
      permissionMode: 'default',
    };
    const modelsSnapshot = {
      currentModelId: 'current-model',
      models: [
        { id: 'current-model', name: 'Current model' },
      ],
    };
    harness.runtime.models = {
      read: () => modelsSnapshot,
      subscribe: (
        listener: (snapshot: typeof modelsSnapshot) => void,
      ) => {
        listener(modelsSnapshot);
        return { dispose: () => undefined };
      },
    };
    harness.session.getMetadataSnapshot = () => metadata;
    harness.session.updateMetadata.mockImplementation(async (update: unknown) => {
      const previous = metadata;
      const next: typeof metadata = typeof update === 'function'
        ? (update as (current: typeof metadata) => typeof metadata)(metadata)
        : update as typeof metadata;
      if (
        previous.sessionModelsV1 === undefined
        && next.sessionModelsV1 !== undefined
      ) {
        order.push('models');
      }
      metadata = next;
    });
    harness.session.refreshSessionSnapshotFromServerRequired = vi.fn(
      async () => {
        order.push('refresh');
      },
    );
    harness.session.claimCurrentSessionPublisherAuthorityForStartup = vi.fn(
      async () => {
        order.push('claim');
        return { status: 'claimed' as const };
      },
    );
    harness.session.activateDurableMutationDelivery = vi.fn(async () => {
      order.push('durable-delivery');
    });
    harness.deps.runSessionLoopLifecycleFn = async () => {
      order.push('loop');
      expect(order).toEqual([
        'claim',
        'refresh',
        'models',
        'durable-delivery',
        'loop',
      ]);
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('drains queued runtime-model publication before terminal session close', async () => {
    const harness = createHarness();
    const order: string[] = [];
    let closed = false;
    let releaseMetadataWrite!: () => void;
    const metadataWriteReleased = new Promise<void>((resolve) => {
      releaseMetadataWrite = resolve;
    });
    let notifyMetadataWriteStarted!: () => void;
    const metadataWriteStarted = new Promise<void>((resolve) => {
      notifyMetadataWriteStarted = resolve;
    });
    let blockMetadataWrites = false;
    let modelListener: ((snapshot: { models: readonly { id: string; name: string }[] | null }) => void) | null = null;
    harness.runtime.models = {
      read: () => ({ models: null }),
      subscribe: (listener: (snapshot: { models: readonly { id: string; name: string }[] | null }) => void) => {
        modelListener = listener;
        listener({ models: null });
        return { dispose: () => { modelListener = null; } };
      },
    };
    harness.session.updateMetadata.mockImplementation(async () => {
      if (!blockMetadataWrites) return;
      order.push('metadata:start');
      notifyMetadataWriteStarted();
      await metadataWriteReleased;
      if (closed) throw new Error('session_closed');
      order.push('metadata:end');
    });
    harness.session.close.mockImplementation(async () => {
      closed = true;
      order.push('close');
    });
    harness.deps.runSessionLoopLifecycleFn = async (params: {
      deps: { onBeforeSessionClose?: () => Promise<void> };
      session: { close(): Promise<void> };
      startupCoordinator?: { start(): Promise<void> } | null;
    }) => {
      await params.startupCoordinator?.start();
      blockMetadataWrites = true;
      modelListener?.({ models: [{ id: 'runtime', name: 'Runtime' }] });
      await metadataWriteStarted;
      const onBeforeSessionClose = params.deps.onBeforeSessionClose;
      expect(onBeforeSessionClose).toBeTypeOf('function');
      let drained = false;
      const drain = onBeforeSessionClose!().then(() => { drained = true; });
      await new Promise((resolve) => setImmediate(resolve));
      expect(drained).toBe(false);
      expect(order).toEqual(['metadata:start']);
      releaseMetadataWrite();
      await drain;
      await params.session.close();
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(order).toEqual(['metadata:start', 'metadata:end', 'close']);
  });

  it('fails startup closed without activating durable delivery when the required authoritative refresh fails', async () => {
    const harness = createHarness();
    const refreshFailure = new Error('authoritative refresh unavailable');
    const runSessionLoopLifecycleFn = vi.fn(async () => undefined);
    harness.deps.runSessionLoopLifecycleFn = runSessionLoopLifecycleFn;
    harness.session.refreshSessionSnapshotFromServerRequired = vi.fn(async () => {
      throw refreshFailure;
    });

    await expect(
      runHostSessionRuntime(harness.opts, harness.config, harness.deps),
    ).rejects.toBe(refreshFailure);

    expect(harness.handlers.has(
      SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION,
    )).toBe(true);
    expect(
      harness.session.activateDurableMutationDelivery,
    ).not.toHaveBeenCalled();
    expect(runSessionLoopLifecycleFn).not.toHaveBeenCalled();
  });

  it('classifies a spawn-only Agent native model change as restart-required before runtime effect', async () => {
    const harness = createHarness();
    let metadata: Record<string, unknown> = {
      path: '/tmp/workspace',
      permissionMode: 'default',
    };
    harness.session.getMetadataSnapshot = () => metadata;
    harness.session.updateMetadata.mockImplementation(async (
      update:
        | Record<string, unknown>
        | ((current: Record<string, unknown>) => Record<string, unknown>),
    ) => {
      metadata = typeof update === 'function' ? update(metadata) : update;
    });
    harness.config.policyAgentId = 'codex';
    harness.opts.modelSelection = {
      v: 1,
      updatedAt: 1,
      ref: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: null,
        modelId: 'old-model',
      },
    };

    harness.deps.runPermissionModePromptLoopFn = async () => {
      const transition = harness.handlers.get(
        SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION,
      );
      const selection = {
        agentTargetKey: 'backend:codex',
        providerConnectionId: null,
        modelId: 'next-model',
      } as const;
      const runtimeUpdateCount =
        harness.runtime.updateSessionRuntimeConfig.mock.calls.length;

      await expect(transition?.({ v: 1, selection })).resolves.toMatchObject({
        ok: false,
        status: 'restart_required',
        activeSelection: harness.opts.modelSelection?.ref,
        requestedSelection: selection,
      });
      expect(harness.runtime.updateSessionRuntimeConfig).toHaveBeenCalledTimes(
        runtimeUpdateCount,
      );
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('atomically transfers the run-host model fence into prompt dispatch custody', async () => {
    const harness = createHarness();
    const activeSelection = {
      agentTargetKey: 'backend:qwen',
      providerConnectionId: null,
      modelId: 'active-model',
    } as const;
    harness.opts.modelSelection = {
      v: 1,
      updatedAt: 1,
      ref: activeSelection,
    };
    let metadata: any = {
      path: '/tmp/workspace',
      permissionMode: 'default',
      modelSelectionIntentV1: {
        v: 1,
        updatedAt: 1,
        selection: activeSelection,
      },
    };
    harness.session.getMetadataSnapshot = () => metadata;
    harness.session.updateMetadata.mockImplementation(
      async (update: unknown) => {
        metadata = typeof update === 'function'
          ? (update as (current: typeof metadata) => typeof metadata)(metadata)
          : update;
      },
    );
    harness.deps.runSessionLoopLifecycleFn = async (params: any) => {
      let providerAccepted = false;
      const result = await params.transitionModelSelection(
        activeSelection,
        'prompt',
        async (transferPromptAdmission: (opts: {
          abortSignal: AbortSignal;
          dispatch: () => Promise<void>;
        }) => Promise<{ status: 'dispatched' | 'cancelled' }>) => {
          const outcome = await transferPromptAdmission({
            abortSignal: new AbortController().signal,
            dispatch: async () => {
              providerAccepted = true;
            },
          });
          expect(outcome.status).toBe('dispatched');
        },
      );
      expect(result).toMatchObject({
        ok: true,
        status: 'already_active',
        activeSelection,
      });
      expect(providerAccepted).toBe(true);
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('keeps input fenced when a live transition returns no authoritative runtime outcome', async () => {
    const harness = createHarness();
    harness.opts.modelSelection = {
      v: 1,
      updatedAt: 1,
      ref: {
        agentTargetKey: 'backend:qwen',
        providerConnectionId: null,
        modelId: 'old-model',
      },
    };
    let metadata: any = {
      path: '/tmp/workspace',
      permissionMode: 'default',
      modelSelectionIntentV1: {
        v: 1,
        updatedAt: 1,
        selection: harness.opts.modelSelection.ref,
      },
    };
    harness.session.getMetadataSnapshot = () => metadata;
    harness.session.updateMetadata.mockImplementation(
      async (update: unknown) => {
        metadata = typeof update === 'function'
          ? (update as (current: typeof metadata) => typeof metadata)(metadata)
          : update;
      },
    );
    harness.runtime.updateSessionRuntimeConfig.mockResolvedValue(undefined);

    harness.deps.runPermissionModePromptLoopFn = async () => {
      const transition = harness.handlers.get(
        SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION,
      );
      const selection = {
        agentTargetKey: 'backend:qwen',
        providerConnectionId: null,
        modelId: 'next-model',
      } as const;

      await expect(transition?.({ v: 1, selection })).resolves.toMatchObject({
        ok: false,
        status: 'reconciliation_required',
        activeSelection: null,
        requestedSelection: selection,
        reason: 'runtime_model_transition_outcome_unproven',
      });
      expect(metadata.modelSelectionIntentV1.selection).toEqual(selection);
      expect(metadata.sessionModelsV1).toMatchObject({
        currentModelId: 'old-model',
      });
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('publishes active facts and releases input after exact live-runtime model readback', async () => {
    const harness = createHarness();
    harness.opts.modelSelection = {
      v: 1,
      updatedAt: 1,
      ref: {
        agentTargetKey: 'backend:qwen',
        providerConnectionId: null,
        modelId: 'old-model',
      },
    };
    let metadata: any = {
      path: '/tmp/workspace',
      permissionMode: 'default',
      modelSelectionIntentV1: {
        v: 1,
        updatedAt: 1,
        selection: harness.opts.modelSelection.ref,
      },
    };
    let currentModelId = 'old-model';
    const readModels = () => ({
      currentModelId,
      models: [
        { id: 'old-model', name: 'Old model' },
        { id: 'next-model', name: 'Next model' },
      ],
    });
    harness.runtime.models = {
      read: readModels,
      subscribe: (listener: (snapshot: ReturnType<typeof readModels>) => void) => {
        listener(readModels());
        return { dispose: () => undefined };
      },
    };
    harness.session.getMetadataSnapshot = () => metadata;
    harness.session.updateMetadata.mockImplementation(
      async (update: unknown) => {
        metadata = typeof update === 'function'
          ? (update as (current: typeof metadata) => typeof metadata)(metadata)
          : update;
      },
    );
    harness.runtime.updateSessionRuntimeConfig.mockImplementation(
      async (update: { modelId?: string | null }) => {
        if (typeof update.modelId === 'string') {
          currentModelId = update.modelId;
        }
        return undefined;
      },
    );

    harness.deps.runPermissionModePromptLoopFn = async () => {
      const transition = harness.handlers.get(
        SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION,
      );
      const selection = {
        agentTargetKey: 'backend:qwen',
        providerConnectionId: null,
        modelId: 'next-model',
      } as const;

      await expect(transition?.({ v: 1, selection })).resolves.toMatchObject({
        ok: true,
        status: 'applied',
        activeSelection: selection,
      });
      expect(metadata.modelSelectionIntentV1.selection).toEqual(selection);
      expect(metadata.sessionModelsV1.currentModelId).toBe('next-model');
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('starts fresh provider input admitted after passive connected-service metadata reconstruction', async () => {
    const harness = createHarness();
    const connectedServices = {
      v: 1 as const,
      bindingsByServiceId: {
        'openai-codex': {
          source: 'connected' as const,
          selection: 'group' as const,
          profileId: 'primary',
          groupId: 'team',
        },
      },
    };
    harness.deps.createSessionMetadataFn = () => ({
      state: { controlledByUser: false },
      metadata: {
        path: '/tmp/workspace',
        permissionMode: 'default',
        permissionModeUpdatedAt: Date.now(),
        connectedServices,
      },
    });
    const swappedSessionFixture = harness.createSessionFixture('session-2');
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

    harness.deps.runPermissionModePromptLoopFn = async (params: Readonly<{ inputConsumer?: any }>) => {
      const consumer = params.inputConsumer;
      expect(consumer?.readProviderInputAdmission()).toEqual({ kind: 'admitted' });
      const initialRpc = harness.handlers.get(SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION);
      expect(initialRpc).toBeTypeOf('function');

      await swapSession?.(swappedSessionFixture.session);
      const swappedRpc = swappedSessionFixture.handlers.get(SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION);
      expect(swappedRpc).toBeTypeOf('function');
      expect(consumer.readProviderInputAdmission()).toEqual({ kind: 'admitted' });
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
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

  it('keeps a constructed replacement inactive until swap apply then deactivates and closes the prior client', async () => {
    const harness = createHarness();
    const order: string[] = [];
    const initialSession = harness.session;
    const replacement = harness.createSessionFixture('session-1').session;
    initialSession.deactivateDurableMutationDelivery = vi.fn(() => order.push('old:deactivate'));
    initialSession.close = vi.fn(async () => { order.push('old:close'); });
    replacement.stageInitialDurableMutationSnapshots = vi.fn(async () => { order.push('replacement:stage'); });
    replacement.activateDurableMutationDelivery = vi.fn(async () => { order.push('replacement:activate'); });
    replacement.flushDurableMutationDelivery = vi.fn(async () => { order.push('replacement:flush'); });
    let pendingApply: (() => Promise<void>) | null = null;
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
    harness.deps.initializeBackendRunSessionFn = async ({ onSessionSwap }: any) => {
      await onSessionSwap(replacement);
      expect(order).toEqual([]);
      expect(initialSession.close).not.toHaveBeenCalled();
      return {
        session: initialSession,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: false,
      };
    };
    harness.deps.runPermissionModePromptLoopFn = async (params: Readonly<{
      onAfterLoopBoundary?: (args: { reason: 'turn_completed' }) => Promise<void> | void;
    }>) => {
      expect(order).toEqual([]);
      await params.onAfterLoopBoundary?.({ reason: 'turn_completed' });
      expect(order).toEqual([
        'old:deactivate',
        'replacement:stage',
        'replacement:activate',
        'old:close',
        'replacement:flush',
      ]);
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('retains Activity slot truth across a same-session client swap', async () => {
    const harness = createHarness();
    harness.config.runtimeActivityApplicability = 'supported';
    const initialSession = harness.session;
    const replacement = harness.createSessionFixture('session-1').session;
    const runtimeActivityHandlers = new Set<(event: any) => void>();
    const unsubscribeRuntimeActivity = vi.fn();
    harness.runtime.subscribeCanonicalAgentSessionEvents = vi.fn((handler: (event: any) => void) => {
      runtimeActivityHandlers.add(handler);
      return () => {
        runtimeActivityHandlers.delete(handler);
        unsubscribeRuntimeActivity();
      };
    });
    let pendingApply: (() => Promise<void>) | null = null;
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
    harness.deps.initializeBackendRunSessionFn = async ({ onSessionSwap }: any) => {
      await onSessionSwap(replacement);
      return {
        session: initialSession,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: false,
      };
    };
    harness.deps.runPermissionModePromptLoopFn = async (params: Readonly<{
      onAfterLoopBoundary?: (args: { reason: 'turn_completed' }) => Promise<void> | void;
    }>) => {
      for (const handler of runtimeActivityHandlers) {
        handler({
          kind: 'runtime-activity-snapshot',
          sequence: 1,
          sessionId: 'session-1',
          emittedAtMs: 1,
          state: 'active',
          activeCount: 1,
        });
      }
      await vi.waitFor(() => expect(initialSession.enqueueRegisteredSessionStateFieldMutation)
        .toHaveBeenLastCalledWith(expect.objectContaining({
          op: { kind: 'set', value: { state: 'active', activeCount: 1 } },
        })));

      await params.onAfterLoopBoundary?.({ reason: 'turn_completed' });

      expect(harness.runtime.subscribeCanonicalAgentSessionEvents).toHaveBeenCalledTimes(1);
      expect(unsubscribeRuntimeActivity).not.toHaveBeenCalled();
      expect(replacement.enqueueRegisteredSessionStateFieldMutation)
        .toHaveBeenLastCalledWith(expect.objectContaining({
          op: { kind: 'set', value: { state: 'active', activeCount: 1 } },
        }));

      for (const handler of runtimeActivityHandlers) {
        handler({
          kind: 'runtime-activity-snapshot',
          sequence: 2,
          sessionId: 'session-1',
          emittedAtMs: 2,
          state: 'idle',
          activeCount: 0,
        });
      }
      await vi.waitFor(() => expect(replacement.enqueueRegisteredSessionStateFieldMutation)
        .toHaveBeenLastCalledWith(expect.objectContaining({
          op: { kind: 'set', value: { state: 'idle', activeCount: 0 } },
        })));
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('rebinds Activity across a different-session client swap and fences the retired subscriber', async () => {
    const harness = createHarness();
    harness.config.runtimeActivityApplicability = 'supported';
    loggerDebugMock.mockClear();
    const initialSession = harness.session;
    const replacement = harness.createSessionFixture('session-2').session;
    const subscriptions: Array<{
      handler: (event: any) => void;
      unsubscribe: ReturnType<typeof vi.fn>;
    }> = [];
    const hostile = Proxy.revocable({}, {});
    hostile.revoke();
    harness.runtime.subscribeCanonicalAgentSessionEvents = vi.fn((handler: (event: any) => void) => {
      const unsubscribe = vi.fn(() => {
        handler({
          kind: 'runtime-activity-snapshot',
          sequence: 99,
          sessionId: 'session-1',
          emittedAtMs: 99,
          state: 'active',
          activeCount: 9,
        });
        throw hostile.proxy;
      });
      subscriptions.push({ handler, unsubscribe });
      return unsubscribe;
    });
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
      expect(subscriptions).toHaveLength(1);
      subscriptions[0]!.handler({
        kind: 'runtime-activity-snapshot',
        sequence: 1,
        sessionId: 'session-1',
        emittedAtMs: 1,
        state: 'active',
        activeCount: 1,
      });
      await vi.waitFor(() => expect(initialSession.enqueueRegisteredSessionStateFieldMutation)
        .toHaveBeenLastCalledWith(expect.objectContaining({
          op: { kind: 'set', value: { state: 'active', activeCount: 1 } },
        })));

      const initialCallsBeforeSwap = initialSession.enqueueRegisteredSessionStateFieldMutation.mock.calls.length;
      await swapSession?.(replacement);
      expect(subscriptions).toHaveLength(2);
      expect(subscriptions[0]!.unsubscribe).toHaveBeenCalledOnce();
      expect(initialSession.enqueueRegisteredSessionStateFieldMutation.mock.calls
        .slice(initialCallsBeforeSwap)).not.toContainEqual([
        expect.objectContaining({
          op: expect.objectContaining({ value: expect.objectContaining({ activeCount: 9 }) }),
        }),
      ]);

      const callsBeforeLateOldCallback = replacement.enqueueRegisteredSessionStateFieldMutation.mock.calls.length;
      subscriptions[0]!.handler({
        kind: 'runtime-activity-snapshot',
        sequence: 2,
        sessionId: 'session-2',
        emittedAtMs: 2,
        state: 'active',
        activeCount: 9,
      });
      await Promise.resolve();
      expect(replacement.enqueueRegisteredSessionStateFieldMutation)
        .toHaveBeenCalledTimes(callsBeforeLateOldCallback);

      subscriptions[1]!.handler({
        kind: 'runtime-activity-snapshot',
        sequence: 3,
        sessionId: 'session-1',
        emittedAtMs: 3,
        state: 'active',
        activeCount: 2,
      });
      await vi.waitFor(() => expect(replacement.enqueueRegisteredSessionStateFieldMutation)
        .toHaveBeenLastCalledWith(expect.objectContaining({
          op: { kind: 'set', value: { state: 'active', activeCount: 2 } },
        })));
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
    expect(subscriptions[0]!.unsubscribe).toHaveBeenCalledOnce();
    expect(subscriptions[1]!.unsubscribe).toHaveBeenCalledOnce();
    const disposalLog = loggerDebugMock.mock.calls.find(
      ([message]) => message === '[Qwen] Runtime Activity subscriber disposal failed after logical fencing (non-fatal)',
    );
    expect(disposalLog?.[0]).toBe(
      '[Qwen] Runtime Activity subscriber disposal failed after logical fencing (non-fatal)',
    );
    expect(Object.is(disposalLog?.[1], hostile.proxy)).toBe(false);
    expect(disposalLog?.[1]).toEqual({
      error: 'runtime_activity_subscriber_disposal_failed',
    });
  });

  it('starts a same-session runtime replacement with a fenced empty Activity scope', async () => {
    const harness = createHarness();
    harness.config.runtimeActivityApplicability = 'supported';
    const runtimeActivityHandlers = new Set<(event: any) => void>();
    let replacementLifecycle: Readonly<{
      beforeReplacement(): Promise<void>;
      onSuccessorBound(): Promise<void>;
      onSuccessorUsable(): Promise<void>;
    }> | null = null;
    harness.runtime.subscribeCanonicalAgentSessionEvents = vi.fn((handler: (event: any) => void) => {
      runtimeActivityHandlers.add(handler);
      return () => runtimeActivityHandlers.delete(handler);
    });
    harness.runtime.setRuntimeReplacementLifecycle = vi.fn((lifecycle: typeof replacementLifecycle) => {
      replacementLifecycle = lifecycle;
    });
    harness.deps.runPermissionModePromptLoopFn = async () => {
      expect(replacementLifecycle).not.toBeNull();
      runtimeActivityHandlers.forEach((handler) => handler({
        kind: 'runtime-activity-snapshot',
        sequence: 1,
        sessionId: 'session-1',
        emittedAtMs: 1,
        state: 'active',
        activeCount: 1,
      }));
      await vi.waitFor(() => expect(harness.session.enqueueRegisteredSessionStateFieldMutation)
        .toHaveBeenLastCalledWith(expect.objectContaining({
          op: { kind: 'set', value: { state: 'active', activeCount: 1 } },
        })));

      await replacementLifecycle!.beforeReplacement();
      await replacementLifecycle!.onSuccessorBound();
      expect(harness.session.enqueueRegisteredSessionStateFieldMutation)
        .toHaveBeenLastCalledWith(expect.objectContaining({
          op: { kind: 'set', value: { state: 'idle', activeCount: 0 } },
        }));
      runtimeActivityHandlers.forEach((handler) => handler({
        kind: 'runtime-activity-snapshot',
        sequence: 2,
        sessionId: 'session-1',
        emittedAtMs: 2,
        state: 'idle',
        activeCount: 0,
      }));

      await new Promise((resolve) => setTimeout(resolve, 0));
      await vi.waitFor(() => expect(harness.session.enqueueRegisteredSessionStateFieldMutation)
        .toHaveBeenLastCalledWith(expect.objectContaining({
          op: { kind: 'set', value: { state: 'idle', activeCount: 0 } },
        })));
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('restores the current producer binding when replacement empty-scope publication rejects', async () => {
    const harness = createHarness();
    harness.config.runtimeActivityApplicability = 'supported';
    const runtimeActivityHandlers = new Set<(event: any) => void>();
    const publicationFailure = new Error('replacement empty-scope publication rejected');
    let rejectNextIdle = false;
    harness.session.enqueueRegisteredSessionStateFieldMutation.mockImplementation(async (mutation: Readonly<{
      op?: Readonly<{ value?: Readonly<{ state?: unknown }> }>;
    }>) => {
      if (rejectNextIdle && mutation.op?.value?.state === 'idle') {
        rejectNextIdle = false;
        throw publicationFailure;
      }
    });
    let replacementLifecycle: Readonly<{
      beforeReplacement(): Promise<void>;
      onSuccessorBound(): Promise<void>;
      onSuccessorUsable(): Promise<void>;
    }> | null = null;
    harness.runtime.subscribeCanonicalAgentSessionEvents = vi.fn((handler: (event: any) => void) => {
      runtimeActivityHandlers.add(handler);
      return () => runtimeActivityHandlers.delete(handler);
    });
    harness.runtime.setRuntimeReplacementLifecycle = vi.fn((lifecycle: typeof replacementLifecycle) => {
      replacementLifecycle = lifecycle;
    });
    harness.deps.runPermissionModePromptLoopFn = async () => {
      runtimeActivityHandlers.forEach((handler) => handler({
        kind: 'runtime-activity-snapshot',
        sequence: 1,
        sessionId: 'session-1',
        emittedAtMs: 1,
        state: 'active',
        activeCount: 1,
      }));
      await vi.waitFor(() => expect(harness.session.enqueueRegisteredSessionStateFieldMutation)
        .toHaveBeenLastCalledWith(expect.objectContaining({
          op: { kind: 'set', value: { state: 'active', activeCount: 1 } },
        })));

      rejectNextIdle = true;
      await expect(replacementLifecycle!.beforeReplacement()).rejects.toBe(publicationFailure);
      runtimeActivityHandlers.forEach((handler) => handler({
        kind: 'runtime-activity-snapshot',
        sequence: 2,
        sessionId: 'session-1',
        emittedAtMs: 2,
        state: 'active',
        activeCount: 2,
      }));
      await vi.waitFor(() => expect(harness.session.enqueueRegisteredSessionStateFieldMutation)
        .toHaveBeenLastCalledWith(expect.objectContaining({
          op: { kind: 'set', value: { state: 'active', activeCount: 2 } },
        })));
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('reactivates the prior delivery owner when replacement baseline persistence fails', async () => {
    const harness = createHarness();
    harness.config.runtimeActivityApplicability = 'supported';
    const unsubscribeRuntimeActivity = vi.fn();
    harness.runtime.subscribeCanonicalAgentSessionEvents = vi.fn(() => unsubscribeRuntimeActivity);
    const order: string[] = [];
    const initialSession = harness.session;
    const replacement = harness.createSessionFixture('session-1').session;
    initialSession.deactivateDurableMutationDelivery = vi.fn(() => order.push('old:deactivate'));
    initialSession.activateDurableMutationDelivery = vi.fn(async () => { order.push('old:reactivate'); });
    initialSession.close = vi.fn(async () => { order.push('old:close'); });
    replacement.stageInitialDurableMutationSnapshots = vi.fn(async () => {
      order.push('replacement:stage');
      expect(unsubscribeRuntimeActivity).not.toHaveBeenCalled();
      throw new Error('replacement baseline persistence rejected');
    });
    replacement.activateDurableMutationDelivery = vi.fn(async () => { order.push('replacement:activate'); });
    let pendingApply: (() => Promise<void>) | null = null;
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
    harness.deps.initializeBackendRunSessionFn = async ({ onSessionSwap }: any) => {
      await onSessionSwap(replacement);
      return {
        session: initialSession,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: false,
      };
    };
    harness.deps.runPermissionModePromptLoopFn = async (params: Readonly<{
      onAfterLoopBoundary?: (args: { reason: 'turn_completed' }) => Promise<void> | void;
    }>) => {
      order.length = 0;
      await expect(params.onAfterLoopBoundary?.({ reason: 'turn_completed' })).rejects.toThrow(
        'replacement baseline persistence rejected',
      );
      expect(order).toEqual([
        'old:deactivate',
        'replacement:stage',
        'old:reactivate',
      ]);
      expect(replacement.activateDurableMutationDelivery).not.toHaveBeenCalled();
      expect(initialSession.close).not.toHaveBeenCalled();
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
    expect(unsubscribeRuntimeActivity).toHaveBeenCalledOnce();
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

  it('resolves and passes native MCP servers for the Grok catalog policy', async () => {
    const harness = createHarness();
    harness.config.flavor = 'grok';
    harness.config.policyAgentId = 'grok';

    let capturedMcpServers: unknown = null;
    const createRuntimeOriginal = harness.config.createSessionRuntime;
    if (!createRuntimeOriginal) {
      throw new Error('Expected session runtime factory in harness');
    }
    const createRuntime = createRuntimeOriginal;
    setSessionRuntimeFactory(harness.config, (params) => {
      capturedMcpServers = params.mcpServers;
      return createRuntime(params);
    });

    const resolveRunnerMcpServersFn = vi.fn(async () => ({
      happierMcpServer: { stop: () => undefined },
      mcpServers: { happier: { command: 'built-in' } },
    }));

    await runHostSessionRuntime(harness.opts, harness.config, {
      ...harness.deps,
      resolveRunnerMcpServersFn,
    });

    expect(resolveRunnerMcpServersFn).toHaveBeenCalledTimes(1);
    expect(capturedMcpServers).toEqual({ happier: { command: 'built-in' } });
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

  it('refreshes provider binding metadata on an attached session before creating its runtime', async () => {
    const harness = createHarness();
    harness.config.policyAgentId = 'codex';
    harness.opts.backendTarget = { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' };
    harness.opts.modelSelection = {
      v: 1, updatedAt: 1,
      ref: { agentTargetKey: 'backend:codex', providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'), modelId: 'provider-model' },
    };
    const materialization = {
      v: 1 as const,
      kind: 'engineConfig' as const,
      engineConfig: { model_provider: { name: 'gateway' } },
    };
    const nextBinding = {
      v: 1 as const,
      connectionId: ProviderConnectionIdSchema.parse('pc_work'),
      contributionKey: 'plugin.openrouter/openrouter',
      connectionRevision: 4,
      model: providerModelDescriptor,
      protocol: 'openai-responses' as const,
      materialization: 'engineConfig' as const,
      adapterBindingKey: 'openrouter',
      compatibilityFingerprint: 'compatibility-v1',
      bindingSecurityFingerprint: 'security-v1',
      displaySnapshot: {
        providerName: 'OpenRouter', connectionName: 'Work', connectionRole: 'named' as const,
        connectionDisplayNameMode: 'custom' as const,
      },
    };
    let attachedMetadata: Record<string, unknown> = {
      path: '/srv/attached-workspace',
      providerBindingV1: { ...nextBinding, connectionRevision: 3 },
    };
    harness.session.getMetadataSnapshot = () => attachedMetadata;
    harness.session.updateMetadata = vi.fn(async (updater: (metadata: Record<string, unknown>) => Record<string, unknown>) => {
      attachedMetadata = updater(attachedMetadata);
    });
    harness.deps.initializeBackendRunSessionFn = async () => ({
      session: harness.session,
      reconnectionHandle: null,
      reportedSessionId: 'session-1',
      attachedToExistingSession: true,
    });
    const createSessionRuntime = vi.fn(() => ({ operations: harness.runtime, nativeRuntime: harness.runtime }));
    harness.config.createSessionRuntime = createSessionRuntime;
    process.env[HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY] =
      serializeProviderBindingLaunchHandoffForEnv(
        materialization,
        nextBinding,
      );

    try {
      await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

      expect(harness.session.updateMetadata).toHaveBeenCalled();
      expect(createSessionRuntime).toHaveBeenCalledWith(expect.objectContaining({
        metadata: expect.objectContaining({ providerBindingV1: nextBinding }),
      }));
    } finally {
      delete process.env[HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY];
    }
  });

  it('clears stale provider binding metadata when an attached session explicitly restarts on a native model', async () => {
    const harness = createHarness();
    harness.opts.backendTarget = { kind: 'backend', backendId: 'qwen', sourceKind: 'built_in' };
    harness.opts.modelSelection = {
      v: 1,
      updatedAt: 10,
      ref: { agentTargetKey: 'backend:qwen', providerConnectionId: null, modelId: 'native-model' },
    };
    let attachedMetadata: Record<string, unknown> = {
      path: '/srv/attached-workspace',
      providerBindingV1: {
        v: 1, connectionId: 'pc_old', contributionKey: 'plugin:old:old', connectionRevision: 1,
        protocol: 'openai-responses', materialization: 'engineConfig', adapterBindingKey: 'old',
        compatibilityFingerprint: 'compatibility-v1', bindingSecurityFingerprint: 'security-v1',
        displaySnapshot: { providerName: 'Old', connectionName: 'Old', connectionRole: 'default', connectionDisplayNameMode: 'automatic' },
      },
    };
    harness.session.getMetadataSnapshot = () => attachedMetadata;
    harness.session.updateMetadata = vi.fn(async (updater: (metadata: Record<string, unknown>) => Record<string, unknown>) => {
      attachedMetadata = updater(attachedMetadata);
    });
    harness.deps.initializeBackendRunSessionFn = async () => ({
      session: harness.session, reconnectionHandle: null, reportedSessionId: 'session-1', attachedToExistingSession: true,
    });
    const createSessionRuntime = vi.fn(() => ({ operations: harness.runtime, nativeRuntime: harness.runtime }));
    harness.config.createSessionRuntime = createSessionRuntime;

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(harness.session.updateMetadata).toHaveBeenCalled();
    expect(createSessionRuntime).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.not.objectContaining({ providerBindingV1: expect.anything() }),
    }));
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

  it('settles an unavailable exact steer through the canonical provider-rejection outcome without queue fallback', async () => {
    const harness = createHarness();
    let userMessageHandler: ((message: unknown) => boolean | void) | null = null;
    let providerRejectedHandler: ((info: Readonly<{
      localIds?: readonly string[];
      userMessageSeq: number | null;
      userMessageSeqs?: readonly number[];
    }>) => void) | null = null;
    const observeProviderInputSettlement = vi.fn();
    harness.session.onUserMessage = (handler: (message: unknown) => boolean | void) => {
      userMessageHandler = handler;
    };
    harness.session.getCommittedUserMessageSeq = vi.fn((localId: string) => (
      localId === 'local-exact-steer-unavailable' ? 92 : null
    ));
    harness.session.hasPendingProviderInput = vi.fn((localId: string) => (
      localId === 'local-exact-steer-unavailable'
    ));
    harness.session.observeProviderInputSettlement = observeProviderInputSettlement;

    const runtime = {
      ...harness.runtime,
      supportsInFlightSteer: vi.fn(() => false),
      isTurnInFlight: vi.fn(() => true),
      setOnPromptTerminallyRejectedBeforeProvider: vi.fn((handler: typeof providerRejectedHandler) => {
        providerRejectedHandler = handler;
      }),
    };
    setSessionRuntimeFactory(harness.config, () => ({
      operations: runtime,
      nativeRuntime: runtime,
    }));
    delete harness.deps.createPermissionModeQueueStateFn;

    harness.deps.runPermissionModePromptLoopFn = async (params: any) => {
      expect(userMessageHandler).toBeTypeOf('function');
      expect(providerRejectedHandler).toBeTypeOf('function');

      userMessageHandler?.({
        role: 'user',
        content: { type: 'text', text: 'exact steer only' },
        localId: 'local-exact-steer-unavailable',
        meta: {},
        pendingProviderAction: 'steer',
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(params.messageQueue.size()).toBe(0);
      expect(observeProviderInputSettlement).toHaveBeenCalledExactlyOnceWith({
        kind: 'rejected_before_effect',
        localId: 'local-exact-steer-unavailable',
        userMessageSeq: 92,
        userMessageSeqs: [92],
        reason: 'provider_rejected_before_acceptance',
        diagnostic: {
          code: 'provider_rejected_before_acceptance',
          severity: 'error',
        },
        retryable: false,
      });

      // A duplicate provider-side terminal rejection traverses the same host normalizer and must
      // not settle Pending twice.
      providerRejectedHandler?.({
        localIds: ['local-exact-steer-unavailable'],
        userMessageSeq: 92,
        userMessageSeqs: [92],
      });
      expect(observeProviderInputSettlement).toHaveBeenCalledTimes(1);

      userMessageHandler?.({
        role: 'user',
        content: { type: 'text', text: 'ambient input still queues' },
        localId: 'local-ambient-input',
        meta: {},
      });
      expect(params.messageQueue.size()).toBe(1);
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('keeps the foreground turn alive when an exact pre-effect steer rejection cannot be settled', async () => {
    const harness = createHarness();
    let userMessageHandler: ((message: unknown) => boolean | void) | null = null;
    harness.session.onUserMessage = (handler: (message: unknown) => boolean | void) => {
      userMessageHandler = handler;
    };
    harness.session.getCommittedUserMessageSeq = vi.fn(() => 93);
    harness.session.hasPendingProviderInput = vi.fn(() => true);
    harness.session.observeProviderInputSettlement = vi.fn(() => {
      throw new Error('settlement owner unavailable');
    });

    const runtime = {
      ...harness.runtime,
      supportsInFlightSteer: vi.fn(() => false),
      isTurnInFlight: vi.fn(() => true),
    };
    setSessionRuntimeFactory(harness.config, () => ({
      operations: runtime,
      nativeRuntime: runtime,
    }));
    delete harness.deps.createPermissionModeQueueStateFn;

    harness.deps.runPermissionModePromptLoopFn = async (params: any) => {
      userMessageHandler?.({
        role: 'user',
        content: { type: 'text', text: 'exact steer only' },
        localId: 'local-exact-steer-settlement-unavailable',
        meta: {},
        pendingProviderAction: 'steer',
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(params.messageQueue.size()).toBe(0);
      expect(runtime.isTurnInFlight()).toBe(true);
      expect(harness.session.sendAgentMessage.mock.calls).not.toContainEqual([
        expect.anything(),
        expect.objectContaining({ type: 'task_complete' }),
      ]);
      expect(harness.session.sendAgentMessage.mock.calls).not.toContainEqual([
        expect.anything(),
        expect.objectContaining({ type: 'turn_failed' }),
      ]);
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('classifies an invoked exact steer throw as uncertainty without queue fallback or foreground completion', async () => {
    const harness = createHarness();
    let userMessageHandler: ((message: unknown) => boolean | void) | null = null;
    harness.session.onUserMessage = (handler: (message: unknown) => boolean | void) => {
      userMessageHandler = handler;
    };
    harness.session.getCommittedUserMessageSeq = vi.fn(() => 94);
    harness.session.hasPendingProviderInput = vi.fn(() => true);
    harness.session.observeProviderInputSettlement = vi.fn();

    const runtime = {
      ...harness.runtime,
      supportsInFlightSteer: vi.fn(() => true),
      isTurnInFlight: vi.fn(() => true),
      canSteerPrompt: vi.fn(() => true),
      steerPrompt: vi.fn(async () => {
        throw new Error('provider response lost after steer invocation');
      }),
    };
    setSessionRuntimeFactory(harness.config, () => ({
      operations: runtime,
      nativeRuntime: runtime,
    }));
    delete harness.deps.createPermissionModeQueueStateFn;

    harness.deps.runPermissionModePromptLoopFn = async (params: any) => {
      userMessageHandler?.({
        role: 'user',
        content: { type: 'text', text: 'exact ambiguous steer' },
        localId: 'local-exact-steer-ambiguous',
        meta: {},
        pendingProviderAction: 'steer',
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(runtime.steerPrompt).toHaveBeenCalledTimes(1);
      expect(params.messageQueue.size()).toBe(0);
      expect(harness.session.observeProviderInputSettlement).toHaveBeenCalledExactlyOnceWith({
        kind: 'effect_may_have_occurred',
        localId: 'local-exact-steer-ambiguous',
        userMessageSeq: 94,
        userMessageSeqs: [94],
        issue: { code: 'provider_steer_outcome_unknown', severity: 'error' },
        detail: 'provider_steer_outcome_unknown',
      });
      expect(runtime.isTurnInFlight()).toBe(true);
      expect(harness.session.sendAgentMessage.mock.calls).not.toContainEqual([
        expect.anything(),
        expect.objectContaining({ type: 'task_complete' }),
      ]);
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('routes in-flight steer input through the admitted queue until the exact generation epoch clears', async () => {
    const harness = createHarness();
    let userMessageHandler: ((message: unknown) => boolean | void) | null = null;
    let steerCallsWhileAdmitted = -1;
    harness.session.onUserMessage = (handler: (message: unknown) => boolean | void) => {
      userMessageHandler = handler;
    };
    harness.session.waitForMetadataUpdate = vi.fn(async () => false);
    harness.session.shouldAttemptPendingMaterialization = vi.fn(() => true);
    harness.session.reconcilePendingQueueState = vi.fn(async () => undefined);
    harness.session.getCommittedUserMessageSeq = vi.fn((localId: string) => (
      localId === 'local-admitted-steer' ? 91 : null
    ));

    const runtime = {
      ...harness.runtime,
      steerPrompt: vi.fn(async () => undefined),
      supportsInFlightSteer: vi.fn(() => true),
      isTurnInFlight: vi.fn(() => true),
    };
    setSessionRuntimeFactory(harness.config, () => ({
      operations: runtime,
      nativeRuntime: runtime,
    }));
    delete harness.deps.createPermissionModeQueueStateFn;

    harness.deps.runPermissionModePromptLoopFn = async (params: any) => {
      const admission = harness.handlers.get(SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION);
      expect(admission).toBeTypeOf('function');
      await admission?.({
        action: 'enforce',
        serviceId: 'openai-codex',
        groupId: 'codex-main',
        reason: 'generation_pending',
        epochId: 'generation:43',
      });

      expect(userMessageHandler).toBeTypeOf('function');
      userMessageHandler?.({
        role: 'user',
        content: { type: 'text', text: 'wait for exact generation' },
        localId: 'local-admitted-steer',
        meta: {},
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      steerCallsWhileAdmitted = runtime.steerPrompt.mock.calls.length;
      if (steerCallsWhileAdmitted > 0) return;

      const abortController = new AbortController();
      let releasedBatch: unknown = null;
      const release = params.inputConsumer.waitForNextInput({
        abortSignal: abortController.signal,
      }).then((batch: unknown) => {
        releasedBatch = batch;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      await expect(admission?.({
        action: 'clear',
        serviceId: 'openai-codex',
        groupId: 'codex-main',
        epochId: 'generation:42',
      })).resolves.toEqual({ status: 'not_matched' });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(releasedBatch).toBeNull();
      expect(runtime.steerPrompt).not.toHaveBeenCalled();

      await expect(admission?.({
        action: 'clear',
        serviceId: 'openai-codex',
        groupId: 'codex-main',
        epochId: 'generation:43',
      })).resolves.toEqual({ status: 'cleared' });
      await release;
      expect(releasedBatch).toEqual(expect.objectContaining({
        message: expect.objectContaining({
          text: 'wait for exact generation',
          localId: 'local-admitted-steer',
          localIds: ['local-admitted-steer'],
          userMessageSeq: 91,
          userMessageSeqs: [91],
        }),
      }));
      expect(runtime.steerPrompt).not.toHaveBeenCalled();

      userMessageHandler?.({
        role: 'user',
        content: { type: 'text', text: 'direct steer after clear' },
        localId: 'local-direct-steer',
        meta: {},
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(runtime.steerPrompt).toHaveBeenCalledTimes(1);
      expect(runtime.steerPrompt).toHaveBeenCalledWith('direct steer after clear', {
        localId: 'local-direct-steer',
        localIds: ['local-direct-steer'],
      });
    };
    harness.deps.runSessionLoopLifecycleFn = async (params: any) => {
      await params.deps.runPermissionModePromptLoopFn({ runtime: params.runtime });
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
    expect(steerCallsWhileAdmitted).toBe(0);
  });

  it('keeps enforcement behind ACP or Claude steer preparation that already owns provider dispatch custody', async () => {
    const harness = createHarness();
    let userMessageHandler: ((message: unknown) => boolean | void) | null = null;
    harness.session.onUserMessage = (handler: (message: unknown) => boolean | void) => {
      userMessageHandler = handler;
    };
    let steerPreparationStartedResolve: () => void = () => {};
    const steerPreparationStarted = new Promise<void>((resolve) => {
      steerPreparationStartedResolve = resolve;
    });
    let releaseSteerPreparation: () => void = () => {};
    const steerPreparationPaused = new Promise<void>((resolve) => {
      releaseSteerPreparation = resolve;
    });
    const runtime = {
      ...harness.runtime,
      steerPrompt: vi.fn(async () => {
        // ACP waits for backend creation here; Claude Unified waits for terminal readiness here.
        steerPreparationStartedResolve();
        await steerPreparationPaused;
      }),
      supportsInFlightSteer: vi.fn(() => true),
      isTurnInFlight: vi.fn(() => true),
    };
    setSessionRuntimeFactory(harness.config, () => ({
      operations: runtime,
      nativeRuntime: runtime,
    }));
    delete harness.deps.createPermissionModeQueueStateFn;

    harness.deps.runPermissionModePromptLoopFn = async () => {
      const admission = harness.handlers.get(SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION);
      expect(admission).toBeTypeOf('function');
      if (!admission) throw new Error('provider input admission handler was not registered');
      expect(userMessageHandler).toBeTypeOf('function');
      userMessageHandler?.({
        role: 'user',
        content: { type: 'text', text: 'steer while provider prepares' },
        localId: 'local-steer-preparation',
        meta: {},
      });
      await steerPreparationStarted;

      const enforcement = Promise.resolve(admission({
        action: 'enforce',
        serviceId: 'openai-codex',
        groupId: 'codex-main',
        reason: 'generation_pending',
        epochId: 'generation:steer-preparation',
      }));
      const enforcementSettled = vi.fn();
      void enforcement.then(enforcementSettled, enforcementSettled);
      await new Promise<void>((resolve) => setImmediate(resolve));
      try {
        expect(enforcementSettled).not.toHaveBeenCalled();
      } finally {
        releaseSteerPreparation();
      }
      await expect(enforcement).resolves.toEqual({ status: 'enforced' });
      expect(runtime.steerPrompt).toHaveBeenCalledTimes(1);
      await expect(Promise.resolve(admission({
        action: 'clear',
        serviceId: 'openai-codex',
        groupId: 'codex-main',
        epochId: 'generation:steer-preparation',
      }))).resolves.toEqual({ status: 'cleared' });
    };
    harness.deps.runSessionLoopLifecycleFn = async (params: any) => {
      await params.deps.runPermissionModePromptLoopFn({ runtime: params.runtime });
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('passes direct native runtime-turn operations through unchanged', async () => {
    const harness = createHarness();
    const nativeRuntime = {
      beginTurnLifecycle: vi.fn(),
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
      hookRuntime?: { sendTurnPrompt?: unknown };
    } | undefined;
    expect(lifecycleParams?.runtime).toBe(nativeRuntime);
    expect(lifecycleParams?.hookRuntime).toBe(nativeRuntime);
    expect(typeof lifecycleParams?.hookRuntime?.sendTurnPrompt).toBe('function');
  });

  it('preserves native runtime restart policy when driving RuntimeTurnOperations', async () => {
    const harness = createHarness();
    const operations = {
      beginTurnLifecycle: vi.fn(),
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
    setTerminalRemoteModeLoop(harness.config, createTerminalRemoteModeLoopFixture());

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
      try {
        await vi.waitFor(() => expect(finishHook).toBeTypeOf('function'));
        expect(notifyFinished).toBe(false);
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

  it('reads the live applied timing for each claim and wakes only when it broadens eligibility', async () => {
    const harness = createHarness();
    const setTiming = (timing: 'after_foreground_ready' | 'after_runtime_idle', version: number) => {
      setActiveAccountSettingsSnapshot({
        source: 'network',
        settings: { sessionPendingQueueDeliveryTiming: timing } as any,
        settingsVersion: version,
        loadedAtMs: version,
        settingsSecretsReadKeys: [],
        scopeKey: 'run-host-live-timing',
      });
    };
    setTiming('after_runtime_idle', 1);
    const materializeNextPendingMessageSafely = vi.fn(async () => ({ type: 'no_pending' as const }));
    harness.session.materializeNextPendingMessageSafely = materializeNextPendingMessageSafely;
    harness.session.wakePendingMaterialization.mockClear();
    harness.deps.runPermissionModePromptLoopFn = async (params: any) => {
      setTiming('after_foreground_ready', 2);
      expect(harness.session.wakePendingMaterialization).toHaveBeenCalledTimes(1);
      await params.inputConsumer.drainPending({ maxPopPerWake: 1, reason: 'live-timing' });
      setTiming('after_runtime_idle', 2);
      setTiming('after_runtime_idle', 1);
      expect(harness.session.wakePendingMaterialization).toHaveBeenCalledTimes(1);
      setTiming('after_runtime_idle', 3);
      expect(harness.session.wakePendingMaterialization).toHaveBeenCalledTimes(1);
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(materializeNextPendingMessageSafely).toHaveBeenCalledWith({
      reconcileWhenEmpty: 'force',
      deliveryTiming: 'after_foreground_ready',
    });
    setTiming('after_foreground_ready', 4);
    expect(harness.session.wakePendingMaterialization).toHaveBeenCalledTimes(1);
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
