import { z } from 'zod';
import { lazySchema } from '../lazySchema.js';

/** Issuer-owned identifiers are opaque: validate presence without changing their bytes. */
export const NonBlankOpaqueIdentifierSchema = lazySchema(() => z.string().refine(
  (value) => value.trim().length > 0,
  'Opaque identifiers must contain a non-whitespace character',
));

export function readNonBlankOpaqueIdentifier(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}
