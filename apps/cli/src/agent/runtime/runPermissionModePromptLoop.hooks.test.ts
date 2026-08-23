import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Metadata } from '@/api/types';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { combinePermissionModeQueuedPrompts, type PermissionModeQueuedPrompt } from '@/agent/runtime/permissions/queuedPrompt';
import type { RuntimeTurnOperations } from '@/agent/runtime/turns/runtimeTurnOperations';
import { createSessionProviderInputConsumer } from '@/agent/runtime/session/input/sessionProviderInputConsumer';

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

import { runPermissionModePromptLoop } from './runPermissionModePromptLoop';

function createModeQueue() {
  return new MessageQueue2<{
    permissionMode: any;
    appendSystemPrompt?: string | null;
    model?: string;
    suppressUserEcho?: boolean;
    providerPromptAlreadyResolved?: boolean;
    inputContextBlock?: string;
  }, PermissionModeQueuedPrompt>(
    (mode) => JSON.stringify(mode),
    {
      batcher: (messages) => combinePermissionModeQueuedPrompts(messages),
    },
  );
}

function createRuntime() {
  return {
    beginTurnLifecycle: vi.fn(),
    sendTurnPrompt: vi.fn(async () => undefined),
    steerInFlightTurn: vi.fn(async () => undefined),
    waitForTurnCompletion: vi.fn(async () => undefined),
    subscribeRuntimeEvents: vi.fn(() => () => undefined),
    respondToPermission: vi.fn(async () => undefined),
    cancelTurn: vi.fn(async () => undefined),
    readSessionIdentity: vi.fn(() => ({ sessionId: 'provider-session-1' })),
    updateSessionRuntimeConfig: vi.fn<RuntimeTurnOperations['updateSessionRuntimeConfig']>(async () => undefined),
    compactContext: vi.fn(async () => undefined),
    resetOrDisposeRuntime: vi.fn(async () => undefined),
    shouldResumeAfterPermissionModeChange: vi.fn(() => true),
    isProviderNativeCommand: vi.fn((_prompt: string) => false),
  };
}

function createSelectedToolBindings() {
  return [{
    tool: {
      toolId: 'example.agent-context-companion/review-summary-tool',
      actionId: 'review-summary',
      name: 'review_summary',
      title: 'Review summary',
      description: 'Summarize the bounded review transcript.',
      inputSchema: { type: 'object', additionalProperties: false },
      surfaces: ['agent', 'mcp'],
    },
    expectedContributorImmutableGenerationId: 'generation-g',
  }] as const;
}

async function runSingleSpecialCommand(params: Readonly<{
  text: string;
  localId: string;
  runtime?: ReturnType<typeof createRuntime>;
}>) {
  const observeProviderInputSettlement = vi.fn();
  const confirmUserMessageLocallyConsumed = vi.fn();
  const session = createMutableApiSessionClientFixture<Metadata>({
    overrides: {
      sessionId: 'session-local-special-command',
      observeProviderInputSettlement,
      confirmUserMessageLocallyConsumed,
    } as Partial<Parameters<typeof runPermissionModePromptLoop>[0]['session']>,
  });
  session.__setMetadata(createTestMetadata({ permissionMode: 'default', permissionModeUpdatedAt: 0 }));
  const queue = createModeQueue();
  queue.push({ text: params.text, localId: params.localId }, { permissionMode: 'default' });
  const runtime = params.runtime ?? createRuntime();
  let shouldExit = false;

  await runPermissionModePromptLoop({
    providerName: 'Test Provider',
    agentMessageType: 'qwen',
    explicitPermissionMode: undefined,
    session,
    messageQueue: queue,
    permissionHandler: { setPermissionMode: vi.fn(), reset: vi.fn() },
    runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
    createOverrideSynchronizer: () => ({
      syncFromMetadata: () => undefined,
      flushPendingAfterStart: async () => undefined,
    }),
    messageBuffer: new MessageBuffer(),
    shouldExit: () => shouldExit,
    getAbortSignal: () => new AbortController().signal,
    keepAlive: () => undefined,
    setThinking: () => undefined,
    sendReady: () => { shouldExit = true; },
    currentPermissionModeUpdatedAt: 0,
    setCurrentPermissionMode: () => undefined,
    setCurrentPermissionModeUpdatedAt: () => undefined,
    formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
  } as Parameters<typeof runPermissionModePromptLoop>[0]);

  return { observeProviderInputSettlement, confirmUserMessageLocallyConsumed, runtime };
}

describe('runPermissionModePromptLoop hook dispatch', () => {
  beforeEach(() => {
    loggerDebugMock.mockClear();
  });

  it('dispatches an advertised provider command verbatim without consuming fresh-session composition', async () => {
    const session = createMutableApiSessionClientFixture<Metadata>({
      overrides: { sessionId: 'session-provider-command' } as Partial<Parameters<typeof runPermissionModePromptLoop>[0]['session']>,
    });
    session.__setMetadata(createTestMetadata({
      permissionMode: 'default',
      permissionModeUpdatedAt: 0,
      slashCommands: ['goal'],
    }));
    const queue = createModeQueue();
    queue.push({ text: '/goal fix authentication', localId: 'local-goal' }, { permissionMode: 'default' });
    const runtime = createRuntime();
    runtime.isProviderNativeCommand.mockImplementation((prompt: string) => prompt.startsWith('/goal'));
    const resolveFreshSessionSystemPrompt = vi.fn(async () => 'SYSTEM');
    const resolveAgentCompositionBeforeDispatch = vi.fn(async () => ({
      managedPluginIds: [],
      selectedTools: [],
      selectedToolBindings: [],
      prompt: 'COMPOSITION',
    }));
    const transformAgentContextBeforeDispatch = vi.fn(async (payload: Record<string, unknown>) => payload);
    let dispatchCount = 0;
    runtime.sendTurnPrompt.mockImplementation(async () => {
      dispatchCount += 1;
      if (dispatchCount === 1) {
        queue.push({ text: 'continue normally', localId: 'local-normal' }, { permissionMode: 'default' });
      }
    });
    let shouldExit = false;

    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'pi',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler: { setPermissionMode: vi.fn(), reset: vi.fn() },
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
      createOverrideSynchronizer: () => ({
        syncFromMetadata: () => undefined,
        flushPendingAfterStart: async () => undefined,
      }),
      messageBuffer: new MessageBuffer(),
      shouldExit: () => shouldExit,
      getAbortSignal: () => new AbortController().signal,
      keepAlive: () => undefined,
      setThinking: () => undefined,
      sendReady: () => { if (dispatchCount === 2) shouldExit = true; },
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => undefined,
      setCurrentPermissionModeUpdatedAt: () => undefined,
      resolveFreshSessionSystemPrompt,
      resolveAgentCompositionBeforeDispatch,
      transformAgentContextBeforeDispatch,
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    } as Parameters<typeof runPermissionModePromptLoop>[0]);

    expect(runtime.sendTurnPrompt).toHaveBeenCalledWith('/goal fix authentication', {
      localId: 'local-goal',
      localIds: ['local-goal'],
    });
    expect(runtime.sendTurnPrompt).toHaveBeenCalledWith('SYSTEM\n\nCOMPOSITION\n\ncontinue normally', {
      localId: 'local-normal',
      localIds: ['local-normal'],
    });
    expect(resolveFreshSessionSystemPrompt).toHaveBeenCalledTimes(1);
    expect(resolveAgentCompositionBeforeDispatch).toHaveBeenCalledTimes(1);
    expect(transformAgentContextBeforeDispatch).toHaveBeenCalledTimes(1);
  });

  it('settles a successful local clear command as accepted with its exact opaque local id', async () => {
    const localId = '  local-clear-opaque  ';

    const result = await runSingleSpecialCommand({ text: '/clear', localId });

    expect(result.runtime.resetOrDisposeRuntime).toHaveBeenCalledTimes(1);
    expect(result.observeProviderInputSettlement).toHaveBeenCalledWith({
      kind: 'accepted',
      localId,
      userMessageSeq: null,
    });
    expect(result.confirmUserMessageLocallyConsumed).toHaveBeenCalledTimes(1);
  });

  it('settles a successful local compact command as accepted with its exact opaque local id', async () => {
    const localId = '  local-compact-accepted-opaque  ';

    const result = await runSingleSpecialCommand({ text: '/compact retain context', localId });

    expect(result.runtime.compactContext).toHaveBeenCalledWith('/compact retain context');
    expect(result.observeProviderInputSettlement).toHaveBeenCalledWith({
      kind: 'accepted',
      localId,
      userMessageSeq: null,
    });
    expect(result.confirmUserMessageLocallyConsumed).toHaveBeenCalledTimes(1);
  });

  it('settles an unsupported local compact command as rejected before effect with its exact opaque local id', async () => {
    const localId = '  local-compact-opaque  ';
    const runtime = createRuntime();
    delete (runtime as Partial<ReturnType<typeof createRuntime>>).compactContext;

    const result = await runSingleSpecialCommand({ text: '/compact', localId, runtime });

    expect(result.observeProviderInputSettlement).toHaveBeenCalledWith({
      kind: 'rejected_before_effect',
      localId,
      userMessageSeq: null,
      reason: 'provider_rejected_before_acceptance',
      diagnostic: {
        code: 'local_special_command_rejected',
        severity: 'error',
        message: 'Error: Error: /compact is not supported by this runtime',
      },
      retryable: false,
    });
    expect(result.confirmUserMessageLocallyConsumed).toHaveBeenCalledTimes(1);
  });

  it('keeps the shared Pending pump armed through a non-steerable settling window until the turn ends', async () => {
    const session = createMutableApiSessionClientFixture<Metadata>({
      overrides: { sessionId: 'session-active-turn-pump' } as Partial<Parameters<typeof runPermissionModePromptLoop>[0]['session']>,
    });
    session.__setMetadata(createTestMetadata({ permissionMode: 'default', permissionModeUpdatedAt: 0 }));
    const queue = createModeQueue();
    queue.push({ text: 'active turn', localId: 'local-active-turn' }, { permissionMode: 'default' });
    const inputConsumer = createSessionProviderInputConsumer({
      messageQueue: queue,
      session,
      reconcileWhenEmpty: 'skip',
    });
    let resolvePumpStarted: () => void = () => {};
    const pumpStarted = new Promise<void>((resolve) => { resolvePumpStarted = resolve; });
    const pumpPendingWhileActive = vi.spyOn(inputConsumer, 'pumpPendingWhileActive')
      .mockImplementation(async ({ abortSignal }) => {
        resolvePumpStarted();
        await new Promise<void>((resolve) => {
          if (abortSignal.aborted) return resolve();
          abortSignal.addEventListener('abort', () => resolve(), { once: true });
        });
      });
    const runtime = createRuntime() as ReturnType<typeof createRuntime> & {
      supportsInFlightSteer: () => boolean;
      canSteerPrompt: () => boolean;
    };
    let steerable = false;
    let resolveTurnCompletion: () => void = () => undefined;
    const turnCompletion = new Promise<void>((resolve) => { resolveTurnCompletion = resolve; });
    runtime.supportsInFlightSteer = vi.fn(() => true);
    runtime.canSteerPrompt = vi.fn(() => steerable);
    runtime.beginTurnLifecycle.mockImplementation(() => { steerable = false; });
    runtime.sendTurnPrompt.mockImplementation(async () => { steerable = true; });
    runtime.waitForTurnCompletion.mockImplementation(async () => {
      steerable = false;
      await turnCompletion;
    });
    const abortController = new AbortController();
    let shouldExit = false;

    const loop = runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      inputConsumer,
      permissionHandler: { setPermissionMode: vi.fn(), reset: vi.fn() },
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
      createOverrideSynchronizer: () => ({
        syncFromMetadata: () => undefined,
        flushPendingAfterStart: async () => undefined,
      }),
      messageBuffer: new MessageBuffer(),
      shouldExit: () => shouldExit,
      getAbortSignal: () => abortController.signal,
      keepAlive: () => undefined,
      setThinking: () => undefined,
      sendReady: () => { shouldExit = true; },
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => undefined,
      setCurrentPermissionModeUpdatedAt: () => undefined,
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    } as Parameters<typeof runPermissionModePromptLoop>[0]);

    await pumpStarted;
    expect(pumpPendingWhileActive).toHaveBeenCalledTimes(1);
    expect(pumpPendingWhileActive.mock.calls[0]?.[0].abortSignal.aborted).toBe(false);
    await vi.waitFor(() => expect(runtime.waitForTurnCompletion).toHaveBeenCalledTimes(1));
    expect(await pumpPendingWhileActive.mock.calls[0]?.[0].shouldContinue?.()).toBe(true);

    resolveTurnCompletion();
    await loop;
    expect(pumpPendingWhileActive.mock.calls[0]?.[0].abortSignal.aborted).toBe(true);
  });

  it('does not retain an arbitrary active-turn Pending pump rejection', async () => {
    const session = createMutableApiSessionClientFixture<Metadata>({
      overrides: { sessionId: 'session-active-turn-pump-log-privacy' } as Partial<Parameters<typeof runPermissionModePromptLoop>[0]['session']>,
    });
    session.__setMetadata(createTestMetadata({ permissionMode: 'default', permissionModeUpdatedAt: 0 }));
    const queue = createModeQueue();
    queue.push({ text: 'active turn', localId: 'local-active-turn' }, { permissionMode: 'default' });
    const inputConsumer = createSessionProviderInputConsumer({
      messageQueue: queue,
      session,
      reconcileWhenEmpty: 'skip',
    });
    const hostile = Proxy.revocable({}, {});
    hostile.revoke();
    vi.spyOn(inputConsumer, 'pumpPendingWhileActive').mockRejectedValueOnce(hostile.proxy);
    const runtime = createRuntime() as ReturnType<typeof createRuntime> & {
      supportsInFlightSteer: () => boolean;
      canSteerPrompt: () => boolean;
    };
    let steerable = false;
    runtime.supportsInFlightSteer = vi.fn(() => true);
    runtime.canSteerPrompt = vi.fn(() => steerable);
    runtime.beginTurnLifecycle.mockImplementation(() => { steerable = false; });
    runtime.sendTurnPrompt.mockImplementation(async () => { steerable = true; });
    runtime.waitForTurnCompletion.mockImplementation(async () => { steerable = false; });
    let shouldExit = false;

    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      inputConsumer,
      permissionHandler: { setPermissionMode: vi.fn(), reset: vi.fn() },
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
      createOverrideSynchronizer: () => ({
        syncFromMetadata: () => undefined,
        flushPendingAfterStart: async () => undefined,
      }),
      messageBuffer: new MessageBuffer(),
      shouldExit: () => shouldExit,
      getAbortSignal: () => new AbortController().signal,
      keepAlive: () => undefined,
      setThinking: () => undefined,
      sendReady: () => { shouldExit = true; },
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => undefined,
      setCurrentPermissionModeUpdatedAt: () => undefined,
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    } as Parameters<typeof runPermissionModePromptLoop>[0]);

    const logCall = loggerDebugMock.mock.calls.find(
      ([message]) => message === '[Test Provider] Active-turn Pending pump stopped after non-fatal error',
    );
    expect(logCall?.[0]).toBe('[Test Provider] Active-turn Pending pump stopped after non-fatal error');
    expect(logCall?.length).toBe(1);
  });

  it('arms the active-turn Pending pump for send-now interrupt when in-flight steer is unsupported', async () => {
    const session = createMutableApiSessionClientFixture<Metadata>({
      overrides: { sessionId: 'session-active-turn-pump-send-now-without-steer' } as Partial<Parameters<typeof runPermissionModePromptLoop>[0]['session']>,
    });
    session.__setMetadata(createTestMetadata({ permissionMode: 'default', permissionModeUpdatedAt: 0 }));
    const queue = createModeQueue();
    queue.push({ text: 'active turn', localId: 'local-active-turn' }, { permissionMode: 'default' });
    const inputConsumer = createSessionProviderInputConsumer({
      messageQueue: queue,
      session,
      reconcileWhenEmpty: 'skip',
    });
    const pumpPendingWhileActive = vi.spyOn(inputConsumer, 'pumpPendingWhileActive')
      .mockImplementation(async () => undefined);
    const runtime = createRuntime() as ReturnType<typeof createRuntime> & {
      supportsInFlightSteer: () => boolean;
      canSteerPrompt: () => boolean;
    };
    runtime.supportsInFlightSteer = vi.fn(() => false);
    runtime.canSteerPrompt = vi.fn(() => false);
    let shouldExit = false;

    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      inputConsumer,
      permissionHandler: { setPermissionMode: vi.fn(), reset: vi.fn() },
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
      createOverrideSynchronizer: () => ({
        syncFromMetadata: () => undefined,
        flushPendingAfterStart: async () => undefined,
      }),
      messageBuffer: new MessageBuffer(),
      shouldExit: () => shouldExit,
      getAbortSignal: () => new AbortController().signal,
      keepAlive: () => undefined,
      setThinking: () => undefined,
      sendReady: () => { shouldExit = true; },
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => undefined,
      setCurrentPermissionModeUpdatedAt: () => undefined,
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    } as Parameters<typeof runPermissionModePromptLoop>[0]);

    expect(runtime.supportsInFlightSteer()).toBe(false);
    expect(pumpPendingWhileActive).toHaveBeenCalledTimes(1);
  });

  it('keeps a dequeued compact command behind enforcement that wins before provider dispatch', async () => {
    const session = createMutableApiSessionClientFixture<Metadata>({
      overrides: {
        sessionId: 'session-compact-enforcement-first',
      } as Partial<Parameters<typeof runPermissionModePromptLoop>[0]['session']>,
    });
    session.__setMetadata(createTestMetadata({
      permissionMode: 'default',
      permissionModeUpdatedAt: 0,
    }));
    const queue = createModeQueue();
    queue.push({ text: '/compact keep the credential transition boundary', localId: 'local-compact' }, {
      permissionMode: 'default',
    });
    const runtime = createRuntime();
    let runtimeConfigStartedResolve: () => void = () => {};
    const runtimeConfigStarted = new Promise<void>((resolve) => {
      runtimeConfigStartedResolve = resolve;
    });
    let releaseRuntimeConfig: () => void = () => {};
    const runtimeConfigPaused = new Promise<void>((resolve) => {
      releaseRuntimeConfig = resolve;
    });
    runtime.updateSessionRuntimeConfig.mockImplementationOnce(async () => {
      runtimeConfigStartedResolve();
      await runtimeConfigPaused;
    });
    const inputConsumer = createSessionProviderInputConsumer({
      messageQueue: queue,
      session,
      reconcileWhenEmpty: 'skip',
    });
    const abortController = new AbortController();
    let shouldExit = false;

    const loop = runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      inputConsumer,
      permissionHandler: {
        setPermissionMode: vi.fn(),
        reset: vi.fn(),
      },
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
      createOverrideSynchronizer: () => ({
        syncFromMetadata: () => undefined,
        flushPendingAfterStart: async () => undefined,
      }),
      messageBuffer: new MessageBuffer(),
      shouldExit: () => shouldExit,
      getAbortSignal: () => abortController.signal,
      keepAlive: () => undefined,
      setThinking: () => undefined,
      sendReady: () => {
        shouldExit = true;
      },
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => undefined,
      setCurrentPermissionModeUpdatedAt: () => undefined,
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    } as Parameters<typeof runPermissionModePromptLoop>[0]);

    await runtimeConfigStarted;
    const enforcement = inputConsumer.enforceProviderInputAdmission({
      kind: 'action_required',
      reason: 'generation_pending',
      serviceId: 'claude-subscription',
      groupId: 'primary',
      epochId: 'dispatch:compact',
    });
    await expect(enforcement).resolves.toMatchObject({ status: 'enforced' });

    releaseRuntimeConfig();
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      expect(runtime.compactContext).not.toHaveBeenCalled();
    } finally {
      await inputConsumer.clearProviderInputAdmission({
        serviceId: 'claude-subscription',
        groupId: 'primary',
        epochId: 'dispatch:compact',
      });
    }

    await loop;
    expect(runtime.compactContext).toHaveBeenCalledWith('/compact keep the credential transition boundary');
  });

  it('keeps enforcement behind an ordinary dispatch already paused in prompt preparation', async () => {
    const session = createMutableApiSessionClientFixture<Metadata>({
      overrides: {
        sessionId: 'session-dispatch-custody',
      } as Partial<Parameters<typeof runPermissionModePromptLoop>[0]['session']>,
    });
    session.__setMetadata(createTestMetadata({
      permissionMode: 'default',
      permissionModeUpdatedAt: 0,
    }));
    const queue = createModeQueue();
    queue.push({ text: 'hello', localId: 'local-custody' }, { permissionMode: 'default' });
    const runtime = createRuntime();
    const inputConsumer = createSessionProviderInputConsumer({
      messageQueue: queue,
      session,
      reconcileWhenEmpty: 'skip',
    });
    const abortController = new AbortController();
    let preparationStartedResolve: () => void = () => {};
    const preparationStarted = new Promise<void>((resolve) => {
      preparationStartedResolve = resolve;
    });
    let releasePreparation: () => void = () => {};
    const preparationPaused = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    let shouldExit = false;

    const loop = runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      inputConsumer,
      permissionHandler: {
        setPermissionMode: vi.fn(),
        reset: vi.fn(),
      },
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
      createOverrideSynchronizer: () => ({
        syncFromMetadata: () => undefined,
        flushPendingAfterStart: async () => undefined,
      }),
      messageBuffer: new MessageBuffer(),
      shouldExit: () => shouldExit,
      getAbortSignal: () => abortController.signal,
      keepAlive: () => undefined,
      setThinking: () => undefined,
      sendReady: () => {
        shouldExit = true;
      },
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => undefined,
      setCurrentPermissionModeUpdatedAt: () => undefined,
      transformAgentContextBeforeDispatch: async (payload) => {
        preparationStartedResolve();
        await preparationPaused;
        return payload;
      },
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    } as Parameters<typeof runPermissionModePromptLoop>[0]);

    await preparationStarted;
    const enforcement = inputConsumer.enforceProviderInputAdmission({
      kind: 'action_required',
      reason: 'generation_pending',
      serviceId: 'openai-codex',
      groupId: 'primary',
      epochId: 'dispatch:ordinary',
    });
    const enforcementSettled = vi.fn();
    void enforcement.then(enforcementSettled, enforcementSettled);
    await new Promise<void>((resolve) => setImmediate(resolve));

    try {
      expect(runtime.sendTurnPrompt).not.toHaveBeenCalled();
      expect(enforcementSettled).not.toHaveBeenCalled();
    } finally {
      releasePreparation();
    }
    await expect(enforcement).resolves.toMatchObject({ status: 'enforced' });
    await loop;
    expect(runtime.sendTurnPrompt).toHaveBeenCalledTimes(1);
    expect(runtime.sendTurnPrompt).toHaveBeenCalledWith('hello', {
      localId: 'local-custody',
      localIds: ['local-custody'],
    });
  });

  it('applies agent.context.before to the finalized outgoing provider prompt before dispatch', async () => {
    const session = createMutableApiSessionClientFixture<Metadata>({
      overrides: {
        sessionId: 'session-1',
      } as Partial<Parameters<typeof runPermissionModePromptLoop>[0]['session']>,
    });
    session.__setMetadata(createTestMetadata({
      permissionMode: 'default',
      permissionModeUpdatedAt: 0,
    }));
    const queue = createModeQueue();
    const inputContextBlock = '<happier_input_context v="1">\nsource_kind="automation"\n</happier_input_context>';
    queue.push({ text: 'hello', localId: 'local-1', inputContextBlock }, {
      permissionMode: 'default',
      inputContextBlock,
    });
    const runtime = createRuntime();
    const messageBuffer = new MessageBuffer();
    let shouldExit = false;
    const transformAgentContextBeforeDispatch = vi.fn(async (payload: Record<string, unknown>) => ({
      ...payload,
      prompt: `${payload.prompt} [context]`,
      messages: [
        ...(payload.messages as readonly unknown[]),
        { role: 'system', content: 'fixture context' },
      ],
    }));

    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler: {
        setPermissionMode: vi.fn(),
        reset: vi.fn(),
      },
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
      createOverrideSynchronizer: () => ({
        syncFromMetadata: () => undefined,
        flushPendingAfterStart: async () => undefined,
      }),
      messageBuffer,
      shouldExit: () => shouldExit,
      getAbortSignal: () => new AbortController().signal,
      keepAlive: () => undefined,
      setThinking: () => undefined,
      sendReady: () => {
        shouldExit = true;
      },
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => undefined,
      setCurrentPermissionModeUpdatedAt: () => undefined,
      resolveFreshSessionSystemPrompt: async () => 'SYSTEM',
      transformAgentContextBeforeDispatch,
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    } as Parameters<typeof runPermissionModePromptLoop>[0]);

    expect(transformAgentContextBeforeDispatch).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: session.sessionId,
      runtimeFamily: 'hostSession',
      prompt: 'SYSTEM\n\nhello',
      messages: [{ role: 'user', content: 'SYSTEM\n\nhello' }],
    }));
    expect(runtime.sendTurnPrompt).toHaveBeenCalledWith(`${inputContextBlock}\n\nSYSTEM\n\nhello [context]`, {
      localId: 'local-1',
      localIds: ['local-1'],
    });
  });

  it('resolves Agent composition at the next-turn boundary before fresh static prompt contributions', async () => {
    const session = createMutableApiSessionClientFixture<Metadata>({
      overrides: { sessionId: 'session-composition-boundary' } as Partial<Parameters<typeof runPermissionModePromptLoop>[0]['session']>,
    });
    session.__setMetadata(createTestMetadata({
      permissionMode: 'default',
      permissionModeUpdatedAt: 0,
    }));
    const queue = createModeQueue();
    queue.push({ text: 'review this', localId: 'local-composition' }, { permissionMode: 'default' });
    const runtime = createRuntime();
    const order: string[] = [];
    runtime.beginTurnLifecycle.mockImplementation(() => { order.push('begin-turn'); });
    runtime.sendTurnPrompt.mockImplementation(async () => { order.push('provider-send'); });
    const setActiveAgentCompositionToolSelection = vi.fn((selection: unknown) => {
      order.push(selection === null ? 'clear-tools' : 'set-tools');
    });
    let shouldExit = false;
    const resolveAgentCompositionBeforeDispatch = vi.fn(async () => {
      order.push('composition');
      return {
        managedPluginIds: ['example.agent-context-companion'],
        selectedTools: [{
          pluginId: 'example.agent-context-companion',
          localId: 'review-summary-tool',
        }],
        selectedToolBindings: createSelectedToolBindings(),
        prompt: 'COMPOSITION',
      };
    });
    const resolveFreshSessionSystemPrompt = vi.fn(async (args: {
      excludePluginIds?: readonly string[];
    }) => {
      order.push('fresh-static');
      expect(args.excludePluginIds).toEqual(['example.agent-context-companion']);
      return 'SYSTEM';
    });

    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler: { setPermissionMode: vi.fn(), reset: vi.fn() },
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
      createOverrideSynchronizer: () => ({
        syncFromMetadata: () => undefined,
        flushPendingAfterStart: async () => undefined,
      }),
      messageBuffer: new MessageBuffer(),
      shouldExit: () => shouldExit,
      getAbortSignal: () => new AbortController().signal,
      keepAlive: () => undefined,
      setThinking: () => undefined,
      sendReady: () => { shouldExit = true; },
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => undefined,
      setCurrentPermissionModeUpdatedAt: () => undefined,
      resolveAgentCompositionBeforeDispatch,
      resolveFreshSessionSystemPrompt,
      setActiveAgentCompositionToolSelection,
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    } as Parameters<typeof runPermissionModePromptLoop>[0]);

    expect(resolveAgentCompositionBeforeDispatch).toHaveBeenCalledTimes(1);
    expect(resolveFreshSessionSystemPrompt).toHaveBeenCalledTimes(1);
    expect(order).toEqual([
      'composition',
      'fresh-static',
      'set-tools',
      'begin-turn',
      'provider-send',
      'clear-tools',
    ]);
    expect(setActiveAgentCompositionToolSelection).toHaveBeenNthCalledWith(1, {
      managedPluginIds: ['example.agent-context-companion'],
      selectedTools: [{
        pluginId: 'example.agent-context-companion',
        localId: 'review-summary-tool',
      }],
      selectedToolBindings: createSelectedToolBindings(),
    });
    expect(setActiveAgentCompositionToolSelection).toHaveBeenLastCalledWith(null);
    expect(runtime.sendTurnPrompt).toHaveBeenCalledWith('SYSTEM\n\nCOMPOSITION\n\nreview this', {
      localId: 'local-composition',
      localIds: ['local-composition'],
    });
  });

  it('clears the active composition tool selection when turn completion aborts', async () => {
    const session = createMutableApiSessionClientFixture<Metadata>({
      overrides: { sessionId: 'session-composition-abort' } as Partial<Parameters<typeof runPermissionModePromptLoop>[0]['session']>,
    });
    session.__setMetadata(createTestMetadata({
      permissionMode: 'default',
      permissionModeUpdatedAt: 0,
    }));
    const queue = createModeQueue();
    queue.push({ text: 'review this', localId: 'local-composition-abort' }, { permissionMode: 'default' });
    const runtime = createRuntime();
    runtime.waitForTurnCompletion.mockImplementation(async () => {
      const abortError = new Error('turn cancelled');
      abortError.name = 'AbortError';
      throw abortError;
    });
    const setActiveAgentCompositionToolSelection = vi.fn();

    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler: { setPermissionMode: vi.fn(), reset: vi.fn() },
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
      createOverrideSynchronizer: () => ({
        syncFromMetadata: () => undefined,
        flushPendingAfterStart: async () => undefined,
      }),
      messageBuffer: new MessageBuffer(),
      shouldExit: () => false,
      getAbortSignal: () => new AbortController().signal,
      keepAlive: () => undefined,
      setThinking: () => undefined,
      sendReady: () => undefined,
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => undefined,
      setCurrentPermissionModeUpdatedAt: () => undefined,
      resolveAgentCompositionBeforeDispatch: async () => ({
        managedPluginIds: ['example.agent-context-companion'],
        selectedTools: [{
          pluginId: 'example.agent-context-companion',
          localId: 'review-summary-tool',
        }],
        selectedToolBindings: createSelectedToolBindings(),
        prompt: 'COMPOSITION',
      }),
      setActiveAgentCompositionToolSelection,
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    } as Parameters<typeof runPermissionModePromptLoop>[0]).catch(() => undefined);

    expect(setActiveAgentCompositionToolSelection).toHaveBeenNthCalledWith(1, {
      managedPluginIds: ['example.agent-context-companion'],
      selectedTools: [{
        pluginId: 'example.agent-context-companion',
        localId: 'review-summary-tool',
      }],
      selectedToolBindings: createSelectedToolBindings(),
    });
    expect(setActiveAgentCompositionToolSelection).toHaveBeenLastCalledWith(null);
  });

  it('applies agent.context.before message-list replacements even when prompt is unchanged', async () => {
    const session = createMutableApiSessionClientFixture<Metadata>({
      overrides: {
        sessionId: 'session-1',
      } as Partial<Parameters<typeof runPermissionModePromptLoop>[0]['session']>,
    });
    session.__setMetadata(createTestMetadata({
      permissionMode: 'default',
      permissionModeUpdatedAt: 0,
    }));
    const queue = createModeQueue();
    queue.push({ text: 'hello', localId: 'local-1' }, { permissionMode: 'default' });
    const runtime = createRuntime();
    const messageBuffer = new MessageBuffer();
    let shouldExit = false;
    const transformAgentContextBeforeDispatch = vi.fn(async (payload: Record<string, unknown>) => ({
      ...payload,
      messages: [
        ...(payload.messages as readonly unknown[]),
        { role: 'system', content: 'fixture context' },
      ],
    }));

    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler: {
        setPermissionMode: vi.fn(),
        reset: vi.fn(),
      },
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
      createOverrideSynchronizer: () => ({
        syncFromMetadata: () => undefined,
        flushPendingAfterStart: async () => undefined,
      }),
      messageBuffer,
      shouldExit: () => shouldExit,
      getAbortSignal: () => new AbortController().signal,
      keepAlive: () => undefined,
      setThinking: () => undefined,
      sendReady: () => {
        shouldExit = true;
      },
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => undefined,
      setCurrentPermissionModeUpdatedAt: () => undefined,
      resolveFreshSessionSystemPrompt: async () => 'SYSTEM',
      transformAgentContextBeforeDispatch,
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    } as Parameters<typeof runPermissionModePromptLoop>[0]);

    expect(transformAgentContextBeforeDispatch).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'SYSTEM\n\nhello',
      messages: [{ role: 'user', content: 'SYSTEM\n\nhello' }],
    }));
    expect(runtime.sendTurnPrompt).toHaveBeenCalledWith('SYSTEM\n\nhello\n\nfixture context', {
      localId: 'local-1',
      localIds: ['local-1'],
    });
  });

  it('falls back without retaining an arbitrary agent.context.before rejection', async () => {
    const session = createMutableApiSessionClientFixture<Metadata>({
      overrides: {
        sessionId: 'session-context-fallback-log-privacy',
      } as Partial<Parameters<typeof runPermissionModePromptLoop>[0]['session']>,
    });
    session.__setMetadata(createTestMetadata({
      permissionMode: 'default',
      permissionModeUpdatedAt: 0,
    }));
    const queue = createModeQueue();
    queue.push({ text: 'private prompt', localId: 'local-context-fallback' }, {
      permissionMode: 'default',
    });
    const runtime = createRuntime();
    const hostile = Proxy.revocable({}, {});
    hostile.revoke();
    let shouldExit = false;

    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler: {
        setPermissionMode: vi.fn(),
        reset: vi.fn(),
      },
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
      createOverrideSynchronizer: () => ({
        syncFromMetadata: () => undefined,
        flushPendingAfterStart: async () => undefined,
      }),
      messageBuffer: new MessageBuffer(),
      shouldExit: () => shouldExit,
      getAbortSignal: () => new AbortController().signal,
      keepAlive: () => undefined,
      setThinking: () => undefined,
      sendReady: () => {
        shouldExit = true;
      },
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => undefined,
      setCurrentPermissionModeUpdatedAt: () => undefined,
      transformAgentContextBeforeDispatch: async () => {
        throw hostile.proxy;
      },
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    } as Parameters<typeof runPermissionModePromptLoop>[0]);

    expect(runtime.sendTurnPrompt).toHaveBeenCalledWith('private prompt', {
      localId: 'local-context-fallback',
      localIds: ['local-context-fallback'],
    });
    expect(loggerDebugMock).toHaveBeenCalledWith(
      '[plugins] agent.context.before failed; using original provider prompt',
    );
  });

  it('does not dispatch the original prompt when the daemon-owned context transform fails closed', async () => {
    const session = createMutableApiSessionClientFixture<Metadata>({
      overrides: {
        sessionId: 'session-1',
      } as Partial<Parameters<typeof runPermissionModePromptLoop>[0]['session']>,
    });
    session.__setMetadata(createTestMetadata({
      permissionMode: 'default',
      permissionModeUpdatedAt: 0,
    }));
    const queue = createModeQueue();
    queue.push({ text: 'hello', localId: 'local-1' }, { permissionMode: 'default' });
    const runtime = createRuntime();
    let shouldExit = false;

    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler: {
        setPermissionMode: vi.fn(),
        reset: vi.fn(),
      },
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
      createOverrideSynchronizer: () => ({
        syncFromMetadata: () => undefined,
        flushPendingAfterStart: async () => undefined,
      }),
      messageBuffer: new MessageBuffer(),
      shouldExit: () => shouldExit,
      getAbortSignal: () => new AbortController().signal,
      keepAlive: () => undefined,
      setThinking: () => undefined,
      sendReady: () => {
        shouldExit = true;
      },
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => undefined,
      setCurrentPermissionModeUpdatedAt: () => undefined,
      transformAgentContextBeforeDispatch: async () => {
        const error = new Error('retired');
        Object.assign(error, { code: 'plugin_generation_stale' });
        throw error;
      },
      transformAgentContextErrorPolicy: 'throw',
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    } as Parameters<typeof runPermissionModePromptLoop>[0]);

    expect(runtime.sendTurnPrompt).not.toHaveBeenCalled();
  });
});
