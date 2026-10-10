import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import {
  AccountSessionFollowCapabilitiesV1Schema,
  AccountSessionFollowV1Schema,
  SessionAutoFollowPreferencesV1Schema,
  SessionFollowNotificationLevelSchema,
} from './accountFollow.js';

/**
 * The closed Follow failure vocabulary. Domain failures are mapped once in the
 * Follow route adapter and reused through the Action projections; there is no
 * second `session_follow_feature_unavailable` alias.
 */
export const SESSION_FOLLOW_ERROR_CODES_V1 = Object.freeze([
  'invalid_parameters',
  'feature_unavailable',
  'session_not_found',
  'account_inactive',
  'session_archived',
] as const);
export type SessionFollowErrorCodeV1 = typeof SESSION_FOLLOW_ERROR_CODES_V1[number];

export const SessionFollowErrorCodeV1Schema = lazyZodSchema(() => z.enum(SESSION_FOLLOW_ERROR_CODES_V1));

export const SessionFollowErrorResponseSchema = lazyZodSchema(() => z
  .object({ error: SessionFollowErrorCodeV1Schema })
  .strict());
export type SessionFollowErrorResponse = z.infer<typeof SessionFollowErrorResponseSchema>;

/**
 * `GET /v2/sessions/:sessionId/follow`. The resource is singular for the
 * authenticated Account; `null` means it made no per-Session choice.
 *
 * `isSessionOwner` is the one extra fact an editor needs to render effective
 * state truthfully: an owner is permanently tracked and Important-eligible with
 * no stored row, so a client that read `follow` alone would show Follow off
 * while the Home still treated them as a tracked recipient. It discloses the
 * caller's own relationship to the Session, never another Account's identity.
 * `voiceInitialSnapshotPending` is a content-free settlement fact. It exposes
 * neither the persisted frontier nor acknowledgement authority; it only lets a
 * refreshed editor stop claiming that the initial current snapshot is pending.
 */
export const GetSessionFollowResponseSchema = lazyZodSchema(() => z
  .object({
    follow: AccountSessionFollowV1Schema.nullable(),
    isSessionOwner: z.boolean(),
    capabilities: AccountSessionFollowCapabilitiesV1Schema,
    voiceInitialSnapshotPending: z.boolean(),
  })
  .strict());
export type GetSessionFollowResponse = z.infer<typeof GetSessionFollowResponseSchema>;

/**
 * `PUT /v2/sessions/:sessionId/follow` sets `following = true` and atomically
 * replaces both preferences. Both fields are required because this is a
 * replacement, not a hidden read-modify-write, and `following` is never a
 * client-supplied field: `DELETE` is the explicit Unfollow.
 */
export const SetSessionFollowRequestSchema = lazyZodSchema(() => z
  .object({
    notificationLevel: SessionFollowNotificationLevelSchema,
    includeInVoice: z.boolean(),
  })
  .strict());
export type SetSessionFollowRequest = z.infer<typeof SetSessionFollowRequestSchema>;

export const SetSessionFollowResponseSchema = lazyZodSchema(() => z
  .object({
    changed: z.boolean(),
    follow: AccountSessionFollowV1Schema,
    voiceInitialSnapshotPending: z.boolean(),
  })
  .strict());
export type SetSessionFollowResponse = z.infer<typeof SetSessionFollowResponseSchema>;

/**
 * `DELETE /v2/sessions/:sessionId/follow` records an explicit Unfollow rather
 * than erasing the only evidence that suppresses future automatic following.
 */
export const RemoveSessionFollowResponseSchema = lazyZodSchema(() => z
  .object({ changed: z.boolean() })
  .strict());
export type RemoveSessionFollowResponse = z.infer<typeof RemoveSessionFollowResponseSchema>;

/** Exact-Home replacement of the authenticated Account's Include in Voice set. */
export const ReplaceSessionVoiceInclusionsRequestSchema = lazyZodSchema(() => z.object({
  sessionIds: z.array(z.string().trim().min(1)),
}).strict());
export type ReplaceSessionVoiceInclusionsRequest = z.infer<typeof ReplaceSessionVoiceInclusionsRequestSchema>;

export const ReplaceSessionVoiceInclusionsResponseSchema = lazyZodSchema(() => z.object({
  changed: z.boolean(),
  sessionIds: z.array(z.string().min(1)),
}).strict());
export type ReplaceSessionVoiceInclusionsResponse = z.infer<typeof ReplaceSessionVoiceInclusionsResponseSchema>;

/** `GET /v2/account/session-follow-preferences` takes no input. */
export const GetSessionAutoFollowPreferencesRequestSchema = lazyZodSchema(() => z.object({}).strict());
export type GetSessionAutoFollowPreferencesRequest = z.infer<
  typeof GetSessionAutoFollowPreferencesRequestSchema
>;

/**
 * `PUT /v2/account/session-follow-preferences` replaces all four Booleans and
 * returns their canonical saved value. It performs no historical backfill.
 */
export const SetSessionAutoFollowPreferencesRequestSchema = SessionAutoFollowPreferencesV1Schema;
export type SetSessionAutoFollowPreferencesRequest = z.infer<
  typeof SetSessionAutoFollowPreferencesRequestSchema
>;

export const SessionAutoFollowPreferencesResponseSchema = SessionAutoFollowPreferencesV1Schema;
export type SessionAutoFollowPreferencesResponse = z.infer<
  typeof SessionAutoFollowPreferencesResponseSchema
>;

export const SESSION_FOLLOW_HTTP_PATHS_V1 = Object.freeze({
  follow: '/v2/sessions/:sessionId/follow',
  preferences: '/v2/account/session-follow-preferences',
  voiceInclusions: '/v2/account/session-follow-voice-inclusions',
});
