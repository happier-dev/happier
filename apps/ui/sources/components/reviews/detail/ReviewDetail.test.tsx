import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { PluginUiScrollActivityProvider, type PluginUiScrollActivityTracker } from '@happier-dev/plugin-ui/advanced';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';

import {
  ReviewFindingsList,
  type ReviewFindingsListRow,
} from './ReviewFindingsList';
import {
  ReviewSubmitPanel,
  type ReviewSubmitResult,
} from './ReviewSubmitPanel';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);

const ROWS: readonly ReviewFindingsListRow[] = [
  { rowId: 'nit', severity: 'nit', decision: 'reject' },
  { rowId: 'blocker-a', severity: 'blocker', decision: 'undecided' },
  { rowId: 'high', severity: 'high', decision: 'accept' },
  { rowId: 'blocker-b', severity: 'blocker', decision: 'accept' },
];

describe('ReviewFindingsList', () => {
  it('windows ten thousand findings in the existing physical page and reaches the last finding', async () => {
    const rows: readonly ReviewFindingsListRow[] = Array.from({ length: 10_000 }, (_, index) => ({
      rowId: `window-${index}`, severity: 'high', decision: 'undecided',
    }));
    let window = { top: 0, bottom: 500 };
    const listeners = new Set<() => void>();
    // The physical page's viewport is the platform boundary; List keeps its real windowing logic.
    const tracker: PluginUiScrollActivityTracker = {
      onScroll() {}, onLayout() {}, onContentSizeChange() {},
      subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      getWindow: () => window, measureSpan: async () => ({ top: 0 }),
      invalidateLayout() {}, getLayoutRevision: () => 0,
    };
    const screen = await renderScreen(<PluginUiScrollActivityProvider tracker={tracker}>
      <ReviewFindingsList rows={rows} renderRow={rowId => <RowProbe rowId={rowId} />} />
    </PluginUiScrollActivityProvider>);
    try {
      expect(screen.findByTestId('row:window-0')).not.toBeNull();
      expect(screen.findByTestId('row:window-9999')).toBeNull();
      expect(screen.tree.root.findAll(node => node.type === RowProbeHost).length).toBeLessThan(rows.length);
      await act(async () => {
        const end = rows.length * HAPPIER_PAGE_METRICS.rowMinHeightPx;
        window = { top: end - 500, bottom: end + 500 };
        listeners.forEach(listener => listener());
      });
      expect(screen.findByTestId('row:window-9999')).not.toBeNull();
      expect(screen.tree.root.findAll(node => node.type === RowProbeHost).length).toBeLessThan(rows.length);
    } finally { await screen.unmount(); }
  });
  it('groups ten thousand loaded findings with one counting pass and one grouping pass', async () => {
    const rows: readonly ReviewFindingsListRow[] = Array.from({ length: 10_000 }, (_, index) => ({
      rowId: `scale-${index}`, severity: 'high', decision: 'undecided',
    }));
    const measuredRows = new WeakSet<object>(rows);
    const originalIterator = Array.prototype[Symbol.iterator];
    let rowVisits = 0;
    // Instrument the real iterator without replacing its behavior: copying earlier groups visits
    // these same row objects again, even though it does not reread their properties.
    Reflect.set(Array.prototype, Symbol.iterator, function* (this: unknown[]) {
      for (const value of originalIterator.call(this)) {
        if (typeof value === 'object' && value !== null && measuredRows.has(value)) rowVisits += 1;
        yield value;
      }
    });
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    try {
      screen = await renderScreen(<ReviewFindingsList rows={rows} renderRow={() => null} />);
    } finally {
      Reflect.set(Array.prototype, Symbol.iterator, originalIterator);
    }
    try {
      expect(groupOrder(screen!)).toEqual(['high']);
      expect(rowVisits).toBe(rows.length * 2);
    } finally { await screen?.unmount(); }
  });
  it('keeps selected finding identities while the person filters the list', async () => {
    function SelectedFindings() {
      const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set());
      return <ReviewFindingsList rows={ROWS} renderRow={rowId => <RowProbe rowId={rowId} />}
        selection={{ selectedRowIds: selected, onToggle: rowId => setSelected(current => {
          const next = new Set(current);
          if (next.has(rowId)) next.delete(rowId); else next.add(rowId);
          return next;
        }) }} />;
    }
    const screen = await renderScreen(<SelectedFindings />);
    try {
      expect(screen.findHostByTestId('review-findings:select:blocker-a')?.props['aria-checked']).toBe(false);
      await screen.pressByTestIdAsync('review-findings:select:blocker-a');
      await screen.pressByTestIdAsync('review-findings:filter:accept');
      await screen.pressByTestIdAsync('review-findings:select:blocker-b');
      await screen.pressByTestIdAsync('review-findings:filter:all');
      expect(screen.findHostByTestId('review-findings:select:blocker-a')?.props.accessibilityState.checked).toBe(true);
      expect(screen.findHostByTestId('review-findings:select:blocker-b')?.props.accessibilityState.checked).toBe(true);
      expect(screen.findHostByTestId('review-findings:select:blocker-a')?.props['aria-checked']).toBe(true);
      expect(screen.findHostByTestId('review-findings:select:blocker-b')?.props['aria-checked']).toBe(true);
      expect(screen.findHostByTestId('review-findings:select:high')?.props.accessibilityState.checked).toBe(false);
    } finally { await screen.unmount(); }
  });
  it('groups rows by severity, most severe first, and filters them by decision in one press', async () => {
    const screen = await renderScreen(
      <ReviewFindingsList
        rows={ROWS}
        renderRow={(rowId) => <RowProbe rowId={rowId} />}
      />,
    );
    expect(groupOrder(screen)).toEqual(['blocker', 'high', 'nit']);
    expect(screen.findByTestId('row:blocker-a')).not.toBeNull();
    // A decision nobody took offers no filter; the ones taken do.
    expect(screen.findByTestId('review-findings:filter:defer')).toBeNull();
    await screen.pressByTestIdAsync('review-findings:filter:accept');
    expect(groupOrder(screen)).toEqual(['blocker', 'high']);
    expect(screen.findByTestId('row:blocker-a')).toBeNull();
    expect(screen.findByTestId('row:blocker-b')).not.toBeNull();
    await screen.unmount();
  });
});

describe('ReviewFindingsList empty', () => {
  it('draws nothing when there are no findings: the page glance already says so', async () => {
    const screen = await renderScreen(<ReviewFindingsList rows={[]} renderRow={() => null} />);
    expect(screen.findByTestId('review-findings:empty')).toBeNull();
    expect(screen.findByTestId('review-findings')).toBeNull();
    await screen.unmount();
  });
});

describe('ReviewSubmitPanel', () => {
  it('sends the chosen verdict with the trimmed summary and keeps both when the send fails', async () => {
    const sent: unknown[] = [];
    let result: ReviewSubmitResult = { ok: false, message: 'Not sent' };
    const screen = await renderScreen(
      <ReviewSubmitPanel
        roundOrdinal={2}
        onCancel={() => undefined}
        onSubmit={async (input) => {
          sent.push(input);
          return result;
        }}
      />,
    );
    await screen.pressByTestIdAsync('review-submit:verdict:request_changes');
    await act(async () => {
      screen.changeTextByTestId('review-submit:body',
        '  Keep the draft when the app closes.  ');
    });
    await screen.pressByTestIdAsync('review-submit:send');
    expect(sent).toEqual([
      {
        verdict: 'request_changes',
        body: 'Keep the draft when the app closes.',
      },
    ]);
    // The failure keeps what the person wrote, so the retry sends the same review.
    expect(screen.findHostByTestId('review-submit:body')?.props.value).toBe(
      '  Keep the draft when the app closes.  ',
    );
    result = { ok: true };
    await screen.pressByTestIdAsync('review-submit:send');
    expect(sent).toHaveLength(2);
    await screen.unmount();
  });

  it('sends no summary when none was written', async () => {
    const sent: unknown[] = [];
    const screen = await renderScreen(
      <ReviewSubmitPanel
        roundOrdinal={1}
        onCancel={() => undefined}
        onSubmit={async (input) => {
          sent.push(input);
          return { ok: true };
        }}
      />,
    );
    await screen.pressByTestIdAsync('review-submit:send');
    expect(sent).toEqual([{ verdict: 'approve', body: undefined }]);
    await screen.unmount();
  });
});

function RowProbe(props: Readonly<{ rowId: string }>) {
  return <RowProbeHost testID={`row:${props.rowId}`} />;
}
const RowProbeHost = 'RowProbe' as unknown as React.ComponentType<{
  testID: string;
}>;

function groupOrder(
  screen: Awaited<ReturnType<typeof renderScreen>>,
): string[] {
  return screen.tree.root
    .findAll(
      (node) =>
        typeof node.props.testID === 'string' &&
        node.props.testID.startsWith('review-findings:group:') &&
        typeof node.type !== 'string',
    )
    .map((node) =>
      String(node.props.testID).slice('review-findings:group:'.length),
    )
    .filter((value, index, all) => all.indexOf(value) === index);
}
