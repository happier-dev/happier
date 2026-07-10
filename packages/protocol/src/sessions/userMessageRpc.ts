import { z } from 'zod';

import {
  HappierStructuredInputV1Schema as HappierStructuredInputV1EnvelopeSchema,
  SESSION_ATTACHMENT_UPLOAD_STRUCTURED_INPUT_PROVENANCE_KIND,
  readAttachmentEnvelopeLocalImagePaths,
  sanitizeHappierStructuredInputV1,
  sanitizeSessionStructuredInputMeta,
  type HappierStructuredInputV1 as HappierStructuredInputV1Envelope,
} from '../runtime/input/index.js';

type MetadataRecord = Record<string, unknown>;

export {
  HappierStructuredInputV1EnvelopeSchema,
  SESSION_ATTACHMENT_UPLOAD_STRUCTURED_INPUT_PROVENANCE_KIND,
  readAttachmentEnvelopeLocalImagePaths,
  sanitizeHappierStructuredInputV1,
};
export type { HappierStructuredInputV1Envelope };

export function sanitizeSessionUserMessageSendMeta(
  value: MetadataRecord,
  options: Readonly<{ allowedLocalImagePaths?: ReadonlySet<string> }> = {},
): MetadataRecord {
  return sanitizeSessionStructuredInputMeta(value, options);
}

export const SessionUserMessageSendMetaSchema = z
  .record(z.string(), z.unknown())
  .transform((value) => sanitizeSessionUserMessageSendMeta(value));
export type SessionUserMessageSendMeta = z.infer<typeof SessionUserMessageSendMetaSchema>;

export const SessionUserMessageSendRequestSchema = z.object({
  text: z.string().min(1),
  localId: z.string().min(1).optional(),
  meta: SessionUserMessageSendMetaSchema.default({}),
}).passthrough();
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
