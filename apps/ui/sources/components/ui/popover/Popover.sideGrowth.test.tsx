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

/** Native portal boxes carry a transparent outset for the shadow (Popover's NATIVE_PORTAL_SHADOW_OUTSET). */
const NATIVE_SHADOW_OUTSET_PX = 16;

let restorePopoverGlobals: (() => void) | undefined;
beforeEach(() => {
    restorePopoverGlobals = withPopoverWebGlobals();
});
afterEach(() => {
    restorePopoverGlobals?.();
});

/**
 * A side popover (an editor's options panel beside its trigger) whose content grows while it is
 * open: a field expands, a sub-page opens. The content reports its size through layout (the
 * measurement boundary); the owner places it.
 */
async function renderSidePopover() {
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
                    anchor={{ kind: 'rect', rect: { left: 300, top: 400, width: 120, height: 28 } }}
                    portal={{ native: true, matchAnchorWidth: false }}
                    placement="right"
                    gap={8}
                    maxWidthCap={360}
                    maxHeightCap={640}
                >
                    {() => React.createElement('OptionsPanel')}
                </Popover>
                <OverlayPortalHost />
            </OverlayPortalProvider>
        </PopoverPortalTargetContextProvider>,
    );
    await act(async () => {
        await flushHookEffects({ cycles: 2, turns: 6, frames: 1 });
    });
    const layout = async (height: number) => {
        const view = findPopoverContentView(screen, 'OptionsPanel');
        await act(async () => {
            // The box's layout carries the shadow outset above and below the surface.
            view?.props?.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 360, height: height + NATIVE_SHADOW_OUTSET_PX * 2 } } });
            await flushHookEffects({ cycles: 2, turns: 6, frames: 1 });
        });
        const style = flattenStyle(findPopoverContentView(screen, 'OptionsPanel')?.props?.style);
        if (typeof style.top !== 'number') throw new Error(`Expected numeric top, got ${JSON.stringify(style.top)}`);
        // The box's top, net of the native portal's shadow outset.
        return style.top + NATIVE_SHADOW_OUTSET_PX;
    };
    return { layout };
}

describe('Popover: a side popover stays where it opened while its content grows', () => {
    it('keeps its top beside the trigger when the taller content still fits below', async () => {
        const { layout } = await renderSidePopover();
        // Opened centred on the trigger (centre y = 414).
        const openedTop = await layout(200);
        expect(openedTop).toBe(314);
        // A field expands: re-centring would lift it to 214; it grows downward instead.
        expect(await layout(400)).toBe(openedTop);
    });

    it('moves up only by what no longer fits, never back to a re-centred or window-top position', async () => {
        const { layout } = await renderSidePopover();
        await layout(200);
        // 600 tall from 314 would cross the 800 bottom: it rises just enough (800 - 600 = 200),
        // not to the re-centred 114.
        expect(await layout(600)).toBe(200);
    });
});
