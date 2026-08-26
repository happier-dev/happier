/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

import { installPopoverCommonModuleMocks } from './popoverTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installPopoverCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
                select: <T,>(values: { web?: T; ios?: T; default?: T }) => values.web ?? values.ios ?? values.default,
            },
            View: (props: any) => React.createElement('div', props, props.children),
        });
    },
});

const safeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };
const requireForTest = createRequire(import.meta.url);
const { Drawer: CjsDrawer } = requireForTest('vaul') as typeof import('vaul');

describe('PopoverPortalTargetProvider (web dom)', () => {
    it('layers the screen-local portal host above later composer siblings', async () => {
        const { PopoverPortalTargetProvider } = await import('./PopoverPortalTargetProvider');
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);

        try {
            await act(async () => {
                root.render(
                    <PopoverPortalTargetProvider>
                        <div data-testid="screen-content" />
                        <div data-testid="composer" style={{ position: 'relative', zIndex: 1 }} />
                    </PopoverPortalTargetProvider>,
                );
            });

            const host = document.querySelector('[data-happy-popover-portal-host]') as HTMLElement | null;
            expect(host).not.toBeNull();
            expect(Number(host?.style.zIndex)).toBeGreaterThan(1);
        } finally {
            await act(async () => {
                root.unmount();
            });
            container.remove();
        }
    });

    it('keeps portaled popovers inside an Expo Router drawer without disabling outside dismissal', async () => {
        const { PopoverPortalTargetProvider } = await import('./PopoverPortalTargetProvider');
        const { Popover } = await import('./Popover');
        const openChanges: boolean[] = [];
        const originalGetComputedStyle = window.getComputedStyle.bind(window);
        const computedStyleSpy = vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
            const style = originalGetComputedStyle(element);
            return new Proxy(style, {
                get(target, property, receiver) {
                    if (property === 'overflow' || property === 'overflowX' || property === 'overflowY') {
                        return 'visible';
                    }
                    return Reflect.get(target, property, receiver);
                },
            });
        });

        function NewSessionAutomationHarness() {
            const anchorRef = React.useRef<HTMLButtonElement | null>(null);
            const [open, setOpen] = React.useState(false);
            return (
                <>
                    <button
                        ref={anchorRef}
                        data-testid="automation-trigger"
                        onClick={() => setOpen(true)}
                    >
                        Automate
                    </button>
                    {open ? (
                        <Popover
                            open
                            anchorRef={anchorRef}
                            backdrop={false}
                            portal={{ web: true, native: true }}
                            onRequestClose={() => setOpen(false)}
                        >
                            {() => <button data-testid="automation-content">Automation settings</button>}
                        </Popover>
                    ) : null}
                </>
            );
        }

        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        try {
            await act(async () => {
                root.render(
                    <CjsDrawer.Root open handleOnly onOpenChange={(open) => openChanges.push(open)}>
                        <CjsDrawer.Portal>
                            <CjsDrawer.Overlay data-testid="drawer-overlay" />
                            <CjsDrawer.Content>
                                <CjsDrawer.Title>New session</CjsDrawer.Title>
                                <CjsDrawer.Description>Configure a session</CjsDrawer.Description>
                                <div data-testid="new-session-screen">
                                    <PopoverPortalTargetProvider>
                                        <NewSessionAutomationHarness />
                                    </PopoverPortalTargetProvider>
                                </div>
                            </CjsDrawer.Content>
                        </CjsDrawer.Portal>
                    </CjsDrawer.Root>,
                );
            });
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 0));
            });

            const trigger = document.querySelector('[data-testid="automation-trigger"]');
            expect(trigger).toBeInstanceOf(HTMLButtonElement);

            await act(async () => {
                trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
                trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });

            expect(document.querySelector('[data-testid="automation-content"]')).not.toBeNull();
            expect(
                document.querySelector('[data-testid="automation-content"]')?.closest('[data-vaul-drawer]'),
            ).not.toBeNull();
            expect(document.querySelector('[data-vaul-drawer]')?.getAttribute('data-state')).toBe('open');
            expect(openChanges).not.toContain(false);

            await act(async () => {
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            });

            expect(document.querySelector('[data-testid="automation-content"]')).toBeNull();
            expect(document.querySelector('[data-vaul-drawer]')?.getAttribute('data-state')).toBe('open');

            await act(async () => {
                const overlay = document.querySelector('[data-testid="drawer-overlay"]');
                overlay?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
                overlay?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                overlay?.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
                overlay?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                overlay?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            expect(openChanges).toContain(false);
        } finally {
            computedStyleSpy.mockRestore();
            await act(async () => {
                root.unmount();
            });
            container.remove();
        }
    });

    it('does not churn the web modal portal target across parent re-renders', async () => {
        const { PopoverPortalTargetProvider } = await import('./PopoverPortalTargetProvider');
        const { useModalPortalTarget } = await import('@/modal/portal/ModalPortalTarget');

        function Child(props: { bump: () => void }) {
            const target = useModalPortalTarget();
            React.useLayoutEffect(() => {
                if (!target) return;
                props.bump();
            }, [props.bump, target]);
            return React.createElement('div', { 'data-testid': 'observer' });
        }

        function Harness() {
            const [tick, setTick] = React.useState(0);
            const bump = React.useCallback(() => setTick((value) => value + 1), []);
            return (
                <PopoverPortalTargetProvider>
                    <Child bump={bump} />
                    <div data-testid="tick" data-value={tick} />
                </PopoverPortalTargetProvider>
            );
        }

        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        try {
            await act(async () => {
                root.render(
                    <React.StrictMode>
                        <Harness />
                    </React.StrictMode>,
                );
            });

            const tickNode = container.querySelector('[data-testid="tick"]');
            expect(tickNode?.getAttribute('data-value')).toBe('1');
        } finally {
            await act(async () => {
                root.unmount();
            });
            container.remove();
        }
    });

    it('does not trigger nested update loops when unmounted during web shell transitions', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);

        try {
            const { PopoverPortalTargetProvider } = await import('./PopoverPortalTargetProvider');

            await act(async () => {
                root.render(
                    <React.StrictMode>
                        <PopoverPortalTargetProvider>
                            <div>child</div>
                        </PopoverPortalTargetProvider>
                    </React.StrictMode>,
                );
            });

            await act(async () => {
                root.render(<div>next</div>);
            });

            await act(async () => {
                root.unmount();
            });

            expect(consoleError).not.toHaveBeenCalled();
        } finally {
            consoleError.mockRestore();
            container.remove();
        }
    });

    it('does not enqueue a null portal target update during cleanup', async () => {
        const originalUseState = React.useState;
        const stateUpdates: unknown[] = [];
        const useStateSpy = vi.spyOn(React, 'useState');
        useStateSpy.mockImplementation((((initialState: unknown) => {
            const [state, setState] = originalUseState(initialState as never);
            const wrappedSetState = (value: unknown) => {
                stateUpdates.push(value);
                return (setState as unknown as (next: unknown) => void)(value);
            };
            return [state, wrappedSetState];
        }) as unknown) as typeof React.useState);

        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);

        try {
            const { PopoverPortalTargetProvider } = await import('./PopoverPortalTargetProvider');

            await act(async () => {
                root.render(
                    <PopoverPortalTargetProvider>
                        <div>child</div>
                    </PopoverPortalTargetProvider>,
                );
            });

            await act(async () => {
                root.unmount();
            });

            expect(stateUpdates.some((value) => value === null)).toBe(false);
        } finally {
            useStateSpy.mockRestore();
            container.remove();
        }
    });

    it('does not trigger nested update loops when a web modal mounts above the same screen tree', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);

        try {
            const { PopoverPortalTargetProvider } = await import('./PopoverPortalTargetProvider');
            const { BaseModal } = await import('@/modal/components/BaseModal');
            const { SafeAreaInsetsContext } = await import('react-native-safe-area-context');

            await act(async () => {
                root.render(
                    <React.StrictMode>
                        <PopoverPortalTargetProvider>
                            <div>sidebar-shell</div>
                            <SafeAreaInsetsContext.Provider value={safeAreaInsets}>
                                <BaseModal visible={true} showBackdrop closeOnBackdrop={false}>
                                    <div>create-account</div>
                                </BaseModal>
                            </SafeAreaInsetsContext.Provider>
                        </PopoverPortalTargetProvider>
                    </React.StrictMode>,
                );
            });

            await act(async () => {
                root.unmount();
            });

            const maxDepthErrors = consoleError.mock.calls.filter((call) =>
                call.some((value) => typeof value === 'string' && /maximum update depth exceeded/i.test(value)),
            );
            expect(maxDepthErrors).toHaveLength(0);
        } finally {
            consoleError.mockRestore();
            container.remove();
        }
    });
});
