import type { GoogleVoiceUiEntry } from '../../protocol/voice/index.js';
import type {
  BundledVoiceSpeechEngineUiEntry,
  BundledVoiceUiEntry,
} from '@happier-dev/bundled-voice-runtime-contract';
import {
  GoogleCloudSynthesizeResponseSchema,
  GoogleGeminiTranscribeResponseSchema,
} from '../../protocol/voice/index.js';
import { createGoogleVoiceSettingsSpec } from './settings.js';

const GOOGLE_UI_INTERNAL: BundledVoiceSpeechEngineUiEntry['internal'] = Object.freeze({
  createSettingsSpec: createGoogleVoiceSettingsSpec,
  speechTarget: Object.freeze({ localId: 'speech' }),
  schemas: Object.freeze({
    synthesizeResponse: GoogleCloudSynthesizeResponseSchema,
    transcribeResponse: GoogleGeminiTranscribeResponseSchema,
  }),
});

type GoogleVoiceUiRuntimeEntry = GoogleVoiceUiEntry
  & Omit<BundledVoiceSpeechEngineUiEntry, 'internal'>
  & Readonly<{
  internal: BundledVoiceSpeechEngineUiEntry['internal'];
  }>;

export const BUNDLED_VOICE_UI_ENTRIES: readonly GoogleVoiceUiRuntimeEntry[] = Object.freeze([
  Object.freeze({
    kind: 'voice.speech-engine.v1',
    pluginId: 'happier.voice.google',
    providerId: 'google_gemini',
    role: 'stt',
    settingsSectionId: 'voice.stt.google_gemini',
    roles: ['dictation_stt', 'conversation_stt'],
    requirements: ['execution_machine', 'credential', 'runtime'],
    internal: GOOGLE_UI_INTERNAL,
  } satisfies GoogleVoiceUiRuntimeEntry),
  Object.freeze({
    kind: 'voice.speech-engine.v1',
    pluginId: 'happier.voice.google',
    providerId: 'google_cloud',
    role: 'tts',
    settingsSectionId: 'voice.tts.google_cloud',
    roles: ['conversation_tts'],
    requirements: ['execution_machine', 'credential', 'runtime'],
    internal: GOOGLE_UI_INTERNAL,
  } satisfies GoogleVoiceUiRuntimeEntry),
]) satisfies readonly BundledVoiceUiEntry[];
