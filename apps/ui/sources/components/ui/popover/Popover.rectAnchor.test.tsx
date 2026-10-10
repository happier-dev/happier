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

function readNumericStyle(style: Record<string, unknown>, key: string): number {
    const value = style[key];
    if (typeof value !== 'number') {
        throw new Error(`Expected numeric ${key} style, got ${typeof value}: ${JSON.stringify(value)}`);
    }
    return value;
}

function expectVisualTop(style: Record<string, unknown>, expected: number): void {
    expect(readNumericStyle(style, 'top') + readNumericStyle(style, 'paddingTop')).toBe(expected);
}

describe('Popover (rect anchor)', () => {
    it('sizes a content-sized popover between the owner min and max and keeps its right edge on an end-aligned anchor', async () => {
        const { Popover, CONTENT_SIZED_POPOVER_WIDTH } = await import('./Popover');
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
                        anchor={{ kind: 'rect', rect: { left: 700, top: 100, width: 140, height: 32 } }}
                        portal={{ native: true, matchAnchorWidth: false, anchorAlign: 'end', sizeToContent: true }}
                        placement="bottom"
                        gap={6}
                        maxWidthCap={560}
                        onRequestClose={() => {}}
                    >
                        {() => React.createElement('PopoverChild')}
                    </Popover>
                    <OverlayPortalHost />
                </OverlayPortalProvider>
            </PopoverPortalTargetContextProvider>,
        );
        await act(async () => {
            await flushHookEffects({ cycles: 1, turns: 6, frames: 1 });
        });

        const style = flattenStyle(findPopoverContentView(screen)?.props?.style);
        // No fixed width: the content decides, within the owner's bounds (not the caller's 560 cap).
        expect(style.width).toBeUndefined();
        expect(readNumericStyle(style, 'maxWidth') - 2 * readNumericStyle(style, 'paddingRight'))
            .toBe(CONTENT_SIZED_POPOVER_WIDTH.maxPx);
        expect(readNumericStyle(style, 'minWidth') - 2 * readNumericStyle(style, 'paddingRight'))
            .toBe(CONTENT_SIZED_POPOVER_WIDTH.minPx);
        // Right edge on the anchor's right edge (1000 - (700 + 140)).
        expect(readNumericStyle(style, 'right') + readNumericStyle(style, 'paddingRight')).toBe(160);
        expect(style.left).toBeUndefined();
    });

    it('positions the popup below the supplied rect anchor using placement + gap', async () => {
        const { Popover } = await import('./Popover');
        const { OverlayPortalProvider, OverlayPortalHost } = await import('./OverlayPortal');
        const { PopoverPortalTargetContextProvider } = await import('./PopoverPortalTarget');

        const portalRootNode = {
            measureInWindow: (cb: any) => cb(0, 0, 1000, 800),
            measure: (cb: any) => cb(0, 0, 1000, 800, 0, 0),
        } as any;

        const portalTarget = {
            rootRef: { current: portalRootNode },
            layout: { width: 1000, height: 800 },
        } as const;

        const screen = await renderScreen(
            <PopoverPortalTargetContextProvider value={portalTarget}>
                <OverlayPortalProvider>
                    <Popover
                        open
                        anchor={{
                            kind: 'rect',
                            rect: { left: 100, top: 200, height: 18 },
                        }}
                        portal={{ native: true }}
                        placement="bottom"
                        gap={4}
                        maxHeightCap={300}
                        onRequestClose={() => {}}
                    >
                        {() => React.createElement('PopoverChild')}
                    </Popover>
                    <OverlayPortalHost />
                </OverlayPortalProvider>
            </PopoverPortalTargetContextProvider>,
        );

        await act(async () => {
            await flushHookEffects({ cycles: 1, turns: 6, frames: 1 });
        });

        const contentView = findPopoverContentView(screen);
        expect(contentView).toBeTruthy();

        const style = flattenStyle(contentView?.props?.style);
        // Bottom placement: popover should be at top = anchorTop + anchorHeight + gap = 200 + 18 + 4 = 222.
        expectVisualTop(style, 222);
    });

    it('flips placement above the rect when popup would overflow the bottom edge', async () => {
        const { Popover } = await import('./Popover');
        const { OverlayPortalProvider, OverlayPortalHost } = await import('./OverlayPortal');
        const { PopoverPortalTargetContextProvider } = await import('./PopoverPortalTarget');

        const portalRootNode = {
            measureInWindow: (cb: any) => cb(0, 0, 1000, 400),
            measure: (cb: any) => cb(0, 0, 1000, 400, 0, 0),
        } as any;

        const portalTarget = {
            rootRef: { current: portalRootNode },
            layout: { width: 1000, height: 400 },
        } as const;

        const screen = await renderScreen(
            <PopoverPortalTargetContextProvider value={portalTarget}>
                <OverlayPortalProvider>
                    <Popover
                        open
                        anchor={{
                            kind: 'rect',
                            rect: { left: 100, top: 350, height: 18 },
                        }}
                        portal={{ native: true }}
                        placement="auto-vertical"
                        gap={8}
                        maxHeightCap={200}
                        onRequestClose={() => {}}
                    >
                        {() => React.createElement('PopoverChild')}
                    </Popover>
                    <OverlayPortalHost />
                </OverlayPortalProvider>
            </PopoverPortalTargetContextProvider>,
        );

        await act(async () => {
            await flushHookEffects({ cycles: 1, turns: 6, frames: 1 });
        });

        const contentView = findPopoverContentView(screen);
        expect(contentView).toBeTruthy();

        const style = flattenStyle(contentView?.props?.style);
        // Available below = 400 - (350 + 18) - 8 = 24 (too small for maxHeightCap 200).
        // Available above = 350 - 0 - 8 = 342 (plenty of room).
        // So auto-vertical should flip to 'top' placement.
        // Top placement uses bottom-pinned style, so we check for `bottom` instead of `top`.
        expect(style.bottom).toBeDefined();
    });

    it('clamps the popup to the boundary when it would overflow the left edge', async () => {
        const { Popover } = await import('./Popover');
        const { OverlayPortalProvider, OverlayPortalHost } = await import('./OverlayPortal');
        const { PopoverPortalTargetContextProvider } = await import('./PopoverPortalTarget');

        const portalRootNode = {
            measureInWindow: (cb: any) => cb(0, 0, 1000, 800),
            measure: (cb: any) => cb(0, 0, 1000, 800, 0, 0),
        } as any;

        const portalTarget = {
            rootRef: { current: portalRootNode },
            layout: { width: 1000, height: 800 },
        } as const;

        const screen = await renderScreen(
            <PopoverPortalTargetContextProvider value={portalTarget}>
                <OverlayPortalProvider>
                    <Popover
                        open
                        anchor={{
                            kind: 'rect',
                            rect: { left: -50, top: 200, height: 18 },
                        }}
                        portal={{ native: true }}
                        placement="bottom"
                        gap={0}
                        maxHeightCap={300}
                        maxWidthCap={200}
                        onRequestClose={() => {}}
                    >
                        {() => React.createElement('PopoverChild')}
                    </Popover>
                    <OverlayPortalHost />
                </OverlayPortalProvider>
            </PopoverPortalTargetContextProvider>,
        );

        await act(async () => {
            await flushHookEffects({ cycles: 1, turns: 6, frames: 1 });
        });

        const contentView = findPopoverContentView(screen);
        expect(contentView).toBeTruthy();

        const style = flattenStyle(contentView?.props?.style);
        // Left edge clamping: the popup's left should be clamped to >= 0 (boundary start).
        const left = readNumericStyle(style, 'left') + readNumericStyle(style, 'paddingLeft');
        expect(left).toBeGreaterThanOrEqual(0);
    });

    it('accepts optional width in the rect anchor and renders correctly', async () => {
        const { Popover } = await import('./Popover');
        const { OverlayPortalProvider, OverlayPortalHost } = await import('./OverlayPortal');
        const { PopoverPortalTargetContextProvider } = await import('./PopoverPortalTarget');

        const portalRootNode = {
            measureInWindow: (cb: any) => cb(0, 0, 1000, 800),
            measure: (cb: any) => cb(0, 0, 1000, 800, 0, 0),
        } as any;

        const portalTarget = {
            rootRef: { current: portalRootNode },
            layout: { width: 1000, height: 800 },
        } as const;

        const screen = await renderScreen(
            <PopoverPortalTargetContextProvider value={portalTarget}>
                <OverlayPortalProvider>
                    <Popover
                        open
                        anchor={{
                            kind: 'rect',
                            rect: { left: 100, top: 200, width: 50, height: 18 },
                        }}
                        portal={{ native: true }}
                        placement="bottom"
                        gap={0}
                        maxHeightCap={300}
                        onRequestClose={() => {}}
                    >
                        {() => React.createElement('PopoverChild')}
                    </Popover>
                    <OverlayPortalHost />
                </OverlayPortalProvider>
            </PopoverPortalTargetContextProvider>,
        );

        await act(async () => {
            await flushHookEffects({ cycles: 1, turns: 6, frames: 1 });
        });

        const contentView = findPopoverContentView(screen);
        expect(contentView).toBeTruthy();

        const style = flattenStyle(contentView?.props?.style);
        // With width=50, the popover should still position correctly.
        expectVisualTop(style, 218);
    });
});
