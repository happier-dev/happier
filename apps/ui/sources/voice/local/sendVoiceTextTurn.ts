import { readStoredSessionMessages } from '@/sync/domains/messages/readStoredSessionMessages';
import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { createTtsChunker, resolveStreamingTtsChunkChars } from '@/voice/output/TtsChunker';
import { speakAssistantText } from '@/voice/output/speakAssistantText';
import { resolveVoiceNetworkTimeoutMs } from '@/voice/runtime/fetchWithTimeout';
import { waitForNextAssistantTextMessage } from '@/voice/runtime/waitForNextAssistantTextMessage';
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

import { patchLocalVoiceState, setIdleStateUnlessRecording } from './localVoiceState';
import { resolveLocalVoiceAdapterSettings } from './localVoiceSettings';
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
  const { sessionId, settings, userText } = params;
  const { adapterId, config } = resolveLocalVoiceAdapterSettings(settings);
  const networkTimeoutMs = resolveVoiceNetworkTimeoutMs(config?.networkTimeoutMs, 15_000);
  const conversationMode =
    adapterId === 'local_conversation' ? ((config?.conversationMode ?? 'direct_session') as 'direct_session' | 'agent') : 'direct_session';
  const sessionBinding =
    resolveVoiceSessionBindingByControlSessionId({ controlSessionId: sessionId })
    ?? resolveVoiceSessionBindingByConversationSessionId({ conversationSessionId: sessionId })
    ?? null;
  const syntheticTranscriptBinding = resolveVoiceSessionBindingByControlSessionId({ controlSessionId: sessionId });
  const syntheticConversationSessionId =
    syntheticTranscriptBinding?.transcriptMode === 'synthetic'
      ? syntheticTranscriptBinding.conversationSessionId
      : null;
  const currentToolSessionId =
    sessionBinding?.targetSessionId
    ?? (sessionId === VOICE_AGENT_GLOBAL_SESSION_ID ? null : sessionId);

  voiceActivityController.appendUserText(sessionId, adapterId, userText);
  if (syntheticConversationSessionId) {
    appendVoiceConversationUserText({
      conversationSessionId: syntheticConversationSessionId,
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
    const autoSpeak = config?.tts?.autoSpeakReplies !== false;
    const tts = config?.tts ?? null;
    const legacyUseDeviceTts = tts?.useDeviceTts === true;
    const legacyBaseUrl = typeof tts?.baseUrl === 'string' ? tts.baseUrl : null;
    const ttsProvider =
      typeof tts?.provider === 'string'
        ? tts.provider
        : legacyUseDeviceTts
          ? 'device'
          : legacyBaseUrl && legacyBaseUrl.trim().length > 0
            ? 'openai_compat'
            : 'openai_compat';
    const openaiCompatBaseUrl = String(tts?.openaiCompat?.baseUrl ?? legacyBaseUrl ?? '').trim();
    const streamingSpeechEnabled =
      autoSpeak &&
      config?.streaming?.enabled === true &&
      config?.streaming?.ttsEnabled === true &&
      (ttsProvider === 'device' ||
        ttsProvider === 'local_neural' ||
        (ttsProvider === 'openai_compat' && Boolean(openaiCompatBaseUrl)));
    const streamingChunkChars = resolveStreamingTtsChunkChars(config?.streaming?.ttsChunkChars);

    patchLocalVoiceState({ status: 'sending' });
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
              text: trimmed,
              settings,
              networkTimeoutMs,
              registerPlaybackStopper: params.playbackController.registerStopper,
              onSpeaking: () => patchLocalVoiceState({ status: 'speaking' }),
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
          text: assistantText,
          settings,
          networkTimeoutMs,
          registerPlaybackStopper: params.playbackController.registerStopper,
          onSpeaking: () => patchLocalVoiceState({ status: 'speaking' }),
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
      if (isTurnAbortedError(error) || params.signal?.aborted) {
        patchLocalVoiceState({ status: 'idle', sessionId, error: null });
        return;
      }
      voiceActivityController.appendError(sessionId, adapterId, 'voice_agent_send_failed', error instanceof Error ? error.message : 'send_failed');
      patchLocalVoiceState({ status: 'idle', sessionId, error: 'send_failed' });
      throw error instanceof Error ? error : new Error('send_failed');
    } finally {
      setIdleStateUnlessRecording(sessionId);
    }
  }

  const baselineMessages = readStoredSessionMessages(storage.getState(), sessionId) as any[];
  const baselineCount = baselineMessages.length;
  const baselineIds = new Set<string>(
    baselineMessages
      .map((message: any) => message?.id)
      .filter((messageId: any): messageId is string => typeof messageId === 'string'),
  );

  patchLocalVoiceState({ status: 'sending' });
  try {
    await sync.sendMessage(sessionId, userText);
    voiceActivityController.appendActionExecuted(sessionId, adapterId, 'unknown', `Sent to session: ${userText.slice(0, 200)}`);
  } catch (error) {
    voiceActivityController.appendError(sessionId, adapterId, 'send_failed', error instanceof Error ? error.message : 'send_failed');
    patchLocalVoiceState({ status: 'idle', sessionId, error: 'send_failed' });
    throw error;
  }

  const autoSpeak = config?.tts?.autoSpeakReplies !== false;
  if (!autoSpeak) {
    patchLocalVoiceState({ status: 'idle', sessionId, error: null });
    return;
  }

  const assistantText = await waitForNextAssistantTextMessage(sessionId, baselineIds, baselineCount, 60_000, params.signal);
  if (params.signal?.aborted) {
    patchLocalVoiceState({ status: 'idle', sessionId, error: null });
    return;
  }
  if (!assistantText) {
    patchLocalVoiceState({ status: 'idle', sessionId, error: null });
    return;
  }

  if (params.signal?.aborted) {
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
  setIdleStateUnlessRecording(sessionId);
}
