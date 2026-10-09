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

// Resolve the component graph during collection, outside behavior-test deadlines.
await import('./Popover');

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
    it('does not re-arm cancelled opening focus when the focus adapter changes during a rerender', async () => {
        const { Popover } = await import('./Popover');
        const search = document.createElement('input');
        const container = document.createElement('div');
        document.body.append(search, container);
        const root = createRoot(container);
        const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect(100, 100, 180, 40));
        const render = (ready: boolean, open = true) => <Popover open={open} anchorRef={{ current: search }}
            initialFocusRef={{ current: null }} autoFocusOnOpen backdrop={false} portal={{ web: true }}>
            {() => ready ? <button data-testid="rerender-late-option">Session</button> : <span>Loading</span>}
        </Popover>;
        try {
            search.focus();
            await act(async () => { root.render(render(false)); });
            await act(async () => {
                search.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }));
                search.value = 'Session summaryx';
                search.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'x' }));
                root.render(render(false));
            });
            await act(async () => { root.render(render(true)); });
            expect(search.value).toBe('Session summaryx');
            expect(document.activeElement).toBe(search);
            // A genuine new opening still owns one fresh focus intent.
            await act(async () => { root.render(render(false, false)); });
            await act(async () => { root.render(render(false)); });
            await act(async () => { root.render(render(true)); });
            expect(document.activeElement).toBe(document.querySelector('[data-testid="rerender-late-option"]'));
        } finally {
            await act(async () => root.unmount());
            measure.mockRestore();
            container.remove(); search.remove();
        }
    });

    it('cancels cold opening focus when the external search receives input immediately after commit', async () => {
        const { Popover } = await import('./Popover');
        const search = document.createElement('input');
        const container = document.createElement('div');
        document.body.append(search, container);
        const root = createRoot(container);
        const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect(100, 100, 180, 40));
        function TypeAfterCommit() {
            React.useLayoutEffect(() => {
                expect(document.activeElement).toBe(search);
                search.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }));
                search.value = 'Session summaryx';
                search.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'x' }));
            }, []);
            return null;
        }
        const render = (ready: boolean) => <>
            <Popover open anchorRef={{ current: search }} autoFocusOnOpen backdrop={false} portal={{ web: true }}>
                {() => ready ? <button data-testid="commit-late-option">Session</button> : <span>Loading</span>}
            </Popover>
            <TypeAfterCommit />
        </>;
        try {
            search.focus();
            await act(async () => { root.render(render(false)); });
            expect(document.querySelector('[data-testid="commit-late-option"]')).toBeNull();
            await act(async () => { root.render(render(true)); });
            expect(search.value).toBe('Session summaryx');
            expect(document.activeElement).toBe(search);
        } finally {
            await act(async () => root.unmount());
            measure.mockRestore();
            container.remove(); search.remove();
        }
    });

    it.each(['arrival', 'keyboard', 'pointer', 'input', 'focus', 'closed'] as const)(
        'keeps asynchronous initial focus pending until content arrives, unless cancelled by %s', async (intent) => {
            const { Popover } = await import('./Popover');
            const portalTarget = document.createElement('div');
            const search = document.createElement('input');
            const other = document.createElement('button');
            const container = document.createElement('div');
            document.body.append(portalTarget, search, other, container);
            const root = createRoot(container);
            const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect(100, 100, 180, 40));
            const optionRef = React.createRef<HTMLButtonElement>();
            const render = (ready: boolean, open = true) => <ModalPortalTargetProvider target={portalTarget}>
                <Popover open={open} anchorRef={{ current: search }} initialFocusRef={optionRef}
                    autoFocusOnOpen placement="bottom" backdrop={false} portal={{ web: true, native: true }}>
                    {() => ready ? <button ref={optionRef} data-testid="late-option">Option</button> : <span>Loading</span>}
                </Popover>
            </ModalPortalTargetProvider>;
            try {
                search.focus();
                await act(async () => { root.render(render(false)); });
                // Options can arrive after the former five-frame focus cutoff.
                await act(async () => { await new Promise(resolve => setTimeout(resolve, 120)); });
                expect(document.activeElement).toBe(search);
                await act(async () => {
                    if (intent === 'keyboard') search.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
                    if (intent === 'pointer') search.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
                    if (intent === 'input') search.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
                    if (intent === 'focus') other.focus();
                    if (intent === 'closed') root.render(render(false, false));
                });
                await act(async () => { root.render(render(true, intent !== 'closed')); });
                expect(document.activeElement).toBe(intent === 'arrival' ? optionRef.current : intent === 'focus' ? other : search);
                if (intent === 'arrival') {
                    // Once fulfilled, later option replacement must not reclaim focus.
                    other.focus();
                    await act(async () => { root.render(render(false)); });
                    await act(async () => { root.render(render(true)); });
                    expect(document.activeElement).toBe(other);
                }
            } finally {
                await act(async () => root.unmount());
                measure.mockRestore();
                portalTarget.remove(); search.remove(); other.remove(); container.remove();
            }
        },
    );

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

    it('keeps an open popover open while the person presses inside a popover opened from it (a row menu in a roster)', async () => {
        const { Popover } = await import('./Popover');
        const portalTarget = document.createElement('div');
        const outerAnchor = document.createElement('button');
        const container = document.createElement('div');
        document.body.append(portalTarget, outerAnchor, container);
        const root = createRoot(container);
        const outerClose = vi.fn();
        const innerClose = vi.fn();
        const latestInnerClose = vi.fn();

        function Nested({ onInnerClose }: { onInnerClose: () => void }) {
            const outerAnchorRef = React.useRef(outerAnchor);
            const innerAnchor = React.useRef<HTMLButtonElement>(null);
            const [innerOpen, setInnerOpen] = React.useState(true);
            return (
                <ModalPortalTargetProvider target={portalTarget}>
                    <Popover open anchorRef={outerAnchorRef} placement="right" backdrop={false}
                        portal={{ web: true, native: true }} onRequestClose={outerClose}>
                        {() => (
                            <div>
                                <button type="button" ref={innerAnchor} data-testid="row-more">More</button>
                                <Popover open={innerOpen} anchorRef={innerAnchor} placement="bottom" backdrop={false}
                                    portal={{ web: true, native: true }} onRequestClose={() => {
                                        onInnerClose();
                                        setInnerOpen(false);
                                    }}>
                                    {() => <button type="button" data-testid="menu-item">Pin to rail</button>}
                                </Popover>
                            </div>
                        )}
                    </Popover>
                </ModalPortalTargetProvider>
            );
        }

        try {
            await act(async () => { root.render(<Nested onInnerClose={innerClose} />); });
            await act(async () => { root.render(<Nested onInnerClose={latestInnerClose} />); });
            const item = portalTarget.querySelector<HTMLElement>('[data-testid="menu-item"]');
            expect(item).not.toBeNull();
            await act(async () => {
                item!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
            });
            expect(outerClose).not.toHaveBeenCalled();
            expect(innerClose).not.toHaveBeenCalled();
            expect(latestInnerClose).not.toHaveBeenCalled();

            // Outside input dismisses the active menu and is consumed before the underlying layer.
            await act(async () => {
                document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
            });
            expect(innerClose).not.toHaveBeenCalled();
            expect({ inner: latestInnerClose.mock.calls.length, outer: outerClose.mock.calls.length })
                .toEqual({ inner: 1, outer: 0 });

            // Closing the controlled child retires its outside listener, leaving the outer layer active.
            await act(async () => {
                document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
            });
            expect(outerClose).toHaveBeenCalled();
        } finally {
            await act(async () => root.unmount());
            portalTarget.remove();
            outerAnchor.remove();
            container.remove();
        }
    });

    it('uses current anchor and outside-input policies without keeping a closed listener active', async () => {
        const { Popover } = await import('./Popover');
        const oldAnchor = document.createElement('button');
        const currentAnchor = document.createElement('button');
        const outside = document.createElement('button');
        const container = document.createElement('div');
        document.body.append(oldAnchor, currentAnchor, outside, container);
        const root = createRoot(container);
        const close = vi.fn();
        const outsidePress = vi.fn();
        outside.addEventListener('pointerdown', outsidePress);
        const render = (updated: boolean, open = true) => <Popover
            open={open}
            anchorRef={{ current: updated ? currentAnchor : oldAnchor }}
            backdrop={false}
            portal={{ web: true }}
            onRequestClose={close}
            closeOnAnchorPress={updated}
            consumeOutsidePointerDown={!updated}
        >{() => <button>Option</button>}</Popover>;

        try {
            await act(async () => { root.render(render(false)); });
            await act(async () => { root.render(render(true)); });
            await act(async () => {
                currentAnchor.dispatchEvent(new Event('pointerdown', { bubbles: true }));
            });
            expect(close).toHaveBeenCalledTimes(1);
            await act(async () => {
                outside.dispatchEvent(new Event('pointerdown', { bubbles: true }));
                await new Promise((resolve) => setTimeout(resolve, 0));
            });
            expect(outsidePress).toHaveBeenCalledTimes(1);
            expect(close).toHaveBeenCalledTimes(2);
            await act(async () => { root.render(render(true, false)); });
            await act(async () => {
                outside.dispatchEvent(new Event('pointerdown', { bubbles: true }));
                await new Promise((resolve) => setTimeout(resolve, 0));
            });
            expect(outsidePress).toHaveBeenCalledTimes(2);
            expect(close).toHaveBeenCalledTimes(2);
        } finally {
            await act(async () => root.unmount());
            oldAnchor.remove();
            currentAnchor.remove();
            outside.remove();
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
        globalThis.requestAnimationFrame = (callback) => window.setTimeout(() => callback(0), 0);
        globalThis.cancelAnimationFrame = (handle) => window.clearTimeout(handle);

        const originalFocus = HTMLElement.prototype.focus;
        const focusCalls: Array<FocusOptions | undefined> = [];

        try {
            anchor.focus();
            HTMLElement.prototype.focus = function focus(options?: FocusOptions) {
                focusCalls.push(options);
                return originalFocus.call(this, options);
            };
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
            // The popover is focused before it is measured and placed. A focus that scrolls would
            // move the whole page to reveal the still-unplaced popover (the "UI flicker" on open).
            expect(focusCalls.length).toBeGreaterThan(0);
            expect(focusCalls.every((options) => options?.preventScroll === true)).toBe(true);
        } finally {
            HTMLElement.prototype.focus = originalFocus;
            await act(async () => root.unmount());
            HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
            globalThis.requestAnimationFrame = originalRequestAnimationFrame;
            globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
            portalTarget.remove();
            anchor.remove();
            container.remove();
        }
    });

    it('focuses the selected interactive descendant before the first option when requested on open', async () => {
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
        globalThis.requestAnimationFrame = (callback) => window.setTimeout(() => callback(0), 0);
        globalThis.cancelAnimationFrame = (handle) => window.clearTimeout(handle);

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
                                    <button type="button" data-testid="popover-first-option">First</button>
                                    <button type="button" aria-selected="true" data-testid="popover-selected-option">Selected</button>
                                </>
                            )}
                        </Popover>
                    </ModalPortalTargetProvider>,
                );
            });
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 100));
            });

            expect(document.activeElement).toBe(portalTarget.querySelector('[data-testid="popover-selected-option"]'));
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

    it('returns Escape focus to the connected activation trigger when the measurable anchor wrapper cannot receive focus', async () => {
        const { Popover } = await import('./Popover');
        const portalTarget = document.createElement('div');
        const container = document.createElement('div');
        document.body.append(portalTarget, container);
        const root = createRoot(container);
        const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
        const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
        const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;

        function DropdownLikeHarness() {
            const [open, setOpen] = React.useState(false);
            const anchorRef = React.useRef<HTMLDivElement>(null);
            return (
                <ModalPortalTargetProvider target={portalTarget}>
                    <div ref={anchorRef}>
                        <button
                            type="button"
                            data-testid="dropdown-trigger"
                            onClick={() => setOpen(true)}
                        >
                            More
                        </button>
                        {open ? (
                            <Popover
                                open={open}
                                anchorRef={anchorRef}
                                autoFocusOnOpen
                                placement="bottom"
                                backdrop={false}
                                portal={{ web: true, native: true }}
                                onRequestClose={() => setOpen(false)}
                            >
                                {() => <button type="button" data-testid="dropdown-menu-item">Remove</button>}
                            </Popover>
                        ) : null}
                    </div>
                </ModalPortalTargetProvider>
            );
        }

        HTMLElement.prototype.getBoundingClientRect = () => rect(100, 100, 180, 40);
        globalThis.requestAnimationFrame = (callback) => window.setTimeout(() => callback(0), 0);
        globalThis.cancelAnimationFrame = (handle) => window.clearTimeout(handle);

        try {
            await act(async () => {
                root.render(<DropdownLikeHarness />);
            });

            const trigger = container.querySelector<HTMLButtonElement>('[data-testid="dropdown-trigger"]');
            expect(trigger).not.toBeNull();
            // Browsers focus a pointer-activated button before its click handler
            // opens the popover; jsdom needs that browser fact made explicit.
            trigger!.focus();
            expect(document.activeElement).toBe(trigger);

            await act(async () => {
                trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                await new Promise((resolve) => setTimeout(resolve, 100));
            });

            const menuItem = portalTarget.querySelector<HTMLButtonElement>('[data-testid="dropdown-menu-item"]');
            expect(menuItem).not.toBeNull();
            expect(document.activeElement).toBe(menuItem);
            expect(trigger!.isConnected).toBe(true);

            await act(async () => {
                menuItem!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
                await Promise.resolve();
            });

            expect(trigger!.isConnected).toBe(true);
            expect(document.activeElement).toBe(trigger);
        } finally {
            await act(async () => root.unmount());
            HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
            globalThis.requestAnimationFrame = originalRequestAnimationFrame;
            globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
            portalTarget.remove();
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
        globalThis.requestAnimationFrame = (callback) => window.setTimeout(() => callback(0), 0);
        globalThis.cancelAnimationFrame = (handle) => window.clearTimeout(handle);
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
