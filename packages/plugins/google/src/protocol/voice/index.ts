import { z } from 'zod';
import type { VoiceSpeechEngineDescriptorV1 } from '@happier-dev/protocol';
import {
  DAEMON_VOICE_OPENAI_COMPAT_TRANSFER_CHUNK_MAX_BYTES,
  DaemonVoiceOpenAiCompatDownloadAbortRequestSchema,
  DaemonVoiceOpenAiCompatDownloadAbortResponseSchema,
  DaemonVoiceOpenAiCompatDownloadChunkRequestSchema,
  DaemonVoiceOpenAiCompatDownloadChunkResponseSchema,
  DaemonVoiceOpenAiCompatDownloadFinalizeRequestSchema,
  DaemonVoiceOpenAiCompatDownloadFinalizeResponseSchema,
  DaemonVoiceOpenAiCompatTranscribeUploadAbortRequestSchema,
  DaemonVoiceOpenAiCompatTranscribeUploadAbortResponseSchema,
  DaemonVoiceOpenAiCompatTranscribeUploadChunkRequestSchema,
  DaemonVoiceOpenAiCompatTranscribeUploadChunkResponseSchema,
  DaemonVoiceOpenAiCompatTranscribeUploadFinalizeRequestSchema,
  DaemonVoiceOpenAiCompatTranscribeUploadFinalizeResponseSchema,
  DaemonVoiceOpenAiCompatTranscribeUploadInitRequestSchema,
  DaemonVoiceOpenAiCompatTranscribeUploadInitResponseSchema,
} from '@happier-dev/protocol';

export {
  GOOGLE_CLOUD_TTS_SETTINGS_DEFAULTS,
  GOOGLE_GEMINI_STT_SETTINGS_DEFAULTS,
  GoogleCloudTtsSettingsLegacySchema,
  GoogleCloudTtsSettingsSchema,
  GoogleGeminiSttSettingsLegacySchema,
  GoogleGeminiSttSettingsSchema,
  type GoogleCloudTtsSettingsLegacy,
  type GoogleCloudTtsSettings,
  type GoogleGeminiSttSettingsLegacy,
  type GoogleGeminiSttSettings,
} from './settings.js';

export const GOOGLE_GEMINI_STT_PROVIDER_ID = 'google_gemini' as const;
export const GOOGLE_CLOUD_TTS_PROVIDER_ID = 'google_cloud' as const;
export const GOOGLE_VOICE_CREDENTIAL_KIND = 'api_key' as const;
export const GOOGLE_VOICE_TRANSFER_CHUNK_MAX_BYTES = DAEMON_VOICE_OPENAI_COMPAT_TRANSFER_CHUNK_MAX_BYTES;

export function classifyGoogleCloudLegacyCredential(value: Readonly<{
  androidCertSha1?: string | null;
}>): 'importable' | 'needs_machine_credential' {
  return typeof value.androidCertSha1 === 'string' && value.androidCertSha1.trim().length > 0
    ? 'needs_machine_credential'
    : 'importable';
}

export const GoogleVoiceAudioMimeTypeSchema = z.enum(['audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/webm', 'audio/ogg']);
export const GoogleGeminiTranscribeRequestSchema = z.object({
  requestId: z.string().trim().min(1).max(128),
  model: z.string().trim().min(1).max(256),
  language: z.string().trim().min(1).max(64).nullable(),
  mimeType: GoogleVoiceAudioMimeTypeSchema,
  uploadId: z.string().trim().min(1).max(128),
}).strict();
export type GoogleGeminiTranscribeRequest = z.infer<typeof GoogleGeminiTranscribeRequestSchema>;
export const GoogleGeminiTranscribeResponseSchema = z.union([
  z.object({ ok: z.literal(true), requestId: z.string().min(1).max(128), text: z.string().max(1_000_000) }).strict(),
  z.object({ ok: z.literal(false), errorCode: z.enum(['invalid_parameters', 'credential_unavailable', 'request_timeout', 'cancelled', 'provider_response_invalid', 'internal_error']) }).strict(),
]);

export const GoogleCloudSynthesizeRequestSchema = z.object({
  requestId: z.string().trim().min(1).max(128),
  input: z.string().min(1).max(20_000),
  voiceName: z.string().trim().min(1).max(256),
  languageCode: z.string().trim().min(1).max(64).nullable(),
  format: z.enum(['mp3', 'wav']),
  speakingRate: z.number().min(0.25).max(4).nullable(),
  pitch: z.number().min(-20).max(20).nullable(),
  recipientPublicKeyBase64: z.string().min(1).max(64 * 1024),
}).strict();
export type GoogleCloudSynthesizeRequest = z.infer<typeof GoogleCloudSynthesizeRequestSchema>;
export const GoogleCloudSynthesizeResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    requestId: z.string().min(1).max(128),
    downloadId: z.string().min(1).max(128),
    chunkSizeBytes: z.number().int().positive(),
    sizeBytes: z.number().int().positive().max(32 * 1024 * 1024),
    mimeType: z.enum(['audio/mpeg', 'audio/wav']),
  }).strict(),
  z.object({ ok: z.literal(false), errorCode: z.enum(['invalid_parameters', 'credential_unavailable', 'request_timeout', 'cancelled', 'provider_response_invalid', 'internal_error']) }).strict(),
]);

export const GoogleVoiceTranscribeUploadInitRequestSchema = DaemonVoiceOpenAiCompatTranscribeUploadInitRequestSchema;
export const GoogleVoiceTranscribeUploadInitResponseSchema = DaemonVoiceOpenAiCompatTranscribeUploadInitResponseSchema;
export const GoogleVoiceTranscribeUploadChunkRequestSchema = DaemonVoiceOpenAiCompatTranscribeUploadChunkRequestSchema;
export const GoogleVoiceTranscribeUploadChunkResponseSchema = DaemonVoiceOpenAiCompatTranscribeUploadChunkResponseSchema;
export const GoogleVoiceTranscribeUploadFinalizeRequestSchema = DaemonVoiceOpenAiCompatTranscribeUploadFinalizeRequestSchema;
export const GoogleVoiceTranscribeUploadFinalizeResponseSchema = DaemonVoiceOpenAiCompatTranscribeUploadFinalizeResponseSchema;
export const GoogleVoiceTranscribeUploadAbortRequestSchema = DaemonVoiceOpenAiCompatTranscribeUploadAbortRequestSchema;
export const GoogleVoiceTranscribeUploadAbortResponseSchema = DaemonVoiceOpenAiCompatTranscribeUploadAbortResponseSchema;
export const GoogleVoiceDownloadChunkRequestSchema = DaemonVoiceOpenAiCompatDownloadChunkRequestSchema;
export const GoogleVoiceDownloadChunkResponseSchema = DaemonVoiceOpenAiCompatDownloadChunkResponseSchema;
export const GoogleVoiceDownloadFinalizeRequestSchema = DaemonVoiceOpenAiCompatDownloadFinalizeRequestSchema;
export const GoogleVoiceDownloadFinalizeResponseSchema = DaemonVoiceOpenAiCompatDownloadFinalizeResponseSchema;
export const GoogleVoiceDownloadAbortRequestSchema = DaemonVoiceOpenAiCompatDownloadAbortRequestSchema;
export const GoogleVoiceDownloadAbortResponseSchema = DaemonVoiceOpenAiCompatDownloadAbortResponseSchema;

export type GoogleVoiceUiEntry = VoiceSpeechEngineDescriptorV1 & Readonly<{
  pluginId: 'happier.voice.google';
  providerId: 'google_gemini' | 'google_cloud';
}>;
