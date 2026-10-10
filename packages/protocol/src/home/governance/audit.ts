import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { AccountDisplayProfileV1Schema } from '../../account/accountDisplayProfileV1.js';
import { AccountStatusV1Schema, HomeRoleV1Schema } from './roles.js';

/**
 * The Home administration audit trail (plan `2026-09-26-home-owner-console` §3.9, D-2).
 *
 * One event is written inside the transaction of the administration mutation it records, so an
 * event exists exactly when its change committed. Summaries are strict per action and never carry a
 * secret value or another person's email: a secret change reads only `unset → set`.
 */
export const HomeAdministrationActorKindV1Schema = lazyZodSchema(() => z.enum([
  /** A signed-in Account acting through the Home administration surface. */
  'account',
  /** `happier-server --claim-home-owner`, run by whoever operates the deployment. */
  'deployment_command',
  /** The managed Personal Home runtime assigning its sole Account as owner. */
  'personal_home_bootstrap',
]));
export type HomeAdministrationActorKindV1 = z.infer<typeof HomeAdministrationActorKindV1Schema>;

export const HomeAdministrationTargetKindV1Schema = lazyZodSchema(() => z.enum(['account', 'setting', 'identity_provider', 'github_app']));
export type HomeAdministrationTargetKindV1 = z.infer<typeof HomeAdministrationTargetKindV1Schema>;

export const HomeGovernancePolicyFieldV1Schema = lazyZodSchema(() => z.enum([
  'teamCreationPolicy',
  'teamsVisibleToMembers',
  'authenticationPolicy',
  'teamProviderPolicy',
  'identityNetworkPolicy',
]));
export type HomeGovernancePolicyFieldV1 = z.infer<typeof HomeGovernancePolicyFieldV1Schema>;

const JsonValueSchema = lazyZodSchema(() => z.unknown());

const SettingChangeSchema = lazyZodSchema(() => z.discriminatedUnion('secret', [
  z.object({
    secret: z.literal(false),
    key: z.string().min(1),
    from: JsonValueSchema.nullable(),
    to: JsonValueSchema.nullable(),
  }).strict(),
  z.object({
    secret: z.literal(true),
    key: z.string().min(1),
    from: z.enum(['unset', 'set']),
    to: z.enum(['unset', 'set']),
  }).strict(),
]));

const EventBaseShape = {
  id: z.string().min(1),
  /** Milliseconds since the epoch. */
  at: z.number().int().min(0),
  actor: z.object({
    kind: HomeAdministrationActorKindV1Schema,
    accountId: z.string().min(1).nullable(),
    profile: AccountDisplayProfileV1Schema.nullable(),
  }).strict(),
  target: z.object({
    kind: HomeAdministrationTargetKindV1Schema,
    id: z.string().min(1),
    /** Present for Account targets that still exist. */
    profile: AccountDisplayProfileV1Schema.nullable(),
  }).strict().nullable(),
};

const IdentityProviderSummarySchema = lazyZodSchema(() => z.object({ displayName: z.string().min(1) }).strict());
/** A GitHub App by the name people see: its slug, or its App id when it has none. */
const GitHubAppSummarySchema = lazyZodSchema(() => z.object({ name: z.string().min(1) }).strict());

/**
 * Each action with its strict summary; adding an action is an additive protocol change.
 * `HomeAdministrationEventDetailV1` is what a writer supplies; the event adds identity, time,
 * actor and target.
 */
const DETAIL_SHAPES = {
  /**
   * The first owner was assigned. The actor says who ran it; `via: 'claim_code'` marks a claim made
   * from the app with a one-time code printed by the server, whose actor is the claiming Account.
   */
  'home.owner.claim': z.object({ via: z.literal('claim_code').optional() }).strict(),
  'home.policy.set': z.object({
    revision: z.number().int().min(1),
    changes: z.array(z.object({
      field: HomeGovernancePolicyFieldV1Schema,
      from: JsonValueSchema.nullable(),
      to: JsonValueSchema.nullable(),
    }).strict()),
    /** The change widened sign-in, admission or storage policy and the owner confirmed it. */
    widening: z.literal(true).optional(),
  }).strict(),
  'home.settings.set': SettingChangeSchema,
  /** A pending restart value went back to what the running server started with (Discard, §3.14 r3). */
  'home.settings.discard': SettingChangeSchema,
  'account.role.set': z.object({ from: HomeRoleV1Schema, to: HomeRoleV1Schema }).strict(),
  'account.status.set': z.object({ from: AccountStatusV1Schema, to: AccountStatusV1Schema }).strict(),
  'account.delete': z.object({ outcome: z.enum(['deleted', 'disabled_pending_completion']) }).strict(),
  /** An administrator ended every signed-in session of the target (D-9); API tokens are unaffected. */
  'account.sign_out_everywhere': z.object({}).strict(),
  /** One ended Team membership lifetime; the Account target is its subject. */
  'teams.members.remove': z.object({ teamId: z.string().min(1), membershipId: z.string().min(1), teamName: z.string().min(1) }).strict(),
  // Home-owned identity providers and GitHub Apps (Sign-in providers). The summary names the
  // provider or App; a secret change says only that it was replaced, never its value.
  'identity_provider.create': IdentityProviderSummarySchema,
  'identity_provider.update': IdentityProviderSummarySchema,
  'identity_provider.secret.replace': IdentityProviderSummarySchema,
  'identity_provider.enable': IdentityProviderSummarySchema,
  'identity_provider.disable': IdentityProviderSummarySchema,
  'identity_provider.remove': IdentityProviderSummarySchema,
  'github_app.create': GitHubAppSummarySchema,
  'github_app.update': GitHubAppSummarySchema.extend({ secretsReplaced: z.boolean() }).strict(),
  'github_app.installation.verify': GitHubAppSummarySchema.extend({ organization: z.string().min(1) }).strict(),
  'github_app.installation.remove': GitHubAppSummarySchema.extend({ organization: z.string().min(1) }).strict(),
} as const;

type DetailShapes = typeof DETAIL_SHAPES;
export type HomeAdministrationActionV1 = keyof DetailShapes;
export type HomeAdministrationEventDetailV1 = {
  [A in HomeAdministrationActionV1]: Readonly<{ action: A; summary: z.infer<DetailShapes[A]> }>;
}[HomeAdministrationActionV1];

export const HOME_ADMINISTRATION_ACTIONS_V1 = Object.keys(DETAIL_SHAPES) as readonly HomeAdministrationActionV1[];

export const HomeAdministrationActionV1Schema = lazyZodSchema(() => z.enum(
  HOME_ADMINISTRATION_ACTIONS_V1 as unknown as [HomeAdministrationActionV1, ...HomeAdministrationActionV1[]],
));

function eventOption<A extends HomeAdministrationActionV1>(action: A) {
  return z.object({ ...EventBaseShape, action: z.literal(action), summary: DETAIL_SHAPES[action] }).strict();
}

export const HomeAdministrationEventV1Schema = lazyZodSchema(() => z.discriminatedUnion('action', [
  eventOption('home.owner.claim'),
  eventOption('home.policy.set'),
  eventOption('home.settings.set'),
  eventOption('home.settings.discard'),
  eventOption('account.role.set'),
  eventOption('account.status.set'),
  eventOption('account.delete'),
  eventOption('account.sign_out_everywhere'),
  eventOption('teams.members.remove'),
  eventOption('identity_provider.create'),
  eventOption('identity_provider.update'),
  eventOption('identity_provider.secret.replace'),
  eventOption('identity_provider.enable'),
  eventOption('identity_provider.disable'),
  eventOption('identity_provider.remove'),
  eventOption('github_app.create'),
  eventOption('github_app.update'),
  eventOption('github_app.installation.verify'),
  eventOption('github_app.installation.remove'),
]));

export type HomeAdministrationEventV1 = z.infer<typeof HomeAdministrationEventV1Schema>;

/** Parses a stored summary against its action's strict shape; `null` for an unknown or drifted row. */
export function parseHomeAdministrationEventDetailV1(action: string, summary: unknown): HomeAdministrationEventDetailV1 | null {
  if (!Object.hasOwn(DETAIL_SHAPES, action)) return null;
  const parsed = DETAIL_SHAPES[action as HomeAdministrationActionV1].safeParse(summary);
  return parsed.success ? ({ action, summary: parsed.data } as HomeAdministrationEventDetailV1) : null;
}

export const HOME_AUDIT_PAGE_LIMIT_DEFAULT_V1 = 50;
export const HOME_AUDIT_PAGE_LIMIT_MAX_V1 = 100;
export const HOME_AUDIT_PAGE_CURSOR_MAX_LENGTH_V1 = 512;

/** Newest first, keyset over `(at, id)`; `targetId` narrows to events about one target. */
export const HomeAuditListInputV1Schema = lazyZodSchema(() => z.object({
  cursor: z.string().min(1).max(HOME_AUDIT_PAGE_CURSOR_MAX_LENGTH_V1).nullable().optional(),
  limit: z.number().int().min(1).max(HOME_AUDIT_PAGE_LIMIT_MAX_V1).optional(),
  targetId: z.string().min(1).max(256).optional(),
}).strict());

export type HomeAuditListInputV1 = z.infer<typeof HomeAuditListInputV1Schema>;

export const HomeAuditListResultV1Schema = lazyZodSchema(() => z.object({
  items: z.array(HomeAdministrationEventV1Schema),
  nextCursor: z.string().min(1).max(HOME_AUDIT_PAGE_CURSOR_MAX_LENGTH_V1).nullable(),
}).strict());

export type HomeAuditListResultV1 = z.infer<typeof HomeAuditListResultV1Schema>;
