import { z } from 'zod';

import { TransferSessionIdSchema } from '../transfers/sessions/index.js';
import { ModelPackKindSchema, ModelPackRuntimeFamilySchema } from '../voice/modelPacks/manifest.js';
import { VoiceModelPackIdentityV1Schema } from '../voice/modelPacks/identityV1.js';
import { VOICE_RUNTIME_DAEMON_STT_PCM_FORMAT } from '../voice/runtimeConfig.js';
import { VoiceSpeechDiagnosticsCaptureContextV1Schema } from '../voice/diagnostics.js';
import { buildQualifiedPluginContributionKey } from '../plugins/contributionIdentity.js';
import {
  PeerApplicationEncryptionAuthorityBindingV1Schema,
  PeerApplicationEncryptionStartResponseV1Schema,
} from '../machines/peer/mediation/peerApplicationEncryptionV1.js';

export const LocalNeuralExecutionSchema = z.enum(['auto', 'device', 'daemon']);
export type LocalNeuralExecution = z.infer<typeof LocalNeuralExecutionSchema>;
export const DAEMON_VOICE_INFERENCE_REQUEST_ID_MAX_LENGTH = 256;
export const DAEMON_VOICE_INFERENCE_STREAM_ID_MAX_LENGTH = 256;
export const DAEMON_VOICE_INFERENCE_STT_STREAM_CHUNK_BASE64_MAX_LENGTH = 1024 * 1024;
export const DAEMON_VOICE_INFERENCE_TTS_STREAM_SEGMENT_AUDIO_BASE64_MAX_LENGTH = 16 * 1024 * 1024;
export const DAEMON_VOICE_INFERENCE_TTS_STREAM_SEGMENT_TEXT_MAX_LENGTH = 4_000;

export const DaemonVoiceInferenceServiceStateSchema = z.enum(['unavailable', 'idle', 'warming', 'ready', 'degraded']);
export type DaemonVoiceInferenceServiceState = z.infer<typeof DaemonVoiceInferenceServiceStateSchema>;

// The packaged daemon runtime currently has exactly one codec owner and always
// produces WAV. Additive codecs belong here only after a runtime encoder exists.
export const DaemonVoiceInferenceAudioCodecSchema = z.literal('wav');
export type DaemonVoiceInferenceAudioCodec = z.infer<typeof DaemonVoiceInferenceAudioCodecSchema>;

export const DaemonVoiceInferenceAudioOutputSchema = z.object({
  codec: z.literal('wav'),
  mimeType: z.literal('audio/wav'),
}).strict();
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

/**
 * Daemon-side resident lifecycle of a model, independent of its install state.
 * `cold` = installed but not loaded; `warming` = loading/priming in flight;
 * `ready` = loaded, primed, and serving; `evicted` = unloaded by the memory-budget
 * LRU (re-warms on next use). Additive, optional readiness telemetry.
 */
export const DaemonVoiceInferenceModelRuntimeStateSchema = z.enum([
  'cold',
  'warming',
  'ready',
  'evicted',
]);
export type DaemonVoiceInferenceModelRuntimeState = z.infer<typeof DaemonVoiceInferenceModelRuntimeStateSchema>;

export const DaemonVoiceModelPackLicenseReviewV1Schema = z.object({
  pluginId: VoiceModelPackIdentityV1Schema.shape.pluginId,
  packId: VoiceModelPackIdentityV1Schema.shape.packId,
  pluginVersion: z.string().min(1).max(128),
  packVersion: z.string().min(1).max(128),
  licenseId: z.string().min(1).max(128),
  licenseTitle: z.string().min(1).max(256),
  licenseText: z.string().min(1).max(128 * 1024),
  licenseSourceUrl: z.string().url().max(2048),
  licenseTextDigest: z.string().regex(/^(?:sha256:)?[0-9a-f]{64}$/i),
  artifactDigest: z.string().regex(/^(?:sha256:)?[0-9a-f]{64}$/i),
  accepted: z.boolean(),
}).strict();
export type DaemonVoiceModelPackLicenseReviewV1 = z.infer<typeof DaemonVoiceModelPackLicenseReviewV1Schema>;

export const DaemonVoiceInferenceModelStatusSchema = z.object({
  packId: z.string().min(1),
  /** Null is the built-in/legacy namespace; non-null is a structured public-plugin identity. */
  pluginIdentity: VoiceModelPackIdentityV1Schema.nullable().default(null),
  kind: ModelPackKindSchema,
  model: z.string().min(1),
  version: z.string().min(1).nullable().default(null),
  executionSupport: z.array(LocalNeuralExecutionSchema).min(1),
  /** Host-projected runtime ABI and support. Optional for older daemon payloads; missing fails closed in new UI. */
  runtimeFamily: ModelPackRuntimeFamilySchema.nullable().optional(),
  runtimeSupported: z.boolean().optional(),
  installState: DaemonVoiceInferenceModelInstallStateSchema,
  progress: DaemonVoiceInferenceInstallProgressSchema.nullable().default(null),
  lastError: z.string().min(1).nullable().default(null),
  updatedAtMs: z.number().int().nonnegative(),
  // Additive readiness telemetry. Optional (not defaulted) so omitted input stays
  // omitted in output and existing callers/payloads are byte-for-byte unaffected.
  runtimeState: DaemonVoiceInferenceModelRuntimeStateSchema.optional(),
  residentMemoryBytes: z.number().int().nonnegative().optional(),
  /** Exact external-pack consent binding. Absent for built-in packs and licenses without consent. */
  licenseReview: DaemonVoiceModelPackLicenseReviewV1Schema.nullable().optional(),
}).superRefine((status, ctx) => {
  if (status.pluginIdentity && buildQualifiedPluginContributionKey({
    pluginId: status.pluginIdentity.pluginId,
    localId: status.pluginIdentity.packId,
  }) !== status.packId) {
    ctx.addIssue({
      code: 'custom',
      path: ['pluginIdentity', 'packId'],
      message: 'Plugin model-pack identity must match the qualified projected pack id.',
    });
  }
});
export type DaemonVoiceInferenceModelStatus = z.infer<typeof DaemonVoiceInferenceModelStatusSchema>;

export const DaemonVoiceInferenceErrorCodeSchema = z.enum([
  'runtime_unavailable',
  'model_not_installed',
  'machine_unreachable',
  'request_timeout',
  'invalid_audio_input',
  'unsupported_codec',
  'unsupported_runtime_family',
  'cancelled',
  'stream_not_found',
  'invalid_stream_state',
  'internal_error',
]);
export type DaemonVoiceInferenceErrorCode = z.infer<typeof DaemonVoiceInferenceErrorCodeSchema>;

export const DaemonVoiceInferenceErrorSchema = z.object({
  ok: z.literal(false),
  errorCode: DaemonVoiceInferenceErrorCodeSchema,
  error: z.string().min(1),
  retryable: z.boolean().optional(),
});
export type DaemonVoiceInferenceError = z.infer<typeof DaemonVoiceInferenceErrorSchema>;

export const DaemonVoiceInferenceStreamIdSchema = z
  .string()
  .min(1)
  .max(DAEMON_VOICE_INFERENCE_STREAM_ID_MAX_LENGTH);
export type DaemonVoiceInferenceStreamId = z.infer<typeof DaemonVoiceInferenceStreamIdSchema>;

const DaemonVoiceInferenceStreamGenerationSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const DaemonVoiceInferenceStreamSeqSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const DaemonVoiceInferenceStreamAckSeqSchema = z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER);
const DaemonVoiceInferenceSegmentIndexSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const DaemonVoiceInferenceSegmentCountSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

export const DaemonVoiceInferenceSttStreamPcmFormatSchema = z.object({
  sampleRateHz: z.literal(VOICE_RUNTIME_DAEMON_STT_PCM_FORMAT.sampleRateHz),
  channelCount: z.literal(VOICE_RUNTIME_DAEMON_STT_PCM_FORMAT.channelCount),
  bitsPerSample: z.literal(VOICE_RUNTIME_DAEMON_STT_PCM_FORMAT.bitsPerSample),
  ffmpegCodec: z.literal(VOICE_RUNTIME_DAEMON_STT_PCM_FORMAT.ffmpegCodec),
}).strict();
export type DaemonVoiceInferenceSttStreamPcmFormat = z.infer<typeof DaemonVoiceInferenceSttStreamPcmFormatSchema>;

export const DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT = VOICE_RUNTIME_DAEMON_STT_PCM_FORMAT;

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

export const DaemonVoiceInferenceModelLicenseAcceptRequestSchema = DaemonVoiceModelPackLicenseReviewV1Schema
  .omit({ licenseTitle: true, licenseText: true, accepted: true })
  .extend({ qualifiedPackId: z.string().min(1).max(2048) })
  .strict();
export type DaemonVoiceInferenceModelLicenseAcceptRequest = z.infer<typeof DaemonVoiceInferenceModelLicenseAcceptRequestSchema>;

export const DaemonVoiceInferenceModelLicenseAcceptResponseSchema = z.union([
  z.object({ ok: z.literal(true), model: DaemonVoiceInferenceModelStatusSchema }).passthrough(),
  DaemonVoiceInferenceErrorSchema,
]);
export type DaemonVoiceInferenceModelLicenseAcceptResponse = z.infer<typeof DaemonVoiceInferenceModelLicenseAcceptResponseSchema>;

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
  diagnostics: VoiceSpeechDiagnosticsCaptureContextV1Schema.optional(),
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

export const DaemonVoiceInferenceTtsStreamStartRequestSchema = z.object({
  requestId: z.string().min(1).max(DAEMON_VOICE_INFERENCE_REQUEST_ID_MAX_LENGTH),
  text: z.string().min(1).max(200_000),
  packId: z.string().min(1).nullable().default(null),
  voiceId: z.string().min(1).nullable().default(null),
  speed: z.number().min(0.5).max(2).nullable().default(null),
  output: DaemonVoiceInferenceAudioOutputSchema.default({ codec: 'wav', mimeType: 'audio/wav' }),
  prefetchDepth: z.number().int().min(1).max(2).optional(),
  diagnostics: VoiceSpeechDiagnosticsCaptureContextV1Schema.optional(),
}).strict();
export type DaemonVoiceInferenceTtsStreamStartRequest = z.infer<typeof DaemonVoiceInferenceTtsStreamStartRequestSchema>;

export const DaemonVoiceInferenceTtsStreamStartResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    requestId: z.string().min(1),
    streamId: DaemonVoiceInferenceStreamIdSchema,
    generation: DaemonVoiceInferenceStreamGenerationSchema,
    segmentCount: DaemonVoiceInferenceSegmentCountSchema,
    output: DaemonVoiceInferenceAudioOutputSchema,
  }).passthrough(),
  DaemonVoiceInferenceErrorSchema,
]);
export type DaemonVoiceInferenceTtsStreamStartResponse = z.infer<typeof DaemonVoiceInferenceTtsStreamStartResponseSchema>;

export const DaemonVoiceInferenceTtsStreamSegmentAudioSchema = z.object({
  contentBase64: z.string().min(1).max(DAEMON_VOICE_INFERENCE_TTS_STREAM_SEGMENT_AUDIO_BASE64_MAX_LENGTH),
  sizeBytes: z.number().int().nonnegative(),
}).strict();
export type DaemonVoiceInferenceTtsStreamSegmentAudio = z.infer<typeof DaemonVoiceInferenceTtsStreamSegmentAudioSchema>;

export const DaemonVoiceInferenceTtsStreamEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('segment'),
    streamId: DaemonVoiceInferenceStreamIdSchema,
    generation: DaemonVoiceInferenceStreamGenerationSchema,
    segmentId: z.string().min(1).max(DAEMON_VOICE_INFERENCE_STREAM_ID_MAX_LENGTH),
    segmentIndex: DaemonVoiceInferenceSegmentIndexSchema,
    segmentCount: DaemonVoiceInferenceSegmentCountSchema,
    text: z.string().min(1).max(DAEMON_VOICE_INFERENCE_TTS_STREAM_SEGMENT_TEXT_MAX_LENGTH),
    textRange: z.object({
      start: z.number().int().min(0),
      end: z.number().int().min(0),
    }).strict(),
    textHash: z.string().min(1).max(128),
    output: DaemonVoiceInferenceAudioOutputSchema,
    audio: DaemonVoiceInferenceTtsStreamSegmentAudioSchema,
    isLastSegment: z.boolean(),
  }).passthrough(),
  z.object({
    type: z.literal('done'),
    streamId: DaemonVoiceInferenceStreamIdSchema,
    generation: DaemonVoiceInferenceStreamGenerationSchema,
  }).passthrough(),
  z.object({
    type: z.literal('error'),
    streamId: DaemonVoiceInferenceStreamIdSchema,
    generation: DaemonVoiceInferenceStreamGenerationSchema,
    segmentId: z.string().min(1).max(DAEMON_VOICE_INFERENCE_STREAM_ID_MAX_LENGTH).nullable().default(null),
    segmentIndex: DaemonVoiceInferenceSegmentIndexSchema.nullable().default(null),
    errorCode: DaemonVoiceInferenceErrorCodeSchema,
    error: z.string().min(1),
    retryable: z.boolean().default(false),
  }).passthrough(),
]);
export type DaemonVoiceInferenceTtsStreamEvent = z.infer<typeof DaemonVoiceInferenceTtsStreamEventSchema>;

export const DaemonVoiceInferenceTtsStreamNextRequestSchema = z.object({
  streamId: DaemonVoiceInferenceStreamIdSchema,
  generation: DaemonVoiceInferenceStreamGenerationSchema,
}).strict();
export type DaemonVoiceInferenceTtsStreamNextRequest = z.infer<typeof DaemonVoiceInferenceTtsStreamNextRequestSchema>;

export const DaemonVoiceInferenceTtsStreamNextResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    streamId: DaemonVoiceInferenceStreamIdSchema,
    generation: DaemonVoiceInferenceStreamGenerationSchema,
    event: DaemonVoiceInferenceTtsStreamEventSchema,
  }).passthrough(),
  DaemonVoiceInferenceErrorSchema,
]);
export type DaemonVoiceInferenceTtsStreamNextResponse = z.infer<typeof DaemonVoiceInferenceTtsStreamNextResponseSchema>;

export const DaemonVoiceInferenceTtsStreamAckRequestSchema = z.object({
  streamId: DaemonVoiceInferenceStreamIdSchema,
  generation: DaemonVoiceInferenceStreamGenerationSchema,
  segmentId: z.string().min(1).max(DAEMON_VOICE_INFERENCE_STREAM_ID_MAX_LENGTH),
  segmentIndex: DaemonVoiceInferenceSegmentIndexSchema,
}).strict();
export type DaemonVoiceInferenceTtsStreamAckRequest = z.infer<typeof DaemonVoiceInferenceTtsStreamAckRequestSchema>;

export const DaemonVoiceInferenceTtsStreamAckResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    streamId: DaemonVoiceInferenceStreamIdSchema,
    generation: DaemonVoiceInferenceStreamGenerationSchema,
    ackedSegmentIndex: DaemonVoiceInferenceSegmentIndexSchema,
    complete: z.boolean(),
  }).passthrough(),
  DaemonVoiceInferenceErrorSchema,
]);
export type DaemonVoiceInferenceTtsStreamAckResponse = z.infer<typeof DaemonVoiceInferenceTtsStreamAckResponseSchema>;

export const DaemonVoiceInferenceTtsStreamCancelReasonSchema = z.enum([
  'client_abort',
  'barge_in',
  'stale_generation',
  'client_dispose',
]);
export type DaemonVoiceInferenceTtsStreamCancelReason = z.infer<typeof DaemonVoiceInferenceTtsStreamCancelReasonSchema>;

export const DaemonVoiceInferenceTtsStreamCancelRequestSchema = z.object({
  streamId: DaemonVoiceInferenceStreamIdSchema,
  generation: DaemonVoiceInferenceStreamGenerationSchema,
  reason: DaemonVoiceInferenceTtsStreamCancelReasonSchema.default('client_abort'),
}).strict();
export type DaemonVoiceInferenceTtsStreamCancelRequest = z.infer<typeof DaemonVoiceInferenceTtsStreamCancelRequestSchema>;

export const DaemonVoiceInferenceTtsStreamCancelResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    streamId: DaemonVoiceInferenceStreamIdSchema,
    generation: DaemonVoiceInferenceStreamGenerationSchema,
  }).passthrough(),
  DaemonVoiceInferenceErrorSchema,
]);
export type DaemonVoiceInferenceTtsStreamCancelResponse = z.infer<typeof DaemonVoiceInferenceTtsStreamCancelResponseSchema>;

export const DaemonVoiceInferenceTtsStreamStateSchema = z.enum(['open', 'error', 'closed']);
export type DaemonVoiceInferenceTtsStreamState = z.infer<typeof DaemonVoiceInferenceTtsStreamStateSchema>;

export const DaemonVoiceInferenceTtsStreamStatusRequestSchema = z.object({
  streamId: DaemonVoiceInferenceStreamIdSchema,
  generation: DaemonVoiceInferenceStreamGenerationSchema.optional(),
}).strict();
export type DaemonVoiceInferenceTtsStreamStatusRequest = z.infer<typeof DaemonVoiceInferenceTtsStreamStatusRequestSchema>;

export const DaemonVoiceInferenceTtsStreamStatusResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    streamId: DaemonVoiceInferenceStreamIdSchema,
    generation: DaemonVoiceInferenceStreamGenerationSchema,
    state: DaemonVoiceInferenceTtsStreamStateSchema,
    segmentCount: DaemonVoiceInferenceSegmentCountSchema,
    deliveredSegmentCount: z.number().int().min(0),
    ackedSegmentCount: z.number().int().min(0),
    outstandingSegmentCount: z.number().int().min(0),
  }).passthrough(),
  DaemonVoiceInferenceErrorSchema,
]);
export type DaemonVoiceInferenceTtsStreamStatusResponse = z.infer<typeof DaemonVoiceInferenceTtsStreamStatusResponseSchema>;

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
  diagnostics: VoiceSpeechDiagnosticsCaptureContextV1Schema.optional(),
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

export const DaemonVoiceInferenceSttStreamStartRequestSchema = z.object({
  requestId: z.string().min(1).max(DAEMON_VOICE_INFERENCE_REQUEST_ID_MAX_LENGTH),
  packId: z.string().min(1).nullable().default(null),
  language: z.string().min(1).nullable().default(null),
  streamingMode: z.enum(['runtime', 'upload_bridge']).optional(),
  format: DaemonVoiceInferenceSttStreamPcmFormatSchema.default(DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT),
  diagnostics: VoiceSpeechDiagnosticsCaptureContextV1Schema.optional(),
  peerApplicationEncryption: PeerApplicationEncryptionAuthorityBindingV1Schema.optional(),
}).strict();
export type DaemonVoiceInferenceSttStreamStartRequest = z.infer<typeof DaemonVoiceInferenceSttStreamStartRequestSchema>;

export const DaemonVoiceInferenceSttStreamStartResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    requestId: z.string().min(1),
    streamId: DaemonVoiceInferenceStreamIdSchema,
    generation: DaemonVoiceInferenceStreamGenerationSchema,
    ackSeq: DaemonVoiceInferenceStreamAckSeqSchema,
    format: DaemonVoiceInferenceSttStreamPcmFormatSchema,
    peerApplicationEncryption: PeerApplicationEncryptionStartResponseV1Schema.optional(),
  }).passthrough(),
  DaemonVoiceInferenceErrorSchema,
]);
export type DaemonVoiceInferenceSttStreamStartResponse = z.infer<typeof DaemonVoiceInferenceSttStreamStartResponseSchema>;

export const DaemonVoiceInferenceSttStreamEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('partial'),
    seq: DaemonVoiceInferenceStreamSeqSchema,
    text: z.string(),
    isEndpoint: z.boolean().default(false),
    confidence: z.number().min(0).max(1).nullable().default(null),
  }).passthrough(),
  z.object({
    type: z.literal('endpoint'),
    seq: DaemonVoiceInferenceStreamSeqSchema,
    transcript: z.string().default(''),
    reason: z.enum(['vad', 'timeout', 'manual', 'eof']).default('vad'),
  }).passthrough(),
  z.object({
    type: z.literal('final'),
    seq: DaemonVoiceInferenceStreamSeqSchema,
    text: z.string(),
    language: z.string().min(1).nullable().default(null),
    modelPackId: z.string().min(1).nullable().default(null),
  }).passthrough(),
]);
export type DaemonVoiceInferenceSttStreamEvent = z.infer<typeof DaemonVoiceInferenceSttStreamEventSchema>;

export const DaemonVoiceInferenceSttStreamChunkRequestSchema = z.object({
  streamId: DaemonVoiceInferenceStreamIdSchema,
  generation: DaemonVoiceInferenceStreamGenerationSchema,
  seq: DaemonVoiceInferenceStreamSeqSchema,
  pcm16Base64: z.string().min(1).max(DAEMON_VOICE_INFERENCE_STT_STREAM_CHUNK_BASE64_MAX_LENGTH),
}).strict();
export type DaemonVoiceInferenceSttStreamChunkRequest = z.infer<typeof DaemonVoiceInferenceSttStreamChunkRequestSchema>;

export const DaemonVoiceInferenceSttStreamChunkResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    streamId: DaemonVoiceInferenceStreamIdSchema,
    generation: DaemonVoiceInferenceStreamGenerationSchema,
    ackSeq: DaemonVoiceInferenceStreamAckSeqSchema,
    events: z.array(DaemonVoiceInferenceSttStreamEventSchema).default([]),
  }).passthrough(),
  DaemonVoiceInferenceErrorSchema,
]);
export type DaemonVoiceInferenceSttStreamChunkResponse = z.infer<typeof DaemonVoiceInferenceSttStreamChunkResponseSchema>;

export const DaemonVoiceInferenceSttStreamFinishRequestSchema = z.object({
  streamId: DaemonVoiceInferenceStreamIdSchema,
  generation: DaemonVoiceInferenceStreamGenerationSchema,
  finalSeq: DaemonVoiceInferenceStreamSeqSchema,
}).strict();
export type DaemonVoiceInferenceSttStreamFinishRequest = z.infer<typeof DaemonVoiceInferenceSttStreamFinishRequestSchema>;

export const DaemonVoiceInferenceSttStreamFinishResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    streamId: DaemonVoiceInferenceStreamIdSchema,
    generation: DaemonVoiceInferenceStreamGenerationSchema,
    ackSeq: DaemonVoiceInferenceStreamAckSeqSchema,
    finalText: z.string(),
    language: z.string().min(1).nullable().default(null),
    modelPackId: z.string().min(1).nullable().default(null),
    events: z.array(DaemonVoiceInferenceSttStreamEventSchema).default([]),
  }).passthrough(),
  DaemonVoiceInferenceErrorSchema,
]);
export type DaemonVoiceInferenceSttStreamFinishResponse = z.infer<typeof DaemonVoiceInferenceSttStreamFinishResponseSchema>;

export const DaemonVoiceInferenceSttStreamCancelRequestSchema = z.object({
  streamId: DaemonVoiceInferenceStreamIdSchema,
  generation: DaemonVoiceInferenceStreamGenerationSchema,
}).strict();
export type DaemonVoiceInferenceSttStreamCancelRequest = z.infer<typeof DaemonVoiceInferenceSttStreamCancelRequestSchema>;

export const DaemonVoiceInferenceSttStreamCancelResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    streamId: DaemonVoiceInferenceStreamIdSchema,
    generation: DaemonVoiceInferenceStreamGenerationSchema,
  }).passthrough(),
  DaemonVoiceInferenceErrorSchema,
]);
export type DaemonVoiceInferenceSttStreamCancelResponse = z.infer<typeof DaemonVoiceInferenceSttStreamCancelResponseSchema>;

export const DaemonVoiceInferenceSttStreamStateSchema = z.enum(['open', 'finishing', 'closed']);
export type DaemonVoiceInferenceSttStreamState = z.infer<typeof DaemonVoiceInferenceSttStreamStateSchema>;

export const DaemonVoiceInferenceSttStreamStatusRequestSchema = z.object({
  streamId: DaemonVoiceInferenceStreamIdSchema,
  generation: DaemonVoiceInferenceStreamGenerationSchema.optional(),
}).strict();
export type DaemonVoiceInferenceSttStreamStatusRequest = z.infer<typeof DaemonVoiceInferenceSttStreamStatusRequestSchema>;

export const DaemonVoiceInferenceSttStreamStatusResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    streamId: DaemonVoiceInferenceStreamIdSchema,
    generation: DaemonVoiceInferenceStreamGenerationSchema,
    ackSeq: DaemonVoiceInferenceStreamAckSeqSchema,
    state: DaemonVoiceInferenceSttStreamStateSchema,
  }).passthrough(),
  DaemonVoiceInferenceErrorSchema,
]);
export type DaemonVoiceInferenceSttStreamStatusResponse = z.infer<typeof DaemonVoiceInferenceSttStreamStatusResponseSchema>;
