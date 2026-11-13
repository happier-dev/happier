import * as z from 'zod';
import { lazySchema, SessionRoleV1Schema, type SessionRoleV1 } from '@happier-dev/protocol';

/**
 * The retained session role travels from the canonical metadata owner to a resuming runner through
 * this short-lived handoff, so the first provider launch carries it even before (or without) a server
 * metadata snapshot. Loosely typed here and validated on both ends: a malformed role never fails a
 * resume, and older readers strip the optional field.
 */
const AttachSessionRoleField = lazySchema(() => z.unknown().optional());

/** The `sessionRoleV1` attach field for a decrypted session metadata record, when it holds a valid role. */
export function readSessionRoleForAttachPayload(metadata: unknown): { sessionRoleV1?: SessionRoleV1 } {
  if (!metadata || typeof metadata !== 'object') return {};
  const parsed = SessionRoleV1Schema.safeParse((metadata as { sessionRoleV1?: unknown }).sessionRoleV1);
  return parsed.success ? { sessionRoleV1: parsed.data } : {};
}

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
  sessionRoleV1: AttachSessionRoleField,
}));

const AttachPayloadV2E2eeSchema = lazySchema(() => z.object({
  v: z.literal(2),
  encryptionMode: z.literal('e2ee'),
  encryptionKeyBase64: z.string().min(1),
  encryptionVariant: z.union([z.literal('legacy'), z.literal('dataKey')]),
  lastObservedMessageSeq: z.number().int().nonnegative().optional(),
  initialTranscriptAfterSeq: z.number().int().nonnegative().optional(),
  sessionRoleV1: AttachSessionRoleField,
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
