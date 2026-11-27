import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

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
  'managed_default_machine_not_member_usable',
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
  'team_member_limit_reached',
  'team_seats_required',
]));
export type TeamErrorCodeV1 = z.infer<typeof TeamErrorCodeV1Schema>;

export const TeamSeatsRequiredDetailsV1Schema = lazyZodSchema(() => z.strictObject({
  current: z.int().check(z.minimum(0)),
  free: z.int().check(z.minimum(0)),
}));
export type TeamSeatsRequiredDetailsV1 = z.infer<typeof TeamSeatsRequiredDetailsV1Schema>;

export const TeamAuthenticationPolicyUnavailableDetailsV1Schema = lazyZodSchema(() => z.strictObject({
  reason: z.literal('provider_test_required'),
}));
export type TeamAuthenticationPolicyUnavailableDetailsV1 = z.infer<
  typeof TeamAuthenticationPolicyUnavailableDetailsV1Schema
>;

const TeamInputErrorDetailsV1Schema = lazyZodSchema(() => z.strictObject({
  field: z.enum(['name', 'description', 'initialOwnerAccountId']),
  reason: z.string().check(z.trim(), z.minLength(1)),
}));

const TeamCreationPolicyRefusalDetailsV1Schema = lazyZodSchema(() => z.strictObject({
  reason: z.enum(['managed_only', 'disabled']),
}));
export type TeamCreationPolicyRefusalDetailsV1 = z.infer<typeof TeamCreationPolicyRefusalDetailsV1Schema>;

/** Action carriers retain the Team error body and may add transport metadata around it. */
export function readTeamCreationPolicyRefusalV1(
  code: unknown,
  body: unknown,
): TeamCreationPolicyRefusalDetailsV1 | null {
  if (code !== 'team_forbidden' || !body || typeof body !== 'object'
    || !('error' in body) || body.error !== code || !('details' in body)) return null;
  return TeamCreationPolicyRefusalDetailsV1Schema.safeParse(body.details).data ?? null;
}

/**
 * Why Team routes refused a credential the Home still accepts elsewhere: a
 * released 0.2 Home sign-in. `team_forbidden` alone also answers a member whose
 * role lacks a capability; only this cause is fixed by signing in again.
 */
const TeamLegacyCredentialRefusalDetailsV1Schema = lazyZodSchema(() => z.strictObject({
  reason: z.literal('legacy_home_credential'),
}));
export const TEAM_LEGACY_CREDENTIAL_REFUSAL_DETAILS_V1 = Object.freeze({ reason: 'legacy_home_credential' as const });

/** Whether a Team failure body is the refusal of a released 0.2 Home sign-in. */
export function isTeamLegacyCredentialRefusalV1(code: unknown, body: unknown): boolean {
  if (code !== 'team_forbidden' || !body || typeof body !== 'object'
    || !('error' in body) || body.error !== code || !('details' in body)) return false;
  return TeamLegacyCredentialRefusalDetailsV1Schema.safeParse(body.details).success;
}

/**
 * The one error body every Team route sends. Clients read `error`; a route that
 * invented its own envelope would make the same domain result unreadable
 * depending on which path produced it.
 */
export const TeamErrorV1Schema = lazyZodSchema(() => z.strictObject({
  error: TeamErrorCodeV1Schema,
  details: z.optional(z.union([
    TeamAuthenticationPolicyUnavailableDetailsV1Schema,
    TeamInputErrorDetailsV1Schema,
    TeamCreationPolicyRefusalDetailsV1Schema,
    TeamLegacyCredentialRefusalDetailsV1Schema,
    TeamSeatsRequiredDetailsV1Schema,
  ])),
}).check(z.superRefine((value, context) => {
  if (value.details !== undefined && !(
    (value.error === 'team_authentication_policy_unavailable'
      && TeamAuthenticationPolicyUnavailableDetailsV1Schema.safeParse(value.details).success)
    || (value.error === 'invalid_team_input' && TeamInputErrorDetailsV1Schema.safeParse(value.details).success)
    || (value.error === 'team_forbidden' && (TeamCreationPolicyRefusalDetailsV1Schema.safeParse(value.details).success
      || TeamLegacyCredentialRefusalDetailsV1Schema.safeParse(value.details).success))
    || (value.error === 'team_seats_required' && TeamSeatsRequiredDetailsV1Schema.safeParse(value.details).success)
  )) {
    context.addIssue({
      code: "custom",
      path: ['details'],
      message: 'Team failure details require their matching error code',
    });
  }
})));
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
    case 'managed_default_machine_not_member_usable':
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
    case 'team_member_limit_reached':
    case 'team_seats_required':
      return 409;
  }
}
