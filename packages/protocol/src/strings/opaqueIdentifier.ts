import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

/**
 * An identifier minted outside Happier — an Agent's resume/session id, a
 * provider tool-call or message id — is opaque. Happier stores it and hands it
 * back to its issuer; it never re-canonicalizes it. Leading and trailing
 * whitespace, embedded newlines, `/`, `+`, `=` and non-ASCII bytes are part of
 * the identity, so presence is decided by a predicate and the accepted value
 * keeps its exact bytes.
 *
 * A missing, non-string or all-whitespace value still means "no identity". That
 * is the only judgement this owner makes.
 *
 * Happier-minted identifiers are a different contract with their own
 * canonicalization rules (`preservedBoundedNfcString`, the trimmed id schemas).
 * Do not route those through this owner.
 */
export const NonBlankOpaqueIdentifierSchema = lazyZodSchema(() => z.string().refine(
  (value) => value.trim().length > 0,
  'Opaque identifiers must contain a non-whitespace character',
));

/** Read an opaque identifier for presence without changing its bytes. */
export function readNonBlankOpaqueIdentifier(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}
