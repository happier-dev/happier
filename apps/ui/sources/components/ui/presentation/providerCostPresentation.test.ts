import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatDeclaredPlanPrice, formatDeclaredPlanSource, formatPriceSource, formatProviderPrice, presentManagedPresetCost } from './providerCostPresentation';

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

  it('prints a declared plan\u2019s structured price the way it prints a provider price (owner ruling A1)', () => {
    expect(formatDeclaredPlanPrice({ amount: '20', currency: 'USD', unit: 'month' })).toBe('$20.00 a month');
    expect(formatDeclaredPlanPrice({ amount: '0', currency: 'USD', unit: 'month' })).toBe('$0.00 a month');
    expect(formatDeclaredPlanPrice({ amount: '0.30', currency: 'USD', unit: '1M requests' })).toBe('$0.30 per 1M requests');
  });

  it('presents local, priced and unpriced managed costs through one owner', () => {
    expect(presentManagedPresetCost({ billing: { location: 'local', stoppedBilling: 'not-billed' }, provider: 'Lima', runsOn: 'Mac' }))
      .toEqual({ value: 'No bill', detail: 'Runs on Mac' });
    expect(presentManagedPresetCost({ prices: [price], provider: 'Vercel' }))
      .toMatchObject({ value: '$5.00 a month' });
    expect(presentManagedPresetCost({ provider: 'Vercel' })?.value).toBeTruthy();
  });

  it('keeps price amount formatting out of deploy and approval UI', () => {
    const root = fileURLToPath(new URL('../..', import.meta.url));
    const sources = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$|\.spec\.tsx?$/.test(name) ? [path] : [];
    });
    const files = ['projects', 'approvals'].flatMap((tree) => sources(join(root, tree)));
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.filter((file) => /\.amount\b|\.currency\b|managedMachines\.price\./.test(readFileSync(file, 'utf8')));
    expect(offenders.map((file) => file.slice(root.length))).toEqual([]);
  });
});
