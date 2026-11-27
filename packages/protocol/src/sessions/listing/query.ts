import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { decodeV2SessionListCursorV1, decodeV2SessionListCursorV2 } from './cursor.js';
import { readServerEnabledBit } from '../../features/serverEnabledBit.js';
import type { SetSelectionV1 } from '../../collections/filter/entityListFilterV1.js';
import type { FeaturesResponse } from '../../features/payload/featuresResponseSchema.js';

// Shared with the ordinary V2 HTTP page. Selector counts remain subject to the
// transport/database boundaries, not an additional query-language quota.
export const SESSION_LIST_PAGE_DEFAULT_LIMIT = 50;
export const SESSION_LIST_PAGE_MAX_LIMIT = 200;

export const SessionListScopeV1Schema = lazyZodSchema(() => z.enum([
  'my_work', 'assigned_to_me', 'following', 'involving_me', 'all_accessible',
]));
export type SessionListScopeV1 = z.infer<typeof SessionListScopeV1Schema>;

export const SessionAttentionFilterV1Schema = lazyZodSchema(() => z.enum(['any', 'needs_my_attention']));
export type SessionAttentionFilterV1 = z.infer<typeof SessionAttentionFilterV1Schema>;

/** Authorized clients project this facet from Session metadata, not server-readable work state. */
export const SessionBotFilterV1Schema = lazyZodSchema(() => z.enum(['bot', 'ordinary']));
export type SessionBotFilterV1 = z.infer<typeof SessionBotFilterV1Schema>;

const SelectorIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));

// Each identity/selection object is closed, independently of the query envelope.
export const SessionAudienceSelectionV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('outside_teams') }),
  z.strictObject({ kind: z.literal('team'), teamId: SelectorIdSchema }),
  z.strictObject({ kind: z.literal('group'), teamId: SelectorIdSchema, groupId: SelectorIdSchema }),
]));
export type SessionAudienceSelectionV1 = Readonly<z.infer<typeof SessionAudienceSelectionV1Schema>>;

function audienceKey(audience: SessionAudienceSelectionV1): string {
  switch (audience.kind) {
    case 'outside_teams': return JSON.stringify([audience.kind]);
    case 'team': return JSON.stringify([audience.kind, audience.teamId]);
    case 'group': return JSON.stringify([audience.kind, audience.teamId, audience.groupId]);
  }
}

const AudienceSelectionsSchema = lazyZodSchema(() => z.pipe(z.array(SessionAudienceSelectionV1Schema).check(z.refine((values) => new Set(values.map(audienceKey)).size === values.length, {
    message: 'Duplicate audience selectors',
  })), z.transform((values) => {
    const teams = new Set(values.filter((value) => value.kind === 'team').map((value) => value.teamId));
    return values
      .filter((value) => value.kind !== 'group' || !teams.has(value.teamId))
      .sort((a, b) => {
        const left = audienceKey(a);
        const right = audienceKey(b);
        return left < right ? -1 : left > right ? 1 : 0;
      });
  })));

const TagIdsSchema = lazyZodSchema(() => z.pipe(z.array(SelectorIdSchema).check(z.refine((values) => new Set(values).size === values.length, { message: 'Duplicate tag selectors' })), z.transform((values) => values.sort())));

const FolderIdsSchema = lazyZodSchema(() => z.pipe(z.array(SelectorIdSchema).check(z.refine((values) => new Set(values).size === values.length, { message: 'Duplicate folder selectors' })), z.transform((values) => values.sort())));

const ProjectKeysSchema = lazyZodSchema(() => z.pipe(z.array(SelectorIdSchema).check(z.refine((values) => new Set(values).size === values.length, { message: 'Duplicate Project selectors' })), z.transform((values) => values.sort())));

const CursorSchema = lazyZodSchema(() => z.string().check(z.refine((value) => decodeV2SessionListCursorV2(value) !== null || decodeV2SessionListCursorV1(value) !== null, { message: 'Invalid cursor format' })));

/** Existing structural selectors, reused by the smart branch of Space membership. */
const structuralFields = () => ({
  scope: SessionListScopeV1Schema, attention: SessionAttentionFilterV1Schema,
  coordinator: z.optional(z.literal('coordinator')),
  audiences: z.strictObject({ include: AudienceSelectionsSchema, exclude: AudienceSelectionsSchema }),
  tagIds: z.strictObject({ include: TagIdsSchema, exclude: TagIdsSchema }),
  /** Relation facts are selected by the Home owner before pagination. */
  folderIds: z.optional(FolderIdsSchema),
  /** Accepted Home-local keys preselect candidates; unpublished identities remain locally resolvable. */
  /** `none` selects only Sessions their owner published as in no Project (owner reclassification); it takes no keys. */
  projectKeys: z.optional(z.strictObject({ include: ProjectKeysSchema, exclude: ProjectKeysSchema, none: z.optional(z.literal(true)) })
    .check(z.refine((value) => value.none !== true || value.include.length + value.exclude.length === 0, { message: 'A no-Project selection takes no Project keys' }))),
  underSessionId: z.optional(SelectorIdSchema),
});
export const SessionListMembershipFilterV1Schema = lazyZodSchema(() => z.strictObject(structuralFields()));
export type SessionListMembershipFilterV1 = Readonly<Omit<z.infer<typeof SessionListMembershipFilterV1Schema>, 'audiences' | 'tagIds' | 'folderIds' | 'projectKeys'> & {
  audiences: SetSelectionV1<SessionAudienceSelectionV1>; tagIds: SetSelectionV1<string>; folderIds?: readonly string[];
  projectKeys?: Readonly<{ include: readonly string[]; exclude: readonly string[]; none?: true }>;
}>;
export const SessionListMembershipV1Schema = lazyZodSchema(() => z.strictObject({
  mode: z.enum(['filter_or_manual', 'manual_only']), tagIds: TagIdsSchema, filter: z.optional(SessionListMembershipFilterV1Schema),
}));
export type SessionListMembershipV1 = Readonly<{ mode: 'filter_or_manual' | 'manual_only'; tagIds: readonly string[]; filter?: SessionListMembershipFilterV1 }>;

/** The ordinary first page's own transport parameters (the `GET /v2/sessions` querystring for page one). */
export const SessionListOrdinaryPageRequestV1Schema = lazyZodSchema(() => z.strictObject({
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(SESSION_LIST_PAGE_MAX_LIMIT))),
  includeAttention: z.optional(z.boolean()),
}));

/** V1 is a closed Home-local selection contract, independent of package SemVer. */
export const SessionListQueryV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  storage: z.enum(['active', 'archived']),
  includeInactive: z.boolean(),
  ...structuralFields(),
  // The server returns the structural candidate corpus and its original cursors.
  // Clients apply this selection only after authorized metadata hydration.
  bot: z.optional(SessionBotFilterV1Schema),
  /** The saved structural lens and explicit membership share one paged corpus. */
  membership: z.optional(SessionListMembershipV1Schema),
  cursor: z.optional(CursorSchema),
  attentionCursor: z.optional(CursorSchema),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(SESSION_LIST_PAGE_MAX_LIMIT))),
  includeAttention: z.optional(z.boolean()),
  /**
   * Also return the ordinary owner-or-direct first page (`GET /v2/sessions`) in this
   * response, so one cold read serves both memberships. First active page only.
   */
  ordinaryPage: z.optional(SessionListOrdinaryPageRequestV1Schema),
}).check(
  z.refine((value) => value.cursor === undefined || value.attentionCursor === undefined, { message: 'cursor and attentionCursor cannot be combined', path: ['attentionCursor'] }),
  z.refine((value) => value.ordinaryPage === undefined || (value.storage === 'active'
    && value.cursor === undefined && value.attentionCursor === undefined), {
    message: 'ordinaryPage reads only the first active page', path: ['ordinaryPage'] }),
));

export type SessionListQueryV1 = Readonly<Omit<z.infer<typeof SessionListQueryV1Schema>, 'audiences' | 'tagIds' | 'folderIds' | 'projectKeys' | 'membership'> & {
  audiences: SetSelectionV1<SessionAudienceSelectionV1>;
  tagIds: SetSelectionV1<string>;
  folderIds?: readonly string[];
  projectKeys?: Readonly<{ include: readonly string[]; exclude: readonly string[]; none?: true }>;
  membership?: SessionListMembershipV1;
}>;

/** Select the same structural vocabulary without transport or lifecycle fields. */
export function sessionListMembershipFilterFromQuery(query: SessionListQueryV1): SessionListMembershipFilterV1 {
  const { v: _v, storage: _storage, includeInactive: _inactive, bot: _bot, membership: _membership,
    cursor: _cursor, attentionCursor: _attentionCursor, limit: _limit, includeAttention: _attention,
    ordinaryPage: _ordinaryPage, ...filter } = query;
  return filter;
}

/** Older strict query readers must never receive an unadvertised selector. */
export function supportsSessionListProjectSelectionV1(payload: Pick<FeaturesResponse, 'features'>): boolean {
  return readServerEnabledBit(payload, 'sessions.filteredListing') === true
    && payload.features.sessions.filteredListing.projectSelectorVersion === 1;
}
export function supportsSessionListMembershipSelectionV1(payload: Pick<FeaturesResponse, 'features'>): boolean {
  return readServerEnabledBit(payload, 'sessions.filteredListing') === true
    && payload.features.sessions.filteredListing.membershipSelectorVersion === 1;
}

/** A Home that answers `ordinaryPage` on its strict query reader. */
export function supportsSessionListOrdinaryPageV1(payload: Pick<FeaturesResponse, 'features'>): boolean {
  return readServerEnabledBit(payload, 'sessions.filteredListing') === true
    && payload.features.sessions.filteredListing.ordinaryPageVersion === 1;
}

/** Bot selection never asks a server to inspect encrypted metadata, including older strict servers. */
export function buildSessionListServerQueryV1(query: SessionListQueryV1): Omit<SessionListQueryV1, 'bot'> {
  if (query.bot === undefined) return query;
  const { bot: _bot, ...structuralQuery } = query;
  return structuralQuery;
}

export const SessionListUnavailableQueryV1Schema = lazyZodSchema(() => z.strictObject({
  error: z.literal('not_found'),
  code: z.literal('filtered_session_listing_unavailable'),
  reason: z.enum(['audience', 'scope', 'following', 'coordinator']),
}));

export type SessionListUnavailableQueryV1 = Readonly<z.infer<typeof SessionListUnavailableQueryV1Schema>>;
