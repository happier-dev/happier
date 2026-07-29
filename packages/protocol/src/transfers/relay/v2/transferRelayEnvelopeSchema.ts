import { z } from 'zod';

import { readCanonicalPaddedBase64DecodedLength } from '../../../crypto/base64.js';

const MAX_TRANSFER_ID_LENGTH = 512;
const MAX_TRANSFER_MANIFEST_HASH_LENGTH = 256;
const MAX_TRANSFER_PUBLIC_KEY_BASE64_LENGTH = 256;
const MAX_TRANSFER_OPEN_PAYLOAD_BASE64_LENGTH = 256 * 1024;
const MAX_TRANSFER_CHUNK_PAYLOAD_BASE64_LENGTH = 16 * 1024 * 1024;
const MAX_TRANSFER_ABORT_REASON_LENGTH = 1024;
const MAX_USER_ID_LENGTH = 256;
const MAX_MACHINE_ID_LENGTH = 256;

function boundedString(maxLength: number): z.ZodString {
  return z.string().min(1).max(maxLength);
}

function boundedBase64String(maxLength: number) {
  return boundedString(maxLength).superRefine((value, context) => {
    if (readCanonicalPaddedBase64DecodedLength(value) !== null) return;
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Invalid base64 payload',
    });
  });
}

const TransferRelayV2OpenEnvelopeSchema = z
  .object({
    transferId: boundedString(MAX_TRANSFER_ID_LENGTH),
    kind: z.literal('open'),
    recipientPublicKeyBase64: boundedBase64String(MAX_TRANSFER_PUBLIC_KEY_BASE64_LENGTH),
    openPayloadBase64: boundedBase64String(MAX_TRANSFER_OPEN_PAYLOAD_BASE64_LENGTH).optional(),
  })
  .strict();

const TransferRelayV2ChunkEnvelopeSchema = z
  .object({
    transferId: boundedString(MAX_TRANSFER_ID_LENGTH),
    kind: z.literal('chunk'),
    sequence: z.number().int().nonnegative(),
    payloadBase64: boundedBase64String(MAX_TRANSFER_CHUNK_PAYLOAD_BASE64_LENGTH),
    encryptedDataKeyEnvelopeBase64: boundedBase64String(MAX_TRANSFER_CHUNK_PAYLOAD_BASE64_LENGTH).optional(),
  })
  .strict();

const TransferRelayV2AckEnvelopeSchema = z
  .object({
    transferId: boundedString(MAX_TRANSFER_ID_LENGTH),
    kind: z.literal('ack'),
    nextSequence: z.number().int().nonnegative(),
    windowBytes: z.number().int().nonnegative().optional(),
  })
  .strict();

const TransferRelayV2FinishEnvelopeSchema = z
  .object({
    transferId: boundedString(MAX_TRANSFER_ID_LENGTH),
    kind: z.literal('finish'),
    manifestHash: boundedString(MAX_TRANSFER_MANIFEST_HASH_LENGTH),
  })
  .strict();

const TransferRelayV2AbortEnvelopeSchema = z
  .object({
    transferId: boundedString(MAX_TRANSFER_ID_LENGTH),
    kind: z.literal('abort'),
    reason: boundedString(MAX_TRANSFER_ABORT_REASON_LENGTH),
  })
  .strict();

export const TransferRelayV2EnvelopeSchema = z.discriminatedUnion('kind', [
  TransferRelayV2OpenEnvelopeSchema,
  TransferRelayV2ChunkEnvelopeSchema,
  TransferRelayV2AckEnvelopeSchema,
  TransferRelayV2FinishEnvelopeSchema,
  TransferRelayV2AbortEnvelopeSchema,
]);
export type TransferRelayV2Envelope = z.infer<typeof TransferRelayV2EnvelopeSchema>;

export const TransferRelayV2UserParticipantSchema = z
  .object({
    kind: z.literal('user'),
    socketId: boundedString(MAX_USER_ID_LENGTH).optional(),
  })
  .strict();
export type TransferRelayV2UserParticipant = z.infer<typeof TransferRelayV2UserParticipantSchema>;

export const TransferRelayV2MachineParticipantSchema = z
  .object({
    kind: z.literal('machine'),
    machineId: boundedString(MAX_MACHINE_ID_LENGTH),
  })
  .strict();
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

export const TransferRelayV2SendEnvelopeSchema = z
  .object({
    scopeUserId: boundedString(MAX_USER_ID_LENGTH),
    sender: TransferRelayV2SenderSchema,
    recipient: TransferRelayV2RecipientSchema,
    envelope: TransferRelayV2EnvelopeSchema,
  })
  .strict();
export type TransferRelayV2SendEnvelope = z.infer<typeof TransferRelayV2SendEnvelopeSchema>;
