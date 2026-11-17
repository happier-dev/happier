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

/** A field low on the page: below it there is less room than the picker's initial cap. */
const ANCHOR = { x: 651, y: 351, width: 280, height: 32 };
const INITIAL_CAP = 560;

describe('Popover first placement of a field picker', () => {
  it('paints its first frame under the field, never placed from the height its content had under the initial cap', async () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    // Layout is the platform boundary. The content's first measurement still reports the cap it was first rendered
    // under (the browser measures a frame later than placement shrinks the cap); later ones report the current cap.
    let firstContentHeight: number | null = null;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.dataset.testid === 'field')
          return new DOMRect(ANCHOR.x, ANCHOR.y, ANCHOR.width, ANCHOR.height);
        const body = this.querySelector<HTMLElement>('[data-max]') ?? (this.dataset.max ? this : null);
        if (body) {
          const current = Number(body.dataset.max);
          if (firstContentHeight === null) firstContentHeight = INITIAL_CAP;
          const height = firstContentHeight !== -1 ? firstContentHeight : current;
          firstContentHeight = -1;
          return new DOMRect(0, 0, 420, height);
        }
        return new DOMRect(0, 0, 420, 40);
      },
    );
    function Harness() {
      const anchor = React.useRef<React.ComponentRef<typeof View>>(null);
      return (
        <>
          <View ref={anchor} testID="field" />
          <Popover open anchorRef={anchor} placement="bottom" flip maxHeightCap={INITIAL_CAP} maxWidthCap={Number.MAX_SAFE_INTEGER}
            portal={{ web: true, matchAnchorWidth: true, anchoredMinWidth: 420 }} onRequestClose={() => {}}>
            {({ maxHeight }) => <div data-max={String(maxHeight)} />}
          </Popover>
        </>
      );
    }
    const shownTops: number[] = [];
    const sample = () => {
      const panel = document.querySelector<HTMLElement>('[id^="popover-"]');
      if (!panel || panel.style.opacity !== '1') return;
      const top = Number.parseFloat(panel.style.top);
      if (shownTops[shownTops.length - 1] !== top) shownTops.push(top);
    };
    try {
      await act(async () => { root.render(<Harness />); });
      sample();
      for (let frame = 0; frame < 20; frame++) {
        await act(async () => { await vi.advanceTimersByTimeAsync(16); });
        sample();
      }
      // One place from the first shown frame on, and that place is under the field.
      expect(shownTops).toHaveLength(1);
      expect(shownTops[0]).toBeGreaterThanOrEqual(ANCHOR.y + ANCHOR.height);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
