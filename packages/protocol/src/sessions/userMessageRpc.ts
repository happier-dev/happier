import { z } from 'zod';

import {
  HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1,
  HappierStructuredInputV1Schema as HappierStructuredInputV1EnvelopeSchema,
  RawIngressStructuredInputV1Schema,
  ComposerContentHandleV1Schema,
  MAX_COMPOSER_ATTACHMENT_INSTANCES_V1,
  SESSION_ATTACHMENT_UPLOAD_STRUCTURED_INPUT_PROVENANCE_KIND,
  hasAdmittedComposerAttachmentSelectionV1,
  readAttachmentEnvelopeLocalImagePaths,
  readHappierStructuredInputV1FromMeta,
  readIngressComposerAttachmentSelectionV1,
  sanitizeHappierStructuredInputV1,
  sanitizeSessionStructuredInputMeta,
  type ComposerContentHandleV1,
  type HappierStructuredInputV1 as HappierStructuredInputV1Envelope,
} from '../runtime/input/index.js';
import {
  SessionMediaMessageMetaV1Schema,
  type SessionMediaMessageMetaV1,
} from './messages/sessionMediaV1.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { SessionIdSchema } from './idsV1.js';
import { PendingLocalIdSchema } from './pending/pendingLocalId.js';

type MetadataRecord = Record<string, unknown>;

export {
  HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1,
  HappierStructuredInputV1EnvelopeSchema,
  SESSION_ATTACHMENT_UPLOAD_STRUCTURED_INPUT_PROVENANCE_KIND,
  hasAdmittedComposerAttachmentSelectionV1,
  readAttachmentEnvelopeLocalImagePaths,
  readHappierStructuredInputV1FromMeta,
  readIngressComposerAttachmentSelectionV1,
  sanitizeHappierStructuredInputV1,
};
export type { HappierStructuredInputV1Envelope };

/**
 * The Session send RPC is Message *ingress*, not persistence. Generic sanitization emits the
 * persisted envelope, whose Composer attachments may carry only a durable SessionMedia
 * reference — so on its own it deletes the transfer-owned staged claim a media attachment
 * still carries before the daemon's SessionMedia finalizer has run, and an attachment-only
 * media message then looks blank. The validated ingress arm is therefore carried through
 * intact for that finalizer, which remains the only writer of the persisted form.
 */
export function sanitizeSessionUserMessageSendMeta(
  value: MetadataRecord,
  options: Readonly<{ allowedLocalImagePaths?: ReadonlySet<string>; text?: string }> = {},
): MetadataRecord {
  const sanitized = sanitizeSessionStructuredInputMeta(value, options);
  const ingressComposerAttachments = readIngressComposerAttachmentSelectionV1(value);
  if (!ingressComposerAttachments || ingressComposerAttachments.length === 0) return sanitized;

  const sanitizedEnvelope = sanitized[HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1];
  return {
    ...sanitized,
    [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: {
      ...(sanitizedEnvelope && typeof sanitizedEnvelope === 'object' && !Array.isArray(sanitizedEnvelope)
        ? sanitizedEnvelope as MetadataRecord
        : {}),
      v: 1,
      composerAttachments: ingressComposerAttachments,
    },
  };
}

export const SessionUserMessageSendMetaSchema = z
  .record(z.string(), z.unknown())
  .transform((value) => sanitizeSessionUserMessageSendMeta(value));
export type SessionUserMessageSendMeta = z.infer<typeof SessionUserMessageSendMetaSchema>;

export const SessionUserMessageSendRequestSchema = z.object({
  text: z.string(),
  localId: PendingLocalIdSchema.optional(),
  meta: SessionUserMessageSendMetaSchema.default({}),
}).passthrough().superRefine((request, context) => {
  if (request.text.trim().length > 0) return;
  // Read the boundary's own preserved ingress arm, not the persisted projection: a staged
  // media attachment is a submitted attachment, and the persisted projection cannot hold one.
  if ((readIngressComposerAttachmentSelectionV1(request.meta) ?? []).length > 0) return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['text'],
    message: 'A blank message requires at least one admitted composer attachment.',
  });
});
export type SessionUserMessageSendRequest = z.infer<typeof SessionUserMessageSendRequestSchema>;

/** Invocation-scoped Pending edit preparation through the canonical Session admission lifecycle. */
export const SessionPendingMessageComposerAdmissionPrepareRequestV1Schema = z.object({
  localId: PendingLocalIdSchema,
  text: z.string(),
  structuredInput: RawIngressStructuredInputV1Schema,
}).strict();
export type SessionPendingMessageComposerAdmissionPrepareRequestV1 = z.infer<
  typeof SessionPendingMessageComposerAdmissionPrepareRequestV1Schema
>;

export const SessionPendingMessageComposerAdmissionPrepareResponseV1Schema = z.union([
  z.object({
    ok: z.literal(true),
    text: z.string(),
    structuredInput: HappierStructuredInputV1EnvelopeSchema,
    stagedMediaHandles: z.array(ComposerContentHandleV1Schema).max(MAX_COMPOSER_ATTACHMENT_INSTANCES_V1),
    sessionMediaMetadata: z.object({
      key: z.enum(['happier', 'happierMedia']),
      envelope: SessionMediaMessageMetaV1Schema,
    }).strict().optional(),
    /** Existing staged-media settlement owner cleanup facts for a prepare that never PATCHes. */
    sessionMediaCleanup: z.object({
      workingDirectory: z.string().min(1).max(32_768),
      createdWorkspaceRelativePaths: z.array(z.string().min(1).max(32_768)).max(64),
    }).strict().optional(),
  }).strict(),
  z.object({
    ok: z.literal(false),
    error: z.string().min(1),
    errorCode: z.string().min(1),
  }).strict(),
]);
export type SessionPendingMessageComposerAdmissionPrepareResponseV1 = z.infer<
  typeof SessionPendingMessageComposerAdmissionPrepareResponseV1Schema
>;

/** The exact post-PATCH fact; the Pending writer, not the UI, owns its structured input. */
export const SessionPendingMessageComposerAdmissionAcceptedRequestV1Schema = z.object({
  sessionId: asProtocolZod(SessionIdSchema),
  localId: PendingLocalIdSchema,
  structuredInput: HappierStructuredInputV1EnvelopeSchema,
  stagedMediaHandles: z.array(ComposerContentHandleV1Schema).max(MAX_COMPOSER_ATTACHMENT_INSTANCES_V1),
  sessionMediaMetadata: z.object({
    key: z.enum(['happier', 'happierMedia']),
    envelope: SessionMediaMessageMetaV1Schema,
  }).strict().optional(),
}).strict();
export type SessionPendingMessageComposerAdmissionAcceptedRequestV1 = Readonly<{
  sessionId: string;
  localId: z.infer<typeof PendingLocalIdSchema>;
  structuredInput: HappierStructuredInputV1Envelope;
  stagedMediaHandles: readonly ComposerContentHandleV1[];
  sessionMediaMetadata?: Readonly<{
    key: 'happier' | 'happierMedia';
    envelope: SessionMediaMessageMetaV1;
  }>;
}>;

/** Narrow abandonment of a pre-PATCH staged-media preparation. */
export const SessionPendingMessageComposerAdmissionAbandonedRequestV1Schema = z.object({
  sessionId: asProtocolZod(SessionIdSchema),
  localId: PendingLocalIdSchema,
  structuredInput: HappierStructuredInputV1EnvelopeSchema,
  stagedMediaHandles: z.array(ComposerContentHandleV1Schema).max(MAX_COMPOSER_ATTACHMENT_INSTANCES_V1),
  sessionMediaCleanup: z.object({
    workingDirectory: z.string().min(1).max(32_768),
    createdWorkspaceRelativePaths: z.array(z.string().min(1).max(32_768)).max(64),
  }).strict(),
}).strict();
export type SessionPendingMessageComposerAdmissionAbandonedRequestV1 = Readonly<{
  sessionId: string;
  localId: z.infer<typeof PendingLocalIdSchema>;
  structuredInput: HappierStructuredInputV1Envelope;
  stagedMediaHandles: readonly ComposerContentHandleV1[];
  sessionMediaCleanup: Readonly<{
    workingDirectory: string;
    createdWorkspaceRelativePaths: readonly string[];
  }>;
}>;

const SessionUserMessageSendSuccessResponseSchema = z.object({
  ok: z.literal(true),
}).passthrough();

const SessionUserMessageSendErrorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.string().min(1),
  errorCode: z.string().min(1),
}).passthrough();

export const SessionUserMessageSendResponseSchema = z.union([
  SessionUserMessageSendSuccessResponseSchema,
  SessionUserMessageSendErrorResponseSchema,
]);
export type SessionUserMessageSendResponse = z.infer<typeof SessionUserMessageSendResponseSchema>;
