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
            await flushHookEffects({ cycles: 1, turns: 6 });
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
            await flushHookEffects({ cycles: 1, turns: 6 });
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
            await flushHookEffects({ cycles: 1, turns: 6 });
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
            await flushHookEffects({ cycles: 1, turns: 6 });
        });

        const contentView = findPopoverContentView(screen);
        expect(contentView).toBeTruthy();

        const style = flattenStyle(contentView?.props?.style);
        // Correct visual anchor bottom: (600 - 200) + 40 = 440.
        expectVisualTop(style, 440);
    });
});
