import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import {
  resolveUsagePageAggregation,
  type UsageQueryResultSlice,
} from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { renderScreen } from '@/dev/testkit';
import { UsageChartPending } from './UsageChartStyleBodies';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);

describe('Usage chart bodies while activity is still being read', () => {
  it.each([
    ['pending', 'loading'], ['available', 'needsData'], ['partial', 'needsData'], ['error', 'unavailable'],
  ] as const)('uses the requested accounting read for an accounting-only chart (%s)', async (status, state) => {
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 604_800_000 },
      includeActivity: true, includeSessionEvidence: false });
    const value = { v: 1 as const, totals: { eventCount: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } } };
    const slice = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status,
      ...(status === 'error' ? { errorCode: 'usage_query_failed' } : {}),
      ...(status === 'available' || status === 'partial' ? { value } : {}),
    }] }).results[0]!;
    const screen = await renderScreen(<UsageChartPending slice={slice} testID="chart" title="Needs another week"
      reason="later" onRetry={() => {}} />);
    expect(screen.findByTestId(`chart.${state}`)).not.toBeNull();
    for (const other of ['loading', 'needsData', 'unavailable'])
      if (other !== state) expect(screen.findByTestId(`chart.${other}`)).toBeNull();
  });

  it('reads while activity is outstanding even when accounting already answered partially', async () => {
    const query = normalizeUsageQuery({
      period: { relative: '7days' },
      granularity: 'day',
    });
    const base = resolveUsagePageAggregation({ queries: [query] }).results[0]!;
    const slice: UsageQueryResultSlice = {
      ...base,
      sources: [
        { source: 'accounting', status: 'partial', asOfMs: 1 },
        { source: 'how_you_work', status: 'pending' },
      ],
    };
    const screen = await renderScreen(
      <UsageChartPending
        slice={slice}
        testID="sky"
        title="Busy time isn't recorded"
        reason="later"
        onRetry={() => {}}
      />,
    );
    expect(screen.findByTestId('sky.loading')).not.toBeNull();
    expect(screen.findByTestId('sky.needsData')).toBeNull();
  });

  it('says the measure is not recorded once activity has answered', async () => {
    const query = normalizeUsageQuery({
      period: { relative: '7days' },
      granularity: 'day',
    });
    const base = resolveUsagePageAggregation({ queries: [query] }).results[0]!;
    const slice: UsageQueryResultSlice = {
      ...base,
      sources: [
        { source: 'accounting', status: 'partial', asOfMs: 1 },
        { source: 'how_you_work', status: 'available', asOfMs: 1 },
      ],
    };
    const screen = await renderScreen(
      <UsageChartPending
        slice={slice}
        testID="sky"
        title="Busy time isn't recorded"
        reason="later"
        onRetry={() => {}}
      />,
    );
    expect(screen.findByTestId('sky.needsData')).not.toBeNull();
    // A failed activity read is unknown, never "not recorded".
    await screen.update(<UsageChartPending slice={{ ...slice, sources: [{ source: 'accounting', status: 'partial', asOfMs: 1 },
      { source: 'how_you_work', status: 'error', errorCode: 'usage_query_failed' }] }} testID="sky" title="Busy time isn't recorded" reason="later" onRetry={() => {}} />);
    expect(screen.findByTestId('sky.needsData')).toBeNull();
    expect(screen.findByTestId('sky.unavailable')).not.toBeNull();
    expect(screen.findByTestId('sky.loading')).toBeNull();
  });
});
