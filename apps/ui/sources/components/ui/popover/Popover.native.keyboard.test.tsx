import React from 'react';
import { describe, expect, it, vi } from 'vitest';

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

describe('Popover (native keyboard)', () => {
    it('recomputes position when the keyboard shows/hides so popovers remain visible', async () => {
        vi.useFakeTimers();

        // Patch the Keyboard listener implementation directly so the Popover module
        // (and any transitive deps) observe the same emit source.
        const rn = await import('react-native');
        expect((rn as any).Platform?.OS).toBe('ios');
        const listeners = new Map<string, Set<(...args: any[]) => void>>();
        const addListener = (event: string, cb: (...args: any[]) => void) => {
            const set = listeners.get(event) ?? new Set<(...args: any[]) => void>();
            set.add(cb);
            listeners.set(event, set);
            return {
                remove: () => {
                    set.delete(cb);
                },
            };
        };
        (rn as any).Keyboard = (rn as any).Keyboard ?? {};
        (rn as any).Keyboard.addListener = addListener;

        const emit = (event: string, payload?: unknown) => {
            for (const cb of listeners.get(event) ?? []) {
                cb(payload);
            }
        };

        const { Popover } = await import('./Popover');
        const { OverlayPortalProvider, OverlayPortalHost } = await import('./OverlayPortal');
        const { PopoverPortalTargetContextProvider } = await import('./PopoverPortalTarget');

        const portalRootNode = {
            measureInWindow: (cb: any) => cb(0, 200, 1000, 600),
        } as any;

        let anchorY = 600;
        const anchorNode = {
            measureInWindow: (cb: any) => cb(0, anchorY, 100, 40),
            measureLayout: (_relativeTo: any, onSuccess: any) => onSuccess(0, anchorY - 200, 100, 40),
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

        // `Popover` positions via `useLayoutEffect`, while the keyboard listeners attach via
        // `useEffect` (next tick). Use a couple cycles so both run.
        await flushHookEffects({ cycles: 4, turns: 10, frames: 6, advanceTimersMs: 120 });

        const contentView = findPopoverContentView(screen);
        expect(contentView).toBeTruthy();

        const before = flattenStyle(contentView?.props?.style);
        expect(before.top).toBe(440); // (600 - 200) + 40

        // Simulate the keyboard pushing the anchor upward (e.g. input bar moves).
        anchorY = 480;
        emit('keyboardDidShow');

        await flushHookEffects({ cycles: 4, turns: 10, frames: 6, advanceTimersMs: 120 });

        const afterView = findPopoverContentView(screen);
        const after = flattenStyle(afterView?.props?.style);
        expect(after.top).toBe(320); // (480 - 200) + 40
        vi.useRealTimers();
    });

    it('treats the keyboard as reducing the usable viewport so auto placement does not flip behind it', async () => {
        vi.useFakeTimers();

        const rn = await import('react-native');
        expect((rn as any).Platform?.OS).toBe('ios');

        const listeners = new Map<string, Set<(...args: any[]) => void>>();
        const addListener = (event: string, cb: (...args: any[]) => void) => {
            const set = listeners.get(event) ?? new Set<(...args: any[]) => void>();
            set.add(cb);
            listeners.set(event, set);
            return {
                remove: () => {
                    set.delete(cb);
                },
            };
        };
        (rn as any).Keyboard = (rn as any).Keyboard ?? {};
        (rn as any).Keyboard.addListener = addListener;
        const emit = (event: string, payload?: unknown) => {
            for (const cb of listeners.get(event) ?? []) {
                cb(payload);
            }
        };

        const { Popover } = await import('./Popover');
        const { OverlayPortalProvider, OverlayPortalHost } = await import('./OverlayPortal');
        const { PopoverPortalTargetContextProvider } = await import('./PopoverPortalTarget');

        const portalRootNode = {
            measureInWindow: (cb: any) => cb(0, 200, 1000, 600),
        } as any;

        // Anchor is relatively close to the top of the portal root so `auto` would normally
        // prefer bottom placement (more space below).
        const anchorY = 400; // window y
        const anchorNode = {
            measureInWindow: (cb: any) => cb(0, anchorY, 100, 40),
            measureLayout: (_relativeTo: any, onSuccess: any) => onSuccess(0, anchorY - 200, 100, 40),
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
                        boundaryRef={null}
                        portal={{ native: true }}
                        placement="auto"
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

        await flushHookEffects({ cycles: 4, turns: 10, frames: 6, advanceTimersMs: 120 });

        const contentView = findPopoverContentView(screen);
        expect(contentView).toBeTruthy();

        const before = flattenStyle(contentView?.props?.style);
        expect(typeof before.top).toBe('number');

        // Keyboard covers the bottom 300px of the screen. Auto placement should treat that as
        // reducing available bottom space, causing it to prefer top placement instead of flipping
        // behind the keyboard.
        emit('keyboardDidShow', { endCoordinates: { height: 300 } });

        await flushHookEffects({ cycles: 4, turns: 10, frames: 6, advanceTimersMs: 120 });

        const afterView = findPopoverContentView(screen);
        const after = flattenStyle(afterView?.props?.style);
        expect(typeof after.top).toBe('number');
        expect(after.top as number).toBeLessThan(before.top as number);
        vi.useRealTimers();
    });
});
