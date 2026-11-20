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

const INVALID_KEY = Symbol("invalid-json-key");

/** PostgreSQL JSONB cannot represent NUL. Normalize before persistence AND idempotency checks. */
export function normalizeSessionStoredMessageContentForStorage(
    content: SessionStoredMessageContentEnvelope,
): SessionStoredMessageContentEnvelope | null {
    // Ciphertext is opaque base64. Never repair encrypted data.
    if (content.t === "encrypted") return content.c.includes("\u0000") ? null : content;
    let changed = false;
    function normalize(value: unknown): unknown {
        if (typeof value === "string") {
            const normalized = value.replaceAll("\u0000", "");
            if (normalized !== value) changed = true;
            return normalized;
        }
        if (Array.isArray(value)) {
            const normalized = value.map(normalize);
            return normalized.includes(INVALID_KEY) ? INVALID_KEY : normalized;
        }
        if (value && typeof value === "object") {
            const entries: [string, unknown][] = [];
            for (const [key, child] of Object.entries(value)) {
                // Rewriting keys can collapse distinct fields and silently lose data.
                if (key.includes("\u0000")) return INVALID_KEY;
                const normalized = normalize(child);
                if (normalized === INVALID_KEY) return INVALID_KEY;
                entries.push([key, normalized]);
            }
            return Object.fromEntries(entries);
        }
        return value;
    }
    const value = normalize(content.v);
    if (value === INVALID_KEY) return null;
    if (!changed) return content;
    return { t: "plain", v: value };
}

export const SessionMessageToolOutputAvailabilitySchema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('available') }),
  z.strictObject({ status: z.literal('expired'), days: z.number().check(z.int(), z.minimum(1)) }),
]));

export type SessionMessageToolOutputAvailability = z.infer<typeof SessionMessageToolOutputAvailabilitySchema>;

export type SessionStoredMessageContent = z.infer<typeof SessionStoredMessageContentSchema>;
export type SessionStoredMessageContentEnvelope = z.infer<
  typeof SessionStoredMessageContentEnvelopeSchema
>;
export type StrictSessionStoredMessageContentEnvelope = z.infer<
  typeof StrictSessionStoredMessageContentEnvelopeSchema
>;
