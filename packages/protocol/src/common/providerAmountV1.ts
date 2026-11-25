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

// A currency code beside a numeric prefix is not a price in text such as "CAD 3D" or "CAD 2.5D".
const amount = String.raw`\d+(?:[.,]\d+)?`;
const amountEnd = String.raw`\b(?![.,]\d)`;
const commonPriceText = new RegExp(
  String.raw`\b(?:USD|EUR|GBP|CAD|CHF|JPY)\s*${amount}${amountEnd}|\b${amount}\s*(?:USD|EUR|GBP|CAD|CHF|JPY|dollars?)\b`,
  'iu',
);
// Supplemental codes use their ISO casing so ordinary text such as "try 3 options" stays valid.
const currencyCodes = Intl.supportedValuesOf?.('currency').join('|');
const isoPriceText = currencyCodes
  ? new RegExp(String.raw`\b(?:${currencyCodes})\s*${amount}${amountEnd}|\b${amount}\s*(?:${currencyCodes})\b`, 'u')
  : null;

/** Money written as text ("$5", "0.30 USD", "20 dollars"): a price that belongs in a ProviderAmountV1 instead. */
export function containsPriceTextV1(value: unknown): boolean {
  if (typeof value === 'string') {
    return /\p{Sc}\s*\d|\d\s*\p{Sc}/u.test(value)
      || commonPriceText.test(value)
      || isoPriceText?.test(value) === true;
  }
  if (Array.isArray(value)) return value.some(containsPriceTextV1);
  return value !== null && typeof value === 'object' && Object.values(value).some(containsPriceTextV1);
}
