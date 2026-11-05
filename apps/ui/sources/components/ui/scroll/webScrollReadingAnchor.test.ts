import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, createRenderCommitCounter, renderHook, standardCleanup, useRenderCommitCounter } from '@/dev/testkit';

import { attachWebScrollReadingAnchor, useWebScrollReadingAnchor } from './webScrollReadingAnchor';

afterEach(() => {
  standardCleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// The browser's layout engine is the boundary here: a scroller whose rows sit at offsets the test
// owns, so a breakpoint recomposition (wider rows above the anchor) can be replayed exactly.
type Listener = (event?: { target?: unknown }) => void;

function createLayout(input: {
  rowsAbove: number;
  scrollTop: number;
  width: number;
}) {
  const layout = {
    ...input,
    viewportTop: 50,
    viewportHeight: 600,
    contentHeight: 2000,
  };
  const listeners = new Map<string, Listener[]>();
  const observers = new Set<() => void>();
  const frames = new Map<number, () => void>();
  let frameId = 0;
  const counts = {
    boundingRects: 0,
    elementFromPoint: 0,
    activeElement: 0,
    contains: 0,
    dimensions: 0,
    scrollTop: 0,
  };
  const focused = {
    isConnected: true,
    getBoundingClientRect: () => {
      counts.boundingRects += 1;
      const top = layout.viewportTop + layout.rowsAbove - layout.scrollTop;
      return { top, height: 40, width: 300 };
    },
  };
  const content = {};
  const scroller = {
    get scrollTop() {
      counts.scrollTop += 1;
      return layout.scrollTop;
    },
    set scrollTop(value: number) {
      layout.scrollTop = Math.max(
        0,
        Math.min(value, layout.contentHeight - layout.viewportHeight),
      );
    },
    get clientWidth() {
      counts.dimensions += 1;
      return layout.width;
    },
    get clientHeight() {
      return layout.viewportHeight;
    },
    get scrollHeight() {
      counts.dimensions += 1;
      return layout.contentHeight + layout.rowsAbove;
    },
    getBoundingClientRect: () => {
      counts.boundingRects += 1;
      return {
        top: layout.viewportTop,
        left: 0,
        height: layout.viewportHeight,
        width: layout.width,
      };
    },
    contains: (node: unknown) => {
      counts.contains += 1;
      return node === focused;
    },
    addEventListener: (type: string, listener: Listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    removeEventListener: (type: string, listener: Listener) => {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((l) => l !== listener),
      );
    },
  };
  const win = {
    requestAnimationFrame: (callback: () => void) => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
    addEventListener: scroller.addEventListener,
    removeEventListener: scroller.removeEventListener,
    document: {
      get activeElement(): unknown {
        counts.activeElement += 1;
        return focused;
      },
      elementFromPoint: (): unknown => {
        counts.elementFromPoint += 1;
        return null;
      },
    },
    ResizeObserver: class {
      constructor(private readonly callback: () => void) {
        observers.add(callback);
      }
      observe() {}
      disconnect() { observers.delete(this.callback); }
    },
  };
  return {
    layout,
    scroller,
    content,
    win,
    focused,
    counts,
    resetCounts: () => {
      for (const key of Object.keys(counts) as (keyof typeof counts)[]) counts[key] = 0;
    },
    emit: (type: string) =>
      (listeners.get(type) ?? []).forEach((listener) => listener({ target: scroller })),
    relayout: () => observers.forEach((callback) => callback()),
    flushFrames: () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); },
    focusedOffset: () =>
      focused.getBoundingClientRect().top - layout.viewportTop,
  };
}

describe('attachWebScrollReadingAnchor', () => {
  it('preserves the reading position when browser scroll clamping precedes the resize observer', () => {
    const page = createLayout({ rowsAbove: 400, scrollTop: 160, width: 1440 });
    const detach = attachWebScrollReadingAnchor(page);
    const offset = page.focusedOffset();
    page.emit('resize');
    page.layout.width = 390;
    page.layout.scrollTop = 0;
    page.emit('scroll');
    page.emit('scrollend');
    page.relayout();
    expect(page.layout.scrollTop).toBe(160);
    expect(page.focusedOffset()).toBe(offset);
    detach();
  });

  it('keeps a native relayout scroll until the delayed viewport resize is observed', () => {
    const page = createLayout({ rowsAbove: 400, scrollTop: 160, width: 1440 });
    const detach = attachWebScrollReadingAnchor(page);
    const offset = page.focusedOffset();
    page.emit('resize');
    page.layout.width = 390;
    page.relayout();
    // Chrome's layout scroll arrives before its viewport-height update, without scrollend.
    page.layout.scrollTop = 0;
    page.emit('scroll');
    page.layout.viewportHeight -= 56;
    page.relayout();
    page.emit('scroll');
    page.emit('scrollend');
    expect(page.layout.scrollTop).toBe(160);
    expect(page.focusedOffset()).toBe(offset);
    detach();
  });

  it('restores a native scroll after the final resize callback without waiting for another resize', () => {
    const page = createLayout({ rowsAbove: 400, scrollTop: 160, width: 390 });
    const detach = attachWebScrollReadingAnchor(page);
    const offset = page.focusedOffset();
    page.emit('resize');
    page.layout.width = 1440;
    page.relayout();
    page.layout.scrollTop = 0;
    page.emit('scroll'); // Layout adjustment, without the scrollend a completed reveal emits.
    page.flushFrames();
    expect(page.layout.scrollTop).toBe(160);
    expect(page.focusedOffset()).toBe(offset);
    detach();
  });

  it.each([1, 100])('does no anchor queries, layout reads or renders over %i ordinary scroll events', async (events) => {
    const page = createLayout({ rowsAbove: 400, scrollTop: 180, width: 1440 });
    vi.stubGlobal('window', page.win);
    const renders = createRenderCommitCounter();
    const hook = await renderHook(() => {
      useRenderCommitCounter(renders);
      const ref = React.useRef({
        getScrollableNode: () => page.scroller,
        getInnerViewNode: () => page.content,
      });
      useWebScrollReadingAnchor(ref, true);
    });
    renders.reset();
    page.resetCounts();
    act(() => {
      for (let i = 0; i < events; i += 1) {
        page.layout.scrollTop += 1;
        page.emit('scroll');
      }
    });
    const ordinary = { ...page.counts, ...renders.read() };
    const offset = page.layout.rowsAbove - page.layout.scrollTop;
    page.resetCounts();
    act(() => {
      page.layout.width = 390;
      page.layout.rowsAbove = 760;
      page.relayout();
      page.emit('scroll'); // The restore's own echo must also be cheap.
    });
    const resized = { ...page.counts, ...renders.read() };
    // Keep measured baseline and GREEN counts in the runner artifact without production telemetry.
    console.info('scroll-cost', JSON.stringify({ events, ordinary, resized }));
    expect(page.layout.rowsAbove - page.layout.scrollTop).toBe(offset);
    expect(ordinary).toEqual({
      boundingRects: 0, elementFromPoint: 0, activeElement: 0, contains: 0,
      dimensions: 0, scrollTop: events, renders: 0, commits: 0,
    });
    expect(resized.boundingRects).toBe(3);
    expect(resized.elementFromPoint).toBe(0);
    expect(resized.activeElement).toBe(0);
    expect(resized.contains).toBe(0);
    expect(renders.read()).toEqual({ renders: 0, commits: 0 });
    // Detach while a native layout scroll has queued a restoration.
    act(() => { page.layout.scrollTop = 0; page.emit('scroll'); });
    await hook.unmount();
    page.resetCounts();
    page.emit('scroll');
    page.emit('scrollend');
    page.relayout();
    page.flushFrames();
    expect(page.counts).toEqual({
      boundingRects: 0, elementFromPoint: 0, activeElement: 0, contains: 0,
      dimensions: 0, scrollTop: 0,
    });
  });

  it('samples the newly visible rows at scrollend before a width change', () => {
    const page = createLayout({ rowsAbove: 400, scrollTop: 180, width: 1440 });
    const nextRow = {
      isConnected: true,
      getBoundingClientRect: () => ({
        top: page.layout.viewportTop + page.layout.rowsAbove + 400 - page.layout.scrollTop,
        height: 300,
        width: 300,
      }),
    };
    // Only the layout/hit-test boundary is replaced; the real scroll owner chooses its anchors.
    vi.spyOn(page.win.document, 'activeElement', 'get').mockReturnValue(null);
    vi.spyOn(page.win.document, 'elementFromPoint').mockImplementation(() =>
      page.layout.scrollTop < 500 ? page.focused : nextRow);
    vi.spyOn(page.scroller, 'contains').mockImplementation((node) =>
      node === page.focused || node === nextRow);
    const detach = attachWebScrollReadingAnchor(page);
    page.layout.scrollTop = 700;
    page.emit('scroll');
    page.emit('scrollend');
    page.focused.isConnected = false;
    const offset = nextRow.getBoundingClientRect().top - page.layout.viewportTop;

    page.layout.width = 390;
    page.layout.rowsAbove = 760;
    page.relayout();
    expect(nextRow.getBoundingClientRect().top - page.layout.viewportTop).toBe(offset);
    expect(page.layout.scrollTop).toBe(1060);
    detach();
  });

  it('keeps the focused row where it was read across a phone and back recomposition', () => {
    const page = createLayout({ rowsAbove: 400, scrollTop: 180, width: 1440 });
    const detach = attachWebScrollReadingAnchor({
      scroller: page.scroller,
      content: page.content,
      win: page.win,
    });
    page.emit('scroll');
    const offsetBefore = page.focusedOffset();

    // Phone: narrower rows reflow and recomposed header rows stack above the focused input.
    page.layout.width = 390;
    page.layout.rowsAbove = 760;
    page.relayout();
    expect(page.focusedOffset()).toBe(offsetBefore);

    // The browser clamps or anchors on its own afterwards; the next scroll event must not re-read that.
    page.emit('scroll');
    page.layout.width = 1440;
    page.layout.rowsAbove = 400;
    page.relayout();
    expect(page.focusedOffset()).toBe(offsetBefore);
    expect(page.layout.scrollTop).toBe(180);
    detach();
  });

  it('takes a scroll made after a recomposition as the new reading position', () => {
    const page = createLayout({ rowsAbove: 400, scrollTop: 180, width: 1440 });
    attachWebScrollReadingAnchor({ scroller: page.scroller, content: page.content, win: page.win });
    page.emit('scroll');
    page.layout.width = 390;
    page.relayout();

    // A reveal (or the person) scrolls; no wheel or touch is involved for a programmatic scroll.
    page.layout.scrollTop = 20;
    page.emit('scroll');
    page.emit('scrollend'); // A completed reveal establishes the new reading position.
    page.flushFrames();
    const offsetAfterScroll = page.focusedOffset();
    // A content-only resize keeps that new position rather than pulling back to the old one.
    page.relayout();
    expect(page.layout.scrollTop).toBe(20);
    page.layout.width = 1440;
    page.relayout();
    expect(page.focusedOffset()).toBe(offsetAfterScroll);
  });

  it('holds the next visible row when the top-visible row is recomposed away', () => {
    // Unfocused, the top-visible row is the wide header line that the phone layout replaces with
    // chips; the step below it survives and is what the person was reading.
    const layout = { scrollTop: 180, width: 1440, headerAbove: 120, viewportTop: 50 };
    const listeners = new Map<string, Array<() => void>>();
    const observers: Array<() => void> = [];
    const header = {
      isConnected: true,
      parentElement: null,
      getBoundingClientRect: () => ({ top: layout.viewportTop + 170 - layout.scrollTop, height: 60, width: 300 }),
    };
    const step = {
      isConnected: true,
      parentElement: null,
      getBoundingClientRect: () => ({
        top: layout.viewportTop + 170 + layout.headerAbove - layout.scrollTop,
        height: 400,
        width: 300,
      }),
    };
    const scroller = {
      get scrollTop() { return layout.scrollTop; },
      set scrollTop(value: number) { layout.scrollTop = Math.max(0, value); },
      get clientWidth() { return layout.width; },
      get scrollHeight() { return 170 + layout.headerAbove + 400; },
      getBoundingClientRect: () => ({ top: layout.viewportTop, left: 0, height: 600, width: layout.width }),
      contains: (node: unknown) => node === header || node === step,
      addEventListener: (type: string, listener: () => void) => {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      },
      removeEventListener: () => {},
    };
    const win = {
      requestAnimationFrame: () => 1,
      cancelAnimationFrame: () => {},
      addEventListener: scroller.addEventListener,
      removeEventListener: scroller.removeEventListener,
      document: {
        activeElement: null,
        elementFromPoint: (_x: number, y: number) => {
          const at = (node: typeof header) => {
            const rect = node.getBoundingClientRect();
            return node.isConnected && y >= rect.top && y < rect.top + rect.height;
          };
          return at(header) ? header : at(step) ? step : null;
        },
      },
      ResizeObserver: class {
        constructor(callback: () => void) { observers.push(callback); }
        observe() {}
        disconnect() {}
      },
    };
    attachWebScrollReadingAnchor({ scroller, content: null, win });
    listeners.get('scroll')?.forEach((listener) => listener());
    const stepOffset = () => step.getBoundingClientRect().top - layout.viewportTop;
    const before = stepOffset();

    layout.width = 390;
    header.isConnected = false;
    layout.headerAbove = 380;
    observers.forEach((callback) => callback());
    expect(stepOffset()).toBe(before);
  });
});
