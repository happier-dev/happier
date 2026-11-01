import * as z from 'zod';
import { lazySchema } from '@happier-dev/protocol';

const LegacyAttachPayloadSchema = lazySchema(() => z.object({
  encryptionKeyBase64: z.string().min(1),
  encryptionVariant: z.union([z.literal('legacy'), z.literal('dataKey')]),
  v: z.undefined().optional(),
  encryptionMode: z.undefined().optional(),
}));

const AttachPayloadV2PlainSchema = lazySchema(() => z.object({
  v: z.literal(2),
  encryptionMode: z.literal('plain'),
  lastObservedMessageSeq: z.number().int().nonnegative().optional(),
  initialTranscriptAfterSeq: z.number().int().nonnegative().optional(),
}));

const AttachPayloadV2E2eeSchema = lazySchema(() => z.object({
  v: z.literal(2),
  encryptionMode: z.literal('e2ee'),
  encryptionKeyBase64: z.string().min(1),
  encryptionVariant: z.union([z.literal('legacy'), z.literal('dataKey')]),
  lastObservedMessageSeq: z.number().int().nonnegative().optional(),
  initialTranscriptAfterSeq: z.number().int().nonnegative().optional(),
}));

export const SessionAttachPayloadV2Schema = lazySchema(() => z.union([AttachPayloadV2PlainSchema, AttachPayloadV2E2eeSchema]));

export type SessionAttachFilePayload = z.infer<typeof SessionAttachPayloadV2Schema>;

export const SessionAttachPayloadSchema = lazySchema(() => z.union([
  // v2 payloads share the e2ee key fields with legacy v1; parse them first so
  // legacy compatibility cannot strip v2 cursor fields.
  SessionAttachPayloadV2Schema,
  // v1 (legacy): treat as e2ee.
  LegacyAttachPayloadSchema,
]));

export type SessionAttachPayload = z.infer<typeof SessionAttachPayloadSchema>;
