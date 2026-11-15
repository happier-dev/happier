import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { SavedSecretResourceEnvelopeCensusRecipientV1Schema } from '../account/settings/savedSecretCatalogV1.js';
import { AccountEncryptionModeSchema } from '../features/payload/capabilities/encryptionCapabilities.js';

export const PRIVATE_LABEL_RECIPIENT_CENSUS_PATH = '/v1/account/private-labels/recipient-census';
export const ACCOUNT_DIRECTORY_PRIVATE_LABEL_RECIPIENT_CENSUS_PATH = '/v1/account-directory/private-labels/recipient-census';

/** The audience whose current Account keys may receive one private label. */
export const PrivateLabelRecipientCensusOwnerV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('account'), accountId: z.string().check(z.trim(), z.minLength(1)) }),
  z.strictObject({ kind: z.literal('team'), teamId: z.string().check(z.trim(), z.minLength(1)) }),
]));
export type PrivateLabelRecipientCensusOwnerV1 = z.infer<typeof PrivateLabelRecipientCensusOwnerV1Schema>;

/** A client asks the server to select its current author-and-Team recipient census. */
export const PrivateLabelRecipientCensusRequestV1Schema = lazyZodSchema(() => z.strictObject({
  owner: PrivateLabelRecipientCensusOwnerV1Schema,
}));
export type PrivateLabelRecipientCensusRequestV1 = z.infer<typeof PrivateLabelRecipientCensusRequestV1Schema>;

/** The server-selected author mode and Saved Secret-compatible recipient census. */
export const PrivateLabelRecipientCensusResponseV1Schema = lazyZodSchema(() => z.strictObject({
  contentEncryptionMode: AccountEncryptionModeSchema,
  recipients: z.array(SavedSecretResourceEnvelopeCensusRecipientV1Schema),
}));
export type PrivateLabelRecipientCensusResponseV1 = z.infer<typeof PrivateLabelRecipientCensusResponseV1Schema>;
