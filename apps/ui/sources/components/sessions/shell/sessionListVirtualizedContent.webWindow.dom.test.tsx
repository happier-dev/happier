// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildSessionListIndexNodeId } from '@/sync/domains/sessionList/sessionListIndex';

import type { SessionListVirtualizedNode } from './sessionListVirtualizedContent';

// The browser list runtime is the boundary under test, so react-native resolves to react-native-web.
vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('./sessionListChrome', () => ({
  SessionsListHeader: () => null,
}));
vi.mock('./NewSessionDraftsSection', () => ({
  NewSessionDraftsSection: () => null,
}));
vi.mock('./SessionListViewEmptyState', () => ({
  SessionListViewEmptyState: () => null,
}));
vi.mock('@/components/ui/empty/EmptyState', () => ({ EmptyState: () => null }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

const VIEWPORT_HEIGHT = 400;
const ROW_COUNT = 240;
const PLACEHOLDER_ROW_HEIGHT = 34;
const HYDRATED_ROW_HEIGHT = 48;
const SCHEDULED_SECTION_HEIGHT = 1200;
// The list's bottom padding is the only content that may sit under the viewport without a row.
const MAX_UNCOVERED_GAP = 8;

/**
 * Minimal browser box model for jsdom. Heights come from `data-row-height` and explicit `height`
 * styles (spacers, content boxes); in-flow children stack; absolutely positioned children sit at their
 * `top`. A ResizeObserver reports a size change only, exactly as a browser does: it never reports a
 * cell that merely moved because content above it grew.
 */
function pixels(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && value.endsWith('px') ? parsed : null;
}

const scrollerByElement = new WeakMap<HTMLElement, boolean>();

function isScroller(element: HTMLElement): boolean {
  // React Native Web resolves its ScrollView styles to classes; Legend writes them inline.
  const known = scrollerByElement.get(element);
  if (known !== undefined) return known;
  const { overflowY } = window.getComputedStyle(element);
  const scroller = overflowY === 'auto' || overflowY === 'scroll';
  scrollerByElement.set(element, scroller);
  return scroller;
}

function isAbsolute(element: HTMLElement): boolean {
  return element.style.position === 'absolute';
}

function heightOf(element: HTMLElement): number {
  if (element.dataset.rowHeight) return Number(element.dataset.rowHeight);
  if (element.id === 'host') return VIEWPORT_HEIGHT;
  if (isScroller(element)) return VIEWPORT_HEIGHT;
  const explicit = pixels(element.style.height);
  if (explicit != null) return explicit;
  let sum = 0;
  for (const child of Array.from(element.children) as HTMLElement[]) {
    if (!isAbsolute(child)) sum += heightOf(child);
  }
  return sum;
}

function topOf(element: HTMLElement): number {
  const parent = element.parentElement;
  if (!parent) return 0;
  const parentTop = topOf(parent);
  if (isAbsolute(element)) {
    const top = pixels(element.style.top);
    const translate = /translateY\((-?[\d.]+)px\)/.exec(
      element.style.transform,
    )?.[1];
    return parentTop + (top ?? (translate ? Number(translate) : 0));
  }
  let before = 0;
  for (const sibling of Array.from(parent.children) as HTMLElement[]) {
    if (sibling === element) break;
    if (!isAbsolute(sibling)) before += heightOf(sibling);
  }
  return parentTop + before;
}

type ObserverRecord = {
  callback: ResizeObserverCallback;
  sizes: Map<Element, string>;
};
const observers = new Set<ObserverRecord>();

function sizeKey(element: HTMLElement): string {
  return `${heightOf(element)}`;
}

function flushResizeObservers(): void {
  for (const observer of observers) {
    const changed: ResizeObserverEntry[] = [];
    for (const [element, previous] of observer.sizes) {
      if (!element.isConnected) continue;
      const key = sizeKey(element as HTMLElement);
      if (key === previous) continue;
      observer.sizes.set(element, key);
      const height = heightOf(element as HTMLElement);
      changed.push({
        borderBoxSize: [],
        contentBoxSize: [],
        contentRect: {
          width: 360,
          height,
          top: 0,
          left: 0,
          bottom: height,
          right: 360,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        },
        devicePixelContentBoxSize: [],
        target: element,
      } as ResizeObserverEntry);
    }
    if (changed.length > 0) observer.callback(changed, {} as ResizeObserver);
  }
}

function rectOf(element: HTMLElement): DOMRectReadOnly {
  const height = heightOf(element);
  const top = topOf(element);
  return {
    x: 0,
    y: top,
    top,
    left: 0,
    bottom: top + height,
    right: 360,
    width: 360,
    height,
    toJSON: () => ({}),
  };
}

type Phase = 'placeholders' | 'hydrated';

function buildNodes(): SessionListVirtualizedNode[] {
  return Array.from({ length: ROW_COUNT }, (_, index) => ({
    id: buildSessionListIndexNodeId({
      type: 'session',
      sessionId: `s${index}`,
      serverId: 'home',
    }),
    kind: 'session' as const,
    rowViewModel: null,
  }));
}

function rowHeightFor(phase: Phase, index: number): number {
  // Hydration turns some encrypted placeholders into titled rows with a subtitle line.
  return phase === 'hydrated' && index % 3 !== 0
    ? HYDRATED_ROW_HEIGHT
    : PLACEHOLDER_ROW_HEIGHT;
}

describe('session list web window while row and header heights change', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    observers.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    class TestResizeObserver implements ResizeObserver {
      private readonly record: ObserverRecord = {
        callback: () => {},
        sizes: new Map(),
      };
      constructor(callback: ResizeObserverCallback) {
        this.record.callback = callback;
        observers.add(this.record);
      }
      disconnect(): void {
        this.record.sizes.clear();
        observers.delete(this.record);
      }
      observe(target: Element): void {
        this.record.sizes.set(target, '');
      }
      unobserve(target: Element): void {
        this.record.sizes.delete(target);
      }
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    vi.stubGlobal(
      'requestAnimationFrame',
      (callback: FrameRequestCallback) =>
        setTimeout(() => callback(Date.now()), 0) as unknown as number,
    );
    vi.stubGlobal('cancelAnimationFrame', (handle: number) =>
      clearTimeout(handle),
    );
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        return rectOf(this);
      },
    );
    const geometry = {
      offsetHeight: (element: HTMLElement) => heightOf(element),
      offsetWidth: () => 360,
      offsetTop: (element: HTMLElement) => topOf(element),
      offsetLeft: () => 0,
      offsetParent: () => null,
      clientHeight: (element: HTMLElement) => heightOf(element),
      clientWidth: () => 360,
      clientTop: () => 0,
      clientLeft: () => 0,
      scrollHeight: (element: HTMLElement) =>
        Math.max(
          heightOf(element),
          (Array.from(element.children) as HTMLElement[]).reduce(
            (sum, child) => sum + (isAbsolute(child) ? 0 : heightOf(child)),
            0,
          ),
        ),
    };
    for (const [name, read] of Object.entries(geometry)) {
      Object.defineProperty(HTMLElement.prototype, name, {
        configurable: true,
        get() {
          return read(this);
        },
      });
    }
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      writable: true,
      value() {},
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    for (const name of [
      'offsetHeight',
      'offsetWidth',
      'offsetTop',
      'offsetLeft',
      'offsetParent',
      'clientHeight',
      'clientWidth',
      'clientTop',
      'clientLeft',
      'scrollHeight',
    ]) {
      Reflect.deleteProperty(HTMLElement.prototype, name);
    }
  });

  async function settle(): Promise<void> {
    for (let pass = 0; pass < 10; pass += 1) {
      await act(async () => {
        flushResizeObservers();
        await vi.runOnlyPendingTimersAsync();
      });
    }
  }

  async function renderList(
    params: Readonly<{ phase: Phase; scheduledHeight: number }>,
  ) {
    const { SessionListVirtualizedContent } =
      await import('./sessionListVirtualizedContent');
    const nodes = buildNodes();
    const indexById = new Map(nodes.map((node, index) => [node.id, index]));
    await act(async () => {
      root.render(
        <div id="host">
          <SessionListVirtualizedContent
            nodes={nodes}
            rowHeight={PLACEHOLDER_ROW_HEIGHT}
            safeAreaBottom={0}
            renderItem={({ item }) => (
              <div
                data-session-row=""
                data-row-height={rowHeightFor(
                  params.phase,
                  indexById.get(item.id) ?? 0,
                )}
              />
            )}
            rowExtraData={params.phase}
            onStopScrollEventPropagationOnWeb={() => {}}
            showDrafts={false}
            showReminders={false}
            scheduledSection={<div data-row-height={params.scheduledHeight} />}
          />
        </div>,
      );
    });
    await settle();
  }

  async function scrollTo(offset: number): Promise<void> {
    const scroller = Array.from(
      container.querySelectorAll<HTMLElement>('div'),
    ).find(isScroller);
    expect(scroller).toBeDefined();
    Object.defineProperty(scroller!, 'scrollTop', {
      configurable: true,
      writable: true,
      value: offset,
    });
    await act(async () => {
      scroller!.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await settle();
  }

  /** The longest stretch of the viewport, [offset, offset + viewport), that no mounted row covers. */
  function longestUncoveredGap(offset: number): number {
    const spans = Array.from(
      container.querySelectorAll<HTMLElement>('[data-session-row]'),
    )
      .map((row) => [topOf(row), topOf(row) + heightOf(row)] as const)
      .sort((left, right) => left[0] - right[0]);
    let cursor = offset;
    let longest = 0;
    for (const [top, bottom] of spans) {
      if (bottom <= cursor) continue;
      longest = Math.max(longest, top - cursor);
      cursor = Math.max(cursor, bottom);
      if (cursor >= offset + VIEWPORT_HEIGHT) return longest;
    }
    return Math.max(longest, offset + VIEWPORT_HEIGHT - cursor);
  }

  it('keeps a row under every part of the viewport after the header grows and rows hydrate', async () => {
    await renderList({ phase: 'placeholders', scheduledHeight: 0 });
    // The reader scrolls through the list, so every window is measured at its placeholder layout.
    for (
      let offset = 0;
      offset <= ROW_COUNT * PLACEHOLDER_ROW_HEIGHT - VIEWPORT_HEIGHT;
      offset += 300
    ) {
      await scrollTo(offset);
    }
    await scrollTo(0);

    // Upcoming work hydrates above the rows and the placeholders become titled rows.
    await renderList({
      phase: 'hydrated',
      scheduledHeight: SCHEDULED_SECTION_HEIGHT,
    });

    const contentHeight =
      SCHEDULED_SECTION_HEIGHT +
      Array.from({ length: ROW_COUNT }, (_, index) =>
        rowHeightFor('hydrated', index),
      ).reduce((a, b) => a + b, 0);
    const gaps: Array<readonly [number, number]> = [];
    for (
      let offset = SCHEDULED_SECTION_HEIGHT;
      offset <= contentHeight - VIEWPORT_HEIGHT;
      offset += 250
    ) {
      await scrollTo(offset);
      gaps.push([offset, longestUncoveredGap(offset)]);
    }

    expect(gaps.filter(([, gap]) => gap > MAX_UNCOVERED_GAP)).toEqual([]);
  });
});
