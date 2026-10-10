import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { AccountDisplayProfileV1Schema } from '../account/accountDisplayProfileV1.js';
import {
  decodeTeamKeysetCursorV1,
  encodeTeamKeysetCursorV1,
  readTeamKeysetIdV1,
  readTeamKeysetTextV1,
  readTeamKeysetTimeV1,
} from './cursor.js';
import {
  SessionHistoryAccessSchema,
  TeamGroupIdSchema,
  TeamIdSchema,
  TeamMembershipIdSchema,
} from './membership.js';
import { TeamExternalGroupBindingOwnerV1Schema } from './externalGroupBindings/v1.js';
import {
  TEAM_DESCRIPTION_MAX_LENGTH_V1,
  TEAM_NAME_MAX_LENGTH_V1,
  normalizeTeamNameV1,
  validateTeamDescriptionV1,
  validateTeamNameV1,
  type TeamDescriptionValidationV1,
  type TeamNameValidationV1,
} from './team.js';

/**
 * The flat Team Group contracts.
 *
 * A Group is a named targeting set inside exactly one Team. There is no nesting,
 * no Group role, no per-Group policy, no deny precedence, no persisted
 * "Everyone" row, and no Group-as-context: the Team principal already denotes
 * active non-guest members, and narrower audiences are exactly what a Group is.
 */

/**
 * Group names reuse the Team display-name owner — one normalizer, one set of
 * bounds, one validation vocabulary. Only the *uniqueness key* is Group-specific,
 * because a Team may hold two Teams-worth of identically named Groups only in
 * the sense that names are unique **within** their Team.
 */
export const TEAM_GROUP_NAME_MAX_LENGTH_V1 = TEAM_NAME_MAX_LENGTH_V1;
export const TEAM_GROUP_DESCRIPTION_MAX_LENGTH_V1 = TEAM_DESCRIPTION_MAX_LENGTH_V1;

export function normalizeTeamGroupNameV1(raw: string): string {
  return normalizeTeamNameV1(raw);
}

export function validateTeamGroupNameV1(raw: string): TeamNameValidationV1 {
  return validateTeamNameV1(raw);
}

export function validateTeamGroupDescriptionV1(
  raw: string | null | undefined,
): TeamDescriptionValidationV1 {
  return validateTeamDescriptionV1(raw);
}

/**
 * The stored uniqueness key for a Group name inside its Team.
 *
 * The display name stays exactly as typed — presentation is never folded. The
 * key adds only the case fold that in-Team uniqueness requires, so "Design" and
 * "design" cannot both exist and confuse a roster. It is derived from the shared
 * normalizer rather than a second Group-specific normalization scheme, and it is
 * a uniqueness key only: nothing routes, links, or authorizes through it.
 */
export function teamGroupNameKeyV1(raw: string): string {
  return normalizeTeamGroupNameV1(raw).toLowerCase();
}

/**
 * Who owns this Group's *metadata* lifecycle.
 *
 * Roster contribution is always additive and independent of this: a
 * directory-created Group still accepts native members, and a native-target
 * Group keeps native archive authority even while external sources contribute
 * members. `bindingId` is opaque and supports the management link to the exact
 * source settings — it is navigation, never resource authorization.
 */
export const TeamGroupManagementV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('native') }).strict(),
  z.object({
    kind: z.literal('directory_created'),
    bindingId: z.string().min(1),
    label: z.string(),
    owner: TeamExternalGroupBindingOwnerV1Schema,
  }).strict(),
]));
export type TeamGroupManagementV1 = z.infer<typeof TeamGroupManagementV1Schema>;

/**
 * What the viewer may do to this Group. `manageNativeMembers` stays true for a
 * directory-created Group — its roster is editable natively — while metadata
 * lifecycle follows the source disposition contract. A client cannot derive that
 * split from `management` alone without becoming a second authority for it.
 */
export const TeamGroupCapabilitiesV1Schema = lazyZodSchema(() => z.object({
  updateMetadata: z.boolean(),
  archive: z.boolean(),
  restore: z.boolean(),
  manageNativeMembers: z.boolean(),
}).strict());
export type TeamGroupCapabilitiesV1 = z.infer<typeof TeamGroupCapabilitiesV1Schema>;

export const NO_TEAM_GROUP_CAPABILITIES_V1: TeamGroupCapabilitiesV1 = Object.freeze({
  updateMetadata: false,
  archive: false,
  restore: false,
  manageNativeMembers: false,
});

/**
 * One Group row. `memberCount` counts effective Group-membership rows, never the
 * sum of contributions: a person contributed by native plus two directories is
 * one member, and the count the roster shows must be the count the roster pages.
 *
 * The stored `nameKey` is absent by design — it is an internal uniqueness key,
 * and publishing it would invite a client to compute collisions locally.
 */
export const TeamGroupV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  id: TeamGroupIdSchema,
  teamId: TeamIdSchema,
  name: z.string(),
  description: z.string().nullable(),
  archivedAt: z.number().nullable(),
  memberCount: z.number().int().min(0),
  management: TeamGroupManagementV1Schema,
  capabilities: TeamGroupCapabilitiesV1Schema,
}).strict());
export type TeamGroupV1 = z.infer<typeof TeamGroupV1Schema>;

/**
 * Why this person is in this Group.
 *
 * Membership is a plain set union with no precedence and no deny rules, so the
 * provenance is simply which contributions currently exist. The roster needs it
 * to tell the truth about a native remove that will not end access because a
 * directory still contributes, and to link to the exact source that owns that
 * contribution.
 */
export const TeamGroupMemberContributionsV1Schema = lazyZodSchema(() => z.object({
  native: z.boolean(),
  external: z.array(z.object({
    bindingId: z.string().min(1),
    label: z.string(),
    owner: TeamExternalGroupBindingOwnerV1Schema,
  }).strict()),
}).strict());
export type TeamGroupMemberContributionsV1 = z.infer<typeof TeamGroupMemberContributionsV1Schema>;

/**
 * One Group roster row. It carries the Account address and the Team-membership
 * lifetime it hangs on, and deliberately no surrogate Group-membership id: none
 * is minted anywhere, which is what keeps Group rows attached through provider
 * Account replacement.
 */
export const TeamGroupMemberV1Schema = lazyZodSchema(() => z.object({
  accountId: z.string().min(1),
  membershipId: TeamMembershipIdSchema,
  account: AccountDisplayProfileV1Schema,
  historyAccess: SessionHistoryAccessSchema,
  contributions: TeamGroupMemberContributionsV1Schema,
}).strict());
export type TeamGroupMemberV1 = z.infer<typeof TeamGroupMemberV1Schema>;

const TeamGroupNameInputV1Schema = lazyZodSchema(() => z.string().min(1).max(TEAM_GROUP_NAME_MAX_LENGTH_V1 * 4));
const TeamGroupDescriptionInputV1Schema = lazyZodSchema(() => z.string().max(TEAM_GROUP_DESCRIPTION_MAX_LENGTH_V1 * 4));

export const TEAM_GROUPS_PAGE_LIMIT_MAX_V1 = 100;
export const TEAM_GROUPS_PAGE_LIMIT_DEFAULT_V1 = 50;
export const TEAM_GROUP_MEMBERS_PAGE_LIMIT_MAX_V1 = 100;
export const TEAM_GROUP_MEMBERS_PAGE_LIMIT_DEFAULT_V1 = 50;

/**
 * `teams.groups.list`. Archived Groups are a separate query, matching the one
 * restrained "Archived Groups" section rather than a mixed flag that would make
 * one page sequence hold two orderings.
 */
export const TeamGroupsListInputV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  teamId: TeamIdSchema,
  archived: z.enum(['active', 'archived']),
  limit: z.number().int().min(1).max(TEAM_GROUPS_PAGE_LIMIT_MAX_V1).optional(),
  cursor: z.string().min(1).nullable().optional(),
}).strict());
export type TeamGroupsListInputV1 = z.infer<typeof TeamGroupsListInputV1Schema>;

export const TeamGroupsPageV1Schema = lazyZodSchema(() => z.object({
  items: z.array(TeamGroupV1Schema),
  nextCursor: z.string().nullable(),
}).strict());
export type TeamGroupsPageV1 = z.infer<typeof TeamGroupsPageV1Schema>;

/** `teams.groups.get`, `archive`, `restore`. */
export const TeamGroupRefInputV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  teamId: TeamIdSchema,
  groupId: TeamGroupIdSchema,
}).strict());
export type TeamGroupRefInputV1 = z.infer<typeof TeamGroupRefInputV1Schema>;

/**
 * `teams.groups.create`. `requestKey` is the caller's retry identity so a lost
 * response cannot create two Groups; it is scoped to actor, Team, and payload at
 * the creating transaction, not a generic Action ledger.
 */
export const TeamGroupCreateInputV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  teamId: TeamIdSchema,
  name: TeamGroupNameInputV1Schema,
  description: TeamGroupDescriptionInputV1Schema.nullable().optional(),
  requestKey: z.string().min(1).max(128),
}).strict());
export type TeamGroupCreateInputV1 = z.infer<typeof TeamGroupCreateInputV1Schema>;

/** `teams.groups.update`. Omitted is unchanged; an explicit null clears. */
export const TeamGroupUpdateInputV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  teamId: TeamIdSchema,
  groupId: TeamGroupIdSchema,
  name: TeamGroupNameInputV1Schema.optional(),
  description: TeamGroupDescriptionInputV1Schema.nullable().optional(),
}).strict().refine(
  (input) => input.name !== undefined || input.description !== undefined,
  { message: 'Group metadata patch changes nothing' },
));
export type TeamGroupUpdateInputV1 = z.infer<typeof TeamGroupUpdateInputV1Schema>;

/**
 * `teams.members.groups.list` — the Groups one membership is effectively in.
 *
 * It is addressed by the membership lifetime rather than by Account, because
 * member detail is already looking at exactly one lifetime and a rejoined person
 * must not inherit the previous one's Groups. The page reuses the Group row and
 * the Group ordering, so a Group reached from member detail carries the same
 * capabilities and opens the same destination as one reached from the Group
 * list: a second, thinner Group shape would be a second answer to "what is this
 * Group and what may I do to it".
 *
 * Archived Groups are included: a retained Group membership is exactly the fact
 * member detail must be able to explain, and each row carries its own
 * `archivedAt` for the reader.
 */
export const TeamMemberGroupsListInputV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  teamId: TeamIdSchema,
  membershipId: TeamMembershipIdSchema,
  limit: z.number().int().min(1).max(TEAM_GROUPS_PAGE_LIMIT_MAX_V1).optional(),
  cursor: z.string().min(1).nullable().optional(),
}).strict());
export type TeamMemberGroupsListInputV1 = z.infer<typeof TeamMemberGroupsListInputV1Schema>;

/**
 * The member-scoped sequence identity. It names the membership, not the
 * Account, for the same reason the input does.
 */
export function teamMemberGroupsQueryKeyV1(
  input: Pick<TeamMemberGroupsListInputV1, 'teamId' | 'membershipId'>,
): string {
  return `v1:member-groups:${input.teamId}:${input.membershipId}`;
}

export const TeamGroupMembersListInputV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  teamId: TeamIdSchema,
  groupId: TeamGroupIdSchema,
  limit: z.number().int().min(1).max(TEAM_GROUP_MEMBERS_PAGE_LIMIT_MAX_V1).optional(),
  cursor: z.string().min(1).nullable().optional(),
}).strict());
export type TeamGroupMembersListInputV1 = z.infer<typeof TeamGroupMembersListInputV1Schema>;

export const TeamGroupMembersPageV1Schema = lazyZodSchema(() => z.object({
  items: z.array(TeamGroupMemberV1Schema),
  nextCursor: z.string().nullable(),
}).strict());
export type TeamGroupMembersPageV1 = z.infer<typeof TeamGroupMembersPageV1Schema>;

/**
 * `teams.groups.members.add` — a native contribution. The Group history intent
 * is required and independent of the Team horizon; it is consumed only when this
 * membership's first contribution mints the horizon, and never widens a retained
 * one when a second contribution arrives.
 */
export const TeamGroupMemberAddInputV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  teamId: TeamIdSchema,
  groupId: TeamGroupIdSchema,
  accountId: z.string().min(1),
  historyAccess: SessionHistoryAccessSchema,
}).strict());
export type TeamGroupMemberAddInputV1 = z.infer<typeof TeamGroupMemberAddInputV1Schema>;

/** `teams.groups.members.remove` — clears only the native contribution. */
export const TeamGroupMemberRemoveInputV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  teamId: TeamIdSchema,
  groupId: TeamGroupIdSchema,
  accountId: z.string().min(1),
}).strict());
export type TeamGroupMemberRemoveInputV1 = z.infer<typeof TeamGroupMemberRemoveInputV1Schema>;

/**
 * The truthful outcome of a native Group mutation.
 *
 * `contribution_removed` is not `removed`: when a directory still contributes,
 * the person keeps Group access and the UI must say so instead of reporting a
 * removal that did not happen.
 */
export const TeamGroupMemberMutationResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.object({ status: z.literal('added'), member: TeamGroupMemberV1Schema }).strict(),
  z.object({ status: z.literal('contribution_added'), member: TeamGroupMemberV1Schema }).strict(),
  z.object({ status: z.literal('unchanged'), member: TeamGroupMemberV1Schema.optional() }).strict(),
  z.object({ status: z.literal('contribution_removed'), member: TeamGroupMemberV1Schema }).strict(),
  z.object({ status: z.literal('removed') }).strict(),
]));
export type TeamGroupMemberMutationResultV1 = z.infer<typeof TeamGroupMemberMutationResultV1Schema>;

/**
 * Groups order by their normalized key and then id, so a rename moves a Group
 * within the sequence rather than breaking it.
 */
export function teamGroupsQueryKeyV1(input: TeamGroupsListInputV1): string {
  return `v1:groups:${input.teamId}:${input.archived}`;
}

export type TeamGroupsCursorV1 = Readonly<{ nameKey: string; id: string }>;

export type TeamGroupsCursorDecodeV1 =
  | Readonly<{ status: 'ok'; cursor: TeamGroupsCursorV1 }>
  | Readonly<{ status: 'invalid' }>;

export function encodeTeamGroupsCursorV1(input: Readonly<{
  queryKey: string;
  nameKey: string;
  id: string;
}>): string {
  return encodeTeamKeysetCursorV1({ queryKey: input.queryKey, parts: [input.nameKey, input.id] });
}

export function decodeTeamGroupsCursorV1(value: string, queryKey: string): TeamGroupsCursorDecodeV1 {
  const decoded = decodeTeamKeysetCursorV1(value, queryKey);
  if (decoded.status !== 'ok') return { status: 'invalid' };
  const nameKey = readTeamKeysetTextV1(decoded.parts[0]);
  const id = readTeamKeysetIdV1(decoded.parts[1]);
  if (nameKey === null || id === null) return { status: 'invalid' };
  return { status: 'ok', cursor: { nameKey, id } };
}

/**
 * The Group roster's ordering tuple: immutable creation order, then the
 * membership lifetime. No Group-membership id is manufactured for paging, and
 * the page is over effective rows, so a member contributed by several sources
 * appears exactly once.
 */
export function teamGroupMembersQueryKeyV1(
  input: Pick<TeamGroupMembersListInputV1, 'teamId' | 'groupId'>,
): string {
  return `v1:group-members:${input.teamId}:${input.groupId}`;
}

export type TeamGroupMembersCursorV1 = Readonly<{ createdAt: number; teamMembershipId: string }>;

export type TeamGroupMembersCursorDecodeV1 =
  | Readonly<{ status: 'ok'; cursor: TeamGroupMembersCursorV1 }>
  | Readonly<{ status: 'invalid' }>;

export function encodeTeamGroupMembersCursorV1(input: Readonly<{
  queryKey: string;
  createdAt: number;
  teamMembershipId: string;
}>): string {
  return encodeTeamKeysetCursorV1({
    queryKey: input.queryKey,
    parts: [input.createdAt, input.teamMembershipId],
  });
}

export function decodeTeamGroupMembersCursorV1(
  value: string,
  queryKey: string,
): TeamGroupMembersCursorDecodeV1 {
  const decoded = decodeTeamKeysetCursorV1(value, queryKey);
  if (decoded.status !== 'ok') return { status: 'invalid' };
  const createdAt = readTeamKeysetTimeV1(decoded.parts[0]);
  const teamMembershipId = readTeamKeysetIdV1(decoded.parts[1]);
  if (createdAt === null || teamMembershipId === null) return { status: 'invalid' };
  return { status: 'ok', cursor: { createdAt, teamMembershipId } };
}
