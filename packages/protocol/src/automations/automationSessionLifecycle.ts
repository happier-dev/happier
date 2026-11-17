import {
  AutomationSessionSubjectV1Schema,
  AutomationProjectSubjectV1Schema,
  AutomationMachineSubjectV1Schema,
  AutomationSubjectStructuralV1Schema,
  checkAutomationSubjectStructuralV1,
  projectAutomationSubjectStructuralV1,
} from './automationSubjectV1.js';


import { lazyDefinition, lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { zodSchemaToJsonSchemaObject } from '../actions/actionInputJsonSchema.js';
import { normalizePluginJsonSchema } from '../plugins/actions/protocolComposableSchema.js';
import type { PluginJsonSchemaV2 } from '../plugins/contributions/jsonSchema.js';

import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { SessionIdSchema, TurnIdSchema } from '../sessions/idsV1.js';
import { computeCanonicalDomainSeparatedDigest } from '../crypto/canonicalDigest.js';
import { AutomationEventFilterV1Schema, type AutomationEventFilterV1 } from './automationEventFilterV1.js';
import { evaluateAutomationEventFilterV1, validateAutomationEventFilterAgainstPayloadSchemaV1 } from './automationEventV1.js';
import {
  SessionUserActionRequiredRequestKindV1Schema,
  type SessionUserActionRequiredRequestKindV1,
} from '../sessions/userActionRequiredOccurrenceV1.js';

export const AutomationSessionLifecycleEventSchema = lazyZodSchema(() => z.enum([
  'parentTurnStarted',
  'parentTurnCompleted',
  'parentTurnFailed',
  'parentTurnCancelled',
  'userActionRequired',
  'sessionStarted',
  'sessionArchived',
]));
export type AutomationSessionLifecycleEvent = z.infer<
  typeof AutomationSessionLifecycleEventSchema
>;

/** Authoring groups project the exact lifecycle event schema, never a matcher. */
export const AUTOMATION_SESSION_LIFECYCLE_EVENT_GROUPS_V1 = {
  turnStarts: ['parentTurnStarted'],
  turnEnds: ['parentTurnCompleted', 'parentTurnFailed', 'parentTurnCancelled'],
  needsYou: ['userActionRequired'],
  sessionArchived: ['sessionArchived'],
  sessionStarts: ['sessionStarted'],
} as const satisfies Readonly<Record<string, readonly AutomationSessionLifecycleEvent[]>>;

export const AutomationSessionLifecycleRequestKindSchema =
  lazyZodSchema(() => SessionUserActionRequiredRequestKindV1Schema);
export type AutomationSessionLifecycleRequestKind =
  SessionUserActionRequiredRequestKindV1;

export const AUTOMATION_SESSION_LIFECYCLE_MAX_MATCH_COUNT = 2_147_483_647;

const AutomationSessionLifecycleNextMatchesPolicySchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('nextMatches'),
  count: z.number().check(z.int(), z.positive(), z.maximum(AUTOMATION_SESSION_LIFECYCLE_MAX_MATCH_COUNT)),
}));

export const AutomationSessionLifecyclePolicySnapshotSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('currentTurn') }),
  z.strictObject({ kind: z.literal('firstMatch') }),
  AutomationSessionLifecycleNextMatchesPolicySchema,
  z.strictObject({ kind: z.literal('everyMatch') }),
]));
export type AutomationSessionLifecyclePolicySnapshot = z.infer<
  typeof AutomationSessionLifecyclePolicySnapshotSchema
>;

export const AutomationSessionLifecyclePolicySchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('currentTurn'),
    sourceTurnId: TurnIdSchema,
  }),
  z.strictObject({ kind: z.literal('firstMatch') }),
  AutomationSessionLifecycleNextMatchesPolicySchema,
  z.strictObject({ kind: z.literal('everyMatch') }),
]));
export type AutomationSessionLifecyclePolicy = z.infer<
  typeof AutomationSessionLifecyclePolicySchema
>;

export const AutomationSessionLifecycleEventsSchema = lazyZodSchema(() => z.array(
  AutomationSessionLifecycleEventSchema,
).check(z.minLength(1), z.superRefine((events, context) => {
  if (new Set(events).size !== events.length) {
    context.addIssue({
      code: 'custom',
      message: 'Session lifecycle Events must be unique',
    });
  }
})));

/**
 * A selected Event set is a set: only its membership decides admission. Authors
 * and clients may submit any order, so the canonical order below is the one
 * comparable projection persistence and equality use. It is applied by the
 * persistence owner rather than by the request schema, which must stay
 * JSON-Schema representable for the public API boundary.
 */
export function canonicalizeAutomationSessionLifecycleEvents(
  events: readonly AutomationSessionLifecycleEvent[],
): AutomationSessionLifecycleEvent[] {
  return AutomationSessionLifecycleEventSchema.options.filter(
    (candidate) => events.includes(candidate),
  );
}

export const AutomationSessionLifecycleSubjectV1Schema = lazyZodSchema(() => z.union([
  AutomationSessionSubjectV1Schema,
  AutomationProjectSubjectV1Schema,
  AutomationMachineSubjectV1Schema,
]));
export type AutomationSessionLifecycleSubjectV1 = z.infer<typeof AutomationSessionLifecycleSubjectV1Schema>;

/** Matching facts are published by the lifecycle producer, never recomputed per habit. */
export const AutomationSessionLifecycleFactsSchema = lazyZodSchema(() => z.strictObject({
  /** Domain-separated profile digest; raw launch-profile ids stay in the private definition. */
  launchProfileId: z.optional(z.nullable(z.string().check(z.minLength(1)))),
  /** Null or omission means unavailable evidence, rather than a clean worktree. */
  changedFiles: z.optional(z.nullable(z.boolean())),
}));
export type AutomationSessionLifecycleFacts = z.infer<typeof AutomationSessionLifecycleFactsSchema>;

export const AUTOMATION_SESSION_LIFECYCLE_FILTER_PAYLOAD_SCHEMA_V1: PluginJsonSchemaV2 = lazyDefinition(() =>
  normalizePluginJsonSchema(zodSchemaToJsonSchemaObject(AutomationSessionLifecycleFactsSchema, { target: 'draft-7' })));

const AutomationSessionLifecycleFilterSchema = lazyZodSchema(() => AutomationEventFilterV1Schema.check(z.superRefine((filter, context) => {
  const result = validateAutomationEventFilterAgainstPayloadSchemaV1({
    filter, payloadSchema: AUTOMATION_SESSION_LIFECYCLE_FILTER_PAYLOAD_SCHEMA_V1,
  });
  if (result.kind === 'invalid') {
    context.addIssue({ code: 'custom', message: 'Invalid Session lifecycle filter', params: result.issue });
  }
})));

export function projectAutomationSessionLifecycleLaunchProfileId(launchProfileId: string): string {
  return computeCanonicalDomainSeparatedDigest('happier.automation-session-launch-profile.v1', [launchProfileId]);
}

function projectLifecycleFilter(filter: AutomationEventFilterV1): AutomationEventFilterV1 {
  return {
    ...filter,
    all: filter.all.map(clause => {
      if (clause.field !== '/launchProfileId') return clause;
      if (clause.op === 'in') {
        return { ...clause, values: clause.values.map(value => typeof value === 'string'
          ? projectAutomationSessionLifecycleLaunchProfileId(value) : value) };
      }
      return clause.op === 'eq' && typeof clause.value === 'string'
        ? { ...clause, value: projectAutomationSessionLifecycleLaunchProfileId(clause.value) } : clause;
    }),
  };
}

/** The existing composable Event evaluator owns matching for lifecycle facts too. */
export function matchesAutomationSessionLifecycleFilter(
  filter: AutomationEventFilterV1 | undefined,
  facts: AutomationSessionLifecycleFacts | undefined,
): boolean {
  return evaluateAutomationEventFilterV1(filter ?? null, facts ?? {});
}

export const AutomationSessionLifecycleConfigurationSchema = lazyZodSchema(() => z.strictObject({
  subject: z.optional(AutomationSessionLifecycleSubjectV1Schema),
  events: AutomationSessionLifecycleEventsSchema,
  policy: AutomationSessionLifecyclePolicySchema,
  filter: z.optional(AutomationSessionLifecycleFilterSchema),
}));
export type AutomationSessionLifecycleConfiguration = z.infer<typeof AutomationSessionLifecycleConfigurationSchema>;

/** Matching headers reveal only the C1 digest; a source id is a registration witness. */
export const AutomationSessionLifecycleStructuralConfigurationSchema = lazyZodSchema(() => z.strictObject({
  ...AutomationSubjectStructuralV1Schema.shape,
  subjectKind: z.optional(z.union([
    AutomationSessionSubjectV1Schema.shape.kind,
    AutomationProjectSubjectV1Schema.shape.kind,
    AutomationMachineSubjectV1Schema.shape.kind,
  ])),
  sourceSessionId: z.optional(asProtocolZod(SessionIdSchema)),
  events: AutomationSessionLifecycleEventsSchema,
  policy: AutomationSessionLifecyclePolicySchema,
  filter: z.optional(AutomationSessionLifecycleFilterSchema),
}).check(z.superRefine(checkAutomationSubjectStructuralV1)));
export type AutomationSessionLifecycleStructuralConfiguration = z.infer<
  typeof AutomationSessionLifecycleStructuralConfigurationSchema
>;

/** The only authored Session selection to indexed matching-header projection. */
export function projectAutomationSessionLifecycleStructuralConfiguration(
  definition: AutomationSessionLifecycleConfiguration,
): AutomationSessionLifecycleStructuralConfiguration {
  return canonicalizeAutomationSessionLifecycleStructuralConfiguration({
    ...(definition.subject ? {
      ...projectAutomationSubjectStructuralV1(definition.subject), subjectKind: definition.subject.kind,
    } : {}),
    ...(definition.policy.kind === 'currentTurn' && definition.subject?.kind === 'session'
      ? { sourceSessionId: definition.subject.sessionId } : {}),
    events: canonicalizeAutomationSessionLifecycleEvents(definition.events),
    policy: definition.policy,
    ...(definition.filter === undefined ? {} : { filter: projectLifecycleFilter(definition.filter) }),
  });
}

/** Consumers compare only this owner's matching fields, excluding row status. */
export function canonicalizeAutomationSessionLifecycleStructuralConfiguration(
  configuration: AutomationSessionLifecycleStructuralConfiguration,
): AutomationSessionLifecycleStructuralConfiguration {
  return {
    ...(configuration.subjectKind === undefined ? {} : { subjectKind: configuration.subjectKind }),
    ...(configuration.subjectKey === undefined ? {} : { subjectKey: configuration.subjectKey }),
    ...(configuration.sourceSessionId === undefined ? {} : { sourceSessionId: configuration.sourceSessionId }),
    events: canonicalizeAutomationSessionLifecycleEvents(configuration.events),
    policy: configuration.policy,
    ...(configuration.filter === undefined ? {} : { filter: configuration.filter }),
  };
}

export function initialAutomationSessionLifecycleRemainingOccurrences(
  policy: AutomationSessionLifecyclePolicy,
): number | null {
  switch (policy.kind) {
    case 'currentTurn':
    case 'firstMatch':
      return 1;
    case 'nextMatches':
      return policy.count;
    case 'everyMatch':
      return null;
  }
}

export function snapshotAutomationSessionLifecyclePolicy(
  policy: AutomationSessionLifecyclePolicy,
): AutomationSessionLifecyclePolicySnapshot {
  return policy.kind === 'currentTurn' ? { kind: 'currentTurn' } : policy;
}
