import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import { findAllByType, findFirstHostNodeByTestId } from '@/dev/testkit/harness/popoverHarness';
import { renderScreen } from '@/dev/testkit';
import { installPopoverCommonModuleMocks } from './popoverTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/components/ui/popover', () => ({
    usePopoverBoundaryRef: () => null,
    PopoverScope: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

installPopoverCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
            },
            useWindowDimensions: () => ({ width: 390, height: 844 }),
            View: (props: any) => React.createElement('View', props, props.children),
            Pressable: (props: any) => React.createElement('Pressable', props, props.children),
        });
    },
});

function PopoverChild() {
    return React.createElement('PopoverChild');
}

describe('PopoverPortalTargetProvider (native)', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('does not churn context value across parent re-renders (prevents maximum update depth loops)', async () => {
        const { PopoverPortalTargetProvider } = await import('./PopoverPortalTargetProvider');
        const { usePopoverPortalTarget } = await import('./PopoverPortalTarget');

        function Child(props: { bump: () => void }) {
            const target = usePopoverPortalTarget();
            React.useLayoutEffect(() => {
                if (!target) return;
                props.bump();
            }, [props.bump, target]);
            return React.createElement('Child');
        }

        function Harness() {
            const [tick, setTick] = React.useState(0);
            const bump = React.useCallback(() => setTick((t) => t + 1), []);
            return React.createElement(
                PopoverPortalTargetProvider,
                null,
                React.createElement(Child, { bump }),
                React.createElement('Tick', { value: tick }),
            );
        }

        const screen = await renderScreen(React.createElement(Harness));

        // If the provider churns its context value each parent render, the Child effect will
        // re-trigger indefinitely (bump -> parent rerender -> new context value -> bump ...).
        // The stable expected behavior is a single bump (tick=1).
        expect(screen.findByType('Tick' as any).props.value).toBe(1);
    });

    it('marks the portal root as non-collapsable (ensures measurement works in contained-sheet presentations)', async () => {
        const { PopoverPortalTargetProvider } = await import('./PopoverPortalTargetProvider');

        const screen = await renderScreen(
            React.createElement(
                PopoverPortalTargetProvider,
                null,
                React.createElement('View', { testID: 'child' }),
            ),
        );

        const views = screen.tree.findAll((node: any) => node?.type === 'View');
        const portalRoot = views.find((node: any) => typeof node?.props?.onLayout === 'function');
        expect(portalRoot).toBeTruthy();
        expect(portalRoot?.props?.collapsable).toBe(false);
    });

    it('renders popovers into a screen-local OverlayPortalHost (avoids coordinate-space mismatch in contained modals)', async () => {
        const { OverlayPortalHost, OverlayPortalProvider } = await import('./OverlayPortal');
        const { Popover } = await import('./Popover');
        const { PopoverPortalTargetProvider } = await import('./PopoverPortalTargetProvider');

        const anchorRef = {
            current: {
                measureInWindow: (cb: any) => cb(200, 200, 20, 20),
            },
        } as any;

        let tree: ReturnType<typeof renderer.create> | undefined;
        tree = (await renderScreen(React.createElement(
                    OverlayPortalProvider,
                    null,
                    React.createElement(
                        'View',
                        { testID: 'inner-root' },
                        React.createElement(
                            PopoverPortalTargetProvider,
                            null,
                            React.createElement(Popover, {
                                open: true,
                                anchorRef,
                                placement: 'bottom',
                                portal: { native: true },
                                onRequestClose: () => {},
                                backdrop: true,
                                children: () => React.createElement(PopoverChild),
                            } as any),
                        ),
                    ),
                    React.createElement(
                        'View',
                        { testID: 'outer-host' },
                        React.createElement(OverlayPortalHost),
                    ),
                ))).tree;

        const innerRoot = tree ? findFirstHostNodeByTestId(tree, 'inner-root') : null;
        expect(innerRoot ? findAllByType(innerRoot, 'PopoverChild').length : 0).toBe(1);

        const outerHost = tree ? findFirstHostNodeByTestId(tree, 'outer-host') : null;
        expect(outerHost ? findAllByType(outerHost, 'PopoverChild').length : 0).toBe(0);
    });

    it('removes portal content when popover closes', async () => {
        vi.useFakeTimers();
        const { Popover } = await import('./Popover');
        const { PopoverPortalTargetProvider } = await import('./PopoverPortalTargetProvider');
        const { motionTokens } = await import('@/components/ui/motion/motionTokens');

        const anchorRef = {
            current: {
                measureInWindow: (cb: any) => cb(120, 240, 20, 20),
            },
        } as any;

        let tree: ReturnType<typeof renderer.create> | undefined;
        tree = (await renderScreen(React.createElement(
                    PopoverPortalTargetProvider,
                    null,
                    React.createElement(
                        'View',
                        { testID: 'screen' },
                        React.createElement(Popover, {
                            open: true,
                            anchorRef,
                            placement: 'bottom',
                            portal: { native: true },
                            onRequestClose: () => {},
                            children: () => React.createElement(PopoverChild),
                        } as any),
                    ),
                ))).tree;

        expect(tree ? findAllByType(tree, 'PopoverChild').length : 0).toBe(1);

        await act(async () => {
            tree?.update(
                React.createElement(
                    PopoverPortalTargetProvider,
                    null,
                    React.createElement(
                        'View',
                        { testID: 'screen' },
                        React.createElement(Popover, {
                            open: false,
                            anchorRef,
                            placement: 'bottom',
                            portal: { native: true },
                            onRequestClose: () => {},
                            children: () => React.createElement(PopoverChild),
                        } as any),
                    ),
                ),
            );
        });

        expect(tree ? findAllByType(tree, 'PopoverChild').length : 0).toBe(1);

        await act(async () => {
            vi.advanceTimersByTime(motionTokens.overlay.popover.exitMs);
        });

        expect(tree ? findAllByType(tree, 'PopoverChild').length : 0).toBe(0);
    });
});
