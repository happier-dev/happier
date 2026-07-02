import { describe, expect, it, vi } from 'vitest';

import type { VoiceAgentManager } from '../../../voice/agent/VoiceAgentManager';
import {
  cancelVoiceAgentTurnStream,
  readVoiceAgentTurnStream,
  startVoiceAgentTurnStream,
} from '@/agent/runtime/bridges/executionRun/voiceAgentTurnStreams';
import type { ExecutionRunState } from '@/agent/runtime/bridges/executionRun/executionRunTypes';
import type { ExecutionRunVoiceAgentController } from '../../../executionRuns/controllers/types';

function createVoiceAgentController(): ExecutionRunVoiceAgentController {
  return {
    kind: 'voice_agent',
    voiceAgentId: 'voice-agent-1',
    cancelled: false,
    lastMarkerWriteAtMs: 0,
    terminalPromise: Promise.resolve(),
    resolveTerminal: vi.fn(),
    transcript: { persistenceMode: 'persistent', epoch: 7 },
    externalStreamIdByInternal: new Map(),
    internalStreamIdByExternal: new Map(),
    persistedDoneByExternalStreamId: new Set(),
  };
}

describe('voiceAgentTurnStreams', () => {
  it('keeps persisted turn metadata keyed by the manager voiceAgentId rather than the execution run id', async () => {
    const userTextCommitted = vi.fn(async (_text: string, _meta: Record<string, unknown>) => undefined);
    const assistantTextCommitted = vi.fn(async (_text: string, _meta: Record<string, unknown>) => undefined);
    const voiceAgentManager = {
      startTurnStream: vi.fn(async ({ voiceAgentId }: { voiceAgentId: string; userText: string }) => {
        expect(voiceAgentId).toBe('voice-agent-1');
        return { streamId: 'internal-stream-1' };
      }),
      readTurnStream: vi.fn(async ({ streamId, cursor }: { streamId: string; cursor: number }) => ({
        streamId,
        events: cursor === 0 ? [{ t: 'done', assistantText: 'assistant reply', actions: [] }] : [],
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
      transcriptWriter: {
        appendUserText: vi.fn(async () => undefined),
        appendUserTextCommitted: userTextCommitted,
      },
    });

    expect(start.ok).toBe(true);
    if (!start.ok) {
      throw new Error(start.error);
    }
    expect(userTextCommitted).toHaveBeenCalledTimes(1);
    expect(userTextCommitted.mock.calls[0]?.[1]).toMatchObject({
      happier: {
        kind: 'voice_agent_turn.v1',
        payload: {
          voiceAgentId: 'voice-agent-1',
          role: 'user',
        },
      },
    });

    const read = await readVoiceAgentTurnStream({
      runId: 'run_1',
      params: { streamId: start.streamId, cursor: 0 },
      runs,
      controllers,
      voiceAgentManager,
      transcriptWriter: {
        appendAssistantText: assistantTextCommitted,
        appendAssistantTextCommitted: assistantTextCommitted,
      },
      writeActivityMarker: vi.fn(async () => undefined),
      getNowMs: () => 123,
    });

    expect(read.ok).toBe(true);
    expect(assistantTextCommitted).toHaveBeenCalledTimes(1);
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
    const assistantTextCommitted = vi.fn(async (_text: string, _meta: Record<string, unknown>) => undefined);
    const voiceAgentManager = {
      readTurnStream: vi.fn(async ({ streamId, cursor }: { streamId: string; cursor: number }) => ({
        streamId,
        events: cursor === 0 ? [{ t: 'done', assistantText: 'assistant reply', actions: [] }] : [],
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
      transcriptWriter: {
        appendAssistantText: assistantTextCommitted,
        appendAssistantTextCommitted: assistantTextCommitted,
      },
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
      transcriptWriter: {
        appendAssistantText: assistantTextCommitted,
        appendAssistantTextCommitted: assistantTextCommitted,
      },
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
});
