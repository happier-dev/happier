import { describe, expect, it } from 'vitest';

import { t } from '@/text';

import {
  describeKeepCosts,
  describeRetention,
  describeRetentionConsequence,
  describeRetentionPolicy,
  describeDefaultPolicy,
  describeArchiveChoiceConsequence,
  keepOffersWake,
} from './managedRetentionPresentation';
import { formatPriceUnit, formatProviderAmount } from '@/components/ui/presentation/providerCostPresentation';

const HOUR = 3_600_000;

describe('describeRetentionConsequence', () => {
  it('names wake only beside a rule that stops it: never Always on, never after deletion (58d §D4)', () => {
    const retention = { kind: 'until-delete' } as const;
    expect(describeRetention(retention)).toBe(t('managedRetention.untilDelete'));
    expect(keepOffersWake(retention)).toBe(false);
    expect(describeRetentionPolicy({ retention, wakeOnAcceptedMessage: true })).toBe(describeRetention(retention));
    expect(describeDefaultPolicy({ retention, wakeOnAcceptedMessage: false })).toBe(describeRetention(retention));
    const stop = { kind: 'unused', afterMs: HOUR, effect: 'stop' } as const;
    expect(keepOffersWake(stop)).toBe(true);
    expect(describeRetentionPolicy({ retention: stop, wakeOnAcceptedMessage: true }))
      .toBe(`${describeRetention(stop)} · ${t('managedRetention.wakes')}`);
    const destruction = { kind: 'unused', afterMs: HOUR, effect: 'delete' } as const;
    expect(describeRetentionPolicy({ retention: destruction, wakeOnAcceptedMessage: true }))
      .toBe(describeRetention(destruction));
  });
  it('states the billing consequence of the choice instead of repeating the choice', () => {
    const billed = {
      location: 'cloud',
      stoppedBilling: 'billed',
      provider: 'Hetzner',
    } as const;
    const stop = { kind: 'unused', afterMs: HOUR, effect: 'stop' } as const;

    expect(describeRetentionConsequence(stop, billed)).not.toBe(
      describeRetention(stop),
    );
    expect(describeRetentionConsequence(stop, billed)).toBe(
      t('managedRetention.consequence.stopBilled', { provider: 'Hetzner' }),
    );
    expect(describeRetentionConsequence({ kind: 'until-delete' }, billed)).toBe(
      t('managedRetention.consequence.untilDeleteBilled'),
    );
    expect(
      describeRetentionConsequence(
        { kind: 'unused', afterMs: 2 * HOUR, effect: 'delete' },
        billed,
      ),
    ).toBe(
      t('managedRetention.consequence.deleteBilled', {
        duration: t('managedRetention.hours', { count: 2 }),
      }),
    );
  });

  it('distinguishes running-only billing, local machines and unknown billing', () => {
    const stop = { kind: 'unused', afterMs: HOUR, effect: 'stop' } as const;
    expect(
      describeRetentionConsequence(stop, {
        location: 'cloud',
        stoppedBilling: 'not-billed',
        provider: 'Fly',
      }),
    ).toBe(
      t('managedRetention.consequence.stopNotBilled', { provider: 'Fly' }),
    );
    expect(
      describeRetentionConsequence(stop, {
        location: 'local',
        stoppedBilling: 'not-billed',
        provider: 'Lima',
      }),
    ).toBe(t('managedRetention.categoryHelp.local'));
    expect(
      describeRetentionConsequence(
        { kind: 'until-delete' },
        { location: 'local', stoppedBilling: 'not-billed', provider: 'Lima' },
      ),
    ).toBe(t('managedRetention.consequence.untilDelete'));
    expect(
      describeRetentionConsequence(stop, {
        location: 'cloud',
        stoppedBilling: 'unknown',
        provider: 'Acme',
      }),
    ).toBe(t('managedRetention.consequence.stopUnknown', { provider: 'Acme' }));
  });
});

describe('describeKeepCosts', () => {
  const hour = { amount: '0.12', currency: 'USD', unit: 'hour', source: 'Boat', observedAt: 1 };
  const rate = `${formatProviderAmount(hour)} ${formatPriceUnit('hour')}`;
  it('prices Always on and a start from the provider\'s own rate, never converting an hour into a month', () => {
    expect(describeKeepCosts([hour])).toEqual({
      alwaysOn: rate,
      starting: t('managedRetention.startingBills', { price: rate }),
    });
  });
  it('says the published monthly rate for Always on when the provider gives one', () => {
    const month = { ...hour, amount: '88', unit: 'month' };
    expect(describeKeepCosts([hour, month]).alwaysOn)
      .toBe(t('managedRetention.aboutMonthly', { amount: formatProviderAmount(month) }));
  });
  it('says nothing it was not told: no price, no cost line', () => {
    expect(describeKeepCosts(undefined)).toEqual({});
    expect(describeKeepCosts([])).toEqual({});
  });
});

describe('the stopped cost, said once (R6)', () => {
  const stop = { kind: 'unused', afterMs: HOUR, effect: 'stop' } as const;
  const charge = (amount: string, unit = 'GB-month') => ({ label: { key: 'x', fallback: 'Snapshot storage (Pro / Enterprise)' },
    amount, currency: 'USD', unit, source: 'pricing', observedAt: 1 });
  const facts = { location: 'cloud', stoppedBilling: 'not-billed', provider: 'Vercel' } as const;
  it('folds the storage rate into the Stop consequence as a short value, never the provider\'s label', () => {
    const one = charge('0.08');
    const rate = `${formatProviderAmount(one)} ${formatPriceUnit(one.unit)}`;
    expect(describeRetentionConsequence(stop, { ...facts, storageCharges: [one] }))
      .toBe(t('managedRetention.consequence.stopNotBilledStorage', { provider: 'Vercel', rate }));
    expect(describeRetentionConsequence(stop, { ...facts, storageCharges: [one] })).not.toContain('Snapshot');
  });
  it('says the lowest rate as "from" when several storage charges share a unit, and nothing new without one', () => {
    const several = [charge('0.15'), charge('0.08')];
    const from = t('managedRetention.storageFrom', { rate: `${formatProviderAmount(several[1]!)} ${formatPriceUnit('GB-month')}` });
    expect(describeRetentionConsequence(stop, { ...facts, storageCharges: several }))
      .toBe(t('managedRetention.consequence.stopNotBilledStorage', { provider: 'Vercel', rate: from }));
    expect(describeRetentionConsequence(stop, facts)).toBe(t('managedRetention.consequence.stopNotBilled', { provider: 'Vercel' }));
  });
});

describe('describeArchiveChoiceConsequence (T3 R3: the creation end choice says its cost)', () => {
  const cloud = { location: 'cloud', stoppedBilling: 'not-billed', provider: 'Hetzner' } as const;
  it('says what Keep, Stop and Delete each mean for the bill, through the one consequence owner', () => {
    expect(describeArchiveChoiceConsequence('keep', cloud)).toBe(t('managedRetention.consequence.untilDeleteBilled'));
    expect(describeArchiveChoiceConsequence('stop', cloud)).toBe(t('managedRetention.consequence.stopNotBilled', { provider: 'Hetzner' }));
    expect(describeArchiveChoiceConsequence('stop', { ...cloud, stoppedBilling: 'billed' }))
      .toBe(t('managedRetention.consequence.stopBilled', { provider: 'Hetzner' }));
    expect(describeArchiveChoiceConsequence('delete', cloud)).toBe(t('managedRetention.consequence.deleteOnEndBilled'));
  });
  it('bills nobody for a local machine, and says no amount it was not told', () => {
    const local = { location: 'local', stoppedBilling: 'not-billed', provider: 'Lima' } as const;
    expect(describeArchiveChoiceConsequence('keep', local)).toBe(t('managedRetention.consequence.untilDelete'));
    expect(describeArchiveChoiceConsequence('stop', local)).toBe(t('managedRetention.categoryHelp.local'));
    expect(describeArchiveChoiceConsequence('delete', local)).toBe(t('managedRetention.consequence.deleteOnEnd'));
    expect(describeArchiveChoiceConsequence('stop', { ...cloud, stoppedBilling: 'unknown' }))
      .toBe(t('managedRetention.consequence.stopUnknown', { provider: 'Hetzner' }));
  });
});
