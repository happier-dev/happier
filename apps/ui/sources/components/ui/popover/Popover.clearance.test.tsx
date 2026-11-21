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

/** The composer card spans y=300..480; its chip sits inside it at y=420..452. */
const COMPOSER = { x: 100, y: 300, width: 800, height: 180 } as const;
const CHIP = { left: 300, top: 420, width: 100, height: 32 } as const;

async function renderChipPicker(
  placement: 'top' | 'bottom',
  withClearance: boolean,
  options: Readonly<{ chip?: Readonly<{ left: number; top: number; width: number; height: number }>; withinComposerWidth?: boolean; composerWidthFromContext?: boolean }> = {},
) {
  const { Popover } = await import('./Popover');
  const { PopoverBoundaryProvider } = await import('./PopoverBoundary');
  const { OverlayPortalProvider, OverlayPortalHost } =
    await import('./OverlayPortal');
  const { PopoverPortalTargetContextProvider } =
    await import('./PopoverPortalTarget');
  const portalRootNode = {
    measureInWindow: (cb: any) => cb(0, 0, 1000, 800),
    measure: (cb: any) => cb(0, 0, 1000, 800, 0, 0),
  } as any;
  const composerNode = {
    measureInWindow: (cb: any) =>
      cb(COMPOSER.x, COMPOSER.y, COMPOSER.width, COMPOSER.height),
  } as any;
  const wrapInContextBoundary = (popover: React.ReactElement) => options.composerWidthFromContext
    ? <PopoverBoundaryProvider boundaryRef={{ current: composerNode }} axis="horizontal">{popover}</PopoverBoundaryProvider>
    : popover;
  const portalTarget = {
    rootRef: { current: portalRootNode },
    layout: { width: 1000, height: 800 },
  } as const;
  const screen = await renderScreen(
    <PopoverPortalTargetContextProvider value={portalTarget}>
      <OverlayPortalProvider>
        {wrapInContextBoundary(<Popover
          open
          backdrop={false}
          anchor={{ kind: 'rect', rect: options.chip ?? CHIP }}
          clearanceRef={withClearance ? { current: composerNode } : undefined}
          horizontalBoundaryRef={options.withinComposerWidth ? { current: composerNode } : undefined}
          portal={{
            native: true,
            matchAnchorWidth: false,
            anchorAlign: 'start',
          }}
          placement={placement}
          gap={8}
          maxHeightCap={200}
          maxWidthCap={400}
        >
          {() => React.createElement('Picker')}
        </Popover>)}
        <OverlayPortalHost />
      </OverlayPortalProvider>
    </PopoverPortalTargetContextProvider>,
  );
  await act(async () => {
    await flushHookEffects({ cycles: 1, turns: 6, frames: 1 });
  });
  const style = flattenStyle(
    findPopoverContentView(screen, 'Picker')?.props?.style,
  );
  return {
    left: Number(style.left),
    top: style.top === undefined ? null : Number(style.top),
    bottomEdge: style.bottom === undefined ? null : 800 - Number(style.bottom),
    maxHeight: style.maxHeight === undefined ? null : Number(style.maxHeight),
  };
}

describe('Popover: a clearance view the popover never covers', () => {
    // The box carries the portal's shadow gutter, so edges are compared with the same popover hung
    // from the chip alone: the clearance moves it by exactly the distance from the chip to the card edge.
    it('opens above the whole clearance view, not just above its trigger', async () => {
        const fromChip = await renderChipPicker('top', false);
        const withClearance = await renderChipPicker('top', true);
        expect(withClearance.bottomEdge! - fromChip.bottomEdge!).toBe(COMPOSER.y - CHIP.top);
        // Horizontally it still hangs from the chip.
        expect(withClearance.left).toBe(fromChip.left);
    });

    it('opens below the whole clearance view when placed below', async () => {
        const fromChip = await renderChipPicker('bottom', false);
        const withClearance = await renderChipPicker('bottom', true);
        expect(withClearance.top! - fromChip.top!).toBe(COMPOSER.y + COMPOSER.height - (CHIP.top + CHIP.height));
    });
});

describe('Popover: a horizontal boundary narrower than the window', () => {
    // A 400-wide picker hung from a chip near the composer's right end would run past the composer
    // (x=900) though the window (1000) has room: the composer's width is the horizontal extent.
    const RIGHT_END_CHIP = { left: 560, top: 420, width: 100, height: 32 } as const;

    it('hangs a picker from its chip\'s far edge when the near one would run past the boundary, and leaves its vertical room to the window', async () => {
        const unbounded = await renderChipPicker('top', false, { chip: RIGHT_END_CHIP });
        const bounded = await renderChipPicker('top', false, { chip: RIGHT_END_CHIP, withinComposerWidth: true });
        // From the chip's right edge instead of its left: the picker ends where the chip does.
        expect(unbounded.left - bounded.left).toBe(400 - RIGHT_END_CHIP.width);
        expect(bounded.bottomEdge).toBe(unbounded.bottomEdge);
    });

    it('takes a width-only boundary from context: a picker inside a short panel keeps the window\'s vertical room', async () => {
        const unbounded = await renderChipPicker('top', false, { chip: RIGHT_END_CHIP });
        const fromContext = await renderChipPicker('top', false, { chip: RIGHT_END_CHIP, composerWidthFromContext: true });
        expect(unbounded.left - fromContext.left).toBe(400 - RIGHT_END_CHIP.width);
        expect(fromContext.bottomEdge).toBe(unbounded.bottomEdge);
        expect(fromContext.maxHeight).toBe(unbounded.maxHeight);
    });

    it('leaves a picker that already fits inside it where it hangs', async () => {
        const unbounded = await renderChipPicker('top', false);
        const bounded = await renderChipPicker('top', false, { withinComposerWidth: true });
        expect(bounded.left).toBe(unbounded.left);
    });
});

/** A 520-wide picker hung from a chip at the window's right edge, with a 12 px edge margin. */
async function renderEdgePicker(containerStyle?: Readonly<{ paddingHorizontal: number }>) {
  const { Popover } = await import('./Popover');
  const { OverlayPortalProvider, OverlayPortalHost } = await import('./OverlayPortal');
  const { PopoverPortalTargetContextProvider } = await import('./PopoverPortalTarget');
  const portalRootNode = {
    measureInWindow: (cb: any) => cb(0, 0, 1000, 800),
    measure: (cb: any) => cb(0, 0, 1000, 800, 0, 0),
  } as any;
  const portalTarget = { rootRef: { current: portalRootNode }, layout: { width: 1000, height: 800 } } as const;
  let childMaxWidth = 0;
  const screen = await renderScreen(
    <PopoverPortalTargetContextProvider value={portalTarget}>
      <OverlayPortalProvider>
        <Popover
          open
          backdrop={false}
          anchor={{ kind: 'rect', rect: { left: 940, top: 400, width: 60, height: 32 } }}
          portal={{ native: true, matchAnchorWidth: false, anchorAlign: 'end' }}
          placement="bottom"
          gap={8}
          maxHeightCap={300}
          maxWidthCap={520}
          edgePadding={{ horizontal: 12, vertical: 12 }}
          containerStyle={containerStyle}
        >
          {({ maxWidth }) => {
            childMaxWidth = maxWidth;
            return React.createElement('Picker');
          }}
        </Popover>
        <OverlayPortalHost />
      </OverlayPortalProvider>
    </PopoverPortalTargetContextProvider>,
  );
  await act(async () => {
    await flushHookEffects({ cycles: 1, turns: 6, frames: 1 });
  });
  const style = flattenStyle(findPopoverContentView(screen, 'Picker')?.props?.style);
  const padding = Number(style.paddingRight ?? style.paddingHorizontal ?? 0);
  return {
    visibleRight: Number(style.left) + Number(style.width) - padding,
    visibleWidth: Number(style.width) - padding * 2,
    childMaxWidth,
  };
}

describe('Popover: the screen-edge margin', () => {
  it('keeps the edge margin whatever horizontal padding the caller gives the box and tells its child the width it may fill', async () => {
    // The default box carries the margin as a gutter; a caller that zeroes the box's padding (the
    // composer's pickers) must still stand the margin from the window edge.
    const gutterCarried = await renderEdgePicker();
    const gutterZeroed = (await renderEdgePicker({ paddingHorizontal: 0 })).visibleRight;
    expect([gutterCarried.visibleRight, gutterZeroed]).toEqual([1000 - 12, 1000 - 12]);
    // A child sized by `maxWidth` fits the visible surface (box less gutter) instead of overflowing it.
    expect(gutterCarried.childMaxWidth).toBe(gutterCarried.visibleWidth);
  });
});
