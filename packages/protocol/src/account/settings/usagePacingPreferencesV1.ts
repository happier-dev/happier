import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { QualifiedConnectedAccountGroupRefSchema } from '../../connect/qualifiedConnectedAccountProjectionsV4.js';

/** Advice only; targets do not participate in quota selection or spend admission. */
export const UsagePacingTargetsV1Schema = lazyZodSchema(() => z.array(z.object({
  id: z.string().trim().min(1),
  scope: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('personal') }).strict(),
    z.object({ kind: z.literal('pool'), group: QualifiedConnectedAccountGroupRefSchema }).strict(),
  ]),
  meterId: z.string().trim().min(1).optional(),
  utilizationFraction: z.number().finite().min(0),
}).strict()).superRefine((targets, ctx) => {
  const ids = new Set<string>();
  targets.forEach((target, index) => {
    if (ids.has(target.id)) ctx.addIssue({ code: 'custom', path: [index, 'id'], message: 'Duplicate target identity' });
    ids.add(target.id);
  });
}));
export type UsagePacingTargetsV1 = z.infer<typeof UsagePacingTargetsV1Schema>;
export const UsageQuotaNotificationKindV1Schema = lazyZodSchema(() => z.enum(['pace', 'depletion', 'almost_out', 'reset', 'ending', 'unused', 'credit_expiry']));
export type UsageQuotaNotificationKindV1 = z.infer<typeof UsageQuotaNotificationKindV1Schema>;

/** Null means no opt-in threshold; there are no guessed numeric alert defaults. */
export const UsageQuotaNotificationsV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1).default(1),
  pace: z.boolean().default(false),
  depletion: z.boolean().default(false),
  reset: z.boolean().default(false),
  unused: z.boolean().default(false),
  almostOutRemainingFraction: z.number().finite().min(0).max(1).nullable().default(null),
  endingBeforeMs: z.number().int().nonnegative().nullable().default(null),
  creditExpiryBeforeMs: z.number().int().nonnegative().nullable().default(null),
}).strict());
export type UsageQuotaNotificationsV1 = z.infer<typeof UsageQuotaNotificationsV1Schema>;
export const DEFAULT_USAGE_QUOTA_NOTIFICATIONS_V1 = UsageQuotaNotificationsV1Schema.parse({});
export function isUsageQuotaNotificationEnabled(preferences: UsageQuotaNotificationsV1, kind: UsageQuotaNotificationKindV1): boolean {
  if (kind === 'almost_out') return preferences.almostOutRemainingFraction !== null;
  if (kind === 'ending') return preferences.endingBeforeMs !== null;
  if (kind === 'credit_expiry') return preferences.creditExpiryBeforeMs !== null;
  return preferences[kind] === true;
}
