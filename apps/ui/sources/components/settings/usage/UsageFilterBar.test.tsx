import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';

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
const { UsageFilterBar } = await import('./UsageFilterBar');
const { USAGE_SCOPE_FILTER_ALL } = await import('./useUsageWidgetPageFilters');

beforeEach(() => {
  Object.assign(viewport, { width: 390, height: 844 });
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone)', maxTouchPoints: 1 });
});

afterEach(() => {
  standardCleanup();
  vi.unstubAllGlobals();
});

type Bar = React.ComponentProps<typeof UsageFilterBar>;
const page = {
  period: '7days',
  scope: { costBasis: 'auto' },
} as const satisfies Readonly<{
  period: Bar['page']['period'];
  scope: Pick<Bar['page']['scope'], 'costBasis'>;
}>;

function renderBar(selections: string[], overrides: Partial<Bar> = {}) {
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
    page: page as unknown as Bar['page'],
    slices: [],
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
  return renderScreen(<UsageFilterBar {...props} {...overrides} />);
}

describe('UsageFilterBar', () => {
  it('collapses every scope filter into one Filters chooser on a phone, keeping each choice and the narrowed count', async () => {
    const selections: string[] = [];
    const screen = await renderBar(selections);
    const chips = screen
      .findAllByType(SelectionListFilterChip)
      .map((chip) => chip.props.filter);
    // Period stays visible; the four scopes become one chip (lab d2filter P).
    expect(chips.map((chip) => chip.id)).toEqual(['scope']);
    expect(chips[0]!).toMatchObject({ active: true, count: '1' });

    const content = await renderScreen(
      <>
        {chips[0]!.renderPopoverContent!({ close: () => {}, maxHeight: 600 })}
      </>,
    );
    const list = content.findAllByType(SelectionList)[0]!;
    const sections = list.props.rootStep.sections;
    expect(
      sections.map((section: { title?: string }) => section.title),
    ).toEqual(['sources', 'agents']);
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

  it('holds the cost basis chip and each unanswered count slot while the usage read is outstanding', async () => {
    Object.assign(viewport, { width: 1280, height: 900 });
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', maxTouchPoints: 0 });
    const pending = await renderBar([], { costBasisPending: true });
    const chips = pending.findAllByType(SelectionListFilterChip).map((chip) => chip.props.filter);
    // The basis in force is the chip's only known choice; the scope chips hold their count slot until it is known.
    expect(chips.find((chip) => chip.id === 'costBasis')?.options.map((option: { id: string }) => option.id)).toEqual(['auto']);
    expect(chips.find((chip) => chip.id === 'sources')).toMatchObject({ reserveCount: true, count: '1' });
    expect(chips.find((chip) => chip.id === 'agents')?.reserveCount).toBeUndefined();
    await pending.unmount();
    // Answered with one basis only: nothing to choose, so the chip is gone.
    const settled = await renderBar([]);
    expect(settled.findAllByType(SelectionListFilterChip).map((chip) => chip.props.filter.id)).not.toContain('costBasis');
    await settled.unmount();
  });
});
