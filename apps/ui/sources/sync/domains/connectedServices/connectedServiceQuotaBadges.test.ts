import { describe, expect, it } from 'vitest';

import type { ConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol';

import { computeConnectedServiceQuotaSummaryBadges } from './connectedServiceQuotaBadges';

describe('computeConnectedServiceQuotaSummaryBadges', () => {
  it('returns one badge per pinned meter in pinned order', () => {
    const snapshot: ConnectedServiceQuotaSnapshotV1 = {
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt: 1,
      staleAfterMs: 1000,
      planLabel: null,
      accountLabel: null,
      meters: [
        { meterId: 'session', label: 'Session', used: null, limit: null, unit: 'unknown', utilizationPct: 10, resetsAt: null, status: 'ok', details: {} },
        { meterId: 'weekly', label: 'Weekly', used: null, limit: null, unit: 'unknown', utilizationPct: 25, resetsAt: null, status: 'ok', details: {} },
      ],
    };

    const badges = computeConnectedServiceQuotaSummaryBadges({
      snapshot,
      pinnedMeterIds: ['weekly', 'session'],
    });

    expect(badges.map((b) => b.meterId)).toEqual(['weekly', 'session']);
    expect(badges[0]?.text).toContain('Weekly');
    expect(badges[1]?.text).toContain('Session');
  });

  it('keeps a placeholder badge when a pinned meter is missing', () => {
    const snapshot: ConnectedServiceQuotaSnapshotV1 = {
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt: 1,
      staleAfterMs: 1000,
      planLabel: null,
      accountLabel: null,
      meters: [],
    };

    const badges = computeConnectedServiceQuotaSummaryBadges({
      snapshot,
      pinnedMeterIds: ['weekly'],
    });

    expect(badges).toEqual([{ meterId: 'weekly', text: 'weekly —' }]);
  });

  it('derives remaining percent from used/limit when utilizationPct is missing', () => {
    const snapshot: ConnectedServiceQuotaSnapshotV1 = {
      v: 1,
      serviceId: 'anthropic',
      profileId: 'work',
      fetchedAt: 1,
      staleAfterMs: 1000,
      planLabel: null,
      accountLabel: null,
      meters: [
        { meterId: 'extra', label: 'Extra', used: 20, limit: 100, unit: 'credits', utilizationPct: null, resetsAt: null, status: 'ok', details: {} },
      ],
    };

    const badges = computeConnectedServiceQuotaSummaryBadges({
      snapshot,
      pinnedMeterIds: ['extra'],
    });

    expect(badges[0]?.text).toContain('80%');
  });

  it('can order badges by least remaining when strategy=min_remaining', () => {
    const snapshot: ConnectedServiceQuotaSnapshotV1 = {
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt: 1,
      staleAfterMs: 1000,
      planLabel: null,
      accountLabel: null,
      meters: [
        { meterId: 'session', label: 'Session', used: null, limit: null, unit: 'unknown', utilizationPct: 10, resetsAt: null, status: 'ok', details: {} },
        { meterId: 'weekly', label: 'Weekly', used: null, limit: null, unit: 'unknown', utilizationPct: 80, resetsAt: null, status: 'ok', details: {} },
      ],
    };

    const badges = computeConnectedServiceQuotaSummaryBadges({
      snapshot,
      pinnedMeterIds: ['session', 'weekly'],
      strategy: 'min_remaining',
    });

    expect(badges.map((b) => b.meterId)).toEqual(['weekly', 'session']);
    expect(badges[0]?.text).toContain('Weekly');
  });
});
