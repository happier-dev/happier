import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { PUSH_NOTIFICATION_BUNDLED_SOUND_FILES } from '../../push/pushNotificationActions.js';
import { SessionAwarenessPresentationStateV1Schema } from '../../sessions/awareness/presentationV1.js';

export const HAPPIER_FOCUS_LIVE_ACTIVITY_NAME = 'HappierFocusLiveActivity';

export const LIVE_ACTIVITY_CONTENT_STATE_MAX_BYTES = 4096;
export const LIVE_ACTIVITY_ALERT_TITLE_MAX_LENGTH = 120;
export const LIVE_ACTIVITY_ALERT_BODY_MAX_LENGTH = 240;

export const LiveActivityRemoteTransportModeSchema = lazyZodSchema(() => z.enum([
  'hosted_happier_relay',
  'direct_apns',
  'background_wake_best_effort',
]));
export type LiveActivityRemoteTransportMode = z.infer<typeof LiveActivityRemoteTransportModeSchema>;

export const LiveActivityRemoteTargetKindSchema = lazyZodSchema(() => z.enum([
  'expo_push_token',
  'activitykit_update_token',
  'activitykit_push_to_start_token',
]));
export type LiveActivityRemoteTargetKind = z.infer<typeof LiveActivityRemoteTargetKindSchema>;

export const LiveActivityRemoteUpdateEventSchema = lazyZodSchema(() => z.enum(['update', 'end']));
export type LiveActivityRemoteUpdateEvent = z.infer<typeof LiveActivityRemoteUpdateEventSchema>;

export const HappierFocusLiveActivityAttentionStateSchema = SessionAwarenessPresentationStateV1Schema;
export type HappierFocusLiveActivityAttentionState =
  z.infer<typeof HappierFocusLiveActivityAttentionStateSchema>;

function countJsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function addPayloadSizeIssue(
  value: unknown,
  ctx: z.core.$RefinementCtx,
): void {
  if (countJsonBytes(value) <= LIVE_ACTIVITY_CONTENT_STATE_MAX_BYTES) return;

  ctx.addIssue({
    code: "custom",
    message: 'Live Activity content state exceeds the ActivityKit payload budget',
  });
}

const TimestampMsSchema = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative()));

export const HappierFocusLiveActivityContentStateV1Schema = lazyZodSchema(() => z.strictObject({
    version: z.literal(1),
    generatedAt: TimestampMsSchema,
    staleAt: TimestampMsSchema,
    sessionId: z.string().check(z.trim(), z.minLength(1)),
    title: z.string(),
    subtitle: z.nullable(z.string()),
    previewText: z.nullable(z.string()),
    statusText: z.nullable(z.string()),
    attentionState: HappierFocusLiveActivityAttentionStateSchema,
    defaultTarget: z.string().check(z.trim(), z.minLength(1)),
    sessionTarget: z.string().check(z.trim(), z.minLength(1)),
    overflowCount: z.number().check(z.int(), z.nonnegative()),
    totalAttentionCount: z.number().check(z.int(), z.nonnegative()),
    allowActionButtons: z.boolean(),
    labels: z.strictObject({
      title: z.string(),
      openLabel: z.string(),
      inboxLabel: z.string(),
      attentionLabel: z.string(),
    }),
  }).check(z.superRefine(addPayloadSizeIssue)));
export type HappierFocusLiveActivityContentStateV1 =
  z.infer<typeof HappierFocusLiveActivityContentStateV1Schema>;

export const LiveActivityRemoteUpdateActivityKeySchema = lazyZodSchema(() => z.strictObject({
    serverId: z.string().check(z.trim(), z.minLength(1)),
    sessionId: z.string().check(z.trim(), z.minLength(1)),
    activityName: z.literal(HAPPIER_FOCUS_LIVE_ACTIVITY_NAME),
  }));
export type LiveActivityRemoteUpdateActivityKey =
  z.infer<typeof LiveActivityRemoteUpdateActivityKeySchema>;

const LiveActivityRemoteUpdateRequestBaseV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    requestId: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
    createdAt: TimestampMsSchema,
    transportMode: LiveActivityRemoteTransportModeSchema,
    activityKey: LiveActivityRemoteUpdateActivityKeySchema,
    snapshotFingerprint: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
  }));

const LiveActivityInterruptiveAlertV1Schema = lazyZodSchema(() => z.strictObject({
    title: z.string().check(z.trim(), z.minLength(1), z.maxLength(LIVE_ACTIVITY_ALERT_TITLE_MAX_LENGTH)),
    body: z.string().check(z.trim(), z.minLength(1), z.maxLength(LIVE_ACTIVITY_ALERT_BODY_MAX_LENGTH)),
    sound: z.optional(z.enum([
      'default',
      ...Object.values(PUSH_NOTIFICATION_BUNDLED_SOUND_FILES).map(sound => sound.expoSoundName),
    ])),
  }));
export type LiveActivityInterruptiveAlertV1 =
  z.infer<typeof LiveActivityInterruptiveAlertV1Schema>;

const LiveActivityRemoteUpdateRequestUpdateV1Schema =
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(LiveActivityRemoteUpdateRequestBaseV1Schema, {
    event: z.literal('update'),
    contentState: HappierFocusLiveActivityContentStateV1Schema,
    interruptiveAlert: z.optional(LiveActivityInterruptiveAlertV1Schema),
  })));

const LiveActivityRemoteUpdateRequestEndV1Schema =
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(LiveActivityRemoteUpdateRequestBaseV1Schema, {
    event: z.literal('end'),
    contentState: z.optional(HappierFocusLiveActivityContentStateV1Schema),
    dismissalAt: z.optional(TimestampMsSchema),
  })));

export const LiveActivityRemoteUpdateRequestV1Schema = lazyZodSchema(() => z
  .discriminatedUnion('event', [
    LiveActivityRemoteUpdateRequestUpdateV1Schema,
    LiveActivityRemoteUpdateRequestEndV1Schema,
  ]).check(z.superRefine((request, ctx) => {
    if (!request.contentState) return;
    if (request.contentState.sessionId !== request.activityKey.sessionId) {
      ctx.addIssue({
        code: "custom",
        path: ['contentState', 'sessionId'],
        message: 'Live Activity content state session must match the activity key',
      });
    }

    if (request.contentState.staleAt <= request.createdAt) {
      ctx.addIssue({
        code: "custom",
        path: ['contentState', 'staleAt'],
        message: 'Live Activity content state must remain fresh after request creation',
      });
    }
  })));
export type LiveActivityRemoteUpdateRequestV1 =
  z.infer<typeof LiveActivityRemoteUpdateRequestV1Schema>;
