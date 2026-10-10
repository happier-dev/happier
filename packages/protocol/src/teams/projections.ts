import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { ImageRefSchema } from '../common/imageRef.js';
import { TeamCapabilitiesV1Schema } from './capabilities.js';
import {
  decodeTeamKeysetCursorV1,
  encodeTeamKeysetCursorV1,
  readTeamKeysetIdV1,
  readTeamKeysetTextV1,
} from './cursor.js';
import { isTeamPrincipalRoleV1, TeamPolicyV1Schema, TeamRoleV1Schema } from './team.js';

/**
 * Whether an admission screen offers the history-horizon choice for this role.
 * A guest never receives Team-principal access, so offering it a Team history
 * choice would promise access the role does not carry. The membership owner
 * projects this so invitation and direct-add screens share one rule and one
 * wording rather than each inferring the guest exception.
 */
const TeamHistoryChoiceAvailabilityV1Schema = lazyZodSchema(() => z.enum(['choice', 'hidden']));

export const TeamAdmissionProjectionV1Schema = lazyZodSchema(() => z.object({
  historyChoice: z.object({
    admin: TeamHistoryChoiceAvailabilityV1Schema,
    member: TeamHistoryChoiceAvailabilityV1Schema,
    guest: TeamHistoryChoiceAvailabilityV1Schema,
  }).strict(),
}).strict());
export type TeamAdmissionProjectionV1 = z.infer<typeof TeamAdmissionProjectionV1Schema>;

/**
 * The one admission-history rule, derived from the one guest rule.
 *
 * `owner` is absent because a Team's initial owner is created with the Team and
 * later owners are promoted from an existing membership; neither is an admission
 * screen. Deriving each entry from `isTeamPrincipalRoleV1` rather than writing a
 * table means the guest exception cannot drift away from the role semantics that
 * justify it.
 */
export function resolveTeamAdmissionProjectionV1(): TeamAdmissionProjectionV1 {
  const availability = (role: 'admin' | 'member' | 'guest') =>
    isTeamPrincipalRoleV1(role) ? ('choice' as const) : ('hidden' as const);
  return Object.freeze({
    historyChoice: Object.freeze({
      admin: availability('admin'),
      member: availability('member'),
      guest: availability('guest'),
    }),
  });
}

/**
 * The canonical Team projection returned by `teams.get` and `teams.list`.
 *
 * It carries no `serverId` or `homeId`: one server database is one Home, so the
 * API is already Home-bound and only the multi-Home client qualifies the ID.
 * It carries only the counts a real UI surface consumes (`counts`, the Team
 * Overview summaries), each answered by one grouped query per page rather than
 * a count per row.
 *
 * `logo` uses the released shared `ImageRef` output shape. That schema is
 * deliberately not tightened globally here; the Team-logo *mutation input* has
 * its own Team-owned strict schema at the media boundary.
 */
/**
 * The Team Overview summary counts, qualified by the viewer's projected
 * capabilities: the whole object is `null` unless the viewer may read the Team
 * (`viewTeam`), and `waitingInvitations` is `null` unless the viewer may read
 * the invitation list (`manageInvitations`). A count is never disclosed to a
 * viewer the corresponding list would refuse.
 *
 * - `members`: every membership (active and suspended), the roster's `all` set.
 * - `suspendedMembers`: memberships currently suspended.
 * - `groups`: Groups that are not archived.
 * - `waitingInvitations`: invitations that are neither accepted, revoked nor expired.
 */
export const TeamSummaryCountsV1Schema = lazyZodSchema(() => z.object({
  members: z.number().int().min(0),
  suspendedMembers: z.number().int().min(0),
  groups: z.number().int().min(0),
  waitingInvitations: z.number().int().min(0).nullable(),
}).strict());
export type TeamSummaryCountsV1 = z.infer<typeof TeamSummaryCountsV1Schema>;

export const TeamSummaryV1Schema = lazyZodSchema(() => z.object({
  id: z.string().min(1),
  name: z.string(),
  description: z.string().nullable(),
  logo: ImageRefSchema.nullable(),
  archivedAt: z.number().nullable(),
  recovery: z.object({
    kind: z.literal('owner_required'),
    canAppointOwner: z.boolean(),
  }).strict().nullable(),
  policy: TeamPolicyV1Schema,
  viewerRole: TeamRoleV1Schema.nullable(),
  capabilities: TeamCapabilitiesV1Schema,
  admission: TeamAdmissionProjectionV1Schema,
  counts: TeamSummaryCountsV1Schema.nullable(),
}).strict());
export type TeamSummaryV1 = z.infer<typeof TeamSummaryV1Schema>;

/**
 * `teams.list`.
 *
 * `scope` separates ordinary membership visibility from the explicit
 * administrative scope a Home administrator with `manageAllTeams` may request
 * without becoming a member. Archived Teams are a separate query rather than a
 * mixed flag, which keeps one stable ordering per page sequence and matches the
 * separate collapsed section the directory renders.
 *
 * There is no `query` field: Team search is not part of this contract, and a
 * filter DSL is explicitly out of scope.
 */
export const TEAM_DIRECTORY_PAGE_LIMIT_MAX_V1 = 100;
export const TEAM_DIRECTORY_PAGE_LIMIT_DEFAULT_V1 = 50;

export const TeamsListInputV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  scope: z.enum(['member', 'administered']),
  archived: z.enum(['active', 'archived']),
  limit: z.number().int().min(1).max(TEAM_DIRECTORY_PAGE_LIMIT_MAX_V1).optional(),
  cursor: z.string().min(1).nullable().optional(),
}).strict());
export type TeamsListInputV1 = z.infer<typeof TeamsListInputV1Schema>;

/** The repository's public page convention; no generic pagination framework. */
export const TeamsPageV1Schema = lazyZodSchema(() => z.object({
  items: z.array(TeamSummaryV1Schema),
  nextCursor: z.string().nullable(),
}).strict());
export type TeamsPageV1 = z.infer<typeof TeamsPageV1Schema>;

/**
 * The stable ordering tuple: normalized display name, then immutable Team ID.
 * Names are not unique, so the ID supplies deterministic ordering and a rename
 * moves a Team within the sequence rather than breaking it.
 */
export type TeamDirectoryCursorV1 = Readonly<{ name: string; id: string }>;

export type TeamDirectoryCursorDecodeV1 =
  | Readonly<{ status: 'ok'; cursor: TeamDirectoryCursorV1 }>
  | Readonly<{ status: 'invalid' }>;

/**
 * Binds a cursor to the exact query that produced it. A cursor decoded against
 * a different scope or archived filter is rejected rather than silently
 * restarting at page one, which would otherwise look like duplicated rows.
 * `limit` is excluded: changing page size mid-sequence is legitimate.
 */
export function teamDirectoryQueryKeyV1(input: TeamsListInputV1): string {
  return `v1:${input.scope}:${input.archived}`;
}

/**
 * The cursor is opaque on purpose: its decoded fields are a position, never an
 * authority. Visibility and archive predicates are applied by the query before
 * the cursor narrows it, so a forged position cannot widen a result set. The
 * encoding, length bound, and query binding are the shared Team keyset codec;
 * only the ordering tuple belongs to this page.
 */
export function encodeTeamDirectoryCursorV1(input: Readonly<{
  queryKey: string;
  name: string;
  id: string;
}>): string {
  return encodeTeamKeysetCursorV1({ queryKey: input.queryKey, parts: [input.name, input.id] });
}

export function decodeTeamDirectoryCursorV1(value: string, queryKey: string): TeamDirectoryCursorDecodeV1 {
  const decoded = decodeTeamKeysetCursorV1(value, queryKey);
  if (decoded.status !== 'ok') return { status: 'invalid' };
  const name = readTeamKeysetTextV1(decoded.parts[0]);
  const id = readTeamKeysetIdV1(decoded.parts[1]);
  if (name === null || id === null) return { status: 'invalid' };
  return { status: 'ok', cursor: { name, id } };
}
