import type { Page } from '@playwright/test';

export type DragDispatchResult = Readonly<{
  ok: boolean;
  scrollTopBefore: number | null;
  scrollTopAfter: number | null;
  error?: string;
}>;

async function dispatchSessionTreePointerDrag(page: Page, params: Readonly<{
  sourceTestId: string;
  sourceChildTestId?: string;
  targetTestId: string;
  targetEdge: 'top' | 'middle' | 'bottom';
  scrollDuringDrag?: 'target-into-view' | 'autoscroll-bottom';
}>): Promise<DragDispatchResult> {
  await page.getByTestId(params.sourceTestId).scrollIntoViewIfNeeded();
  await page.getByTestId(params.sourceTestId).hover();

  if (!params.scrollDuringDrag) {
    await page.getByTestId(params.targetTestId).scrollIntoViewIfNeeded();
  }

  const result = await page.evaluate(async ({
    sourceTestId,
    sourceChildTestId,
    targetTestId,
    targetEdge,
    scrollDuringDrag,
  }) => {
    const byTestId = (testId: string): HTMLElement | null => (
      document.querySelector<HTMLElement>(`[data-testid="${CSS.escape(testId)}"]`)
    );
    const findScrollableAncestor = (element: HTMLElement): HTMLElement | null => {
      let current: HTMLElement | null = element.parentElement;
      while (current) {
        if (current.scrollHeight > current.clientHeight + 8) return current;
        current = current.parentElement;
      }
      return document.scrollingElement instanceof HTMLElement ? document.scrollingElement : null;
    };
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const dispatchPointer = (
      target: EventTarget,
      type: string,
      point: Readonly<{ x: number; y: number }>,
      buttons: number,
    ) => {
      target.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 77,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons,
        clientX: point.x,
        clientY: point.y,
        screenX: point.x,
        screenY: point.y,
      }));
    };
    const pointForTarget = (element: HTMLElement, edge: 'top' | 'middle' | 'bottom') => {
      const rect = element.getBoundingClientRect();
      const y = edge === 'top'
        ? rect.top + 4
        : edge === 'bottom'
          ? rect.bottom - 4
          : rect.top + rect.height / 2;
      return {
        x: rect.left + Math.min(Math.max(rect.width * 0.5, 8), Math.max(rect.width - 8, 8)),
        y,
      };
    };

    const sourceContainer = byTestId(sourceTestId);
    if (!sourceContainer) return { ok: false, scrollTopBefore: null, scrollTopAfter: null, error: `missing ${sourceTestId}` };
    const source = sourceChildTestId
      ? sourceContainer.querySelector<HTMLElement>(`[data-testid="${CSS.escape(sourceChildTestId)}"]`)
      : sourceContainer;
    if (!source) return { ok: false, scrollTopBefore: null, scrollTopAfter: null, error: `missing ${sourceChildTestId ?? sourceTestId}` };

    const scrollable = findScrollableAncestor(sourceContainer);
    const scrollTopBefore = scrollable?.scrollTop ?? null;
    const sourcePoint = pointForTarget(source, 'middle');
    dispatchPointer(source, 'pointerdown', sourcePoint, 1);
    await wait(35);
    dispatchPointer(window, 'pointermove', { x: sourcePoint.x + 2, y: sourcePoint.y + 10 }, 1);
    await wait(35);

    if (scrollDuringDrag === 'target-into-view') {
      const targetBeforeScroll = byTestId(targetTestId);
      targetBeforeScroll?.scrollIntoView({ block: 'center', inline: 'nearest' });
      await wait(80);
    } else if (scrollDuringDrag === 'autoscroll-bottom' && scrollable) {
      const rect = scrollable.getBoundingClientRect();
      dispatchPointer(window, 'pointermove', { x: rect.left + rect.width / 2, y: rect.bottom - 6 }, 1);
      await wait(900);
    }

    const target = byTestId(targetTestId);
    if (!target) {
      dispatchPointer(window, 'pointerup', sourcePoint, 0);
      return { ok: false, scrollTopBefore, scrollTopAfter: scrollable?.scrollTop ?? null, error: `missing ${targetTestId}` };
    }
    const targetPoint = pointForTarget(target, targetEdge);
    for (const fraction of [0.35, 0.7, 1]) {
      dispatchPointer(window, 'pointermove', {
        x: sourcePoint.x + (targetPoint.x - sourcePoint.x) * fraction,
        y: sourcePoint.y + (targetPoint.y - sourcePoint.y) * fraction,
      }, 1);
      await wait(45);
    }
    dispatchPointer(window, 'pointerup', targetPoint, 0);
    await wait(160);
    return { ok: true, scrollTopBefore, scrollTopAfter: scrollable?.scrollTop ?? null };
  }, params);

  if (!result.ok) throw new Error(result.error ?? 'drag dispatch failed');
  await page.waitForTimeout(250);
  return result;
}

export async function dragSessionToTarget(page: Page, params: Readonly<{
  sessionId: string;
  targetTestId: string;
  targetEdge: 'top' | 'middle' | 'bottom';
  scrollDuringDrag?: 'target-into-view' | 'autoscroll-bottom';
}>): Promise<DragDispatchResult> {
  return dispatchSessionTreePointerDrag(page, {
    sourceTestId: `session-list-item-${params.sessionId}`,
    sourceChildTestId: 'session-item-reorder-handle',
    targetTestId: params.targetTestId,
    targetEdge: params.targetEdge,
    scrollDuringDrag: params.scrollDuringDrag,
  });
}

export async function dragFolderToTarget(page: Page, params: Readonly<{
  sourceFolderId: string;
  targetTestId: string;
  targetEdge: 'top' | 'middle' | 'bottom';
}>): Promise<void> {
  await dispatchSessionTreePointerDrag(page, {
    sourceTestId: `session-folder-header-${params.sourceFolderId}`,
    targetTestId: params.targetTestId,
    targetEdge: params.targetEdge,
  });
}

/** A DOM rect captured inside the browser (`getBoundingClientRect` shape). */
export type CapturedRect = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
}>;

/**
 * Geometry observed at the held mid-drag pointer position, just before the
 * drop is committed.
 *
 * This is the evidence vehicle for the drag-geometry refactor's headline fixes
 * (`.project/plans/session-list-drag-geometry-performance-unification.md`
 * sections 1.4, 8): the single viewport-level drop overlay must render its
 * indicator at the pointer's target row — NOT offset by several rows — even
 * after the list has been scrolled.
 */
export type DragGeometryProbe = Readonly<{
  ok: boolean;
  /** Final pointer position (viewport coordinates) held before the drop. */
  pointer: Readonly<{ x: number; y: number }> | null;
  /** The drop overlay indicator line rect while visible mid-drag. */
  overlayLine: CapturedRect | null;
  /** The drop overlay nest outline rect while visible mid-drag. */
  overlayOutline: CapturedRect | null;
  /** The row/header rect under the held pointer (the intended target). */
  targetRect: CapturedRect | null;
  scrollTopBefore: number | null;
  scrollTopAfter: number | null;
  error?: string;
}>;

/**
 * Drives a pointer drag from a session row's reorder handle to a target, but
 * PAUSES at the final pointer position to capture the live drop-overlay
 * geometry before committing the drop.
 *
 * Unlike `dragSessionToTarget`, which only proves the committed outcome, this
 * helper proves the *visual* contract: where the blue drop line is drawn
 * relative to the pointer. The single overlay's indicator views
 * (`session-list-drop-overlay-line` / `-outline`) are absolutely positioned
 * and only become opaque/visible while a drag is active, so their
 * `getBoundingClientRect()` must be read mid-drag.
 */
export async function dragSessionWithGeometryProbe(page: Page, params: Readonly<{
  sessionId: string;
  targetTestId: string;
  targetEdge: 'top' | 'middle' | 'bottom';
  /** Optional scroll performed before the drag starts (regression for stale bounds). */
  preScroll?: 'target-into-view';
}>): Promise<DragGeometryProbe> {
  const sourceTestId = `session-list-item-${params.sessionId}`;
  await page.getByTestId(sourceTestId).scrollIntoViewIfNeeded();
  if (params.preScroll === 'target-into-view') {
    await page.getByTestId(params.targetTestId).scrollIntoViewIfNeeded();
    await page.getByTestId(sourceTestId).scrollIntoViewIfNeeded();
  } else {
    await page.getByTestId(params.targetTestId).scrollIntoViewIfNeeded();
  }
  await page.getByTestId(sourceTestId).hover();

  const probe = await page.evaluate(async ({ sourceTestId, targetTestId, targetEdge }) => {
    const byTestId = (testId: string): HTMLElement | null => (
      document.querySelector<HTMLElement>(`[data-testid="${CSS.escape(testId)}"]`)
    );
    const findScrollableAncestor = (element: HTMLElement): HTMLElement | null => {
      let current: HTMLElement | null = element.parentElement;
      while (current) {
        if (current.scrollHeight > current.clientHeight + 8) return current;
        current = current.parentElement;
      }
      return document.scrollingElement instanceof HTMLElement ? document.scrollingElement : null;
    };
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const dispatchPointer = (
      target: EventTarget,
      type: string,
      point: Readonly<{ x: number; y: number }>,
      buttons: number,
    ) => {
      target.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 77,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons,
        clientX: point.x,
        clientY: point.y,
        screenX: point.x,
        screenY: point.y,
      }));
    };
    // A `getBoundingClientRect()` is only meaningful for an indicator that is
    // actually painted. The overlay keeps both the line and the outline
    // mounted and carries `opacity:0` on whichever one is not the active drop
    // kind (and on both when no drag is active), so an `opacity:0` or
    // zero-area rect means "not currently shown".
    const captureRect = (element: Element | null): CapturedRect | null => {
      if (!element) return null;
      const opacity = Number.parseFloat(window.getComputedStyle(element).opacity || '1');
      if (Number.isFinite(opacity) && opacity <= 0.01) return null;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 && rect.height <= 0) return null;
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
      };
    };
    type CapturedRect = Readonly<{
      x: number; y: number; width: number; height: number;
      top: number; bottom: number; left: number; right: number;
    }>;

    const sourceContainer = byTestId(sourceTestId);
    if (!sourceContainer) {
      return {
        ok: false, pointer: null, overlayLine: null, overlayOutline: null,
        targetRect: null, scrollTopBefore: null, scrollTopAfter: null,
        error: `missing ${sourceTestId}`,
      };
    }
    const handle = sourceContainer.querySelector<HTMLElement>('[data-testid="session-item-reorder-handle"]');
    if (!handle) {
      return {
        ok: false, pointer: null, overlayLine: null, overlayOutline: null,
        targetRect: null, scrollTopBefore: null, scrollTopAfter: null,
        error: 'missing session-item-reorder-handle',
      };
    }

    const scrollable = findScrollableAncestor(sourceContainer);
    const scrollTopBefore = scrollable?.scrollTop ?? null;

    const handleRect = handle.getBoundingClientRect();
    const sourcePoint = {
      x: handleRect.left + handleRect.width / 2,
      y: handleRect.top + handleRect.height / 2,
    };
    dispatchPointer(handle, 'pointerdown', sourcePoint, 1);
    await wait(40);
    // First small move past the activation threshold to lift the drag.
    dispatchPointer(window, 'pointermove', { x: sourcePoint.x + 2, y: sourcePoint.y + 12 }, 1);
    await wait(40);

    const target = byTestId(targetTestId);
    if (!target) {
      dispatchPointer(window, 'pointerup', sourcePoint, 0);
      return {
        ok: false, pointer: null, overlayLine: null, overlayOutline: null,
        targetRect: null, scrollTopBefore, scrollTopAfter: scrollable?.scrollTop ?? null,
        error: `missing ${targetTestId}`,
      };
    }
    const targetRectRaw = target.getBoundingClientRect();
    const pointer = {
      x: targetRectRaw.left + Math.min(Math.max(targetRectRaw.width * 0.5, 8), Math.max(targetRectRaw.width - 8, 8)),
      y: targetEdge === 'top'
        ? targetRectRaw.top + 4
        : targetEdge === 'bottom'
          ? targetRectRaw.bottom - 4
          : targetRectRaw.top + targetRectRaw.height / 2,
    };
    // Glide toward the target so autoscroll / hit-testing engage naturally.
    for (const fraction of [0.35, 0.7, 1]) {
      dispatchPointer(window, 'pointermove', {
        x: sourcePoint.x + (pointer.x - sourcePoint.x) * fraction,
        y: sourcePoint.y + (pointer.y - sourcePoint.y) * fraction,
      }, 1);
      await wait(50);
    }
    // Hold at the target: let the overlay glide settle, then capture it
    // BEFORE the drop tears the overlay down.
    dispatchPointer(window, 'pointermove', pointer, 1);
    await wait(220);

    const overlayLine = captureRect(byTestId('session-list-drop-overlay-line'));
    const overlayOutline = captureRect(byTestId('session-list-drop-overlay-outline'));
    // Re-read the target rect at hold time (it may have shifted under scroll).
    const targetAtHold = byTestId(targetTestId);
    const targetRect = targetAtHold ? (() => {
      const r = targetAtHold.getBoundingClientRect();
      return {
        x: r.x, y: r.y, width: r.width, height: r.height,
        top: r.top, bottom: r.bottom, left: r.left, right: r.right,
      } satisfies CapturedRect;
    })() : null;

    dispatchPointer(window, 'pointerup', pointer, 0);
    await wait(180);

    return {
      ok: true,
      pointer,
      overlayLine,
      overlayOutline,
      targetRect,
      scrollTopBefore,
      scrollTopAfter: scrollable?.scrollTop ?? null,
    };
  }, { sourceTestId, targetTestId: params.targetTestId, targetEdge: params.targetEdge });

  await page.waitForTimeout(250);
  return probe;
}

/** Long-task timing summary captured around an interaction. */
export type LongTaskSummary = Readonly<{
  /** Total count of `longtask` PerformanceEntry records observed. */
  count: number;
  /** Sum of all long-task durations, in ms. */
  totalMs: number;
  /** Longest single long-task duration, in ms. */
  maxMs: number;
}>;

/**
 * Drives a session drag while a `PerformanceObserver` records `longtask`
 * entries on the main thread, returning a coarse long-task summary.
 *
 * This is the optional, intentionally forgiving perf probe from Phase 7: it
 * exists to catch a *catastrophic* main-thread regression (the pre-fix drag
 * measured ~1742 ms of blocking across 14 long tasks). Precise FPS / frame
 * timing belongs in manual QA — CI thresholds here must stay generous so the
 * probe never flakes on shared/slow runners.
 */
export async function dragSessionWithLongTaskProbe(page: Page, params: Readonly<{
  sessionId: string;
  targetTestId: string;
  targetEdge: 'top' | 'middle' | 'bottom';
}>): Promise<Readonly<{ drag: DragDispatchResult; longTasks: LongTaskSummary }>> {
  const longTaskSupported = await page.evaluate(() => {
    try {
      return typeof PerformanceObserver !== 'undefined'
        && PerformanceObserver.supportedEntryTypes?.includes('longtask') === true;
    } catch {
      return false;
    }
  });

  if (longTaskSupported) {
    await page.evaluate(() => {
      const w = window as unknown as {
        __happierLongTasks?: number[];
        __happierLongTaskObserver?: PerformanceObserver;
      };
      w.__happierLongTasks = [];
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          w.__happierLongTasks?.push(entry.duration);
        }
      });
      observer.observe({ entryTypes: ['longtask'] });
      w.__happierLongTaskObserver = observer;
    });
  }

  const drag = await dragSessionToTarget(page, {
    sessionId: params.sessionId,
    targetTestId: params.targetTestId,
    targetEdge: params.targetEdge,
  });

  const longTasks = await page.evaluate(() => {
    const w = window as unknown as {
      __happierLongTasks?: number[];
      __happierLongTaskObserver?: PerformanceObserver;
    };
    w.__happierLongTaskObserver?.disconnect();
    const durations = w.__happierLongTasks ?? [];
    const totalMs = durations.reduce((sum, value) => sum + value, 0);
    const maxMs = durations.reduce((max, value) => Math.max(max, value), 0);
    return { count: durations.length, totalMs, maxMs };
  });

  return { drag, longTasks };
}

/**
 * The visible session-row order, top-to-bottom, captured from the DOM.
 *
 * Each entry is a session id parsed from a `session-list-item-<id>` testID,
 * ordered by on-screen vertical position. Used to prove the frozen-surface
 * contract: while a drag is active the visible row order must not reorder, even
 * if a background sync update lands.
 */
export async function readVisibleSessionRowOrder(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => {
    const prefix = 'session-list-item-';
    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}"]`),
    );
    return nodes
      .map((node) => ({
        id: (node.getAttribute('data-testid') ?? '').slice(prefix.length),
        y: node.getBoundingClientRect().top,
      }))
      .filter((entry) => entry.id.length > 0)
      .sort((a, b) => a.y - b.y)
      .map((entry) => entry.id);
  });
}

/**
 * A live, step-controlled session drag.
 *
 * The atomic `dragSessionToTarget` runs an entire drag inside one
 * `page.evaluate`, so a test cannot interleave server-side work mid-drag.
 * `SteppedSessionDrag` keeps the drag open across Playwright steps: the drag
 * state lives in the app (Reanimated shared values + the frozen snapshot), not
 * in any evaluate closure, so dispatching `pointerdown` / `pointermove` /
 * `pointerup` from separate evaluate calls is a valid continuous gesture.
 *
 * This is what makes the frozen-surface scenario testable end-to-end: begin a
 * drag, hover a target, perform a real background reorder over REST, then read
 * the visible row order before dropping.
 */
export type SteppedSessionDrag = Readonly<{
  /** Hover the pointer over a target row/header edge (no drop). */
  moveOverTarget: (targetTestId: string, edge: 'top' | 'middle' | 'bottom') => Promise<void>;
  /** Release the pointer at the last hovered target, committing the drop. */
  drop: () => Promise<void>;
}>;

/**
 * Begins a step-controlled drag from a session row's reorder handle and returns
 * a controller to move/drop it across later Playwright steps.
 */
export async function beginSteppedSessionDrag(page: Page, params: Readonly<{
  sessionId: string;
}>): Promise<SteppedSessionDrag> {
  const sourceTestId = `session-list-item-${params.sessionId}`;
  await page.getByTestId(sourceTestId).scrollIntoViewIfNeeded();
  await page.getByTestId(sourceTestId).hover();

  await page.evaluate(async ({ sourceTestId }) => {
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const dispatchPointer = (
      target: EventTarget,
      type: string,
      point: Readonly<{ x: number; y: number }>,
      buttons: number,
    ) => {
      target.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 77,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons,
        clientX: point.x,
        clientY: point.y,
        screenX: point.x,
        screenY: point.y,
      }));
    };
    const sourceContainer = document.querySelector<HTMLElement>(
      `[data-testid="${CSS.escape(sourceTestId)}"]`,
    );
    if (!sourceContainer) throw new Error(`missing ${sourceTestId}`);
    const handle = sourceContainer.querySelector<HTMLElement>('[data-testid="session-item-reorder-handle"]');
    if (!handle) throw new Error('missing session-item-reorder-handle');

    const rect = handle.getBoundingClientRect();
    const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const w = window as unknown as { __happierDragPoint?: { x: number; y: number } };
    w.__happierDragPoint = point;
    dispatchPointer(handle, 'pointerdown', point, 1);
    await wait(40);
    // Move past the activation threshold so the drag lifts and the snapshot
    // freezes.
    dispatchPointer(window, 'pointermove', { x: point.x + 2, y: point.y + 12 }, 1);
    await wait(60);
  }, { sourceTestId });
  await page.waitForTimeout(80);

  return {
    moveOverTarget: async (targetTestId, edge) => {
      await page.evaluate(async ({ targetTestId, edge }) => {
        const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
        const dispatchPointer = (point: Readonly<{ x: number; y: number }>) => {
          window.dispatchEvent(new PointerEvent('pointermove', {
            bubbles: true,
            cancelable: true,
            pointerId: 77,
            pointerType: 'mouse',
            isPrimary: true,
            button: 0,
            buttons: 1,
            clientX: point.x,
            clientY: point.y,
            screenX: point.x,
            screenY: point.y,
          }));
        };
        const target = document.querySelector<HTMLElement>(
          `[data-testid="${CSS.escape(targetTestId)}"]`,
        );
        if (!target) throw new Error(`missing ${targetTestId}`);
        const rect = target.getBoundingClientRect();
        const point = {
          x: rect.left + Math.min(Math.max(rect.width * 0.5, 8), Math.max(rect.width - 8, 8)),
          y: edge === 'top'
            ? rect.top + 4
            : edge === 'bottom'
              ? rect.bottom - 4
              : rect.top + rect.height / 2,
        };
        const w = window as unknown as { __happierDragPoint?: { x: number; y: number } };
        w.__happierDragPoint = point;
        // Two moves so hit-testing + the overlay glide engage.
        dispatchPointer({ x: point.x, y: point.y - 3 });
        await wait(45);
        dispatchPointer(point);
        await wait(140);
      }, { targetTestId, edge });
      await page.waitForTimeout(80);
    },
    drop: async () => {
      await page.evaluate(async () => {
        const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
        const w = window as unknown as { __happierDragPoint?: { x: number; y: number } };
        const point = w.__happierDragPoint ?? { x: 0, y: 0 };
        window.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true,
          cancelable: true,
          pointerId: 77,
          pointerType: 'mouse',
          isPrimary: true,
          button: 0,
          buttons: 0,
          clientX: point.x,
          clientY: point.y,
          screenX: point.x,
          screenY: point.y,
        }));
        await wait(180);
      });
      await page.waitForTimeout(250);
    },
  };
}
