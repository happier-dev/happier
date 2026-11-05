import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';
import {
  flattenTestStyle as flattenStyle,
  findPopoverContentView,
  withPopoverWebGlobals,
} from '@/dev/testkit/harness/popoverHarness';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { installPopoverCommonModuleMocks } from './popoverTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installPopoverCommonModuleMocks({
  reactNative: async () => {
    const { createReactNativeNativeMock } =
      await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock(
      { platformOS: 'ios' },
      {
        useWindowDimensions: () => ({ width: 1000, height: 800 }),
      },
    );
  },
});

let restorePopoverGlobals: (() => void) | undefined;
beforeEach(() => {
  restorePopoverGlobals = withPopoverWebGlobals();
});
afterEach(() => {
  restorePopoverGlobals?.();
});

/**
 * A designed panel (the widget Add surface, 600 tall) opened from a trigger in the middle of an
 * 800-high window: neither side holds it.
 */
async function renderPanel(
  fit: 'shrink' | 'shift' | undefined,
  over: Readonly<{ placement?: 'top' | 'bottom'; anchorTop?: number; flip?: boolean; contentHeight?: number; cap?: number | 'default' }> = {},
) {
  const { Popover } = await import('./Popover');
  const { OverlayPortalProvider, OverlayPortalHost } =
    await import('./OverlayPortal');
  const { PopoverPortalTargetContextProvider } =
    await import('./PopoverPortalTarget');
  const portalRootNode = {
    measureInWindow: (cb: any) => cb(0, 0, 1000, 800),
    measure: (cb: any) => cb(0, 0, 1000, 800, 0, 0),
  } as any;
  const portalTarget = {
    rootRef: { current: portalRootNode },
    layout: { width: 1000, height: 800 },
  } as const;
  const seen: number[] = [];
  const screen = await renderScreen(
    <PopoverPortalTargetContextProvider value={portalTarget}>
      <OverlayPortalProvider>
        <Popover
          open
          backdrop={false}
          anchor={{
            kind: 'rect',
            rect: { left: 700, top: over.anchorTop ?? 400, width: 100, height: 32 },
          }}
          portal={{ native: true, matchAnchorWidth: false, anchorAlign: 'end' }}
          placement={over.placement ?? 'bottom'}
          {...(over.flip === undefined ? {} : { flip: over.flip })}
          gap={8}
          {...(over.cap === 'default' ? {} : { maxHeightCap: over.cap ?? 600 })}
          maxWidthCap={900}
          {...(fit ? { fit } : {})}
        >
          {({ maxHeight }) => {
            seen.push(maxHeight);
            return React.createElement('AddPanel');
          }}
        </Popover>
        <OverlayPortalHost />
      </OverlayPortalProvider>
    </PopoverPortalTargetContextProvider>,
  );
  await act(async () => {
    await flushHookEffects({ cycles: 1, turns: 6, frames: 1 });
  });
  // The content reports its laid-out size (the measurement boundary), as a mounted surface does.
  const contentView = findPopoverContentView(screen, 'AddPanel');
  expect(contentView).toBeTruthy();
  await act(async () => {
    contentView?.props?.onLayout?.({
      nativeEvent: { layout: { x: 0, y: 0, width: 900, height: over.contentHeight ?? seen.at(-1) ?? 600 } },
    });
    await flushHookEffects({ cycles: 1, turns: 6, frames: 1 });
  });
  const style = flattenStyle(
    findPopoverContentView(screen, 'AddPanel')?.props?.style,
  );
  // The entrance motion's side: the popover's motion frame carries the side it enters from.
  const motion = screen.root.findAll((node) => node.props?.kind === 'popover' && typeof node.props?.direction === 'string');
  const panelTop = style.top !== undefined
    ? Number(style.top) + Number(style.paddingTop ?? 0)
    : 800 - Number(style.bottom) - Number(style.paddingBottom ?? 0) - (over.contentHeight ?? 600);
  return { maxHeight: seen.at(-1), style, panelTop, direction: motion[0]?.props?.direction as string | undefined };
}

describe('Popover: a designed panel keeps its size when neither side of its trigger holds it', { timeout: 180_000 }, () => {
  it('shifts the whole panel inside the window instead of shrinking it to one side of the trigger', async () => {
    const { maxHeight, style } = await renderPanel('shift');
    expect(maxHeight).toBe(600);
    // Below the trigger would end at 1040; the panel moves up until its bottom meets the window (800 - 600).
    expect(Number(style.top) + Number(style.paddingTop ?? 0)).toBe(200);
    expect(style.bottom).toBeUndefined();
  });

  it('opens a panel above its trigger when it does not fit below but fits above, instead of covering the trigger', async () => {
    // A "+" low in a rail (lab: Credentials Secrets): 800 - 532 - 8 = 260 below, 500 - 8 = 492 above, panel 400.
    const { panelTop, direction } = await renderPanel('shift', { anchorTop: 500, contentHeight: 400 });
    // It ends a gap above the trigger, whole, with its actions inside the window.
    expect(panelTop).toBe(500 - 8 - 400);
    // It enters from its trigger's side, as any popover placed above does.
    expect(direction).toBe('top');
  });

  it('keeps a panel that fits below its trigger below it', async () => {
    const { panelTop, direction } = await renderPanel('shift', { anchorTop: 100, contentHeight: 400 });
    expect(panelTop).toBe(100 + 32 + 8);
    expect(direction).toBe('bottom');
  });

  it('never lets a panel hung above its trigger start above the window while its size is out of date', async () => {
    // The trigger has scrolled up to 100 while the panel still stands 500 tall (measured when there was room):
    // pinned to the trigger it would start 400 above the window, so its bottom edge is held down instead.
    const { style } = await renderPanel(undefined, { placement: 'top', flip: false, anchorTop: 100, contentHeight: 500 });
    expect(800 - Number(style.bottom) - 500).toBeGreaterThanOrEqual(0);
  });

  it('keeps shrinking menus to the larger side by default', async () => {
    const { maxHeight } = await renderPanel(undefined);
    // Above the trigger: 400 - 8.
    expect(maxHeight).toBe(392);
  });

  it('lets a popover with no explicit cap use the room its window gives, so tall content scrolls instead of hiding', async () => {
    // Below a trigger at 100 an 800-high window leaves 800 - 132 - 8 = 660; the old fixed 400 cap hid the rest.
    const { maxHeight } = await renderPanel(undefined, { cap: 'default', anchorTop: 100 });
    expect(maxHeight).toBe(660);
  });

  it('still prefers the side with the usual 400 of room when no cap is given', async () => {
    // Auto placement: below the trigger there is 660 and above 92 - 8; the roomy side is chosen as before.
    const { maxHeight } = await renderPanel(undefined, { cap: 'default', placement: 'bottom', anchorTop: 600, flip: true });
    // Above the trigger: 600 - 8, not the 160 left below.
    expect(maxHeight).toBe(592);
  });
});
