import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { SessionIdSchema, TurnIdSchema } from '../sessions/idsV1.js';
import {
  SessionUserActionRequiredRequestKindV1Schema,
  type SessionUserActionRequiredRequestKindV1,
} from '../sessions/userActionRequiredOccurrenceV1.js';

export const AutomationSessionLifecycleEventSchema = lazyZodSchema(() => z.enum([
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

export const AutomationSessionLifecycleConfigurationSchema = lazyZodSchema(() => z.strictObject({
  sourceSessionId: asProtocolZod(SessionIdSchema),
  events: AutomationSessionLifecycleEventsSchema,
  policy: AutomationSessionLifecyclePolicySchema,
}));
export type AutomationSessionLifecycleConfiguration = z.infer<
  typeof AutomationSessionLifecycleConfigurationSchema
>;

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
