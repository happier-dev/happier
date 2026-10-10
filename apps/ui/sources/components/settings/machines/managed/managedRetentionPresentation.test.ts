import { describe, expect, it } from 'vitest';

import { t } from '@/text';

import {
  describeRetention,
  describeRetentionConsequence,
  describeRetentionPolicy,
  describeDefaultPolicy,
} from './managedRetentionPresentation';

const HOUR = 3_600_000;

describe('describeRetentionConsequence', () => {
  it('names explicit Until-delete wake in summaries without promising wake after deletion', () => {
    const retention = { kind: 'until-delete' } as const;
    expect(describeRetentionPolicy({ retention, wakeOnAcceptedMessage: true }))
      .toBe(`${describeRetention(retention)} · ${t('managedRetention.wakes')}`);
    expect(describeDefaultPolicy({ retention, wakeOnAcceptedMessage: false }))
      .toBe(`${describeRetention(retention)} · ${t('managedRetention.wakeOff')}`);
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
