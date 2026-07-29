import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    renderHook,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { FocusReturnProvider } from '@/keyboard/focusReturn';

const navigationState = vi.hoisted(() => ({
    focusEffect: null as null | (() => void | (() => void)),
}));

vi.mock('@react-navigation/native', async () => {
    const ReactModule = await import('react');
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return {
        ...createReactNavigationNativeMock(),
        useFocusEffect: (effect: () => void | (() => void)) => {
            ReactModule.useEffect(() => {
                navigationState.focusEffect = effect;
                const cleanup = effect();
                return () => {
                    navigationState.focusEffect = null;
                    if (typeof cleanup === 'function') cleanup();
                };
            }, [effect]);
        },
    };
});

describe('useNavigationFocusReturn', () => {
    afterEach(() => {
        standardCleanup();
        vi.unstubAllGlobals();
        navigationState.focusEffect = null;
    });

    it('keeps navigation unchanged when the platform has no document focus owner', async () => {
        vi.stubGlobal('document', undefined);
        const navigate = vi.fn();
        const { useNavigationFocusReturn } = await import('./useNavigationFocusReturn');
        const hook = await renderHook(() => useNavigationFocusReturn());

        React.act(() => {
            hook.getCurrent()(navigate);
            navigationState.focusEffect?.();
        });

        expect(navigate).toHaveBeenCalledOnce();
    });

    it('restores the exact initiating element only after the source screen regains focus', async () => {
        const focus = vi.fn();
        const target = {
            focus,
            isConnected: true,
            getAttribute: (name: string) => name === 'data-testid' ? 'return-target' : null,
        };
        vi.stubGlobal('document', {
            activeElement: target,
            body: {},
            documentElement: {},
            querySelectorAll: () => [target],
        });
        const navigate = vi.fn();
        const { useNavigationFocusReturn } = await import('./useNavigationFocusReturn');
        const hook = await renderHook(() => useNavigationFocusReturn());

        expect(focus).not.toHaveBeenCalled();

        React.act(() => {
            hook.getCurrent()(() => navigate());
        });

        expect(navigate).toHaveBeenCalledOnce();
        expect(focus).not.toHaveBeenCalled();

        React.act(() => {
            navigationState.focusEffect?.();
        });

        expect(focus).toHaveBeenCalledOnce();

        React.act(() => {
            navigationState.focusEffect?.();
        });
        expect(focus).toHaveBeenCalledOnce();
    });

    it('retains the original trigger when focus moves before deferred navigation commits', async () => {
        const originalFocus = vi.fn();
        const movedFocus = vi.fn();
        const originalTarget = {
            focus: originalFocus,
            isConnected: true,
            getAttribute: (name: string) => name === 'data-testid' ? 'original-trigger' : null,
        };
        const movedTarget = {
            focus: movedFocus,
            isConnected: true,
            getAttribute: (name: string) => name === 'data-testid' ? 'moved-trigger' : null,
        };
        const documentState = {
            activeElement: originalTarget as typeof originalTarget | typeof movedTarget,
            body: {},
            documentElement: {},
            querySelectorAll: () => [originalTarget, movedTarget],
        };
        vi.stubGlobal('document', documentState);
        const navigate = vi.fn();
        const { useNavigationFocusReturn } = await import('./useNavigationFocusReturn');
        const hook = await renderHook(() => useNavigationFocusReturn());

        const capture = hook.getCurrent().capture();
        documentState.activeElement = movedTarget;
        React.act(() => {
            capture.navigate(navigate);
            navigationState.focusEffect?.();
        });

        expect(navigate).toHaveBeenCalledOnce();
        expect(originalFocus).toHaveBeenCalledOnce();
        expect(movedFocus).not.toHaveBeenCalled();
    });

    it('safely drops a return target that disconnected while the destination was open', async () => {
        const focus = vi.fn();
        const target = {
            focus,
            isConnected: true,
            getAttribute: (name: string) => name === 'data-testid' ? 'disconnected-target' : null,
        };
        vi.stubGlobal('document', {
            activeElement: target,
            body: {},
            documentElement: {},
            querySelectorAll: () => [target],
        });
        const { useNavigationFocusReturn } = await import('./useNavigationFocusReturn');
        const hook = await renderHook(() => useNavigationFocusReturn());

        React.act(() => {
            hook.getCurrent()(() => undefined);
        });
        target.isConnected = false;

        expect(() => {
            React.act(() => {
                navigationState.focusEffect?.();
            });
        }).not.toThrow();
        expect(focus).not.toHaveBeenCalled();
    });

    it('restores the sole visible enabled incarnation when the original trigger becomes a hidden stack copy', async () => {
        const originalFocus = vi.fn();
        const visibleFocus = vi.fn();
        const disabledFocus = vi.fn();
        let originalHidden = false;
        const createTarget = (
            focus: ReturnType<typeof vi.fn>,
            options: Readonly<{ hidden: () => boolean; disabled?: boolean }>,
        ) => ({
            focus,
            isConnected: true,
            getAttribute: (name: string) => {
                if (name === 'data-testid') return 'settings-provider-available:deepseek';
                if (name === 'aria-disabled') return options.disabled ? 'true' : null;
                return null;
            },
            getClientRects: () => options.hidden() ? [] : [{ width: 313, height: 58 }],
            getBoundingClientRect: () => options.hidden()
                ? ({ width: 0, height: 0 })
                : ({ width: 313, height: 58 }),
            closest: () => null,
        });
        const original = createTarget(originalFocus, { hidden: () => originalHidden });
        const disabledDuplicate = createTarget(disabledFocus, {
            hidden: () => false,
            disabled: true,
        });
        const visibleReplacement = createTarget(visibleFocus, { hidden: () => false });
        vi.stubGlobal('document', {
            activeElement: original,
            body: {},
            documentElement: {},
            querySelectorAll: () => [original, disabledDuplicate, visibleReplacement],
        });
        const { useNavigationFocusReturn } = await import('./useNavigationFocusReturn');
        const hook = await renderHook(() => useNavigationFocusReturn());

        React.act(() => {
            hook.getCurrent()(() => undefined);
        });
        originalHidden = true;

        React.act(() => {
            navigationState.focusEffect?.();
        });

        expect(originalFocus).not.toHaveBeenCalled();
        expect(disabledFocus).not.toHaveBeenCalled();
        expect(visibleFocus).toHaveBeenCalledOnce();
    });

    it('does not guess between multiple visible incarnations with the same stable identity', async () => {
        const createTarget = (focus: ReturnType<typeof vi.fn>, visible: boolean) => ({
            focus,
            isConnected: true,
            getAttribute: (name: string) => name === 'data-testid' ? 'duplicate-trigger' : null,
            getClientRects: () => visible ? [{ width: 100, height: 40 }] : [],
            getBoundingClientRect: () => visible
                ? ({ width: 100, height: 40 })
                : ({ width: 0, height: 0 }),
            closest: () => null,
        });
        const originalFocus = vi.fn();
        const firstVisibleFocus = vi.fn();
        const secondVisibleFocus = vi.fn();
        const original = createTarget(originalFocus, false);
        const firstVisible = createTarget(firstVisibleFocus, true);
        const secondVisible = createTarget(secondVisibleFocus, true);
        let candidates = [original, firstVisible, secondVisible];
        vi.stubGlobal('document', {
            activeElement: original,
            body: {},
            documentElement: {},
            querySelectorAll: () => candidates,
        });
        const { useNavigationFocusReturn } = await import('./useNavigationFocusReturn');
        const hook = await renderHook(() => useNavigationFocusReturn());

        React.act(() => {
            hook.getCurrent()(() => undefined);
            navigationState.focusEffect?.();
        });

        expect(originalFocus).not.toHaveBeenCalled();
        expect(firstVisibleFocus).not.toHaveBeenCalled();
        expect(secondVisibleFocus).not.toHaveBeenCalled();

        candidates = [firstVisible];
        React.act(() => {
            navigationState.focusEffect?.();
        });
        expect(firstVisibleFocus).not.toHaveBeenCalled();
    });

    it('clears the pending shared intent when navigation throws', async () => {
        const focus = vi.fn();
        const target = {
            focus,
            isConnected: true,
            getAttribute: (name: string) => name === 'data-testid' ? 'throwing-target' : null,
        };
        vi.stubGlobal('document', {
            activeElement: target,
            body: {},
            documentElement: {},
            querySelectorAll: () => [target],
        });
        const { useNavigationFocusReturn } = await import('./useNavigationFocusReturn');
        const hook = await renderHook(() => useNavigationFocusReturn());

        expect(() => {
            hook.getCurrent()(() => {
                throw new Error('navigation failed');
            });
        }).toThrow('navigation failed');

        React.act(() => {
            navigationState.focusEffect?.();
        });
        expect(focus).not.toHaveBeenCalled();
    });

    it('waits for final layout readiness before a different screen instance consumes the shared return', async () => {
        const originalFocus = vi.fn();
        const visibleFocus = vi.fn();
        let originalHidden = false;
        let replacementHidden = true;
        const createTarget = (
            focus: ReturnType<typeof vi.fn>,
            hidden: () => boolean,
        ) => ({
            focus,
            isConnected: true,
            getAttribute: (name: string) => name === 'data-testid'
                ? 'settings-provider-add-custom'
                : null,
            getClientRects: () => hidden() ? [] : [{ width: 313, height: 58 }],
            getBoundingClientRect: () => hidden()
                ? ({ width: 0, height: 0 })
                : ({ width: 313, height: 58 }),
            closest: () => null,
        });
        const original = createTarget(originalFocus, () => originalHidden);
        const visibleReplacement = createTarget(visibleFocus, () => replacementHidden);
        const body = {};
        vi.stubGlobal('document', {
            activeElement: original,
            body,
            documentElement: {},
            querySelectorAll: () => [original, visibleReplacement],
        });
        const { useNavigationFocusReturn } = await import('./useNavigationFocusReturn');
        const navigateFromSource = {
            current: null as ((navigate: () => void) => void) | null,
        };

        type ScreenInstanceId = 'source' | 'return' | 'later';

        function ScreenInstance(props: Readonly<{
            instance: ScreenInstanceId;
            ready: boolean;
        }>) {
            const navigateWithFocusReturn = useNavigationFocusReturn({ ready: props.ready });
            if (props.instance === 'source') {
                navigateFromSource.current = navigateWithFocusReturn;
            }
            return null;
        }

        function Harness(props: Readonly<{
            instance: ScreenInstanceId;
            ready: boolean;
        }>) {
            return (
                <FocusReturnProvider>
                    <ScreenInstance
                        key={props.instance}
                        instance={props.instance}
                        ready={props.ready}
                    />
                </FocusReturnProvider>
            );
        }

        const screen = await renderScreen(<Harness instance="source" ready />);
        const sourceNavigation = navigateFromSource.current;
        if (!sourceNavigation) throw new Error('Expected the source screen navigation callback');
        React.act(() => {
            sourceNavigation(() => undefined);
        });

        originalHidden = true;
        replacementHidden = false;
        (document as unknown as { activeElement: unknown }).activeElement = body;
        await React.act(async () => {
            screen.tree.update(<Harness instance="return" ready={false} />);
        });
        expect(originalFocus).not.toHaveBeenCalled();
        expect(visibleFocus).not.toHaveBeenCalled();

        await React.act(async () => {
            screen.tree.update(<Harness instance="return" ready />);
        });

        expect(originalFocus).not.toHaveBeenCalled();
        expect(visibleFocus).toHaveBeenCalledOnce();

        await React.act(async () => {
            screen.tree.update(<Harness instance="later" ready />);
        });
        expect(visibleFocus).toHaveBeenCalledOnce();
    });
});
