import { lazyZodSchema } from '@happier-dev/protocol/lazyZodSchema';
import * as z from 'zod/mini';
import { SessionTeamCredentialBindingIntentV1Schema, type SessionTeamCredentialBindingIntentV1 } from '@happier-dev/protocol/teams/credentials/sessionBindingIntentV1';
import { ExecutionRunIdSchema } from '@happier-dev/protocol/sessions/idsV1';
import { SESSION_METADATA_LAYOUT_VERSION_V1, SessionOwnerMetadataEnvelopeV1Schema, SessionOwnerMetadataV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { SessionManagerV1Schema } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';
import { SessionAwarenessOriginV1Schema } from '@happier-dev/protocol/sessions/awareness/projectionV1';
import type { SessionManagerV1, SessionAwarenessOriginV1, SessionOwnerMetadataEnvelopeV1, SessionOwnerMetadataV1 } from '@happier-dev/protocol';

type AttachSnapshotPayload = Readonly<{
  acceptedTeamCredentialBinding?: SessionTeamCredentialBindingIntentV1 | null;
  manager?: SessionManagerV1;
  origin?: SessionAwarenessOriginV1;
  metadata: Readonly<Record<string, unknown>>;
  metadataVersion: number;
  agentState: Readonly<Record<string, unknown>> | null;
  agentStateVersion: number;
  pendingExecutionRunIds?: readonly string[];
  metadataLayoutVersion?: typeof SESSION_METADATA_LAYOUT_VERSION_V1;
  ownerMetadata?: SessionOwnerMetadataV1;
  ownerMetadataEnvelope?: SessionOwnerMetadataEnvelopeV1;
}>;

type AttachPayloadV2Plain = Readonly<{
  v: 2;
  encryptionMode: 'plain';
  lastObservedMessageSeq?: number;
  initialTranscriptAfterSeq?: number;
  snapshot?: AttachSnapshotPayload;
}>;

type AttachPayloadV2E2ee = Readonly<{
  v: 2;
  encryptionMode: 'e2ee';
  encryptionKeyBase64: string;
  encryptionVariant: 'legacy' | 'dataKey';
  lastObservedMessageSeq?: number;
  initialTranscriptAfterSeq?: number;
  snapshot?: AttachSnapshotPayload;
}>;

type LegacyAttachPayload = Readonly<{
  encryptionKeyBase64: string;
  encryptionVariant: 'legacy' | 'dataKey';
  v?: undefined;
  encryptionMode?: undefined;
}>;

export type SessionAttachFilePayload =
  | AttachPayloadV2Plain
  | AttachPayloadV2E2ee;
export type SessionAttachPayload =
  | SessionAttachFilePayload
  | LegacyAttachPayload;

const AttachSnapshotSchema = lazyZodSchema(() => z.object({
  acceptedTeamCredentialBinding: z.optional(z.nullable(SessionTeamCredentialBindingIntentV1Schema)),
  manager: z.optional(SessionManagerV1Schema),
  origin: z.optional(SessionAwarenessOriginV1Schema),
  metadata: z.record(z.string(), z.unknown()),
  metadataVersion: z.number().check(z.int(), z.nonnegative()),
  agentState: z.nullable(z.record(z.string(), z.unknown())),
  agentStateVersion: z.number().check(z.int(), z.nonnegative()),
  pendingExecutionRunIds: z.optional(z.array(ExecutionRunIdSchema)),
  metadataLayoutVersion: z.optional(z.literal(SESSION_METADATA_LAYOUT_VERSION_V1)),
  ownerMetadata: z.optional(SessionOwnerMetadataV1Schema),
  ownerMetadataEnvelope: z.optional(SessionOwnerMetadataEnvelopeV1Schema),
}));

const LegacyAttachPayloadSchema = lazyZodSchema(() => z.object({
  encryptionKeyBase64: z.string().check(z.minLength(1)),
  encryptionVariant: z.union([z.literal('legacy'), z.literal('dataKey')]),
  v: z.optional(z.undefined()),
  encryptionMode: z.optional(z.undefined()),
}));

const AttachPayloadV2PlainSchema = lazyZodSchema(() => z.object({
  v: z.literal(2),
  encryptionMode: z.literal('plain'),
  lastObservedMessageSeq: z.optional(z.number().check(z.int(), z.nonnegative())),
  initialTranscriptAfterSeq: z.optional(z.number().check(z.int(), z.nonnegative())),
  snapshot: z.optional(AttachSnapshotSchema),
}));

const AttachPayloadV2E2eeSchema = lazyZodSchema(() => z.object({
  v: z.literal(2),
  encryptionMode: z.literal('e2ee'),
  encryptionKeyBase64: z.string().check(z.minLength(1)),
  encryptionVariant: z.union([z.literal('legacy'), z.literal('dataKey')]),
  lastObservedMessageSeq: z.optional(z.number().check(z.int(), z.nonnegative())),
  initialTranscriptAfterSeq: z.optional(z.number().check(z.int(), z.nonnegative())),
  snapshot: z.optional(AttachSnapshotSchema),
}));

export const SessionAttachPayloadV2Schema: z.ZodMiniType<SessionAttachFilePayload> =
  lazyZodSchema(() => z.union([AttachPayloadV2PlainSchema, AttachPayloadV2E2eeSchema]));

export const SessionAttachPayloadSchema: z.ZodMiniType<SessionAttachPayload> = lazyZodSchema(() => z.union([
  // v2: explicit encryption mode. Parse before legacy because v2 e2ee carries legacy key fields too.
  SessionAttachPayloadV2Schema,
  // v1 (legacy): treat as e2ee.
  LegacyAttachPayloadSchema,
]));
