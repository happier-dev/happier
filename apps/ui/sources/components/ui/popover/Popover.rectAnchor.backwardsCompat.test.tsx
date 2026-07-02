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

describe('Popover rect-anchor (backwards compatibility)', () => {
    it('preserves exact behavior when using the legacy anchorRef prop', async () => {
        const { Popover } = await import('./Popover');
        const { OverlayPortalProvider, OverlayPortalHost } = await import('./OverlayPortal');
        const { PopoverPortalTargetContextProvider } = await import('./PopoverPortalTarget');

        const portalRootNode = {
            measureInWindow: (cb: any) => cb(0, 0, 1000, 800),
            measure: (cb: any) => cb(0, 0, 1000, 800, 0, 0),
        } as any;

        const anchorNode = {
            measureInWindow: (cb: any) => cb(100, 200, 150, 40),
        } as any;
        const anchorRef = { current: anchorNode } as any;

        const portalTarget = {
            rootRef: { current: portalRootNode },
            layout: { width: 1000, height: 800 },
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
        // View anchor at y=200, height=40: popup at 200+40+0=240.
        expectVisualTop(style, 240);
    });

    it('new anchor prop wins when both anchorRef and anchor are provided', async () => {
        const { Popover } = await import('./Popover');
        const { OverlayPortalProvider, OverlayPortalHost } = await import('./OverlayPortal');
        const { PopoverPortalTargetContextProvider } = await import('./PopoverPortalTarget');

        const portalRootNode = {
            measureInWindow: (cb: any) => cb(0, 0, 1000, 800),
            measure: (cb: any) => cb(0, 0, 1000, 800, 0, 0),
        } as any;

        // Legacy anchorRef points to a different location.
        const anchorNode = {
            measureInWindow: (cb: any) => cb(0, 500, 150, 40),
        } as any;
        const anchorRef = { current: anchorNode } as any;

        const portalTarget = {
            rootRef: { current: portalRootNode },
            layout: { width: 1000, height: 800 },
        } as const;

        const screen = await renderScreen(
            <PopoverPortalTargetContextProvider value={portalTarget}>
                <OverlayPortalProvider>
                    <Popover
                        open
                        anchorRef={anchorRef}
                        anchor={{
                            kind: 'rect',
                            rect: { left: 100, top: 200, height: 18 },
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
        // anchor prop should win: rect at y=200, height=18 => popup at 218.
        // If anchorRef won, we'd see 500+40=540.
        expectVisualTop(style, 218);
    });
});
