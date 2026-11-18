import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

export const AttentionRemindAtV1Schema = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative()));
export type AttentionReminderV1 = Readonly<{ state: 'scheduled' | 'due'; remindAt: number }>;

export function resolveAttentionReminderV1(remindAt: number | undefined, nowMs: number): AttentionReminderV1 | null {
  return remindAt === undefined ? null : { state: remindAt > nowMs ? 'scheduled' : 'due', remindAt };
}
