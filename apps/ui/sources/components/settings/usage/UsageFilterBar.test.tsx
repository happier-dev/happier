import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { collectUnexpectedRawTextNodes } from '@/dev/testkit/render/renderScreen';

// Browser hardware and native viewport measurements are the boundaries; classification stays real.
const viewport = vi.hoisted(() => ({ width: 390, height: 844, scale: 1, fontScale: 1 }));
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    useWindowDimensions: () => viewport,
  }));

const { SelectionListFilterChip } =
  await import('@/components/ui/selectionList/SelectionListFilterChips');
const { SelectionList } =
  await import('@/components/ui/selectionList/SelectionList');
const { UsageFilterBar, usageTokensCostMetricOptions } = await import('./UsageFilterBar');
const { USAGE_SCOPE_FILTER_ALL } = await import('./useUsageWidgetPageFilters');

beforeEach(() => {
  Object.assign(viewport, { width: 390, height: 844 });
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone)', maxTouchPoints: 1 });
});

afterEach(() => {
  standardCleanup();
  vi.unstubAllGlobals();
});

type Bar = React.ComponentProps<typeof UsageFilterBar<'tokens' | 'cost'>>;

function renderBar(selections: string[], overrides: Partial<Bar> = {}) {
  return renderScreen(<UsageFilterBar {...barProps(selections)} {...overrides} />);
}

function barProps(selections: string[]): Bar {
  const filter = (
    field: 'sources' | 'agents',
    selected: string[],
    options: { id: string; label: string }[],
  ) => ({
    field,
    title: field,
    selected,
    options: [
      { id: USAGE_SCOPE_FILTER_ALL, label: `All ${field}` },
      ...options,
    ],
    select: (id: string) => {
      selections.push(`${field}:${id}`);
      return true;
    },
  });
  const props = {
    period: '7days',
    costBasis: 'auto',
    metricOptions: usageTokensCostMetricOptions(),
    coverageIncomplete: false,
    scopeFilters: [
      filter('sources', [], [{ id: 'runtime', label: 'Happier sessions' }]),
      filter(
        'agents',
        ['claude'],
        [
          { id: 'claude', label: 'Claude' },
          { id: 'codex', label: 'Codex' },
        ],
      ),
    ],
    costBasisOptions: ['auto'],
    costBasisPending: false,
    onPeriodChange: async () => true,
    onCostBasisChange: async () => true,
    metric: 'tokens',
    onMetricChange: null,
    testID: 'filters',
  } satisfies Bar;
  return props;
}

describe('UsageFilterBar', () => {
  it('announces period and metric choices as radio values with their checked state', async () => {
    Object.assign(viewport, { width: 1280, height: 900 });
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', maxTouchPoints: 0 });
    const screen = await renderBar([], { onMetricChange: () => {} });
    for (const [id, checked] of [['filters.period:7days', true], ['filters.period:today', false],
      ['filters.metric:tokens', true], ['filters.metric:cost', false]] as const) {
      const choice = screen.findHostByTestId(id)!;
      expect(choice.props.accessibilityRole).toBe('radio');
      expect(choice.props.accessibilityState).toMatchObject({ checked });
      expect(choice.props.accessibilityState.selected).toBeUndefined();
    }
    await screen.unmount();
  });

  it.each([390, 1280])('does not announce Tokens as selected when displayed widgets have mixed metrics (%spx)', async (width) => {
    Object.assign(viewport, { width, height: 844 });
    vi.stubGlobal('navigator', { userAgent: width === 390 ? 'Mozilla/5.0 (iPhone)' : 'Mozilla/5.0 (X11; Linux x86_64)', maxTouchPoints: width === 390 ? 1 : 0 });
    const selections: string[] = [];
    const props = { ...barProps([]), onMetricChange: (metric: 'tokens' | 'cost') => { selections.push(metric); } };
    const screen = await renderScreen(<UsageFilterBar {...props} metric="cost" />);
    try {
      expect(screen.findHostByTestId('filters.metric:cost')!.props.accessibilityState.checked).toBe(true);
      await screen.update(<UsageFilterBar {...props} metric={null} />);
      for (const metric of ['tokens', 'cost']) {
        expect(screen.findHostByTestId(`filters.metric:${metric}`)!.props.accessibilityState.checked).toBe(false);
      }
      expect(selections).toEqual([]);
      await screen.pressByTestIdAsync('filters.metric:cost');
      expect(selections).toEqual(['cost']);
    } finally {
      await screen.unmount();
    }
  });

  it('draws no period choice where the page fixes its own period (a Session), keeping Tokens/Cost (USAGE-ACCEPT 1118 #17)', async () => {
    const screen = await renderBar([], { onMetricChange: () => {}, showPeriod: false });
    expect(screen.findHostByTestId('filters.period:7days')).toBeFalsy();
    expect(screen.findHostByTestId('filters.metric:tokens')).toBeTruthy();
    await screen.unmount();
  });

  it('keeps phone and desktop filter labels inside text hosts as controls settle', async () => {
    for (const width of [390, 1280]) {
      Object.assign(viewport, { width, height: 844 });
      vi.stubGlobal('navigator', { userAgent: width === 390 ? 'Mozilla/5.0 (iPhone)' : 'Mozilla/5.0 (X11; Linux x86_64)', maxTouchPoints: width === 390 ? 1 : 0 });
      const props = barProps([]);
      const screen = await renderScreen(<UsageFilterBar {...props} costBasisPending metricPending onMetricChange={() => {}} />);
      expect(collectUnexpectedRawTextNodes(screen.tree.toJSON(), ['Text', 'span'])).toEqual([]);
      await screen.update(<UsageFilterBar {...props} costBasisOptions={['auto', 'reported']} onMetricChange={() => {}} />);
      expect(collectUnexpectedRawTextNodes(screen.tree.toJSON(), ['Text', 'span'])).toEqual([]);
      await screen.unmount();
    }
  });

  it('reads an unnarrowed scope as "All", leaving the count to the menu\'s All row (lab d2views, d2filter)', async () => {
    Object.assign(viewport, { width: 1280, height: 900 });
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', maxTouchPoints: 0 });
    const { t } = await import('@/text');
    const screen = await renderBar([]);
    const sources = screen.findAllByType(SelectionListFilterChip).map((chip) => chip.props.filter)
      .find((chip) => chip.id === 'sources')!;
    expect(sources.valueLabel).toBe(t('usage.board.page.filterAll'));
    expect(sources.count).toBeUndefined();
    expect(sources.reserveCount).toBeUndefined();
    await screen.unmount();
  });

  it('keeps Tokens/Cost and the basis at the bar\'s end edge on every desktop view, so views share one bar shape (R138)', async () => {
    Object.assign(viewport, { width: 1280, height: 900 });
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', maxTouchPoints: 0 });
    for (const overrides of [{ metric: 'tokens' as const, onMetricChange: () => {} }, { metric: null, onMetricChange: null }]) {
      const screen = await renderBar([], { ...overrides, costBasisOptions: ['auto', 'reported'] });
      const row = screen.findHostByTestId('filters.trailing');
      expect(row).not.toBeNull();
      expect(screen.findAllByType(SelectionListFilterChip).some(chip => chip.props.filter.id === 'costBasis')).toBe(true);
      // Decided by the layout, never by a remembered measurement.
      expect(screen.findHostByTestId('filters')!.props.onLayout).toBeUndefined();
      await screen.unmount();
    }
  });

  it('keeps the cost basis chip in Tokens and Cost alike, so the bar keeps its shape on every toggle', async () => {
    Object.assign(viewport, { width: 1280, height: 900 });
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', maxTouchPoints: 0 });
    for (const metric of ['tokens', 'cost', null] as const) {
      const screen = await renderBar([], { metric, costBasisOptions: ['auto', 'reported'], onMetricChange: () => {} });
      expect(screen.findAllByType(SelectionListFilterChip).map((chip) => chip.props.filter.id)).toContain('costBasis');
      await screen.unmount();
    }
  });

  // USAGE-ACCEPT 1121 #14: a phone stacked the six-way period, then Filters and the basis. Six periods are a chooser
  // (more than four short options), so the period, Filters and the basis share one row (lab uframe-Rp).
  it('puts the period on the phone row as one chooser beside Filters and the basis', async () => {
    const periods: unknown[][] = [];
    const { t } = await import('@/text');
    const screen = await renderBar([], { costBasisOptions: ['auto', 'reported'], onPeriodChange: async (...args) => { periods.push(args); return true; } });
    try {
      expect(screen.findHostByTestId('filters.period:7days')).toBeFalsy();
      const chips = screen.findAllByType(SelectionListFilterChip).map((chip) => chip.props.filter);
      expect(chips.map((chip) => chip.id)).toEqual(['period', 'scope', 'costBasis']);
      const period = chips[0]!;
      expect(period).toMatchObject({ selectedId: '7days', valueLabel: t('usage.period7dShort') });
      expect(period.options.map((option: { id: string }) => option.id)).toEqual(['today', '7days', '30days', '90days', 'year', 'all']);
      // The chooser's caller and foreground invocation travel with the choice, as the basis and scopes do: dropped, the
      // page looked up a page command the open chooser withholds and kept "Today" (USAGE-JOURNEY H, phone period).
      const caller = { source: 'ui' } as never;
      const invocation = { foreground: true } as never;
      await act(async () => { period.onChange?.('30days', caller, invocation); });
      expect(periods).toEqual([['30days', caller, invocation]]);
    } finally {
      await screen.unmount();
    }
  });

  it('collapses every scope filter into one Filters chooser on a phone, keeping each choice and the narrowed count', async () => {
    const { t } = await import('@/text');
    const selections: string[] = [];
    const screen = await renderBar(selections);
    const chips = screen
      .findAllByType(SelectionListFilterChip)
      .map((chip) => chip.props.filter);
    // Period stays visible; the four scopes become one chip (lab d2filter P).
    expect(chips.map((chip) => chip.id)).toEqual(['period', 'scope']);
    expect(chips[1]!).toMatchObject({ active: true, count: '1' });

    const content = await renderScreen(
      <>
        {chips[1]!.renderPopoverContent!({ close: () => {}, maxHeight: 600 })}
      </>,
    );
    const list = content.findAllByType(SelectionList)[0]!;
    // USAGE-ACCEPT 1121 #19: the sheet is one row per scope with its current value, each pushing its own list, so
    // Projects never sits below every machine and the sheet keeps its height when the lists settle.
    const sections = list.props.rootStep.sections;
    expect(sections).toHaveLength(1);
    const rows = sections[0].options as readonly { id: string; label: string; subtitle?: string; openStep?: { sections: readonly { title?: string; options: readonly { id: string }[] }[] } }[];
    expect(rows.map(row => [row.label, row.subtitle])).toEqual([['sources', t('usage.board.page.filterAll')], ['agents', 'Claude']]);
    expect(rows.every(row => row.openStep !== undefined)).toBe(true);
    expect(rows[1]!.openStep!.sections.flatMap(section => section.options.map(option => option.id)))
      .toEqual([`agents\u0001${USAGE_SCOPE_FILTER_ALL}`, 'agents\u0001claude', 'agents\u0001codex']);
    expect([...list.props.selection.selectedIds].sort()).toEqual(
      ['agents\u0001claude', `sources\u0001${USAGE_SCOPE_FILTER_ALL}`].sort(),
    );
    await act(async () => {
      list.props.onSelect('agents\u0001codex');
    });
    expect(selections).toEqual(['agents:codex']);
    await content.unmount();
    await screen.unmount();
  });

  it.each([390, 1280])('shows pending scope choices until inventory settles (%spx)', async width => {
    Object.assign(viewport, { width, height: 844 });
    vi.stubGlobal('navigator', { userAgent: width === 390 ? 'Mozilla/5.0 (iPhone)' : 'Mozilla/5.0 (X11; Linux x86_64)', maxTouchPoints: width === 390 ? 1 : 0 });
    const { Popover } = await import('@/components/ui/popover');
    const { t } = await import('@/text');
    const props = barProps([]);
    const all = { id: USAGE_SCOPE_FILTER_ALL, label: 'All projects' };
    const inventory = (optionsPending: boolean, options = [all]) =>
      [{ ...props.scopeFilters[0]!, field: 'projects' as const, title: 'Projects', optionsPending, options }];
    const screen = await renderBar([], { scopeFilters: inventory(true) });
    const renderPicker = () => {
      const chip = screen.findAllByType(SelectionListFilterChip)
        .find(node => node.props.filter.id === (width === 390 ? 'scope' : 'projects'))!;
      const popover = chip.findByType(Popover);
      return popover.props.children({ maxHeight: 600, maxWidth: width, placement: 'bottom', requestClose: () => {} });
    };
    // Invoke the existing popover content in place so no portal or focus behavior is mocked.
    const picker = await renderScreen(<>{renderPicker()}</>);
    try {
      if (width === 390) await picker.pressByTestIdAsync('filters.scope:open:projects');
      expect(JSON.stringify(picker.tree.toJSON())).toContain('All projects');
      expect(JSON.stringify(picker.tree.toJSON())).toContain(t('common.loading'));
      await screen.update(<UsageFilterBar {...props} scopeFilters={inventory(false)} />);
      await picker.update(<>{renderPicker()}</>);
      expect(JSON.stringify(picker.tree.toJSON())).toContain('All projects');
      expect(JSON.stringify(picker.tree.toJSON())).not.toContain(t('common.loading'));
      await screen.update(<UsageFilterBar {...props} scopeFilters={inventory(false, [all, { id: 'project-a', label: 'Project A' }])} />);
      await picker.update(<>{renderPicker()}</>);
      expect(JSON.stringify(picker.tree.toJSON())).toContain('Project A');
    } finally {
      await picker.unmount();
      await screen.unmount();
    }
  });

  it("keeps one chip per scope on a wide screen, opening from the chip's leading edge", async () => {
    Object.assign(viewport, { width: 1280, height: 900 });
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', maxTouchPoints: 0 });
    const screen = await renderBar([]);
    const chips = screen
      .findAllByType(SelectionListFilterChip)
      .map((chip) => chip.props.filter);
    expect(chips.map((chip) => chip.id)).toEqual(['sources', 'agents']);
    // Choosers open from the chip's leading edge (the shared chip's default), never over the navigation.
    const { Popover } = await import('@/components/ui/popover');
    const popovers = screen.findAllByType(Popover);
    expect(popovers.length).toBeGreaterThan(0);
    expect(popovers.every((popover) => (popover.props.portal?.anchorAlign ?? 'start') === 'start')).toBe(true);
    await screen.unmount();
  });

  it('shows the cost basis chip only once its owner reports more than one basis, keeping a chosen basis while it reads (USAGE-DESIGN-PASS-57 #7)', async () => {
    Object.assign(viewport, { width: 1280, height: 900 });
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', maxTouchPoints: 0 });
    const pending = await renderBar([], { costBasisPending: true, metric: null });
    // The default basis while the read is outstanding: nothing to choose yet, so no chip that a settled read removes.
    expect(pending.findAllByType(SelectionListFilterChip).map((chip) => chip.props.filter.id)).not.toContain('costBasis');
    await pending.unmount();
    // A basis the person chose stays in force and in view while the read is outstanding.
    const chosen = await renderBar([], { costBasisPending: true, costBasis: 'reported', metric: null });
    expect(chosen.findAllByType(SelectionListFilterChip).map((chip) => chip.props.filter)
      .find((chip) => chip.id === 'costBasis')?.options.map((option: { id: string }) => option.id)).toEqual(['reported']);
    await chosen.unmount();
    // Answered with one basis only: nothing to choose, so the chip is gone.
    const settled = await renderBar([]);
    expect(settled.findAllByType(SelectionListFilterChip).map((chip) => chip.props.filter.id)).not.toContain('costBasis');
    await settled.unmount();
  });

  // HUNT-UI-STATE C2: the bar recomposes at the phone breakpoint without remounting the cost basis chip, so a chooser
  // open on one side is still open on the other. (Opening it needs the app's mounted command composition; the chip's
  // open state lives in the chip, so its host node surviving is the contract.)
  it('keeps the cost basis chip mounted when the window crosses the phone breakpoint and back', async () => {
    const desktop = () => {
      Object.assign(viewport, { width: 1280, height: 900 });
      vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', maxTouchPoints: 0 });
    };
    desktop();
    const props = { ...barProps([]), costBasisOptions: ['auto', 'reported'] as const, onMetricChange: () => {} };
    const screen = await renderScreen(<UsageFilterBar {...props} />);
    // The renderer keeps one test instance per mounted fiber: the same instance after a resize means no remount.
    const chip = () => screen.findHostByTestId('filters.costBasis');
    const wide = chip();
    expect(wide).toBeTruthy();
    Object.assign(viewport, { width: 390, height: 844 });
    await screen.update(<UsageFilterBar {...props} />);
    expect(screen.findAllByType(SelectionListFilterChip).map((entry) => entry.props.filter.id)).toContain('scope');
    expect(chip()).toBe(wide);
    desktop();
    await screen.update(<UsageFilterBar {...props} />);
    expect(screen.findAllByType(SelectionListFilterChip).map((entry) => entry.props.filter.id)).toContain('sources');
    expect(chip()).toBe(wide);
    await screen.unmount();
  });
});
