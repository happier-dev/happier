/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import { installPopoverCommonModuleMocks } from '@/components/ui/popover/popoverTestHelpers';

type LensGesture = { gestures: [{ __handlers: Record<string, (event: { x: number }) => void> },
  { gestures: [{ __handlers: Record<string, (event: { x: number }) => void> },
    { __handlers: Record<string, (event: { x: number }) => void> }] }] };
const gestureBoundary = vi.hoisted(() => ({ current: null as LensGesture | null }));
// Gesture delivery is the platform boundary; lens commands and Popover placement stay real.
vi.mock('react-native-gesture-handler', async importOriginal => ({
  ...await importOriginal<typeof import('react-native-gesture-handler')>(),
  GestureDetector: (props: { gesture: LensGesture; children: React.ReactNode }) => {
    gestureBoundary.current = props.gesture;
    return props.children;
  },
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Real RNW DOM primitives: the defect is DOM containment under a clipping card.
const viewport = vi.hoisted(() => ({ width: 1440, height: 900 }));
installPopoverCommonModuleMocks({
  reactNative: async () => ({
    ...(await vi.importActual<typeof import('react-native-web')>('react-native-web')),
    // Physical dimensions are the boundary; placement, portals and motion stay real.
    useWindowDimensions: () => ({ ...viewport, scale: 1, fontScale: 1 }),
    Dimensions: {
      get: () => ({ ...viewport, scale: 1, fontScale: 1 }),
      addEventListener: () => ({ remove: () => {} }),
    },
  }),
});

const { ScrubLens } = await import('./UsageScrubLens');

function rect(x: number, y: number, width: number, height: number): DOMRect {
  return {
    x,
    y,
    width,
    height,
    top: y,
    left: x,
    right: x + width,
    bottom: y + height,
    toJSON: () => ({}),
  };
}

const ROWS = Array.from({ length: 8 }, (_, index) => ({
  id: `source-${index}`,
  label: `Source ${index}`,
  value: `${index}M`,
  color: '#123456',
}));

describe('the scrub lens placement', () => {
  it.each(['held', 'passive'] as const)('describes the %s scrub surface with its lens and clears it when scrolling outside the viewport', async mode => {
    const { serveActionHomes } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
    const { installLocalStorageMock } = await import('@/auth/storage/tokenStorage.web.testHelpers');
    const storage = installLocalStorageMock();
    const home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-lens-scroll.test', accountId: 'account-a' }],
      route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
    const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const server = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
    const { createMountedCurrentUiContextWrapper } = await import('@/dev/testkit/harness/mountedCurrentUiContext');
    const Wrapper = await createMountedCurrentUiContextWrapper();
    const container = document.createElement('div');
    container.style.overflowY = 'scroll';
    document.body.append(container);
    const root = createRoot(container);
    let anchorTop = 120;
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('data-testid') === 'scroll-plot-lens' || this.querySelector('[data-testid="scroll-plot-lens"]')
        ? rect(0, 0, 184, 260) : rect(200, anchorTop, 2, 140);
    });
    try {
      await act(async () => root.render(<Wrapper><ScrubLens testID="scroll-plot" layout={{ centers: [20] }}
        accentColor="#000" resolveContent={() => ({ title: 'Nov 4', rows: ROWS })} /></Wrapper>));
      await act(async () => {
        if (mode === 'held') gestureBoundary.current!.gestures[1].gestures[1].__handlers.onEnd!({ x: 20 });
        else gestureBoundary.current!.gestures[0].__handlers.onBegin!({ x: 20 });
      });
      await vi.waitFor(() => expect(document.querySelector('[data-testid="scroll-plot-lens"]')).not.toBeNull());
      const trigger = document.querySelector('[data-testid="scroll-plot"]')!;
      const describedBy = trigger.getAttribute('aria-describedby');
      expect(describedBy).toBeTruthy();
      const tooltip = document.getElementById(describedBy!);
      expect(tooltip?.getAttribute('role')).toBe('tooltip');
      expect(tooltip?.textContent).toContain('Source 7');
      anchorTop = -200;
      await act(async () => {
        container.scrollTop = 320;
        container.dispatchEvent(new Event('scroll'));
      });
      await vi.waitFor(() => expect(document.querySelector('[data-testid="scroll-plot-lens"]')).toBeNull());
      expect(trigger.hasAttribute('aria-describedby')).toBe(false);
      expect(document.getElementById(describedBy!)).toBeNull();
    } finally {
      await act(async () => root.unmount());
      measure.mockRestore();
      container.remove();
      retireActiveServerAccountScopeLifetime();
      await home.dispose();
      storage.restore();
    }
  });

  it('floats outside the clipping card, beside its crosshair and inside the window', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const windowWidth = viewport.width;
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (callback) =>
      window.setTimeout(() => callback(performance.now()), 0);
    // The plot sits near the window's right edge, so the lens has no room after its crosshair.
    const measure = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        if (this.getAttribute('data-testid') === 'plot')
          return rect(windowWidth - 220, 120, 200, 140);
        if (
          this.querySelector?.('[data-testid="plot-lens"]') ||
          this.getAttribute('data-testid') === 'plot-lens'
        )
          return rect(0, 0, 184, 260);
        // The lens anchor: the crosshair's span, the height of the plot.
        return rect(windowWidth - 41, 120, 2, 140);
      });
    try {
      await act(async () => {
        root.render(
          // The card clips its body, as a Usage widget frame does.
          <div data-testid="card" style={{ overflow: 'hidden', height: 160 }}>
            <ScrubLens
              testID="plot"
              layout={{ centers: [20, 100, 180] }}
              focusIndex={2}
              accentColor="#000"
              resolveContent={() => ({
                title: 'Nov 4',
                total: '28M',
                rows: ROWS,
              })}
            />
          </div>,
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      const card = document.querySelector('[data-testid="card"]')!;
      const lens = await vi.waitFor(() => {
        const element = document.querySelector<HTMLElement>(
          '[data-testid="plot-lens"]',
        );
        expect(element).not.toBeNull();
        return element!;
      });
      // Every row is painted, and none of it lives inside the card that clips.
      expect(lens.textContent).toContain('Source 7');
      expect(card.contains(lens)).toBe(false);
      // Following the pointer is passive: the lens never takes the pointer from the plot under it.
      let passive = false;
      for (
        let element: HTMLElement | null = lens;
        element && element !== document.body;
        element = element.parentElement
      ) {
        if (getComputedStyle(element).pointerEvents === 'none') passive = true;
      }
      expect(passive).toBe(true);
      // No room after the crosshair: it sits before it, inside the window.
      // No room after the crosshair: the lens ends a gap before it, whole and inside the window.
      const panel = await vi.waitFor(() => {
        const element = document.querySelector<HTMLElement>('[id^="popover-"]');
        expect(element?.contains(lens)).toBe(true);
        expect(element!.style.opacity).toBe('1');
        return element!;
      });
      const rightEdge = windowWidth - Number.parseFloat(panel.style.right);
      expect(rightEdge).toBeLessThanOrEqual(windowWidth - 41);
      expect(rightEdge - 184).toBeGreaterThanOrEqual(0);
    } finally {
      await act(async () => root.unmount());
      measure.mockRestore();
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
      container.remove();
    }
  });
});
