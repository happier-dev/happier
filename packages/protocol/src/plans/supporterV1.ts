import { z } from '../zodRuntimePolicy.js';

import { lazyZodSchema } from '../lazyZodSchema.js';

/**
 * A supporter code: 128 random bits as 32 lowercase hex characters.
 *
 * It is the bearer that carries a purchase made from a server Happier Cloud cannot see
 * (Polar `reference_id`, RevenueCat `appUserID`). It never appears in a URL or in
 * `account.plan.get`; requests carry it in the body only.
 */
export const SupporterCodeV1Schema = lazyZodSchema(() => z.string().check(z.regex(/^[0-9a-f]{32}$/)));

/**
 * How the supporter record was earned. `plan` = a paid plan, which includes the Supporter pack.
 */
export const SupporterKindV1Schema = lazyZodSchema(() => z.enum([
  'supporter_once',
  'supporter_monthly',
  'plan',
  'github_sponsor',
]));
export type SupporterKindV1 = z.infer<typeof SupporterKindV1Schema>;

/** Public facts about a supporter record. `number` null = pending (code minted, nothing paid yet). */
export const SupporterRecordFactsV1Schema = lazyZodSchema(() => z.object({
  number: z.nullable(z.int().check(z.minimum(1))),
  kind: z.nullable(SupporterKindV1Schema),
  grantedAt: z.nullable(z.int()),
  recurringActive: z.boolean(),
  revokedAt: z.nullable(z.int()),
}));
export type SupporterRecordFactsV1 = z.infer<typeof SupporterRecordFactsV1Schema>;

// Absent on servers that predate the Cloud supporter profile or do not own it.
const supporterProfileReadShape = () => ({
  publicName: z.optional(z.nullable(z.string())),
  publicLink: z.optional(z.nullable(z.string())),
  githubLogin: z.optional(z.nullable(z.string())),
});

/** `POST /v1/supporter/lookup` (Happier Cloud, public, code in the body). */
export const SupporterLookupRequestV1Schema = lazyZodSchema(() => z.strictObject({ code: SupporterCodeV1Schema }));
export const SupporterLookupResponseV1Schema = lazyZodSchema(() => z.extend(SupporterRecordFactsV1Schema, supporterProfileReadShape()));

/** `GET /v1/account/supporter`: the session's own record, including its code. Not an Action. */
export const AccountSupporterResponseV1Schema = lazyZodSchema(() => z.object({
  record: z.nullable(z.extend(SupporterRecordFactsV1Schema, { code: SupporterCodeV1Schema, ...supporterProfileReadShape() })),
}));
export type AccountSupporterResponseV1 = z.infer<typeof AccountSupporterResponseV1Schema>;

/**
 * `PUT /v1/account/supporter` (self-hosted only; refused where billing is configured).
 *
 * The app writes a freshly minted code (facts omitted = pending), then the facts it read from
 * Happier Cloud's lookup for that code.
 */
export const AccountSupporterPutRequestV1Schema = lazyZodSchema(() => z.strictObject({
  code: SupporterCodeV1Schema,
  facts: z.optional(SupporterRecordFactsV1Schema),
}));
export type AccountSupporterPutRequestV1 = z.infer<typeof AccountSupporterPutRequestV1Schema>;
