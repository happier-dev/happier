import { z } from 'zod';

import { lazySchema } from '../lazySchema.js';

/**
 * A supporter code: 128 random bits as 32 lowercase hex characters.
 *
 * It is the bearer that carries a purchase made from a server Happier Cloud cannot see
 * (Polar `reference_id`, RevenueCat `appUserID`). It never appears in a URL or in
 * `account.plan.get`; requests carry it in the body only.
 */
export const SupporterCodeV1Schema = lazySchema(() => z.string().regex(/^[0-9a-f]{32}$/));

/**
 * How the supporter record was earned. `plan` = a paid plan, which includes the Supporter pack.
 */
export const SupporterKindV1Schema = lazySchema(() => z.enum([
  'supporter_once',
  'supporter_monthly',
  'plan',
  'github_sponsor',
]));
export type SupporterKindV1 = z.infer<typeof SupporterKindV1Schema>;

/** Public facts about a supporter record. `number` null = pending (code minted, nothing paid yet). */
export const SupporterRecordFactsV1Schema = lazySchema(() => z.object({
  number: z.number().int().min(1).nullable(),
  kind: SupporterKindV1Schema.nullable(),
  grantedAt: z.number().int().nullable(),
  recurringActive: z.boolean(),
  /** Older lookup and self-hosted clients can omit the current recurring purchase date. */
  recurringSince: z.number().int().nullable().optional(),
  revokedAt: z.number().int().nullable(),
}));
export type SupporterRecordFactsV1 = z.infer<typeof SupporterRecordFactsV1Schema>;

/** Completed UTC calendar months, with the anniversary clamped in shorter months. */
export function countSupporterMonths(recurringSinceMs: number, nowMs: number): number {
  if (nowMs <= recurringSinceMs) return 0;
  const start = new Date(recurringSinceMs);
  const now = new Date(nowMs);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const months = (year - start.getUTCFullYear()) * 12 + month - start.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(start.getUTCDate(), lastDay);
  const anniversary = Date.UTC(year, month, day, start.getUTCHours(), start.getUTCMinutes(),
    start.getUTCSeconds(), start.getUTCMilliseconds());
  return Math.max(0, months - Number(nowMs < anniversary));
}

/** `POST /v1/supporter/lookup` (Happier Cloud, public, code in the body). */
export const SupporterLookupRequestV1Schema = lazySchema(() => z.object({ code: SupporterCodeV1Schema }));
export const SupporterLookupResponseV1Schema = SupporterRecordFactsV1Schema;

/** `GET /v1/account/supporter`: the session's own record, including its code. Not an Action. */
export const AccountSupporterResponseV1Schema = lazySchema(() => z.object({
  record: SupporterRecordFactsV1Schema.extend({ code: SupporterCodeV1Schema }).nullable(),
}));
export type AccountSupporterResponseV1 = z.infer<typeof AccountSupporterResponseV1Schema>;

/**
 * `PUT /v1/account/supporter` (self-hosted only; refused where billing is configured).
 *
 * The app writes a freshly minted code (facts omitted = pending), then the facts it read from
 * Happier Cloud's lookup for that code.
 */
export const AccountSupporterPutRequestV1Schema = lazySchema(() => z.object({
  code: SupporterCodeV1Schema,
  facts: SupporterRecordFactsV1Schema.optional(),
}));
export type AccountSupporterPutRequestV1 = z.infer<typeof AccountSupporterPutRequestV1Schema>;
