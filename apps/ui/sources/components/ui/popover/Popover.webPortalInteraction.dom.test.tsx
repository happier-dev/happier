/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import { ModalPortalTargetProvider } from '@/modal/portal/ModalPortalTarget';

import { installPopoverCommonModuleMocks } from './popoverTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installPopoverCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        type MockViewProps = React.HTMLAttributes<HTMLDivElement> & {
            style?: unknown;
            testID?: string;
            nativeID?: string;
            pointerEvents?: string;
            onLayout?: unknown;
        };
        const flattenStyle = (style: unknown): React.CSSProperties | undefined => {
            if (style == null) return undefined;
            if (Array.isArray(style)) {
                return style.reduce<React.CSSProperties>(
                    (acc, entry) => ({ ...acc, ...(flattenStyle(entry) ?? {}) }),
                    {},
                );
            }
            return typeof style === 'object' ? style as React.CSSProperties : undefined;
        };
        const View = React.forwardRef<HTMLDivElement, MockViewProps>(function View(props, ref) {
            const { children, style, testID, nativeID, pointerEvents, onLayout: _onLayout, ...rest } = props;
            return React.createElement('div', {
                ...rest,
                ref,
                id: nativeID,
                'data-testid': testID,
                'data-pointer-events': pointerEvents,
                style: flattenStyle(style),
            }, children);
        });
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
                select: <T,>(values: { web?: T; default?: T; native?: T }) => values.web ?? values.default ?? values.native,
            },
            View,
            Animated: { View },
            StyleSheet: {
                absoluteFillObject: {},
                flatten: flattenStyle,
                create: (styles: unknown) => styles,
            },
        });
    },
});

function rect(x: number, y: number, width: number, height: number): DOMRect {
    return {
        x,
        y,
        width,
        height,
        top: y,
        left: x,
        right: x + width,
        bottom: y + height,
        toJSON: () => ({}),
    };
}

describe('Popover web portal interaction readiness', () => {
    it('contains option clicks inside the web portal so a parent route modal cannot dismiss', async () => {
        const { Popover } = await import('./Popover');
        const portalTarget = document.createElement('div');
        const anchor = document.createElement('button');
        const container = document.createElement('div');
        document.body.append(portalTarget, anchor, container);
        const root = createRoot(container);
        const parentClick = vi.fn();
        const optionClick = vi.fn();

        try {
            await act(async () => {
                root.render(
                    <div onClick={parentClick}>
                        <ModalPortalTargetProvider target={portalTarget}>
                            <Popover
                                open
                                anchorRef={{ current: anchor }}
                                placement="bottom"
                                backdrop={false}
                                portal={{ web: true, native: true }}
                            >
                                {() => (
                                    <button
                                        type="button"
                                        data-testid="popover-option"
                                        onClick={optionClick}
                                    >
                                        Option
                                    </button>
                                )}
                            </Popover>
                        </ModalPortalTargetProvider>
                    </div>,
                );
            });

            const option = portalTarget.querySelector<HTMLElement>('[data-testid="popover-option"]');
            expect(option).not.toBeNull();
            await act(async () => {
                option!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });

            expect(optionClick).toHaveBeenCalledTimes(1);
            expect(parentClick).not.toHaveBeenCalled();
        } finally {
            await act(async () => root.unmount());
            portalTarget.remove();
            anchor.remove();
            container.remove();
        }
    });

    it('focuses the first enabled interactive descendant when requested on open', async () => {
        const { Popover } = await import('./Popover');
        const portalTarget = document.createElement('div');
        const anchor = document.createElement('button');
        const container = document.createElement('div');
        anchor.textContent = 'Open';
        document.body.append(portalTarget, anchor, container);
        const root = createRoot(container);
        const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
        const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
        const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;

        HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
            if (this === anchor) return rect(100, 100, 180, 40);
            return rect(100, 140, 180, 120);
        };
        globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => setTimeout(() => callback(0), 0)) as typeof requestAnimationFrame;
        globalThis.cancelAnimationFrame = ((handle: number) => clearTimeout(handle)) as typeof cancelAnimationFrame;

        try {
            anchor.focus();
            await act(async () => {
                root.render(
                    <ModalPortalTargetProvider target={portalTarget}>
                        <Popover
                            open
                            anchorRef={{ current: anchor }}
                            autoFocusOnOpen
                            placement="bottom"
                            backdrop={false}
                            portal={{ web: true, native: true }}
                        >
                            {() => (
                                <>
                                    <button type="button" aria-disabled="true" data-testid="popover-disabled-option">Disabled</button>
                                    <button type="button" data-testid="popover-first-option">Option</button>
                                </>
                            )}
                        </Popover>
                    </ModalPortalTargetProvider>,
                );
            });
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 100));
            });

            expect(document.activeElement).toBe(portalTarget.querySelector('[data-testid="popover-first-option"]'));
        } finally {
            await act(async () => root.unmount());
            HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
            globalThis.requestAnimationFrame = originalRequestAnimationFrame;
            globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
            portalTarget.remove();
            anchor.remove();
            container.remove();
        }
    });

    it('retries transient zero-sized content before enabling opacity and pointer input', async () => {
        const { Popover } = await import('./Popover');
        const portalTarget = document.createElement('div');
        const anchor = document.createElement('button');
        const container = document.createElement('div');
        document.body.append(portalTarget, anchor, container);
        const root = createRoot(container);
        const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
        const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
        const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
        const originalResizeObserver = globalThis.ResizeObserver;
        let contentMeasurements = 0;

        HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
            if (this === anchor) return rect(100, 100, 180, 40);
            const isPopoverContent = this.id.startsWith('popover-')
                || this.getAttribute('data-testid')?.startsWith('popover-') === true
                || this.querySelector('[id^="popover-"], [data-testid^="popover-"]') !== null;
            if (isPopoverContent) {
                contentMeasurements += 1;
                return contentMeasurements < 3 ? rect(0, 0, 0, 0) : rect(100, 140, 180, 120);
            }
            return rect(0, 0, 1280, 720);
        };
        globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => setTimeout(() => callback(0), 0)) as typeof requestAnimationFrame;
        globalThis.cancelAnimationFrame = ((handle: number) => clearTimeout(handle)) as typeof cancelAnimationFrame;
        globalThis.ResizeObserver = class ResizeObserver {
            observe() {}
            unobserve() {}
            disconnect() {}
        } as typeof ResizeObserver;

        try {
            await act(async () => {
                root.render(
                    <ModalPortalTargetProvider target={portalTarget}>
                        <Popover
                            open
                            anchorRef={{ current: anchor }}
                            placement="bottom"
                            backdrop={false}
                            portal={{ web: true, native: true }}
                        >
                            {() => <button type="button">Option</button>}
                        </Popover>
                    </ModalPortalTargetProvider>,
                );
            });
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 100));
            });

            const candidates = Array.from(portalTarget.querySelectorAll<HTMLElement>('[id^="popover-"], [data-testid^="popover-"]'));
            expect(candidates.length).toBeGreaterThan(0);
            expect(contentMeasurements).toBeGreaterThanOrEqual(3);
            expect(candidates.map((content) => ({
                id: content.id,
                testID: content.getAttribute('data-testid'),
                opacity: getComputedStyle(content).opacity,
                pointerEvents: getComputedStyle(content).pointerEvents,
            }))).toContainEqual(expect.objectContaining({ opacity: '1', pointerEvents: 'auto' }));
        } finally {
            await act(async () => root.unmount());
            HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
            globalThis.requestAnimationFrame = originalRequestAnimationFrame;
            globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
            globalThis.ResizeObserver = originalResizeObserver;
            portalTarget.remove();
            anchor.remove();
            container.remove();
        }
    });
});
