import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { createTtsChunker, resolveStreamingTtsChunkChars } from '@/voice/output/TtsChunker';
import { speakAssistantText } from '@/voice/output/speakAssistantText';
import { resolveVoiceNetworkTimeoutMs } from '@/voice/runtime/fetchWithTimeout';
import { waitForNextAssistantTextMessage } from '@/voice/runtime/waitForNextAssistantTextMessage';
import { voiceActivityController } from '@/voice/activity/voiceActivityController';
import { createVoiceToolHandlers } from '@/voice/tools/handlers';
import { resolveToolSessionId } from '@/voice/tools/resolveToolSessionId';

import { patchLocalVoiceState, setIdleStateUnlessRecording } from './localVoiceState';
import { resolveLocalVoiceAdapterSettings } from './localVoiceSettings';

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
}): Promise<void> {
  const { sessionId, settings, userText } = params;
  const { adapterId, config } = resolveLocalVoiceAdapterSettings(settings);
  const networkTimeoutMs = resolveVoiceNetworkTimeoutMs(config?.networkTimeoutMs, 15_000);
  const conversationMode =
    adapterId === 'local_conversation' ? ((config?.conversationMode ?? 'direct_session') as 'direct_session' | 'agent') : 'direct_session';

  voiceActivityController.appendUserText(sessionId, adapterId, userText);

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
      type VoiceToolAction = Readonly<{ t?: unknown; args?: unknown }>;
      type ToolResultEntry = Readonly<{
        t: string;
        args: unknown;
        result: unknown;
      }>;

      const parseToolResult = (value: string): unknown => {
        const trimmed = String(value ?? '').trim();
        if (!trimmed) return '';
        try {
          return JSON.parse(trimmed);
        } catch {
          return trimmed;
        }
      };

      const chunker = streamingSpeechEnabled ? createTtsChunker(streamingChunkChars) : null;
      const playbackEpoch = params.playbackController.captureEpoch();
      let queuedChunkCount = 0;
      let chunkPlaybackQueue: Promise<void> = Promise.resolve();

      const queueSpokenChunk = (chunkText: string) => {
        const trimmed = chunkText.trim();
        if (!trimmed) return;
        queuedChunkCount += 1;
        chunkPlaybackQueue = chunkPlaybackQueue
          .then(async () => {
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

      const { assistantText, actions: _actions } = await params.voiceAgentSessions.sendTurn(
        sessionId,
        userText,
        chunker
          ? {
              onTextDelta: (textDelta) => {
                const nextChunks = chunker.push(textDelta);
                nextChunks.forEach((chunk) => queueSpokenChunk(chunk));
              },
            }
          : undefined,
      );

      voiceActivityController.appendAssistantText(sessionId, adapterId, assistantText);

      const tools = createVoiceToolHandlers({
        resolveSessionId: (explicitSessionId) =>
          resolveToolSessionId({
            explicitSessionId,
            currentSessionId: null,
          }),
      });
      const canSpeak =
        autoSpeak &&
        (ttsProvider === 'device' ||
          ttsProvider === 'local_neural' ||
          (ttsProvider === 'openai_compat' && Boolean(openaiCompatBaseUrl)));

      const runActionsOnce = async (actions: ReadonlyArray<unknown>): Promise<ToolResultEntry[]> => {
        const results: ToolResultEntry[] = [];
        for (const actionRaw of actions) {
          const action = actionRaw as VoiceToolAction;
          const toolName = typeof action?.t === 'string' ? action.t.trim() : '';
          if (!toolName) continue;
          const handler = (tools as any)[toolName] as ((params: unknown) => Promise<string>) | undefined;
          if (typeof handler !== 'function') {
            results.push({
              t: toolName,
              args: action?.args ?? null,
              result: { ok: false, errorCode: 'tool_not_supported', errorMessage: 'tool_not_supported' },
            });
            continue;
          }
          try {
            const value = await handler(action?.args ?? null);
            results.push({ t: toolName, args: action?.args ?? null, result: parseToolResult(value) });
          } catch (error) {
            results.push({
              t: toolName,
              args: action?.args ?? null,
              result: {
                ok: false,
                errorCode: 'tool_failed',
                errorMessage: error instanceof Error ? error.message : 'tool_failed',
              },
            });
          }
        }
        return results;
      };

      const MAX_TOOL_ROUNDS = 3;
      const initialActions = _actions ?? [];
      const initialToolResults = await runActionsOnce(initialActions);

      if (!canSpeak) {
        // Even when autoSpeak is disabled, we still run a tool request/response loop so the agent can see outcomes.
        let toolResults = initialToolResults;
        for (let i = 0; i < MAX_TOOL_ROUNDS && toolResults.length > 0; i++) {
          const toolResultsMessage = `VOICE_TOOL_RESULTS_JSON:\n${JSON.stringify({ toolResults })}`;
          const followUp = await params.voiceAgentSessions.sendTurn(sessionId, toolResultsMessage);
          voiceActivityController.appendAssistantText(sessionId, adapterId, followUp.assistantText);
          toolResults = await runActionsOnce(followUp.actions ?? []);
        }
        return;
      }

      if (chunker) {
        chunker.flush().forEach((chunk) => queueSpokenChunk(chunk));
        if (queuedChunkCount === 0 && assistantText.trim().length > 0) {
          queueSpokenChunk(assistantText);
        }
        await chunkPlaybackQueue;
      } else {
        await speakAssistantText({
          text: assistantText,
          settings,
          networkTimeoutMs,
          registerPlaybackStopper: params.playbackController.registerStopper,
          onSpeaking: () => patchLocalVoiceState({ status: 'speaking' }),
        });
      }

      let toolResults = initialToolResults;
      for (let i = 0; i < MAX_TOOL_ROUNDS && toolResults.length > 0; i++) {
        const toolResultsMessage = `VOICE_TOOL_RESULTS_JSON:\n${JSON.stringify({ toolResults })}`;
        const followUp = await params.voiceAgentSessions.sendTurn(sessionId, toolResultsMessage);
        voiceActivityController.appendAssistantText(sessionId, adapterId, followUp.assistantText);
        if (followUp.assistantText.trim().length > 0) {
          await speakAssistantText({
            text: followUp.assistantText,
            settings,
            networkTimeoutMs,
            registerPlaybackStopper: params.playbackController.registerStopper,
            onSpeaking: () => patchLocalVoiceState({ status: 'speaking' }),
          });
        }
        toolResults = await runActionsOnce(followUp.actions ?? []);
      }

      return;
    } catch (error) {
      voiceActivityController.appendError(sessionId, adapterId, 'voice_agent_send_failed', error instanceof Error ? error.message : 'send_failed');
      patchLocalVoiceState({ status: 'idle', sessionId, error: 'send_failed' });
      return;
    } finally {
      setIdleStateUnlessRecording(sessionId);
    }
  }

  const baselineMessages = ((storage.getState() as any).sessionMessages?.[sessionId]?.messages ?? []) as any[];
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

  const assistantText = await waitForNextAssistantTextMessage(sessionId, baselineIds, baselineCount, 60_000);
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
  setIdleStateUnlessRecording(sessionId);
}

