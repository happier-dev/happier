import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

/**
 * The typed Team domain results a route may map to HTTP.
 *
 * There is deliberately no "hidden" or "forbidden but exists" code: an
 * inaccessible Team and an absent Team both resolve to `team_not_found`, so
 * Team existence cannot be probed by an unauthorized caller. `team_forbidden`
 * is reserved for a Team the viewer may already see but may not mutate.
 */
export const TeamErrorCodeV1Schema = lazyZodSchema(() => z.enum([
  'invalid_team_input',
  'invalid_team_cursor',
  'invalid_team_authentication_policy',
  'team_forbidden',
  'team_not_found',
  'teams_unavailable',
  'team_archived',
  'team_conflict',
  'team_authentication_policy_conflict',
  'team_authentication_policy_unavailable',
  'team_authentication_required',
  'team_authentication_unavailable',
  /**
   * The addressed invitation does not belong to this Team or does not exist.
   * Like `team_not_found` it does not distinguish absent from unreadable.
   */
  'invitation_not_found',
  /** The invitation is already accepted, revoked, or expired. */
  'invitation_not_active',
  /**
   * This Home cannot send mail, so an email-bound invitation would be created
   * with no way to reach anyone. The transferable link stays available.
   */
  'invitation_email_unavailable',
  /**
   * The addressed membership lifetime does not exist in this Team. Like
   * `team_not_found` it does not distinguish absent from unreadable, so a
   * membership id cannot be probed across Teams.
   */
  'membership_not_found',
  /** The addressed Account has no current membership in this Team. */
  'not_team_member',
  /** The addressed Group does not belong to this Team or does not exist. */
  'group_not_found',
  /** The Group is archived; its rows are retained but no mutation applies. */
  'group_archived',
  /** Another Group in this Team already uses that normalized name. */
  'group_name_taken',
  /**
   * The requested change would seize a lifetime owned by a native manager or a
   * different source. Conversion is an explicit action, never a side effect.
   */
  'management_conflict',
  /**
   * This membership's lifecycle is owned by a directory source, so the native
   * mutation is refused and the UI explains where the change happens.
   */
  'managed_by_directory',
  /**
   * The mutation would leave a live Team without an active owner. Ordinary Team
   * administration must transfer ownership first; security offboarding is a
   * different owner and deliberately does not fail here.
   */
  'team_owner_transfer_required',
  /** The target Account does not exist on this Home. */
  'account_not_found',
  /** The target Account is not active and cannot hold Team membership. */
  'account_ineligible',
]));
export type TeamErrorCodeV1 = z.infer<typeof TeamErrorCodeV1Schema>;

export const TeamAuthenticationPolicyUnavailableDetailsV1Schema = lazyZodSchema(() => z.object({
  reason: z.literal('provider_test_required'),
}).strict());
export type TeamAuthenticationPolicyUnavailableDetailsV1 = z.infer<
  typeof TeamAuthenticationPolicyUnavailableDetailsV1Schema
>;

/**
 * The one error body every Team route sends. Clients read `error`; a route that
 * invented its own envelope would make the same domain result unreadable
 * depending on which path produced it.
 */
export const TeamErrorV1Schema = lazyZodSchema(() => z.object({
  error: TeamErrorCodeV1Schema,
  details: TeamAuthenticationPolicyUnavailableDetailsV1Schema.optional(),
}).strict().superRefine((value, context) => {
  if (value.details !== undefined && value.error !== 'team_authentication_policy_unavailable') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['details'],
      message: 'Team authentication-policy details require the matching unavailable error',
    });
  }
}));
export type TeamErrorV1 = z.infer<typeof TeamErrorV1Schema>;

/**
 * The single code → status mapping, shared by every Team route so one domain
 * result cannot become two different wire contracts.
 *
 * `teams_unavailable` is 404 rather than 403: when the deployment has Teams
 * disabled the routes are not part of this Home's surface at all, which is what
 * the feature-gated route owner already returns.
 */
export function teamErrorHttpStatusV1(code: TeamErrorCodeV1): 400 | 403 | 404 | 409 | 503 {
  switch (code) {
    case 'invalid_team_input':
    case 'invalid_team_cursor':
    case 'invalid_team_authentication_policy':
      return 400;
    case 'team_forbidden':
    case 'team_authentication_required':
    // Not being a member is a permission answer, not a hidden resource: the
    // caller already reached a Team it may address, so 404 would be a lie.
    case 'not_team_member':
      return 403;
    case 'team_not_found':
    case 'teams_unavailable':
      return 404;
    case 'team_authentication_unavailable':
      return 503;
    case 'invitation_not_found':
    case 'membership_not_found':
    case 'group_not_found':
    case 'account_not_found':
      return 404;
    case 'team_archived':
    case 'team_conflict':
    case 'team_authentication_policy_conflict':
    case 'team_authentication_policy_unavailable':
    case 'invitation_not_active':
    case 'invitation_email_unavailable':
    case 'group_archived':
    case 'group_name_taken':
    case 'management_conflict':
    case 'managed_by_directory':
    case 'team_owner_transfer_required':
    case 'account_ineligible':
      return 409;
  }
}
