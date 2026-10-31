import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { decodeBase64, encodeBase64 } from '../../crypto/base64.js';

const binary = lazyZodSchema(() => z.string().check(z.minLength(1), z.refine(value => {
  try { return encodeBase64(decodeBase64(value, 'base64'), 'base64') === value; } catch { return false; }
})));

/** Private material, carried only by the existing Saved Secret content envelope. */
export const SavedSecretPasskeySourceV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('passkey'),
  rpId: z.string().check(z.minLength(1), z.refine(value => {
    try { return new URL(`https://${value}`).hostname === value && !value.includes(':'); } catch { return false; }
  })),
  credentialId: binary,
  // WebAuthn's user handle boundary is 64 bytes, not an application quota.
  userHandle: binary.check(z.refine(value => decodeBase64(value, 'base64').byteLength <= 64)),
  privateKey: binary,
  // Chromium's native WebAuthn.addCredential accepts ECDSA P-256 PKCS#8 only.
  algorithm: z.literal(-7),
  signCount: z.number().check(z.int(), z.minimum(0), z.maximum(0xffffffff)),
  backupEligibility: z.boolean(),
  backupState: z.boolean(),
  userName: z.optional(z.string()),
  userDisplayName: z.optional(z.string()),
}).check(z.refine(value => !value.backupState || value.backupEligibility)));

export type SavedSecretPasskeySourceV1 = Readonly<z.infer<typeof SavedSecretPasskeySourceV1Schema>>;
