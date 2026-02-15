import { randomUUID } from 'node:crypto';

import { VoiceAgentError, type VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';
import type { ExecutionRunState } from '@/agent/executionRuns/runtime/ExecutionRunManager';
import type { ExecutionRunController, ExecutionRunVoiceAgentController } from '@/agent/executionRuns/runtime/executionRunControllers';

export async function startVoiceAgentTurnStream(args: Readonly<{
  runId: string;
  params: Readonly<{ message: string }>;
  runs: ReadonlyMap<string, ExecutionRunState>;
  controllers: ReadonlyMap<string, ExecutionRunController>;
  voiceAgentManager: VoiceAgentManager;
  transcriptWriter: Readonly<{
    appendUserText: (text: string, meta: Record<string, unknown>) => void | Promise<void>;
  }> | null;
}>): Promise<{ ok: true; streamId: string } | { ok: false; errorCode: string; error: string }> {
  const run = args.runs.get(args.runId) ?? null;
  if (!run) return { ok: false, errorCode: 'execution_run_not_found', error: 'Not found' };
  if (run.status !== 'running') return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not running' };
  if (run.intent !== 'voice_agent' || run.ioMode !== 'streaming') {
    return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not supported' };
  }

  const ctrl = args.controllers.get(args.runId);
  if (!ctrl || ctrl.kind !== 'voice_agent') {
    return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not running' };
  }

  const userText = String(args.params.message ?? '');
  if (!userText.trim()) return { ok: false, errorCode: 'execution_run_invalid_action_input', error: 'Invalid params' };

  // Persist user turn (optional).
  if (args.transcriptWriter && ctrl.transcript.persistenceMode === 'persistent') {
    const meta = {
      sentFrom: 'voice_agent',
      source: 'cli',
      happier: {
        kind: 'voice_agent_turn.v1',
        payload: {
          v: 1,
          epoch: ctrl.transcript.epoch,
          role: 'user',
          voiceAgentId: ctrl.voiceAgentId,
          ts: Date.now(),
        },
      },
    };
    void args.transcriptWriter.appendUserText(userText, meta);
  }

  try {
    const started = await args.voiceAgentManager.startTurnStream({ voiceAgentId: ctrl.voiceAgentId, userText });
    const externalStreamId = `stream_${randomUUID()}`;
    ctrl.externalStreamIdByInternal.set(started.streamId, externalStreamId);
    ctrl.internalStreamIdByExternal.set(externalStreamId, started.streamId);
    return { ok: true, streamId: externalStreamId };
  } catch (e) {
    if (e instanceof VoiceAgentError) {
      if (e.code === 'VOICE_AGENT_BUSY') return { ok: false, errorCode: 'execution_run_busy', error: e.message };
      if (e.code === 'VOICE_AGENT_NOT_FOUND') return { ok: false, errorCode: 'execution_run_not_found', error: e.message };
      return { ok: false, errorCode: 'execution_run_failed', error: e.message };
    }
    return { ok: false, errorCode: 'execution_run_failed', error: e instanceof Error ? e.message : 'Execution failed' };
  }
}

export async function readVoiceAgentTurnStream(args: Readonly<{
  runId: string;
  params: Readonly<{ streamId: string; cursor: number; maxEvents?: number }>;
  runs: ReadonlyMap<string, ExecutionRunState>;
  controllers: ReadonlyMap<string, ExecutionRunController>;
  voiceAgentManager: VoiceAgentManager;
  transcriptWriter: Readonly<{
    appendAssistantText: (text: string, meta: Record<string, unknown>) => void | Promise<void>;
  }> | null;
  writeActivityMarker: (runId: string, nowMs: number, opts?: Readonly<{ force?: boolean }>) => Promise<void>;
  getNowMs: () => number;
}>): Promise<
  | { ok: true; streamId: string; events: any[]; nextCursor: number; done: boolean }
  | { ok: false; errorCode: string; error: string }
> {
  const run = args.runs.get(args.runId) ?? null;
  if (!run) return { ok: false, errorCode: 'execution_run_not_found', error: 'Not found' };
  if (run.status !== 'running') return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not running' };
  if (run.intent !== 'voice_agent' || run.ioMode !== 'streaming') {
    return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not supported' };
  }

  const ctrl = args.controllers.get(args.runId);
  if (!ctrl || ctrl.kind !== 'voice_agent') {
    return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not running' };
  }

  const externalStreamId = String(args.params.streamId ?? '').trim();
  const internalStreamId = ctrl.internalStreamIdByExternal.get(externalStreamId) ?? null;
  if (!internalStreamId) return { ok: false, errorCode: 'execution_run_stream_not_found', error: 'Not found' };

  try {
    const read = await args.voiceAgentManager.readTurnStream({
      voiceAgentId: ctrl.voiceAgentId,
      streamId: internalStreamId,
      cursor: args.params.cursor,
      maxEvents: args.params.maxEvents,
    });

    // Persist assistant completion once per stream (optional).
    if (args.transcriptWriter && ctrl.transcript.persistenceMode === 'persistent') {
      const done = read.events.find((event) => event.t === 'done') as any;
      if (done && typeof done.assistantText === 'string' && !ctrl.persistedDoneByExternalStreamId.has(externalStreamId)) {
        ctrl.persistedDoneByExternalStreamId.add(externalStreamId);
        const meta = {
          sentFrom: 'voice_agent',
          source: 'cli',
          happier: {
            kind: 'voice_agent_turn.v1',
            payload: {
              v: 1,
              epoch: ctrl.transcript.epoch,
              role: 'assistant',
              voiceAgentId: ctrl.voiceAgentId,
              ts: Date.now(),
            },
          },
        };
        void args.transcriptWriter.appendAssistantText(done.assistantText, meta);
      }
    }

    // Best-effort: reflect activity for machine-wide run listing.
    await args.writeActivityMarker(args.runId, args.getNowMs(), { force: true });

    if (read.done) {
      ctrl.internalStreamIdByExternal.delete(externalStreamId);
      ctrl.externalStreamIdByInternal.delete(internalStreamId);
    }

    return {
      ok: true,
      streamId: externalStreamId,
      events: read.events,
      nextCursor: read.nextCursor,
      done: read.done,
    };
  } catch (e) {
    if (e instanceof VoiceAgentError) {
      if (e.code === 'VOICE_AGENT_NOT_FOUND') return { ok: false, errorCode: 'execution_run_stream_not_found', error: e.message };
      if (e.code === 'VOICE_AGENT_BUSY') return { ok: false, errorCode: 'execution_run_busy', error: e.message };
      return { ok: false, errorCode: 'execution_run_failed', error: e.message };
    }
    return { ok: false, errorCode: 'execution_run_failed', error: e instanceof Error ? e.message : 'Execution failed' };
  }
}

export async function cancelVoiceAgentTurnStream(args: Readonly<{
  runId: string;
  params: Readonly<{ streamId: string }>;
  runs: ReadonlyMap<string, ExecutionRunState>;
  controllers: ReadonlyMap<string, ExecutionRunController>;
  voiceAgentManager: VoiceAgentManager;
}>): Promise<{ ok: true } | { ok: false; errorCode: string; error: string }> {
  const run = args.runs.get(args.runId) ?? null;
  if (!run) return { ok: false, errorCode: 'execution_run_not_found', error: 'Not found' };
  if (run.status !== 'running') return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not running' };
  if (run.intent !== 'voice_agent' || run.ioMode !== 'streaming') {
    return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not supported' };
  }

  const ctrl = args.controllers.get(args.runId);
  if (!ctrl || ctrl.kind !== 'voice_agent') {
    return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not running' };
  }

  const externalStreamId = String(args.params.streamId ?? '').trim();
  const internalStreamId = ctrl.internalStreamIdByExternal.get(externalStreamId) ?? null;
  if (!internalStreamId) return { ok: false, errorCode: 'execution_run_stream_not_found', error: 'Not found' };

  try {
    await args.voiceAgentManager.cancelTurnStream({ voiceAgentId: ctrl.voiceAgentId, streamId: internalStreamId });
    ctrl.internalStreamIdByExternal.delete(externalStreamId);
    ctrl.externalStreamIdByInternal.delete(internalStreamId);
    return { ok: true };
  } catch (e) {
    if (e instanceof VoiceAgentError) {
      if (e.code === 'VOICE_AGENT_NOT_FOUND') return { ok: false, errorCode: 'execution_run_stream_not_found', error: e.message };
      if (e.code === 'VOICE_AGENT_BUSY') return { ok: false, errorCode: 'execution_run_busy', error: e.message };
      return { ok: false, errorCode: 'execution_run_failed', error: e.message };
    }
    return { ok: false, errorCode: 'execution_run_failed', error: e instanceof Error ? e.message : 'Execution failed' };
  }
}

export function readVoiceAgentController(ctrl: ExecutionRunController | null): ExecutionRunVoiceAgentController | null {
  if (!ctrl) return null;
  return ctrl.kind === 'voice_agent' ? ctrl : null;
}

