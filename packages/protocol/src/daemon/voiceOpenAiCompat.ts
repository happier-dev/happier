import { z } from 'zod';

import { TransferSessionIdSchema } from '../transfers/sessions/index.js';
import { DaemonVoiceCredentialKindSchema } from './voiceCredentials.js';

export const DAEMON_VOICE_OPENAI_COMPAT_AUDIO_MAX_BYTES = 8 * 1024 * 1024;
export const DAEMON_VOICE_OPENAI_COMPAT_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
export const DAEMON_VOICE_OPENAI_COMPAT_REQUEST_ID_MAX_LENGTH = 128;
const TRANSFER_CHUNK_ENCODED_MAX_LENGTH = 4 * 1024 * 1024;
const TRANSFER_KEY_ENVELOPE_MAX_LENGTH = 64 * 1024;

const RequestIdSchema = z.string().min(1).max(DAEMON_VOICE_OPENAI_COMPAT_REQUEST_ID_MAX_LENGTH);
const AudioInputMimeTypeSchema = z.enum(['audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/webm', 'audio/ogg']);
const AudioOutputMimeTypeSchema = z.enum([
  'audio/wav',
  'audio/mpeg',
  'audio/ogg',
  'audio/aac',
  'audio/flac',
  'audio/l16',
  'application/octet-stream',
]);

export const DaemonVoiceOpenAiCompatErrorCodeSchema = z.enum([
  'invalid_parameters',
  'credential_unavailable',
  'endpoint_invalid',
  'endpoint_consent_required',
  'endpoint_unsafe',
  'redirect_forbidden',
  'request_timeout',
  'cancelled',
  'provider_error',
  'provider_response_invalid',
  'response_too_large',
  'unsupported_media_type',
  'internal_error',
]);
export type DaemonVoiceOpenAiCompatErrorCode = z.infer<typeof DaemonVoiceOpenAiCompatErrorCodeSchema>;
export const DaemonVoiceOpenAiCompatErrorSchema = z.object({
  ok: z.literal(false),
  errorCode: DaemonVoiceOpenAiCompatErrorCodeSchema,
  error: DaemonVoiceOpenAiCompatErrorCodeSchema,
  retryable: z.boolean(),
}).strict();
export type DaemonVoiceOpenAiCompatError = z.infer<typeof DaemonVoiceOpenAiCompatErrorSchema>;

export const DaemonVoiceOpenAiCompatConnectionSchema = z.object({
  baseUrl: z.string().trim().min(1).max(2_048),
  insecureLocalOriginConsent: z.string().trim().url().max(512).nullable(),
  credentialKind: DaemonVoiceCredentialKindSchema,
}).strict();
export type DaemonVoiceOpenAiCompatConnection = z.infer<typeof DaemonVoiceOpenAiCompatConnectionSchema>;

export const DaemonVoiceOpenAiCompatChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().max(100_000),
}).strict();
export const DaemonVoiceOpenAiCompatChatRequestSchema = DaemonVoiceOpenAiCompatConnectionSchema.extend({
  requestId: RequestIdSchema,
  model: z.string().trim().min(1).max(256),
  messages: z.array(DaemonVoiceOpenAiCompatChatMessageSchema).min(1).max(256),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().max(65_536).optional(),
}).strict().superRefine((request, context) => {
  const totalCharacters = request.messages.reduce((sum, message) => sum + message.content.length, 0);
  if (totalCharacters > 1_000_000) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Chat message content exceeds the aggregate limit.' });
  }
});
export type DaemonVoiceOpenAiCompatChatRequest = z.infer<typeof DaemonVoiceOpenAiCompatChatRequestSchema>;
export const DaemonVoiceOpenAiCompatChatResponseSchema = z.union([
  z.object({ ok: z.literal(true), text: z.string().max(1_000_000) }).strict(),
  DaemonVoiceOpenAiCompatErrorSchema,
]);
export type DaemonVoiceOpenAiCompatChatResponse = z.infer<typeof DaemonVoiceOpenAiCompatChatResponseSchema>;

export const DaemonVoiceOpenAiCompatModelsListRequestSchema = DaemonVoiceOpenAiCompatConnectionSchema;
export type DaemonVoiceOpenAiCompatModelsListRequest = z.infer<typeof DaemonVoiceOpenAiCompatModelsListRequestSchema>;
export const DaemonVoiceOpenAiCompatModelsListResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    models: z.array(z.object({ id: z.string().trim().min(1).max(256) }).strict()).max(2_000),
  }).strict(),
  DaemonVoiceOpenAiCompatErrorSchema,
]);
export type DaemonVoiceOpenAiCompatModelsListResponse = z.infer<typeof DaemonVoiceOpenAiCompatModelsListResponseSchema>;

const TransferErrorCodeSchema = z.enum([
  'invalid_parameters',
  'transfer_not_found',
  'transfer_failed',
  'cancelled',
]);
const TransferFailureSchema = z.object({
  success: z.literal(false),
  error: TransferErrorCodeSchema,
  errorCode: TransferErrorCodeSchema,
}).strict();
const TransferSuccessSchema = z.object({ success: z.literal(true) }).strict();

export const DaemonVoiceOpenAiCompatTranscribeUploadInitRequestSchema = z.object({
  sizeBytes: z.number().int().positive().max(DAEMON_VOICE_OPENAI_COMPAT_AUDIO_MAX_BYTES),
  mimeType: AudioInputMimeTypeSchema,
  fileName: z.string().trim().min(1).max(256).regex(/^[^/\\\u0000-\u001f\u007f]+$/u),
}).strict();
export type DaemonVoiceOpenAiCompatTranscribeUploadInitRequest = z.infer<typeof DaemonVoiceOpenAiCompatTranscribeUploadInitRequestSchema>;
export const DaemonVoiceOpenAiCompatTranscribeUploadInitResponseSchema = z.union([
  z.object({
    success: z.literal(true),
    uploadId: TransferSessionIdSchema,
    chunkSizeBytes: z.number().int().positive().max(DAEMON_VOICE_OPENAI_COMPAT_AUDIO_MAX_BYTES),
    recipientPublicKeyBase64: z.string().min(1).max(TRANSFER_KEY_ENVELOPE_MAX_LENGTH),
  }).strict(),
  TransferFailureSchema,
]);
export type DaemonVoiceOpenAiCompatTranscribeUploadInitResponse = z.infer<typeof DaemonVoiceOpenAiCompatTranscribeUploadInitResponseSchema>;

export const DaemonVoiceOpenAiCompatTranscribeUploadChunkRequestSchema = z.object({
  uploadId: TransferSessionIdSchema,
  index: z.number().int().min(0),
  payloadBase64: z.string().min(1).max(TRANSFER_CHUNK_ENCODED_MAX_LENGTH),
  encryptedDataKeyEnvelopeBase64: z.string().min(1).max(TRANSFER_KEY_ENVELOPE_MAX_LENGTH),
}).strict();
export type DaemonVoiceOpenAiCompatTranscribeUploadChunkRequest = z.infer<typeof DaemonVoiceOpenAiCompatTranscribeUploadChunkRequestSchema>;
export const DaemonVoiceOpenAiCompatTranscribeUploadChunkResponseSchema = z.union([TransferSuccessSchema, TransferFailureSchema]);
export type DaemonVoiceOpenAiCompatTranscribeUploadChunkResponse = z.infer<typeof DaemonVoiceOpenAiCompatTranscribeUploadChunkResponseSchema>;

export const DaemonVoiceOpenAiCompatTranscribeUploadFinalizeRequestSchema = z.object({ uploadId: TransferSessionIdSchema }).strict();
export type DaemonVoiceOpenAiCompatTranscribeUploadFinalizeRequest = z.infer<typeof DaemonVoiceOpenAiCompatTranscribeUploadFinalizeRequestSchema>;
export const DaemonVoiceOpenAiCompatTranscribeUploadFinalizeResponseSchema = z.union([
  z.object({
    success: z.literal(true),
    uploadId: TransferSessionIdSchema,
    sizeBytes: z.number().int().positive().max(DAEMON_VOICE_OPENAI_COMPAT_AUDIO_MAX_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict(),
  TransferFailureSchema,
]);
export type DaemonVoiceOpenAiCompatTranscribeUploadFinalizeResponse = z.infer<typeof DaemonVoiceOpenAiCompatTranscribeUploadFinalizeResponseSchema>;

export const DaemonVoiceOpenAiCompatTranscribeUploadAbortRequestSchema = z.object({ uploadId: TransferSessionIdSchema }).strict();
export type DaemonVoiceOpenAiCompatTranscribeUploadAbortRequest = z.infer<typeof DaemonVoiceOpenAiCompatTranscribeUploadAbortRequestSchema>;
export const DaemonVoiceOpenAiCompatTranscribeUploadAbortResponseSchema = z.union([TransferSuccessSchema, TransferFailureSchema]);
export type DaemonVoiceOpenAiCompatTranscribeUploadAbortResponse = z.infer<typeof DaemonVoiceOpenAiCompatTranscribeUploadAbortResponseSchema>;

export const DaemonVoiceOpenAiCompatTranscribeRequestSchema = DaemonVoiceOpenAiCompatConnectionSchema.extend({
  requestId: RequestIdSchema,
  model: z.string().trim().min(1).max(256),
  language: z.string().trim().min(1).max(64).optional(),
  prompt: z.string().max(8_000).optional(),
  uploadId: TransferSessionIdSchema,
}).strict();
export type DaemonVoiceOpenAiCompatTranscribeRequest = z.infer<typeof DaemonVoiceOpenAiCompatTranscribeRequestSchema>;
export const DaemonVoiceOpenAiCompatTranscribeResponseSchema = z.union([
  z.object({ ok: z.literal(true), text: z.string().max(1_000_000) }).strict(),
  DaemonVoiceOpenAiCompatErrorSchema,
]);
export type DaemonVoiceOpenAiCompatTranscribeResponse = z.infer<typeof DaemonVoiceOpenAiCompatTranscribeResponseSchema>;

export const DaemonVoiceOpenAiCompatSynthesizeRequestSchema = DaemonVoiceOpenAiCompatConnectionSchema.extend({
  requestId: RequestIdSchema,
  model: z.string().trim().min(1).max(256),
  voice: z.string().trim().min(1).max(256),
  text: z.string().min(1).max(200_000),
  speed: z.number().min(0.25).max(4).optional(),
  responseFormat: z.enum(['wav', 'mp3', 'opus', 'aac', 'flac', 'pcm']),
  recipientPublicKeyBase64: z.string().min(1).max(TRANSFER_KEY_ENVELOPE_MAX_LENGTH),
}).strict();
export type DaemonVoiceOpenAiCompatSynthesizeRequest = z.infer<typeof DaemonVoiceOpenAiCompatSynthesizeRequestSchema>;
export const DaemonVoiceOpenAiCompatSynthesizeResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    downloadId: TransferSessionIdSchema,
    chunkSizeBytes: z.number().int().positive().max(DAEMON_VOICE_OPENAI_COMPAT_RESPONSE_MAX_BYTES),
    sizeBytes: z.number().int().positive().max(DAEMON_VOICE_OPENAI_COMPAT_RESPONSE_MAX_BYTES),
    mimeType: AudioOutputMimeTypeSchema,
  }).strict(),
  DaemonVoiceOpenAiCompatErrorSchema,
]);
export type DaemonVoiceOpenAiCompatSynthesizeResponse = z.infer<typeof DaemonVoiceOpenAiCompatSynthesizeResponseSchema>;

export const DaemonVoiceOpenAiCompatDownloadChunkRequestSchema = z.object({
  downloadId: TransferSessionIdSchema,
  index: z.number().int().min(0),
}).strict();
export type DaemonVoiceOpenAiCompatDownloadChunkRequest = z.infer<typeof DaemonVoiceOpenAiCompatDownloadChunkRequestSchema>;
export const DaemonVoiceOpenAiCompatDownloadChunkResponseSchema = z.union([
  z.object({
    success: z.literal(true),
    payloadBase64: z.string().min(1).max(TRANSFER_CHUNK_ENCODED_MAX_LENGTH),
    encryptedDataKeyEnvelopeBase64: z.string().min(1).max(TRANSFER_KEY_ENVELOPE_MAX_LENGTH),
    isLast: z.boolean(),
  }).strict(),
  TransferFailureSchema,
]);
export type DaemonVoiceOpenAiCompatDownloadChunkResponse = z.infer<typeof DaemonVoiceOpenAiCompatDownloadChunkResponseSchema>;

export const DaemonVoiceOpenAiCompatDownloadFinalizeRequestSchema = z.object({ downloadId: TransferSessionIdSchema }).strict();
export type DaemonVoiceOpenAiCompatDownloadFinalizeRequest = z.infer<typeof DaemonVoiceOpenAiCompatDownloadFinalizeRequestSchema>;
export const DaemonVoiceOpenAiCompatDownloadFinalizeResponseSchema = z.union([TransferSuccessSchema, TransferFailureSchema]);
export type DaemonVoiceOpenAiCompatDownloadFinalizeResponse = z.infer<typeof DaemonVoiceOpenAiCompatDownloadFinalizeResponseSchema>;

export const DaemonVoiceOpenAiCompatDownloadAbortRequestSchema = z.object({ downloadId: TransferSessionIdSchema }).strict();
export type DaemonVoiceOpenAiCompatDownloadAbortRequest = z.infer<typeof DaemonVoiceOpenAiCompatDownloadAbortRequestSchema>;
export const DaemonVoiceOpenAiCompatDownloadAbortResponseSchema = z.union([TransferSuccessSchema, TransferFailureSchema]);
export type DaemonVoiceOpenAiCompatDownloadAbortResponse = z.infer<typeof DaemonVoiceOpenAiCompatDownloadAbortResponseSchema>;

export const DaemonVoiceOpenAiCompatRequestCancelRequestSchema = z.object({ requestId: RequestIdSchema }).strict();
export type DaemonVoiceOpenAiCompatRequestCancelRequest = z.infer<typeof DaemonVoiceOpenAiCompatRequestCancelRequestSchema>;
export const DaemonVoiceOpenAiCompatRequestCancelResponseSchema = z.union([
  z.object({ ok: z.literal(true), cancelled: z.boolean() }).strict(),
  DaemonVoiceOpenAiCompatErrorSchema,
]);
export type DaemonVoiceOpenAiCompatRequestCancelResponse = z.infer<typeof DaemonVoiceOpenAiCompatRequestCancelResponseSchema>;
