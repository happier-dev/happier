import { z } from 'zod/mini';
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
