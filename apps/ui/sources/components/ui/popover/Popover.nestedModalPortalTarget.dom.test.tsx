/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import { ModalPortalTargetProvider, useModalPortalTarget } from '@/modal/portal/ModalPortalTarget';

import { installPopoverCommonModuleMocks } from './popoverTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function flattenStyle(style: unknown): React.CSSProperties | undefined {
    if (style == null) return undefined;
    if (Array.isArray(style)) {
        return style.reduce<React.CSSProperties>((acc, entry) => ({ ...acc, ...(flattenStyle(entry) ?? {}) }), {});
    }
    if (typeof style === 'object') return style as React.CSSProperties;
    return undefined;
}

installPopoverCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        const View = React.forwardRef<HTMLDivElement, any>(function View(props, ref) {
            const { children, style, testID, nativeID, pointerEvents, onLayout: _onLayout, ...rest } = props;
            return React.createElement(
                'div',
                {
                    ...rest,
                    ref,
                    id: nativeID,
                    'data-testid': testID,
                    'data-pointer-events': pointerEvents,
                    style: flattenStyle(style),
                },
                children,
            );
        });
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
                select: <T,>(values: { web?: T; ios?: T; default?: T }) => values.web ?? values.default ?? values.ios,
            },
            View,
            Animated: {
                View,
            },
            StyleSheet: {
                absoluteFillObject: {},
                flatten: flattenStyle,
                create: (styles: unknown) => styles,
            },
        });
    },
});

describe('Popover nested modal portal target', () => {
    it('keeps clicks inside a portaled popover from activating its React ancestors', async () => {
        const { Popover } = await import('./Popover');
        const anchor = document.createElement('button');
        const container = document.createElement('div');
        const onUnderlyingRowClick = vi.fn();
        const onAction = vi.fn();
        document.body.append(anchor, container);
        const root = createRoot(container);
        try {
            await act(async () => {
                root.render(
                    <div onClick={onUnderlyingRowClick}>
                        <Popover
                            open
                            anchorRef={{ current: anchor }}
                            backdrop={false}
                            portal={{ web: true, native: false }}
                        >
                            {() => <button data-testid="popover-action" onClick={onAction}>Edit tag</button>}
                        </Popover>
                    </div>,
                );
            });

            const action = document.querySelector('[data-testid="popover-action"]');
            expect(action).not.toBeNull();
            await act(async () => {
                action!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });

            expect(onAction).toHaveBeenCalledOnce();
            expect(onUnderlyingRowClick).not.toHaveBeenCalled();
        } finally {
            await act(async () => { root.unmount(); });
            anchor.remove();
            container.remove();
        }
    });

    it('provides a popover-local modal portal target to portaled popover content', async () => {
        const { Popover } = await import('./Popover');
        const parentModalTarget = document.createElement('div');
        const anchor = document.createElement('button');
        const container = document.createElement('div');
        document.body.append(parentModalTarget, anchor, container);
        const anchorRef = { current: anchor };
        const observedTargets: Array<unknown> = [];

        function Probe() {
            observedTargets.push(useModalPortalTarget());
            return React.createElement('span', { 'data-testid': 'probe' });
        }

        const root = createRoot(container);
        try {
            await act(async () => {
                root.render(
                    <ModalPortalTargetProvider target={parentModalTarget}>
                        <Popover
                            open
                            anchorRef={anchorRef}
                            backdrop={false}
                            portal={{ web: true, native: true }}
                        >
                            {() => <Probe />}
                        </Popover>
                    </ModalPortalTargetProvider>,
                );
            });

            expect(observedTargets.length).toBeGreaterThan(0);
            const latestTarget = observedTargets[observedTargets.length - 1];
            expect(latestTarget).toBeInstanceOf(HTMLElement);
            expect(latestTarget).not.toBe(parentModalTarget);
            expect((latestTarget as HTMLElement).getAttribute('data-happy-popover-modal-portal-target')).toBe('');
            expect(parentModalTarget.contains(latestTarget as Node)).toBe(true);
        } finally {
            await act(async () => {
                root.unmount();
            });
            parentModalTarget.remove();
            anchor.remove();
            container.remove();
        }
    });
});
