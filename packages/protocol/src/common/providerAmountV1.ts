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

// Supplemental codes require ISO casing so ordinary text such as "try 3 options" stays valid.
const commonCurrency = /^(?:USD|EUR|GBP|CAD|CHF|JPY)$/iu;
const isoCurrencies = new Set(Intl.supportedValuesOf?.('currency'));
const word = /\w/iu;
const space = /\s/u;

function isCurrencyCode(text: string, start: number): boolean {
  const code = text.slice(start, start + 3);
  return commonCurrency.test(code) || isoCurrencies.has(code);
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function containsCurrencyAmount(text: string): boolean {
  for (let end = 0; end < text.length;) {
    if (!isDigit(text.charCodeAt(end))) {
      end++;
      continue;
    }
    const start = end;
    // Consume every digit group once, even when neither side names a currency.
    do {
      end++;
      if ((text[end] === ',' || text[end] === '.') && isDigit(text.charCodeAt(end + 1))) end++;
    } while (isDigit(text.charCodeAt(end)));

    if (!word.test(text[end] ?? '')) {
      let prefix = start;
      if (text[prefix - 1] === '-' || text[prefix - 1] === '+') prefix--;
      while (space.test(text[prefix - 1] ?? '')) prefix--;
      if (prefix >= 3 && !word.test(text[prefix - 4] ?? '') && isCurrencyCode(text, prefix - 3)) return true;
    }

    if (!word.test(text[start - 1] ?? '')) {
      let suffix = end;
      while (space.test(text[suffix] ?? '')) suffix++;
      if (isCurrencyCode(text, suffix) && !word.test(text[suffix + 3] ?? '')) return true;
      if (/^dollars?\b/iu.test(text.slice(suffix, suffix + 8))) return true;
    }
  }
  return false;
}

/** Money written as text ("$5", "0.30 USD", "20 dollars"): a price that belongs in a ProviderAmountV1 instead. */
export function containsPriceTextV1(value: unknown): boolean {
  if (typeof value === 'string') {
    return /\p{Sc}\s*[+-]?\d|\d\s*\p{Sc}/u.test(value)
      || containsCurrencyAmount(value);
  }
  if (Array.isArray(value)) return value.some(containsPriceTextV1);
  return value !== null && typeof value === 'object' && Object.values(value).some(containsPriceTextV1);
}
