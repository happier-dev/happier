import { describe, expect, it, vi } from 'vitest';

import type { OpenCodeServerClient } from './openCodeServerClient.js';
import type { OpenCodeRuntimeContext } from './runtimeContext.js';
import { createOpenCodeServerRuntime } from './runtime.js';

const readyMcpRegistration = Promise.resolve({
  requiredHappier: { status: 'ready' as const },
});

function createClient(): OpenCodeServerClient {
  return {
    mcpAdd: vi.fn(async () => ({ status: 'connected' as const })),
    sessionCreate: vi.fn(async () => ({ id: 'provider-session-1' })),
    sessionFork: vi.fn(async () => ({ id: 'provider-session-child' })),
    sessionPromptAsync: vi.fn(async () => undefined),
    sessionAbort: vi.fn(async () => undefined),
    sessionSummarize: vi.fn(async () => undefined),
    sessionStatus: vi.fn(async () => ({ type: 'idle' })),
    sessionMessages: vi.fn(async () => []),
    sessionTodo: vi.fn(async () => []),
    permissionReply: vi.fn(async () => undefined),
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
}>) {
  const runtime = createOpenCodeServerRuntime({
    ctx: createContext(params.askQuestions),
    directory: '/repo',
    happierSessionId: 'happier-session-1',
    baseUrl: 'http://127.0.0.1:49196',
    client: params.client,
    mcpRegistration: readyMcpRegistration,
  });
  await runtime.openSession({ kind: 'create' });
  return runtime;
}

describe('OpenCode native interactions', () => {
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
});
