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

/** Money written as text ("$5", "0.30 USD", "20 dollars"): a price that belongs in a ProviderAmountV1 instead. */
export function containsPriceTextV1(value: unknown): boolean {
  if (typeof value === 'string') return /\p{Sc}\s*\d|\d\s*\p{Sc}|\b(?:USD|EUR|GBP|CAD)\s*\d+(?:[.,]\d+)?\b|\b\d+(?:[.,]\d+)?\s*(?:USD|EUR|GBP|CAD|dollars?)\b/iu.test(value);
  if (Array.isArray(value)) return value.some(containsPriceTextV1);
  return value !== null && typeof value === 'object' && Object.values(value).some(containsPriceTextV1);
}
