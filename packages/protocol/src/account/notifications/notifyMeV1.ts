import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

export const NotificationsNotifyMeOpenV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session'), sessionId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('workflow_run'), runId: z.string().min(1) }).strict(),
]));

export const NotificationsNotifyMeInputV1Schema = lazyZodSchema(() => z.object({
  message: z.string(),
  title: z.string().optional(),
  open: NotificationsNotifyMeOpenV1Schema.optional(),
  channels: z.array(z.string().min(1)).optional(),
}).strict().superRefine((value, context) => {
  if (value.channels && new Set(value.channels).size !== value.channels.length) {
    context.addIssue({ code: 'custom', path: ['channels'], message: 'Channel ids must be unique' });
  }
}));

export const NotificationsNotifyMeResultV1Schema = lazyZodSchema(() => z.object({
  attemptedChannels: z.number().int().nonnegative(),
  deliveredChannels: z.number().int().nonnegative(),
}).strict());

export type NotificationsNotifyMeInputV1 = z.infer<typeof NotificationsNotifyMeInputV1Schema>;
export type NotificationsNotifyMeResultV1 = z.infer<typeof NotificationsNotifyMeResultV1Schema>;
