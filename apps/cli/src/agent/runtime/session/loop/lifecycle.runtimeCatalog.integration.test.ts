import { buildUsageLimitIssueFingerprint } from '@happier-dev/protocol';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import type {
  AgentSessionRuntime,
  AgentSessionRuntimeContext,
  AgentSessionRuntimeEvent,
} from '@happier-dev/plugin-sdk/agents/runtime';
import {
  AgentSessionRuntimeEventV1Schema,
  type AgentSessionRuntimeEventV1,
} from '@happier-dev/protocol';

import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import { cleanupBackendRunResources } from '@/agent/runtime/cleanupBackendRunResources';
import type { Metadata } from '@/api/types';
import type { ApiClient } from '@/api/api';
import { buildAcpAgentMessageEnvelope } from '@/api/session/acpMessageEnvelope';
import { loadCommittedTranscriptLocalIdBaseline } from '@/api/session/client/transcript/committedTranscriptLocalIdBaseline';
import { createHostTerminalTranscriptFollowService } from '@/agent/runtime/session/terminal/transcriptFollow';
import { createExternalSessionTerminalFollowProjector } from '@/session/external/terminalFollowProjection';
import { projectRuntimeTranscriptEvent } from '@/agent/runtime/session/transcripts/projectRuntimeTranscriptEvent';
import { createDeferredStartupBootstrap } from '@/agent/runtime/startup/createDeferredStartupBootstrap';
import {
  computeRunnerTerminationOutcome,
  type RunnerTerminationEvent,
  type RunnerTerminationOutcome,
} from '@/agent/runtime/lifecycle/runnerTerminationOutcome';
import { registerRunnerTerminationHandlers } from '@/agent/runtime/lifecycle/runnerTerminationHandlers';
import type { RuntimeTurnMessageHandler } from '@/agent/runtime/turns/runtimeTurnOperations';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { getResolvedContributionRegistry } from '@/plugins/projection/registry/builtIn/snapshot';
import { createNativeAgentSessionOperations } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { runPermissionModePromptLoop } from '@/agent/runtime/runPermissionModePromptLoop';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { combinePermissionModeQueuedPrompts, type PermissionModeQueuedPrompt, type PermissionModeQueuedPromptMode } from '@/agent/runtime/permissions/queuedPrompt';
import { projectAgentRuntimeDaemonServiceTurnWitnessV1 } from '../process/agentRuntimeDaemonServiceTurnWitness';
import { registerHappierSessionAgentToolRpc, startHappyServer } from '@/mcp/startHappyServer';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { FeaturesResponseSchema, accountSettingsParse } from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { writeSessionExplicitStopV1ToMetadata } from '@happier-dev/protocol/sessions/metadata/sessionExplicitStopV1';
import * as persistence from '@/persistence';
import { BROWSER_RUNTIME_ACTION_CONTROL_PATH, BrowserRuntimeActionControlRequestSchema } from '@/daemon/browser/actions/controlTransport';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createLifecycleParams, createMetadata, machineMetadata } from './lifecycle.testkit';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { buildRunScopedExecutionPermissionRequestId, createRunScopedExecutionPermissionHandler } from '@/agent/executionRuns/policy/runScopedExecutionPermissionHandler';
import { writeSessionCapabilitySelectionToMetadataV1 } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1';
import { installEmptyProjectAccountRowsHttpBoundary } from '@/testkit/http/projectAccountRows';
import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import { createAcpSessionRuntimeContextFixture } from '@/agent/acp/testkit/runtimeContextFixture';
import { createPublicAcpRuntimeProtocols } from '@/agent/acp/runtime/publicSession/createPublicAcpRuntimeProtocols';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';

// A real prompt plan reads the Home's Project associations even for an
// unassociated checkout. Keep that HTTP boundary in-process, not the resolver.
let restoreProjectHttp: (() => void) | undefined;
beforeEach(() => { restoreProjectHttp = installEmptyProjectAccountRowsHttpBoundary(); });
afterEach(() => { restoreProjectHttp?.(); restoreProjectHttp = undefined; });

const { loggerDebugMock, recoveryNotify, capabilityRestart, recoveryBoundary } = vi.hoisted(() => ({
  loggerDebugMock: vi.fn(),
  recoveryNotify: vi.fn(),
  capabilityRestart: vi.fn(),
  recoveryBoundary: { outboxRoot: '' },
}));
vi.mock('@/configuration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configuration')>();
  return { ...actual, configuration: Object.create(actual.configuration, { activeServerDir: { configurable: true, get: () => recoveryBoundary.outboxRoot || actual.configuration.activeServerDir } }) };
});
vi.mock('@/daemon/controlClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/daemon/controlClient')>();
  return { ...actual, notifyDaemonConnectedServiceRuntimeAuthFailure: recoveryNotify, requestDaemonSessionRunnerRestart: capabilityRestart };
});

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

import { runSessionLoopLifecycle, type SessionLoopLifecycleParams } from './lifecycle';
import type { DaemonAgentRuntimeTurnContributionsBridge } from '../process/agentRuntimeDaemonTurnContributionsBridge';

const RETIRED_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY =
  'HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE';

const checkpointLifecycle = Object.freeze({});

const checkpointFactory = vi.hoisted(() => vi.fn(() => checkpointLifecycle));

let nextRuntimeEventSequence = 0;

function canonicalRuntimeEvent(input: Readonly<Record<string, unknown>>): AgentSessionRuntimeEventV1 {
  return AgentSessionRuntimeEventV1Schema.parse({
    sequence: ++nextRuntimeEventSequence,
    ...input,
    ...(input.kind === 'turn-start' && input.startedBy === undefined
      ? { startedBy: 'host' }
      : {}),
  });
}

type RunPermissionModePromptLoopFn = NonNullable<
  NonNullable<SessionLoopLifecycleParams['deps']>['runPermissionModePromptLoopFn']
>;
type NotifyDaemonConnectedServiceTurnLifecycleFn = NonNullable<
  NonNullable<SessionLoopLifecycleParams['deps']>['notifyDaemonConnectedServiceTurnLifecycleFn']
>;

vi.mock('@/agent/runtime/checkpoints/repositoryCheckpointPromptLifecycle', () => ({
  createRepositoryCheckpointPromptLifecycle: checkpointFactory,
}));

function createRevokedTranscriptFailure(privateTranscript: string): object {
  const hostile = Proxy.revocable({ privateTranscript }, {});
  hostile.revoke();
  return hostile.proxy;
}

function loggerReceivedIdentity(value: unknown): boolean {
  return loggerDebugMock.mock.calls.some((call) => call.some((argument) => argument === value));
}

describe('runSessionLoopLifecycle presence renewal', () => {
  it.each(['unmount', 'terminate'] as const)('does not mount a cold terminal display after %s', async (retirement) => {
    const base = createLifecycleParams();
    const params = { ...base, deps: { ...base.deps } } satisfies SessionLoopLifecycleParams;
    const modeRuns: string[] = [];
    params.terminalRemoteModeLoop = {
      startingMode: 'remote', remoteExitCode: 0, topology: 'shared', remoteWritable: true,
      runTerminal: async () => { modeRuns.push('terminal'); return { type: 'exit', code: 0 }; },
      runRemote: async () => { modeRuns.push('remote'); return 'exit'; }, onModeChange: () => undefined,
    };
    let releaseDisplay!: () => void;
    const displayReady = new Promise<void>(resolve => { releaseDisplay = resolve; });
    let loading = false;
    Object.assign(params.config, {
      loadTerminalDisplay: async () => {
        loading = true;
        await displayReady;
        return () => null;
      },
    });
    params.config.shouldRenderTerminalDisplay = () => true;
    params.config.processLifecycleOwnership = 'caller';
    let controller: Parameters<NonNullable<typeof params.config.onTerminalDisplayControllerReady>>[0] | undefined;
    let stop: (() => Promise<void>) | undefined;
    params.config.onTerminalDisplayControllerReady = value => { controller = value; };
    params.config.onRuntimeStopReady = value => { stop = value; };
    // Keep the real termination and cleanup owners. Only the Ink/OS renderer
    // boundary is replaced; the deferred callback models module loading.
    params.deps.registerRunnerTerminationHandlersFn = registerRunnerTerminationHandlers;
    params.deps.cleanupBackendRunResourcesFn = cleanupBackendRunResources;
    const unmount = vi.fn();
    const renderFn: NonNullable<SessionLoopLifecycleParams['deps']['renderFn']> = vi.fn(() => ({
      rerender: vi.fn(), unmount, waitUntilExit: async () => undefined,
      cleanup: vi.fn(), clear: vi.fn(),
    }));
    params.deps.renderFn = renderFn;
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    let run: Promise<void> | undefined;
    try {
      run = runSessionLoopLifecycle(params);
      expect(renderFn).not.toHaveBeenCalled();
      await vi.waitFor(() => { expect(loading).toBe(true); });
      expect(params.deps.runPermissionModePromptLoopFn).not.toHaveBeenCalled();
      if (retirement === 'unmount') {
        if (!controller) throw new Error('Terminal display controller unavailable');
        await controller.unmount();
      } else {
        if (!stop) throw new Error('Runtime stop control unavailable');
        await stop();
      }
      releaseDisplay();
      await run;
      expect(renderFn).not.toHaveBeenCalled();
      expect(unmount).not.toHaveBeenCalled();
      if (retirement === 'terminate') {
        expect(params.session.endSessionAndClose).toHaveBeenCalledOnce();
        expect(modeRuns).toEqual([]);
      }
    } finally {
      releaseDisplay();
      await run;
      if (stdoutDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
      else Reflect.deleteProperty(process.stdout, 'isTTY');
      if (stdinDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
      else Reflect.deleteProperty(process.stdin, 'isTTY');
    }
  });

  it('defers rule replacement while a collected prompt is preparing, then applies after its turn', async () => {
    capabilityRestart.mockReset();
    capabilityRestart.mockResolvedValue({ ok: true, status: 'restarted', sessionId: 'session-1' });
    const base = createLifecycleParams();
    const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(
      mode => JSON.stringify(mode), { batcher: combinePermissionModeQueuedPrompts });
    queue.push({ text: 'Reply only READY', localId: 'prepared-input' }, { permissionMode: 'default' });
    let releasePreparation!: () => void;
    const preparation = new Promise<void>(resolve => { releasePreparation = resolve; });
    let preparing = false;
    let sent = false;
    let sentTurnId = '';
    let listener: ((event: AgentSessionRuntimeEvent) => void) | undefined;
    const provider: AgentSessionRuntime = {
      async send(request) {
        sent = true;
        sentTurnId = request.delivery.turnId;
        listener?.(canonicalRuntimeEvent({ kind: 'input-accepted', sessionId: 'session-1', inputIds: request.inputIds, delivery: request.delivery, emittedAtMs: 1 }));
        listener?.(canonicalRuntimeEvent({ kind: 'turn-start', sessionId: 'session-1', turnId: sentTurnId, emittedAtMs: 1 }));
        return { status: 'admitted' };
      },
      watch(value) { listener = value; return { dispose() { listener = undefined; } }; },
      dispose() {},
    };
    const runtime = createNativeAgentSessionOperations(provider, 'session-1', undefined, undefined, undefined, undefined, undefined, {
      context: {} as AgentSessionRuntimeContext, cwd: '/workspace', connectedAccounts: [],
      capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
      cancellation: { declared: false }, configuration: { declared: false }, compaction: { capability: null },
    });
    const fixture = createMutableApiSessionClientFixture({ sessionId: 'session-1', metadata: createMetadata() });
    const session = Object.assign(fixture, {
      updateMetadataAsCurrentPublisher: async (update: (current: Metadata) => Metadata) => {
        fixture.updateMetadata(current => update(current!));
      },
      enqueueSessionEventCommitted: async () => ({ persisted: true as const, delivered: false as const }),
    });
    let enabled = true;
    const context = { machineId: 'machine', machinePlatform: 'posix' as const, directory: '/workspace', projectKey: null, agentId: 'codex' };
    const rules = () => [{ id: 'rule', skillId: 'library', target: { t: 'allMachines' as const }, enabled, createdAt: 1, updatedAt: 1 }];
    let wake = () => {};
    const run = runSessionLoopLifecycle({ ...base, session, runtime, hookRuntime: runtime,
      config: { ...base.config, startRuntimeBeforeFirstPrompt: true, lifecycleHooks: { createCheckpointLifecycle: () => ({}) } },
      capabilitySelection: { agent: { vendorResume: 'supported', skillsLiveReload: 'unsupported' },
        initialSkillRules: { context, rules: rules() }, readSkillRules: () => ({ context, rules: rules() }),
        subscribeAccountSettings: listener => { wake = listener; return () => {}; } },
      permissionModeState: { ...base.permissionModeState, messageQueue: queue },
      deps: { ...base.deps, cleanupBackendRunResourcesFn: cleanupBackendRunResources, registerKillSessionHandlerFn: undefined,
        runPermissionModePromptLoopFn: opts => runPermissionModePromptLoop({ ...opts,
          resolveFreshSessionSystemPrompt: async () => { preparing = true; await preparation; return ''; } }),
        registerRunnerTerminationHandlersFn: options => registerRunnerTerminationHandlers({
          ...options, processLifecycleOwnership: 'caller', sessionExitReport: null, exit: () => undefined,
        }) },
    });
    try {
      await vi.waitFor(() => expect(preparing).toBe(true));
      enabled = false;
      wake();
      await vi.waitFor(() => expect(fixture.getMetadataSnapshot()?.capabilitySelectionApplyV1?.skills).toMatchObject({ source: 'rules' }));
      expect(sent).toBe(false);
      expect(capabilityRestart).not.toHaveBeenCalled();
      releasePreparation();
      await vi.waitFor(() => expect(sent).toBe(true));
      expect(capabilityRestart).not.toHaveBeenCalled();
      listener?.(canonicalRuntimeEvent({ kind: 'turn-complete', sessionId: 'session-1', turnId: sentTurnId, emittedAtMs: 2 }));
      await vi.waitFor(() => expect(capabilityRestart).toHaveBeenCalledOnce());
    } finally {
      releasePreparation();
      listener?.(canonicalRuntimeEvent({ kind: 'runtime-ended', sessionId: 'session-1', cause: 'providerEnded', retryable: false, emittedAtMs: 3 }));
      // Teardown may dispose the boundary while a failed assertion holds preparation.
      await run.catch(error => { if (!(error instanceof Error) || error.name !== 'AbortError') throw error; });
    }
  });

  it('applies capability changes after a provider-owned turn settles while the host input queue remains idle', async () => {
    capabilityRestart.mockReset();
    capabilityRestart.mockResolvedValue({ ok: true, status: 'restarted', sessionId: 'session-1' });
    const base = createLifecycleParams({ runPermissionModePromptLoopFn: runPermissionModePromptLoop });
    const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(
      mode => JSON.stringify(mode), { batcher: combinePermissionModeQueuedPrompts });
    let listener: ((event: AgentSessionRuntimeEvent) => void) | undefined;
    const provider: AgentSessionRuntime = {
      async send() { throw new Error('Provider-owned turn must not receive a host prompt'); },
      watch(value) { listener = value; return { dispose() { listener = undefined; } }; },
      dispose() {},
    };
    const runtime = createNativeAgentSessionOperations(provider, 'session-1', undefined, undefined, undefined, undefined, undefined, {
      context: {} as AgentSessionRuntimeContext, cwd: '/workspace', connectedAccounts: [],
      capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
      cancellation: { declared: false }, configuration: { declared: false }, compaction: { capability: null },
    });
    const fixture = createMutableApiSessionClientFixture({ sessionId: 'session-1', metadata: createMetadata() });
    let acknowledgeTerminal!: () => void;
    const terminalAcknowledgement = new Promise<void>(resolve => { acknowledgeTerminal = resolve; });
    let terminalPending = false;
    const session = Object.assign(fixture, {
      enqueueSessionTurnMutation: async (mutation: Parameters<NonNullable<SessionLoopLifecycleParams['session']['enqueueSessionTurnMutation']>>[0]) => {
        if (mutation.action === 'complete') { terminalPending = true; await terminalAcknowledgement; }
      },
      updateMetadataAsCurrentPublisher: async (update: (current: Metadata) => Metadata) => {
        fixture.updateMetadata(current => update(current!));
      },
      enqueueSessionEventCommitted: async () => ({ persisted: true as const, delivered: false as const }),
    });
    const run = runSessionLoopLifecycle({ ...base, session, runtime, hookRuntime: runtime,
      config: { ...base.config, startRuntimeBeforeFirstPrompt: true,
        lifecycleHooks: { createCheckpointLifecycle: () => ({}) } },
      capabilitySelection: { agent: { vendorResume: 'supported', skillsLiveReload: 'unsupported' } },
      permissionModeState: { ...base.permissionModeState, messageQueue: queue },
      deps: { ...base.deps, cleanupBackendRunResourcesFn: cleanupBackendRunResources,
        registerKillSessionHandlerFn: undefined,
        registerRunnerTerminationHandlersFn: options => registerRunnerTerminationHandlers({
        ...options, processLifecycleOwnership: 'caller', sessionExitReport: null, exit: () => undefined,
      }) },
    });
    try {
      await vi.waitFor(() => expect(listener).toBeTypeOf('function'));
      listener?.(canonicalRuntimeEvent({ kind: 'turn-start', sessionId: 'session-1', turnId: 'native-turn', startedBy: 'provider', emittedAtMs: 1 }));
      fixture.updateMetadata(current => writeSessionCapabilitySelectionToMetadataV1(current!, {
        mcp: { v: 1, managedServersEnabled: false, forceIncludeServerIds: [], forceExcludeServerIds: [] },
      }, { sessionActive: true }));
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(capabilityRestart).not.toHaveBeenCalled();
      listener?.(canonicalRuntimeEvent({ kind: 'turn-complete', sessionId: 'session-1', turnId: 'native-turn', emittedAtMs: 2 }));
      await vi.waitFor(() => expect(terminalPending).toBe(true));
      expect(capabilityRestart).not.toHaveBeenCalled();
      acknowledgeTerminal();
      await vi.waitFor(() => expect(capabilityRestart).toHaveBeenCalledWith({
        sessionId: 'session-1', mode: 'force_current_cli', reason: 'capability_selection_change',
      }, { signal: expect.any(AbortSignal) }));
      expect(capabilityRestart.mock.calls[0]?.[1]?.signal.aborted).toBe(false);
      expect(queue.size()).toBe(0);
    } finally {
      acknowledgeTerminal();
      listener?.(canonicalRuntimeEvent({ kind: 'runtime-ended', sessionId: 'session-1', cause: 'providerEnded', retryable: false, emittedAtMs: 3 }));
      await run;
    }
    expect(capabilityRestart.mock.calls[0]?.[1]?.signal.aborted).toBe(true);
  });
  it('suppresses duplicate idle publication and leaves renewal to the Session transport', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const initialTime = Date.now();
    const params = createLifecycleParams({
      runPermissionModePromptLoopFn: async (loopParams) => {
        expect(params.session.keepAlive).toHaveBeenCalledWith(false, 'remote');
        loopParams.keepAlive(); // A duplicate immediate publication must not move the lease deadline.
        await vi.advanceTimersByTimeAsync(2 * configuration.sessionKeepAliveIdleMs);
        expect(Date.now()).toBe(initialTime + 2 * configuration.sessionKeepAliveIdleMs);
        expect(params.session.keepAlive).toHaveBeenCalledTimes(1);
      },
    });
    try {
      await runSessionLoopLifecycle({
        ...params, deps: { ...params.deps, cleanupBackendRunResourcesFn: cleanupBackendRunResources },
      });
      await vi.advanceTimersByTimeAsync(2 * configuration.sessionKeepAliveIdleMs);
      expect(params.session.keepAlive).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('publishes host thinking transitions immediately without a competing renewal timer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const params = createLifecycleParams({
      runPermissionModePromptLoopFn: async (loopParams) => {
        await vi.advanceTimersByTimeAsync(1_000);
        loopParams.setThinking(true);
        expect(params.session.keepAlive).toHaveBeenLastCalledWith(true, 'remote');
        const thinkingStartedAt = Date.now();
        await vi.advanceTimersByTimeAsync(configuration.sessionKeepAliveThinkingMs);
        expect(Date.now()).toBe(thinkingStartedAt + configuration.sessionKeepAliveThinkingMs);
        expect(params.session.keepAlive).toHaveBeenCalledTimes(2);
        loopParams.setThinking(false);
        expect(params.session.keepAlive).toHaveBeenLastCalledWith(false, 'remote');
        const settledAt = Date.now();
        await vi.advanceTimersByTimeAsync(configuration.sessionKeepAliveIdleMs);
        expect(Date.now()).toBe(settledAt + configuration.sessionKeepAliveIdleMs);
        expect(params.session.keepAlive).toHaveBeenCalledTimes(3);
      },
    });
    try {
      await runSessionLoopLifecycle({
        ...params, deps: { ...params.deps, cleanupBackendRunResourcesFn: cleanupBackendRunResources },
      });
      await vi.advanceTimersByTimeAsync(configuration.sessionKeepAliveThinkingMs);
      expect(params.session.keepAlive).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('runSessionLoopLifecycle checkpoint controls', () => {
  it('materializes a strict initial-resume startup failure as an idle failed session turn', async () => {
    const resumeFailure = new Error('resume transport unavailable');
    const baseParams = createLifecycleParams({
      runPermissionModePromptLoopFn: vi.fn(async (loopParams) => {
        await loopParams.onStrictInitialResumeFailure?.({
          resumeId: 'resume-123',
          error: resumeFailure,
        });
        throw resumeFailure;
      }),
    });
    const session = baseParams.session as unknown as {
      enqueueSessionTurnMutation: ReturnType<typeof vi.fn>;
    };

    await expect(runSessionLoopLifecycle({
      ...baseParams,
      initialResumeId: 'resume-123',
    })).rejects.toBe(resumeFailure);

    expect(session.enqueueSessionTurnMutation).toHaveBeenCalledWith(expect.objectContaining({
      action: 'begin',
      agentId: 'codex',
    }));
    expect(session.enqueueSessionTurnMutation).toHaveBeenCalledWith(expect.objectContaining({
      action: 'fail',
      agentId: 'codex',
      issue: expect.objectContaining({
        scope: 'primary_session',
        status: 'failed',
        source: 'agent_status_error',
      }),
    }));
  });

  it('awaits startup authority preparation before entering the prompt loop', async () => {
    const order: string[] = [];
    let releaseStartup!: () => void;
    const startupGate = new Promise<void>((resolve) => {
      releaseStartup = resolve;
    });
    const runPermissionModePromptLoopFn: RunPermissionModePromptLoopFn =
      vi.fn(async () => {
        order.push('prompt-loop');
      });
    const baseParams = createLifecycleParams({
      policyAgentId: 'codex',
      runPermissionModePromptLoopFn,
    });
    const createSendReady = vi.fn(() => vi.fn());
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      config: {
        ...baseParams.config,
        createSendReady,
      },
      startupCoordinator: {
        start: async () => {
          order.push('startup:start');
          await startupGate;
          order.push('startup:ready');
        },
        cleanup: vi.fn(async () => undefined),
      },
    };

    const lifecycle = runSessionLoopLifecycle(params);
    await vi.waitFor(() => {
      expect(order).toContain('startup:start');
    });
    expect(createSendReady).not.toHaveBeenCalled();
    expect(runPermissionModePromptLoopFn).not.toHaveBeenCalled();

    releaseStartup();
    await lifecycle;

    expect(order).toEqual([
      'startup:start',
      'startup:ready',
      'prompt-loop',
    ]);
    expect(createSendReady).toHaveBeenCalledOnce();
  });

  it('propagates startup authority preparation failure without entering the prompt loop', async () => {
    const authorityFailure = new Error('required startup authority refresh failed');
    const runPermissionModePromptLoopFn: RunPermissionModePromptLoopFn =
      vi.fn(async () => undefined);
    const cleanup = vi.fn(async () => undefined);
    const baseParams = createLifecycleParams({
      policyAgentId: 'codex',
      runPermissionModePromptLoopFn,
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      startupCoordinator: {
        start: vi.fn(async () => {
          throw authorityFailure;
        }),
        cleanup,
      },
    };

    await expect(runSessionLoopLifecycle(params)).rejects.toBe(authorityFailure);

    expect(runPermissionModePromptLoopFn).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(baseParams.session.close).toHaveBeenCalledOnce();
    expect(baseParams.session.endSessionAndClose).not.toHaveBeenCalled();
  });

  it('does not enter the provider prompt loop when initial Session creation has no durable custody', async () => {
    const runPermissionModePromptLoopFn: RunPermissionModePromptLoopFn =
      vi.fn(async () => undefined);
    const bootstrap = await createDeferredStartupBootstrap({
      credentials: { token: 'test-token' } as never,
      startedBy: 'terminal',
      initialMachineId: 'machine-1',
      machineMetadata,
      sessionTag: 'initial-offline-custody-test',
      initialMetadata: createMetadata(),
      createInitializedSessionMetadata: (machineId) => ({
        metadata: { ...createMetadata(), machineId },
        state: {},
      }),
      uiLogPrefix: '[Test]',
      startupMetadataOverrides: {
        permissionModeOverride: { mode: 'default', updatedAt: 1 },
      },
      deps: {
        initializeBackendApiContextFn: async () => ({
          api: {
            getOrCreateSession: vi.fn(async () => null),
            sessionSyncClient: vi.fn(),
            push: () => ({
              sendToAllDevices: vi.fn(),
              sendToAllDevicesAsync: vi.fn(async () => true),
            }),
          } as unknown as ApiClient,
          machineId: 'machine-1',
        }),
      },
    });
    const baseParams = createLifecycleParams({ runPermissionModePromptLoopFn });

    await expect(runSessionLoopLifecycle({
      ...baseParams,
      startupCoordinator: {
        start: bootstrap.start,
        cancel: bootstrap.cancel,
        cleanup: bootstrap.cleanup,
      },
    })).rejects.toMatchObject({
      name: 'BackendRunSessionUnavailableError',
      code: 'backend_run_session_unavailable',
    });

    expect(runPermissionModePromptLoopFn).not.toHaveBeenCalled();
    expect(baseParams.runtime.sendTurnPrompt).not.toHaveBeenCalled();
  });

  it('does not log a hostile startup cleanup rejection after startup fails', async () => {
    loggerDebugMock.mockClear();
    const authorityFailure = new Error('required startup authority refresh failed');
    const hostileCleanupFailure = createRevokedTranscriptFailure(
      'private startup instructions must not enter cleanup logs',
    );
    const baseParams = createLifecycleParams({
      policyAgentId: 'codex',
      runPermissionModePromptLoopFn: vi.fn(async () => undefined),
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      startupCoordinator: {
        start: vi.fn(async () => {
          throw authorityFailure;
        }),
        cleanup: vi.fn(async () => {
          throw hostileCleanupFailure;
        }),
      },
    };

    await expect(runSessionLoopLifecycle(params)).rejects.toBe(authorityFailure);

    expect(loggerReceivedIdentity(hostileCleanupFailure)).toBe(false);
    expect(loggerDebugMock).toHaveBeenCalledWith(
      '[Test] Shared startup coordinator cleanup failed after startup rejection (non-fatal)',
      { error: 'startup_coordinator_cleanup_failed' },
    );
  });

  it('uses provider-neutral checkpoint protocol config instead of inferring from provider id', async () => {
    checkpointFactory.mockClear();
    const params = createLifecycleParams({
      policyAgentId: 'codex',
      checkpointToolProtocol: 'claude',
    });

    await runSessionLoopLifecycle(params);

    expect(checkpointFactory).toHaveBeenCalledWith(expect.objectContaining({
      protocol: 'claude',
      provider: 'codex',
    }));
  });

  it('passes pending queue delivery timing from account settings into the permission prompt loop', async () => {
    let observedPendingQueueDeliveryTiming: unknown;
    const runPermissionModePromptLoopFn: RunPermissionModePromptLoopFn = vi.fn(async (loopParams) => {
      observedPendingQueueDeliveryTiming = loopParams.pendingQueueDeliveryTiming;
    });
    const params = createLifecycleParams({ policyAgentId: 'codex', runPermissionModePromptLoopFn });
    params.opts.accountSettingsContext = {
      source: 'network',
      settings: {
        sessionPendingQueueDeliveryTiming: 'after_runtime_idle',
      } as any,
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      whenRefreshed: null,
    };

    await runSessionLoopLifecycle(params);

    expect(observedPendingQueueDeliveryTiming).toBe('after_runtime_idle');
  });
});

describe('runSessionLoopLifecycle daemon exact-turn custody', () => {
  it('preserves caller process-lifecycle ownership while exposing canonical explicit stop', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'claude' });
    let registration: Parameters<typeof registerRunnerTerminationHandlers>[0] | null = null;
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      config: {
        ...baseParams.config,
        processLifecycleOwnership: 'caller',
      },
      deps: {
        ...baseParams.deps,
        registerRunnerTerminationHandlersFn: vi.fn((nextRegistration) => {
          registration = nextRegistration;
          return {
            dispose: vi.fn(),
            requestTermination: vi.fn(),
            whenTerminated: Promise.resolve({
              event: { kind: 'killSession' as const },
              outcome: computeRunnerTerminationOutcome({ kind: 'killSession' }),
            }),
          };
        }),
      },
    };

    await runSessionLoopLifecycle(params);

    expect(registration).toEqual(expect.objectContaining({
      processLifecycleOwnership: 'caller',
    }));
  });

  it('exposes the canonical explicit-stop operation to a scoped runtime composition', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'claude' });
    let exposedStop: (() => Promise<void>) | null = null;
    let releasePromptLoop!: () => void;
    const promptLoopReleased = new Promise<void>((resolve) => { releasePromptLoop = resolve; });
    const requestTermination = vi.fn();
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      config: {
        ...baseParams.config,
        onRuntimeStopReady: (stop) => { exposedStop = stop; },
      },
      deps: {
        ...baseParams.deps,
        registerRunnerTerminationHandlersFn: vi.fn(() => ({
          dispose: vi.fn(), requestTermination,
          whenTerminated: Promise.resolve({ event: { kind: 'killSession' as const }, outcome: computeRunnerTerminationOutcome({ kind: 'killSession' }) }),
        })),
        runPermissionModePromptLoopFn: vi.fn(async () => { await promptLoopReleased; }),
      },
    };

    const runPromise = runSessionLoopLifecycle(params);
    await vi.waitFor(() => expect(exposedStop).not.toBeNull());
    await exposedStop!();
    expect(requestTermination).toHaveBeenCalledOnce();
    releasePromptLoop();
    await runPromise;
  });

  it('disposes the runtime as session_closed before explicit killSession requests runner termination', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'claude' });
    const order: string[] = [];
    let killSession: (() => Promise<void>) | null = null;
    let releasePromptLoop!: () => void;
    const promptLoopReleased = new Promise<void>((resolve) => {
      releasePromptLoop = resolve;
    });
    const runtime = baseParams.runtime as unknown as {
      resetOrDisposeRuntime: ReturnType<typeof vi.fn>;
    };
    runtime.resetOrDisposeRuntime.mockImplementation(async (reason?: string) => {
      order.push(`runtime_disposed:${reason ?? 'missing'}`);
    });
    const requestTermination = vi.fn(() => {
      order.push('termination_requested');
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      deps: {
        ...baseParams.deps,
        registerKillSessionHandlerFn: vi.fn((_manager, handler) => {
          killSession = handler;
        }),
        registerRunnerTerminationHandlersFn: vi.fn(() => ({
          dispose: vi.fn(),
          requestTermination,
          whenTerminated: Promise.resolve({
            event: { kind: 'killSession' as const },
            outcome: computeRunnerTerminationOutcome({ kind: 'killSession' }),
          }),
        })),
        runPermissionModePromptLoopFn: vi.fn(async () => {
          await promptLoopReleased;
        }),
      },
    };

    const runPromise = runSessionLoopLifecycle(params);
    await vi.waitFor(() => expect(killSession).not.toBeNull());
    const explicitStop = killSession as (() => Promise<void>) | null;
    if (!explicitStop) throw new Error('Expected killSession handler registration');

    await explicitStop();

    expect(order).toEqual(['runtime_disposed:session_closed', 'termination_requested']);
    releasePromptLoop();
    await runPromise;
  });

  it('keeps the runner alive when explicit killSession runtime disposal fails', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'claude' });
    let killSession: (() => Promise<void>) | null = null;
    let releasePromptLoop!: () => void;
    const promptLoopReleased = new Promise<void>((resolve) => {
      releasePromptLoop = resolve;
    });
    const disposalError = new Error('injected runtime disposal failure');
    const runtime = baseParams.runtime as unknown as {
      resetOrDisposeRuntime: ReturnType<typeof vi.fn>;
    };
    runtime.resetOrDisposeRuntime.mockImplementation(async (reason?: string) => {
      if (reason === 'session_closed') throw disposalError;
    });
    const requestTermination = vi.fn();
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      deps: {
        ...baseParams.deps,
        registerKillSessionHandlerFn: vi.fn((_manager, handler) => {
          killSession = handler;
        }),
        registerRunnerTerminationHandlersFn: vi.fn(() => ({
          dispose: vi.fn(),
          requestTermination,
          whenTerminated: Promise.resolve({
            event: { kind: 'killSession' as const },
            outcome: computeRunnerTerminationOutcome({ kind: 'killSession' }),
          }),
        })),
        runPermissionModePromptLoopFn: vi.fn(async () => {
          await promptLoopReleased;
        }),
      },
    };

    const runPromise = runSessionLoopLifecycle(params);
    await vi.waitFor(() => expect(killSession).not.toBeNull());
    const explicitStop = killSession as (() => Promise<void>) | null;
    if (!explicitStop) throw new Error('Expected killSession handler registration');

    await expect(explicitStop()).rejects.toBe(disposalError);
    expect(requestTermination).not.toHaveBeenCalled();

    releasePromptLoop();
    await runPromise;
  });

  it.each(['host shutdown', 'foreground Stop', 'session Stop', 'daemon Stop', 'unavailable Stop intent'] as const)('retains questions only across %s while retiring native permissions', async retirement => {
    const base = createLifecycleParams({ runPermissionModePromptLoopFn: runPermissionModePromptLoop });
    const session = base.session;
    let localMetadata = createMetadata();
    const refreshSnapshot = session.refreshSessionSnapshotFromServerRequired.bind(session);
    let releaseSnapshot: () => void = () => undefined;
    const snapshotReleased = new Promise<void>(resolve => { releaseSnapshot = resolve; });
    Object.assign(session, {
      getMetadataSnapshot: () => localMetadata,
      // The mutable Session fixture is the persistence/transport boundary. Its
      // local metadata intentionally lags the already committed Stop marker.
      refreshSessionSnapshotFromServerRequired: async () => {
        if (retirement === 'daemon Stop') {
          await snapshotReleased;
          localMetadata = writeSessionExplicitStopV1ToMetadata(localMetadata, {
            v: 1, cause: 'explicit_stop', requestId: 'committed-stop', requestedAtMs: 1,
          });
        } else if (retirement === 'unavailable Stop intent') throw new Error('Home unavailable');
        else await refreshSnapshot();
      },
    });
    const rpc = new RpcHandlerManager({ scopePrefix: session.sessionId, encryptionMode: 'plain' });
    Object.assign(session, { rpcHandlerManager: rpc });
    const permission = new ProviderEnforcedPermissionHandler(session, { logPrefix: '[Question lifetime]' });
    const question = permission.handleToolCall('retained-question', 'AskUserQuestion', {
      questions: [{ question: 'Continue after the runner returns?', options: [{ label: 'Yes' }] }],
    }, { lifetime: 'occurrence', origin: 'host_occurrence_question' });
    void question.catch(() => undefined);
    await vi.waitFor(() => expect(session.getAgentStateSnapshot()?.requests?.['retained-question']).toBeDefined());
    // The persistence boundary also contains a native permission from this runner.
    // It must be retired even when a durable question survives physical shutdown.
    await session.updateAgentState(state => ({ ...state, requests: { ...state.requests,
      'native-permission': { tool: 'Write', arguments: { path: '/workspace/native' }, createdAt: 1, kind: 'permission' },
    } }));
    const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(
      mode => JSON.stringify(mode), { batcher: combinePermissionModeQueuedPrompts },
    );
    let termination: ReturnType<typeof registerRunnerTerminationHandlers> | undefined;
    let stopSession: (() => Promise<void>) | undefined;
    const running = runSessionLoopLifecycle({
      ...base, session, permissionHandler: permission,
      config: { ...base.config, onRuntimeStopReady: stop => { stopSession = stop; } },
      permissionModeState: { ...base.permissionModeState, messageQueue: queue },
      deps: { ...base.deps, cleanupBackendRunResourcesFn: cleanupBackendRunResources,
        registerRunnerTerminationHandlersFn: registration => {
          termination = registerRunnerTerminationHandlers({ ...registration, processLifecycleOwnership: 'caller',
            sessionExitReport: null, exit: () => undefined });
          return termination;
        } },
    });
    try {
      await vi.waitFor(() => expect(termination).toBeDefined());
      if (!termination) throw new Error('Runner termination unavailable');
      if (retirement === 'session Stop') {
        if (!stopSession) throw new Error('Session Stop unavailable');
        await stopSession();
      } else {
        if (retirement === 'foreground Stop') await rpc.invokeLocal('abort', {});
        termination.requestTermination({ kind: 'signal', signal: 'SIGTERM' });
      }
      if (retirement === 'daemon Stop') {
        // The authoritative read must not delay native retirement, and close
        // must wait for its permission decision instead of losing that read.
        await vi.waitFor(() => expect(base.runtime.resetOrDisposeRuntime).toHaveBeenCalledWith('host_shutdown'));
        expect(base.session.endSessionAndClose).not.toHaveBeenCalled();
        releaseSnapshot();
      }
      await termination.whenTerminated;
      await running;
      const state = session.getAgentStateSnapshot();
      expect(state?.requests?.['native-permission']).toBeUndefined();
      expect(state?.completedRequests?.['native-permission']).toMatchObject({ status: 'canceled' });
      if (retirement === 'host shutdown' || retirement === 'unavailable Stop intent') {
        expect(state?.requests?.['retained-question']).toMatchObject({ tool: 'AskUserQuestion', lifetime: 'occurrence' });
        expect(state?.completedRequests?.['retained-question']).toBeUndefined();
        const resumedRpc = new RpcHandlerManager({ scopePrefix: session.sessionId, encryptionMode: 'plain' });
        Object.assign(session, { rpcHandlerManager: resumedRpc });
        const resumedPermission = new ProviderEnforcedPermissionHandler(session, { logPrefix: '[Question rejoin]' });
        try {
          await resumedRpc.invokeLocal('session.user_action.answer', {
            id: 'retained-question', approved: true, answers: { 'Continue after the runner returns?': ['Yes'] },
          });
          expect(session.getAgentStateSnapshot()?.requests?.['retained-question']).toBeUndefined();
          expect(session.getAgentStateSnapshot()?.completedRequests?.['retained-question']).toMatchObject({
            status: 'approved', structuredAnswersV1: { 'Continue after the runner returns?': ['Yes'] },
          });
        } finally {
          await resumedPermission.reset();
        }
      } else {
        expect(state?.requests?.['retained-question']).toBeUndefined();
        expect(state?.completedRequests?.['retained-question']).toMatchObject({ status: 'canceled', reason: 'Foreground turn stopped' });
      }
    } finally {
      releaseSnapshot();
      termination?.requestTermination({ kind: 'signal', signal: 'SIGTERM' });
      await running;
      await question.catch(() => undefined);
    }
  });

  it('disposes native process custody as host_shutdown without waiting for native cancellation', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'claude' });
    let releaseNativeCancellation!: () => void;
    const nativeCancellation = new Promise<void>((resolve) => { releaseNativeCancellation = resolve; });
    const termination = {
      onTerminate: null as ((event: RunnerTerminationEvent, outcome: RunnerTerminationOutcome) => void | Promise<void>) | null,
    };
    let releasePromptLoop!: () => void;
    const promptLoopReleased = new Promise<void>((resolve) => {
      releasePromptLoop = resolve;
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      runtime: { ...baseParams.runtime, cancelTurn: () => nativeCancellation },
      hookRuntime: { ...baseParams.hookRuntime, cancelTurn: () => nativeCancellation },
      deps: {
        ...baseParams.deps,
        registerRunnerTerminationHandlersFn: vi.fn((registration) => {
          termination.onTerminate = registration.onTerminate;
          return {
            dispose: vi.fn(),
            requestTermination: vi.fn(),
            whenTerminated: new Promise<Readonly<{
              event: RunnerTerminationEvent;
              outcome: RunnerTerminationOutcome;
            }>>(() => undefined),
          };
        }),
        cleanupBackendRunResourcesFn: cleanupBackendRunResources,
        runPermissionModePromptLoopFn: vi.fn(async () => {
          await promptLoopReleased;
        }),
      },
    };

    const runPromise = runSessionLoopLifecycle(params);
    await vi.waitFor(() => expect(termination.onTerminate).not.toBeNull());
    const onTerminate = termination.onTerminate;
    if (!onTerminate) throw new Error('Expected runner termination handler registration');

    const stopping = onTerminate(
      { kind: 'signal', signal: 'SIGTERM' },
      computeRunnerTerminationOutcome({ kind: 'signal', signal: 'SIGTERM' }),
    );
    try {
      await vi.waitFor(() => expect(baseParams.runtime.resetOrDisposeRuntime).toHaveBeenCalledWith('host_shutdown'));
      await vi.waitFor(() => expect(baseParams.session.endSessionAndClose).toHaveBeenCalled());
      await stopping;
    } finally {
      releaseNativeCancellation();
      await stopping;
      releasePromptLoop();
      await runPromise;
    }
  });

  it('fences claimed Pending input before a planned replacement disposes its runtime', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'claude' });
    const termination = {
      onTerminate: null as ((event: RunnerTerminationEvent, outcome: RunnerTerminationOutcome) => void | Promise<void>) | null,
    };
    let releaseDisposal!: () => void;
    const disposalReleased = new Promise<void>((resolve) => { releaseDisposal = resolve; });
    const runtime = baseParams.runtime as unknown as { resetOrDisposeRuntime: ReturnType<typeof vi.fn> };
    runtime.resetOrDisposeRuntime.mockImplementation(async () => { await disposalReleased; });
    let releasePromptLoop!: () => void;
    const promptLoopReleased = new Promise<void>((resolve) => { releasePromptLoop = resolve; });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      deps: {
        ...baseParams.deps,
        registerRunnerTerminationHandlersFn: vi.fn((registration) => {
          termination.onTerminate = registration.onTerminate;
          return {
            dispose: vi.fn(),
            requestTermination: vi.fn(),
            whenTerminated: new Promise<Readonly<{
              event: RunnerTerminationEvent;
              outcome: RunnerTerminationOutcome;
            }>>(() => undefined),
          };
        }),
        runPermissionModePromptLoopFn: vi.fn(async () => { await promptLoopReleased; }),
      },
    };

    const runPromise = runSessionLoopLifecycle(params);
    await vi.waitFor(() => expect(termination.onTerminate).not.toBeNull());
    const onTerminate = termination.onTerminate;
    if (!onTerminate) throw new Error('Expected runner termination handler registration');

    const stopping = onTerminate(
      { kind: 'signal', signal: 'SIGTERM' },
      computeRunnerTerminationOutcome({ kind: 'signal', signal: 'SIGTERM' }),
    );
    try {
      await vi.waitFor(() => expect(runtime.resetOrDisposeRuntime).toHaveBeenCalledWith('host_shutdown'));
      // Disposal is still pending: the prompt loop must already be unable to cross its effect boundary.
      expect(baseParams.session.retireUndispatchedProviderInput).toHaveBeenCalledOnce();
    } finally {
      releaseDisposal();
      await stopping;
      releasePromptLoop();
      await runPromise;
    }
  });

  it('durably ends the active API session before daemon-started SIGTERM cleanup completes', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'grok' });
    const termination = {
      onTerminate: null as ((event: RunnerTerminationEvent, outcome: RunnerTerminationOutcome) => void | Promise<void>) | null,
    };
    let releasePromptLoop!: () => void;
    const promptLoopReleased = new Promise<void>((resolve) => {
      releasePromptLoop = resolve;
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      opts: { ...baseParams.opts, startedBy: 'daemon' },
      deps: {
        ...baseParams.deps,
        registerRunnerTerminationHandlersFn: vi.fn((registration) => {
          termination.onTerminate = registration.onTerminate;
          return {
            dispose: vi.fn(),
            requestTermination: vi.fn(),
            whenTerminated: new Promise<Readonly<{
              event: RunnerTerminationEvent;
              outcome: RunnerTerminationOutcome;
            }>>(() => undefined),
          };
        }),
        runPermissionModePromptLoopFn: vi.fn(async () => {
          await promptLoopReleased;
        }),
      },
    };

    const runPromise = runSessionLoopLifecycle(params);
    await vi.waitFor(() => expect(termination.onTerminate).not.toBeNull());
    const onTerminate = termination.onTerminate;
    if (!onTerminate) throw new Error('Expected runner termination handler registration');

    await onTerminate(
      { kind: 'signal', signal: 'SIGTERM' },
      computeRunnerTerminationOutcome({ kind: 'signal', signal: 'SIGTERM' }),
    );

    expect(baseParams.session.endSessionAndClose).toHaveBeenCalledOnce();
    expect(baseParams.session.close).not.toHaveBeenCalled();
    releasePromptLoop();
    await runPromise;
  });

  it('admits cancellation transcript output before semantic session termination', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'grok' });
    const termination = {
      onTerminate: null as ((event: RunnerTerminationEvent, outcome: RunnerTerminationOutcome) => void | Promise<void>) | null,
    };
    let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
    let releaseTranscriptAdmission!: () => void;
    const transcriptAdmissionReleased = new Promise<void>((resolve) => {
      releaseTranscriptAdmission = resolve;
    });
    let releasePromptLoop!: () => void;
    const promptLoopReleased = new Promise<void>((resolve) => {
      releasePromptLoop = resolve;
    });
    const session = baseParams.session as unknown as {
      enqueueAgentMessageCommitted: ReturnType<typeof vi.fn>;
      endSessionAndClose: ReturnType<typeof vi.fn>;
    };
    session.enqueueAgentMessageCommitted.mockImplementation(async () => {
      await transcriptAdmissionReleased;
      return { persisted: true, delivered: false };
    });
    const runtime = baseParams.runtime as unknown as {
      cancelTurn: ReturnType<typeof vi.fn>;
      subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
    };
    runtime.subscribeRuntimeEvents.mockImplementation((handler: RuntimeTurnMessageHandler) => {
      runtimeEventHandler = handler;
      return () => undefined;
    });
    runtime.cancelTurn.mockImplementation(async () => {
      runtimeEventHandler?.(canonicalRuntimeEvent({
        kind: 'turn-cancelled',
        sessionId: 'session-1',
        emittedAtMs: 1,
        turnId: 'turn-1',
        agentTurnId: 'agent-turn-1',
        cause: 'hostShutdown',
      }));
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      deps: {
        ...baseParams.deps,
        registerRunnerTerminationHandlersFn: vi.fn((registration) => {
          termination.onTerminate = registration.onTerminate;
          return {
            dispose: vi.fn(),
            requestTermination: vi.fn(),
            whenTerminated: new Promise<Readonly<{
              event: RunnerTerminationEvent;
              outcome: RunnerTerminationOutcome;
            }>>(() => undefined),
          };
        }),
        runPermissionModePromptLoopFn: vi.fn(async () => {
          await promptLoopReleased;
        }),
      },
    };

    const runPromise = runSessionLoopLifecycle(params);
    await vi.waitFor(() => expect(termination.onTerminate).not.toBeNull());
    const onTerminate = termination.onTerminate;
    if (!onTerminate) throw new Error('Expected runner termination handler registration');

    const terminationPromise = onTerminate(
      { kind: 'signal', signal: 'SIGTERM' },
      computeRunnerTerminationOutcome({ kind: 'killSession' }),
    );
    await vi.waitFor(() => expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledOnce());
    expect(session.endSessionAndClose).not.toHaveBeenCalled();

    releaseTranscriptAdmission();
    await terminationPromise;
    expect(session.endSessionAndClose).toHaveBeenCalledOnce();
    expect(session.enqueueAgentMessageCommitted.mock.invocationCallOrder[0]).toBeLessThan(
      session.endSessionAndClose.mock.invocationCallOrder[0]!,
    );

    releasePromptLoop();
    await runPromise;
  });

  it('routes a confirmed terminal UI exit through the runner termination owner without awaiting native cancellation', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'codex' });
    const runtime = baseParams.runtime as unknown as {
      cancelTurn: ReturnType<typeof vi.fn>;
    };
    let releaseCancel!: () => void;
    const cancelReleased = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    runtime.cancelTurn.mockImplementation(async () => {
      await cancelReleased;
    });
    const termination = {
      onTerminate: null as ((event: RunnerTerminationEvent, outcome: RunnerTerminationOutcome) => void | Promise<void>) | null,
    };
    let resolveTerminated!: (value: Readonly<{
      event: RunnerTerminationEvent;
      outcome: RunnerTerminationOutcome;
    }>) => void;
    const whenTerminated = new Promise<Readonly<{
      event: RunnerTerminationEvent;
      outcome: RunnerTerminationOutcome;
    }>>((resolve) => {
      resolveTerminated = resolve;
    });
    const requestTermination = vi.fn((event: RunnerTerminationEvent) => {
      const onTerminate = termination.onTerminate;
      if (!onTerminate) throw new Error('Expected runner termination handler registration');
      const outcome: RunnerTerminationOutcome = computeRunnerTerminationOutcome(event);
      void Promise.resolve(onTerminate(event, outcome)).then(() => {
        resolveTerminated({ event, outcome });
      });
    });
    const renderedElements: Array<Readonly<{
      props: Readonly<Record<string, unknown>>;
    }>> = [];
    const order: string[] = [];
    let releaseCleanup!: () => void;
    const cleanupReleased = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const sessionEndAndClose = baseParams.session.endSessionAndClose as unknown as ReturnType<typeof vi.fn>;
    sessionEndAndClose.mockImplementation(async () => {
      order.push('end');
    });
    const cleanupBackendRunResourcesFn = vi.fn(async (
      { stopKeepAlive }: { stopKeepAlive: () => void },
    ) => {
      stopKeepAlive();
      order.push('cleanup:start');
      await cleanupReleased;
      order.push('cleanup:end');
    });
    const renderFn: NonNullable<
      NonNullable<SessionLoopLifecycleParams['deps']>['renderFn']
    > = vi.fn((element) => {
      renderedElements.push(element as Readonly<{
        props: Readonly<Record<string, unknown>>;
      }>);
      return {
        rerender: vi.fn(),
        unmount: vi.fn(),
        waitUntilExit: vi.fn(async () => undefined),
        cleanup: vi.fn(),
        clear: vi.fn(),
      };
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      opts: {
        ...baseParams.opts,
        startedBy: 'terminal',
      },
      config: {
        ...baseParams.config,
        shouldRenderTerminalDisplay: () => true,
      },
      deps: {
        ...baseParams.deps,
        cleanupBackendRunResourcesFn,
        renderFn,
        registerRunnerTerminationHandlersFn: vi.fn((registration) => {
          termination.onTerminate = registration.onTerminate;
          return {
            dispose: vi.fn(),
            requestTermination,
            whenTerminated,
          };
        }),
        runPermissionModePromptLoopFn: vi.fn(async (loopParams) => {
          const signal = loopParams.getAbortSignal();
          if (signal.aborted) return;
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
        }),
      },
    };
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });

    try {
      const runPromise = runSessionLoopLifecycle(params);
      await vi.waitFor(() => {
        expect(renderedElements).toHaveLength(1);
        expect(termination.onTerminate).not.toBeNull();
      });
      const onExit = renderedElements[0]?.props.onExit;
      if (typeof onExit !== 'function') throw new Error('Expected terminal display exit handler');

      let exitSettled = false;
      const exitPromise = Promise.resolve(onExit()).then(() => {
        exitSettled = true;
      });
      await vi.waitFor(() => {
        expect(runtime.cancelTurn).toHaveBeenCalledOnce();
      });
      await vi.waitFor(() => {
        expect(baseParams.session.endSessionAndClose).toHaveBeenCalledOnce();
        expect(cleanupBackendRunResourcesFn).toHaveBeenCalledOnce();
      });
      await new Promise((resolve) => setImmediate(resolve));
      const exitSettledBeforeCleanup = exitSettled;
      releaseCleanup();
      await exitPromise;
      await runPromise;
      releaseCancel();

      expect(order).toEqual([
        'end',
        'cleanup:start',
        'cleanup:end',
      ]);
      expect(exitSettledBeforeCleanup).toBe(false);
      expect(requestTermination).toHaveBeenCalledWith({
        kind: 'signal',
        signal: 'SIGINT',
      });
      // A terminal-started session that terminates stays unarchived and resumable.
      expect(baseParams.session.endSessionAndClose).toHaveBeenCalledOnce();
    } finally {
      releaseCancel();
      releaseCleanup();
      if (stdoutDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
      if (stdinDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
    }
  });

  it('drains host shutdown work before closing the session', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'codex' });
    const order: string[] = [];
    const termination = {
      onTerminate: null as ((event: RunnerTerminationEvent, outcome: RunnerTerminationOutcome) => void | Promise<void>) | null,
    };
    let releasePromptLoop!: () => void;
    const promptLoopReleased = new Promise<void>((resolve) => {
      releasePromptLoop = resolve;
    });
    const sessionClose = baseParams.session.close as unknown as ReturnType<typeof vi.fn>;
    sessionClose.mockImplementation(async () => {
      order.push('close');
    });
    const sessionEndAndClose = baseParams.session.endSessionAndClose as unknown as ReturnType<typeof vi.fn>;
    sessionEndAndClose.mockImplementation(async () => {
      order.push('end');
      await sessionClose();
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      config: {
        ...baseParams.config,
      },
      deps: {
        ...baseParams.deps,
        onBeforeSessionClose: async () => {
          order.push('drain');
        },
        registerRunnerTerminationHandlersFn: vi.fn((registration) => {
          termination.onTerminate = registration.onTerminate;
          return {
            dispose: vi.fn(),
            requestTermination: vi.fn((_event: RunnerTerminationEvent) => undefined),
            whenTerminated: new Promise<Readonly<{
              event: RunnerTerminationEvent;
              outcome: RunnerTerminationOutcome;
            }>>(() => {}),
          };
        }),
        runPermissionModePromptLoopFn: vi.fn(async () => {
          await promptLoopReleased;
        }),
      },
    };

    const lifecycle = runSessionLoopLifecycle(params);
    await vi.waitFor(() => expect(termination.onTerminate).not.toBeNull());
    const onTerminate = termination.onTerminate;
    if (!onTerminate) throw new Error('Expected runner termination handler registration');
    await onTerminate(
      { kind: 'signal', signal: 'SIGINT' },
      computeRunnerTerminationOutcome({ kind: 'signal', signal: 'SIGINT' }),
    );

    expect(order).toEqual(['drain', 'end', 'close']);
    releasePromptLoop();
    await lifecycle;
  });

  it('does not close the session when host shutdown work rejects', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'codex' });
    const shutdownError = new Error('session_closed');
    const termination = {
      onTerminate: null as ((event: RunnerTerminationEvent, outcome: RunnerTerminationOutcome) => void | Promise<void>) | null,
    };
    let releasePromptLoop!: () => void;
    const promptLoopReleased = new Promise<void>((resolve) => {
      releasePromptLoop = resolve;
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      config: {
        ...baseParams.config,
      },
      deps: {
        ...baseParams.deps,
        onBeforeSessionClose: async () => {
          throw shutdownError;
        },
        registerRunnerTerminationHandlersFn: vi.fn((registration) => {
          termination.onTerminate = registration.onTerminate;
          return {
            dispose: vi.fn(),
            requestTermination: vi.fn((_event: RunnerTerminationEvent) => undefined),
            whenTerminated: new Promise<Readonly<{
              event: RunnerTerminationEvent;
              outcome: RunnerTerminationOutcome;
            }>>(() => {}),
          };
        }),
        runPermissionModePromptLoopFn: vi.fn(async () => {
          await promptLoopReleased;
        }),
      },
    };

    const lifecycle = runSessionLoopLifecycle(params);
    await vi.waitFor(() => expect(termination.onTerminate).not.toBeNull());
    const onTerminate = termination.onTerminate;
    if (!onTerminate) throw new Error('Expected runner termination handler registration');
    await expect(onTerminate(
      { kind: 'signal', signal: 'SIGINT' },
      computeRunnerTerminationOutcome({ kind: 'uncaughtException' }),
    )).rejects.toBe(shutdownError);
    expect(baseParams.session.close).not.toHaveBeenCalled();
    releasePromptLoop();
    await lifecycle;
  });

  it.each(['complete', 'wait-cancel', 'wait-complete', 'other-question'] as const)('publishes exact turn identity after durable %s acceptance', async outcome => {
    const baseParams = createLifecycleParams({ policyAgentId: 'codex' });
    const waiting = outcome === 'wait-cancel' || outcome === 'wait-complete';
    const cancelled = outcome === 'wait-cancel' || outcome === 'other-question';
    let questionWaitTurnId: string | null = outcome === 'complete' ? null
      : outcome === 'other-question' ? 'other-turn' : 'turn-exact-1';
    Object.assign(baseParams.session, { requiresDurableTurnCompletionMarker: true,
      readQuestionWaitTurnId(this: { sessionId: string }) {
      return this.sessionId === 'session-1' ? questionWaitTurnId : null;
    } });
    let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
    const runtime = baseParams.runtime as unknown as {
      subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
    };
    runtime.subscribeRuntimeEvents = vi.fn((handler: RuntimeTurnMessageHandler) => {
      runtimeEventHandler = handler;
      return () => undefined;
    });
    const notifyDaemonConnectedServiceTurnLifecycleFn = vi.fn<NotifyDaemonConnectedServiceTurnLifecycleFn>(async (input) => ({
      status: 'continue' as const,
      turnCustody: {
        status: 'recorded' as const,
        activeTurnId:
          input.event === 'task_started'
            ? input.turnId ?? null
            : null,
      },
    }));
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      opts: {
        ...baseParams.opts,
        startedBy: 'daemon',
      },
      deps: {
        ...baseParams.deps,
        notifyDaemonConnectedServiceTurnLifecycleFn,
        runPermissionModePromptLoopFn: vi.fn(async () => {
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 1,
            turnId: 'turn-exact-1',
            startedBy: 'host',
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: cancelled ? 'turn-cancelled' : 'turn-complete',
            sessionId: 'session-1',
            emittedAtMs: 2,
            turnId: 'turn-exact-1',
            ...(cancelled ? { cause: 'user' } : {}),
          }));
          // A successor can clear live yield intent before the ordered async
          // transcript projection runs; the original observation stays waiting.
          questionWaitTurnId = null;
        }),
      },
    };

    await runSessionLoopLifecycle(params);

    await vi.waitFor(() => expect(notifyDaemonConnectedServiceTurnLifecycleFn).toHaveBeenCalledTimes(2));
    expect(notifyDaemonConnectedServiceTurnLifecycleFn).toHaveBeenNthCalledWith(1, {
      sessionId: 'session-1',
      event: 'task_started',
      turnId: 'turn-exact-1',
    });
    expect(notifyDaemonConnectedServiceTurnLifecycleFn).toHaveBeenNthCalledWith(2, {
      sessionId: 'session-1',
      event: outcome === 'other-question' ? 'turn_cancelled' : 'assistant_message_end',
      ...(outcome === 'complete' ? { terminalStatus: 'completed' } : {}),
      turnId: 'turn-exact-1',
    });
    expect(vi.mocked(baseParams.session.enqueueSessionTurnMutation!).mock.calls.map(([mutation]) => mutation.action))
      .toEqual(['begin', waiting ? 'wait' : cancelled ? 'cancel' : 'complete']);
    const transcriptMarkers = vi.mocked(baseParams.session.enqueueAgentMessageCommitted!).mock.calls
      .map(([, body]) => body.type).filter(type => type === 'turn_cancelled' || type === 'task_complete');
    if (waiting) {
      expect(transcriptMarkers).toEqual([]);
    } else {
      expect(transcriptMarkers).toEqual([cancelled ? 'turn_cancelled' : 'task_complete']);
    }
  });

  it('does not finish runner cleanup until a rejected exact begin reaches marker custody', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'codex' });
    let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
    const runtime = baseParams.runtime as unknown as {
      subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
    };
    runtime.subscribeRuntimeEvents = vi.fn((handler: RuntimeTurnMessageHandler) => {
      runtimeEventHandler = handler;
      return () => undefined;
    });
    let releaseRecorded!: () => void;
    const recorded = new Promise<void>((resolve) => {
      releaseRecorded = resolve;
    });
    const notifyDaemonConnectedServiceTurnLifecycleFn = vi.fn<NotifyDaemonConnectedServiceTurnLifecycleFn>(async (input) => {
      if (notifyDaemonConnectedServiceTurnLifecycleFn.mock.calls.length === 1) {
        return {
          status: 'continue' as const,
          turnCustody: { status: 'ignored_marker_not_updated' as const, activeTurnId: null },
        };
      }
      await recorded;
      return {
        status: 'continue' as const,
        turnCustody: {
          status: 'recorded' as const,
          activeTurnId: input.turnId ?? null,
        },
      };
    });
    const cleanupBackendRunResourcesFn = vi.fn(async ({ stopKeepAlive }: { stopKeepAlive: () => void }) => {
      stopKeepAlive();
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      opts: { ...baseParams.opts, startedBy: 'daemon' },
      deps: {
        ...baseParams.deps,
        cleanupBackendRunResourcesFn,
        notifyDaemonConnectedServiceTurnLifecycleFn,
        runPermissionModePromptLoopFn: vi.fn(async () => {
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 1,
            turnId: 'turn-exact-retry',
            startedBy: 'host',
          }));
        }),
      },
    };

    let settled = false;
    const run = runSessionLoopLifecycle(params).then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(notifyDaemonConnectedServiceTurnLifecycleFn).toHaveBeenCalledTimes(2));
    expect((baseParams.session as any).enqueueSessionTurnMutation).not.toHaveBeenCalled();
    expect(cleanupBackendRunResourcesFn).not.toHaveBeenCalled();
    expect(settled).toBe(false);

    releaseRecorded();
    await run;
    expect(cleanupBackendRunResourcesFn).toHaveBeenCalledOnce();
    expect(settled).toBe(true);
  });

  it('retains the exact daemon marker without logging a hostile terminal mutation rejection', async () => {
    loggerDebugMock.mockClear();
    const baseParams = createLifecycleParams({ policyAgentId: 'codex' });
    const hostileFailure = createRevokedTranscriptFailure(
      'private terminal mutation transcript must not enter logs',
    );
    let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
    const runtime = baseParams.runtime as unknown as {
      subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
    };
    runtime.subscribeRuntimeEvents = vi.fn((handler: RuntimeTurnMessageHandler) => {
      runtimeEventHandler = handler;
      return () => undefined;
    });
    const session = baseParams.session as unknown as {
      enqueueSessionTurnMutation: ReturnType<typeof vi.fn>;
    };
    session.enqueueSessionTurnMutation.mockImplementation(async (mutation) => {
      if (mutation.action === 'complete') {
        throw hostileFailure;
      }
    });
    let daemonActiveTurnId: string | null = null;
    const notifyDaemonConnectedServiceTurnLifecycleFn = vi.fn<NotifyDaemonConnectedServiceTurnLifecycleFn>(async (input) => {
      daemonActiveTurnId = input.event === 'task_started' ? input.turnId ?? null : null;
      return {
        status: 'continue' as const,
        turnCustody: {
          status: 'recorded' as const,
          activeTurnId: daemonActiveTurnId,
        },
      };
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      opts: { ...baseParams.opts, startedBy: 'daemon' },
      deps: {
        ...baseParams.deps,
        notifyDaemonConnectedServiceTurnLifecycleFn,
        runPermissionModePromptLoopFn: vi.fn(async () => {
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 1,
            turnId: 'turn-terminal-rejection',
            startedBy: 'host',
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-complete',
            sessionId: 'session-1',
            emittedAtMs: 2,
            turnId: 'turn-terminal-rejection',
          }));
        }),
      },
    };

    await runSessionLoopLifecycle(params);

    expect(session.enqueueSessionTurnMutation).toHaveBeenCalledWith(expect.objectContaining({
      action: 'complete',
      turnId: 'turn-terminal-rejection',
    }));
    expect(notifyDaemonConnectedServiceTurnLifecycleFn).toHaveBeenCalledTimes(1);
    expect(notifyDaemonConnectedServiceTurnLifecycleFn).toHaveBeenCalledWith({
      sessionId: 'session-1',
      event: 'task_started',
      turnId: 'turn-terminal-rejection',
    });
    expect(daemonActiveTurnId).toBe('turn-terminal-rejection');
    expect(loggerReceivedIdentity(hostileFailure)).toBe(false);
    expect(loggerDebugMock).toHaveBeenCalledWith(
      '[Test] Runtime terminal turn mutation failed',
      {
        error: 'runtime_terminal_turn_mutation_failed',
        action: 'complete',
      },
    );
  });
});

describe('runSessionLoopLifecycle runtime transcript projection', () => {
  afterAll(async () => {
    await pluginReloadController.shutdown({ timeoutMs: 5_000 });
  });

  it.each(['assistant-first', 'reasoning-first', 'two-outputs', 'cancelled', 'repeated-commit', 'session-replay'] as const)(
    'persists one native assistant message after unkeyed streaming and retains the other channel (%s)', async (scenario) => {
    const registry = await pluginReloadController.acquireRuntimeRegistry({
      resolveRuntimeRegistry: async () => await resolveExecutablePluginRuntimeRegistry({
        contributes: getResolvedContributionRegistry(), pluginIds: [],
      }),
    });
    const base = createLifecycleParams({ runPermissionModePromptLoopFn: runPermissionModePromptLoop });
    const stored = new Map<string, Parameters<NonNullable<typeof base.session.enqueueAgentMessageCommitted>>[1]>();
    const storedOptions = new Map<string, Parameters<NonNullable<typeof base.session.enqueueAgentMessageCommitted>>[2]>();
    vi.mocked(base.session.enqueueAgentMessageCommitted!).mockImplementation(async (_provider, body, options) => {
      if (!options?.localId) throw new Error('A durable transcript row requires its local identity');
      stored.set(options.localId, body);
      storedOptions.set(options.localId, options);
      return { persisted: true, delivered: false };
    });
    const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(
      (mode) => JSON.stringify(mode), { batcher: combinePermissionModeQueuedPrompts },
    );
    queue.push({ text: 'Explain the change', localId: 'input-stream', userMessageSeq: 1 }, { permissionMode: 'default' });
    let listener: ((event: AgentSessionRuntimeEvent) => void) | undefined;
    let checkpointLocalId: string | undefined;
    // The Agent runtime is the external producer boundary. Host admission, prompt loop,
    // projection, stream writer and durable-message validation remain production code.
    const provider: AgentSessionRuntime = {
      async send(request) {
        const turnId = request.delivery.turnId;
        for (const event of [
          { kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery },
          { kind: 'turn-start', turnId: request.delivery.turnId, startedBy: 'host' },
          { kind: 'message-delta', turnId: request.delivery.turnId, channel: 'reasoning', text: 'Checking the change.' },
          { kind: 'message-delta', turnId: request.delivery.turnId, channel: 'assistant', text: 'The change is complete.' },
          ...(scenario === 'reasoning-first' ? [{ kind: 'transcript-message-committed', turnId,
            messageId: 'native-reasoning-fact', role: 'reasoning', text: 'Checked the change.' }] : []),
          ...(scenario === 'cancelled' ? [] : [{ kind: 'transcript-message-committed', turnId,
            messageId: 'native-assistant-fact', role: 'assistant', text: 'The authoritative change is complete.' }]),
          ...(scenario === 'two-outputs' ? [
            { kind: 'message-delta', turnId, channel: 'assistant', text: 'A second output.' },
            { kind: 'transcript-message-committed', turnId, messageId: 'native-assistant-second', role: 'assistant', text: 'The authoritative change is complete.' },
          ] : []),
          ...(scenario === 'repeated-commit' ? [
            { kind: 'message-delta', turnId, channel: 'assistant', text: 'A distinct unfinished output.' },
            { kind: 'transcript-message-committed', turnId, messageId: 'native-assistant-fact', role: 'assistant', text: 'The authoritative change is complete.' },
          ] : []),
          ...(scenario === 'cancelled' || scenario === 'repeated-commit'
            ? [{ kind: 'turn-cancelled', turnId, cause: 'user' }]
            : [{ kind: 'turn-complete', turnId }]),
          ...(scenario === 'session-replay' ? [
            { kind: 'transcript-message-committed', messageId: 'native-assistant-fact', role: 'assistant', text: 'The authoritative change is complete.' },
          ] : []),
          { kind: 'runtime-ended', cause: 'providerEnded', retryable: false },
        ]) {
          // The real report already had a durable checkpoint before native completion.
          // A fix that only discards an unpersisted draft must not pass this case.
          if ((event.kind === 'transcript-message-committed' || event.kind === 'turn-cancelled') && checkpointLocalId === undefined) {
            await vi.waitFor(() => expect([...stored.values()].some(body => body.type === 'message')).toBe(true), { timeout: 10_000 });
            checkpointLocalId = [...stored].find(([, body]) => body.type === 'message')?.[0];
          }
          listener?.(canonicalRuntimeEvent({ ...event, sessionId: 'session-1', emittedAtMs: 1 }));
        }
        return { status: 'admitted' };
      },
      watch(next) { listener = next; return { dispose() { listener = undefined; } }; },
      dispose() {},
    };
    const runtime = createNativeAgentSessionOperations(provider, 'session-1', undefined, undefined, undefined, undefined, undefined,
      { context: { signal: new AbortController().signal } as AgentSessionRuntimeContext,
        cwd: '/workspace', connectedAccounts: [], capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
        cancellation: { declared: false }, configuration: { declared: false }, compaction: { capability: null } });
    try {
      await runSessionLoopLifecycle({ ...base, runtime, hookRuntime: runtime,
        permissionModeState: { ...base.permissionModeState, messageQueue: queue },
        deps: { ...base.deps, registerRunnerTerminationHandlersFn: (registration) => registerRunnerTerminationHandlers({
          process: registration.process, exit: registration.exit, onTerminate: registration.onTerminate, processLifecycleOwnership: 'caller',
        }) },
      });
      const rows = [...stored.values()];
      expect(rows.filter(body => body.type === 'message')).toEqual([
        { type: 'message', message: scenario === 'cancelled' ? 'The change is complete.' : 'The authoritative change is complete.' },
        ...(scenario === 'two-outputs' ? [{ type: 'message', message: 'The authoritative change is complete.' }] : []),
        ...(scenario === 'repeated-commit' ? [{ type: 'message', message: 'A distinct unfinished output.' }] : []),
      ]);
      expect(rows.filter(body => body.type === 'thinking')).toEqual([
        { type: 'thinking', text: scenario === 'reasoning-first' ? 'Checked the change.' : 'Checking the change.' },
      ]);
      expect(checkpointLocalId).toBeDefined();
      expect(stored.get(checkpointLocalId!)?.type).toBe('message');
      expect(storedOptions.get(checkpointLocalId!)?.meta).toMatchObject({ happierStreamSegmentV1: {
        segmentLocalId: checkpointLocalId,
        segmentState: scenario === 'cancelled' ? 'interrupted' : 'complete',
        ...(scenario === 'cancelled' ? {} : { sourceMessageId: 'native-assistant-fact' }),
      } });
      if (scenario === 'two-outputs') {
        const sourceIds = [...stored].filter(([, body]) => body.type === 'message').map(([localId]) =>
          storedOptions.get(localId)?.meta?.happierStreamSegmentV1);
        expect(sourceIds).toEqual([
          expect.objectContaining({ sourceMessageId: 'native-assistant-fact' }),
          expect.objectContaining({ sourceMessageId: 'native-assistant-second' }),
        ]);
      }
      if (scenario === 'repeated-commit') {
        const unfinished = [...stored].find(([, body]) => body.type === 'message' && body.message === 'A distinct unfinished output.');
        expect(unfinished).toBeDefined();
        expect(storedOptions.get(unfinished![0])?.meta).toMatchObject({ happierStreamSegmentV1: {
          segmentLocalId: unfinished![0], segmentState: 'interrupted',
        } });
      }
      if (scenario !== 'cancelled') {
        const beforeReplay = [...stored.entries()];
        const follow = createHostTerminalTranscriptFollowService({
          signal: new AbortController().signal,
          loadCommittedLocalIdBaseline: (input) => loadCommittedTranscriptLocalIdBaseline({ ...input,
            // Home page transport: these are the envelopes produced from the durable writes above.
            fetchPage: async () => ({ messages: [...stored].map(([localId, body]) => ({ localId,
              meta: buildAcpAgentMessageEnvelope({ provider: 'agent', body, meta: storedOptions.get(localId)?.meta }).meta,
            })), hasMore: false, nextBeforeSeq: null }),
          }),
          followProviderSession: async (_request, consume) => {
            await consume({ kind: 'data', phase: 'initial_replay', fromCursor: null, nextCursor: 'tail', items: [
              { id: 'native-assistant-fact', localId: 'native-assistant-fact', kind: 'agent', timestampMs: 2,
                data: StrictJsonValueSchema.parse(buildAcpAgentMessageEnvelope({ provider: 'agent', body: { type: 'message', message: 'The authoritative change is complete.' } })) },
            ] });
            return { status: 'following', startingCursor: 'tail', subscription: { dispose: async () => undefined } };
          },
          publish: createExternalSessionTerminalFollowProjector({ sessionId: 'session-1', agentId: 'agent',
            projectRuntimeEvent: (event, admission) => projectRuntimeTranscriptEvent({ session: base.session,
              provider: 'agent', event, admission }),
          }),
        });
        try {
          await expect(follow.bindProviderSession({ agentId: 'agent', providerSessionId: 'native-session' }))
            .resolves.toMatchObject({ status: 'following' });
          expect([...stored.entries()]).toEqual(beforeReplay);
        } finally {
          await follow.releaseActiveBindings();
        }
      }
    } finally {
      await registry.release();
    }
  });

  it.each([
    { starterDepth: 0, callerDepth: undefined, workDepth: 0 },
    { starterDepth: 2, callerDepth: undefined, workDepth: 2 },
    { starterDepth: 1, callerDepth: 3, workDepth: 4 },
  ])('publishes host Session caller depth $workDepth through the real prompt loop before daemon admission', async ({ starterDepth, callerDepth, workDepth }) => {
    // The real prompt loop consumes the daemon-applied contribution projection.
    // No executable Agent plugin is needed: the provider boundary below owns delivery.
    const runtimeRegistryLease = await pluginReloadController.acquireRuntimeRegistry({
      resolveRuntimeRegistry: async () => await resolveExecutablePluginRuntimeRegistry({
        contributes: getResolvedContributionRegistry(),
        pluginIds: [],
      }),
    });
    try {
      const base = createLifecycleParams({ runPermissionModePromptLoopFn: runPermissionModePromptLoop });
      const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(
        (mode) => JSON.stringify(mode), { batcher: combinePermissionModeQueuedPrompts },
      );
      queue.push({
        text: 'Do the task', localId: 'input-depth', userMessageSeq: 1,
        ...(callerDepth === undefined ? {} : {
          inputProvenance: { v: 1, kind: 'happierSession', sourceSessionId: 'sender', via: 'mcp', callerDepth },
        }),
      }, { permissionMode: 'default' });
      let eventListener: ((event: AgentSessionRuntimeEvent) => void) | undefined;
      const provider: AgentSessionRuntime = {
        async send(request) {
          for (const event of [
            { kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery },
            { kind: 'turn-start', turnId: request.delivery.turnId, startedBy: 'host' },
            { kind: 'turn-complete', turnId: request.delivery.turnId },
            { kind: 'runtime-ended', cause: 'providerEnded', retryable: false },
          ]) eventListener?.(canonicalRuntimeEvent({ ...event, sessionId: 'session-1', emittedAtMs: 1 }));
          return { status: 'admitted' };
        },
        watch(listener) { eventListener = listener; return { dispose() { eventListener = undefined; } }; },
        dispose() {},
      };
      const daemonWitnesses: unknown[] = [];
      const runtime = createNativeAgentSessionOperations(
        provider, 'session-1', undefined, undefined, undefined, undefined, undefined,
        {
          // Only the session cancellation environment is consumed by this native turn.
          context: { signal: new AbortController().signal } as AgentSessionRuntimeContext,
          cwd: '/workspace', connectedAccounts: [],
          capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
          cancellation: { declared: false }, configuration: { declared: false }, compaction: { capability: null },
        },
        undefined, [], undefined, undefined,
        async (witness) => {
          daemonWitnesses.push(projectAgentRuntimeDaemonServiceTurnWitnessV1(witness));
          return { status: 'admitted' };
        },
      );
      let requestTermination: ((event: RunnerTerminationEvent) => void) | undefined;
      const runPromise = runSessionLoopLifecycle({
        ...base, runtime, hookRuntime: runtime,
        session: Object.assign(base.session, { getWorkDepth: () => starterDepth }),
        permissionModeState: { ...base.permissionModeState, messageQueue: queue },
        deps: {
          ...base.deps,
          registerRunnerTerminationHandlersFn: (registration) => {
            // Use real runtime-ended termination without exiting the test process
            // or writing the real runner's process diagnostic file.
            const handlers = registerRunnerTerminationHandlers({
              process: registration.process,
              exit: registration.exit,
              onTerminate: registration.onTerminate,
              processLifecycleOwnership: 'caller',
            });
            requestTermination = handlers.requestTermination;
            return handlers;
          },
        },
      });
      try {
        await vi.waitFor(() => expect({
          daemonWitnesses,
          transcript: vi.mocked(base.session.enqueueAgentMessageCommitted!).mock.calls,
        }).toEqual({
          daemonWitnesses: [expect.objectContaining({
            workDepth,
            agentStartCaller: { kind: 'session', sessionId: 'session-1', starterDepth, turnDepth: callerDepth === undefined ? 0 : callerDepth + 1 },
          })],
          transcript: [],
        }));
        await runPromise;
      } finally {
        requestTermination?.({ kind: 'killSession' });
        await runPromise;
      }
    } finally {
      await runtimeRegistryLease.release();
    }
  });

  it('terminates the runner when its native runtime ends', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'codex' });
    let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
    const runtime = baseParams.runtime as unknown as {
      subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
    };
    runtime.subscribeRuntimeEvents = vi.fn((handler: RuntimeTurnMessageHandler) => {
      runtimeEventHandler = handler;
      return () => undefined;
    });
    const requestTermination = vi.fn();
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      deps: {
        ...baseParams.deps,
        registerRunnerTerminationHandlersFn: vi.fn(() => ({
          dispose: vi.fn(),
          requestTermination,
          whenTerminated: Promise.resolve({
            event: { kind: 'exit' as const, code: 0 },
            outcome: computeRunnerTerminationOutcome({ kind: 'exit', code: 0 }),
          }),
        })),
        runPermissionModePromptLoopFn: vi.fn(async () => {
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'runtime-ended',
            sessionId: 'session-1',
            emittedAtMs: 1,
            cause: 'providerEnded',
            retryable: false,
          }));
        }),
      },
    };

    await runSessionLoopLifecycle(params);

    expect(requestTermination).toHaveBeenCalledOnce();
    expect(requestTermination).toHaveBeenCalledWith({ kind: 'exit', code: 0 });
  });

  it('publishes one native runtime observation to the Host Event broker exactly once', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'codex' });
    let observeNativeEvent!: (event: AgentSessionRuntimeEvent) => void;
    const nativeSession: AgentSessionRuntime = {
      send: vi.fn(async () => ({ status: 'admitted' as const })),
      watch: (listener) => {
        observeNativeEvent = listener;
        return { dispose: () => undefined };
      },
      dispose: vi.fn(),
    };
    const publishHostRuntimeEvent = vi.fn<(event: AgentSessionRuntimeEventV1) => void>();
    const runtime = createNativeAgentSessionOperations(
      nativeSession,
      'session-1',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        context: {} as AgentSessionRuntimeContext,
        cwd: '/repo',
        connectedAccounts: [],
        capabilities: {
          open: ['create'],
          delivery: ['newTurn'],
          cancel: false,
        },
        cancellation: { declared: false },
        configuration: { declared: false },
        compaction: { capability: null },
      },
      undefined,
      [],
      undefined,
      undefined,
      undefined,
      undefined,
    );
    const event = canonicalRuntimeEvent({
      kind: 'runtime-activity-snapshot',
      sessionId: 'session-1',
      emittedAtMs: 1,
      state: 'idle',
      activeCount: 0,
    });

    await runSessionLoopLifecycle({
      ...baseParams,
      runtime,
      hookRuntime: runtime,
      config: {
        ...baseParams.config,
        publishHostRuntimeEvent,
      },
      deps: {
        ...baseParams.deps,
        runPermissionModePromptLoopFn: vi.fn(async () => {
          observeNativeEvent(event);
        }),
      },
    });

    expect(publishHostRuntimeEvent).toHaveBeenCalledOnce();
    expect(publishHostRuntimeEvent).toHaveBeenCalledWith(event);
  });

  it('fans strict agent-session lifecycle classes into Host Events without coupling producer success', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'codex' });
    let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
    const runtime = baseParams.runtime as unknown as {
      subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
    };
    runtime.subscribeRuntimeEvents = vi.fn((handler: RuntimeTurnMessageHandler) => {
      runtimeEventHandler = handler;
      return () => undefined;
    });
    const publishHostRuntimeEvent = vi.fn<(event: AgentSessionRuntimeEventV1) => void>(() => {
      throw new Error('Host Event listener failure');
    });
    const events = [
      canonicalRuntimeEvent({
        kind: 'turn-complete',
        sessionId: 'session-1',
        emittedAtMs: 1,
        turnId: 'turn-1',
      }),
      canonicalRuntimeEvent({
        kind: 'runtime-ended',
        sessionId: 'session-1',
        emittedAtMs: 2,
        cause: 'providerEnded',
        retryable: false,
      }),
      canonicalRuntimeEvent({
        kind: 'runtime-activity-snapshot',
        sessionId: 'session-1',
        emittedAtMs: 3,
        state: 'idle',
        activeCount: 0,
      }),
    ] as const;
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      config: {
        ...baseParams.config,
        publishHostRuntimeEvent,
      },
      deps: {
        ...baseParams.deps,
        runPermissionModePromptLoopFn: vi.fn(async () => {
          for (const event of events) runtimeEventHandler?.(event);
        }),
      },
    };

    await expect(runSessionLoopLifecycle(params)).resolves.toBeUndefined();

    expect(publishHostRuntimeEvent.mock.calls.map(([event]) => event)).toEqual(events);
  });

  it('fails closed before provider effects when required runtime event subscription rejects', async () => {
    loggerDebugMock.mockClear();
    const baseParams = createLifecycleParams({ policyAgentId: 'codex' });
    const hostileFailure = createRevokedTranscriptFailure(
      'private runtime subscription transcript must not enter logs',
    );
    const runtime = baseParams.runtime as unknown as {
      subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
    };
    runtime.subscribeRuntimeEvents = vi.fn(() => {
      throw hostileFailure;
    });
    const runPermissionModePromptLoopFn = vi.fn(async () => undefined);
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      deps: {
        ...baseParams.deps,
        runPermissionModePromptLoopFn,
      },
    };

    await expect(runSessionLoopLifecycle(params)).rejects.toMatchObject({
      code: 'runtime_event_subscription_required',
    });

    expect(loggerReceivedIdentity(hostileFailure)).toBe(false);
    expect(runPermissionModePromptLoopFn).not.toHaveBeenCalled();
    expect(baseParams.deps.cleanupBackendRunResourcesFn).toHaveBeenCalledOnce();
  });

  it.each(['native', 'http'] as const)('settles a %s Browser tool when the real host Stop cancels its containing turn', async entrypoint => {
    // Session policy must retain its reviewed waiver despite the launching
    // process's standalone CLI policy.
    vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', JSON.stringify({ v: 1, actions: {} }));
    const lease = await pluginReloadController.acquireRuntimeRegistry({
      resolveRuntimeRegistry: async () => await resolveExecutablePluginRuntimeRegistry({
        contributes: getResolvedContributionRegistry(), pluginIds: [],
      }),
    });
    const base = createLifecycleParams({ runPermissionModePromptLoopFn: runPermissionModePromptLoop });
    const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(
      mode => JSON.stringify(mode), { batcher: combinePermissionModeQueuedPrompts },
    );
    queue.push({ text: 'Open the browser', localId: 'browser-input', userMessageSeq: 1 }, { permissionMode: 'yolo' });
    let listener: ((event: AgentSessionRuntimeEvent) => void) | undefined;
    const provider: AgentSessionRuntime = {
      async send(request) {
        for (const event of [
          { kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery },
          { kind: 'turn-start', turnId: request.delivery.turnId, startedBy: 'host' },
        ]) listener?.(canonicalRuntimeEvent({ ...event, sessionId: 'session-1', emittedAtMs: 1 }));
        return { status: 'admitted' };
      },
      watch(next) { listener = next; return { dispose() { listener = undefined; } }; },
      dispose() {},
    };
    const runtimeLifetime = new AbortController();
    const runtime = createNativeAgentSessionOperations(provider, 'session-1', undefined, undefined, undefined, undefined, undefined, {
      context: { signal: runtimeLifetime.signal } as AgentSessionRuntimeContext,
      cwd: '/workspace', connectedAccounts: [],
      capabilities: { open: ['create'], delivery: ['newTurn'], cancel: true },
      cancellation: { declared: true, cancel: async ({ turnId }) => {
        listener?.(canonicalRuntimeEvent({ kind: 'turn-cancelled', sessionId: 'session-1', emittedAtMs: 2, turnId, cause: 'user' }));
        return { status: 'requested', turnId };
      } },
      configuration: { declared: false }, compaction: { capability: null },
    });
    const abortTurn: { current?: (() => void | Promise<void>) | null } = {};
    let readTurnSignal: (() => AbortSignal) | undefined;
    const rpc = new RpcHandlerManager({ scopePrefix: 'session-1', encryptionMode: 'plain' });
    const session = Object.assign(base.session, {
      rpcHandlerManager: rpc,
      getServerBinding: () => ({ serverId: 'browser_home', serverUrl: 'https://browser-home.example.test' }),
      getWorkDepth: () => 0,
      getHostTurnWorkDepth: (turnId: string) => {
        const witness = runtime.readActiveTurnAdmissionWitness?.();
        return witness?.turnId === turnId ? witness?.agentStartCaller?.turnDepth : undefined;
      },
      getPermissionMode: () => 'yolo' as const,
      getActiveTurnPermissionWitness: () => runtime.readActiveTurnPermissionWitness?.(),
      getHostTurnAbortSignal: () => readTurnSignal?.() ?? null,
      getRuntimeLifetimeSignal: () => runtimeLifetime.signal,
      getServerFeaturesSnapshot: () => ({ status: 'ready' as const, features: FeaturesResponseSchema.parse({
        features: { browser: { enabled: true, viewTargets: { enabled: true }, internal: { enabled: true }, sidecar: { enabled: true } } },
      }) }),
    });
    registerHappierSessionAgentToolRpc(session, {
      sessionCredentials: { token: 'browser-fixture', encryption: null }, accountSettings: accountSettingsParse({
        actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'browser.view.open': ['agent'] } },
      }),
      pluginRuntimeRegistryLease: lease,
    });
    let enter: (signal: AbortSignal | undefined) => void = () => undefined;
    let release: () => void = () => undefined;
    const entered = new Promise<AbortSignal | undefined>(resolve => { enter = resolve; });
    vi.spyOn(persistence, 'readDaemonState').mockResolvedValue({ pid: 123, httpPort: 12345,
      controlToken: 'browser-control-token', startedAt: 1, startedWithCliVersion: '0.3.0' });
    // The daemon HTTP transport is outside this Session process. All MCP and Action owners remain real.
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      const endpoint = new URL(String(url));
      if (endpoint.port !== '12345') return await realFetch(url, options);
      if (endpoint.pathname !== BROWSER_RUNTIME_ACTION_CONTROL_PATH) throw new Error(`Unexpected daemon request: ${endpoint.pathname}`);
      expect(BrowserRuntimeActionControlRequestSchema.parse(JSON.parse(String(options?.body))))
        .toMatchObject({ actionId: 'browser.view.open', sessionId: 'session-1', input: {
          kind: 'openView', commandId: 'stop-open', browserSessionId: 'session-1',
          target: { kind: 'externalUrl', targetId: 'target', url: 'https://example.test' },
        } });
      const signal = options?.signal ?? undefined;
      enter(signal);
      return await new Promise<Response>((resolve, reject) => {
        release = () => resolve(new Response(JSON.stringify({ result: { v: 1, commandId: 'stop-open', status: 'failed',
          completion: 'known', error: { code: 'adapter_unavailable', message: 'fixture retired' } } })));
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    let terminate: ((event: RunnerTerminationEvent) => void) | undefined;
    const running = runSessionLoopLifecycle({
      ...base, session, runtime, hookRuntime: runtime,
      permissionModeState: { ...base.permissionModeState, messageQueue: queue },
      setAbortRequestedCallback: (callback, signalReader?: () => AbortSignal) => {
        abortTurn.current = callback; readTurnSignal = signalReader;
      },
      deps: { ...base.deps, registerRunnerTerminationHandlersFn: registration => {
        const handlers = registerRunnerTerminationHandlers({ ...registration, processLifecycleOwnership: 'caller', sessionExitReport: null,
          exit: () => undefined });
        terminate = handlers.requestTermination;
        return handlers;
      } },
    });
    let pending: Promise<unknown> | undefined;
    let mcpServer: Awaited<ReturnType<typeof startHappyServer>> | undefined;
    let mcpClient: Client | undefined;
    try {
      await vi.waitFor(() => expect(runtime.readActiveTurnPermissionWitness?.()).not.toBeNull());
      const args = { actionId: 'browser.view.open', input: {
          kind: 'openView', commandId: 'stop-open', browserSessionId: 'session-1', viewId: 'view', platform: 'web',
          target: { kind: 'externalUrl', targetId: 'target', url: 'https://example.test' },
      } };
      const turnId = runtime.readActiveTurnPermissionWitness?.()?.turnId;
      expect(turnId).toBeDefined();
      listener?.(canonicalRuntimeEvent({ kind: 'tool-call', sessionId: 'session-1', emittedAtMs: 1,
        turnId, toolCallId: 'browser-stop-tool', toolName: 'action_execute', input: args }));
      await vi.waitFor(() => expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
        expect.anything(), expect.objectContaining({ type: 'tool-call', callId: 'browser-stop-tool' }), expect.anything(),
      ));
      if (entrypoint === 'native') {
        pending = rpc.invokeLocal(SESSION_RPC_METHODS.SESSION_AGENT_TOOL_CALL_V1, {
          toolName: 'action_execute', toolCallId: 'browser-stop-tool', args,
        });
      } else {
        mcpServer = await startHappyServer(session, {
          sessionCredentials: { token: 'browser-fixture', encryption: null }, accountSettings: accountSettingsParse({
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'browser.view.open': ['agent'] } },
          }),
          pluginRuntimeRegistryLease: lease,
        });
        mcpClient = new Client({ name: 'host-stop-browser', version: '1.0.0' });
        await mcpClient.connect(new StreamableHTTPClientTransport(new URL(mcpServer.url)));
        pending = mcpClient.callTool({ name: 'action_execute', arguments: args });
      }
      const signal = await Promise.race([entered, pending.then(result => { throw new Error(`Tool ended before daemon dispatch: ${JSON.stringify(result)}`); })]);
      expect(signal).toBeDefined();
      await abortTurn.current?.();
      expect(signal?.aborted).toBe(true);
      if (entrypoint === 'native') await expect(pending).resolves.toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
      else await expect(pending).resolves.toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining('outcome_unknown') }] });
      await vi.waitFor(() => expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
        expect.anything(), expect.objectContaining({ type: 'tool-result', callId: 'browser-stop-tool', isError: true,
          output: expect.objectContaining({ status: 'cancelled' }) }), expect.anything(),
      ));
      expect(runtimeLifetime.signal.aborted).toBe(false);
    } finally {
      release(); terminate?.({ kind: 'killSession' }); await pending?.catch(() => undefined); await running;
      await mcpClient?.close(); mcpServer?.stop();
      vi.restoreAllMocks(); await lease.release();
      vi.unstubAllEnvs();
    }
  });

  it.each(['failed', 'pending'] as const)('physically stops the native turn while permission persistence is %s', async persistence => {
    const base = createLifecycleParams({ runPermissionModePromptLoopFn: runPermissionModePromptLoop });
    const session = base.session;
    const rpc = new RpcHandlerManager({ scopePrefix: session.sessionId, encryptionMode: 'plain' });
    Object.assign(session, { rpcHandlerManager: rpc });
    const permission = new ProviderEnforcedPermissionHandler(session, { logPrefix: '[Stop persistence]' });
    let failWrites = false;
    let releaseWrite!: () => void;
    const writeReleased = new Promise<void>(resolve => { releaseWrite = resolve; });
    const updateAgentState = session.updateAgentState.bind(session);
    // Session persistence is the boundary; the permission handler, store and coordinator stay real.
    const writer = vi.spyOn(session, 'updateAgentState').mockImplementation(async updater => {
      if (failWrites) {
        if (persistence === 'pending') await writeReleased;
        else throw new Error('private-stop-permission-write-payload');
      }
      await updateAgentState(updater);
    });
    let pending: Promise<unknown> | undefined;
    const childScope = createRunScopedExecutionPermissionHandler({
      runId: 'independent-child', controllerOccurrenceId: 'child-controller', handler: permission,
    });
    const childRequestId = buildRunScopedExecutionPermissionRequestId({
      runId: 'independent-child', controllerOccurrenceId: 'child-controller', providerRequestId: 'child-question',
    });
    let childPending: Promise<unknown> | undefined;
    let childSettled = false;
    const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(
      mode => JSON.stringify(mode), { batcher: combinePermissionModeQueuedPrompts },
    );
    let listener: ((event: AgentSessionRuntimeEvent) => void) | undefined;
    const provider: AgentSessionRuntime = {
      async send() { return { status: 'admitted' }; },
      watch(next) { listener = next; return { dispose() { listener = undefined; } }; },
      dispose() {},
    };
    const cancelProvider = vi.fn();
    const declaration = readAgentCatalogSnapshot().agentDefinitionsById.get('codex');
    if (!declaration?.richDefinition || !declaration.pluginId) throw new Error('Missing Codex Agent declaration');
    const runtimeScope = new AbortController();
    const services = createUnavailablePluginServices();
    const contextFixture = createAcpSessionRuntimeContextFixture({
      agent: declaration.richDefinition.definition, pluginId: declaration.pluginId,
      sessionId: session.sessionId, directory: '/workspace', signal: runtimeScope.signal,
      session, permissionHandler: permission, services,
      protocols: createPublicAcpRuntimeProtocols({ pluginId: declaration.pluginId, agentId: declaration.id,
        signal: runtimeScope.signal, isCurrent: () => !runtimeScope.signal.aborted, services }),
    });
    onTestFinished(async () => { runtimeScope.abort(); await contextFixture.dispose(); });
    const runtime = createNativeAgentSessionOperations(provider, session.sessionId, undefined, undefined, undefined, undefined, undefined, {
      context: contextFixture.context, cwd: '/workspace', connectedAccounts: [],
      capabilities: { open: ['create'], delivery: ['newTurn'], cancel: true },
      cancellation: { declared: true, cancel: async ({ turnId }) => {
        cancelProvider(turnId);
        listener?.(canonicalRuntimeEvent({ kind: 'turn-cancelled', sessionId: session.sessionId, emittedAtMs: 2, turnId, cause: 'user' }));
        return { status: 'requested', turnId };
      } },
      configuration: { declared: false }, compaction: { capability: null },
    });
    let readTurnSignal: (() => AbortSignal) | undefined;
    let terminate: ((event: RunnerTerminationEvent) => void) | undefined;
    const info = vi.spyOn(logger, 'infoFile');
    const running = runSessionLoopLifecycle({
      ...base, session, permissionHandler: permission, runtime, hookRuntime: runtime,
      permissionModeState: { ...base.permissionModeState, messageQueue: queue },
      setAbortRequestedCallback: (_callback, signalReader) => { readTurnSignal = signalReader; },
      deps: { ...base.deps, registerRunnerTerminationHandlersFn: registration => {
        const handlers = registerRunnerTerminationHandlers({ ...registration, processLifecycleOwnership: 'caller', sessionExitReport: null,
          exit: () => undefined });
        terminate = handlers.requestTermination;
        return handlers;
      } },
    });
    try {
      await vi.waitFor(() => expect(listener).toBeTypeOf('function'));
      // A native provider can start a turn independently of the host input queue.
      listener?.(canonicalRuntimeEvent({ kind: 'turn-start', sessionId: session.sessionId,
        emittedAtMs: 1, turnId: 'stop-provider-turn', startedBy: 'provider' }));
      pending = permission.handleToolCall('stop-pending', 'AskUserQuestion', { questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }] }, {
        turnId: 'stop-provider-turn', lifetime: 'occurrence', origin: 'host_occurrence_question',
      });
      void pending.catch(() => undefined);
      await vi.waitFor(() => expect(session.getAgentStateSnapshot()?.requests?.['stop-pending']).toBeDefined());
      const signal = readTurnSignal?.();
      expect(signal).toBeDefined();
      failWrites = true;
      const stopping = rpc.invokeLocal('abort', {});
      void stopping.catch(() => undefined);
      try {
        // Persistence may remain unavailable indefinitely. Stop must reach the
        // native cancellation boundary before that write completes.
        await vi.waitFor(() => expect(cancelProvider).toHaveBeenCalledOnce());
        expect(signal?.aborted).toBe(true);
      } finally {
        releaseWrite();
        await stopping;
      }
      expect(signal?.aborted).toBe(true);
      expect(cancelProvider).toHaveBeenCalledOnce();
      if (persistence === 'failed') {
        expect(session.getAgentStateSnapshot()?.requests?.['stop-pending']).toBeDefined();
        expect(info).toHaveBeenCalledWith(expect.any(String), { error: 'permission_reset_failed' });
        logger.flushSync();
        const log = await readFile(logger.getLogPath(), 'utf8');
        expect(log).toContain('permission_reset_failed');
        expect(log).not.toContain('private-stop-permission-write-payload');
      } else {
        expect(session.getAgentStateSnapshot()?.requests?.['stop-pending']).toBeUndefined();
      }

      failWrites = false;
      listener?.(canonicalRuntimeEvent({ kind: 'turn-start', sessionId: session.sessionId,
        emittedAtMs: 3, turnId: 'successor-foreground-turn', startedBy: 'provider' }));
      // This Run shares the Session permission owner, but its provider continues
      // independently of foreground Stop and owns its own prompt disposal.
      childPending = childScope.handler.handleToolCall('child-question', 'AskUserQuestion', {
        questions: [{ question: 'Continue the independent Run?', options: [{ label: 'Yes' }] }],
      }, { lifetime: 'occurrence', origin: 'host_occurrence_question' });
      void childPending.then(() => { childSettled = true; }, () => { childSettled = true; });
      await vi.waitFor(() => expect(session.getAgentStateSnapshot()?.requests?.[childRequestId]).toBeDefined());
      // A saved foreground prompt has no local coordinator waiter after restart.
      await session.updateAgentState(state => ({ ...state, requests: { ...state.requests,
        'saved-foreground': { tool: 'Write', arguments: { path: '/workspace/saved' }, createdAt: 1, kind: 'permission' },
      } }));
      await rpc.invokeLocal('abort', {});
      expect(cancelProvider).toHaveBeenCalledTimes(2);
      expect(session.getAgentStateSnapshot()?.requests?.['stop-pending']).toBeUndefined();
      expect(session.getAgentStateSnapshot()?.requests?.['saved-foreground']).toBeUndefined();
      expect(session.getAgentStateSnapshot()?.requests?.[childRequestId]).toBeDefined();
      expect(childSettled).toBe(false);
      await childScope.dispose('Independent Run stopped');
      await expect(childPending).rejects.toThrow();
      expect(session.getAgentStateSnapshot()?.requests?.[childRequestId]).toBeUndefined();
      expect(session.getAgentStateSnapshot()?.completedRequests?.[childRequestId]).toMatchObject({ status: 'canceled' });
    } finally {
      releaseWrite();
      failWrites = false;
      await childScope.dispose('Test cleanup');
      await childPending?.catch(() => undefined);
      await permission.reset();
      terminate?.({ kind: 'killSession' });
      await running;
      await pending?.catch(() => undefined);
      writer.mockRestore(); info.mockRestore();
    }
  });

  it('does not log a hostile runtime cancellation rejection', async () => {
    loggerDebugMock.mockClear();
    const info = vi.spyOn(logger, 'infoFile');
    const baseParams = createLifecycleParams({ policyAgentId: 'codex' });
    const hostileFailure = createRevokedTranscriptFailure(
      'private cancellation transcript must not enter logs',
    );
    let abortRequested: (() => void | Promise<void>) | null = null;
    const runtime = baseParams.runtime as unknown as {
      cancelTurn: ReturnType<typeof vi.fn>;
    };
    runtime.cancelTurn.mockRejectedValue(hostileFailure);
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      setAbortRequestedCallback: (callback) => {
        abortRequested = callback;
      },
      deps: {
        ...baseParams.deps,
        runPermissionModePromptLoopFn: vi.fn(async () => {
          await abortRequested?.();
        }),
      },
    };

    await runSessionLoopLifecycle(params);

    expect(loggerReceivedIdentity(hostileFailure)).toBe(false);
    expect(info).toHaveBeenCalledWith(
      expect.any(String),
      { error: 'runtime_cancel_failed' },
    );
    expect(info.mock.calls.some(call => call.includes(hostileFailure))).toBe(false);
    info.mockRestore();
  });

  it.each([
    { stopPath: 'killSession', stopIntent: true, nativeCancelled: false },
    { stopPath: 'signal', stopIntent: true, nativeCancelled: false },
    { stopPath: 'signal', stopIntent: true, nativeCancelled: true },
    { stopPath: 'signal', stopIntent: false, nativeCancelled: false },
  ])('retains Discussion preface reply custody when person Stop disposes an in-flight tool ($stopPath, explicit=$stopIntent, native=$nativeCancelled)', async ({ stopPath, stopIntent, nativeCancelled }) => {
    const base = createLifecycleParams({ runPermissionModePromptLoopFn: runPermissionModePromptLoop });
    const session = base.session;
    const partial = 'I will write the answer directly in the Discussion reply.';
    const turnId = 'discussion-stopped-during-tool';
    const requestLocalId = 'discussion-follow-stopped-question';
    Object.assign(session, {
      getLastObservedMessageSeq: () => 43,
      getCommittedUserMessageSeq: (localId: string) => localId === requestLocalId ? 40 : null,
      enqueueAgentMessageCommitted: vi.fn<NonNullable<SessionLoopLifecycleParams['session']['enqueueAgentMessageCommitted']>>(async (_provider, body) => ({
        persisted: true, delivered: true, committedSequence: body.type === 'message' ? 42 : 43,
      })),
    });
    const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(
      mode => JSON.stringify(mode), { batcher: combinePermissionModeQueuedPrompts });
    let listener: ((event: AgentSessionRuntimeEvent) => void) | undefined;
    let acceptedTurnId = turnId;
    const provider: AgentSessionRuntime = {
      async send(request) {
        acceptedTurnId = request.delivery.turnId;
        for (const event of [
          { kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery },
          { kind: 'turn-start', turnId: acceptedTurnId, startedBy: 'host' },
          { kind: 'message-delta', turnId: acceptedTurnId, channel: 'assistant', messageId: 'preface', text: partial },
          { kind: 'tool-call', turnId: acceptedTurnId, toolCallId: 'reply-in-flight', toolName: 'discussion_reply', input: {} },
        ]) listener?.(canonicalRuntimeEvent({ ...event, sessionId: session.sessionId, emittedAtMs: 1 }));
        return { status: 'admitted' };
      },
      watch(next) { listener = next; return { dispose() { listener = undefined; } }; },
      async dispose() {
        // Codex retires its native subscribers before disposing app-server.
        // Its raw native interruption is not observable by the host afterward.
        listener = undefined;
      },
    };
    const declaration = readAgentCatalogSnapshot().agentDefinitionsById.get('codex');
    if (!declaration?.richDefinition || !declaration.pluginId) throw new Error('Missing Codex Agent declaration');
    const runtimeScope = new AbortController();
    const services = createUnavailablePluginServices();
    const contextFixture = createAcpSessionRuntimeContextFixture({
      agent: declaration.richDefinition.definition, pluginId: declaration.pluginId, sessionId: session.sessionId,
      directory: '/workspace', signal: runtimeScope.signal, session, services,
      protocols: createPublicAcpRuntimeProtocols({ pluginId: declaration.pluginId, agentId: declaration.id,
        signal: runtimeScope.signal, isCurrent: () => !runtimeScope.signal.aborted, services }),
    });
    onTestFinished(async () => { runtimeScope.abort(); await contextFixture.dispose(); });
    const runtime = createNativeAgentSessionOperations(provider, session.sessionId, undefined, undefined, undefined, undefined, undefined, {
      context: contextFixture.context, cwd: '/workspace', connectedAccounts: [],
      capabilities: { open: ['create'], delivery: ['newTurn'], cancel: true },
      cancellation: { declared: true, cancel: async ({ turnId }) => {
        if (nativeCancelled) listener?.(canonicalRuntimeEvent({ kind: 'turn-cancelled', sessionId: session.sessionId,
          turnId, emittedAtMs: 2, cause: 'user' }));
        return { status: 'requested', turnId };
      } },
      configuration: { declared: false }, compaction: { capability: null },
    });
    let stop: (() => Promise<void>) | undefined;
    let termination: ReturnType<typeof registerRunnerTerminationHandlers> | undefined;
    const running = runSessionLoopLifecycle({ ...base, runtime, hookRuntime: runtime,
      config: { ...base.config, startRuntimeBeforeFirstPrompt: true, onRuntimeStopReady: value => { stop = value; } },
      permissionModeState: { ...base.permissionModeState, messageQueue: queue },
      deps: { ...base.deps, cleanupBackendRunResourcesFn: cleanupBackendRunResources,
        registerRunnerTerminationHandlersFn: options => {
          termination = registerRunnerTerminationHandlers({ ...options, processLifecycleOwnership: 'caller', sessionExitReport: null, exit: () => undefined });
          return termination;
        } },
    });
    try {
      await vi.waitFor(() => { expect(listener).toBeTypeOf('function'); expect(stop).toBeTypeOf('function'); });
      // The native owner starts the already-admitted turn; protected Pending
      // readmission is exercised by its separate HTTP composition.
      await runtime.sendTurnPrompt('Answer this Discussion question', { localId: requestLocalId, turnId, userMessageSeq: 40,
        discussionAddressing: { discussionId: 'discussion-1', messageId: 'question-1', throughSeq: 1, participantSessionId: session.sessionId },
      });
      await vi.waitFor(() => expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
        'codex', expect.objectContaining({ type: 'tool-call', callId: 'reply-in-flight' }), expect.anything()));
      if (!stop || !termination) throw new Error('Stop controls were not registered');
      const stoppedMetadata = writeSessionExplicitStopV1ToMetadata(createMetadata(), {
        v: 1, cause: 'explicit_stop', requestId: 'person-stop', requestedAtMs: Date.now(),
      });
      if (stopIntent) Object.assign(session, { getMetadataSnapshot: () => stoppedMetadata });
      if (stopPath === 'killSession') await stop();
      else { termination.requestTermination({ kind: 'signal', signal: 'SIGTERM' }); await termination.whenTerminated; }
      await running;
      const commits = vi.mocked(session.enqueueAgentMessageCommitted!).mock.calls;
      expect(commits.filter(([, body]) => body.type === 'turn_cancelled')).toHaveLength(stopIntent ? 1 : 0);
      const rows = new Map(commits.map(([, body, options]) => [options.localId, body]));
      expect([...rows.values()].filter(body => body.type === 'message' && body.message === partial)).toHaveLength(1);
      const mutations = vi.mocked(session.enqueueSessionTurnMutation!).mock.calls.map(([mutation]) => mutation);
      expect(mutations.filter(mutation => mutation.action === 'cancel')).toEqual(stopIntent ? [
        expect.objectContaining({ turnId: acceptedTurnId }),
      ] : []);
      if (stopIntent) expect(mutations.some(mutation => mutation.action === 'append_transcript_anchors'
        && mutation.turnId === acceptedTurnId && mutation.transcriptAnchors.finalAssistantMessageSeq === 42)).toBe(true);
      expect(mutations.filter(mutation => mutation.action === 'complete' || mutation.action === 'fail')).toEqual([]);
    } finally {
      termination?.requestTermination({ kind: 'signal', signal: 'SIGTERM' });
      await running.catch(() => undefined);
    }
  });

  it.each(['no-partial', 'committed-partial'] as const)('lets canonical runtime cancellation retain exact reply custody without an abort-side duplicate (%s)', async partial => {
    const baseParams = createLifecycleParams({ policyAgentId: 'codex' });
    // The provider and acknowledged transcript transport are the boundaries;
    // Stop, ordered transcript projection and terminal mutation stay real.
    const partialSeq = 42;
    Object.assign(baseParams.session, {
      getLastObservedMessageSeq: () => partial === 'committed-partial' ? partialSeq : 40,
      getCommittedUserMessageSeq: (localId: string) => localId === 'original-addressed-question' ? 40 : null,
      enqueueAgentMessageCommitted: vi.fn<NonNullable<SessionLoopLifecycleParams['session']['enqueueAgentMessageCommitted']>>(async (_provider, body) => ({
        persisted: true as const, delivered: true as const,
        committedSequence: body.type === 'message' ? partialSeq : partialSeq + 1,
      })),
    });
    let abortRequested: (() => void | Promise<void>) | null = null;
    let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
    const runtime = baseParams.runtime as unknown as {
      subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
      cancelTurn: ReturnType<typeof vi.fn>;
    };
    runtime.subscribeRuntimeEvents = vi.fn((handler: RuntimeTurnMessageHandler) => {
      runtimeEventHandler = handler;
      return () => undefined;
    });
    runtime.cancelTurn.mockImplementation(async () => {
      runtimeEventHandler?.(canonicalRuntimeEvent({
        kind: 'turn-cancelled',
        sessionId: 'session-1',
        emittedAtMs: 2,
        turnId: 'turn-1',
        agentTurnId: 'agent-turn-1',
        cause: 'user',
      }));
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      setAbortRequestedCallback: (callback) => {
        abortRequested = callback;
      },
      deps: {
        ...baseParams.deps,
        runPermissionModePromptLoopFn: vi.fn(async () => {
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 1,
            turnId: 'turn-1',
            startedBy: 'host',
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'input-accepted', sessionId: 'session-1', emittedAtMs: 1,
            inputIds: ['original-addressed-question'], delivery: { kind: 'newTurn', turnId: 'turn-1' },
          }));
          if (partial === 'committed-partial') runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'transcript-message-committed', sessionId: 'session-1', emittedAtMs: 1,
            turnId: 'turn-1', messageId: 'exact-stopped-partial', role: 'assistant',
            text: 'The stopped turn retained this partial answer',
          }));
          await abortRequested?.();
        }),
      },
    };

    await runSessionLoopLifecycle(params);

    const commits = vi.mocked(baseParams.session.enqueueAgentMessageCommitted!).mock.calls;
    expect(commits.filter(([, body]) => body.type === 'turn_cancelled')).toHaveLength(1);
    expect(baseParams.session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'codex',
      { type: 'turn_cancelled', id: 'agent-turn-1' },
      expect.objectContaining({
        localId: 'agent-turn-1:turn_cancelled',
        provenance: { kind: 'non_dependent', source: 'external' },
      }),
    );
    const mutations = vi.mocked(baseParams.session.enqueueSessionTurnMutation!).mock.calls.map(([mutation]) => mutation);
    const cancel = mutations.find(mutation => mutation.action === 'cancel');
    expect(cancel).toMatchObject({ action: 'cancel', turnId: 'turn-1' });
    // Earlier append_transcript_anchors is equally valid custody. Inspect the
    // complete emitted turn history, not one incidental terminal packet shape.
    const retainedResultSeqs = mutations.flatMap(mutation =>
      'turnId' in mutation && mutation.turnId === 'turn-1'
        && 'transcriptAnchors' in mutation && typeof mutation.transcriptAnchors?.finalAssistantMessageSeq === 'number'
        ? [mutation.transcriptAnchors.finalAssistantMessageSeq] : []);
    if (partial === 'committed-partial') {
      expect(commits.some(([, body, options]) => body.type === 'message'
        && options.localId === 'exact-stopped-partial')).toBe(true);
      expect(retainedResultSeqs).toContain(partialSeq);
    } else {
      expect(retainedResultSeqs).toEqual([]);
    }
  });

  it('classifies a hostile remote handoff rejection without logging or synchronizing it', async () => {
    loggerDebugMock.mockClear();
    const baseParams = createLifecycleParams({ policyAgentId: 'codex' });
    const hostileFailure = createRevokedTranscriptFailure(
      'private remote handoff transcript must not enter logs or sync',
    );
    let agentState: Record<string, unknown> = {};
    const session = baseParams.session as unknown as {
      updateAgentState: ReturnType<typeof vi.fn>;
    };
    session.updateAgentState = vi.fn(async (
      updater: (state: Record<string, unknown>) => Record<string, unknown>,
    ) => {
      agentState = updater(agentState);
    });
    const requestGracefulRemoteHandoff = vi.fn(async () => {
      throw hostileFailure;
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      terminalRemoteModeLoop: {
        startingMode: 'terminal',
        remoteExitCode: 0,
        runTerminal: vi.fn(async () => ({ type: 'switch' as const })),
        runRemote: vi.fn(async () => 'exit' as const),
        onModeChange: vi.fn(),
        requestGracefulRemoteHandoff,
      },
      deps: {
        ...baseParams.deps,
        runTerminalRemoteSessionModeLoopFn: vi.fn(async (options) => {
          await options.onBeforeIteration?.('terminal');
          return 0;
        }),
        runPermissionModePromptLoopFn: vi.fn(async (loopParams) => {
          await expect(loopParams.beforePendingMaterialize?.()).resolves.toBe(false);
        }),
      },
    };

    await runSessionLoopLifecycle(params);

    expect(requestGracefulRemoteHandoff).toHaveBeenCalledWith(
      'pending_queue_after_terminal_boundary',
    );
    expect(loggerReceivedIdentity(hostileFailure)).toBe(false);
    expect(loggerDebugMock).toHaveBeenCalledWith(
      '[Test] Failed to request remote handoff',
      {
        error: 'remote_handoff_failed',
        reason: 'pending_queue_after_terminal_boundary',
      },
    );
    expect(agentState).not.toHaveProperty('terminalControl.pendingHandoffV1');
  });

  it('closes the session exactly once when the initial terminal child exits', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'codex' });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      opts: {
        ...baseParams.opts,
        startedBy: 'terminal',
        startingMode: 'terminal',
      },
      terminalRemoteModeLoop: {
        startingMode: 'terminal',
        remoteExitCode: 0,
        runTerminal: vi.fn(async () => ({ type: 'exit' as const, code: 0 })),
        runRemote: vi.fn(async () => 'exit' as const),
        onModeChange: vi.fn(),
      },
      deps: {
        ...baseParams.deps,
        runPermissionModePromptLoopFn: vi.fn(async (loopParams) => {
          const signal = loopParams.getAbortSignal();
          if (signal.aborted) return;
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
        }),
      },
    };

    await runSessionLoopLifecycle(params);

    expect(baseParams.session.endSessionAndClose).toHaveBeenCalledOnce();
    expect(baseParams.deps.cleanupBackendRunResourcesFn).toHaveBeenCalledOnce();
  });

  it.each([false, true])('settles unresolved native input custody before closing after physical terminal exit (cleanup fails: %s)', async (cleanupFails) => {
    const baseParams = createLifecycleParams({ policyAgentId: 'codex' });
    const cleanupFailure = new Error('native terminal cleanup failed');
    const native: AgentSessionRuntime = {
      send: async () => ({ status: 'admitted' }),
      watch: () => ({ dispose() {} }),
      dispose: async () => { if (cleanupFails) throw cleanupFailure; },
    };
    const runtime = createNativeAgentSessionOperations(native, 'session-1', undefined, undefined, undefined, undefined, undefined, {
      context: { signal: new AbortController().signal } as AgentSessionRuntimeContext,
      cwd: '/workspace', connectedAccounts: [],
      capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
      cancellation: { declared: false }, configuration: { declared: false }, compaction: { capability: null },
    });
    let closed = false;
    const outcomes: unknown[] = [];
    runtime.setOnPromptDeliveryOutcome((outcome) => {
      // The Session transport cannot admit new settlement after it closes.
      if (!closed) outcomes.push(outcome);
    });
    await runtime.sendTurnPrompt('waiting for native trust', {
      localId: 'terminal-exit-input', turnId: 'terminal-exit-turn',
    });
    const session = Object.assign(baseParams.session, {
      endSessionAndClose: async () => { closed = true; },
    });
    const running = runSessionLoopLifecycle({
      ...baseParams, session, runtime, hookRuntime: runtime,
      opts: { ...baseParams.opts, startedBy: 'terminal', startingMode: 'terminal' },
      terminalRemoteModeLoop: {
        startingMode: 'terminal', remoteExitCode: 0,
        runTerminal: async () => ({ type: 'exit', code: 0 }),
        runRemote: async () => 'exit', onModeChange: () => undefined,
      },
      deps: {
        ...baseParams.deps, cleanupBackendRunResourcesFn: cleanupBackendRunResources,
        runPermissionModePromptLoopFn: async (params) => {
          const signal = params.getAbortSignal();
          if (!signal.aborted) await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
        },
      },
    });
    if (cleanupFails) await expect(running).rejects.toBe(cleanupFailure);
    else await running;
    expect(closed).toBe(true);
    expect(outcomes).toEqual([{
      type: 'input-custody-unknown', localId: 'terminal-exit-input', userMessageSeq: null,
      issue: { code: 'native_runtime_disposed_with_input_in_flight', severity: 'warning' },
    }]);
  });

  it('retires Session RPC custody before runtime cleanup after terminal follow admission fails', async () => {
    const failure = new Error('terminal follow admission failed');
    const baseParams = createLifecycleParams({ policyAgentId: 'codex', runPermissionModePromptLoopFn: runPermissionModePromptLoop });
    const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(
      mode => JSON.stringify(mode), { batcher: combinePermissionModeQueuedPrompts });
    const order: string[] = [];
    const close = vi.mocked(baseParams.session.close);
    close.mockImplementation(async () => { order.push('session_closed'); });
    const runtime = baseParams.runtime;
    vi.mocked(runtime.resetOrDisposeRuntime).mockImplementation(async () => {
      expect(close).toHaveBeenCalledOnce();
      order.push('runtime_disposed');
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      opts: { ...baseParams.opts, startedBy: 'terminal', startingMode: 'terminal' },
      permissionModeState: { ...baseParams.permissionModeState, messageQueue: queue },
      terminalRemoteModeLoop: {
        startingMode: 'terminal', remoteExitCode: 0,
        runTerminal: async () => { throw failure; },
        runRemote: async () => 'exit', onModeChange: () => undefined,
      },
      deps: { ...baseParams.deps, cleanupBackendRunResourcesFn: cleanupBackendRunResources,
        onBeforeSessionClose: async () => { order.push('before_close'); } },
    };
    await expect(runSessionLoopLifecycle(params)).rejects.toBe(failure);
    expect(order).toEqual(['before_close', 'session_closed', 'runtime_disposed']);
    expect(baseParams.session.endSessionAndClose).not.toHaveBeenCalled();
  });

  it('publishes the active terminal mode through the canonical keep-alive when no provider override exists', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'codex' });
    const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(
      mode => JSON.stringify(mode), { batcher: combinePermissionModeQueuedPrompts });
    Object.assign(baseParams.session, {
      hasPendingProviderInput: () => false,
      getPendingQueueState: () => ({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 0 }),
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      permissionModeState: { ...baseParams.permissionModeState, messageQueue: queue },
      opts: {
        ...baseParams.opts,
        startedBy: 'terminal',
        startingMode: 'terminal',
      },
      terminalRemoteModeLoop: {
        startingMode: 'terminal',
        remoteExitCode: 0,
        topology: 'shared',
        remoteWritable: true,
        runTerminal: vi.fn(async () => ({ type: 'switch' as const })),
        runRemote: vi.fn(async () => 'exit' as const),
        onModeChange: vi.fn(),
      },
      deps: {
        ...baseParams.deps,
        runPermissionModePromptLoopFn: runPermissionModePromptLoop,
      },
    };

    await runSessionLoopLifecycle(params);

    expect(baseParams.session.keepAlive).toHaveBeenNthCalledWith(1, false, 'local');
    expect(baseParams.session.keepAlive).toHaveBeenLastCalledWith(false, 'remote');
  });

  it('uses an injected foreground daemon bridge for agent context transforms without a process-global handoff', async () => {
    const previousTokenFile =
      process.env[RETIRED_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY];
    delete process.env[RETIRED_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY];
    const transformedPayload = Object.freeze({
      sessionId: 'session-1',
      agentId: 'codex',
      prompt: 'daemon-transformed',
    });
    const agentComposition = {
      kind: 'composition' as const,
      managedPluginIds: ['example.agent-context-companion'],
      selectedTools: [{
        pluginId: 'example.agent-context-companion',
        localId: 'review-summary-tool',
      }],
      selectedToolBindings: [{
        tool: {
          toolId: 'example.agent-context-companion/review-summary-tool',
          actionId: 'review-summary',
          name: 'review_summary',
          title: 'Review summary',
          description: 'Summarize the bounded review transcript.',
          inputSchema: { type: 'object', additionalProperties: false },
          surfaces: ['agent', 'mcp'],
        },
        expectedContributorOccurrenceId: 'occurrence-g',
      }],
      promptAssetBlocks: [],
      toolPromptContributions: [],
      additionalInstructions: [{
        pluginId: 'example.agent-context-companion',
        text: 'Use the bounded review cursor for this next turn.',
      }],
    } satisfies Awaited<ReturnType<DaemonAgentRuntimeTurnContributionsBridge['resolveAgentComposition']>>;
    const daemonTurnContributionsBridge = {
      resolvePrompt: vi.fn(),
      resolveAgentComposition: vi.fn(async () => agentComposition),
      resolveComposerReference: vi.fn(async () => {
        throw new Error('composer reference was not requested');
      }),
      resolveComposerAttachment: vi.fn(async () => ({
        attachments: [{
          instanceId: 'review-1',
          status: 'ready' as const,
          context: 'Fresh review context.',
          data: { refreshed: true },
        }],
      })),
      afterComposerAttachmentMessageAccepted: vi.fn(async () => {}),
      transformAgentContext: vi.fn(async () => transformedPayload),
      transformSessionInput: vi.fn(),
      transformAgentRequest: vi.fn(),
    } satisfies DaemonAgentRuntimeTurnContributionsBridge;
    let observedPayload: unknown = null;
    let observedErrorPolicy: unknown = null;
    let observedComposition: unknown = null;
    let observedAttachment: unknown = null;
    try {
      const baseParams = createLifecycleParams({ policyAgentId: 'codex' });
      const deps = {
        ...baseParams.deps,
        daemonTurnContributionsBridge,
        runPermissionModePromptLoopFn: vi.fn(async (loopParams) => {
          observedErrorPolicy = loopParams.transformAgentContextErrorPolicy;
          observedPayload = await loopParams.transformAgentContextBeforeDispatch?.({
            sessionId: 'session-1',
            agentId: 'codex',
            prompt: 'original',
          });
          observedComposition = await loopParams.resolveAgentCompositionBeforeDispatch?.({
            signal: new AbortController().signal,
          });
          observedAttachment = await loopParams.resolveComposerAttachmentForDispatch!({
            sessionId: 'session-1',
            attachment: {
              pluginId: 'acme.review',
              localId: 'review-comment',
            },
            request: {
              sessionId: 'session-1',
              localId: 'local-1',
              attachments: [{
                instanceId: 'review-1',
                key: 'review-1',
                value: { reviewId: '42' },
              }],
            },
            signal: new AbortController().signal,
          });
        }),
      } satisfies SessionLoopLifecycleParams['deps'];
      const params: SessionLoopLifecycleParams = {
        ...baseParams,
        deps,
      };

      await runSessionLoopLifecycle(params);

      expect(observedPayload).toEqual(transformedPayload);
      expect(observedErrorPolicy).toBe('throw');
      expect(observedAttachment).toEqual({
        attachments: [{
          instanceId: 'review-1',
          status: 'ready',
          context: 'Fresh review context.',
          data: { refreshed: true },
        }],
      });
      expect(daemonTurnContributionsBridge.transformAgentContext).toHaveBeenCalledWith({
        sessionId: 'session-1',
        payload: {
          sessionId: 'session-1',
          agentId: 'codex',
          prompt: 'original',
        },
        signal: expect.any(AbortSignal),
      });
      expect(daemonTurnContributionsBridge.resolveAgentComposition).toHaveBeenCalledWith({
        sessionId: 'session-1',
        runtimeFamily: 'hostSession',
        machineId: 'machine-1',
        featureIds: ['execution.runs'],
        signal: expect.any(AbortSignal),
      });
      expect(daemonTurnContributionsBridge.resolveComposerAttachment).toHaveBeenCalledWith({
        sessionId: 'session-1',
        attachment: {
          pluginId: 'acme.review',
          localId: 'review-comment',
        },
        request: {
          sessionId: 'session-1',
          localId: 'local-1',
          attachments: [{
            instanceId: 'review-1',
            key: 'review-1',
            value: { reviewId: '42' },
          }],
        },
        signal: expect.any(AbortSignal),
      });
      expect(observedComposition).toEqual({
        managedPluginIds: ['example.agent-context-companion'],
        selectedTools: [{
          pluginId: 'example.agent-context-companion',
          localId: 'review-summary-tool',
        }],
        selectedToolBindings: [{
          tool: {
            toolId: 'example.agent-context-companion/review-summary-tool',
            actionId: 'review-summary',
            name: 'review_summary',
            title: 'Review summary',
            description: 'Summarize the bounded review transcript.',
            inputSchema: { type: 'object', additionalProperties: false },
            surfaces: ['agent', 'mcp'],
          },
          expectedContributorOccurrenceId: 'occurrence-g',
        }],
        prompt: expect.stringContaining('Use the bounded review cursor for this next turn.'),
      });
    } finally {
      if (previousTokenFile === undefined) {
        delete process.env[RETIRED_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY];
      } else {
        process.env[RETIRED_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY] =
          previousTokenFile;
      }
    }
  });

  it('ignores a legacy process-global daemon bridge handoff without an explicit runner contribution bridge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-stream-hook-daemon-child-'));
    const tokenFilePath = join(root, 'handoff.json');
    const previousTokenFile =
      process.env[RETIRED_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY];
    await writeFile(tokenFilePath, JSON.stringify({
      v: 1,
      token: 'bridge-token',
      descriptor: {
        v: 1,
        pluginId: 'happier.agent.codex',
        pluginVersion: '1.2.3',
        agentId: 'codex',
        backendId: 'codex',
        generation: 'generation-stream',
      },
    }), 'utf8');
    process.env[RETIRED_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY] =
      tokenFilePath;
    vi.spyOn(
      pluginReloadController,
      'tryAcquireRuntimeRegistry',
    );
    try {
      const baseParams = createLifecycleParams({ policyAgentId: 'codex' });
      let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
      const runtime = baseParams.runtime as unknown as {
        subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
      };
      runtime.subscribeRuntimeEvents = vi.fn((handler: RuntimeTurnMessageHandler) => {
        runtimeEventHandler = handler;
        return () => undefined;
      });
      const params: SessionLoopLifecycleParams = {
        ...baseParams,
        deps: {
          ...baseParams.deps,
          runPermissionModePromptLoopFn: vi.fn(async () => {
            runtimeEventHandler?.(canonicalRuntimeEvent({
              kind: 'message-delta',
              sessionId: 'session-1',
              emittedAtMs: 2,
              turnId: 'turn-stream-daemon',
              channel: 'assistant',
              text: 'daemon-owned token',
            }));
          }),
        },
      };

      await runSessionLoopLifecycle(params);

      expect(pluginReloadController.tryAcquireRuntimeRegistry).toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      if (previousTokenFile === undefined) {
        delete process.env[RETIRED_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY];
      } else {
        process.env[RETIRED_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY] =
          previousTokenFile;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it('observes message-delta runtime events through agent.stream.token without blocking projection', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'codex' });
    let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
    const runtime = baseParams.runtime as unknown as {
      subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
    };
    runtime.subscribeRuntimeEvents = vi.fn((handler: RuntimeTurnMessageHandler) => {
      runtimeEventHandler = handler;
      return () => undefined;
    });
    const observeAgentStreamToken = vi.fn(async () => undefined);
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      deps: {
        ...baseParams.deps,
        observeAgentStreamToken,
        runPermissionModePromptLoopFn: vi.fn(async () => {
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'message-delta',
            sessionId: 'session-1',
            emittedAtMs: 2,
            turnId: 'turn-stream-1',
            channel: 'assistant',
            text: 'partial token',
          }));
          for (const scope of [{ sidechainId: 'child-1', turnId: 'turn-stream-1' }, { sidechainId: 'child-1' }]) {
            runtimeEventHandler?.(canonicalRuntimeEvent({
              kind: 'message-delta', sessionId: 'session-1', emittedAtMs: 3,
              channel: 'assistant', text: 'child token', ...scope,
            }));
          }
        }),
      },
    };

    await runSessionLoopLifecycle(params);

    expect(observeAgentStreamToken).toHaveBeenCalledOnce();
    expect(observeAgentStreamToken).toHaveBeenCalledWith({
      sessionId: 'session-1',
      agentId: 'codex',
      runtimeFamily: 'hostSession',
      turnId: 'turn-stream-1',
      tokenText: 'partial token',
      streamKind: 'assistant',
      timestampMs: 2,
    });
  });

  it('does not retain an arbitrary agent.stream.token observer rejection', async () => {
    loggerDebugMock.mockClear();
    const baseParams = createLifecycleParams({ policyAgentId: 'codex' });
    let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
    const runtime = baseParams.runtime as unknown as {
      subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
    };
    runtime.subscribeRuntimeEvents = vi.fn((handler: RuntimeTurnMessageHandler) => {
      runtimeEventHandler = handler;
      return () => undefined;
    });
    const hostile = Proxy.revocable({}, {});
    hostile.revoke();
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      deps: {
        ...baseParams.deps,
        observeAgentStreamToken: async () => {
          throw hostile.proxy;
        },
        runPermissionModePromptLoopFn: vi.fn(async () => {
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'message-delta',
            sessionId: 'session-1',
            emittedAtMs: 2,
            turnId: 'turn-stream-private-rejection',
            channel: 'assistant',
            text: 'private token',
          }));
        }),
      },
    };

    await runSessionLoopLifecycle(params);

    expect(loggerDebugMock).toHaveBeenCalledWith(
      '[Test] agent.stream.token observer failed (non-fatal)',
    );
  });

  it.each(['turn-failed', 'input-rejected'] as const)('projects %s runtime issues into visible durable diagnostics when no assistant text was committed', async kind => {
    const baseParams = createLifecycleParams({ policyAgentId: 'opencode' });
    let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
    const session = baseParams.session as unknown as {
      enqueueAgentMessageCommitted: ReturnType<typeof vi.fn>;
      enqueueSessionTurnMutation: ReturnType<typeof vi.fn>;
      getTurnAssistantTextSnapshotStore: ReturnType<typeof vi.fn>;
    };
    session.getTurnAssistantTextSnapshotStore = vi.fn(() => ({
      getCurrentTurnSnapshot: () => ({ seq: 42, source: 'committed' }),
    }));
    const runtime = baseParams.runtime as unknown as {
      subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
    };
    runtime.subscribeRuntimeEvents = vi.fn((handler: RuntimeTurnMessageHandler) => {
      runtimeEventHandler = handler;
      return () => undefined;
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      deps: {
        ...baseParams.deps,
        runPermissionModePromptLoopFn: vi.fn(async () => {
          if (kind === 'turn-failed') runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 1,
            turnId: 'turn-1',
            startedBy: 'host',
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind,
            sessionId: 'session-1',
            emittedAtMs: 2,
            ...(kind === 'turn-failed' ? { turnId: 'turn-1' } : { inputIds: ['turn-1'], retryable: true }),
            diagnostic: {
              code: 'opencode_empty_provider_response',
              severity: 'error',
              message: 'OpenCode completed provider tool work but returned no assistant message.',
              details: { agentId: 'opencode' },
            },
          }));
        }),
      },
    };

    await runSessionLoopLifecycle(params);

    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'opencode',
      {
        type: 'message',
        message: expect.stringContaining('OpenCode completed provider tool work'),
      },
      {
        localId: 'turn-1:runtime_issue',
        meta: expect.objectContaining({
          runtimeIssueCode: 'opencode_empty_provider_response',
          runtimeIssueSource: 'agent_session_error',
        }),
        provenance: { kind: 'non_dependent', source: 'background' },
      },
    );
    if (kind === 'input-rejected') {
      expect(session.enqueueAgentMessageCommitted).not.toHaveBeenCalledWith('opencode', expect.objectContaining({ type: 'turn_failed' }), expect.anything());
      expect(session.enqueueSessionTurnMutation).not.toHaveBeenCalled();
      return;
    }
    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'opencode',
      { type: 'turn_failed', id: 'turn-1' },
      {
        localId: 'turn-1:turn_failed',
        meta: expect.objectContaining({
          source: 'runtime',
          runtimeIssueCode: 'opencode_empty_provider_response',
        }),
        provenance: { kind: 'non_dependent', source: 'background' },
      },
    );
    expect(session.enqueueSessionTurnMutation).toHaveBeenCalledWith(expect.objectContaining({
      action: 'fail',
      turnId: 'turn-1',
      issue: expect.objectContaining({
        code: 'opencode_empty_provider_response',
      }),
    }));
  });

  it('does not add a generic runtime diagnostic when the runtime already committed assistant text for the failed turn', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'claude' });
    let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
    const session = baseParams.session as unknown as {
      enqueueAgentMessageCommitted: ReturnType<typeof vi.fn>;
    };
    const runtime = baseParams.runtime as unknown as {
      subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
    };
    runtime.subscribeRuntimeEvents = vi.fn((handler: RuntimeTurnMessageHandler) => {
      runtimeEventHandler = handler;
      return () => undefined;
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      config: {
        ...baseParams.config,
        agentMessageType: 'claude',
        providerName: 'Claude',
      },
      deps: {
        ...baseParams.deps,
        runPermissionModePromptLoopFn: vi.fn(async () => {
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 1,
            turnId: 'turn-2',
            startedBy: 'host',
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'transcript-message-committed',
            sessionId: 'session-1',
            emittedAtMs: 2,
            messageId: 'turn-2:provider-error',
            role: 'assistant',
            text: 'Claude authentication failed.',
            turnId: 'turn-2',
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-failed',
            sessionId: 'session-1',
            emittedAtMs: 3,
            turnId: 'turn-2',
            diagnostic: {
              code: 'claude_authentication_failed',
              severity: 'error',
              message: 'Claude authentication failed.',
              details: { agentId: 'claude' },
            },
          }));
        }),
      },
    };

    await runSessionLoopLifecycle(params);

    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'claude',
      { type: 'message', message: 'Claude authentication failed.' },
      expect.objectContaining({
        localId: 'turn-2:provider-error',
        provenance: { kind: 'non_dependent', source: 'external' },
      }),
    );
    expect(session.enqueueAgentMessageCommitted).not.toHaveBeenCalledWith(
      'claude',
      expect.objectContaining({
        type: 'message',
        message: expect.stringContaining('turn failed'),
      }),
      expect.objectContaining({ localId: 'turn-2:runtime_issue' }),
    );
    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'claude',
      { type: 'turn_failed', id: 'turn-2' },
      expect.objectContaining({ localId: 'turn-2:turn_failed' }),
    );
  });

  it('keeps foreground failure diagnostics visible when only child text was committed', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'claude' });
    let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
    const session = baseParams.session as unknown as {
      enqueueAgentMessageCommitted: ReturnType<typeof vi.fn>;
    };
    const runtime = baseParams.runtime as unknown as {
      subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
    };
    runtime.subscribeRuntimeEvents = vi.fn((handler: RuntimeTurnMessageHandler) => {
      runtimeEventHandler = handler;
      return () => undefined;
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      config: {
        ...baseParams.config,
        agentMessageType: 'claude',
        providerName: 'Claude',
      },
      deps: {
        ...baseParams.deps,
        runPermissionModePromptLoopFn: vi.fn(async () => {
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 1,
            turnId: 'turn-2',
            startedBy: 'host',
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'transcript-message-committed',
            sessionId: 'session-1',
            emittedAtMs: 2,
            messageId: 'turn-2:provider-error',
            role: 'assistant',
            text: 'Claude authentication failed.',
            turnId: 'turn-2',
            sidechainId: 'child-1',
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-failed',
            sessionId: 'session-1',
            emittedAtMs: 3,
            turnId: 'turn-2',
            diagnostic: {
              code: 'claude_authentication_failed',
              severity: 'error',
              message: 'Claude authentication failed.',
              details: { agentId: 'claude' },
            },
          }));
        }),
      },
    };

    await runSessionLoopLifecycle(params);

    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'claude',
      { type: 'message', message: 'Claude authentication failed.', sidechainId: 'child-1' },
      expect.objectContaining({
        localId: 'turn-2:provider-error',
        provenance: { kind: 'non_dependent', source: 'external' },
      }),
    );
    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'claude',
      expect.objectContaining({
        type: 'message',
        message: expect.stringContaining('turn failed'),
      }),
      expect.objectContaining({ localId: 'turn-2:runtime_issue' }),
    );
    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'claude',
      { type: 'turn_failed', id: 'turn-2' },
      expect.objectContaining({ localId: 'turn-2:turn_failed' }),
    );
  });

  it('retains the failure cause when the runtime streamed a partial answer before failing', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'cursor' });
    let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
    const session = baseParams.session as unknown as {
      enqueueAgentMessageCommitted: ReturnType<typeof vi.fn>;
    };
    const runtime = baseParams.runtime as unknown as {
      subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
    };
    runtime.subscribeRuntimeEvents = vi.fn((handler: RuntimeTurnMessageHandler) => {
      runtimeEventHandler = handler;
      return () => undefined;
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      config: {
        ...baseParams.config,
        agentMessageType: 'cursor',
        providerName: 'Cursor',
      },
      deps: {
        ...baseParams.deps,
        runPermissionModePromptLoopFn: vi.fn(async () => {
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 1,
            turnId: 'turn-3',
            startedBy: 'host',
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'message-delta',
            sessionId: 'session-1',
            emittedAtMs: 2,
            turnId: 'turn-3',
            channel: 'assistant',
            text: 'Partial answer before failure.',
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-failed',
            sessionId: 'session-1',
            emittedAtMs: 3,
            turnId: 'turn-3',
            diagnostic: {
              code: 'cursor_runtime_error',
              severity: 'error',
              message: 'Cursor failed after streaming partial output.',
              details: { agentId: 'cursor' },
            },
          }));
        }),
      },
    };

    await runSessionLoopLifecycle(params);

    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'cursor',
      { type: 'message', message: 'Partial answer before failure.' },
      expect.objectContaining({
        meta: expect.objectContaining({
          happierStreamSegmentV1: expect.objectContaining({
            segmentState: 'interrupted',
          }),
        }),
      }),
    );
    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'cursor',
      expect.objectContaining({
        type: 'message',
        message: expect.stringContaining('Cursor failed after streaming partial output'),
      }),
      expect.objectContaining({ localId: 'turn-3:runtime_issue' }),
    );
    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'cursor',
      { type: 'turn_failed', id: 'turn-3' },
      expect.objectContaining({ localId: 'turn-3:turn_failed' }),
    );
  });

  it('keeps permission-blocked runtime diagnostics visible after an assistant preamble without trusting diagnostic identity', async () => {
    const spoofedAgentId = 'spoofed-diagnostic-agent';
    const spoofedAgentTurnId = 'spoofed-diagnostic-agent-turn';
    const hostAgentTurnId = 'host-agent-turn-permission-denied';
    const baseParams = createLifecycleParams({ policyAgentId: 'opencode' });
    let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
    const session = baseParams.session as unknown as {
      enqueueAgentMessageCommitted: ReturnType<typeof vi.fn>;
    };
    const runtime = baseParams.runtime as unknown as {
      subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
    };
    runtime.subscribeRuntimeEvents = vi.fn((handler: RuntimeTurnMessageHandler) => {
      runtimeEventHandler = handler;
      return () => undefined;
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      config: {
        ...baseParams.config,
        agentMessageType: 'opencode',
        providerName: 'OpenCode',
      },
      deps: {
        ...baseParams.deps,
        runPermissionModePromptLoopFn: vi.fn(async () => {
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 1,
            turnId: 'turn-permission-denied',
            startedBy: 'host',
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'message-delta',
            sessionId: 'session-1',
            emittedAtMs: 2,
            turnId: 'turn-permission-denied',
            channel: 'assistant',
            text: 'I need to inspect the repo first.',
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-failed',
            sessionId: 'session-1',
            emittedAtMs: 3,
            turnId: 'turn-permission-denied',
            agentTurnId: hostAgentTurnId,
            diagnostic: {
              code: 'opencode_permission_denied',
              severity: 'error',
              message: 'OpenCode permission request was denied.',
              details: {
                v: 1,
                source: 'permission_blocked',
                agentId: spoofedAgentId,
                agentTurnId: spoofedAgentTurnId,
              },
            },
          }));
        }),
      },
    };

    await runSessionLoopLifecycle(params);

    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'opencode',
      { type: 'message', message: 'I need to inspect the repo first.' },
      expect.any(Object),
    );
    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'opencode',
      { type: 'message', message: 'Permission blocked' },
      expect.objectContaining({
        localId: 'turn-permission-denied:runtime_issue',
        meta: expect.objectContaining({
          runtimeIssueCode: 'permission_blocked',
          runtimeIssueSource: 'permission_blocked',
          runtimeIssueProvider: 'opencode',
          runtimeIssueProviderTurnId: hostAgentTurnId,
        }),
      }),
    );
    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'opencode',
      { type: 'turn_failed', id: 'turn-permission-denied' },
      expect.objectContaining({ localId: 'turn-permission-denied:turn_failed' }),
    );
    expect(JSON.stringify(session.enqueueAgentMessageCommitted.mock.calls)).not.toContain(spoofedAgentId);
    expect(JSON.stringify(session.enqueueAgentMessageCommitted.mock.calls)).not.toContain(spoofedAgentTurnId);
  });

  it.each([
    { connected: true, acceptsFailure: true, recoveryUnavailable: false },
    { connected: true, acceptsFailure: false, recoveryUnavailable: false },
    { connected: false, acceptsFailure: true, recoveryUnavailable: false },
    { connected: false, acceptsFailure: false, recoveryUnavailable: false },
    { connected: false, acceptsFailure: true, recoveryUnavailable: true },
  ])('reports valid quota evidence only after the host accepts its failed turn (%j)', async ({ connected, acceptsFailure, recoveryUnavailable }) => {
    const outboxRoot = await mkdtemp(join(tmpdir(), 'agy-host-recovery-'));
    recoveryBoundary.outboxRoot = outboxRoot;
    try {
      const lease = await pluginReloadController.acquireRuntimeRegistry({
        resolveRuntimeRegistry: async () => await resolveExecutablePluginRuntimeRegistry({
          contributes: getResolvedContributionRegistry(), pluginIds: [],
        }),
      });
      try {
        const base = createLifecycleParams({
          policyAgentId: 'happier.agent.antigravity/antigravity',
          runPermissionModePromptLoopFn: runPermissionModePromptLoop,
        });
        const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(
          (mode) => JSON.stringify(mode), { batcher: combinePermissionModeQueuedPrompts },
        );
        queue.push({ text: 'Continue', localId: 'quota-input', userMessageSeq: 1 }, { permissionMode: 'default' });
        let failedTurnAccepted = false;
        vi.mocked(base.session.enqueueSessionTurnMutation!).mockImplementation(async (mutation) => {
          if (mutation.action === 'fail') {
            await Promise.resolve();
            if (!acceptsFailure) throw new Error('Synthetic terminal persistence rejection');
            failedTurnAccepted = true;
          }
        });
        let listener: ((event: AgentSessionRuntimeEvent) => void) | undefined;
        // The native Agent SDK session is the provider boundary; host composition stays real.
        const provider: AgentSessionRuntime = {
          async send(request) {
            for (const event of [
              { kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery },
              { kind: 'turn-start', turnId: request.delivery.turnId, startedBy: 'host' },
              { kind: 'turn-failed', turnId: request.delivery.turnId, diagnostic: {
                code: 'provider_usage_limit', severity: 'error', message: 'Usage Limit Reached',
                details: { v: 1, source: 'usage_limit', runtimeAuthClassification: {
                  kind: 'usage_limit', limitCategory: 'usage_limit', serviceId: 'happier.agent.antigravity/antigravity-account',
                  profileId: connected ? 'selected-profile' : null, groupId: connected ? 'selected-pool' : null,
                  ...(connected ? { groupGeneration: 7, expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuv' } : {}),
                  ...(recoveryUnavailable ? { connectedServiceRecovery: 'unavailable' } : {}),
                  source: 'stable_provider_message', resetsAtMs: null, retryAfterMs: null, quotaScope: 'account', rateLimits: null,
                } },
              } },
              { kind: 'runtime-ended', cause: 'providerEnded', retryable: false },
            ]) listener?.(canonicalRuntimeEvent({ ...event, sessionId: 'session-1', emittedAtMs: 1 }));
            return { status: 'admitted' };
          },
          watch(value) { listener = value; return { dispose() { listener = undefined; } }; },
          dispose() {},
        };
        const runtime = createNativeAgentSessionOperations(
          provider, 'session-1', undefined, undefined, undefined, undefined, undefined,
          {
            context: { signal: new AbortController().signal } as AgentSessionRuntimeContext,
            cwd: '/workspace', connectedAccounts: [],
            capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
            cancellation: { declared: false }, configuration: { declared: false }, compaction: { capability: null },
          }, undefined, [], undefined, undefined, async () => ({ status: 'admitted' }),
        );
        const reports: unknown[] = [];
        recoveryNotify.mockImplementation(async (body: unknown) => {
          expect(vi.mocked(base.session.enqueueAgentMessageCommitted!).mock.calls.some(([, value]) => value.type === 'turn_failed')).toBe(true);
          expect(failedTurnAccepted).toBe(true);
          const mutation = vi.mocked(base.session.enqueueSessionTurnMutation!).mock.calls
            .map(([value]) => value).find((value) => value.action === 'fail');
          if (!mutation || mutation.action !== 'fail') throw new Error('Missing accepted failure issue');
          expect(body).toMatchObject({ classification: {
            runtimeIssueFingerprint: buildUsageLimitIssueFingerprint(mutation.issue),
          } });
          reports.push(body);
          return { ok: true, result: { status: 'recovery_superseded', reason: 'source_tuple_mismatch', serviceId: 'happier.agent.antigravity/antigravity-account' } };
        });
        let terminate: ((event: RunnerTerminationEvent) => void) | undefined;
        const run = runSessionLoopLifecycle({
          ...base, runtime, hookRuntime: runtime,
          permissionModeState: { ...base.permissionModeState, messageQueue: queue },
          deps: { ...base.deps, registerRunnerTerminationHandlersFn: (registration) => {
            const handlers = registerRunnerTerminationHandlers({
              process: registration.process, exit: registration.exit, onTerminate: registration.onTerminate,
              processLifecycleOwnership: 'caller',
            });
            terminate = handlers.requestTermination;
            return handlers;
          } },
        });
        try { await run; } finally { terminate?.({ kind: 'killSession' }); await run; }
        expect(vi.mocked(base.session.enqueueSessionTurnMutation!).mock.calls.some(([mutation]) => mutation.action === 'fail')).toBe(true);
        expect(failedTurnAccepted).toBe(acceptsFailure);
        expect(reports).toEqual(acceptsFailure && !recoveryUnavailable ? [expect.objectContaining({ sessionId: 'session-1', classification: expect.objectContaining({
          serviceId: 'happier.agent.antigravity/antigravity-account', profileId: connected ? 'selected-profile' : null, groupId: connected ? 'selected-pool' : null,
          ...(connected ? { groupGeneration: 7, expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuv' } : {}),
        }) })] : []);
      } finally { await lease.release(); }
    } finally {
      recoveryNotify.mockReset(); recoveryBoundary.outboxRoot = '';
      await rm(outboxRoot, { recursive: true, force: true });
    }
  });

  it('flushes streamed assistant text before publishing a turn-failed marker', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'cursor' });
    let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
    const session = baseParams.session as unknown as {
      enqueueAgentMessageCommitted: ReturnType<typeof vi.fn>;
    };
    const runtime = baseParams.runtime as unknown as {
      subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
    };
    runtime.subscribeRuntimeEvents = vi.fn((handler: RuntimeTurnMessageHandler) => {
      runtimeEventHandler = handler;
      return () => undefined;
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      config: {
        ...baseParams.config,
        agentMessageType: 'cursor',
        providerName: 'Cursor',
      },
      deps: {
        ...baseParams.deps,
        runPermissionModePromptLoopFn: vi.fn(async () => {
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 1,
            turnId: 'turn-4',
            startedBy: 'host',
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'message-delta',
            sessionId: 'session-1',
            emittedAtMs: 2,
            turnId: 'turn-4',
            channel: 'assistant',
            text: 'Visible partial answer.',
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-failed',
            sessionId: 'session-1',
            emittedAtMs: 3,
            turnId: 'turn-4',
            diagnostic: {
              code: 'cursor_runtime_error',
              severity: 'error',
              message: 'Cursor failed after streaming partial output.',
              details: { agentId: 'cursor' },
            },
          }));
        }),
      },
    };

    await runSessionLoopLifecycle(params);

    const streamedAssistantCallIndex = session.enqueueAgentMessageCommitted.mock.calls.findIndex(([provider, body, opts]) => {
      return provider === 'cursor'
        && body.type === 'message'
        && body.message === 'Visible partial answer.'
        && opts.meta?.happierStreamSegmentV1?.segmentState === 'interrupted';
    });
    const turnFailedCallIndex = session.enqueueAgentMessageCommitted.mock.calls.findIndex(([provider, body, opts]) => {
      return provider === 'cursor'
        && body.type === 'turn_failed'
        && body.id === 'turn-4'
        && opts.localId === 'turn-4:turn_failed';
    });

    expect(streamedAssistantCallIndex).toBeGreaterThanOrEqual(0);
    expect(turnFailedCallIndex).toBeGreaterThanOrEqual(0);
    expect(session.enqueueAgentMessageCommitted.mock.invocationCallOrder[streamedAssistantCallIndex]!).toBeLessThan(
      session.enqueueAgentMessageCommitted.mock.invocationCallOrder[turnFailedCallIndex]!,
    );
  });

  it('waits for runtime transcript projection durability before cleanup completes', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'opencode' });
    let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
    let releaseCommit!: () => void;
    const commitReleased = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const session = baseParams.session as unknown as {
      enqueueAgentMessageCommitted: ReturnType<typeof vi.fn>;
    };
    session.enqueueAgentMessageCommitted = vi.fn(async () => {
      await commitReleased;
      return { persisted: true as const, delivered: false as const };
    });
    const runtime = baseParams.runtime as unknown as {
      subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
    };
    runtime.subscribeRuntimeEvents = vi.fn((handler: RuntimeTurnMessageHandler) => {
      runtimeEventHandler = handler;
      return () => undefined;
    });
    const cleanupBackendRunResourcesFn = vi.fn(async ({ stopKeepAlive }: { stopKeepAlive: () => void }) => {
      stopKeepAlive();
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      deps: {
        ...baseParams.deps,
        cleanupBackendRunResourcesFn,
        runPermissionModePromptLoopFn: vi.fn(async () => {
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'transcript-message-committed',
            sessionId: 'session-1',
            emittedAtMs: 1,
            messageId: 'turn-1:terminal-note',
            role: 'assistant',
            text: 'Terminal failure marker',
            turnId: 'turn-1',
          }));
        }),
      },
    };

    let settled = false;
    const runPromise = runSessionLoopLifecycle(params).then(() => {
      settled = true;
    });

    await vi.waitFor(() => {
      expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
        'opencode',
        { type: 'message', message: 'Terminal failure marker' },
        expect.objectContaining({
          localId: 'turn-1:terminal-note',
          provenance: { kind: 'non_dependent', source: 'external' },
        }),
      );
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(settled).toBe(false);
    expect(cleanupBackendRunResourcesFn).not.toHaveBeenCalled();

    releaseCommit();
    await runPromise;

    expect(settled).toBe(true);
    expect(cleanupBackendRunResourcesFn).toHaveBeenCalledTimes(1);
  });

  it('does not log a hostile runtime transcript projection rejection', async () => {
    loggerDebugMock.mockClear();
    const baseParams = createLifecycleParams({ policyAgentId: 'opencode' });
    const hostileFailure = createRevokedTranscriptFailure(
      'private projected transcript must not enter logs',
    );
    let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
    const session = baseParams.session as unknown as {
      enqueueAgentMessageCommitted: ReturnType<typeof vi.fn>;
    };
    session.enqueueAgentMessageCommitted.mockRejectedValue(hostileFailure);
    const runtime = baseParams.runtime as unknown as {
      subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
    };
    runtime.subscribeRuntimeEvents = vi.fn((handler: RuntimeTurnMessageHandler) => {
      runtimeEventHandler = handler;
      return () => undefined;
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      deps: {
        ...baseParams.deps,
        runPermissionModePromptLoopFn: vi.fn(async () => {
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'transcript-message-committed',
            sessionId: 'session-1',
            emittedAtMs: 1,
            messageId: 'turn-private-projection:assistant',
            role: 'assistant',
            text: 'private projected transcript must not enter logs',
          }));
        }),
      },
    };

    await runSessionLoopLifecycle(params);

    expect(loggerReceivedIdentity(hostileFailure)).toBe(false);
    expect(loggerDebugMock).toHaveBeenCalledWith(
      '[Test] Runtime transcript projection failed (non-fatal)',
      {
        error: 'runtime_transcript_projection_failed',
        eventKind: 'transcript-message-committed',
      },
    );
  });

  it('waits for transcript projection durability before publishing terminal turn mutations', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'antigravity' });
    let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
    let releaseCommit!: () => void;
    const commitReleased = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const session = baseParams.session as unknown as {
      enqueueAgentMessageCommitted: ReturnType<typeof vi.fn>;
      enqueueSessionTurnMutation: ReturnType<typeof vi.fn>;
    };
    session.enqueueAgentMessageCommitted = vi.fn(async () => {
      await commitReleased;
      return { persisted: true as const, delivered: true as const, committedSequence: 7 };
    });
    const runtime = baseParams.runtime as unknown as {
      subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
    };
    runtime.subscribeRuntimeEvents = vi.fn((handler: RuntimeTurnMessageHandler) => {
      runtimeEventHandler = handler;
      return () => undefined;
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      deps: {
        ...baseParams.deps,
        runPermissionModePromptLoopFn: vi.fn(async () => {
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 1,
            turnId: 'turn-1',
            startedBy: 'host',
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'transcript-message-committed',
            sessionId: 'session-1',
            emittedAtMs: 2,
            messageId: 'turn-1:assistant',
            role: 'assistant',
            text: 'Antigravity answered.',
            turnId: 'turn-1',
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-complete',
            sessionId: 'session-1',
            emittedAtMs: 3,
            turnId: 'turn-1',
          }));
        }),
      },
    };

    const runPromise = runSessionLoopLifecycle(params);

    await vi.waitFor(() => {
      expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
        'antigravity',
        { type: 'message', message: 'Antigravity answered.' },
        expect.objectContaining({
          localId: 'turn-1:assistant',
          provenance: { kind: 'non_dependent', source: 'external' },
        }),
      );
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(session.enqueueSessionTurnMutation).toHaveBeenCalledWith(expect.objectContaining({
      action: 'begin',
      turnId: 'turn-1',
    }));
    expect(session.enqueueSessionTurnMutation).not.toHaveBeenCalledWith(expect.objectContaining({
      action: 'complete',
      turnId: 'turn-1',
    }));

    releaseCommit();
    await runPromise;

    expect(session.enqueueSessionTurnMutation).toHaveBeenCalledWith(expect.objectContaining({
      action: 'complete',
      turnId: 'turn-1',
    }));
  });

  it.each([false, true, 'source-first'] as const)('projects public runtime message deltas before publishing terminal turn mutations (Session-scoped final=%s)', async (sourceFinal) => {
    const baseParams = createLifecycleParams({ policyAgentId: 'cursor' });
    let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
    const session = baseParams.session as unknown as {
      enqueueAgentMessageCommitted: ReturnType<typeof vi.fn>;
      enqueueSessionTurnMutation: ReturnType<typeof vi.fn>;
    };
    session.enqueueAgentMessageCommitted = vi.fn(async () => ({
      persisted: true as const, delivered: true as const, committedSequence: 7,
    }));
    const runtime = baseParams.runtime as unknown as {
      subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
    };
    runtime.subscribeRuntimeEvents = vi.fn((handler: RuntimeTurnMessageHandler) => {
      runtimeEventHandler = handler;
      return () => undefined;
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      config: {
        ...baseParams.config,
        agentMessageType: 'cursor',
        providerName: 'Cursor',
      },
      deps: {
        ...baseParams.deps,
        runPermissionModePromptLoopFn: vi.fn(async () => {
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 1,
            turnId: 'turn-1',
            startedBy: 'host',
          }));
          if (sourceFinal === 'source-first') runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'transcript-message-committed', sessionId: 'session-1', emittedAtMs: 2,
            messageId: 'native-cursor-final', role: 'assistant', text: 'Cursor answered.',
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'message-delta',
            sessionId: 'session-1',
            emittedAtMs: 2,
            turnId: 'turn-1',
            channel: 'assistant',
            text: 'Cursor ',
            messageId: 'native-cursor-final',
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'message-delta',
            sessionId: 'session-1',
            emittedAtMs: 3,
            turnId: 'turn-1',
            channel: 'assistant',
            text: 'answered.',
            messageId: 'native-cursor-final',
          }));
          if (sourceFinal === true) runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'transcript-message-committed', sessionId: 'session-1', emittedAtMs: 3,
            messageId: 'native-cursor-final', role: 'assistant', text: 'Cursor answered.',
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-complete',
            sessionId: 'session-1',
            emittedAtMs: 4,
            turnId: 'turn-1',
          }));
        }),
      },
    };

    await runSessionLoopLifecycle(params);

    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'cursor',
      { type: 'message', message: 'Cursor answered.' },
      expect.objectContaining(sourceFinal === 'source-first' ? {
        localId: 'native-cursor-final',
        meta: expect.objectContaining({ source: 'runtime', runtimeEventKind: 'transcript-message-committed' }),
      } : {
        meta: expect.objectContaining({
          happierStreamSegmentV1: expect.objectContaining({
            segmentKind: 'assistant',
            segmentState: 'complete',
          }),
        }),
      }),
    );
    const committedCallOrder = session.enqueueAgentMessageCommitted.mock.invocationCallOrder.at(-1);
    const completeMutationCall = session.enqueueSessionTurnMutation.mock.calls.findIndex((call) => {
      const [mutation] = call;
      return mutation?.action === 'complete' && mutation.turnId === 'turn-1';
    });
    expect(committedCallOrder).toBeDefined();
    expect(completeMutationCall).toBeGreaterThanOrEqual(0);
    expect(committedCallOrder).toBeLessThan(
      session.enqueueSessionTurnMutation.mock.invocationCallOrder[completeMutationCall]!,
    );
    expect(session.enqueueSessionTurnMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'complete',
        turnId: 'turn-1',
        transcriptAnchors: { startSeqInclusive: 7, endSeqInclusive: 7, finalAssistantMessageSeq: 7 },
      }),
    );
  });

  it('serializes runtime transcript projections so tool-boundary flushes complete before later transcript rows', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'cursor' });
    let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
    let releaseStreamCommit!: () => void;
    const streamCommitReleased = new Promise<void>((resolve) => {
      releaseStreamCommit = resolve;
    });
    const session = baseParams.session as unknown as {
      enqueueAgentMessageCommitted: ReturnType<typeof vi.fn>;
    };
    session.enqueueAgentMessageCommitted = vi.fn(async (_provider, body, opts) => {
      if (
        body.type === 'message'
        && body.message === 'Before tool.'
        && opts.meta?.happierStreamSegmentV1
      ) {
        await streamCommitReleased;
      }
      return { persisted: true as const, delivered: false as const };
    });
    const runtime = baseParams.runtime as unknown as {
      subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
    };
    runtime.subscribeRuntimeEvents = vi.fn((handler: RuntimeTurnMessageHandler) => {
      runtimeEventHandler = handler;
      return () => undefined;
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      config: {
        ...baseParams.config,
        agentMessageType: 'cursor',
        providerName: 'Cursor',
      },
      deps: {
        ...baseParams.deps,
        runPermissionModePromptLoopFn: vi.fn(async () => {
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 1,
            turnId: 'turn-1',
            startedBy: 'host',
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'message-delta',
            sessionId: 'session-1',
            emittedAtMs: 2,
            turnId: 'turn-1',
            channel: 'assistant',
            text: 'Before tool.',
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'tool-call',
            sessionId: 'session-1',
            emittedAtMs: 3,
            turnId: 'turn-1',
            toolCallId: 'tool-1',
            toolName: 'read_file',
            input: { path: 'README.md' },
          }));
        }),
      },
    };

    const runPromise = runSessionLoopLifecycle(params);

    await vi.waitFor(() => {
      expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
        'cursor',
        { type: 'message', message: 'Before tool.' },
        expect.objectContaining({
          meta: expect.objectContaining({
            happierStreamSegmentV1: expect.objectContaining({
              segmentState: 'streaming',
            }),
          }),
        }),
      );
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(session.enqueueAgentMessageCommitted).not.toHaveBeenCalledWith(
      'cursor',
      expect.objectContaining({ type: 'tool-call' }),
      expect.objectContaining({ localId: expect.stringMatching(/^acp-call-v1:/) }),
    );

    releaseStreamCommit();
    await runPromise;

    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'cursor',
      expect.objectContaining({ type: 'tool-call' }),
      expect.objectContaining({ localId: expect.stringMatching(/^acp-call-v1:/) }),
    );
  });

  it('wires normalized provider tool evidence into the durable canonical Diff transcript', async () => {
    const baseParams = createLifecycleParams({
      policyAgentId: 'codex',
      checkpointToolProtocol: 'codex',
    });
    let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
    const runtime = baseParams.runtime as unknown as {
      subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
    };
    runtime.subscribeRuntimeEvents = vi.fn((handler: RuntimeTurnMessageHandler) => {
      runtimeEventHandler = handler;
      return () => undefined;
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      config: {
        ...baseParams.config,
        agentMessageType: 'codex',
      },
      deps: {
        ...baseParams.deps,
        runPermissionModePromptLoopFn: vi.fn(async () => {
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-start', sessionId: 'session-1', emittedAtMs: 1,
            turnId: 'host-turn-1', startedBy: 'provider',
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'tool-call', sessionId: 'session-1', emittedAtMs: 2,
            turnId: 'host-turn-1', toolCallId: 'edit-1', toolName: 'Edit',
            input: { file_path: 'src/real-wire.ts', old_string: 'before', new_string: 'after' },
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'tool-result', sessionId: 'session-1', emittedAtMs: 3,
            turnId: 'host-turn-1', toolCallId: 'edit-1', output: { status: 'completed' },
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-complete', sessionId: 'session-1', emittedAtMs: 4,
            turnId: 'host-turn-1', agentTurnId: 'provider-turn-1',
          }));
        }),
      },
    };

    await runSessionLoopLifecycle(params);

    expect(baseParams.session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({
        type: 'tool-call',
        name: 'Diff',
        input: expect.objectContaining({
          files: [expect.objectContaining({
            file_path: 'src/real-wire.ts',
            oldText: 'before',
            newText: 'after',
            provider: 'codex',
            provider_turn_id: 'provider-turn-1',
          })],
          _happier: expect.objectContaining({
            turnId: 'host-turn-1',
            provider: 'codex',
          }),
        }),
      }),
      expect.objectContaining({
        localId: expect.stringMatching(/^turn-diff-.*:tool-call$/),
      }),
    );
  });

});

describe('runSessionLoopLifecycle required transcript admission', () => {
  it('terminalizes as a typed failure instead of success after an earlier stable tool admission loses custody', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'cursor' });
    let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
    const runtime = baseParams.runtime as unknown as {
      subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
    };
    runtime.subscribeRuntimeEvents = vi.fn((handler: RuntimeTurnMessageHandler) => {
      runtimeEventHandler = handler;
      return () => undefined;
    });
    const session = baseParams.session as unknown as {
      enqueueAgentMessageCommitted: ReturnType<typeof vi.fn>;
      enqueueSessionTurnMutation: ReturnType<typeof vi.fn>;
    };
    session.enqueueAgentMessageCommitted.mockImplementation(async (_provider, body) => ({
      persisted: body.type !== 'tool-result',
      delivered: false,
    }));
    const notifyDaemonConnectedServiceTurnLifecycleFn = vi.fn<NotifyDaemonConnectedServiceTurnLifecycleFn>(async (input) => ({
      status: 'continue' as const,
      turnCustody: {
        status: 'recorded' as const,
        activeTurnId: input.event === 'task_started' ? input.turnId ?? null : null,
      },
    }));
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      opts: { ...baseParams.opts, startedBy: 'daemon' },
      deps: {
        ...baseParams.deps,
        notifyDaemonConnectedServiceTurnLifecycleFn,
        runPermissionModePromptLoopFn: vi.fn(async () => {
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 1,
            turnId: 'turn-required-output',
            startedBy: 'host',
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'tool-result',
            sessionId: 'session-1',
            emittedAtMs: 2,
            turnId: 'turn-required-output',
            toolCallId: 'tool-1',
            output: { text: 'stable result' },
          }));
          await new Promise((resolve) => setImmediate(resolve));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-complete',
            sessionId: 'session-1',
            emittedAtMs: 3,
            turnId: 'turn-required-output',
          }));
        }),
      },
    };

    await runSessionLoopLifecycle(params);

    expect(session.enqueueSessionTurnMutation).not.toHaveBeenCalledWith(expect.objectContaining({
      action: 'complete',
      turnId: 'turn-required-output',
    }));
    expect(session.enqueueSessionTurnMutation).toHaveBeenCalledWith(expect.objectContaining({
      action: 'fail',
      turnId: 'turn-required-output',
      issue: expect.objectContaining({
        code: 'runtime_transcript_required_admission_failed',
        source: 'stream_error',
      }),
    }));
    expect(notifyDaemonConnectedServiceTurnLifecycleFn).toHaveBeenCalledWith(expect.objectContaining({
      event: 'assistant_message_end',
      turnId: 'turn-required-output',
      terminalStatus: 'failed',
    }));
  });

  it.each([{}, { sidechainId: 'child-1' }, { sidechainId: 'child-1', turnId: 'turn-required-output' }])('keeps session-scoped tool admission loss separate from foreground success: %j', async (scope) => {
    const baseParams = createLifecycleParams({ policyAgentId: 'cursor' });
    let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
    const runtime = baseParams.runtime as unknown as {
      subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
    };
    runtime.subscribeRuntimeEvents = vi.fn((handler: RuntimeTurnMessageHandler) => {
      runtimeEventHandler = handler;
      return () => undefined;
    });
    const session = baseParams.session as unknown as {
      enqueueAgentMessageCommitted: ReturnType<typeof vi.fn>;
      enqueueSessionTurnMutation: ReturnType<typeof vi.fn>;
    };
    session.enqueueAgentMessageCommitted.mockImplementation(async (_provider, body) => ({
      persisted: body.type !== 'tool-result',
      delivered: false,
    }));
    const notifyDaemonConnectedServiceTurnLifecycleFn = vi.fn<NotifyDaemonConnectedServiceTurnLifecycleFn>(async (input) => ({
      status: 'continue' as const,
      turnCustody: {
        status: 'recorded' as const,
        activeTurnId: input.event === 'task_started' ? input.turnId ?? null : null,
      },
    }));
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      opts: { ...baseParams.opts, startedBy: 'daemon' },
      deps: {
        ...baseParams.deps,
        notifyDaemonConnectedServiceTurnLifecycleFn,
        runPermissionModePromptLoopFn: vi.fn(async () => {
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 1,
            turnId: 'turn-required-output',
            startedBy: 'host',
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'tool-result',
            sessionId: 'session-1',
            emittedAtMs: 2,
            ...scope,
            toolCallId: 'tool-1',
            output: { text: 'stable result' },
          }));
          await new Promise((resolve) => setImmediate(resolve));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-complete',
            sessionId: 'session-1',
            emittedAtMs: 3,
            turnId: 'turn-required-output',
          }));
        }),
      },
    };

    await runSessionLoopLifecycle(params);

    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith('cursor',
      expect.objectContaining({ type: 'tool-result', callId: 'tool-1' }), expect.anything());
    expect(session.enqueueSessionTurnMutation).toHaveBeenCalledWith(expect.objectContaining({
      action: 'complete',
      turnId: 'turn-required-output',
    }));
    expect(session.enqueueSessionTurnMutation).not.toHaveBeenCalledWith(expect.objectContaining({
      action: 'fail',
      turnId: 'turn-required-output',
      issue: expect.objectContaining({
        code: 'runtime_transcript_required_admission_failed',
        source: 'stream_error',
      }),
    }));
    expect(notifyDaemonConnectedServiceTurnLifecycleFn).toHaveBeenCalledWith(expect.objectContaining({
      event: 'assistant_message_end',
      turnId: 'turn-required-output',
      terminalStatus: 'completed',
    }));
  });

  it('keeps ephemeral progress loss non-fatal for terminal success', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'cursor' });
    let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
    const runtime = baseParams.runtime as unknown as {
      subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
    };
    runtime.subscribeRuntimeEvents = vi.fn((handler: RuntimeTurnMessageHandler) => {
      runtimeEventHandler = handler;
      return () => undefined;
    });
    const session = baseParams.session as unknown as {
      enqueueSessionTurnMutation: ReturnType<typeof vi.fn>;
      sendAgentMessageEphemeral: ReturnType<typeof vi.fn>;
      getEphemeralStreamConnectionEpoch: ReturnType<typeof vi.fn>;
    };
    session.sendAgentMessageEphemeral = vi.fn(async () => ({
      accepted: false as const,
      epoch: 1,
      reason: 'disconnected' as const,
    }));
    session.getEphemeralStreamConnectionEpoch = vi.fn(() => 1);
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      deps: {
        ...baseParams.deps,
        runPermissionModePromptLoopFn: vi.fn(async () => {
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 1,
            turnId: 'turn-ephemeral-progress',
            startedBy: 'host',
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'tool-progress',
            sessionId: 'session-1',
            emittedAtMs: 2,
            turnId: 'turn-ephemeral-progress',
            toolCallId: 'tool-1',
            progress: { toolName: 'Read', status: 'running' },
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-complete',
            sessionId: 'session-1',
            emittedAtMs: 3,
            turnId: 'turn-ephemeral-progress',
          }));
        }),
      },
    };

    await runSessionLoopLifecycle(params);

    expect(session.enqueueSessionTurnMutation).toHaveBeenCalledWith(expect.objectContaining({
      action: 'complete',
      turnId: 'turn-ephemeral-progress',
    }));
  });

  it('keeps a valid reply pending until an ACK inside the transcript transport budget', async () => {
    const { configuration } = await import('@/configuration');
    const { createRuntimeSessionClientDurableMutationOutbox } = await import('@/api/session/client/transport/mutations/createRuntimeSessionClientDurableMutationOutbox');
    const { createTranscriptMessageAppendMutation } = await import('@/api/session/client/transport/mutations/sessionClientDurableMutationTypes');
    const fixtureDir = await mkdtemp(join(tmpdir(), 'happier-transcript-drain-owner-'));
    const serverDirDescriptor = Object.getOwnPropertyDescriptor(configuration, 'activeServerDir')!;
    // The isolated filesystem location and the socket are environment/OS/network boundaries.
    Object.defineProperty(configuration, 'activeServerDir', {
      configurable: serverDirDescriptor.configurable, enumerable: serverDirDescriptor.enumerable, get: () => fixtureDir,
    });
    vi.stubEnv('HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS', '10000');
    let acknowledge!: () => void;
    const acknowledgement = new Promise<void>((resolve) => { acknowledge = resolve; });
    let reportDeliveryStarted!: () => void;
    const deliveryStarted = new Promise<void>((resolve) => { reportDeliveryStarted = resolve; });
    let nextServerSequence = 47;
    const socket = {
      connected: true,
      emit: () => undefined,
      timeout(ms: number) { expect(ms).toBe(10_000); return this; },
      async emitWithAck(_event: string, payload: unknown) {
        // The Socket.IO boundary accepts an untyped payload; production codecs remain real.
        const observation = payload as Readonly<{ localId: string }>;
        reportDeliveryStarted();
        await acknowledgement;
        const seq = nextServerSequence++;
        return { ok: true, status: 'observed', id: `server-reply-${seq}`, seq,
          localId: observation.localId, didWrite: true, ingestedAt: Date.now() };
      },
    };
    const outbox = createRuntimeSessionClientDurableMutationOutbox({
      token: 'test-token', serverUrl: 'https://api.test.invalid', sessionId: 'session-1',
      getSocket: () => socket, requestReconnect: () => undefined, flushOnReady: false,
    });
    let runPromise: Promise<void> | null = null;
    try {
      await outbox.setSessionSyncPendingInputServerContract({
        mode: 'session_sync_v2_pending_input_v1', runtimeActivity: 'v2', pendingInput: 'v1',
        publisherAuthority: 'indeterminate', sessionConnectionEpoch: 1, socket,
        transcriptTransport: { mode: 'session_transcript_observation_v1' },
      });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const base = createLifecycleParams({ runPermissionModePromptLoopFn: runPermissionModePromptLoop });
      const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(
        (mode) => JSON.stringify(mode), { batcher: combinePermissionModeQueuedPrompts },
      );
      let nativeListener: ((event: AgentSessionRuntimeEvent) => void) | undefined;
      let nativeDisposed = false;
      const provider: AgentSessionRuntime = {
        async send() { throw new Error('This provider-owned turn has no host prompt'); },
        watch(listener) { nativeListener = listener; return { dispose() { nativeListener = undefined; } }; },
        dispose() { nativeDisposed = true; },
      };
      const runtime = createNativeAgentSessionOperations(provider, 'session-1', undefined, undefined, undefined, undefined, undefined, {
        context: {} as AgentSessionRuntimeContext, cwd: '/workspace', connectedAccounts: [],
        capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
        cancellation: { declared: false }, configuration: { declared: false }, compaction: { capability: null },
      });
      const committedBodies: unknown[] = [];
      const session = Object.assign(base.session, {
        sendAgentMessageEphemeral: () => ({ accepted: true as const, epoch: 0 }),
        enqueueAgentMessageCommitted: async (...[_provider, body, options]: Parameters<NonNullable<SessionLoopLifecycleParams['session']['enqueueAgentMessageCommitted']>>) => {
          committedBodies.push(body);
          return await outbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
            sessionId: 'session-1', localId: options.localId,
            content: { t: 'plain', v: buildAcpAgentMessageEnvelope({ provider: _provider, body, meta: options.meta }) },
            messageRole: 'agent',
            createdAt: options.createdAt ?? Date.now(), updatedAt: options.updatedAt,
            provenance: options.provenance,
          }), options.admission === undefined ? undefined : { admission: options.admission });
        },
      });
      runPromise = runSessionLoopLifecycle({
        ...base, session, runtime, hookRuntime: runtime,
        permissionModeState: { ...base.permissionModeState, messageQueue: queue },
        deps: {
          ...base.deps,
          registerRunnerTerminationHandlersFn: (options) => registerRunnerTerminationHandlers({
            ...options, processLifecycleOwnership: 'caller', sessionExitReport: null,
            exit: () => undefined,
          }),
        },
      });
      await vi.waitFor(() => {
        expect(base.deps.registerKillSessionHandlerFn).toHaveBeenCalled();
        expect(nativeListener).toBeTypeOf('function');
      });
      for (const event of [
        { kind: 'turn-start', turnId: 'host-reply-turn', agentTurnId: 'native-reply-turn', startedBy: 'provider' },
        { kind: 'message-delta', turnId: 'host-reply-turn', channel: 'assistant', text: 'QA_HOST_R6_OK' },
        { kind: 'tool-call', turnId: 'host-reply-turn', toolCallId: 'call-after-reply', toolName: 'Read', input: { path: 'README.md' } },
        { kind: 'turn-complete', turnId: 'host-reply-turn', agentTurnId: 'native-reply-turn' },
        { kind: 'runtime-ended', cause: 'providerEnded', retryable: false },
      ]) nativeListener?.(canonicalRuntimeEvent({ ...event, sessionId: 'session-1', emittedAtMs: Date.now() }));
      await vi.waitFor(() => expect(committedBodies).toHaveLength(1));
      await deliveryStarted;
      await vi.advanceTimersByTimeAsync(6_000);
      expect(committedBodies).toEqual([{ type: 'message', message: 'QA_HOST_R6_OK' }]);
      expect(base.deps.cleanupBackendRunResourcesFn).not.toHaveBeenCalled();
      expect(nativeDisposed).toBe(true);
      expect(session.enqueueSessionTurnMutation).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'fail' }));
      expect(session.enqueueSessionTurnMutation).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'complete' }));
      acknowledge();
      await runPromise;
      expect(committedBodies).toEqual([
        { type: 'message', message: 'QA_HOST_R6_OK' },
        expect.objectContaining({ type: 'tool-call', callId: 'call-after-reply', name: 'Read' }),
        expect.objectContaining({ type: 'tool-result', callId: 'call-after-reply', isError: true,
          output: expect.objectContaining({ status: 'failed' }) }),
      ]);
      expect(base.deps.cleanupBackendRunResourcesFn).toHaveBeenCalled();
      expect(session.enqueueSessionTurnMutation).toHaveBeenCalledWith(expect.objectContaining({ action: 'complete' }));
      expect(session.enqueueSessionTurnMutation).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'fail' }));
    } finally {
      acknowledge();
      if (runPromise) await runPromise;
      await outbox.close();
      vi.useRealTimers();
      vi.unstubAllEnvs();
      Object.defineProperty(configuration, 'activeServerDir', serverDirDescriptor);
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });
});
