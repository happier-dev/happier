import { z } from 'zod';

const TransferUrlEndpointCandidateSchema = z
  .object({
    kind: z.enum(['tcp', 'http', 'https']),
    url: z.string().min(1),
    authorizationToken: z.string().min(1).optional(),
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
    transferId: z.string().min(1),
    kind: z.literal('open'),
    manifestHash: z.string().min(1),
    recipientPublicKeyBase64: z.string().min(1).optional(),
  })
  .strict();

export const TransferChunkEnvelopeSchema = z
  .object({
    transferId: z.string().min(1),
    kind: z.literal('chunk'),
    sequence: z.number().int().nonnegative(),
    payloadBase64: z.string().min(1),
    encryptedDataKeyEnvelopeBase64: z.string().min(1).optional(),
  })
  .strict();
export type TransferChunkEnvelope = z.infer<typeof TransferChunkEnvelopeSchema>;

const TransferAckEnvelopeSchema = z
  .object({
    transferId: z.string().min(1),
    kind: z.literal('ack'),
    nextSequence: z.number().int().nonnegative(),
    windowBytes: z.number().int().nonnegative().optional(),
  })
  .strict();

const TransferFinishEnvelopeSchema = z
  .object({
    transferId: z.string().min(1),
    kind: z.literal('finish'),
    manifestHash: z.string().min(1),
  })
  .strict();

const TransferAbortEnvelopeSchema = z
  .object({
    transferId: z.string().min(1),
    kind: z.literal('abort'),
    reason: z.string().min(1),
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
    targetMachineId: z.string().min(1),
    envelope: TransferStreamEnvelopeSchema,
  })
  .strict();
export type MachineTransferSendEnvelope = z.infer<typeof MachineTransferSendEnvelopeSchema>;

export const MachineTransferReceiveEnvelopeSchema = z
  .object({
    sourceMachineId: z.string().min(1),
    targetMachineId: z.string().min(1),
    envelope: TransferStreamEnvelopeSchema,
  })
  .strict();
export type MachineTransferReceiveEnvelope = z.infer<typeof MachineTransferReceiveEnvelopeSchema>;
