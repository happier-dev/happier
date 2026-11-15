/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import { installPopoverCommonModuleMocks } from './popoverTestHelpers';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

installPopoverCommonModuleMocks({
  reactNative: async () => ({
    ...(await vi.importActual<typeof import('react-native-web')>(
      'react-native-web',
    )),
    // Viewport dimensions are a platform boundary; the anchored popover and its focus owners stay real.
    useWindowDimensions: () => ({
      width: 1440,
      height: 1000,
      scale: 1,
      fontScale: 1,
    }),
  }),
});

const { Popover } = await import('./Popover');
const { View } = await import('react-native');

// L04 (QA-LAYOUT-1114 F2): a popover its own content closes (Step options' Done) returns focus to its opener, as
// Escape does. Both the content-driven unmount and `open` turning false go through the popover's one close owner.
it.each(['unmount', 'closed'] as const)(
  'returns focus to the opener when the content closes the popover (%s)',
  async (shape) => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(100, 200, 160, 40),
    );
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    function Harness() {
      const [open, setOpen] = React.useState(false);
      const anchorRef = React.useRef<View>(null);
      const popover = (
        <Popover
          open={open}
          anchorRef={anchorRef}
          focusReturnRef={anchorRef}
          portal={{ web: true }}
          accessibilityLabel="Step options"
          onRequestClose={() => setOpen(false)}
        >
          {() => (
            <button
              data-testid="step-options-done"
              onClick={() => setOpen(false)}
            >
              Done
            </button>
          )}
        </Popover>
      );
      return (
        <>
          <View ref={anchorRef}>
            <button
              data-testid="step-options-opener"
              onClick={() => setOpen(true)}
            >
              Step options
            </button>
          </View>
          {shape === 'unmount' ? (open ? popover : null) : popover}
        </>
      );
    }
    try {
      await act(async () => root.render(<Harness />));
      const opener = container.querySelector<HTMLButtonElement>(
        '[data-testid="step-options-opener"]',
      )!;
      await act(async () => {
        opener.focus();
        opener.click();
      });
      const done = document.querySelector<HTMLButtonElement>(
        '[data-testid="step-options-done"]',
      )!;
      expect(done).not.toBeNull();
      await act(async () => {
        done.focus();
      });
      expect(document.activeElement).toBe(done);
      await act(async () => {
        done.click();
      });
      await vi.waitFor(async () => {
        await act(async () => {});
        expect(
          document.querySelector('[data-testid="step-options-done"]'),
        ).toBeNull();
        expect(document.activeElement).toBe(opener);
      });
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.restoreAllMocks();
    }
  },
);
