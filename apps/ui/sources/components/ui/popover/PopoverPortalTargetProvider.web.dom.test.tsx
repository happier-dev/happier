/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
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

describe('PopoverPortalTargetProvider (web dom)', () => {
    it('keeps the exposed portal target attached after StrictMode effect replay', async () => {
        const { PopoverPortalTargetProvider } = await import('./PopoverPortalTargetProvider');
        const { useModalPortalTarget } = await import('@/modal/portal/ModalPortalTarget');

        function TargetProbe() {
            const target = useModalPortalTarget();
            return React.createElement('div', {
                'data-testid': 'portal-state',
                'data-connected': String(Boolean(target?.isConnected)),
            });
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

            const portalState = container.querySelector('[data-testid="portal-state"]');
            expect(portalState?.getAttribute('data-connected')).toBe('true');
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
