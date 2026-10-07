import { describe, expect, it } from 'vitest';

import type { ConnectedServiceQuotaMeterV1, ConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol';
import { parseClaudeSubscriptionUsageMeters } from '@happier-dev/plugins-claude/agent/auth/services/quota/subscriptionFetcher';

import { buildSummaryMeters, computeConnectedServiceQuotaSummaryBadges, selectConnectedServiceQuotaSummaryMeters } from './connectedServiceQuotaBadges';

describe('buildSummaryMeters', () => {
  it('uses the same canonical labels for current Claude producer snapshots and account summaries', () => {
    const ids = ['five_hour', 'seven_day', 'seven_day_all', 'seven_day_fable', 'spend', 'future_api_window'];
    const meters = parseClaudeSubscriptionUsageMeters(Object.fromEntries(ids.map((id) => [id, { utilization: 20 }])));
    const labels = ['5-hour', 'Weekly', 'Weekly (all models)', 'Weekly (Fable)', 'Spend', 'Future API Window'];
    expect(ids.map((id) => meters.find((meter) => meter.meterId === id)?.label)).toEqual(labels);
    expect(buildSummaryMeters(meters, [], 'primary').map((meter) => meter.label)).toEqual(labels);
  });

  it('presents raw stored window ids consistently while retaining provider display labels', () => {
    const ids = ['five_hour', 'seven_day', 'seven_day_all', 'seven_day_fable', 'spend', 'future_api_window', 'base_model_inference:primary'];
    const meters = ids.map((meterId) => ({
      meterId, label: meterId, used: null, limit: null, unit: 'unknown',
      utilizationPct: 10, resetsAt: null, status: 'ok', details: {},
    } satisfies ConnectedServiceQuotaMeterV1));
    const labels = ['5-hour', 'Weekly', 'Weekly (all models)', 'Weekly (Fable)', 'Spend', 'Future API Window', 'Base Model Inference Primary'];
    expect(buildSummaryMeters(meters, [], 'primary').map((meter) => meter.label)).toEqual(labels);
    expect(computeConnectedServiceQuotaSummaryBadges({ snapshot: { meters }, pinnedMeterIds: ids }).map((badge) => badge.text))
      .toEqual(labels.map((label) => `${label} 90%`));
    expect(selectConnectedServiceQuotaSummaryMeters({ meters: [], meterIds: ['seven_day_all', 'future_api_window'] }).map((meter) => meter.label))
      .toEqual(['Weekly (all models)', 'Future API Window']);
    expect(buildSummaryMeters([{ ...meters[0]!, label: 'Session allowance' }], [], 'primary')[0]?.label).toBe('Session allowance');
    expect(meters.map((meter) => meter.label)).toEqual(ids);
  });

  it('hides empty placeholders in summaries and removes them when unpinned', () => {
    const base = { used: null, limit: null, unit: 'unknown', utilizationPct: null, resetsAt: null, status: 'unavailable', details: {} } as const;
    const reported: ConnectedServiceQuotaMeterV1[] = [
      { ...base, meterId: 'full', label: 'Full', utilizationPct: 0, status: 'ok' },
      { ...base, meterId: 'empty', label: 'Empty', utilizationPct: 100, status: 'ok' },
      { ...base, meterId: 'placeholder', label: 'Placeholder' },
      { ...base, meterId: 'reset', label: 'Reset', resetAtMs: 62_000 },
      { ...base, meterId: 'expired', label: 'Expired', resetsAt: 1_000 },
      { ...base, meterId: 'pinned', label: 'Pinned' },
    ];
    for (const strategy of ['primary', 'min_remaining'] as const) {
      const projected = buildSummaryMeters(reported, ['pinned'], strategy, 2_000);
      expect(projected.map((row) => row.meterId).sort()).toEqual(['empty', 'full', 'pinned', 'reset']);
      expect(projected.find((row) => row.meterId === 'full')?.remainingPct).toBe(100);
      expect(projected.find((row) => row.meterId === 'empty')?.remainingPct).toBe(0);
      expect(projected.find((row) => row.meterId === 'reset')?.resetsAt).toBe(62_000);
    }
    expect(buildSummaryMeters(reported, [], 'primary', 2_000).map((row) => row.meterId)).toEqual(['full', 'empty', 'reset']);
  });

  const meters = ['session', 'weekly', 'weekly-sonnet', 'weekly-opus', 'extra-usage'].map((meterId, index) => ({
    meterId, label: ['Session', 'Weekly', 'Weekly Sonnet', 'Weekly Opus', 'Extra usage'][index]!, used: null, limit: null, unit: 'unknown',
    utilizationPct: index * 10, remainingPct: 95 - index * 10,
    resetsAt: index + 1, status: 'ok', details: {},
  } satisfies ConnectedServiceQuotaMeterV1));

  it('preserves every reported usage window and its provider-reported values', () => {
    expect(buildSummaryMeters(meters, [], 'primary')).toEqual(meters.map((meter) => ({
      meterId: meter.meterId, label: meter.label, remainingPct: meter.remainingPct,
      utilizationPct: meter.utilizationPct, status: meter.status, resetsAt: meter.resetsAt,
    })));
  });

  it('keeps unmeasured windows with useful reset information for either summary strategy', () => {
    const reached = { ...meters[0]!, meterId: 'reached', label: 'Reached', utilizationPct: null, remainingPct: null, resetsAt: 62_000 };
    for (const strategy of ['primary', 'min_remaining'] as const) {
      const summary = buildSummaryMeters([...meters, reached], ['weekly'], strategy, 2_000);
      expect(summary.map((meter) => meter.meterId).sort()).toEqual([...meters.map((meter) => meter.meterId), 'reached'].sort());
      expect(summary.find((meter) => meter.meterId === 'reached')).toMatchObject({ remainingPct: null, utilizationPct: null });
    }
  });

  it('keeps every present pinned meter in the chosen order, dropping only absent meters', () => {
    const pinned = ['extra-usage', 'weekly-opus', 'missing', 'weekly-sonnet', 'session', 'weekly'];
    expect(buildSummaryMeters(meters, pinned, 'primary').map((meter) => meter.meterId))
      .toEqual(['extra-usage', 'weekly-opus', 'weekly-sonnet', 'session', 'weekly']);
  });
});

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

    expect(badges).toEqual([{ meterId: 'weekly', text: '—' }]);
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

  it('does not rank quota badges against provider capacity states', () => {
    const snapshot: ConnectedServiceQuotaSnapshotV1 = {
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt: 1,
      staleAfterMs: 1000,
      planLabel: null,
      accountLabel: null,
      meters: [
        { meterId: 'daily', label: 'Daily', used: 50, limit: 100, unit: 'requests', utilizationPct: null, resetsAt: null, status: 'ok', details: { limitCategory: 'usage_limit' } },
        { meterId: 'weekly', label: 'Weekly', used: 80, limit: 100, unit: 'requests', utilizationPct: null, resetsAt: null, status: 'ok', details: { limitCategory: 'usage_limit' } },
        { meterId: 'server_capacity', label: 'Server capacity', used: 99, limit: 100, unit: 'requests', utilizationPct: null, resetsAt: null, status: 'ok', details: { limitCategory: 'capacity' } },
      ],
    };

    const badges = computeConnectedServiceQuotaSummaryBadges({
      snapshot,
      pinnedMeterIds: ['daily', 'weekly', 'server_capacity'],
      strategy: 'min_remaining',
    });

    expect(badges.map((badge) => badge.meterId)).toEqual(['weekly', 'daily']);
  });
});
