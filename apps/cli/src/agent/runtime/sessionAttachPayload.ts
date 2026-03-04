import * as z from 'zod';

const LegacyAttachPayloadSchema = z.object({
  encryptionKeyBase64: z.string().min(1),
  encryptionVariant: z.union([z.literal('legacy'), z.literal('dataKey')]),
});

const AttachPayloadV2PlainSchema = z.object({
  v: z.literal(2),
  encryptionMode: z.literal('plain'),
});

const AttachPayloadV2E2eeSchema = z.object({
  v: z.literal(2),
  encryptionMode: z.literal('e2ee'),
  encryptionKeyBase64: z.string().min(1),
  encryptionVariant: z.union([z.literal('legacy'), z.literal('dataKey')]),
});

export const SessionAttachPayloadV2Schema = z.union([AttachPayloadV2PlainSchema, AttachPayloadV2E2eeSchema]);

export type SessionAttachFilePayload = z.infer<typeof SessionAttachPayloadV2Schema>;

export const SessionAttachPayloadSchema = z.union([
  // v1 (legacy): treat as e2ee.
  LegacyAttachPayloadSchema,
  // v2: explicit encryption mode.
  SessionAttachPayloadV2Schema,
]);

export type SessionAttachPayload = z.infer<typeof SessionAttachPayloadSchema>;

