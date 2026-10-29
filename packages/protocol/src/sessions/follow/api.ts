import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import {
  AccountSessionFollowCapabilitiesV1Schema,
  AccountSessionFollowV1Schema,
  AccountFollowRelationV1Schema,
  OtherAccountFollowV1Schema,
  SessionAutoFollowPreferencesV1Schema,
  SessionFollowNotificationLevelSchema,
  PersonalFollowOnceV1Schema,
  PersonalRunFollowOnceSetV1Schema,
  type PersonalRunFollowOnceV1,
  type PersonalFollowOnceV1,
  type SessionFollowNotificationLevel,
} from './accountFollow.js';
import { FollowPolicyV1Schema, type FollowPolicyV1 } from './sessionFollowPolicyV1.js';
import { FollowListPageResultFieldsV1 } from './sessionFollowListV1.js';
import type { FollowSourceRefV1 } from './sessionDeliveryMuteV1.js';

/**
 * The closed Follow failure vocabulary. Domain failures are mapped once in the
 * Follow route adapter and reused through the Action projections; there is no
 * second `session_follow_feature_unavailable` alias.
 */
export const SESSION_FOLLOW_ERROR_CODES_V1 = Object.freeze([
  'invalid_parameters',
  'feature_unavailable',
  'session_not_found',
  'source_not_found',
  'source_unavailable',
  'account_inactive',
  'session_archived',
] as const);
export type SessionFollowErrorCodeV1 = typeof SESSION_FOLLOW_ERROR_CODES_V1[number];

export const SessionFollowErrorCodeV1Schema = lazyZodSchema(() => z.enum(SESSION_FOLLOW_ERROR_CODES_V1));

export const SessionFollowErrorResponseSchema = lazyZodSchema(() => z.strictObject({ error: SessionFollowErrorCodeV1Schema }));
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
export const GetSessionFollowResponseSchema = lazyZodSchema(() => z.strictObject({
    follow: z.nullable(AccountSessionFollowV1Schema),
    isSessionOwner: z.boolean(),
    capabilities: AccountSessionFollowCapabilitiesV1Schema,
    voiceInitialSnapshotPending: z.boolean(),
  }));
export type GetSessionFollowResponse = z.infer<typeof GetSessionFollowResponseSchema>;
export const ListAccountSessionFollowsResponseV1Schema = lazyZodSchema(() => z.strictObject({ follows: z.array(AccountFollowRelationV1Schema), ...FollowListPageResultFieldsV1 }));
export const GetOtherAccountFollowResponseV1Schema = lazyZodSchema(() => z.strictObject({ follow: z.nullable(OtherAccountFollowV1Schema) }));
export const SetOtherAccountFollowResponseV1Schema = lazyZodSchema(() => z.strictObject({ changed: z.boolean(), follow: OtherAccountFollowV1Schema }));
export type ListAccountSessionFollowsResponseV1 = z.infer<typeof ListAccountSessionFollowsResponseV1Schema>;

/** A Run convenience edit preserves ongoing policy unless policy is supplied. */
export function hasOtherAccountFollowMutationV1(value: Readonly<{
  policy?: FollowPolicyV1; once?: readonly PersonalRunFollowOnceV1[] | null; clearOnceDeliveries?: true;
}>): boolean {
  return value.policy !== undefined || value.once !== undefined || value.clearOnceDeliveries === true;
}
export function isOtherAccountFollowMutationSupportedV1(source: FollowSourceRefV1, value: Readonly<{
  policy?: FollowPolicyV1; once?: readonly PersonalRunFollowOnceV1[] | null; clearOnceDeliveries?: true;
}>): boolean {
  if (source.kind === 'discussion') return value.policy !== undefined && value.once === undefined && value.clearOnceDeliveries === undefined;
  if (source.kind === 'execution_run') return hasOtherAccountFollowMutationV1(value);
  return source.kind === 'workflow_run' && hasOtherAccountFollowMutationV1(value)
    && !value.once?.some(once => once.kind === 'output_ready');
}
export const SetOtherAccountFollowRequestV1Schema = lazyZodSchema(() => z.strictObject({
  policy: z.optional(FollowPolicyV1Schema), once: z.optional(z.nullable(PersonalRunFollowOnceSetV1Schema)),
  clearOnceDeliveries: z.optional(z.literal(true)),
}).check(z.refine(hasOtherAccountFollowMutationV1, { message: 'A persistent policy or one-shot mutation is required' })));
export type SetOtherAccountFollowRequestV1 = z.infer<typeof SetOtherAccountFollowRequestV1Schema>;

/**
 * A policy edit establishes persistent Follow. A one-shot-only edit changes
 * only convenience custody, preserving persistent interest, suppression,
 * Voice and read progress. Legacy notificationLevel/includeInVoice remain an
 * admitted replacement pair at this boundary; `following` is never input.
 */
/** Shared mutation admission for the HTTP and executable Action schemas. */
export function hasAccountSessionFollowMutationV1(value: Readonly<{
  notificationLevel?: SessionFollowNotificationLevel;
  includeInVoice?: boolean;
  policy?: FollowPolicyV1;
  once?: PersonalFollowOnceV1 | null;
}>): boolean {
  if (value.notificationLevel !== undefined) return value.includeInVoice !== undefined && value.policy === undefined;
  if (value.policy !== undefined) return true;
  return value.once !== undefined && value.includeInVoice === undefined;
}

export const SetSessionFollowRequestSchema = lazyZodSchema(() => z.strictObject({
    notificationLevel: z.optional(SessionFollowNotificationLevelSchema),
    includeInVoice: z.optional(z.boolean()),
    policy: z.optional(FollowPolicyV1Schema),
    once: z.optional(z.nullable(PersonalFollowOnceV1Schema)),
  }).check(z.refine(hasAccountSessionFollowMutationV1,
    { message: 'A persistent policy or one-shot mutation is required' })));
export type SetSessionFollowRequest = z.infer<typeof SetSessionFollowRequestSchema>;

export const SetSessionFollowResponseSchema = lazyZodSchema(() => z.strictObject({
    changed: z.boolean(),
    follow: AccountSessionFollowV1Schema,
    voiceInitialSnapshotPending: z.boolean(),
  }));
export type SetSessionFollowResponse = z.infer<typeof SetSessionFollowResponseSchema>;

/**
 * `DELETE /v2/sessions/:sessionId/follow` records an explicit Unfollow rather
 * than erasing the only evidence that suppresses future automatic following.
 */
export const RemoveSessionFollowResponseSchema = lazyZodSchema(() => z.strictObject({ changed: z.boolean() }));
export type RemoveSessionFollowResponse = z.infer<typeof RemoveSessionFollowResponseSchema>;

/** Exact-Home replacement of the authenticated Account's Include in Voice set. */
export const ReplaceSessionVoiceInclusionsRequestSchema = lazyZodSchema(() => z.strictObject({
  sessionIds: z.array(z.string().check(z.trim(), z.minLength(1))),
}));
export type ReplaceSessionVoiceInclusionsRequest = z.infer<typeof ReplaceSessionVoiceInclusionsRequestSchema>;

export const ReplaceSessionVoiceInclusionsResponseSchema = lazyZodSchema(() => z.strictObject({
  changed: z.boolean(),
  sessionIds: z.array(z.string().check(z.minLength(1))),
}));
export type ReplaceSessionVoiceInclusionsResponse = z.infer<typeof ReplaceSessionVoiceInclusionsResponseSchema>;

/** `GET /v2/account/session-follow-preferences` takes no input. */
export const GetSessionAutoFollowPreferencesRequestSchema = lazyZodSchema(() => z.strictObject({}));
export type GetSessionAutoFollowPreferencesRequest = z.infer<
  typeof GetSessionAutoFollowPreferencesRequestSchema
>;

/**
 * Replaces defaultRules (legacy top-level booleans remain readable) and patches
 * supplied creation policies. Omitted policies preserve saved choices;
 * existing relations are unchanged.
 */
export const SetSessionAutoFollowPreferencesRequestSchema = lazyZodSchema(() => SessionAutoFollowPreferencesV1Schema);
export type SetSessionAutoFollowPreferencesRequest = z.input<
  typeof SetSessionAutoFollowPreferencesRequestSchema
>;

export const SessionAutoFollowPreferencesResponseSchema = lazyZodSchema(() => SessionAutoFollowPreferencesV1Schema);
export type SessionAutoFollowPreferencesResponse = z.infer<
  typeof SessionAutoFollowPreferencesResponseSchema
>;

export const SESSION_FOLLOW_HTTP_PATHS_V1 = Object.freeze({
  follow: '/v2/sessions/:sessionId/follow',
  otherSource: '/v2/account/follows/sources',
  preferences: '/v2/account/session-follow-preferences',
  voiceInclusions: '/v2/account/session-follow-voice-inclusions',
});
