import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatDeclaredPlanSource, formatPriceSource, formatProviderPrice, presentManagedPresetCost } from './providerCostPresentation';

const price = { amount: '5.00', currency: 'USD', unit: 'month', source: 'https://api.example.test/v1/pricing', observedAt: Date.UTC(2026, 10, 18) };

describe('provider cost presentation', () => {
  it('prints an observed price as the reader says it, with its public pricing page and never an API reference', () => {
    expect(formatProviderPrice(price, 'https://www.example.test/pricing')).toBe('$5.00 a month · example.test');
    expect(formatProviderPrice(price, 'snapshot-pricing')).toBe('$5.00 a month');
    expect(formatPriceSource(price, null)).not.toContain('api.example.test');
    expect(formatPriceSource(price, 'Hetzner')).toContain('Hetzner');
  });

  it('dates a declared plan by its calendar day and names its page by host', () => {
    const line = formatDeclaredPlanSource({ url: 'https://vercel.com/docs/plans/hobby', checkedAt: '2026-11-16' });
    expect(line).toContain('vercel.com');
    expect(line).toMatch(/16/);
  });

  it('presents local, priced and unpriced managed costs through one owner', () => {
    expect(presentManagedPresetCost({ billing: { location: 'local' }, provider: 'Lima', runsOn: 'Mac' }))
      .toEqual({ value: 'No bill', detail: 'Runs on Mac' });
    expect(presentManagedPresetCost({ prices: [price], provider: 'Vercel' }))
      .toMatchObject({ value: '$5.00 a month' });
    expect(presentManagedPresetCost({ provider: 'Vercel' })?.value).toBeTruthy();
  });

  it('keeps price amount formatting out of deploy UI consumers', () => {
    for (const file of ['../../projects/deployments/DeploymentRestoreSheet.tsx', '../../projects/deployments/DeploymentTargetPlans.tsx']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source, file).not.toMatch(/\.amount\b|\.currency\b|managedMachines\.price\./);
    }
  });
});
