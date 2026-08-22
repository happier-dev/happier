import { readStoredSessionMessages } from '@/sync/domains/messages/readStoredSessionMessages';
import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { createTtsChunker, resolveStreamingTtsChunkChars } from '@/voice/output/TtsChunker';
import { createTtsPlaybackController, type TtsSpeakHandle } from '@/voice/output/TtsController';
import { speakAssistantText } from '@/voice/output/speakAssistantText';
import { resolveVoiceNetworkTimeoutMs } from '@/voice/runtime/fetchWithTimeout';
import { waitForNextAssistantTextMessageEntry } from '@/voice/runtime/waitForNextAssistantTextMessage';
import {
  appendVoiceConversationAssistantText,
  appendVoiceConversationNoteText,
  appendVoiceConversationUserText,
} from '@/voice/transcript/voiceConversationTranscript';
import { voiceConversationRuntimeMachine } from '@/voice/runtime/machine/VoiceConversationRuntimeMachine';
import { transitionVoiceRuntimeToIdle } from '@/voice/runtime/machine/voiceConversationRuntimeHelpers';
import { classifyVoiceMachineError } from '@/voice/runtime/machine/voiceMachineError';
import { voiceOutputStatusStore } from '@/voice/runtime/outputStatus/voiceOutputStatusStore';
import type { VoicePlaybackStopperRegistrar } from '@/voice/runtime/playback/VoicePlaybackController';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { resolveVoiceBindingBySessionId } from '@/voice/binding/resolveVoiceBindingBySessionId';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import {
  submitDurableVoiceTextTurn,
  type VoiceTextTurnPendingPort,
} from '@/voice/binding/sendVoiceSessionComposerText';
import { parseLocalVoiceTtsSettings, resolveLocalVoiceAdapterSettings } from './localVoiceSettings';
import { runVoiceAgentTurnWithTools, type LocalVoiceAgentToolResultEntry } from './runVoiceAgentTurnWithTools';
import type {
  VoiceAgentAcceptedOutputV1,
  VoiceAgentSendTurnOptions,
} from '@/voice/agent/types';
import type { VoiceCurrentUiToolPort } from '@/voice/tools/currentUiContextToolPort';

type VoicePlaybackControllerLike = Readonly<{
  registerStopper: VoicePlaybackStopperRegistrar;
  interrupt: () => void;
  captureEpoch: () => number;
  isEpochCurrent: (epoch: number) => boolean;
}>;

type VoiceAgentSessionsLike = Readonly<{
  commitUserTranscript?: (sessionId: string, userText: string, localId: string) => Promise<void>;
  sendTurn: (
    sessionId: string,
    userText: string,
    opts?: VoiceAgentSendTurnOptions,
  ) => Promise<{ assistantText: string; actions?: ReadonlyArray<unknown> }>;
}>;

export async function sendVoiceTextTurn(params: {
  sessionId: string;
  settings: any;
  userText: string;
  playbackController: VoicePlaybackControllerLike;
  voiceAgentSessions: VoiceAgentSessionsLike;
  signal?: AbortSignal;
  /**
   * Seed the barge-in echo guard + protected-head window with the assistant
   * reply text when the reply starts speaking. Mirrors the prewarm/welcome
   * seam (`noteTtsStarted` in `localVoiceEngine`) so the textual echo guard and
   * the 800 ms protected head are live for the PRIMARY reply, not only the
   * welcome speak. Without it both gates are inert for replies — harmless while
   * the loop is half-duplex (mic torn down during a reply), but a
   * self-interruption risk the moment full-duplex keeps the mic open over reply
   * TTS.
   */
  onTtsStarted?: (replyText: string, assistantEntryId: string | null) => void;
  /**
   * Update the exact persisted assistant final bound to the active playback.
   * Streaming speech may begin before this identity exists.
   */
  onAssistantFinalAvailable?: (assistantEntryId: string | null) => void;
  /** Clear the echo guard + protected-head window when the reply stops/aborts. */
  onTtsStopped?: () => void;
  pendingPort?: VoiceTextTurnPendingPort;
  durableDispatch?: Readonly<{
    localId: string;
    deliveryCommand: 'interrupt_and_send';
  }>;
  onUserTranscriptAccepted?: () => Promise<void>;
  /** Provider-owned current UI port carried by this exact local voice attempt. */
  currentUiContext?: VoiceCurrentUiToolPort;
}): Promise<void> {
  const sessionId = normalizeNonEmptyString(params.sessionId);
  if (!sessionId) {
    throw new Error('session_id_required');
  }
  const { settings, userText } = params;
  const registerPlaybackStopper =
    params.playbackController.registerStopper.captureAttempt?.() ?? params.playbackController.registerStopper;
  const { adapterId, config } = resolveLocalVoiceAdapterSettings(settings);
  const networkTimeoutMs = resolveVoiceNetworkTimeoutMs(config?.networkTimeoutMs, 15_000);
  const conversationMode =
    adapterId === 'local_conversation' ? ((config?.conversationMode ?? 'direct_session') as 'direct_session' | 'agent') : 'direct_session';
  const sessionBinding = resolveVoiceBindingBySessionId({ sessionId });
  const projectedConversationSessionId = sessionBinding?.conversationSessionId ?? null;
  const uiOwnsTranscriptProjection = sessionBinding?.transcriptMode === 'synthetic';
  const currentToolSessionId =
    sessionBinding?.targetSessionId
    ?? (sessionId === VOICE_AGENT_GLOBAL_SESSION_ID ? null : sessionId);

  if (conversationMode === 'agent' && !params.durableDispatch) {
    if (!projectedConversationSessionId) throw new Error('voice_session_binding_required');
    const result = await submitDurableVoiceTextTurn({
      conversationSessionId: projectedConversationSessionId,
      text: userText,
      pendingPort: params.pendingPort,
      dispatch: async ({ localId, deliveryCommand, onAccepted }) => {
        await sendVoiceTextTurn({
          ...params,
          durableDispatch: { localId, deliveryCommand },
          onUserTranscriptAccepted: onAccepted,
        });
      },
    });
    if (!result.ok) throw new Error(result.message ?? result.reason);
    if (result.disposition === 'settled') return;
    throw new Error(result.disposition === 'ambiguous' ? 'voice_turn_dispatch_ambiguous' : 'voice_turn_pending');
  }

  const transitionVoiceRuntimeToIdleIfCurrent = (idleParams: Parameters<typeof transitionVoiceRuntimeToIdle>[0]) => {
    const snapshot = voiceConversationRuntimeMachine.getSnapshot();
    if (snapshot.controlSessionId !== sessionId) {
      return;
    }
    if (snapshot.state === 'disconnected' || snapshot.state === 'ending') {
      return;
    }
    transitionVoiceRuntimeToIdle(idleParams);
  };

  if (projectedConversationSessionId && uiOwnsTranscriptProjection) {
    appendVoiceConversationUserText({
      conversationSessionId: projectedConversationSessionId,
      text: userText,
    });
  }

  const isTurnAbortedError = (error: unknown): boolean => {
    const err: any = error;
    if (err?.rpcErrorCode === 'cancelled' || err?.code === 'cancelled') return true;
    if (err?.name === 'AbortError' && typeof err?.message === 'string' && err.message.includes('turn_aborted')) return true;
    if (typeof err?.message === 'string' && (err.message.includes('turn_aborted') || err.message.includes('stream_cancelled'))) return true;
    if (typeof err === 'string' && (err.includes('turn_aborted') || err.includes('stream_cancelled'))) return true;
    return false;
  };

  const appendSyntheticToolResultNotes = (toolResults: ReadonlyArray<{ t?: unknown; result?: any }>) => {
    if (!projectedConversationSessionId || !uiOwnsTranscriptProjection) return;
    for (const toolResult of toolResults) {
      const toolName = typeof toolResult?.t === 'string' ? toolResult.t.trim() : '';
      if (!toolName) continue;
      const succeeded = toolResult?.result?.ok !== false;
      appendVoiceConversationNoteText({
        conversationSessionId: projectedConversationSessionId,
        text: `Tool result: ${toolName} ${succeeded ? 'succeeded' : 'failed'}`,
      });
    }
  };

  const throwIfAborted = () => {
    if (params.signal?.aborted) {
      throw Object.assign(new Error('turn_aborted'), { name: 'AbortError' });
    }
  };

  // Seed the barge-in echo guard + protected-head window once, at the reply's
  // first transition to `speaking`, and clear it on every reply exit
  // (success/abort/failure/interrupt). Seeding once (not per streamed chunk)
  // keeps the protected head + the echo guard's AEC "just started" window
  // anchored to the start of the reply rather than resetting on each chunk.
  let ttsGuardSeeded = false;
  let currentAssistantEntryId: string | null = null;
  const noteAssistantFinal = (assistantEntryId: string | null) => {
    currentAssistantEntryId = normalizeNonEmptyString(assistantEntryId);
    params.onAssistantFinalAvailable?.(currentAssistantEntryId);
  };
  const seedReplyTtsGuard = (replyText: string, assistantEntryId?: string | null) => {
    if (ttsGuardSeeded) return;
    const trimmed = replyText.trim();
    if (!trimmed) return;
    if (assistantEntryId !== undefined) noteAssistantFinal(assistantEntryId);
    ttsGuardSeeded = true;
    params.onTtsStarted?.(trimmed, currentAssistantEntryId);
  };
  const clearReplyTtsGuard = () => {
    noteAssistantFinal(null);
    if (!ttsGuardSeeded) return;
    ttsGuardSeeded = false;
    params.onTtsStopped?.();
  };

  if (conversationMode === 'agent') {
    const tts = parseLocalVoiceTtsSettings(config?.tts);
    const autoSpeak = tts.autoSpeakReplies !== false;
    const streamingSpeechEnabled =
      autoSpeak &&
      config?.streaming?.enabled === true &&
      config?.streaming?.ttsEnabled === true;
    const streamingChunkChars = resolveStreamingTtsChunkChars(config?.streaming?.ttsChunkChars);

    voiceConversationRuntimeMachine.transitionToThinking({ controlSessionId: sessionId });
    // Cleanup for the streaming playback queue's interrupt stopper. Hoisted so the
    // outer `finally` releases it on any exit path (success, abort, or failure).
    let releaseStreamingQueueStopper = () => {};
    const canonicalOutputTurnIds = new Set<string>();
    let streamingPlaybackError: unknown = null;
    try {
      throwIfAborted();
      const playbackEpoch = params.playbackController.captureEpoch();
      let currentOutputTurnId: string | null = null;
      let chunker = streamingSpeechEnabled ? createTtsChunker(streamingChunkChars) : null;
      let canonicalTurnFinalized = false;
      let canonicalTurnCancelled = false;
      let speakHandle: TtsSpeakHandle | null = null;
      let streamingGroupId = '';
      let queuedChunkCount = 0;
      let nextChunkIndex = 0;
      const pendingChunks: string[] = [];

      const beginOutputTurn = (turnId: string) => {
        if (currentOutputTurnId === turnId) return;
        currentOutputTurnId = turnId;
        canonicalOutputTurnIds.add(turnId);
        chunker = streamingSpeechEnabled ? createTtsChunker(streamingChunkChars) : null;
        canonicalTurnFinalized = false;
        canonicalTurnCancelled = false;
        speakHandle = null;
        streamingGroupId = `${sessionId}#${playbackEpoch}#${turnId}`;
        queuedChunkCount = 0;
        nextChunkIndex = 0;
        pendingChunks.splice(0, pendingChunks.length);
      };

      // Canonical ordered ack'd TTS queue (D10/L4.T2): chunks for one assistant
      // turn share a `groupId`, advance only on a contiguous `chunkIndex` run,
      // and the queue serializes `playChunk` with per-chunk backpressure. This is
      // the single ordering owner — the previous ad-hoc serial promise chain is
      // gone, and every provider TTS controller converges on `speakAssistantText`
      // inside `playChunk` below.
      const playbackQueue = createTtsPlaybackController<{ text: string }>({
        playChunk: async (chunk) => {
          // The terminal sentinel carries empty text purely to mark the group's
          // last chunk; nothing to speak, just advance/retire the queue.
          if (!chunk.text) return;
          if (params.signal?.aborted) return;
          if (!params.playbackController.isEpochCurrent(playbackEpoch)) return;
          await speakAssistantText({
            sessionId,
            text: chunk.text,
            settings,
            networkTimeoutMs,
            registerPlaybackStopper,
            onSpeaking: () => {
              seedReplyTtsGuard(chunk.text);
              voiceConversationRuntimeMachine.transitionToSpeaking({ controlSessionId: sessionId });
            },
          });
        },
        onPlaybackError: (_chunk, error) => {
          if (canonicalTurnCancelled || params.signal?.aborted || streamingPlaybackError !== null) return;
          streamingPlaybackError = error;
          speakHandle?.abort();
        },
      });

      // The queue is the live ordering owner, so a barge-in/interrupt must abort
      // it. `playbackController.interrupt()` (driven by the barge-in controller
      // and manual/turn aborts) advances the playback epoch and fires the
      // registered stopper; here that stopper aborts the queue handle so no
      // further chunks play. The in-flight chunk's own provider stopper
      // (registered inside `speakAssistantText` → provider controller) still
      // stops the live audio, keeping the interrupt → abort path intact.
      const ensureQueueStarted = () => {
        if (speakHandle) return;
        speakHandle = playbackQueue.speak();
        releaseStreamingQueueStopper = registerPlaybackStopper(() => {
          speakHandle?.abort();
        });
      };

      // When the assistant text ends we mark the latest enqueued chunk as the
      // final one so the queue can retire the group and resolve `done`.
      const flushPendingChunks = (markLast: boolean) => {
        if (params.signal?.aborted) return;
        if (pendingChunks.length === 0) return;
        ensureQueueStarted();
        const batch = pendingChunks.splice(0, pendingChunks.length);
        batch.forEach((text, offset) => {
          playbackQueue.enqueue({
            groupId: streamingGroupId,
            chunkIndex: nextChunkIndex + offset,
            isLastChunk: markLast && offset === batch.length - 1,
            text,
          });
        });
        nextChunkIndex += batch.length;
      };

      const queueSpokenChunk = (chunkText: string) => {
        if (params.signal?.aborted || canonicalTurnCancelled || streamingPlaybackError !== null) return;
        const trimmed = chunkText.trim();
        if (!trimmed) return;
        queuedChunkCount += 1;
        pendingChunks.push(trimmed);
        // Emit eagerly (no terminal marker) so audio starts as deltas stream;
        // the final marker is applied when the assistant turn completes.
        flushPendingChunks(false);
      };

      // Mark the end of the streamed turn and wait for the queue to drain. If
      // every real chunk was already emitted eagerly, enqueue a terminal sentinel
      // (empty text → `speakAssistantText` no-ops) so the group retires and the
      // speak handle's `done` resolves.
      const finalizeStreamedTurn = async () => {
        const handle = speakHandle;
        if (!handle) {
          // Nothing was ever enqueued (no speakable text): nothing to await.
          return;
        }
        // If an interrupt already advanced the playback epoch (barge-in/abort),
        // abort the queue handle directly so `done` resolves instead of draining
        // no-op chunks. Mirrors the old chain's epoch short-circuit.
        if (params.signal?.aborted || !params.playbackController.isEpochCurrent(playbackEpoch)) {
          handle.abort();
        } else if (pendingChunks.length > 0) {
          flushPendingChunks(true);
        } else {
          playbackQueue.enqueue({
            groupId: streamingGroupId,
            chunkIndex: nextChunkIndex,
            isLastChunk: true,
            text: '',
          });
          nextChunkIndex += 1;
        }
        try {
          await handle.done;
          if (streamingPlaybackError !== null) {
            throw streamingPlaybackError;
          }
        } finally {
          releaseStreamingQueueStopper();
          releaseStreamingQueueStopper = () => {};
          speakHandle = null;
        }
      };

      const cancelStreamedTurn = async () => {
        if (canonicalTurnCancelled) return;
        canonicalTurnCancelled = true;
        canonicalTurnFinalized = true;
        pendingChunks.splice(0, pendingChunks.length);
        const handle = speakHandle;
        if (handle) {
          handle.abort();
          params.playbackController.interrupt();
          await handle.done;
        }
        releaseStreamingQueueStopper();
        releaseStreamingQueueStopper = () => {};
      };

      const consumeCanonicalOutputEvent = async ({ event, effects }: VoiceAgentAcceptedOutputV1) => {
        beginOutputTurn(event.turnId);
        let finalAccepted = false;
        for (const effect of effects) {
          if (effect.kind === 'speak') {
            if (!streamingSpeechEnabled) {
              continue;
            }
            if (chunker) {
              chunker.push(effect.text).forEach((chunk) => queueSpokenChunk(chunk));
            } else {
              queueSpokenChunk(effect.text);
            }
          } else if (effect.kind === 'display_status') {
            voiceOutputStatusStore.show({
              sessionId,
              turnId: event.turnId,
              statusId: effect.statusId,
              text: effect.text,
            });
          } else if (effect.kind === 'persist_final') {
            finalAccepted = true;
            voiceOutputStatusStore.clear({ sessionId, turnId: event.turnId });
          } else if (effect.kind === 'cancel_turn') {
            voiceOutputStatusStore.clear({ sessionId, turnId: event.turnId });
            await cancelStreamedTurn();
          }
        }
        if (finalAccepted && !canonicalTurnFinalized) {
          canonicalTurnFinalized = true;
          chunker?.flush().forEach((chunk) => queueSpokenChunk(chunk));
          await finalizeStreamedTurn();
        }
      };

      const speakAssistantReply = async (
        assistantText: string,
        _turnIndex: number,
        assistantEntryId: string | null,
      ) => {
        if (!autoSpeak || !assistantText.trim()) return;
        noteAssistantFinal(assistantEntryId);
        if (streamingSpeechEnabled && currentOutputTurnId && chunker) {
          if (canonicalTurnFinalized) return;
          chunker.flush().forEach((chunk) => queueSpokenChunk(chunk));
          if (queuedChunkCount === 0) {
            queueSpokenChunk(assistantText);
          }
          await finalizeStreamedTurn();
          return;
        }

        throwIfAborted();
        await speakAssistantText({
          sessionId,
          text: assistantText,
          settings,
          networkTimeoutMs,
          registerPlaybackStopper,
          onSpeaking: () => {
            seedReplyTtsGuard(assistantText);
            voiceConversationRuntimeMachine.transitionToSpeaking({ controlSessionId: sessionId });
          },
        });
      };

      await runVoiceAgentTurnWithTools({
        sessionId,
        userText,
        durableLocalId: params.durableDispatch!.localId,
        currentToolSessionId,
        ...(params.currentUiContext ? { currentUiContext: params.currentUiContext } : {}),
        voiceAgentSessions: params.voiceAgentSessions,
        signal: params.signal,
        onUserTranscriptAccepted: params.onUserTranscriptAccepted,
        onOutputEvent: consumeCanonicalOutputEvent,
        onAssistantTurn: async ({ assistantText, turnIndex }) => {
          throwIfAborted();
          let assistantEntryId: string | null = null;
          if (projectedConversationSessionId && uiOwnsTranscriptProjection) {
            assistantEntryId = appendVoiceConversationAssistantText({
              conversationSessionId: projectedConversationSessionId,
              text: assistantText,
            });
          }
          await speakAssistantReply(assistantText, turnIndex, assistantEntryId);
        },
        onToolResults: async ({ toolResults }) => {
          appendSyntheticToolResultNotes(toolResults as ReadonlyArray<LocalVoiceAgentToolResultEntry>);
        },
      });
      return;
    } catch (error) {
      if (isTurnAbortedError(error) || params.signal?.aborted) {
        transitionVoiceRuntimeToIdleIfCurrent({ controlSessionId: sessionId });
        return;
      }
      if (streamingPlaybackError !== null) {
        const machineError = classifyVoiceMachineError(streamingPlaybackError, {
          kind: 'tts_failed',
          reason: 'tts_failed',
        });
        transitionVoiceRuntimeToIdleIfCurrent({
          controlSessionId: sessionId,
          kind: machineError.kind,
          reason: machineError.reason,
        });
        throw streamingPlaybackError instanceof Error
          ? streamingPlaybackError
          : Object.assign(new Error(machineError.reason), machineError);
      }
      transitionVoiceRuntimeToIdleIfCurrent({
        controlSessionId: sessionId,
        reason: 'send_failed',
      });
      throw error instanceof Error ? error : new Error('send_failed');
    } finally {
      for (const turnId of canonicalOutputTurnIds) {
        voiceOutputStatusStore.clear({ sessionId, turnId });
      }
      // Clear the echo guard + protected-head window for every reply exit
      // (success, abort, failure, or barge-in interrupt) so no stale window
      // outlives the reply.
      clearReplyTtsGuard();
      releaseStreamingQueueStopper();
      if (voiceConversationRuntimeMachine.getSnapshot().state !== 'listening') {
        transitionVoiceRuntimeToIdleIfCurrent({ controlSessionId: sessionId });
      }
    }
  }

  const baselineMessages = readStoredSessionMessages(storage.getState(), sessionId) as any[];
  const baselineCount = baselineMessages.length;
  const baselineIds = new Set<string>(
    baselineMessages
      .map((message: any) => message?.id)
      .filter((messageId: any): messageId is string => typeof messageId === 'string'),
  );

  voiceConversationRuntimeMachine.transitionToThinking({ controlSessionId: sessionId });
  try {
    throwIfAborted();
    await sync.submitMessage(sessionId, userText, undefined, undefined, {
      callerSurface: 'voice_turn',
      forceImmediate: true,
      hostAdmissionOrigin: 'voice',
    });
  } catch (error) {
    transitionVoiceRuntimeToIdleIfCurrent({
      controlSessionId: sessionId,
      reason: 'send_failed',
    });
    throw error;
  }

  const autoSpeak = config?.tts?.autoSpeakReplies !== false;
  if (!autoSpeak) {
    transitionVoiceRuntimeToIdleIfCurrent({ controlSessionId: sessionId });
    return;
  }

  const assistantEntry = await waitForNextAssistantTextMessageEntry(
    sessionId,
    baselineIds,
    baselineCount,
    60_000,
    params.signal,
  );
  if (params.signal?.aborted) {
    transitionVoiceRuntimeToIdleIfCurrent({ controlSessionId: sessionId });
    return;
  }
  if (!assistantEntry) {
    transitionVoiceRuntimeToIdleIfCurrent({ controlSessionId: sessionId });
    return;
  }

  if (params.signal?.aborted) {
    transitionVoiceRuntimeToIdleIfCurrent({ controlSessionId: sessionId });
    return;
  }
  try {
    await speakAssistantText({
      sessionId,
      text: assistantEntry.text,
      settings,
      networkTimeoutMs,
      registerPlaybackStopper,
      onSpeaking: () => {
        seedReplyTtsGuard(assistantEntry.text, assistantEntry.entryId);
        voiceConversationRuntimeMachine.transitionToSpeaking({ controlSessionId: sessionId });
      },
    });
  } finally {
    // Clear on every reply exit (completion, abort, failure, or barge-in
    // interrupt) so no stale echo guard / protected-head window survives.
    clearReplyTtsGuard();
  }
  if (voiceConversationRuntimeMachine.getSnapshot().state !== 'listening') {
    transitionVoiceRuntimeToIdleIfCurrent({ controlSessionId: sessionId });
  }
}
