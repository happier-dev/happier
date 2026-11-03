import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';
import { flattenTestStyle as flattenStyle, findPopoverContentView, withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
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

let restorePopoverGlobals: (() => void) | undefined;
beforeEach(() => {
    restorePopoverGlobals = withPopoverWebGlobals();
});
afterEach(() => {
    restorePopoverGlobals?.();
});

type AnchorRect = Readonly<{ left: number; top: number; width: number; height: number }>;

/** A fixed-width picker (520 wide) hung from a chip, as the composer's list pickers are. */
async function renderPicker(anchor: AnchorRect, anchorAlign: 'start' | 'end' | 'auto') {
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
                    portal={{ native: true, matchAnchorWidth: false, anchorAlign }}
                    placement="bottom"
                    gap={8}
                    maxHeightCap={300}
                    maxWidthCap={520}
                    edgePadding={{ horizontal: 0, vertical: 0 }}
                >
                    {() => React.createElement('Picker')}
                </Popover>
                <OverlayPortalHost />
            </OverlayPortalProvider>
        </PopoverPortalTargetContextProvider>,
    );
    await act(async () => {
        await flushHookEffects({ cycles: 1, turns: 6, frames: 1 });
    });
    const style = flattenStyle(findPopoverContentView(screen, 'Picker')?.props?.style);
    const padding = Number(style.paddingLeft ?? 0);
    return { left: Number(style.left) + padding, width: Number(style.width) - padding * 2 };
}

describe('Popover: a fixed-width popover hangs from its anchor edge', () => {
    it('hangs a start-aligned popover from the anchor\'s end edge when the start edge leaves it no room', async () => {
        // A chip at x=600..700 in a 1000-wide window: a 520-wide popover from x=600 would cross the edge.
        const { left, width } = await renderPicker({ left: 600, top: 400, width: 100, height: 32 }, 'start');
        expect(width).toBe(520);
        expect(left + width).toBe(700);
    });

    it('stays on the start edge while that edge leaves the popover its full width', async () => {
        const { left } = await renderPicker({ left: 200, top: 400, width: 100, height: 32 }, 'start');
        expect(left).toBe(200);
    });

    it('hangs an end-aligned popover from the anchor\'s start edge when the end edge leaves it no room', async () => {
        const { left } = await renderPicker({ left: 100, top: 400, width: 100, height: 32 }, 'end');
        expect(left).toBe(100);
    });
});

describe('Popover: an auto-aligned popover opens toward the open side of the window', () => {
    it('hangs from the start edge of an anchor on the left, so it never spans what sits left of its trigger', async () => {
        // Both edges leave it its full width; more of the window lies right of this trigger, so it opens there
        // instead of covering what sits left of it (a rail's "+" beside the Settings sidebar).
        const { left, width } = await renderPicker({ left: 440, top: 400, width: 100, height: 32 }, 'auto');
        expect(width).toBe(520);
        expect(left).toBe(440);
    });

    it('hangs from the end edge of an anchor on the right, as a page header\'s Share does', async () => {
        const { left, width } = await renderPicker({ left: 480, top: 400, width: 120, height: 32 }, 'auto');
        expect(left + width).toBe(600);
    });
});
