import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

export const SessionStoredMessageContentEnvelopeSchema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.object({
    t: z.literal('encrypted'),
    c: z.string().check(z.minLength(1)),
  }),
  z.object({
    t: z.literal('plain'),
    v: z.unknown(),
  }),
]));

export const StrictSessionStoredMessageContentEnvelopeSchema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.strictObject({
    t: z.literal('encrypted'),
    c: z.string().check(z.minLength(1)),
  }),
  z.strictObject({
    t: z.literal('plain'),
    v: z.unknown().check(z.refine((value) => value !== undefined, { message: 'Plain envelope value is required' })),
  }),
]));

export const SessionStoredMessageContentSchema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value) => {
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
}), SessionStoredMessageContentEnvelopeSchema));

export type SessionStoredMessageContent = z.infer<typeof SessionStoredMessageContentSchema>;
export type SessionStoredMessageContentEnvelope = z.infer<
  typeof SessionStoredMessageContentEnvelopeSchema
>;
export type StrictSessionStoredMessageContentEnvelope = z.infer<
  typeof StrictSessionStoredMessageContentEnvelopeSchema
>;
