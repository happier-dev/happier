import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

export const SessionStoredMessageContentEnvelopeSchema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.object({
    t: z.literal('encrypted'),
    c: z.string().min(1),
  }),
  z.object({
    t: z.literal('plain'),
    v: z.unknown(),
  }),
]));

export const StrictSessionStoredMessageContentEnvelopeSchema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.object({
    t: z.literal('encrypted'),
    c: z.string().min(1),
  }).strict(),
  z.object({
    t: z.literal('plain'),
    v: z.unknown().refine((value) => value !== undefined, { message: 'Plain envelope value is required' }),
  }).strict(),
]));

export const SessionStoredMessageContentSchema = lazyZodSchema(() => z.preprocess((value) => {
  // Backwards compatibility: older clients/servers stored message content as a bare ciphertext string.
  if (typeof value === 'string') {
    const ciphertext = value.trim();
    return ciphertext ? { t: 'encrypted', c: ciphertext } : value;
  }
  // Backwards compatibility: some call sites used `{ ciphertext: string }`.
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.ciphertext === 'string') {
      const ciphertext = record.ciphertext.trim();
      return ciphertext ? { t: 'encrypted', c: ciphertext } : value;
    }
  }
  return value;
}, SessionStoredMessageContentEnvelopeSchema));

export type SessionStoredMessageContent = z.infer<typeof SessionStoredMessageContentSchema>;
export type SessionStoredMessageContentEnvelope = z.infer<
  typeof SessionStoredMessageContentEnvelopeSchema
>;
export type StrictSessionStoredMessageContentEnvelope = z.infer<
  typeof StrictSessionStoredMessageContentEnvelopeSchema
>;
