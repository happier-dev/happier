import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { isSessionPersonallyTrackedForViewerV1 } from '../personal/tracking.js';

/**
 * The one Follow notification vocabulary. It is closed on purpose: schemas,
 * persisted values, predicates and prose all use these three values.
 */
export const SessionFollowNotificationLevelSchema = lazyZodSchema(() => z.enum([
  'none',
  'important',
  'all_messages',
]));
export type SessionFollowNotificationLevel = z.infer<typeof SessionFollowNotificationLevelSchema>;

/**
 * The Account-private projection of one `AccountSessionFollow` row.
 *
 * Persisted delivery frontiers, delivery Account ids, internal reasons and
 * runtime diagnostics are deliberately absent: a human client only needs the
 * preference it can edit.
 */
export const AccountSessionFollowV1Schema = lazyZodSchema(() => z
  .object({
    sessionId: z.string().trim().min(1),
    following: z.boolean(),
    notificationLevel: SessionFollowNotificationLevelSchema,
    includeInVoice: z.boolean(),
  })
  .strict());
export type AccountSessionFollowV1 = z.infer<typeof AccountSessionFollowV1Schema>;

/**
 * The server-resolved Follow capability. Reading a Session and reading the
 * caller's own Follow projection are already governed by Session access and
 * current-Account ownership, so a second `view` bit would encode one decision
 * twice.
 */
export const AccountSessionFollowCapabilitiesV1Schema = lazyZodSchema(() => z
  .object({
    manageFollow: z.boolean(),
  })
  .strict());
export type AccountSessionFollowCapabilitiesV1 = z.infer<
  typeof AccountSessionFollowCapabilitiesV1Schema
>;

/**
 * The four Account-level auto-follow defaults. They are a bounded operational
 * policy the Home must be able to apply while the recipient has no connected
 * device, not a mirror of the encrypted Account notification settings.
 */
export const SessionAutoFollowPreferencesV1Schema = lazyZodSchema(() => z
  .object({
    assigned: z.boolean(),
    direct: z.boolean(),
    team: z.boolean(),
    group: z.boolean(),
  })
  .strict());
export type SessionAutoFollowPreferencesV1 = z.infer<typeof SessionAutoFollowPreferencesV1Schema>;

export const DEFAULT_SESSION_AUTO_FOLLOW_PREFERENCES_V1: SessionAutoFollowPreferencesV1 =
  Object.freeze({
    assigned: true,
    direct: false,
    team: false,
    group: false,
  });

/**
 * The qualifying relationship transitions that may create an automatic Follow.
 * They map one-to-one onto the four Account preferences above.
 */
export const SESSION_AUTO_FOLLOW_TRIGGERS_V1 = Object.freeze([
  'assigned',
  'direct',
  'team',
  'group',
] as const);
export type SessionAutoFollowTriggerV1 = typeof SESSION_AUTO_FOLLOW_TRIGGERS_V1[number];

/**
 * The narrow Follow adapter consumed by the viewer-relevance owner (09B's
 * `resolveSessionPersonalEventEligibility`).
 *
 * Current viewer projections also carry `includeInVoice`; its optional read
 * shape preserves cached/released projections and absence fails closed.
 *
 * - active row       → `{ follows: true, notificationLevel, includeInVoice? }`
 * - explicit unfollow → `{ follows: false, notificationLevel: 'none', includeInVoice?: false }`
 * - absent row        → `{ follows: false, notificationLevel: null }`
 */
export const SessionFollowFactsV1Schema = lazyZodSchema(() => z
  .object({
    follows: z.boolean(),
    notificationLevel: SessionFollowNotificationLevelSchema.nullable(),
    /**
     * Synchronized Account Follow authority for Voice eligibility. Optional on
     * read so cached/released viewer projections remain parseable; current Home
     * projections always supply it and absence fails closed.
     */
    includeInVoice: z.boolean().optional(),
  })
  .strict());
export type SessionFollowFactsV1 = z.infer<typeof SessionFollowFactsV1Schema>;

export const ABSENT_SESSION_FOLLOW_FACTS_V1: SessionFollowFactsV1 = Object.freeze({
  follows: false,
  notificationLevel: null,
});

/**
 * The one stored-row → Follow-facts mapping, shared by the Home reader and the
 * client editor so a suppression row cannot mean two different things on the two
 * sides of the wire. A malformed stored level stays quiet rather than being
 * reinterpreted as an active choice.
 */
export function projectSessionFollowFactsV1(
  row: Readonly<{ following: boolean; notificationLevel: unknown; includeInVoice?: boolean }> | null | undefined,
): SessionFollowFactsV1 {
  if (!row) return ABSENT_SESSION_FOLLOW_FACTS_V1;
  const level = SessionFollowNotificationLevelSchema.safeParse(row.notificationLevel);
  if (!row.following || !level.success) return {
    follows: false,
    notificationLevel: 'none',
    ...(row.includeInVoice === undefined ? {} : { includeInVoice: false }),
  };
  return {
    follows: true,
    notificationLevel: level.data,
    ...(row.includeInVoice === undefined ? {} : { includeInVoice: row.includeInVoice }),
  };
}

/**
 * The one effective-notification resolver: an explicit per-Session preference
 * wins, otherwise a Session owner keeps the existing Important default, and a
 * non-owner without a Follow row receives nothing. Responsibility has no second
 * implicit fallback — its default becomes a real Follow row.
 */
export function resolveEffectiveSessionFollowNotificationLevelV1(params: Readonly<{
  facts: SessionFollowFactsV1;
  isSessionOwner: boolean;
}>): SessionFollowNotificationLevel {
  if (params.facts.notificationLevel !== null) return params.facts.notificationLevel;
  return params.isSessionOwner ? 'important' : 'none';
}

/**
 * Builds the canonical stored shape of an explicit Unfollow. The suppression
 * bit lives in the same row so a later assignment or re-grant cannot undo the
 * choice; it carries no notifications, no Voice and no Voice frontier.
 */
export const EXPLICIT_SESSION_UNFOLLOW_STATE_V1 = Object.freeze({
  following: false as const,
  notificationLevel: 'none' as const,
  includeInVoice: false as const,
});

/**
 * The state written when a Follow becomes active without an explicit user
 * choice (the automatic assignment/access path).
 */
export const AUTOMATIC_SESSION_FOLLOW_STATE_V1 = Object.freeze({
  following: true as const,
  notificationLevel: 'important' as const,
  includeInVoice: false as const,
});

export type AccountSessionFollowEditorStateV1 = Readonly<{
  /** Owner-or-active-Follow. An owner cannot untrack their own Session. */
  tracked: boolean;
  /** A stored explicit Unfollow, which also blocks every later automatic trigger. */
  suppressed: boolean;
  notificationLevel: SessionFollowNotificationLevel;
  includeInVoice: boolean;
}>;

/**
 * The effective state every Follow editor host renders.
 *
 * It composes the two existing owners — the tracking predicate and the
 * effective-notification resolver — instead of letting a client read the
 * persisted row directly. That is what keeps a Session owner with no explicit
 * row from being shown as "not following" while the Home still treats them as
 * tracked and Important-eligible.
 */
export function projectAccountSessionFollowEditorStateV1(params: Readonly<{
  follow: AccountSessionFollowV1 | null;
  isSessionOwner: boolean;
}>): AccountSessionFollowEditorStateV1 {
  const facts = projectSessionFollowFactsV1(params.follow);
  return {
    tracked: isSessionPersonallyTrackedForViewerV1({ isSessionOwner: params.isSessionOwner, followFacts: facts }),
    suppressed: params.follow?.following === false,
    notificationLevel: resolveEffectiveSessionFollowNotificationLevelV1({
      facts,
      isSessionOwner: params.isSessionOwner,
    }),
    includeInVoice: params.follow?.following === true && params.follow.includeInVoice,
  };
}
