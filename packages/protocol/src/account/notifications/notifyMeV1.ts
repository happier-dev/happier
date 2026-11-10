import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

export const NotificationsNotifyMeOpenV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('session'), sessionId: z.string().check(z.minLength(1)) }),
  z.strictObject({ kind: z.literal('workflow_run'), runId: z.string().check(z.minLength(1)) }),
]));

export const NotificationsNotifyMeInputV1Schema = lazyZodSchema(() => z.strictObject({
  message: z.string(),
  title: z.optional(z.string()),
  open: z.optional(NotificationsNotifyMeOpenV1Schema),
  channels: z.optional(z.array(z.string().check(z.minLength(1)))),
}).check(z.superRefine((value, context) => {
  if (value.channels && new Set(value.channels).size !== value.channels.length) {
    context.addIssue({ code: 'custom', path: ['channels'], message: 'Channel ids must be unique' });
  }
})));

export const NotificationsNotifyMeResultV1Schema = lazyZodSchema(() => z.strictObject({
  attemptedChannels: z.number().check(z.int(), z.nonnegative()),
  deliveredChannels: z.number().check(z.int(), z.nonnegative()),
}));

export type NotificationsNotifyMeInputV1 = z.infer<typeof NotificationsNotifyMeInputV1Schema>;
export type NotificationsNotifyMeResultV1 = z.infer<typeof NotificationsNotifyMeResultV1Schema>;
