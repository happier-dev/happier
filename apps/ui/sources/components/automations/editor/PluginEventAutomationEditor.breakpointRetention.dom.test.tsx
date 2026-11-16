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

it('keeps focus and selection on the second field while an open popover becomes a phone sheet', async () => {
  vi.useFakeTimers();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(100, 200, 160, 40),
  );
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  function Harness() {
    const anchor = React.useRef<View | null>(null);
    return <>
      <View ref={anchor}><button data-testid="focus-opener">Open</button></View>
      <Popover open anchorRef={anchor} phonePresentation="sheet" accessibilityLabel="Edit fields"
        portal={{ web: true }} onRequestClose={() => {}}>
        {() => <><input data-testid="first-field" /><textarea data-testid="second-field" defaultValue="A reviewed result" /></>}
      </Popover>
    </>;
  }
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    const field = document.querySelector<HTMLTextAreaElement>('[data-testid="second-field"]')!;
    field.focus();
    field.setSelectionRange(2, 10);
    expect(document.activeElement).toBe(field);
    viewport.width = 390;
    viewport.height = 844;
    await act(async () => root.render(<Harness />));
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(document.querySelector('[role="dialog"]')?.contains(field)).toBe(true);
    expect(document.activeElement).toBe(field);
    expect([field.selectionStart, field.selectionEnd]).toEqual([2, 10]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

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
