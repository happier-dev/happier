import { describe, expect, it, vi } from 'vitest';
import recordedNativeHistory from './opencode119.httpHistory.fixture.json';

import { createOpenCodeServerClient, type OpenCodeServerClient } from './openCodeServerClient.js';
import { buildOpenCodeV2ConnectedAuthConfigPart } from '../../auth/services/requestAuth/assets.js';
import { asRecord } from './openCodeParsing.js';
import type { OpenCodeRuntimeContext } from './runtimeContext.js';
import { createOpenCodeServerRuntime } from './runtime.js';
import { normalizeOpenCodeV2Event } from './openCodeV2EventAdapter.js';
import { normalizeOpenCodeV2Messages } from './openCodeV2Wire.js';
import { createOpenCodeSessionRuntime } from './sessionRuntime.js';
import { AGENT_DEFINITION } from '../../definition.js';
import { createRuntimeTranscriptProjector } from '../../../../../../../apps/cli/src/agent/runtime/session/transcripts/projectRuntimeTranscriptEvent';

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
  it('binds recorded live paid inferences to their admitted turn without assigning late accounting to a newer turn', async () => {
    const client = createClient();
    const history = recordedNativeHistory.history.body;
    const user = history[0]!.info;
    const assistant = history[1]!.info;
    vi.mocked(client.sessionCreate).mockResolvedValue({ id: user.sessionID });
    vi.mocked(client.sessionPromptAsync).mockResolvedValue({ id: user.id });
    const runtime = await createRuntime({ client, askQuestions: vi.fn() });
    const native = createOpenCodeSessionRuntime({
      operations: runtime,
      request: { kind: 'create', sessionId: 'happier-session-1', cwd: '/repo' },
      disposeOperations: () => runtime.resetOrDisposeRuntime(),
      runtimeCapabilities: {
        sessionCapabilities: AGENT_DEFINITION.core.sessionCapabilities,
        tools: { delivery: 'native_mcp', support: 'supported' },
      },
    });
    const events: Array<{ kind: string; turnId?: string }> = [];
    const watcher = native.watch(event => events.push(event));
    const publish = async (info: unknown) => runtime.handleProviderEvent({
      type: 'message.updated', properties: { info },
    });
    const usage = () => events.filter(event => event.kind === 'usage-observed');
    try {
      runtime.beginTurnLifecycle('paid-turn');
      await runtime.sendTurnPrompt('hello');
      await publish(assistant);
      expect(usage()).toMatchObject([{ turnId: 'paid-turn' }]);
      // Unchanged native deliveries do not multiply accounting observations.
      await publish(assistant);
      expect(usage()).toHaveLength(1);
      vi.mocked(client.sessionMessages).mockResolvedValue(history);
      await runtime.handleProviderEvent({ type: 'session.idle', properties: { sessionID: user.sessionID } });
      expect(events).toContainEqual(expect.objectContaining({ kind: 'turn-complete', turnId: 'paid-turn' }));
      // A revised accounting frame after completion has no live ownership proof.
      await publish({ ...assistant, cost: (assistant.cost ?? 0) + 1 });
      expect(usage().at(-1)).not.toHaveProperty('turnId');
      vi.mocked(client.sessionMessages).mockResolvedValue([]);
      vi.mocked(client.sessionPromptAsync).mockResolvedValue({ id: 'next-native-user' });
      runtime.beginTurnLifecycle('next-turn');
      await runtime.sendTurnPrompt('next');
      await publish({ ...assistant, cost: (assistant.cost ?? 0) + 2 });
      expect(usage().at(-1)).not.toHaveProperty('turnId');
      await publish({ ...assistant, summary: true, parentID: 'next-native-user', cost: (assistant.cost ?? 0) + 3 });
      expect(usage().at(-1)).not.toHaveProperty('turnId');
    } finally {
      watcher.dispose();
      await native.dispose();
    }
  });

  it.each(['success', 'failed'] as const)('publishes foreground V2 MCP calls and their %s result once across live and history delivery', async (outcome) => {
    const runtime = await createRuntime({ client: createClient(), dialect: 'v2', askQuestions: vi.fn() });
    const events: unknown[] = [];
    const dispose = runtime.subscribeRuntimeEvents(event => events.push(event));
    const native = createOpenCodeSessionRuntime({
      operations: runtime,
      request: { kind: 'create', sessionId: 'happier-session-1', cwd: '/repo' },
      disposeOperations: () => runtime.resetOrDisposeRuntime(),
      runtimeCapabilities: {
        sessionCapabilities: AGENT_DEFINITION.core.sessionCapabilities,
        tools: { delivery: 'native_mcp', support: 'supported' },
      },
    });
    const commits: unknown[] = [];
    const projections: Promise<unknown>[] = [];
    const project = createRuntimeTranscriptProjector();
    const watcher = native.watch(event => {
      if (event.kind !== 'tool-call' && event.kind !== 'tool-result') return;
      projections.push(project({ event, provider: 'opencode', session: {
        sessionId: 'happier-session-1',
        // The durable transcript port is the persistence boundary; mapping/projection stay real.
        enqueueAgentMessageCommitted: async (_provider, body) => {
          commits.push(body);
          return { persisted: true, delivered: true };
        },
      } }));
    });
    try {
      runtime.beginTurnLifecycle('usage-turn');
      // r159 OpenCode 2.2.7 persisted this code-mode tool shape (sanitized inputs/results).
      // V2 session.tool.* frames carry the name on input.started.
      const identity = { sessionID: 'provider-session-1', assistantMessageID: 'usage-message', id: 'usage-call' };
      const input = { code: 'await tools.happier_action_execute({ actionId: "usage.query" })' };
      const result = JSON.stringify({ accounting: { totals: { eventCount: 2235 } } });
      const expectedOutput = outcome === 'success' ? { output: result } : { error: 'fixture refusal' };
      for (const [type, data] of [
        ['session.tool.input.started', { ...identity, name: 'execute' }],
        ['session.tool.called', { ...identity, input, executed: true }],
        [`session.tool.${outcome}`, { ...identity, content: [{ type: 'text', text: result }], error: 'fixture refusal', executed: true }],
      ] as const) {
        const normalized = normalizeOpenCodeV2Event(type, data);
        await runtime.handleProviderEvent({ payload: normalized });
      }
      expect(events).toHaveLength(3);
      // A durable snapshot of the same native call must not duplicate publication.
      await runtime.handleProviderEvent({ type: 'message.part.updated', properties: { part: {
        type: 'tool', sessionID: identity.sessionID, messageID: identity.assistantMessageID,
        callID: identity.id, tool: 'execute',
        state: { status: outcome === 'success' ? 'completed' : 'error', input, output: result },
      } } });
      expect(events).toMatchObject([
        { kind: 'turn-start', turnId: 'usage-turn' },
        { kind: 'tool-call', turnId: 'usage-turn', toolCallId: 'usage-call', toolName: 'execute', toolInput: input },
        { kind: 'tool-result', turnId: 'usage-turn', toolCallId: 'usage-call',
          output: expectedOutput,
          ...(outcome === 'failed' ? { isError: true } : {}) },
      ]);
      await Promise.all(projections);
      expect(commits).toMatchObject([
        { type: 'tool-call', name: 'execute', input },
        { type: 'tool-result', output: expectedOutput,
          ...(outcome === 'failed' ? { isError: true } : {}) },
      ]);
    } finally {
      watcher.dispose();
      dispose();
      await native.dispose();
    }
  });

  it('omits current context when paid counters have no native total while retaining a measured zero total', async () => {
    const client = createClient();
    vi.mocked(client.sessionPromptAsync).mockResolvedValue({ id: 'native-paid-user' });
    const runtime = await createRuntime({ client, askQuestions: vi.fn() });
    const events: unknown[] = [];
    const dispose = runtime.subscribeRuntimeEvents(event => events.push(event));
    try {
      runtime.beginTurnLifecycle('partial-paid-turn');
      await runtime.sendTurnPrompt('hello');
      for (const total of [null, 0]) await runtime.handleProviderEvent({ type: 'message.updated', properties: { info: {
        id: `paid-${total}`, sessionID: 'provider-session-1', parentID: 'native-paid-user',
        role: 'assistant', modelID: 'sonnet', time: { created: 100, completed: 200 }, tokens: { input: 12, output: 0, total },
      } } });
      const observations = events.filter(value => value && typeof value === 'object' && Reflect.get(value, 'kind') === 'usage-observed');
      expect(observations).toMatchObject([{ tokens: { input: 12, total: null } }, { tokens: { total: 0 }, context: { usedTokens: 0 } }]);
      expect(observations[0]).not.toHaveProperty('context');
    } finally { dispose(); await runtime.resetOrDisposeRuntime(); }
  });
  it.each(['v1', 'v2'] as const)('withdraws unproven ChatGPT catalog rows without preventing an explicit native selection (%s)', async dialect => {
    const config = buildOpenCodeV2ConnectedAuthConfigPart({ configHome: '/opencode', requestAuthProviders: ['openai'], directApiKeys: {} });
    const nativeProviders = dialect === 'v1' ? asRecord(config.provider) : asRecord(config.providers);
    const settings = asRecord(asRecord(nativeProviders?.openai)?.[dialect === 'v1' ? 'options' : 'settings']);
    const openai = { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini' };
    const sonnet = { id: 'sonnet', name: 'Sonnet' };
    let otherProviderAvailable = true;
    let chatGptRoute = true;
    // The HTTP transport is the process boundary; decoding and catalog ownership stay real.
    const nativeClient = createOpenCodeServerClient({ dialect, transport: {
      fetch: vi.fn(async () => new Response()),
      request: async request => {
        const path = new URL(request.url, 'http://opencode.invalid').pathname;
        const routeSettings = chatGptRoute ? settings : { baseURL: 'https://api.openai.com/v1' };
        const value = dialect === 'v1'
          ? { all: [{ id: 'openai', options: routeSettings, models: { [openai.id]: openai } }, ...(otherProviderAvailable ? [{ id: 'anthropic', models: { sonnet } }] : [])], connected: ['openai', 'anthropic'] }
          : { data: path === '/api/model'
            ? [{ ...openai, providerID: 'openai' }, ...(otherProviderAvailable ? [{ ...sonnet, providerID: 'anthropic' }] : [])]
            : [{ id: 'openai', settings: routeSettings }, ...(otherProviderAvailable ? [{ id: 'anthropic' }] : [])] };
        const response = new Response(JSON.stringify(value));
        return { ok: true, status: 200, headers: {}, text: () => response.text(), json: () => response.json(), arrayBuffer: () => response.arrayBuffer() };
      },
    } });
    const client = { ...createClient(), providersList: () => nativeClient.providersList() };
    const runtime = await createRuntime({ client, dialect, askQuestions: vi.fn() });
    expect(runtime.readModelCatalog().models).toMatchObject([{ id: 'anthropic/sonnet', name: 'Sonnet' }]);
    await expect(runtime.updateSessionRuntimeConfig({ modelId: 'openai/gpt-5.4-mini' })).resolves.toBeDefined();
    otherProviderAvailable = false;
    await runtime.handleProviderEvent({ type: 'provider.updated', properties: {} });
    expect(runtime.readModelCatalog().models).toBeNull();
    chatGptRoute = false;
    await runtime.handleProviderEvent({ type: 'provider.updated', properties: {} });
    expect(runtime.readModelCatalog().models).toMatchObject([{ id: 'openai/gpt-5.4-mini' }]);
    await runtime.resetOrDisposeRuntime();
  });

  it.each(['v1', 'v2'] as const)('preserves idle origin without foreground work for %s summarize', async (dialect) => {
    const client = createClient();
    const runtime = await createRuntime({ client, dialect, askQuestions: vi.fn() });
    await runtime.updateSessionRuntimeConfig({ modelId: 'anthropic/sonnet' });
    const historyRead = vi.spyOn(client, 'sessionMessages').mockClear();
    const events: Array<{ kind: string; phase?: string; trigger?: string; turnId?: string }> = [];
    runtime.subscribeRuntimeEvents((event) => events.push(event));
    vi.mocked(client.sessionSummarize).mockImplementationOnce(async () => {
      await runtime.handleProviderEvent({ type: 'session.status', properties: { sessionID: 'provider-session-1', status: { type: 'busy' } } });
      if (dialect === 'v1') {
        await runtime.handleProviderEvent({ type: 'message.updated', properties: { info: {
          id: 'summary-idle', sessionID: 'provider-session-1', role: 'assistant', summary: true,
        } } });
      }
    });
    await runtime.compactContext({ compactionId: 'idle-compact', trigger: 'idle' });
    if (dialect === 'v2') {
      expect(events.filter((event) => event.kind === 'context-compaction')).toMatchObject([
        { phase: 'started', trigger: 'idle' },
      ]);
      await runtime.handleProviderEvent({ type: 'session.next.compaction.ended', properties: { sessionID: 'provider-session-1' } });
    }
    expect(events.filter((event) => event.kind === 'context-compaction')).toMatchObject([
      { phase: 'started', trigger: 'idle' }, { phase: 'completed', trigger: 'idle' },
    ]);
    expect(events.some((event) => event.kind === 'turn-start' || event.kind === 'turn-complete')).toBe(false);
    expect(events.every((event) => event.turnId === undefined)).toBe(true);
    expect(client.sessionSummarize).toHaveBeenCalledTimes(1);
    // V2 already reads terminal accounting; V1's summarize response settles directly.
    expect(historyRead).toHaveBeenCalledTimes(dialect === 'v2' ? 1 : 0);
    await runtime.resetOrDisposeRuntime();
  });
  it('settles admitted V2 idle compaction once when disposed', async () => {
    const runtime = await createRuntime({ client: createClient(), dialect: 'v2', askQuestions: vi.fn() });
    await runtime.updateSessionRuntimeConfig({ modelId: 'anthropic/sonnet' });
    const events: Array<{ kind: string; phase?: string; trigger?: string }> = [];
    runtime.subscribeRuntimeEvents((event) => events.push(event));
    await runtime.compactContext({ compactionId: 'idle-dispose', trigger: 'idle' });
    await runtime.resetOrDisposeRuntime();
    expect(events.filter((event) => event.kind === 'context-compaction')).toMatchObject([
      { phase: 'started', trigger: 'idle' }, { phase: 'cancelled', trigger: 'idle' },
    ]);
  });
  it('keeps V1 idle origin when native busy and summary arrive after the HTTP response', async () => {
    const client = createClient();
    const runtime = await createRuntime({ client, dialect: 'v1', askQuestions: vi.fn() });
    await runtime.updateSessionRuntimeConfig({ modelId: 'anthropic/sonnet' });
    const historyRead = vi.spyOn(client, 'sessionMessages').mockClear();
    const events: Array<{ kind: string; phase?: string; trigger?: string }> = [];
    runtime.subscribeRuntimeEvents(event => events.push(event));
    await runtime.compactContext({ compactionId: 'late-idle', trigger: 'idle' });
    await runtime.handleProviderEvent({ type: 'session.status', properties: {
      sessionID: 'provider-session-1', status: { type: 'busy' },
    } });
    await runtime.handleProviderEvent({ type: 'message.updated', properties: { info: {
      id: 'late-idle-summary', sessionID: 'provider-session-1', role: 'assistant', summary: true,
    } } });
    await runtime.handleProviderEvent({ type: 'session.idle', properties: { sessionID: 'provider-session-1' } });
    expect(events.filter(event => event.kind === 'context-compaction')).toMatchObject([
      { phase: 'started', trigger: 'idle' }, { phase: 'completed', trigger: 'idle' },
    ]);
    expect(events.some(event => event.kind === 'turn-start' || event.kind === 'turn-complete')).toBe(false);
    expect(historyRead).not.toHaveBeenCalled();
    await runtime.compactContext({ compactionId: 'manual-after-idle', trigger: 'manual' });
    expect(client.sessionSummarize).toHaveBeenCalledTimes(2);
    expect(events.filter(event => event.kind === 'context-compaction')).toMatchObject([
      { phase: 'started', trigger: 'idle' }, { phase: 'completed', trigger: 'idle' },
      { phase: 'started', trigger: 'manual' }, { phase: 'completed', trigger: 'manual' },
    ]);
    runtime.beginTurnLifecycle('foreground-after-idle');
    expect(events.filter(event => event.kind === 'turn-start')).toMatchObject([{ turnId: 'foreground-after-idle' }]);
    await runtime.resetOrDisposeRuntime();
  });
  it('captures settled V2 compaction accounting from native history before the lifecycle early return', async () => {
    const client = createClient();
    const runtime = await createRuntime({ client, dialect: 'v2', askQuestions: vi.fn(async () => ({ status: 'cancelled' as const })) });
    const events: unknown[] = [];
    const dispose = runtime.subscribeRuntimeEvents((event) => events.push(event));
    vi.mocked(client.sessionMessages).mockResolvedValue(normalizeOpenCodeV2Messages([{ id: 'v2-paid', type: 'compaction',
      status: 'completed', model: { providerID: 'anthropic', id: 'sonnet' }, time: { created: 100, completed: 200 },
      cost: 0.2, tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 4 } } }], 'provider-session-1'));
    await runtime.handleProviderEvent({ type: 'session.next.compaction.ended', properties: { sessionID: 'provider-session-1', messageID: 'v2-paid' } });
    expect(events.filter((value) => value && typeof value === 'object' && Reflect.get(value, 'kind') === 'usage-observed'))
      .toMatchObject([{ accounting: { nativeSessionId: 'provider-session-1', inferenceId: 'v2-paid', outputIncludesReasoning: false, historyComplete: false },
        tokens: { total: null, output: 5, reasoning: 2 }, cost: { estimatedUsd: 0.2 } }]);
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
      .toMatchObject([{ accounting: { nativeSessionId: 'provider-session-1', inferenceId: 'paid-compaction', historyComplete: false }, tokens: { total: null }, cost: { estimatedUsd: 0.2 } }]);
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

    await runtime.compactContext({ compactionId: 'compact-1', trigger: 'manual' });

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

    await runtime.compactContext({ compactionId: 'compact-v2', trigger: 'manual' });
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
      compactionId: 'compact-default-model', trigger: 'manual',
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
