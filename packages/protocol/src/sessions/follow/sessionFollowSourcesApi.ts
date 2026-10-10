import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { SessionIdSchema } from '../idsV1.js';
import { SESSION_FOLLOW_ERROR_CODES_V1 } from './api.js';

const FollowSessionIdSchema = asProtocolZod(SessionIdSchema);

export const SESSION_FOLLOW_SOURCE_MODES_V1 = ['next_turn', 'wake_on_human_change'] as const;
export const SessionFollowSourceModeV1Schema = lazyZodSchema(() => z.enum(SESSION_FOLLOW_SOURCE_MODES_V1));
export type SessionFollowSourceModeV1 = z.infer<typeof SessionFollowSourceModeV1Schema>;

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
] as const);
export type SessionFollowSourcesErrorCodeV1 = typeof SESSION_FOLLOW_SOURCES_ERROR_CODES_V1[number];

export const SessionFollowSourcesErrorCodeV1Schema = lazyZodSchema(() => z.enum(SESSION_FOLLOW_SOURCES_ERROR_CODES_V1));

export const SessionFollowSourcesErrorResponseSchema = lazyZodSchema(() => z
  .object({ error: SessionFollowSourcesErrorCodeV1Schema })
  .strict());
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
export const SessionFollowSourceV1Schema = lazyZodSchema(() => z
  .object({
    sourceSessionId: FollowSessionIdSchema,
    destinationSessionId: FollowSessionIdSchema,
    mode: SessionFollowSourceModeV1Schema.default('next_turn'),
    deliveryState: SessionFollowSourceDeliveryStateV1Schema,
    hasPendingUpdates: z.boolean(),
  })
  .strict());
export type SessionFollowSourceV1 = z.infer<typeof SessionFollowSourceV1Schema>;

/** `GET /v2/sessions/:destinationSessionId/follows/sessions` takes no input. */
export const ListSessionFollowSourcesResponseSchema = lazyZodSchema(() => z
  .object({ sources: z.array(SessionFollowSourceV1Schema) })
  .strict());
export type ListSessionFollowSourcesResponse = z.infer<typeof ListSessionFollowSourcesResponseSchema>;

/**
 * `PUT /v2/sessions/:destinationSessionId/follows/sessions/:sourceSessionId`.
 *
 * V1 natural-turn delivery is implicit, so the body is empty. Creation seeds
 * every delivered component from the source's current frontier, so enabling
 * Follow never emits historical context and the caller never supplies a
 * frontier or an execution Account.
 */
export const SetSessionFollowSourceRequestSchema = lazyZodSchema(() => z
  .object({ mode: SessionFollowSourceModeV1Schema.optional() })
  .strict());
export type SetSessionFollowSourceRequest = z.infer<typeof SetSessionFollowSourceRequestSchema>;

export const SetSessionFollowSourceResponseSchema = lazyZodSchema(() => z
  .object({
    changed: z.boolean(),
    source: SessionFollowSourceV1Schema,
  })
  .strict());
export type SetSessionFollowSourceResponse = z.infer<typeof SetSessionFollowSourceResponseSchema>;

/**
 * `DELETE /v2/sessions/:destinationSessionId/follows/sessions/:sourceSessionId`
 * is idempotent: removing an absent edge reports `changed: false` rather than a
 * not-found failure, and removal never grants source read.
 */
export const RemoveSessionFollowSourceResponseSchema = lazyZodSchema(() => z
  .object({ changed: z.boolean() })
  .strict());
export type RemoveSessionFollowSourceResponse = z.infer<typeof RemoveSessionFollowSourceResponseSchema>;

export const SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1 = Object.freeze({
  list: '/v2/sessions/:destinationSessionId/follows/sessions',
  source: '/v2/sessions/:destinationSessionId/follows/sessions/:sourceSessionId',
});
