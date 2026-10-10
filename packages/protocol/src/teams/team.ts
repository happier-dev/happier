import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import {
  TeamAuthenticationPolicyV1Schema,
  TeamRestrictedAuthenticationPolicyV1Schema,
} from '../auth/teamAuthenticationPolicy.js';

/**
 * The Team role of one membership. Like the Home role this is a fixed,
 * scope-specific enum: holding a Home role never implies a Team role, and no
 * role authority is ever carried in a bearer token.
 *
 * `guest` is an active, rostered member with the ratified restricted meaning —
 * no governance capability and no Team-principal or Team-default resource
 * eligibility. Only a direct Account grant or an explicit Group grant can
 * authorize a guest, and no consumer may treat it as `member`.
 */
export const TeamRoleV1Schema = lazyZodSchema(() => z.enum(['owner', 'admin', 'member', 'guest']));
export type TeamRoleV1 = z.infer<typeof TeamRoleV1Schema>;

/** The roles that receive Team-principal (Team-default) eligibility downstream. */
export const TEAM_PRINCIPAL_ROLES_V1: readonly TeamRoleV1[] = Object.freeze(['owner', 'admin', 'member']);

/**
 * Whether a Team-principal expansion includes this role. Downstream access and
 * entitlement owners consume this single predicate rather than respelling the
 * guest exclusion, which is the failure the ratified decision exists to prevent.
 */
export function isTeamPrincipalRoleV1(role: TeamRoleV1): boolean {
  return role !== 'guest';
}

/** The initial/required Team audience intent for new Team-context Sessions. */
export const TeamSessionCreationPolicyV1Schema = lazyZodSchema(() => z.enum(['private_default', 'team_default', 'team_required']));
export type TeamSessionCreationPolicyV1 = z.infer<typeof TeamSessionCreationPolicyV1Schema>;

/** May only narrow external sharing; the Session owner still decides each share. */
export const TeamExternalSharingPolicyV1Schema = lazyZodSchema(() => z.enum(['allowed', 'team_admins_only', 'disabled']));
export type TeamExternalSharingPolicyV1 = z.infer<typeof TeamExternalSharingPolicyV1Schema>;

/**
 * The one shared Team/Group membership-history vocabulary. `all_existing` means
 * every otherwise applicable existing grant; `from_membership` means only grants
 * strictly after the actual activation cutoff minted by the membership owner.
 */
export const SessionHistoryAccessV1Schema = lazyZodSchema(() => z.enum(['all_existing', 'from_membership']));
export type SessionHistoryAccessV1 = z.infer<typeof SessionHistoryAccessV1Schema>;

/** How members are admitted. This is admission intent, not accepted authentication. */
export const TeamAdmissionModeV1Schema = lazyZodSchema(() => z.enum(['invite_only', 'provisioned', 'jit']));
export type TeamAdmissionModeV1 = z.infer<typeof TeamAdmissionModeV1Schema>;

/**
 * The ratified default history horizon. A new member does not unexpectedly see
 * older Team Sessions; an authorized manager may still choose `all_existing`
 * for a concrete admission.
 */
export const TEAM_DEFAULT_SESSION_HISTORY_ACCESS_V1: SessionHistoryAccessV1 = 'from_membership';

/**
 * The complete Team policy projection: closed enums with named downstream
 * consumers and nothing else. There is deliberately no rules bag, no condition
 * language, no Group override, and no revision counter.
 *
 * Authentication narrowing consumes the canonical Lane 03 selector codec.
 * Persisted null is inherit; projections retain that one representation.
 */
export const TeamPolicyV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  sessionCreationPolicy: TeamSessionCreationPolicyV1Schema,
  externalSharingPolicy: TeamExternalSharingPolicyV1Schema,
  defaultSessionHistoryAccess: SessionHistoryAccessV1Schema,
  admissionMode: TeamAdmissionModeV1Schema,
  authenticationPolicy: TeamRestrictedAuthenticationPolicyV1Schema.nullable(),
  /**
   * Malformed persisted policy is never reinterpreted as inheritance. Older
   * Team projections may omit this additive field; current servers always
   * publish it so an administrator can distinguish repair from Home-policy use.
   */
  authenticationPolicyStatus: z.enum(['available', 'repair_required']).optional(),
}).strict());
export type TeamPolicyV1 = z.infer<typeof TeamPolicyV1Schema>;

/**
 * Presentation bounds. These are display limits, not identity keys: two Teams
 * may hold the same name, and nothing derived from a name is ever used for
 * routing, uniqueness, or authorization.
 */
export const TEAM_NAME_MAX_LENGTH_V1 = 80;
export const TEAM_DESCRIPTION_MAX_LENGTH_V1 = 500;

// C0 and C1 control characters that survive whitespace collapsing. Tab, line
// feed, and friends are whitespace and are folded before this test runs.
const TEAM_CONTROL_CHARACTERS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;

/**
 * The single Team display-name normalizer, shared by the server writer and the
 * client's live preview so both agree on the stored value. It normalizes to
 * NFC, collapses internal Unicode whitespace, and trims — it never folds case
 * or strips characters, because a normalized name is presentation and must not
 * become a uniqueness key.
 */
export function normalizeTeamNameV1(raw: string): string {
  return raw.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

export type TeamNameValidationV1 =
  | Readonly<{ status: 'ok'; name: string }>
  | Readonly<{ status: 'invalid'; reason: 'empty' | 'too_long' | 'control_characters' }>;

/** Normalizes, then admits or rejects with the precise reason the UI shows. */
export function validateTeamNameV1(raw: string): TeamNameValidationV1 {
  const name = normalizeTeamNameV1(raw);
  if (TEAM_CONTROL_CHARACTERS_RE.test(name)) return { status: 'invalid', reason: 'control_characters' };
  if (name.length === 0) return { status: 'invalid', reason: 'empty' };
  if (name.length > TEAM_NAME_MAX_LENGTH_V1) return { status: 'invalid', reason: 'too_long' };
  return { status: 'ok', name };
}

export type TeamDescriptionValidationV1 =
  | Readonly<{ status: 'ok'; description: string | null }>
  | Readonly<{ status: 'invalid'; reason: 'too_long' | 'control_characters' }>;

/**
 * Bounded plain presentation text. Internal line breaks are preserved because
 * a description is a paragraph, but it is never HTML and never authorization
 * metadata. A blank description stores `null` rather than an empty string, so
 * "absent" has one representation.
 */
export function validateTeamDescriptionV1(raw: string | null | undefined): TeamDescriptionValidationV1 {
  if (raw === null || raw === undefined) return { status: 'ok', description: null };
  const description = raw.normalize('NFC').replace(/\r\n?/gu, '\n').trim();
  if (description.length === 0) return { status: 'ok', description: null };
  if (TEAM_CONTROL_CHARACTERS_RE.test(description.replace(/\n/gu, ''))) {
    return { status: 'invalid', reason: 'control_characters' };
  }
  if (description.length > TEAM_DESCRIPTION_MAX_LENGTH_V1) return { status: 'invalid', reason: 'too_long' };
  return { status: 'ok', description };
}

const TeamIdV1Schema = lazyZodSchema(() => z.string().min(1).max(64));
const TeamNameInputV1Schema = lazyZodSchema(() => z.string().min(1).max(TEAM_NAME_MAX_LENGTH_V1 * 4));
const TeamDescriptionInputV1Schema = lazyZodSchema(() => z.string().max(TEAM_DESCRIPTION_MAX_LENGTH_V1 * 4));

/**
 * `teams.create`. `initialOwnerAccountId` is how a Home administrator creates a
 * managed Team for somebody else without implicitly becoming a member; when it
 * is absent the authenticated creator becomes the initial owner. Under a
 * `managed_only` Home creation policy the initial owner must be named
 * explicitly — omitting it is refused as `invalid_team_input` rather than
 * silently making the administrator the owner.
 *
 * `requestKey` is the caller's own retry identity, so a lost response cannot
 * create two Teams. It is scoped to actor, operation, and payload at the
 * existing idempotent domain transaction boundary — not a generic Action ledger.
 */
export const TeamCreateInputV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  name: TeamNameInputV1Schema,
  description: TeamDescriptionInputV1Schema.nullable().optional(),
  initialOwnerAccountId: z.string().min(1).optional(),
  requestKey: z.string().min(1).max(128),
}).strict());
export type TeamCreateInputV1 = z.infer<typeof TeamCreateInputV1Schema>;

/**
 * `teams.update`. Metadata only, authorized by `manageSettings`. An omitted
 * field is unchanged; an explicit null description clears it.
 */
export const TeamUpdateInputV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  teamId: TeamIdV1Schema,
  name: TeamNameInputV1Schema.optional(),
  description: TeamDescriptionInputV1Schema.nullable().optional(),
}).strict().refine(
  (input) => input.name !== undefined || input.description !== undefined,
  { message: 'Team metadata patch changes nothing' },
));
export type TeamUpdateInputV1 = z.infer<typeof TeamUpdateInputV1Schema>;

/**
 * `teams.policy.set`. Omitted means unchanged; the patch commits wholly or not
 * at all so a permitted Session-default edit can never clear a field the actor
 * was not authorized to change.
 *
 * Authentication policy is independently authorized by `manageAuthentication`.
 */
export const TeamAuthenticationPolicyRepairBasisV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  status: z.literal('repair_required'),
}).strict());
export type TeamAuthenticationPolicyRepairBasisV1 = z.infer<typeof TeamAuthenticationPolicyRepairBasisV1Schema>;

export const TeamAuthenticationPolicyComparisonBasisV1Schema = lazyZodSchema(() => z.union([
  TeamRestrictedAuthenticationPolicyV1Schema,
  TeamAuthenticationPolicyRepairBasisV1Schema,
  z.null(),
]));
export type TeamAuthenticationPolicyComparisonBasisV1 = z.infer<
  typeof TeamAuthenticationPolicyComparisonBasisV1Schema
>;

export const TeamPolicySetInputV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  teamId: TeamIdV1Schema,
  sessionCreationPolicy: TeamSessionCreationPolicyV1Schema.optional(),
  externalSharingPolicy: TeamExternalSharingPolicyV1Schema.optional(),
  defaultSessionHistoryAccess: SessionHistoryAccessV1Schema.optional(),
  admissionMode: TeamAdmissionModeV1Schema.optional(),
  previousAuthenticationPolicy: TeamAuthenticationPolicyComparisonBasisV1Schema.optional(),
  authenticationPolicy: TeamAuthenticationPolicyV1Schema.nullable().optional(),
}).strict().superRefine((input, context) => {
  if ((input.authenticationPolicy !== undefined) !== (input.previousAuthenticationPolicy !== undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Authentication policy edits require the previously read canonical value',
      path: ['previousAuthenticationPolicy'],
    });
  }
}).refine(
  (input) => input.sessionCreationPolicy !== undefined
    || input.externalSharingPolicy !== undefined
    || input.defaultSessionHistoryAccess !== undefined
    || input.admissionMode !== undefined
    || input.authenticationPolicy !== undefined,
  { message: 'Team policy patch changes nothing' },
));
export type TeamPolicySetInputV1 = z.infer<typeof TeamPolicySetInputV1Schema>;

/** `teams.get`, `teams.archive`, `teams.restore`, `teams.logo.remove`. */
export const TeamRefInputV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  teamId: TeamIdV1Schema,
}).strict());
export type TeamRefInputV1 = z.infer<typeof TeamRefInputV1Schema>;

/**
 * The client/navigation/cache identity. Home-local persistence and server API
 * never redundantly store `serverId`: one server database is one Home, and the
 * client is the only layer that must disambiguate several Homes.
 */
export type TeamAddressV1 = Readonly<{
  serverId: string;
  teamId: string;
}>;
