import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';

/**
 * A provider's price as data: a decimal amount, its ISO currency and the unit it is charged per ("hour", "month").
 * Machine prices and declared deployment plans carry it; the shared cost presenter is the only thing that prints it.
 */
export function providerAmountFieldsV1() {
  return {
    amount: z.string().check(z.regex(/^-?[0-9]+(?:\.[0-9]+)?$/)),
    currency: z.string().check(z.trim(), z.minLength(1)),
    unit: z.string().check(z.trim(), z.minLength(1)),
  };
}

export const ProviderAmountV1Schema = lazyZodSchema(() =>
  z.strictObject(providerAmountFieldsV1()),
);
export type ProviderAmountV1 = z.infer<typeof ProviderAmountV1Schema>;
