import { z } from 'zod';

const MAX_TRANSFER_ID_LENGTH = 512;
const MAX_TRANSFER_MANIFEST_HASH_LENGTH = 256;
const MAX_TRANSFER_ENDPOINT_URL_LENGTH = 2048;
const MAX_TRANSFER_ENDPOINT_AUTH_TOKEN_LENGTH = 2048;
const MAX_MACHINE_ID_LENGTH = 256;

// Open envelopes must stay small to avoid unbounded JSON buffering on the receiver.
const MAX_TRANSFER_OPEN_PAYLOAD_BASE64_LENGTH = 256 * 1024;

// Most transfer public keys are 32 bytes => 44 chars base64, but keep this generous and bounded.
const MAX_TRANSFER_PUBLIC_KEY_BASE64_LENGTH = 256;

// Chunk payload sizes are transport-limited, but keep protocol validation bounded to avoid
// accidental unbounded JSON bodies.
const MAX_TRANSFER_CHUNK_PAYLOAD_BASE64_LENGTH = 16 * 1024 * 1024;

const BASE64_REGEX =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function boundedString(maxLength: number): z.ZodString {
  return z.string().min(1).max(maxLength);
}

function boundedBase64String(maxLength: number): z.ZodString {
  return boundedString(maxLength).regex(BASE64_REGEX, { message: 'Invalid base64 payload' });
}

const TransferUrlEndpointCandidateSchema = z
  .object({
    kind: z.enum(['tcp', 'http', 'https']),
    url: boundedString(MAX_TRANSFER_ENDPOINT_URL_LENGTH),
    authorizationToken: boundedString(MAX_TRANSFER_ENDPOINT_AUTH_TOKEN_LENGTH).optional(),
    expiresAt: z.number().int().nonnegative(),
  })
  .superRefine((value, context) => {
    let protocol: string;
    try {
      protocol = new URL(value.url).protocol;
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: 'Transfer endpoint candidates need an absolute URL',
      });
      return;
    }

    if (protocol !== `${value.kind}:`) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: `Transfer endpoint candidate URL must use the ${value.kind}: scheme`,
      });
    }
  })
  .strict();

export const TransferEndpointCandidateSchema = z.discriminatedUnion('kind', [
  TransferUrlEndpointCandidateSchema,
]);
export type TransferEndpointCandidate = z.infer<typeof TransferEndpointCandidateSchema>;

const TransferOpenEnvelopeSchema = z
  .object({
    transferId: boundedString(MAX_TRANSFER_ID_LENGTH),
    kind: z.literal('open'),
    manifestHash: boundedString(MAX_TRANSFER_MANIFEST_HASH_LENGTH),
    // Required: server-routed transfer responders need the recipient's public key to encrypt
    // chunks (we do not preserve undeployed "no key" compatibility).
    recipientPublicKeyBase64: boundedBase64String(MAX_TRANSFER_PUBLIC_KEY_BASE64_LENGTH),
    // Optional request-scoped payload. Used by server-routed workspace replication to avoid
    // encoding large digest lists into transfer ids (which are capped at the transport layer).
    openPayloadBase64: boundedBase64String(MAX_TRANSFER_OPEN_PAYLOAD_BASE64_LENGTH).optional(),
  })
  .strict();

export const TransferChunkEnvelopeSchema = z
  .object({
    transferId: boundedString(MAX_TRANSFER_ID_LENGTH),
    kind: z.literal('chunk'),
    sequence: z.number().int().nonnegative(),
    payloadBase64: boundedBase64String(MAX_TRANSFER_CHUNK_PAYLOAD_BASE64_LENGTH),
    encryptedDataKeyEnvelopeBase64: boundedBase64String(MAX_TRANSFER_CHUNK_PAYLOAD_BASE64_LENGTH).optional(),
  })
  .strict();
export type TransferChunkEnvelope = z.infer<typeof TransferChunkEnvelopeSchema>;

const TransferAckEnvelopeSchema = z
  .object({
    transferId: boundedString(MAX_TRANSFER_ID_LENGTH),
    kind: z.literal('ack'),
    nextSequence: z.number().int().nonnegative(),
    windowBytes: z.number().int().nonnegative().optional(),
  })
  .strict();

const TransferFinishEnvelopeSchema = z
  .object({
    transferId: boundedString(MAX_TRANSFER_ID_LENGTH),
    kind: z.literal('finish'),
    manifestHash: boundedString(MAX_TRANSFER_MANIFEST_HASH_LENGTH),
  })
  .strict();

const TransferAbortEnvelopeSchema = z
  .object({
    transferId: boundedString(MAX_TRANSFER_ID_LENGTH),
    kind: z.literal('abort'),
    reason: boundedString(1024),
  })
  .strict();

export const TransferStreamEnvelopeSchema = z.discriminatedUnion('kind', [
  TransferOpenEnvelopeSchema,
  TransferChunkEnvelopeSchema,
  TransferAckEnvelopeSchema,
  TransferFinishEnvelopeSchema,
  TransferAbortEnvelopeSchema,
]);
export type TransferStreamEnvelope = z.infer<typeof TransferStreamEnvelopeSchema>;

export const MachineTransferSendEnvelopeSchema = z
  .object({
    targetMachineId: boundedString(MAX_MACHINE_ID_LENGTH),
    envelope: TransferStreamEnvelopeSchema,
  })
  .strict();
export type MachineTransferSendEnvelope = z.infer<typeof MachineTransferSendEnvelopeSchema>;

export const MachineTransferReceiveEnvelopeSchema = z
  .object({
    sourceMachineId: boundedString(MAX_MACHINE_ID_LENGTH),
    targetMachineId: boundedString(MAX_MACHINE_ID_LENGTH),
    envelope: TransferStreamEnvelopeSchema,
  })
  .strict();
export type MachineTransferReceiveEnvelope = z.infer<typeof MachineTransferReceiveEnvelopeSchema>;
