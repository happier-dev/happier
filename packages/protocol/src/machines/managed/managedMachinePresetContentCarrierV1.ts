import tweetnacl from 'tweetnacl';
import { SavedSecretResourceRecipientEnvelopeV1Schema } from '../../account/settings/savedSecretCatalogV1.js';

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

/** Persisted recipient envelopes are Account-scoped; Machine recipients are not a valid shape. */
export const ManagedMachinePresetRecipientV1Schema = lazyZodSchema(() => z.strictObject({
  accountId: z.string().check(z.trim(), z.minLength(1)),
  envelope: SavedSecretResourceRecipientEnvelopeV1Schema,
}));
export type ManagedMachinePresetRecipientV1 = Readonly<z.infer<typeof ManagedMachinePresetRecipientV1Schema>>;

export const ManagedMachinePresetRecipientsV1Schema = lazyZodSchema(() => z.array(
  ManagedMachinePresetRecipientV1Schema,
).check(z.refine((items) => new Set(items.map(item => item.accountId)).size === items.length,
  { message: 'Duplicate accountId' })));
export type ManagedMachinePresetRecipientsV1 = ReadonlyArray<ManagedMachinePresetRecipientV1>;


/** The canonical mode-tagged snapshot retained by a managed admission. */
export const ManagedAdmissionPresetContentV1Schema = lazyZodSchema(() => z.strictObject({
  content: ManagedMachinePresetStoredContentCarrierV1Schema,
  recipients: ManagedMachinePresetRecipientsV1Schema,
}));
export type ManagedAdmissionPresetContentV1 = z.infer<typeof ManagedAdmissionPresetContentV1Schema>;
