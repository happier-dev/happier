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
import { ChartInteractionProvider } from '@happier-dev/plugin-ui/presentation';
import { storage } from '@/sync/domains/state/storage';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);

function pageFilters(selected: readonly string[] = [], field: 'agents' | 'machines' = 'agents') {
  const chosen: string[] = [];
  const agents: UsageWidgetPageFilter = {
    field,
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

  it.each(['agent', 'machine'] as const)('keeps %s drill and exact value controls as independent sibling buttons', async dimension => {
    const start = Date.parse('2024-04-22T00:00:00Z');
    const query = normalizeUsageQuery({
      period: { startMs: start, endMs: start + 86_400_000 },
      granularity: 'day',
      breakdown: [dimension, 'model'],
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
              [dimension]: [entry('claude', 20), entry('codex', 10)],
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
    const { filters, chosen } = pageFilters([], dimension === 'machine' ? 'machines' : 'agents');
    const revealed: string[] = [];
    const original = storage.getState();
    const named = createMachineFixture({ id: 'codex' });
    const machines = [{ ...named, metadata: { ...named.metadata!, displayName: 'Build box' } },
      ...Array.from({ length: 149 }, (_, index) => createMachineFixture({ id: `other-${index}` }))];
    storage.setState({ machines: Object.fromEntries(machines.map(machine => [machine.id, machine])),
      machineListByServerId: {}, machineListStatusByServerId: {} });
    let commits = 0;
    const screen = await renderScreen(
      <React.Profiler id="breakdowns" onRender={() => { commits++; }}>
      <UsageDrillProvider value={usageDrillFromPageFilters(filters)}>
        <ChartInteractionProvider renderDatum={(datum, visual, testID) => <button data-testid={testID} onClick={() => revealed.push(datum.value)}>{visual}</button>}>
        <UsageBreakdownsWidget
          id="usage_breakdowns"
          query={query}
          slice={slice}
          model={model}
          serverId="home"
          testID="breakdowns"
        />
        </ChartInteractionProvider>
      </UsageDrillProvider>
      </React.Profiler>,
    );
    try {
      commits = 0;
      for (let index = 0; index < 20; index++) {
        await act(async () => {
          const current = storage.getState().machines;
          storage.setState({ machines: { ...current, codex: { ...current.codex!, daemonStateVersion: index + 2 } } });
        });
      }
      await act(async () => {
        const current = storage.getState().machines;
        storage.setState({ machines: { ...current, 'other-0': { ...current['other-0']!,
          metadata: { ...current['other-0']!.metadata!, displayName: 'Unrelated box' } } } });
      });
      expect(commits, 'Machine runtime changes do not render a ranked breakdown').toBe(0);
      if (dimension === 'machine') {
        await act(async () => {
          const current = storage.getState().machines;
          storage.setState({ machines: { ...current, codex: { ...current.codex!, metadata: { ...current.codex!.metadata!, displayName: 'Renamed build box' } } } });
        });
        expect(screen.findByType((await import('@happier-dev/plugin-ui/presentation')).UsageBreakdownsBody).props.model.blocks[0].rows
          .find((row: { id: string }) => row.id === 'codex').label).toBe('Renamed build box');
      }
      const drillButton = screen.findByTestId(`breakdowns.${dimension}.drill.codex`)!;
      // Inspecting an exact amount must never bubble to the scope-narrowing button.
      expect(drillButton.findAll(node => node.type === 'button')).toHaveLength(0);
      const exact = screen.findAll(node => node.type === 'button')[0]!;
      act(() => exact.props.onClick());
      expect(revealed).toHaveLength(1);
      expect(chosen).toEqual([]);
      act(() =>
        pressTestInstance(
          drillButton,
          'row',
        ),
      );
      expect(chosen).toEqual(['codex']);
      expect(
        screen.findAllHostsByTestId('breakdowns.model.drill.opus'),
      ).toHaveLength(0);
    } finally {
      await screen.unmount();
      storage.setState({ machines: original.machines, machineListByServerId: original.machineListByServerId,
        machineListStatusByServerId: original.machineListStatusByServerId });
    }
  });
});
