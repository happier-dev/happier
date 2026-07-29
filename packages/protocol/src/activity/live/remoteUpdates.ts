import { z } from 'zod';

import { PUSH_NOTIFICATION_BUNDLED_SOUND_FILES } from '../../push/pushNotificationActions.js';

export const HAPPIER_FOCUS_LIVE_ACTIVITY_NAME = 'HappierFocusLiveActivity';

export const LIVE_ACTIVITY_CONTENT_STATE_MAX_BYTES = 4096;

export const LiveActivityRemoteTransportModeSchema = z.enum([
  'hosted_happier_relay',
  'direct_apns',
  'background_wake_best_effort',
]);
export type LiveActivityRemoteTransportMode = z.infer<typeof LiveActivityRemoteTransportModeSchema>;

export const LiveActivityRemoteTargetKindSchema = z.enum([
  'expo_push_token',
  'activitykit_update_token',
  'activitykit_push_to_start_token',
]);
export type LiveActivityRemoteTargetKind = z.infer<typeof LiveActivityRemoteTargetKindSchema>;

export const LiveActivityRemoteUpdateEventSchema = z.enum(['update', 'end']);
export type LiveActivityRemoteUpdateEvent = z.infer<typeof LiveActivityRemoteUpdateEventSchema>;

export const HappierFocusLiveActivityAttentionStateSchema = z.enum([
  'quiet',
  'unread',
  'pending',
  'thinking',
  'permission_required',
  'action_required',
]);
export type HappierFocusLiveActivityAttentionState =
  z.infer<typeof HappierFocusLiveActivityAttentionStateSchema>;

function countJsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function addPayloadSizeIssue(
  value: unknown,
  ctx: z.RefinementCtx,
): void {
  if (countJsonBytes(value) <= LIVE_ACTIVITY_CONTENT_STATE_MAX_BYTES) return;

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'Live Activity content state exceeds the ActivityKit payload budget',
  });
}

const TimestampMsSchema = z.number().int().nonnegative();

export const HappierFocusLiveActivityContentStateV1Schema = z
  .object({
    version: z.literal(1),
    generatedAt: TimestampMsSchema,
    staleAt: TimestampMsSchema,
    sessionId: z.string().trim().min(1),
    title: z.string(),
    subtitle: z.string().nullable(),
    previewText: z.string().nullable(),
    statusText: z.string().nullable(),
    attentionState: HappierFocusLiveActivityAttentionStateSchema,
    defaultTarget: z.string().trim().min(1),
    sessionTarget: z.string().trim().min(1),
    overflowCount: z.number().int().nonnegative(),
    totalAttentionCount: z.number().int().nonnegative(),
    allowActionButtons: z.boolean(),
    labels: z.object({
      title: z.string(),
      openLabel: z.string(),
      inboxLabel: z.string(),
      attentionLabel: z.string(),
    }).strict(),
  })
  .strict()
  .superRefine(addPayloadSizeIssue);
export type HappierFocusLiveActivityContentStateV1 =
  z.infer<typeof HappierFocusLiveActivityContentStateV1Schema>;

export const LiveActivityRemoteUpdateActivityKeySchema = z
  .object({
    serverId: z.string().trim().min(1),
    sessionId: z.string().trim().min(1),
    activityName: z.literal(HAPPIER_FOCUS_LIVE_ACTIVITY_NAME),
  })
  .strict();
export type LiveActivityRemoteUpdateActivityKey =
  z.infer<typeof LiveActivityRemoteUpdateActivityKeySchema>;

const LiveActivityRemoteUpdateRequestBaseV1Schema = z
  .object({
    v: z.literal(1),
    requestId: z.string().trim().min(1).max(128),
    createdAt: TimestampMsSchema,
    transportMode: LiveActivityRemoteTransportModeSchema,
    activityKey: LiveActivityRemoteUpdateActivityKeySchema,
    snapshotFingerprint: z.string().trim().min(1).max(512),
  })
  .strict();

const LiveActivityInterruptiveAlertV1Schema = z
  .object({
    title: z.string().trim().min(1).max(120),
    body: z.string().trim().min(1).max(240),
    sound: z.enum([
      'default',
      PUSH_NOTIFICATION_BUNDLED_SOUND_FILES.soft.expoSoundName,
      PUSH_NOTIFICATION_BUNDLED_SOUND_FILES.urgent.expoSoundName,
    ]).optional(),
  })
  .strict();
export type LiveActivityInterruptiveAlertV1 =
  z.infer<typeof LiveActivityInterruptiveAlertV1Schema>;

const LiveActivityRemoteUpdateRequestUpdateV1Schema =
  LiveActivityRemoteUpdateRequestBaseV1Schema.extend({
    event: z.literal('update'),
    contentState: HappierFocusLiveActivityContentStateV1Schema,
    interruptiveAlert: LiveActivityInterruptiveAlertV1Schema.optional(),
  }).strict();

const LiveActivityRemoteUpdateRequestEndV1Schema =
  LiveActivityRemoteUpdateRequestBaseV1Schema.extend({
    event: z.literal('end'),
    contentState: HappierFocusLiveActivityContentStateV1Schema.optional(),
    dismissalAt: TimestampMsSchema.optional(),
  }).strict();

export const LiveActivityRemoteUpdateRequestV1Schema = z
  .discriminatedUnion('event', [
    LiveActivityRemoteUpdateRequestUpdateV1Schema,
    LiveActivityRemoteUpdateRequestEndV1Schema,
  ])
  .superRefine((request, ctx) => {
    if (!request.contentState) return;
    if (request.contentState.sessionId !== request.activityKey.sessionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contentState', 'sessionId'],
        message: 'Live Activity content state session must match the activity key',
      });
    }

    if (request.contentState.staleAt <= request.createdAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contentState', 'staleAt'],
        message: 'Live Activity content state must remain fresh after request creation',
      });
    }
  });
export type LiveActivityRemoteUpdateRequestV1 =
  z.infer<typeof LiveActivityRemoteUpdateRequestV1Schema>;
