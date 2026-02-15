import { AudioModule, RecordingPresets } from 'expo-audio';

import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/platform/microphonePermissions';
import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { createDeviceSttController } from '@/voice/input/DeviceSttController';
import { createSherpaStreamingSttController } from '@/voice/input/SherpaStreamingSttController';
import { MissingGeminiApiKeyError, MissingSttBaseUrlError, transcribeRecordedAudioWithProvider } from '@/voice/input/transcribeRecordedAudioWithProvider';
import { createVoiceAgentSessionController } from '@/voice/agent/VoiceAgentSessionController';
import { speakAssistantText } from '@/voice/output/speakAssistantText';
import { createTtsChunker, resolveStreamingTtsChunkChars } from '@/voice/output/TtsChunker';
import { resolveVoiceNetworkTimeoutMs } from '@/voice/runtime/fetchWithTimeout';
import { createVoicePlaybackController } from '@/voice/runtime/VoicePlaybackController';
import { waitForNextAssistantTextMessage } from '@/voice/runtime/waitForNextAssistantTextMessage';
import { createVoiceToolHandlers } from '@/voice/tools/handlers';
import { resolveToolSessionId } from '@/voice/tools/resolveToolSessionId';
import { voiceActivityController } from '@/voice/activity/voiceActivityController';

import type { LocalVoiceState, LocalVoiceStatus } from './localVoiceState';
import {
  getLocalVoiceState,
  patchLocalVoiceState,
  setIdleStateUnlessRecording,
} from './localVoiceState';
import {
  isHandsFreeDeviceSttEnabled,
  isHandsFreeLocalNeuralSttEnabled,
  isVoiceBargeInEnabled,
  resolveLocalSttProvider,
  resolveLocalVoiceAdapterSettings,
} from './localVoiceSettings';

export type { LocalVoiceState, LocalVoiceStatus } from './localVoiceState';
export { getLocalVoiceState, useLocalVoiceStatus, subscribeLocalVoiceState } from './localVoiceState';

let recorder: InstanceType<typeof AudioModule.AudioRecorder> | null = null;
let inFlight: Promise<void> | null = null;

const playbackController = createVoicePlaybackController();
const voiceAgentSessions = createVoiceAgentSessionController();
const deviceSttController = createDeviceSttController({
  setState: patchLocalVoiceState,
  getSettings: () => storage.getState().settings as any,
  canAutoStopTurn: () => !inFlight,
  onAutoStopTurn: (sessionId: string) => {
    if (inFlight) return;
    inFlight = stopDeviceSpeechRecognitionAndSend(sessionId).finally(() => {
      inFlight = null;
    });
  },
});
const sherpaSttController = createSherpaStreamingSttController({
  setState: patchLocalVoiceState,
  getSettings: () => storage.getState().settings as any,
});

async function startRecording(sessionId: string): Promise<void> {
  const permission = await requestMicrophonePermission();
  if (!permission.granted) {
    showMicrophonePermissionDeniedAlert(permission.canAskAgain);
    return;
  }

  const nextRecorder = new AudioModule.AudioRecorder(RecordingPresets.HIGH_QUALITY);
  try {
    await nextRecorder.prepareToRecordAsync();
    nextRecorder.record();
    recorder = nextRecorder;
    patchLocalVoiceState({ status: 'recording', sessionId, error: null });
  } catch (error) {
    try {
      await nextRecorder.stop?.();
    } catch {
      // best-effort
    }
    recorder = null;
    patchLocalVoiceState({ status: 'idle', sessionId: null, error: 'recording_start_failed' });
    throw error;
  }
}

async function stopAndSendRecordedTurn(sessionId: string): Promise<void> {
  if (!recorder) {
    patchLocalVoiceState({ status: 'idle', sessionId, error: null });
    return;
  }

  patchLocalVoiceState({ status: 'transcribing', error: null });
  let uri: string | null = null;
  try {
    await recorder.stop();
    uri = recorder.uri;
  } catch {
    recorder = null;
    patchLocalVoiceState({ status: 'idle', sessionId, error: 'recording_stop_failed' });
    return;
  }
  recorder = null;

  if (!uri) {
    patchLocalVoiceState({ status: 'idle', sessionId, error: null });
    return;
  }

  const settings = storage.getState().settings as any;
  let text: string | null = null;
  try {
    text = await transcribeRecordedAudioWithProvider({ uri, settings });
  } catch (error) {
    if (error instanceof MissingSttBaseUrlError) {
      patchLocalVoiceState({ status: 'idle', sessionId, error: 'missing_stt_base_url' });
      throw error;
    }
    if (error instanceof MissingGeminiApiKeyError) {
      patchLocalVoiceState({ status: 'idle', sessionId, error: 'missing_stt_api_key' });
      throw error;
    }
    patchLocalVoiceState({ status: 'idle', sessionId, error: 'stt_failed' });
    return;
  }

  if (!text) {
    patchLocalVoiceState({ status: 'idle', sessionId, error: null });
    return;
  }

  await sendVoiceTextTurn(sessionId, settings, text);
}

async function stopDeviceSpeechRecognitionAndSend(sessionId: string): Promise<void> {
  patchLocalVoiceState({ status: 'transcribing', error: null });

  const text = await deviceSttController.stop(sessionId);
  if (!text) {
    if (deviceSttController.isHandsFreeSession(sessionId) && isHandsFreeDeviceSttEnabled(storage.getState().settings)) {
      await deviceSttController.start(sessionId);
      return;
    }
    patchLocalVoiceState({ status: 'idle', sessionId, error: null });
    return;
  }

  const settings = storage.getState().settings as any;
  await sendVoiceTextTurn(sessionId, settings, text);

  if (deviceSttController.isHandsFreeSession(sessionId) && isHandsFreeDeviceSttEnabled(storage.getState().settings)) {
    await deviceSttController.start(sessionId);
  }
}

async function stopSherpaSpeechRecognitionAndSend(sessionId: string): Promise<void> {
  patchLocalVoiceState({ status: 'transcribing', error: null });

  const text = await sherpaSttController.stop(sessionId);
  if (!text) {
    if (sherpaSttController.isHandsFreeSession(sessionId) && isHandsFreeLocalNeuralSttEnabled(storage.getState().settings)) {
      await sherpaSttController.start(sessionId);
      return;
    }
    patchLocalVoiceState({ status: 'idle', sessionId, error: null });
    return;
  }

  const settings = storage.getState().settings as any;
  await sendVoiceTextTurn(sessionId, settings, text);

  if (sherpaSttController.isHandsFreeSession(sessionId) && isHandsFreeLocalNeuralSttEnabled(storage.getState().settings)) {
    await sherpaSttController.start(sessionId);
  }
}

async function sendVoiceTextTurn(sessionId: string, settings: any, userText: string): Promise<void> {
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
      const playbackEpoch = playbackController.captureEpoch();
      let queuedChunkCount = 0;
      let chunkPlaybackQueue: Promise<void> = Promise.resolve();

      const queueSpokenChunk = (chunkText: string) => {
        const trimmed = chunkText.trim();
        if (!trimmed) return;
        queuedChunkCount += 1;
        chunkPlaybackQueue = chunkPlaybackQueue
          .then(async () => {
            if (!playbackController.isEpochCurrent(playbackEpoch)) return;
            await speakAssistantText({
              text: trimmed,
              settings,
              networkTimeoutMs,
              registerPlaybackStopper: playbackController.registerStopper,
              onSpeaking: () => patchLocalVoiceState({ status: 'speaking' }),
            });
          })
          .catch(() => {});
      };

      const { assistantText, actions: _actions } = await voiceAgentSessions.sendTurn(
        sessionId,
        userText,
        chunker
          ? {
              onTextDelta: (textDelta) => {
                const nextChunks = chunker.push(textDelta);
                nextChunks.forEach((chunk) => queueSpokenChunk(chunk));
              },
            }
          : undefined
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
          const followUp = await voiceAgentSessions.sendTurn(sessionId, toolResultsMessage);
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
          registerPlaybackStopper: playbackController.registerStopper,
          onSpeaking: () => patchLocalVoiceState({ status: 'speaking' }),
        });
      }

      let toolResults = initialToolResults;
      for (let i = 0; i < MAX_TOOL_ROUNDS && toolResults.length > 0; i++) {
        const toolResultsMessage = `VOICE_TOOL_RESULTS_JSON:\n${JSON.stringify({ toolResults })}`;
        const followUp = await voiceAgentSessions.sendTurn(sessionId, toolResultsMessage);
        voiceActivityController.appendAssistantText(sessionId, adapterId, followUp.assistantText);
        if (followUp.assistantText.trim().length > 0) {
          await speakAssistantText({
            text: followUp.assistantText,
            settings,
            networkTimeoutMs,
            registerPlaybackStopper: playbackController.registerStopper,
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
      .filter((messageId: any): messageId is string => typeof messageId === 'string')
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
    registerPlaybackStopper: playbackController.registerStopper,
    onSpeaking: () => patchLocalVoiceState({ status: 'speaking' }),
  });
  setIdleStateUnlessRecording(sessionId);
}

export async function stopLocalVoiceAgent(sessionId: string): Promise<void> {
  deviceSttController.clearHandsFreeSession(sessionId);
  sherpaSttController.clearHandsFreeSession(sessionId);
  await voiceAgentSessions.stop(sessionId);
}

export function isLocalVoiceAgentActive(sessionId: string): boolean {
  return voiceAgentSessions.isActive(sessionId);
}

export function appendLocalVoiceAgentContextUpdate(sessionId: string, update: string): void {
  voiceAgentSessions.appendContextUpdate(sessionId, update);
}

export async function toggleLocalVoiceTurn(sessionId: string): Promise<void> {
  const realtimeStatus = (storage.getState() as any)?.realtimeStatus;
  if (realtimeStatus === 'connected' || realtimeStatus === 'connecting') {
    // Avoid audio-session conflicts: local voice should not start while a realtime call is active.
    return;
  }

  const initialState = getLocalVoiceState();
  const canAttemptBargeIn =
    initialState.status === 'speaking' && initialState.sessionId === sessionId && isVoiceBargeInEnabled(storage.getState().settings);
  const shouldNoopWhileSpeaking =
    initialState.status === 'speaking' && initialState.sessionId === sessionId && !isVoiceBargeInEnabled(storage.getState().settings);

  if (shouldNoopWhileSpeaking) {
    return;
  }

  if (inFlight && !canAttemptBargeIn) {
    await inFlight;
  }

  const current = getLocalVoiceState();

  if (current.status === 'speaking') {
    if (current.sessionId !== sessionId) {
      return;
    }

    if (!isVoiceBargeInEnabled(storage.getState().settings)) {
      return;
    }

    playbackController.interrupt();
    if (inFlight) {
      await inFlight.catch(() => {});
    }

    const settings = storage.getState().settings as any;
    const { config } = resolveLocalVoiceAdapterSettings(settings);
    const sttProvider = resolveLocalSttProvider(settings);
    const useDeviceStt = sttProvider === 'device';
    const useSherpaStt = sttProvider === 'local_neural';
    deviceSttController.setHandsFreeSession(useDeviceStt && config?.handsFree?.enabled === true ? sessionId : null);
    sherpaSttController.setHandsFreeSession(useSherpaStt && config?.handsFree?.enabled === true ? sessionId : null);
    inFlight = (useDeviceStt ? deviceSttController.start(sessionId) : useSherpaStt ? sherpaSttController.start(sessionId) : startRecording(sessionId)).finally(() => {
      inFlight = null;
    });
    await inFlight;
    return;
  }

  if (current.status === 'idle') {
    const settings = storage.getState().settings as any;
    const { config } = resolveLocalVoiceAdapterSettings(settings);
    const sttProvider = resolveLocalSttProvider(settings);
    const useDeviceStt = sttProvider === 'device';
    const useSherpaStt = sttProvider === 'local_neural';
    deviceSttController.setHandsFreeSession(useDeviceStt && config?.handsFree?.enabled === true ? sessionId : null);
    sherpaSttController.setHandsFreeSession(useSherpaStt && config?.handsFree?.enabled === true ? sessionId : null);
    inFlight = (useDeviceStt ? deviceSttController.start(sessionId) : useSherpaStt ? sherpaSttController.start(sessionId) : startRecording(sessionId)).finally(() => {
      inFlight = null;
    });
    await inFlight;
    return;
  }

  if (current.status === 'recording') {
    if (current.sessionId !== sessionId) {
      return;
    }

    const settings = storage.getState().settings as any;
    const { config } = resolveLocalVoiceAdapterSettings(settings);
    const sttProvider = resolveLocalSttProvider(settings);
    const useDeviceStt = sttProvider === 'device';
    const useSherpaStt = sttProvider === 'local_neural';
    if (useDeviceStt) {
      deviceSttController.clearHandsFreeSession();
    }

    if (useSherpaStt) {
      sherpaSttController.clearHandsFreeSession();
    }

    inFlight = (useDeviceStt
      ? stopDeviceSpeechRecognitionAndSend(sessionId)
      : useSherpaStt
        ? stopSherpaSpeechRecognitionAndSend(sessionId)
        : stopAndSendRecordedTurn(sessionId)).finally(() => {
      inFlight = null;
    });
    await inFlight;
  }
}

export async function stopLocalVoiceSession(): Promise<void> {
  const current = getLocalVoiceState();
  if (!current.sessionId) return;

  playbackController.interrupt();

  const activeSessionId = current.sessionId;

  // Best-effort stop any recording (we intentionally do not send).
  if (recorder) {
    try {
      await recorder.stop();
    } catch {
      // ignore
    }
    recorder = null;
  }

  if (typeof activeSessionId === 'string' && activeSessionId.trim().length > 0) {
    try {
      await deviceSttController.stop(activeSessionId);
    } catch {
      // ignore
    }
    deviceSttController.clearHandsFreeSession(activeSessionId);

    try {
      await sherpaSttController.stop(activeSessionId);
    } catch {
      // ignore
    }
    sherpaSttController.clearHandsFreeSession(activeSessionId);

    try {
      await voiceAgentSessions.stop(activeSessionId);
    } catch {
      // ignore
    }
  } else {
    deviceSttController.clearHandsFreeSession();
    sherpaSttController.clearHandsFreeSession();
  }

  patchLocalVoiceState({ status: 'idle', sessionId: null, error: null });
}
