import tweetnacl from 'tweetnacl';

import { decodeBase64, encodeBase64, readCanonicalPaddedBase64DecodedLength } from '../../crypto/base64.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

function isCanonicalCiphertext(value: string): boolean {
  try {
    const decodedLength = readCanonicalPaddedBase64DecodedLength(value);
    if (decodedLength === null || decodedLength < tweetnacl.secretbox.nonceLength + tweetnacl.secretbox.overheadLength) return false;
    return encodeBase64(decodeBase64(value, 'base64'), 'base64') === value;
  } catch {
    return false;
  }
}

export const CanonicalCiphertextSchema = lazyZodSchema(() => z.string().check(
  z.minLength(1),
  z.refine(isCanonicalCiphertext, { message: 'Expected canonical padded Base64 ciphertext' }),
));

/**
 * Public/server carrier for private preset content. It checks only the explicit
 * tag and encrypted transport shape; sealing and opening own private-body validation.
 */
const OpaquePrivatePresetContentV1Schema = lazyZodSchema(() => z.unknown().check(
  z.refine(value => value !== undefined, { message: 'Expected private preset content' }),
));
export const ManagedMachinePresetStoredContentCarrierV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('plain'), v: OpaquePrivatePresetContentV1Schema }),
  z.strictObject({ t: z.literal('encrypted'), c: CanonicalCiphertextSchema }),
]));
export type ManagedMachinePresetStoredContentCarrierV1 = Readonly<
  z.infer<typeof ManagedMachinePresetStoredContentCarrierV1Schema>
>;

/**
 * Optional acquire-time private replacement. Its allowed semantic delta is
 * decided only by the narrow creator/resolver pair; the server stores no raw
 * name or setup separately from this existing mode-tagged carrier.
 */
export const ManagedMachinePresetLaunchNameOverrideV1Schema = lazyZodSchema(() => z.strictObject({
  content: ManagedMachinePresetStoredContentCarrierV1Schema,
}));
export type ManagedMachinePresetLaunchNameOverrideV1 = Readonly<
  z.infer<typeof ManagedMachinePresetLaunchNameOverrideV1Schema>
>;
