import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import {
  PluginContributionIdentityV1Schema,
  PluginContributionLocalIdSchema,
} from '../plugins/contributionIdentity.js';
import { PluginJsonValueV2Schema } from '../plugins/contributions/publicTypes.js';
import { PluginSettingFieldIdV2Schema } from '../plugins/contributions/settings.js';
import {
  VOICE_SPEECH_OUTPUT_MAX_BYTES,
  VoiceSpeechInputMimeTypeSchema,
} from '../plugins/contributions/voiceProviders.js';
import { TransferSessionIdSchema } from '../transfers/sessions/transferSessionIds.js';
import { VoiceProviderOperationErrorCodeSchema } from '../voice/providerOperations.js';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";
import { SessionVoicePreferenceV1Schema } from '../sessions/instructions/sessionVoicePreferenceV1.js';

export const DAEMON_VOICE_SPEECH_INPUT_MAX_BYTES = 8 * 1024 * 1024;
export const DAEMON_VOICE_SPEECH_OUTPUT_MAX_BYTES = VOICE_SPEECH_OUTPUT_MAX_BYTES;
export const DAEMON_VOICE_SPEECH_REQUEST_ID_MAX_LENGTH = 128;

export const DAEMON_VOICE_SPEECH_TRANSFER_CHUNK_ENCODED_MAX_LENGTH = 4 * 1024 * 1024;
export const DAEMON_VOICE_SPEECH_TRANSFER_KEY_ENVELOPE_MAX_LENGTH = 64 * 1024;
const TRANSFER_ENCRYPTED_CHUNK_OVERHEAD_BYTES = 1 + 12 + 16;
export const DAEMON_VOICE_SPEECH_TRANSFER_CHUNK_MAX_BYTES =
  Math.floor(DAEMON_VOICE_SPEECH_TRANSFER_CHUNK_ENCODED_MAX_LENGTH / 4) * 3
  - TRANSFER_ENCRYPTED_CHUNK_OVERHEAD_BYTES;

const VoiceSpeechRequestIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(DAEMON_VOICE_SPEECH_REQUEST_ID_MAX_LENGTH)));
const VoiceSpeechRequiredStringSchema = (maxLength: number) => z.string().check(z.trim(), z.minLength(1), z.maxLength(maxLength));
const VoiceSpeechNullableStringSchema = (maxLength: number) => z.nullable(VoiceSpeechRequiredStringSchema(maxLength));
const VoiceSpeechOperationErrorSchema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(false),
  errorCode: VoiceProviderOperationErrorCodeSchema,
}));

const VoiceSpeechTransferErrorCodeSchema = lazyZodSchema(() => z.enum([
  'invalid_parameters',
  'transfer_not_found',
  'transfer_failed',
  'cancelled',
]));
const VoiceSpeechTransferFailureSchema = lazyZodSchema(() => z.strictObject({
  success: z.literal(false),
  error: VoiceSpeechTransferErrorCodeSchema,
  errorCode: VoiceSpeechTransferErrorCodeSchema,
}));
const VoiceSpeechTransferSuccessSchema = lazyZodSchema(() => z.strictObject({ success: z.literal(true) }));

export const DaemonVoiceSpeechCatalogRequestSchema = lazyZodSchema(() => z.strictObject({
  target: asProtocolZod(PluginContributionIdentityV1Schema),
  catalog: z.enum(['models', 'voices']),
}));
export type DaemonVoiceSpeechCatalogRequest = z.infer<
  typeof DaemonVoiceSpeechCatalogRequestSchema
>;

/**
 * The Account Settings revision is an admission fence. The daemon reads the
 * matching canonical settings snapshot; the UI remains the sole CAS/patch owner.
 */
export const DaemonVoiceSpeechSettingsActionRequestSchema = lazyZodSchema(() => z.strictObject({
  target: asProtocolZod(PluginContributionIdentityV1Schema),
  actionId: asProtocolZod(PluginContributionLocalIdSchema),
  expectedSettingsVersion: z.number().check(z.int(), z.nonnegative()),
}));
export type DaemonVoiceSpeechSettingsActionRequest = z.infer<
  typeof DaemonVoiceSpeechSettingsActionRequestSchema
>;

export const DaemonVoiceSpeechSettingsActionResponseSchema = lazyZodSchema(() => z.union([
  z.strictObject({
    ok: z.literal(true),
    patch: z.record(PluginSettingFieldIdV2Schema, PluginJsonValueV2Schema),
  }),
  VoiceSpeechOperationErrorSchema,
]));
export type DaemonVoiceSpeechSettingsActionResponse = z.infer<
  typeof DaemonVoiceSpeechSettingsActionResponseSchema
>;

export const DaemonVoiceSpeechTranscribeUploadInitRequestSchema = lazyZodSchema(() => z.strictObject({
  target: asProtocolZod(PluginContributionIdentityV1Schema),
  sizeBytes: z.number().check(z.int(), z.positive(), z.maximum(DAEMON_VOICE_SPEECH_INPUT_MAX_BYTES)),
  mimeType: VoiceSpeechInputMimeTypeSchema,
  fileName: z.string().check(z.trim(), z.minLength(1), z.maxLength(256), z.regex(/^[^/\\\u0000-\u001f\u007f]+$/u)),
}));
export type DaemonVoiceSpeechTranscribeUploadInitRequest = z.infer<
  typeof DaemonVoiceSpeechTranscribeUploadInitRequestSchema
>;

export const DaemonVoiceSpeechTranscribeUploadInitResponseSchema = lazyZodSchema(() => z.union([
  z.strictObject({
    success: z.literal(true),
    uploadId: TransferSessionIdSchema,
    chunkSizeBytes: z.number().check(z.int(), z.positive(), z.maximum(DAEMON_VOICE_SPEECH_TRANSFER_CHUNK_MAX_BYTES)),
    recipientPublicKeyBase64: z.string().check(z.minLength(1), z.maxLength(DAEMON_VOICE_SPEECH_TRANSFER_KEY_ENVELOPE_MAX_LENGTH)),
  }),
  VoiceSpeechTransferFailureSchema,
]));
export type DaemonVoiceSpeechTranscribeUploadInitResponse = z.infer<
  typeof DaemonVoiceSpeechTranscribeUploadInitResponseSchema
>;

export const DaemonVoiceSpeechTranscribeUploadChunkRequestSchema = lazyZodSchema(() => z.strictObject({
  uploadId: TransferSessionIdSchema,
  index: z.number().check(z.int(), z.minimum(0)),
  payloadBase64: z.string().check(z.minLength(1), z.maxLength(DAEMON_VOICE_SPEECH_TRANSFER_CHUNK_ENCODED_MAX_LENGTH)),
  encryptedDataKeyEnvelopeBase64: z.string().check(z.minLength(1), z.maxLength(DAEMON_VOICE_SPEECH_TRANSFER_KEY_ENVELOPE_MAX_LENGTH)),
}));
export type DaemonVoiceSpeechTranscribeUploadChunkRequest = z.infer<
  typeof DaemonVoiceSpeechTranscribeUploadChunkRequestSchema
>;

export const DaemonVoiceSpeechTranscribeUploadChunkResponseSchema = lazyZodSchema(() => z.union([
  VoiceSpeechTransferSuccessSchema,
  VoiceSpeechTransferFailureSchema,
]));
export type DaemonVoiceSpeechTranscribeUploadChunkResponse = z.infer<
  typeof DaemonVoiceSpeechTranscribeUploadChunkResponseSchema
>;

export const DaemonVoiceSpeechTranscribeUploadFinalizeRequestSchema = lazyZodSchema(() => z.strictObject({
  uploadId: TransferSessionIdSchema,
}));
export type DaemonVoiceSpeechTranscribeUploadFinalizeRequest = z.infer<
  typeof DaemonVoiceSpeechTranscribeUploadFinalizeRequestSchema
>;

export const DaemonVoiceSpeechTranscribeUploadFinalizeResponseSchema = lazyZodSchema(() => z.union([
  z.strictObject({
    success: z.literal(true),
    uploadId: TransferSessionIdSchema,
    sizeBytes: z.number().check(z.int(), z.positive(), z.maximum(DAEMON_VOICE_SPEECH_INPUT_MAX_BYTES)),
    sha256: z.string().check(z.regex(/^[a-f0-9]{64}$/u)),
  }),
  VoiceSpeechTransferFailureSchema,
]));
export type DaemonVoiceSpeechTranscribeUploadFinalizeResponse = z.infer<
  typeof DaemonVoiceSpeechTranscribeUploadFinalizeResponseSchema
>;

export const DaemonVoiceSpeechTranscribeUploadAbortRequestSchema = lazyZodSchema(() => z.strictObject({
  uploadId: TransferSessionIdSchema,
}));
export type DaemonVoiceSpeechTranscribeUploadAbortRequest = z.infer<
  typeof DaemonVoiceSpeechTranscribeUploadAbortRequestSchema
>;

export const DaemonVoiceSpeechTranscribeUploadAbortResponseSchema = lazyZodSchema(() => z.union([
  VoiceSpeechTransferSuccessSchema,
  VoiceSpeechTransferFailureSchema,
]));
export type DaemonVoiceSpeechTranscribeUploadAbortResponse = z.infer<
  typeof DaemonVoiceSpeechTranscribeUploadAbortResponseSchema
>;

export const DaemonVoiceSpeechTranscribeRequestSchema = lazyZodSchema(() => z.strictObject({
  target: asProtocolZod(PluginContributionIdentityV1Schema),
  requestId: VoiceSpeechRequestIdSchema,
  mimeType: VoiceSpeechInputMimeTypeSchema,
  uploadId: TransferSessionIdSchema,
  capturePurpose: z.optional(z.enum(['conversation', 'dictation'])),
}));
export type DaemonVoiceSpeechTranscribeRequest = z.infer<
  typeof DaemonVoiceSpeechTranscribeRequestSchema
>;

export const DaemonVoiceSpeechDownloadChunkRequestSchema = lazyZodSchema(() => z.strictObject({
  downloadId: TransferSessionIdSchema,
  index: z.number().check(z.int(), z.minimum(0)),
}));
export type DaemonVoiceSpeechDownloadChunkRequest = z.infer<
  typeof DaemonVoiceSpeechDownloadChunkRequestSchema
>;

export const DaemonVoiceSpeechDownloadChunkResponseSchema = lazyZodSchema(() => z.union([
  z.strictObject({
    success: z.literal(true),
    payloadBase64: z.string().check(z.minLength(1), z.maxLength(DAEMON_VOICE_SPEECH_TRANSFER_CHUNK_ENCODED_MAX_LENGTH)),
    encryptedDataKeyEnvelopeBase64: z.string().check(z.minLength(1), z.maxLength(DAEMON_VOICE_SPEECH_TRANSFER_KEY_ENVELOPE_MAX_LENGTH)),
    isLast: z.boolean(),
  }),
  VoiceSpeechTransferFailureSchema,
]));
export type DaemonVoiceSpeechDownloadChunkResponse = z.infer<
  typeof DaemonVoiceSpeechDownloadChunkResponseSchema
>;

export const DaemonVoiceSpeechDownloadFinalizeRequestSchema = lazyZodSchema(() => z.strictObject({
  downloadId: TransferSessionIdSchema,
}));
export type DaemonVoiceSpeechDownloadFinalizeRequest = z.infer<
  typeof DaemonVoiceSpeechDownloadFinalizeRequestSchema
>;

export const DaemonVoiceSpeechDownloadFinalizeResponseSchema = lazyZodSchema(() => z.union([
  VoiceSpeechTransferSuccessSchema,
  VoiceSpeechTransferFailureSchema,
]));
export type DaemonVoiceSpeechDownloadFinalizeResponse = z.infer<
  typeof DaemonVoiceSpeechDownloadFinalizeResponseSchema
>;

export const DaemonVoiceSpeechDownloadAbortRequestSchema = lazyZodSchema(() => z.strictObject({
  downloadId: TransferSessionIdSchema,
}));
export type DaemonVoiceSpeechDownloadAbortRequest = z.infer<
  typeof DaemonVoiceSpeechDownloadAbortRequestSchema
>;

export const DaemonVoiceSpeechDownloadAbortResponseSchema = lazyZodSchema(() => z.union([
  VoiceSpeechTransferSuccessSchema,
  VoiceSpeechTransferFailureSchema,
]));
export type DaemonVoiceSpeechDownloadAbortResponse = z.infer<
  typeof DaemonVoiceSpeechDownloadAbortResponseSchema
>;

export const DaemonVoiceSpeechSynthesizeRequestSchema = lazyZodSchema(() => z.strictObject({
  target: asProtocolZod(PluginContributionIdentityV1Schema),
  requestId: VoiceSpeechRequestIdSchema,
  input: VoiceSpeechRequiredStringSchema(200_000),
  /** Only the admitted declared voice field; Account credentials and remaining settings stay daemon-owned. */
  voicePreference: z.optional(SessionVoicePreferenceV1Schema),
  recipientPublicKeyBase64: z.string().check(z.trim(), z.minLength(1), z.maxLength(DAEMON_VOICE_SPEECH_TRANSFER_KEY_ENVELOPE_MAX_LENGTH)),
}));
export type DaemonVoiceSpeechSynthesizeRequest = z.infer<
  typeof DaemonVoiceSpeechSynthesizeRequestSchema
>;

export const DaemonVoiceSpeechTranscribeResponseSchema = lazyZodSchema(() => z.union([
  z.strictObject({
    ok: z.literal(true),
    requestId: VoiceSpeechRequestIdSchema,
    text: z.string().check(z.maxLength(1_000_000)),
  }),
  VoiceSpeechOperationErrorSchema,
]));
export type DaemonVoiceSpeechTranscribeResponse = z.infer<
  typeof DaemonVoiceSpeechTranscribeResponseSchema
>;

export const DaemonVoiceSpeechSynthesizeResponseSchema = lazyZodSchema(() => z.union([
  z.strictObject({
    ok: z.literal(true),
    requestId: VoiceSpeechRequestIdSchema,
    downloadId: TransferSessionIdSchema,
    chunkSizeBytes: z.number().check(z.int(), z.positive(), z.maximum(DAEMON_VOICE_SPEECH_TRANSFER_CHUNK_MAX_BYTES)),
    sizeBytes: z.number().check(z.int(), z.positive(), z.maximum(DAEMON_VOICE_SPEECH_OUTPUT_MAX_BYTES)),
    mimeType: z.enum(['audio/mpeg', 'audio/wav']),
    appliedVoice: z.optional(z.nullable(SessionVoicePreferenceV1Schema)),
  }),
  VoiceSpeechOperationErrorSchema,
]));
export type DaemonVoiceSpeechSynthesizeResponse = z.infer<
  typeof DaemonVoiceSpeechSynthesizeResponseSchema
>;
