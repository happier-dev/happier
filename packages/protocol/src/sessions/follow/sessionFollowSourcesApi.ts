import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { SessionIdSchema } from '../idsV1.js';
import { SESSION_FOLLOW_ERROR_CODES_V1 } from './api.js';
import { FollowPolicyV1Schema } from './sessionFollowPolicyV1.js';
import { FollowListPageResultFieldsV1 } from './sessionFollowListV1.js';
import { FollowSourceRefV1Schema } from './sessionDeliveryMuteV1.js';

const FollowSessionIdSchema = asProtocolZod(SessionIdSchema);

/**
 * Authoring contracts for the `SessionFollowEdge` source relation.
 *
 * These DTOs describe only the human/agent authoring resource. The runtime
 * delivery envelope, prompt context and daemon socket contracts are owned by
 * the runtime Follow modules beside this one; nothing here is a delivery
 * surface and no delivery endpoint is exposed to humans or plugins.
 */

/**
 * The closed authoring failure vocabulary. It extends the shared Follow codes
 * with the two rejections that only exist for a source/destination pair, so the
 * route adapter keeps one mapping instead of a second evaluator.
 */
export const SESSION_FOLLOW_SOURCES_ERROR_CODES_V1 = Object.freeze([
  ...SESSION_FOLLOW_ERROR_CODES_V1,
  'session_follow_same_session',
  'session_follow_source_forbidden',
  'session_follow_source_unavailable',
] as const);
export type SessionFollowSourcesErrorCodeV1 = typeof SESSION_FOLLOW_SOURCES_ERROR_CODES_V1[number];

export const SessionFollowSourcesErrorCodeV1Schema = lazyZodSchema(() => z.enum(SESSION_FOLLOW_SOURCES_ERROR_CODES_V1));

export const SessionFollowSourcesErrorResponseSchema = lazyZodSchema(() => z.strictObject({ error: SessionFollowSourcesErrorCodeV1Schema }));
export type SessionFollowSourcesErrorResponse = z.infer<typeof SessionFollowSourcesErrorResponseSchema>;

/**
 * Durable eligibility derived from the two endpoints inside the same
 * transaction that reads the edge.
 *
 * `paused_archived` is the only non-eligible durable state: an archived source
 * or destination keeps the relation but performs no observation, hydration,
 * delivery or acknowledgment. Runtime reachability and source-key readiness are
 * deliberately absent — they are not persisted on the edge and are derived by
 * their own owners from current runtime facts.
 */
export const SESSION_FOLLOW_SOURCE_DELIVERY_STATES_V1 = ['eligible', 'paused_archived'] as const;
export type SessionFollowSourceDeliveryStateV1 = (typeof SESSION_FOLLOW_SOURCE_DELIVERY_STATES_V1)[number];
export const SessionFollowSourceDeliveryStateV1Schema = lazyZodSchema(() => z.enum(SESSION_FOLLOW_SOURCE_DELIVERY_STATES_V1));

/**
 * One authored source relation. Titles are intentionally absent: source display
 * names live in end-to-end encrypted Session metadata that the Home cannot
 * read, so presentation resolves them from the client's own Session projection.
 */
export const SessionFollowSourceV1Schema = lazyZodSchema(() => z.strictObject({
    sourceSessionId: FollowSessionIdSchema,
    destinationSessionId: FollowSessionIdSchema,
    policy: FollowPolicyV1Schema,
    deliveryState: SessionFollowSourceDeliveryStateV1Schema,
    hasPendingUpdates: z.boolean(),
    /** Reverse inspection distinguishes configured intents on the same pair. */
    relation: z.optional(z.enum(['follower', 'manager'])),
  }));
export type SessionFollowSourceV1 = z.infer<typeof SessionFollowSourceV1Schema>;

/** Non-Session sources retain their own exact identity on the same Follow edge. */
export const OtherSessionFollowSourceV1Schema = lazyZodSchema(() => z.strictObject({
    source: FollowSourceRefV1Schema,
    destinationSessionId: FollowSessionIdSchema,
    policy: FollowPolicyV1Schema,
    deliveryState: SessionFollowSourceDeliveryStateV1Schema,
    sourceAvailability: z.enum(['available', 'unavailable']),
    /** Null means this source's own retained-result reader has not proved currentness. */
    hasPendingUpdates: z.nullable(z.boolean()),
    relation: z.literal('follower'),
  }).check(z.refine(row => row.source.kind !== 'session' && row.source.kind !== 'rule')));
export const FollowSourceRelationV1Schema = lazyZodSchema(() => z.union([
  SessionFollowSourceV1Schema, OtherSessionFollowSourceV1Schema,
]));
export type FollowSourceRelationV1 = z.infer<typeof FollowSourceRelationV1Schema>;

/** `GET /v2/sessions/:destinationSessionId/follows/sessions` takes no input. */
export const ListSessionFollowSourcesResponseSchema = lazyZodSchema(() => z.strictObject({ sources: z.array(FollowSourceRelationV1Schema), ...FollowListPageResultFieldsV1 }));
export type ListSessionFollowSourcesResponse = z.infer<typeof ListSessionFollowSourcesResponseSchema>;
export const GetOtherSessionFollowSourceResponseSchema = lazyZodSchema(() => z.strictObject({
  source: z.nullable(OtherSessionFollowSourceV1Schema),
}));

/**
 * `PUT /v2/sessions/:destinationSessionId/follows/sessions/:sourceSessionId`.
 *
 * The caller supplies the shared event policy. Creation seeds
 * every delivered component from the source's current frontier, so enabling
 * Follow never emits historical context and the caller never supplies a
 * frontier or an execution Account.
 */
export const SetSessionFollowSourceRequestSchema = lazyZodSchema(() => z.strictObject({ policy: FollowPolicyV1Schema }));
export type SetSessionFollowSourceRequest = z.infer<typeof SetSessionFollowSourceRequestSchema>;

export const SetSessionFollowSourceResponseSchema = lazyZodSchema(() => z.strictObject({
    changed: z.boolean(),
    source: FollowSourceRelationV1Schema,
  }));
export type SetSessionFollowSourceResponse = z.infer<typeof SetSessionFollowSourceResponseSchema>;

/**
 * `DELETE /v2/sessions/:destinationSessionId/follows/sessions/:sourceSessionId`
 * is idempotent: removing an absent edge reports `changed: false` rather than a
 * not-found failure, and removal never grants source read.
 */
export const RemoveSessionFollowSourceResponseSchema = lazyZodSchema(() => z.strictObject({ changed: z.boolean() }));
export type RemoveSessionFollowSourceResponse = z.infer<typeof RemoveSessionFollowSourceResponseSchema>;

export const SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1 = Object.freeze({
  occurrenceRoutes: '/v2/sessions/:sourceSessionId/follows/occurrence-routes',
  runOccurrenceRoutes: '/v2/follows/sources/run-occurrence-routes',
  inactiveObservations: '/v2/sessions/:destinationSessionId/follows/inactive-observations',
  pendingReceivers: '/v2/follows/pending-receivers',
  list: '/v2/sessions/:destinationSessionId/follows/sessions',
  followers: '/v2/sessions/:sourceSessionId/follows/followers',
  source: '/v2/sessions/:destinationSessionId/follows/sessions/:sourceSessionId',
  otherSource: '/v2/sessions/:destinationSessionId/follows/sources',
  otherFollowers: '/v2/follows/sources/followers',
});
