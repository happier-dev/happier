import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

import {
  createAgentSessionRuntimeHarness,
  type AgentSessionRuntimeHarness,
} from '@happier-dev/plugin-sdk/testing';
import type { AgentSessionModelsSource } from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentSessionRuntimeEventSchema, type AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ManagedServiceSnapshot } from '@happier-dev/plugin-sdk/managed-services';

import type { OpenCodeRuntimeTurnOperations } from './operations.js';
import type { OpenCodeRuntimeEvent } from './runtimeEvents.js';
import { createOpenCodeSessionRuntime } from './sessionRuntime.js';
import { createOpenCodeServerRuntime } from './runtime.js';
import type { OpenCodeServerClient } from './openCodeServerClient.js';
import { OpenCodeSseHttpError } from './openCodeSse.js';
import { OpenCodeServerUnsupportedOperationError } from './openCodeServerClient.js';
import type { OpenCodeRuntimeContext } from './runtimeContext.js';

const readyMcpRegistration = Promise.resolve({
  requiredHappier: { status: 'ready' as const },
  registeredServers: [] as const,
});
const emptyMcpProjection = {
  registrations: [] as const,
  requiredHappierServerName: null,
  requiredHappierConfigurationPresent: false,
} as const;

function managedServiceSnapshot(
  overrides: Partial<ManagedServiceSnapshot> = {},
): ManagedServiceSnapshot {
  return {
    id: 'opencode-server',
    state: 'healthy',
    mode: 'spawn',
    baseUrl: 'http://127.0.0.1:49196',
    startedAtMs: 1000,
    lastHealthyAtMs: 1200,
    diagnostics: [],
    diagnosticsTruncated: false,
    ...overrides,
  };
}

type RuntimeWithProviderEvents = OpenCodeRuntimeTurnOperations & Readonly<{
  handleProviderEvent(event: unknown): Promise<void>;
}>;

type TestOpenCodeClient = OpenCodeServerClient & Readonly<{
  sessionPromptImplementation: Mock<OpenCodeServerClient['sessionPromptAsync']>;
  sessionChildInventory: Mock<OpenCodeServerClient['sessionChildInventory']>;
  suppressNextNativePromptPersistence(): void;
  emitProviderEvent(event: unknown, delivery?: Readonly<{ provenance: string; connectionGeneration: number }>): void;
  setMessages(messages: readonly unknown[]): void;
  globalConfigGet(): Promise<Readonly<Record<string, unknown>>>;
  permissionReply(input: Readonly<{
    requestId: string;
    reply: 'once' | 'always' | 'reject';
    message?: string | null;
  }>): Promise<void>;
  subscribeGlobalEvents(input: Readonly<{
    signal: AbortSignal;
    onEvent: (event: unknown) => void;
  }>): Promise<void>;
}>;

const activeHarnesses: AgentSessionRuntimeHarness[] = [];
const runtimeEventsByHarness = new WeakMap<AgentSessionRuntimeHarness, OpenCodeRuntimeEvent[]>();

afterEach(() => {
  for (const harness of activeHarnesses) {
    harness.dispose();
  }
  activeHarnesses.length = 0;
  vi.useRealTimers();
});

function createContextFixture(options?: Readonly<{
  onPermissionDecision?: (
    request: unknown,
  ) => Promise<Readonly<{ decision: string; rationale?: string }>>;
  onSessionStateFieldWrite?: (request: unknown) => Promise<void>;
  onSubagentObservation?: (request: unknown) => Promise<unknown>;
}>) {
  const harness = createAgentSessionRuntimeHarness();
  activeHarnesses.push(harness);
  const runtimeEvents: OpenCodeRuntimeEvent[] = [];
  runtimeEventsByHarness.set(harness, runtimeEvents);
  const metadataWrites: unknown[] = [];
  const stateFieldWrites: unknown[] = [];
  const transcriptAppends: unknown[] = [];
  const logs: Array<Readonly<{
    level: 'debug' | 'info' | 'warn' | 'error';
    message: string;
    fields?: Readonly<Record<string, unknown>>;
  }>> = [];
  const sessionStorage = new Map<string, unknown>();
  const abortController = new AbortController();
  const recordLog = (
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    fields?: Readonly<Record<string, unknown>>,
  ) => {
    logs.push({ level, message, ...(fields ? { fields } : {}) });
  };
  const ctx: OpenCodeRuntimeContext = {
    exec: {
      systemTools: {
        resolve: async () => ({ executablePath: '/usr/local/bin/opencode' }),
      },
    },
    logger: {
      debug: (message, fields) => recordLog('debug', message, fields),
      info: (message, fields) => recordLog('info', message, fields),
      warn: (message, fields) => recordLog('warn', message, fields),
      error: (message, fields) => recordLog('error', message, fields),
    },
    abort: {
      signal: abortController.signal,
      compose: (signals) => AbortSignal.any(signals),
    },
    config: { values: {} },
    env: { list: () => ({}) },
    managedServices: {
      dependencies: {} as OpenCodeRuntimeContext['managedServices']['dependencies'],
      supervise: vi.fn(async () => {
        throw new Error('managed server is outside the OpenCode runtime fixture');
      }),
    },
    ui: {
      askQuestions: vi.fn(async () => ({
        requestId: 'question-cancelled',
        kind: 'questions' as const,
        status: 'userCancelled' as const,
      })),
    },
    sessions: {
      current: {
        subagents: {
          observe: vi.fn(async (request) => (
            await options?.onSubagentObservation?.(request) ?? request
          )),
        },
        permissions: {
          requestDecision: async (request) => {
            const result = await options?.onPermissionDecision?.(request)
              ?? { decision: 'approved' as const };
            if (result.decision === 'approved') {
              return { status: 'approved' as const, persistence: 'once' as const };
            }
            return {
              status: 'denied' as const,
              ...(result.rationale ? { rationale: result.rationale } : {}),
            };
          },
        },
      },
      async writeStateField(request) {
        stateFieldWrites.push(request);
        await options?.onSessionStateFieldWrite?.(request);
      },
    },
    storage: {
      daemonSession: {
        get: async (key) => sessionStorage.get(key),
        set: async (key, value) => {
          sessionStorage.set(key, value);
        },
      },
    },
    experimental: { telemetry: { emit: vi.fn() } },
  };

  return {
    ctx,
    harness,
    runtimeEvents,
    metadataWrites,
    stateFieldWrites,
    logs,
    transcriptAppends,
  };
}

function createClientFixture(): TestOpenCodeClient {
  let messages: readonly unknown[] = [];
  let providerEventHandler: ((
    event: unknown,
    delivery?: Readonly<{ provenance: string; connectionGeneration: number }>,
  ) => void) | null = null;
  let nativePromptSequence = 0;
  let suppressNextNativePromptPersistence = false;
  const sessionPromptImplementation = vi.fn<OpenCodeServerClient['sessionPromptAsync']>(
    async () => undefined,
  );
  return {
    sessionPromptImplementation,
    sessionCommand: vi.fn<OpenCodeServerClient['sessionCommand']>(async () => undefined),
    appCommands: vi.fn<OpenCodeServerClient['appCommands']>(async () => []),
    suppressNextNativePromptPersistence() {
      suppressNextNativePromptPersistence = true;
    },
    emitProviderEvent(event, delivery = { provenance: 'accepted-live', connectionGeneration: 1 }) {
      providerEventHandler?.(event, delivery);
    },
    setMessages(nextMessages) {
      messages = nextMessages;
    },
    sessionCreate: vi.fn(async () => ({ id: 'ses-1' })),
    sessionUpdatePermissions: vi.fn(async () => undefined),
    sessionSetAgent: vi.fn(async () => undefined),
    sessionReadAgent: vi.fn(async () => null),
    agentsList: vi.fn(async () => []),
    sessionSetModel: vi.fn(async () => undefined),
    sessionFork: vi.fn(async () => ({ id: 'ses-forked' })),
    sessionPromptAsync: vi.fn(async (input) => {
      nativePromptSequence += 1;
      const messageId = `msg_${nativePromptSequence.toString(16).padStart(12, '0')}00000000000000`;
      const response = await sessionPromptImplementation({
        ...input,
        messageId,
      });
      if (suppressNextNativePromptPersistence) {
        suppressNextNativePromptPersistence = false;
        return response;
      }
      const alreadyPersisted = messages.some((message) => {
        if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
        const info = 'info' in message ? message.info : null;
        return Boolean(
          info
          && typeof info === 'object'
          && !Array.isArray(info)
          && 'id' in info
          && info.id === messageId,
        );
      });
      if (!alreadyPersisted) {
        messages = [
          ...messages,
          {
            info: {
              id: messageId,
              role: 'user',
              sessionID: input.sessionId,
              time: { created: Date.now() },
            },
            parts: input.parts ?? [{
              id: `part-native-user-${nativePromptSequence}`,
              type: 'text',
              text: input.text,
            }],
          },
        ];
      }
      return response;
    }),
    sessionAbort: vi.fn(async () => undefined),
    sessionSummarize: vi.fn(async () => undefined),
    sessionStatus: vi.fn(async () => ({ type: 'idle' })),
    sessionChildInventory: vi.fn(async () => null),
    sessionMessages: vi.fn(async () => messages),
    sessionTodo: vi.fn(async () => [
      { id: 'todo-1', content: 'Ship OpenCode runtime', status: 'in_progress', priority: 'high' },
    ]),
    permissionList: vi.fn(async () => []),
    questionList: vi.fn(async () => []),
    permissionReply: vi.fn(async () => undefined),
    questionReply: vi.fn(async () => undefined),
    questionReject: vi.fn(async () => undefined),
    appSkills: vi.fn(async () => []),
    globalConfigGet: vi.fn(async () => ({})),
    subscribeGlobalEvents: vi.fn(async ({ onEvent }) => {
      providerEventHandler = onEvent;
    }),
    providersList: vi.fn(async () => []),
  } satisfies TestOpenCodeClient;
}

async function createStartedRuntime(params?: Readonly<{
  client?: TestOpenCodeClient;
  ctx?: OpenCodeRuntimeContext;
  env?: Readonly<Record<string, string>>;
  harness?: AgentSessionRuntimeHarness;
  readManagedServiceSnapshot?: () => ManagedServiceSnapshot | null;
  mcpRegistration?: Promise<Readonly<{
    requiredHappier: Readonly<
      | { status: 'ready' }
      | { status: 'failed'; error: unknown }
      | { status: 'unsupported'; reason: string }
    >;
    registeredServers: readonly Readonly<{ directory: string; name: string }>[];
  }>>;
}>): Promise<RuntimeWithProviderEvents> {
  const runtimeParams = {
    ctx: params?.ctx ?? createContextFixture().ctx,
    directory: '/repo',
    happierSessionId: 'happy-session-1',
    baseUrl: 'http://127.0.0.1:49196',
    client: params?.client ?? createClientFixture(),
    env: params?.env,
    readManagedServiceSnapshot: params?.readManagedServiceSnapshot,
    mcpRegistration: params?.mcpRegistration ?? readyMcpRegistration,
    mcpProjection: emptyMcpProjection,
  };
  const runtime = createOpenCodeServerRuntime(runtimeParams) as RuntimeWithProviderEvents;
  const runtimeEvents = params?.harness
    ? runtimeEventsByHarness.get(params.harness)
    : undefined;
  if (runtimeEvents) {
    runtime.subscribeRuntimeEvents((event) => {
      runtimeEvents.push(event);
    });
  }
  await runtime.openSession({ kind: 'create' });
  return runtime;
}

function createNativeSessionRuntimeForTest(operations: OpenCodeRuntimeTurnOperations) {
  return createOpenCodeSessionRuntime({
    operations,
    request: {
      kind: 'create',
      sessionId: 'happy-session-1',
      cwd: '/repo',
    },
    disposeOperations: async () => {
      await operations.resetOrDisposeRuntime();
    },
  });
}

let testHostTurnSequence = 0;

function beginTestHostTurn(runtime: OpenCodeRuntimeTurnOperations): void {
  testHostTurnSequence += 1;
  runtime.beginTurnLifecycle(`test-host-turn-${testHostTurnSequence}`);
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function observePromisePending(promise: Promise<unknown>): Readonly<{ isPending(): boolean }> {
  let pending = true;
  void promise.then(
    () => {
      pending = false;
    },
    () => {
      pending = false;
    },
  );
  return {
    isPending: () => pending,
  };
}

describe('OpenCode catalog observation', () => {
  it.each([
    { providerId: 'example', modelId: 'image', model: { id: 'image', status: 'active', capabilities: { input: ['image'] } } },
    { providerId: 'anthropic', modelId: 'claude-2.0', model: { id: 'claude-2.0', status: 'active', capabilities: { input: ['text'] } } },
  ])('uses the same catalog eligibility when selecting $modelId at runtime', async ({ providerId, modelId, model }) => {
    const client = createClientFixture();
    client.providersList = async () => [{ id: providerId, models: { [modelId]: model } }];
    const operations = await createStartedRuntime({ client });
    try {
      await expect(operations.updateSessionRuntimeConfig({ modelId: `${providerId}/${modelId}` })).rejects.toThrow(/not selectable/i);
    } finally { await operations.resetOrDisposeRuntime(); }
  });

  it('publishes observed inventory separately from the effective model accepted for a prompt', async () => {
    const client = createClientFixture();
    client.providersList = async () => [{ id: 'example', models: { text: { id: 'text', name: 'Text', capabilities: { input: ['text'], tools: false } } } }];
    const operations = await createStartedRuntime({ client });
    await operations.updateSessionRuntimeConfig({ modelId: 'example/text' });
    let source: AgentSessionModelsSource | null = null;
    const runtime = createOpenCodeSessionRuntime({
      operations,
      request: { kind: 'create', sessionId: 'model-facts', cwd: '/repo' },
      models: { bind(value) { source = value; return { dispose() {} }; } },
      disposeOperations: async () => { await operations.resetOrDisposeRuntime(); },
    });
    try {
      expect(source?.read()).toMatchObject({ models: [{ id: 'example/text', name: 'Text' }], currentModelId: null });
      expect(source?.read().observedAt).toBeGreaterThan(0);
      await runtime.send({ inputIds: ['facts'], input: { text: 'hello' }, delivery: { kind: 'newTurn', turnId: 'facts-turn' } });
      expect(source?.read()).toMatchObject({ currentModelId: 'example/text', models: [{ id: 'example/text', name: 'Text' }] });
    } finally { await runtime.dispose(); }
  });
});

describe('createOpenCodeServerRuntime', () => {
  it('publishes commands activated by a real V2 prompt after the cold inventory was empty', async () => {
    const client = createClientFixture();
    const operations = await createStartedRuntime({ client });
    const runtime = createNativeSessionRuntimeForTest(operations);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(AgentSessionRuntimeEventSchema.parse(event)));
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'available-commands', commands: [] })]));
    client.sessionPromptImplementation.mockImplementationOnce(async () => {
      vi.mocked(client.appCommands).mockResolvedValue([{ name: 'review' }]);
    });
    try {
      await expect(runtime.send({ inputIds: ['warm'], input: { text: 'hello' },
        delivery: { kind: 'newTurn', turnId: 'warm-turn' } })).resolves.toMatchObject({ status: 'admitted' });
      await vi.waitFor(() => expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'available-commands', commands: [{ name: 'review' }] })])));
      await operations.cancelTurn();
    } finally { await runtime.dispose(); }
  });

  it('dispatches advertised native commands and completes callbacks without inventing a provider prompt identity', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.appCommands).mockResolvedValue([{ name: 'review', description: 'Review changes' }]);
    const runtime = await createStartedRuntime({ ctx, harness, client });
    const sessionRuntime = createNativeSessionRuntimeForTest(runtime);
    const publicEvents: AgentSessionRuntimeEvent[] = [];
    sessionRuntime.watch((event) => publicEvents.push(AgentSessionRuntimeEventSchema.parse(event)));
    expect(publicEvents).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'available-commands', commands: [{ name: 'review', description: 'Review changes' }] })]));
    beginTestHostTurn(runtime);
    await expect(runtime.sendTurnPrompt('/review  src/a.ts\nkeep spacing  ')).resolves.toEqual({ providerUserMessageId: null });
    expect(client.sessionCommand).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'ses-1', command: 'review', arguments: ' src/a.ts\nkeep spacing  ', parts: [],
    }));
    expect(client.sessionPromptAsync).not.toHaveBeenCalled();
    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'available-commands', commands: [{ name: 'review', description: 'Review changes' }] }),
      expect.objectContaining({ kind: 'turn-complete' }),
    ]));
    await expect(runtime.waitForTurnCompletion()).resolves.toBeUndefined();
    beginTestHostTurn(runtime);
    await runtime.sendTurnPrompt('/unknown remains literal');
    expect(client.sessionPromptAsync).toHaveBeenCalledWith(expect.objectContaining({ text: '/unknown remains literal' }));
    await runtime.cancelTurn();
    await runtime.resetOrDisposeRuntime();
  });

  it('streams parent inference witnessed after a native callback and keeps provider controls active', async () => {
    const { ctx, harness } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.appCommands).mockResolvedValue([{ name: 'review' }]);
    const operations = await createStartedRuntime({ ctx, harness, client });
    const runtime = createNativeSessionRuntimeForTest(operations);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(AgentSessionRuntimeEventSchema.parse(event)));
    beginTestHostTurn(operations);
    await operations.sendTurnPrompt('/review');
    expect(runtime.isTurnInFlight()).toBe(false);
    await operations.handleProviderEvent({ type: 'session.status', properties: { sessionID: 'ses-1', status: { type: 'busy' } } });
    await operations.handleProviderEvent({ type: 'session.next.text.started', properties: { sessionID: 'ses-1', assistantMessageID: 'native-answer', partID: 'native-text' } });
    await operations.handleProviderEvent({ type: 'message.part.delta', properties: { sessionID: 'ses-1', messageID: 'native-answer', partID: 'native-text', partType: 'text', field: 'text', delta: 'Review in progress' } });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'turn-start', startedBy: 'provider' }),
      expect.objectContaining({ kind: 'message-delta', messageId: 'opencode:ses-1:native-answer', text: 'Review in progress' }),
    ]));
    expect(runtime.isTurnInFlight()).toBe(true);
    await operations.handleProviderEvent({ type: 'message.updated', properties: { info: {
      id: 'v1-native-answer', sessionID: 'ses-1', role: 'assistant', time: { created: Date.now() },
    } } });
    await operations.handleProviderEvent({ type: 'message.part.updated', properties: { part: {
      id: 'v1-native-text', sessionID: 'ses-1', messageID: 'v1-native-answer', type: 'text', text: 'V1 streamed output',
    } } });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'message-delta', messageId: 'opencode:ses-1:v1-native-answer', text: 'V1 streamed output' }),
    ]));
    await operations.handleProviderEvent({ type: 'message.updated', properties: { info: {
      id: 'native-internal', sessionID: 'ses-1', role: 'assistant', summary: true,
    } } });
    await operations.handleProviderEvent({ type: 'session.next.text.started', properties: { sessionID: 'ses-1', assistantMessageID: 'native-internal' } });
    await operations.handleProviderEvent({ type: 'message.part.delta', properties: { sessionID: 'ses-1', messageID: 'native-internal', partID: 'internal-text', partType: 'text', delta: 'INTERNAL_SUMMARY' } });
    expect(events.some((event) => event.kind === 'message-delta' && event.text.includes('INTERNAL_SUMMARY'))).toBe(false);
    await operations.steerInFlightTurn('/review follow up');
    expect(client.sessionCommand).toHaveBeenLastCalledWith(expect.objectContaining({ delivery: 'steer', arguments: 'follow up' }));
    await operations.cancelTurn();
    expect(client.sessionAbort).toHaveBeenCalled();
    expect(runtime.isTurnInFlight()).toBe(false);
    await operations.resetOrDisposeRuntime();
  });

  it('retires a pending native callback on cancellation before its HTTP response arrives', async () => {
    const client = createClientFixture();
    vi.mocked(client.appCommands).mockResolvedValue([{ name: 'review' }]);
    let resolveCallback!: () => void;
    vi.mocked(client.sessionCommand).mockImplementationOnce(() => new Promise<void>((resolve) => { resolveCallback = resolve; }));
    const operations = await createStartedRuntime({ client });
    beginTestHostTurn(operations);
    let result: 'pending' | 'resolved' | 'rejected' = 'pending';
    const submitted = operations.sendTurnPrompt('/review').then(() => { result = 'resolved'; }, () => { result = 'rejected'; });
    await vi.waitFor(() => expect(client.sessionCommand).toHaveBeenCalled());
    await operations.cancelTurn();
    try {
      await vi.waitFor(() => expect(result).toBe('rejected'));
    } finally {
      resolveCallback();
      await submitted;
      await operations.resetOrDisposeRuntime();
    }
  });

  it.each(['newTurn', 'steer'] as const)('rejects a native attachment contract failure before provider input custody (%s)', async (delivery) => {
    const client = createClientFixture();
    vi.mocked(client.appCommands).mockResolvedValue([{ name: 'review' }]);
    vi.mocked(client.sessionCommand).mockRejectedValueOnce(new OpenCodeServerUnsupportedOperationError({
      operation: 'session_command_attachments', dialect: 'v1', message: 'Native commands accept only file attachments',
    }));
    const operations = await createStartedRuntime({ client });
    const runtime = createNativeSessionRuntimeForTest(operations);
    const events: AgentSessionRuntimeEvent[] = [];
    runtime.watch((event) => events.push(AgentSessionRuntimeEventSchema.parse(event)));
    try {
      if (delivery === 'steer') await operations.handleProviderEvent({ type: 'session.status', properties: { sessionID: 'ses-1', status: { type: 'busy' } } });
      await expect(runtime.send({ inputIds: ['native-invalid'], input: { text: '/review' },
        delivery: { kind: delivery, turnId: 'native-invalid-turn' } })).resolves.toMatchObject({ status: 'rejected' });
      expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'input-rejected' })]));
      expect(events.some((event) => event.kind === 'input-custody-unknown')).toBe(false);
      expect(runtime.isTurnInFlight()).toBe(delivery === 'steer');
    } finally { await runtime.dispose(); }
  });

  it('exposes the final runtime event subscription operation name', async () => {
    const runtime = await createStartedRuntime();

    expect(typeof runtime.subscribeRuntimeEvents).toBe('function');
    expect('subscribeRuntimeMessages' in runtime).toBe(false);
  });

  it('refuses prompt submission before provider work when the host has not begun a turn lifecycle', async () => {
    const client = createClientFixture();
    const runtime = createOpenCodeServerRuntime({
      ctx: createContextFixture().ctx,
      directory: '/repo',
      happierSessionId: 'happy-session-without-turn',
      baseUrl: 'http://127.0.0.1:49196',
      client,
      mcpRegistration: readyMcpRegistration,
      mcpProjection: emptyMcpProjection,
    });

    await expect(runtime.sendTurnPrompt('must not reach OpenCode')).rejects.toThrow(
      'OpenCode prompt submission requires an active host turn lifecycle',
    );

    expect(client.sessionCreate).not.toHaveBeenCalled();
    expect(client.sessionPromptAsync).not.toHaveBeenCalled();
  });

  it('opens a provider-native fork as a distinct child session at the exact checkpoint', async () => {
    const client = createClientFixture();
    const runtime = createOpenCodeServerRuntime({
      ctx: createContextFixture().ctx,
      directory: '/repo',
      happierSessionId: 'happy-child',
      baseUrl: 'http://127.0.0.1:49196',
      client,
      mcpRegistration: readyMcpRegistration,
      mcpProjection: emptyMcpProjection,
    });

    await expect(runtime.openSession({
      kind: 'fork',
      source: {
        providerSessionId: 'ses-parent',
        providerCheckpoint: {
          kind: 'opencode_exclusive_message_id',
          messageId: 'msg-checkpoint',
        },
      },
    })).resolves.toBe('ses-forked');

    expect(client.sessionFork).toHaveBeenCalledWith({
      sessionId: 'ses-parent',
      messageId: 'msg-checkpoint',
    });
    expect(runtime.readSessionIdentity()).toEqual({ sessionId: 'ses-forked' });
    expect(client.sessionCreate).not.toHaveBeenCalled();
  });

  it('resumes the exact provider session without creating or forking another identity', async () => {
    const client = createClientFixture();
    const runtime = createOpenCodeServerRuntime({
      ctx: createContextFixture().ctx,
      directory: '/repo',
      happierSessionId: 'happy-resume',
      baseUrl: 'http://127.0.0.1:49196',
      client,
      permissionMode: 'plan',
      mcpRegistration: readyMcpRegistration,
      mcpProjection: emptyMcpProjection,
    });

    await expect(runtime.openSession({
      kind: 'resume',
      providerSessionId: 'ses-existing',
    })).resolves.toBe('ses-existing');

    expect(runtime.readSessionIdentity()).toEqual({ sessionId: 'ses-existing' });
    expect(client.sessionCreate).not.toHaveBeenCalled();
    expect(client.sessionFork).not.toHaveBeenCalled();
    expect(client.sessionUpdatePermissions).toHaveBeenCalledWith({
      sessionId: 'ses-existing',
      permissions: expect.any(Array),
    });
  });

  it('observes only provider-native child sessions of the current OpenCode session', async () => {
    const observations: unknown[] = [];
    const { ctx } = createContextFixture({
      onSubagentObservation: async (observation) => {
        observations.push(observation);
        return observation;
      },
    });
    const runtime = await createStartedRuntime({ ctx });

    await runtime.handleProviderEvent({
      payload: {
        type: 'session.created',
        properties: {
          sessionID: 'child / Session-01',
          info: {
            id: 'child / Session-01',
            parentID: 'ses-1',
            title: 'Inspect the runtime',
            agent: 'explore',
          },
        },
      },
    });
    await runtime.handleProviderEvent({
      payload: {
        type: 'session.created',
        properties: {
          sessionID: 'top-level-session',
          info: { id: 'top-level-session', title: 'Top level' },
        },
      },
    });
    await runtime.handleProviderEvent({
      payload: {
        type: 'session.created',
        properties: {
          sessionID: 'other-child',
          info: { id: 'other-child', parentID: 'some-other-parent', title: 'Unrelated' },
        },
      },
    });

    expect(observations).toEqual([{
      observationId: 'child / Session-01',
      status: 'running',
      detail: {
        origin: 'agent',
        kind: 'native',
        agentRef: { agentId: 'opencode', agentKind: 'explore' },
        vendorRef: {
          agentSessionId: 'child / Session-01',
          vendorSource: 'opencode',
        },
        label: 'Inspect the runtime',
        agentMetadata: { parentProviderSessionId: 'ses-1' },
      },
    }]);
  });

  it('reconciles current OpenCode V2 child sessions when the provider connection is established', async () => {
    const observations: unknown[] = [];
    const { ctx } = createContextFixture({
      onSubagentObservation: async (observation) => {
        observations.push(observation);
        return observation;
      },
    });
    const client = createClientFixture();
    client.sessionChildInventory.mockResolvedValue([
      {
        info: { id: 'child-running', parentID: 'ses-1', title: 'Running child' },
        status: 'running',
      },
      {
        info: { id: 'child-completed', parentID: 'ses-1', title: 'Completed child' },
        status: 'completed',
      },
      {
        info: { id: 'top-level', title: 'Top level' },
        status: 'completed',
      },
      {
        info: { id: 'unrelated-child', parentID: 'other-parent', title: 'Unrelated' },
        status: 'running',
      },
    ]);
    const runtime = await createStartedRuntime({ ctx, client });

    await runtime.handleProviderEvent({ payload: { type: 'server.connected', properties: {} } });

    expect(client.sessionChildInventory).toHaveBeenCalledWith({ parentSessionId: 'ses-1' });
    expect(observations).toEqual([
      expect.objectContaining({ observationId: 'child-running', status: 'running' }),
      expect.objectContaining({ observationId: 'child-completed', status: 'completed' }),
    ]);
  });

  it('reconciles a provider-native child from task metadata without parsing task prose', async () => {
    const observations: unknown[] = [];
    const { ctx } = createContextFixture({
      onSubagentObservation: async (observation) => {
        observations.push(observation);
        return observation;
      },
    });
    const client = createClientFixture();
    client.sessionChildInventory.mockResolvedValue([
      {
        info: { id: 'child-exact', parentID: 'ses-1', title: 'Exact child' },
        status: 'completed',
      },
      {
        info: { id: 'child-sibling', parentID: 'ses-1', title: 'Sibling' },
        status: 'running',
      },
    ]);
    const runtime = await createStartedRuntime({ ctx, client });

    await runtime.handleProviderEvent({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            sessionID: 'ses-1',
            messageID: 'msg-parent',
            callID: 'call-task',
            tool: 'task',
            state: {
              status: 'completed',
              output: 'arbitrary prose that carries no lifecycle authority',
              metadata: { sessionId: 'child-exact' },
            },
          },
        },
      },
    });

    expect(observations).toEqual([
      expect.objectContaining({ observationId: 'child-exact', status: 'completed' }),
    ]);
  });

  it('keeps an asynchronously launched background child running when its parent tool call completes', async () => {
    const observations: unknown[] = [];
    const { ctx } = createContextFixture({
      onSubagentObservation: async (observation) => {
        observations.push(observation);
        return observation;
      },
    });
    const client = createClientFixture();
    client.sessionChildInventory.mockResolvedValue([{
      info: { id: 'background-child', parentID: 'ses-1', title: 'Background child' },
      status: 'completed',
    }]);
    const runtime = await createStartedRuntime({ ctx, client });

    await runtime.handleProviderEvent({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            sessionID: 'ses-1',
            messageID: 'msg-parent',
            callID: 'call-background-task',
            tool: 'task',
            state: {
              status: 'completed',
              output: 'launch acknowledged',
              metadata: { sessionId: 'background-child', background: true },
            },
          },
        },
      },
    });

    expect(observations).toEqual([
      expect.objectContaining({ observationId: 'background-child', status: 'running' }),
    ]);
  });

  it('publishes native todo updates through the registered runtime work-state field', async () => {
    const { ctx, metadataWrites, stateFieldWrites } = createContextFixture();
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ ctx, client });

    expect(typeof runtime.handleProviderEvent).toBe('function');
    await runtime.handleProviderEvent({
      payload: {
        type: 'todo.updated',
        properties: { sessionID: 'ses-1' },
      },
    });

    expect(client.sessionTodo).toHaveBeenCalledWith({ sessionId: 'ses-1' });
    expect(metadataWrites).toHaveLength(0);
    const workStateWrites = stateFieldWrites.filter((write) => (
      write as Readonly<{ fieldId?: unknown }>
    ).fieldId === 'runtime.workState');
    expect(workStateWrites).toHaveLength(1);
    expect(workStateWrites[0]).toMatchObject({
      fieldId: 'runtime.workState',
      value: {
        v: 1,
        backendId: 'opencode',
        agentId: 'opencode',
        primaryItemId: 'todo:opencode:todo-1',
        items: [
          expect.objectContaining({
            id: 'todo:opencode:todo-1',
            status: 'active',
            title: 'Ship OpenCode runtime',
          }),
        ],
      },
    });
    expect((workStateWrites[0] as { value?: unknown }).value).toMatchObject({
      backendId: 'opencode',
      agentId: 'opencode',
      primaryItemId: 'todo:opencode:todo-1',
      items: [
        expect.objectContaining({
          id: 'todo:opencode:todo-1',
          status: 'active',
          title: 'Ship OpenCode runtime',
        }),
      ],
    });
  });

  it('publishes provider session identity through the registered session-state field when starting a session', async () => {
    const { ctx, metadataWrites, stateFieldWrites } = createContextFixture();
    const client = createClientFixture();

    await createStartedRuntime({ ctx, client });

    expect(metadataWrites).toHaveLength(0);
    expect(stateFieldWrites).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fieldId: 'identity.providerSessionId',
        value: {
          metadataKey: 'opencodeSessionId',
          value: 'ses-1',
        },
      }),
    ]));
  });

  it('passes runtime model and singular configOption updates as OpenCode prompt fields', async () => {
    const { ctx, harness, runtimeEvents, transcriptAppends } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.providersList).mockResolvedValue([{
      id: 'opencode',
      models: {
        'big-pickle': {
          id: 'big-pickle',
          status: 'active',
          capabilities: { input: { text: true } },
        },
      },
    }]);
    const runtime = await createStartedRuntime({ ctx, client, harness });

    await runtime.updateSessionRuntimeConfig({
      modelId: 'opencode/big-pickle',
    });
    await runtime.updateSessionRuntimeConfig({
      configOption: { id: 'reasoning_effort', value: ' high ' },
    });
    await runtime.updateSessionRuntimeConfig({
      configOption: { id: 'temperature', value: 0.2 },
    });
    beginTestHostTurn(runtime);
    await runtime.sendTurnPrompt('Use deeper reasoning.');

    expect(client.sessionPromptAsync).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'ses-1',
      text: 'Use deeper reasoning.',
      model: {
        providerID: 'opencode',
        modelID: 'big-pickle',
      },
      variant: 'high',
      config: {
        temperature: 0.2,
      },
    }));
    expect(transcriptAppends).toHaveLength(0);
    expect(runtimeEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'transcript-user-text',
      }),
    ]));
  });

  it('recovers the server-owned prompt identity and ignores stale prompt-response assistants until the exact parent completes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    const priorUser = {
      info: {
        id: 'msg_00000000100100000000000000',
        role: 'user',
        sessionID: 'ses-1',
        time: { created: 900 },
      },
      parts: [{ id: 'part-prior-user', type: 'text', text: 'Earlier prompt' }],
    };
    const priorTerminalAssistant = {
      info: {
        id: 'msg_00000000100200000000000000',
        parentID: priorUser.info.id,
        role: 'assistant',
        sessionID: 'ses-1',
        time: { created: 910, completed: 920 },
        finish: 'stop',
      },
      parts: [{ id: 'part-prior-assistant', type: 'text', text: 'STALE_PRIOR_RESPONSE' }],
    };
    const nativeCurrentUser = {
      info: {
        id: 'msg_00000000200100000000000000',
        role: 'user',
        sessionID: 'ses-1',
        time: { created: 1_001 },
      },
      parts: [{ id: 'part-current-user', type: 'text', text: 'Current prompt' }],
    };
    client.setMessages([priorUser, priorTerminalAssistant]);
    client.suppressNextNativePromptPersistence();
    vi.mocked(client.sessionPromptImplementation).mockImplementationOnce(async () => {
      client.setMessages([priorUser, priorTerminalAssistant, nativeCurrentUser]);
      return priorTerminalAssistant;
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });

    beginTestHostTurn(runtime);
    await expect(runtime.sendTurnPrompt('Current prompt')).resolves.toEqual({
      providerUserMessageId: nativeCurrentUser.info.id,
    });
    await flushMicrotasks();

    const promptCall = vi.mocked(client.sessionPromptAsync).mock.calls[0]?.[0];
    expect(promptCall).toMatchObject({
      sessionId: 'ses-1',
      text: 'Current prompt',
    });
    expect(promptCall).not.toHaveProperty('messageId');
    expect(runtimeEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'transcript-agent-message-committed',
        localId: `opencode:ses-1:${priorTerminalAssistant.info.id}`,
      }),
      expect.objectContaining({ kind: 'turn-complete' }),
    ]));

    const exactParentAssistant = {
      info: {
        id: 'msg_00000000200200000000000000',
        parentID: nativeCurrentUser.info.id,
        role: 'assistant',
        sessionID: 'ses-1',
        time: { created: 1_010, completed: 1_020 },
        finish: 'stop',
      },
      parts: [{ id: 'part-current-assistant', type: 'text', text: 'EXACT_CURRENT_RESPONSE' }],
    };
    client.setMessages([
      priorUser,
      priorTerminalAssistant,
      nativeCurrentUser,
      exactParentAssistant,
    ]);
    await runtime.handleProviderEvent({
      payload: {
        type: 'session.idle',
        properties: { sessionID: 'ses-1' },
      },
    });

    expect(runtimeEvents.filter((event) => (
      event.kind === 'transcript-agent-message-committed'
      && event.localId === `opencode:ses-1:${exactParentAssistant.info.id}`
    ))).toEqual([
      expect.objectContaining({
        body: { type: 'message', message: 'EXACT_CURRENT_RESPONSE' },
      }),
    ]);
    expect(runtimeEvents.filter((event) => event.kind === 'turn-complete')).toHaveLength(1);
    expect(JSON.stringify(runtimeEvents)).not.toContain('STALE_PRIOR_RESPONSE');
  });

  it.each([
    {
      label: 'missing',
      messages: [],
      inventoryError: undefined,
    },
    {
      label: 'ambiguous',
      messages: [
        {
          info: {
            id: 'msg_00000000200100000000000000',
            role: 'user',
            sessionID: 'ses-1',
            time: { created: 1_001 },
          },
          parts: [{ id: 'part-current-user-a', type: 'text', text: 'Current prompt' }],
        },
        {
          info: {
            id: 'msg_00000000200200000000000000',
            role: 'user',
            sessionID: 'ses-1',
            time: { created: 1_002 },
          },
          parts: [{ id: 'part-current-user-b', type: 'text', text: 'Current prompt' }],
        },
      ],
      inventoryError: undefined,
    },
    {
      label: 'inventory read failure',
      messages: [],
      inventoryError: new Error('authoritative inventory unavailable'),
    },
  ])('reports unknown custody when an accepted prompt has no unique server-owned user identity: $label', async ({
    inventoryError,
    messages,
  }) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { ctx, harness } = createContextFixture();
    const client = createClientFixture();
    client.suppressNextNativePromptPersistence();
    vi.mocked(client.sessionPromptImplementation).mockImplementationOnce(async () => {
      client.setMessages(messages);
      if (inventoryError) {
        vi.mocked(client.sessionMessages).mockRejectedValueOnce(inventoryError);
      }
    });
    const operations = await createStartedRuntime({ ctx, client, harness });
    const runtime = createNativeSessionRuntimeForTest(operations);
    const nativeEvents: Array<{
      kind: string;
      inputIds?: readonly string[];
    }> = [];
    runtime.watch((event) => nativeEvents.push(event));

    await expect(runtime.send({
      inputIds: ['input-identity-unresolved'],
      input: { text: 'Current prompt' },
      delivery: { kind: 'newTurn', turnId: 'turn-identity-unresolved' },
    })).resolves.toMatchObject({
      status: 'unavailable',
      retryable: false,
      diagnostic: { code: 'opencode_input_custody_unknown' },
    });

    expect(nativeEvents.filter((event) => event.kind === 'input-custody-unknown')).toEqual([
      expect.objectContaining({
        inputIds: ['input-identity-unresolved'],
      }),
    ]);
    expect(nativeEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'input-accepted' }),
      expect.objectContaining({ kind: 'input-rejected' }),
      expect.objectContaining({ kind: 'turn-rollback-boundary' }),
    ]));
    await runtime.dispose?.();
  });

  it('accepts only after the exact OpenCode message request succeeds without waiting for turn completion', async () => {
    const { ctx, harness } = createContextFixture();
    const client = createClientFixture();
    let settlePromptRequest: (() => void) | null = null;
    vi.mocked(client.sessionPromptImplementation).mockImplementationOnce(async (input) => {
      await new Promise<void>((resolve) => {
        settlePromptRequest = resolve;
      });
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });

    beginTestHostTurn(runtime);
    const dispatch = runtime.sendTurnPrompt('Keep the provider request open.');
    const result = await Promise.race([
      dispatch.then(() => 'resolved' as const),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 25)),
    ]);

    expect(result).toBe('pending');
    expect(client.sessionPromptAsync).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'ses-1',
      text: 'Keep the provider request open.',
    }));

    settlePromptRequest?.();
    await expect(dispatch).resolves.toMatchObject({
      providerUserMessageId: expect.any(String),
    });
  });

  it('waits for the managed OpenCode server.connected startup event before dispatching the first prompt', async () => {
    const { ctx, harness } = createContextFixture();
    const client = createClientFixture();
    const runtime = await createStartedRuntime({
      ctx,
      client,
      harness,
      readManagedServiceSnapshot: () => managedServiceSnapshot(),
    });

    beginTestHostTurn(runtime);
    const dispatch = runtime.sendTurnPrompt('first prompt before startup readiness');
    const pending = observePromisePending(dispatch);
    await flushMicrotasks();

    expect(client.sessionPromptAsync).not.toHaveBeenCalled();
    expect(pending.isPending()).toBe(true);

    await runtime.handleProviderEvent({ payload: { type: 'server.connected', properties: {} } });
    await expect.poll(() => vi.mocked(client.sessionPromptAsync).mock.calls.length).toBe(1);

    await expect(dispatch).resolves.toMatchObject({
      providerUserMessageId: expect.any(String),
    });
  });

  it('waits for required Happier MCP registration before dispatching the first prompt', async () => {
    const { ctx, harness } = createContextFixture();
    const client = createClientFixture();
    let resolveRequiredHappier!: (result: Readonly<{
      requiredHappier: Readonly<{ status: 'ready' }>;
    }>) => void;
    const mcpRegistration = new Promise<Readonly<{
      requiredHappier: Readonly<{ status: 'ready' }>;
    }>>((resolve) => {
      resolveRequiredHappier = resolve;
    });
    const runtime = await createStartedRuntime({
      ctx,
      client,
      harness,
      mcpRegistration,
    });

    beginTestHostTurn(runtime);
    const dispatch = runtime.sendTurnPrompt('first prompt requiring Happier tools');
    const pending = observePromisePending(dispatch);
    await flushMicrotasks();

    expect(pending.isPending()).toBe(true);
    expect(client.sessionPromptAsync).not.toHaveBeenCalled();

    resolveRequiredHappier({ requiredHappier: { status: 'ready' } });

    await expect.poll(() => vi.mocked(client.sessionPromptAsync).mock.calls.length).toBe(1);
    await expect(dispatch).resolves.toMatchObject({
      providerUserMessageId: expect.any(String),
    });
  });

  it('does not dispatch a prompt after its turn is cancelled while Happier MCP registration is pending', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    let resolveRequiredHappier!: (result: Readonly<{
      requiredHappier: Readonly<{ status: 'ready' }>;
    }>) => void;
    const mcpRegistration = new Promise<Readonly<{
      requiredHappier: Readonly<{ status: 'ready' }>;
    }>>((resolve) => {
      resolveRequiredHappier = resolve;
    });
    const runtime = await createStartedRuntime({
      ctx,
      client,
      harness,
      mcpRegistration,
    });

    beginTestHostTurn(runtime);
    const dispatch = runtime.sendTurnPrompt('prompt cancelled before Happier MCP readiness');
    const pending = observePromisePending(dispatch);
    await flushMicrotasks();

    expect(pending.isPending()).toBe(true);
    expect(client.sessionPromptAsync).not.toHaveBeenCalled();

    await runtime.cancelTurn();
    beginTestHostTurn(runtime);
    resolveRequiredHappier({ requiredHappier: { status: 'ready' } });

    await expect(dispatch).rejects.toThrow(/cancelled before prompt submission/iu);
    expect(client.sessionPromptAsync).not.toHaveBeenCalled();
    expect(runtimeEvents.filter((event) => event.kind === 'turn-cancelled')).toHaveLength(1);
    expect(runtimeEvents.filter((event) => event.kind === 'turn-failed')).toHaveLength(0);

    await expect(runtime.sendTurnPrompt('replacement turn prompt')).resolves.toMatchObject({
      providerUserMessageId: expect.any(String),
    });
    expect(client.sessionPromptAsync).toHaveBeenCalledTimes(1);
  });

  it('fails before provider acceptance when required Happier MCP registration fails', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    const runtime = await createStartedRuntime({
      ctx,
      client,
      harness,
      mcpRegistration: Promise.resolve({
        requiredHappier: {
          status: 'failed',
          error: new Error('required bridge add failed'),
        },
        registeredServers: [],
      }),
    });

    beginTestHostTurn(runtime);

    await expect(runtime.sendTurnPrompt('first prompt without Happier tools')).rejects.toThrow(
      /required Happier MCP registration failed.*required bridge add failed/iu,
    );
    expect(client.sessionPromptAsync).not.toHaveBeenCalled();
    expect(runtimeEvents).toContainEqual(expect.objectContaining({
      kind: 'turn-failed',
      issue: expect.objectContaining({ code: 'opencode_prompt_submission_failed' }),
    }));
  });

  it('still admits a prompt when the server has no dynamic MCP registration route at all', async () => {
    const { ctx, harness } = createContextFixture();
    const client = createClientFixture();
    const runtime = await createStartedRuntime({
      ctx,
      client,
      harness,
      mcpRegistration: Promise.resolve({
        requiredHappier: {
          status: 'unsupported',
          reason: 'OpenCode V2 servers expose no dynamic MCP registration route',
        },
        registeredServers: [],
      }),
    });

    beginTestHostTurn(runtime);

    // Absent capability is not a refused registration. Blanketing every V2
    // prompt on a route the server never had would make core prompting unusable
    // for a limitation that only costs Happier's own MCP-backed tools.
    await expect(runtime.sendTurnPrompt('ordinary prompt on a server without dynamic MCP'))
      .resolves.toMatchObject({ providerUserMessageId: expect.any(String) });
    expect(client.sessionPromptAsync).toHaveBeenCalledTimes(1);
  });

  it('does not treat mutable snapshot endpoint metadata as request-currentness authority', async () => {
    const { ctx, harness } = createContextFixture();
    const client = createClientFixture();
    let snapshot = managedServiceSnapshot();
    const runtime = await createStartedRuntime({
      ctx,
      client,
      harness,
      readManagedServiceSnapshot: () => snapshot,
    });
    await runtime.handleProviderEvent({ payload: { type: 'server.connected', properties: {} } });

    snapshot = {
      ...snapshot,
      baseUrl: 'http://127.0.0.1:49197',
      startedAtMs: 2000,
      lastHealthyAtMs: 2200,
    };
    beginTestHostTurn(runtime);
    const dispatch = runtime.sendTurnPrompt('first prompt after managed-service endpoint drift');
    await expect(dispatch).resolves.toMatchObject({
      providerUserMessageId: expect.any(String),
    });
    expect(client.sessionPromptAsync).toHaveBeenCalledOnce();
  });

  it('falls back to managed-server health readiness when the provider event subscription fails before server.connected', async () => {
    const { ctx, harness } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.subscribeGlobalEvents).mockRejectedValueOnce(new Error('SSE unavailable'));
    const runtime = await createStartedRuntime({
      ctx,
      client,
      harness,
      readManagedServiceSnapshot: () => managedServiceSnapshot(),
    });

    beginTestHostTurn(runtime);
    const dispatch = runtime.sendTurnPrompt('first prompt after event stream failure');

    await expect.poll(() => vi.mocked(client.sessionPromptAsync).mock.calls.length).toBe(1);
    await expect(dispatch).resolves.toMatchObject({
      providerUserMessageId: expect.any(String),
    });
  });

  it('keeps retrying the provider event subscription after an authentication rejection', async () => {
    vi.useFakeTimers();
    const { ctx } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.subscribeGlobalEvents)
      .mockRejectedValueOnce(new OpenCodeSseHttpError(401, 'Unauthorized'))
      .mockImplementationOnce(async () => await new Promise<void>(() => undefined));

    await createStartedRuntime({ ctx, client });
    await vi.advanceTimersByTimeAsync(100);

    expect(client.subscribeGlobalEvents).toHaveBeenCalledTimes(2);
  });

  it('unblocks a prompt waiting for managed-server readiness when the turn is cancelled', async () => {
    const { ctx, harness } = createContextFixture();
    const client = createClientFixture();
    const runtime = await createStartedRuntime({
      ctx,
      client,
      harness,
      readManagedServiceSnapshot: () => managedServiceSnapshot(),
    });

    beginTestHostTurn(runtime);
    const dispatch = runtime.sendTurnPrompt('prompt cancelled before startup readiness');
    const pending = observePromisePending(dispatch);
    await flushMicrotasks();

    expect(client.sessionPromptAsync).not.toHaveBeenCalled();
    expect(pending.isPending()).toBe(true);

    await runtime.cancelTurn();

    await expect(dispatch).rejects.toThrow('OpenCode server became unavailable before prompt submission');
    expect(client.sessionPromptAsync).not.toHaveBeenCalled();
  });

  it('resolves bare runtime model ids through a unique connected OpenCode provider before prompting', async () => {
    const { ctx, harness } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.providersList).mockResolvedValue([
      {
        id: 'openai',
        models: {
          'gpt-5.4-mini': {
            id: 'gpt-5.4-mini',
            status: 'active',
            capabilities: { input: { text: true } },
          },
        },
      },
    ]);
    const runtime = await createStartedRuntime({ ctx, client, harness });

    await runtime.updateSessionRuntimeConfig({
      modelId: 'gpt-5.4-mini',
    });
    beginTestHostTurn(runtime);
    await runtime.sendTurnPrompt('Use the selected model.');

    expect(client.sessionPromptAsync).toHaveBeenCalledWith(expect.objectContaining({
      model: {
        providerID: 'openai',
        modelID: 'gpt-5.4-mini',
      },
    }));
  });

  it('rejects a qualified per-prompt model absent from an authoritative provider inventory before prompting', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.providersList).mockResolvedValue([{
      id: 'openai',
      models: {
        'gpt-5.6-luna': {
          id: 'gpt-5.6-luna',
          status: 'active',
          capabilities: { input: { text: true } },
        },
      },
    }]);
    const runtime = await createStartedRuntime({ ctx, client, harness });

    beginTestHostTurn(runtime);
    await expect(runtime.sendTurnPrompt('Use the unavailable model.', {
      modelId: 'openai-codex/gpt-5.6-luna',
    })).rejects.toThrow(/not selectable/iu);

    expect(client.sessionPromptAsync).not.toHaveBeenCalled();
    expect(runtimeEvents).toContainEqual(expect.objectContaining({
      kind: 'turn-failed',
      issue: expect.objectContaining({
        code: 'opencode_prompt_submission_failed',
        source: 'agent_session_error',
      }),
    }));
  });

  it('fails open for a qualified runtime model when provider inventory is unavailable', async () => {
    const { ctx, harness, logs } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.providersList).mockRejectedValue(new Error('provider inventory unavailable'));
    const runtime = await createStartedRuntime({ ctx, client, harness });

    await runtime.updateSessionRuntimeConfig({
      modelId: 'custom-provider/custom-model',
      configOption: { id: 'variant', value: ' low ' },
    });
    expect(logs).toContainEqual(expect.objectContaining({ level: 'warn' }));
    beginTestHostTurn(runtime);
    await runtime.sendTurnPrompt('Use the selected custom model.');

    expect(client.sessionPromptAsync).toHaveBeenCalledWith(expect.objectContaining({
      model: {
        providerID: 'custom-provider',
        modelID: 'custom-model',
      },
      variant: 'low',
    }));
  });

  it('uses per-prompt model overrides without replacing the selected runtime model', async () => {
    const { ctx, harness } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.globalConfigGet).mockResolvedValue({ model: 'openai/default-large' });
    vi.mocked(client.providersList).mockResolvedValue([
      {
        id: 'openai',
        models: {
          'gpt-5.2': {
            id: 'gpt-5.2',
            status: 'active',
            capabilities: { input: { text: true } },
          },
          'gpt-5.4-mini': {
            id: 'gpt-5.4-mini',
            status: 'active',
            capabilities: { input: { text: true } },
          },
        },
      },
    ]);
    const runtime = await createStartedRuntime({ ctx, client, harness });

    await runtime.updateSessionRuntimeConfig({
      modelId: 'openai/gpt-5.2',
    });
    beginTestHostTurn(runtime);
    await runtime.sendTurnPrompt('Use the one-shot model.', { modelId: 'gpt-5.4-mini' });
    await runtime.sendTurnPrompt('Use the selected runtime model.');

    expect(client.sessionPromptAsync).toHaveBeenNthCalledWith(1, expect.objectContaining({
      model: {
        providerID: 'openai',
        modelID: 'gpt-5.4-mini',
      },
    }));
    expect(client.sessionPromptAsync).toHaveBeenNthCalledWith(2, expect.objectContaining({
      model: {
        providerID: 'openai',
        modelID: 'gpt-5.2',
      },
    }));
  });

  it('resolves bare runtime model ids through the active default provider before unique fallback', async () => {
    const { ctx, harness } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.globalConfigGet).mockResolvedValueOnce({ model: 'active-provider/default-large' });
    vi.mocked(client.providersList).mockResolvedValue([
      {
        id: 'fallback-provider',
        models: {
          'shared-mini': {
            id: 'shared-mini',
            status: 'active',
            capabilities: { input: { text: true } },
          },
        },
      },
      {
        id: 'active-provider',
        models: {
          'default-large': {
            id: 'default-large',
            status: 'active',
            capabilities: { input: { text: true } },
          },
          'shared-mini': {
            id: 'shared-mini',
            status: 'active',
            capabilities: { input: { text: true } },
          },
        },
      },
    ]);
    const runtime = await createStartedRuntime({ ctx, client, harness });

    await runtime.updateSessionRuntimeConfig({
      modelId: 'shared-mini',
    });
    beginTestHostTurn(runtime);
    await runtime.sendTurnPrompt('Use the selected default-provider model.');

    expect(client.sessionPromptAsync).toHaveBeenCalledWith(expect.objectContaining({
      model: {
        providerID: 'active-provider',
        modelID: 'shared-mini',
      },
    }));
  });

  it('ignores legacy plural runtime configOptions updates', async () => {
    const { ctx, harness } = createContextFixture();
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ ctx, client, harness });

    await runtime.updateSessionRuntimeConfig({
      configOptions: {
        variant: ' high ',
        temperature: 0.2,
      },
    });
    beginTestHostTurn(runtime);
    await runtime.sendTurnPrompt('Use default reasoning.');

    expect(client.sessionPromptAsync).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'ses-1',
      text: 'Use default reasoning.',
    }));
  });

  it('publishes a canonical failed turn when OpenCode rejects prompt submission', async () => {
    const { ctx, harness, runtimeEvents, transcriptAppends } = createContextFixture();
    const client = createClientFixture();
    const promptError = new Error('OpenCode server request failed: 401 Unauthorized Authorization: Bearer sk-live-secret');
    vi.mocked(client.sessionPromptImplementation).mockRejectedValueOnce(promptError);
    const runtime = await createStartedRuntime({ ctx, client, harness });

    runtime.beginTurnLifecycle('test-turn');
    await expect(runtime.sendTurnPrompt('Please answer briefly.')).rejects.toBe(promptError);

    await vi.waitFor(() => {
      expect(runtimeEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'turn-failed',
          issue: expect.objectContaining({
            agentId: 'opencode',
            code: 'opencode_prompt_submission_failed',
            source: 'agent_session_error',
            sanitizedPreview: expect.stringContaining('Unauthorized'),
          }),
        }),
      ]));
    });

    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
        issue: expect.objectContaining({
          agentId: 'opencode',
          code: 'opencode_prompt_submission_failed',
          source: 'agent_session_error',
          sanitizedPreview: expect.stringContaining('Unauthorized'),
        }),
      }),
      expect.objectContaining({
        kind: 'transcript-agent-message-committed',
        agentId: 'opencode',
        body: expect.objectContaining({
          type: 'turn_failed',
        }),
      }),
    ]));
    expect(runtimeEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'transcript-user-text',
      }),
    ]));
    expect(JSON.stringify(runtimeEvents)).not.toContain('sk-live-secret');
    expect(transcriptAppends).toHaveLength(0);
  });

  it('dispatches exactly once without live SSE provenance while ambiguous replay stays observation-only', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ ctx, client, harness });
    runtime.beginTurnLifecycle('test-turn');

    await expect(runtime.sendTurnPrompt(
      'reach OpenCode through the authenticated prompt endpoint',
    )).resolves.toMatchObject({
      providerUserMessageId: expect.any(String),
    });

    client.emitProviderEvent({
      payload: {
        type: 'session.idle',
        properties: { sessionID: 'ses-1' },
      },
    }, { provenance: 'untrusted-observation', connectionGeneration: 1 });
    client.emitProviderEvent({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-replayed-tool',
            type: 'tool',
            sessionID: 'ses-1',
            messageID: 'msg-replayed-tool',
            callID: 'call-replayed-tool',
            tool: 'task',
            state: { status: 'completed', input: {}, output: 'done' },
          },
        },
      },
    }, { provenance: 'untrusted-observation', connectionGeneration: 1 });
    await flushMicrotasks();

    expect(client.sessionPromptAsync).toHaveBeenCalledTimes(1);
    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'turn-start' }),
    ]));
    expect(runtimeEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'turn-complete' }),
      expect.objectContaining({ kind: 'turn-failed' }),
      expect.objectContaining({ kind: 'tool-call' }),
      expect.objectContaining({ kind: 'tool-result' }),
    ]));
  });

  it('reconciles one exact-parent terminal assistant from authoritative inventory when SSE is observation-only', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100);
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    let status: unknown = { type: 'busy' };
    let providerUserMessageId = '';
    vi.mocked(client.sessionStatus).mockImplementation(async () => status);
    vi.mocked(client.sessionPromptImplementation).mockImplementationOnce(async (input) => {
      providerUserMessageId = input.messageId ?? '';
      const terminalAssistant = {
        info: {
          id: 'msg-exact-parent-terminal',
          parentID: providerUserMessageId,
          role: 'assistant',
          sessionID: 'ses-1',
          time: { created: 1_010, completed: 1_020 },
          finish: 'stop',
        },
        parts: [{ id: 'part-exact-parent-terminal', type: 'text', text: 'EXACT_PARENT_FINAL' }],
      };
      client.setMessages([
        {
          info: {
            id: providerUserMessageId,
            role: 'user',
            sessionID: 'ses-1',
            time: { created: 1_005 },
          },
          parts: [{ id: 'part-current-user', type: 'text', text: 'hello' }],
        },
        terminalAssistant,
        terminalAssistant,
      ]);
    });
    const operations = await createStartedRuntime({ ctx, client, harness });
    const runtime = createNativeSessionRuntimeForTest(operations);
    const nativeEvents: Array<{ kind: string; inputIds?: readonly string[] }> = [];
    runtime.watch((event) => nativeEvents.push(event));

    await runtime.send({
      inputIds: ['pending-exact-parent'],
      input: { text: 'hello' },
      delivery: { kind: 'newTurn', turnId: 'turn-exact-parent' },
    });
    expect(providerUserMessageId).not.toBe('');

    client.emitProviderEvent({
      payload: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg-exact-parent-terminal',
            parentID: providerUserMessageId,
            role: 'assistant',
            sessionID: 'ses-1',
            time: { completed: 1_020 },
            finish: 'stop',
          },
        },
      },
    }, { provenance: 'untrusted-observation', connectionGeneration: 1 });
    client.emitProviderEvent({
      payload: {
        type: 'session.idle',
        properties: { sessionID: 'ses-1' },
      },
    }, { provenance: 'untrusted-observation', connectionGeneration: 1 });
    await flushMicrotasks();

    expect(nativeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'input-accepted',
        inputIds: ['pending-exact-parent'],
      }),
    ]));
    expect(runtimeEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'transcript-agent-message-committed' }),
      expect.objectContaining({ kind: 'turn-complete' }),
    ]));

    status = { type: 'idle' };
    await operations.waitForTurnCompletion();

    expect(nativeEvents.filter((event) => event.kind === 'input-accepted')).toHaveLength(1);
    expect(runtimeEvents.filter((event) => (
      event.kind === 'transcript-agent-message-committed'
      && event.localId === 'opencode:ses-1:msg-exact-parent-terminal'
    ))).toEqual([
      expect.objectContaining({
        body: { type: 'message', message: 'EXACT_PARENT_FINAL' },
      }),
    ]);
    expect(runtimeEvents.filter((event) => event.kind === 'turn-complete')).toHaveLength(1);
    expect(runtimeEvents.some((event) => event.kind === 'turn-failed')).toBe(false);
    await runtime.dispose?.();
  });

  it.each([
    {
      label: 'a stale terminal assistant',
      assistants: (providerUserMessageId: string) => [{
        info: {
          id: 'msg-stale-terminal',
          parentID: 'msg-old-user',
          role: 'assistant',
          sessionID: 'ses-1',
          time: { created: 10, completed: 20 },
          finish: 'stop',
        },
        parts: [{ type: 'text', text: `STALE_${providerUserMessageId}` }],
      }],
    },
    {
      label: 'a wrong-parent terminal assistant',
      assistants: () => [{
        info: {
          id: 'msg-wrong-parent-terminal',
          parentID: 'msg-unrelated-user',
          role: 'assistant',
          sessionID: 'ses-1',
          time: { created: 110, completed: 120 },
          finish: 'stop',
        },
        parts: [{ type: 'text', text: 'WRONG_PARENT' }],
      }],
    },
    {
      label: 'ambiguous exact-parent terminal assistants',
      assistants: (providerUserMessageId: string) => ['a', 'b'].map((suffix) => ({
        info: {
          id: `msg-ambiguous-${suffix}`,
          parentID: providerUserMessageId,
          role: 'assistant',
          sessionID: 'ses-1',
          time: { created: 110, completed: 120 },
          finish: 'stop',
        },
        parts: [{ type: 'text', text: `AMBIGUOUS_${suffix}` }],
      })),
    },
    {
      label: 'a malformed terminal assistant without a parent',
      assistants: () => [{
        info: {
          id: 'msg-missing-parent-terminal',
          role: 'assistant',
          sessionID: 'ses-1',
          time: { created: 110, completed: 120 },
          finish: 'stop',
        },
        parts: [{ type: 'text', text: 'MISSING_PARENT' }],
      }],
    },
    {
      label: 'a whitespace-wrapped parent that is not byte-exact',
      assistants: (providerUserMessageId: string) => [{
        info: {
          id: 'msg-whitespace-parent-terminal',
          parentID: ` ${providerUserMessageId} `,
          role: 'assistant',
          sessionID: 'ses-1',
          time: { created: 110, completed: 120 },
          finish: 'stop',
        },
        parts: [{ type: 'text', text: 'WHITESPACE_PARENT' }],
      }],
    },
  ])('fails closed for $label in authoritative inventory', async ({ assistants }) => {
    vi.useFakeTimers();
    vi.setSystemTime(100);
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    let providerUserMessageId = '';
    vi.mocked(client.sessionPromptImplementation).mockImplementationOnce(async (input) => {
      providerUserMessageId = input.messageId ?? '';
      client.setMessages([
        {
          info: {
            id: providerUserMessageId,
            role: 'user',
            sessionID: 'ses-1',
            time: { created: 100 },
          },
          parts: [{ type: 'text', text: 'hello' }],
        },
        ...assistants(providerUserMessageId),
      ]);
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });

    beginTestHostTurn(runtime);
    await runtime.sendTurnPrompt('hello');
    await runtime.waitForTurnCompletion();

    expect(providerUserMessageId).not.toBe('');
    expect(runtimeEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'transcript-agent-message-committed' }),
      expect.objectContaining({ kind: 'turn-complete' }),
    ]));
  });

  it('does not settle from an exact-parent assistant message id already projected by an older turn', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100);
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    client.setMessages([
      {
        info: { id: 'msg-older-external-user', role: 'user', sessionID: 'ses-1', time: { created: 10 } },
        parts: [{ type: 'text', text: 'older external prompt' }],
      },
      {
        info: {
          id: 'msg-reused-assistant',
          parentID: 'msg-older-external-user',
          role: 'assistant',
          sessionID: 'ses-1',
          time: { created: 20, completed: 30 },
          finish: 'stop',
        },
        parts: [{ type: 'text', text: 'OLDER_ALREADY_PROJECTED' }],
      },
    ]);
    const runtime = await createStartedRuntime({ ctx, client, harness });
    await runtime.handleProviderEvent({
      payload: { type: 'session.idle', properties: { sessionID: 'ses-1' } },
    });
    expect(runtimeEvents.filter((event) => (
      event.kind === 'transcript-agent-message-committed'
      && event.localId === 'opencode:ses-1:msg-reused-assistant'
    ))).toHaveLength(1);

    vi.mocked(client.sessionPromptImplementation).mockImplementationOnce(async (input) => {
      client.setMessages([
        {
          info: { id: input.messageId, role: 'user', sessionID: 'ses-1', time: { created: 100 } },
          parts: [{ type: 'text', text: 'current prompt' }],
        },
        {
          info: {
            id: 'msg-reused-assistant',
            parentID: input.messageId,
            role: 'assistant',
            sessionID: 'ses-1',
            time: { created: 110, completed: 120 },
            finish: 'stop',
          },
          parts: [{ type: 'text', text: 'MUST_NOT_SETTLE_AS_NEW' }],
        },
      ]);
    });

    beginTestHostTurn(runtime);
    await runtime.sendTurnPrompt('current prompt');
    await runtime.waitForTurnCompletion();

    expect(runtimeEvents.filter((event) => event.kind === 'turn-complete')).toHaveLength(0);
    expect(JSON.stringify(runtimeEvents)).not.toContain('MUST_NOT_SETTLE_AS_NEW');
  });

  it('does not let terminal evidence for an earlier steer satisfy the exact current input', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100);
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    let firstProviderUserMessageId = '';
    let secondProviderUserMessageId = '';
    vi.mocked(client.sessionPromptImplementation)
      .mockImplementationOnce(async (input) => {
        firstProviderUserMessageId = input.messageId ?? '';
        return {
          info: {
            id: 'msg-first-steer-terminal',
            parentID: firstProviderUserMessageId,
            role: 'assistant',
            sessionID: 'ses-1',
            time: { created: 100, completed: 110 },
            finish: 'stop',
          },
          parts: [{ type: 'text', text: 'FIRST_STEER_TERMINAL' }],
        };
      })
      .mockImplementationOnce(async (input) => {
        secondProviderUserMessageId = input.messageId ?? '';
        client.setMessages([{
          info: {
            id: 'msg-first-steer-terminal',
            parentID: firstProviderUserMessageId,
            role: 'assistant',
            sessionID: 'ses-1',
            time: { created: 100, completed: 110 },
            finish: 'stop',
          },
          parts: [{ type: 'text', text: 'FIRST_STEER_TERMINAL' }],
        }]);
      });
    const runtime = await createStartedRuntime({ ctx, client, harness });
    runtime.beginTurnLifecycle('test-turn');
    await runtime.handleProviderEvent({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-running-between-steers',
            type: 'tool',
            sessionID: 'ses-1',
            messageID: 'msg-first-steer-terminal',
            callID: 'call-running-between-steers',
            tool: 'bash',
            state: { status: 'running', input: { command: 'pwd' } },
          },
        },
      },
    });
    await runtime.sendTurnPrompt('first input');
    await flushMicrotasks();
    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);

    await runtime.steerInFlightTurn('second input');
    await runtime.handleProviderEvent({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-running-between-steers',
            type: 'tool',
            sessionID: 'ses-1',
            messageID: 'msg-first-steer-terminal',
            callID: 'call-running-between-steers',
            tool: 'bash',
            state: { status: 'completed', input: { command: 'pwd' }, output: '/repo' },
          },
        },
      },
    });
    await runtime.waitForTurnCompletion();

    expect(firstProviderUserMessageId).not.toBe(secondProviderUserMessageId);
    expect(runtimeEvents.filter((event) => event.kind === 'turn-complete')).toHaveLength(0);
  });

  it('does not publish execution-run status envelopes on the session runtime event stream', async () => {
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ client });
    const rawEvents: unknown[] = [];
    runtime.subscribeRuntimeEvents((event) => {
      rawEvents.push(event);
    });

    runtime.beginTurnLifecycle('test-turn');
    await runtime.waitForTurnCompletion();

    expect(rawEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'status' }),
    ]));
  });

  it('keeps todo update events non-fatal when work-state publication fails', async () => {
    const client = createClientFixture();
    const publishError = new Error('session-state unavailable');
    const { ctx, logs } = createContextFixture({
      onSessionStateFieldWrite: async (request) => {
        if ((request as Readonly<{ fieldId?: unknown }>).fieldId !== 'runtime.workState') return;
        throw publishError;
      },
    });
    const runtime = await createStartedRuntime({ ctx, client });

    await expect(runtime.handleProviderEvent({
      payload: {
        type: 'todo.updated',
        properties: { sessionID: 'ses-1' },
      },
    })).resolves.toBeUndefined();

    expect(client.sessionTodo).toHaveBeenCalledWith({ sessionId: 'ses-1' });
    expect(logs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        level: 'debug',
        message: expect.stringContaining('todo'),
        fields: expect.objectContaining({ error: publishError }),
      }),
    ]));
  });

  it('bridges OpenCode permission asks through the session permission service and replies once', async () => {
    const permissionRequests: unknown[] = [];
    const { ctx } = createContextFixture({
      onPermissionDecision: async (request) => {
        permissionRequests.push(request);
        return { decision: 'denied', rationale: 'read-only mode denied bash' };
      },
    });
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ ctx, client });

    await runtime.handleProviderEvent({
      payload: {
        type: 'permission.asked',
        properties: {
          sessionID: 'ses-1',
          id: 'per_123',
          permission: 'bash',
          patterns: ['echo "WAVE90_CLI_SURFACE_OK"'],
        },
      },
    });
    await runtime.handleProviderEvent({
      payload: {
        type: 'permission.asked',
        properties: {
          sessionID: 'ses-1',
          id: 'per_123',
          permission: 'bash',
          patterns: ['echo "WAVE90_CLI_SURFACE_OK"'],
        },
      },
    });

    expect(permissionRequests).toEqual([
      expect.objectContaining({
        subject: expect.objectContaining({
          kind: 'tool',
          name: 'bash',
          input: expect.objectContaining({
            permission: 'bash',
            patterns: ['echo "WAVE90_CLI_SURFACE_OK"'],
            providerSessionId: 'ses-1',
          }),
        }),
      }),
    ]);
    expect(client.permissionReply).toHaveBeenCalledTimes(1);
    expect(client.permissionReply).toHaveBeenCalledWith({
      sessionId: 'ses-1',
      requestId: 'per_123',
      reply: 'reject',
    });
  });

  it('reattaches provider event subscription after a stream drop before later permission asks', async () => {
    const permissionRequests: unknown[] = [];
    const { ctx } = createContextFixture({
      onPermissionDecision: async (request) => {
        permissionRequests.push(request);
        return { decision: 'approved' };
      },
    });
    const client = createClientFixture();
    const subscriptionHandlers: Array<(
      event: unknown,
      delivery: Readonly<{ provenance: 'accepted-live'; connectionGeneration: number }>,
    ) => void> = [];
    let rejectFirstSubscription!: (reason?: unknown) => void;
    vi.mocked(client.subscribeGlobalEvents).mockImplementation(({ onEvent }) => {
      subscriptionHandlers.push(onEvent);
      if (subscriptionHandlers.length === 1) {
        return new Promise<void>((_resolve, reject) => {
          rejectFirstSubscription = reject;
        });
      }
      return new Promise<void>(() => undefined);
    });

    await createStartedRuntime({ ctx, client });

    expect(client.subscribeGlobalEvents).toHaveBeenCalledTimes(1);
    expect(client.subscribeGlobalEvents).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'ses-1',
    }));
    rejectFirstSubscription(new Error('stream dropped'));
    await expect.poll(() => vi.mocked(client.subscribeGlobalEvents).mock.calls.length).toBe(2);

    subscriptionHandlers[1]?.({
      payload: {
        type: 'permission.asked',
        properties: {
          sessionID: 'ses-1',
          id: 'per_after_reconnect',
          permission: 'bash',
          patterns: ['pwd'],
        },
      },
    }, { provenance: 'accepted-live', connectionGeneration: 2 });

    await expect.poll(() => vi.mocked(client.permissionReply).mock.calls.length).toBe(1);
    expect(permissionRequests).toEqual([
      expect.objectContaining({
        subject: expect.objectContaining({
          kind: 'tool',
          name: 'bash',
        }),
      }),
    ]);
    expect(client.permissionReply).toHaveBeenCalledWith({
      sessionId: 'ses-1',
      requestId: 'per_after_reconnect',
      reply: 'once',
    });
  });

  it('fails OpenCode permission asks closed when the session permission service errors', async () => {
    const permissionError = new Error('permission surface unavailable');
    const { ctx, logs } = createContextFixture({
      onPermissionDecision: async () => {
        throw permissionError;
      },
    });
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ ctx, client });

    await runtime.handleProviderEvent({
      payload: {
        type: 'permission.asked',
        properties: {
          sessionID: 'ses-1',
          id: 'per_fail_closed',
          permission: 'bash',
          patterns: ['pwd'],
        },
      },
    });

    expect(client.permissionReply).toHaveBeenCalledWith({
      sessionId: 'ses-1',
      requestId: 'per_fail_closed',
      reply: 'reject',
      message: expect.stringContaining('failed closed'),
    });
    expect(logs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        level: 'debug',
        message: expect.stringContaining('permission'),
        fields: expect.objectContaining({ error: permissionError }),
      }),
    ]));
  });

  it('rejects malformed OpenCode permission asks without presenting an approvable generic tool', async () => {
    const onPermissionDecision = vi.fn(async () => ({ decision: 'approved' as const }));
    const { ctx } = createContextFixture({ onPermissionDecision });
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ ctx, client });

    await runtime.handleProviderEvent({
      payload: {
        type: 'permission.asked',
        properties: {
          sessionID: 'ses-1',
          id: 'per_malformed',
          patterns: ['pwd'],
        },
      },
    });
    await runtime.handleProviderEvent({
      payload: {
        type: 'permission.asked',
        properties: {
          sessionID: 'ses-1',
          id: 'per_ambiguous',
          permission: 'bash',
          action: { permission: 'edit' },
          patterns: ['pwd'],
        },
      },
    });

    expect(onPermissionDecision).not.toHaveBeenCalled();
    expect(client.permissionReply).toHaveBeenCalledTimes(2);
    expect(client.permissionReply).toHaveBeenNthCalledWith(1, {
      sessionId: 'ses-1',
      requestId: 'per_malformed',
      reply: 'reject',
      message: 'OpenCode permission request was malformed or ambiguous.',
    });
    expect(client.permissionReply).toHaveBeenNthCalledWith(2, {
      sessionId: 'ses-1',
      requestId: 'per_ambiguous',
      reply: 'reject',
      message: 'OpenCode permission request was malformed or ambiguous.',
    });
  });

  it('replies to turnless OpenCode permission asks even if a Happier turn starts before the decision', async () => {
    let resolvePermissionDecision: ((value: { decision: 'approved' }) => void) | null = null;
    const pendingPermissionDecision = new Promise<{ decision: 'approved' }>((resolve) => {
      resolvePermissionDecision = resolve;
    });
    const { ctx, harness } = createContextFixture({
      onPermissionDecision: async () => await pendingPermissionDecision,
    });
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ ctx, client, harness });

    const permissionAsk = runtime.handleProviderEvent({
      payload: {
        type: 'permission.asked',
        properties: {
          sessionID: 'ses-1',
          id: 'per_turnless',
          permission: 'bash',
          patterns: ['pwd'],
        },
      },
    });
    void permissionAsk.catch(() => undefined);
    await Promise.resolve();

    beginTestHostTurn(runtime);
    await runtime.sendTurnPrompt('hello');
    resolvePermissionDecision?.({ decision: 'approved' });
    await permissionAsk;

    expect(client.permissionReply).toHaveBeenCalledWith({
      sessionId: 'ses-1',
      requestId: 'per_turnless',
      reply: 'once',
    });
  });

  it('drops a turnless OpenCode permission decision when its runtime generation retires', async () => {
    let resolvePermissionDecision: ((value: { decision: 'approved' }) => void) | null = null;
    const pendingPermissionDecision = new Promise<{ decision: 'approved' }>((resolve) => {
      resolvePermissionDecision = resolve;
    });
    const generationAbort = new AbortController();
    const { ctx, harness } = createContextFixture({
      onPermissionDecision: async () => await pendingPermissionDecision,
    });
    const generationScopedContext: OpenCodeRuntimeContext = {
      ...ctx,
      abort: {
        signal: generationAbort.signal,
        compose: (signals) => AbortSignal.any(signals),
      },
    };
    const client = createClientFixture();
    const runtime = await createStartedRuntime({
      ctx: generationScopedContext,
      client,
      harness,
    });

    const permissionAsk = runtime.handleProviderEvent({
      payload: {
        type: 'permission.asked',
        properties: {
          sessionID: 'ses-1',
          id: 'per_retired_turnless',
          permission: 'bash',
          patterns: ['pwd'],
        },
      },
    });
    void permissionAsk.catch(() => undefined);
    await Promise.resolve();

    generationAbort.abort(new Error('runtime generation retired'));
    resolvePermissionDecision?.({ decision: 'approved' });
    await permissionAsk;

    expect(client.permissionReply).not.toHaveBeenCalled();
  });

  it('keeps turns open for live provider tool work until reconnect history supplies terminal evidence', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ ctx, client, harness });
    runtime.beginTurnLifecycle('test-turn');

    await runtime.handleProviderEvent({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            sessionID: 'ses-1',
            callID: 'call-1',
            tool: 'bash',
            state: { status: 'running' },
          },
        },
      },
    });

    await runtime.waitForTurnCompletion();
    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);

    client.setMessages([
      {
        parts: [
          {
            type: 'tool',
            sessionID: 'ses-1',
            callID: 'call-1',
            tool: 'bash',
            state: { status: 'completed' },
          },
        ],
      },
    ]);
    await runtime.handleProviderEvent({ payload: { type: 'server.connected', properties: {} } });
    await runtime.waitForTurnCompletion();

    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);
  });

  it('publishes live OpenCode tool parts as canonical runtime tool events', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ ctx, client, harness });
    runtime.beginTurnLifecycle('test-turn');

    const turnStart = runtimeEvents.find((event) => event.kind === 'turn-start');
    const turnId = (turnStart as { turnId?: string } | undefined)?.turnId;
    expect(turnId).toBeTruthy();

    await runtime.handleProviderEvent({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-tool-1',
            type: 'tool',
            sessionID: 'ses-1',
            messageID: 'msg-tool-1',
            callID: 'call-tool-1',
            tool: 'bash',
            state: {
              status: 'running',
              input: { command: 'pwd' },
            },
          },
        },
      },
    });

    await runtime.handleProviderEvent({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-tool-1',
            type: 'tool',
            sessionID: 'ses-1',
            messageID: 'msg-tool-1',
            callID: 'call-tool-1',
            tool: 'bash',
            state: {
              status: 'completed',
              input: { command: 'pwd' },
              output: 'repo\n',
              title: 'repo/probe.txt',
              metadata: { preview: 'repo' },
            },
          },
        },
      },
    });

    expect(runtimeEvents).toContainEqual(expect.objectContaining({
      kind: 'tool-call',
      sessionId: 'happy-session-1',
      turnId,
      toolCallId: 'call-tool-1',
      toolName: 'bash',
      toolInput: { command: 'pwd' },
    }));
    expect(runtimeEvents).toContainEqual(expect.objectContaining({
      kind: 'tool-result',
      sessionId: 'happy-session-1',
      turnId,
      toolCallId: 'call-tool-1',
      output: {
        output: 'repo\n',
        title: 'repo/probe.txt',
        metadata: { preview: 'repo' },
      },
    }));
  });

  it('backfills current-turn OpenCode tool events from completed history before assistant commit', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.sessionPromptImplementation).mockImplementationOnce(async (input) => {
      client.setMessages([
        {
          info: {
            id: input.messageId,
            role: 'user',
            sessionID: 'ses-1',
            time: { created: Date.now() + 1 },
          },
          parts: [
            { id: 'part-history-user', type: 'text', text: 'run pwd' },
          ],
        },
        {
          info: {
            id: 'msg-history-assistant',
            role: 'assistant',
            sessionID: 'ses-1',
            parentID: input.messageId,
            time: { created: Date.now() + 2, completed: Date.now() + 3 },
          },
          parts: [
            {
              id: 'part-history-tool',
              type: 'tool',
              sessionID: 'ses-1',
              messageID: 'msg-history-assistant',
              callID: 'call-history-tool',
              tool: 'bash',
              state: {
                status: 'completed',
                input: { command: 'pwd' },
                output: 'repo\n',
              },
            },
            { id: 'part-history-text', type: 'text', text: 'The repo path is /repo.' },
          ],
        },
      ]);
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });

    beginTestHostTurn(runtime);
    await runtime.sendTurnPrompt('run pwd');
    await runtime.handleProviderEvent({
      payload: {
        type: 'session.idle',
        properties: { sessionID: 'ses-1' },
      },
    });

    const turnStart = runtimeEvents.find((event) => event.kind === 'turn-start');
    const turnId = (turnStart as { turnId?: string } | undefined)?.turnId;
    expect(turnId).toBeTruthy();

    const toolCallIndex = runtimeEvents.findIndex((event) => event.kind === 'tool-call');
    const toolResultIndex = runtimeEvents.findIndex((event) => event.kind === 'tool-result');
    const assistantCommitIndex = runtimeEvents.findIndex((event) => event.kind === 'transcript-agent-message-committed');
    const turnCompleteIndex = runtimeEvents.findIndex((event) => event.kind === 'turn-complete');

    expect(toolCallIndex).toBeGreaterThan(-1);
    expect(toolResultIndex).toBeGreaterThan(toolCallIndex);
    expect(assistantCommitIndex).toBeGreaterThan(toolResultIndex);
    expect(turnCompleteIndex).toBeGreaterThan(assistantCommitIndex);
    expect(runtimeEvents[toolCallIndex]).toEqual(expect.objectContaining({
      kind: 'tool-call',
      sessionId: 'happy-session-1',
      turnId,
      toolCallId: 'call-history-tool',
      toolName: 'bash',
      toolInput: { command: 'pwd' },
    }));
    expect(runtimeEvents[toolResultIndex]).toEqual(expect.objectContaining({
      kind: 'tool-result',
      sessionId: 'happy-session-1',
      turnId,
      toolCallId: 'call-history-tool',
      output: 'repo\n',
    }));
    expect(runtimeEvents[assistantCommitIndex]).toEqual(expect.objectContaining({
      kind: 'transcript-agent-message-committed',
      localId: 'opencode:ses-1:msg-history-assistant',
      body: {
        type: 'message',
        message: 'The repo path is /repo.',
      },
    }));
  });

  it('does not duplicate OpenCode tool events when history repeats live-published parts', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ ctx, client, harness });
    runtime.beginTurnLifecycle('test-turn');

    await runtime.handleProviderEvent({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-tool-live',
            type: 'tool',
            sessionID: 'ses-1',
            messageID: 'msg-live-tool-assistant',
            callID: 'call-live-tool',
            tool: 'bash',
            state: {
              status: 'running',
              input: { command: 'pwd' },
            },
          },
        },
      },
    });
    await runtime.handleProviderEvent({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-tool-live',
            type: 'tool',
            sessionID: 'ses-1',
            messageID: 'msg-live-tool-assistant',
            callID: 'call-live-tool',
            tool: 'bash',
            state: {
              status: 'completed',
              input: { command: 'pwd' },
              output: 'repo\n',
            },
          },
        },
      },
    });

    client.setMessages([
      {
        info: {
          id: 'msg-live-tool-assistant',
          role: 'assistant',
          sessionID: 'ses-1',
          time: { completed: Date.now() },
        },
        parts: [
          {
            id: 'part-tool-live',
            type: 'tool',
            sessionID: 'ses-1',
            messageID: 'msg-live-tool-assistant',
            callID: 'call-live-tool',
            tool: 'bash',
            state: {
              status: 'completed',
              input: { command: 'pwd' },
              output: 'repo\n',
            },
          },
          { id: 'part-live-text', type: 'text', text: 'The repo path is /repo.' },
        ],
      },
    ]);
    await runtime.handleProviderEvent({
      payload: {
        type: 'session.idle',
        properties: { sessionID: 'ses-1' },
      },
    });

    expect(runtimeEvents.filter((event) => event.kind === 'tool-call')).toHaveLength(1);
    expect(runtimeEvents.filter((event) => event.kind === 'tool-result')).toHaveLength(1);
    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);
  });

  it('keeps polling turns open while refreshed OpenCode history still has running provider work', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    client.setMessages([
      {
        info: { id: 'msg-running-tool', role: 'assistant', sessionID: 'ses-1' },
        parts: [
          {
            id: 'part-running-tool',
            type: 'tool',
            sessionID: 'ses-1',
            messageID: 'msg-running-tool',
            callID: 'call-running-tool',
            tool: 'bash',
            state: { status: 'running' },
          },
        ],
      },
    ]);
    const runtime = await createStartedRuntime({ ctx, client, harness });
    runtime.beginTurnLifecycle('test-turn');

    await runtime.handleProviderEvent({
      payload: {
        type: 'message.updated',
        properties: {
          info: { id: 'msg-running-tool', role: 'assistant', sessionID: 'ses-1' },
        },
      },
    });
    await runtime.waitForTurnCompletion();

    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);
  });

  it('commits observed assistant transcript text from OpenCode history before completing the turn', async () => {
    const { ctx, harness, runtimeEvents, transcriptAppends } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.sessionPromptImplementation).mockImplementationOnce(async (input) => {
      client.setMessages([
        {
          info: {
            id: 'msg-assistant-1',
            parentID: input.messageId,
            role: 'assistant',
            sessionID: 'ses-1',
            time: { created: 100, completed: 200 },
            finish: 'stop',
          },
          parts: [
            { id: 'part-text-1', type: 'text', text: 'OPENCODE_LIVE_OK' },
          ],
        },
      ]);
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });
    beginTestHostTurn(runtime);
    await runtime.sendTurnPrompt('hello');

    await runtime.handleProviderEvent({
      payload: {
        type: 'message.updated',
        properties: {
          info: { id: 'msg-assistant-1', role: 'assistant', sessionID: 'ses-1' },
        },
      },
    });
    await runtime.handleProviderEvent({
      payload: {
        type: 'session.idle',
        properties: { sessionID: 'ses-1' },
      },
    });

    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'transcript-agent-message-committed',
        agentId: 'opencode',
        localId: 'opencode:ses-1:msg-assistant-1',
        body: {
          type: 'message',
          message: 'OPENCODE_LIVE_OK',
        },
      }),
      expect.objectContaining({ kind: 'turn-complete' }),
    ]));
    expect(transcriptAppends).toHaveLength(0);

    await runtime.handleProviderEvent({
      payload: {
        type: 'session.idle',
        properties: { sessionID: 'ses-1' },
      },
    });

    const committedAssistantEvents = runtimeEvents.filter((event) => (
      event.kind === 'transcript-agent-message-committed'
      && event.agentId === 'opencode'
      && event.body
      && typeof event.body === 'object'
      && !Array.isArray(event.body)
      && (event.body as Readonly<{ message?: unknown }>).message === 'OPENCODE_LIVE_OK'
    ));
    expect(committedAssistantEvents).toHaveLength(1);
  });

  it('commits assistant transcript text that follows the current provider user message in history', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.sessionPromptImplementation).mockImplementationOnce(async (input) => {
      client.setMessages([
        {
          info: {
            id: input.messageId,
            role: 'user',
            sessionID: 'ses-1',
            time: { created: Date.now() },
          },
          parts: [
            { id: 'part-user-1', type: 'text', text: 'hello' },
          ],
        },
        {
          info: {
            id: 'msg-assistant-after-user',
            parentID: input.messageId,
            role: 'assistant',
            sessionID: 'ses-1',
            time: { created: 100, completed: 200 },
            finish: 'stop',
          },
          parts: [
            { id: 'part-text-1', type: 'text', text: 'Assistant after user id' },
          ],
        },
      ]);
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });

    runtime.beginTurnLifecycle('test-turn');
    await runtime.sendTurnPrompt('hello');
    await runtime.handleProviderEvent({
      payload: {
        type: 'session.idle',
        properties: { sessionID: 'ses-1' },
      },
    });

    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'transcript-agent-message-committed',
        agentId: 'opencode',
        localId: 'opencode:ses-1:msg-assistant-after-user',
        body: {
          type: 'message',
          message: 'Assistant after user id',
        },
      }),
      expect.objectContaining({ kind: 'turn-complete' }),
    ]));
    expect(runtimeEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'transcript-user-text' }),
    ]));
  });

  it('does not passively mirror provider user rows that came from a completed Happier turn', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.sessionPromptImplementation).mockImplementationOnce(async (input) => {
      client.setMessages([
        {
          info: {
            id: input.messageId,
            role: 'user',
            sessionID: 'ses-1',
            time: { created: Date.now() },
          },
          parts: [
            { id: 'part-user-1', type: 'text', text: 'internal system guidance\n\nUSER_MARKER' },
          ],
        },
        {
          info: {
            id: 'msg-happier-provider-assistant',
            role: 'assistant',
            sessionID: 'ses-1',
            parentID: input.messageId,
            finish: 'stop',
            time: { completed: Date.now() + 1 },
          },
          parts: [
            { id: 'part-assistant-1', type: 'text', text: 'USER_MARKER_OK' },
          ],
        },
      ]);
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });

    runtime.beginTurnLifecycle('test-turn');
    await runtime.sendTurnPrompt('internal system guidance\n\nUSER_MARKER');
    await runtime.handleProviderEvent({
      payload: {
        type: 'session.idle',
        properties: { sessionID: 'ses-1' },
      },
    });

    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'turn-complete' }),
    ]));

    await runtime.handleProviderEvent({
      payload: {
        type: 'session.idle',
        properties: { sessionID: 'ses-1' },
      },
    });

    expect(runtimeEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'transcript-user-text',
        text: expect.stringContaining('internal system guidance'),
      }),
    ]));
  });

  it('does not passively mirror completed Happier turn user rows when OpenCode reports nested created time in seconds', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    vi.useFakeTimers();
    vi.setSystemTime(1_782_215_218_000);
    vi.mocked(client.sessionPromptImplementation).mockImplementationOnce(async (input) => {
      client.setMessages([
        {
          info: {
            id: input.messageId,
            role: 'user',
            sessionID: 'ses-1',
            time: { created: 1_782_215_218 },
          },
          parts: [
            { id: 'part-user-seconds', type: 'text', text: 'seconds timestamp guidance\n\nUSER_MARKER_SECONDS' },
          ],
        },
        {
          info: {
            id: 'msg-happier-provider-assistant-seconds',
            role: 'assistant',
            sessionID: 'ses-1',
            parentID: input.messageId,
            finish: 'stop',
            time: { completed: 1_782_215_219_000 },
          },
          parts: [
            { id: 'part-assistant-seconds', type: 'text', text: 'USER_MARKER_SECONDS_OK' },
          ],
        },
      ]);
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });

    beginTestHostTurn(runtime);
    await runtime.sendTurnPrompt('seconds timestamp guidance\n\nUSER_MARKER_SECONDS');
    await runtime.waitForTurnCompletion();

    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'turn-complete' }),
    ]));

    await runtime.handleProviderEvent({
      payload: {
        type: 'session.idle',
        properties: { sessionID: 'ses-1' },
      },
    });

    expect(runtimeEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'transcript-user-text',
        text: expect.stringContaining('seconds timestamp guidance'),
      }),
    ]));
  });

  it('does not passively mirror completed Happier turn user rows after runtime recreation', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.sessionPromptImplementation).mockImplementationOnce(async (input) => {
      client.setMessages([
        {
          info: {
            id: input.messageId,
            role: 'user',
            sessionID: 'ses-1',
            time: { created: Date.now() },
          },
          parts: [
            { id: 'part-user-1', type: 'text', text: 'internal restart guidance\n\nUSER_MARKER' },
          ],
        },
        {
          info: {
            id: 'msg-happier-provider-assistant-before-restart',
            role: 'assistant',
            sessionID: 'ses-1',
            parentID: input.messageId,
            finish: 'stop',
            time: { completed: Date.now() + 1 },
          },
          parts: [
            { id: 'part-assistant-1', type: 'text', text: 'USER_MARKER_RESTART_OK' },
          ],
        },
      ]);
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });

    beginTestHostTurn(runtime);
    await runtime.sendTurnPrompt('internal restart guidance\n\nUSER_MARKER');
    await runtime.handleProviderEvent({
      payload: {
        type: 'session.idle',
        properties: { sessionID: 'ses-1' },
      },
    });
    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'turn-complete' }),
    ]));

    await runtime.resetOrDisposeRuntime();
    const restartedRuntime = await createStartedRuntime({ ctx, client, harness });
    await restartedRuntime.handleProviderEvent({
      payload: {
        type: 'session.idle',
        properties: { sessionID: 'ses-1' },
      },
    });

    expect(runtimeEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'transcript-user-text',
        text: expect.stringContaining('internal restart guidance'),
      }),
    ]));
  });

  it('does not passively mirror provider user rows after an accepted Happier turn fails before history finality', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    let providerUserMessageId = '';
    vi.mocked(client.sessionPromptImplementation).mockImplementationOnce(async (input) => {
      providerUserMessageId = input.messageId ?? '';
      client.setMessages([
        {
          info: {
            id: input.messageId,
            role: 'user',
            sessionID: 'ses-1',
            time: { created: Date.now() },
          },
          parts: [
            { id: 'part-user-1', type: 'text', text: 'internal error-path guidance\n\nUSER_MARKER' },
          ],
        },
      ]);
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });

    runtime.beginTurnLifecycle('test-turn');
    await runtime.sendTurnPrompt('internal error-path guidance\n\nUSER_MARKER');
    await runtime.handleProviderEvent({
      payload: {
        type: 'session.error',
        properties: {
          sessionID: 'ses-1',
          error: { message: 'provider failed after accepting prompt' },
        },
      },
    });
    client.setMessages([
      {
        info: {
          id: providerUserMessageId,
          role: 'user',
          sessionID: 'ses-1',
          time: { created: Date.now() },
        },
        parts: [
          { id: 'part-user-1', type: 'text', text: 'internal error-path guidance\n\nUSER_MARKER' },
        ],
      },
      {
        info: {
          id: 'msg-provider-error',
          role: 'assistant',
          sessionID: 'ses-1',
          parentID: providerUserMessageId,
          time: { created: Date.now(), completed: Date.now() + 1 },
          error: { message: 'provider failed after accepting prompt' },
        },
        parts: [],
      },
    ]);
    await runtime.handleProviderEvent({
      payload: {
        type: 'session.idle',
        properties: { sessionID: 'ses-1' },
      },
    });

    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'turn-failed' }),
    ]));

    await runtime.handleProviderEvent({
      payload: {
        type: 'session.idle',
        properties: { sessionID: 'ses-1' },
      },
    });

    expect(runtimeEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'transcript-user-text',
        text: expect.stringContaining('internal error-path guidance'),
      }),
    ]));
  });

  it('does not passively mirror provider user rows after prompt submission rejects with provider history', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.sessionPromptImplementation).mockImplementationOnce(async (input) => {
      client.setMessages([
        {
          info: {
            id: 'msg-happier-provider-user-before-submit-reject',
            role: 'user',
            sessionID: 'ses-1',
            time: { created: Date.now() },
          },
          parts: [
            { id: 'part-user-1', type: 'text', text: 'internal submit-reject guidance\n\nUSER_MARKER' },
          ],
        },
      ]);
      throw new Error('provider rejected after writing the user row');
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });

    beginTestHostTurn(runtime);
    await expect(
      runtime.sendTurnPrompt('internal submit-reject guidance\n\nUSER_MARKER'),
    ).rejects.toThrow('provider rejected after writing the user row');
    expect(runtime.isHappierAuthoredProviderUserMessageId(
      'msg-happier-provider-user-before-submit-reject',
    )).toBe(true);
    await vi.waitFor(() => {
      expect(runtimeEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'turn-failed' }),
      ]));
    });

    await runtime.handleProviderEvent({
      payload: {
        type: 'session.idle',
        properties: { sessionID: 'ses-1' },
      },
    });

    expect(runtimeEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'transcript-user-text',
        text: expect.stringContaining('internal submit-reject guidance'),
      }),
    ]));
  });

  it('commits assistant transcript text after OpenCode preserves the exact provider user message id', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.sessionPromptImplementation).mockImplementationOnce(async (input) => {
      client.setMessages([
        {
          info: {
            id: input.messageId,
            role: 'user',
            sessionID: 'ses-1',
            time: { created: Date.now() },
          },
          parts: [
            { id: 'part-user-1', type: 'text', text: '[opencode prompt stack]\nhello' },
          ],
        },
        {
          info: {
            id: 'msg-assistant-after-generated-user',
            parentID: input.messageId,
            role: 'assistant',
            sessionID: 'ses-1',
            time: { created: 100, completed: 200 },
            finish: 'stop',
          },
          parts: [
            { id: 'part-text-1', type: 'text', text: 'Assistant after generated user id' },
          ],
        },
      ]);
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });

    beginTestHostTurn(runtime);
    await runtime.sendTurnPrompt('hello');
    await runtime.waitForTurnCompletion();

    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'transcript-agent-message-committed',
        agentId: 'opencode',
        localId: 'opencode:ses-1:msg-assistant-after-generated-user',
        body: {
          type: 'message',
          message: 'Assistant after generated user id',
        },
      }),
      expect.objectContaining({ kind: 'turn-complete' }),
    ]));
  });

  it('completes a user turn from terminal assistant history while OpenCode status is unknown', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.sessionStatus).mockResolvedValue({});
    vi.mocked(client.sessionPromptImplementation).mockImplementationOnce(async (input) => {
      client.setMessages([
        {
          info: {
            id: input.messageId,
            role: 'user',
            sessionID: 'ses-1',
            time: { created: Date.now() },
          },
          parts: [
            { id: 'part-user-1', type: 'text', text: '[opencode prompt stack]\nhello' },
          ],
        },
        {
          info: {
            id: 'msg-assistant-before-idle',
            parentID: input.messageId,
            role: 'assistant',
            sessionID: 'ses-1',
            time: { created: 100, completed: 200 },
            finish: 'stop',
          },
          parts: [
            { id: 'part-text-1', type: 'text', text: 'Assistant before explicit idle' },
          ],
        },
      ]);
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });

    beginTestHostTurn(runtime);
    await runtime.sendTurnPrompt('hello');
    await runtime.waitForTurnCompletion();

    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'transcript-agent-message-committed',
        agentId: 'opencode',
        localId: 'opencode:ses-1:msg-assistant-before-idle',
        body: {
          type: 'message',
          message: 'Assistant before explicit idle',
        },
      }),
      expect.objectContaining({ kind: 'turn-complete' }),
    ]));
    expect(runtimeEvents.some((event) => event.kind === 'turn-failed')).toBe(false);
  });

  it('keeps the turn open when OpenCode reports idle before producing assistant history', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    let providerUserMessageId = '';
    vi.mocked(client.sessionPromptImplementation).mockImplementationOnce(async (input) => {
      providerUserMessageId = input.messageId ?? '';
      client.setMessages([
        {
          info: {
            id: providerUserMessageId,
            role: 'user',
            sessionID: 'ses-1',
            time: { created: Date.now() },
            model: {
              providerID: 'opencode',
              modelID: 'big-pickle',
            },
          },
          parts: [
            {
              id: 'part-user-1',
              type: 'text',
              text: '[analyze-mode]\nhello',
            },
          ],
        },
      ]);
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });

    beginTestHostTurn(runtime);
    await runtime.sendTurnPrompt('hello');
    await runtime.waitForTurnCompletion();

    expect(runtimeEvents.some((event) => event.kind === 'turn-failed')).toBe(false);
    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);

    client.setMessages([
      {
        info: {
          id: providerUserMessageId,
          role: 'user',
          sessionID: 'ses-1',
          time: { created: Date.now() },
        },
        parts: [
          { id: 'part-user-1', type: 'text', text: '[analyze-mode]\nhello' },
        ],
      },
      {
        info: {
          id: 'msg-assistant-after-delayed-idle',
          parentID: providerUserMessageId,
          role: 'assistant',
          sessionID: 'ses-1',
          modelID: 'big-pickle',
          providerID: 'opencode',
          time: { created: 100, completed: 200 },
          finish: 'stop',
        },
        parts: [
          { id: 'part-step-1', type: 'step-start' },
          { id: 'part-reasoning-1', type: 'reasoning', text: 'internal thinking' },
          { id: 'part-text-1', type: 'text', text: 'Assistant after delayed idle' },
        ],
      },
    ]);
    await runtime.handleProviderEvent({
      payload: { type: 'session.idle', properties: { sessionID: 'ses-1' } },
    });

    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'transcript-agent-message-committed',
        agentId: 'opencode',
        localId: 'opencode:ses-1:msg-assistant-after-delayed-idle',
        body: {
          type: 'message',
          message: 'Assistant after delayed idle',
        },
      }),
      expect.objectContaining({ kind: 'turn-complete' }),
    ]));
    expect(runtimeEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'turn-failed' }),
    ]));
  });

  it('fails accepted prompts when idle history never produces assistant evidence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.sessionPromptImplementation).mockImplementationOnce(async (input) => {
      client.setMessages([
        {
          info: {
            id: input.messageId,
            role: 'user',
            sessionID: 'ses-1',
            time: { created: Date.now() },
            model: {
              providerID: 'opencode',
              modelID: 'big-pickle',
            },
          },
          parts: [
            {
              id: 'part-user-1',
              type: 'text',
              text: '[analyze-mode]\nhello',
            },
          ],
        },
      ]);
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });

    beginTestHostTurn(runtime);
    await runtime.sendTurnPrompt('hello');
    await runtime.waitForTurnCompletion();

    expect(runtimeEvents.some((event) => event.kind === 'turn-failed')).toBe(false);
    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);

    vi.setSystemTime(61_001);
    await runtime.waitForTurnCompletion();

    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
        issue: expect.objectContaining({
          agentId: 'opencode',
          code: 'opencode_empty_provider_response',
          source: 'agent_session_error',
          sanitizedPreview: expect.stringContaining('did not publish assistant'),
        }),
      }),
      expect.objectContaining({
        kind: 'transcript-agent-message-committed',
        agentId: 'opencode',
        body: expect.objectContaining({
          type: 'turn_failed',
        }),
      }),
    ]));
    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);
    expect(client.sessionMessages).toHaveBeenCalledTimes(3);
  });

  it('keeps accepted prompts open when OpenCode remains busy without assistant, tool, or error evidence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const permissionRequests: unknown[] = [];
    const { ctx, harness, runtimeEvents } = createContextFixture({
      onPermissionDecision: async (request) => {
        permissionRequests.push(request);
        return { decision: 'approved' };
      },
    });
    const client = createClientFixture();
    vi.mocked(client.sessionStatus).mockResolvedValue({ type: 'busy' });
    vi.mocked(client.sessionPromptImplementation).mockImplementationOnce(async (input) => {
      client.setMessages([
        {
          info: {
            id: input.messageId,
            role: 'user',
            sessionID: 'ses-1',
            time: { created: Date.now() },
            model: {
              providerID: 'opencode',
              modelID: 'big-pickle',
            },
          },
          parts: [
            {
              id: 'part-user-1',
              type: 'text',
              text: '[analyze-mode]\nhello',
            },
          ],
        },
      ]);
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });

    beginTestHostTurn(runtime);
    await runtime.sendTurnPrompt('hello');
    await runtime.waitForTurnCompletion();

    expect(runtimeEvents.some((event) => event.kind === 'turn-failed')).toBe(false);
    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);
    expect(client.sessionMessages).toHaveBeenCalledTimes(1);

    vi.setSystemTime(61_001);
    await runtime.waitForTurnCompletion();

    expect(runtimeEvents.some((event) => event.kind === 'turn-failed')).toBe(false);
    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);
    expect(client.sessionMessages).toHaveBeenCalledTimes(1);

    await runtime.handleProviderEvent({
      payload: {
        type: 'permission.asked',
        properties: {
          sessionID: 'ses-1',
          id: 'per_late_busy',
          permission: 'bash',
          patterns: ['ls /tmp/happier-opencode-late-permission/'],
        },
      },
    });

    expect(permissionRequests).toEqual([
      expect.objectContaining({
        subject: expect.objectContaining({
          kind: 'tool',
          name: 'bash',
        }),
      }),
    ]);
    expect(client.permissionReply).toHaveBeenCalledWith({
      sessionId: 'ses-1',
      requestId: 'per_late_busy',
      reply: 'once',
    });
    expect(runtimeEvents.some((event) => event.kind === 'turn-failed')).toBe(false);
    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);
  });

  it('keeps the turn open while an OpenCode permission request waits for a decision', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const permissionRequests: unknown[] = [];
    let resolvePermissionDecision: ((value: { decision: 'approved' }) => void) | null = null;
    const pendingPermissionDecision = new Promise<{ decision: 'approved' }>((resolve) => {
      resolvePermissionDecision = resolve;
    });
    const { ctx, harness, runtimeEvents } = createContextFixture({
      onPermissionDecision: async (request) => {
        permissionRequests.push(request);
        return await pendingPermissionDecision;
      },
    });
    const client = createClientFixture();
    vi.mocked(client.sessionPromptImplementation).mockImplementationOnce(async (input) => {
      client.setMessages([
        {
          info: {
            id: input.messageId,
            role: 'user',
            sessionID: 'ses-1',
            time: { created: Date.now() },
            model: {
              providerID: 'opencode',
              modelID: 'big-pickle',
            },
          },
          parts: [
            {
              id: 'part-user-1',
              type: 'text',
              text: '[analyze-mode]\nhello',
            },
          ],
        },
      ]);
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });

    beginTestHostTurn(runtime);
    await runtime.sendTurnPrompt('hello');

    const permissionAsk = runtime.handleProviderEvent({
      payload: {
        type: 'permission.asked',
        properties: {
          sessionID: 'ses-1',
          id: 'per_waiting',
          permission: 'bash',
          patterns: ['pwd'],
        },
      },
    });
    void permissionAsk.catch(() => undefined);
    await Promise.resolve();

    expect(permissionRequests).toEqual([
      expect.objectContaining({
        subject: expect.objectContaining({
          kind: 'tool',
          name: 'bash',
        }),
      }),
    ]);

    vi.setSystemTime(61_001);
    await runtime.waitForTurnCompletion();

    expect(runtimeEvents.some((event) => event.kind === 'turn-failed')).toBe(false);
    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);
    expect(client.permissionReply).not.toHaveBeenCalled();

    resolvePermissionDecision?.({ decision: 'approved' });
    await permissionAsk;
  });

  it('cancels pending turn-scoped OpenCode permission decisions when provider errors fail the turn', async () => {
    type PermissionDecision = Awaited<
      ReturnType<OpenCodeRuntimeContext['sessions']['current']['permissions']['requestDecision']>
    >;
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    let capturedSignal: AbortSignal | null = null;
    let resolvePermissionDecision: ((value: PermissionDecision) => void) | null = null;
    let rejectPermissionDecision: ((reason: unknown) => void) | null = null;
    let permissionSettled = false;
    const pendingPermissionDecision = new Promise<PermissionDecision>((resolve, reject) => {
      resolvePermissionDecision = resolve;
      rejectPermissionDecision = reject;
    }).finally(() => {
      permissionSettled = true;
    });
    const ctxWithPermissionSignal: OpenCodeRuntimeContext = {
      ...ctx,
      sessions: {
        ...ctx.sessions,
        current: {
          ...ctx.sessions.current,
          permissions: {
            ...ctx.sessions.current.permissions,
            requestDecision: vi.fn((_request, options) => {
              capturedSignal = options?.signal ?? null;
              if (capturedSignal) {
                capturedSignal.addEventListener('abort', () => {
                  rejectPermissionDecision?.(
                    capturedSignal?.reason ?? new Error('permission aborted'),
                  );
                }, { once: true });
              }
              return pendingPermissionDecision;
            }),
          },
        },
      },
    };
    let providerUserMessageId = '';
    vi.mocked(client.sessionPromptImplementation).mockImplementationOnce(async (input) => {
      providerUserMessageId = input.messageId ?? '';
    });
    const runtime = await createStartedRuntime({ ctx: ctxWithPermissionSignal, client, harness });

    beginTestHostTurn(runtime);
    await runtime.sendTurnPrompt('hello');
    const permissionAsk = runtime.handleProviderEvent({
      payload: {
        type: 'permission.asked',
        properties: {
          sessionID: 'ses-1',
          id: 'per_provider_error_abort',
          permission: 'bash',
          patterns: ['pwd'],
        },
      },
    });
    void permissionAsk.catch(() => undefined);
    await Promise.resolve();

    try {
      expect(capturedSignal).toBeInstanceOf(AbortSignal);

      await runtime.handleProviderEvent({
        payload: {
          type: 'session.error',
          properties: {
            sessionID: 'ses-1',
            error: { message: 'provider failed while permission was pending' },
          },
        },
      });

      expect(capturedSignal?.aborted).toBe(false);
      client.setMessages([
        {
          info: { id: providerUserMessageId, role: 'user', sessionID: 'ses-1', time: { created: 10 } },
          parts: [{ id: 'part-current-user', type: 'text', text: 'hello' }],
        },
        {
          info: {
            id: 'msg-provider-error',
            role: 'assistant',
            sessionID: 'ses-1',
            parentID: providerUserMessageId,
            time: { created: 11, completed: 12 },
            error: { message: 'provider failed while permission was pending' },
          },
          parts: [],
        },
      ]);
      await runtime.handleProviderEvent({
        payload: {
          type: 'session.idle',
          properties: { sessionID: 'ses-1' },
        },
      });

      expect(capturedSignal?.aborted).toBe(true);
      await permissionAsk;
      expect(client.permissionReply).not.toHaveBeenCalled();
      expect(runtimeEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'turn-failed' }),
      ]));
      expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);
    } finally {
      if (!permissionSettled) {
        resolvePermissionDecision?.({ decision: 'denied' });
        await permissionAsk.catch(() => undefined);
      }
    }
  });

  it('uses the V2 admitted prompt id without requiring immediate message projection', async () => {
    const client = createClientFixture();
    client.suppressNextNativePromptPersistence();
    vi.mocked(client.sessionPromptImplementation).mockResolvedValueOnce({
      id: 'msg_v2_admitted',
      sessionID: 'ses-1',
      admittedSeq: 12,
      delivery: 'steer',
    });
    const runtime = await createStartedRuntime({ client });

    beginTestHostTurn(runtime);
    await expect(runtime.sendTurnPrompt('accepted before projection')).resolves.toEqual({
      providerUserMessageId: 'msg_v2_admitted',
    });

    expect(client.sessionMessages).not.toHaveBeenCalled();
  });

  it('reports user-denied OpenCode permissions as permission failures instead of empty provider responses', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { ctx, harness, runtimeEvents } = createContextFixture({
      onPermissionDecision: async () => ({ decision: 'denied', rationale: 'QA denied shell access' }),
    });
    const client = createClientFixture();
    vi.mocked(client.sessionPromptImplementation).mockResolvedValueOnce(undefined);
    const runtime = await createStartedRuntime({ ctx, client, harness });

    beginTestHostTurn(runtime);
    const { providerUserMessageId } = await runtime.sendTurnPrompt('hello');
    await runtime.handleProviderEvent({
      payload: {
        type: 'permission.asked',
        properties: {
          sessionID: 'ses-1',
          id: 'per_denied',
          permission: 'bash',
          patterns: ['pwd'],
        },
      },
    });

    client.setMessages([
      {
        info: {
          id: providerUserMessageId,
          role: 'user',
          sessionID: 'ses-1',
          time: { created: 1_000 },
        },
        parts: [
          { id: 'part-user-1', type: 'text', text: '[opencode prompt stack]\nhello' },
        ],
      },
      {
        info: {
          id: 'msg-denied-assistant',
          parentID: providerUserMessageId,
          role: 'assistant',
          sessionID: 'ses-1',
          time: { created: 1_010, completed: 1_020 },
        },
        parts: [
          {
            id: 'part-denied-tool',
            type: 'tool',
            sessionID: 'ses-1',
            messageID: 'msg-denied-assistant',
            callID: 'call-denied-tool',
            tool: 'bash',
            state: {
              status: 'error',
              input: { command: 'pwd' },
              output: 'Permission denied by user',
            },
          },
        ],
      },
    ]);

    await runtime.waitForTurnCompletion();

    expect(client.permissionReply).toHaveBeenCalledWith({
      sessionId: 'ses-1',
      requestId: 'per_denied',
      reply: 'reject',
    });
    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'tool-result',
        toolCallId: 'call-denied-tool',
        isError: true,
      }),
      expect.objectContaining({
        kind: 'turn-failed',
        issue: expect.objectContaining({
          agentId: 'opencode',
          code: 'opencode_permission_denied',
          source: 'permission_blocked',
          sanitizedPreview: expect.stringContaining('permission'),
        }),
      }),
    ]));
    expect(runtimeEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
        issue: expect.objectContaining({
          code: 'opencode_empty_provider_response',
        }),
      }),
    ]));
    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);
  });

  it('reports user-denied OpenCode permissions as permission failures when no assistant history is recorded', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { ctx, harness, runtimeEvents } = createContextFixture({
      onPermissionDecision: async () => ({ decision: 'denied', rationale: 'QA denied shell access' }),
    });
    const client = createClientFixture();
    vi.mocked(client.sessionPromptImplementation).mockResolvedValueOnce(undefined);
    const runtime = await createStartedRuntime({ ctx, client, harness });

    beginTestHostTurn(runtime);
    const { providerUserMessageId } = await runtime.sendTurnPrompt('hello');
    await runtime.handleProviderEvent({
      payload: {
        type: 'permission.asked',
        properties: {
          sessionID: 'ses-1',
          id: 'per_denied_no_history',
          permission: 'bash',
          patterns: ['pwd'],
        },
      },
    });

    client.setMessages([
      {
        info: {
          id: providerUserMessageId,
          role: 'user',
          sessionID: 'ses-1',
          time: { created: 1_000 },
        },
        parts: [
          { id: 'part-user-1', type: 'text', text: '[opencode prompt stack]\nhello' },
        ],
      },
    ]);

    vi.setSystemTime(61_001);
    await runtime.waitForTurnCompletion();

    expect(client.permissionReply).toHaveBeenCalledWith({
      sessionId: 'ses-1',
      requestId: 'per_denied_no_history',
      reply: 'reject',
    });
    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
        issue: expect.objectContaining({
          agentId: 'opencode',
          code: 'opencode_permission_denied',
          source: 'permission_blocked',
          sanitizedPreview: expect.stringContaining('permission'),
        }),
      }),
    ]));
    expect(runtimeEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
        issue: expect.objectContaining({
          code: 'opencode_empty_provider_response',
        }),
      }),
    ]));
    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);
  });

  it('keeps the turn open after a delayed permission reply resets the idle assistant grace', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let resolvePermissionDecision: ((value: { decision: 'approved' }) => void) | null = null;
    let permissionResolved = false;
    const pendingPermissionDecision = new Promise<{ decision: 'approved' }>((resolve) => {
      resolvePermissionDecision = (value) => {
        permissionResolved = true;
        resolve(value);
      };
    });
    const { ctx, harness, runtimeEvents } = createContextFixture({
      onPermissionDecision: async () => await pendingPermissionDecision,
    });
    const client = createClientFixture();
    vi.mocked(client.sessionPromptImplementation).mockImplementationOnce(async (input) => {
      client.setMessages([
        {
          info: {
            id: input.messageId,
            role: 'user',
            sessionID: 'ses-1',
            time: { created: Date.now() },
            model: {
              providerID: 'opencode',
              modelID: 'big-pickle',
            },
          },
          parts: [
            {
              id: 'part-user-1',
              type: 'text',
              text: '[analyze-mode]\nhello',
            },
          ],
        },
      ]);
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });

    beginTestHostTurn(runtime);
    await runtime.sendTurnPrompt('hello');
    const permissionAsk = runtime.handleProviderEvent({
      payload: {
        type: 'permission.asked',
        properties: {
          sessionID: 'ses-1',
          id: 'per_delayed',
          permission: 'bash',
          patterns: ['pwd'],
        },
      },
    });
    void permissionAsk.catch(() => undefined);
    await Promise.resolve();

    try {
      vi.setSystemTime(61_001);
      resolvePermissionDecision?.({ decision: 'approved' });
      await permissionAsk;
      expect(client.permissionReply).toHaveBeenCalledWith({
        sessionId: 'ses-1',
      requestId: 'per_delayed',
        reply: 'once',
      });

      await runtime.waitForTurnCompletion();

      expect(runtimeEvents.some((event) => event.kind === 'turn-failed')).toBe(false);
      expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);
    } finally {
      if (!permissionResolved) {
        resolvePermissionDecision?.({ decision: 'approved' });
        await permissionAsk;
      }
    }
  });

  it('starts a fresh turn lifecycle for follow-up prompts after completing a previous turn', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.sessionPromptImplementation).mockImplementation(async (input) => {
      if (input.text === 'first') {
        client.setMessages([
          {
            info: { id: input.messageId, role: 'user', sessionID: 'ses-1', time: { created: Date.now() } },
            parts: [
              { id: 'part-user-first', type: 'text', text: '[opencode prompt stack]\nfirst' },
            ],
          },
          {
            info: {
              id: 'msg-assistant-first',
              parentID: input.messageId,
              role: 'assistant',
              sessionID: 'ses-1',
              time: { created: Date.now() + 1, completed: Date.now() + 2 },
            },
            parts: [
              { id: 'part-text-first', type: 'text', text: 'first done' },
            ],
          },
        ]);
        return;
      }
      client.setMessages([
        {
          info: { id: input.messageId, role: 'user', sessionID: 'ses-1', time: { created: Date.now() } },
          parts: [
            { id: 'part-user-second', type: 'text', text: '[opencode prompt stack]\nsecond' },
          ],
        },
      ]);
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });

    beginTestHostTurn(runtime);
    await runtime.sendTurnPrompt('first');
    await runtime.waitForTurnCompletion();
    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'turn-complete' }),
      expect.objectContaining({
        kind: 'transcript-agent-message-committed',
        agentId: 'opencode',
        localId: 'opencode:ses-1:msg-assistant-first',
      }),
    ]));

    vi.setSystemTime(2_000);
    beginTestHostTurn(runtime);
    await runtime.sendTurnPrompt('second');

    expect(runtimeEvents.filter((event) => event.kind === 'turn-start')).toHaveLength(2);

    vi.setSystemTime(63_000);
    await runtime.waitForTurnCompletion();

    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
        issue: expect.objectContaining({
          agentId: 'opencode',
          code: 'opencode_empty_provider_response',
        }),
      }),
      expect.objectContaining({
        kind: 'transcript-agent-message-committed',
        agentId: 'opencode',
        body: expect.objectContaining({
          type: 'turn_failed',
        }),
      }),
    ]));
  });

  it('fails active user turns when OpenCode completes with an empty assistant message', async () => {
    const { ctx, harness, runtimeEvents, transcriptAppends } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.sessionPromptImplementation).mockImplementationOnce(async (input) => {
      client.setMessages([
        {
          info: {
            id: input.messageId,
            role: 'user',
            sessionID: 'ses-1',
            time: { created: Date.now() },
          },
          parts: [
            { id: 'part-user-1', type: 'text', text: '[opencode prompt stack]\nhello' },
          ],
        },
        {
          info: {
            id: 'msg-empty-assistant',
            parentID: input.messageId,
            role: 'assistant',
            sessionID: 'ses-1',
            time: { created: Date.now() + 1, completed: Date.now() + 2 },
          },
          parts: [],
        },
      ]);
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });

    beginTestHostTurn(runtime);
    await runtime.sendTurnPrompt('hello');
    await runtime.waitForTurnCompletion();

    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
        issue: expect.objectContaining({
          agentId: 'opencode',
          code: 'opencode_empty_provider_response',
          source: 'agent_session_error',
        }),
      }),
      expect.objectContaining({
        kind: 'transcript-agent-message-committed',
        agentId: 'opencode',
        body: expect.objectContaining({
          type: 'turn_failed',
        }),
      }),
    ]));
    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);
    expect(transcriptAppends).toHaveLength(0);
    expect(client.sessionMessages).toHaveBeenCalledTimes(2);
  });

  it('backs off full history refreshes while waiting for idle assistant history', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { ctx, harness } = createContextFixture();
    const client = createClientFixture();
    const operations = await createStartedRuntime({ ctx, client, harness });
    const runtime = createNativeSessionRuntimeForTest(operations);

    await runtime.send({
      inputIds: ['input-history-backoff'],
      input: { text: 'hello' },
      delivery: { kind: 'newTurn', turnId: 'turn-history-backoff' },
    });
    await flushMicrotasks();

    for (let i = 0; i < 20; i += 1) {
      await vi.advanceTimersByTimeAsync(250);
      await flushMicrotasks();
    }

    expect(client.sessionStatus).toHaveBeenCalledTimes(3);
    expect(client.sessionMessages.mock.calls.length).toBeLessThanOrEqual(7);
    expect(runtime.isTurnInFlight()).toBe(true);
  });

  it('fails active user turns with the provider error recorded on the terminal assistant history message', async () => {
    const { ctx, harness, runtimeEvents, transcriptAppends } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.sessionPromptImplementation).mockImplementationOnce(async (input) => {
      client.setMessages([
        {
          info: {
            id: input.messageId,
            role: 'user',
            sessionID: 'ses-1',
            time: { created: Date.now() },
          },
          parts: [
            { id: 'part-user-1', type: 'text', text: '[opencode prompt stack]\nhello' },
          ],
        },
        {
          info: {
            id: 'msg-error-assistant',
            parentID: input.messageId,
            role: 'assistant',
            sessionID: 'ses-1',
            time: { created: 100, completed: 200 },
            error: {
              name: 'UnknownError',
              data: {
                message: 'Token refresh failed: 401 Authorization: Bearer sk-live-secret',
              },
            },
          },
          parts: [],
        },
      ]);
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });

    beginTestHostTurn(runtime);
    await runtime.sendTurnPrompt('hello');
    await runtime.waitForTurnCompletion();

    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
        issue: expect.objectContaining({
          agentId: 'opencode',
          code: 'opencode_provider_session_error',
          source: 'auth_error',
          sanitizedPreview: expect.stringContaining('Token refresh failed: 401'),
        }),
      }),
      expect.objectContaining({
        kind: 'transcript-agent-message-committed',
        agentId: 'opencode',
        body: expect.objectContaining({
          type: 'turn_failed',
        }),
      }),
    ]));
    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);
    expect(JSON.stringify(runtimeEvents)).not.toContain('sk-live-secret');
    expect(transcriptAppends).toHaveLength(0);
    expect(client.sessionMessages).toHaveBeenCalledTimes(2);
  });

  it('fails and confirms provider acceptance from an immediate assistant error prompt response', async () => {
    const { ctx, harness, runtimeEvents, transcriptAppends } = createContextFixture();
    const client = createClientFixture();
    const immediateAssistantError = {
      info: {
        id: 'msg-immediate-error',
        role: 'assistant',
        sessionID: 'ses-1',
        time: { created: Date.now() },
        error: {
          name: 'ProviderAuthError',
          data: {
            message: 'Token refresh failed: 401 Authorization: Bearer sk-live-secret',
          },
        },
      },
      parts: [],
    };
    vi.mocked(client.sessionPromptImplementation).mockImplementationOnce(async (input) => ({
      ...immediateAssistantError,
      info: {
        ...immediateAssistantError.info,
        parentID: input.messageId,
      },
    }));
    const operations = await createStartedRuntime({ ctx, client, harness });
    const runtime = createNativeSessionRuntimeForTest(operations);
    const nativeEvents: Array<{ kind: string }> = [];
    runtime.watch((event) => nativeEvents.push(event));

    await expect(runtime.send({
      inputIds: ['input-immediate-error'],
      input: { text: 'hello' },
      delivery: { kind: 'newTurn', turnId: 'turn-immediate-error' },
    })).resolves.toMatchObject({ status: 'admitted' });

    await vi.waitFor(() => {
      expect(runtimeEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'turn-failed',
          issue: expect.objectContaining({
            agentId: 'opencode',
            code: 'opencode_provider_session_error',
            source: 'auth_error',
            sanitizedPreview: expect.stringContaining('Token refresh failed: 401'),
          }),
        }),
      ]));
    });

    expect(nativeEvents.filter((event) => event.kind === 'input-accepted')).toHaveLength(1);
    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);
    expect(JSON.stringify(runtimeEvents)).not.toContain('sk-live-secret');
    expect(transcriptAppends).toHaveLength(0);
    await runtime.dispose?.();
  });

  it('does not attribute stale assistant errors from an older identical prompt to the active turn', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.sessionPromptImplementation).mockImplementationOnce(async (input) => {
      client.setMessages([
        {
          info: { id: 'msg-older-user', role: 'user', sessionID: 'ses-1' },
          parts: [
            { id: 'part-older-user', type: 'text', text: '[opencode prompt stack]\nrepeat me' },
          ],
        },
        {
          info: {
            id: 'msg-older-error-assistant',
            role: 'assistant',
            sessionID: 'ses-1',
            time: { created: 100, completed: 200 },
            error: {
              name: 'StaleProviderError',
              data: {
                message: 'stale provider error from earlier repeated prompt',
              },
            },
          },
          parts: [],
        },
        {
          info: { id: 'msg-current-rewritten-user', role: 'user', sessionID: 'ses-1' },
          parts: [
            { id: 'part-current-user', type: 'text', text: '[opencode prompt stack]\nrepeat me' },
          ],
        },
      ]);
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });

    beginTestHostTurn(runtime);
    await runtime.sendTurnPrompt('repeat me');
    await runtime.waitForTurnCompletion();

    expect(runtimeEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'turn-failed' }),
      expect.objectContaining({ kind: 'turn-complete' }),
    ]));
    expect(JSON.stringify(runtimeEvents)).not.toContain('stale provider error from earlier repeated prompt');
    expect(client.sessionMessages).toHaveBeenCalledTimes(2);
  });

  it('does not complete from an older identical prompt when current provider user history is missing', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.sessionStatus).mockResolvedValue({});
    vi.mocked(client.sessionPromptImplementation).mockImplementationOnce(async () => {
      client.setMessages([
        {
          info: { id: 'msg-older-user', role: 'user', sessionID: 'ses-1' },
          parts: [
            { id: 'part-older-user', type: 'text', text: '[opencode prompt stack]\nrepeat me' },
          ],
        },
        {
          info: {
            id: 'msg-older-assistant',
            role: 'assistant',
            sessionID: 'ses-1',
            time: { created: 100, completed: 200 },
            finish: 'stop',
          },
          parts: [
            { id: 'part-older-text', type: 'text', text: 'stale assistant from earlier repeated prompt' },
          ],
        },
      ]);
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });

    beginTestHostTurn(runtime);
    await runtime.sendTurnPrompt('repeat me');
    await runtime.waitForTurnCompletion();

    expect(runtimeEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'transcript-agent-message-committed',
        localId: 'opencode:ses-1:msg-older-assistant',
      }),
      expect.objectContaining({ kind: 'turn-complete' }),
    ]));
    expect(JSON.stringify(runtimeEvents)).not.toContain('stale assistant from earlier repeated prompt');
    expect(client.sessionMessages).toHaveBeenCalledTimes(2);
  });

  it('fails active user turns when OpenCode completes provider tool work without assistant text', async () => {
    const { ctx, harness, runtimeEvents, transcriptAppends } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.sessionPromptImplementation).mockImplementationOnce(async (input) => {
      client.setMessages([
        {
          info: {
            id: input.messageId,
            role: 'user',
            sessionID: 'ses-1',
            time: { created: Date.now() },
          },
          parts: [
            { id: 'part-user-1', type: 'text', text: '[opencode prompt stack]\nhello' },
          ],
        },
        {
          info: {
            id: 'msg-tool-only-assistant',
            parentID: input.messageId,
            role: 'assistant',
            sessionID: 'ses-1',
            time: { created: Date.now() + 1, completed: Date.now() + 2 },
          },
          parts: [
            {
              id: 'part-file-read',
              type: 'tool',
              sessionID: 'ses-1',
              messageID: 'msg-tool-only-assistant',
              callID: 'call-file-read',
              tool: 'file',
              state: {
                status: 'completed',
                input: { path: 'README.md' },
                output: 'read file contents',
              },
            },
          ],
        },
      ]);
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });

    beginTestHostTurn(runtime);
    await runtime.sendTurnPrompt('hello');
    await runtime.waitForTurnCompletion();

    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
        issue: expect.objectContaining({
          agentId: 'opencode',
          code: 'opencode_empty_provider_response',
          source: 'agent_session_error',
        }),
      }),
      expect.objectContaining({
        kind: 'transcript-agent-message-committed',
        agentId: 'opencode',
        body: expect.objectContaining({
          type: 'turn_failed',
        }),
      }),
    ]));
    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);
    expect(transcriptAppends).toHaveLength(0);
  });

  it('keeps active turns open when the status poll fails transiently', async () => {
    const { ctx, harness, runtimeEvents, logs } = createContextFixture();
    const client = createClientFixture();
    const pollError = new Error('status endpoint unavailable');
    vi.mocked(client.sessionStatus)
      .mockRejectedValueOnce(pollError)
      .mockResolvedValueOnce({ type: 'idle' });
    const runtime = await createStartedRuntime({ ctx, client, harness });
    beginTestHostTurn(runtime);
    const { providerUserMessageId } = await runtime.sendTurnPrompt('hello');

    await expect(runtime.waitForTurnCompletion()).resolves.toBeUndefined();
    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);
    expect(logs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        level: 'debug',
        message: expect.stringContaining('status poll failed'),
        fields: expect.objectContaining({ error: pollError }),
      }),
    ]));

    client.setMessages([
      {
        info: {
          id: providerUserMessageId,
          role: 'user',
          sessionID: 'ses-1',
          time: { created: Date.now() },
        },
        parts: [{ id: 'part-user', type: 'text', text: 'hello' }],
      },
      {
        info: {
          id: 'assistant-after-status-recovery',
          parentID: providerUserMessageId,
          role: 'assistant',
          sessionID: 'ses-1',
          time: { created: Date.now() + 1, completed: Date.now() + 2 },
        },
        parts: [{ id: 'part-assistant', type: 'text', text: 'done' }],
      },
    ]);
    await runtime.waitForTurnCompletion();

    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(true);
  });

  it('fails active turns when status polling fails after the managed server exits', async () => {
    const { ctx, harness, runtimeEvents, transcriptAppends } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.sessionStatus).mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:49196'));
    const runtime = await createStartedRuntime({
      ctx,
      client,
      harness,
      readManagedServiceSnapshot: () => managedServiceSnapshot({
        state: 'failed',
        startedAtMs: 100,
        lastHealthyAtMs: 120,
        diagnostics: [{
          code: 'plugin_managed_server_process_exited',
          severity: 'error',
          message: "Managed server 'opencode-server' exited after becoming healthy",
        }],
      }),
    });
    runtime.beginTurnLifecycle('test-turn');

    await runtime.waitForTurnCompletion();

    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
        issue: expect.objectContaining({
          agentId: 'opencode',
          code: 'opencode_managed_server_unhealthy',
          source: 'agent_process_exit',
          sanitizedPreview: expect.stringContaining('exited after becoming healthy'),
        }),
      }),
      expect.objectContaining({
        kind: 'transcript-agent-message-committed',
        agentId: 'opencode',
        body: expect.objectContaining({
          type: 'turn_failed',
        }),
      }),
    ]));
    expect(JSON.stringify(runtimeEvents)).not.toContain('sk-live-secret');
    expect(transcriptAppends).toHaveLength(0);

    await runtime.waitForTurnCompletion();
    expect(client.sessionStatus).toHaveBeenCalledTimes(1);
  });

  it('keeps an active lifecycle without an exact submitted prompt open', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    client.setMessages([
      {
        info: { id: 'msg-stale-running-tool', role: 'assistant', sessionID: 'ses-1' },
        parts: [
          {
            id: 'part-stale-running-tool',
            type: 'tool',
            sessionID: 'ses-1',
            messageID: 'msg-stale-running-tool',
            callID: 'call-stale-running-tool',
            tool: 'bash',
            state: { status: 'running' },
          },
        ],
      },
    ]);
    const runtime = await createStartedRuntime({ ctx, client, harness });
    runtime.beginTurnLifecycle('test-turn');

    await runtime.waitForTurnCompletion();

    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);
  });

  it('completes active turns when OpenCode reports idle after provider work has drained', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.sessionPromptImplementation).mockImplementationOnce(async (input) => {
      client.setMessages([{
        info: {
          id: 'msg-drained-terminal',
          parentID: input.messageId,
          role: 'assistant',
          sessionID: 'ses-1',
          time: { created: 100, completed: 200 },
          finish: 'stop',
        },
        parts: [{ type: 'text', text: 'Provider work drained' }],
      }]);
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });
    beginTestHostTurn(runtime);
    await runtime.sendTurnPrompt('hello');

    await runtime.handleProviderEvent({
      payload: {
        type: 'session.status',
        properties: {
          sessionID: 'ses-1',
          status: { type: 'idle' },
        },
      },
    });

    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(true);
    expect(client.sessionMessages).toHaveBeenCalledTimes(2);
  });

  it('requires actual provider activity before starting a provider-origin turn', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ ctx, client, harness });

    await runtime.handleProviderEvent({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'text',
            sessionID: 'ses-1',
            messageID: 'msg-native-background-wake',
            text: '<task id="ses-background-child" state="completed"><task_result>Done</task_result></task>',
          },
        },
      },
    });
    expect(runtimeEvents.some((event) => event.kind === 'turn-start')).toBe(false);

    await runtime.handleProviderEvent({
      payload: {
        type: 'session.status',
        properties: {
          sessionID: 'ses-1',
          status: { type: 'busy' },
        },
      },
    });
    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'turn-start', startedBy: 'provider' }),
    ]));
    await runtime.handleProviderEvent({
      payload: {
        type: 'session.status',
        properties: {
          sessionID: 'ses-1',
          status: { type: 'idle' },
        },
      },
    });

    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'turn-complete' }),
    ]));
  });

  it('keeps replay-shaped global frames observation-only before turn and tool effects', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ ctx, client, harness });

    expect(client.subscribeGlobalEvents).toHaveBeenCalledTimes(1);

    client.emitProviderEvent({
      payload: {
        type: 'message.part.updated',
        properties: {
          time: Date.now(),
          part: {
            id: 'part-replayed-tool',
            type: 'tool',
            sessionID: 'ses-1',
            messageID: 'msg-replayed-tool',
            callID: 'call-replayed-tool',
            tool: 'task',
            state: {
              status: 'completed',
              input: { background: true },
              output: '<task state="running" id="ses-replayed-child"></task>',
              metadata: { sessionId: 'ses-replayed-child', background: true },
            },
          },
        },
      },
    }, { provenance: 'untrusted-observation', connectionGeneration: 1 });
    client.emitProviderEvent({
      payload: {
        type: 'session.status',
        properties: {
          sessionID: 'ses-1',
          status: { type: 'busy' },
        },
      },
    }, { provenance: 'untrusted-observation', connectionGeneration: 1 });
    client.emitProviderEvent({
      payload: {
        type: 'message.part.delta',
        properties: {
          sessionID: 'ses-1',
          messageID: 'msg-replayed-wake',
          partID: 'part-replayed-wake',
          delta: '<task state="completed" id="ses-replayed-child"><task_result>Done</task_result></task>',
        },
      },
    }, { provenance: 'untrusted-observation', connectionGeneration: 1 });

    await flushMicrotasks();
    expect(runtimeEvents.filter((event) => event.kind !== 'model-catalog-observed' && event.kind !== 'mode-catalog-observed' && event.kind !== 'available-commands')).toEqual([]);

    await runtime.resetOrDisposeRuntime();
  });

  it('projects only exact-current tool work from replayable OpenCode observations', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ ctx, client, harness });
    runtime.beginTurnLifecycle('test-turn');

    const { providerUserMessageId } = await runtime.sendTurnPrompt('run the current task');

    client.emitProviderEvent({
      payload: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg-replayed-assistant',
            parentID: 'msg-old-user',
            role: 'assistant',
            sessionID: 'ses-1',
          },
        },
      },
    }, { provenance: 'untrusted-observation', connectionGeneration: 1 });
    client.emitProviderEvent({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-replayed-tool',
            type: 'tool',
            sessionID: 'ses-1',
            messageID: 'msg-replayed-assistant',
            callID: 'call-replayed-tool',
            tool: 'bash',
            state: {
              status: 'completed',
              input: { command: 'rm -rf /tmp/replayed' },
              output: 'replayed',
            },
          },
        },
      },
    }, { provenance: 'untrusted-observation', connectionGeneration: 1 });

    client.emitProviderEvent({
      payload: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg-current-assistant',
            parentID: providerUserMessageId,
            role: 'assistant',
            sessionID: 'ses-1',
          },
        },
      },
    }, { provenance: 'untrusted-observation', connectionGeneration: 1 });
    client.emitProviderEvent({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-current-tool',
            type: 'tool',
            sessionID: 'ses-1',
            messageID: 'msg-current-assistant',
            callID: 'call-current-tool',
            tool: 'bash',
            state: {
              status: 'completed',
              input: { command: 'pwd' },
              output: '/repo\n',
            },
          },
        },
      },
    }, { provenance: 'untrusted-observation', connectionGeneration: 1 });

    await flushMicrotasks();

    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'tool-call',
        toolCallId: 'call-current-tool',
        toolName: 'bash',
      }),
      expect.objectContaining({
        kind: 'tool-result',
        toolCallId: 'call-current-tool',
      }),
    ]));
    expect(runtimeEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ toolCallId: 'call-replayed-tool' }),
      expect.objectContaining({ kind: 'turn-complete' }),
      expect.objectContaining({ kind: 'turn-failed' }),
    ]));

    await runtime.resetOrDisposeRuntime();
  });

  it('uses replayable request events only to read authoritative active OpenCode inventories', async () => {
    const permissionRequests: unknown[] = [];
    const { ctx, harness } = createContextFixture({
      onPermissionDecision: async (request) => {
        permissionRequests.push(request);
        return { decision: 'approved' };
      },
    });
    const client = createClientFixture();
    vi.mocked(client.permissionList).mockResolvedValueOnce([{
      id: 'per-authoritative',
      sessionID: 'ses-1',
      permission: 'edit',
      patterns: ['src/current.ts'],
    }]);
    vi.mocked(client.questionList).mockResolvedValueOnce([{
      id: 'question-authoritative',
      sessionID: 'ses-1',
      questions: [{
        header: 'Title',
        question: '(internal) Apply the current title?',
        options: [{ label: 'OK' }],
        multiple: false,
      }],
    }]);
    const runtime = await createStartedRuntime({ ctx, client, harness });

    client.emitProviderEvent({
      payload: {
        type: 'permission.asked',
        properties: {
          id: 'per-replayed',
          sessionID: 'ses-1',
          permission: 'bash',
          patterns: ['rm -rf /'],
        },
      },
    }, { provenance: 'untrusted-observation', connectionGeneration: 1 });
    client.emitProviderEvent({
      payload: {
        type: 'question.asked',
        properties: {
          id: 'question-replayed',
          sessionID: 'ses-1',
          questions: [{
            header: 'Replay',
            question: 'Trust replayed content?',
            options: [{ label: 'yes' }],
          }],
        },
      },
    }, { provenance: 'untrusted-observation', connectionGeneration: 1 });

    await expect.poll(() => vi.mocked(client.permissionReply).mock.calls.length).toBe(1);
    await expect.poll(() => vi.mocked(client.questionReply).mock.calls.length).toBe(1);
    expect(client.permissionList).toHaveBeenCalledTimes(1);
    expect(client.questionList).toHaveBeenCalledTimes(1);
    expect(permissionRequests).toEqual([
      expect.objectContaining({
        subject: expect.objectContaining({
          kind: 'tool',
          name: 'edit',
        }),
      }),
    ]);
    expect(client.permissionReply).toHaveBeenCalledWith({
      sessionId: 'ses-1',
      requestId: 'per-authoritative',
      reply: 'once',
    });
    expect(client.questionReply).toHaveBeenCalledWith({
      sessionId: 'ses-1',
      requestId: 'question-authoritative',
      answers: [['OK']],
    });
    expect(JSON.stringify(permissionRequests)).not.toContain('rm -rf /');

    await runtime.resetOrDisposeRuntime();
  });

  it('refreshes authoritative request inventories when the V2 global stream reconnects after a missed ask', async () => {
    const permissionRequests: unknown[] = [];
    const { ctx, harness } = createContextFixture({
      onPermissionDecision: async (request) => {
        permissionRequests.push(request);
        return { decision: 'approved' };
      },
    });
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ ctx, client, harness });
    vi.mocked(client.permissionList).mockResolvedValueOnce([{
      id: 'per-created-during-global-gap',
      sessionID: 'ses-1',
      permission: 'bash',
      patterns: ['pwd'],
    }]);

    client.emitProviderEvent(
      { payload: { type: 'server.connected', properties: {} } },
      { provenance: 'untrusted-observation', connectionGeneration: 2 },
    );

    await expect.poll(() => vi.mocked(client.permissionReply).mock.calls.length).toBe(1);
    expect(client.permissionList).toHaveBeenCalledTimes(1);
    expect(client.questionList).toHaveBeenCalledTimes(1);
    expect(permissionRequests).toEqual([
      expect.objectContaining({
        subject: expect.objectContaining({ kind: 'tool', name: 'bash' }),
      }),
    ]);
    expect(client.permissionReply).toHaveBeenCalledWith({
      sessionId: 'ses-1',
      requestId: 'per-created-during-global-gap',
      reply: 'once',
    });

    await runtime.resetOrDisposeRuntime();
  });

  it('does not infer an autonomous turn from third-party background-task prose', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ ctx, client, harness });

    await runtime.handleProviderEvent({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'text',
            sessionID: 'ses-1',
            messageID: 'msg-omo-background-wake',
            text: [
              '<system-reminder>',
              '[ALL BACKGROUND TASKS COMPLETE]',
              'Use `background_output(task_id="bg_abc123")` to retrieve each result.',
              '</system-reminder>',
              '<!-- OMO_INTERNAL_INITIATOR -->',
            ].join('\n'),
          },
        },
      },
    });
    expect(runtimeEvents.some((event) => event.kind === 'turn-start')).toBe(false);

    await runtime.handleProviderEvent({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            sessionID: 'ses-1',
            callID: 'call-background-output',
            tool: 'background_output',
            state: {
              status: 'completed',
              input: { task_id: 'bg_abc123' },
              output: '# Task Result\n\nResult ready',
              metadata: { backgroundTaskId: 'bg_abc123' },
            },
          },
        },
      },
    });
    await runtime.handleProviderEvent({
      payload: {
        type: 'session.idle',
        properties: { sessionID: 'ses-1' },
      },
    });

    expect(runtimeEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'turn-start' }),
      expect.objectContaining({ kind: 'turn-complete' }),
    ]));
  });

  it('does not expose a canonical Runtime Activity producer subscription', async () => {
    const runtime = await createStartedRuntime({ client: createClientFixture() });

    expect(runtime).not.toHaveProperty('subscribeCanonicalAgentSessionEvents');
  });

  it('keeps OpenCode background-task launch and wake signals out of Runtime Activity truth', async () => {
    const { ctx, harness, stateFieldWrites } = createContextFixture();
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ ctx, client, harness });
    runtime.beginTurnLifecycle('test-turn');
    stateFieldWrites.length = 0;

    await runtime.handleProviderEvent({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-background-task-launch',
            type: 'tool',
            sessionID: 'ses-1',
            messageID: 'msg-background-task-launch',
            callID: 'call-background-task-launch',
            tool: 'task',
            state: {
              status: 'completed',
              input: { description: 'Run in background', background: true },
              output: '<task state="running" id="ses-background-child"></task>',
              metadata: { sessionId: 'ses-background-child', background: true },
            },
          },
        },
      },
    });

    expect(stateFieldWrites).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldId: 'runtime.activity' }),
    ]));

    await runtime.handleProviderEvent({
      payload: {
        type: 'session.idle',
        properties: { sessionID: 'ses-1' },
      },
    });
    await runtime.handleProviderEvent({
      payload: {
        type: 'message.part.delta',
        properties: {
          sessionID: 'ses-1',
          messageID: 'msg-background-task-wake',
          partID: 'part-background-task-wake',
          delta: '<task state="completed" id="ses-background-child"><task_result>Done</task_result></task>',
        },
      },
    });

    expect(stateFieldWrites).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldId: 'runtime.activity' }),
    ]));
  });

  it('does not publish detached runtime activity for foreground-only OpenCode tool work', async () => {
    const { ctx, harness, stateFieldWrites } = createContextFixture();
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ ctx, client, harness });
    runtime.beginTurnLifecycle('test-turn');
    stateFieldWrites.length = 0;

    await runtime.handleProviderEvent({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-foreground-tool',
            type: 'tool',
            sessionID: 'ses-1',
            messageID: 'msg-foreground-tool',
            callID: 'call-foreground-tool',
            tool: 'bash',
            state: {
              status: 'running',
              input: { command: 'npm test' },
              output: '',
            },
          },
        },
      },
    });

    expect(stateFieldWrites).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldId: 'runtime.activity' }),
    ]));
  });

  it('ignores background task events from other OpenCode sessions', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ ctx, client, harness });

    await runtime.handleProviderEvent({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'text',
            sessionID: 'ses-other',
            messageID: 'msg-other-background-wake',
            text: [
              '<system-reminder>',
              '[ALL BACKGROUND TASKS COMPLETE]',
              'Use `background_output(task_id="bg_other")` to retrieve each result.',
              '</system-reminder>',
              '<!-- OMO_INTERNAL_INITIATOR -->',
            ].join('\n'),
          },
        },
      },
    });
    await runtime.handleProviderEvent({
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            sessionID: 'ses-other',
            callID: 'call-other-background-output',
            tool: 'background_output',
            state: {
              status: 'completed',
              input: { task_id: 'bg_other' },
              output: '# Task Result\n\nOther result',
            },
          },
        },
      },
    });
    await runtime.handleProviderEvent({
      payload: {
        type: 'session.status',
        properties: {
          sessionID: 'ses-other',
          status: { type: 'busy' },
        },
      },
    });
    await runtime.handleProviderEvent({
      payload: {
        type: 'session.idle',
        properties: { sessionID: 'ses-other' },
      },
    });

    expect(runtimeEvents.some((event) => event.kind === 'turn-start')).toBe(false);
    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);
  });

  it('fails active turns when OpenCode reports usage-limit retry status from provider events', async () => {
    const { ctx, harness, runtimeEvents, transcriptAppends } = createContextFixture();
    const client = createClientFixture();
    const runtime = await createStartedRuntime({ ctx, client, harness });
    runtime.beginTurnLifecycle('test-turn');

    await expect(runtime.handleProviderEvent({
      payload: {
        type: 'session.status',
        properties: {
          sessionID: 'ses-1',
          status: {
            type: 'retry',
            attempt: 3,
            message: 'The usage limit has been reached',
            next: Date.now() + 60_000,
          },
        },
      },
    })).rejects.toThrow('The usage limit has been reached');

    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
        issue: expect.objectContaining({
          source: 'usage_limit',
          agentId: 'opencode',
          code: 'opencode_session_retry',
          usageLimit: expect.objectContaining({
            quotaScope: 'account',
            recoverability: 'wait',
            resetAtMs: null,
            retryAfterMs: expect.any(Number),
          }),
        }),
      }),
    ]));
    expect(transcriptAppends).toHaveLength(0);
    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'transcript-agent-message-committed',
        agentId: 'opencode',
        body: expect.objectContaining({
          type: 'turn_failed',
        }),
      }),
    ]));
    expect(client.sessionAbort).toHaveBeenCalledOnce();
    expect(client.sessionAbort).toHaveBeenCalledWith({ sessionId: 'ses-1' });
  });

  it('defers a live session.error until exact-parent terminal history follows idle', async () => {
    const { ctx, harness, runtimeEvents, transcriptAppends } = createContextFixture();
    const client = createClientFixture();
    let providerUserMessageId = '';
    vi.mocked(client.sessionPromptImplementation).mockImplementationOnce(async (input) => {
      providerUserMessageId = input.messageId ?? '';
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });
    beginTestHostTurn(runtime);
    await runtime.sendTurnPrompt('hello');

    const providerError = {
      name: 'ProviderAuthError',
      data: {
        message: 'Token refresh failed: 401 Authorization: Bearer sk-live-secret',
      },
    };

    await runtime.handleProviderEvent({
      payload: {
        type: 'session.error',
        properties: {
          sessionID: 'ses-1',
          error: providerError,
        },
      },
    });
    await runtime.handleProviderEvent({
      payload: {
        type: 'session.error',
        properties: { sessionID: 'ses-1', error: providerError },
      },
    });

    expect(runtimeEvents.some((event) => event.kind === 'turn-failed')).toBe(false);

    client.setMessages([
      {
        info: { id: providerUserMessageId, role: 'user', sessionID: 'ses-1', time: { created: 10 } },
        parts: [{ id: 'part-current-user', type: 'text', text: 'hello' }],
      },
      {
        info: {
          id: 'msg-current-provider-error',
          role: 'assistant',
          sessionID: 'ses-1',
          parentID: providerUserMessageId,
          time: { created: 11 },
          error: providerError,
        },
        parts: [],
      },
    ]);
    await runtime.handleProviderEvent({
      payload: {
        type: 'session.idle',
        properties: { sessionID: 'ses-1' },
      },
    });

    expect(runtimeEvents.some((event) => event.kind === 'turn-failed')).toBe(false);

    client.setMessages([
      {
        info: { id: providerUserMessageId, role: 'user', sessionID: 'ses-1', time: { created: 10 } },
        parts: [{ id: 'part-current-user', type: 'text', text: 'hello' }],
      },
      {
        info: {
          id: 'msg-current-provider-error',
          role: 'assistant',
          sessionID: 'ses-1',
          parentID: providerUserMessageId,
          time: { created: 11, completed: 12 },
          error: providerError,
        },
        parts: [],
      },
    ]);
    await runtime.handleProviderEvent({
      payload: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg-current-provider-error',
            role: 'assistant',
            sessionID: 'ses-1',
            parentID: providerUserMessageId,
            time: { created: 11, completed: 12 },
            error: providerError,
          },
        },
      },
    });

    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
        issue: expect.objectContaining({
          agentId: 'opencode',
          code: 'opencode_provider_session_error',
          source: 'auth_error',
          sanitizedPreview: expect.stringContaining('Token refresh failed: 401'),
        }),
      }),
      expect.objectContaining({
        kind: 'transcript-agent-message-committed',
        agentId: 'opencode',
        body: expect.objectContaining({
          type: 'turn_failed',
        }),
      }),
    ]));
    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);
    expect(JSON.stringify(runtimeEvents)).not.toContain('sk-live-secret');
    expect(transcriptAppends).toHaveLength(0);
  });

  it('does not let an uncorrelated live session.error override a valid current assistant completion', async () => {
    const { ctx, harness, runtimeEvents } = createContextFixture();
    const client = createClientFixture();
    let providerUserMessageId = '';
    vi.mocked(client.sessionPromptImplementation).mockImplementationOnce(async (input) => {
      providerUserMessageId = input.messageId ?? '';
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });
    beginTestHostTurn(runtime);
    await runtime.sendTurnPrompt('hello');

    await runtime.handleProviderEvent({
      payload: {
        type: 'session.error',
        properties: {
          sessionID: 'ses-1',
          error: { name: 'UnknownError', data: { message: 'failure from another author' } },
        },
      },
    });
    expect(runtimeEvents.some((event) => event.kind === 'turn-failed')).toBe(false);

    client.setMessages([
      {
        info: { id: providerUserMessageId, role: 'user', sessionID: 'ses-1', time: { created: 10 } },
        parts: [{ id: 'part-current-user', type: 'text', text: 'hello' }],
      },
      {
        info: {
          id: 'msg-current-success',
          role: 'assistant',
          sessionID: 'ses-1',
          parentID: providerUserMessageId,
          time: { created: 11, completed: 12 },
          finish: 'stop',
        },
        parts: [{ id: 'part-current-success', type: 'text', text: 'ok' }],
      },
    ]);
    await runtime.handleProviderEvent({
      payload: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg-current-success',
            role: 'assistant',
            sessionID: 'ses-1',
            parentID: providerUserMessageId,
            time: { created: 11, completed: 12 },
            finish: 'stop',
          },
        },
      },
    });
    await runtime.handleProviderEvent({
      payload: { type: 'session.idle', properties: { sessionID: 'ses-1' } },
    });

    expect(runtimeEvents.filter((event) => event.kind === 'turn-complete')).toHaveLength(1);
    expect(runtimeEvents.some((event) => event.kind === 'turn-failed')).toBe(false);
  });

  it('publishes a provider session failure once when provider event and status polling race', async () => {
    const { ctx, harness, runtimeEvents, transcriptAppends } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.sessionStatus).mockResolvedValue({
      type: 'error',
      error: {
        name: 'ProviderAuthError',
        data: {
          message: 'Token refresh failed: 401 Authorization: Bearer sk-live-secret',
        },
      },
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });
    runtime.beginTurnLifecycle('test-turn');

    await Promise.all([
      runtime.handleProviderEvent({
        payload: {
          type: 'session.error',
          properties: {
            sessionID: 'ses-1',
            error: {
              name: 'ProviderAuthError',
              data: {
                message: 'Token refresh failed: 401 Authorization: Bearer sk-live-secret',
              },
            },
          },
        },
      }),
      runtime.waitForTurnCompletion(),
    ]);

    expect(runtimeEvents.filter((event) => event.kind === 'turn-failed')).toHaveLength(1);
    expect(runtimeEvents.filter((event) => (
      event.kind === 'transcript-agent-message-committed'
      && event.agentId === 'opencode'
      && event.body.type === 'turn_failed'
    ))).toHaveLength(1);
    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);
    expect(JSON.stringify(runtimeEvents)).not.toContain('sk-live-secret');
    expect(transcriptAppends).toHaveLength(0);
  });

  it('fails active turns when status polling reports a provider session error', async () => {
    const { ctx, harness, runtimeEvents, transcriptAppends } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.sessionStatus).mockResolvedValue({
      type: 'error',
      error: {
        name: 'ProviderAuthError',
        data: {
          message: 'Token refresh failed: 401 Authorization: Bearer sk-live-secret',
        },
      },
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });
    runtime.beginTurnLifecycle('test-turn');

    await runtime.waitForTurnCompletion();

    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
        issue: expect.objectContaining({
          agentId: 'opencode',
          code: 'opencode_provider_session_error',
          source: 'auth_error',
          sanitizedPreview: expect.stringContaining('Token refresh failed: 401'),
        }),
      }),
      expect.objectContaining({
        kind: 'transcript-agent-message-committed',
        agentId: 'opencode',
        body: expect.objectContaining({
          type: 'turn_failed',
        }),
      }),
    ]));
    expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);
    expect(JSON.stringify(runtimeEvents)).not.toContain('sk-live-secret');
    expect(transcriptAppends).toHaveLength(0);
  });

  it('fails active turns when control-plane status polling reports usage-limit retry', async () => {
    const { ctx, harness, runtimeEvents, transcriptAppends } = createContextFixture();
    const client = createClientFixture();
    vi.mocked(client.sessionStatus).mockResolvedValue({
      type: 'retry',
      attempt: 4,
      message: 'Quota limit reached for this account',
      next: Date.now() + 60_000,
    });
    const runtime = await createStartedRuntime({ ctx, client, harness });
    runtime.beginTurnLifecycle('test-turn');

    await expect(runtime.waitForTurnCompletion()).rejects.toThrow('Quota limit reached for this account');

    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'turn-failed',
        issue: expect.objectContaining({
          source: 'usage_limit',
          agentId: 'opencode',
          code: 'opencode_session_retry',
          usageLimit: expect.objectContaining({
            limitCategory: 'usage_limit',
          }),
        }),
      }),
    ]));
    expect(transcriptAppends).toHaveLength(0);
    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'transcript-agent-message-committed',
        agentId: 'opencode',
        body: expect.objectContaining({
          type: 'turn_failed',
        }),
      }),
    ]));
    expect(client.sessionAbort).toHaveBeenCalledOnce();
    expect(client.sessionAbort).toHaveBeenCalledWith({ sessionId: 'ses-1' });
  });

  describe('exact managed-service handle loss recovery (Lane E)', () => {
    function serviceSnapshot(
      overrides: Partial<ManagedServiceSnapshot>,
    ): ManagedServiceSnapshot {
      return managedServiceSnapshot(overrides);
    }

    function runningToolPart(callId: string) {
      return {
        id: `part-${callId}`,
        type: 'tool',
        sessionID: 'ses-1',
        messageID: `msg-${callId}`,
        callID: callId,
        tool: 'bash',
        state: { status: 'running' },
      };
    }

    it('fails the active turn exactly once when the managed service is lost with unreconciled tool work', async () => {
      const { ctx, harness, runtimeEvents } = createContextFixture();
      const client = createClientFixture();
      // Durable history still shows the tool running → unreconciled live-known work.
      client.setMessages([
        { info: { id: 'msg-call-live-1', role: 'assistant', sessionID: 'ses-1' }, parts: [runningToolPart('call-live-1')] },
      ]);
      let snapshot = serviceSnapshot({});
      const runtime = await createStartedRuntime({
        ctx,
        client,
        harness,
        readManagedServiceSnapshot: () => snapshot,
      });
      runtime.beginTurnLifecycle('test-turn');
      // Observe live running tool work while the exact handle is healthy.
      await runtime.handleProviderEvent({
        payload: { type: 'message.part.updated', properties: { part: runningToolPart('call-live-1') } },
      });

      snapshot = serviceSnapshot({ state: 'stopped' });
      await runtime.waitForTurnCompletion();
      await runtime.waitForTurnCompletion();

      const restartFailures = runtimeEvents.filter(
        (event) => event.kind === 'turn-failed'
          && (event as { issue?: { code?: string } }).issue?.code === 'opencode_server_restarted_during_turn',
      );
      expect(restartFailures).toHaveLength(1);
      expect(restartFailures[0]).toEqual(expect.objectContaining({
        issue: expect.objectContaining({
          agentId: 'opencode',
          code: 'opencode_server_restarted_during_turn',
          source: 'stream_error',
        }),
      }));
      // No prompt replay, no abort.
      expect(client.sessionPromptAsync).not.toHaveBeenCalled();
      expect(client.sessionAbort).not.toHaveBeenCalled();
    });

    it('does not fail the turn when durable history reconciles the tool as terminal after handle loss', async () => {
      const { ctx, harness, runtimeEvents } = createContextFixture();
      const client = createClientFixture();
      let snapshot = serviceSnapshot({});
      const runtime = await createStartedRuntime({
        ctx,
        client,
        harness,
        readManagedServiceSnapshot: () => snapshot,
      });
      runtime.beginTurnLifecycle('test-turn');
      await runtime.handleProviderEvent({
        payload: { type: 'message.part.updated', properties: { part: runningToolPart('call-live-2') } },
      });

      // Durable history shows the tool COMPLETED (reconciled terminal).
      client.setMessages([
        {
          info: { id: 'msg-call-live-2', role: 'assistant', sessionID: 'ses-1' },
          parts: [{ ...runningToolPart('call-live-2'), state: { status: 'completed' } }],
        },
      ]);
      snapshot = serviceSnapshot({ state: 'stopped' });
      await runtime.waitForTurnCompletion();

      expect(runtimeEvents.some(
        (event) => event.kind === 'turn-failed'
          && (event as { issue?: { code?: string } }).issue?.code === 'opencode_server_restarted_during_turn',
      )).toBe(false);
    });

    it('does not wedge: orphaned work from the lost handle reaches a terminal turn state', async () => {
      const { ctx, harness, runtimeEvents } = createContextFixture();
      const client = createClientFixture();
      let snapshot = serviceSnapshot({});
      const runtime = await createStartedRuntime({
        ctx,
        client,
        harness,
        readManagedServiceSnapshot: () => snapshot,
      });
      runtime.beginTurnLifecycle('test-turn');
      // Live running tool tracked while the exact handle is healthy.
      await runtime.handleProviderEvent({
        payload: { type: 'message.part.updated', properties: { part: runningToolPart('call-orphan') } },
      });
      // History is empty (the orphaned tool is gone), so it cannot be reconciled
      // terminal and remains as unreconciled live-known work → the supervisor fails the turn once
      // rather than letting orphaned work wedge completion forever.
      client.setMessages([]);
      snapshot = serviceSnapshot({ state: 'stopped' });

      await runtime.waitForTurnCompletion();
      await runtime.waitForTurnCompletion();

      const terminal = runtimeEvents.filter(
        (event) => event.kind === 'turn-failed' || event.kind === 'turn-complete',
      );
      expect(terminal.length).toBeGreaterThanOrEqual(1);
      expect(runtimeEvents.some(
        (event) => event.kind === 'turn-failed'
          && (event as { issue?: { code?: string } }).issue?.code === 'opencode_server_restarted_during_turn',
      )).toBe(true);
    });

    it('fails the active turn when the managed service is lost while a permission ask is pending', async () => {
      let resolvePermissionDecision: ((value: { decision: 'approved' }) => void) | null = null;
      let permissionResolved = false;
      const pendingPermissionDecision = new Promise<{ decision: 'approved' }>((resolve) => {
        resolvePermissionDecision = (value) => {
          permissionResolved = true;
          resolve(value);
        };
      });
      const { ctx, harness, runtimeEvents } = createContextFixture({
        onPermissionDecision: async () => await pendingPermissionDecision,
      });
      const client = createClientFixture();
      let snapshot = serviceSnapshot({});
      const runtime = await createStartedRuntime({
        ctx,
        client,
        harness,
        readManagedServiceSnapshot: () => snapshot,
      });
      await runtime.handleProviderEvent({ payload: { type: 'server.connected', properties: {} } });

      beginTestHostTurn(runtime);
      await runtime.sendTurnPrompt('hello');
      const permissionAsk = runtime.handleProviderEvent({
        payload: {
          type: 'permission.asked',
          properties: {
            sessionID: 'ses-1',
            id: 'per_generation_replaced',
            permission: 'bash',
            patterns: ['pwd'],
          },
        },
      });
      void permissionAsk.catch(() => undefined);
      await Promise.resolve();

      try {
        snapshot = serviceSnapshot({ state: 'stopped' });

        await runtime.waitForTurnCompletion();

        expect(runtimeEvents).toEqual(expect.arrayContaining([
          expect.objectContaining({
            kind: 'turn-failed',
            issue: expect.objectContaining({
              agentId: 'opencode',
              code: 'opencode_server_restarted_during_turn',
              source: 'stream_error',
            }),
          }),
        ]));
        expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(false);
      } finally {
        if (!permissionResolved) {
          resolvePermissionDecision?.({ decision: 'approved' });
          await permissionAsk;
        }
      }
    });

    it('drops stale permission decisions after the original turn is failed and a new turn starts', async () => {
      let resolvePermissionDecision: ((value: { decision: 'approved' }) => void) | null = null;
      const pendingPermissionDecision = new Promise<{ decision: 'approved' }>((resolve) => {
        resolvePermissionDecision = resolve;
      });
      const { ctx, harness, runtimeEvents } = createContextFixture({
        onPermissionDecision: async () => await pendingPermissionDecision,
      });
      const client = createClientFixture();
      let snapshot = serviceSnapshot({});
      const runtime = await createStartedRuntime({
        ctx,
        client,
        harness,
        readManagedServiceSnapshot: () => snapshot,
      });
      await runtime.handleProviderEvent({ payload: { type: 'server.connected', properties: {} } });

      beginTestHostTurn(runtime);
      await runtime.sendTurnPrompt('hello');
      const stalePermissionAsk = runtime.handleProviderEvent({
        payload: {
          type: 'permission.asked',
          properties: {
            sessionID: 'ses-1',
            id: 'per_stale_after_restart',
            permission: 'bash',
            patterns: ['pwd'],
          },
        },
      });
      void stalePermissionAsk.catch(() => undefined);
      await Promise.resolve();

      snapshot = serviceSnapshot({ state: 'stopped' });
      await runtime.waitForTurnCompletion();
      beginTestHostTurn(runtime);

      resolvePermissionDecision?.({ decision: 'approved' });
      await stalePermissionAsk;

      expect(client.permissionReply).not.toHaveBeenCalled();
      expect(runtimeEvents.filter((event) => event.kind === 'turn-failed')).toHaveLength(1);
      expect(runtimeEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'turn-failed',
          issue: expect.objectContaining({
            code: 'opencode_server_restarted_during_turn',
          }),
        }),
      ]));
    });

    it('lets the exact handle reject a permission reply when loss precedes observation', async () => {
      let resolvePermissionDecision: ((value: { decision: 'approved' }) => void) | null = null;
      const pendingPermissionDecision = new Promise<{ decision: 'approved' }>((resolve) => {
        resolvePermissionDecision = resolve;
      });
      const { ctx, harness, runtimeEvents } = createContextFixture({
        onPermissionDecision: async () => await pendingPermissionDecision,
      });
      const client = createClientFixture();
      let snapshot = serviceSnapshot({});
      const runtime = await createStartedRuntime({
        ctx,
        client,
        harness,
        readManagedServiceSnapshot: () => snapshot,
      });
      await runtime.handleProviderEvent({ payload: { type: 'server.connected', properties: {} } });

      beginTestHostTurn(runtime);
      await runtime.sendTurnPrompt('hello');
      const stalePermissionAsk = runtime.handleProviderEvent({
        payload: {
          type: 'permission.asked',
          properties: {
            sessionID: 'ses-1',
            id: 'per_stale_before_observe',
            permission: 'bash',
            patterns: ['pwd'],
          },
        },
      });
      void stalePermissionAsk.catch(() => undefined);
      await Promise.resolve();

      snapshot = serviceSnapshot({ state: 'stopped' });
      vi.mocked(client.permissionReply).mockRejectedValueOnce(
        new Error('plugin_managed_service_not_reusable'),
      );
      resolvePermissionDecision?.({ decision: 'approved' });
      await stalePermissionAsk;

      expect(client.permissionReply).toHaveBeenCalledOnce();

      await runtime.waitForTurnCompletion();

      expect(runtimeEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'turn-failed',
          issue: expect.objectContaining({
            code: 'opencode_provider_session_error',
          }),
        }),
      ]));
    });
  });

  describe('origin-agnostic transcript projection (Lane H / S2)', () => {
    function externalUserMessage(messageId: string, text: string, createdAtMs: number) {
      return {
        info: { id: messageId, role: 'user', sessionID: 'ses-1', time: { created: createdAtMs } },
        parts: [{ id: `${messageId}-part`, type: 'text', text }],
      };
    }

    function providerUserMessageWithCreatedAtMs(messageId: string, text: string, createdAtMs: number) {
      return {
        info: { id: messageId, role: 'user', sessionID: 'ses-1', createdAtMs },
        parts: [{ id: `${messageId}-part`, type: 'text', text }],
      };
    }

    function externalTerminalAssistantMessage(messageId: string, text: string, completedAtMs: number) {
      return {
        info: {
          id: messageId,
          role: 'assistant',
          sessionID: 'ses-1',
          finish: 'stop',
          time: { created: completedAtMs - 10, completed: completedAtMs },
        },
        parts: [{ id: `${messageId}-part`, type: 'text', text }],
      };
    }

    function userTextEvents(events: readonly OpenCodeRuntimeEvent[]): OpenCodeRuntimeEvent[] {
      return events.filter((event) => event.kind === 'transcript-user-text');
    }

    function committedAssistantEvents(events: readonly OpenCodeRuntimeEvent[]): OpenCodeRuntimeEvent[] {
      return events.filter((event) => event.kind === 'transcript-agent-message-committed'
        && (event as { body?: { type?: string } }).body?.type === 'message');
    }

    it.each([
      ['prompt-stack wrapper', '[analyze-mode]\nHappier system prompt...\nUser request: RUQA_PROMPT_STACK'],
      ['plain provider prompt', 'RUQA plain dispatched prompt'],
    ])('does not passively mirror a delayed Happier-authored %s user row after turn completion', async (_label, prompt) => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      const { ctx, harness, runtimeEvents } = createContextFixture();
      const client = createClientFixture();
      const runtime = await createStartedRuntime({ ctx, client, harness });

      beginTestHostTurn(runtime);
      const { providerUserMessageId } = await runtime.sendTurnPrompt(prompt);
      await runtime.handleProviderEvent({
        payload: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'msg-authored-assistant-part',
              messageID: 'msg-authored-assistant',
              type: 'text',
              text: 'AUTHORED_ASSISTANT_OK',
            },
          },
        },
      });
      client.setMessages([
        {
          ...externalTerminalAssistantMessage('msg-authored-assistant', 'AUTHORED_ASSISTANT_OK', 11_000),
          info: {
            ...externalTerminalAssistantMessage('msg-authored-assistant', 'AUTHORED_ASSISTANT_OK', 11_000).info,
            parentID: providerUserMessageId,
          },
        },
      ]);
      vi.setSystemTime(11_000);
      await runtime.handleProviderEvent({ payload: { type: 'session.idle', properties: {} } });

      expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(true);
      expect(committedAssistantEvents(runtimeEvents)).toHaveLength(1);
      expect(userTextEvents(runtimeEvents)).toHaveLength(0);

      client.setMessages([
        providerUserMessageWithCreatedAtMs('msg-delayed-authored-user', prompt, 10_001),
        {
          ...externalTerminalAssistantMessage('msg-authored-assistant', 'AUTHORED_ASSISTANT_OK', 11_000),
          info: {
            ...externalTerminalAssistantMessage('msg-authored-assistant', 'AUTHORED_ASSISTANT_OK', 11_000).info,
            parentID: providerUserMessageId,
          },
        },
      ]);
      await runtime.handleProviderEvent({ payload: { type: 'server.connected', properties: {} } });

      expect(userTextEvents(runtimeEvents)).toHaveLength(0);
      expect(committedAssistantEvents(runtimeEvents)).toHaveLength(1);
    });

    it('does not passively mirror delayed OpenCode prompt-stack rows that wrap a Happier-authored prompt', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(20_000);
      const { ctx, harness, runtimeEvents } = createContextFixture();
      const client = createClientFixture();
      const runtime = await createStartedRuntime({ ctx, client, harness });
      const prompt = 'Reply exactly: RUQA_PROMPT_STACK_WRAPPED';

      beginTestHostTurn(runtime);
      const { providerUserMessageId } = await runtime.sendTurnPrompt(prompt);
      await runtime.handleProviderEvent({
        payload: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'msg-wrapped-assistant-part',
              messageID: 'msg-wrapped-assistant',
              type: 'text',
              text: 'RUQA_PROMPT_STACK_WRAPPED',
            },
          },
        },
      });
      client.setMessages([
        {
          ...externalTerminalAssistantMessage('msg-wrapped-assistant', 'RUQA_PROMPT_STACK_WRAPPED', 21_000),
          info: {
            ...externalTerminalAssistantMessage('msg-wrapped-assistant', 'RUQA_PROMPT_STACK_WRAPPED', 21_000).info,
            parentID: providerUserMessageId,
          },
        },
      ]);
      vi.setSystemTime(21_000);
      await runtime.handleProviderEvent({ payload: { type: 'session.idle', properties: {} } });

      expect(runtimeEvents.some((event) => event.kind === 'turn-complete')).toBe(true);
      expect(userTextEvents(runtimeEvents)).toHaveLength(0);
      expect(committedAssistantEvents(runtimeEvents)).toHaveLength(1);

      client.setMessages([
        providerUserMessageWithCreatedAtMs(
          'msg-delayed-wrapped-authored-user',
          [
            '[analyze-mode]',
            'ANALYSIS MODE. Gather context before diving deep.',
            'Session title',
            'Options',
            `User request: ${prompt}`,
            'Linked workspace files',
          ].join('\n'),
          20_001,
        ),
        providerUserMessageWithCreatedAtMs(
          'msg-delayed-wrapped-authored-user-2',
          [
            '[search-mode]',
            'Session title',
            'Attachments',
            `User request: ${prompt}`,
          ].join('\n'),
          20_002,
        ),
        {
          ...externalTerminalAssistantMessage('msg-wrapped-assistant', 'RUQA_PROMPT_STACK_WRAPPED', 21_000),
          info: {
            ...externalTerminalAssistantMessage('msg-wrapped-assistant', 'RUQA_PROMPT_STACK_WRAPPED', 21_000).info,
            parentID: providerUserMessageId,
          },
        },
      ]);
      await runtime.handleProviderEvent({ payload: { type: 'server.connected', properties: {} } });

      expect(userTextEvents(runtimeEvents)).toHaveLength(0);
      expect(committedAssistantEvents(runtimeEvents)).toHaveLength(1);
    });

    it('mirrors settled TUI-authored user + assistant messages into the transcript when no Happier turn is active', async () => {
      const { ctx, harness, runtimeEvents } = createContextFixture();
      const client = createClientFixture();
      client.setMessages([
        externalUserMessage('msg-ext-user', 'a question typed in the OpenCode TUI', 1_000),
        externalTerminalAssistantMessage('msg-ext-assistant', 'TUI_ANSWER_OK', 2_000),
      ]);
      const runtime = await createStartedRuntime({ ctx, client, harness });

      // No Happier turn in flight: a server.connected catch-up mirrors the external turn.
      await runtime.handleProviderEvent({ payload: { type: 'server.connected', properties: {} } });

      const userEvents = userTextEvents(runtimeEvents);
      const assistantEvents = committedAssistantEvents(runtimeEvents);
      expect(userEvents).toHaveLength(1);
      expect((userEvents[0] as { text?: string }).text).toContain('a question typed in the OpenCode TUI');
      expect(assistantEvents).toHaveLength(1);
      expect((assistantEvents[0] as { body?: { message?: string } }).body?.message).toBe('TUI_ANSWER_OK');
      // Mirror-only: never re-enqueued back to OpenCode.
      expect(client.sessionPromptAsync).not.toHaveBeenCalled();
      // No turn lifecycle is fabricated for the external turn.
      expect(runtimeEvents.some((event) => event.kind === 'turn-start')).toBe(false);
    });

    it('does not passively mirror late assistant messages from a Happier-authored turn that already failed', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const { ctx, harness, runtimeEvents } = createContextFixture();
      const client = createClientFixture();
      const runtime = await createStartedRuntime({ ctx, client, harness });
      const prompt = 'RUQA late assistant should stay quarantined';
      const authoredProviderUser = externalUserMessage('msg-late-authored-user', prompt, 1_000);

      beginTestHostTurn(runtime);
      await runtime.sendTurnPrompt(prompt);
      client.setMessages([authoredProviderUser]);
      await runtime.waitForTurnCompletion();

      expect(runtimeEvents.some((event) => event.kind === 'turn-failed')).toBe(false);
      expect(committedAssistantEvents(runtimeEvents)).toHaveLength(0);

      vi.setSystemTime(61_001);
      await runtime.waitForTurnCompletion();

      expect(runtimeEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'turn-failed',
          issue: expect.objectContaining({
            agentId: 'opencode',
            code: 'opencode_empty_provider_response',
          }),
        }),
      ]));
      expect(committedAssistantEvents(runtimeEvents)).toHaveLength(0);

      client.setMessages([
        authoredProviderUser,
        externalTerminalAssistantMessage('msg-late-authored-assistant', 'LATE_ASSISTANT_MUST_NOT_MIRROR', 62_000),
      ]);
      vi.setSystemTime(62_000);
      await runtime.handleProviderEvent({ payload: { type: 'session.idle', properties: { sessionID: 'ses-1' } } });

      expect(userTextEvents(runtimeEvents)).toHaveLength(0);
      expect(committedAssistantEvents(runtimeEvents)).toHaveLength(0);
      expect(JSON.stringify(runtimeEvents)).not.toContain('LATE_ASSISTANT_MUST_NOT_MIRROR');
    });

    it('is idempotent: re-triggering the passive projection does not duplicate mirrored messages', async () => {
      const { ctx, harness, runtimeEvents } = createContextFixture();
      const client = createClientFixture();
      client.setMessages([
        externalUserMessage('msg-ext-user-2', 'second TUI question', 3_000),
        externalTerminalAssistantMessage('msg-ext-assistant-2', 'SECOND_ANSWER', 4_000),
      ]);
      const runtime = await createStartedRuntime({ ctx, client, harness });

      await runtime.handleProviderEvent({ payload: { type: 'server.connected', properties: {} } });
      await runtime.handleProviderEvent({ payload: { type: 'server.connected', properties: {} } });

      expect(userTextEvents(runtimeEvents)).toHaveLength(1);
      expect(committedAssistantEvents(runtimeEvents)).toHaveLength(1);
    });

    it('keeps external-user dedupe scoped to the active provider session', async () => {
      const { ctx, harness, runtimeEvents } = createContextFixture();
      const client = createClientFixture();
      vi.mocked(client.sessionCreate)
        .mockResolvedValueOnce({ id: 'provider-session-1' })
        .mockResolvedValueOnce({ id: 'provider-session-2' });
      client.setMessages([
        externalUserMessage('msg-colliding-user', 'first provider-session TUI question', 3_000),
      ]);
      const runtime = await createStartedRuntime({ ctx, client, harness });

      await runtime.handleProviderEvent({ payload: { type: 'server.connected', properties: {} } });
      client.setMessages([
        externalUserMessage('msg-colliding-user', 'second provider-session TUI question', 4_000),
      ]);
      await runtime.openSession({ kind: 'create' });
      await runtime.handleProviderEvent({ payload: { type: 'server.connected', properties: {} } });

      const mirroredUserEvents = userTextEvents(runtimeEvents);
      expect(mirroredUserEvents.map((event) => (event as { text?: string }).text)).toEqual([
        'first provider-session TUI question',
        'second provider-session TUI question',
      ]);
      expect(mirroredUserEvents.map((event) => event.localId)).toEqual([
        'opencode:provider-session-1:msg-colliding-user',
        'opencode:provider-session-2:msg-colliding-user',
      ]);
    });

    it('does not mirror in-progress (non-terminal) assistant messages', async () => {
      const { ctx, harness, runtimeEvents } = createContextFixture();
      const client = createClientFixture();
      client.setMessages([
        externalUserMessage('msg-ext-user-3', 'streaming question', 5_000),
        // No `time.completed` → non-terminal assistant; must not be committed.
        {
          info: { id: 'msg-ext-assistant-3', role: 'assistant', sessionID: 'ses-1' },
          parts: [{ id: 'p3', type: 'text', text: 'partial in-progress text' }],
        },
      ]);
      const runtime = await createStartedRuntime({ ctx, client, harness });

      await runtime.handleProviderEvent({ payload: { type: 'server.connected', properties: {} } });

      // The settled user message mirrors; the in-progress assistant text does not.
      expect(userTextEvents(runtimeEvents)).toHaveLength(1);
      expect(committedAssistantEvents(runtimeEvents)).toHaveLength(0);
    });

    it('does not run the passive projection while a Happier turn is in flight (live path owns it)', async () => {
      const { ctx, harness, runtimeEvents } = createContextFixture();
      const client = createClientFixture();
      client.setMessages([
        externalUserMessage('msg-live-user', 'unrelated history user row', 6_000),
      ]);
      const runtime = await createStartedRuntime({ ctx, client, harness });
      runtime.beginTurnLifecycle('test-turn');

      // server.connected during an active turn must NOT passively mirror unrelated history rows.
      await runtime.handleProviderEvent({ payload: { type: 'server.connected', properties: {} } });

      expect(userTextEvents(runtimeEvents)).toHaveLength(0);
    });

    it('does not reimport old Happier-authored provider user rows after many authored turns and runtime recreation', async () => {
      const { ctx, harness, runtimeEvents } = createContextFixture();
      const client = createClientFixture();
      vi.useFakeTimers();
      vi.mocked(client.sessionCreate)
        .mockResolvedValueOnce({ id: 'provider-session-long' })
        .mockResolvedValueOnce({ id: 'provider-session-long' });
      client.setMessages([]);
      const runtime = await createStartedRuntime({ ctx, client, harness });
      const authoredMessages: Array<ReturnType<typeof externalUserMessage>> = [];

      for (let index = 0; index < 4097; index += 1) {
        const prompt = `host authored prompt ${index}`;
        const submittedAtMs = 10_000 + (index * 100_000);
        const message = externalUserMessage(`msg-authored-${index}`, prompt, submittedAtMs);
        authoredMessages.push(message);
        vi.setSystemTime(submittedAtMs);
        client.setMessages([message]);
        client.suppressNextNativePromptPersistence();
        beginTestHostTurn(runtime);
        await runtime.sendTurnPrompt(prompt);
        vi.setSystemTime(submittedAtMs + 61_001);
        await runtime.waitForTurnCompletion();
      }

      await runtime.resetOrDisposeRuntime();
      const eventCountBeforeRecreate = runtimeEvents.length;
      client.setMessages(authoredMessages);
      const recreated = await createStartedRuntime({ ctx, client, harness });

      await recreated.handleProviderEvent({ payload: { type: 'server.connected', properties: {} } });

      const recreatedEvents = runtimeEvents.slice(eventCountBeforeRecreate);
      expect(userTextEvents(recreatedEvents)).toHaveLength(0);
    }, 15_000);
  });
});

/**
 * Bytes OpenCode minted. Surrounding whitespace, the embedded newline and the
 * `/`, `+`, `=` punctuation are part of the identity, and every hop between the
 * host and the provider hands the value straight back, so no hop may re-mint it.
 */
const PROVIDER_MINTED_SESSION_ID = '  provider\nses/AB+cd==  ';
const PROVIDER_MINTED_PARENT_SESSION_ID = '  provider\nses/parent+cd==  ';
const PROVIDER_MINTED_CHECKPOINT_MESSAGE_ID = '  provider\nmsg/AB+cd==  ';

describe('OpenCode provider-minted session identity', () => {
  it('resumes, publishes and addresses events with the exact provider session bytes', async () => {
    const { ctx, stateFieldWrites } = createContextFixture();
    const client = createClientFixture();
    const runtime = createOpenCodeServerRuntime({
      ctx,
      directory: '/repo',
      happierSessionId: 'happy-resume-exact',
      baseUrl: 'http://127.0.0.1:49196',
      client,
      mcpRegistration: readyMcpRegistration,
      mcpProjection: emptyMcpProjection,
    });

    await expect(runtime.openSession({
      kind: 'resume',
      providerSessionId: PROVIDER_MINTED_SESSION_ID,
    })).resolves.toBe(PROVIDER_MINTED_SESSION_ID);

    expect(runtime.readSessionIdentity()).toEqual({ sessionId: PROVIDER_MINTED_SESSION_ID });
    expect(stateFieldWrites).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fieldId: 'identity.providerSessionId',
        value: {
          metadataKey: 'opencodeSessionId',
          value: PROVIDER_MINTED_SESSION_ID,
        },
      }),
    ]));
    expect(client.sessionCreate).not.toHaveBeenCalled();
    expect(client.sessionFork).not.toHaveBeenCalled();

    await runtime.handleProviderEvent({
      payload: {
        type: 'todo.updated',
        properties: { sessionID: PROVIDER_MINTED_SESSION_ID },
      },
    });

    expect(client.sessionTodo).toHaveBeenCalledWith({ sessionId: PROVIDER_MINTED_SESSION_ID });
  });

  it('refuses a whitespace-only resume id instead of opening a blank provider session', async () => {
    const { ctx } = createContextFixture();
    const client = createClientFixture();
    const runtime = createOpenCodeServerRuntime({
      ctx,
      directory: '/repo',
      happierSessionId: 'happy-resume-blank',
      baseUrl: 'http://127.0.0.1:49196',
      client,
      mcpRegistration: readyMcpRegistration,
      mcpProjection: emptyMcpProjection,
    });

    await expect(runtime.openSession({
      kind: 'resume',
      providerSessionId: '  \n ',
    })).rejects.toThrow('OpenCode session open did not produce a provider session id');

    expect(client.sessionCreate).not.toHaveBeenCalled();
    expect(client.sessionFork).not.toHaveBeenCalled();
  });

  it('forks from the exact parent and checkpoint bytes and adopts the exact child id', async () => {
    const { ctx } = createContextFixture();
    const client = createClientFixture();
    (client.sessionFork as Mock<OpenCodeServerClient['sessionFork']>)
      .mockResolvedValue({ id: PROVIDER_MINTED_SESSION_ID });
    const runtime = createOpenCodeServerRuntime({
      ctx,
      directory: '/repo',
      happierSessionId: 'happy-fork-exact',
      baseUrl: 'http://127.0.0.1:49196',
      client,
      mcpRegistration: readyMcpRegistration,
      mcpProjection: emptyMcpProjection,
    });

    await expect(runtime.openSession({
      kind: 'fork',
      source: {
        providerSessionId: PROVIDER_MINTED_PARENT_SESSION_ID,
        providerCheckpoint: {
          kind: 'opencode_exclusive_message_id',
          messageId: PROVIDER_MINTED_CHECKPOINT_MESSAGE_ID,
        },
      },
    })).resolves.toBe(PROVIDER_MINTED_SESSION_ID);

    expect(client.sessionFork).toHaveBeenCalledWith({
      sessionId: PROVIDER_MINTED_PARENT_SESSION_ID,
      messageId: PROVIDER_MINTED_CHECKPOINT_MESSAGE_ID,
    });
    expect(runtime.readSessionIdentity()).toEqual({ sessionId: PROVIDER_MINTED_SESSION_ID });
  });

  it('refuses a whitespace-only fork parent rather than forking a blank identity', async () => {
    const { ctx } = createContextFixture();
    const client = createClientFixture();
    const runtime = createOpenCodeServerRuntime({
      ctx,
      directory: '/repo',
      happierSessionId: 'happy-fork-blank',
      baseUrl: 'http://127.0.0.1:49196',
      client,
      mcpRegistration: readyMcpRegistration,
      mcpProjection: emptyMcpProjection,
    });

    await expect(runtime.openSession({
      kind: 'fork',
      source: {
        providerSessionId: ' \t ',
        providerCheckpoint: {
          kind: 'opencode_exclusive_message_id',
          messageId: PROVIDER_MINTED_CHECKPOINT_MESSAGE_ID,
        },
      },
    })).rejects.toThrow('OpenCode fork requires a parent provider session id');

    expect(client.sessionFork).not.toHaveBeenCalled();
  });
});
