import { describe, expect, it, vi } from 'vitest';

import { VoiceAgentManager } from '../../../voice/agent/VoiceAgentManager';
import { createTestExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/testkit';
import {
  cancelVoiceAgentTurnStream,
  commitVoiceAgentUserTranscript,
  readVoiceAgentTurnStream,
  startVoiceAgentTurnStream,
} from '@/agent/runtime/bridges/executionRun/voiceAgentTurnStreams';
import type { ExecutionRunState } from '@/agent/runtime/bridges/executionRun/executionRunTypes';
import type { ExecutionRunVoiceAgentController } from '../../../executionRuns/controllers/types';

function createVoiceAgentController(
  persistenceMode: 'persistent' | 'ephemeral' = 'persistent',
): ExecutionRunVoiceAgentController {
  return {
    kind: 'voice_agent',
    voiceAgentId: 'voice-agent-1',
    cancelled: false,
    lastMarkerWriteAtMs: 0,
    terminalPromise: Promise.resolve(),
    resolveTerminal: vi.fn(),
    transcript: { persistenceMode, epoch: 7 },
    externalStreamIdByInternal: new Map(),
    internalStreamIdByExternal: new Map(),
    pendingTranscriptTurnByExternalStreamId: new Map(),
    terminalReadByExternalStreamId: new Map(),
    readInFlightByExternalStreamId: new Map(),
  };
}

describe('voiceAgentTurnStreams', () => {
  it('persists the display override for an explicit user-transcript commit and otherwise uses provider text', async () => {
    const appendUserTextCommitted = vi.fn(async () => ({ persisted: true, delivered: true }));
    const runs = new Map([['run_1', {
      status: 'running',
      intent: 'voice_agent',
      ioMode: 'streaming',
    } as ExecutionRunState]]);
    const controllers = new Map([['run_1', createVoiceAgentController()]]);
    const transcriptWriter = {
      appendUserTextCommitted,
      appendAssistantTextCommitted: vi.fn(async () => ({ persisted: true, delivered: true })),
      commitVoiceAgentTranscriptTurn: vi.fn(async () => ({ persisted: true, delivered: true })),
    };

    const result = await commitVoiceAgentUserTranscript({
      runId: 'run_1',
      text: 'Provider-facing text',
      displayText: 'User-visible text',
      localId: 'local-display',
      runs,
      controllers,
      transcriptWriter,
    });

    expect(result).toEqual({ ok: true });
    expect(appendUserTextCommitted).toHaveBeenCalledWith(
      'User-visible text',
      expect.objectContaining({ localId: 'local-display' }),
    );

    await expect(commitVoiceAgentUserTranscript({
      runId: 'run_1',
      text: 'Provider-only text',
      localId: 'local-provider',
      runs,
      controllers,
      transcriptWriter,
    })).resolves.toEqual({ ok: true });
    expect(appendUserTextCommitted).toHaveBeenLastCalledWith(
      'Provider-only text',
      expect.objectContaining({ localId: 'local-provider' }),
    );
  });

  it('persists the exact v2 outer local id before starting the provider', async () => {
    const events: string[] = [];
    const appendUserTextCommitted = vi.fn(async (_text: string, options: Readonly<{ localId: string }>) => {
      events.push(`persist:${options.localId}`);
      return { persisted: true, delivered: true };
    });
    const appendAssistantTextCommitted = vi.fn(async () => ({ persisted: true, delivered: true }));
    const startTurnStream = vi.fn(async () => {
      events.push('provider');
      return { streamId: 'internal-v2' };
    });
    const ctrl = createVoiceAgentController();

    const result = await startVoiceAgentTurnStream({
      runId: 'run_1',
      params: {
        message: 'provider payload',
        displayMessage: 'Outer prompt',
        userTranscript: { mode: 'persist', localId: ' opaque-local-id ' },
      },
      runs: new Map([['run_1', {
        status: 'running',
        intent: 'voice_agent',
        ioMode: 'streaming',
      } as ExecutionRunState]]),
      controllers: new Map([['run_1', ctrl]]),
      voiceAgentManager: { startTurnStream } as unknown as VoiceAgentManager,
      transcriptWriter: {
        appendUserTextCommitted,
        appendAssistantTextCommitted,
        commitVoiceAgentTranscriptTurn: vi.fn(async () => ({ persisted: true, delivered: true })),
      },
    });

    expect(result.ok).toBe(true);
    expect(events).toEqual(['persist: opaque-local-id ', 'provider']);
  });

  it('rejects v2 persist before provider effects without a persistent committed writer', async () => {
    const startTurnStream = vi.fn();

    const result = await startVoiceAgentTurnStream({
      runId: 'run_1',
      params: {
        message: 'Outer prompt',
        userTranscript: { mode: 'persist', localId: 'opaque-local-id' },
      },
      runs: new Map([['run_1', {
        status: 'running',
        intent: 'voice_agent',
        ioMode: 'streaming',
      } as ExecutionRunState]]),
      controllers: new Map([['run_1', createVoiceAgentController('ephemeral')]]),
      voiceAgentManager: { startTurnStream } as unknown as VoiceAgentManager,
      transcriptWriter: null,
    });

    expect(result).toMatchObject({ ok: false, errorCode: 'execution_run_not_allowed' });
    expect(startTurnStream).not.toHaveBeenCalled();
  });

  it('allows explicit suppress without any transcript writer', async () => {
    const startTurnStream = vi.fn(async () => ({ streamId: 'internal-suppress' }));

    const result = await startVoiceAgentTurnStream({
      runId: 'run_1',
      params: {
        message: 'tool follow-up',
        userTranscript: { mode: 'suppress' },
      },
      runs: new Map([['run_1', {
        status: 'running',
        intent: 'voice_agent',
        ioMode: 'streaming',
      } as ExecutionRunState]]),
      controllers: new Map([['run_1', createVoiceAgentController('ephemeral')]]),
      voiceAgentManager: { startTurnStream } as unknown as VoiceAgentManager,
      transcriptWriter: null,
    });

    expect(result.ok).toBe(true);
    expect(startTurnStream).toHaveBeenCalledTimes(1);
  });

  it('keeps persisted turn metadata keyed by the manager voiceAgentId rather than the execution run id', async () => {
    const userTextCommitted = vi.fn(async (_text: string, _meta: Record<string, unknown>) => undefined);
    const assistantTextCommitted = vi.fn(async (_text: string, _meta: Record<string, unknown>) => undefined);
    const commitVoiceAgentTranscriptTurn = vi.fn(async (turn: Readonly<{
      user: Readonly<{ text: string; meta: Record<string, unknown> }>;
      assistant: Readonly<{ text: string; meta: Record<string, unknown> }>;
    }>) => {
      await userTextCommitted(turn.user.text, turn.user.meta);
      await assistantTextCommitted(turn.assistant.text, turn.assistant.meta);
      return { persisted: true, delivered: true };
    });
    const voiceAgentManager = {
      startTurnStream: vi.fn(async ({ voiceAgentId }: { voiceAgentId: string; userText: string }) => {
        expect(voiceAgentId).toBe('voice-agent-1');
        return { streamId: 'internal-stream-1' };
      }),
      readTurnStream: vi.fn(async ({ streamId, cursor }: { streamId: string; cursor: number }) => ({
        streamId,
        events: cursor === 0 ? [{
          t: 'voice_output',
          output: { v: 1, kind: 'turn_final', turnId: 'internal-stream-1', seq: 0, text: 'assistant reply' },
        }] : [],
        nextCursor: cursor + 1,
        done: true,
      })),
    } as unknown as VoiceAgentManager;

    const run = {
      status: 'running',
      intent: 'voice_agent',
      ioMode: 'streaming',
    } as ExecutionRunState;
    const ctrl = createVoiceAgentController();
    const runs = new Map<string, ExecutionRunState>([['run_1', run]]);
    const controllers = new Map<string, ExecutionRunVoiceAgentController>([['run_1', ctrl]]);

    const start = await startVoiceAgentTurnStream({
      runId: 'run_1',
      params: { message: 'hello' },
      runs,
      controllers,
      voiceAgentManager,
      transcriptWriter: { commitVoiceAgentTranscriptTurn },
    });

    expect(start.ok).toBe(true);
    if (!start.ok) {
      throw new Error(start.error);
    }
    expect(userTextCommitted).not.toHaveBeenCalled();

    const read = await readVoiceAgentTurnStream({
      runId: 'run_1',
      params: { streamId: start.streamId, cursor: 0 },
      runs,
      controllers,
      voiceAgentManager,
      transcriptWriter: { commitVoiceAgentTranscriptTurn },
      writeActivityMarker: vi.fn(async () => undefined),
      getNowMs: () => 123,
    });

    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.events).toEqual([{
        t: 'voice_output',
        output: { v: 1, kind: 'turn_final', turnId: start.streamId, seq: 0, text: 'assistant reply' },
      }]);
    }
    expect(assistantTextCommitted).toHaveBeenCalledTimes(1);
    expect(userTextCommitted).toHaveBeenCalledTimes(1);
    expect(commitVoiceAgentTranscriptTurn).toHaveBeenCalledTimes(1);
    expect(userTextCommitted.mock.calls[0]?.[1]).toMatchObject({
      happier: {
        kind: 'voice_agent_turn.v1',
        payload: {
          voiceAgentId: 'voice-agent-1',
          role: 'user',
        },
      },
    });
    expect(assistantTextCommitted.mock.calls[0]?.[1]).toMatchObject({
      happier: {
        kind: 'voice_agent_turn.v1',
        payload: {
          voiceAgentId: 'voice-agent-1',
          role: 'assistant',
        },
      },
    });
  });

  it('drops the external stream identity after a terminal read so replay and cancel are rejected', async () => {
    const voiceAgentManager = {
      readTurnStream: vi.fn(async ({ streamId, cursor }: { streamId: string; cursor: number }) => ({
        streamId,
        events: cursor === 0 ? [{
          t: 'voice_output',
          output: { v: 1, kind: 'turn_final', turnId: 'internal-stream-1', seq: 0, text: 'assistant reply' },
        }] : [],
        nextCursor: cursor + 1,
        done: true,
      })),
      cancelTurnStream: vi.fn(async ({ streamId }: { streamId: string }) => {
        expect(streamId).toBe('internal-stream-1');
        return { ok: true as const };
      }),
    } as unknown as VoiceAgentManager;

    const run = {
      status: 'running',
      intent: 'voice_agent',
      ioMode: 'streaming',
    } as ExecutionRunState;
    const ctrl = createVoiceAgentController();
    ctrl.transcript = { persistenceMode: 'ephemeral', epoch: 7 };
    ctrl.externalStreamIdByInternal.set('internal-stream-1', 'stream_external');
    ctrl.internalStreamIdByExternal.set('stream_external', 'internal-stream-1');
    const runs = new Map<string, ExecutionRunState>([['run_1', run]]);
    const controllers = new Map<string, ExecutionRunVoiceAgentController>([['run_1', ctrl]]);

    const firstRead = await readVoiceAgentTurnStream({
      runId: 'run_1',
      params: { streamId: 'stream_external', cursor: 0 },
      runs,
      controllers,
      voiceAgentManager,
      transcriptWriter: { commitVoiceAgentTranscriptTurn: vi.fn() },
      writeActivityMarker: vi.fn(async () => undefined),
      getNowMs: () => 123,
    });

    if (!firstRead.ok) {
      throw new Error(firstRead.error);
    }
    expect(firstRead).toMatchObject({
      ok: true,
      done: true,
      streamId: 'stream_external',
    });

    const replayRead = await readVoiceAgentTurnStream({
      runId: 'run_1',
      params: { streamId: 'stream_external', cursor: firstRead.nextCursor },
      runs,
      controllers,
      voiceAgentManager,
      transcriptWriter: { commitVoiceAgentTranscriptTurn: vi.fn() },
      writeActivityMarker: vi.fn(async () => undefined),
      getNowMs: () => 123,
    });

    expect(replayRead).toMatchObject({
      ok: false,
      errorCode: 'execution_run_stream_not_found',
    });

    const cancel = await cancelVoiceAgentTurnStream({
      runId: 'run_1',
      params: { streamId: 'stream_external' },
      runs,
      controllers,
      voiceAgentManager,
    });

    expect(cancel).toMatchObject({
      ok: false,
      errorCode: 'execution_run_stream_not_found',
    });
    expect(voiceAgentManager.readTurnStream).toHaveBeenCalledTimes(1);
    expect(voiceAgentManager.cancelTurnStream).toHaveBeenCalledTimes(0);
  });

  it('does not persist either side of a persistent turn that is cancelled', async () => {
    const userTextCommitted = vi.fn(async (_text: string, _meta: Record<string, unknown>) => undefined);
    const assistantTextCommitted = vi.fn(async () => undefined);
    const voiceAgentManager = {
      startTurnStream: vi.fn(async () => ({ streamId: 'internal-stream-cancelled' })),
      cancelTurnStream: vi.fn(async () => ({ ok: true as const })),
    } as unknown as VoiceAgentManager;
    const run = { status: 'running', intent: 'voice_agent', ioMode: 'streaming' } as ExecutionRunState;
    const ctrl = createVoiceAgentController();
    const runs = new Map<string, ExecutionRunState>([['run_1', run]]);
    const controllers = new Map<string, ExecutionRunVoiceAgentController>([['run_1', ctrl]]);

    const start = await startVoiceAgentTurnStream({
      runId: 'run_1',
      params: { message: 'cancel me' },
      runs,
      controllers,
      voiceAgentManager,
      transcriptWriter: { commitVoiceAgentTranscriptTurn: vi.fn() },
    });
    if (!start.ok) throw new Error(start.error);

    await cancelVoiceAgentTurnStream({
      runId: 'run_1',
      params: { streamId: start.streamId },
      runs,
      controllers,
      voiceAgentManager,
    });

    expect(userTextCommitted).not.toHaveBeenCalled();
    expect(assistantTextCommitted).not.toHaveBeenCalled();
    expect(ctrl.pendingTranscriptTurnByExternalStreamId.size).toBe(0);
    expect(ctrl.terminalReadByExternalStreamId.size).toBe(0);
    expect(ctrl.readInFlightByExternalStreamId.size).toBe(0);
  });

  it('retries transfer of the same complete turn intent when durable persistence initially fails', async () => {
    let attempts = 0;
    const commitVoiceAgentTranscriptTurn = vi.fn(async (_turn: Readonly<{
      turnId: string;
      user: Readonly<{ text: string; meta: Record<string, unknown> }>;
      assistant: Readonly<{ text: string; meta: Record<string, unknown> }>;
    }>) => {
      attempts += 1;
      if (attempts === 1) throw new Error('durable persistence unavailable');
      return { persisted: true, delivered: false };
    });
    const voiceAgentManager = {
      startTurnStream: vi.fn(async () => ({ streamId: 'internal-user-retry' })),
      readTurnStream: vi.fn(async () => ({
        streamId: 'internal-user-retry',
        events: [{
          t: 'voice_output',
          output: { v: 1, kind: 'turn_final', turnId: 'internal-user-retry', seq: 0, text: 'assistant reply' },
        }],
        nextCursor: 1,
        done: true,
      })),
    } as unknown as VoiceAgentManager;
    const run = { status: 'running', intent: 'voice_agent', ioMode: 'streaming' } as ExecutionRunState;
    const ctrl = createVoiceAgentController();
    const runs = new Map<string, ExecutionRunState>([['run_1', run]]);
    const controllers = new Map<string, ExecutionRunVoiceAgentController>([['run_1', ctrl]]);
    const started = await startVoiceAgentTurnStream({
      runId: 'run_1',
      params: { message: 'persist me' },
      runs,
      controllers,
      voiceAgentManager,
      transcriptWriter: { commitVoiceAgentTranscriptTurn },
    });
    if (!started.ok) throw new Error(started.error);
    const args = {
      runId: 'run_1',
      params: { streamId: started.streamId, cursor: 0 },
      runs,
      controllers,
      voiceAgentManager,
      transcriptWriter: { commitVoiceAgentTranscriptTurn },
      writeActivityMarker: vi.fn(async () => undefined),
      getNowMs: () => 123,
    } as const;

    await expect(readVoiceAgentTurnStream(args)).resolves.toMatchObject({ ok: false });
    await expect(readVoiceAgentTurnStream({
      ...args,
      params: { ...args.params, cursor: 99 },
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'execution_run_invalid_action_input',
    });
    expect(commitVoiceAgentTranscriptTurn).toHaveBeenCalledTimes(1);
    await expect(readVoiceAgentTurnStream(args)).resolves.toMatchObject({ ok: true, done: true });
    expect(commitVoiceAgentTranscriptTurn).toHaveBeenCalledTimes(2);
    expect(commitVoiceAgentTranscriptTurn.mock.calls[0]?.[0]).toEqual(commitVoiceAgentTranscriptTurn.mock.calls[1]?.[0]);
    expect(voiceAgentManager.readTurnStream).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the durable turn owner does not confirm persistence', async () => {
    const commitVoiceAgentTranscriptTurn = vi.fn()
      .mockResolvedValueOnce({ persisted: false, delivered: false })
      .mockResolvedValueOnce({ persisted: true, delivered: false });
    const voiceAgentManager = {
      startTurnStream: vi.fn(async () => ({ streamId: 'internal-retry' })),
      readTurnStream: vi.fn(async () => ({
        streamId: 'internal-retry',
        events: [{
          t: 'voice_output',
          output: { v: 1, kind: 'turn_final', turnId: 'internal-retry', seq: 0, text: 'assistant reply' },
        }],
        nextCursor: 1,
        done: true,
      })),
    } as unknown as VoiceAgentManager;
    const run = { status: 'running', intent: 'voice_agent', ioMode: 'streaming' } as ExecutionRunState;
    const ctrl = createVoiceAgentController();
    const runs = new Map<string, ExecutionRunState>([['run_1', run]]);
    const controllers = new Map<string, ExecutionRunVoiceAgentController>([['run_1', ctrl]]);
    const started = await startVoiceAgentTurnStream({
      runId: 'run_1',
      params: { message: 'persist me' },
      runs,
      controllers,
      voiceAgentManager,
      transcriptWriter: { commitVoiceAgentTranscriptTurn },
    });
    if (!started.ok) throw new Error(started.error);

    const readArgs = {
      runId: 'run_1',
      params: { streamId: started.streamId, cursor: 0 },
      runs,
      controllers,
      voiceAgentManager,
      transcriptWriter: { commitVoiceAgentTranscriptTurn },
      writeActivityMarker: vi.fn(async () => undefined),
      getNowMs: () => 123,
    } as const;

    await expect(readVoiceAgentTurnStream(readArgs)).resolves.toMatchObject({
      ok: false,
      errorCode: 'execution_run_failed',
    });
    await expect(readVoiceAgentTurnStream(readArgs)).resolves.toMatchObject({ ok: true, done: true });

    expect(commitVoiceAgentTranscriptTurn).toHaveBeenCalledTimes(2);
    expect(voiceAgentManager.readTurnStream).toHaveBeenCalledTimes(1);
    expect(commitVoiceAgentTranscriptTurn.mock.calls[0]?.[0]).toEqual(commitVoiceAgentTranscriptTurn.mock.calls[1]?.[0]);
  });

  it('single-flights concurrent terminal reads and transcript pair persistence', async () => {
    const readDeferred: { resolve: () => void } = { resolve: () => {} };
    const readBarrier = new Promise<void>((resolve) => { readDeferred.resolve = resolve; });
    const voiceAgentManager = {
      readTurnStream: vi.fn(async () => {
        await readBarrier;
        return {
          streamId: 'internal-concurrent',
          events: [{
            t: 'voice_output',
            output: { v: 1, kind: 'turn_final', turnId: 'internal-concurrent', seq: 0, text: 'reply' },
          }],
          nextCursor: 1,
          done: true,
        };
      }),
    } as unknown as VoiceAgentManager;
    const commitVoiceAgentTranscriptTurn = vi.fn(async () => ({ persisted: true, delivered: true }));
    const run = { status: 'running', intent: 'voice_agent', ioMode: 'streaming' } as ExecutionRunState;
    const ctrl = createVoiceAgentController();
    ctrl.externalStreamIdByInternal.set('internal-concurrent', 'stream_concurrent');
    ctrl.internalStreamIdByExternal.set('stream_concurrent', 'internal-concurrent');
    ctrl.pendingTranscriptTurnByExternalStreamId.set('stream_concurrent', {
      mode: 'legacy_pair',
      user: { text: 'user', localId: 'legacy-user-id', meta: {} },
      assistant: null,
      commitInFlight: null,
    });
    const runs = new Map<string, ExecutionRunState>([['run_1', run]]);
    const controllers = new Map<string, ExecutionRunVoiceAgentController>([['run_1', ctrl]]);
    const args = {
      runId: 'run_1',
      params: { streamId: 'stream_concurrent', cursor: 0 },
      runs,
      controllers,
      voiceAgentManager,
      transcriptWriter: { commitVoiceAgentTranscriptTurn },
      writeActivityMarker: vi.fn(async () => undefined),
      getNowMs: () => 123,
    } as const;

    const first = readVoiceAgentTurnStream(args);
    const second = readVoiceAgentTurnStream(args);
    readDeferred.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ ok: true, done: true }),
      expect.objectContaining({ ok: true, done: true }),
    ]);
    expect(voiceAgentManager.readTurnStream).toHaveBeenCalledTimes(1);
    expect(commitVoiceAgentTranscriptTurn).toHaveBeenCalledTimes(1);
  });

  it('integrates the real manager and bridge across invalid cursors, partial reads, durable handoff, and cancellation', async () => {
    let runtime: ReturnType<typeof createTestExecutionRunHostRuntime>;
    let releaseCancelledPrompt: () => void = () => {};
    const cancelledPromptBarrier = new Promise<void>((resolve) => {
      releaseCancelledPrompt = resolve;
    });
    runtime = createTestExecutionRunHostRuntime({
      sessionId: 'voice-agent-integration-session',
      async onSendPrompt(_sessionId, prompt) {
        if (prompt.includes('cancel this')) {
          await cancelledPromptBarrier;
          return;
        }
        runtime.emitMessage({ type: 'model-output', textDelta: 'assistant ' });
        runtime.emitMessage({ type: 'model-output', textDelta: 'reply' });
        runtime.emitMessage({ type: 'status', status: 'idle' });
      },
      onCancel() {
        releaseCancelledPrompt();
      },
    });
    const manager = new VoiceAgentManager({ createRuntime: () => runtime });
    const startedAgent = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'chat-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });
    const run = { status: 'running', intent: 'voice_agent', ioMode: 'streaming' } as ExecutionRunState;
    const ctrl = createVoiceAgentController();
    ctrl.voiceAgentId = startedAgent.voiceAgentId;
    const runs = new Map<string, ExecutionRunState>([['run_1', run]]);
    const controllers = new Map<string, ExecutionRunVoiceAgentController>([['run_1', ctrl]]);
    const durableCommit = vi.fn(async (_turn: Readonly<{
      turnId: string;
      user: Readonly<{ text: string; meta: Record<string, unknown> }>;
      assistant: Readonly<{ text: string; meta: Record<string, unknown> }>;
    }>) => ({ persisted: true, delivered: false }));
    const marker = vi.fn(async () => undefined);
    const started = await startVoiceAgentTurnStream({
      runId: 'run_1',
      params: { message: 'hello' },
      runs,
      controllers,
      voiceAgentManager: manager,
      transcriptWriter: { commitVoiceAgentTranscriptTurn: durableCommit },
    });
    if (!started.ok) throw new Error(started.error);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    await expect(readVoiceAgentTurnStream({
      runId: 'run_1',
      params: { streamId: started.streamId, cursor: 999 },
      runs,
      controllers,
      voiceAgentManager: manager,
      transcriptWriter: { commitVoiceAgentTranscriptTurn: durableCommit },
      writeActivityMarker: marker,
      getNowMs: () => 123,
    })).resolves.toMatchObject({ ok: false, errorCode: 'execution_run_invalid_action_input' });
    expect(ctrl.internalStreamIdByExternal.has(started.streamId)).toBe(true);
    expect(durableCommit).not.toHaveBeenCalled();

    let cursor = 0;
    let done = false;
    const observed: unknown[] = [];
    while (!done) {
      const read = await readVoiceAgentTurnStream({
        runId: 'run_1',
        params: { streamId: started.streamId, cursor, maxEvents: 1 },
        runs,
        controllers,
        voiceAgentManager: manager,
        transcriptWriter: { commitVoiceAgentTranscriptTurn: durableCommit },
        writeActivityMarker: marker,
        getNowMs: () => 123,
      });
      if (!read.ok) throw new Error(read.error);
      observed.push(...read.events);
      cursor = read.nextCursor;
      done = read.done;
    }
    expect(JSON.stringify(observed)).toContain('turn_final');
    expect(durableCommit).toHaveBeenCalledTimes(1);
    expect(durableCommit).toHaveBeenCalledWith(expect.objectContaining({
      turnId: started.streamId,
      user: expect.objectContaining({ text: 'hello' }),
      assistant: expect.objectContaining({ text: 'assistant reply' }),
    }));
    expect(ctrl.pendingTranscriptTurnByExternalStreamId.size).toBe(0);

    // A new stream can be cancelled through the same real manager without
    // ever handing a transcript pair to the durable boundary.
    const cancelled = await startVoiceAgentTurnStream({
      runId: 'run_1',
      params: { message: 'cancel this' },
      runs,
      controllers,
      voiceAgentManager: manager,
      transcriptWriter: { commitVoiceAgentTranscriptTurn: durableCommit },
    });
    if (!cancelled.ok) throw new Error(cancelled.error);
    await expect(cancelVoiceAgentTurnStream({
      runId: 'run_1',
      params: { streamId: cancelled.streamId },
      runs,
      controllers,
      voiceAgentManager: manager,
    })).resolves.toEqual({ ok: true });
    expect(durableCommit).toHaveBeenCalledTimes(1);
    await manager.dispose();
  });

  it('rejects completed-but-unread cancellation and preserves matching history and durable intent across adjacent same-text turns', async () => {
    const seenPrompts: string[] = [];
    let responseIndex = 0;
    let runtime: ReturnType<typeof createTestExecutionRunHostRuntime>;
    runtime = createTestExecutionRunHostRuntime({
      sessionId: 'voice-agent-completed-cancel-session',
      onSendPrompt(_sessionId, prompt) {
        seenPrompts.push(prompt);
        responseIndex += 1;
        runtime.emitMessage({
          type: 'model-output',
          fullText: prompt.includes('preparing a single instruction message')
            ? `commit-${responseIndex}`
            : `assistant-${responseIndex}`,
        });
        runtime.emitMessage({ type: 'status', status: 'idle' });
      },
    });
    const createRuntime = vi.fn(() => runtime);
    const manager = new VoiceAgentManager({ createRuntime });
    const startedAgent = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'chat-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });
    const run = { status: 'running', intent: 'voice_agent', ioMode: 'streaming' } as ExecutionRunState;
    const ctrl = createVoiceAgentController();
    ctrl.voiceAgentId = startedAgent.voiceAgentId;
    const runs = new Map<string, ExecutionRunState>([['run_1', run]]);
    const controllers = new Map<string, ExecutionRunVoiceAgentController>([['run_1', ctrl]]);
    const durableCommit = vi.fn(async (_turn: Readonly<{
      turnId: string;
      user: Readonly<{ text: string; meta: Record<string, unknown> }>;
      assistant: Readonly<{ text: string; meta: Record<string, unknown> }>;
    }>) => ({ persisted: true, delivered: false }));
    const marker = vi.fn(async () => undefined);

    const finishTurn = async (message: string): Promise<string> => {
      const started = await startVoiceAgentTurnStream({
        runId: 'run_1',
        params: { message },
        runs,
        controllers,
        voiceAgentManager: manager,
        transcriptWriter: { commitVoiceAgentTranscriptTurn: durableCommit },
      });
      if (!started.ok) throw new Error(started.error);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await expect(cancelVoiceAgentTurnStream({
        runId: 'run_1',
        params: { streamId: started.streamId },
        runs,
        controllers,
        voiceAgentManager: manager,
      })).resolves.toMatchObject({
        ok: false,
        errorCode: 'execution_run_not_allowed',
      });
      expect(ctrl.pendingTranscriptTurnByExternalStreamId.has(started.streamId)).toBe(true);

      const read = await readVoiceAgentTurnStream({
        runId: 'run_1',
        params: { streamId: started.streamId, cursor: 0, maxEvents: 128 },
        runs,
        controllers,
        voiceAgentManager: manager,
        transcriptWriter: { commitVoiceAgentTranscriptTurn: durableCommit },
        writeActivityMarker: marker,
        getNowMs: () => 123,
      });
      expect(read).toMatchObject({ ok: true, done: true });
      return started.streamId;
    };

    const firstStreamId = await finishTurn('same user text');
    const firstCommit = await manager.commit({ voiceAgentId: startedAgent.voiceAgentId, maxChars: 10_000 });
    expect(firstCommit.commitText).toContain('commit-');
    expect(seenPrompts.at(-1)).toContain('User: same user text');
    expect(seenPrompts.at(-1)).toContain('Voice agent: assistant-1');

    const secondStreamId = await finishTurn('same user text');
    expect(secondStreamId).not.toBe(firstStreamId);
    expect(durableCommit).toHaveBeenCalledTimes(2);
    expect(durableCommit.mock.calls.map(([turn]) => turn.turnId)).toEqual([
      firstStreamId,
      secondStreamId,
    ]);
    expect(createRuntime).toHaveBeenCalledTimes(1);

    // If commit wins the race, provider-visible history is already irreversible;
    // cancellation must reject while the terminal read remains available.
    const third = await startVoiceAgentTurnStream({
      runId: 'run_1',
      params: { message: 'commit race' },
      runs,
      controllers,
      voiceAgentManager: manager,
      transcriptWriter: { commitVoiceAgentTranscriptTurn: durableCommit },
    });
    if (!third.ok) throw new Error(third.error);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const committing = manager.commit({ voiceAgentId: startedAgent.voiceAgentId, maxChars: 10_000 });
    const cancelling = cancelVoiceAgentTurnStream({
      runId: 'run_1',
      params: { streamId: third.streamId },
      runs,
      controllers,
      voiceAgentManager: manager,
    });
    await expect(committing).resolves.toMatchObject({ commitText: expect.any(String) });
    await expect(cancelling).resolves.toMatchObject({
      ok: false,
      errorCode: 'execution_run_not_allowed',
    });
    await expect(readVoiceAgentTurnStream({
      runId: 'run_1',
      params: { streamId: third.streamId, cursor: 0, maxEvents: 128 },
      runs,
      controllers,
      voiceAgentManager: manager,
      transcriptWriter: { commitVoiceAgentTranscriptTurn: durableCommit },
      writeActivityMarker: marker,
      getNowMs: () => 123,
    })).resolves.toMatchObject({ ok: true, done: true });
    expect(durableCommit).toHaveBeenCalledTimes(3);
    await manager.dispose();
  });

  it('rejects cancellation while a completed terminal pair is crossing the durable handoff boundary', async () => {
    let runtime: ReturnType<typeof createTestExecutionRunHostRuntime>;
    runtime = createTestExecutionRunHostRuntime({
      sessionId: 'voice-agent-durable-handoff-session',
      onSendPrompt() {
        runtime.emitMessage({ type: 'model-output', fullText: 'durable assistant' });
        runtime.emitMessage({ type: 'status', status: 'idle' });
      },
    });
    const manager = new VoiceAgentManager({ createRuntime: () => runtime });
    const startedAgent = await manager.start({
      agentId: 'claude',
      chatModelId: 'chat-model',
      commitModelId: 'chat-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });
    const run = { status: 'running', intent: 'voice_agent', ioMode: 'streaming' } as ExecutionRunState;
    const ctrl = createVoiceAgentController();
    ctrl.voiceAgentId = startedAgent.voiceAgentId;
    const runs = new Map<string, ExecutionRunState>([['run_1', run]]);
    const controllers = new Map<string, ExecutionRunVoiceAgentController>([['run_1', ctrl]]);
    const persisted: { resolve: (result: Readonly<{ persisted: boolean; delivered: boolean }>) => void } = {
      resolve: () => {},
    };
    const persistenceBarrier = new Promise<Readonly<{ persisted: boolean; delivered: boolean }>>((resolve) => {
      persisted.resolve = resolve;
    });
    const durableCommit = vi.fn(async (_turn: Readonly<{
      turnId: string;
      user: Readonly<{ text: string; meta: Record<string, unknown> }>;
      assistant: Readonly<{ text: string; meta: Record<string, unknown> }>;
    }>) => await persistenceBarrier);
    const started = await startVoiceAgentTurnStream({
      runId: 'run_1',
      params: { message: 'persist race' },
      runs,
      controllers,
      voiceAgentManager: manager,
      transcriptWriter: { commitVoiceAgentTranscriptTurn: durableCommit },
    });
    if (!started.ok) throw new Error(started.error);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const reading = readVoiceAgentTurnStream({
      runId: 'run_1',
      params: { streamId: started.streamId, cursor: 0, maxEvents: 128 },
      runs,
      controllers,
      voiceAgentManager: manager,
      transcriptWriter: { commitVoiceAgentTranscriptTurn: durableCommit },
      writeActivityMarker: vi.fn(async () => undefined),
      getNowMs: () => 123,
    });
    await vi.waitFor(() => expect(durableCommit).toHaveBeenCalledTimes(1));
    await expect(cancelVoiceAgentTurnStream({
      runId: 'run_1',
      params: { streamId: started.streamId },
      runs,
      controllers,
      voiceAgentManager: manager,
    })).resolves.toMatchObject({ ok: false });
    expect(ctrl.pendingTranscriptTurnByExternalStreamId.has(started.streamId)).toBe(true);
    persisted.resolve({ persisted: true, delivered: false });
    await expect(reading).resolves.toMatchObject({ ok: true, done: true });
    expect(ctrl.pendingTranscriptTurnByExternalStreamId.has(started.streamId)).toBe(false);
    await manager.dispose();
  });
});
