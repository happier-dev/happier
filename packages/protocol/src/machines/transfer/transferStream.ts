import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { readCanonicalPaddedBase64DecodedLength } from '../../crypto/base64.js';

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

const TransferUrlEndpointCandidateSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z
  .object({
    kind: z.enum(['tcp', 'http', 'https']),
    url: boundedString(MAX_TRANSFER_ENDPOINT_URL_LENGTH),
    authorizationToken: z.optional(boundedString(MAX_TRANSFER_ENDPOINT_AUTH_TOKEN_LENGTH)),
    expiresAt: z.number().check(z.int(), z.nonnegative()),
  }).check(z.superRefine((value, context) => {
    let protocol: string;
    try {
      protocol = new URL(value.url).protocol;
    } catch {
      context.addIssue({
        code: "custom",
        path: ['url'],
        message: 'Transfer endpoint candidates need an absolute URL',
      });
      return;
    }

    if (protocol !== `${value.kind}:`) {
      context.addIssue({
        code: "custom",
        path: ['url'],
        message: `Transfer endpoint candidate URL must use the ${value.kind}: scheme`,
      });
    }
  }))));

export const TransferEndpointCandidateSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  TransferUrlEndpointCandidateSchema,
]));
export type TransferEndpointCandidate = z.infer<typeof TransferEndpointCandidateSchema>;

const TransferOpenEnvelopeSchema = lazyZodSchema(() => z.strictObject({
    transferId: boundedString(MAX_TRANSFER_ID_LENGTH),
    kind: z.literal('open'),
    manifestHash: boundedString(MAX_TRANSFER_MANIFEST_HASH_LENGTH),
    // Required: server-routed transfer responders need the recipient's public key to encrypt
    // chunks (we do not preserve undeployed "no key" compatibility).
    recipientPublicKeyBase64: boundedBase64String(MAX_TRANSFER_PUBLIC_KEY_BASE64_LENGTH),
    // Optional request-scoped payload. Used by server-routed workspace replication to avoid
    // encoding large digest lists into transfer ids (which are capped at the transport layer).
    openPayloadBase64: z.optional(boundedBase64String(MAX_TRANSFER_OPEN_PAYLOAD_BASE64_LENGTH)),
  }));

export const TransferChunkEnvelopeSchema = lazyZodSchema(() => z.strictObject({
    transferId: boundedString(MAX_TRANSFER_ID_LENGTH),
    kind: z.literal('chunk'),
    sequence: z.number().check(z.int(), z.nonnegative()),
    payloadBase64: boundedBase64String(MAX_TRANSFER_CHUNK_PAYLOAD_BASE64_LENGTH),
    encryptedDataKeyEnvelopeBase64: z.optional(boundedBase64String(MAX_TRANSFER_CHUNK_PAYLOAD_BASE64_LENGTH)),
  }));
export type TransferChunkEnvelope = z.infer<typeof TransferChunkEnvelopeSchema>;

const TransferAckEnvelopeSchema = lazyZodSchema(() => z.strictObject({
    transferId: boundedString(MAX_TRANSFER_ID_LENGTH),
    kind: z.literal('ack'),
    nextSequence: z.number().check(z.int(), z.nonnegative()),
    windowBytes: z.optional(z.number().check(z.int(), z.nonnegative())),
  }));

const TransferFinishEnvelopeSchema = lazyZodSchema(() => z.strictObject({
    transferId: boundedString(MAX_TRANSFER_ID_LENGTH),
    kind: z.literal('finish'),
    manifestHash: boundedString(MAX_TRANSFER_MANIFEST_HASH_LENGTH),
  }));

const TransferAbortEnvelopeSchema = lazyZodSchema(() => z.strictObject({
    transferId: boundedString(MAX_TRANSFER_ID_LENGTH),
    kind: z.literal('abort'),
    reason: boundedString(1024),
  }));

export const TransferStreamEnvelopeSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  TransferOpenEnvelopeSchema,
  TransferChunkEnvelopeSchema,
  TransferAckEnvelopeSchema,
  TransferFinishEnvelopeSchema,
  TransferAbortEnvelopeSchema,
]));
export type TransferStreamEnvelope = z.infer<typeof TransferStreamEnvelopeSchema>;

export const MachineTransferSendEnvelopeSchema = lazyZodSchema(() => z.strictObject({
    targetMachineId: boundedString(MAX_MACHINE_ID_LENGTH),
    envelope: TransferStreamEnvelopeSchema,
  }));
export type MachineTransferSendEnvelope = z.infer<typeof MachineTransferSendEnvelopeSchema>;

export const MachineTransferReceiveEnvelopeSchema = lazyZodSchema(() => z.strictObject({
    sourceMachineId: boundedString(MAX_MACHINE_ID_LENGTH),
    targetMachineId: boundedString(MAX_MACHINE_ID_LENGTH),
    envelope: TransferStreamEnvelopeSchema,
  }));
export type MachineTransferReceiveEnvelope = z.infer<typeof MachineTransferReceiveEnvelopeSchema>;
