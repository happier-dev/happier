import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

// The popover module graph is large: load it once, outside each test's own time.
beforeAll(async () => {
    await Promise.all([import('./Popover'), import('./OverlayPortal'), import('./PopoverPortalTarget')]);
}, 300_000);

let restorePopoverGlobals: (() => void) | undefined;
beforeEach(() => {
    restorePopoverGlobals = withPopoverWebGlobals();
});
afterEach(() => {
    restorePopoverGlobals?.();
});

function readNumericStyle(style: Record<string, unknown>, key: string): number {
    const value = style[key];
    if (typeof value !== 'number') {
        throw new Error(`Expected numeric ${key} style`);
    }
    return value;
}

function expectVisualTop(style: Record<string, unknown>, expected: number): void {
    expect(readNumericStyle(style, 'top') + readNumericStyle(style, 'paddingTop')).toBe(expected);
}

describe('Popover (native measurements)', () => {
    it('derives portal-relative anchor coordinates from window measurements when measureLayout is inconsistent (prevents iOS sheet/drawer offsets)', async () => {
        const { Popover } = await import('./Popover');
        const { OverlayPortalProvider, OverlayPortalHost } = await import('./OverlayPortal');
        const { PopoverPortalTargetContextProvider } = await import('./PopoverPortalTarget');

        const portalRootNode = {
            measure: (cb: any) => cb(0, 0, 1000, 600, 0, 200),
        } as any;

        const anchorNode = {
            // Wrong by +100px relative to portalRoot.
            measureLayout: (_relativeTo: any, onSuccess: any) => onSuccess(0, 500, 100, 40),
            // Window coords (pageY=600) should win: portalRootY=200 => relativeY=400.
            measure: (cb: any) => cb(0, 0, 100, 40, 0, 600),
        } as any;

        const anchorRef = { current: anchorNode } as any;
        const portalTarget = {
            rootRef: { current: portalRootNode },
            layout: { width: 1000, height: 600 },
        } as const;

        const screen = await renderScreen(
            <PopoverPortalTargetContextProvider value={portalTarget}>
                <OverlayPortalProvider>
                    <Popover
                        open
                        anchorRef={anchorRef}
                        portal={{ native: true }}
                        placement="bottom"
                        flip={false}
                        gap={0}
                        maxHeightCap={320}
                        onRequestClose={() => {}}
                    >
                        {() => React.createElement('PopoverChild')}
                    </Popover>
                    <OverlayPortalHost />
                </OverlayPortalProvider>
            </PopoverPortalTargetContextProvider>,
        );

        await act(async () => {
            await flushHookEffects({ cycles: 2, turns: 6, frames: 1 });
        });

        const contentView = findPopoverContentView(screen);
        expect(contentView).toBeTruthy();

        const style = flattenStyle(contentView?.props?.style);
        // Correct visual anchor bottom: (600 - 200) + 40 = 440.
        expectVisualTop(style, 440);
    });

    it('does not double-apply the portal-root offset when measureInWindow already reports portal-relative coordinates (prevents popovers rendering too high)', async () => {
        const { Popover } = await import('./Popover');
        const { OverlayPortalProvider, OverlayPortalHost } = await import('./OverlayPortal');
        const { PopoverPortalTargetContextProvider } = await import('./PopoverPortalTarget');

        const portalRootNode = {
            // Window-relative portal root coordinates (contained sheet starts lower on screen).
            measureInWindow: (cb: any) => cb(0, 200, 1000, 600),
            measure: (cb: any) => cb(0, 0, 1000, 600, 0, 200),
        } as any;

        const anchorNode = {
            // BUGGY BUT REALISTIC: some contained presentations report anchor coordinates already
            // relative to the portal root via `measureInWindow`.
            measureInWindow: (cb: any) => cb(0, 400, 100, 40),
            // Correct portal-relative coordinates via measureLayout.
            measureLayout: (_relativeTo: any, onSuccess: any) => onSuccess(0, 400, 100, 40),
        } as any;

        const anchorRef = { current: anchorNode } as any;
        const portalTarget = {
            rootRef: { current: portalRootNode },
            layout: { width: 1000, height: 600 },
        } as const;

        const screen = await renderScreen(
            <PopoverPortalTargetContextProvider value={portalTarget}>
                <OverlayPortalProvider>
                    <Popover
                        open
                        anchorRef={anchorRef}
                        portal={{ native: true }}
                        placement="bottom"
                        flip={false}
                        gap={0}
                        maxHeightCap={320}
                        onRequestClose={() => {}}
                    >
                        {() => React.createElement('PopoverChild')}
                    </Popover>
                    <OverlayPortalHost />
                </OverlayPortalProvider>
            </PopoverPortalTargetContextProvider>,
        );

        await act(async () => {
            await flushHookEffects({ cycles: 2, turns: 6, frames: 1 });
        });

        const contentView = findPopoverContentView(screen);
        expect(contentView).toBeTruthy();

        const style = flattenStyle(contentView?.props?.style);
        // If we incorrectly subtract portalRootY again: (400 - 200) + 40 = 240 (too high).
        // Correct visual anchor bottom uses portal-relative coords directly: 400 + 40 = 440.
        expectVisualTop(style, 440);
    });

    it('falls back to measureLayout when window measurements are in a different coordinate space (prevents negative/way-off offsets)', async () => {
        const { Popover } = await import('./Popover');
        const { OverlayPortalProvider, OverlayPortalHost } = await import('./OverlayPortal');
        const { PopoverPortalTargetContextProvider } = await import('./PopoverPortalTarget');

        const portalRootNode = {
            // Portal root is presented lower on the screen (e.g. contained sheet).
            measure: (cb: any) => cb(0, 0, 1000, 600, 0, 200),
        } as any;

        const anchorNode = {
            // Correct portal-relative coords: y=300.
            measureLayout: (_relativeTo: any, onSuccess: any) => onSuccess(0, 300, 100, 40),
            // Window coords are in a different coordinate space (pageY=100 => relativeY=-100).
            measure: (cb: any) => cb(0, 0, 100, 40, 0, 100),
        } as any;

        const anchorRef = { current: anchorNode } as any;
        const portalTarget = {
            rootRef: { current: portalRootNode },
            layout: { width: 1000, height: 600 },
        } as const;

        const screen = await renderScreen(
            <PopoverPortalTargetContextProvider value={portalTarget}>
                <OverlayPortalProvider>
                    <Popover
                        open
                        anchorRef={anchorRef}
                        portal={{ native: true }}
                        placement="bottom"
                        flip={false}
                        gap={0}
                        maxHeightCap={320}
                        onRequestClose={() => {}}
                    >
                        {() => React.createElement('PopoverChild')}
                    </Popover>
                    <OverlayPortalHost />
                </OverlayPortalProvider>
            </PopoverPortalTargetContextProvider>,
        );

        await act(async () => {
            await flushHookEffects({ cycles: 2, turns: 6, frames: 1 });
        });

        const contentView = findPopoverContentView(screen);
        expect(contentView).toBeTruthy();

        const style = flattenStyle(contentView?.props?.style);
        // Correct visual anchor bottom from measureLayout: 300 + 40 = 340.
        expectVisualTop(style, 340);
    });

    it('prefers measureInWindow over measure() when both exist (keeps portal-root deltas consistent in iOS sheets)', async () => {
        const { Popover } = await import('./Popover');
        const { OverlayPortalProvider, OverlayPortalHost } = await import('./OverlayPortal');
        const { PopoverPortalTargetContextProvider } = await import('./PopoverPortalTarget');

        const portalRootNode = {
            // Window-relative coordinates.
            measureInWindow: (cb: any) => cb(0, 200, 1000, 600),
            // Some contained presentations report a different coordinate space via `measure`.
            measure: (cb: any) => cb(0, 0, 1000, 600, 0, 200),
        } as any;

        const anchorNode = {
            // Window-relative coordinates.
            measureInWindow: (cb: any) => cb(0, 600, 100, 40),
            // Wrong coordinate space (e.g. relative to sheet root) via `measure`.
            measure: (cb: any) => cb(0, 0, 100, 40, 0, 500),
        } as any;

        const anchorRef = { current: anchorNode } as any;
        const portalTarget = {
            rootRef: { current: portalRootNode },
            layout: { width: 1000, height: 600 },
        } as const;

        const screen = await renderScreen(
            <PopoverPortalTargetContextProvider value={portalTarget}>
                <OverlayPortalProvider>
                    <Popover
                        open
                        anchorRef={anchorRef}
                        portal={{ native: true }}
                        placement="bottom"
                        flip={false}
                        gap={0}
                        maxHeightCap={320}
                        onRequestClose={() => {}}
                    >
                        {() => React.createElement('PopoverChild')}
                    </Popover>
                    <OverlayPortalHost />
                </OverlayPortalProvider>
            </PopoverPortalTargetContextProvider>,
        );

        await act(async () => {
            await flushHookEffects({ cycles: 2, turns: 6, frames: 1 });
        });

        const contentView = findPopoverContentView(screen);
        expect(contentView).toBeTruthy();

        const style = flattenStyle(contentView?.props?.style);
        // Correct visual anchor bottom: (600 - 200) + 40 = 440.
        expectVisualTop(style, 440);
    });
    // Native QA 11-09 (R2): a View options panel taller than the room under its ⋯ rose over the trigger row.
    // The measured box carries the shadow outset on both edges; only the surface itself has to fit.
    it('keeps a full-height panel under its trigger, never over it, when its box carries the shadow outset', async () => {
        const { Popover } = await import('./Popover');
        const { OverlayPortalProvider, OverlayPortalHost } = await import('./OverlayPortal');
        const { PopoverPortalTargetContextProvider } = await import('./PopoverPortalTarget');

        const portalRootNode = {
            measureInWindow: (cb: any) => cb(0, 0, 1000, 600),
            measure: (cb: any) => cb(0, 0, 1000, 600, 0, 0),
        } as any;
        const anchorNode = {
            measureInWindow: (cb: any) => cb(900, 100, 40, 40),
            measureLayout: (_relativeTo: any, onSuccess: any) => onSuccess(900, 100, 40, 40),
        } as any;
        const portalTarget = { rootRef: { current: portalRootNode }, layout: { width: 1000, height: 600 } } as const;
        let renderedMaxHeight = 0;

        const screen = await renderScreen(
            <PopoverPortalTargetContextProvider value={portalTarget}>
                <OverlayPortalProvider>
                    <Popover open anchorRef={{ current: anchorNode } as any} portal={{ native: true }} placement="bottom" gap={0} onRequestClose={() => {}}>
                        {({ maxHeight }) => {
                            renderedMaxHeight = maxHeight;
                            return React.createElement('PopoverChild');
                        }}
                    </Popover>
                    <OverlayPortalHost />
                </OverlayPortalProvider>
            </PopoverPortalTargetContextProvider>,
        );
        await act(async () => {
            await flushHookEffects({ cycles: 2, turns: 6, frames: 1 });
        });
        expect(renderedMaxHeight).toBe(460);

        const contentView = findPopoverContentView(screen);
        const style = flattenStyle(contentView?.props?.style);
        const outset = readNumericStyle(style, 'paddingTop');
        // The content fills the room under the trigger; the box adds the outset above and below it.
        await act(async () => {
            contentView?.props?.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 1000, height: renderedMaxHeight + outset * 2 } } });
        });
        await act(async () => {
            await flushHookEffects({ cycles: 2, turns: 6, frames: 1 });
        });

        expectVisualTop(flattenStyle(findPopoverContentView(screen)?.props?.style), 140);
    });
    // Native QA r3n (docked Search "This Home"): a chooser placed above its chip took the whole room above it, and
    // its shorter content sat at the top of that room, far from the chip. A popover placed above its anchor hangs
    // its content from the anchor: the box ends a gap above the anchor and its content stands at the box's bottom.
    it('hangs a top-placed popover\'s content from its anchor when the content is shorter than its room', async () => {
        const { Popover } = await import('./Popover');
        const { OverlayPortalProvider, OverlayPortalHost } = await import('./OverlayPortal');
        const { PopoverPortalTargetContextProvider } = await import('./PopoverPortalTarget');
        const portalRootNode = {
            measureInWindow: (cb: any) => cb(0, 0, 1000, 800),
            measure: (cb: any) => cb(0, 0, 1000, 800, 0, 0),
        } as any;
        const anchorNode = {
            measureInWindow: (cb: any) => cb(600, 438, 120, 32),
            measureLayout: (_relativeTo: any, onSuccess: any) => onSuccess(600, 438, 120, 32),
        } as any;
        let renderedMaxHeight = 0;
        const screen = await renderScreen(
            <PopoverPortalTargetContextProvider value={{ rootRef: { current: portalRootNode }, layout: { width: 1000, height: 800 } }}>
                <OverlayPortalProvider>
                    <Popover open anchorRef={{ current: anchorNode } as any} portal={{ native: true }} placement="top" flip={false}
                        gap={8} onRequestClose={() => {}}>
                        {({ maxHeight }) => {
                            renderedMaxHeight = maxHeight;
                            return React.createElement('PopoverChild');
                        }}
                    </Popover>
                    <OverlayPortalHost />
                </OverlayPortalProvider>
            </PopoverPortalTargetContextProvider>,
        );
        await act(async () => {
            await flushHookEffects({ cycles: 2, turns: 6, frames: 1 });
        });
        // 430 of room above the chip (438 - 8); the chooser's content is 319 tall.
        expect(renderedMaxHeight).toBe(430);
        const contentView = findPopoverContentView(screen);
        const outset = readNumericStyle(flattenStyle(contentView?.props?.style), 'paddingTop');
        // The box takes the room above the chip (as the docked Search's chooser did); its content is shorter.
        await act(async () => {
            contentView?.props?.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 360, height: renderedMaxHeight + outset * 2 } } });
        });
        await act(async () => {
            await flushHookEffects({ cycles: 2, turns: 6, frames: 1 });
        });
        const style = flattenStyle(findPopoverContentView(screen)?.props?.style);
        // The box ends a gap above the anchor, and lays its content out from that edge.
        expect(800 - readNumericStyle(style, 'bottom') - outset).toBe(438 - 8);
        // Its content hangs from that edge through an auto top margin, never by aligning the box's content to its
        // end: content taller than its box (QA-B3 r173, web 1280×577) then starts at the box's top and never rises
        // past it, as an auto margin takes no negative room.
        expect(style.justifyContent).toBeUndefined();
        const frame = screen.root.findAll((node: any) => node.props?.kind === 'popover' && node.props?.style !== undefined)[0];
        expect(flattenStyle(frame?.props?.style).marginTop).toBe('auto');
    });
});
