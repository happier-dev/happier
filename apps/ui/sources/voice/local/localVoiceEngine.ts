import { AudioModule, RecordingPresets } from 'expo-audio';

import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/platform/microphonePermissions';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { storage } from '@/sync/domains/state/storage';
import { createDeviceSttController } from '@/voice/input/DeviceSttController';
import { createSherpaStreamingSttController } from '@/voice/input/SherpaStreamingSttController';
import { MissingGeminiApiKeyError, MissingSttBaseUrlError, transcribeRecordedAudioWithProvider } from '@/voice/input/transcribeRecordedAudioWithProvider';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { findVoiceCarrierSessionId } from '@/voice/agent/voiceCarrierSession';
import { voiceAgentSessions } from '@/voice/agent/voiceAgentSessions';
import { speakAssistantText } from '@/voice/output/speakAssistantText';
import { resolveVoiceNetworkTimeoutMs } from '@/voice/runtime/fetchWithTimeout';
import { createVoicePlaybackController } from '@/voice/runtime/VoicePlaybackController';
import { voiceActivityController } from '@/voice/activity/voiceActivityController';
import { clearVoiceAgentRunMetadataFromCarrierSession } from '@/voice/persistence/voiceAgentRunMetadata';

import type { LocalVoiceState, LocalVoiceStatus } from './localVoiceState';
import {
  getLocalVoiceState,
  patchLocalVoiceState,
} from './localVoiceState';
import {
  isHandsFreeDeviceSttEnabled,
  isHandsFreeLocalNeuralSttEnabled,
  isVoiceBargeInEnabled,
  resolveLocalSttProvider,
  resolveLocalVoiceAdapterSettings,
} from './localVoiceSettings';
import { sendVoiceTextTurn as sendVoiceTextTurnImpl } from './sendVoiceTextTurn';

export type { LocalVoiceState, LocalVoiceStatus } from './localVoiceState';
export { getLocalVoiceState, useLocalVoiceStatus, subscribeLocalVoiceState } from './localVoiceState';

let recorder: InstanceType<typeof AudioModule.AudioRecorder> | null = null;
let inFlight: Promise<void> | null = null;

const playbackController = createVoicePlaybackController();
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

  await sendVoiceTextTurnImpl({
    sessionId,
    settings,
    userText: text,
    playbackController,
    voiceAgentSessions,
  });
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
  await sendVoiceTextTurnImpl({
    sessionId,
    settings,
    userText: text,
    playbackController,
    voiceAgentSessions,
  });

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
  await sendVoiceTextTurnImpl({
    sessionId,
    settings,
    userText: text,
    playbackController,
    voiceAgentSessions,
  });

  if (sherpaSttController.isHandsFreeSession(sessionId) && isHandsFreeLocalNeuralSttEnabled(storage.getState().settings)) {
    await sherpaSttController.start(sessionId);
  }
}

export async function stopLocalVoiceAgent(sessionId: string): Promise<void> {
  deviceSttController.clearHandsFreeSession(sessionId);
  sherpaSttController.clearHandsFreeSession(sessionId);
  await voiceAgentSessions.stop(sessionId);
}

export async function resetLocalVoiceAgentPersistence(): Promise<void> {
  await stopLocalVoiceAgent(VOICE_AGENT_GLOBAL_SESSION_ID);
  voiceActivityController.clearSession(VOICE_AGENT_GLOBAL_SESSION_ID);
  const carrierSessionId = findVoiceCarrierSessionId(storage.getState() as any);
  if (carrierSessionId) {
    await clearVoiceAgentRunMetadataFromCarrierSession({ carrierSessionId }).catch(() => {});
  }
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

	  const prewarmLocalVoiceAgentOnConnect = (params: Readonly<{ settings: any; config: any }>): void => {
	    const { config } = params;
	    if (config?.conversationMode !== 'agent' || config?.agent?.prewarmOnConnect !== true) return;

	    fireAndForget((async () => {
	      const networkTimeoutMs = resolveVoiceNetworkTimeoutMs(config?.networkTimeoutMs, 15_000);
	      const welcomeMode = config?.agent?.welcome?.mode === 'on_first_turn' ? 'on_first_turn' : 'immediate';
	      const welcomeEnabled = config?.agent?.welcome?.enabled === true;
	      const canSpeakWelcome = config?.tts?.autoSpeakReplies !== false;

      if (welcomeEnabled && welcomeMode === 'immediate' && canSpeakWelcome) {
        const assistantText = await voiceAgentSessions.ensureRunningAndMaybeWelcome(sessionId).catch(() => null);
        const text = typeof assistantText === 'string' ? assistantText.trim() : '';
        if (text) {
          voiceActivityController.appendAssistantText(sessionId, 'local_conversation', text);
          await speakAssistantText({
            text,
            settings: params.settings,
            networkTimeoutMs,
            registerPlaybackStopper: playbackController.registerStopper,
            onSpeaking: () => patchLocalVoiceState({ status: 'speaking' }),
          });
        }
        return;
      }

	      await voiceAgentSessions.ensureRunning(sessionId);
	    })(), { tag: 'localVoiceEngine.prewarmLocalVoiceAgentOnConnect' });
	  };

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
    prewarmLocalVoiceAgentOnConnect({ settings, config });
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
    prewarmLocalVoiceAgentOnConnect({ settings, config });
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
