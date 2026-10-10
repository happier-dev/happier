import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { resolveUsagePageAggregation } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { pressTestInstance, renderScreen } from '@/dev/testkit';
import type { UsageWidgetBodyModel } from './useUsageWidgetResource';
import type { UsageWidgetPageFilter } from './useUsageWidgetPageFilters';
import { UsageDrillProvider, usageDrillFromPageFilters } from './usageDrill';
import { UsageBreakdownsWidget } from './widgets/UsageBreakdownsWidget';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);

function pageFilters(selected: readonly string[] = []) {
  const chosen: string[] = [];
  const agents: UsageWidgetPageFilter = {
    field: 'agents',
    title: 'Agents',
    selected,
    options: [
      { id: 'claude', label: 'Claude Code' },
      { id: 'codex', label: 'Codex' },
    ],
    select: (id) => {
      if (id !== 'claude' && id !== 'codex') return false;
      chosen.push(id);
      return true;
    },
  };
  return { filters: [agents], chosen };
}

describe('drill-to-filter', () => {
  it('is the page filter row itself: one writer, its own selection and its own refusals', () => {
    const { filters, chosen } = pageFilters(['codex']);
    const drill = usageDrillFromPageFilters(filters);
    expect(drill.available('agents')).toBe(true);
    // A Session-scoped page offers no scope filters, so nothing there can be narrowed.
    expect(drill.available('projects')).toBe(false);
    expect(drill.selected('agents', 'codex')).toBe(true);
    expect(drill.selected('agents', 'claude')).toBe(false);
    expect(drill.toggle('agents', 'claude')).toBe(true);
    expect(drill.toggle('agents', 'not-listed')).toBe(false);
    expect(drill.toggle('projects', 'happier')).toBe(false);
    expect(chosen).toEqual(['claude']);
  });

  it('narrows to a ranked Agent row, and leaves a dimension that is not a scope filter as plain rows', async () => {
    const start = Date.parse('2024-04-22T00:00:00Z');
    const query = normalizeUsageQuery({
      period: { startMs: start, endMs: start + 86_400_000 },
      granularity: 'day',
      breakdown: ['agent', 'model'],
    });
    const tokens = (total: number) => ({
      input: total,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total,
    });
    const cost = { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' };
    const entry = (key: string, total: number) => ({
      key,
      label: key,
      eventCount: 1,
      tokens: tokens(total),
      cost,
    });
    const slice = resolveUsagePageAggregation({
      queries: [query],
      accounting: [
        {
          query,
          status: 'available',
          value: {
            v: 1,
            totals: { tokens: tokens(30), cost, eventCount: 2 },
            series: [],
            breakdowns: {
              agent: [entry('claude', 20), entry('codex', 10)],
              model: [entry('opus', 30)],
            },
          },
        },
      ],
    }).results[0]!;
    const model: UsageWidgetBodyModel = {
      requestedQuery: null,
      shownQuery: null,
      slice,
      pending: false,
      error: null,
      freshness: 'fresh',
      updatingPreviousPeriod: false,
      refreshing: false,
      refresh: async () => {},
    };
    const { filters, chosen } = pageFilters();
    const screen = await renderScreen(
      <UsageDrillProvider value={usageDrillFromPageFilters(filters)}>
        <UsageBreakdownsWidget
          id="usage_breakdowns"
          query={query}
          slice={slice}
          model={model}
          serverId="home"
          testID="breakdowns"
        />
      </UsageDrillProvider>,
    );
    act(() =>
      pressTestInstance(
        screen.findByTestId('breakdowns.agent.drill.codex')!,
        'row',
      ),
    );
    expect(chosen).toEqual(['codex']);
    expect(
      screen.findAllHostsByTestId('breakdowns.model.drill.opus'),
    ).toHaveLength(0);
  });
});
