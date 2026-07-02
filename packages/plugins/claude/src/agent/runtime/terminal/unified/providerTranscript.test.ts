import type { TranscriptFileFollowHandleV1, TranscriptFileFollowInputV1, TranscriptFileFollowLineV1 } from '@happier-dev/plugin-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

type TestLogger = Readonly<{
  debug: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
}>;

type TestContext = Readonly<{
  sessionHooks: Readonly<{
    publishProviderTranscript: ReturnType<typeof vi.fn>;
  }>;
  transcripts: Readonly<{
    fileFollow: Readonly<{
      follow: ReturnType<typeof vi.fn>;
    }>;
  }>;
  logger: TestLogger;
  fileFollows: CapturedFileFollow[];
}>;

type ProviderTranscriptPublisher = Readonly<{
  bindFromSessionHook(providerSessionId: string, payload: Readonly<Record<string, unknown>>): Promise<void>;
  drainNow(): Promise<void>;
  dispose(options?: Readonly<{ drainTimeoutMs?: number }>): void | Promise<void>;
}>;

type ProviderTranscriptModule = Readonly<{
  createClaudeUnifiedProviderTranscriptPublisher(params: Readonly<{
    ctx: TestContext;
    sessionId: string;
  }>): ProviderTranscriptPublisher;
}>;

type CapturedFileFollow = Readonly<{
  input: TranscriptFileFollowInputV1;
  handle: TranscriptFileFollowHandleV1;
  emit(line: string): Promise<void>;
  emitError(error: unknown): Promise<void>;
  drainNow: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
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
    async emitError(error: unknown) {
      await input.onError?.(error);
    },
  });
}

function createContext(): TestContext {
  const fileFollows: CapturedFileFollow[] = [];
  const follow = vi.fn(async (input: TranscriptFileFollowInputV1) => {
    const captured = createCapturedFileFollow(input);
    fileFollows.push(captured);
    return captured.handle;
  });
  return {
    sessionHooks: {
      publishProviderTranscript: vi.fn(async () => undefined),
    },
    transcripts: {
      fileFollow: {
        follow,
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
}>): Promise<Readonly<{
  ctx: TestContext;
  publisher: ProviderTranscriptPublisher;
  transcriptPath: string;
}>> {
  const { createClaudeUnifiedProviderTranscriptPublisher } = await loadSubject();
  const transcriptPath = options?.transcriptPath ?? '/tmp/claude-session-1.jsonl';
  const providerSessionId = options?.providerSessionId ?? 'claude-session-1';
  const ctx = createContext();
  const publisher = createClaudeUnifiedProviderTranscriptPublisher({
    ctx,
    sessionId: options?.sessionId ?? 'happy-session-1',
  });
  publishers.push(publisher);
  await publisher.bindFromSessionHook(providerSessionId, {
    hook_event_name: 'SessionStart',
    session_id: providerSessionId,
    transcript_path: transcriptPath,
    ...(options?.source ? { source: options.source } : {}),
  });
  return { ctx, publisher, transcriptPath };
}

describe('createClaudeUnifiedProviderTranscriptPublisher', () => {
  afterEach(async () => {
    for (const publisher of publishers.splice(0)) {
      await publisher.dispose();
    }
  });

  it('publishes Claude lifecycle transcript events from the trusted SessionStart JSONL path', async () => {
    const { ctx, transcriptPath } = await createBoundPublisher();
    expect(ctx.transcripts.fileFollow.follow).toHaveBeenCalledWith(expect.objectContaining({
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

    expect(ctx.sessionHooks.publishProviderTranscript).toHaveBeenCalledTimes(3);
    expect(ctx.sessionHooks.publishProviderTranscript).toHaveBeenNthCalledWith(1, {
      providerId: 'claude',
      sessionId: 'happy-session-1',
      providerSessionId: 'claude-session-1',
      kind: 'assistant_stop',
      turnId: 'assistant-row-1',
      stopReason: 'end_turn',
      providerPayload: assistantEndTurn,
    });
    expect(ctx.sessionHooks.publishProviderTranscript).toHaveBeenNthCalledWith(2, {
      providerId: 'claude',
      sessionId: 'happy-session-1',
      providerSessionId: 'claude-session-1',
      kind: 'stop_hook_feedback',
      turnId: 'user-row-1',
      providerPayload: stopHookFeedback,
    });
    expect(ctx.sessionHooks.publishProviderTranscript).toHaveBeenNthCalledWith(3, {
      providerId: 'claude',
      sessionId: 'happy-session-1',
      providerSessionId: 'claude-session-1',
      kind: 'text',
      turnId: 'user-row-2',
      text: '[Request interrupted by user]',
      providerPayload: interrupted,
    });
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

    expect(ctx.sessionHooks.publishProviderTranscript).toHaveBeenCalledTimes(1);
    expect(ctx.sessionHooks.publishProviderTranscript).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'assistant_stop',
      turnId: 'assistant-row-1',
    }));
  });

  it('fails closed without binding when host file-follow denies the trusted transcript path', async () => {
    const { createClaudeUnifiedProviderTranscriptPublisher } = await loadSubject();
    const transcriptPath = '/tmp/denied-claude-session.jsonl';
    const ctx = createContext();
    const denied = new Error('path is not granted');
    ctx.transcripts.fileFollow.follow.mockRejectedValueOnce(denied);
    const publisher = createClaudeUnifiedProviderTranscriptPublisher({
      ctx,
      sessionId: 'happy-session-1',
    });
    publishers.push(publisher);

    await publisher.bindFromSessionHook('claude-session-1', {
      hook_event_name: 'SessionStart',
      session_id: 'claude-session-1',
      transcriptPath,
    });
    expect(ctx.transcripts.fileFollow.follow).toHaveBeenCalledTimes(1);
    expect(ctx.logger.debug).toHaveBeenCalledWith(
      '[ClaudeUnifiedTerminal] transcript drain deferred',
      expect.objectContaining({ error: denied }),
    );

    await publisher.drainNow();
    expect(ctx.sessionHooks.publishProviderTranscript).not.toHaveBeenCalled();

    await publisher.bindFromSessionHook('claude-session-1', {
      hook_event_name: 'SessionStart',
      session_id: 'claude-session-1',
      transcriptPath,
    });
    expect(ctx.transcripts.fileFollow.follow).toHaveBeenCalledTimes(2);
    await ctx.fileFollows[0]?.emit(jsonLine({
      type: 'user',
      uuid: 'user-row-1',
      message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] },
    }));

    expect(ctx.sessionHooks.publishProviderTranscript).toHaveBeenCalledWith({
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

    expect(ctx.sessionHooks.publishProviderTranscript).toHaveBeenCalledWith({
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

    expect(ctx.sessionHooks.publishProviderTranscript).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'text',
      text: '  /compact\nplease keep spaces  ',
    }));
  });

  it('suppresses historical rows for fresh resumed Claude sessions while publishing appended live rows', async () => {
    const { ctx } = await createBoundPublisher({ source: 'resume' });
    const historicalUser = {
      type: 'user',
      uuid: 'historical-user-row',
      timestamp: new Date(Date.now() - 60_000).toISOString(),
      message: { content: [{ type: 'text', text: 'old prompt from resumed provider history' }] },
    };
    const historicalAssistant = {
      type: 'assistant',
      uuid: 'historical-assistant-row',
      timestamp: new Date(Date.now() - 30_000).toISOString(),
      message: { stop_reason: 'end_turn' },
    };
    const liveUser = {
      type: 'user',
      uuid: 'live-user-row',
      timestamp: new Date(Date.now() + 1_000).toISOString(),
      message: { content: [{ type: 'text', text: 'new prompt accepted after resume bind' }] },
    };

    await ctx.fileFollows[0]?.emit(jsonLine(historicalUser));
    await ctx.fileFollows[0]?.emit(jsonLine(historicalAssistant));
    await ctx.fileFollows[0]?.emit(jsonLine(liveUser));

    expect(ctx.sessionHooks.publishProviderTranscript).toHaveBeenCalledTimes(1);
    expect(ctx.sessionHooks.publishProviderTranscript).toHaveBeenCalledWith({
      providerId: 'claude',
      sessionId: 'happy-session-1',
      providerSessionId: 'claude-session-1',
      kind: 'text',
      turnId: 'live-user-row',
      text: 'new prompt accepted after resume bind',
      providerPayload: liveUser,
    });
  });

  it('drops command-XML user rows from the one-time bind replay but keeps live command rows and genuine new rows (resume-replay leak, Z)', async () => {
    // A command-XML row reaching the bind-time replay was either suppressed by a previous
    // runner or written during downtime; raw `<command-name>`/`<local-command-stdout>` XML
    // must never re-render as a user message after a respawn. LIVE rows (appended after the
    // bind) keep Lane M's policy: a genuine user-typed command in the attached TUI may surface.
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
    // No timestamp = unprovably-live; command XML fails closed to the snapshot filter.
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

    const publishedTurnIds = ctx.sessionHooks.publishProviderTranscript.mock.calls
      .map((call) => (call[0] as { turnId?: string }).turnId);
    expect(publishedTurnIds).toEqual(['live-command-row', 'live-user-row']);
  });

  it('suppresses compact summary and local-command artifacts while publishing compact boundaries', async () => {
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

    expect(ctx.sessionHooks.publishProviderTranscript).toHaveBeenCalledTimes(1);
    expect(ctx.sessionHooks.publishProviderTranscript).toHaveBeenCalledWith({
      providerId: 'claude',
      sessionId: 'happy-session-1',
      providerSessionId: 'claude-session-1',
      kind: 'compact_boundary',
      turnId: 'compact-boundary-1',
      providerPayload: compactBoundary,
    });
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
    expect(ctx.sessionHooks.publishProviderTranscript).toHaveBeenCalledWith(expect.objectContaining({
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

    expect(ctx.sessionHooks.publishProviderTranscript).not.toHaveBeenCalled();
  });

});
