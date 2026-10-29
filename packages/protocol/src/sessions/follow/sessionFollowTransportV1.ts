import { lazyZodSchema } from '../../lazyZodSchema.js';
import { sha256 } from '@noble/hashes/sha2';
import { z } from 'zod/mini';

import { encodeBase64 } from '../../crypto/base64.js';
import { SessionIdSchema } from '../idsV1.js';
import { DiscussionAddressingV1Schema, DiscussionAddressV1Schema, type DiscussionAddressingV1 } from '../../discussions/references.js';
import { DiscussionMessageRefV1Schema } from '../../discussions/messageRefs.js';
import { SessionInputMachineTargetV1Schema } from '../messages/sessionInputAdmission.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { PendingLocalIdSchema } from '../pending/pendingLocalId.js';
import { ExecutionRunFollowOriginalV1Schema, ExecutionRunFollowSourceV1Schema, ExecutionRunFollowOccurrenceV1Schema, ExecutionRunFollowEventV1Schema, SessionFollowInputV1Schema, WorkflowRunFollowOriginalV1Schema, WorkflowRunFollowEventV1Schema } from './sessionFollowInputV1.js';
import { FollowEventV1Schema, FollowPolicyV1Schema, serializeFollowPolicyV1 } from './sessionFollowPolicyV1.js';
import { SessionFollowSelectedDeliveryV1Schema } from './sessionFollowSelectedDeliveryV1.js';
import { SessionFollowPublisherGenerationV1Schema, SessionFollowSourceMessageV1Schema, SessionFollowSourceRequestsV1Schema, SessionFollowSourceTurnV1Schema, SessionFollowStalledOccurrenceV1Schema } from './sessionFollowSourceOccurrenceV1.js';
import { SessionMetadataPublisherPreconditionV1Schema } from '../metadata/sessionMetadataSchemasV1.js';
import { SessionFollowDefaultRelationshipsV1Schema } from './accountFollow.js';
import { ExecutionRunOutputRefV1Schema } from '../../reviews/reviewNarration.js';
import { WorkerUpdateV1Schema, classifyWorkerUpdateEventV1 } from '../relations/workerUpdateV1.js';
import {
  SessionFollowFrontierV1Schema,
  type SessionFollowFrontierV1,
} from './sessionFollowFrontierV1.js';

export const SESSION_FOLLOW_OBSERVE_PENDING_EVENT_V1 = 'session-follow-observe-pending-v1' as const;
export const SESSION_FOLLOW_ACKNOWLEDGE_EVENT_V1 = 'session-follow-acknowledge-v1' as const;
export const SESSION_FOLLOW_WAKE_EVENT_LOCAL_ID_PREFIX = 'session-follow-wake:' as const;
export const SESSION_FOLLOW_WAKE_EVENT_MESSAGE = 'Followed context changed, so Happier woke this Agent with the update.' as const;

export function buildSessionFollowWakeEventLocalId(wakeId: string): string {
  const normalizedWakeId = wakeId.trim();
  if (normalizedWakeId.length === 0) throw new Error('Session Follow wake id must not be empty');
  return `${SESSION_FOLLOW_WAKE_EVENT_LOCAL_ID_PREFIX}${normalizedWakeId}`;
}

export function isSessionFollowWakeEventLocalId(localId: unknown): localId is string {
  return typeof localId === 'string'
    && localId.startsWith(SESSION_FOLLOW_WAKE_EVENT_LOCAL_ID_PREFIX)
    && localId.length > SESSION_FOLLOW_WAKE_EVENT_LOCAL_ID_PREFIX.length;
}

const PublisherGenerationV1Schema = SessionFollowPublisherGenerationV1Schema;
const NonBlankStringSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
// SessionIdSchema is the Protocol composable schema; adapt it at this Zod
// composition boundary so discriminated unions receive a native Zod node
// while admission remains owned by the canonical SessionId schema.
const SessionIdZodSchema = asProtocolZod(SessionIdSchema);

const SESSION_FOLLOW_WAKE_EVENT_IDENTITY_DOMAIN_V1 = 'session-follow-wake-event:v1' as const;
const textEncoder = new TextEncoder();

function serializeWakeFrontier(frontier: SessionFollowFrontierV1) {
  return [
    frontier.transcriptSeq,
    frontier.readyEventSeq,
    frontier.agentStateVersion,
    frontier.turn === null ? null : [frontier.turn.id, frontier.turn.status],
  ] as const;
}

/** A manager observation carries its exact attachment identity; no other relation does. */
function managerAttachmentMatches(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return true;
  const relation = 'relation' in value ? value.relation : undefined;
  const attachedAt = 'attachedAt' in value ? value.attachedAt : undefined;
  return (relation === 'manager') === (attachedAt !== undefined);
}

/** No-original receivers see the selected route, never private rule witnesses. */
function noOriginalRouteSchema<Fields extends Record<string, z.ZodMiniType>>(fields: Fields) {
  return z.union([
    z.strictObject({ ...fields, policy: FollowPolicyV1Schema,
      relation: z._default(z.enum(['follower', 'manager']), 'follower'),
      attachedAt: z.optional(z.number().check(z.int(), z.nonnegative())),
      effectiveDelivery: z.optional(z.never()), presence: z.optional(z.never()),
    }).check(z.refine<unknown>(managerAttachmentMatches, {
      path: ['attachedAt'], message: 'Manager observations require their exact attachment identity',
    })),
    z.strictObject({ ...fields, relation: z.literal('rule'), effectiveDelivery: SessionFollowSelectedDeliveryV1Schema,
      presence: SessionFollowStalledOccurrenceV1Schema, policy: z.optional(z.never()), attachedAt: z.optional(z.never()) }),
  ]);
}

export const SessionFollowWakeObservationV1Schema = lazyZodSchema(() => noOriginalRouteSchema({
  sourceSessionId: SessionIdZodSchema,
  expected: SessionFollowFrontierV1Schema,
  consumed: SessionFollowFrontierV1Schema,
}));
export type SessionFollowWakeObservationV1 = z.infer<typeof SessionFollowWakeObservationV1Schema>;

const SessionFollowWakeObservationBatchV1Schema = lazyZodSchema(() => z.array(SessionFollowWakeObservationV1Schema).check(z.minLength(1), z.superRefine((observations, context) => {
    const seenSourceSessionIds = new Set<string>();
    for (const [index, observation] of observations.entries()) {
      const identity = `${observation.relation ?? 'follower'}:${observation.sourceSessionId}`;
      if (seenSourceSessionIds.has(identity)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'sourceSessionId'],
          message: 'Session Follow wake observations require unique source Sessions',
        });
      }
      seenSourceSessionIds.add(identity);
    }
  })));

/** Canonical byte-order normalization for the exact source batch represented by a wake event. */
export function normalizeSessionFollowWakeObservationsV1(
  observations: readonly SessionFollowWakeObservationV1[],
): SessionFollowWakeObservationV1[] {
  return SessionFollowWakeObservationBatchV1Schema.parse(observations).sort((left, right) => (
    left.sourceSessionId < right.sourceSessionId
      ? -1
      : left.sourceSessionId > right.sourceSessionId
        ? 1
        : (left.relation ?? 'follower') < (right.relation ?? 'follower') ? -1
          : (left.relation ?? 'follower') > (right.relation ?? 'follower') ? 1
            : 0
  ));
}

/**
 * Derives the one durable event identity for a context-only wake attempt.
 * Sorting makes a retry independent of hydration completion order, while the
 * publisher fence and exact expected/consumed tuples prevent a later wake from
 * aliasing an earlier accepted frontier set.
 */
export function deriveSessionFollowWakeEventLocalIdV1(input: Readonly<{
  destinationSessionId: string;
  publisherGeneration: string;
  observations: readonly SessionFollowWakeObservationV1[];
}>): string {
  const destinationSessionId = SessionIdZodSchema.parse(input.destinationSessionId);
  const publisherGeneration = PublisherGenerationV1Schema.parse(input.publisherGeneration);
  const observations = normalizeSessionFollowWakeObservationsV1(input.observations);
  const canonicalIdentity = JSON.stringify([
    SESSION_FOLLOW_WAKE_EVENT_IDENTITY_DOMAIN_V1,
    destinationSessionId,
    publisherGeneration,
    observations.map((observation) => [
      observation.sourceSessionId,
      observation.relation === 'rule'
        ? [observation.effectiveDelivery, observation.presence.turnId, observation.presence.publisherFence]
        : serializeFollowPolicyV1(observation.policy),
      serializeWakeFrontier(observation.expected),
      serializeWakeFrontier(observation.consumed),
      ...(observation.relation ? [observation.relation, observation.attachedAt] : []),
    ]),
  ]);
  return buildSessionFollowWakeEventLocalId(
    encodeBase64(sha256(textEncoder.encode(canonicalIdentity)), 'base64url'),
  );
}

export const SessionFollowSessionPendingObservationV1Schema = lazyZodSchema(() => noOriginalRouteSchema({
  sourceSessionId: SessionIdZodSchema,
  destinationSessionId: SessionIdZodSchema,
  delivered: SessionFollowFrontierV1Schema,
  observed: SessionFollowFrontierV1Schema,
}));
export type SessionFollowSessionPendingObservationV1 = z.infer<typeof SessionFollowSessionPendingObservationV1Schema>;

/** Caller-declared diagnostic only; it grants no source or recovery authority. */
export const SessionFollowRunRouteReleaseReasonV1Schema = lazyZodSchema(() => z.enum([
  'exact_run', 'target_machine', 'account_reconnect', 'full_recovery', 'legacy_broad',
]));
export type SessionFollowRunRouteReleaseReasonV1 = z.infer<typeof SessionFollowRunRouteReleaseReasonV1Schema>;

/** Optional query controls keep the existing strict request body compatible with older Homes. */
export const SessionFollowRunOccurrenceRoutesQueryV1Schema = lazyZodSchema(() => z.strictObject({
  includeTargetMachineId: z.optional(z.literal('true')),
  releaseReason: z.optional(SessionFollowRunRouteReleaseReasonV1Schema),
}));
export type SessionFollowRunOccurrenceRoutesQueryV1 = z.infer<typeof SessionFollowRunOccurrenceRoutesQueryV1Schema>;

/** Current, exact Run-original route read; no parent Session frontier or private rule proof. */
export const SessionFollowRunOccurrenceRoutesRequestV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ v: z.literal(1), original: ExecutionRunFollowOriginalV1Schema }),
  z.strictObject({ v: z.literal(1), original: WorkflowRunFollowOriginalV1Schema }),
  z.strictObject({ v: z.literal(1), source: ExecutionRunFollowSourceV1Schema, outputRef: z.optional(ExecutionRunOutputRefV1Schema) }),
  z.strictObject({ v: z.literal(1), source: WorkflowRunFollowOriginalV1Schema.shape.source }),
]));
export type SessionFollowRunOccurrenceRoutesRequestV1 = z.infer<typeof SessionFollowRunOccurrenceRoutesRequestV1Schema>;
const runRouteFields = () => ({ destinationSessionId: SessionIdZodSchema, relation: z.literal('follower'),
  attachedAt: z.number().check(z.int(), z.nonnegative()), policy: FollowPolicyV1Schema });
export const SessionFollowRunOccurrenceRoutesResponseV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ok: z.literal(true), v: z.literal(1), original: ExecutionRunFollowOriginalV1Schema,
    event: ExecutionRunFollowEventV1Schema,
    personal: z.optional(z.strictObject({ policy: FollowPolicyV1Schema, alreadyRepresented: z.boolean() })),
    routes: z.array(z.strictObject({ ...runRouteFields(),
      expectedTerminalEventId: z.nullable(z.string().check(z.minLength(1))) })) }).check(z.refine(value =>
    ExecutionRunFollowOccurrenceV1Schema.safeParse({ original: value.original, event: value.event }).success)),
  z.strictObject({ ok: z.literal(true), v: z.literal(1), original: WorkflowRunFollowOriginalV1Schema,
    event: WorkflowRunFollowEventV1Schema,
    personal: z.optional(z.strictObject({ policy: FollowPolicyV1Schema, alreadyRepresented: z.boolean() })),
    routes: z.array(z.strictObject({ ...runRouteFields(),
      expectedRevision: z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)) })) }),
  z.strictObject({ ok: z.literal(false), v: z.literal(1), error: z.literal('source_unavailable'),
    targetMachineId: z.optional(NonBlankStringSchema) }),
  z.strictObject({ ok: z.literal(false), v: z.literal(1), error: z.enum(['forbidden', 'invalid_request']) }),
]));
export type SessionFollowRunOccurrenceRoutesResponseV1 = z.infer<typeof SessionFollowRunOccurrenceRoutesResponseV1Schema>;

const discussionFollowSourceSchema = lazyZodSchema(() => z.strictObject({ kind: z.literal('discussion'),
  discussionId: DiscussionMessageRefV1Schema.shape.discussion.shape.discussionId }));
export const SessionFollowDiscussionOccurrenceRoutesRequestV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), source: discussionFollowSourceSchema, messageId: z.optional(DiscussionMessageRefV1Schema.shape.messageId),
}));
export type SessionFollowDiscussionOccurrenceRoutesRequestV1 = z.infer<typeof SessionFollowDiscussionOccurrenceRoutesRequestV1Schema>;
/** Source-local pointer; the authorized client qualifies the exact C3 message ref with its captured Home. */
export const SessionFollowDiscussionOccurrenceV1Schema = lazyZodSchema(() => z.strictObject({
  source: discussionFollowSourceSchema, messageId: DiscussionMessageRefV1Schema.shape.messageId,
  seq: z.number().check(z.int(), z.positive()), event: z.strictObject({ kind: z.enum(['person_wrote', 'message']) }),
  personal: z.strictObject({ policy: FollowPolicyV1Schema, alreadyRepresented: z.boolean() }),
}));
export type SessionFollowDiscussionOccurrenceV1 = z.infer<typeof SessionFollowDiscussionOccurrenceV1Schema>;
/** One non-Session source route read. Executable Discussion participants retain their own C3 addressing intake. */
export const SessionFollowSourceOccurrenceRoutesRequestV1Schema = lazyZodSchema(() => z.union([
  SessionFollowRunOccurrenceRoutesRequestV1Schema, SessionFollowDiscussionOccurrenceRoutesRequestV1Schema,
]));
export type SessionFollowSourceOccurrenceRoutesRequestV1 = z.infer<typeof SessionFollowSourceOccurrenceRoutesRequestV1Schema>;
export const SessionFollowSourceOccurrenceRoutesResponseV1Schema = lazyZodSchema(() => z.union([
  SessionFollowRunOccurrenceRoutesResponseV1Schema,
  z.strictObject({ ok: z.literal(true), v: z.literal(1), discussion: SessionFollowDiscussionOccurrenceV1Schema }),
]));
export type SessionFollowSourceOccurrenceRoutesResponseV1 = z.infer<typeof SessionFollowSourceOccurrenceRoutesResponseV1Schema>;

/** One original's ordinary source routes; private rule witnesses never cross this read boundary. */
export const SessionFollowObserveSourceRoutesRequestV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ v: z.literal(1), receiver: z.strictObject({ kind: z.literal('account') }),
    production: z.enum(['source', 'recovery']), sourcePublisher: z.optional(z.never()), destinationSessionId: z.optional(z.never()),
    sourceMessage: SessionFollowSourceMessageV1Schema, sourceTurn: z.optional(z.never()), sourceRequests: z.optional(z.never()) }),
  z.strictObject({ v: z.literal(1), receiver: z.strictObject({ kind: z.literal('account') }),
    production: z.enum(['source', 'recovery']), sourcePublisher: z.optional(z.never()), destinationSessionId: z.optional(z.never()),
    sourceTurn: SessionFollowSourceTurnV1Schema, sourceMessage: z.optional(z.never()), sourceRequests: z.optional(z.never()) }),
  z.strictObject({ v: z.literal(1), receiver: z.strictObject({ kind: z.literal('account') }),
    production: z.enum(['source', 'recovery']), sourcePublisher: z.optional(z.never()), destinationSessionId: z.optional(z.never()),
    sourceRequests: SessionFollowSourceRequestsV1Schema, sourceTurn: z.optional(z.never()), sourceMessage: z.optional(z.never()) }),
  z.strictObject({ v: z.literal(1), sourcePublisher: SessionMetadataPublisherPreconditionV1Schema,
    destinationSessionId: z.optional(z.never()), sourceTurn: SessionFollowSourceTurnV1Schema,
    sourceMessage: z.optional(z.never()), sourceRequests: z.optional(z.never()) }),
  z.strictObject({ v: z.literal(1), destinationSessionId: SessionIdZodSchema,
    sourcePublisher: z.optional(z.never()), sourceTurn: SessionFollowSourceTurnV1Schema,
    sourceMessage: z.optional(z.never()), sourceRequests: z.optional(z.never()) }),
  z.strictObject({ v: z.literal(1), sourcePublisher: SessionMetadataPublisherPreconditionV1Schema,
    destinationSessionId: z.optional(z.never()),
    sourceMessage: SessionFollowSourceMessageV1Schema, sourceRequests: z.optional(z.never()), sourceTurn: z.optional(z.never()) }),
  z.strictObject({ v: z.literal(1), sourcePublisher: SessionMetadataPublisherPreconditionV1Schema,
    destinationSessionId: z.optional(z.never()),
    sourceRequests: SessionFollowSourceRequestsV1Schema, sourceMessage: z.optional(z.never()), sourceTurn: z.optional(z.never()) }),
  z.strictObject({ v: z.literal(1), destinationSessionId: SessionIdZodSchema,
    sourcePublisher: z.optional(z.never()), sourceMessage: SessionFollowSourceMessageV1Schema, sourceRequests: z.optional(z.never()), sourceTurn: z.optional(z.never()) }),
  z.strictObject({ v: z.literal(1), destinationSessionId: SessionIdZodSchema,
    sourcePublisher: z.optional(z.never()), sourceRequests: SessionFollowSourceRequestsV1Schema, sourceMessage: z.optional(z.never()), sourceTurn: z.optional(z.never()) }),
]));
export type SessionFollowObserveSourceRoutesRequestV1 = z.infer<typeof SessionFollowObserveSourceRoutesRequestV1Schema>;
export const SessionFollowObserveSourceRoutesResponseV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ok: z.literal(true), v: z.literal(1), sourceSessionId: SessionIdZodSchema,
    routes: z.array(SessionFollowSessionPendingObservationV1Schema),
    receiverEvaluation: z.optional(z.strictObject({ ownerAccountId: NonBlankStringSchema, production: z.literal('source') })),
    /** Missing original time cannot establish a rule's inception boundary. */
    originalCreatedAt: z.optional(z.number().check(z.int(), z.gte(0))),
    /** Existing Pending/Message custody for this exact handler-bound question original. */
    representedQuestionHandlerSessionId: z.optional(SessionIdZodSchema),
    /** Private to this current Account read, never copied into the original or native input. */
    currentAccountFacts: z.optional(z.strictObject({ defaultRelationships: SessionFollowDefaultRelationshipsV1Schema,
      personalFollowSuppressed: z.boolean(), hasPersistentFollow: z.optional(z.boolean()) })),
  }).check(z.superRefine((value, context) => {
    const identities = new Set<string>();
    for (const [index, route] of value.routes.entries()) {
      const identity = `${route.destinationSessionId}:${route.relation}`;
      if (route.sourceSessionId !== value.sourceSessionId || route.sourceSessionId === route.destinationSessionId
        || identities.has(identity)) context.addIssue({ code: 'custom', path: ['routes', index], message: 'Source routes must identify one distinct current relation' });
      identities.add(identity);
    }
  })),
  z.strictObject({ ok: z.literal(false), v: z.literal(1), error: z.enum(['forbidden', 'invalid_request', 'other_evaluator', 'recovery_unverified']) }),
]));
export type SessionFollowObserveSourceRoutesResponseV1 = z.infer<typeof SessionFollowObserveSourceRoutesResponseV1Schema>;

/** The committed question, not a caller-authored attention hint or a fabricated Session source. */
export const SessionFollowDiscussionPendingObservationV1Schema = lazyZodSchema(() => z.strictObject({
  source: z.strictObject({ kind: z.literal('discussion'), discussionId: DiscussionAddressingV1Schema.shape.discussionId }),
  destinationSessionId: SessionIdZodSchema,
  addressing: DiscussionAddressingV1Schema,
  policy: FollowPolicyV1Schema,
  event: FollowEventV1Schema,
}).check(z.refine(value => value.source.discussionId === value.addressing.discussionId
  && value.destinationSessionId === value.addressing.participantSessionId, {
  path: ['addressing'], message: 'Discussion occurrence must name its actual source and receiver',
})));
export type SessionFollowDiscussionPendingObservationV1 = z.infer<typeof SessionFollowDiscussionPendingObservationV1Schema>;
/**
 * Already-evaluated public intent; private rules stay in admission custody.
 * Requested ids hydrate queued input. An unsolicited observation is an exact
 * server-verified accepted-input rejoin for native source correlation only;
 * it must never render, reinject or ACK that already accepted input again.
 */
export const SessionFollowAdmittedInputObservationV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('admitted_input'), localInputId: PendingLocalIdSchema,
  sourceSessionId: SessionIdZodSchema, destinationSessionId: SessionIdZodSchema,
  delivered: SessionFollowFrontierV1Schema, observed: SessionFollowFrontierV1Schema,
  delivery: SessionFollowInputV1Schema,
  /** Current surviving route union; immutable original/receipt delivery stays unchanged. */
  effectiveDelivery: z.nullable(SessionFollowSelectedDeliveryV1Schema),
}).check(z.refine(value => 'sourceSessionId' in value.delivery.original && value.sourceSessionId === value.delivery.original.sourceSessionId
  && value.sourceSessionId !== value.destinationSessionId)));
export type SessionFollowAdmittedInputObservationV1 = z.infer<typeof SessionFollowAdmittedInputObservationV1Schema>;
export const SessionFollowAdmittedRunInputObservationV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('admitted_run_input'), localInputId: PendingLocalIdSchema,
  /** Positive current-source evidence retires obsolete unstarted permission custody. Absence is still retryable. */
  disposition: z.optional(z.literal('withdrawn')),
  destinationSessionId: SessionIdZodSchema,
  delivery: SessionFollowInputV1Schema,
  effectiveDelivery: z.nullable(SessionFollowSelectedDeliveryV1Schema),
  /** Source-owned terminal metadata only; never caller-authored content or a source-read grant. */
  workerUpdate: z.optional(WorkerUpdateV1Schema),
}).check(z.refine(value => 'source' in value.delivery.original
  && (value.delivery.original.source.kind === 'execution_run' || value.delivery.original.source.kind === 'workflow_run')
  && (value.disposition !== 'withdrawn' || 'permissionRequests' in value.delivery.original)
  && (value.workerUpdate === undefined || value.disposition === undefined
    && 'terminalEventId' in value.delivery.original && value.delivery.original.source.kind === 'execution_run'
    && 'sessionId' in value.delivery.original.source && value.workerUpdate.workerKind === 'execution_run'
    && value.workerUpdate.workerId === value.delivery.original.source.runId
    && value.workerUpdate.transcriptPointer?.kind === 'execution_run'
    && value.workerUpdate.transcriptPointer.sessionId === value.delivery.original.source.sessionId
    && value.workerUpdate.transcriptPointer.runId === value.delivery.original.source.runId
    && value.workerUpdate.canInspect === false && value.workerUpdate.result === undefined
    && value.workerUpdate.deliverables === undefined && value.workerUpdate.engine === undefined
    && 'event' in value.delivery && classifyWorkerUpdateEventV1(value.workerUpdate) === value.delivery.event.kind))));
export type SessionFollowAdmittedRunInputObservationV1 = z.infer<typeof SessionFollowAdmittedRunInputObservationV1Schema>;
export const SessionFollowPendingObservationV1Schema = lazyZodSchema(() => z.union([
  SessionFollowSessionPendingObservationV1Schema, SessionFollowDiscussionPendingObservationV1Schema, SessionFollowAdmittedInputObservationV1Schema,
  SessionFollowAdmittedRunInputObservationV1Schema,
]));
export type SessionFollowPendingObservationV1 = z.infer<typeof SessionFollowPendingObservationV1Schema>;

/** One existing Pending identity per immutable committed question and concrete receiver. */
export function deriveDiscussionFollowInputLocalIdV1(addressing: DiscussionAddressingV1): string {
  const value = DiscussionAddressingV1Schema.parse(addressing);
  return `discussion-follow-v1:${encodeBase64(sha256(textEncoder.encode(JSON.stringify([
    'discussion-follow-input:v1', value.discussionId, value.messageId, value.throughSeq, value.participantSessionId,
  ]))), 'base64url')}`;
}

export const SessionFollowObservePendingRequestV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  sessionId: SessionIdZodSchema,
  includeManager: z.optional(z.boolean()),
  inputLocalIds: z.optional(z.array(PendingLocalIdSchema).check(z.minLength(1))),
  supportsWakeAdmission: z.optional(z.literal(true)),
  wakeAdmission: z.optional(z.strictObject({
    eventLocalId: NonBlankStringSchema,
    observations: SessionFollowWakeObservationBatchV1Schema,
    autonomousCheckIn: z.optional(z.strictObject({
      afterTurns: z.nullable(z.number().check(z.int(), z.positive())),
    })),
  })),
}));
export type SessionFollowObservePendingRequestV1 = z.infer<typeof SessionFollowObservePendingRequestV1Schema>;

export const SessionFollowObservePendingResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    v: z.literal(1),
    sessionId: SessionIdZodSchema,
    publisherGeneration: PublisherGenerationV1Schema,
    currentSourceSessionIds: z.array(SessionIdZodSchema),
    observations: z.array(SessionFollowPendingObservationV1Schema),
    // Explicit null proves a non-Discussion root. Omission means origin
    // authority is unavailable and current clients hold before provider effect.
    wakeAdmission: z.optional(z.discriminatedUnion('status', [
      z.strictObject({ status: z.literal('allowed'),
        originatingDiscussion: z.optional(z.nullable(DiscussionAddressV1Schema)) }),
      z.strictObject({ status: z.literal('held'), code: z.enum([
        'autonomous_check_in', 'session_input_target_unavailable', 'session_input_cancelled',
      ]), originatingDiscussion: z.optional(z.nullable(DiscussionAddressV1Schema)) }),
    ])),
  }),
  z.strictObject({
    ok: z.literal(false),
    v: z.literal(1),
    error: z.enum(['invalid_request', 'forbidden', 'unsupported', 'internal']),
  }),
]));
export type SessionFollowObservePendingResponseV1 = z.infer<typeof SessionFollowObservePendingResponseV1Schema>;

/** Content-free prelaunch observation; this grants no publisher or ACK authority. */
export const SessionFollowObserveInactiveRequestV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  machineId: NonBlankStringSchema,
  installationId: NonBlankStringSchema,
}));
export type SessionFollowObserveInactiveRequestV1 = z.infer<typeof SessionFollowObserveInactiveRequestV1Schema>;

export const SessionFollowObserveInactiveResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    v: z.literal(1),
    sessionId: SessionIdZodSchema,
    target: SessionInputMachineTargetV1Schema,
    currentSourceSessionIds: z.array(SessionIdZodSchema),
    observations: z.array(SessionFollowPendingObservationV1Schema),
  }),
  z.strictObject({
    ok: z.literal(false),
    v: z.literal(1),
    error: z.enum(['invalid_request', 'forbidden', 'unsupported', 'internal']),
  }),
]));
export type SessionFollowObserveInactiveResponseV1 = z.infer<typeof SessionFollowObserveInactiveResponseV1Schema>;

const SessionFollowEdgeAcknowledgeRequestV1Schema = lazyZodSchema(() => noOriginalRouteSchema({
  v: z.literal(1),
  destinationSessionId: SessionIdZodSchema,
  sourceSessionId: SessionIdZodSchema,
  expectedPublisherGeneration: PublisherGenerationV1Schema,
  expected: SessionFollowFrontierV1Schema,
  observed: SessionFollowFrontierV1Schema,
  consumed: SessionFollowFrontierV1Schema,
  acceptance: z.union([
    z.strictObject({
      kind: z.literal('admitted_input'),
      localInputId: NonBlankStringSchema,
      userMessageSeq: z.nullable(z.number().check(z.int(), z.nonnegative())),
    }),
    z.strictObject({
      kind: z.literal('context_only_wake'),
      eventLocalId: NonBlankStringSchema.apply((base) => base.check(z.refine<z.output<typeof base>>(isSessionFollowWakeEventLocalId, {
        message: 'Expected a canonical Session Follow wake event id',
      })) as typeof base & z.ZodMiniType<string, z.input<typeof base>>),
      observations: SessionFollowWakeObservationBatchV1Schema,
    }),
  ]),
}).check(z.superRefine((value, context) => {
  if ((value.relation === 'manager') !== (value.attachedAt !== undefined)) {
    context.addIssue({ code: 'custom', path: ['attachedAt'], message: 'Manager ACK requires the exact attachment timestamp' });
  }
  if (value.sourceSessionId === value.destinationSessionId) {
    context.addIssue({ code: 'custom', path: ['sourceSessionId'], message: 'Follow requires distinct Sessions' });
  }
})));
export const SessionFollowAdmittedInputAcknowledgeRequestV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), destinationSessionId: SessionIdZodSchema, sourceSessionId: SessionIdZodSchema,
  localInputId: PendingLocalIdSchema, expectedPublisherGeneration: PublisherGenerationV1Schema,
  expected: SessionFollowFrontierV1Schema, observed: SessionFollowFrontierV1Schema, consumed: SessionFollowFrontierV1Schema,
  acceptance: z.strictObject({ kind: z.literal('admitted_input'), localInputId: PendingLocalIdSchema,
    userMessageSeq: z.nullable(z.number().check(z.int(), z.nonnegative())) }),
}).check(z.refine(value => value.localInputId === value.acceptance.localInputId
  && value.destinationSessionId !== value.sourceSessionId)));
export const SessionFollowAdmittedRunInputAcknowledgeRequestV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), destinationSessionId: SessionIdZodSchema,
  localInputId: PendingLocalIdSchema, expectedPublisherGeneration: PublisherGenerationV1Schema,
  original: z.union([ExecutionRunFollowOriginalV1Schema, WorkflowRunFollowOriginalV1Schema]),
  acceptance: z.strictObject({ kind: z.literal('admitted_input'), localInputId: PendingLocalIdSchema,
    userMessageSeq: z.nullable(z.number().check(z.int(), z.nonnegative())) }),
}).check(z.refine(value => value.localInputId === value.acceptance.localInputId)));
export const SessionFollowAcknowledgeRequestV1Schema = lazyZodSchema(() => z.union([
  SessionFollowEdgeAcknowledgeRequestV1Schema, SessionFollowAdmittedInputAcknowledgeRequestV1Schema,
  SessionFollowAdmittedRunInputAcknowledgeRequestV1Schema,
]));
export type SessionFollowAcknowledgeRequestV1 = z.infer<typeof SessionFollowAcknowledgeRequestV1Schema>;

export const SessionFollowAcknowledgeResponseV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ok: z.literal(true), v: z.literal(1), destinationSessionId: SessionIdZodSchema,
    localInputId: PendingLocalIdSchema, original: z.union([ExecutionRunFollowOriginalV1Schema, WorkflowRunFollowOriginalV1Schema]) }),
  z.strictObject({
    ok: z.literal(true),
    v: z.literal(1),
    destinationSessionId: SessionIdZodSchema,
    sourceSessionId: SessionIdZodSchema,
    delivered: SessionFollowFrontierV1Schema,
  }),
  z.strictObject({
    ok: z.literal(false),
    v: z.literal(1),
    error: z.enum([
      'invalid_request',
      'forbidden',
      'edge_not_found',
      'session_archived',
      'stale_publisher_generation',
      'stale_expected_frontier',
      'stale_terminal_turn',
      'invalid_consumed_frontier',
      'provider_acceptance_unverified',
      'source_forbidden',
      'unsupported',
      'retryable',
      'internal',
    ]),
  }),
]));
export type SessionFollowAcknowledgeResponseV1 = z.infer<typeof SessionFollowAcknowledgeResponseV1Schema>;
