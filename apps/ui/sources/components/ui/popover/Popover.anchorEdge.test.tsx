import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

// Collect the real owner graph before interaction deadlines begin.
const { Popover } = await import('./Popover');
const { OverlayPortalProvider, OverlayPortalHost } = await import('./OverlayPortal');
const { PopoverPortalTargetContextProvider } = await import('./PopoverPortalTarget');

/** A fixed-width picker (520 wide) hung from a chip, as the composer's list pickers are. */
async function renderPicker(anchor: AnchorRect, anchorAlign: 'start' | 'end' | 'auto', onAnchorHidden?: () => void,
    portalOverride?: Readonly<{ matchAnchorWidth: boolean; anchoredMinWidth?: number }>) {
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
                    dismissWhenAnchorHidden={Boolean(onAnchorHidden)}
                    onRequestClose={onAnchorHidden}
                    backdrop={false}
                    anchor={{ kind: 'rect', rect: anchor }}
                    portal={{ native: true, matchAnchorWidth: false, anchorAlign, ...portalOverride }}
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
    it('dismisses an opted-in tooltip when its anchor leaves the viewport, preserving partially visible anchors', async () => {
        const dismiss = vi.fn();
        await renderPicker({ left: 200, top: 790, width: 100, height: 32 }, 'start', dismiss);
        expect(dismiss).not.toHaveBeenCalled();
        await renderPicker({ left: 200, top: 801, width: 100, height: 32 }, 'start', dismiss);
        expect(dismiss).toHaveBeenCalled();
    });
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

describe('Popover: a field-width picker keeps a readable minimum', () => {
    it('opens a narrow field\'s picker at the minimum from the field\'s own edge, and a wide field\'s at its width', async () => {
        const narrow = await renderPicker({ left: 200, top: 100, width: 280, height: 32 }, 'start', undefined,
            { matchAnchorWidth: true, anchoredMinWidth: 420 });
        expect(narrow).toEqual({ left: 200, width: 420 });
        const wide = await renderPicker({ left: 100, top: 100, width: 480, height: 32 }, 'start', undefined,
            { matchAnchorWidth: true, anchoredMinWidth: 420 });
        expect(wide).toEqual({ left: 100, width: 480 });
    });

});
