import { z } from '../../../zodRuntimePolicy.js';

import { readCanonicalPaddedBase64DecodedLength } from '../../../crypto/base64.js';

const MAX_TRANSFER_ID_LENGTH = 512;
const MAX_TRANSFER_MANIFEST_HASH_LENGTH = 256;
const MAX_TRANSFER_PUBLIC_KEY_BASE64_LENGTH = 256;
const MAX_TRANSFER_OPEN_PAYLOAD_BASE64_LENGTH = 256 * 1024;
const MAX_TRANSFER_CHUNK_PAYLOAD_BASE64_LENGTH = 16 * 1024 * 1024;
const MAX_TRANSFER_ABORT_REASON_LENGTH = 1024;
const MAX_USER_ID_LENGTH = 256;
const MAX_MACHINE_ID_LENGTH = 256;

function boundedString(maxLength: number): z.ZodMiniString<string> {
  return z.string().check(z.minLength(1), z.maxLength(maxLength));
}

function boundedBase64String(maxLength: number) {
  return boundedString(maxLength).check(z.superRefine((value, context) => {
    if (readCanonicalPaddedBase64DecodedLength(value) !== null) return;
    context.addIssue({
      code: "custom",
      message: 'Invalid base64 payload',
    });
  }));
}

const TransferRelayV2OpenEnvelopeSchema = z.strictObject({
    transferId: boundedString(MAX_TRANSFER_ID_LENGTH),
    kind: z.literal('open'),
    recipientPublicKeyBase64: boundedBase64String(MAX_TRANSFER_PUBLIC_KEY_BASE64_LENGTH),
    openPayloadBase64: z.optional(boundedBase64String(MAX_TRANSFER_OPEN_PAYLOAD_BASE64_LENGTH)),
  });

const TransferRelayV2ChunkEnvelopeSchema = z.strictObject({
    transferId: boundedString(MAX_TRANSFER_ID_LENGTH),
    kind: z.literal('chunk'),
    sequence: z.number().check(z.int(), z.nonnegative()),
    payloadBase64: boundedBase64String(MAX_TRANSFER_CHUNK_PAYLOAD_BASE64_LENGTH),
    encryptedDataKeyEnvelopeBase64: z.optional(boundedBase64String(MAX_TRANSFER_CHUNK_PAYLOAD_BASE64_LENGTH)),
  });

const TransferRelayV2AckEnvelopeSchema = z.strictObject({
    transferId: boundedString(MAX_TRANSFER_ID_LENGTH),
    kind: z.literal('ack'),
    nextSequence: z.number().check(z.int(), z.nonnegative()),
    windowBytes: z.optional(z.number().check(z.int(), z.nonnegative())),
  });

const TransferRelayV2FinishEnvelopeSchema = z.strictObject({
    transferId: boundedString(MAX_TRANSFER_ID_LENGTH),
    kind: z.literal('finish'),
    manifestHash: boundedString(MAX_TRANSFER_MANIFEST_HASH_LENGTH),
  });

const TransferRelayV2AbortEnvelopeSchema = z.strictObject({
    transferId: boundedString(MAX_TRANSFER_ID_LENGTH),
    kind: z.literal('abort'),
    reason: boundedString(MAX_TRANSFER_ABORT_REASON_LENGTH),
  });

export const TransferRelayV2EnvelopeSchema = z.discriminatedUnion('kind', [
  TransferRelayV2OpenEnvelopeSchema,
  TransferRelayV2ChunkEnvelopeSchema,
  TransferRelayV2AckEnvelopeSchema,
  TransferRelayV2FinishEnvelopeSchema,
  TransferRelayV2AbortEnvelopeSchema,
]);
export type TransferRelayV2Envelope = z.infer<typeof TransferRelayV2EnvelopeSchema>;

export const TransferRelayV2UserParticipantSchema = z.strictObject({
    kind: z.literal('user'),
    socketId: z.optional(boundedString(MAX_USER_ID_LENGTH)),
  });
export type TransferRelayV2UserParticipant = z.infer<typeof TransferRelayV2UserParticipantSchema>;

export const TransferRelayV2MachineParticipantSchema = z.strictObject({
    kind: z.literal('machine'),
    machineId: boundedString(MAX_MACHINE_ID_LENGTH),
  });
export type TransferRelayV2MachineParticipant = z.infer<typeof TransferRelayV2MachineParticipantSchema>;

export const TransferRelayV2SenderSchema = z.discriminatedUnion('kind', [
  TransferRelayV2UserParticipantSchema,
  TransferRelayV2MachineParticipantSchema,
]);
export type TransferRelayV2Sender = z.infer<typeof TransferRelayV2SenderSchema>;

export const TransferRelayV2RecipientSchema = z.discriminatedUnion('kind', [
  TransferRelayV2UserParticipantSchema,
  TransferRelayV2MachineParticipantSchema,
]);
export type TransferRelayV2Recipient = z.infer<typeof TransferRelayV2RecipientSchema>;

export const TransferRelayV2SendEnvelopeSchema = z.strictObject({
    scopeUserId: boundedString(MAX_USER_ID_LENGTH),
    sender: TransferRelayV2SenderSchema,
    recipient: TransferRelayV2RecipientSchema,
    envelope: TransferRelayV2EnvelopeSchema,
  });
export type TransferRelayV2SendEnvelope = z.infer<typeof TransferRelayV2SendEnvelopeSchema>;
