import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { SessionIdSchema } from '../idsV1.js';
import { PendingLocalIdSchema } from '../pending/pendingLocalId.js';
import { SessionFollowRuleWitnessV1Schema } from './sessionFollowRuleV1.js';
import { TurnIdSchema } from '../idsV1.js';
import { isProjectedSessionStalledV1 } from '../awareness/runtime.js';
import { defineStoredReadProjection } from '../../json/storedReadSchema.js';
import { ExecutionRunFollowSourceV1Schema } from './sessionDeliveryMuteV1.js';
import { SessionFollowTerminalTurnV1Schema } from './sessionFollowFrontierV1.js';
import { SessionFollowSelectedDeliveryV1Schema } from './sessionFollowSelectedDeliveryV1.js';
import { SessionQuestionHandlerV1Schema } from '../permissions/questionV1.js';

/** Existing committed presence fence + exact in-flight Turn; not a Message or a delivery cursor. */
export const SessionFollowStalledOccurrenceV1Schema = lazyZodSchema(() => z.strictObject({
  turnId: TurnIdSchema,
  publisherFence: z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)),
}));
export type SessionFollowStalledOccurrenceV1 = z.infer<typeof SessionFollowStalledOccurrenceV1Schema>;

export function isSessionFollowStalledOccurrenceCurrentV1(occurrence: SessionFollowStalledOccurrenceV1,
  source: Readonly<{ active?: boolean | null; latestTurnId?: string | null; latestTurnStatus?: string | null;
    archivedAt?: unknown; activeAt: number }>): boolean {
  return source.archivedAt == null && isProjectedSessionStalledV1({ active: source.active, latestTurnStatus: source.latestTurnStatus })
    && source.latestTurnId === occurrence.turnId && source.activeAt === occurrence.publisherFence;
}

export const SessionFollowPublisherGenerationV1Schema = lazyZodSchema(() => z.string().check(
  z.regex(/^(?:0|[1-9]\d{0,18})$/u), z.refine(value => BigInt(value) <= 9_223_372_036_854_775_807n)));
/** Private admission route reasons, resolved internally after provider acceptance. */
const relationAttachedAt = z.number().check(z.int(), z.nonnegative());
export const SessionFollowRelationWitnessesV1Schema = lazyZodSchema(() => z.array(z.union([
  z.strictObject({ relation: z.literal('follower') }),
  z.strictObject({ relation: z.literal('manager'), attachedAt: relationAttachedAt }),
  z.strictObject({ relation: z.literal('follower'), attachedAt: relationAttachedAt,
    source: ExecutionRunFollowSourceV1Schema,
    expectedTerminalEventId: z.nullable(z.string().check(z.minLength(1))) }),
  z.strictObject({ relation: z.literal('follower'), attachedAt: relationAttachedAt,
    source: z.strictObject({ kind: z.literal('workflow_run'), runId: z.string().check(z.minLength(1)) }),
    expectedRevision: z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)) }),
])).check(z.minLength(1), z.refine(values => new Set(values.map(value => JSON.stringify([
  value.relation, 'source' in value ? value.source : null,
]))).size === values.length)));
export type SessionFollowRelationWitnessV1 = z.infer<typeof SessionFollowRelationWitnessesV1Schema>[number];
// Routing custody is closed even on retained reads. Dropping Run fields could
// reinterpret its witness as the less specific Session follower union arm.
defineStoredReadProjection(SessionFollowRelationWitnessesV1Schema, () => SessionFollowRelationWitnessesV1Schema);
export const SessionFollowSourceMessageV1Schema = lazyZodSchema(() => z.strictObject({
  localId: PendingLocalIdSchema, seq: z.number().check(z.int(), z.positive(), z.maximum(Number.MAX_SAFE_INTEGER)),
}));
/** The host's persisted terminal Turn is the original, irrespective of native marker timing. */
export const SessionFollowSourceTurnV1Schema = SessionFollowTerminalTurnV1Schema;
export type SessionFollowSourceTurnV1 = z.infer<typeof SessionFollowSourceTurnV1Schema>;
export const SessionFollowSourceRequestsV1Schema = lazyZodSchema(() => z.strictObject({
  agentStateVersion: z.number().check(z.int(), z.positive(), z.maximum(Number.MAX_SAFE_INTEGER)),
  requests: z.array(z.strictObject({
    requestId: z.string().check(z.minLength(1)),
    createdAt: z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)),
    turnId: z.optional(TurnIdSchema),
    /** Exact request-owner assignment; omitted for an ordinary informational notice. */
    currentHandler: z.optional(SessionQuestionHandlerV1Schema),
  })).check(z.minLength(1), z.superRefine((requests, context) => {
    const ids = new Set<string>();
    for (const [index, request] of requests.entries()) {
      if (ids.has(request.requestId)) context.addIssue({ code: 'custom', path: [index, 'requestId'], message: 'Request identities must be unique' });
      if (request.currentHandler && (requests.length !== 1 || request.currentHandler.kind !== 'session')) {
        context.addIssue({ code: 'custom', path: [index, 'currentHandler'], message: 'A question offer names one assigned Session handler' });
      }
      ids.add(request.requestId);
    }
  })),
}));
/** One visible Machine-admission witness, bound by the existing receipt to encrypted receiver input. */
export const SessionFollowSourceOccurrenceWitnessFieldsV1 = {
  rule: z.lazy(() => SessionFollowRuleWitnessV1Schema),
  /** Exact vote from the authorized private evaluator for this pinned rule version. */
  selectedDelivery: SessionFollowSelectedDeliveryV1Schema,
  sourceSessionId: asProtocolZod(SessionIdSchema), destinationSessionId: asProtocolZod(SessionIdSchema),
  evaluation: z.optional(z.enum(['source', 'receiver'])),
  expectedSourcePublisherGeneration: z.optional(SessionFollowPublisherGenerationV1Schema),
  machineId: z.optional(z.string().check(z.minLength(1))), installationId: z.optional(z.string().check(z.trim(), z.minLength(1))),
};
function occurrenceWitnessSchema<Fields extends Record<string, z.ZodMiniType>>(extraFields: Fields) {
  return z.union([
    z.strictObject({ ...SessionFollowSourceOccurrenceWitnessFieldsV1, ...extraFields,
      sourceMessage: SessionFollowSourceMessageV1Schema, sourceRequests: z.optional(z.never()), sourceTurn: z.optional(z.never()) }),
    z.strictObject({ ...SessionFollowSourceOccurrenceWitnessFieldsV1, ...extraFields,
      sourceRequests: SessionFollowSourceRequestsV1Schema, sourceMessage: z.optional(z.never()), sourceTurn: z.optional(z.never()) }),
    z.strictObject({ ...SessionFollowSourceOccurrenceWitnessFieldsV1, ...extraFields,
      sourceTurn: SessionFollowSourceTurnV1Schema, sourceMessage: z.optional(z.never()), sourceRequests: z.optional(z.never()) }),
  ]).check(z.refine<Record<string, unknown>>(value => value.sourceSessionId !== value.destinationSessionId, {
  path: ['destinationSessionId'], message: 'Follow cannot deliver a source to itself',
  }), z.refine<Record<string, unknown>>(value => value.evaluation === 'receiver'
    ? value.expectedSourcePublisherGeneration === undefined && value.machineId === undefined && value.installationId === undefined
    : value.expectedSourcePublisherGeneration !== undefined && value.machineId !== undefined && value.installationId !== undefined,
  { message: 'Source evaluation requires its exact publisher; receiver evaluation uses admission custody' }));
}
export const SessionFollowSourceOccurrenceWitnessV1Schema = lazyZodSchema(() => occurrenceWitnessSchema({}));
export type SessionFollowSourceOccurrenceWitnessV1 = z.infer<typeof SessionFollowSourceOccurrenceWitnessV1Schema>;
export const SessionFollowSourceOccurrenceWitnessesV1Schema = lazyZodSchema(() => z.array(SessionFollowSourceOccurrenceWitnessV1Schema)
  .check(z.minLength(1), z.superRefine((items, context) => {
    const first = items[0];
    const rules = new Set<string>();
    for (const [index, item] of items.entries()) {
      if (rules.has(item.rule.ruleId)) context.addIssue({ code: 'custom', path: [index, 'rule'], message: 'Each rule is represented once' });
      rules.add(item.rule.ruleId);
      if (first && (item.sourceSessionId !== first.sourceSessionId || item.destinationSessionId !== first.destinationSessionId
        || JSON.stringify(item.sourceMessage ?? item.sourceRequests ?? ('sourceTurn' in item ? item.sourceTurn : undefined))
          !== JSON.stringify(first.sourceMessage ?? first.sourceRequests ?? ('sourceTurn' in first ? first.sourceTurn : undefined))
        || item.expectedSourcePublisherGeneration !== first.expectedSourcePublisherGeneration
        || item.machineId !== first.machineId || item.installationId !== first.installationId)) {
        context.addIssue({ code: 'custom', path: [index], message: 'One Follow input represents one original source occurrence' });
      }
    }
  })));
