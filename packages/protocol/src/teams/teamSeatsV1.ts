import { AccountDisplayProfileV1Schema } from '../account/accountDisplayProfileV1.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

export const TEAM_BILLING_CHECKOUT_PATH = '/v1/teams/:teamId/billing/checkout';

export const TeamBillingCheckoutV1Schema = lazyZodSchema(() => z.strictObject({
  url: z.url().check(z.startsWith('https://')),
}));

export const TeamSeatsV1Schema = lazyZodSchema(() => z.strictObject({
  freeSeats: z.int().check(z.minimum(0)),
  paidSeats: z.int().check(z.minimum(0)),
  members: z.array(z.strictObject({
    accountId: z.string().check(z.minLength(1)),
    profile: AccountDisplayProfileV1Schema,
  })),
  monthlyPrice: z.nullable(z.strictObject({
    amountMinor: z.int().check(z.minimum(0)),
    currency: z.string().check(z.minLength(1)),
  })),
  checkoutAvailable: z.boolean(),
}));
export type TeamSeatsV1 = z.infer<typeof TeamSeatsV1Schema>;
