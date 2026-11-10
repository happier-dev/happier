import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { QualifiedConnectedAccountGroupRefSchema } from '../../connect/qualifiedConnectedAccountProjectionsV4.js';

/** Advice only; targets do not participate in quota selection or spend admission. */
export const UsagePacingTargetsV1Schema = lazyZodSchema(() => z.array(z.strictObject({
  id: z.string().check(z.trim(), z.minLength(1)),
  scope: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('personal') }),
    z.strictObject({ kind: z.literal('pool'), group: QualifiedConnectedAccountGroupRefSchema }),
  ]),
  meterId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  utilizationFraction: z.number().check(z.minimum(0)),
})).check(z.superRefine((targets, ctx) => {
  const ids = new Set<string>();
  targets.forEach((target, index) => {
    if (ids.has(target.id)) ctx.addIssue({ code: 'custom', path: [index, 'id'], message: 'Duplicate target identity' });
    ids.add(target.id);
  });
})));
export type UsagePacingTargetsV1 = z.infer<typeof UsagePacingTargetsV1Schema>;
export const UsageQuotaNotificationKindV1Schema = lazyZodSchema(() => z.enum(['pace', 'depletion', 'almost_out', 'reset', 'ending', 'unused', 'credit_expiry']));
export type UsageQuotaNotificationKindV1 = z.infer<typeof UsageQuotaNotificationKindV1Schema>;

/** Null means no opt-in threshold; there are no guessed numeric alert defaults. */
export const UsageQuotaNotificationsV1Schema = lazyZodSchema(() => z.strictObject({
  v: z._default(z.literal(1), 1),
  pace: z._default(z.boolean(), false),
  depletion: z._default(z.boolean(), false),
  reset: z._default(z.boolean(), false),
  unused: z._default(z.boolean(), false),
  almostOutRemainingFraction: z._default(z.nullable(z.number().check(z.minimum(0), z.maximum(1))), null),
  endingBeforeMs: z._default(z.nullable(z.number().check(z.int(), z.nonnegative())), null),
  creditExpiryBeforeMs: z._default(z.nullable(z.number().check(z.int(), z.nonnegative())), null),
}));
export type UsageQuotaNotificationsV1 = z.infer<typeof UsageQuotaNotificationsV1Schema>;
export const DEFAULT_USAGE_QUOTA_NOTIFICATIONS_V1 = UsageQuotaNotificationsV1Schema.parse({});
export function isUsageQuotaNotificationEnabled(preferences: UsageQuotaNotificationsV1, kind: UsageQuotaNotificationKindV1): boolean {
  if (kind === 'almost_out') return preferences.almostOutRemainingFraction !== null;
  if (kind === 'ending') return preferences.endingBeforeMs !== null;
  if (kind === 'credit_expiry') return preferences.creditExpiryBeforeMs !== null;
  return preferences[kind] === true;
}
