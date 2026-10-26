import { sync } from '@/sync/sync';
import { createTtsChunker, resolveStreamingTtsChunkChars } from '@/voice/output/TtsChunker';
import { speakAssistantText } from '@/voice/output/speakAssistantText';
import { createSpeechTextContext, type SpeechTextContext } from '@/voice/output/speechText';
import { resolveVoiceNetworkTimeoutMs } from '@/voice/runtime/fetchWithTimeout';
import {
  captureSessionTurnBaseline,
  waitForTurnFinalAssistantText,
} from '@/voice/runtime/waitForNextAssistantTextMessage';
import { voiceActivityController } from '@/voice/activity/voiceActivityController';
import {
  appendVoiceConversationAssistantText,
  appendVoiceConversationNoteText,
  appendVoiceConversationUserText,
} from '@/voice/sessionBinding/voiceConversationTranscript';
import {
  resolveVoiceSessionBindingByControlSessionId,
  resolveVoiceSessionBindingByConversationSessionId,
} from '@/voice/sessionBinding/resolveVoiceSessionBinding';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import {
  submitDurableVoiceTextTurn,
  type VoiceTextTurnPendingPort,
} from '@/voice/sessionBinding/sendVoiceSessionComposerText';

import { patchLocalVoiceState, resolveLocalVoiceError, setIdleStateUnlessRecording } from './localVoiceState';
import { resolveLocalVoiceAdapterSettings } from './localVoiceSettings';
import { runVoiceAgentTurnWithTools, type LocalVoiceAgentToolResultEntry } from './runVoiceAgentTurnWithTools';

type VoicePlaybackControllerLike = Readonly<{
  registerStopper: (stopper: () => void) => () => void;
  interrupt: () => void;
  captureEpoch: () => number;
  isEpochCurrent: (epoch: number) => boolean;
}>;

type VoiceAgentSessionsLike = Readonly<{
  commitUserTranscript?: (sessionId: string, userText: string, localId: string) => Promise<void>;
  sendTurn: (
    sessionId: string,
    userText: string,
    opts?:
      | {
          onTextDelta?: (delta: string) => void;
          signal?: AbortSignal;
          userTranscript?: import('@happier-dev/protocol').ExecutionRunUserTranscriptDirective;
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
  pendingPort?: VoiceTextTurnPendingPort;
  durableDispatch?: Readonly<{
    localId: string;
    handoffMode: 'interrupt_and_send';
  }>;
}): Promise<void> {
  const { sessionId, settings, userText } = params;
  const { adapterId, config } = resolveLocalVoiceAdapterSettings(settings);
  const networkTimeoutMs = resolveVoiceNetworkTimeoutMs(config?.networkTimeoutMs, 15_000);
  const conversationMode =
    adapterId === 'local_conversation' ? ((config?.conversationMode ?? 'direct_session') as 'direct_session' | 'agent') : 'direct_session';
  const sessionBinding =
    resolveVoiceSessionBindingByControlSessionId({ controlSessionId: sessionId })
    ?? resolveVoiceSessionBindingByConversationSessionId({ conversationSessionId: sessionId })
    ?? null;
  const syntheticConversationSessionId =
    sessionBinding?.transcriptMode === 'synthetic'
      ? sessionBinding.conversationSessionId
      : null;
  const currentToolSessionId =
    sessionBinding?.targetSessionId
    ?? (sessionId === VOICE_AGENT_GLOBAL_SESSION_ID ? null : sessionId);

  if (conversationMode === 'agent' && !params.durableDispatch) {
    if (!sessionBinding) {
      throw new Error('voice_session_binding_required');
    }
    const result = await submitDurableVoiceTextTurn({
      conversationSessionId: sessionBinding.conversationSessionId,
      text: userText,
      pendingPort: params.pendingPort,
      dispatch: async (durableDispatch) => {
        await sendVoiceTextTurn({ ...params, durableDispatch });
      },
    });
    if (!result.ok) throw new Error(result.message ?? result.reason);
    if (result.disposition === 'settled') return;
    if (result.disposition !== 'handoff_acknowledged') {
      throw new Error(
        result.disposition === 'ambiguous'
          ? 'voice_turn_dispatch_ambiguous'
          : 'voice_turn_pending',
      );
    }
    return;
  }

  voiceActivityController.appendUserText(sessionId, adapterId, userText);
  const voiceAgentBackend = String(config?.agent?.backend ?? 'daemon').trim() || 'daemon';
  if (
    syntheticConversationSessionId
    && !(conversationMode === 'agent' && voiceAgentBackend === 'daemon')
  ) {
    appendVoiceConversationUserText({
      conversationSessionId: syntheticConversationSessionId,
      text: userText,
      localId: params.durableDispatch?.localId,
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
    if (!syntheticConversationSessionId) return;
    for (const toolResult of toolResults) {
      const toolName = typeof toolResult?.t === 'string' ? toolResult.t.trim() : '';
      if (!toolName) continue;
      const succeeded = toolResult?.result?.ok !== false;
      appendVoiceConversationNoteText({
        conversationSessionId: syntheticConversationSessionId,
        text: `[Voice] Tool result: ${toolName} ${succeeded ? 'succeeded' : 'failed'}`,
      });
    }
  };

  const throwIfAborted = () => {
    if (params.signal?.aborted) {
      throw Object.assign(new Error('turn_aborted'), { name: 'AbortError' });
    }
  };

  if (conversationMode === 'agent') {
    const durableLocalId = params.durableDispatch?.localId;
    if (!durableLocalId) {
      throw new Error('voice_durable_local_id_required');
    }
    // Whether a provider can actually speak (configured key/base URL) is decided by the canonical
    // TTS runtime behind speakAssistantText; this turn only honours the auto-speak preference.
    const autoSpeak = config?.tts?.autoSpeakReplies !== false;
    const streamingSpeechEnabled =
      autoSpeak && config?.streaming?.enabled === true && config?.streaming?.ttsEnabled === true;
    const streamingChunkChars = resolveStreamingTtsChunkChars(config?.streaming?.ttsChunkChars);

    patchLocalVoiceState({ status: 'sending' });
    try {
      throwIfAborted();
      const chunker = streamingSpeechEnabled ? createTtsChunker(streamingChunkChars) : null;
      const streamingSpeechTextContext = chunker ? createSpeechTextContext() : undefined;
      const playbackEpoch = params.playbackController.captureEpoch();
      let queuedChunkCount = 0;
      let chunkPlaybackQueue: Promise<void> = Promise.resolve();
      // One failure is reported once per turn; the rest of that turn's speech is skipped.
      let speechFailed = false;

      // A barge-in advances the playback epoch without aborting the turn, so every reply of this
      // turn (streamed chunks and later tool-round replies) is dropped once the epoch is stale.
      const speakForThisTurn = async (text: string, speechTextContext?: SpeechTextContext) => {
        if (params.signal?.aborted || speechFailed) return;
        if (!params.playbackController.isEpochCurrent(playbackEpoch)) return;
        const spoken = await speakAssistantText({
          text,
          speechTextContext,
          settings,
          networkTimeoutMs,
          registerPlaybackStopper: params.playbackController.registerStopper,
          onSpeaking: () => patchLocalVoiceState({ status: 'speaking' }),
        });
        if (!spoken) speechFailed = true;
      };

      const queueSpokenChunk = (chunkText: string) => {
        if (params.signal?.aborted) return;
        const trimmed = chunkText.trim();
        if (!trimmed) return;
        queuedChunkCount += 1;
        chunkPlaybackQueue = chunkPlaybackQueue.then(() => speakForThisTurn(trimmed, streamingSpeechTextContext));
      };

      const sendOptions = chunker
        ? {
            onTextDelta: (textDelta: string) => {
              if (params.signal?.aborted) return;
              const nextChunks = chunker.push(textDelta);
              nextChunks.forEach((chunk) => queueSpokenChunk(chunk));
            },
            signal: params.signal,
          }
        : params.signal
          ? { signal: params.signal }
          : undefined;

      const speakAssistantReply = async (assistantText: string, turnIndex: number) => {
        if (!autoSpeak || !assistantText.trim()) return;
        if (turnIndex === 0 && chunker) {
          chunker.flush().forEach((chunk) => queueSpokenChunk(chunk));
          if (queuedChunkCount === 0) {
            queueSpokenChunk(assistantText);
          }
          await chunkPlaybackQueue;
          return;
        }

        throwIfAborted();
        await speakForThisTurn(assistantText);
      };

      await runVoiceAgentTurnWithTools({
        sessionId,
        userText,
        durableLocalId,
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
          voiceActivityController.appendAssistantText(sessionId, adapterId, assistantText);
          if (syntheticConversationSessionId) {
            appendVoiceConversationAssistantText({
              conversationSessionId: syntheticConversationSessionId,
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
      // An aborted turn hands state back to whoever aborted it (cancel or hang-up).
      if (isTurnAbortedError(error) || params.signal?.aborted) return;
      voiceActivityController.appendError(sessionId, adapterId, 'voice_agent_send_failed', error instanceof Error ? error.message : 'send_failed');
      patchLocalVoiceState({ status: 'idle', sessionId, ...resolveLocalVoiceError(error, 'send_failed') });
      throw error instanceof Error ? error : new Error('send_failed');
    } finally {
      if (!params.signal?.aborted) setIdleStateUnlessRecording(sessionId);
    }
  }

  const baseline = captureSessionTurnBaseline(sessionId);
  let submittedUserLocalId: string | undefined;

  patchLocalVoiceState({ status: 'sending' });
  try {
    const submission = await sync.submitMessage(sessionId, userText, undefined, undefined, {
      callerSurface: 'voice_turn',
      forceImmediate: true,
    });
    submittedUserLocalId = submission?.localId;
    voiceActivityController.appendActionExecuted(sessionId, adapterId, 'unknown', `Sent to session: ${userText.slice(0, 200)}`);
  } catch (error) {
    voiceActivityController.appendError(sessionId, adapterId, 'send_failed', error instanceof Error ? error.message : 'send_failed');
    patchLocalVoiceState({ status: 'idle', sessionId, ...resolveLocalVoiceError(error, 'send_failed') });
    throw error;
  }

  const autoSpeak = config?.tts?.autoSpeakReplies !== false;
  if (!autoSpeak) {
    patchLocalVoiceState({ status: 'idle', sessionId, error: null });
    return;
  }

  // Speak the final reply of the turn admitting this message; the wait is bounded by the session's
  // turn lifecycle and by the voice turn's abort signal (cancel / hang-up), not by a fixed timeout.
  const assistantText = await waitForTurnFinalAssistantText({ sessionId, baseline, signal: params.signal, submittedUserLocalId });
  if (params.signal?.aborted) return;
  if (!assistantText) {
    patchLocalVoiceState({ status: 'idle', sessionId, error: null });
    return;
  }

  await speakAssistantText({
    text: assistantText,
    settings,
    networkTimeoutMs,
    registerPlaybackStopper: params.playbackController.registerStopper,
    onSpeaking: () => patchLocalVoiceState({ status: 'speaking' }),
  });
  if (params.signal?.aborted) return;
  setIdleStateUnlessRecording(sessionId);
}
