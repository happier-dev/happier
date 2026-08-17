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

const requireForTest = createRequire(import.meta.url);
const { Drawer: CjsDrawer } = requireForTest('vaul') as typeof import('vaul');

describe('PopoverPortalTargetProvider (web dom)', () => {
    it('keeps its portal target inside an Expo Router drawer before styles are observable', async () => {
        const { PopoverPortalTargetProvider } = await import('./PopoverPortalTargetProvider');
        const { useModalPortalTarget } = await import('@/modal/portal/ModalPortalTarget');
        const observedTargetRef: { current: Element | DocumentFragment | null } = { current: null };
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

        function TargetProbe() {
            observedTargetRef.current = useModalPortalTarget();
            return null;
        }

        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        try {
            await act(async () => {
                root.render(
                    <CjsDrawer.Root open handleOnly>
                        <CjsDrawer.Portal>
                            <CjsDrawer.Content>
                                <CjsDrawer.Title>New session</CjsDrawer.Title>
                                <CjsDrawer.Description>Configure a session</CjsDrawer.Description>
                                <PopoverPortalTargetProvider>
                                    <TargetProbe />
                                </PopoverPortalTargetProvider>
                            </CjsDrawer.Content>
                        </CjsDrawer.Portal>
                    </CjsDrawer.Root>,
                );
            });

            const observedTarget = observedTargetRef.current;
            if (!(observedTarget instanceof Element)) {
                throw new Error('Expected the provider to expose a web portal target');
            }
            expect(observedTarget.closest('[data-vaul-drawer]')).not.toBeNull();
        } finally {
            computedStyleSpy.mockRestore();
            await act(async () => {
                root.unmount();
            });
            container.remove();
        }
    });

    it('does not target an unrelated dialog when the scope anchor is outside that dialog', async () => {
        const { PopoverPortalTargetProvider } = await import('./PopoverPortalTargetProvider');
        const { useModalPortalTarget } = await import('@/modal/portal/ModalPortalTarget');

        function TargetParentProbe() {
            const target = useModalPortalTarget();
            const parent = target instanceof HTMLElement ? target.parentElement : null;
            return React.createElement('div', {
                'data-testid': 'target-parent',
                'data-parent': parent?.getAttribute('data-testid') ?? 'none',
            });
        }

        const unrelatedDialog = document.createElement('div');
        unrelatedDialog.setAttribute('data-radix-dialog-content', '');
        unrelatedDialog.setAttribute('data-testid', 'unrelated-dialog');
        document.body.appendChild(unrelatedDialog);

        const container = document.createElement('div');
        container.setAttribute('data-testid', 'sidebar-root');
        document.body.appendChild(container);
        const root = createRoot(container);
        try {
            await act(async () => {
                root.render(
                    <PopoverPortalTargetProvider>
                        <TargetParentProbe />
                    </PopoverPortalTargetProvider>,
                );
            });

            const targetParent = container.querySelector('[data-testid="target-parent"]');
            expect(targetParent?.getAttribute('data-parent')).toBe('none');
        } finally {
            await act(async () => {
                root.unmount();
            });
            container.remove();
            unrelatedDialog.remove();
        }
    });

    it('keeps the exposed portal target attached after StrictMode effect replay', async () => {
        const { PopoverPortalTargetProvider } = await import('./PopoverPortalTargetProvider');
        const { useModalPortalTarget } = await import('@/modal/portal/ModalPortalTarget');

        const observedTargetRef: { current: Element | DocumentFragment | null } = { current: null };
        function TargetProbe() {
            const target = useModalPortalTarget();
            observedTargetRef.current = target;
            return React.createElement('div', { 'data-testid': 'portal-state' });
        }

        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        try {
            await act(async () => {
                root.render(
                    <React.StrictMode>
                        <PopoverPortalTargetProvider>
                            <TargetProbe />
                        </PopoverPortalTargetProvider>
                    </React.StrictMode>,
                );
            });

            expect(container.querySelector('[data-testid="portal-state"]')).toBeTruthy();
            const observedTarget = observedTargetRef.current;
            if (!observedTarget) {
                throw new Error('Expected the provider to expose a web portal target');
            }
            expect(observedTarget.isConnected).toBe(true);
        } finally {
            await act(async () => {
                root.unmount();
            });
            container.remove();
        }
    });

    it('does not churn the web modal portal target across parent re-renders', async () => {
        const { PopoverPortalTargetProvider } = await import('./PopoverPortalTargetProvider');
        const { useModalPortalTarget } = await import('@/modal/portal/ModalPortalTarget');

        const observedTargets: Array<Element | DocumentFragment> = [];
        function Child(props: { bump: () => void }) {
            const target = useModalPortalTarget();
            React.useLayoutEffect(() => {
                if (!target) return;
                observedTargets.push(target);
                props.bump();
            }, [props.bump, target]);
            return React.createElement('div', { 'data-testid': 'observer' });
        }

        function Harness(props: { label: string }) {
            const [tick, setTick] = React.useState(0);
            const bump = React.useCallback(() => setTick((value) => value + 1), []);
            return (
                <PopoverPortalTargetProvider>
                    <Child bump={bump} />
                    <div data-testid="tick" data-value={tick} data-label={props.label} />
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
                        <Harness label="initial" />
                    </React.StrictMode>,
                );
            });

            const tickNode = container.querySelector('[data-testid="tick"]');
            const tickBeforeRerender = tickNode?.getAttribute('data-value');

            await act(async () => {
                root.render(
                    <React.StrictMode>
                        <Harness label="updated" />
                    </React.StrictMode>,
                );
            });

            const updatedTickNode = container.querySelector('[data-testid="tick"]');
            expect(updatedTickNode?.getAttribute('data-label')).toBe('updated');
            expect(updatedTickNode?.getAttribute('data-value')).toBe(tickBeforeRerender);
            expect(new Set(observedTargets).size).toBe(1);
        } finally {
            await act(async () => {
                root.unmount();
            });
            container.remove();
        }
    });

    it('does not rerender children just to expose the web portal target', async () => {
        const { PopoverPortalTargetProvider } = await import('./PopoverPortalTargetProvider');
        const { useModalPortalTarget } = await import('@/modal/portal/ModalPortalTarget');

        let childRenderCount = 0;
        function Child() {
            useModalPortalTarget();
            childRenderCount += 1;
            return React.createElement('div', { 'data-testid': 'child' });
        }

        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        try {
            await act(async () => {
                root.render(
                    <PopoverPortalTargetProvider>
                        <Child />
                    </PopoverPortalTargetProvider>,
                );
            });

            expect(childRenderCount).toBe(1);
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
        useStateSpy.mockImplementation(((initialState: unknown) => {
            const [state, setState] = originalUseState(initialState as never);
            const wrappedSetState = (value: unknown) => {
                stateUpdates.push(value);
                return (setState as unknown as (next: unknown) => void)(value);
            };
            return [state, wrappedSetState];
        }) as unknown as typeof React.useState);

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

            await act(async () => {
                root.render(
                    <React.StrictMode>
                        <PopoverPortalTargetProvider>
                            <div>sidebar-shell</div>
                            <BaseModal visible={true} showBackdrop closeOnBackdrop={false}>
                                <div>create-account</div>
                            </BaseModal>
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
