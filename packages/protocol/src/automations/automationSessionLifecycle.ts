import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

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

export const AutomationSessionLifecycleRequestKindSchema =
  SessionUserActionRequiredRequestKindV1Schema;
export type AutomationSessionLifecycleRequestKind =
  SessionUserActionRequiredRequestKindV1;

export const AUTOMATION_SESSION_LIFECYCLE_MAX_MATCH_COUNT = 2_147_483_647;

const AutomationSessionLifecycleNextMatchesPolicySchema = lazyZodSchema(() => z.object({
  kind: z.literal('nextMatches'),
  count: z.number().int().positive().max(AUTOMATION_SESSION_LIFECYCLE_MAX_MATCH_COUNT),
}).strict());

export const AutomationSessionLifecyclePolicySnapshotSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('currentTurn') }).strict(),
  z.object({ kind: z.literal('firstMatch') }).strict(),
  AutomationSessionLifecycleNextMatchesPolicySchema,
  z.object({ kind: z.literal('everyMatch') }).strict(),
]));
export type AutomationSessionLifecyclePolicySnapshot = z.infer<
  typeof AutomationSessionLifecyclePolicySnapshotSchema
>;

export const AutomationSessionLifecyclePolicySchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('currentTurn'),
    sourceTurnId: TurnIdSchema,
  }).strict(),
  z.object({ kind: z.literal('firstMatch') }).strict(),
  AutomationSessionLifecycleNextMatchesPolicySchema,
  z.object({ kind: z.literal('everyMatch') }).strict(),
]));
export type AutomationSessionLifecyclePolicy = z.infer<
  typeof AutomationSessionLifecyclePolicySchema
>;

export const AutomationSessionLifecycleEventsSchema = lazyZodSchema(() => z.array(
  AutomationSessionLifecycleEventSchema,
).min(1).superRefine((events, context) => {
  if (new Set(events).size !== events.length) {
    context.addIssue({
      code: 'custom',
      message: 'Session lifecycle Events must be unique',
    });
  }
}));

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

export const AutomationSessionLifecycleConfigurationSchema = lazyZodSchema(() => z.object({
  sourceSessionId: asProtocolZod(SessionIdSchema),
  events: AutomationSessionLifecycleEventsSchema,
  policy: AutomationSessionLifecyclePolicySchema,
}).strict());
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
