// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import {
  SPECIMEN_ANALYSIS_COMPLETE,
  SPECIMEN_COMPARISON,
  SPECIMEN_WALKTHROUGH,
} from '@/components/dev/changes/walkthroughSpecimenFixture';
import { KeyboardShortcutProvider } from '@/keyboard/KeyboardShortcutProvider';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { executeFindAction } from '@/keyboard/findActionRuntime';

import { buildWalkthroughReading } from './walkthroughReading';

// Focus and Find registration need the actual RNW DOM boundary.
vi.mock('react-native', async () => await import('react-native-web'));
// Renderer leaves are host elements that expose what the reading asked them to draw; Find and reveal decisions run for real.
vi.mock('@/components/ui/code/diff/DiffViewer', () => ({
  DiffViewer: (props: {
    filePath?: string;
    scrollToLineId?: string;
    findRangesByLineId?: ReadonlyMap<string, unknown>;
  }) =>
    React.createElement('div', {
      'data-testid': `diff:${props.filePath}`,
      'data-target': props.scrollToLineId ?? '',
      'data-marked': String(props.findRangesByLineId?.size ?? 0),
    }),
}));
vi.mock('@/components/markdown/MarkdownView', () => ({
  MarkdownView: () => null,
}));
// The web reading mounts code through the web lazy-mount owner; jsdom has no IntersectionObserver, so it mounts at once
// unless a test drives intersection itself.
vi.mock('@/components/ui/performance/LazyMountOnScreen', async () => await import('@/components/ui/performance/LazyMountOnScreen.web'));

const { WalkthroughView } = await import('./WalkthroughView');

const STOPS = SPECIMEN_WALKTHROUGH.stops.map((stop) =>
  stop.id === 'why'
    ? {
        ...stop,
        suggestedQuestions: [
          'Why not key by width at all?',
          'Does the draft survive a rotation?',
        ],
      }
    : stop,
);
const reading = buildWalkthroughReading({
  comparison: SPECIMEN_COMPARISON,
  walkthrough: {
    state: 'complete',
    value: { ...SPECIMEN_WALKTHROUGH, stops: STOPS },
  },
  analysis: SPECIMEN_ANALYSIS_COMPLETE,
  reviewed: null,
});

async function mount(element: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <KeyboardShortcutProvider handlers={{}}>
        <PluginSurfaceFocusEligibilityProvider active>
          {element}
        </PluginSurfaceFocusEligibilityProvider>
      </KeyboardShortcutProvider>,
    );
  });
  return {
    container,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

const find = (input: Record<string, unknown>) =>
  executeFindAction({
    actionId: 'ui.find',
    input: { target: 'walkthrough:test', ...input } as never,
    context: { surface: 'agent' },
  });

describe('Find in the walkthrough reading', () => {
  it('opens the code of a change outside the stops when Find lands on it, and folds it again when Find closes', async () => {
    const view = await mount(
      <WalkthroughView
        reading={reading}
        scopeLabel="This session"
        layout="wide"
        findSurfaceId="walkthrough:test"
      />,
    );
    const tail = () =>
      view.container.querySelector(
        '[data-testid="walkthrough-other-code-yarn.lock"]',
      );
    try {
      expect(tail()).toBeNull();
      let result: Awaited<ReturnType<typeof find>> | undefined;
      await act(async () => {
        result = await find({ op: 'set', query: '0.4.2' });
      });
      expect(result).toMatchObject({
        ok: true,
        result: { status: 'results', total: 2, current: 1 },
      });
      expect(tail()).not.toBeNull();
      const diff = tail()!.querySelector('[data-testid="diff:yarn.lock"]')!;
      expect(diff.getAttribute('data-target')).not.toBe('');
      expect(diff.getAttribute('data-marked')).toBe('2');
      await act(async () => {
        await find({ op: 'close' });
      });
      expect(tail()).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it("offers a stop's suggested questions beside its Ask and hands the chosen one to Ask", async () => {
    const onAsk = vi.fn();
    const view = await mount(
      <WalkthroughView
        reading={reading}
        scopeLabel="This session"
        layout="wide"
        onAsk={onAsk}
      />,
    );
    try {
      const question = view.container.querySelector<HTMLElement>(
        '[data-testid="walkthrough-question-why-1"]',
      );
      expect(question?.textContent).toBe('Does the draft survive a rotation?');
      expect(
        view.container.querySelector(
          '[data-testid="walkthrough-questions-sheet"]',
        ),
      ).toBeNull();
      await act(async () => {
        question!.click();
      });
      expect(onAsk).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'why' }),
        'Does the draft survive a rotation?',
      );
    } finally {
      await view.unmount();
    }
  });
});

describe('A large walkthrough reading', () => {
  const FILE_COUNT = 215;
  const pathOf = (index: number) => `src/gen/file-${String(index).padStart(4, '0')}.ts`;
  const stops = reading.stops.map((stop, stopIndex) => stopIndex !== 0 ? stop : {
      ...stop,
      files: Array.from({ length: FILE_COUNT }, (_, index) => ({
        path: pathOf(index),
        previousPath: null,
        changeKind: 'modified',
        unifiedDiff: `@@ -1,1 +1,1 @@\n-old ${index}\n+needle-${String(index).padStart(4, '0')}\n`,
        rangeLabel: 'L1',
        added: 1,
        removed: 1,
        unavailableReason: null,
      })),
    });
  const large = {
    ...reading,
    stops,
    code: { stops, others: reading.others },
  };

  it('watches the whole reserved body, so a card in view mounts even when its top is scrolled away', async () => {
    const previous = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
    const watched: Element[] = [];
    // The browser boundary: a placeholder with no height of its own is clipped away by the scroller once its top
    // is above the viewport, so only a placeholder that fills the card body can intersect while the body is in view.
    class RecordingIntersectionObserver {
      observe(node: Element) { watched.push(node); }
      disconnect() {}
    }
    Object.assign(globalThis, { IntersectionObserver: RecordingIntersectionObserver });
    const view = await mount(
      <WalkthroughView reading={large} scopeLabel="This session" layout="wide" findSurfaceId="walkthrough:test" />,
    );
    try {
      const card = view.container.querySelector(`[data-testid="walkthrough-hunk-${pathOf(0)}"]`);
      const body = card?.children[1];
      const cardPlaceholders = watched.filter((node) => node.closest('[data-testid^="walkthrough-hunk-src/gen/"]'));
      expect(cardPlaceholders).toHaveLength(FILE_COUNT);
      expect(body?.firstElementChild).toBe(cardPlaceholders[0]);
      expect((cardPlaceholders[0] as HTMLElement).style.minHeight).toBe('inherit');
    } finally {
      await view.unmount();
      Object.assign(globalThis, { IntersectionObserver: previous });
    }
  });

  it('mounts code only for cards near the viewport, and mounts the card Find lands on', async () => {
    const previous = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
    const observed: Array<() => void> = [];
    // The browser's viewport-intersection boundary: the test decides which placeholders are near the viewport.
    class ControlledIntersectionObserver {
      constructor(private readonly callback: (entries: readonly Readonly<{ isIntersecting: boolean }>[]) => void) {}
      observe() { observed.push(() => this.callback([{ isIntersecting: true }])); }
      disconnect() {}
    }
    Object.assign(globalThis, { IntersectionObserver: ControlledIntersectionObserver });
    const view = await mount(
      <WalkthroughView reading={large} scopeLabel="This session" layout="wide" findSurfaceId="walkthrough:test" />,
    );
    const cards = () => view.container.querySelectorAll('[data-testid^="walkthrough-hunk-src/gen/"]');
    const mounted = () => view.container.querySelectorAll('[data-testid^="diff:src/gen/"]');
    try {
      // Every file's card (path, counts, Find count) is there; no code is drawn before it nears the viewport.
      expect(cards()).toHaveLength(FILE_COUNT);
      expect(mounted()).toHaveLength(0);
      const VIEWPORT_CARDS = 3;
      await act(async () => { observed.slice(0, VIEWPORT_CARDS).forEach((intersect) => intersect()); });
      expect(Array.from(mounted(), (node) => node.getAttribute('data-testid'))).toEqual(
        [0, 1, 2].map((index) => `diff:${pathOf(index)}`),
      );
      // Find reaches code that was never drawn and draws the card it lands on, aimed at the match.
      let result: Awaited<ReturnType<typeof find>> | undefined;
      await act(async () => { result = await find({ op: 'set', query: 'needle-0150' }); });
      expect(result).toMatchObject({ ok: true, result: { status: 'results', total: 1, current: 1 } });
      const target = view.container.querySelector(`[data-testid="diff:${pathOf(150)}"]`);
      expect(target?.getAttribute('data-target')).not.toBe('');
      expect(mounted()).toHaveLength(VIEWPORT_CARDS + 1);
    } finally {
      await view.unmount();
      Object.assign(globalThis, { IntersectionObserver: previous });
    }
  });
});
