// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
// The Home's document reader is the system boundary: the original is unavailable, so the whole proposal is the diff.
vi.mock('@/sync/ops/promptLibrary/promptLibraryArtifactStore', () => ({
  withUiPromptLibraryArtifactReader: async () => {
    throw new Error('original unavailable');
  },
}));

const { DiffViewer } = await import('../DiffViewer');
const { PromptDocApprovalDiff } =
  await import('@/components/approvals/PromptDocApprovalDiff');

const ROW_HEIGHT = 28;
const LINES = 900;

type ResizeObserverRecord = Readonly<{
  callback: ResizeObserverCallback;
  elements: Set<Element>;
}>;
const resizeObservers = new Set<ResizeObserverRecord>();

function rect(width: number, height: number): DOMRectReadOnly {
  return {
    bottom: height,
    height,
    left: 0,
    right: width,
    top: 0,
    width,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  };
}

/** A laid-out web page: a styled viewport keeps its height, every other box is one prose row tall. */
function measuredRect(element: Element): DOMRectReadOnly {
  const html = element as HTMLElement;
  const styledHeight = Number.parseFloat(html.style.height || '');
  if (Number.isFinite(styledHeight)) return rect(800, styledHeight);
  if (html.style.overflowY === 'auto' || html.style.overflow === 'auto')
    return rect(800, 0);
  return rect(800, ROW_HEIGHT);
}

async function flushLegendWork(): Promise<void> {
  for (let pass = 0; pass < 8; pass += 1) {
    await act(async () => {
      for (const observer of resizeObservers) {
        const entries = [...observer.elements].map((target) => ({
          borderBoxSize: [],
          contentBoxSize: [],
          contentRect: measuredRect(target),
          devicePixelContentBoxSize: [],
          target,
        })) as ResizeObserverEntry[];
        if (entries.length > 0)
          observer.callback(entries, {} as ResizeObserver);
      }
      await vi.runOnlyPendingTimersAsync();
    });
  }
}

function lines(prefix: string): string {
  return Array.from({ length: LINES }, (_, i) => `${prefix} line ${i}`).join(
    '\n',
  );
}

describe('prose diff face: large comparisons stay a bounded viewport', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    resizeObservers.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    class TestResizeObserver implements ResizeObserver {
      private readonly record: ResizeObserverRecord;
      constructor(callback: ResizeObserverCallback) {
        this.record = { callback, elements: new Set() };
        resizeObservers.add(this.record);
      }
      disconnect(): void {
        this.record.elements.clear();
        resizeObservers.delete(this.record);
      }
      observe(target: Element): void {
        this.record.elements.add(target);
      }
      unobserve(target: Element): void {
        this.record.elements.delete(target);
      }
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        return measuredRect(this);
      },
    );
    vi.stubGlobal(
      'requestAnimationFrame',
      (cb: FrameRequestCallback) =>
        setTimeout(() => cb(Date.now()), 0) as unknown as number,
    );
    vi.stubGlobal('cancelAnimationFrame', (handle: number) =>
      clearTimeout(handle),
    );
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get() {
        return measuredRect(this).height;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() {
        return measuredRect(this).width;
      },
    });
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
  });

  function mountedRows(): number {
    return container.querySelectorAll(
      '[data-testid="diff.lines.added"], [data-testid="diff.lines.removed"]',
    ).length;
  }

  it('mounts only the rows near the viewport for a 900-line Instructions approval', async () => {
    await act(async () => {
      root.render(
        <PromptDocApprovalDiff
          serverId={null}
          testID="diff"
          request={
            {
              artifactId: 'doc-1',
              markdown: lines('proposed'),
              expectedRevision: null,
              outcome: null,
            } as never
          }
        />,
      );
    });
    await flushLegendWork();
    expect(mountedRows()).toBeGreaterThan(0);
    expect(mountedRows()).toBeLessThan(LINES / 4);
  });

  it('bounds each side of a two-version comparison the same way', async () => {
    await act(async () => {
      root.render(
        <DiffViewer
          mode="text"
          face="prose"
          testID="compare"
          presentationStyleOverride="split"
          oldText={lines('yours')}
          newText={lines('theirs')}
          prose={{ oldLabel: 'Yours', newLabel: 'Theirs' }}
        />,
      );
    });
    await flushLegendWork();
    const text = container.textContent ?? '';
    const yours = text.split('yours line ').length - 1;
    const theirs = text.split('theirs line ').length - 1;
    expect(yours).toBeGreaterThan(0);
    expect(theirs).toBeGreaterThan(0);
    expect(yours).toBeLessThan(LINES / 4);
    expect(theirs).toBeLessThan(LINES / 4);
  });
});
