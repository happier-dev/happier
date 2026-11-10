import { z } from '../../zodRuntimePolicy.js';

import { readCanonicalPaddedBase64DecodedLength } from '../../crypto/base64.js';
import { TransferChunkEnvelopeSchema, type TransferChunkEnvelope } from '../../machines/transfer/transferStream.js';
import { MAX_TRANSFER_SESSION_ID_LENGTH, TransferSessionIdSchema } from './transferSessionIds.js';

export const TransferSessionProtocolVersionSchema = z.literal(1);
export type TransferSessionProtocolVersion = z.infer<typeof TransferSessionProtocolVersionSchema>;

const MAX_TRANSFER_MANIFEST_HASH_LENGTH = 256;
const MAX_TRANSFER_PUBLIC_KEY_BASE64_LENGTH = 256;
const MAX_TRANSFER_SCOPE_FINGERPRINT_LENGTH = 4 * 1024;
const MAX_TRANSFER_LIMIT_BYTES = Number.MAX_SAFE_INTEGER;

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

export const TransferSessionKindSchema = z.enum(['import', 'export']);
export type TransferSessionKind = z.infer<typeof TransferSessionKindSchema>;

export const TransferSessionLimitsSchema = z.strictObject({
    maxBytes: z.optional(z.number().check(z.int(), z.nonnegative(), z.maximum(MAX_TRANSFER_LIMIT_BYTES))),
    maxChunks: z.optional(z.number().check(z.int(), z.nonnegative(), z.maximum(MAX_TRANSFER_LIMIT_BYTES))),
    maxChunkBytes: z.optional(z.number().check(z.int(), z.nonnegative(), z.maximum(MAX_TRANSFER_LIMIT_BYTES))),
  });
export type TransferSessionLimits = z.infer<typeof TransferSessionLimitsSchema>;

const TransferSessionResponseBaseSchema = z.strictObject({
    protocolVersion: TransferSessionProtocolVersionSchema,
    sessionId: TransferSessionIdSchema,
    chunkSizeBytes: z.number().check(z.int(), z.positive()),
    expiresAt: z.number().check(z.int(), z.nonnegative()),
    scopeFingerprint: z.optional(boundedString(MAX_TRANSFER_SCOPE_FINGERPRINT_LENGTH)),
    limits: z.optional(TransferSessionLimitsSchema),
  });

export const TransferSessionImportOpenResponseSchema = (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(TransferSessionResponseBaseSchema, {
  kind: z.literal('import'),
  recipientPublicKeyBase64: boundedBase64String(MAX_TRANSFER_PUBLIC_KEY_BASE64_LENGTH),
}));
export type TransferSessionImportOpenResponse = z.infer<typeof TransferSessionImportOpenResponseSchema>;

export const TransferSessionExportOpenResponseSchema = (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(TransferSessionResponseBaseSchema, {
  kind: z.literal('export'),
  manifestHash: boundedString(MAX_TRANSFER_MANIFEST_HASH_LENGTH),
  totalChunks: z.number().check(z.int(), z.nonnegative()),
}));
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
