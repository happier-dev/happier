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
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
                select: (value: any) => value.ios ?? value.default ?? null,
            },
            useWindowDimensions: () => ({ width: 1000, height: 800 }),
            StyleSheet: {
                absoluteFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
            },
            View: (props: any) => React.createElement('View', props, props.children),
            Pressable: (props: any) => React.createElement('Pressable', props, props.children),
        });
    },
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
            await flushHookEffects({ cycles: 1, turns: 6 });
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
            await flushHookEffects({ cycles: 1, turns: 6 });
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
            await flushHookEffects({ cycles: 1, turns: 6 });
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
            await flushHookEffects({ cycles: 1, turns: 6 });
        });

        const contentView = findPopoverContentView(screen);
        expect(contentView).toBeTruthy();

        const style = flattenStyle(contentView?.props?.style);
        // With width=50, the popover should still position correctly.
        expectVisualTop(style, 218);
    });
});
