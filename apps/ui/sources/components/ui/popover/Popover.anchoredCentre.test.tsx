import React from 'react';
import { describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';
import { flattenTestStyle as flattenStyle, findPopoverContentView } from '@/dev/testkit/harness/popoverHarness';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { installPopoverCommonModuleMocks } from './popoverTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installPopoverCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock({ platformOS: 'ios' }, {
            useWindowDimensions: () => ({ width: 1000, height: 800 }),
        });
    },
});

function readNumber(style: Record<string, unknown>, key: string): number {
    const value = style[key];
    if (typeof value !== 'number') throw new Error(`Expected numeric ${key}, got ${JSON.stringify(value)}`);
    return value;
}

type AnchorRect = Readonly<{ left: number; top: number; width: number; height: number }>;

/**
 * A tooltip-shaped popover: content-sized, centred on its anchor. The content reports its own
 * size through layout (the measurement boundary); the owner places it.
 */
async function renderCentredPopover(anchor: AnchorRect, content: Readonly<{ width: number; height: number }>, options: Readonly<{
    placement?: 'top' | 'bottom';
    flip?: boolean;
}> = {}) {
    const { Popover } = await import('./Popover');
    const { OverlayPortalProvider, OverlayPortalHost } = await import('./OverlayPortal');
    const { PopoverPortalTargetContextProvider } = await import('./PopoverPortalTarget');
    const portalRootNode = {
        measureInWindow: (cb: any) => cb(0, 0, 1000, 800),
        measure: (cb: any) => cb(0, 0, 1000, 800, 0, 0),
    } as any;
    const portalTarget = { rootRef: { current: portalRootNode }, layout: { width: 1000, height: 800 } } as const;

    const screen = await renderScreen(
        <PopoverPortalTargetContextProvider value={portalTarget}>
            <OverlayPortalProvider>
                <Popover
                    open
                    backdrop={false}
                    anchor={{ kind: 'rect', rect: anchor }}
                    portal={{ native: true, matchAnchorWidth: false, anchorAlign: 'center', sizeToContent: true }}
                    placement={options.placement ?? 'top'}
                    flip={options.flip}
                    gap={6}
                    minWidth={0}
                    maxWidthCap={240}
                    maxHeightCap={80}
                >
                    {() => React.createElement('TooltipBubble')}
                </Popover>
                <OverlayPortalHost />
            </OverlayPortalProvider>
        </PopoverPortalTargetContextProvider>,
    );
    await act(async () => {
        await flushHookEffects({ cycles: 1, turns: 6 });
    });
    const contentView = findPopoverContentView(screen, 'TooltipBubble');
    expect(contentView).toBeTruthy();
    const padding = Number(flattenStyle(contentView?.props?.style).paddingLeft ?? 0);
    await act(async () => {
        contentView?.props?.onLayout?.({
            nativeEvent: { layout: { x: 0, y: 0, width: content.width + padding * 2, height: content.height + padding * 2 } },
        });
        await flushHookEffects({ cycles: 1, turns: 6 });
    });
    const style = flattenStyle(findPopoverContentView(screen, 'TooltipBubble')?.props?.style);
    const visualLeft = readNumber(style, 'left') + padding;
    return { style, visualLeft };
}

describe('Popover: content-sized and centred on its anchor (tooltips)', () => {
    it('centres the measured content on the anchor centre', async () => {
        // The sidebar footer's Settings button: 28px wide at x=348, so its centre is x=362.
        const anchor = { left: 348, top: 700, width: 28, height: 28 };
        const { style, visualLeft } = await renderCentredPopover(anchor, { width: 64, height: 28 });

        expect(Math.abs(visualLeft + 64 / 2 - (anchor.left + anchor.width / 2))).toBeLessThanOrEqual(2);
        expect(style.opacity).toBe(1);
    });

    it('clamps a centred popover inside the boundary instead of letting it cross the edge', async () => {
        const anchor = { left: 976, top: 700, width: 20, height: 20 };
        const { visualLeft } = await renderCentredPopover(anchor, { width: 120, height: 28 });

        expect(visualLeft + 120).toBeLessThanOrEqual(1000);
        expect(visualLeft).toBeGreaterThanOrEqual(0);
    });

    it('flips an explicit side that cannot fit to the opposite side when asked to', async () => {
        // A top tooltip on a control at the very top of the window has 4px above it.
        const anchor = { left: 400, top: 10, width: 28, height: 28 };
        const { style } = await renderCentredPopover(anchor, { width: 64, height: 28 }, { placement: 'top', flip: true });

        // Bottom placement pins `top` below the anchor: 10 + 28 + 6.
        expect(readNumber(style, 'top') + Number(style.paddingTop ?? 0)).toBe(44);
        expect(style.bottom).toBeUndefined();
    });

    it('keeps explicit-side popovers reachable near the window edge by default', async () => {
        const { style } = await renderCentredPopover({ left: 400, top: 10, width: 28, height: 28 }, { width: 64, height: 28 });
        expect(readNumber(style, 'top') + Number(style.paddingTop ?? 0)).toBe(44);
        expect(style.bottom).toBeUndefined();
    });

    it('honors a caller that explicitly retains its requested side', async () => {
        const { style } = await renderCentredPopover({ left: 400, top: 10, width: 28, height: 28 }, { width: 64, height: 28 }, { flip: false });
        expect(style.top).toBeUndefined();
        expect(typeof style.bottom).toBe('number');
    });
});
