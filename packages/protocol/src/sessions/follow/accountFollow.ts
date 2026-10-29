import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { defineStoredReadProjection } from '../../json/storedReadSchema.js';

import { isSessionPersonallyTrackedForViewerV1 } from '../personal/tracking.js';
import { TurnIdSchema } from '../idsV1.js';
import { SessionFollowFrontierV1Schema, type SessionFollowFrontierV1 } from './sessionFollowFrontierV1.js';
import { FOLLOW_EVENT_KINDS_V1, FollowPolicyV1Schema, resolveFollowDeliveryV1, type FollowEventV1, type FollowPolicyV1, type FollowEventMapV1 } from './sessionFollowPolicyV1.js';
import { normalizeSessionListFilterV1 } from '../listFilter/sessionListFilterV1.js';
import type { SessionFollowRuleDefinitionV1 } from './sessionFollowRuleV1.js';
import { FollowSourceRefV1Schema } from './sessionDeliveryMuteV1.js';
import { ExecutionRunOutputRefV1Schema } from '../../reviews/reviewNarration.js';
import { RunFollowOccurrenceV1Schema, ExecutionRunFollowOriginalV1Schema, WorkflowRunFollowOriginalV1Schema } from './sessionFollowInputV1.js';
import { sameStrictJsonValue } from '../../json/strictJsonValue.js';

/** A convenience intent, independent of the persistent Follow and Voice choices. */
export const PersonalFollowOnceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('turn_finished'), sourceTurnId: TurnIdSchema }),
  z.strictObject({ kind: z.literal('first_needs_you') }),
]));
export type PersonalFollowOnceV1 = z.infer<typeof PersonalFollowOnceV1Schema>;

/** Run intents share Follow custody, with independently armable exact outputs. */
export const PersonalRunFollowOnceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('run_settled') }),
  z.strictObject({ kind: z.literal('first_needs_you') }),
  z.strictObject({ kind: z.literal('output_ready'), outputRef: ExecutionRunOutputRefV1Schema,
    afterRevision: z.optional(z.number().check(z.int(), z.nonnegative())) }),
]));
export type PersonalRunFollowOnceV1 = z.infer<typeof PersonalRunFollowOnceV1Schema>;
export function personalRunFollowOnceKeyV1(once: PersonalRunFollowOnceV1): string {
  return JSON.stringify(once.kind === 'output_ready' ? [once.kind, once.outputRef.kind,
    once.outputRef.kind === 'scm_diff_summary' ? once.outputRef.output : null,
    once.outputRef.comparisonId, once.outputRef.resultId] : [once.kind]);
}
export const PersonalRunFollowOnceSetV1Schema = lazyZodSchema(() => z.array(PersonalRunFollowOnceV1Schema)
  .check(z.refine(intents => new Set(intents.map(personalRunFollowOnceKeyV1)).size === intents.length,
    { message: 'Run one-shot controls require unique exact intent identities' })));
export const PersonalRunFollowOnceOccurrenceV1Schema = lazyZodSchema(() => RunFollowOccurrenceV1Schema);
export type PersonalRunFollowOnceOccurrenceV1 = z.infer<typeof PersonalRunFollowOnceOccurrenceV1Schema>;
export const PersonalRunFollowOnceBaselineV1Schema = lazyZodSchema(() => z.strictObject({
  original: z.nullable(z.union([ExecutionRunFollowOriginalV1Schema, WorkflowRunFollowOriginalV1Schema])),
  outputRevision: z.optional(z.number().check(z.int(), z.nonnegative())),
}));
export type PersonalRunFollowOnceBaselineV1 = z.infer<typeof PersonalRunFollowOnceBaselineV1Schema>;
export const PersistedPersonalRunFollowOnceV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), intents: z.array(z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('armed'), once: PersonalRunFollowOnceV1Schema, baseline: PersonalRunFollowOnceBaselineV1Schema }),
    z.strictObject({ state: z.literal('fulfilled'), once: PersonalRunFollowOnceV1Schema, baseline: PersonalRunFollowOnceBaselineV1Schema,
      occurrence: PersonalRunFollowOnceOccurrenceV1Schema }),
  ])).check(z.refine(intents => new Set(intents.map(entry => personalRunFollowOnceKeyV1(entry.once))).size === intents.length),
    z.refine(intents => intents.every(entry => entry.state !== 'fulfilled' || matchesPersonalRunFollowOnceOccurrenceV1(entry)))),
}));
export type PersistedPersonalRunFollowOnceV1 = z.infer<typeof PersistedPersonalRunFollowOnceV1Schema>;
defineStoredReadProjection(PersonalRunFollowOnceV1Schema, () => PersonalRunFollowOnceV1Schema);
defineStoredReadProjection(PersistedPersonalRunFollowOnceV1Schema, () => PersistedPersonalRunFollowOnceV1Schema);

export function parsePersistedPersonalRunFollowOnceV1(value: string | null | undefined): PersistedPersonalRunFollowOnceV1 | null {
  if (!value) return null;
  try { return PersistedPersonalRunFollowOnceV1Schema.safeParse(JSON.parse(value)).data ?? null; }
  catch { return null; }
}
export function projectPersonalRunFollowCustodyV1(row: Readonly<{ notifyOnce?: string | null }>): Readonly<{
  once?: PersonalRunFollowOnceV1[] | null; onceDeliveries?: PersonalRunFollowOnceOccurrenceV1[];
}> {
  if (row.notifyOnce === undefined) return {};
  const parsed = parsePersistedPersonalRunFollowOnceV1(row.notifyOnce);
  const armed = parsed?.intents.flatMap(entry => entry.state === 'armed' ? [entry.once] : []) ?? [];
  const deliveries = parsed?.intents.flatMap(entry => entry.state === 'fulfilled' ? [entry.occurrence] : []) ?? [];
  return { once: armed.length ? armed : null,
    ...(deliveries.length ? { onceDeliveries: deliveries } : {}) };
}
export function matchesPersonalRunFollowOnceOccurrenceV1(input: Readonly<{
  once: PersonalRunFollowOnceV1; baseline: PersonalRunFollowOnceBaselineV1; occurrence: PersonalRunFollowOnceOccurrenceV1;
}>): boolean {
  const { once, baseline, occurrence } = input;
  if (baseline.original && !sameStrictJsonValue(baseline.original.source, occurrence.original.source)) return false;
  if (once.kind === 'output_ready') {
    if (!('output' in occurrence.original) || !sameStrictJsonValue(once.outputRef, occurrence.original.output.outputRef)) return false;
    const after = once.afterRevision ?? baseline.outputRevision;
    return after === undefined || occurrence.original.output.revision > after;
  }
  if ('output' in occurrence.original) return false;
  if (once.kind === 'run_settled') return occurrence.event.kind === 'finished' || occurrence.event.kind === 'failed_or_stopped';
  if (occurrence.event.kind !== 'needs_you') return false;
  if ('revision' in occurrence.original) return !baseline.original || !('revision' in baseline.original)
    || occurrence.original.revision > baseline.original.revision;
  if (!('permissionRequests' in occurrence.original)) return false;
  return !baseline.original || !('permissionRequests' in baseline.original)
    || occurrence.original.permissionRequests.some(request => !baseline.original || !('permissionRequests' in baseline.original)
      || !baseline.original.permissionRequests.some(prior => sameStrictJsonValue(prior, request)));
}

/** Original source identity only; the content and resolution stay at the source. */
export const PersonalFollowOnceOccurrenceV1Schema = lazyZodSchema(() => z.strictObject({
  event: z.enum(['ready', 'failed', 'cancelled', 'permission_required', 'user_action_required', 'message']),
  turnId: z.optional(TurnIdSchema),
  requestId: z.optional(z.string().check(z.minLength(1))),
  agentStateVersion: z.number().check(z.int(), z.minimum(0)),
  transcriptSeq: z.optional(z.number().check(z.int(), z.minimum(0))),
}));
export type PersonalFollowOnceOccurrenceV1 = z.infer<typeof PersonalFollowOnceOccurrenceV1Schema>;

export const PersistedPersonalFollowOnceV1Schema = lazyZodSchema(() => z.discriminatedUnion('state', [
  z.strictObject({ v: z.literal(1), state: z.literal('armed'), once: PersonalFollowOnceV1Schema, baseline: SessionFollowFrontierV1Schema }),
  z.strictObject({ v: z.literal(1), state: z.literal('fulfilled'), once: PersonalFollowOnceV1Schema, baseline: SessionFollowFrontierV1Schema,
    occurrence: PersonalFollowOnceOccurrenceV1Schema }),
]));
export type PersistedPersonalFollowOnceV1 = z.infer<typeof PersistedPersonalFollowOnceV1Schema>;

// These are exact intent/source identities, not presentation fields that a
// retained document reader may discard while recovering a supported shape.
defineStoredReadProjection(PersonalFollowOnceV1Schema, () => PersonalFollowOnceV1Schema);
defineStoredReadProjection(PersonalFollowOnceOccurrenceV1Schema, () => PersonalFollowOnceOccurrenceV1Schema);
defineStoredReadProjection(PersistedPersonalFollowOnceV1Schema, () => PersistedPersonalFollowOnceV1Schema);

export function parsePersistedPersonalFollowOnceV1(value: string | null | undefined): PersistedPersonalFollowOnceV1 | null {
  if (!value) return null;
  try { return PersistedPersonalFollowOnceV1Schema.safeParse(JSON.parse(value)).data ?? null; }
  catch { return null; }
}

/** The shared stored-row boundary; malformed custody never creates interest. */
export function projectPersonalFollowCustodyV1(row: Readonly<{ followPolicy?: string | null; notifyOnce?: string | null }>): Readonly<{
  policy?: FollowPolicyV1; once?: PersonalFollowOnceV1 | null; onceAfterAgentStateVersion?: number; onceDelivery?: PersonalFollowOnceOccurrenceV1;
}> {
  let policy: FollowPolicyV1 | undefined;
  if (row.followPolicy !== undefined && row.followPolicy !== null) {
    policy = { preset: 'custom', events: {} };
    try { policy = FollowPolicyV1Schema.safeParse(JSON.parse(row.followPolicy)).data ?? policy; } catch { /* Invalid stored policy fails closed. */ }
  }
  const once = parsePersistedPersonalFollowOnceV1(row.notifyOnce);
  return {
    ...(policy ? { policy } : {}),
    ...(row.notifyOnce === undefined ? {} : { once: once?.state === 'armed' ? once.once : null }),
    ...(once?.state === 'armed' ? { onceAfterAgentStateVersion: once.baseline.agentStateVersion } : {}),
    ...(once?.state === 'fulfilled' ? { onceDelivery: once.occurrence } : {}),
  };
}

/**
 * Effective personal Voice interest. An explicit policy owns every event,
 * including Custom-off; the boolean is only the policy-absent legacy ingress.
 * Selection is independent of readiness and private delivery progress.
 */
export function resolveAccountFollowVoiceSelectionV1(input: Readonly<{
  policy?: FollowPolicyV1;
  includeInVoice?: boolean;
}>): Readonly<{ policy?: FollowPolicyV1 }> | null {
  const policy = input.policy;
  if (!policy) return input.includeInVoice === true ? {} : null;
  const selected = FOLLOW_EVENT_KINDS_V1.some(kind => {
    const events: FollowEventV1[] = kind === 'needs_you'
      ? [{ kind, type: 'decision' }, { kind, type: 'approval' }, { kind, type: 'blocked' }] : [{ kind }];
    return events.some(event => resolveFollowDeliveryV1({ policies: [policy], event }).person.voice);
  });
  return selected ? { policy } : null;
}

export function matchesPersonalFollowOnceOccurrenceV1(input: Readonly<{
  once: PersonalFollowOnceV1;
  baseline: Pick<SessionFollowFrontierV1, 'agentStateVersion'>;
  occurrence: PersonalFollowOnceOccurrenceV1;
}>): boolean {
  const { once, occurrence, baseline } = input;
  if (once.kind === 'turn_finished') {
    return occurrence.turnId === once.sourceTurnId
      && ['ready', 'failed', 'cancelled'].includes(occurrence.event);
  }
  return (occurrence.event === 'permission_required' || occurrence.event === 'user_action_required')
    && Boolean(occurrence.requestId)
    && occurrence.agentStateVersion > baseline.agentStateVersion;
}

/**
 * Accepted one-shot attention is an exception for exactly this source reference,
 * never ongoing tracking. A question needs its real request owner's live-id
 * evidence; pending counts or a newer encrypted state version are insufficient.
 */
export function resolvePersonalFollowOnceAttentionV1(input: Readonly<{
  delivery: PersonalFollowOnceOccurrenceV1 | null | undefined;
  currentRequestIds?: readonly string[];
}>): 'ready_after_read' | 'failed' | 'permission_required' | 'user_action_required' | null {
  const delivery = input.delivery;
  if (!delivery) return null;
  if (delivery.event === 'ready' || delivery.event === 'cancelled') return delivery.turnId ? 'ready_after_read' : null;
  if (delivery.event === 'failed') return delivery.turnId ? 'failed' : null;
  if ((delivery.event === 'permission_required' || delivery.event === 'user_action_required')
    && delivery.requestId && input.currentRequestIds?.includes(delivery.requestId)) return delivery.event;
  return null;
}

/**
 * Scalar ingress/presentation vocabulary. Stored event decisions use FollowPolicyV1.
 */
export const SessionFollowNotificationLevelSchema = lazyZodSchema(() => z.enum([
  'none',
  'important',
  'all_messages',
]));
export type SessionFollowNotificationLevel = z.infer<typeof SessionFollowNotificationLevelSchema>;

/** The scalar edit boundary immediately translates into the canonical policy. */
export function normalizeAccountFollowNotificationChoiceV1(input: Readonly<{
  notificationLevel: SessionFollowNotificationLevel; includeInVoice: boolean;
}>): FollowPolicyV1 {
  if (!input.includeInVoice) return input.notificationLevel === 'none' ? { preset: 'custom', events: {} }
    : { preset: input.notificationLevel === 'all_messages' ? 'everything' : 'important' };
  if (input.notificationLevel === 'all_messages') return { preset: 'everything', voice: true };
  if (input.notificationLevel === 'important') return { preset: 'important', voice: true };
  const events: FollowEventMapV1 = {};
  for (const kind of FOLLOW_EVENT_KINDS_V1) {
    const setting = { delivery: 'off', voice: true } as const;
    if (kind === 'needs_you') events.needs_you = { decision: setting, approval: setting, blocked: setting };
    else events[kind] = setting;
  }
  return { preset: 'custom', events };
}

/** Compatibility presentation only; event delivery always reads the policy. */
export function projectAccountFollowNotificationLevelV1(policy: FollowPolicyV1 | undefined): SessionFollowNotificationLevel {
  if (!policy) return 'none';
  if (policy.preset === 'quiet') return 'none';
  if (resolveFollowDeliveryV1({ policies: [policy], event: { kind: 'message' } }).selected) return 'all_messages';
  return FOLLOW_EVENT_KINDS_V1.some(kind => {
    const events: FollowEventV1[] = kind === 'needs_you'
      ? [{ kind, type: 'decision' }, { kind, type: 'approval' }, { kind, type: 'blocked' }] : [{ kind }];
    return events.some(event => resolveFollowDeliveryV1({ policies: [policy], event }).selected);
  }) ? 'important' : 'none';
}

/**
 * The Account-private projection of one `AccountSessionFollow` row.
 *
 * Persisted delivery frontiers, delivery Account ids, internal reasons and
 * runtime diagnostics are deliberately absent: a human client only needs the
 * preference it can edit.
 */
export const AccountSessionFollowV1Schema = lazyZodSchema(() => z.strictObject({
    sessionId: z.string().check(z.trim(), z.minLength(1)),
    following: z.boolean(),
    persistent: z.optional(z.boolean()),
    notificationLevel: SessionFollowNotificationLevelSchema,
    includeInVoice: z.boolean(),
    policy: z.optional(FollowPolicyV1Schema),
    once: z.optional(z.nullable(PersonalFollowOnceV1Schema)),
    onceAfterAgentStateVersion: z.optional(z.number().check(z.int(), z.minimum(0))),
    onceDelivery: z.optional(PersonalFollowOnceOccurrenceV1Schema),
  }));
export type AccountSessionFollowV1 = z.infer<typeof AccountSessionFollowV1Schema>;

/** Private policy for an admitted source whose original is not a Session. */
export const OtherAccountFollowV1Schema = lazyZodSchema(() => z.strictObject({
  source: FollowSourceRefV1Schema,
  following: z.boolean(),
  persistent: z.boolean(),
  policy: FollowPolicyV1Schema,
  once: z.optional(z.nullable(PersonalRunFollowOnceSetV1Schema)),
  onceDeliveries: z.optional(z.array(PersonalRunFollowOnceOccurrenceV1Schema)),
}).check(z.refine(row => row.source.kind !== 'session' && row.source.kind !== 'rule'
  && (row.onceDeliveries ?? []).every(delivery => sameStrictJsonValue(row.source, delivery.original.source)))));
export type OtherAccountFollowV1 = z.infer<typeof OtherAccountFollowV1Schema>;
export const AccountFollowRelationV1Schema = lazyZodSchema(() => z.union([
  AccountSessionFollowV1Schema, OtherAccountFollowV1Schema,
]));
export type AccountFollowRelationV1 = z.infer<typeof AccountFollowRelationV1Schema>;

/**
 * The server-resolved Follow capability. Reading a Session and reading the
 * caller's own Follow projection are already governed by Session access and
 * current-Account ownership, so a second `view` bit would encode one decision
 * twice.
 */
export const AccountSessionFollowCapabilitiesV1Schema = lazyZodSchema(() => z.strictObject({
    manageFollow: z.boolean(),
  }));
export type AccountSessionFollowCapabilitiesV1 = z.infer<
  typeof AccountSessionFollowCapabilitiesV1Schema
>;

/** Operational event choices for future creations, never private rule definitions. */
export const SessionFollowCreationPoliciesV1Schema = lazyZodSchema(() => z.strictObject({
  managerPolicy: FollowPolicyV1Schema,
  runReportPolicy: FollowPolicyV1Schema,
  discussionReceivePolicy: FollowPolicyV1Schema,
}));
export type SessionFollowCreationPoliciesV1 = z.infer<typeof SessionFollowCreationPoliciesV1Schema>;
export const DEFAULT_SESSION_FOLLOW_CREATION_POLICIES_V1: SessionFollowCreationPoliciesV1 = Object.freeze({
  managerPolicy: { preset: 'important' }, runReportPolicy: { preset: 'important' }, discussionReceivePolicy: { preset: 'quiet' },
} satisfies SessionFollowCreationPoliciesV1);
export const SESSION_FOLLOW_CREATION_PREFERENCES_ACCOUNT_KEY_V1 = '@happier/account/session-follow-creation-preferences/v1' as const;

/** The four operational relationship choices remain stored in the existing Account columns. */
const SessionFollowDefaultRulesV1Schema = lazyZodSchema(() => z.strictObject({
    assigned: z.boolean(),
    direct: z.boolean(),
    team: z.boolean(),
    group: z.boolean(),
}));
/** Current writes name defaultRules; legacy flat reads normalize to the same operational owner. */
export const SessionAutoFollowPreferencesV1Schema = lazyZodSchema(() => {
  const creationPolicyFields = {
    managerPolicy: z.optional(FollowPolicyV1Schema),
    runReportPolicy: z.optional(FollowPolicyV1Schema),
    discussionReceivePolicy: z.optional(FollowPolicyV1Schema),
  };
  return z.pipe(z.union([
    z.strictObject({ defaultRules: SessionFollowDefaultRulesV1Schema, ...creationPolicyFields }),
    z.strictObject({ ...SessionFollowDefaultRulesV1Schema.shape, ...creationPolicyFields }),
  ]), z.transform(value => {
    if (!('defaultRules' in value)) return value;
    const { defaultRules, ...policies } = value;
    return { ...defaultRules, ...policies };
  }));
});
export type SessionAutoFollowPreferencesV1 = z.infer<typeof SessionAutoFollowPreferencesV1Schema>;

export const DEFAULT_SESSION_AUTO_FOLLOW_PREFERENCES_V1: SessionAutoFollowPreferencesV1 =
  Object.freeze({
    assigned: true,
    direct: false,
    team: false,
    group: false,
  });

/**
 * The relationship facts used by the canonical default-rule normalizer.
 * They map one-to-one onto the four Account preferences above.
 */
export const SESSION_AUTO_FOLLOW_TRIGGERS_V1 = Object.freeze([
  'assigned',
  'direct',
  'team',
  'group',
] as const);
export type SessionAutoFollowTriggerV1 = typeof SESSION_AUTO_FOLLOW_TRIGGERS_V1[number];

/** Complete current relationships for this requester, never another Account's preferences. */
export const SessionFollowDefaultRelationshipsV1Schema = lazyZodSchema(() => z.strictObject({
  assigned: z.boolean(), direct: z.boolean(), team: z.boolean(), group: z.boolean(),
}));
export type SessionFollowDefaultRelationshipsV1 = z.infer<typeof SessionFollowDefaultRelationshipsV1Schema>;

/** Reuses the access owner's complete applicable grants, not its bounded display explanations. */
export function projectSessionFollowDefaultRelationshipsV1(input: Readonly<{
  responsibleForMe: boolean; relationshipKinds: readonly ('direct' | 'team' | 'group')[];
}>): SessionFollowDefaultRelationshipsV1 {
  return { assigned: input.responsibleForMe, direct: input.relationshipKinds.includes('direct'),
    team: input.relationshipKinds.includes('team'), group: input.relationshipKinds.includes('group') };
}

export type SessionFollowDefaultRuleV1 = Readonly<{
  key: SessionAutoFollowTriggerV1; receiver: Readonly<{ kind: 'account' }>; definition: SessionFollowRuleDefinitionV1;
}>;

/** Built-in personal rules share the authored rule representation, without stored identities or enrollment. */
export function normalizeSessionFollowDefaultRulesV1(input: Readonly<{
  serverId: string; preferences: SessionAutoFollowPreferencesV1;
  relationships: Partial<Readonly<SessionFollowDefaultRelationshipsV1>>;
  hasPersistentFollow?: boolean;
}>): Readonly<{ rules: readonly SessionFollowDefaultRuleV1[]; pendingKeys: readonly SessionAutoFollowTriggerV1[] }> {
  const rules: SessionFollowDefaultRuleV1[] = [];
  const pendingKeys: SessionAutoFollowTriggerV1[] = [];
  if (input.hasPersistentFollow === true) return { rules, pendingKeys };
  const filter = normalizeSessionListFilterV1({ homeServerIds: [input.serverId], show: 'sessions',
    scope: 'all_accessible', startedBy: ['you', 'triggers', 'agents'] });
  for (const key of SESSION_AUTO_FOLLOW_TRIGGERS_V1) {
    if (!input.preferences[key]) continue;
    if (input.relationships[key] === false) continue;
    if (input.hasPersistentFollow === undefined || input.relationships[key] === undefined) { pendingKeys.push(key); continue; }
    if (input.relationships[key]) rules.push({ key, receiver: { kind: 'account' },
      definition: { v: 1, enabled: true, filter, policy: { preset: 'important' } } });
  }
  return { rules, pendingKeys };
}

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
export const SessionFollowFactsV1Schema = lazyZodSchema(() => z.strictObject({
    follows: z.boolean(),
    notificationLevel: z.nullable(SessionFollowNotificationLevelSchema),
    /** Current requester-qualified complete relationships; older projections remain unavailable. */
    defaultRelationships: z.optional(SessionFollowDefaultRelationshipsV1Schema),
    /**
     * Synchronized Account Follow authority for Voice eligibility. Optional on
     * read so cached/released viewer projections remain parseable; current Home
     * projections always supply it and absence fails closed.
     */
    includeInVoice: z.optional(z.boolean()),
    policy: z.optional(FollowPolicyV1Schema),
    once: z.optional(z.nullable(PersonalFollowOnceV1Schema)),
    onceAfterAgentStateVersion: z.optional(z.number().check(z.int(), z.minimum(0))),
    onceDelivery: z.optional(PersonalFollowOnceOccurrenceV1Schema),
  }));
export type SessionFollowFactsV1 = z.infer<typeof SessionFollowFactsV1Schema>;

export const ABSENT_SESSION_FOLLOW_FACTS_V1: SessionFollowFactsV1 = Object.freeze({
  follows: false,
  notificationLevel: null,
});

/**
 * The one stored-row → Follow-facts mapping, shared by the Home reader and the
 * client editor so a suppression row cannot mean two different things on the two
 * sides of the wire. Stored policies are parsed by the custody boundary above.
 */
export function projectSessionFollowFactsV1(
  row: Readonly<{ following: boolean; notificationLevel?: unknown; includeInVoice?: boolean;
    followPolicy?: string | null; notifyOnce?: string | null; hasPersistentFollow?: boolean; persistent?: boolean;
    policy?: z.infer<typeof FollowPolicyV1Schema>; once?: PersonalFollowOnceV1 | null; onceAfterAgentStateVersion?: number; onceDelivery?: PersonalFollowOnceOccurrenceV1 }> | null | undefined,
): SessionFollowFactsV1 {
  if (!row) return ABSENT_SESSION_FOLLOW_FACTS_V1;
  const custody = projectPersonalFollowCustodyV1(row);
  if (row.hasPersistentFollow === false || row.persistent === false) return { ...ABSENT_SESSION_FOLLOW_FACTS_V1, ...custody,
    ...(row.once === undefined ? {} : { once: row.once }),
    ...(row.onceAfterAgentStateVersion === undefined ? {} : { onceAfterAgentStateVersion: row.onceAfterAgentStateVersion }),
    ...(row.onceDelivery === undefined ? {} : { onceDelivery: row.onceDelivery }) };
  if (!row.following) return {
    follows: false,
    notificationLevel: 'none',
    ...(row.includeInVoice === undefined ? {} : { includeInVoice: false }),
    ...(row.once === undefined ? {} : { once: row.once }),
    ...(row.onceAfterAgentStateVersion === undefined ? {} : { onceAfterAgentStateVersion: row.onceAfterAgentStateVersion }),
    ...(row.onceDelivery === undefined ? {} : { onceDelivery: row.onceDelivery }),
    ...custody,
  };
  return {
    follows: true,
    notificationLevel: projectAccountFollowNotificationLevelV1(custody.policy ?? row.policy),
    ...(row.includeInVoice === undefined && row.policy === undefined && custody.policy === undefined ? {} : {
      includeInVoice: resolveAccountFollowVoiceSelectionV1({ includeInVoice: row.includeInVoice, policy: custody.policy ?? row.policy }) !== null,
    }),
    ...(row.policy === undefined ? {} : { policy: row.policy }),
    ...(row.once === undefined ? {} : { once: row.once }),
    ...(row.onceAfterAgentStateVersion === undefined ? {} : { onceAfterAgentStateVersion: row.onceAfterAgentStateVersion }),
    ...(row.onceDelivery === undefined ? {} : { onceDelivery: row.onceDelivery }),
    ...custody,
  };
}

/**
 * The one effective-notification resolver: an explicit per-Session preference
 * wins, otherwise a Session owner keeps the existing Important default, and a
 * non-owner without a Follow row receives nothing through this stored-choice
 * resolver. Relationship defaults are separately normalized as admitted rules.
 */
export function resolveEffectiveSessionFollowNotificationLevelV1(params: Readonly<{
  facts: SessionFollowFactsV1;
  isSessionOwner: boolean;
}>): SessionFollowNotificationLevel {
  if (params.facts.notificationLevel !== null) return params.facts.notificationLevel;
  return params.isSessionOwner ? 'important' : 'none';
}

export function resolveEffectiveAccountFollowPolicyV1(params: Readonly<{
  facts: SessionFollowFactsV1; isSessionOwner: boolean;
}>): FollowPolicyV1 | null {
  return params.facts.policy ?? (params.facts.notificationLevel === null && params.isSessionOwner ? { preset: 'important' } : null);
}

/**
 * The public projection of an explicit Unfollow. Persistence keeps the
 * suppression bit; notificationLevel is derived and never written to storage.
 */
export const EXPLICIT_SESSION_UNFOLLOW_STATE_V1 = Object.freeze({
  following: false as const,
  notificationLevel: 'none' as const,
  includeInVoice: false as const,
});

export type AccountSessionFollowEditorStateV1 = Readonly<{
  /** Owner-or-active-Follow. An owner cannot untrack their own Session. */
  tracked: boolean;
  /** A stored explicit Unfollow, which also blocks every later automatic trigger. */
  suppressed: boolean;
  notificationLevel: SessionFollowNotificationLevel;
  includeInVoice: boolean;
  policy: FollowPolicyV1 | null;
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
    suppressed: params.follow?.following === false && params.follow.persistent !== false,
    notificationLevel: resolveEffectiveSessionFollowNotificationLevelV1({
      facts,
      isSessionOwner: params.isSessionOwner,
    }),
    includeInVoice: facts.follows && facts.includeInVoice === true,
    policy: resolveEffectiveAccountFollowPolicyV1({ facts, isSessionOwner: params.isSessionOwner }),
  };
}
