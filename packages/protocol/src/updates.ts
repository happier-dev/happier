import { z } from 'zod';

const TimestampMsSchema = z.number().int().min(0);
const Base64Schema = z.string();

const VersionedNullableStringSchema = z.object({
  value: z.string().nullable(),
  version: z.number().int(),
}).strict();

const VersionedStringSchema = z.object({
  value: z.string(),
  version: z.number().int(),
}).strict();

export const UpdateBodySchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('new-message'),
    sid: z.string(),
    message: z.object({
      id: z.string(),
      seq: z.number().int().min(0),
      content: z.unknown(),
      localId: z.string().nullable(),
      createdAt: TimestampMsSchema,
      updatedAt: TimestampMsSchema,
    }).strict(),
  }).passthrough(),
  z.object({
    t: z.literal('new-session'),
    id: z.string(),
    seq: z.number().int().min(0),
    metadata: Base64Schema,
    metadataVersion: z.number().int(),
    agentState: Base64Schema.nullable(),
    agentStateVersion: z.number().int(),
    dataEncryptionKey: Base64Schema.nullable(),
    active: z.boolean(),
    activeAt: TimestampMsSchema,
    createdAt: TimestampMsSchema,
    updatedAt: TimestampMsSchema,
  }).passthrough(),
  z.object({
    t: z.literal('update-session'),
    id: z.string(),
    metadata: VersionedNullableStringSchema.optional(),
    agentState: VersionedNullableStringSchema.optional(),
  }).passthrough(),
  z.object({
    t: z.literal('delete-session'),
    sid: z.string(),
  }).passthrough(),
  z.object({
    t: z.literal('update-account'),
    id: z.string(),
  }).passthrough(),
  z.object({
    t: z.literal('new-machine'),
    machineId: z.string(),
    seq: z.number().int().min(0),
    metadata: Base64Schema,
    metadataVersion: z.number().int(),
    daemonState: Base64Schema.nullable(),
    daemonStateVersion: z.number().int(),
    dataEncryptionKey: Base64Schema.nullable(),
    active: z.boolean(),
    activeAt: TimestampMsSchema,
    createdAt: TimestampMsSchema,
    updatedAt: TimestampMsSchema,
  }).passthrough(),
  z.object({
    t: z.literal('update-machine'),
    machineId: z.string(),
    metadata: VersionedStringSchema.optional(),
    daemonState: VersionedStringSchema.optional(),
    activeAt: TimestampMsSchema.optional(),
  }).passthrough(),
  z.object({
    t: z.literal('new-artifact'),
    artifactId: z.string(),
    seq: z.number().int().min(0),
    header: Base64Schema,
    headerVersion: z.number().int(),
    body: Base64Schema,
    bodyVersion: z.number().int(),
    dataEncryptionKey: Base64Schema,
    createdAt: TimestampMsSchema,
    updatedAt: TimestampMsSchema,
  }).passthrough(),
  z.object({
    t: z.literal('update-artifact'),
    artifactId: z.string(),
    header: VersionedStringSchema.optional(),
    body: VersionedStringSchema.optional(),
  }).passthrough(),
  z.object({
    t: z.literal('delete-artifact'),
    artifactId: z.string(),
  }).passthrough(),
  z.object({
    t: z.literal('relationship-updated'),
    uid: z.string(),
    status: z.enum(['none', 'requested', 'pending', 'friend', 'rejected']),
    timestamp: TimestampMsSchema,
  }).passthrough(),
  z.object({
    t: z.literal('new-feed-post'),
    id: z.string(),
    body: z.unknown(),
    cursor: z.string(),
    createdAt: TimestampMsSchema,
  }).passthrough(),
  z.object({
    t: z.literal('kv-batch-update'),
    changes: z.array(z.object({
      key: z.string(),
      value: z.string().nullable(),
      version: z.number().int(),
    }).strict()),
  }).passthrough(),
  z.object({
    t: z.literal('session-shared'),
    sessionId: z.string(),
    shareId: z.string(),
    sharedBy: z.object({
      id: z.string(),
      firstName: z.string().nullable(),
      lastName: z.string().nullable(),
      username: z.string().nullable(),
      avatar: z.unknown().nullable(),
    }).passthrough(),
    accessLevel: z.enum(['view', 'edit', 'admin']),
    encryptedDataKey: Base64Schema,
    createdAt: TimestampMsSchema,
  }).passthrough(),
  z.object({
    t: z.literal('session-share-updated'),
    sessionId: z.string(),
    shareId: z.string(),
    accessLevel: z.enum(['view', 'edit', 'admin']),
    updatedAt: TimestampMsSchema,
  }).passthrough(),
  z.object({
    t: z.literal('session-share-revoked'),
    sessionId: z.string(),
    shareId: z.string(),
  }).passthrough(),
  z.object({
    t: z.literal('public-share-created'),
    sessionId: z.string(),
    publicShareId: z.string(),
    token: z.string(),
    expiresAt: TimestampMsSchema.nullable(),
    maxUses: z.number().int().nullable(),
    isConsentRequired: z.boolean(),
    createdAt: TimestampMsSchema,
  }).passthrough(),
  z.object({
    t: z.literal('public-share-updated'),
    sessionId: z.string(),
    publicShareId: z.string(),
    expiresAt: TimestampMsSchema.nullable(),
    maxUses: z.number().int().nullable(),
    isConsentRequired: z.boolean(),
    updatedAt: TimestampMsSchema,
  }).passthrough(),
  z.object({
    t: z.literal('public-share-deleted'),
    sessionId: z.string(),
  }).passthrough(),
]);

export type UpdateBody = z.infer<typeof UpdateBodySchema>;

export const UpdateContainerSchema = z.object({
  id: z.string(),
  seq: z.number().int().min(0),
  createdAt: TimestampMsSchema,
  body: UpdateBodySchema,
}).strict();

export type UpdateContainer = z.infer<typeof UpdateContainerSchema>;

export const EphemeralUpdateSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('activity'),
    id: z.string(),
    active: z.boolean(),
    activeAt: TimestampMsSchema,
    thinking: z.boolean().optional(),
  }).passthrough(),
  z.object({
    type: z.literal('machine-activity'),
    id: z.string(),
    active: z.boolean(),
    activeAt: TimestampMsSchema,
  }).passthrough(),
  z.object({
    type: z.literal('usage'),
    id: z.string(),
    key: z.string(),
    tokens: z.record(z.number()),
    cost: z.record(z.number()),
    timestamp: TimestampMsSchema,
  }).passthrough(),
  z.object({
    type: z.literal('machine-status'),
    machineId: z.string(),
    online: z.boolean(),
    timestamp: TimestampMsSchema,
  }).passthrough(),
]);

export type EphemeralUpdate = z.infer<typeof EphemeralUpdateSchema>;

// Broadcast-safe events (cursorless).
//
// These are intended for cases where a single identical payload can be emitted to a shared room (e.g. `session:${sessionId}`)
// without carrying per-account cursors or recipient-specific secrets.
//
// Important: clients must treat these as optional hints/optimizations only, never as the sole source of truth.
export const SessionBroadcastBodySchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('session-changed'),
    sessionId: z.string(),
  }).passthrough(),
]);

export type SessionBroadcastBody = z.infer<typeof SessionBroadcastBodySchema>;

export const SessionBroadcastContainerSchema = z.object({
  id: z.string(),
  createdAt: TimestampMsSchema,
  body: SessionBroadcastBodySchema,
}).strict();

export type SessionBroadcastContainer = z.infer<typeof SessionBroadcastContainerSchema>;

export const MessageAckResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    id: z.string(),
    seq: z.number().int().min(0),
    localId: z.string().nullable(),
  }).strict(),
  z.object({
    ok: z.literal(false),
    error: z.string(),
  }).strict(),
]);

export type MessageAckResponse = z.infer<typeof MessageAckResponseSchema>;

export const UpdateMetadataAckResponseSchema = z.discriminatedUnion('result', [
  z.object({
    result: z.literal('success'),
    version: z.number().int(),
    metadata: z.string(),
  }).strict(),
  z.object({
    result: z.literal('version-mismatch'),
    version: z.number().int(),
    metadata: z.string(),
  }).strict(),
  z.object({
    result: z.literal('forbidden'),
  }).strict(),
  z.object({
    result: z.literal('error'),
  }).strict(),
]);

export type UpdateMetadataAckResponse = z.infer<typeof UpdateMetadataAckResponseSchema>;

export const UpdateStateAckResponseSchema = z.discriminatedUnion('result', [
  z.object({
    result: z.literal('success'),
    version: z.number().int(),
    agentState: z.string().nullable(),
  }).strict(),
  z.object({
    result: z.literal('version-mismatch'),
    version: z.number().int(),
    agentState: z.string().nullable(),
  }).strict(),
  z.object({
    result: z.literal('forbidden'),
  }).strict(),
  z.object({
    result: z.literal('error'),
  }).strict(),
]);

export type UpdateStateAckResponse = z.infer<typeof UpdateStateAckResponseSchema>;
