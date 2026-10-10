import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

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

const VoiceSpeechRequestIdSchema = lazyZodSchema(() => z.string().trim().min(1).max(DAEMON_VOICE_SPEECH_REQUEST_ID_MAX_LENGTH));
const VoiceSpeechRequiredStringSchema = (maxLength: number) => z.string().trim().min(1).max(maxLength);
const VoiceSpeechNullableStringSchema = (maxLength: number) => VoiceSpeechRequiredStringSchema(maxLength).nullable();
const VoiceSpeechOperationErrorSchema = lazyZodSchema(() => z.object({
  ok: z.literal(false),
  errorCode: VoiceProviderOperationErrorCodeSchema,
}).strict());

const VoiceSpeechTransferErrorCodeSchema = lazyZodSchema(() => z.enum([
  'invalid_parameters',
  'transfer_not_found',
  'transfer_failed',
  'cancelled',
]));
const VoiceSpeechTransferFailureSchema = lazyZodSchema(() => z.object({
  success: z.literal(false),
  error: VoiceSpeechTransferErrorCodeSchema,
  errorCode: VoiceSpeechTransferErrorCodeSchema,
}).strict());
const VoiceSpeechTransferSuccessSchema = lazyZodSchema(() => z.object({ success: z.literal(true) }).strict());

export const DaemonVoiceSpeechCatalogRequestSchema = lazyZodSchema(() => z.object({
  target: asProtocolZod(PluginContributionIdentityV1Schema),
  catalog: z.enum(['models', 'voices']),
}).strict());
export type DaemonVoiceSpeechCatalogRequest = z.infer<
  typeof DaemonVoiceSpeechCatalogRequestSchema
>;

/**
 * The Account Settings revision is an admission fence. The daemon reads the
 * matching canonical settings snapshot; the UI remains the sole CAS/patch owner.
 */
export const DaemonVoiceSpeechSettingsActionRequestSchema = lazyZodSchema(() => z.object({
  target: asProtocolZod(PluginContributionIdentityV1Schema),
  actionId: asProtocolZod(PluginContributionLocalIdSchema),
  expectedSettingsVersion: z.number().int().nonnegative(),
}).strict());
export type DaemonVoiceSpeechSettingsActionRequest = z.infer<
  typeof DaemonVoiceSpeechSettingsActionRequestSchema
>;

export const DaemonVoiceSpeechSettingsActionResponseSchema = lazyZodSchema(() => z.union([
  z.object({
    ok: z.literal(true),
    patch: z.record(PluginSettingFieldIdV2Schema, PluginJsonValueV2Schema),
  }).strict(),
  VoiceSpeechOperationErrorSchema,
]));
export type DaemonVoiceSpeechSettingsActionResponse = z.infer<
  typeof DaemonVoiceSpeechSettingsActionResponseSchema
>;

export const DaemonVoiceSpeechTranscribeUploadInitRequestSchema = lazyZodSchema(() => z.object({
  target: asProtocolZod(PluginContributionIdentityV1Schema),
  sizeBytes: z.number().int().positive().max(DAEMON_VOICE_SPEECH_INPUT_MAX_BYTES),
  mimeType: VoiceSpeechInputMimeTypeSchema,
  fileName: z.string().trim().min(1).max(256).regex(/^[^/\\\u0000-\u001f\u007f]+$/u),
}).strict());
export type DaemonVoiceSpeechTranscribeUploadInitRequest = z.infer<
  typeof DaemonVoiceSpeechTranscribeUploadInitRequestSchema
>;

export const DaemonVoiceSpeechTranscribeUploadInitResponseSchema = lazyZodSchema(() => z.union([
  z.object({
    success: z.literal(true),
    uploadId: TransferSessionIdSchema,
    chunkSizeBytes: z.number().int().positive().max(DAEMON_VOICE_SPEECH_TRANSFER_CHUNK_MAX_BYTES),
    recipientPublicKeyBase64: z.string().min(1).max(DAEMON_VOICE_SPEECH_TRANSFER_KEY_ENVELOPE_MAX_LENGTH),
  }).strict(),
  VoiceSpeechTransferFailureSchema,
]));
export type DaemonVoiceSpeechTranscribeUploadInitResponse = z.infer<
  typeof DaemonVoiceSpeechTranscribeUploadInitResponseSchema
>;

export const DaemonVoiceSpeechTranscribeUploadChunkRequestSchema = lazyZodSchema(() => z.object({
  uploadId: TransferSessionIdSchema,
  index: z.number().int().min(0),
  payloadBase64: z.string().min(1).max(DAEMON_VOICE_SPEECH_TRANSFER_CHUNK_ENCODED_MAX_LENGTH),
  encryptedDataKeyEnvelopeBase64: z.string().min(1).max(DAEMON_VOICE_SPEECH_TRANSFER_KEY_ENVELOPE_MAX_LENGTH),
}).strict());
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

export const DaemonVoiceSpeechTranscribeUploadFinalizeRequestSchema = lazyZodSchema(() => z.object({
  uploadId: TransferSessionIdSchema,
}).strict());
export type DaemonVoiceSpeechTranscribeUploadFinalizeRequest = z.infer<
  typeof DaemonVoiceSpeechTranscribeUploadFinalizeRequestSchema
>;

export const DaemonVoiceSpeechTranscribeUploadFinalizeResponseSchema = lazyZodSchema(() => z.union([
  z.object({
    success: z.literal(true),
    uploadId: TransferSessionIdSchema,
    sizeBytes: z.number().int().positive().max(DAEMON_VOICE_SPEECH_INPUT_MAX_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict(),
  VoiceSpeechTransferFailureSchema,
]));
export type DaemonVoiceSpeechTranscribeUploadFinalizeResponse = z.infer<
  typeof DaemonVoiceSpeechTranscribeUploadFinalizeResponseSchema
>;

export const DaemonVoiceSpeechTranscribeUploadAbortRequestSchema = lazyZodSchema(() => z.object({
  uploadId: TransferSessionIdSchema,
}).strict());
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

export const DaemonVoiceSpeechTranscribeRequestSchema = lazyZodSchema(() => z.object({
  target: asProtocolZod(PluginContributionIdentityV1Schema),
  requestId: VoiceSpeechRequestIdSchema,
  mimeType: VoiceSpeechInputMimeTypeSchema,
  uploadId: TransferSessionIdSchema,
  capturePurpose: z.enum(['conversation', 'dictation']).optional(),
}).strict());
export type DaemonVoiceSpeechTranscribeRequest = z.infer<
  typeof DaemonVoiceSpeechTranscribeRequestSchema
>;

export const DaemonVoiceSpeechDownloadChunkRequestSchema = lazyZodSchema(() => z.object({
  downloadId: TransferSessionIdSchema,
  index: z.number().int().min(0),
}).strict());
export type DaemonVoiceSpeechDownloadChunkRequest = z.infer<
  typeof DaemonVoiceSpeechDownloadChunkRequestSchema
>;

export const DaemonVoiceSpeechDownloadChunkResponseSchema = lazyZodSchema(() => z.union([
  z.object({
    success: z.literal(true),
    payloadBase64: z.string().min(1).max(DAEMON_VOICE_SPEECH_TRANSFER_CHUNK_ENCODED_MAX_LENGTH),
    encryptedDataKeyEnvelopeBase64: z.string().min(1).max(DAEMON_VOICE_SPEECH_TRANSFER_KEY_ENVELOPE_MAX_LENGTH),
    isLast: z.boolean(),
  }).strict(),
  VoiceSpeechTransferFailureSchema,
]));
export type DaemonVoiceSpeechDownloadChunkResponse = z.infer<
  typeof DaemonVoiceSpeechDownloadChunkResponseSchema
>;

export const DaemonVoiceSpeechDownloadFinalizeRequestSchema = lazyZodSchema(() => z.object({
  downloadId: TransferSessionIdSchema,
}).strict());
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

export const DaemonVoiceSpeechDownloadAbortRequestSchema = lazyZodSchema(() => z.object({
  downloadId: TransferSessionIdSchema,
}).strict());
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

export const DaemonVoiceSpeechSynthesizeRequestSchema = lazyZodSchema(() => z.object({
  target: asProtocolZod(PluginContributionIdentityV1Schema),
  requestId: VoiceSpeechRequestIdSchema,
  input: VoiceSpeechRequiredStringSchema(200_000),
  /** Only the admitted declared voice field; Account credentials and remaining settings stay daemon-owned. */
  voicePreference: SessionVoicePreferenceV1Schema.optional(),
  recipientPublicKeyBase64: z.string().trim().min(1).max(DAEMON_VOICE_SPEECH_TRANSFER_KEY_ENVELOPE_MAX_LENGTH),
}).strict());
export type DaemonVoiceSpeechSynthesizeRequest = z.infer<
  typeof DaemonVoiceSpeechSynthesizeRequestSchema
>;

export const DaemonVoiceSpeechTranscribeResponseSchema = lazyZodSchema(() => z.union([
  z.object({
    ok: z.literal(true),
    requestId: VoiceSpeechRequestIdSchema,
    text: z.string().max(1_000_000),
  }).strict(),
  VoiceSpeechOperationErrorSchema,
]));
export type DaemonVoiceSpeechTranscribeResponse = z.infer<
  typeof DaemonVoiceSpeechTranscribeResponseSchema
>;

export const DaemonVoiceSpeechSynthesizeResponseSchema = lazyZodSchema(() => z.union([
  z.object({
    ok: z.literal(true),
    requestId: VoiceSpeechRequestIdSchema,
    downloadId: TransferSessionIdSchema,
    chunkSizeBytes: z.number().int().positive().max(DAEMON_VOICE_SPEECH_TRANSFER_CHUNK_MAX_BYTES),
    sizeBytes: z.number().int().positive().max(DAEMON_VOICE_SPEECH_OUTPUT_MAX_BYTES),
    mimeType: z.enum(['audio/mpeg', 'audio/wav']),
    appliedVoice: SessionVoicePreferenceV1Schema.nullable().optional(),
  }).strict(),
  VoiceSpeechOperationErrorSchema,
]));
export type DaemonVoiceSpeechSynthesizeResponse = z.infer<
  typeof DaemonVoiceSpeechSynthesizeResponseSchema
>;
