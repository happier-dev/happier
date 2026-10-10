import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { AccountDisplayProfileV1Schema } from '../account/accountDisplayProfileV1.js';
import {
  decodeTeamKeysetCursorV1,
  encodeTeamKeysetCursorV1,
  readTeamKeysetIdV1,
  readTeamKeysetTimeV1,
} from './cursor.js';
import {
  SessionHistoryAccessV1Schema,
  TeamRoleV1Schema,
  type SessionHistoryAccessV1,
  type TeamRoleV1,
} from './team.js';

/**
 * The one closed input vocabulary for Session-history admission.
 *
 * Reused by Group and invitation contracts. Membership persistence stores only
 * the normalized result (a nullable cutoff), so this enum is the public semantic
 * projection of that cutoff, never a second stored fact.
 *
 * Canonical owner is `team.ts` (Lane 01.03 §4.4 — `SessionHistoryAccess` is the
 * one shared Team/Group membership-history vocabulary, and umbrella §5.1 assigns
 * `L01-R8` Team vocabulary to child 03 with 04/05 consuming canonical names).
 * These are aliases, not a second definition: a duplicate `z.enum` here would be
 * a second decision-maker for the same concept. Contract the alias once the
 * membership consumers import the `V1` names directly.
 */
export const SessionHistoryAccessSchema = SessionHistoryAccessV1Schema;
export type SessionHistoryAccess = SessionHistoryAccessV1;

/**
 * Team roles are a fixed, scope-specific enum. `guest` is a real restricted
 * collaborator: rostered and visible, excluded from Team-principal access, and
 * without governance capability. It is never a synonym for `member`.
 *
 * Canonical owner is `team.ts`, which also exports `isTeamPrincipalRoleV1` —
 * consume that predicate rather than respelling the guest exclusion.
 */
export const TeamRoleSchema = TeamRoleV1Schema;
export type TeamRole = TeamRoleV1;

/**
 * Absence of a row means removal, so no `invited`, `disabled`, or `deleted` member
 * state exists here. Account lifecycle keeps its own separate meaning.
 */
export const TeamMembershipStatusSchema = lazyZodSchema(() => z.enum(['active', 'suspended']));
export type TeamMembershipStatus = z.infer<typeof TeamMembershipStatusSchema>;

export const TeamIdSchema = lazyZodSchema(() => z.string().min(1));
export const TeamGroupIdSchema = lazyZodSchema(() => z.string().min(1));

/**
 * One immutable membership lifetime. Removal ends it; rejoining mints a new one,
 * so downstream member-lifetime grants cannot be resurrected by re-adding a person.
 */
export const TeamMembershipIdSchema = lazyZodSchema(() => z.string().min(1));

/**
 * The public address of a person's Group membership.
 *
 * Callers address Group membership by Account, never by a surrogate Group-membership
 * id: the server resolves the current Team-membership lifetime inside the deciding
 * transaction. This keeps Group rows attached across provider Account replacement
 * and leaves exactly one resolution owner.
 */
export const TeamGroupMemberAddressV1Schema = lazyZodSchema(() => z.object({
  teamId: TeamIdSchema,
  groupId: TeamGroupIdSchema,
  accountId: z.string().min(1),
}).strict());
export type TeamGroupMemberAddressV1 = z.infer<typeof TeamGroupMemberAddressV1Schema>;

/**
 * Roles a Team manager may confer when admitting someone.
 *
 * Owner is absent by construction, exactly as it is for an invitation: owner
 * promotion remains an explicit post-membership governance operation with
 * last-owner enforcement, so no admission input can mint one.
 */
export const TeamAdmissibleRoleV1Schema = lazyZodSchema(() => z.enum(['admin', 'member', 'guest']));
export type TeamAdmissibleRoleV1 = z.infer<typeof TeamAdmissibleRoleV1Schema>;

/**
 * `teams.members.add` — direct admission of an already existing, exactly
 * identified Account.
 *
 * The input carries an Account id, never a search term: the authorized picker
 * projection resolves people, and a Team manager never gains a Home-wide lookup
 * capability by managing one Team. The mutation still rechecks the actor's
 * capability and the target's eligibility, so a stale selection or a guessed id
 * cannot admit anyone.
 *
 * The history intent is required rather than defaulted at the wire: an
 * administrator's explicit choice is the product contract, and a silently
 * defaulted horizon is exactly the ambiguity `L01-MGH-R8` exists to prevent.
 * Unattended directory activation uses the Team default instead, which is a
 * different caller rather than a different meaning.
 *
 * The result is one shape, `TeamMembershipV1`: admission is idempotent, so an
 * Account that already belongs answers with its existing membership rather than
 * an outcome discriminator the surface would have to translate. A re-add never
 * resets an existing role, status, or history horizon.
 */
export const TeamMemberAddInputV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  teamId: TeamIdSchema,
  accountId: z.string().min(1),
  role: TeamAdmissibleRoleV1Schema,
  historyAccess: SessionHistoryAccessSchema,
}).strict());
export type TeamMemberAddInputV1 = z.infer<typeof TeamMemberAddInputV1Schema>;

/**
 * Who currently owns lifecycle changes for one membership.
 *
 * The label is a display name supplied by the managing source's own projection.
 * Raw external user ids, provider claims, directory cursors, and reconciliation
 * markers are deliberately absent: this projection exists so a roster can
 * *explain* where a change happens, never so a client can reconstruct provider
 * authority.
 *
 * `directorySourceId` is the one exception and is present for the same reason
 * the Group projection carries its `bindingId`: member detail must be able to
 * open the exact source that owns this lifetime. It is navigation, never
 * resource authorization — the directory destination re-checks its own
 * capability before it shows anything.
 */
export const TeamMembershipManagementV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('native') }).strict(),
  z.object({
    kind: z.literal('directory_source'),
    directorySourceId: z.string().min(1),
    label: z.string(),
  }).strict(),
  z.object({
    kind: z.literal('identity_connection'),
    identityConnectionId: z.string().min(1),
    label: z.string(),
  }).strict(),
]));
export type TeamMembershipManagementV1 = z.infer<typeof TeamMembershipManagementV1Schema>;

/**
 * What the viewer may do to *this* member, decided by the server.
 *
 * These exist because the rules are not derivable from a role string: an admin
 * may not touch an owner, ordinary administration may not strand the final
 * active owner, and a directory-managed lifetime is native read-only. A client
 * that reconstructed those from `role` and `management` would be a second
 * authority for the same question — exactly what `L01-MGH-R16` forbids.
 *
 * Like every projection this renders and prechecks; the mutation's own
 * transaction remains decisive.
 */
export const TeamMembershipCapabilitiesV1Schema = lazyZodSchema(() => z.object({
  setRole: z.boolean(),
  assignableRoles: z.array(TeamRoleV1Schema),
  suspend: z.boolean(),
  reactivate: z.boolean(),
  remove: z.boolean(),
  setManagement: z.boolean(),
}).strict());
export type TeamMembershipCapabilitiesV1 = z.infer<typeof TeamMembershipCapabilitiesV1Schema>;

export const NO_TEAM_MEMBERSHIP_CAPABILITIES_V1: TeamMembershipCapabilitiesV1 = Object.freeze({
  setRole: false,
  assignableRoles: [],
  suspend: false,
  reactivate: false,
  remove: false,
  setManagement: false,
});

/**
 * One roster row.
 *
 * `historyAccess` is the semantic mode, never the raw `sessionAccessStartsAt`
 * cutoff: the cutoff is a server-owned access input, and publishing it would
 * invite a client to compare it with a grant timestamp — Lane 04's exclusive
 * decision. The row also carries no email, external identifier, identity claim,
 * or cryptographic material.
 */
export const TeamMembershipV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  id: TeamMembershipIdSchema,
  teamId: TeamIdSchema,
  accountId: z.string().min(1),
  account: AccountDisplayProfileV1Schema,
  role: TeamRoleSchema,
  status: TeamMembershipStatusSchema,
  historyAccess: SessionHistoryAccessSchema,
  management: TeamMembershipManagementV1Schema,
  capabilities: TeamMembershipCapabilitiesV1Schema,
  joinedAt: z.number().int().min(0),
}).strict());
export type TeamMembershipV1 = z.infer<typeof TeamMembershipV1Schema>;

/**
 * The compact, current-purpose roster filters from the Members screen. This is
 * deliberately a closed enum rather than a query language: a filter DSL is
 * explicitly out of scope. Looking one person up is the separate bounded
 * `query` below, not another filter value.
 */
export const TeamMembersListFilterV1Schema = lazyZodSchema(() => z.enum([
  'all',
  'owners_admins',
  'members',
  'guests',
  'suspended',
]));
export type TeamMembersListFilterV1 = z.infer<typeof TeamMembersListFilterV1Schema>;

export const TEAM_MEMBERS_PAGE_LIMIT_MAX_V1 = 100;
export const TEAM_MEMBERS_PAGE_LIMIT_DEFAULT_V1 = 50;

export const TeamMembersListInputV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  teamId: TeamIdSchema,
  filter: TeamMembersListFilterV1Schema,
  limit: z.number().int().min(1).max(TEAM_MEMBERS_PAGE_LIMIT_MAX_V1).optional(),
  cursor: z.string().min(1).nullable().optional(),
  /**
   * One bounded lookup over the whole roster, in the same shape the Team
   * directory contract already ships. Narrowing only the pages a reader holds
   * reports a member on a later page as absent, so the Home answers the
   * question instead. Paging is unchanged: a query names its own sequence.
   */
  query: z.string().max(256).optional(),
}).strict());
export type TeamMembersListInputV1 = z.infer<typeof TeamMembersListInputV1Schema>;

export const TeamMembersPageV1Schema = lazyZodSchema(() => z.object({
  items: z.array(TeamMembershipV1Schema),
  nextCursor: z.string().nullable(),
}).strict());
export type TeamMembersPageV1 = z.infer<typeof TeamMembersPageV1Schema>;

/** `teams.members.get`, `suspend`, `reactivate`, `remove`. */
export const TeamMemberRefInputV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  teamId: TeamIdSchema,
  membershipId: TeamMembershipIdSchema,
}).strict());
export type TeamMemberRefInputV1 = z.infer<typeof TeamMemberRefInputV1Schema>;

/**
 * `teams.members.role.set`. Owner is admissible here and only here; the server
 * additionally requires `manageOwners` whenever the current or resulting role is
 * owner, and refuses to strand the final active owner.
 */
export const TeamMemberRoleSetInputV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  teamId: TeamIdSchema,
  membershipId: TeamMembershipIdSchema,
  role: TeamRoleSchema,
}).strict());
export type TeamMemberRoleSetInputV1 = z.infer<typeof TeamMemberRoleSetInputV1Schema>;

/**
 * `teams.members.management.set` — §6.2's deliberate conversion, which preserves
 * the membership lifetime, role, status, and horizon. The exact source is named
 * so a conversion cannot be a vague "manage externally" that silently picks a
 * connection; converting back to native names no source at all.
 *
 * `identity_connection` is admissible as a *projection* of who manages a
 * lifetime, but not as a conversion target: the connection-to-membership binding
 * that would record it belongs to the Lane 03 OIDC admission owner and does not
 * exist. Accepting it here would mean either a dormant input the server always
 * refuses, or a second binding invented outside its owner.
 */
export const TeamMemberManagementTargetV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('native') }).strict(),
  z.object({ kind: z.literal('directory_source'), directorySourceId: z.string().min(1) }).strict(),
]));
export type TeamMemberManagementTargetV1 = z.infer<typeof TeamMemberManagementTargetV1Schema>;

export const TeamMemberManagementSetInputV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  teamId: TeamIdSchema,
  membershipId: TeamMembershipIdSchema,
  management: TeamMemberManagementTargetV1Schema,
}).strict());
export type TeamMemberManagementSetInputV1 = z.infer<typeof TeamMemberManagementSetInputV1Schema>;

/**
 * Removal is idempotent: a repeated request against an already-removed lifetime
 * is `unchanged`, not a 404, so a retried confirmation cannot read as a failure.
 * The server still rechecks authorization before answering `unchanged`.
 */
export const TeamMemberRemoveResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.object({ status: z.literal('removed'), membershipId: TeamMembershipIdSchema }).strict(),
  z.object({ status: z.literal('unchanged') }).strict(),
]));
export type TeamMemberRemoveResultV1 = z.infer<typeof TeamMemberRemoveResultV1Schema>;

/**
 * The roster's stable ordering tuple: immutable creation time, then the
 * membership lifetime id. Neither component changes under a role edit, a
 * suspension, a rename, or a provider Account replacement, so a page sequence
 * cannot shuffle beneath a scrolling reader.
 *
 * `limit` is excluded from the binding: changing page size mid-sequence is
 * legitimate. The Team, filter and lookup are not, because each would change
 * which rows the position refers to.
 */
export function teamMembersQueryKeyV1(input: TeamMembersListInputV1): string {
  // A query selects different rows, so it belongs to the sequence identity. An
  // unqueried roster keeps the key it already had, so positions minted before
  // the field existed stay valid.
  const query = input.query?.trim() ?? '';
  const base = `v1:members:${input.teamId}:${input.filter}`;
  return query === '' ? base : `${base}:${query}`;
}

export type TeamMembersCursorV1 = Readonly<{ createdAt: number; id: string }>;

export type TeamMembersCursorDecodeV1 =
  | Readonly<{ status: 'ok'; cursor: TeamMembersCursorV1 }>
  | Readonly<{ status: 'invalid' }>;

export function encodeTeamMembersCursorV1(input: Readonly<{
  queryKey: string;
  createdAt: number;
  id: string;
}>): string {
  return encodeTeamKeysetCursorV1({ queryKey: input.queryKey, parts: [input.createdAt, input.id] });
}

export function decodeTeamMembersCursorV1(value: string, queryKey: string): TeamMembersCursorDecodeV1 {
  const decoded = decodeTeamKeysetCursorV1(value, queryKey);
  if (decoded.status !== 'ok') return { status: 'invalid' };
  const createdAt = readTeamKeysetTimeV1(decoded.parts[0]);
  const id = readTeamKeysetIdV1(decoded.parts[1]);
  if (createdAt === null || id === null) return { status: 'invalid' };
  return { status: 'ok', cursor: { createdAt, id } };
}
