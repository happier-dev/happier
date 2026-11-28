import { z } from 'zod';

import { lazySchema } from '../lazySchema.js';

/**
 * Per-Account limits. `null` means no limit (or keep forever).
 *
 * Open object: an older reader drops limit fields it does not know, so a later limit is a new
 * field defaulting to `null` in the base tier.
 */
export const AccountLimitsV1Schema = lazySchema(() => z.object({
  sessionRetentionDays: z.number().int().min(1).nullable(),
  subagentRetentionDays: z.number().int().min(1).nullable(),
  /** 0.3 only; always null on 0.2, whose server cannot separate tool outputs from E2EE rows. */
  toolOutputRetentionDays: z.number().int().min(1).nullable(),
  pinnedSessions: z.number().int().min(0).nullable(),
  /** 0.3 only; always null on 0.2. */
  artifactStorageBytes: z.number().int().min(0).nullable(),
}));
export type AccountLimitsV1 = z.infer<typeof AccountLimitsV1Schema>;

/**
 * Shapes shared by the operator config (closed, so typos surface) and the read response (open, so
 * an older client drops fields it does not know).
 */
const planPriceShape = () => ({
  interval: z.enum(['month', 'year']),
  amountMinor: z.number().int().min(0),
  currency: z.string().min(1),
  /** Hosted checkout link (web, desktop). Public value. */
  checkoutUrl: z.string().url().optional(),
  storeProductId: z.string().min(1).optional(),
  storeOfferingId: z.string().min(1).optional(),
});
const supporterOfferShape = () => ({
  suggestedMonthlyMinor: z.number().int().min(0),
  minimumMinor: z.number().int().min(0),
  currency: z.string().min(1),
  /**
   * Hosted pay-what-you-want checkout links (public values). The app appends the supporter
   * `reference_id` and the chosen amount. Null where no link is configured.
   */
  checkoutUrls: z.object({
    monthly: z.string().url().nullable(),
    once: z.string().url().nullable(),
  }).optional(),
  /** RevenueCat offering for the one-time native Supporter tiers. */
  storeOfferingId: z.string().min(1).optional(),
});
const supporterPresetsShape = () => ({
  monthly: z.array(z.number().int().min(0)),
  once: z.array(z.number().int().min(0)),
});

/** One price point. Provider fields are public values (plan 03 seam). */
export const PlanPriceV1Schema = lazySchema(() => z.object(planPriceShape()));
export type PlanPriceV1 = z.infer<typeof PlanPriceV1Schema>;

export const PlanDefinitionV1Schema = lazySchema(() => z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  limits: AccountLimitsV1Schema,
  prices: z.array(PlanPriceV1Schema),
}));
export type PlanDefinitionV1 = z.infer<typeof PlanDefinitionV1Schema>;

export const SupporterOfferV1Schema = lazySchema(() => z.object({
  ...supporterOfferShape(),
  presets: z.object(supporterPresetsShape()),
}));
export type SupporterOfferV1 = z.infer<typeof SupporterOfferV1Schema>;

const StrictPlanPriceV1Schema = lazySchema(() => z.strictObject(planPriceShape()));

/**
 * The value of `HAPPIER_PLANS__CONFIG`. Closed: an operator's typo must surface.
 *
 * `plans` is ordered from the lowest to the highest plan; billing reconciliation reads that order
 * when two live sources disagree ("highest live plan wins").
 */
export const PlansConfigV1Schema = lazySchema(() => z.strictObject({
  v: z.literal(1),
  graceDays: z.number().int().min(0),
  plans: z.array(z.strictObject({
    id: z.string().min(1),
    name: z.string().min(1),
    limits: z.strictObject(AccountLimitsV1Schema.shape),
    prices: z.array(StrictPlanPriceV1Schema),
  })),
  teams: z.strictObject({
    freeSeats: z.number().int().min(0),
    limitsFromPlanId: z.string().min(1),
    seatPrices: z.array(StrictPlanPriceV1Schema),
  }).nullable(),
  supporter: z.strictObject({
    ...supporterOfferShape(),
    presets: z.strictObject(supporterPresetsShape()),
  }).nullable(),
  /** Public URL for Polar’s email-code customer portal. */
  portalUrl: z.string().url().optional(),
}).superRefine((config, ctx) => {
  const seen = new Set<string>();
  config.plans.forEach((plan, index) => {
    if (seen.has(plan.id)) {
      ctx.addIssue({ code: 'custom', path: ['plans', index, 'id'], message: `duplicate plan id "${plan.id}"` });
    }
    seen.add(plan.id);
  });
}));
export type PlansConfigV1 = z.infer<typeof PlansConfigV1Schema>;

export const AccountPlanViaV1Schema = lazySchema(() => z.enum(['account', 'team']));

/** `GET /v1/account/plan`. Open objects: an old client drops what it does not know. */
export const AccountPlanResponseV1Schema = lazySchema(() => z.object({
  plan: z.object({
    id: z.string(),
    name: z.string(),
    via: AccountPlanViaV1Schema,
    source: z.string().nullable(),
    /** Epoch ms of the paid period end; null = no end (manual grant). */
    endsAt: z.number().int().nullable(),
    renews: z.boolean(),
    /** Set only once `endsAt` has passed: limits stay on this plan until this date. */
    graceEndsAt: z.number().int().nullable(),
    /** Derived: `renews && endsAt < now`. A lost renewal webhook reads the same. */
    overdue: z.boolean(),
  }).nullable(),
  limits: AccountLimitsV1Schema,
  usage: z.object({
    pinnedSessions: z.number().int().min(0),
    artifactStorageBytes: z.number().int().min(0).nullable(),
  }),
  /**
   * Read from the Account's `SupporterRecord`. False and null once revoked by a refund.
   * Never carries the supporter code: this response reaches agents.
   */
  supporter: z.object({
    active: z.boolean(),
    since: z.number().int().nullable(),
    number: z.number().int().nullable(),
    recurringSince: z.number().int().nullable(),
  }),
  supporterRing: z.boolean(),
  /** Absent parts follow the `plans` and `supporter` bits. */
  offers: z.object({
    /** The base tier (no plan), so a plan ladder can show it to people on a plan. Null with `plans` off. */
    baseLimits: AccountLimitsV1Schema.nullable(),
    /** Days limits stay on a plan after its paid period ends. 0 when no plans are configured. */
    graceDays: z.number().int().min(0),
    plans: z.array(PlanDefinitionV1Schema),
    teams: z.object({
      freeSeats: z.number().int().min(0),
      seatPrices: z.array(PlanPriceV1Schema),
    }).nullable(),
    supporter: SupporterOfferV1Schema.nullable(),
    portalUrl: z.string().nullable(),
    /** Which reference this server can settle. Missing on older servers. */
    billingReference: z.enum(['account', 'supporter_code']).optional(),
  }).optional(),
}));
export type AccountPlanResponseV1 = z.infer<typeof AccountPlanResponseV1Schema>;
