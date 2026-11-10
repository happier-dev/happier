import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { ManagedResourceDispositionV1Schema } from '../../machines/managed/managedDependencyV1.js';

import { AccountDisplayProfileV1Schema } from '../../account/accountDisplayProfileV1.js';
import { TeamRoleV1Schema } from '../../teams/team.js';
import { HomeAdministrationEventV1Schema } from './audit.js';
import { AccountStatusV1Schema, HomeRoleV1Schema } from './roles.js';

/** Explicit identity reclaim: reason is audited and notice is disclosed to the target Account. */
export const HomePublicProfileHandleReclaimInputV1Schema = lazyZodSchema(() => z.strictObject({
  accountId: z.string().check(z.minLength(1)),
  username: z.string().check(z.minLength(1)),
  reason: z.string().check(z.trim(), z.minLength(1)),
  notice: z.string().check(z.trim(), z.minLength(1)),
}));
export type HomePublicProfileHandleReclaimInputV1 = z.infer<typeof HomePublicProfileHandleReclaimInputV1Schema>;

export const HomePublicProfileHandleReclaimResultV1Schema = lazyZodSchema(() => z.strictObject({
  username: z.null(),
  reclaimed: z.boolean(),
}));
export type HomePublicProfileHandleReclaimResultV1 = z.infer<typeof HomePublicProfileHandleReclaimResultV1Schema>;

export const HomeAccountMutationUnavailableReasonV1Schema = lazyZodSchema(() => z.enum([
  'not_authorized',
  'last_active_owner',
  'target_inactive',
  'target_not_active',
  'target_not_suspended',
  'target_retired',
  'team_owner_transfer_required',
  'unchanged',
]));

export type HomeAccountMutationUnavailableReasonV1 = z.infer<
  typeof HomeAccountMutationUnavailableReasonV1Schema
>;

export const HomeAccountMutationCapabilityV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('available') }),
  z.strictObject({
    status: z.literal('unavailable'),
    reason: HomeAccountMutationUnavailableReasonV1Schema,
  }),
]));

export type HomeAccountMutationCapabilityV1 = z.infer<typeof HomeAccountMutationCapabilityV1Schema>;

export const HomeAccountMutationCapabilitiesV1Schema = lazyZodSchema(() => z.strictObject({
  setRole: z.strictObject({
    member: HomeAccountMutationCapabilityV1Schema,
    admin: HomeAccountMutationCapabilityV1Schema,
    owner: HomeAccountMutationCapabilityV1Schema,
  }),
  disable: HomeAccountMutationCapabilityV1Schema,
  reenable: HomeAccountMutationCapabilityV1Schema,
  delete: HomeAccountMutationCapabilityV1Schema,
  /** End every signed-in session of the Account (D-9). Needs an active target; no role changes. */
  signOutEverywhere: HomeAccountMutationCapabilityV1Schema,
}));

export type HomeAccountMutationCapabilitiesV1 = z.infer<
  typeof HomeAccountMutationCapabilitiesV1Schema
>;

/** Privacy-safe authentication facts projected by the authentication owner. */
export const HomeAccountAuthenticationV1Schema = lazyZodSchema(() => z.strictObject({
  signInEmail: z.nullable(z.string().check(z.minLength(1))),
  usableMethodIds: z.array(z.string().check(z.minLength(1))),
}));

export type HomeAccountAuthenticationV1 = z.infer<typeof HomeAccountAuthenticationV1Schema>;

/**
 * One Account row in the Home Administration People list.
 *
 * Authentication facts come from Lane 02's canonical Account-login decision;
 * this governance contract never reconstructs them from credential rows. This
 * row is never reused as the Team picker projection.
 */
export const HomeAccountRowV1Schema = lazyZodSchema(() => z.strictObject({
  accountId: z.string().check(z.minLength(1)),
  homeRole: HomeRoleV1Schema,
  status: AccountStatusV1Schema,
  profile: AccountDisplayProfileV1Schema,
  createdAt: z.number().check(z.int(), z.minimum(0)),
  authentication: HomeAccountAuthenticationV1Schema,
  mutationCapabilities: HomeAccountMutationCapabilitiesV1Schema,
}));

export type HomeAccountRowV1 = z.infer<typeof HomeAccountRowV1Schema>;

/**
 * Canonical Home Account directory bounds consumed by Account-derived pickers.
 * A narrower authorized projection may change row eligibility, but must not
 * invent different text/page/cursor resource limits.
 */
export const HOME_ACCOUNT_PAGE_LIMIT_DEFAULT_V1 = 50;
export const HOME_ACCOUNT_PAGE_LIMIT_MAX_V1 = 100;
export const HOME_ACCOUNT_PAGE_CURSOR_MAX_LENGTH_V1 = 512;
export const HOME_ACCOUNT_SEARCH_QUERY_MAX_LENGTH_V1 = 256;

/** Keyset page over captured role/unnamed/label/id keys; the cursor is opaque to clients. */
export const HomeAccountListInputV1Schema = lazyZodSchema(() => z.strictObject({
  cursor: z.optional(z.nullable(z.string().check(z.minLength(1), z.maxLength(HOME_ACCOUNT_PAGE_CURSOR_MAX_LENGTH_V1)))),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(HOME_ACCOUNT_PAGE_LIMIT_MAX_V1))),
}));

export type HomeAccountListInputV1 = z.infer<typeof HomeAccountListInputV1Schema>;

export const HomeAccountListResultV1Schema = lazyZodSchema(() => z.strictObject({
  items: z.array(HomeAccountRowV1Schema),
  nextCursor: z.nullable(z.string().check(z.minLength(1), z.maxLength(HOME_ACCOUNT_PAGE_CURSOR_MAX_LENGTH_V1))),
  /** All Home Accounts, including inactive Accounts, before pagination. */
  total: z.optional(z.number().check(z.int(), z.minimum(0))),
}));

export type HomeAccountListResultV1 = z.infer<typeof HomeAccountListResultV1Schema>;

/**
 * Search is authorized against one exact scope. Team scope is authorized by
 * current management authority on that exact active Team, so managing one Team
 * can never enumerate another Team or the Home People projection.
 */
export const HomeAccountSearchScopeV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('home') }),
  z.strictObject({ kind: z.literal('team'), teamId: z.string().check(z.minLength(1)) }),
]));

export type HomeAccountSearchScopeV1 = z.infer<typeof HomeAccountSearchScopeV1Schema>;

export const HomeAccountSearchInputV1Schema = lazyZodSchema(() => z.strictObject({
  query: z.string().check(z.minLength(1), z.maxLength(HOME_ACCOUNT_SEARCH_QUERY_MAX_LENGTH_V1)),
  scope: HomeAccountSearchScopeV1Schema,
}));

export type HomeAccountSearchInputV1 = z.infer<typeof HomeAccountSearchInputV1Schema>;

/**
 * The minimal picker row. It carries no Home role, lifecycle status,
 * relationship, provider identity, directory link, or authentication metadata,
 * so a Team manager can resolve a person without reading Home administration.
 */
export const HomeAccountPickerRowV1Schema = lazyZodSchema(() => z.strictObject({
  accountId: z.string().check(z.minLength(1)),
  profile: AccountDisplayProfileV1Schema,
  eligible: z.boolean(),
}));

export type HomeAccountPickerRowV1 = z.infer<typeof HomeAccountPickerRowV1Schema>;

export const HomeAccountSearchResultV1Schema = lazyZodSchema(() => z.strictObject({
  accounts: z.array(HomeAccountPickerRowV1Schema),
}));

export type HomeAccountSearchResultV1 = z.infer<typeof HomeAccountSearchResultV1Schema>;

export const HomeAccountRoleSetInputV1Schema = lazyZodSchema(() => z.strictObject({
  accountId: z.string().check(z.minLength(1)),
  homeRole: HomeRoleV1Schema,
}));

export type HomeAccountRoleSetInputV1 = z.infer<typeof HomeAccountRoleSetInputV1Schema>;

/** Disable, Re-enable, and Delete all address one explicit Account. */
export const HomeAccountTargetInputV1Schema = lazyZodSchema(() => z.strictObject({
  accountId: z.string().check(z.minLength(1)),
}));

export type HomeAccountTargetInputV1 = z.infer<typeof HomeAccountTargetInputV1Schema>;
export const HomeAccountDeleteInputV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(HomeAccountTargetInputV1Schema, {
  managedResourceDispositions: z.optional(z.array(ManagedResourceDispositionV1Schema)),
})));
export type HomeAccountDeleteInputV1 = z.infer<typeof HomeAccountDeleteInputV1Schema>;

/**
 * Administrative deletion reports incomplete cleanup explicitly. It never
 * reports `deleted` before physical completion, and the released self-erasure
 * success shape is unchanged by this closed result union.
 */
export const HomeAccountDeleteResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('deleted') }),
  z.strictObject({ status: z.literal('disabled_pending_completion') }),
]));

export type HomeAccountDeleteResultV1 = z.infer<typeof HomeAccountDeleteResultV1Schema>;

/** One Team the Account belongs to, as Home administration may see it: name and role only. */
export const HomeAccountTeamMembershipV1Schema = lazyZodSchema(() => z.strictObject({
  teamId: z.string().check(z.minLength(1)),
  name: z.string(),
  role: TeamRoleV1Schema,
  /** A suspended membership is still listed, flagged. */
  status: z.enum(['active', 'suspended']),
  archived: z.boolean(),
}));

export type HomeAccountTeamMembershipV1 = z.infer<typeof HomeAccountTeamMembershipV1Schema>;

export const HOME_ACCOUNT_DETAIL_RECENT_EVENTS_LIMIT_V1 = 10;

/**
 * One person as Home administration sees them (plan `2026-09-26-home-owner-console` §3.12).
 *
 * The row half is exactly the People row. Everything added is a fact an owner already has: linked
 * provider ids (never the provider's user id), Team names and roles, and counts — never token
 * labels or prefixes, Group membership or Session facts. There is no per-device session model, so
 * no device list (D-8).
 */
export const HomeAccountDetailV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(HomeAccountRowV1Schema, {
  /** Absent on Homes predating the operator presentation; absence grants no management authority. */
  publicProfile: z.optional(z.strictObject({
    managementCapability: HomeAccountMutationCapabilityV1Schema,
    restricted: z.boolean(),
  })),
  authentication: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(HomeAccountAuthenticationV1Schema, {
    linkedProviderIds: z.array(z.string().check(z.minLength(1))),
  })),
  teams: z.array(HomeAccountTeamMembershipV1Schema),
  machines: z.strictObject({ count: z.number().check(z.int(), z.minimum(0)) }),
  apiTokens: z.strictObject({
    count: z.number().check(z.int(), z.minimum(0)),
    /** Milliseconds since the epoch; null when no token was ever used. */
    lastUsedAt: z.nullable(z.number().check(z.int(), z.minimum(0))),
  }),
  /** Newest first, at most `HOME_ACCOUNT_DETAIL_RECENT_EVENTS_LIMIT_V1`. */
  recentEvents: z.array(HomeAdministrationEventV1Schema),
})));

export type HomeAccountDetailV1 = z.infer<typeof HomeAccountDetailV1Schema>;
