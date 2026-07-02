import { readStoredSessionMessages } from '@/sync/domains/messages/readStoredSessionMessages';
import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { createTtsChunker, resolveStreamingTtsChunkChars } from '@/voice/output/TtsChunker';
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

    voiceConversationRuntimeMachine.transitionToSending({ controlSessionId: sessionId });
    try {
      throwIfAborted();
      const chunker = streamingSpeechEnabled ? createTtsChunker(streamingChunkChars) : null;
      const playbackEpoch = params.playbackController.captureEpoch();
      let queuedChunkCount = 0;
      let chunkPlaybackQueue: Promise<void> = Promise.resolve();

      const queueSpokenChunk = (chunkText: string) => {
        if (params.signal?.aborted) return;
        const trimmed = chunkText.trim();
        if (!trimmed) return;
        queuedChunkCount += 1;
        chunkPlaybackQueue = chunkPlaybackQueue
          .then(async () => {
            if (params.signal?.aborted) return;
            if (!params.playbackController.isEpochCurrent(playbackEpoch)) return;
            await speakAssistantText({
              sessionId,
              text: trimmed,
              settings,
              networkTimeoutMs,
              registerPlaybackStopper: params.playbackController.registerStopper,
              onSpeaking: () => voiceConversationRuntimeMachine.transitionToSpeaking({ controlSessionId: sessionId }),
            });
          })
          .catch(() => {});
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
          await chunkPlaybackQueue;
          return;
        }

        throwIfAborted();
        await speakAssistantText({
          sessionId,
          text: assistantText,
          settings,
          networkTimeoutMs,
          registerPlaybackStopper: params.playbackController.registerStopper,
          onSpeaking: () => voiceConversationRuntimeMachine.transitionToSpeaking({ controlSessionId: sessionId }),
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

  voiceConversationRuntimeMachine.transitionToSending({ controlSessionId: sessionId });
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
  await speakAssistantText({
    sessionId,
    text: assistantText,
    settings,
    networkTimeoutMs,
    registerPlaybackStopper: params.playbackController.registerStopper,
    onSpeaking: () => voiceConversationRuntimeMachine.transitionToSpeaking({ controlSessionId: sessionId }),
  });
  if (voiceConversationRuntimeMachine.getSnapshot().state !== 'listening') {
    transitionVoiceRuntimeToIdleIfCurrent({ controlSessionId: sessionId });
  }
}
