import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import { SessionViewerProjectionV1Schema } from '../personal/viewer.js';

/**
 * Transport for `POST /v2/sessions/:sessionId/read-state` (Lane 09B §5.3).
 *
 * The route and its mutation input/output stay owned by the existing
 * `registerSessionReadStateRoutes` owner. This module only names the path so
 * the Action catalog's `serverTransport` and both host adapters bind the exact
 * same URL without a second path table. No feature gate, registrar, or second
 * persistence writer is introduced here.
 */
export const SESSION_READ_STATE_HTTP_PATHS_V1 = Object.freeze({
  set: '/v2/sessions/:sessionId/read-state',
});

export const SESSION_READ_STATE_HTTP_METHOD_V1 = 'POST' as const;

/**
 * The existing domain route body. The Action input carries the same `state`
 * plus the exact `sessionId` address; the shared binder lifts the path param
 * into the URL and sends only `{ state }` as JSON body.
 */
export const SessionReadStateRouteRequestBodyV1Schema = lazyZodSchema(() => z.object({
  state: z.enum(['read', 'unread']),
}).strict());
export type SessionReadStateRouteRequestBodyV1 = z.infer<typeof SessionReadStateRouteRequestBodyV1Schema>;

/**
 * The existing domain route success payload. The Action result removes only
 * the transport-level `success` flag and retains the optional canonical
 * private viewer projection so interactive hosts can converge immediately.
 */
export const SessionReadStateRouteSuccessResponseV1Schema = lazyZodSchema(() => z.object({
  success: z.literal(true),
  state: z.enum(['read', 'unread', 'empty']),
  lastViewedSessionSeq: z.number().int().min(0).nullable(),
  didChange: z.boolean(),
  viewer: SessionViewerProjectionV1Schema.optional(),
}).strict());
export type SessionReadStateRouteSuccessResponseV1 = z.infer<typeof SessionReadStateRouteSuccessResponseV1Schema>;

/**
 * Exact existing route failures. They remain transport vocabulary; the one
 * Action failure projector maps them to the closed Action error codes below.
 */
export const SessionReadStateRouteInvalidRequestResponseV1Schema = lazyZodSchema(() => z.object({
  error: z.literal('invalid-read-state'),
}).strict());
export const SessionReadStateRouteForbiddenResponseV1Schema = lazyZodSchema(() => z.object({
  error: z.literal('Forbidden'),
}).strict());
export const SessionReadStateRouteNotTrackedResponseV1Schema = lazyZodSchema(() => z.object({
  error: z.literal('session_not_tracked'),
  viewer: SessionViewerProjectionV1Schema.optional(),
}).strict());
export const SessionReadStateRouteNotFoundResponseV1Schema = lazyZodSchema(() => z.object({
  error: z.literal('Session not found'),
}).strict());
export const SessionReadStateRouteFailureResponseV1Schema = lazyZodSchema(() => z.object({
  error: z.literal('Failed to update session read state'),
}).strict());

export const SESSION_READ_STATE_ACTION_ERROR_CODES_V1 = Object.freeze([
  'invalid_parameters',
  'session_not_tracked',
  'session_not_found',
  'forbidden',
] as const);
export type SessionReadStateActionErrorCodeV1 = typeof SESSION_READ_STATE_ACTION_ERROR_CODES_V1[number];
export const SessionReadStateActionErrorCodeV1Schema = lazyZodSchema(() => z.enum(SESSION_READ_STATE_ACTION_ERROR_CODES_V1));
