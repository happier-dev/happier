import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';

export const AutomationOnceScheduleSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('once'),
  scheduledAt: z.number().check(z.int(), z.nonnegative(), z.refine(value => Number.isFinite(new Date(value).getTime()), 'Invalid schedule instant')),
}));

/** Persisted schedule value, shared by trigger definitions and deliberate setup preferences. */
export const AutomationScheduleSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  AutomationOnceScheduleSchema,
  z.strictObject({ kind: z.literal('cron'), scheduleExpr: z.string(), everyMs: z.null(), timezone: z.nullable(z.string()) }),
  z.strictObject({ kind: z.literal('interval'), scheduleExpr: z.null(), everyMs: z.number().check(z.int()), timezone: z.nullable(z.string()) }),
]));

/** Read-only draft evaluation through the Automation query owner; never saves a trigger. */
export const AutomationSchedulePreviewRequestSchema = lazyZodSchema(() => z.strictObject({
  proposedSchedule: AutomationScheduleSchema,
}));
export const AutomationSchedulePreviewResultSchema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ready'), nextRunAt: z.number() }),
  z.strictObject({ status: z.literal('invalid_schedule') }),
]));
export type AutomationSchedulePreviewResult = z.infer<typeof AutomationSchedulePreviewResultSchema>;
