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

describe('Popover rect-anchor (portal native)', () => {
    it('converts a window-relative rect anchor to portal-relative by subtracting the portal root offset', async () => {
        const { Popover } = await import('./Popover');
        const { OverlayPortalProvider, OverlayPortalHost } = await import('./OverlayPortal');
        const { PopoverPortalTargetContextProvider } = await import('./PopoverPortalTarget');

        // Portal root is at y=200 in window coordinates (e.g. iOS sheet offset).
        const portalRootNode = {
            measureInWindow: (cb: any) => cb(0, 200, 1000, 600),
            measure: (cb: any) => cb(0, 0, 1000, 600, 0, 200),
        } as any;

        const portalTarget = {
            rootRef: { current: portalRootNode },
            layout: { width: 1000, height: 600 },
        } as const;

        const screen = await renderScreen(
            <PopoverPortalTargetContextProvider value={portalTarget}>
                <OverlayPortalProvider>
                    <Popover
                        open
                        anchor={{
                            kind: 'rect',
                            // Window-relative: the caret is at y=600 in window space.
                            rect: { left: 50, top: 600, height: 18 },
                        }}
                        portal={{ native: true }}
                        placement="bottom"
                        gap={0}
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
        // Portal-relative anchor: (600 - 200) = 400 for Y; popup at 400 + 18 + 0 = 418.
        expectVisualTop(style, 418);
    });

    it('uses the raw window rect when portal-root subtraction would produce implausible negative coords (iOS contained presentation)', async () => {
        const { Popover } = await import('./Popover');
        const { OverlayPortalProvider, OverlayPortalHost } = await import('./OverlayPortal');
        const { PopoverPortalTargetContextProvider } = await import('./PopoverPortalTarget');

        // Portal root is at y=200 in window coordinates.
        const portalRootNode = {
            measureInWindow: (cb: any) => cb(0, 200, 1000, 600),
            measure: (cb: any) => cb(0, 0, 1000, 600, 0, 200),
        } as any;

        const portalTarget = {
            rootRef: { current: portalRootNode },
            layout: { width: 1000, height: 600 },
        } as const;

        const screen = await renderScreen(
            <PopoverPortalTargetContextProvider value={portalTarget}>
                <OverlayPortalProvider>
                    <Popover
                        open
                        anchor={{
                            kind: 'rect',
                            // The rect is ALREADY portal-relative (some iOS presentations do this).
                            // Subtracting portal root y=200 would give y=-100 which is implausible.
                            rect: { left: 50, top: 100, height: 18 },
                        }}
                        portal={{ native: true }}
                        placement="bottom"
                        gap={0}
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
        // If we incorrectly subtract portal offset: (100 - 200) = -100, which is implausible.
        // The plausibility guard should use the raw rect (100) since it's within portal layout.
        // Popup at 100 + 18 + 0 = 118.
        expectVisualTop(style, 118);
    });

    it('falls back to the supplied window rect when the portal root cannot be measured', async () => {
        const { Popover } = await import('./Popover');
        const { OverlayPortalProvider, OverlayPortalHost } = await import('./OverlayPortal');
        const { PopoverPortalTargetContextProvider } = await import('./PopoverPortalTarget');

        // Portal root with no measurement methods (transient failure).
        const portalRootNode = {} as any;

        const portalTarget = {
            rootRef: { current: portalRootNode },
            layout: { width: 1000, height: 600 },
        } as const;

        const screen = await renderScreen(
            <PopoverPortalTargetContextProvider value={portalTarget}>
                <OverlayPortalProvider>
                    <Popover
                        open
                        anchor={{
                            kind: 'rect',
                            rect: { left: 50, top: 300, height: 18 },
                        }}
                        portal={{ native: true }}
                        placement="bottom"
                        gap={0}
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
        // Falls back to raw window rect. Popup at 300 + 18 + 0 = 318.
        expectVisualTop(style, 318);
    });
});
