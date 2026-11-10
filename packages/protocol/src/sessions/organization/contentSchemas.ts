import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';

import { SESSION_ORGANIZATION_MAX_DISPLAY_ENVELOPE_BYTES } from './constants.js';

const textEncoder = new TextEncoder();

function measureJsonUtf8Bytes(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return textEncoder.encode(serialized).byteLength;
  } catch {
    return null;
  }
}

const CycleSafeJsonValueSchema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value) => {
  try {
    JSON.stringify(value);
    return value;
  } catch {
    return undefined;
  }
}), z.json()));

export const SessionOrganizationContentEnvelopeSchema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.strictObject({
    t: z.literal('plain'),
    v: CycleSafeJsonValueSchema,
  }),
  z.strictObject({
    t: z.literal('encrypted'),
    c: z.string().check(z.minLength(1)),
  }),
]).check(z.superRefine((value, ctx) => {
  const byteLength = measureJsonUtf8Bytes(value);
  if (byteLength === null) {
    ctx.addIssue({
      code: 'custom',
      message: 'Session organization display envelope must be JSON serializable.',
    });
    return;
  }

  if (byteLength > SESSION_ORGANIZATION_MAX_DISPLAY_ENVELOPE_BYTES) {
    ctx.addIssue({
      code: 'custom',
      message: 'Session organization display envelope exceeds the maximum serialized size.',
    });
  }
})));
export type SessionOrganizationContentEnvelope = z.infer<typeof SessionOrganizationContentEnvelopeSchema>;
export const SessionOrganizationContentEnvelopeStoredSchema = createStoredReadSchema(SessionOrganizationContentEnvelopeSchema);

export const SessionOrganizationDisplayStateSchema = lazyZodSchema(() => z.strictObject({
    status: z.literal('unavailable'),
    reason: z.enum(['invalid_stored_display', 'storage_mode_mismatch']),
  }));
export type SessionOrganizationDisplayState = z.infer<typeof SessionOrganizationDisplayStateSchema>;
