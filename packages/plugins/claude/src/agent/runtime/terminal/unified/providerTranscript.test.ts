import type {
  TranscriptFileFollowHandleV1,
  TranscriptFileFollowInputV1,
  TranscriptFileFollowLineV1,
  TranscriptFileFollowResetReasonV1,
} from '@happier-dev/plugin-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ClaudeUnifiedProviderTranscriptBindResult } from './providerTranscript.js';

type TestLogger = Readonly<{
  debug: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
}>;

type TestContext = Readonly<{
  agentRuntime: Readonly<{
    sessionHooks: Readonly<{
      publishProviderTranscript: ReturnType<typeof vi.fn>;
    }>;
    transcripts: Readonly<{
      fileFollow: Readonly<{
        follow: ReturnType<typeof vi.fn>;
      }>;
    }>;
  }>;
  logger: TestLogger;
  fileFollows: CapturedFileFollow[];
}>;

type ProviderTranscriptPublisher = Readonly<{
  bindFromSessionHook(providerSessionId: string, payload: Readonly<Record<string, unknown>>): Promise<ClaudeUnifiedProviderTranscriptBindResult>;
  bindKnownLiveTranscript(input: Readonly<{
    providerSessionId: string;
    transcriptPath: string;
  }>): Promise<ClaudeUnifiedProviderTranscriptBindResult>;
  drainNow(): Promise<void>;
  dispose(options?: Readonly<{ drainTimeoutMs?: number }>): void | Promise<void>;
}>;

type ProviderTranscriptModule = Readonly<{
  createClaudeUnifiedProviderTranscriptPublisher(params: Readonly<{
    ctx: TestContext;
    sessionId: string;
    onObserveRow?: (row: unknown) => void;
  }>): ProviderTranscriptPublisher;
}>;

type CapturedFileFollow = Readonly<{
  input: TranscriptFileFollowInputV1;
  handle: TranscriptFileFollowHandleV1;
  emit(line: string): Promise<void>;
  emitReset(reason: TranscriptFileFollowResetReasonV1): Promise<void>;
  emitError(error: unknown): Promise<void>;
  drainNow: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}>;

type TestContextOptions = Readonly<{
  replayLinesOnFollow?: readonly string[];
}>;

const publishers: ProviderTranscriptPublisher[] = [];
let nextFollowId = 0;

function jsonLine(value: unknown): string {
  return JSON.stringify(value);
}

function createCapturedFileFollow(input: TranscriptFileFollowInputV1): CapturedFileFollow {
  let sequence = 0;
  const drainNow = vi.fn(async () => undefined);
  const close = vi.fn(async () => undefined);
  nextFollowId += 1;
  const handle: TranscriptFileFollowHandleV1 = Object.freeze({
    id: `test-follow-${nextFollowId}`,
    drainNow,
    close,
  });
  return Object.freeze({
    input,
    handle,
    drainNow,
    close,
    async emit(line: string) {
      sequence += 1;
      const event: TranscriptFileFollowLineV1 = Object.freeze({
        line,
        sourcePath: input.path,
        sequence,
      });
      await input.onLine(event);
    },
    async emitReset(reason: TranscriptFileFollowResetReasonV1) {
      await input.onReset?.({ reason });
    },
    async emitError(error: unknown) {
      await input.onError?.(error);
    },
  });
}

function createContext(options: TestContextOptions = {}): TestContext {
  const fileFollows: CapturedFileFollow[] = [];
  const follow = vi.fn(async (input: TranscriptFileFollowInputV1) => {
    const captured = createCapturedFileFollow(input);
    fileFollows.push(captured);
    for (const line of options.replayLinesOnFollow ?? []) {
      await captured.emit(line);
    }
    return captured.handle;
  });
  return {
    agentRuntime: {
      sessionHooks: {
        publishProviderTranscript: vi.fn(async () => undefined),
      },
      transcripts: {
        fileFollow: {
          follow,
        },
      },
    },
    logger: {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    fileFollows,
  };
}

async function loadSubject(): Promise<ProviderTranscriptModule> {
  const loaded = await import('./providerTranscript.js').catch((error: unknown) => ({ error }));
  expect(loaded).not.toHaveProperty('error');
  expect(loaded).toHaveProperty('createClaudeUnifiedProviderTranscriptPublisher', expect.any(Function));
  return loaded as ProviderTranscriptModule;
}

async function createBoundPublisher(options?: Readonly<{
  transcriptPath?: string;
  providerSessionId?: string;
  sessionId?: string;
  source?: string;
  replayLinesOnFollow?: readonly string[];
  onObserveRow?: (row: unknown) => void;
}>): Promise<Readonly<{
  ctx: TestContext;
  publisher: ProviderTranscriptPublisher;
  transcriptPath: string;
}>> {
  const { createClaudeUnifiedProviderTranscriptPublisher } = await loadSubject();
  const transcriptPath = options?.transcriptPath ?? '/tmp/claude-session-1.jsonl';
  const providerSessionId = options?.providerSessionId ?? 'claude-session-1';
  const ctx = createContext({ replayLinesOnFollow: options?.replayLinesOnFollow });
  const publisher = createClaudeUnifiedProviderTranscriptPublisher({
    ctx,
    sessionId: options?.sessionId ?? 'happy-session-1',
    ...(options?.onObserveRow ? { onObserveRow: options.onObserveRow } : {}),
  });
  publishers.push(publisher);
  const bindResult = await publisher.bindFromSessionHook(providerSessionId, {
    hook_event_name: 'SessionStart',
    session_id: providerSessionId,
    transcript_path: transcriptPath,
    ...(options?.source ? { source: options.source } : {}),
  });
  expect(bindResult).toEqual({
    status: 'bound',
    binding: {
      providerSessionId,
      transcriptPath,
    },
  });
  return { ctx, publisher, transcriptPath };
}

describe('createClaudeUnifiedProviderTranscriptPublisher', () => {
  afterEach(async () => {
    for (const publisher of publishers.splice(0)) {
      await publisher.dispose();
    }
  });

  it('ignores a sidechain (subagent) SessionStart so it can never re-key the transcript binding (ported HF-7)', async () => {
    const { createClaudeUnifiedProviderTranscriptPublisher } = await loadSubject();
    const ctx = createContext();
    const publisher = createClaudeUnifiedProviderTranscriptPublisher({
      ctx,
      sessionId: 'happy-session-1',
    });
    publishers.push(publisher);

    await expect(publisher.bindFromSessionHook('subagent-session-1', {
      hook_event_name: 'SessionStart',
      session_id: 'subagent-session-1',
      transcript_path: '/tmp/subagent-session-1.jsonl',
      agent_id: 'agent-sidechain-1',
    })).resolves.toEqual({ status: 'ignored' });
    expect(ctx.agentRuntime.transcripts.fileFollow.follow).not.toHaveBeenCalled();

    // The MAIN-chain SessionStart that follows must bind cleanly (no conflicting-binding refusal).
    await expect(publisher.bindFromSessionHook('claude-session-1', {
      hook_event_name: 'SessionStart',
      session_id: 'claude-session-1',
      transcript_path: '/tmp/claude-session-1.jsonl',
    })).resolves.toEqual({
      status: 'bound',
      binding: {
        providerSessionId: 'claude-session-1',
        transcriptPath: '/tmp/claude-session-1.jsonl',
      },
    });
    expect(ctx.agentRuntime.transcripts.fileFollow.follow).toHaveBeenCalledTimes(1);
    expect(ctx.logger.warn).not.toHaveBeenCalledWith(
      '[ClaudeUnifiedTerminal] ignored conflicting transcript binding',
      expect.anything(),
    );
  });

  it('binds current Claude SessionStart hook payloads with camelCase sessionId', async () => {
    const { createClaudeUnifiedProviderTranscriptPublisher } = await loadSubject();
    const ctx = createContext();
    const publisher = createClaudeUnifiedProviderTranscriptPublisher({
      ctx,
      sessionId: 'happy-session-1',
    });
    publishers.push(publisher);

    await expect(publisher.bindFromSessionHook('', {
      hook_event_name: 'SessionStart',
      sessionId: 'claude-current-session',
      transcript_path: '/tmp/claude-current-session.jsonl',
    })).resolves.toEqual({
      status: 'bound',
      binding: {
        providerSessionId: 'claude-current-session',
        transcriptPath: '/tmp/claude-current-session.jsonl',
      },
    });
    expect(ctx.agentRuntime.transcripts.fileFollow.follow).toHaveBeenCalledWith(expect.objectContaining({
      path: '/tmp/claude-current-session.jsonl',
    }));
  });

  it('publishes Claude lifecycle transcript events from the trusted SessionStart JSONL path', async () => {
    const { ctx, transcriptPath } = await createBoundPublisher();
    expect(ctx.agentRuntime.transcripts.fileFollow.follow).toHaveBeenCalledWith(expect.objectContaining({
      path: transcriptPath,
      startAt: 'beginning',
      strategy: 'poll',
      onLine: expect.any(Function),
      onError: expect.any(Function),
    }));
    const assistantEndTurn = {
      type: 'assistant',
      uuid: 'assistant-row-1',
      message: { stop_reason: 'end_turn' },
    };
    const stopHookFeedback = {
      type: 'user',
      uuid: 'user-row-1',
      isMeta: true,
      message: { content: [{ type: 'text', text: 'Stop hook feedback:\ncontinue please' }] },
    };
    const interrupted = {
      type: 'user',
      uuid: 'user-row-2',
      message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] },
    };
    for (const row of [assistantEndTurn, stopHookFeedback, interrupted]) {
      await ctx.fileFollows[0]?.emit(jsonLine(row));
    }

    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenCalledTimes(3);
    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenNthCalledWith(1, {
      providerId: 'claude',
      sessionId: 'happy-session-1',
      providerSessionId: 'claude-session-1',
      kind: 'assistant_stop',
      turnId: 'assistant-row-1',
      stopReason: 'end_turn',
      providerPayload: assistantEndTurn,
    });
    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenNthCalledWith(2, {
      providerId: 'claude',
      sessionId: 'happy-session-1',
      providerSessionId: 'claude-session-1',
      kind: 'stop_hook_feedback',
      turnId: 'user-row-1',
      providerPayload: stopHookFeedback,
    });
    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenNthCalledWith(3, {
      providerId: 'claude',
      sessionId: 'happy-session-1',
      providerSessionId: 'claude-session-1',
      kind: 'text',
      turnId: 'user-row-2',
      text: '[Request interrupted by user]',
      providerPayload: interrupted,
    });
  });

  it('publishes Claude queued-command transcript rows as provider-acceptance evidence only', async () => {
    const { ctx } = await createBoundPublisher();
    const queuedCommandOperation = {
      type: 'queue-operation',
      operation: 'enqueue',
      uuid: 'queued-command-row-1',
      content: 'prompt delivered through Claude queue',
      timestamp: new Date(Date.now() + 1_000).toISOString(),
    };
    const queuedCommandAttachment = {
      type: 'attachment',
      uuid: 'queued-command-row-2',
      attachment: {
        type: 'queued_command',
        prompt: 'prompt delivered through Claude attachment',
      },
      timestamp: new Date(Date.now() + 2_000).toISOString(),
    };
    const removalOnly = {
      type: 'queue-operation',
      operation: 'remove',
      uuid: 'queued-command-row-3',
      content: 'not delivery evidence',
      timestamp: new Date(Date.now() + 3_000).toISOString(),
    };

    for (const row of [queuedCommandOperation, queuedCommandAttachment, removalOnly]) {
      await ctx.fileFollows[0]?.emit(jsonLine(row));
    }

    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenCalledTimes(2);
    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenNthCalledWith(1, {
      providerId: 'claude',
      sessionId: 'happy-session-1',
      providerSessionId: 'claude-session-1',
      kind: 'queued_command',
      turnId: 'queued-command-row-1',
      text: 'prompt delivered through Claude queue',
      providerPayload: queuedCommandOperation,
    });
    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenNthCalledWith(2, {
      providerId: 'claude',
      sessionId: 'happy-session-1',
      providerSessionId: 'claude-session-1',
      kind: 'queued_command',
      turnId: 'queued-command-row-2',
      text: 'prompt delivered through Claude attachment',
      providerPayload: queuedCommandAttachment,
    });
  });

  it('still observes queued-command rows through the raw work-state seam', async () => {
    const observedRows: unknown[] = [];
    const { ctx } = await createBoundPublisher({
      onObserveRow: (row) => {
        observedRows.push(row);
      },
    });
    const queuedCommandOperation = {
      type: 'queue-operation',
      operation: 'enqueue',
      uuid: 'queued-command-row-1',
      content:
        '<task-notification><task-id>w1</task-id><tool-use-id>wf-tool-1</tool-use-id><status>completed</status></task-notification>',
      timestamp: new Date(Date.now() + 1_000).toISOString(),
    };
    const queuedCommandAttachment = {
      type: 'attachment',
      uuid: 'queued-command-row-2',
      attachment: {
        type: 'queued_command',
        prompt:
          '<task-notification><task-id>w2</task-id><tool-use-id>wf-tool-2</tool-use-id><status>completed</status></task-notification>',
      },
      timestamp: new Date(Date.now() + 2_000).toISOString(),
    };

    for (const row of [queuedCommandOperation, queuedCommandAttachment]) {
      await ctx.fileFollows[0]?.emit(jsonLine(row));
    }

    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenCalledTimes(2);
    expect(observedRows).toEqual([queuedCommandOperation, queuedCommandAttachment]);
  });

  it('observes trusted queued-command rows replayed during SessionStart binding', async () => {
    const queuedCommandOperation = {
      type: 'queue-operation',
      operation: 'enqueue',
      uuid: 'queued-command-initial-row',
      content: 'prompt already present before SessionStart binding',
      timestamp: new Date(Date.now() + 1_000).toISOString(),
    };
    const observedRows: unknown[] = [];
    const { createClaudeUnifiedProviderTranscriptPublisher } = await loadSubject();
    const ctx = createContext({
      replayLinesOnFollow: [jsonLine(queuedCommandOperation)],
    });
    const publisher = createClaudeUnifiedProviderTranscriptPublisher({
      ctx,
      sessionId: 'happy-session-1',
      onObserveRow: (row) => {
        observedRows.push(row);
      },
    });
    publishers.push(publisher);

    await expect(publisher.bindFromSessionHook('claude-session-1', {
      hook_event_name: 'SessionStart',
      session_id: 'claude-session-1',
      transcript_path: '/tmp/claude-session-1.jsonl',
    })).resolves.toEqual({
      status: 'bound',
      binding: {
        providerSessionId: 'claude-session-1',
        transcriptPath: '/tmp/claude-session-1.jsonl',
      },
    });

    expect(ctx.agentRuntime.transcripts.fileFollow.follow).toHaveBeenCalledWith(expect.objectContaining({
      path: '/tmp/claude-session-1.jsonl',
      startAt: 'beginning',
    }));
    expect(observedRows).toEqual([queuedCommandOperation]);
    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenCalledTimes(1);
    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenCalledWith({
      providerId: 'claude',
      sessionId: 'happy-session-1',
      providerSessionId: 'claude-session-1',
      kind: 'queued_command',
      turnId: 'queued-command-initial-row',
      text: 'prompt already present before SessionStart binding',
      providerPayload: queuedCommandOperation,
    });
  });

  it('does not publish Claude synthetic no-response assistant closures as completion evidence', async () => {
    const { ctx } = await createBoundPublisher();
    await ctx.fileFollows[0]?.emit(jsonLine({
      type: 'assistant',
      uuid: 'synthetic-no-response',
      isSidechain: false,
      model: '<synthetic>',
      message: {
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'No response requested.' }],
      },
    }));

    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).not.toHaveBeenCalled();
  });

  it('drops sidechain rows so subagent activity never becomes parent-turn lifecycle evidence', async () => {
    const { ctx } = await createBoundPublisher();
    const sidechainAssistantEndTurn = {
      type: 'assistant',
      uuid: 'sidechain-assistant-row-1',
      isSidechain: true,
      message: { stop_reason: 'end_turn' },
    };
    const sidechainUserPrompt = {
      type: 'user',
      uuid: 'sidechain-user-row-1',
      isSidechain: true,
      message: { content: [{ type: 'text', text: 'subagent task prompt' }] },
    };
    const parentAssistantEndTurn = {
      type: 'assistant',
      uuid: 'assistant-row-1',
      message: { stop_reason: 'end_turn' },
    };
    for (const row of [sidechainAssistantEndTurn, sidechainUserPrompt, parentAssistantEndTurn]) {
      await ctx.fileFollows[0]?.emit(jsonLine(row));
    }

    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenCalledTimes(1);
    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'assistant_stop',
      turnId: 'assistant-row-1',
    }));
  });

  it('fails closed without binding when host file-follow denies the trusted transcript path', async () => {
    const { createClaudeUnifiedProviderTranscriptPublisher } = await loadSubject();
    const transcriptPath = '/tmp/denied-claude-session.jsonl';
    const ctx = createContext();
    const denied = new Error('path is not granted');
    ctx.agentRuntime.transcripts.fileFollow.follow.mockRejectedValueOnce(denied);
    const publisher = createClaudeUnifiedProviderTranscriptPublisher({
      ctx,
      sessionId: 'happy-session-1',
    });
    publishers.push(publisher);

    await expect(publisher.bindFromSessionHook('claude-session-1', {
      hook_event_name: 'SessionStart',
      session_id: 'claude-session-1',
      transcriptPath,
    })).resolves.toEqual({
      status: 'deferred',
      binding: {
        providerSessionId: 'claude-session-1',
        transcriptPath,
      },
    });
    expect(ctx.agentRuntime.transcripts.fileFollow.follow).toHaveBeenCalledTimes(1);
    expect(ctx.logger.debug).toHaveBeenCalledWith(
      '[ClaudeUnifiedTerminal] transcript drain deferred',
      expect.objectContaining({ error: denied }),
    );

    await publisher.drainNow();
    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).not.toHaveBeenCalled();

    await expect(publisher.bindFromSessionHook('claude-session-1', {
      hook_event_name: 'SessionStart',
      session_id: 'claude-session-1',
      transcriptPath,
    })).resolves.toEqual({
      status: 'bound',
      binding: {
        providerSessionId: 'claude-session-1',
        transcriptPath,
      },
    });
    expect(ctx.agentRuntime.transcripts.fileFollow.follow).toHaveBeenCalledTimes(2);
    await ctx.fileFollows[0]?.emit(jsonLine({
      type: 'user',
      uuid: 'user-row-1',
      message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] },
    }));

  expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenCalledWith({
    providerId: 'claude',
    sessionId: 'happy-session-1',
      providerSessionId: 'claude-session-1',
      kind: 'text',
      turnId: 'user-row-1',
      text: '[Request interrupted by user]',
      providerPayload: expect.objectContaining({
        uuid: 'user-row-1',
      }),
    });
  });

  it('continues following the bound transcript after transient read failures', async () => {
    const { ctx } = await createBoundPublisher({ transcriptPath: '/tmp/late-session.jsonl' });
    const error = new Error('transient host follow read error');
    await ctx.fileFollows[0]?.emitError(error);
    await ctx.fileFollows[0]?.emit(jsonLine({
      type: 'assistant',
      uuid: 'assistant-row-1',
      message: { stop_reason: 'end_turn' },
    }));

    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenCalledWith({
      providerId: 'claude',
      sessionId: 'happy-session-1',
      providerSessionId: 'claude-session-1',
      kind: 'assistant_stop',
      turnId: 'assistant-row-1',
      stopReason: 'end_turn',
      providerPayload: expect.objectContaining({
        uuid: 'assistant-row-1',
      }),
    });
    expect(ctx.logger.debug).toHaveBeenCalledWith(
      '[ClaudeUnifiedTerminal] transcript drain deferred',
      expect.objectContaining({ error }),
    );
  });

  it('preserves Claude transcript text exactly when publishing terminal-origin text rows', async () => {
    const { ctx } = await createBoundPublisher();
    await ctx.fileFollows[0]?.emit(jsonLine({
      type: 'user',
      uuid: 'user-row-1',
      message: { content: [{ type: 'text', text: '  /compact\nplease keep spaces  ' }] },
    }));

    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'text',
      text: '  /compact\nplease keep spaces  ',
    }));
  });

  it('publishes all Claude transcript text blocks in order for array content rows', async () => {
    const { ctx } = await createBoundPublisher();
    await ctx.fileFollows[0]?.emit(jsonLine({
      type: 'user',
      uuid: 'user-row-1',
      message: {
        content: [
          { type: 'tool_result', content: 'not prompt text' },
          { type: 'text', text: 'first part ' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '...' } },
          { type: 'text', text: 'second part' },
        ],
      },
    }));

    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'text',
      text: 'first part second part',
    }));
  });

  it('replays normal resume catch-up rows but suppresses prior-era failures and emits live failures once', async () => {
    const historicalUser = {
      type: 'user',
      uuid: 'historical-user-row',
      message: { content: [{ type: 'text', text: 'old prompt from resumed provider history' }] },
    };
    const historicalFailure = {
      type: 'assistant',
      uuid: 'historical-api-error-row',
      isApiErrorMessage: true,
      message: { content: 'API Error: failure from a prior runner era' },
    };
    const historicalCompletion = {
      type: 'assistant',
      uuid: 'historical-assistant-stop-row',
      message: { stop_reason: 'end_turn' },
    };
    const { ctx } = await createBoundPublisher({
      source: 'resume',
      replayLinesOnFollow: [
        jsonLine(historicalUser),
        jsonLine(historicalFailure),
        jsonLine(historicalCompletion),
      ],
    });
    const liveFailure = {
      type: 'assistant',
      uuid: 'live-api-error-row',
      isApiErrorMessage: true,
      message: { content: 'API Error: failure observed after attach' },
    };

    await ctx.fileFollows[0]?.emit(jsonLine(liveFailure));

    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenCalledTimes(2);
    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenNthCalledWith(1, {
      providerId: 'claude',
      sessionId: 'happy-session-1',
      providerSessionId: 'claude-session-1',
      kind: 'text',
      turnId: 'historical-user-row',
      text: 'old prompt from resumed provider history',
      providerPayload: historicalUser,
    });
    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenNthCalledWith(2, {
      providerId: 'claude',
      sessionId: 'happy-session-1',
      providerSessionId: 'claude-session-1',
      kind: 'assistant_api_error',
      turnId: 'live-api-error-row',
      providerPayload: liveFailure,
    });
  });

  it('follows a known resumed transcript from the end without waiting for SessionStart', async () => {
    const { createClaudeUnifiedProviderTranscriptPublisher } = await loadSubject();
    const ctx = createContext();
    const publisher = createClaudeUnifiedProviderTranscriptPublisher({
      ctx,
      sessionId: 'happy-session-known-resume',
    });
    publishers.push(publisher);

    await expect(publisher.bindKnownLiveTranscript({
      providerSessionId: 'claude-known-resume',
      transcriptPath: '/tmp/known-resume.jsonl',
    })).resolves.toEqual({
      status: 'bound',
      binding: {
        providerSessionId: 'claude-known-resume',
        transcriptPath: '/tmp/known-resume.jsonl',
      },
    });

    expect(ctx.agentRuntime.transcripts.fileFollow.follow).toHaveBeenCalledWith(expect.objectContaining({
      path: '/tmp/known-resume.jsonl',
      startAt: 'end',
      strategy: 'poll',
    }));

    const liveUser = {
      type: 'user',
      uuid: 'known-live-user-row',
      timestamp: new Date(Date.now() + 1_000).toISOString(),
      message: { content: [{ type: 'text', text: 'known resumed prompt accepted' }] },
    };

    await ctx.fileFollows[0]?.emit(jsonLine(liveUser));

    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenCalledWith({
      providerId: 'claude',
      sessionId: 'happy-session-known-resume',
      providerSessionId: 'claude-known-resume',
      kind: 'text',
      turnId: 'known-live-user-row',
      text: 'known resumed prompt accepted',
      providerPayload: liveUser,
    });
  });

  it('suppresses rows replayed by a file reset until the first fresh transcript row arrives', async () => {
    const { ctx } = await createBoundPublisher();
    const replayedUser = {
      type: 'user',
      uuid: 'reset-replayed-user',
      timestamp: new Date(Date.now() - 60_000).toISOString(),
      message: { content: [{ type: 'text', text: 'old prompt replayed after file reset' }] },
    };
    const replayedAssistant = {
      type: 'assistant',
      uuid: 'reset-replayed-assistant',
      timestamp: new Date(Date.now() - 59_000).toISOString(),
      message: { stop_reason: 'end_turn' },
    };
    const replayedWithoutTimestamp = {
      type: 'user',
      uuid: 'reset-replayed-no-timestamp',
      message: { content: [{ type: 'text', text: 'unprovably live replay row' }] },
    };
    const freshUser = {
      type: 'user',
      uuid: 'reset-fresh-user',
      timestamp: new Date(Date.now() + 1_000).toISOString(),
      message: { content: [{ type: 'text', text: 'fresh prompt after reset' }] },
    };
    const laterBackdatedRow = {
      type: 'user',
      uuid: 'reset-later-backdated-user',
      timestamp: new Date(Date.now() - 120_000).toISOString(),
      message: { content: [{ type: 'text', text: 'legitimate row after reset suppression cleared' }] },
    };

    await ctx.fileFollows[0]?.emitReset('replaced');
    for (const row of [replayedUser, replayedAssistant, replayedWithoutTimestamp, freshUser, laterBackdatedRow]) {
      await ctx.fileFollows[0]?.emit(jsonLine(row));
    }

    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenCalledTimes(2);
    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenNthCalledWith(1, {
      providerId: 'claude',
      sessionId: 'happy-session-1',
      providerSessionId: 'claude-session-1',
      kind: 'text',
      turnId: 'reset-fresh-user',
      text: 'fresh prompt after reset',
      providerPayload: freshUser,
    });
    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenNthCalledWith(2, {
      providerId: 'claude',
      sessionId: 'happy-session-1',
      providerSessionId: 'claude-session-1',
      kind: 'text',
      turnId: 'reset-later-backdated-user',
      text: 'legitimate row after reset suppression cleared',
      providerPayload: laterBackdatedRow,
    });
  });

  it('does not observe resume-replayed rows on the raw work-state seam before the live cutoff', async () => {
    const observedRows: unknown[] = [];
    const oldGoalStatus = {
      type: 'attachment',
      uuid: 'resume-old-goal-status',
      timestamp: new Date(Date.now() - 60_000).toISOString(),
      attachment: { type: 'goal_status', met: false, condition: 'old replayed goal' },
    };
    const oldGoalWithoutTimestamp = {
      type: 'attachment',
      uuid: 'resume-goal-without-timestamp',
      attachment: { type: 'goal_status', met: false, condition: 'unprovably live goal' },
    };
    const freshGoalStatus = {
      type: 'attachment',
      uuid: 'resume-fresh-goal-status',
      timestamp: new Date(Date.now() + 1_000).toISOString(),
      attachment: { type: 'goal_status', met: false, condition: 'fresh goal' },
    };
    const { ctx } = await createBoundPublisher({
      source: 'resume',
      replayLinesOnFollow: [jsonLine(oldGoalStatus), jsonLine(oldGoalWithoutTimestamp)],
      onObserveRow: (row) => {
        observedRows.push(row);
      },
    });

    await ctx.fileFollows[0]?.emit(jsonLine(freshGoalStatus));

    expect(observedRows).toEqual([freshGoalStatus]);
  });

  it('relabels command-XML rows from bind replay and live follow without leaking raw XML', async () => {
    const { ctx } = await createBoundPublisher();
    const replayCommand = {
      type: 'user',
      uuid: 'replay-command-row',
      timestamp: new Date(Date.now() - 60_000).toISOString(),
      message: {
        content: [{
          type: 'text',
          text: '<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args>medium</command-args>',
        }],
      },
    };
    const replayStdout = {
      type: 'user',
      uuid: 'replay-stdout-row',
      timestamp: new Date(Date.now() - 59_000).toISOString(),
      message: { content: [{ type: 'text', text: '<local-command-stdout>Set effort level to medium</local-command-stdout>' }] },
    };
    const replayCommandNoTimestamp = {
      type: 'user',
      uuid: 'replay-command-row-no-ts',
      message: { content: [{ type: 'text', text: '<command-name>/model</command-name>\n<command-message>model</command-message>' }] },
    };
    const liveCommand = {
      type: 'user',
      uuid: 'live-command-row',
      timestamp: new Date(Date.now() + 1_000).toISOString(),
      message: { content: [{ type: 'text', text: '<command-name>/status</command-name>\n<command-message>status</command-message>' }] },
    };
    const liveUser = {
      type: 'user',
      uuid: 'live-user-row',
      timestamp: new Date(Date.now() + 2_000).toISOString(),
      message: { content: [{ type: 'text', text: 'genuinely new prompt after the bind' }] },
    };

    for (const row of [replayCommand, replayStdout, replayCommandNoTimestamp, liveCommand, liveUser]) {
      await ctx.fileFollows[0]?.emit(jsonLine(row));
    }

    const published = ctx.agentRuntime.sessionHooks.publishProviderTranscript.mock.calls.map((call) => call[0]);
    expect(published).toEqual([
      expect.objectContaining({ kind: 'slash_command', turnId: 'replay-command-row', text: '/effort medium' }),
      expect.objectContaining({ kind: 'local_command_output', turnId: 'replay-stdout-row', text: 'Set effort level to medium' }),
      expect.objectContaining({ kind: 'slash_command', turnId: 'replay-command-row-no-ts', text: '/model' }),
      expect.objectContaining({ kind: 'slash_command', turnId: 'live-command-row', text: '/status' }),
      expect.objectContaining({ kind: 'text', turnId: 'live-user-row', text: 'genuinely new prompt after the bind' }),
    ]);
    expect(JSON.stringify(published)).not.toContain('<command-name>');
    expect(JSON.stringify(published)).not.toContain('<local-command-stdout>');
  });

  it('publishes compact summaries and command artifacts as visible sanitized rows with compact boundaries', async () => {
    const { ctx } = await createBoundPublisher();
    const compactBoundary = {
      type: 'system',
      subtype: 'compact_boundary',
      uuid: 'compact-boundary-1',
      session_id: 'claude-session-1',
    };
    for (const row of [
      {
        type: 'user',
        uuid: 'compact-summary-1',
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
        message: { content: 'This session is being continued from a previous conversation.' },
      },
      {
        type: 'user',
        uuid: 'local-command-caveat-1',
        isMeta: true,
        message: { content: '<local-command-caveat>Generated by a local command.</local-command-caveat>' },
      },
      {
        type: 'user',
        uuid: 'compact-command-1',
        message: { content: '<command-name>/compact</command-name>\n<command-message>compact</command-message>' },
      },
      {
        type: 'user',
        uuid: 'compact-stdout-1',
        message: {
          content:
            '<local-command-stdout>\u001b[2mCompacted\u001b[22m\n'
            + "\u001b[2mPreCompact [python3 '/tmp/hook.py'] completed successfully\u001b[22m\n"
            + "\u001b[2mPostCompact [python3 '/tmp/hook.py'] completed successfully\u001b[22m</local-command-stdout>",
        },
      },
      compactBoundary,
    ]) {
      await ctx.fileFollows[0]?.emit(jsonLine(row));
    }

    const published = ctx.agentRuntime.sessionHooks.publishProviderTranscript.mock.calls.map((call) => call[0]);
    expect(published).toEqual([
      expect.objectContaining({
        kind: 'compact_summary',
        turnId: 'compact-summary-1',
        text: 'This session is being continued from a previous conversation.',
      }),
      expect.objectContaining({ kind: 'slash_command', turnId: 'compact-command-1', text: '/compact' }),
      expect.objectContaining({
        kind: 'local_command_output',
        turnId: 'compact-stdout-1',
        text: "Compacted\nPreCompact [python3 '/tmp/hook.py'] completed successfully\nPostCompact [python3 '/tmp/hook.py'] completed successfully",
      }),
      expect.objectContaining({
        providerId: 'claude',
        sessionId: 'happy-session-1',
        providerSessionId: 'claude-session-1',
        kind: 'compact_boundary',
        turnId: 'compact-boundary-1',
        providerPayload: compactBoundary,
      }),
    ]);
    expect(JSON.stringify(published)).not.toContain('<command-name>');
    expect(JSON.stringify(published)).not.toContain('<local-command-stdout>');
  });

  it('drains complete transcript rows before dispose completes', async () => {
    const { ctx, publisher } = await createBoundPublisher();
    ctx.fileFollows[0]?.close.mockImplementationOnce(async (options) => {
      if (options?.finalDrain === true) {
        await ctx.fileFollows[0]?.emit(jsonLine({
          type: 'assistant',
          uuid: 'assistant-row-final',
          message: { stop_reason: 'end_turn' },
        }));
      }
    });

    await publisher.dispose();

    expect(ctx.fileFollows[0]?.close).toHaveBeenCalledWith({
      finalDrain: true,
      drainTimeoutMs: 750,
    });
    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'assistant_stop',
      turnId: 'assistant-row-final',
    }));
  });

  it('passes the final drain timeout to the host file-follow close operation', async () => {
    const { ctx, publisher } = await createBoundPublisher();

    await publisher.dispose({ drainTimeoutMs: 5 });

    expect(ctx.fileFollows[0]?.close).toHaveBeenCalledWith({
      finalDrain: true,
      drainTimeoutMs: 5,
    });
  });

  it('ignores Claude metadata user rows unless they are Stop hook feedback', async () => {
    const { ctx } = await createBoundPublisher();
    await ctx.fileFollows[0]?.emit(jsonLine({
      type: 'user',
      uuid: 'meta-row-1',
      isMeta: true,
      message: { content: [{ type: 'text', text: 'Claude internal metadata row' }] },
    }));

    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).not.toHaveBeenCalled();
  });

});
