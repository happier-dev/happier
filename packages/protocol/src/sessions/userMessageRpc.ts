import { z } from 'zod';

import {
  HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1,
  HappierStructuredInputV1Schema as HappierStructuredInputV1EnvelopeSchema,
  SESSION_ATTACHMENT_UPLOAD_STRUCTURED_INPUT_PROVENANCE_KIND,
  hasAdmittedComposerAttachmentSelectionV1,
  readAttachmentEnvelopeLocalImagePaths,
  readHappierStructuredInputV1FromMeta,
  readIngressComposerAttachmentSelectionV1,
  sanitizeHappierStructuredInputV1,
  sanitizeSessionStructuredInputMeta,
  type HappierStructuredInputV1 as HappierStructuredInputV1Envelope,
} from '../runtime/input/index.js';
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
