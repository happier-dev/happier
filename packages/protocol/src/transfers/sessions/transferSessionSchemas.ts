import { z } from 'zod';

import { readCanonicalPaddedBase64DecodedLength } from '../../crypto/base64.js';
import { TransferChunkEnvelopeSchema, type TransferChunkEnvelope } from '../../machines/transfer/transferStream.js';
import { MAX_TRANSFER_SESSION_ID_LENGTH, TransferSessionIdSchema } from './transferSessionIds.js';

export const TransferSessionProtocolVersionSchema = z.literal(1);
export type TransferSessionProtocolVersion = z.infer<typeof TransferSessionProtocolVersionSchema>;

const MAX_TRANSFER_MANIFEST_HASH_LENGTH = 256;
const MAX_TRANSFER_PUBLIC_KEY_BASE64_LENGTH = 256;
const MAX_TRANSFER_SCOPE_FINGERPRINT_LENGTH = 4 * 1024;
const MAX_TRANSFER_LIMIT_BYTES = Number.MAX_SAFE_INTEGER;

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

export const TransferSessionKindSchema = z.enum(['import', 'export']);
export type TransferSessionKind = z.infer<typeof TransferSessionKindSchema>;

export const TransferSessionLimitsSchema = z
  .object({
    maxBytes: z.number().int().nonnegative().max(MAX_TRANSFER_LIMIT_BYTES).optional(),
    maxChunks: z.number().int().nonnegative().max(MAX_TRANSFER_LIMIT_BYTES).optional(),
    maxChunkBytes: z.number().int().nonnegative().max(MAX_TRANSFER_LIMIT_BYTES).optional(),
  })
  .strict();
export type TransferSessionLimits = z.infer<typeof TransferSessionLimitsSchema>;

const TransferSessionResponseBaseSchema = z
  .object({
    protocolVersion: TransferSessionProtocolVersionSchema,
    sessionId: TransferSessionIdSchema,
    chunkSizeBytes: z.number().int().positive(),
    expiresAt: z.number().int().nonnegative(),
    scopeFingerprint: boundedString(MAX_TRANSFER_SCOPE_FINGERPRINT_LENGTH).optional(),
    limits: TransferSessionLimitsSchema.optional(),
  })
  .strict();

export const TransferSessionImportOpenResponseSchema = TransferSessionResponseBaseSchema.extend({
  kind: z.literal('import'),
  recipientPublicKeyBase64: boundedBase64String(MAX_TRANSFER_PUBLIC_KEY_BASE64_LENGTH),
}).strict();
export type TransferSessionImportOpenResponse = z.infer<typeof TransferSessionImportOpenResponseSchema>;

export const TransferSessionExportOpenResponseSchema = TransferSessionResponseBaseSchema.extend({
  kind: z.literal('export'),
  manifestHash: boundedString(MAX_TRANSFER_MANIFEST_HASH_LENGTH),
  totalChunks: z.number().int().nonnegative(),
}).strict();
export type TransferSessionExportOpenResponse = z.infer<typeof TransferSessionExportOpenResponseSchema>;

export const TransferSessionOpenResponseSchema = z.discriminatedUnion('kind', [
  TransferSessionImportOpenResponseSchema,
  TransferSessionExportOpenResponseSchema,
]);
export type TransferSessionOpenResponse = z.infer<typeof TransferSessionOpenResponseSchema>;

export const TransferSessionChunkEnvelopeSchema = TransferChunkEnvelopeSchema;
export type TransferSessionChunkEnvelope = TransferChunkEnvelope;

export {
  MAX_TRANSFER_SESSION_ID_LENGTH,
};
