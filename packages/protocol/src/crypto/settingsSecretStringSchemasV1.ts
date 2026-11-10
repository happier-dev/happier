import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { appendSavedSecretReferencePathV1 } from '../account/settings/savedSecretReferenceV1.js';

export const EncryptedStringV1Schema = lazyZodSchema(() => z.object({
  t: z.literal('enc-v1'),
  c: z.string().check(z.minLength(1)),
}));

export type EncryptedStringV1 = z.infer<typeof EncryptedStringV1Schema>;

export const SecretStringV1Schema = lazyZodSchema(() => z.object({
  _isSecretValue: z.literal(true),
  value: z.optional(z.string().check(z.minLength(1))),
  encryptedValue: z.optional(EncryptedStringV1Schema),
}));

export type SecretStringV1 = z.infer<typeof SecretStringV1Schema>;

/** Inspect actual SecretString markers before tolerant stored projections discard fields. */
export function listSecretStringCarrierPathsV1(value: unknown): readonly string[] {
  const paths: string[] = [];
  const visit = (candidate: unknown, path: string): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach((entry, index) => visit(entry, `${path}[${index}]`));
    } else if (candidate !== null && typeof candidate === 'object') {
      if ('_isSecretValue' in candidate && candidate._isSecretValue === true) paths.push(path);
      for (const [key, entry] of Object.entries(candidate)) visit(entry, appendSavedSecretReferencePathV1(path, key));
    }
  };
  visit(value, '');
  return paths;
}
