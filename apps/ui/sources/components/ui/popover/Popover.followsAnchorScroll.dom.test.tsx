/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { installPopoverCommonModuleMocks } from './popoverTestHelpers';

// WF-ACCEPT-1119 item 2: the workflow editor's Step options popover (portaled to the body, bounded by a view that
// does not scroll) stayed at y 488 while the page scrolled its "…" from y 452 to 367. A popover hung from an anchor
// follows that anchor whichever ancestor scrolls it, without waiting for the scroll to end.
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
const { View, ScrollView } = await import('react-native');

afterEach(() => {
  vi.restoreAllMocks();
});

it('follows its anchor while the page that holds it scrolls, though its boundary is another view', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const anchorRect = { x: 1250, y: 452, width: 28, height: 28 };
  // jsdom has no layout: the measured rects are the boundary. The editor column is the popover's bound.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      if (this.dataset.testid === 'step-more')
        return new DOMRect(
          anchorRect.x,
          anchorRect.y,
          anchorRect.width,
          anchorRect.height,
        );
      if (this.dataset.testid === 'editor-column')
        return new DOMRect(380, 40, 1000, 850);
      if (this.dataset.testid === 'editor-page')
        return new DOMRect(380, 40, 1000, 850);
      return new DOMRect(0, 0, 400, 240);
    },
  );
  function Harness() {
    const anchor = React.useRef<React.ComponentRef<typeof View>>(null);
    const column = React.useRef<React.ComponentRef<typeof View>>(null);
    return (
      <View ref={column} testID="editor-column">
        <ScrollView testID="editor-page">
          <View ref={anchor} testID="step-more" />
        </ScrollView>
        <Popover
          open
          anchorRef={anchor}
          boundaryRef={column}
          placement="auto-vertical"
          portal={{
            web: { target: 'body' },
            native: true,
            matchAnchorWidth: false,
            anchorAlign: 'end',
          }}
          onRequestClose={() => {}}
        >
          {() => <div data-testid="step-options" />}
        </Popover>
      </View>
    );
  }
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    const panel = document.querySelector<HTMLElement>('[id^="popover-"]');
    const shownTop = () => Number.parseFloat(panel!.style.top);
    const before = shownTop();
    expect(Number.isFinite(before)).toBe(true);

    // The page scrolls the "…" up by 85 px; one frame later the popover stands as far below it as before.
    anchorRect.y = 367;
    const page = document.querySelector<HTMLElement>(
      '[data-testid="editor-page"]',
    )!;
    await act(async () => {
      page.dispatchEvent(new Event('scroll'));
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(shownTop()).toBe(before - 85);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
