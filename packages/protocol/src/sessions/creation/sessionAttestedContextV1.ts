import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';

// These values become HTTP header values. Preserve opaque identities verbatim,
// including RFC Message-ID brackets, while rejecting line injection.
const attestedFact = () => z.string().check(z.minLength(1), z.refine(value => value.trim().length > 0 && !/[\r\n\0]/.test(value), 'Invalid attested header value'));

/** Birth-only facts supplied by trusted, host-stamped plugin callers. */
export const SessionAttestedContextV1Schema = lazyZodSchema(() => z.strictObject({
  externalPrincipalId: attestedFact(),
  sourceMessageId: attestedFact(),
}));
export type SessionAttestedContextV1 = Readonly<z.infer<typeof SessionAttestedContextV1Schema>>;
