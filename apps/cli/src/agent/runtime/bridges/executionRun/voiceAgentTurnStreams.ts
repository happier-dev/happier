import { randomUUID } from 'node:crypto';

import { VoiceAgentError, type VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';
import type { ExecutionRunState } from './executionRunTypes';
import type {
  ExecutionRunController,
  ExecutionRunVoiceAgentController,
  PendingVoiceAgentTranscriptTurn,
} from '@/agent/executionRuns/controllers/types';
import type { VoiceAgentTurnStreamEvent, VoiceAgentTurnStreamReadResult } from '@/agent/voice/agent/voiceAgentTypes';
import type { ExecutionRunUserTranscriptDirective } from '@happier-dev/protocol';

type DurableVoiceAgentTranscriptTurnWriter = Readonly<{
  appendUserTextCommitted?: (
    text: string,
    options: Readonly<{ localId: string; meta: Record<string, unknown> }>,
  ) => Promise<Readonly<{ persisted: boolean; delivered: boolean }>>;
  appendAssistantTextCommitted?: (
    text: string,
    options: Readonly<{ localId: string; meta: Record<string, unknown> }>,
  ) => Promise<Readonly<{ persisted: boolean; delivered: boolean }>>;
  commitVoiceAgentTranscriptTurn: (turn: Readonly<{
    turnId: string;
    user: Readonly<{ text: string; localId: string; meta: Record<string, unknown> }>;
    assistant: Readonly<{ text: string; meta: Record<string, unknown> }>;
  }>) => Promise<Readonly<{ persisted: boolean; delivered: boolean }>>;
}>;

async function commitPendingTranscriptTurn(
  externalStreamId: string,
  turn: PendingVoiceAgentTranscriptTurn,
  writer: DurableVoiceAgentTranscriptTurnWriter,
): Promise<void> {
  if (!turn.assistant) throw new Error('Assistant transcript completion is not prepared');
  if (turn.commitInFlight) {
    const result = await turn.commitInFlight;
    if (!result.persisted) throw new Error('Voice-agent transcript turn was not durably persisted');
    return;
  }
  const commit = turn.mode !== 'assistant_only'
    ? (() => {
        if (!turn.user) throw new Error('Legacy transcript pair is missing its user intent');
        return writer.commitVoiceAgentTranscriptTurn({
          turnId: externalStreamId,
          user: turn.user,
          assistant: turn.assistant!,
        });
      })()
    : (() => {
        if (!writer.appendAssistantTextCommitted) {
          throw new Error('Committed assistant transcript writer is required');
        }
        return writer.appendAssistantTextCommitted(turn.assistant!.text, {
          localId: `${externalStreamId}:assistant`,
          meta: turn.assistant!.meta,
        });
      })();
  turn.commitInFlight = commit;
  try {
    const result = await commit;
    if (!result.persisted) throw new Error('Voice-agent transcript turn was not durably persisted');
  } catch (error) {
    if (turn.commitInFlight === commit) turn.commitInFlight = null;
    throw error;
  }
}

function clearExternalTurnState(
  ctrl: ExecutionRunVoiceAgentController,
  externalStreamId: string,
  internalStreamId: string,
): void {
  ctrl.pendingTranscriptTurnByExternalStreamId.delete(externalStreamId);
  ctrl.terminalReadByExternalStreamId.delete(externalStreamId);
  ctrl.readInFlightByExternalStreamId.delete(externalStreamId);
  ctrl.internalStreamIdByExternal.delete(externalStreamId);
  ctrl.externalStreamIdByInternal.delete(internalStreamId);
}

function projectVoiceOutputEventToExternalStream(
  event: VoiceAgentTurnStreamEvent,
  internalStreamId: string,
  externalStreamId: string,
): VoiceAgentTurnStreamEvent {
  if (event.t !== 'voice_output') return event;
  const output = event.output;
  const projectId = (id: string): string => id.startsWith(`${internalStreamId}:`)
    ? `${externalStreamId}${id.slice(internalStreamId.length)}`
    : id;
  if (output.kind === 'speech_segment') {
    return { t: 'voice_output', output: { ...output, turnId: externalStreamId, segmentId: projectId(output.segmentId) } };
  }
  if (output.kind === 'display_status') {
    return { t: 'voice_output', output: { ...output, turnId: externalStreamId, statusId: projectId(output.statusId) } };
  }
  if (output.kind === 'side_effect') {
    return { t: 'voice_output', output: { ...output, turnId: externalStreamId, effectId: projectId(output.effectId) } };
  }
  return { t: 'voice_output', output: { ...output, turnId: externalStreamId } };
}

export async function commitVoiceAgentUserTranscript(args: Readonly<{
  runId: string;
  text: string;
  displayText?: string;
  localId: string;
  runs: ReadonlyMap<string, ExecutionRunState>;
  controllers: ReadonlyMap<string, ExecutionRunController>;
  transcriptWriter: DurableVoiceAgentTranscriptTurnWriter | null;
}>): Promise<{ ok: true } | { ok: false; errorCode: string; error: string }> {
  const run = args.runs.get(args.runId) ?? null;
  const ctrl = args.controllers.get(args.runId) ?? null;
  if (!run || !ctrl || ctrl.kind !== 'voice_agent') {
    return { ok: false, errorCode: 'execution_run_not_found', error: 'Not found' };
  }
  if (
    run.status !== 'running'
    || run.intent !== 'voice_agent'
    || ctrl.transcript.persistenceMode !== 'persistent'
    || !args.transcriptWriter?.appendUserTextCommitted
  ) {
    return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Persistent transcript writer is required' };
  }
  const result = await args.transcriptWriter.appendUserTextCommitted(args.displayText ?? args.text, {
    localId: args.localId,
    meta: {
      sentFrom: 'voice_agent',
      source: 'cli',
      happier: {
        kind: 'voice_agent_turn.v1',
        payload: {
          v: 1,
          epoch: ctrl.transcript.epoch,
          role: 'user',
          voiceAgentId: ctrl.voiceAgentId,
          runId: args.runId,
          streamId: `user_transcript:${args.localId}`,
          ts: Date.now(),
        },
      },
    },
  });
  return result.persisted
    ? { ok: true }
    : { ok: false, errorCode: 'execution_run_failed', error: 'Voice-agent user transcript was not durably persisted' };
}

export async function startVoiceAgentTurnStream(args: Readonly<{
  runId: string;
  params: Readonly<{
    message: string;
    displayMessage?: string;
    userTranscript?: ExecutionRunUserTranscriptDirective;
  }>;
  runs: ReadonlyMap<string, ExecutionRunState>;
  controllers: ReadonlyMap<string, ExecutionRunController>;
  voiceAgentManager: VoiceAgentManager;
  transcriptWriter: DurableVoiceAgentTranscriptTurnWriter | null;
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
  const transcriptUserText = String(args.params.displayMessage ?? userText);

  const externalStreamId = `stream_${randomUUID()}`;
  const userMeta = {
    sentFrom: 'voice_agent',
    source: 'cli',
    happier: {
      kind: 'voice_agent_turn.v1',
      payload: {
        v: 1,
        epoch: ctrl.transcript.epoch,
        role: 'user',
        voiceAgentId: ctrl.voiceAgentId,
        runId: args.runId,
        streamId: externalStreamId,
        ts: Date.now(),
      },
    },
  };

  try {
    if (args.params.userTranscript?.mode === 'persist') {
      if (
        ctrl.transcript.persistenceMode !== 'persistent'
        || !args.transcriptWriter?.appendUserTextCommitted
        || !args.transcriptWriter.appendAssistantTextCommitted
      ) {
        return {
          ok: false,
          errorCode: 'execution_run_not_allowed',
          error: 'Persistent transcript writer is required',
        };
      }
      const persisted = await args.transcriptWriter.appendUserTextCommitted(transcriptUserText, {
        localId: args.params.userTranscript.localId,
        meta: userMeta,
      });
      if (!persisted.persisted) {
        return {
          ok: false,
          errorCode: 'execution_run_failed',
          error: 'Voice-agent user transcript was not durably persisted',
        };
      }
    }

    const started = await args.voiceAgentManager.startTurnStream({ voiceAgentId: ctrl.voiceAgentId, userText });
    ctrl.externalStreamIdByInternal.set(started.streamId, externalStreamId);
    ctrl.internalStreamIdByExternal.set(externalStreamId, started.streamId);
    if (
      args.transcriptWriter
      && ctrl.transcript.persistenceMode === 'persistent'
      && (!args.params.userTranscript || args.transcriptWriter.appendAssistantTextCommitted)
    ) {
      ctrl.pendingTranscriptTurnByExternalStreamId.set(externalStreamId, {
        mode: args.params.userTranscript ? 'assistant_only' : 'legacy_pair',
        user: args.params.userTranscript
          ? null
          : {
              text: transcriptUserText,
              localId: `voice_agent_user:${randomUUID()}`,
              meta: userMeta,
            },
        assistant: null,
        commitInFlight: null,
      });
    }
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
  transcriptWriter: DurableVoiceAgentTranscriptTurnWriter | null;
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
    const cachedTerminalRead = ctrl.terminalReadByExternalStreamId.get(externalStreamId) ?? null;
    if (cachedTerminalRead && cachedTerminalRead.requestedCursor !== args.params.cursor) {
      throw new VoiceAgentError(
        'VOICE_AGENT_INVALID_CURSOR',
        'A failed terminal handoff may only be retried from its original cursor',
      );
    }
    let read = cachedTerminalRead?.result ?? null;
    if (!read) {
      let readInFlight = ctrl.readInFlightByExternalStreamId.get(externalStreamId) ?? null;
      if (!readInFlight) {
        readInFlight = args.voiceAgentManager.readTurnStream({
          voiceAgentId: ctrl.voiceAgentId,
          streamId: internalStreamId,
          cursor: args.params.cursor,
          maxEvents: args.params.maxEvents,
        });
        ctrl.readInFlightByExternalStreamId.set(externalStreamId, readInFlight);
      }
      try {
        read = await readInFlight;
      } finally {
        if (ctrl.readInFlightByExternalStreamId.get(externalStreamId) === readInFlight) {
          ctrl.readInFlightByExternalStreamId.delete(externalStreamId);
        }
      }
      if (read.done) {
        ctrl.terminalReadByExternalStreamId.set(externalStreamId, {
          requestedCursor: args.params.cursor,
          result: read,
        });
      }
    }
    const projectedEvents = read.events.map((event) =>
      projectVoiceOutputEventToExternalStream(event, internalStreamId, externalStreamId));

    // Persist assistant completion once per stream (optional).
    if (args.transcriptWriter && ctrl.transcript.persistenceMode === 'persistent') {
      const projectedTerminalEvent = read.terminalEvent
        ? projectVoiceOutputEventToExternalStream(read.terminalEvent, internalStreamId, externalStreamId)
        : null;
      const finalEvent = projectedTerminalEvent?.t === 'voice_output'
        && projectedTerminalEvent.output.kind === 'turn_final'
        ? projectedTerminalEvent
        : projectedEvents.find(
        (event) => event.t === 'voice_output' && event.output.kind === 'turn_final',
      );
      const assistantText = finalEvent?.t === 'voice_output' && finalEvent.output.kind === 'turn_final'
        ? finalEvent.output.text
        : null;
      if (assistantText !== null) {
        let pendingTurn = ctrl.pendingTranscriptTurnByExternalStreamId.get(externalStreamId) ?? null;
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
              runId: args.runId,
              streamId: externalStreamId,
              ts: Date.now(),
            },
          },
        };
        if (!pendingTurn) throw new Error('Persistent voice-agent turn is missing its durable transcript state');
        if (!pendingTurn.assistant) pendingTurn.assistant = { text: assistantText, meta };
        await commitPendingTranscriptTurn(externalStreamId, pendingTurn, args.transcriptWriter);
      }
    }

    // Best-effort: reflect activity for machine-wide run listing.
    await args.writeActivityMarker(args.runId, args.getNowMs(), { force: true });

    if (read.done) {
      clearExternalTurnState(ctrl, externalStreamId, internalStreamId);
    }

    return {
      ok: true,
      streamId: externalStreamId,
      events: projectedEvents,
      nextCursor: read.nextCursor,
      done: read.done,
    };
  } catch (e) {
    if (e instanceof VoiceAgentError) {
      if (e.code === 'VOICE_AGENT_NOT_FOUND') return { ok: false, errorCode: 'execution_run_stream_not_found', error: e.message };
      if (e.code === 'VOICE_AGENT_BUSY') return { ok: false, errorCode: 'execution_run_busy', error: e.message };
      if (e.code === 'VOICE_AGENT_INVALID_CURSOR') return { ok: false, errorCode: 'execution_run_invalid_action_input', error: e.message };
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
    clearExternalTurnState(ctrl, externalStreamId, internalStreamId);
    return { ok: true };
  } catch (e) {
    if (e instanceof VoiceAgentError) {
      if (e.code === 'VOICE_AGENT_NOT_FOUND') return { ok: false, errorCode: 'execution_run_stream_not_found', error: e.message };
      if (e.code === 'VOICE_AGENT_BUSY') return { ok: false, errorCode: 'execution_run_busy', error: e.message };
      if (e.code === 'VOICE_AGENT_TURN_COMPLETED') return { ok: false, errorCode: 'execution_run_not_allowed', error: e.message };
      return { ok: false, errorCode: 'execution_run_failed', error: e.message };
    }
    return { ok: false, errorCode: 'execution_run_failed', error: e instanceof Error ? e.message : 'Execution failed' };
  }
}

export function readVoiceAgentController(ctrl: ExecutionRunController | null): ExecutionRunVoiceAgentController | null {
  if (!ctrl) return null;
  return ctrl.kind === 'voice_agent' ? ctrl : null;
}
