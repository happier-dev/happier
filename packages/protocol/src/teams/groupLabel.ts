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

/**
 * Team-audience private labels whose stored data key current keyholders may rewrap for the current
 * Team recipient census. The binding is the label's immutable cipher identity and its storage address.
 */
export const TeamLabelEnvelopeBindingV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ entity: z.literal('team_group'), field: z.enum(['name', 'description']), id: z.string().check(z.minLength(1)) }),
  z.strictObject({ entity: z.literal('team_credential_resource'), field: z.literal('displayName'), id: z.string().check(z.minLength(1)) }),
  z.strictObject({ entity: z.literal('team_credential_external_api_key'), field: z.literal('label'), id: z.string().check(z.minLength(1)) }),
  z.strictObject({ entity: z.literal('machine_pool'), field: z.enum(['name', 'description']), id: z.string().check(z.minLength(1)) }),
]));
export type TeamLabelEnvelopeBindingV1 = z.infer<typeof TeamLabelEnvelopeBindingV1Schema>;

/** Recipient-only repair keeps the immutable binding and ciphertext. */
export const TeamLabelEnvelopeRepairsV1Schema = lazyZodSchema(() => z.strictObject({
  teamId: z.string().check(z.minLength(1)),
  labels: z.array(z.strictObject({ binding: TeamLabelEnvelopeBindingV1Schema, label: PrivateLabelStoredV1Schema })),
}));
export type TeamLabelEnvelopeRepairsV1 = z.infer<typeof TeamLabelEnvelopeRepairsV1Schema>;

/** Labels the caller can already open, each with the complete recipient census its next envelope set must cover. */
export const TeamLabelEnvelopeWorkV1Schema = lazyZodSchema(() => z.strictObject({
  teams: z.array(z.strictObject({
    teamId: z.string().check(z.minLength(1)),
    labels: z.array(z.strictObject({
      binding: TeamLabelEnvelopeBindingV1Schema,
      label: PrivateLabelReadV1Schema,
      recipients: z.array(SavedSecretResourceEnvelopeCensusRecipientV1Schema),
    })),
  })),
}));
export type TeamLabelEnvelopeWorkV1 = z.infer<typeof TeamLabelEnvelopeWorkV1Schema>;
