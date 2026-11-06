import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

import { TransferSessionIdSchema } from '../transfers/sessions/transferSessionIds.js';
import {
  ModelPackKindSchema,
  ModelPackRuntimeFamilySchema,
  ModelPackVoiceCatalogEntrySchema,
} from '../voice/modelPacks/manifest.js';
import { VoiceModelPackIdentityV1Schema } from '../voice/modelPacks/identityV1.js';
import { VOICE_RUNTIME_DAEMON_STT_PCM_FORMAT } from '../voice/runtimeConfig.js';
import { VoiceSpeechDiagnosticsCaptureContextV1Schema } from '../voice/diagnostics.js';
import { buildQualifiedPluginContributionKey } from '../plugins/contributionIdentity.js';
import {
  PeerApplicationEncryptionAuthorityBindingV1Schema,
  PeerApplicationEncryptionStartResponseV1Schema,
} from '../machines/peer/mediation/peerApplicationEncryptionV1.js';
import { DevelopmentPluginSourceCustodyV1Schema } from '../plugins/runtime/sourceCustody.js';

export const LocalNeuralExecutionSchema = lazyZodSchema(() => z.enum(['auto', 'device', 'daemon']));
export type LocalNeuralExecution = z.infer<typeof LocalNeuralExecutionSchema>;
export const DAEMON_VOICE_INFERENCE_REQUEST_ID_MAX_LENGTH = 256;
export const DAEMON_VOICE_INFERENCE_STREAM_ID_MAX_LENGTH = 256;
export const DAEMON_VOICE_INFERENCE_STT_STREAM_CHUNK_BASE64_MAX_LENGTH = 1024 * 1024;
export const DAEMON_VOICE_INFERENCE_TTS_STREAM_SEGMENT_AUDIO_BASE64_MAX_LENGTH = 16 * 1024 * 1024;
export const DAEMON_VOICE_INFERENCE_TTS_STREAM_SEGMENT_TEXT_MAX_LENGTH = 4_000;

export const DaemonVoiceInferenceServiceStateSchema = lazyZodSchema(() => z.enum(['unavailable', 'idle', 'warming', 'ready', 'degraded']));
export type DaemonVoiceInferenceServiceState = z.infer<typeof DaemonVoiceInferenceServiceStateSchema>;

// The packaged daemon runtime currently has exactly one codec owner and always
// produces WAV. Additive codecs belong here only after a runtime encoder exists.
export const DaemonVoiceInferenceAudioCodecSchema = lazyZodSchema(() => z.literal('wav'));
export type DaemonVoiceInferenceAudioCodec = z.infer<typeof DaemonVoiceInferenceAudioCodecSchema>;

export const DaemonVoiceInferenceAudioOutputSchema = lazyZodSchema(() => z.strictObject({
  codec: z.literal('wav'),
  mimeType: z.literal('audio/wav'),
}));
export type DaemonVoiceInferenceAudioOutput = z.infer<typeof DaemonVoiceInferenceAudioOutputSchema>;

export const DaemonVoiceInferenceNormalizationStrategySchema = lazyZodSchema(() => z.enum(['daemon_decode', 'ui_pretranscoded_pcm16_fallback']));
export type DaemonVoiceInferenceNormalizationStrategy = z.infer<typeof DaemonVoiceInferenceNormalizationStrategySchema>;

export const DaemonVoiceInferenceNormalizationDecisionSchema = lazyZodSchema(() => z.object({
  inputTransport: z.literal('upload_transfer'),
  strategy: DaemonVoiceInferenceNormalizationStrategySchema,
  systemFfmpegAllowed: z.literal(false),
}));
export type DaemonVoiceInferenceNormalizationDecision = z.infer<typeof DaemonVoiceInferenceNormalizationDecisionSchema>;

export const DaemonVoiceInferenceInstallPhaseSchema = lazyZodSchema(() => z.enum([
  'queued',
  'downloading',
  'verifying',
  'installing',
  'complete',
  'error',
]));
export type DaemonVoiceInferenceInstallPhase = z.infer<typeof DaemonVoiceInferenceInstallPhaseSchema>;

export const DaemonVoiceInferenceInstallProgressSchema = lazyZodSchema(() => z.object({
  phase: DaemonVoiceInferenceInstallPhaseSchema,
  progress: z.number().check(z.minimum(0), z.maximum(1)),
  bytesDownloaded: z._default(z.nullable(z.number().check(z.int(), z.minimum(0))), null),
  totalBytes: z._default(z.nullable(z.number().check(z.int(), z.minimum(0))), null),
  message: z._default(z.nullable(z.string().check(z.minLength(1))), null),
}));
export type DaemonVoiceInferenceInstallProgress = z.infer<typeof DaemonVoiceInferenceInstallProgressSchema>;

export const DaemonVoiceInferenceModelInstallStateSchema = lazyZodSchema(() => z.enum([
  'not_installed',
  'installing',
  'installed',
  'error',
]));
export type DaemonVoiceInferenceModelInstallState = z.infer<typeof DaemonVoiceInferenceModelInstallStateSchema>;

/**
 * Daemon-side resident lifecycle of a model, independent of its install state.
 * `cold` = installed but not loaded; `warming` = loading/priming in flight;
 * `ready` = loaded, primed, and serving; `evicted` = unloaded by the memory-budget
 * LRU (re-warms on next use). Additive, optional readiness telemetry.
 */
export const DaemonVoiceInferenceModelRuntimeStateSchema = lazyZodSchema(() => z.enum([
  'cold',
  'warming',
  'ready',
  'evicted',
]));
export type DaemonVoiceInferenceModelRuntimeState = z.infer<typeof DaemonVoiceInferenceModelRuntimeStateSchema>;

/**
 * Voice-owned binding to the admitted plugin artifact. External acquisition
 * integrity and local immutable materialization are intentionally distinct:
 * neither is a substitute for the other.
 */
export const DaemonVoiceModelPackArtifactBindingV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('sourceIntegrity'),
    integrity: z.string().check(z.minLength(1), z.maxLength(1024), z.refine((value) => value.trim() === value)),
  }),
  z.strictObject({
    kind: z.literal('materialization'),
    sourceCustody: DevelopmentPluginSourceCustodyV1Schema,
  }),
]));
export type DaemonVoiceModelPackArtifactBindingV1 = z.infer<typeof DaemonVoiceModelPackArtifactBindingV1Schema>;

export const DaemonVoiceModelPackLicenseReviewV1Schema = lazyZodSchema(() => z.strictObject({
  pluginId: VoiceModelPackIdentityV1Schema.shape.pluginId,
  packId: VoiceModelPackIdentityV1Schema.shape.packId,
  pluginVersion: z.string().check(z.minLength(1), z.maxLength(128)),
  packVersion: z.string().check(z.minLength(1), z.maxLength(128)),
  licenseId: z.string().check(z.minLength(1), z.maxLength(128)),
  licenseTitle: z.string().check(z.minLength(1), z.maxLength(256)),
  licenseText: z.string().check(z.minLength(1), z.maxLength(128 * 1024)),
  licenseSourceUrl: z.string().check(z.url(), z.maxLength(2048)),
  licenseTextDigest: z.string().check(z.regex(/^(?:sha256:)?[0-9a-f]{64}$/i)),
  artifactBinding: DaemonVoiceModelPackArtifactBindingV1Schema,
  accepted: z.boolean(),
}));
export type DaemonVoiceModelPackLicenseReviewV1 = z.infer<typeof DaemonVoiceModelPackLicenseReviewV1Schema>;

export const DaemonVoiceInferenceModelStatusSchema = lazyZodSchema(() => z.object({
  packId: z.string().check(z.minLength(1)),
  /** Null is the built-in/legacy namespace; non-null is a structured public-plugin identity. */
  pluginIdentity: z._default(z.nullable(VoiceModelPackIdentityV1Schema), null),
  kind: ModelPackKindSchema,
  model: z.string().check(z.minLength(1)),
  version: z._default(z.nullable(z.string().check(z.minLength(1))), null),
  executionSupport: z.array(LocalNeuralExecutionSchema).check(z.minLength(1)),
  /** Host-projected runtime ABI and support. Optional for older daemon payloads; missing fails closed in new UI. */
  runtimeFamily: z.optional(z.nullable(ModelPackRuntimeFamilySchema)),
  runtimeSupported: z.optional(z.boolean()),
  installState: DaemonVoiceInferenceModelInstallStateSchema,
  progress: z._default(z.nullable(DaemonVoiceInferenceInstallProgressSchema), null),
  lastError: z._default(z.nullable(z.string().check(z.minLength(1))), null),
  updatedAtMs: z.number().check(z.int(), z.nonnegative()),
  // Additive readiness telemetry. Optional (not defaulted) so omitted input stays
  // omitted in output and existing callers/payloads are byte-for-byte unaffected.
  runtimeState: z.optional(DaemonVoiceInferenceModelRuntimeStateSchema),
  /** Declared bytes of the model-pack artifact whose runtime is currently loaded; not RSS. */
  loadedArtifactBytes: z.optional(z.number().check(z.int(), z.nonnegative())),
  /** Active or queued inference/stream lease at observation time; omission means unknown. */
  inUse: z.optional(z.boolean()),
  /** Exact external-pack consent binding. Absent for built-in packs and licenses without consent. */
  licenseReview: z.optional(z.nullable(DaemonVoiceModelPackLicenseReviewV1Schema)),
  /** TTS voices declared by this exact pack. Empty for packs without a catalog. */
  voices: z.optional(z.array(ModelPackVoiceCatalogEntrySchema).check(z.maxLength(512))),
  /** Resolved explicit catalog default (or the first declared voice for legacy manifests). */
  defaultVoiceId: z.optional(z.nullable(z.string().check(z.minLength(1)))),
}).check(z.superRefine((status, ctx) => {
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
  if (
    status.defaultVoiceId
    && !(status.voices ?? []).some((voice) => voice.id === status.defaultVoiceId)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['defaultVoiceId'],
      message: 'The default voice must identify a projected voice.',
    });
  }
})));
export type DaemonVoiceInferenceModelStatus = z.infer<typeof DaemonVoiceInferenceModelStatusSchema>;

export const DaemonVoiceInferenceErrorCodeSchema = lazyZodSchema(() => z.enum([
  'runtime_unavailable',
  'model_not_installed',
  'machine_unreachable',
  'request_timeout',
  'invalid_audio_input',
  'output_too_large',
  'unsupported_codec',
  'unsupported_runtime_family',
  'cancelled',
  'stream_not_found',
  'invalid_stream_state',
  'internal_error',
]));
export type DaemonVoiceInferenceErrorCode = z.infer<typeof DaemonVoiceInferenceErrorCodeSchema>;

/** Native failure metadata only; never exception text, stacks, paths or audio. */
export const DaemonVoiceInferenceSttAppendDiagnosticSchema = lazyZodSchema(() => z.strictObject({
  operation: z.literal('appendPcm16'),
  streamId: DaemonVoiceInferenceStreamIdSchema,
  exceptionClass: z.enum(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError', 'EvalError', 'AggregateError', 'Unknown']),
  // Match the runner's identifier-only diagnostic convention; native APIs may also use numeric codes.
  code: z.nullable(z.union([
    z.string().check(z.regex(/^[a-zA-Z][a-zA-Z0-9_]{0,127}$/u)),
    z.number().check(z.int(), z.minimum(Number.MIN_SAFE_INTEGER), z.maximum(Number.MAX_SAFE_INTEGER)),
  ])),
}));

export const DaemonVoiceInferenceErrorSchema = lazyZodSchema(() => z.object({
  ok: z.literal(false),
  errorCode: DaemonVoiceInferenceErrorCodeSchema,
  error: z.string().check(z.minLength(1)),
  retryable: z.optional(z.boolean()),
  diagnostic: z.optional(DaemonVoiceInferenceSttAppendDiagnosticSchema),
}));
export type DaemonVoiceInferenceError = z.infer<typeof DaemonVoiceInferenceErrorSchema>;

export const DaemonVoiceInferenceStreamIdSchema = lazyZodSchema(() => z
  .string().check(z.minLength(1), z.maxLength(DAEMON_VOICE_INFERENCE_STREAM_ID_MAX_LENGTH)));
export type DaemonVoiceInferenceStreamId = z.infer<typeof DaemonVoiceInferenceStreamIdSchema>;

const DaemonVoiceInferenceStreamGenerationSchema = lazyZodSchema(() => z.number().check(z.int(), z.minimum(0), z.maximum(Number.MAX_SAFE_INTEGER)));
const DaemonVoiceInferenceStreamSeqSchema = lazyZodSchema(() => z.number().check(z.int(), z.minimum(0), z.maximum(Number.MAX_SAFE_INTEGER)));
const DaemonVoiceInferenceStreamAckSeqSchema = lazyZodSchema(() => z.number().check(z.int(), z.minimum(-1), z.maximum(Number.MAX_SAFE_INTEGER)));
const DaemonVoiceInferenceSegmentIndexSchema = lazyZodSchema(() => z.number().check(z.int(), z.minimum(0), z.maximum(Number.MAX_SAFE_INTEGER)));
const DaemonVoiceInferenceSegmentCountSchema = lazyZodSchema(() => z.number().check(z.int(), z.minimum(1), z.maximum(Number.MAX_SAFE_INTEGER)));

export const DaemonVoiceInferenceSttStreamPcmFormatSchema = lazyZodSchema(() => z.strictObject({
  sampleRateHz: z.literal(VOICE_RUNTIME_DAEMON_STT_PCM_FORMAT.sampleRateHz),
  channelCount: z.literal(VOICE_RUNTIME_DAEMON_STT_PCM_FORMAT.channelCount),
  bitsPerSample: z.literal(VOICE_RUNTIME_DAEMON_STT_PCM_FORMAT.bitsPerSample),
  ffmpegCodec: z.literal(VOICE_RUNTIME_DAEMON_STT_PCM_FORMAT.ffmpegCodec),
}));
export type DaemonVoiceInferenceSttStreamPcmFormat = z.infer<typeof DaemonVoiceInferenceSttStreamPcmFormatSchema>;

export const DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT = VOICE_RUNTIME_DAEMON_STT_PCM_FORMAT;

export const DaemonVoiceInferenceStatusRequestSchema = lazyZodSchema(() => z.looseObject({}));
export type DaemonVoiceInferenceStatusRequest = z.infer<typeof DaemonVoiceInferenceStatusRequestSchema>;

export const DaemonVoiceInferenceStatusResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({
    ok: z.literal(true),
    serviceState: DaemonVoiceInferenceServiceStateSchema,
    normalization: DaemonVoiceInferenceNormalizationDecisionSchema,
    models: z.array(DaemonVoiceInferenceModelStatusSchema),
  }),
  DaemonVoiceInferenceErrorSchema,
]));
export type DaemonVoiceInferenceStatusResponse = z.infer<typeof DaemonVoiceInferenceStatusResponseSchema>;

export const DaemonVoiceInferenceModelsListRequestSchema = lazyZodSchema(() => z.looseObject({}));
export type DaemonVoiceInferenceModelsListRequest = z.infer<typeof DaemonVoiceInferenceModelsListRequestSchema>;

export const DaemonVoiceInferenceModelsListResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({
    ok: z.literal(true),
    models: z.array(DaemonVoiceInferenceModelStatusSchema),
  }),
  DaemonVoiceInferenceErrorSchema,
]));
export type DaemonVoiceInferenceModelsListResponse = z.infer<typeof DaemonVoiceInferenceModelsListResponseSchema>;

export const DaemonVoiceInferenceModelsInstallRequestSchema = lazyZodSchema(() => z.strictObject({
  packId: z.string().check(z.minLength(1)),
}));
export type DaemonVoiceInferenceModelsInstallRequest = z.infer<typeof DaemonVoiceInferenceModelsInstallRequestSchema>;

export const DaemonVoiceInferenceModelsInstallResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({
    ok: z.literal(true),
    model: DaemonVoiceInferenceModelStatusSchema,
  }),
  DaemonVoiceInferenceErrorSchema,
]));
export type DaemonVoiceInferenceModelsInstallResponse = z.infer<typeof DaemonVoiceInferenceModelsInstallResponseSchema>;

export const DaemonVoiceInferenceModelLicenseAcceptRequestSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.omit(DaemonVoiceModelPackLicenseReviewV1Schema, { licenseTitle: true, licenseText: true, accepted: true }), { qualifiedPackId: z.string().check(z.minLength(1), z.maxLength(2048)) })));
export type DaemonVoiceInferenceModelLicenseAcceptRequest = z.infer<typeof DaemonVoiceInferenceModelLicenseAcceptRequestSchema>;

export const DaemonVoiceInferenceModelLicenseAcceptResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({ ok: z.literal(true), model: DaemonVoiceInferenceModelStatusSchema }),
  DaemonVoiceInferenceErrorSchema,
]));
export type DaemonVoiceInferenceModelLicenseAcceptResponse = z.infer<typeof DaemonVoiceInferenceModelLicenseAcceptResponseSchema>;

export const DaemonVoiceInferenceModelsRemoveRequestSchema = lazyZodSchema(() => z.strictObject({
  packId: z.string().check(z.minLength(1)),
}));
export type DaemonVoiceInferenceModelsRemoveRequest = z.infer<typeof DaemonVoiceInferenceModelsRemoveRequestSchema>;

export const DaemonVoiceInferenceModelsRemoveResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({ ok: z.literal(true) }),
  DaemonVoiceInferenceErrorSchema,
]));
export type DaemonVoiceInferenceModelsRemoveResponse = z.infer<typeof DaemonVoiceInferenceModelsRemoveResponseSchema>;

export const DaemonVoiceInferenceModelsStatusRequestSchema = lazyZodSchema(() => z.strictObject({
  packIds: z.optional(z.array(z.string().check(z.minLength(1)))),
}));
export type DaemonVoiceInferenceModelsStatusRequest = z.infer<typeof DaemonVoiceInferenceModelsStatusRequestSchema>;

export const DaemonVoiceInferenceModelsWarmRequestSchema = lazyZodSchema(() => z.strictObject({
  packIds: z.array(z.string().check(z.minLength(1))).check(z.minLength(1)),
}));
export type DaemonVoiceInferenceModelsWarmRequest = z.infer<typeof DaemonVoiceInferenceModelsWarmRequestSchema>;

export const DaemonVoiceInferenceModelsStatusResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({
    ok: z.literal(true),
    models: z.array(DaemonVoiceInferenceModelStatusSchema),
  }),
  DaemonVoiceInferenceErrorSchema,
]));
export type DaemonVoiceInferenceModelsStatusResponse = z.infer<typeof DaemonVoiceInferenceModelsStatusResponseSchema>;

export const DaemonVoiceInferenceModelsWarmResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({
    ok: z.literal(true),
    models: z.array(DaemonVoiceInferenceModelStatusSchema),
  }),
  DaemonVoiceInferenceErrorSchema,
]));
export type DaemonVoiceInferenceModelsWarmResponse = z.infer<typeof DaemonVoiceInferenceModelsWarmResponseSchema>;

export const DaemonVoiceInferenceTtsStreamStartRequestSchema = lazyZodSchema(() => z.strictObject({
  requestId: z.string().check(z.minLength(1), z.maxLength(DAEMON_VOICE_INFERENCE_REQUEST_ID_MAX_LENGTH)),
  text: z.string().check(z.minLength(1), z.maxLength(200_000)),
  packId: z._default(z.nullable(z.string().check(z.minLength(1))), null),
  voiceId: z._default(z.nullable(z.string().check(z.minLength(1))), null),
  speed: z._default(z.nullable(z.number().check(z.minimum(0.5), z.maximum(2))), null),
  output: z._default(DaemonVoiceInferenceAudioOutputSchema, { codec: 'wav', mimeType: 'audio/wav' }),
  prefetchDepth: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(2))),
  diagnostics: z.optional(VoiceSpeechDiagnosticsCaptureContextV1Schema),
}));
export type DaemonVoiceInferenceTtsStreamStartRequest = z.infer<typeof DaemonVoiceInferenceTtsStreamStartRequestSchema>;

export const DaemonVoiceInferenceTtsStreamStartResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({
    ok: z.literal(true),
    requestId: z.string().check(z.minLength(1)),
    streamId: DaemonVoiceInferenceStreamIdSchema,
    generation: DaemonVoiceInferenceStreamGenerationSchema,
    segmentCount: DaemonVoiceInferenceSegmentCountSchema,
    output: DaemonVoiceInferenceAudioOutputSchema,
  }),
  DaemonVoiceInferenceErrorSchema,
]));
export type DaemonVoiceInferenceTtsStreamStartResponse = z.infer<typeof DaemonVoiceInferenceTtsStreamStartResponseSchema>;

export const DaemonVoiceInferenceTtsStreamSegmentAudioSchema = lazyZodSchema(() => z.strictObject({
  contentBase64: z.string().check(z.minLength(1), z.maxLength(DAEMON_VOICE_INFERENCE_TTS_STREAM_SEGMENT_AUDIO_BASE64_MAX_LENGTH)),
  sizeBytes: z.number().check(z.int(), z.nonnegative()),
}));
export type DaemonVoiceInferenceTtsStreamSegmentAudio = z.infer<typeof DaemonVoiceInferenceTtsStreamSegmentAudioSchema>;

export const DaemonVoiceInferenceTtsStreamEventSchema = lazyZodSchema(() => z.discriminatedUnion('type', [
  z.looseObject({
    type: z.literal('segment'),
    streamId: DaemonVoiceInferenceStreamIdSchema,
    generation: DaemonVoiceInferenceStreamGenerationSchema,
    segmentId: z.string().check(z.minLength(1), z.maxLength(DAEMON_VOICE_INFERENCE_STREAM_ID_MAX_LENGTH)),
    segmentIndex: DaemonVoiceInferenceSegmentIndexSchema,
    segmentCount: DaemonVoiceInferenceSegmentCountSchema,
    text: z.string().check(z.minLength(1), z.maxLength(DAEMON_VOICE_INFERENCE_TTS_STREAM_SEGMENT_TEXT_MAX_LENGTH)),
    textRange: z.strictObject({
      start: z.number().check(z.int(), z.minimum(0)),
      end: z.number().check(z.int(), z.minimum(0)),
    }),
    textHash: z.string().check(z.minLength(1), z.maxLength(128)),
    output: DaemonVoiceInferenceAudioOutputSchema,
    audio: DaemonVoiceInferenceTtsStreamSegmentAudioSchema,
    isLastSegment: z.boolean(),
  }),
  z.looseObject({
    type: z.literal('done'),
    streamId: DaemonVoiceInferenceStreamIdSchema,
    generation: DaemonVoiceInferenceStreamGenerationSchema,
  }),
  z.looseObject({
    type: z.literal('error'),
    streamId: DaemonVoiceInferenceStreamIdSchema,
    generation: DaemonVoiceInferenceStreamGenerationSchema,
    segmentId: z._default(z.nullable(z.string().check(z.minLength(1), z.maxLength(DAEMON_VOICE_INFERENCE_STREAM_ID_MAX_LENGTH))), null),
    segmentIndex: z._default(z.nullable(DaemonVoiceInferenceSegmentIndexSchema), null),
    errorCode: DaemonVoiceInferenceErrorCodeSchema,
    error: z.string().check(z.minLength(1)),
    retryable: z._default(z.boolean(), false),
  }),
]));
export type DaemonVoiceInferenceTtsStreamEvent = z.infer<typeof DaemonVoiceInferenceTtsStreamEventSchema>;

export const DaemonVoiceInferenceTtsStreamNextRequestSchema = lazyZodSchema(() => z.strictObject({
  streamId: DaemonVoiceInferenceStreamIdSchema,
  generation: DaemonVoiceInferenceStreamGenerationSchema,
}));
export type DaemonVoiceInferenceTtsStreamNextRequest = z.infer<typeof DaemonVoiceInferenceTtsStreamNextRequestSchema>;

export const DaemonVoiceInferenceTtsStreamNextResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({
    ok: z.literal(true),
    streamId: DaemonVoiceInferenceStreamIdSchema,
    generation: DaemonVoiceInferenceStreamGenerationSchema,
    event: DaemonVoiceInferenceTtsStreamEventSchema,
  }),
  DaemonVoiceInferenceErrorSchema,
]));
export type DaemonVoiceInferenceTtsStreamNextResponse = z.infer<typeof DaemonVoiceInferenceTtsStreamNextResponseSchema>;

export const DaemonVoiceInferenceTtsStreamAckRequestSchema = lazyZodSchema(() => z.strictObject({
  streamId: DaemonVoiceInferenceStreamIdSchema,
  generation: DaemonVoiceInferenceStreamGenerationSchema,
  segmentId: z.string().check(z.minLength(1), z.maxLength(DAEMON_VOICE_INFERENCE_STREAM_ID_MAX_LENGTH)),
  segmentIndex: DaemonVoiceInferenceSegmentIndexSchema,
}));
export type DaemonVoiceInferenceTtsStreamAckRequest = z.infer<typeof DaemonVoiceInferenceTtsStreamAckRequestSchema>;

export const DaemonVoiceInferenceTtsStreamAckResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({
    ok: z.literal(true),
    streamId: DaemonVoiceInferenceStreamIdSchema,
    generation: DaemonVoiceInferenceStreamGenerationSchema,
    ackedSegmentIndex: DaemonVoiceInferenceSegmentIndexSchema,
    complete: z.boolean(),
  }),
  DaemonVoiceInferenceErrorSchema,
]));
export type DaemonVoiceInferenceTtsStreamAckResponse = z.infer<typeof DaemonVoiceInferenceTtsStreamAckResponseSchema>;

export const DaemonVoiceInferenceTtsStreamCancelReasonSchema = lazyZodSchema(() => z.enum([
  'client_abort',
  'barge_in',
  'stale_generation',
  'client_dispose',
]));
export type DaemonVoiceInferenceTtsStreamCancelReason = z.infer<typeof DaemonVoiceInferenceTtsStreamCancelReasonSchema>;

export const DaemonVoiceInferenceTtsStreamCancelRequestSchema = lazyZodSchema(() => z.strictObject({
  streamId: DaemonVoiceInferenceStreamIdSchema,
  generation: DaemonVoiceInferenceStreamGenerationSchema,
  reason: z._default(DaemonVoiceInferenceTtsStreamCancelReasonSchema, 'client_abort'),
}));
export type DaemonVoiceInferenceTtsStreamCancelRequest = z.infer<typeof DaemonVoiceInferenceTtsStreamCancelRequestSchema>;

export const DaemonVoiceInferenceTtsStreamCancelResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({
    ok: z.literal(true),
    streamId: DaemonVoiceInferenceStreamIdSchema,
    generation: DaemonVoiceInferenceStreamGenerationSchema,
  }),
  DaemonVoiceInferenceErrorSchema,
]));
export type DaemonVoiceInferenceTtsStreamCancelResponse = z.infer<typeof DaemonVoiceInferenceTtsStreamCancelResponseSchema>;

export const DaemonVoiceInferenceTtsStreamStateSchema = lazyZodSchema(() => z.enum(['open', 'error', 'closed']));
export type DaemonVoiceInferenceTtsStreamState = z.infer<typeof DaemonVoiceInferenceTtsStreamStateSchema>;

export const DaemonVoiceInferenceSttUploadInitRequestSchema = lazyZodSchema(() => z.strictObject({
  requestId: z.string().check(z.minLength(1), z.maxLength(DAEMON_VOICE_INFERENCE_REQUEST_ID_MAX_LENGTH)),
  sizeBytes: z.number().check(z.int(), z.positive()),
  inputMimeType: z.string().check(z.minLength(1)),
}));
export type DaemonVoiceInferenceSttUploadInitRequest = z.infer<typeof DaemonVoiceInferenceSttUploadInitRequestSchema>;

export const DaemonVoiceInferenceSttUploadInitResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({
    success: z.literal(true),
    uploadId: TransferSessionIdSchema,
    chunkSizeBytes: z.number().check(z.int(), z.positive()),
    recipientPublicKeyBase64: z.string().check(z.minLength(1)),
  }),
  z.looseObject({
    success: z.literal(false),
    error: z.string().check(z.minLength(1)),
    errorCode: z.optional(z.string().check(z.minLength(1))),
  }),
]));
export type DaemonVoiceInferenceSttUploadInitResponse = z.infer<typeof DaemonVoiceInferenceSttUploadInitResponseSchema>;

export const DaemonVoiceInferenceSttUploadChunkRequestSchema = lazyZodSchema(() => z.looseObject({
  uploadId: TransferSessionIdSchema,
  index: z.number().check(z.int(), z.minimum(0)),
  payloadBase64: z.string().check(z.minLength(1)),
  encryptedDataKeyEnvelopeBase64: z.string().check(z.minLength(1)),
}));
export type DaemonVoiceInferenceSttUploadChunkRequest = z.infer<typeof DaemonVoiceInferenceSttUploadChunkRequestSchema>;

export const DaemonVoiceInferenceSttUploadChunkResponseSchema = lazyZodSchema(() => z.looseObject({
  success: z.boolean(),
  error: z.optional(z.string().check(z.minLength(1))),
  errorCode: z.optional(z.string().check(z.minLength(1))),
}));
export type DaemonVoiceInferenceSttUploadChunkResponse = z.infer<typeof DaemonVoiceInferenceSttUploadChunkResponseSchema>;

export const DaemonVoiceInferenceSttUploadFinalizeRequestSchema = lazyZodSchema(() => z.looseObject({
  uploadId: TransferSessionIdSchema,
}));
export type DaemonVoiceInferenceSttUploadFinalizeRequest = z.infer<typeof DaemonVoiceInferenceSttUploadFinalizeRequestSchema>;

export const DaemonVoiceInferenceSttUploadFinalizeResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({
    success: z.literal(true),
    uploadId: TransferSessionIdSchema,
    path: z.string().check(z.minLength(1)),
    sizeBytes: z.number().check(z.int(), z.nonnegative()),
    sha256: z.string().check(z.minLength(1)),
  }),
  z.looseObject({
    success: z.literal(false),
    error: z.string().check(z.minLength(1)),
    errorCode: z.optional(z.string().check(z.minLength(1))),
  }),
]));
export type DaemonVoiceInferenceSttUploadFinalizeResponse = z.infer<typeof DaemonVoiceInferenceSttUploadFinalizeResponseSchema>;

export const DaemonVoiceInferenceSttUploadAbortRequestSchema = lazyZodSchema(() => z.looseObject({
  uploadId: TransferSessionIdSchema,
}));
export type DaemonVoiceInferenceSttUploadAbortRequest = z.infer<typeof DaemonVoiceInferenceSttUploadAbortRequestSchema>;

export const DaemonVoiceInferenceSttUploadAbortResponseSchema = lazyZodSchema(() => z.looseObject({
  success: z.boolean(),
  error: z.optional(z.string().check(z.minLength(1))),
  errorCode: z.optional(z.string().check(z.minLength(1))),
}));
export type DaemonVoiceInferenceSttUploadAbortResponse = z.infer<typeof DaemonVoiceInferenceSttUploadAbortResponseSchema>;

export const DaemonVoiceInferenceSttTranscribeRequestSchema = lazyZodSchema(() => z.strictObject({
  requestId: z.string().check(z.minLength(1), z.maxLength(DAEMON_VOICE_INFERENCE_REQUEST_ID_MAX_LENGTH)),
  uploadId: TransferSessionIdSchema,
  packId: z._default(z.nullable(z.string().check(z.minLength(1))), null),
  language: z._default(z.nullable(z.string().check(z.minLength(1))), null),
  normalization: DaemonVoiceInferenceNormalizationDecisionSchema,
  diagnostics: z.optional(VoiceSpeechDiagnosticsCaptureContextV1Schema),
}));
export type DaemonVoiceInferenceSttTranscribeRequest = z.infer<typeof DaemonVoiceInferenceSttTranscribeRequestSchema>;

export const DaemonVoiceInferenceSttTranscribeResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({
    ok: z.literal(true),
    requestId: z.string().check(z.minLength(1)),
    text: z.string(),
    language: z._default(z.nullable(z.string().check(z.minLength(1))), null),
    modelPackId: z._default(z.nullable(z.string().check(z.minLength(1))), null),
  }),
  DaemonVoiceInferenceErrorSchema,
]));
export type DaemonVoiceInferenceSttTranscribeResponse = z.infer<typeof DaemonVoiceInferenceSttTranscribeResponseSchema>;

export const DaemonVoiceInferenceSttCancelRequestSchema = lazyZodSchema(() => z.looseObject({
  requestId: z.string().check(z.minLength(1), z.maxLength(DAEMON_VOICE_INFERENCE_REQUEST_ID_MAX_LENGTH)),
}));
export type DaemonVoiceInferenceSttCancelRequest = z.infer<typeof DaemonVoiceInferenceSttCancelRequestSchema>;

export const DaemonVoiceInferenceSttCancelResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({ ok: z.literal(true) }),
  DaemonVoiceInferenceErrorSchema,
]));
export type DaemonVoiceInferenceSttCancelResponse = z.infer<typeof DaemonVoiceInferenceSttCancelResponseSchema>;

export const DaemonVoiceInferenceSttStreamStartRequestSchema = lazyZodSchema(() => z.strictObject({
  requestId: z.string().check(z.minLength(1), z.maxLength(DAEMON_VOICE_INFERENCE_REQUEST_ID_MAX_LENGTH)),
  packId: z._default(z.nullable(z.string().check(z.minLength(1))), null),
  language: z._default(z.nullable(z.string().check(z.minLength(1))), null),
  streamingMode: z.optional(z.enum(['runtime', 'upload_bridge'])),
  format: z._default(DaemonVoiceInferenceSttStreamPcmFormatSchema, DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT),
  diagnostics: z.optional(VoiceSpeechDiagnosticsCaptureContextV1Schema),
  peerApplicationEncryption: z.optional(PeerApplicationEncryptionAuthorityBindingV1Schema),
}));
export type DaemonVoiceInferenceSttStreamStartRequest = z.infer<typeof DaemonVoiceInferenceSttStreamStartRequestSchema>;

export const DaemonVoiceInferenceSttStreamStartResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({
    ok: z.literal(true),
    requestId: z.string().check(z.minLength(1)),
    streamId: DaemonVoiceInferenceStreamIdSchema,
    generation: DaemonVoiceInferenceStreamGenerationSchema,
    ackSeq: DaemonVoiceInferenceStreamAckSeqSchema,
    format: DaemonVoiceInferenceSttStreamPcmFormatSchema,
    peerApplicationEncryption: z.optional(PeerApplicationEncryptionStartResponseV1Schema),
  }),
  DaemonVoiceInferenceErrorSchema,
]));
export type DaemonVoiceInferenceSttStreamStartResponse = z.infer<typeof DaemonVoiceInferenceSttStreamStartResponseSchema>;

export const DaemonVoiceInferenceSttStreamEventSchema = lazyZodSchema(() => z.discriminatedUnion('type', [
  z.looseObject({
    type: z.literal('partial'),
    seq: DaemonVoiceInferenceStreamSeqSchema,
    text: z.string(),
    isEndpoint: z._default(z.boolean(), false),
    confidence: z._default(z.nullable(z.number().check(z.minimum(0), z.maximum(1))), null),
  }),
  z.looseObject({
    type: z.literal('endpoint'),
    seq: DaemonVoiceInferenceStreamSeqSchema,
    transcript: z._default(z.string(), ''),
    reason: z._default(z.enum(['vad', 'timeout', 'manual', 'eof']), 'vad'),
  }),
  z.looseObject({
    type: z.literal('final'),
    seq: DaemonVoiceInferenceStreamSeqSchema,
    text: z.string(),
    language: z._default(z.nullable(z.string().check(z.minLength(1))), null),
    modelPackId: z._default(z.nullable(z.string().check(z.minLength(1))), null),
  }),
]));
export type DaemonVoiceInferenceSttStreamEvent = z.infer<typeof DaemonVoiceInferenceSttStreamEventSchema>;

export const DaemonVoiceInferenceSttStreamChunkRequestSchema = lazyZodSchema(() => z.strictObject({
  streamId: DaemonVoiceInferenceStreamIdSchema,
  generation: DaemonVoiceInferenceStreamGenerationSchema,
  seq: DaemonVoiceInferenceStreamSeqSchema,
  pcm16Base64: z.string().check(z.minLength(1), z.maxLength(DAEMON_VOICE_INFERENCE_STT_STREAM_CHUNK_BASE64_MAX_LENGTH)),
}));
export type DaemonVoiceInferenceSttStreamChunkRequest = z.infer<typeof DaemonVoiceInferenceSttStreamChunkRequestSchema>;

export const DaemonVoiceInferenceSttStreamChunkResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({
    ok: z.literal(true),
    streamId: DaemonVoiceInferenceStreamIdSchema,
    generation: DaemonVoiceInferenceStreamGenerationSchema,
    ackSeq: DaemonVoiceInferenceStreamAckSeqSchema,
    events: z._default(z.array(DaemonVoiceInferenceSttStreamEventSchema), []),
  }),
  DaemonVoiceInferenceErrorSchema,
]));
export type DaemonVoiceInferenceSttStreamChunkResponse = z.infer<typeof DaemonVoiceInferenceSttStreamChunkResponseSchema>;

export const DaemonVoiceInferenceSttStreamFinishRequestSchema = lazyZodSchema(() => z.strictObject({
  streamId: DaemonVoiceInferenceStreamIdSchema,
  generation: DaemonVoiceInferenceStreamGenerationSchema,
  finalSeq: DaemonVoiceInferenceStreamSeqSchema,
}));
export type DaemonVoiceInferenceSttStreamFinishRequest = z.infer<typeof DaemonVoiceInferenceSttStreamFinishRequestSchema>;

export const DaemonVoiceInferenceSttStreamFinishResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({
    ok: z.literal(true),
    streamId: DaemonVoiceInferenceStreamIdSchema,
    generation: DaemonVoiceInferenceStreamGenerationSchema,
    ackSeq: DaemonVoiceInferenceStreamAckSeqSchema,
    finalText: z.string(),
    language: z._default(z.nullable(z.string().check(z.minLength(1))), null),
    modelPackId: z._default(z.nullable(z.string().check(z.minLength(1))), null),
    events: z._default(z.array(DaemonVoiceInferenceSttStreamEventSchema), []),
  }),
  DaemonVoiceInferenceErrorSchema,
]));
export type DaemonVoiceInferenceSttStreamFinishResponse = z.infer<typeof DaemonVoiceInferenceSttStreamFinishResponseSchema>;

export const DaemonVoiceInferenceSttStreamCancelRequestSchema = lazyZodSchema(() => z.strictObject({
  streamId: DaemonVoiceInferenceStreamIdSchema,
  generation: DaemonVoiceInferenceStreamGenerationSchema,
}));
export type DaemonVoiceInferenceSttStreamCancelRequest = z.infer<typeof DaemonVoiceInferenceSttStreamCancelRequestSchema>;

export const DaemonVoiceInferenceSttStreamCancelResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({
    ok: z.literal(true),
    streamId: DaemonVoiceInferenceStreamIdSchema,
    generation: DaemonVoiceInferenceStreamGenerationSchema,
  }),
  DaemonVoiceInferenceErrorSchema,
]));
export type DaemonVoiceInferenceSttStreamCancelResponse = z.infer<typeof DaemonVoiceInferenceSttStreamCancelResponseSchema>;

export const DaemonVoiceInferenceSttStreamStateSchema = lazyZodSchema(() => z.enum(['open', 'finishing', 'closed']));
export type DaemonVoiceInferenceSttStreamState = z.infer<typeof DaemonVoiceInferenceSttStreamStateSchema>;

export const DaemonVoiceInferenceSttStreamStatusRequestSchema = lazyZodSchema(() => z.strictObject({
  streamId: DaemonVoiceInferenceStreamIdSchema,
  generation: z.optional(DaemonVoiceInferenceStreamGenerationSchema),
}));
export type DaemonVoiceInferenceSttStreamStatusRequest = z.infer<typeof DaemonVoiceInferenceSttStreamStatusRequestSchema>;

export const DaemonVoiceInferenceSttStreamStatusResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({
    ok: z.literal(true),
    streamId: DaemonVoiceInferenceStreamIdSchema,
    generation: DaemonVoiceInferenceStreamGenerationSchema,
    ackSeq: DaemonVoiceInferenceStreamAckSeqSchema,
    state: DaemonVoiceInferenceSttStreamStateSchema,
  }),
  DaemonVoiceInferenceErrorSchema,
]));
export type DaemonVoiceInferenceSttStreamStatusResponse = z.infer<typeof DaemonVoiceInferenceSttStreamStatusResponseSchema>;
