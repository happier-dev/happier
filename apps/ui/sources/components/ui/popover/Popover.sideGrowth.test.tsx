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

// The first test pays the cold import of the Popover graph (over a minute on a busy worker), as in shiftFit.
describe('Popover: a side popover stays where it opened while its content grows', { timeout: 180_000 }, () => {
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

/**
 * A designed panel (`fit: 'shift'`, the Connect sheet) opened from a trigger low in the window, so it stands above
 * it, whose content grows while it is open (a tab with more fields).
 */
async function renderPanelAboveTrigger() {
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
                    anchor={{ kind: 'rect', rect: { left: 300, top: 700, width: 28, height: 28 } }}
                    portal={{ native: true, matchAnchorWidth: false }}
                    placement="bottom"
                    fit="shift"
                    gap={8}
                    maxWidthCap={560}
                    maxHeightCap={640}
                    placementMinSpace={320}
                >
                    {() => React.createElement('ConnectPanel')}
                </Popover>
                <OverlayPortalHost />
            </OverlayPortalProvider>
        </PopoverPortalTargetContextProvider>,
    );
    await act(async () => {
        await flushHookEffects({ cycles: 2, turns: 6, frames: 1 });
    });
    const layout = async (height: number) => {
        const view = findPopoverContentView(screen, 'ConnectPanel');
        await act(async () => {
            view?.props?.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 560, height: height + NATIVE_SHADOW_OUTSET_PX * 2 } } });
            await flushHookEffects({ cycles: 2, turns: 6, frames: 1 });
        });
        const style = flattenStyle(findPopoverContentView(screen, 'ConnectPanel')?.props?.style);
        // The surface's top, net of the native portal's shadow outset, whichever edge the box is pinned by.
        if (typeof style.top === 'number') return style.top + NATIVE_SHADOW_OUTSET_PX;
        if (typeof style.bottom === 'number') return 800 - (style.bottom + NATIVE_SHADOW_OUTSET_PX) - height;
        throw new Error(`Expected a numeric top or bottom, got ${JSON.stringify(style)}`);
    };
    return { layout };
}

describe('Popover: a designed panel above its trigger stays where it opened while its content grows', { timeout: 180_000 }, () => {
    it('keeps its top, so the controls under the pointer stay put, and grows down over the trigger', async () => {
        const { layout } = await renderPanelAboveTrigger();
        // 200 tall does not fit below the trigger (700 + 28 + 8 + 200 > 800): it opens above it, ending at 692.
        const openedTop = await layout(200);
        expect(openedTop).toBe(492);
        // A tab with more fields: pinning its bottom would lift it to 412; it keeps its top instead.
        expect(await layout(280)).toBe(openedTop);
    });

    it('rises only by what no longer fits inside the window', async () => {
        const { layout } = await renderPanelAboveTrigger();
        await layout(200);
        expect(await layout(400)).toBe(400);
    });
});

/**
 * A submenu beside its row (start-aligned): it opens on a tall placeholder (a sheet reserving rows while it
 * loads) and then settles on short content (a "Couldn't check" line).
 */
async function renderSubmenuBesideRow(edgePadding: number | Readonly<{ horizontal: number; vertical: number }> = 0) {
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
                    anchor={{ kind: 'rect', rect: { left: 300, top: 500, width: 300, height: 48 } }}
                    portal={{ native: true, matchAnchorWidth: false, anchorAlignVertical: 'start' }}
                    placement="right"
                    gap={4}
                    maxWidthCap={360}
                    maxHeightCap={640}
                    placementMinSpace={320}
                    edgePadding={edgePadding}
                >
                    {() => React.createElement('SubmenuSheet')}
                </Popover>
                <OverlayPortalHost />
            </OverlayPortalProvider>
        </PopoverPortalTargetContextProvider>,
    );
    await act(async () => {
        await flushHookEffects({ cycles: 2, turns: 6, frames: 1 });
    });
    const layout = async (height: number) => {
        const view = findPopoverContentView(screen, 'SubmenuSheet');
        await act(async () => {
            view?.props?.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 360, height: height + NATIVE_SHADOW_OUTSET_PX * 2 } } });
            await flushHookEffects({ cycles: 2, turns: 6, frames: 1 });
        });
        const style = flattenStyle(findPopoverContentView(screen, 'SubmenuSheet')?.props?.style);
        if (typeof style.top !== 'number') throw new Error(`Expected numeric top, got ${JSON.stringify(style.top)}`);
        return style.top + NATIVE_SHADOW_OUTSET_PX;
    };
    return { layout };
}

describe('Popover: a submenu stands beside its row whenever its content fits below it', { timeout: 180_000 }, () => {
    it('rises for a tall placeholder, then returns to its row once the content fits below', async () => {
        const { layout } = await renderSubmenuBesideRow();
        // 600 tall from the row (500) would cross the 800 bottom: it rises only that far.
        expect(await layout(600)).toBeLessThan(500);
        // The content settles at 160: it fits below the row, so the submenu stands at its row, not over the page above.
        expect(await layout(160)).toBe(500);
    });

    it('puts its surface, not its transparent edge gutter, on the row\'s top edge', async () => {
        const { layout } = await renderSubmenuBesideRow({ horizontal: 16, vertical: 16 });
        // The box carries a 16 px gutter above its surface: the box starts 16 above the row so the surface meets it.
        expect(await layout(160 + 32)).toBe(500 - 16);
    });
});
