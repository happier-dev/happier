// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createWebDomScrollObservation } from '@/components/sessions/transcript/viewport/driver/webDomObservation';
import { resolveMainTranscriptListShellFrame } from '../transcriptListShellCapabilities';
import { legendListRenderer } from './legendListRenderer';

vi.mock('react-native', async () => vi.importActual('react-native-web'));

type Row = Readonly<{ id: string; height: number }>;
type ResizeObserverRecord = Readonly<{
  callback: ResizeObserverCallback;
  elements: Set<Element>;
}>;

const resizeObservers = new Set<ResizeObserverRecord>();
// The pane the transcript sits in. A remounted or unfrozen Session can lay out in a pane that is
// momentarily a few px wide before the column settles at its real width.
let paneWidth = 800;

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

// Block layout: a box is as wide as the pane unless it or an ancestor carries an explicit px width.
function measuredWidth(element: Element): number {
  let width = paneWidth;
  for (
    let node: Element | null = element;
    node && node.id !== 'transcript-host';
    node = node.parentElement
  ) {
    const explicit = (node as HTMLElement).style?.width ?? '';
    if (explicit.endsWith('px'))
      width = Math.min(width, Number.parseFloat(explicit));
  }
  return width;
}

function measuredRect(element: Element): DOMRectReadOnly {
  const html = element as HTMLElement;
  const width = measuredWidth(element);
  if (
    html.id === 'transcript-host' ||
    html.style.overflowY === 'auto' ||
    html.style.overflow === 'auto'
  ) {
    return rect(width, 600);
  }
  const row = html.querySelector<HTMLElement>('[data-height]');
  if (row) return rect(width, Number(row.dataset.height ?? 72));
  return rect(width, Number.parseFloat(html.style.height || '0') || 0);
}

function flushResizeObservers(): void {
  for (const observer of resizeObservers) {
    const entries = [...observer.elements].map((element) => ({
      borderBoxSize: [],
      contentBoxSize: [],
      contentRect: measuredRect(element),
      devicePixelContentBoxSize: [],
      target: element,
    })) as ResizeObserverEntry[];
    if (entries.length > 0) observer.callback(entries, {} as ResizeObserver);
  }
}

async function flushLegendWork(): Promise<void> {
  for (let pass = 0; pass < 8; pass += 1) {
    await act(async () => {
      flushResizeObservers();
      await vi.runOnlyPendingTimersAsync();
    });
  }
}

const renderRow = ({ item }: Readonly<{ item: Row }>) => (
  <div
    data-height={item.height}
    data-testid={`row:${item.id}`}
    style={{ height: item.height }}
  >
    {item.id}
  </div>
);

function messages(count: number): Row[] {
  return Array.from({ length: count }, (_value, index) => ({
    id: `msg-${index}`,
    height: 72,
  }));
}

describe('transcript renderer cross-axis width', () => {
  let container: HTMLDivElement;
  let root: Root;
  let initialScrollBy: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    paneWidth = 800;
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
        resizeObservers.add(this.record);
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
      (callback: FrameRequestCallback) =>
        setTimeout(() => callback(Date.now()), 0) as unknown as number,
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
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        const element = this as HTMLElement;
        let content = 0;
        for (const descendant of element.querySelectorAll<HTMLElement>(
          '[style]',
        )) {
          content = Math.max(
            content,
            Number.parseFloat(descendant.style.height || '0') || 0,
          );
        }
        return Math.max(element.clientHeight, content);
      },
    });
    initialScrollBy = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'scrollBy',
    );
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      writable: true,
      value() {},
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollBy', {
      configurable: true,
      writable: true,
      value() {},
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    if (initialScrollBy)
      Object.defineProperty(HTMLElement.prototype, 'scrollBy', initialScrollBy);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollBy');
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('fills the pane again after first laying out in a pane only a few px wide', async () => {
    const Renderer = legendListRenderer.Component;
    const frame = resolveMainTranscriptListShellFrame({ platformOS: 'web' });
    const webDomObservation = createWebDomScrollObservation();
    const data = messages(40);
    const render = async () => {
      await act(async () =>
        root.render(
          <div
            id="transcript-host"
            style={{ display: 'flex', flexDirection: 'column', height: 600 }}
          >
            <Renderer
              data={data}
              dataKey="session:resumed"
              extraData={null}
              frame={frame}
              keyExtractor={(item: Row) => item.id}
              renderItem={renderRow}
              webDomObservation={webDomObservation}
            />
          </div>,
        ),
      );
      await flushLegendWork();
    };

    // Stop → cold Resume remounts the Session while its pane column is still collapsing open.
    paneWidth = 4;
    await render();
    paneWidth = 800;
    await render();

    const scroller = [...container.querySelectorAll<HTMLElement>('div')].find(
      (element) =>
        element.style.overflowY === 'auto' || element.style.overflow === 'auto',
    );
    const lastRow = container.querySelector('[data-testid="row:msg-39"]');
    expect({
      scrollerWidth: scroller ? measuredRect(scroller).width : null,
      rowWidth: lastRow ? measuredRect(lastRow).width : null,
    }).toEqual({ scrollerWidth: 800, rowWidth: 800 });
  });
});
