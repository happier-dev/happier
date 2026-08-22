import * as z from 'zod';
import {
  SESSION_METADATA_LAYOUT_VERSION_V1,
  SessionOwnerMetadataEnvelopeV1Schema,
  SessionOwnerMetadataV1Schema,
  type SessionOwnerMetadataEnvelopeV1,
  type SessionOwnerMetadataV1,
} from '@happier-dev/protocol';

type AttachSnapshotPayload = Readonly<{
  metadata: Readonly<Record<string, unknown>>;
  metadataVersion: number;
  agentState: Readonly<Record<string, unknown>> | null;
  agentStateVersion: number;
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

const AttachSnapshotSchema = z.object({
  metadata: z.record(z.string(), z.unknown()),
  metadataVersion: z.number().int().nonnegative(),
  agentState: z.record(z.string(), z.unknown()).nullable(),
  agentStateVersion: z.number().int().nonnegative(),
  metadataLayoutVersion: z.literal(SESSION_METADATA_LAYOUT_VERSION_V1).optional(),
  ownerMetadata: SessionOwnerMetadataV1Schema.optional(),
  ownerMetadataEnvelope: SessionOwnerMetadataEnvelopeV1Schema.optional(),
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

export const SessionAttachPayloadV2Schema: z.ZodType<SessionAttachFilePayload> =
  z.union([AttachPayloadV2PlainSchema, AttachPayloadV2E2eeSchema]);

export const SessionAttachPayloadSchema: z.ZodType<SessionAttachPayload> = z.union([
  // v2: explicit encryption mode. Parse before legacy because v2 e2ee carries legacy key fields too.
  SessionAttachPayloadV2Schema,
  // v1 (legacy): treat as e2ee.
  LegacyAttachPayloadSchema,
]);
