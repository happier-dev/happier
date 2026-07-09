import { readStoredSessionMessages } from '@/sync/domains/messages/readStoredSessionMessages';
import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { createTtsChunker, resolveStreamingTtsChunkChars } from '@/voice/output/TtsChunker';
import { createTtsPlaybackController } from '@/voice/output/TtsController';
import { speakAssistantText } from '@/voice/output/speakAssistantText';
import { resolveVoiceNetworkTimeoutMs } from '@/voice/runtime/fetchWithTimeout';
import { waitForNextAssistantTextMessage } from '@/voice/runtime/waitForNextAssistantTextMessage';
import {
  appendVoiceConversationAssistantText,
  appendVoiceConversationNoteText,
  appendVoiceConversationUserText,
} from '@/voice/transcript/voiceConversationTranscript';
import { voiceConversationRuntimeMachine } from '@/voice/runtime/machine/VoiceConversationRuntimeMachine';
import { transitionVoiceRuntimeToIdle } from '@/voice/runtime/machine/voiceConversationRuntimeHelpers';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { resolveVoiceBindingBySessionId } from '@/voice/binding/resolveVoiceBindingBySessionId';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import { parseLocalVoiceTtsSettings, resolveLocalVoiceAdapterSettings } from './localVoiceSettings';
import { runVoiceAgentTurnWithTools, type LocalVoiceAgentToolResultEntry } from './runVoiceAgentTurnWithTools';

type VoicePlaybackControllerLike = Readonly<{
  registerStopper: (stopper: () => void) => () => void;
  interrupt: () => void;
  captureEpoch: () => number;
  isEpochCurrent: (epoch: number) => boolean;
}>;

type VoiceAgentSessionsLike = Readonly<{
  sendTurn: (
    sessionId: string,
    userText: string,
    opts?:
      | {
          onTextDelta?: (delta: string) => void;
          signal?: AbortSignal;
        }
      | undefined,
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
  onTtsStarted?: (replyText: string) => void;
  /** Clear the echo guard + protected-head window when the reply stops/aborts. */
  onTtsStopped?: () => void;
}): Promise<void> {
  const sessionId = normalizeNonEmptyString(params.sessionId);
  if (!sessionId) {
    throw new Error('session_id_required');
  }
  const { settings, userText } = params;
  const { adapterId, config } = resolveLocalVoiceAdapterSettings(settings);
  const networkTimeoutMs = resolveVoiceNetworkTimeoutMs(config?.networkTimeoutMs, 15_000);
  const conversationMode =
    adapterId === 'local_conversation' ? ((config?.conversationMode ?? 'direct_session') as 'direct_session' | 'agent') : 'direct_session';
  const sessionBinding = resolveVoiceBindingBySessionId({ sessionId });
  const projectedConversationSessionId = sessionBinding?.conversationSessionId ?? null;
  const currentToolSessionId =
    sessionBinding?.targetSessionId
    ?? (sessionId === VOICE_AGENT_GLOBAL_SESSION_ID ? null : sessionId);

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

  if (projectedConversationSessionId) {
    appendVoiceConversationUserText({
      conversationSessionId: projectedConversationSessionId,
      text: userText,
    });
  }

  const isTurnAbortedError = (error: unknown): boolean => {
    const err: any = error;
    if (err?.name === 'AbortError' && typeof err?.message === 'string' && err.message.includes('turn_aborted')) return true;
    if (typeof err?.message === 'string' && err.message.includes('turn_aborted')) return true;
    if (typeof err === 'string' && err.includes('turn_aborted')) return true;
    return false;
  };

  const appendSyntheticToolResultNotes = (toolResults: ReadonlyArray<{ t?: unknown; result?: any }>) => {
    if (!projectedConversationSessionId) return;
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
  const seedReplyTtsGuard = (replyText: string) => {
    if (ttsGuardSeeded) return;
    const trimmed = replyText.trim();
    if (!trimmed) return;
    ttsGuardSeeded = true;
    params.onTtsStarted?.(trimmed);
  };
  const clearReplyTtsGuard = () => {
    if (!ttsGuardSeeded) return;
    ttsGuardSeeded = false;
    params.onTtsStopped?.();
  };

  if (conversationMode === 'agent') {
    const tts = parseLocalVoiceTtsSettings(config?.tts);
    const autoSpeak = tts.autoSpeakReplies !== false;
    const ttsProvider = tts.provider;
    const openaiCompatBaseUrl = String(tts.openaiCompat.baseUrl ?? '').trim();
    const streamingSpeechEnabled =
      autoSpeak &&
      config?.streaming?.enabled === true &&
      config?.streaming?.ttsEnabled === true &&
      (ttsProvider === 'device' ||
        ttsProvider === 'local_neural' ||
        (ttsProvider === 'openai_compat' && Boolean(openaiCompatBaseUrl)));
    const streamingChunkChars = resolveStreamingTtsChunkChars(config?.streaming?.ttsChunkChars);

    voiceConversationRuntimeMachine.transitionToThinking({ controlSessionId: sessionId });
    // Cleanup for the streaming playback queue's interrupt stopper. Hoisted so the
    // outer `finally` releases it on any exit path (success, abort, or failure).
    let releaseStreamingQueueStopper = () => {};
    try {
      throwIfAborted();
      const chunker = streamingSpeechEnabled ? createTtsChunker(streamingChunkChars) : null;
      const playbackEpoch = params.playbackController.captureEpoch();

      // Canonical ordered ack'd TTS queue (D10/L4.T2): chunks for one assistant
      // turn share a `groupId`, advance only on a contiguous `chunkIndex` run,
      // and the queue serializes `playChunk` with per-chunk backpressure. This is
      // the single ordering owner — the previous ad-hoc serial promise chain is
      // gone, and every provider TTS controller converges on `speakAssistantText`
      // inside `playChunk` below.
      const streamingGroupId = `${sessionId}#${playbackEpoch}`;
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
            registerPlaybackStopper: params.playbackController.registerStopper,
            onSpeaking: () => {
              seedReplyTtsGuard(chunk.text);
              voiceConversationRuntimeMachine.transitionToSpeaking({ controlSessionId: sessionId });
            },
          });
        },
      });

      // The queue is the live ordering owner, so a barge-in/interrupt must abort
      // it. `playbackController.interrupt()` (driven by the barge-in controller
      // and manual/turn aborts) advances the playback epoch and fires the
      // registered stopper; here that stopper aborts the queue handle so no
      // further chunks play. The in-flight chunk's own provider stopper
      // (registered inside `speakAssistantText` → provider controller) still
      // stops the live audio, keeping the interrupt → abort path intact.
      let speakHandle: ReturnType<typeof playbackQueue.speak> | null = null;
      const ensureQueueStarted = () => {
        if (speakHandle) return;
        speakHandle = playbackQueue.speak();
        releaseStreamingQueueStopper = params.playbackController.registerStopper(() => {
          speakHandle?.abort();
        });
      };

      let queuedChunkCount = 0;
      let nextChunkIndex = 0;
      // When the assistant text ends we mark the latest enqueued chunk as the
      // final one so the queue can retire the group and resolve `done`.
      const pendingChunks: string[] = [];
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
        if (params.signal?.aborted) return;
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
        } finally {
          releaseStreamingQueueStopper();
          releaseStreamingQueueStopper = () => {};
        }
      };

      const canSpeak =
        autoSpeak &&
        (ttsProvider === 'device' ||
          ttsProvider === 'local_neural' ||
          (ttsProvider === 'openai_compat' && Boolean(openaiCompatBaseUrl)));
      const speakAssistantReply = async (assistantText: string, turnIndex: number) => {
        if (!canSpeak || !assistantText.trim()) return;
        if (turnIndex === 0 && chunker) {
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
          registerPlaybackStopper: params.playbackController.registerStopper,
          onSpeaking: () => {
            seedReplyTtsGuard(assistantText);
            voiceConversationRuntimeMachine.transitionToSpeaking({ controlSessionId: sessionId });
          },
        });
      };

      await runVoiceAgentTurnWithTools({
        sessionId,
        userText,
        currentToolSessionId,
        voiceAgentSessions: params.voiceAgentSessions,
        signal: params.signal,
        onTextDelta: chunker
          ? (textDelta) => {
              if (params.signal?.aborted) return;
              const nextChunks = chunker.push(textDelta);
              nextChunks.forEach((chunk) => queueSpokenChunk(chunk));
            }
          : undefined,
        onAssistantTurn: async ({ assistantText, turnIndex }) => {
          throwIfAborted();
          if (projectedConversationSessionId) {
            appendVoiceConversationAssistantText({
              conversationSessionId: projectedConversationSessionId,
              text: assistantText,
            });
          }
          await speakAssistantReply(assistantText, turnIndex);
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
      transitionVoiceRuntimeToIdleIfCurrent({
        controlSessionId: sessionId,
        reason: 'send_failed',
      });
      throw error instanceof Error ? error : new Error('send_failed');
    } finally {
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
    await sync.sendMessage(sessionId, userText, undefined, undefined, {
      bypassPendingQueueReason: 'voice_turn',
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

  const assistantText = await waitForNextAssistantTextMessage(sessionId, baselineIds, baselineCount, 60_000, params.signal);
  if (params.signal?.aborted) {
    transitionVoiceRuntimeToIdleIfCurrent({ controlSessionId: sessionId });
    return;
  }
  if (!assistantText) {
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
      text: assistantText,
      settings,
      networkTimeoutMs,
      registerPlaybackStopper: params.playbackController.registerStopper,
      onSpeaking: () => {
        seedReplyTtsGuard(assistantText);
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
