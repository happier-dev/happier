/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { installPopoverCommonModuleMocks } from '@/components/ui/popover/popoverTestHelpers';

const viewport = vi.hoisted(() => ({ width: 1440, height: 1000 }));
installPopoverCommonModuleMocks({
  reactNative: async () => ({
    ...(await vi.importActual<typeof import('react-native-web')>(
      'react-native-web',
    )),
    // Physical dimensions are the boundary; the popover, its phone sheet and the editor stay real.
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
const { InlinePluginEventEditor } =
  await import('./PluginEventAutomationEditor');
const { EVENT_WATCHERS_SPECIMEN_MODEL } =
  await import('@/components/dev/automations/EventWatchersSpecimen');
const { Popover } = await import('@/components/ui/popover/Popover');
const { View } = await import('react-native');

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  viewport.width = 1440;
  viewport.height = 1000;
});

// C1 (HUNT-UI-STATE-1115): the Event editor inside a trigger popover keeps its composer (open pickers, their search)
// when the window crosses into the phone sheet and back.
it('keeps the Event composer mounted across the phone breakpoint', async () => {
  vi.useFakeTimers();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      return this.dataset.testid === 'c1-anchor'
        ? new DOMRect(100, 200, 160, 40)
        : new DOMRect(0, 0, 360, 300);
    },
  );
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  function Harness() {
    const anchor = React.useRef<View | null>(null);
    return (
      <>
        <View ref={anchor} testID="c1-anchor" />
        <Popover
          open
          anchorRef={anchor}
          phonePresentation="sheet"
          accessibilityLabel="Configure event"
          portal={{ web: true }}
          onRequestClose={() => {}}
        >
          {() => (
            <InlinePluginEventEditor
              model={EVENT_WATCHERS_SPECIMEN_MODEL}
              onComplete={() => {}}
              onCancel={() => {}}
            />
          )}
        </Popover>
      </>
    );
  }
  const composer = () =>
    document.querySelector('[data-testid="automation-event-composer"]');
  const settled = async () => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
  };
  const resize = async (width: number, height: number) => {
    viewport.width = width;
    viewport.height = height;
    await act(async () => {
      root.render(<Harness />);
    });
    await settled();
  };
  try {
    await act(async () => {
      root.render(<Harness />);
    });
    await settled();
    const wide = composer();
    expect(wide).not.toBeNull();

    await resize(390, 844);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(composer()).toBe(wide);

    await resize(1440, 1000);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(composer()).toBe(wide);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
