import { describe, expect, it, vi } from 'vitest';

import type { OpenCodeServerClient } from './openCodeServerClient.js';
import type { OpenCodeRuntimeContext } from './runtimeContext.js';
import { createOpenCodeServerRuntime } from './runtime.js';
import { normalizeOpenCodeV2Messages } from './openCodeV2Wire.js';

const readyMcpRegistration = Promise.resolve({
  requiredHappier: { status: 'ready' as const },
  registeredServers: [] as const,
});
const emptyMcpProjection = {
  registrations: [] as const,
  requiredHappierServerName: null,
  requiredHappierConfigurationPresent: false,
} as const;

function createClient(): OpenCodeServerClient {
  return {
    mcpAdd: vi.fn(async () => ({ status: 'connected' as const })),
    mcpRemove: vi.fn(async () => undefined),
    sessionCreate: vi.fn(async () => ({ id: 'provider-session-1' })),
    sessionUpdatePermissions: vi.fn(async () => undefined),
    sessionSetAgent: vi.fn(async () => undefined),
    sessionReadAgent: vi.fn(async () => null),
    agentsList: vi.fn(async () => []),
    sessionSetModel: vi.fn(async () => undefined),
    sessionFork: vi.fn(async () => ({ id: 'provider-session-child' })),
    sessionPromptAsync: vi.fn(async () => undefined),
    sessionAbort: vi.fn(async () => undefined),
    sessionSummarize: vi.fn(async () => undefined),
    sessionStatus: vi.fn(async () => ({ type: 'idle' })),
    sessionChildInventory: vi.fn(async () => []),
    sessionMessages: vi.fn(async () => []),
    sessionTodo: vi.fn(async () => []),
    permissionReply: vi.fn(async () => undefined),
    permissionList: vi.fn(async () => []),
    questionList: vi.fn(async () => []),
    questionReply: vi.fn(async () => undefined),
    questionReject: vi.fn(async () => undefined),
    appSkills: vi.fn(async () => []),
    subscribeGlobalEvents: vi.fn(async () => undefined),
    globalConfigGet: vi.fn(async () => ({})),
    providersList: vi.fn(async () => [{
      id: 'anthropic',
      models: { sonnet: { name: 'Sonnet' } },
    }]),
  };
}

function createContext(
  askQuestions: OpenCodeRuntimeContext['ui']['askQuestions'],
): OpenCodeRuntimeContext {
  const abortController = new AbortController();
  const sessionStorage = new Map<string, unknown>();
  return {
    exec: {
      systemTools: {
        resolve: vi.fn(async () => {
          throw new Error('executable resolution is outside this controller test');
        }),
      },
    },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
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
        throw new Error('managed server is outside this controller test');
      }),
    },
    ui: { askQuestions },
    mcp: { resolveForSession: vi.fn(async () => []) },
    sessions: {
      current: {
        permissions: {
          requestDecision: vi.fn(async () => ({ status: 'cancelled' as const })),
        },
      },
      writeStateField: vi.fn(async () => undefined),
    },
    storage: {
      daemonSession: {
        get: vi.fn(async (key: string) => sessionStorage.get(key)),
        set: vi.fn(async (key: string, value: unknown) => {
          sessionStorage.set(key, value);
        }),
      },
    },
    experimental: { telemetry: { emit: vi.fn() } },
  };
}

async function createRuntime(params: Readonly<{
  client: OpenCodeServerClient;
  askQuestions: OpenCodeRuntimeContext['ui']['askQuestions'];
  dialect?: 'v1' | 'v2';
}>) {
  const runtime = createOpenCodeServerRuntime({
    ctx: createContext(params.askQuestions),
    directory: '/repo',
    happierSessionId: 'happier-session-1',
    baseUrl: 'http://127.0.0.1:49196',
    client: params.client,
    ...(params.dialect ? { dialect: params.dialect } : {}),
    mcpRegistration: readyMcpRegistration,
    mcpProjection: emptyMcpProjection,
  });
  await runtime.openSession({ kind: 'create' });
  return runtime;
}

describe('OpenCode native interactions', () => {
  it('captures settled V2 compaction accounting from native history before the lifecycle early return', async () => {
    const client = createClient();
    const runtime = await createRuntime({ client, dialect: 'v2', askQuestions: vi.fn(async () => ({ status: 'cancelled' as const })) });
    const events: unknown[] = [];
    const dispose = runtime.subscribeRuntimeEvents((event) => events.push(event));
    vi.mocked(client.sessionMessages).mockResolvedValue(normalizeOpenCodeV2Messages([{ id: 'v2-paid', type: 'compaction',
      status: 'completed', model: { providerID: 'anthropic', modelID: 'sonnet' }, time: { created: 100, completed: 200 },
      cost: 0.2, tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 4 } } }], 'provider-session-1'));
    await runtime.handleProviderEvent({ type: 'session.next.compaction.ended', properties: { sessionID: 'provider-session-1', messageID: 'v2-paid' } });
    expect(events.filter((value) => value && typeof value === 'object' && Reflect.get(value, 'kind') === 'usage-observed'))
      .toMatchObject([{ accounting: { nativeSessionId: 'provider-session-1', inferenceId: 'v2-paid', outputIncludesReasoning: false, historyComplete: false },
        tokens: { total: 24, output: 5, reasoning: 2 }, cost: { estimatedUsd: 0.2 } }]);
    dispose(); await runtime.resetOrDisposeRuntime();
  });
  it('publishes paid compaction accounting before transcript suppression without step duplication', async () => {
    const runtime = await createRuntime({ client: createClient(), askQuestions: vi.fn(async () => ({ status: 'cancelled' as const })) });
    const events: unknown[] = [];
    const dispose = runtime.subscribeRuntimeEvents((event) => events.push(event));
    const event = { type: 'message.updated', properties: { info: { id: 'paid-compaction', sessionID: 'provider-session-1',
      role: 'assistant', summary: true, modelID: 'sonnet', cost: 0.2, time: { created: 100, completed: 200 },
      tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 4 } } } } };
    await runtime.handleProviderEvent(event);
    await runtime.handleProviderEvent(event);
    expect(events.filter((value) => value && typeof value === 'object' && Reflect.get(value, 'kind') === 'usage-observed'))
      .toMatchObject([{ accounting: { nativeSessionId: 'provider-session-1', inferenceId: 'paid-compaction', historyComplete: false }, tokens: { total: 22 }, cost: { estimatedUsd: 0.2 } }]);
    dispose(); await runtime.resetOrDisposeRuntime();
  });
  it('translates a provider question through the host owner and replies exactly once', async () => {
    const client = createClient();
    const askQuestions = vi.fn(async (request) => ({
      requestId: 'questions-1',
      kind: 'questions' as const,
      status: 'answered' as const,
      answers: {
        [request.questions[0].id]: {
          kind: 'singleChoice' as const,
          answer: { kind: 'choice' as const, choiceId: request.questions[0].choices![1].id },
        },
      },
    }));
    const runtime = await createRuntime({ client, askQuestions });

    await runtime.handleProviderEvent({
      type: 'question.asked',
      properties: {
        id: 'question-1',
        sessionID: 'provider-session-1',
        questions: [{
          header: 'Deploy',
          question: 'Choose the target',
          options: [{ label: 'Preview' }, { label: 'Production' }],
        }],
      },
    });

    expect(askQuestions).toHaveBeenCalledTimes(1);
    expect(client.questionReply).toHaveBeenCalledTimes(1);
    expect(client.questionReply).toHaveBeenCalledWith({
      sessionId: 'provider-session-1',
      requestId: 'question-1',
      answers: [['Production']],
    });
    expect(client.questionReject).not.toHaveBeenCalled();
  });

  it('suppresses a late host answer after the provider turn is cancelled', async () => {
    const client = createClient();
    let resolveQuestion!: (value: {
      requestId: string;
      kind: 'questions';
      status: 'answered';
      answers: Record<string, { kind: 'text'; value: string }>;
    }) => void;
    const askQuestions = vi.fn(() => new Promise((resolve) => {
      resolveQuestion = resolve;
    }));
    const runtime = await createRuntime({
      client,
      askQuestions: askQuestions as OpenCodeRuntimeContext['ui']['askQuestions'],
    });
    runtime.beginTurnLifecycle('test-turn');
    const providerQuestion = runtime.handleProviderEvent({
      type: 'question.asked',
      properties: {
        id: 'question-late',
        sessionID: 'provider-session-1',
        questions: [{ header: 'Name', question: 'Name?', options: [] }],
      },
    });
    await Promise.resolve();

    await runtime.cancelTurn();
    resolveQuestion({
      requestId: 'questions-late',
      kind: 'questions',
      status: 'answered',
      answers: {
        'question-late:0': { kind: 'text', value: 'late' },
      },
    });
    await providerQuestion;

    expect(client.questionReply).not.toHaveBeenCalled();
    expect(client.questionReject).not.toHaveBeenCalled();
  });

  it('preserves the active turn and publishes no cancellation when provider abort fails', async () => {
    const client = createClient();
    const runtime = await createRuntime({ client, askQuestions: vi.fn() });
    const events: Array<{ kind: string }> = [];
    runtime.subscribeRuntimeEvents((event) => events.push(event));
    runtime.beginTurnLifecycle('turn-cancel-retry');
    vi.mocked(client.sessionAbort).mockRejectedValueOnce(new Error('abort unavailable'));

    await expect(runtime.cancelTurn()).rejects.toThrow('abort unavailable');
    expect(events.filter((event) => event.kind === 'turn-cancelled')).toHaveLength(0);

    await expect(runtime.cancelTurn()).resolves.toBeUndefined();
    expect(client.sessionAbort).toHaveBeenCalledTimes(2);
    expect(events.filter((event) => event.kind === 'turn-cancelled')).toHaveLength(1);
  });

  it('publishes strict manual compaction start and completion around provider summarize', async () => {
    const client = createClient();
    const runtime = await createRuntime({
      client,
      askQuestions: vi.fn(),
    });
    await runtime.updateSessionRuntimeConfig({ modelId: 'anthropic/sonnet' });
    const events: Array<{ kind: string; phase?: string }> = [];
    const unsubscribe = runtime.subscribeRuntimeEvents((event) => events.push(event));

    await runtime.compactContext({ compactionId: 'compact-1' });

    expect(client.sessionSummarize).toHaveBeenCalledWith({
      sessionId: 'provider-session-1',
      model: { providerID: 'anthropic', modelID: 'sonnet' },
      auto: false,
    });
    expect(events.filter((event) => event.kind === 'context-compaction')).toEqual([
      expect.objectContaining({ phase: 'started' }),
      expect.objectContaining({ phase: 'completed' }),
    ]);
    unsubscribe();
  });

  it('keeps released V2 compaction open until the provider terminal event', async () => {
    const client = createClient();
    const runtime = await createRuntime({ client, askQuestions: vi.fn(), dialect: 'v2' });
    await runtime.updateSessionRuntimeConfig({ modelId: 'anthropic/sonnet' });
    const events: Array<{ kind: string; phase?: string; compactionId?: string }> = [];
    runtime.subscribeRuntimeEvents((event) => events.push(event));

    await runtime.compactContext({ compactionId: 'compact-v2' });
    expect(events.filter((event) => event.kind === 'context-compaction')).toEqual([
      expect.objectContaining({ phase: 'started', compactionId: 'compact-v2' }),
    ]);

    await runtime.handleProviderEvent({
      type: 'session.next.compaction.ended',
      properties: { sessionID: 'provider-session-1' },
    });
    expect(events.filter((event) => event.kind === 'context-compaction')).toEqual([
      expect.objectContaining({ phase: 'started', compactionId: 'compact-v2' }),
      expect.objectContaining({ phase: 'completed', compactionId: 'compact-v2' }),
    ]);
  });

  it('uses the provider-configured default model for compaction in a default-model session', async () => {
    const client = createClient();
    vi.mocked(client.globalConfigGet).mockResolvedValueOnce({
      model: 'anthropic/sonnet',
    });
    const runtime = await createRuntime({
      client,
      askQuestions: vi.fn(),
    });

    await expect(runtime.compactContext({
      compactionId: 'compact-default-model',
    })).resolves.toBeUndefined();

    expect(client.sessionSummarize).toHaveBeenCalledWith({
      sessionId: 'provider-session-1',
      model: { providerID: 'anthropic', modelID: 'sonnet' },
      auto: false,
    });
  });

  it('projects provider summary evidence as one automatic compaction lifecycle', async () => {
    const client = createClient();
    const runtime = await createRuntime({
      client,
      askQuestions: vi.fn(),
    });
    const events: Array<{ kind: string; phase?: string; trigger?: string }> = [];
    runtime.subscribeRuntimeEvents((event) => events.push(event));
    const providerEvent = {
      type: 'message.updated',
      properties: {
        info: {
          id: 'provider-summary-1',
          sessionID: 'provider-session-1',
          role: 'assistant',
          summary: true,
        },
      },
    };

    await runtime.handleProviderEvent(providerEvent);
    await runtime.handleProviderEvent(providerEvent);

    expect(events.filter((event) => event.kind === 'context-compaction')).toEqual([
      expect.objectContaining({ phase: 'started', trigger: 'automatic' }),
      expect.objectContaining({ phase: 'completed', trigger: 'automatic' }),
    ]);
  });

  it('projects V2 automatic compaction lifecycle with the provider messageID', async () => {
    const client = createClient();
    const runtime = await createRuntime({ client, askQuestions: vi.fn() });
    const events: Array<{ kind: string; phase?: string; compactionId?: string; trigger?: string }> = [];
    runtime.subscribeRuntimeEvents((event) => events.push(event));

    await runtime.handleProviderEvent({
      type: 'session.next.compaction.started',
      properties: {
        sessionID: 'provider-session-1',
        messageID: 'msg_compaction_v2',
        reason: 'auto',
      },
    });
    await runtime.handleProviderEvent({
      type: 'session.next.compaction.ended',
      properties: {
        sessionID: 'provider-session-1',
        messageID: 'msg_compaction_v2',
        reason: 'auto',
        text: '',
        recent: '',
      },
    });

    expect(events.filter((event) => event.kind === 'context-compaction')).toEqual([
      expect.objectContaining({ phase: 'started', trigger: 'automatic', compactionId: 'msg_compaction_v2' }),
      expect.objectContaining({ phase: 'completed', trigger: 'automatic', compactionId: 'msg_compaction_v2' }),
    ]);
  });
});
