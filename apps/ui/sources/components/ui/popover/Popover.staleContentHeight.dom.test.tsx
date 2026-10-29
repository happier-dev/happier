/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installPopoverCommonModuleMocks } from './popoverTestHelpers';

const viewport = vi.hoisted(() => ({ width: 1440, height: 900 }));
installPopoverCommonModuleMocks({
  reactNative: async () => ({
    ...(await vi.importActual<typeof import('react-native-web')>(
      'react-native-web',
    )),
    // Physical dimensions are the boundary; placement, portals and motion stay real.
    useWindowDimensions: () => ({ ...viewport, scale: 1, fontScale: 1 }),
    Dimensions: {
      get: () => ({ ...viewport, scale: 1, fontScale: 1 }),
      addEventListener: () => ({ remove: () => {} }),
    },
  }),
});
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const { Popover } = await import('./Popover');
const { View } = await import('react-native');

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const ANCHOR = { x: 1008, y: 388, width: 380, height: 40 };
/** A long menu: as tall as whatever bound it is given. */
const LONG_MENU_HEIGHT = 3_000_000;

describe('Popover first placement of a long menu', () => {
  it('never shows a frame placed from the height it had under the window-sized first bound', async () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    // Layout is the platform boundary: the box is as tall as the bound its content was rendered under.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.dataset.testid === 'menu-trigger')
          return new DOMRect(ANCHOR.x, ANCHOR.y, ANCHOR.width, ANCHOR.height);
        const body =
          this.querySelector<HTMLElement>('[data-max]') ??
          (this.dataset.max ? this : null);
        if (body)
          return new DOMRect(
            0,
            0,
            ANCHOR.width,
            Math.min(LONG_MENU_HEIGHT, Number(body.dataset.max)),
          );
        return new DOMRect(0, 0, ANCHOR.width, 40);
      },
    );
    function Harness() {
      const anchor = React.useRef<React.ComponentRef<typeof View>>(null);
      return (
        <>
          <View ref={anchor} testID="menu-trigger" />
          <Popover
            open
            anchorRef={anchor}
            placement="auto-vertical"
            maxHeightCap={viewport.height}
            maxWidthCap={380}
            portal={{ web: true, matchAnchorWidth: true }}
            onRequestClose={() => {}}
          >
            {({ maxHeight }) => <div data-max={String(maxHeight)} />}
          </Popover>
        </>
      );
    }
    const visibleOverlaps: string[] = [];
    const sample = () => {
      const panel = document.querySelector<HTMLElement>('[id^="popover-"]');
      if (!panel || panel.style.opacity !== '1') return;
      const top = Number.parseFloat(panel.style.top);
      const height = panel.getBoundingClientRect().height;
      // A shown menu sits beside its trigger, never over it.
      const overlaps =
        top < ANCHOR.y + ANCHOR.height && top + height > ANCHOR.y;
      if (overlaps) visibleOverlaps.push(`top ${top}, height ${height}`);
    };
    try {
      await act(async () => {
        root.render(<Harness />);
      });
      sample();
      for (let frame = 0; frame < 20; frame++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(16);
        });
        sample();
      }
      expect(
        document.querySelector<HTMLElement>('[id^="popover-"]')?.style.opacity,
      ).toBe('1');
      expect(visibleOverlaps).toEqual([]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
