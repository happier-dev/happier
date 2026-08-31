import type { Page } from '@playwright/test';

export type DragDispatchResult = Readonly<{
  ok: boolean;
  scrollTopBefore: number | null;
  scrollTopAfter: number | null;
  error?: string;
}>;

async function scrollConnectedTestIdIntoView(
  page: Page,
  testId: string,
  timeoutMs: number = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connectedAfterLayout = await page.evaluate(async (candidateTestId) => {
      const selector = `[data-testid="${CSS.escape(candidateTestId)}"]`;
      const element = document.querySelector<HTMLElement>(selector);
      if (!element?.isConnected) return false;

      // Query and scroll in one browser task. Playwright's locator action waits
      // for stability while retaining an element handle, which is unsafe for
      // this intentionally re-rendering/virtualized tree during drag setup.
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return document.querySelector<HTMLElement>(selector)?.isConnected === true;
    }, testId);
    if (connectedAfterLayout) return;
    await page.waitForTimeout(50);
  }
  throw new Error(`missing connected ${testId}`);
}

async function dispatchSessionTreePointerDrag(page: Page, params: Readonly<{
  sourceTestId: string;
  sourceChildTestId?: string;
  targetTestId: string;
  targetEdge: 'top' | 'middle' | 'bottom';
  scrollDuringDrag?: 'target-into-view' | 'autoscroll-bottom';
}>): Promise<DragDispatchResult> {
  await scrollConnectedTestIdIntoView(page, params.sourceTestId);
  await page.getByTestId(params.sourceTestId).hover().catch(() => undefined);

  if (!params.scrollDuringDrag) {
    await scrollConnectedTestIdIntoView(page, params.targetTestId);
  }

  const scrollMetricsBefore = await page.evaluate((sourceTestId) => {
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
    const sourceContainer = byTestId(sourceTestId);
    const scrollable = sourceContainer ? findScrollableAncestor(sourceContainer) : null;
    const rect = scrollable?.getBoundingClientRect() ?? null;
    return {
      scrollTop: scrollable?.scrollTop ?? null,
      rect: rect
        ? { left: rect.left, width: rect.width, bottom: rect.bottom }
        : null,
    };
  }, params.sourceTestId);

  const sourceContainer = page.getByTestId(params.sourceTestId);
  const source = params.sourceChildTestId
    ? sourceContainer.getByTestId(params.sourceChildTestId)
    : sourceContainer;
  const sourceBox = await source.boundingBox();
  if (!sourceBox) {
    return {
      ok: false,
      scrollTopBefore: scrollMetricsBefore.scrollTop,
      scrollTopAfter: scrollMetricsBefore.scrollTop,
      error: `missing ${params.sourceChildTestId ?? params.sourceTestId}`,
    };
  }

  const pointForBox = (
    box: NonNullable<Awaited<ReturnType<typeof source.boundingBox>>>,
    edge: 'top' | 'middle' | 'bottom',
    outsideEdges: boolean = false,
  ) => {
    const y = outsideEdges && edge === 'top'
      ? box.y - 4
      : outsideEdges && edge === 'bottom'
        ? box.y + box.height + 4
        : edge === 'top'
          ? box.y + 1
          : edge === 'bottom'
            ? box.y + box.height - 1
            : box.y + box.height / 2;
    return {
      x: box.x + Math.min(Math.max(box.width * 0.5, 8), Math.max(box.width - 8, 8)),
      y,
    };
  };

  const folderDragRowTestIdFromHeaderTestId = (testId: string): string | null => {
    const prefix = 'session-folder-header-';
    return testId.startsWith(prefix)
      ? `session-folder-drag-row-${testId.slice(prefix.length)}`
      : null;
  };

  const resolveTargetBox = async (
    targetTestId: string,
  ): Promise<NonNullable<Awaited<ReturnType<typeof source.boundingBox>>> | null> => {
    const folderDragRowTestId = folderDragRowTestIdFromHeaderTestId(targetTestId);
    if (!folderDragRowTestId) {
      return page.getByTestId(targetTestId).boundingBox();
    }
    const folderDragRow = page.getByTestId(folderDragRowTestId);
    const rowBox = await folderDragRow.boundingBox().catch(() => null);
    if (rowBox) return rowBox;
    return page.evaluate((testId) => {
      const element = document.querySelector<HTMLElement>(`[data-testid="${CSS.escape(testId)}"]`);
      const row = element?.parentElement ?? element;
      const rect = row?.getBoundingClientRect();
      if (!rect) return null;
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };
    }, targetTestId);
  };

  const sourcePoint = pointForBox(sourceBox, 'middle');
  await page.mouse.move(sourcePoint.x, sourcePoint.y);
  await page.mouse.down({ button: 'left' });
  await page.waitForTimeout(35);
  await page.mouse.move(sourcePoint.x + 2, sourcePoint.y + 10);
  await page.waitForTimeout(35);

  if (params.scrollDuringDrag === 'target-into-view') {
    await scrollConnectedTestIdIntoView(page, params.targetTestId);
    await page.waitForTimeout(80);
  } else if (params.scrollDuringDrag === 'autoscroll-bottom' && scrollMetricsBefore.rect) {
    await page.mouse.move(
      scrollMetricsBefore.rect.left + scrollMetricsBefore.rect.width / 2,
      scrollMetricsBefore.rect.bottom - 6,
    );
    await page.waitForTimeout(900);
  }

  const targetBox = await resolveTargetBox(params.targetTestId);
  if (!targetBox) {
    await page.mouse.up({ button: 'left' });
    const scrollTopAfter = await page.evaluate((sourceTestId) => {
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
      const sourceContainer = byTestId(sourceTestId);
      return sourceContainer ? findScrollableAncestor(sourceContainer)?.scrollTop ?? null : null;
    }, params.sourceTestId);
    return {
      ok: false,
      scrollTopBefore: scrollMetricsBefore.scrollTop,
      scrollTopAfter,
      error: `missing ${params.targetTestId}`,
    };
  }

  const targetPoint = pointForBox(
    targetBox,
    params.targetEdge,
    params.sourceTestId.startsWith('session-folder-drag-row-')
      && params.targetTestId.startsWith('session-folder-header-'),
  );
  for (const fraction of [0.35, 0.7, 1]) {
    await page.mouse.move(
      sourcePoint.x + (targetPoint.x - sourcePoint.x) * fraction,
      sourcePoint.y + (targetPoint.y - sourcePoint.y) * fraction,
    );
    await page.waitForTimeout(45);
  }
  await page.mouse.up({ button: 'left' });
  await page.waitForTimeout(160);

  const scrollTopAfter = await page.evaluate((sourceTestId) => {
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
    const sourceContainer = byTestId(sourceTestId);
    return sourceContainer ? findScrollableAncestor(sourceContainer)?.scrollTop ?? null : null;
  }, params.sourceTestId);

  const result = {
    ok: true,
    scrollTopBefore: scrollMetricsBefore.scrollTop,
    scrollTopAfter,
  };

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
  const result = await dispatchSessionTreePointerDrag(page, {
    sourceTestId: `session-folder-drag-row-${params.sourceFolderId}`,
    sourceChildTestId: `session-folder-reorder-handle-${params.sourceFolderId}`,
    targetTestId: params.targetTestId,
    targetEdge: params.targetEdge,
  });
  if (!result.ok) throw new Error(result.error ?? 'folder drag dispatch failed');
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
  await scrollConnectedTestIdIntoView(page, sourceTestId);
  await page.getByTestId(sourceTestId).hover();
  if (params.preScroll === 'target-into-view') {
    await scrollConnectedTestIdIntoView(page, params.targetTestId);
    await scrollConnectedTestIdIntoView(page, sourceTestId);
    await page.getByTestId(sourceTestId).hover();
  }

  const scrollTopBefore = await page.evaluate((sourceTestId) => {
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
    const sourceContainer = byTestId(sourceTestId);
    return sourceContainer ? findScrollableAncestor(sourceContainer)?.scrollTop ?? null : null;
  }, sourceTestId);

  const sourceHandle = page
    .getByTestId(sourceTestId)
    .getByTestId('session-item-reorder-handle');
  const sourceBox = await sourceHandle.boundingBox();
  if (!sourceBox) {
    return {
      ok: false,
      pointer: null,
      overlayLine: null,
      overlayOutline: null,
      targetRect: null,
      scrollTopBefore,
      scrollTopAfter: scrollTopBefore,
      error: 'missing session-item-reorder-handle',
    };
  }

  const pointForBox = (
    box: NonNullable<typeof sourceBox>,
    edge: 'top' | 'middle' | 'bottom',
    outsideEdges: boolean = false,
  ) => {
    const y = outsideEdges && edge === 'top'
      ? box.y - 4
      : outsideEdges && edge === 'bottom'
        ? box.y + box.height + 4
        : edge === 'top'
          ? box.y + 1
          : edge === 'bottom'
            ? box.y + box.height - 1
            : box.y + box.height / 2;
    return {
      x: box.x + Math.min(Math.max(box.width * 0.5, 8), Math.max(box.width - 8, 8)),
      y,
    };
  };

  const folderDragRowTestIdFromHeaderTestId = (testId: string): string | null => {
    const prefix = 'session-folder-header-';
    return testId.startsWith(prefix)
      ? `session-folder-drag-row-${testId.slice(prefix.length)}`
      : null;
  };

  const resolveTargetBox = async (
    targetTestId: string,
  ): Promise<NonNullable<typeof sourceBox> | null> => {
    const folderDragRowTestId = folderDragRowTestIdFromHeaderTestId(targetTestId);
    if (!folderDragRowTestId) {
      return page.getByTestId(targetTestId).boundingBox();
    }
    const folderDragRow = page.getByTestId(folderDragRowTestId);
    const rowBox = await folderDragRow.boundingBox().catch(() => null);
    if (rowBox) return rowBox;
    return page.evaluate((testId) => {
      const element = document.querySelector<HTMLElement>(`[data-testid="${CSS.escape(testId)}"]`);
      const row = element?.parentElement ?? element;
      const rect = row?.getBoundingClientRect();
      if (!rect) return null;
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };
    }, targetTestId);
  };

  const sourcePoint = pointForBox(sourceBox, 'middle');
  await page.mouse.move(sourcePoint.x, sourcePoint.y);
  await page.mouse.down({ button: 'left' });
  await page.waitForTimeout(40);
  await page.mouse.move(sourcePoint.x + 2, sourcePoint.y + 12);
  await page.waitForTimeout(40);

  // Scroll the target into view AFTER the drag lifts so the probe matches the
  // real pointer-drag contract used by the committed outcome helper.
  await scrollConnectedTestIdIntoView(page, params.targetTestId);
  await page.waitForTimeout(80);

  const targetBox = await resolveTargetBox(params.targetTestId);
  if (!targetBox) {
    await page.mouse.up({ button: 'left' });
    return {
      ok: false,
      pointer: null,
      overlayLine: null,
      overlayOutline: null,
      targetRect: null,
      scrollTopBefore,
      scrollTopAfter: await page.evaluate((sourceTestId) => {
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
        const sourceContainer = byTestId(sourceTestId);
        return sourceContainer ? findScrollableAncestor(sourceContainer)?.scrollTop ?? null : null;
      }, sourceTestId),
      error: `missing ${params.targetTestId}`,
    };
  }

  const pointer = pointForBox(
    targetBox,
    params.targetEdge,
    false,
  );
  for (const fraction of [0.35, 0.7, 1]) {
    await page.mouse.move(
      sourcePoint.x + (pointer.x - sourcePoint.x) * fraction,
      sourcePoint.y + (pointer.y - sourcePoint.y) * fraction,
    );
    await page.waitForTimeout(50);
  }
  await page.mouse.move(pointer.x, pointer.y);
  await page.waitForTimeout(220);

  const probe = await page.evaluate(({ targetTestId }) => {
    const byTestId = (testId: string): HTMLElement | null => (
      document.querySelector<HTMLElement>(`[data-testid="${CSS.escape(testId)}"]`)
    );
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

    return {
      overlayLine,
      overlayOutline,
      targetRect,
    };
  }, { targetTestId: params.targetTestId });

  await page.mouse.up({ button: 'left' });
  await page.waitForTimeout(180);
  const scrollTopAfter = await page.evaluate((sourceTestId) => {
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
    const sourceContainer = byTestId(sourceTestId);
    return sourceContainer ? findScrollableAncestor(sourceContainer)?.scrollTop ?? null : null;
  }, sourceTestId);

  await page.waitForTimeout(250);
  return {
    ok: true,
    pointer,
    overlayLine: probe.overlayLine,
    overlayOutline: probe.overlayOutline,
    targetRect: probe.targetRect,
    scrollTopBefore,
    scrollTopAfter,
  };
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
  await scrollConnectedTestIdIntoView(page, sourceTestId);
  await page.getByTestId(sourceTestId).hover();

  const sourceHandle = page
    .getByTestId(sourceTestId)
    .getByTestId('session-item-reorder-handle');
  const sourceBox = await sourceHandle.boundingBox();
  if (!sourceBox) throw new Error('missing session-item-reorder-handle');

  const pointForBox = (
    box: NonNullable<typeof sourceBox>,
    edge: 'top' | 'middle' | 'bottom',
  ) => ({
    x: box.x + Math.min(Math.max(box.width * 0.5, 8), Math.max(box.width - 8, 8)),
    y: edge === 'top'
      ? box.y + 1
      : edge === 'bottom'
        ? box.y + box.height - 1
        : box.y + box.height / 2,
  });

  const sourcePoint = pointForBox(sourceBox, 'middle');
  await page.mouse.move(sourcePoint.x, sourcePoint.y);
  await page.mouse.down({ button: 'left' });
  await page.waitForTimeout(40);
  // Move past the activation threshold so the drag lifts and the snapshot
  // freezes.
  await page.mouse.move(sourcePoint.x + 2, sourcePoint.y + 12);
  await page.waitForTimeout(60);
  await page.waitForTimeout(80);

  let currentPoint = { x: sourcePoint.x + 2, y: sourcePoint.y + 12 };

  return {
    moveOverTarget: async (targetTestId, edge) => {
      await scrollConnectedTestIdIntoView(page, targetTestId);
      const targetBox = await page.getByTestId(targetTestId).boundingBox();
      if (!targetBox) throw new Error(`missing ${targetTestId}`);

      const point = pointForBox(targetBox, edge);
      for (const fraction of [0.5, 1]) {
        await page.mouse.move(
          currentPoint.x + (point.x - currentPoint.x) * fraction,
          currentPoint.y + (point.y - currentPoint.y) * fraction,
        );
        await page.waitForTimeout(45);
      }
      currentPoint = point;
      await page.waitForTimeout(140);
      await page.waitForTimeout(80);
    },
    drop: async () => {
      await page.mouse.up({ button: 'left' });
      await page.waitForTimeout(180);
      await page.waitForTimeout(250);
    },
  };
}
