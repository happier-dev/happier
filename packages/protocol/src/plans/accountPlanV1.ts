import { z } from '../zodRuntimePolicy.js';

import { lazyZodSchema } from '../lazyZodSchema.js';

/**
 * Per-Account limits. `null` means no limit (or keep forever).
 *
 * Open object: an older reader drops limit fields it does not know, so a later limit is a new
 * field defaulting to `null` in the base tier.
 */
export const AccountLimitsV1Schema = lazyZodSchema(() => z.object({
  sessionRetentionDays: z.nullable(z.int().check(z.minimum(1))),
  subagentRetentionDays: z.nullable(z.int().check(z.minimum(1))),
  /** 0.3 only; always null on 0.2, whose server cannot separate tool outputs from E2EE rows. */
  toolOutputRetentionDays: z.nullable(z.int().check(z.minimum(1))),
  pinnedSessions: z.nullable(z.int().check(z.minimum(0))),
  /** 0.3 only; always null on 0.2. */
  artifactStorageBytes: z.nullable(z.int().check(z.minimum(0))),
}));
export type AccountLimitsV1 = z.infer<typeof AccountLimitsV1Schema>;

/**
 * Shapes shared by the operator config (closed, so typos surface) and the read response (open, so
 * an older client drops fields it does not know).
 */
const planPriceShape = () => ({
  interval: z.enum(['month', 'year']),
  amountMinor: z.int().check(z.minimum(0)),
  currency: z.string().check(z.minLength(1)),
  /** Hosted checkout link (web, desktop). Public value. */
  checkoutUrl: z.optional(z.url()),
  storeProductId: z.optional(z.string().check(z.minLength(1))),
  storeOfferingId: z.optional(z.string().check(z.minLength(1))),
});
const supporterOfferShape = () => ({
  suggestedMonthlyMinor: z.int().check(z.minimum(0)),
  minimumMinor: z.int().check(z.minimum(0)),
  currency: z.string().check(z.minLength(1)),
  /** RevenueCat offering used by the iOS and Android purchase sheet. */
  storeOfferingId: z.optional(z.string().check(z.minLength(1))),
  /**
   * Hosted pay-what-you-want checkout links (public values). The app appends the supporter
   * `reference_id` and the chosen amount. Null where no link is configured.
   */
  checkoutUrls: z.optional(z.object({
    monthly: z.nullable(z.url()),
    once: z.nullable(z.url()),
  })),
});
const supporterPresetsShape = () => ({
  monthly: z.array(z.int().check(z.minimum(0))),
  once: z.array(z.int().check(z.minimum(0))),
});

/** One price point. Provider fields are public values (plan 03 seam). */
export const PlanPriceV1Schema = lazyZodSchema(() => z.object(planPriceShape()));
export type PlanPriceV1 = z.infer<typeof PlanPriceV1Schema>;

export const PlanDefinitionV1Schema = lazyZodSchema(() => z.object({
  id: z.string().check(z.minLength(1)),
  name: z.string().check(z.minLength(1)),
  limits: AccountLimitsV1Schema,
  prices: z.array(PlanPriceV1Schema),
}));
export type PlanDefinitionV1 = z.infer<typeof PlanDefinitionV1Schema>;

export const SupporterOfferV1Schema = lazyZodSchema(() => z.object({
  ...supporterOfferShape(),
  presets: z.object(supporterPresetsShape()),
}));
export type SupporterOfferV1 = z.infer<typeof SupporterOfferV1Schema>;

const StrictPlanPriceV1Schema = lazyZodSchema(() => z.strictObject(planPriceShape()));

/**
 * The value of `HAPPIER_PLANS__CONFIG`. Closed: an operator's typo must surface.
 *
 * `plans` is ordered from the lowest to the highest plan; billing reconciliation reads that order
 * when two live sources disagree ("highest live plan wins").
 */
export const PlansConfigV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  graceDays: z.int().check(z.minimum(0)),
  plans: z.array(z.strictObject({
    id: z.string().check(z.minLength(1)),
    name: z.string().check(z.minLength(1)),
    limits: z.strictObject(AccountLimitsV1Schema.shape),
    prices: z.array(StrictPlanPriceV1Schema),
  })),
  teams: z.nullable(z.strictObject({
    freeSeats: z.int().check(z.minimum(0)),
    limitsFromPlanId: z.string().check(z.minLength(1)),
    seatPrices: z.array(StrictPlanPriceV1Schema),
  })),
  supporter: z.nullable(z.strictObject({
    ...supporterOfferShape(),
    presets: z.strictObject(supporterPresetsShape()),
  })),
  /** Public URL for Polar’s email-code customer portal. */
  portalUrl: z.optional(z.url()),
}).check(z.superRefine((config, ctx) => {
  const seen = new Set<string>();
  config.plans.forEach((plan, index) => {
    if (seen.has(plan.id)) {
      ctx.addIssue({ code: 'custom', path: ['plans', index, 'id'], message: `duplicate plan id "${plan.id}"` });
    }
    seen.add(plan.id);
  });
})));
export type PlansConfigV1 = z.infer<typeof PlansConfigV1Schema>;

export const AccountPlanViaV1Schema = lazyZodSchema(() => z.enum(['account', 'team']));

/** `GET /v1/account/plan`. Open objects: an old client drops what it does not know. */
export const AccountPlanResponseV1Schema = lazyZodSchema(() => z.object({
  plan: z.nullable(z.object({
    id: z.string(),
    name: z.string(),
    via: AccountPlanViaV1Schema,
    source: z.nullable(z.string()),
    /** Epoch ms of the paid period end; null = no end (manual grant). */
    endsAt: z.nullable(z.int()),
    renews: z.boolean(),
    /** Set only once `endsAt` has passed: limits stay on this plan until this date. */
    graceEndsAt: z.nullable(z.int()),
    /** Derived: `renews && endsAt < now`. A lost renewal webhook reads the same. */
    overdue: z.boolean(),
  })),
  limits: AccountLimitsV1Schema,
  usage: z.object({
    pinnedSessions: z.int().check(z.minimum(0)),
    artifactStorageBytes: z.nullable(z.int().check(z.minimum(0))),
  }),
  /**
   * Read from the Account's `SupporterRecord`. False and null once revoked by a refund.
   * Never carries the supporter code: this response reaches agents.
   */
  supporter: z.object({
    active: z.boolean(),
    since: z.nullable(z.int()),
    number: z.nullable(z.int()),
    recurringSince: z.nullable(z.int()),
  }),
  supporterRing: z.boolean(),
  /** Absent parts follow the `plans` and `supporter` bits. */
  offers: z.optional(z.object({
    /** The base tier (no plan), so a plan ladder can show it to people on a plan. Null with `plans` off. */
    baseLimits: z.nullable(AccountLimitsV1Schema),
    /** Days limits stay on a plan after its paid period ends. 0 when no plans are configured. */
    graceDays: z.int().check(z.minimum(0)),
    plans: z.array(PlanDefinitionV1Schema),
    teams: z.nullable(z.object({
      freeSeats: z.int().check(z.minimum(0)),
      seatPrices: z.array(PlanPriceV1Schema),
    })),
    supporter: z.nullable(SupporterOfferV1Schema),
    portalUrl: z.nullable(z.string()),
    /** Which reference this server can settle. Missing on older servers. */
    billingReference: z.optional(z.enum(['account', 'supporter_code'])),
  })),
}));
export type AccountPlanResponseV1 = z.infer<typeof AccountPlanResponseV1Schema>;
