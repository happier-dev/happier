import { PrivateLabelReadV1Schema, PrivateLabelStoredV1Schema } from '../crypto/privateLabelV1.js';
import { SavedSecretResourceEnvelopeCensusRecipientV1Schema } from '../account/settings/savedSecretCatalogV1.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

/** The immutable cipher binding shared by Group authors and readers. */
export function teamGroupLabelBinding(groupId: string, field: 'name' | 'description') {
  return { entity: 'team_group', field, id: groupId } as const;
}

/** One recipient-safe Team Group label projection, reused by every Group reader. */
export const TeamGroupLabelProjectionV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('available'), label: PrivateLabelReadV1Schema }),
  z.strictObject({ kind: z.literal('unavailable') }),
]));
export type TeamGroupLabelProjectionV1 = z.infer<typeof TeamGroupLabelProjectionV1Schema>;

/** Existing Group-name consumers share the same label projection owner. */
export const TeamGroupNameProjectionV1Schema = TeamGroupLabelProjectionV1Schema;
export type TeamGroupNameProjectionV1 = TeamGroupLabelProjectionV1;

/** Recipient-only repair keeps the immutable Group binding and ciphertext. */
export const TeamGroupLabelEnvelopeRepairV1Schema = lazyZodSchema(() => z.strictObject({
  groupId: z.string().check(z.minLength(1)),
  field: z.enum(['name', 'description']),
  label: PrivateLabelStoredV1Schema,
}));
export const TeamGroupLabelEnvelopeRepairsV1Schema = lazyZodSchema(() => z.strictObject({
  teamId: z.string().check(z.minLength(1)),
  labels: z.array(TeamGroupLabelEnvelopeRepairV1Schema),
}));
export const TeamGroupLabelEnvelopeWorkV1Schema = lazyZodSchema(() => z.strictObject({
  teams: z.array(z.strictObject({
    teamId: z.string().check(z.minLength(1)),
    recipients: z.array(SavedSecretResourceEnvelopeCensusRecipientV1Schema),
    labels: z.array(z.strictObject({
      groupId: z.string().check(z.minLength(1)),
      field: z.enum(['name', 'description']),
      label: PrivateLabelReadV1Schema,
    })),
  })),
}));
