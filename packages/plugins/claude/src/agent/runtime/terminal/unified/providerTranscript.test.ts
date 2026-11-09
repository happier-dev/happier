import type { JsonValue } from '@happier-dev/plugin-sdk';
import { PluginError } from '@happier-dev/plugin-sdk';
import type {
  AgentTranscriptFileFollowHandle as TranscriptFileFollowHandleV1,
  AgentTranscriptFileFollowInput as TranscriptFileFollowInputV1,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ClaudeUnifiedProviderTranscriptBindResult } from './providerTranscript.js';
import * as loadedSubject from './providerTranscript.js';

type TranscriptFileFollowLineV1 = Parameters<TranscriptFileFollowInputV1['onLine']>[0];
type TranscriptFileFollowResetReasonV1 = Parameters<
  NonNullable<TranscriptFileFollowInputV1['onReset']>
>[0]['reason'];

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
      followSource: ReturnType<typeof vi.fn>;
      fileFollow: Readonly<{
        follow: ReturnType<typeof vi.fn>;
      }>;
    }>;
  }>;
  logger: TestLogger;
  fileFollows: CapturedFileFollow[];
}>;

type ProviderTranscriptPublisher = Readonly<{
  readSourceFollowReadiness(): Readonly<{ status: string; error?: Error }>;
  observeSourceTranscript(input: Readonly<{ providerSessionId: string; sourceId: string; row: JsonValue }>): Promise<void>;
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
    historicalProviderSessionId?: string;
    onPublishPayload?: Parameters<typeof loadedSubject.createClaudeUnifiedProviderTranscriptPublisher>[0]['onPublishPayload'];
    onObserveRow?: (row: unknown, observation: Readonly<{ providerSessionId: string; historicalReplay: boolean; projectedTaskResult?: unknown }>) => void;
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
        followSource: vi.fn(async () => ({ dispose: vi.fn(async () => undefined) })),
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
  return loadedSubject;
}

async function createBoundPublisher(options?: Readonly<{
  transcriptPath?: string;
  providerSessionId?: string;
  sessionId?: string;
  source?: string;
  replayLinesOnFollow?: readonly string[];
  onPublishPayload?: Parameters<typeof loadedSubject.createClaudeUnifiedProviderTranscriptPublisher>[0]['onPublishPayload'];
  onObserveRow?: (row: unknown, observation: Readonly<{ providerSessionId: string; historicalReplay: boolean; projectedTaskResult?: unknown }>) => void;
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
    ...(options?.onPublishPayload ? { onPublishPayload: options.onPublishPayload } : {}),
  });
  publishers.push(publisher);
  const bindResult = await publisher.bindFromSessionHook(providerSessionId, {
    hook_event_name: 'SessionStart',
    session_id: providerSessionId,
    transcript_path: transcriptPath,
    // Projection cases start with admitted history. Fresh startup admission is
    // exercised with the real identity writer in the composed CLI regression.
    source: options?.source ?? 'resume',
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
    const { ctx, publisher, transcriptPath } = await createBoundPublisher();
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
      await publisher.observeSourceTranscript({ providerSessionId: 'claude-session-1', sourceId: `source:${row.uuid}`, row });
    }

    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenCalledTimes(3);
    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenNthCalledWith(1, {
      providerSessionId: 'claude-session-1',
      kind: 'assistant_stop',
      turnId: 'assistant-row-1',
      stopReason: 'end_turn',
      providerPayload: assistantEndTurn,
    });
    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenNthCalledWith(2, {
      providerSessionId: 'claude-session-1',
      kind: 'stop_hook_feedback',
      turnId: 'user-row-1',
      providerPayload: stopHookFeedback,
    });
    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenNthCalledWith(3, {
      providerSessionId: 'claude-session-1',
      kind: 'text',
      turnId: 'user-row-2',
      text: '[Request interrupted by user]',
      providerPayload: interrupted,
    });
  });

  it('keeps compact acceptance and terminal lifecycle behind ordered host import', async () => {
    const localPayloads: loadedSubject.ClaudeProviderTranscriptPayload[] = [];
    const { ctx, publisher } = await createBoundPublisher({ onPublishPayload: payload => { localPayloads.push(payload); } });
    const { mapClaudeUnifiedTranscriptLifecyclePayload } = await import('./lifecycleEvents.js');
    const rows = [
      { type: 'system', subtype: 'compact_boundary', uuid: 'ordered-compact-boundary',
        compactMetadata: { trigger: 'manual', preTokens: 1_000 } },
      { type: 'user', uuid: 'ordered-interrupt', message: { content: '[Request interrupted by user]' } },
      { type: 'assistant', uuid: 'ordered-stop', message: { stop_reason: 'end_turn' } },
    ];
    for (const row of rows) await ctx.fileFollows[0]?.emit(jsonLine(row));
    const lifecycle = () => localPayloads
      .map(payload => mapClaudeUnifiedTranscriptLifecyclePayload(payload, 'happy-session-1'))
      .filter(Boolean);
    expect(lifecycle()).toEqual([]);
    for (const [index, row] of rows.entries()) {
    await publisher.observeSourceTranscript({ providerSessionId: 'claude-session-1', sourceId: `lifecycle:${index}`, row });
    }
    expect(lifecycle().map((event) => event?.type)).toEqual([
      'compaction_completed', 'turn_aborted', 'completion_candidate',
    ]);
    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript.mock.calls.some(([payload]) => payload.kind === 'compact_boundary')).toBe(false);
  });

  it('publishes queued-command acceptance only after one exact native enqueue/remove/consumption episode', async () => {
    const { ctx, publisher } = await createBoundPublisher();
    const enqueuedAt = new Date(Date.now() + 1_000).toISOString();
    const attachedAt = new Date(Date.parse(enqueuedAt) - 5).toISOString();
    const queuedCommandEnqueue = {
      type: 'queue-operation',
      operation: 'enqueue',
      sessionId: 'claude-session-1',
      content: 'prompt delivered through Claude queue',
      timestamp: attachedAt,
    };
    const queuedCommandRemove = {
      type: 'queue-operation',
      operation: 'remove',
      sessionId: 'claude-session-1',
      content: 'prompt delivered through Claude queue',
      timestamp: new Date(Date.now() + 2_000).toISOString(),
    };
    const queuedCommandConsumption = {
      type: 'attachment',
      uuid: 'queued-command-row-1',
      parentUuid: 'queued-command-parent-1',
      isSidechain: false,
      sessionId: 'claude-session-1',
      timestamp: enqueuedAt,
      attachment: {
        type: 'queued_command',
        prompt: 'prompt delivered through Claude queue',
        commandMode: 'prompt',
        origin: { kind: 'human' },
        timestamp: attachedAt,
      },
    };

    await ctx.fileFollows[0]?.emit(jsonLine(queuedCommandEnqueue));
    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).not.toHaveBeenCalled();
    await ctx.fileFollows[0]?.emit(jsonLine(queuedCommandRemove));
    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).not.toHaveBeenCalled();
    await ctx.fileFollows[0]?.emit(jsonLine(queuedCommandConsumption));

    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).not.toHaveBeenCalled();
    for (const [index, row] of [queuedCommandEnqueue, queuedCommandRemove, queuedCommandConsumption].entries()) {
    await publisher.observeSourceTranscript({ providerSessionId: 'claude-session-1', sourceId: `source:${index}`, row });
    }

    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenCalledTimes(1);
    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenCalledWith({
      providerSessionId: 'claude-session-1',
      kind: 'queued_command',
      turnId: 'queued-command-row-1',
      text: 'prompt delivered through Claude queue',
      providerPayload: queuedCommandConsumption,
    });
    // A later host batch failure can replay the whole delivered prefix. Stable source ids
    // must not recreate an enqueue episode that credits a second consumption.
    for (const [index, row] of [queuedCommandEnqueue, queuedCommandRemove, queuedCommandConsumption].entries()) {
    await publisher.observeSourceTranscript({ providerSessionId: 'claude-session-1', sourceId: `source:${index}`, row });
    }
    await publisher.observeSourceTranscript({
      providerSessionId: 'claude-session-1', sourceId: 'source:next-consumption',
      row: { ...queuedCommandConsumption, uuid: 'unmatched-next-consumption' },
    });
    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenCalledTimes(1);
  });

  it.each(['absorbed_mid_turn', 'delivered_to_agent', 'cleared_on_cancel', 'dropped_by_hook'])(
    'joins attachment-before-removal using the native disposition and identities: %s',
    async (reason) => {
      const { ctx, publisher } = await createBoundPublisher();
      const sessionId = 'claude-session-1';
      const prompt = 'the same queued prompt';
      const timestamp = new Date().toISOString();
      let sourceIndex = 0;
      const observe = async (row: Parameters<ProviderTranscriptPublisher['observeSourceTranscript']>[0]['row']) => {
        await publisher.observeSourceTranscript({ providerSessionId: sessionId, sourceId: `ordered:${sourceIndex++}`, row });
      };
      const enqueue = { type: 'queue-operation', operation: 'enqueue', sessionId, content: prompt, timestamp };
      const attachment = {
        type: 'attachment', uuid: 'queued-old', parentUuid: 'parent', isSidechain: false, sessionId, timestamp,
        attachment: { type: 'queued_command', prompt, commandMode: 'prompt', origin: { kind: 'human' },
          source_uuid: 'command-old', delivery_id: 'delivery-old' },
      };
      const remove = { type: 'queue-operation', operation: 'remove', sessionId, timestamp, reason,
        ...(reason === 'dropped_by_hook' ? {} : { content: prompt }),
        commandUuid: 'command-old', deliveryId: 'delivery-old' };
      await observe(enqueue);
      await observe(attachment);
      expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).not.toHaveBeenCalled();
      await observe(remove);
      const discarded = reason === 'cleared_on_cancel' || reason === 'dropped_by_hook';
      expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript.mock.calls.map(([payload]) => payload)).toEqual(
        discarded ? [] : [expect.objectContaining({ kind: 'queued_command', turnId: 'queued-old', providerPayload: attachment })],
      );
      if (!discarded) return;

      // A canceled predecessor must absorb its replayed removal and late attachment,
      // while an identical replacement waits for its own consumed disposition.
      await observe(enqueue);
      await observe(remove);
      const replacement = { ...attachment, uuid: 'queued-replacement', attachment: {
        ...attachment.attachment, source_uuid: 'command-replacement', delivery_id: 'delivery-replacement',
      } };
      await observe(replacement);
      await observe(attachment);
      expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).not.toHaveBeenCalled();
      await observe({ ...remove, content: prompt, reason: 'absorbed_mid_turn',
        commandUuid: 'command-replacement', deliveryId: 'delivery-replacement' });
      expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript.mock.calls.map(([payload]) => payload)).toEqual([
        expect.objectContaining({ kind: 'queued_command', turnId: 'queued-replacement', providerPayload: replacement }),
      ]);
    },
  );

  it('publishes repeated identical native queue episodes in chronological one-to-one order', async () => {
    const { ctx, publisher } = await createBoundPublisher();
    const prompt = 'repeat this exact native queue prompt';
    const sessionId = 'claude-session-1';
    const baseMs = Date.now() + 1_000;
    const operations = [
      ...[0, 1].map((episode) => ({
        type: 'queue-operation',
        operation: 'enqueue',
        sessionId,
        content: prompt,
        timestamp: new Date(baseMs + episode * 1_000).toISOString(),
      })),
      ...[0, 1].map((episode) => ({
        type: 'queue-operation',
        operation: 'remove',
        sessionId,
        content: prompt,
        timestamp: new Date(baseMs + 2_500 + episode * 500).toISOString(),
      })),
    ];
    const consumptions = [0, 1].map((episode) => {
      const attachedAt = new Date(baseMs + episode * 1_000 - 5).toISOString();
      return {
        type: 'attachment',
        uuid: `repeated-queued-command-${episode + 1}`,
        parentUuid: `repeated-queued-parent-${episode + 1}`,
        isSidechain: false,
        sessionId,
        timestamp: attachedAt,
        attachment: {
          type: 'queued_command',
          prompt,
          commandMode: 'prompt',
          origin: { kind: 'human' },
          timestamp: attachedAt,
        },
      };
    });

    for (const [index, row] of [...operations, ...consumptions].entries()) {
    await publisher.observeSourceTranscript({ providerSessionId: sessionId, sourceId: `source:${index}`, row });
    }

    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenCalledTimes(2);
    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenNthCalledWith(1, expect.objectContaining({
      kind: 'queued_command',
      turnId: 'repeated-queued-command-1',
      text: prompt,
    }));
    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenNthCalledWith(2, expect.objectContaining({
      kind: 'queued_command',
      turnId: 'repeated-queued-command-2',
      text: prompt,
    }));
  });

  it('fails closed for incomplete, mismatched, sidechain, rotated-binding, and duplicate queue evidence', async () => {
    const { ctx, publisher } = await createBoundPublisher();
    let episodeIndex = 0;
    const createEpisode = (overrides?: Readonly<{
      prompt?: string;
      operationSessionId?: string;
      consumptionSessionId?: string;
      consumptionPrompt?: string;
      isSidechain?: boolean;
      commandMode?: string;
      originKind?: string;
    }>) => {
      episodeIndex += 1;
      const prompt = overrides?.prompt ?? `queued prompt ${episodeIndex}`;
      const enqueuedAt = new Date(Date.now() + episodeIndex * 10_000).toISOString();
      return {
        enqueue: {
          type: 'queue-operation',
          operation: 'enqueue',
          sessionId: overrides?.operationSessionId ?? 'claude-session-1',
          content: prompt,
          timestamp: enqueuedAt,
        },
        remove: {
          type: 'queue-operation',
          operation: 'remove',
          sessionId: overrides?.operationSessionId ?? 'claude-session-1',
          content: prompt,
          timestamp: new Date(Date.parse(enqueuedAt) + 1_000).toISOString(),
        },
        consumption: {
          type: 'attachment',
          uuid: `queued-command-row-${episodeIndex}`,
          parentUuid: `queued-command-parent-${episodeIndex}`,
          isSidechain: overrides?.isSidechain ?? false,
          sessionId: overrides?.consumptionSessionId ?? 'claude-session-1',
          timestamp: enqueuedAt,
          attachment: {
            type: 'queued_command',
            prompt: overrides?.consumptionPrompt ?? prompt,
            commandMode: overrides?.commandMode ?? 'prompt',
            origin: { kind: overrides?.originKind ?? 'human' },
            timestamp: enqueuedAt,
          },
        },
      };
    };
    let sourceSequence = 0;
    const emit = async (...rows: readonly JsonValue[]) => {
      for (const row of rows) {
        await publisher.observeSourceTranscript({ providerSessionId: 'claude-session-1', sourceId: `source:${sourceSequence++}`, row });
      }
    };

    const enqueueOnly = createEpisode();
    await emit(enqueueOnly.enqueue);
    const removeOnly = createEpisode();
    await emit(removeOnly.remove);
    const attachmentOnly = createEpisode();
    await emit(attachmentOnly.consumption);

    const sidechain = createEpisode({ isSidechain: true });
    await emit(sidechain.enqueue, sidechain.remove, sidechain.consumption);
    const wrongSession = createEpisode({
      operationSessionId: 'other-session',
      consumptionSessionId: 'other-session',
    });
    await emit(wrongSession.enqueue, wrongSession.remove, wrongSession.consumption);
    const wrongContent = createEpisode({ consumptionPrompt: 'different prompt' });
    await emit(wrongContent.enqueue, wrongContent.remove, wrongContent.consumption);
    const wrongMode = createEpisode({ commandMode: 'command' });
    await emit(wrongMode.enqueue, wrongMode.remove, wrongMode.consumption);
    const wrongOrigin = createEpisode({ originKind: 'system' });
    await emit(wrongOrigin.enqueue, wrongOrigin.remove, wrongOrigin.consumption);
    const resetBeforeConsumption = createEpisode();
    await emit(resetBeforeConsumption.enqueue, resetBeforeConsumption.remove);
    await publisher.bindFromSessionHook('claude-session-1', {
      hook_event_name: 'SessionStart', transcript_path: '/tmp/rotated-session.jsonl', source: 'resume',
    });
    await emit(resetBeforeConsumption.consumption);
    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).not.toHaveBeenCalled();

    const accepted = createEpisode();
    await emit(accepted.enqueue, accepted.remove, accepted.consumption);
    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenCalledTimes(1);

    await emit(accepted.consumption, accepted.remove, {
      ...accepted.consumption,
      uuid: 'conflicting-duplicate-transcript-row',
    });
    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenCalledTimes(1);
  });

  it('awaits host source-follow binding and releases it with the publisher', async () => {
    const { createClaudeUnifiedProviderTranscriptPublisher } = await loadSubject();
    const ctx = createContext();
    let finishBinding!: (handle: { dispose(): Promise<void> }) => void;
    ctx.agentRuntime.transcripts.followSource.mockImplementation(() => new Promise((resolve) => { finishBinding = resolve; }));
    const publisher = createClaudeUnifiedProviderTranscriptPublisher({ ctx, sessionId: 'happy-session-1' });
    publishers.push(publisher);
    let bound = false;
    const binding = publisher.bindFromSessionHook('claude-session-1', {
      hook_event_name: 'SessionStart', transcript_path: '/tmp/claude-session-1.jsonl', source: 'resume',
    }).then(() => { bound = true; });
    await vi.waitFor(() => expect(ctx.agentRuntime.transcripts.followSource).toHaveBeenCalledWith({
      providerSessionId: 'claude-session-1', replay: 'historical',
    }));
    expect(bound).toBe(false);
    const dispose = vi.fn(async () => undefined);
    finishBinding({ dispose });
    await binding;
    await publisher.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('settles failed host source-follow admission once for an unchanged binding', async () => {
    const { createClaudeUnifiedProviderTranscriptPublisher } = await loadSubject();
    const ctx = createContext();
    const failure = Object.assign(new Error('source unavailable'), { code: 'native_agent_terminal_transcript_follow_admission_failed' });
    ctx.agentRuntime.transcripts.followSource.mockRejectedValueOnce(failure);
    const publisher = createClaudeUnifiedProviderTranscriptPublisher({ ctx, sessionId: 'happy-session-1' });
    publishers.push(publisher);
    const hook = { hook_event_name: 'SessionStart', transcript_path: '/tmp/claude-session-1.jsonl', source: 'resume' };
    await expect(publisher.bindFromSessionHook('claude-session-1', hook)).rejects.toBe(failure);
    expect(publisher.readSourceFollowReadiness()).toEqual({ status: 'failed', error: failure });
    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(publisher.bindFromSessionHook('claude-session-1', hook)).rejects.toBe(failure);
    }
    expect(ctx.agentRuntime.transcripts.followSource).toHaveBeenCalledTimes(1);
    expect(ctx.fileFollows).toHaveLength(1);
    await ctx.fileFollows[0]?.emit(jsonLine({ type: 'user', uuid: 'after-failed-admission', sessionId: 'claude-session-1', message: { content: 'native row' } }));
    expect(ctx.agentRuntime.transcripts.followSource).toHaveBeenCalledTimes(1);
    // A new native binding is an explicit new admission, so recovery remains available.
    await expect(publisher.bindFromSessionHook('claude-session-2', {
      ...hook, transcript_path: '/tmp/claude-session-2.jsonl',
    })).resolves.toMatchObject({ status: 'bound' });
    expect(publisher.readSourceFollowReadiness()).toEqual({ status: 'ready' });
    expect(ctx.agentRuntime.transcripts.followSource).toHaveBeenCalledTimes(2);
  });

  it('deduplicates ordered source replay and rejects foreign or disposed bindings', async () => {
    const { ctx, publisher } = await createBoundPublisher();
    const row = { type: 'user', uuid: 'ordered-user', sessionId: 'claude-session-1', message: { content: 'ordered prompt' } };
    const observation = { providerSessionId: 'claude-session-1', sourceId: 'source:user:1', row };
    await ctx.fileFollows[0]?.emit(jsonLine(row));
    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).not.toHaveBeenCalled();
    await publisher.observeSourceTranscript({ ...observation, providerSessionId: 'foreign-session' });
    await publisher.observeSourceTranscript({ ...observation, row: null });
    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).not.toHaveBeenCalled();
    await publisher.observeSourceTranscript(observation);
    await publisher.observeSourceTranscript(observation);
    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenCalledTimes(1);
    await publisher.dispose();
    await publisher.observeSourceTranscript({ ...observation, sourceId: 'source:user:2' });
    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenCalledTimes(1);
  });

  it('still observes queued-command rows through the raw work-state seam', async () => {
    const observedRows: Array<Readonly<{
      row: unknown;
      observation: Readonly<{ providerSessionId: string; historicalReplay: boolean }>;
    }>> = [];
    const { ctx } = await createBoundPublisher({
      onObserveRow: (row, observation) => {
        observedRows.push({ row, observation });
      },
    });
    const queuedCommandOperation = {
      type: 'queue-operation',
      operation: 'enqueue',
      uuid: 'queued-command-row-1',
      sessionId: 'claude-session-1',
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

    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).not.toHaveBeenCalled();
    expect(observedRows).toEqual([
      {
        row: queuedCommandOperation,
        observation: {
          providerSessionId: 'claude-session-1',
          transcriptPath: '/tmp/claude-session-1.jsonl',
          historicalReplay: false,
        },
      },
      {
        row: queuedCommandAttachment,
        observation: {
          providerSessionId: 'claude-session-1',
          transcriptPath: '/tmp/claude-session-1.jsonl',
          historicalReplay: false,
        },
      },
    ]);
  });

  it.each(['completed', 'failed', 'stopped'] as const)('issue506 ordered terminal source routes native queued %s received before ACK without publishing a control row', async status => {
    const observations: Array<Readonly<{ historicalReplay: boolean; projectedTaskResult?: unknown }>> = [];
    const { ctx, publisher } = await createBoundPublisher({ onObserveRow: (_row, observation) => { observations.push(observation); } });
    const terminal = { type: 'attachment', uuid: 'early-terminal', sessionId: 'claude-session-1', attachment: {
      type: 'queued_command', commandMode: 'task-notification', prompt:
        `<task-notification><task-id>native-task</task-id><status>${status}</status><result>Native findings</result></task-notification>`,
    } };
    const ack = { type: 'user', uuid: 'ack', sessionId: 'claude-session-1', toolUseResult: { status: 'async_launched', agentId: 'native-task' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'original-tool', content: 'Async agent launched successfully.' }] } };
    for (const row of [terminal, ack]) {
      const input = { providerSessionId: 'claude-session-1', sourceId: `source:${row.uuid}`, row };
      await publisher.observeSourceTranscript(input);
      await publisher.observeSourceTranscript(input);
    }
    const results = observations.flatMap(observation => observation.projectedTaskResult ? [observation.projectedTaskResult] : []);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ type: 'user', uuid: 'early-terminal', origin: { toolUseId: 'original-tool' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'original-tool', content: [{ type: 'text', text: 'Native findings' }], is_error: status !== 'completed' }] } });
    expect(results[0]).not.toHaveProperty('isMeta');
    if (status !== 'completed') expect(results[0]).toMatchObject({ toolUseResult: { status: status === 'stopped' ? 'cancelled' : 'failed' } });
    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).not.toHaveBeenCalled();
  });

  it('observes but never accepts queued-command history replayed during SessionStart binding', async () => {
    const enqueuedAt = new Date(Date.now() + 1_000).toISOString();
    const queuedCommandEnqueue = {
      type: 'queue-operation',
      operation: 'enqueue',
      sessionId: 'claude-session-1',
      content: 'prompt already present before SessionStart binding',
      timestamp: enqueuedAt,
    };
    const queuedCommandRemove = {
      type: 'queue-operation',
      operation: 'remove',
      sessionId: 'claude-session-1',
      content: 'prompt already present before SessionStart binding',
      timestamp: new Date(Date.now() + 2_000).toISOString(),
    };
    const queuedCommandConsumption = {
      type: 'attachment',
      uuid: 'queued-command-initial-row',
      parentUuid: 'queued-command-initial-parent',
      isSidechain: false,
      sessionId: 'claude-session-1',
      timestamp: enqueuedAt,
      attachment: {
        type: 'queued_command',
        prompt: 'prompt already present before SessionStart binding',
        commandMode: 'prompt',
        origin: { kind: 'human' },
        timestamp: enqueuedAt,
      },
    };
    const observedRows: Array<Readonly<{
      row: unknown;
      observation: Readonly<{ providerSessionId: string; historicalReplay: boolean }>;
    }>> = [];
    const { createClaudeUnifiedProviderTranscriptPublisher } = await loadSubject();
    const ctx = createContext({
      replayLinesOnFollow: [
        jsonLine(queuedCommandEnqueue),
        jsonLine(queuedCommandRemove),
        jsonLine(queuedCommandConsumption),
      ],
    });
    const publisher = createClaudeUnifiedProviderTranscriptPublisher({
      ctx,
      onObserveRow: (row, observation) => {
        observedRows.push({ row, observation });
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
    expect(observedRows).toEqual([
      queuedCommandEnqueue,
      queuedCommandRemove,
      queuedCommandConsumption,
    ].map((row) => ({
      row,
      observation: {
        providerSessionId: 'claude-session-1',
        transcriptPath: '/tmp/claude-session-1.jsonl',
        historicalReplay: true,
      },
    })));
    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).not.toHaveBeenCalled();
  });

  it('keeps historical compact boundaries lifecycle-inert during resume catch-up while observing the next live boundary locally', async () => {
    const historicalCompactBoundary = {
      type: 'system',
      subtype: 'compact_boundary',
      uuid: 'historical-compact-boundary',
      session_id: 'claude-session-1',
      compactMetadata: { trigger: 'auto' },
    };
    const { createClaudeUnifiedProviderTranscriptPublisher } = await loadSubject();
    const ctx = createContext({
      replayLinesOnFollow: [jsonLine(historicalCompactBoundary)],
    });
    const onPublishPayload = vi.fn();
    const publisher = createClaudeUnifiedProviderTranscriptPublisher({ ctx, onPublishPayload });
    publishers.push(publisher);

    await expect(publisher.bindFromSessionHook('claude-session-1', {
      hook_event_name: 'SessionStart',
      source: 'resume',
      session_id: 'claude-session-1',
      transcript_path: '/tmp/claude-session-1.jsonl',
    })).resolves.toEqual({
      status: 'bound',
      binding: {
        providerSessionId: 'claude-session-1',
        transcriptPath: '/tmp/claude-session-1.jsonl',
      },
    });
    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).not.toHaveBeenCalled();

    const liveCompactBoundary = {
      type: 'system',
      subtype: 'compact_boundary',
      uuid: 'live-compact-boundary',
      session_id: 'claude-session-1',
      compactMetadata: { trigger: 'auto' },
    };
    await ctx.fileFollows[0]?.emit(jsonLine(liveCompactBoundary));
    await publisher.observeSourceTranscript({ providerSessionId: 'claude-session-1', sourceId: `source:${liveCompactBoundary.uuid}`, row: liveCompactBoundary });

    expect(onPublishPayload).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'compact_boundary',
      turnId: 'live-compact-boundary',
    }));
    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).not.toHaveBeenCalled();
  });

  it('does not publish Claude synthetic no-response assistant closures as completion evidence', async () => {
    const { ctx, publisher } = await createBoundPublisher();
    await publisher.observeSourceTranscript({ providerSessionId: 'claude-session-1', sourceId: 'source:ignored', row: {
      type: 'assistant',
      uuid: 'synthetic-no-response',
      isSidechain: false,
      model: '<synthetic>',
      message: {
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'No response requested.' }],
      },
    } });

    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).not.toHaveBeenCalled();
  });

  it('drops sidechain rows so subagent activity never becomes parent-turn lifecycle evidence', async () => {
    const { ctx, publisher } = await createBoundPublisher();
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
      await publisher.observeSourceTranscript({ providerSessionId: 'claude-session-1', sourceId: `source:${row.uuid}`, row });
    }

    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenCalledTimes(1);
    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'assistant_stop',
      turnId: 'assistant-row-1',
    }));
  });

  it('settles a denied host file-follow admission without retrying the binding', async () => {
    const { createClaudeUnifiedProviderTranscriptPublisher } = await loadSubject();
    const transcriptPath = '/tmp/denied-claude-session.jsonl';
    const ctx = createContext();
    const denied = new PluginError({ code: 'PLUGIN_TRANSCRIPTS_FILE_FOLLOW_PATH_DENIED', message: 'path is not granted' });
    ctx.agentRuntime.transcripts.fileFollow.follow.mockRejectedValueOnce(denied);
    const publisher = createClaudeUnifiedProviderTranscriptPublisher({
      ctx,
    });
    publishers.push(publisher);

    await expect(publisher.bindFromSessionHook('claude-session-1', {
      hook_event_name: 'SessionStart',
      source: 'resume',
      session_id: 'claude-session-1',
      transcriptPath,
    })).rejects.toBe(denied);
    expect(publisher.readSourceFollowReadiness()).toEqual({ status: 'failed', error: denied });
    expect(ctx.agentRuntime.transcripts.fileFollow.follow).toHaveBeenCalledTimes(1);

    await publisher.drainNow();
    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).not.toHaveBeenCalled();

    await expect(publisher.bindFromSessionHook('claude-session-1', {
      hook_event_name: 'SessionStart',
      source: 'resume',
      session_id: 'claude-session-1',
      transcriptPath,
    })).rejects.toBe(denied);
    expect(ctx.agentRuntime.transcripts.fileFollow.follow).toHaveBeenCalledTimes(1);
    expect(ctx.agentRuntime.transcripts.followSource).not.toHaveBeenCalled();
    await publisher.observeSourceTranscript({ providerSessionId: 'claude-session-1', sourceId: 'source:live-row', row: {
      type: 'user',
      uuid: 'user-row-1',
      message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] },
    } });

    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).not.toHaveBeenCalled();
  });

  it('continues following the bound transcript after transient read failures', async () => {
    const { ctx, publisher } = await createBoundPublisher({ transcriptPath: '/tmp/late-session.jsonl' });
    const error = new Error('transient host follow read error');
    await ctx.fileFollows[0]?.emitError(error);
    await publisher.observeSourceTranscript({ providerSessionId: 'claude-session-1', sourceId: 'source:live-row', row: {
      type: 'assistant',
      uuid: 'assistant-row-1',
      message: { stop_reason: 'end_turn' },
    } });

    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenCalledWith({
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
    const { ctx, publisher } = await createBoundPublisher();
    await publisher.observeSourceTranscript({ providerSessionId: 'claude-session-1', sourceId: 'source:user:1', row: {
      type: 'user',
      uuid: 'user-row-1',
      message: { content: [{ type: 'text', text: '  /compact\nplease keep spaces  ' }] },
    } });

    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'text',
      text: '  /compact\nplease keep spaces  ',
    }));
  });

  it('publishes all Claude transcript text blocks in order for array content rows', async () => {
    const { ctx, publisher } = await createBoundPublisher();
    await publisher.observeSourceTranscript({ providerSessionId: 'claude-session-1', sourceId: 'source:user:1', row: {
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
    } });

    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'text',
      text: 'first part second part',
    }));
  });

  it('suppresses historical acceptance and prior-era failures while emitting live failures once', async () => {
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
    const { ctx, publisher } = await createBoundPublisher({
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
    await publisher.observeSourceTranscript({ providerSessionId: 'claude-session-1', sourceId: `source:${liveFailure.uuid}`, row: liveFailure });

    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenCalledTimes(1);
    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenNthCalledWith(1, {
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
      historicalProviderSessionId: 'claude-known-resume',
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
    await publisher.observeSourceTranscript({ providerSessionId: 'claude-known-resume', sourceId: `source:${liveUser.uuid}`, row: liveUser });

    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenCalledWith({
      providerSessionId: 'claude-known-resume',
      kind: 'text',
      turnId: 'known-live-user-row',
      text: 'known resumed prompt accepted',
      providerPayload: liveUser,
    });
  });

  it('rebinds to a rotated main SessionStart identity and stops publishing the prior transcript', async () => {
    const { createClaudeUnifiedProviderTranscriptPublisher } = await loadSubject();
    const ctx = createContext();
    const observedRows: unknown[] = [];
    const publisher = createClaudeUnifiedProviderTranscriptPublisher({
      ctx,
      onObserveRow: (row) => {
        observedRows.push(row);
      },
    });
    publishers.push(publisher);

    await expect(publisher.bindKnownLiveTranscript({
      providerSessionId: 'claude-session-before-compact',
      transcriptPath: '/tmp/claude-session-before-compact.jsonl',
    })).resolves.toEqual({
      status: 'bound',
      binding: {
        providerSessionId: 'claude-session-before-compact',
        transcriptPath: '/tmp/claude-session-before-compact.jsonl',
      },
    });

    await expect(publisher.bindFromSessionHook('claude-session-after-compact', {
      hook_event_name: 'SessionStart',
      source: 'compact',
      session_id: 'claude-session-after-compact',
      transcript_path: '/tmp/claude-session-after-compact.jsonl',
    })).resolves.toEqual({
      status: 'bound',
      binding: {
        providerSessionId: 'claude-session-after-compact',
        transcriptPath: '/tmp/claude-session-after-compact.jsonl',
      },
    });

    expect(ctx.fileFollows).toHaveLength(2);
    expect(ctx.fileFollows[0]?.close).toHaveBeenCalledTimes(1);

    const rotatedRow = {
      type: 'assistant',
      sessionId: 'claude-session-after-compact',
      uuid: 'assistant-after-compact',
      message: { stop_reason: 'end_turn' },
    };
    await ctx.fileFollows[1]?.emit(jsonLine(rotatedRow));
    expect(observedRows).toEqual([rotatedRow]);
    await publisher.observeSourceTranscript({ providerSessionId: 'claude-session-after-compact', sourceId: `source:${rotatedRow.uuid}`, row: rotatedRow });
    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenCalledWith(expect.objectContaining({
      providerSessionId: 'claude-session-after-compact',
      turnId: 'assistant-after-compact',
    }));

    ctx.agentRuntime.sessionHooks.publishProviderTranscript.mockClear();
    observedRows.length = 0;
    await ctx.fileFollows[0]?.emit(jsonLine({
      type: 'system',
      subtype: 'task_updated',
      session_id: 'claude-session-before-compact',
      task_id: 'stale-task',
      patch: { status: 'killed' },
    }));
    await ctx.fileFollows[0]?.emit(jsonLine({
      type: 'assistant',
      uuid: 'stale-assistant-before-compact',
      message: { stop_reason: 'end_turn' },
    }));
    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).not.toHaveBeenCalled();
    expect(observedRows).toEqual([]);
  });

  it('rebinds the same main session when a later trusted hook reports a moved transcript path', async () => {
    const { createClaudeUnifiedProviderTranscriptPublisher } = await loadSubject();
    const ctx = createContext();
    const publisher = createClaudeUnifiedProviderTranscriptPublisher({ ctx });
    publishers.push(publisher);

    await expect(publisher.bindFromSessionHook('claude-session-1', {
      hook_event_name: 'SessionStart',
      source: 'startup',
      session_id: 'claude-session-1',
      transcript_path: '/tmp/project-a/claude-session-1.jsonl',
    })).resolves.toEqual({
      status: 'bound',
      binding: {
        providerSessionId: 'claude-session-1',
        transcriptPath: '/tmp/project-a/claude-session-1.jsonl',
      },
    });

    await expect(publisher.bindFromSessionHook('claude-session-1', {
      hook_event_name: 'PostToolUse',
      session_id: 'claude-session-1',
      transcript_path: '/tmp/project-b/claude-sidechain.jsonl',
      agent_id: 'subagent-1',
    })).resolves.toEqual({ status: 'ignored' });
    expect(ctx.fileFollows).toHaveLength(1);

    await expect(publisher.bindFromSessionHook('claude-session-1', {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'claude-session-1',
      transcript_path: '/tmp/project-b/claude-session-1.jsonl',
    })).resolves.toEqual({
      status: 'bound',
      binding: {
        providerSessionId: 'claude-session-1',
        transcriptPath: '/tmp/project-b/claude-session-1.jsonl',
      },
    });

    expect(ctx.fileFollows).toHaveLength(2);
    expect(ctx.fileFollows[0]?.close).toHaveBeenCalledTimes(1);

    const movedRow = {
      type: 'assistant',
      sessionId: 'claude-session-1',
      uuid: 'assistant-after-transcript-move',
      message: { stop_reason: 'end_turn' },
    };
    await ctx.fileFollows[1]?.emit(jsonLine(movedRow));
    await publisher.observeSourceTranscript({ providerSessionId: 'claude-session-1', sourceId: `source:${movedRow.uuid}`, row: movedRow });
    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).toHaveBeenCalledWith(expect.objectContaining({
      providerSessionId: 'claude-session-1',
      turnId: 'assistant-after-transcript-move',
    }));

    ctx.agentRuntime.sessionHooks.publishProviderTranscript.mockClear();
    await ctx.fileFollows[0]?.emit(jsonLine({
      type: 'assistant',
      uuid: 'stale-assistant-before-transcript-move',
      message: { stop_reason: 'end_turn' },
    }));
    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).not.toHaveBeenCalled();
  });

  it('suppresses rows replayed by a file reset until the first fresh transcript row arrives', async () => {
    const observedRows: unknown[] = [];
    const { ctx } = await createBoundPublisher({ onObserveRow: (row) => { observedRows.push(row); } });
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

    expect(observedRows).toEqual([freshUser, laterBackdatedRow]);
    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).not.toHaveBeenCalled();
  });

  it('does not observe resume-replayed rows on the raw work-state seam before the live cutoff', async () => {
    const observedRows: unknown[] = [];
    const oldProviderTask = {
      type: 'system',
      subtype: 'task_updated',
      session_id: 'claude-session-1',
      task_id: 'old-provider-task',
      patch: { status: 'killed' },
    };
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
      replayLinesOnFollow: [
        jsonLine(oldGoalStatus),
        jsonLine(oldGoalWithoutTimestamp),
        jsonLine(oldProviderTask),
      ],
      onObserveRow: (row) => {
        observedRows.push(row);
      },
    });

    await ctx.fileFollows[0]?.emit(jsonLine(freshGoalStatus));

    expect(observedRows).toEqual([freshGoalStatus]);
  });

  it('relabels command-XML rows from bind replay and live follow without leaking raw XML', async () => {
    const { ctx, publisher } = await createBoundPublisher();
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
      await publisher.observeSourceTranscript({ providerSessionId: 'claude-session-1', sourceId: `source:${row.uuid}`, row });
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

  it('publishes compact summaries and command artifacts without duplicating the canonical compact boundary', async () => {
    const { ctx, publisher } = await createBoundPublisher();
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
      await publisher.observeSourceTranscript({ providerSessionId: 'claude-session-1', sourceId: `source:${row.uuid}`, row });
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
    ]);
    expect(JSON.stringify(published)).not.toContain('<command-name>');
    expect(JSON.stringify(published)).not.toContain('<local-command-stdout>');
  });

  it('drains complete transcript rows before dispose completes', async () => {
    const observedRows: unknown[] = [];
    const { ctx, publisher } = await createBoundPublisher({ onObserveRow: (row) => { observedRows.push(row); } });
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
    expect(observedRows).toEqual([expect.objectContaining({ uuid: 'assistant-row-final' })]);
    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).not.toHaveBeenCalled();
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
    const { ctx, publisher } = await createBoundPublisher();
    await publisher.observeSourceTranscript({ providerSessionId: 'claude-session-1', sourceId: 'source:ignored', row: {
      type: 'user',
      uuid: 'meta-row-1',
      isMeta: true,
      message: { content: [{ type: 'text', text: 'Claude internal metadata row' }] },
    } });

    expect(ctx.agentRuntime.sessionHooks.publishProviderTranscript).not.toHaveBeenCalled();
  });

});


describe('native shell delivery', () => {
  it.each([false, true])('accepts shell input and completes only a linked no-query episode (localOnly=%s)', async (localOnly) => {
    const { mapClaudeUnifiedTranscriptLifecyclePayload } = await import('./lifecycleEvents.js');
    const { ctx, publisher } = await createBoundPublisher();
    const observe = async (uuid: string, parentUuid: string | null, content: string, isMeta = false) => {
      await publisher.observeSourceTranscript({ providerSessionId: 'claude-session-1', sourceId: `source:${uuid}`, row: {
        type: 'user', uuid, parentUuid, promptId: 'shell-prompt', sessionId: 'claude-session-1', isMeta, message: { role: 'user', content },
      } });
    };
    if (localOnly) await observe('caveat', null, '<local-command-caveat>Local only</local-command-caveat>', true);
    await observe('input', localOnly ? 'caveat' : null, '<bash-input> echo hi</bash-input>');
    const observations = () => ctx.agentRuntime.sessionHooks.publishProviderTranscript.mock.calls.map(([payload]) => mapClaudeUnifiedTranscriptLifecyclePayload(payload, 'happy-session-1')).filter(Boolean);
    expect(observations()).toEqual([expect.objectContaining({ type: 'prompt_submitted', promptText: '! echo hi' })]);
    await observe('foreign-output', 'other-input', '<bash-stdout>other</bash-stdout><bash-stderr></bash-stderr>');
    expect(observations()).toHaveLength(1);
    await observe('output', 'input', '<bash-stdout>hi</bash-stdout><bash-stderr></bash-stderr>');
    await observe('output', 'input', '<bash-stdout>hi</bash-stdout><bash-stderr></bash-stderr>');
    expect(observations().filter(event => event?.type === 'completion_candidate')).toHaveLength(localOnly ? 1 : 0);
    await observe('next-input', 'output', 'next ordinary prompt');
    expect(observations().at(-1)).toMatchObject({ type: 'prompt_submitted', promptText: 'next ordinary prompt' });
  });

  it('completes /clear from the system stdout row Claude writes, because it fires no Stop hook', async () => {
    const { mapClaudeUnifiedTranscriptLifecyclePayload } = await import('./lifecycleEvents.js');
    const { ctx, publisher } = await createBoundPublisher();
    const observe = async (uuid: string, row: Record<string, unknown>) => {
      await publisher.observeSourceTranscript({ providerSessionId: 'claude-session-1', sourceId: `source:${uuid}`,
        row: { uuid, sessionId: 'claude-session-1', ...row } });
    };
    // Row shapes captured from Claude Code 2.1.316.
    await observe('caveat', { type: 'user', parentUuid: null, isMeta: true, message: { role: 'user', content: '<local-command-caveat>Local only</local-command-caveat>' } });
    await observe('clear', { type: 'user', parentUuid: 'caveat', message: { role: 'user',
      content: '<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>' } });
    const observations = () => ctx.agentRuntime.sessionHooks.publishProviderTranscript.mock.calls.map(([payload]) => mapClaudeUnifiedTranscriptLifecyclePayload(payload, 'claude-session-1'));
    expect(observations().filter(event => event?.type === 'completion_candidate')).toHaveLength(0);
    await observe('foreign', { type: 'system', subtype: 'local_command', parentUuid: 'other', content: '<local-command-stdout></local-command-stdout>' });
    expect(observations().filter(event => event?.type === 'completion_candidate')).toHaveLength(0);
    await observe('stdout', { type: 'system', subtype: 'local_command', parentUuid: 'clear', content: '<local-command-stdout></local-command-stdout>' });
    expect(observations().filter(event => event?.type === 'completion_candidate')).toHaveLength(1);
  });
});
