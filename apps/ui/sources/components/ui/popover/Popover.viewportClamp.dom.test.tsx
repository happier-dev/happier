/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { installPopoverCommonModuleMocks } from './popoverTestHelpers';

// QA-B3 r173 (desktop web 1280×577, docked composer in a Session): the engine picker's boundary reached above the
// window, so the popover took its 420 cap as its room and its option rail started at y −92, out of reach.
const viewport = vi.hoisted(() => ({ width: 1280, height: 577 }));
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
  vi.restoreAllMocks();
});

const CHIP = { x: 500, y: 358, width: 120, height: 32 };
/** A Session pane laid out taller than the window, starting above its top edge. */
const PANE = { x: 0, y: -400, width: 1280, height: 1200 };

it('gives a popover only the room the window shows when its boundary reaches past the window (577 px)', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  // jsdom has no layout: window rects are the measured boundary. The content is as tall as the bound it was given.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      if (this.dataset.testid === 'engine-chip')
        return new DOMRect(CHIP.x, CHIP.y, CHIP.width, CHIP.height);
      if (this.dataset.testid === 'session-pane')
        return new DOMRect(PANE.x, PANE.y, PANE.width, PANE.height);
      const body =
        this.querySelector<HTMLElement>('[data-max]') ??
        (this.dataset.max ? this : null);
      if (body) return new DOMRect(0, 0, 360, Number(body.dataset.max));
      return new DOMRect(0, 0, 360, 40);
    },
  );
  let givenMaxHeight = 0;
  function Harness() {
    const anchor = React.useRef<React.ComponentRef<typeof View>>(null);
    const pane = React.useRef<React.ComponentRef<typeof View>>(null);
    return (
      <>
        {/* The boundary provider is mounted before the popover reads it, as a pane's boundary is. */}
        <View ref={pane} testID="session-pane" />
        <View ref={anchor} testID="engine-chip" />
        <Popover
          open
          anchorRef={anchor}
          boundaryRef={pane}
          placement="top"
          maxHeightCap={420}
          maxWidthCap={720}
          portal={{ web: true }}
          onRequestClose={() => {}}
        >
          {({ maxHeight }) => {
            givenMaxHeight = maxHeight;
            return <div data-max={String(maxHeight)} />;
          }}
        </Popover>
      </>
    );
  }
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    const panel = document.querySelector<HTMLElement>('[id^="popover-"]');
    expect(panel?.style.opacity).toBe('1');
    // The room above the chip ends at the window's top edge, not at the pane's: content bounded by it fits.
    expect(givenMaxHeight).toBeGreaterThan(0);
    expect(givenMaxHeight).toBeLessThan(CHIP.y);
    const bottom = Number.parseFloat(panel!.style.bottom);
    const top = Number.parseFloat(panel!.style.top);
    const shownTop = Number.isFinite(top)
      ? top
      : viewport.height - bottom - givenMaxHeight;
    expect(shownTop).toBeGreaterThanOrEqual(0);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
