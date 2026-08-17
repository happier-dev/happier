import { z } from 'zod';

import {
  HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1,
  HappierStructuredInputV1Schema as HappierStructuredInputV1EnvelopeSchema,
  SESSION_ATTACHMENT_UPLOAD_STRUCTURED_INPUT_PROVENANCE_KIND,
  hasAdmittedComposerAttachmentSelectionV1,
  readAttachmentEnvelopeLocalImagePaths,
  readHappierStructuredInputV1FromMeta,
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
  sanitizeHappierStructuredInputV1,
};
export type { HappierStructuredInputV1Envelope };

export function sanitizeSessionUserMessageSendMeta(
  value: MetadataRecord,
  options: Readonly<{ allowedLocalImagePaths?: ReadonlySet<string>; text?: string }> = {},
): MetadataRecord {
  return sanitizeSessionStructuredInputMeta(value, options);
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
  const structuredInput = readHappierStructuredInputV1FromMeta(request.meta);
  if (hasAdmittedComposerAttachmentSelectionV1(structuredInput)) return;
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
