import { z } from 'zod/mini';
import { TEAM_MEMBERSHIP_HISTORY_ACTION_IDS_V1 } from './actionsV1.js';
import { TeamIdSchema, TeamGroupIdSchema, TeamMembershipIdSchema } from './membership.js';
import { SessionDataKeyEnvelopeRecipientAccountIdV1Schema, SessionDataKeyRecipientUnavailableReasonV1Schema } from '../sessions/encryption/sessionDataKeyEnvelopes.js';
import { MembershipSessionDataKeyEnvelopeExceptionsV1Schema } from '../sessions/encryption/membershipSessionDataKeyEnvelopes.js';

/** Public intents on the material-holding client, never raw envelope operations. */
export { TEAM_MEMBERSHIP_HISTORY_ACTION_IDS_V1 } from './actionsV1.js';
export type TeamMembershipHistoryActionIdV1 = typeof TEAM_MEMBERSHIP_HISTORY_ACTION_IDS_V1[number];
export function isTeamMembershipHistoryActionIdV1(value: string): value is TeamMembershipHistoryActionIdV1 {
  return (TEAM_MEMBERSHIP_HISTORY_ACTION_IDS_V1 as readonly string[]).includes(value);
}
export const TeamMembershipHistoryTargetV1Schema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('team'), teamMembershipId: TeamMembershipIdSchema }),
  z.strictObject({ kind: z.literal('group'), teamGroupId: TeamGroupIdSchema,
    accountId: SessionDataKeyEnvelopeRecipientAccountIdV1Schema }),
]);
export type TeamMembershipHistoryTargetV1 = z.infer<typeof TeamMembershipHistoryTargetV1Schema>;
export const TeamMembershipHistoryInputV1Schema = z.strictObject({
  teamId: TeamIdSchema, target: TeamMembershipHistoryTargetV1Schema,
  recipientAccountId: SessionDataKeyEnvelopeRecipientAccountIdV1Schema,
}).check(z.refine(value => value.target.kind !== 'group' || value.target.accountId === value.recipientAccountId, { message: 'Group membership must address its recipient Account' }));
export type TeamMembershipHistoryInputV1 = z.infer<typeof TeamMembershipHistoryInputV1Schema>;
export const TeamMembershipHistoryReadinessV1Schema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ready'), actionable: z.boolean(),
    exceptions: MembershipSessionDataKeyEnvelopeExceptionsV1Schema }),
  z.strictObject({ status: z.literal('recipient_unavailable'), reason: SessionDataKeyRecipientUnavailableReasonV1Schema }),
]);
export type TeamMembershipHistoryReadinessV1 = z.infer<typeof TeamMembershipHistoryReadinessV1Schema>;
/** Session identities and material remain private to the encryption host. */
export const TeamMembershipHistoryPreparationResultV1Schema = z.strictObject({
  status: z.enum(['complete', 'incomplete', 'scope_changed', 'recipient_unavailable',
    'recipient_changed', 'membership_changed', 'invalid_recipient_binding']),
  preparedCount: z.number().check(z.int(), z.nonnegative()), skippedCount: z.number().check(z.int(), z.nonnegative()),
  repairRequiredCount: z.number().check(z.int(), z.nonnegative()),
  /** Sessions whose served key did not prove it is that Session's, so nothing was sealed for them. */
  sessionKeyUnprovenCount: z.number().check(z.int(), z.nonnegative()),
  recipientUnavailableReason: z.nullable(SessionDataKeyRecipientUnavailableReasonV1Schema),
  exceptions: z.nullable(MembershipSessionDataKeyEnvelopeExceptionsV1Schema),
});
export type TeamMembershipHistoryPreparationResultV1 = z.infer<typeof TeamMembershipHistoryPreparationResultV1Schema>;
