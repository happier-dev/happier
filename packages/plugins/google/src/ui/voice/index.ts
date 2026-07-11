import type { GoogleVoiceUiEntry } from '../../protocol/voice/index.js';
import {
  classifyGoogleCloudLegacyCredential,
  GoogleCloudSynthesizeRequestSchema,
  GoogleCloudSynthesizeResponseSchema,
  GoogleGeminiTranscribeResponseSchema,
  GoogleVoiceDownloadAbortResponseSchema,
  GoogleVoiceDownloadChunkResponseSchema,
  GoogleVoiceDownloadFinalizeResponseSchema,
  GoogleVoiceTranscribeUploadAbortResponseSchema,
  GoogleVoiceTranscribeUploadChunkResponseSchema,
  GoogleVoiceTranscribeUploadFinalizeResponseSchema,
  GoogleVoiceTranscribeUploadInitResponseSchema,
} from '../../protocol/voice/index.js';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createGoogleVoiceSettingsSpec } from './settings.js';

const GOOGLE_UI_INTERNAL = Object.freeze({
  classifyLegacyCredential: classifyGoogleCloudLegacyCredential,
  createSettingsSpec: createGoogleVoiceSettingsSpec,
  speechClient: Object.freeze({
    credentialKind: 'api_key' as const,
    validationCatalogByProvider: Object.freeze({
      google_gemini: 'models' as const,
      google_cloud: 'voices' as const,
    }),
    methods: Object.freeze({
      credentialStatus: RPC_METHODS.DAEMON_VOICE_CREDENTIAL_STATUS,
      credentialStore: RPC_METHODS.DAEMON_VOICE_CREDENTIAL_STORE,
      credentialDelete: RPC_METHODS.DAEMON_VOICE_CREDENTIAL_DELETE,
      catalog: RPC_METHODS.DAEMON_VOICE_CREDENTIAL_PROVIDER_CATALOG,
      transcribeUploadInit: RPC_METHODS.DAEMON_VOICE_GOOGLE_TRANSCRIBE_UPLOAD_INIT,
      transcribeUploadChunk: RPC_METHODS.DAEMON_VOICE_GOOGLE_TRANSCRIBE_UPLOAD_CHUNK,
      transcribeUploadFinalize: RPC_METHODS.DAEMON_VOICE_GOOGLE_TRANSCRIBE_UPLOAD_FINALIZE,
      transcribeUploadAbort: RPC_METHODS.DAEMON_VOICE_GOOGLE_TRANSCRIBE_UPLOAD_ABORT,
      transcribe: RPC_METHODS.DAEMON_VOICE_GOOGLE_TRANSCRIBE,
      synthesize: RPC_METHODS.DAEMON_VOICE_GOOGLE_SYNTHESIZE,
      downloadChunk: RPC_METHODS.DAEMON_VOICE_GOOGLE_DOWNLOAD_CHUNK,
      downloadFinalize: RPC_METHODS.DAEMON_VOICE_GOOGLE_DOWNLOAD_FINALIZE,
      downloadAbort: RPC_METHODS.DAEMON_VOICE_GOOGLE_DOWNLOAD_ABORT,
    }),
  }),
  schemas: Object.freeze({
    synthesizeRequest: GoogleCloudSynthesizeRequestSchema,
    synthesizeResponse: GoogleCloudSynthesizeResponseSchema,
    transcribeResponse: GoogleGeminiTranscribeResponseSchema,
    uploadInitResponse: GoogleVoiceTranscribeUploadInitResponseSchema,
    uploadChunkResponse: GoogleVoiceTranscribeUploadChunkResponseSchema,
    uploadFinalizeResponse: GoogleVoiceTranscribeUploadFinalizeResponseSchema,
    uploadAbortResponse: GoogleVoiceTranscribeUploadAbortResponseSchema,
    downloadChunkResponse: GoogleVoiceDownloadChunkResponseSchema,
    downloadFinalizeResponse: GoogleVoiceDownloadFinalizeResponseSchema,
    downloadAbortResponse: GoogleVoiceDownloadAbortResponseSchema,
  }),
});

type GoogleVoiceUiRuntimeEntry = GoogleVoiceUiEntry & Readonly<{
  internal: typeof GOOGLE_UI_INTERNAL;
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
]);
