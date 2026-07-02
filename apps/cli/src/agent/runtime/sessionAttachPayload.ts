import * as z from 'zod';

const AttachSnapshotSchema = z.object({
  metadata: z.record(z.string(), z.unknown()),
  metadataVersion: z.number().int().nonnegative(),
  agentState: z.record(z.string(), z.unknown()).nullable(),
  agentStateVersion: z.number().int().nonnegative(),
});

const LegacyAttachPayloadSchema = z.object({
  encryptionKeyBase64: z.string().min(1),
  encryptionVariant: z.union([z.literal('legacy'), z.literal('dataKey')]),
  v: z.undefined().optional(),
  encryptionMode: z.undefined().optional(),
});

const AttachPayloadV2PlainSchema = z.object({
  v: z.literal(2),
  encryptionMode: z.literal('plain'),
  lastObservedMessageSeq: z.number().int().nonnegative().optional(),
  initialTranscriptAfterSeq: z.number().int().nonnegative().optional(),
  snapshot: AttachSnapshotSchema.optional(),
});

const AttachPayloadV2E2eeSchema = z.object({
  v: z.literal(2),
  encryptionMode: z.literal('e2ee'),
  encryptionKeyBase64: z.string().min(1),
  encryptionVariant: z.union([z.literal('legacy'), z.literal('dataKey')]),
  lastObservedMessageSeq: z.number().int().nonnegative().optional(),
  initialTranscriptAfterSeq: z.number().int().nonnegative().optional(),
  snapshot: AttachSnapshotSchema.optional(),
});

export const SessionAttachPayloadV2Schema = z.union([AttachPayloadV2PlainSchema, AttachPayloadV2E2eeSchema]);

export type SessionAttachFilePayload = z.infer<typeof SessionAttachPayloadV2Schema>;

export const SessionAttachPayloadSchema = z.union([
  // v2: explicit encryption mode. Parse before legacy because v2 e2ee carries legacy key fields too.
  SessionAttachPayloadV2Schema,
  // v1 (legacy): treat as e2ee.
  LegacyAttachPayloadSchema,
]);

export type SessionAttachPayload = z.infer<typeof SessionAttachPayloadSchema>;
