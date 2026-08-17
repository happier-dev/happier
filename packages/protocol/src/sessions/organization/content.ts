import { z } from 'zod';

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

const CycleSafeJsonValueSchema = z.preprocess((value) => {
  try {
    JSON.stringify(value);
    return value;
  } catch {
    return undefined;
  }
}, z.json());

export const SessionOrganizationContentEnvelopeSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('plain'),
    v: CycleSafeJsonValueSchema,
  }).strict(),
  z.object({
    t: z.literal('encrypted'),
    c: z.string().min(1),
  }).strict(),
]).superRefine((value, ctx) => {
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
});
export type SessionOrganizationContentEnvelope = z.infer<typeof SessionOrganizationContentEnvelopeSchema>;

export const SessionOrganizationDisplayStateSchema = z
  .object({
    status: z.literal('unavailable'),
    reason: z.enum(['invalid_stored_display', 'storage_mode_mismatch']),
  })
  .strict();
export type SessionOrganizationDisplayState = z.infer<typeof SessionOrganizationDisplayStateSchema>;
