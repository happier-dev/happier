import { describe, expect, it } from 'vitest';

import { formatProviderAmount } from './managedMachineDisplay';

describe('provider amount presentation', () => {
  it('rounds a provider’s raw decimal to the currency, keeping honest digits for a tiny hourly rate', () => {
    const usd = (amount: string) => ({ amount, currency: 'USD' });
    // Hetzner returns gross prices with sixteen decimals; the receipt must not print them all.
    expect(formatProviderAmount(usd('0.0010810000000000'))).toBe('$0.00108');
    expect(formatProviderAmount({ amount: '0.0119000000000000', currency: 'EUR' })).toBe('€0.0119');
    // A figure that is not tiny keeps the currency's normal precision, whatever the provider padded it with.
    expect(formatProviderAmount(usd('7.4900000000000000'))).toBe('$7.49');
    expect(formatProviderAmount(usd('0.6'))).toBe('$0.60');
    expect(formatProviderAmount(usd('0.6486000000000000'))).toBe('$0.65');
    expect(formatProviderAmount(usd('12'))).toBe('$12.00');
  });
});
