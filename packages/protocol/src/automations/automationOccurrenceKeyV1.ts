import { z } from 'zod/mini';
import { decodeBase64, encodeBase64 } from '../crypto/base64.js';

const base64UrlSha256 = z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u), z.refine((value) => {
  try {
    const decoded = decodeBase64(value, 'base64url');
    return decoded.byteLength === 32 && encodeBase64(decoded, 'base64url') === value;
  } catch {
    return false;
  }
}, 'Expected one canonical unpadded base64url SHA-256 value'));

/** Shared identity leaves do not load occurrence evidence, delivery or Action registries. */
export const AutomationOccurrenceKeyV1Schema = base64UrlSha256.brand<'AutomationOccurrenceKeyV1'>();
export type AutomationOccurrenceKeyV1 = z.infer<typeof AutomationOccurrenceKeyV1Schema>;
export const AutomationOccurrenceEvidenceEqualityTagV1Schema = base64UrlSha256.brand<'AutomationOccurrenceEvidenceEqualityTagV1'>();
export type AutomationOccurrenceEvidenceEqualityTagV1 = z.infer<typeof AutomationOccurrenceEvidenceEqualityTagV1Schema>;
