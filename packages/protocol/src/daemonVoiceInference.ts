import { z } from 'zod';

import { TransferSessionIdSchema } from './transferSessions/index.js';
import { ModelPackKindSchema } from './voice/modelPacks/manifest.js';

export const LocalNeuralExecutionSchema = z.enum(['auto', 'device', 'daemon']);
export type LocalNeuralExecution = z.infer<typeof LocalNeuralExecutionSchema>;
export const DAEMON_VOICE_INFERENCE_REQUEST_ID_MAX_LENGTH = 256;

export const DaemonVoiceInferenceServiceStateSchema = z.enum(['unavailable', 'idle', 'warming', 'ready', 'degraded']);
export type DaemonVoiceInferenceServiceState = z.infer<typeof DaemonVoiceInferenceServiceStateSchema>;

export const DaemonVoiceInferenceAudioCodecSchema = z.enum(['mp3', 'wav', 'opus']);
export type DaemonVoiceInferenceAudioCodec = z.infer<typeof DaemonVoiceInferenceAudioCodecSchema>;

export const DaemonVoiceInferenceAudioOutputSchema = z.discriminatedUnion('codec', [
  z.object({
    codec: z.literal('wav'),
    mimeType: z.literal('audio/wav'),
  }),
  z.object({
    codec: z.literal('mp3'),
    mimeType: z.literal('audio/mpeg'),
  }),
  z.object({
    codec: z.literal('opus'),
    mimeType: z.literal('audio/opus'),
  }),
]);
export type DaemonVoiceInferenceAudioOutput = z.infer<typeof DaemonVoiceInferenceAudioOutputSchema>;

export const DaemonVoiceInferenceNormalizationStrategySchema = z.enum(['daemon_decode', 'ui_pretranscoded_pcm16_fallback']);
export type DaemonVoiceInferenceNormalizationStrategy = z.infer<typeof DaemonVoiceInferenceNormalizationStrategySchema>;

export const DaemonVoiceInferenceNormalizationDecisionSchema = z.object({
  inputTransport: z.literal('upload_transfer'),
  strategy: DaemonVoiceInferenceNormalizationStrategySchema,
  systemFfmpegAllowed: z.literal(false),
});
export type DaemonVoiceInferenceNormalizationDecision = z.infer<typeof DaemonVoiceInferenceNormalizationDecisionSchema>;

export const DaemonVoiceInferenceInstallPhaseSchema = z.enum([
  'queued',
  'downloading',
  'verifying',
  'installing',
  'complete',
  'error',
]);
export type DaemonVoiceInferenceInstallPhase = z.infer<typeof DaemonVoiceInferenceInstallPhaseSchema>;

export const DaemonVoiceInferenceInstallProgressSchema = z.object({
  phase: DaemonVoiceInferenceInstallPhaseSchema,
  progress: z.number().min(0).max(1),
  bytesDownloaded: z.number().int().min(0).nullable().default(null),
  totalBytes: z.number().int().min(0).nullable().default(null),
  message: z.string().min(1).nullable().default(null),
});
export type DaemonVoiceInferenceInstallProgress = z.infer<typeof DaemonVoiceInferenceInstallProgressSchema>;

export const DaemonVoiceInferenceModelInstallStateSchema = z.enum([
  'not_installed',
  'installing',
  'installed',
  'error',
]);
export type DaemonVoiceInferenceModelInstallState = z.infer<typeof DaemonVoiceInferenceModelInstallStateSchema>;

export const DaemonVoiceInferenceModelStatusSchema = z.object({
  packId: z.string().min(1),
  kind: ModelPackKindSchema,
  model: z.string().min(1),
  version: z.string().min(1).nullable().default(null),
  executionSupport: z.array(LocalNeuralExecutionSchema).min(1),
  installState: DaemonVoiceInferenceModelInstallStateSchema,
  progress: DaemonVoiceInferenceInstallProgressSchema.nullable().default(null),
  lastError: z.string().min(1).nullable().default(null),
  updatedAtMs: z.number().int().nonnegative(),
});
export type DaemonVoiceInferenceModelStatus = z.infer<typeof DaemonVoiceInferenceModelStatusSchema>;

export const DaemonVoiceInferenceErrorCodeSchema = z.enum([
  'runtime_unavailable',
  'model_not_installed',
  'machine_unreachable',
  'request_timeout',
  'invalid_audio_input',
  'unsupported_codec',
  'cancelled',
  'internal_error',
]);
export type DaemonVoiceInferenceErrorCode = z.infer<typeof DaemonVoiceInferenceErrorCodeSchema>;

export const DaemonVoiceInferenceErrorSchema = z.object({
  ok: z.literal(false),
  errorCode: DaemonVoiceInferenceErrorCodeSchema,
  error: z.string().min(1),
});
export type DaemonVoiceInferenceError = z.infer<typeof DaemonVoiceInferenceErrorSchema>;

export const DaemonVoiceInferenceStatusRequestSchema = z.object({}).passthrough();
export type DaemonVoiceInferenceStatusRequest = z.infer<typeof DaemonVoiceInferenceStatusRequestSchema>;

export const DaemonVoiceInferenceStatusResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    serviceState: DaemonVoiceInferenceServiceStateSchema,
    normalization: DaemonVoiceInferenceNormalizationDecisionSchema,
    models: z.array(DaemonVoiceInferenceModelStatusSchema),
  }).passthrough(),
  DaemonVoiceInferenceErrorSchema,
]);
export type DaemonVoiceInferenceStatusResponse = z.infer<typeof DaemonVoiceInferenceStatusResponseSchema>;

export const DaemonVoiceInferenceModelsListRequestSchema = z.object({}).passthrough();
export type DaemonVoiceInferenceModelsListRequest = z.infer<typeof DaemonVoiceInferenceModelsListRequestSchema>;

export const DaemonVoiceInferenceModelsListResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    models: z.array(DaemonVoiceInferenceModelStatusSchema),
  }).passthrough(),
  DaemonVoiceInferenceErrorSchema,
]);
export type DaemonVoiceInferenceModelsListResponse = z.infer<typeof DaemonVoiceInferenceModelsListResponseSchema>;

export const DaemonVoiceInferenceModelsInstallRequestSchema = z.object({
  packId: z.string().min(1),
}).strict();
export type DaemonVoiceInferenceModelsInstallRequest = z.infer<typeof DaemonVoiceInferenceModelsInstallRequestSchema>;

export const DaemonVoiceInferenceModelsInstallResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    model: DaemonVoiceInferenceModelStatusSchema,
  }).passthrough(),
  DaemonVoiceInferenceErrorSchema,
]);
export type DaemonVoiceInferenceModelsInstallResponse = z.infer<typeof DaemonVoiceInferenceModelsInstallResponseSchema>;

export const DaemonVoiceInferenceModelsRemoveRequestSchema = z.object({
  packId: z.string().min(1),
}).strict();
export type DaemonVoiceInferenceModelsRemoveRequest = z.infer<typeof DaemonVoiceInferenceModelsRemoveRequestSchema>;

export const DaemonVoiceInferenceModelsRemoveResponseSchema = z.union([
  z.object({ ok: z.literal(true) }).passthrough(),
  DaemonVoiceInferenceErrorSchema,
]);
export type DaemonVoiceInferenceModelsRemoveResponse = z.infer<typeof DaemonVoiceInferenceModelsRemoveResponseSchema>;

export const DaemonVoiceInferenceModelsStatusRequestSchema = z.object({
  packIds: z.array(z.string().min(1)).optional(),
}).strict();
export type DaemonVoiceInferenceModelsStatusRequest = z.infer<typeof DaemonVoiceInferenceModelsStatusRequestSchema>;

export const DaemonVoiceInferenceModelsWarmRequestSchema = z.object({
  packIds: z.array(z.string().min(1)).min(1),
}).strict();
export type DaemonVoiceInferenceModelsWarmRequest = z.infer<typeof DaemonVoiceInferenceModelsWarmRequestSchema>;

export const DaemonVoiceInferenceModelsStatusResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    models: z.array(DaemonVoiceInferenceModelStatusSchema),
  }).passthrough(),
  DaemonVoiceInferenceErrorSchema,
]);
export type DaemonVoiceInferenceModelsStatusResponse = z.infer<typeof DaemonVoiceInferenceModelsStatusResponseSchema>;

export const DaemonVoiceInferenceModelsWarmResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    models: z.array(DaemonVoiceInferenceModelStatusSchema),
  }).passthrough(),
  DaemonVoiceInferenceErrorSchema,
]);
export type DaemonVoiceInferenceModelsWarmResponse = z.infer<typeof DaemonVoiceInferenceModelsWarmResponseSchema>;

export const DaemonVoiceInferenceTtsSynthesizeRequestSchema = z.object({
  requestId: z.string().min(1).max(DAEMON_VOICE_INFERENCE_REQUEST_ID_MAX_LENGTH),
  text: z.string().min(1).max(200_000),
  packId: z.string().min(1).nullable().default(null),
  voiceId: z.string().min(1).nullable().default(null),
  speed: z.number().min(0.5).max(2).nullable().default(null),
  output: DaemonVoiceInferenceAudioOutputSchema.default({ codec: 'wav', mimeType: 'audio/wav' }),
}).strict();
export type DaemonVoiceInferenceTtsSynthesizeRequest = z.infer<typeof DaemonVoiceInferenceTtsSynthesizeRequestSchema>;

export const DaemonVoiceInferenceTtsSynthesizeResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    requestId: z.string().min(1),
    output: DaemonVoiceInferenceAudioOutputSchema,
    downloadId: TransferSessionIdSchema,
    chunkSizeBytes: z.number().int().positive(),
    sizeBytes: z.number().int().nonnegative(),
    name: z.string().min(1),
  }).passthrough(),
  DaemonVoiceInferenceErrorSchema,
]);
export type DaemonVoiceInferenceTtsSynthesizeResponse = z.infer<typeof DaemonVoiceInferenceTtsSynthesizeResponseSchema>;

export const DaemonVoiceInferenceTtsChunkRequestSchema = z.object({
  downloadId: TransferSessionIdSchema,
  index: z.number().int().min(0),
}).passthrough();
export type DaemonVoiceInferenceTtsChunkRequest = z.infer<typeof DaemonVoiceInferenceTtsChunkRequestSchema>;

export const DaemonVoiceInferenceTtsChunkResponseSchema = z.union([
  z.object({
    success: z.literal(true),
    contentBase64: z.string().min(1).optional(),
    payloadBase64: z.string().min(1).optional(),
    encryptedDataKeyEnvelopeBase64: z.string().min(1).optional(),
    isLast: z.boolean(),
  }).passthrough(),
  z.object({
    success: z.literal(false),
    error: z.string().min(1),
    errorCode: z.string().min(1).optional(),
  }).passthrough(),
]);
export type DaemonVoiceInferenceTtsChunkResponse = z.infer<typeof DaemonVoiceInferenceTtsChunkResponseSchema>;

export const DaemonVoiceInferenceTtsFinalizeRequestSchema = z.object({
  downloadId: TransferSessionIdSchema,
}).passthrough();
export type DaemonVoiceInferenceTtsFinalizeRequest = z.infer<typeof DaemonVoiceInferenceTtsFinalizeRequestSchema>;

export const DaemonVoiceInferenceTtsFinalizeResponseSchema = z.object({
  success: z.boolean(),
  error: z.string().min(1).optional(),
  errorCode: z.string().min(1).optional(),
}).passthrough();
export type DaemonVoiceInferenceTtsFinalizeResponse = z.infer<typeof DaemonVoiceInferenceTtsFinalizeResponseSchema>;

export const DaemonVoiceInferenceTtsAbortRequestSchema = z.object({
  downloadId: TransferSessionIdSchema,
}).passthrough();
export type DaemonVoiceInferenceTtsAbortRequest = z.infer<typeof DaemonVoiceInferenceTtsAbortRequestSchema>;

export const DaemonVoiceInferenceTtsAbortResponseSchema = z.object({
  success: z.boolean(),
  error: z.string().min(1).optional(),
  errorCode: z.string().min(1).optional(),
}).passthrough();
export type DaemonVoiceInferenceTtsAbortResponse = z.infer<typeof DaemonVoiceInferenceTtsAbortResponseSchema>;

export const DaemonVoiceInferenceTtsCancelRequestSchema = z.object({
  requestId: z.string().min(1).max(DAEMON_VOICE_INFERENCE_REQUEST_ID_MAX_LENGTH),
}).passthrough();
export type DaemonVoiceInferenceTtsCancelRequest = z.infer<typeof DaemonVoiceInferenceTtsCancelRequestSchema>;

export const DaemonVoiceInferenceTtsCancelResponseSchema = z.union([
  z.object({ ok: z.literal(true) }).passthrough(),
  DaemonVoiceInferenceErrorSchema,
]);
export type DaemonVoiceInferenceTtsCancelResponse = z.infer<typeof DaemonVoiceInferenceTtsCancelResponseSchema>;

export const DaemonVoiceInferenceSttUploadInitRequestSchema = z.object({
  requestId: z.string().min(1).max(DAEMON_VOICE_INFERENCE_REQUEST_ID_MAX_LENGTH),
  sizeBytes: z.number().int().positive(),
  inputMimeType: z.string().min(1),
}).strict();
export type DaemonVoiceInferenceSttUploadInitRequest = z.infer<typeof DaemonVoiceInferenceSttUploadInitRequestSchema>;

export const DaemonVoiceInferenceSttUploadInitResponseSchema = z.union([
  z.object({
    success: z.literal(true),
    uploadId: TransferSessionIdSchema,
    chunkSizeBytes: z.number().int().positive(),
    recipientPublicKeyBase64: z.string().min(1),
  }).passthrough(),
  z.object({
    success: z.literal(false),
    error: z.string().min(1),
    errorCode: z.string().min(1).optional(),
  }).passthrough(),
]);
export type DaemonVoiceInferenceSttUploadInitResponse = z.infer<typeof DaemonVoiceInferenceSttUploadInitResponseSchema>;

export const DaemonVoiceInferenceSttUploadChunkRequestSchema = z.object({
  uploadId: TransferSessionIdSchema,
  index: z.number().int().min(0),
  payloadBase64: z.string().min(1),
  encryptedDataKeyEnvelopeBase64: z.string().min(1),
}).passthrough();
export type DaemonVoiceInferenceSttUploadChunkRequest = z.infer<typeof DaemonVoiceInferenceSttUploadChunkRequestSchema>;

export const DaemonVoiceInferenceSttUploadChunkResponseSchema = z.object({
  success: z.boolean(),
  error: z.string().min(1).optional(),
  errorCode: z.string().min(1).optional(),
}).passthrough();
export type DaemonVoiceInferenceSttUploadChunkResponse = z.infer<typeof DaemonVoiceInferenceSttUploadChunkResponseSchema>;

export const DaemonVoiceInferenceSttUploadFinalizeRequestSchema = z.object({
  uploadId: TransferSessionIdSchema,
}).passthrough();
export type DaemonVoiceInferenceSttUploadFinalizeRequest = z.infer<typeof DaemonVoiceInferenceSttUploadFinalizeRequestSchema>;

export const DaemonVoiceInferenceSttUploadFinalizeResponseSchema = z.union([
  z.object({
    success: z.literal(true),
    uploadId: TransferSessionIdSchema,
    path: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
    sha256: z.string().min(1),
  }).passthrough(),
  z.object({
    success: z.literal(false),
    error: z.string().min(1),
    errorCode: z.string().min(1).optional(),
  }).passthrough(),
]);
export type DaemonVoiceInferenceSttUploadFinalizeResponse = z.infer<typeof DaemonVoiceInferenceSttUploadFinalizeResponseSchema>;

export const DaemonVoiceInferenceSttUploadAbortRequestSchema = z.object({
  uploadId: TransferSessionIdSchema,
}).passthrough();
export type DaemonVoiceInferenceSttUploadAbortRequest = z.infer<typeof DaemonVoiceInferenceSttUploadAbortRequestSchema>;

export const DaemonVoiceInferenceSttUploadAbortResponseSchema = z.object({
  success: z.boolean(),
  error: z.string().min(1).optional(),
  errorCode: z.string().min(1).optional(),
}).passthrough();
export type DaemonVoiceInferenceSttUploadAbortResponse = z.infer<typeof DaemonVoiceInferenceSttUploadAbortResponseSchema>;

export const DaemonVoiceInferenceSttTranscribeRequestSchema = z.object({
  requestId: z.string().min(1).max(DAEMON_VOICE_INFERENCE_REQUEST_ID_MAX_LENGTH),
  uploadId: TransferSessionIdSchema,
  packId: z.string().min(1).nullable().default(null),
  language: z.string().min(1).nullable().default(null),
  normalization: DaemonVoiceInferenceNormalizationDecisionSchema,
}).strict();
export type DaemonVoiceInferenceSttTranscribeRequest = z.infer<typeof DaemonVoiceInferenceSttTranscribeRequestSchema>;

export const DaemonVoiceInferenceSttTranscribeResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    requestId: z.string().min(1),
    text: z.string(),
    language: z.string().min(1).nullable().default(null),
    modelPackId: z.string().min(1).nullable().default(null),
  }).passthrough(),
  DaemonVoiceInferenceErrorSchema,
]);
export type DaemonVoiceInferenceSttTranscribeResponse = z.infer<typeof DaemonVoiceInferenceSttTranscribeResponseSchema>;

export const DaemonVoiceInferenceSttCancelRequestSchema = z.object({
  requestId: z.string().min(1).max(DAEMON_VOICE_INFERENCE_REQUEST_ID_MAX_LENGTH),
}).passthrough();
export type DaemonVoiceInferenceSttCancelRequest = z.infer<typeof DaemonVoiceInferenceSttCancelRequestSchema>;

export const DaemonVoiceInferenceSttCancelResponseSchema = z.union([
  z.object({ ok: z.literal(true) }).passthrough(),
  DaemonVoiceInferenceErrorSchema,
]);
export type DaemonVoiceInferenceSttCancelResponse = z.infer<typeof DaemonVoiceInferenceSttCancelResponseSchema>;
