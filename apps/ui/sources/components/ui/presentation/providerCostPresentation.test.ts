import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatPriceSource, formatProviderPrice, presentManagedPresetCost } from './providerCostPresentation';

describe('provider cost presentation', () => {
  it('keeps the dated source line beside a provider price', () => {
    expect(formatPriceSource({ observedAt: Date.UTC(2026, 10, 18), source: 'https://example.test/pricing' }, null))
      .toContain('https://example.test/pricing');
    expect(formatProviderPrice({ amount: '5.00', currency: 'USD', unit: 'month' }, 'snapshot'))
      .toBe('5.00 USD/month · snapshot');
  });

  it('presents local, priced and unpriced managed costs through one owner', () => {
    expect(presentManagedPresetCost({ billing: { location: 'local' }, provider: 'Lima', runsOn: 'Mac' }))
      .toEqual({ value: 'No bill', detail: 'Runs on Mac' });
    expect(presentManagedPresetCost({ prices: [{ amount: '5.00', currency: 'USD', unit: 'month', source: 'bundle', observedAt: 1 }], provider: 'Vercel' }))
      .toMatchObject({ value: '$5.00 a month', detail: expect.stringContaining('bundle') });
    expect(presentManagedPresetCost({ provider: 'Vercel' }))
      .toEqual({ value: 'Price unavailable' });
  });

  it('keeps deploy UI price amount formatting out of consumers', () => {
    const restoreSource = readFileSync(new URL('../../projects/deployments/DeploymentRestoreSheet.tsx', import.meta.url), 'utf8');
    expect(restoreSource).not.toMatch(/price\.amount.*price\.currency.*price\.unit/s);
  });
});
