/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import { installPopoverCommonModuleMocks } from './popoverTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Real RNW DOM primitives expose ScrollView's ref lifecycle and pointer-event warnings;
// a plain-div content ref or local View shim cannot reproduce either contract.
installPopoverCommonModuleMocks({
    reactNative: async () => await vi.importActual('react-native-web'),
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

describe('Popover web pointer-events ownership', () => {
    it('keeps in-page customization controls inside its dismissal boundary until their click completes', async () => {
        const { Popover } = await import('./Popover');
        const { ItemList } = await import('@/components/ui/lists/ItemList');
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        const onAdd = vi.fn();
        const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect(100, 100, 180, 40));
        function Harness() {
            const [open, setOpen] = React.useState(true);
            const [menuOpen, setMenuOpen] = React.useState(false);
            const anchorRef = React.useRef<HTMLButtonElement>(null);
            const menuAnchorRef = React.useRef<HTMLButtonElement>(null);
            const interactionBoundaryRef = React.useRef<import('react-native').View>(null);
            return <>
                <button ref={anchorRef}>Customize</button>
                <ItemList innerViewRef={interactionBoundaryRef as React.RefObject<import('react-native').View>}>
                    {open ? ['empty-slot', 'child-menu', 'size', 'frame'].map(id => (
                        <button key={id} data-testid={`customize-${id}`} onClick={onAdd}>{id}</button>
                    )) : null}
                    {open ? <button ref={menuAnchorRef} data-testid="customize-group-bar" onClick={() => setMenuOpen(true)}>Group menu</button> : null}
                    <Popover open={open && menuOpen} anchorRef={menuAnchorRef} backdrop={false}
                        portal={{ web: true }} onRequestClose={() => setMenuOpen(false)}>
                        {() => <button data-testid="customize-group-menu-option" onClick={onAdd}>Frame</button>}
                    </Popover>
                </ItemList>
                <button data-testid="outside-customize">Outside</button>
                <Popover open={open} anchorRef={anchorRef} interactionBoundaryRef={interactionBoundaryRef}
                    backdrop={false} portal={{ web: true }} onRequestClose={() => setOpen(false)}>
                    {() => <span data-testid="customize-panel">Editor</span>}
                </Popover>
            </>;
        }
        try {
            await act(async () => root.render(<Harness />));
            const slot = document.querySelector('[data-testid="customize-empty-slot"]')!;
            await act(async () => slot.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
            expect(document.body.contains(slot)).toBe(true);
            await act(async () => {
                slot.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
                slot.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            expect(onAdd).toHaveBeenCalledOnce();
            expect(document.querySelector('[data-testid="customize-panel"]')).not.toBeNull();
            for (const id of ['child-menu', 'size', 'frame']) {
                const control = document.querySelector(`[data-testid="customize-${id}"]`)!;
                await act(async () => {
                    control.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
                    control.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                });
                expect(document.querySelector('[data-testid="customize-panel"]')).not.toBeNull();
            }
            expect(onAdd).toHaveBeenCalledTimes(4);
            await act(async () => {
                const groupBar = document.querySelector('[data-testid="customize-group-bar"]')!;
                groupBar.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
                groupBar.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            const menuOption = document.querySelector('[data-testid="customize-group-menu-option"]')!;
            await act(async () => menuOption.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
            expect(document.body.contains(slot)).toBe(true);
            expect(document.body.contains(menuOption)).toBe(true);
            await act(async () => menuOption.dispatchEvent(new MouseEvent('click', { bubbles: true })));
            expect(onAdd).toHaveBeenCalledTimes(5);
            // A portaled menu anchored inside the participating content owns the first outside press.
            await act(async () => document.querySelector('[data-testid="outside-customize"]')!
                .dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
            await vi.waitFor(() => expect(document.querySelector('[data-testid="customize-group-menu-option"]')).toBeNull());
            expect(document.body.contains(slot)).toBe(true);
            expect(document.querySelector('[data-testid="customize-panel"]')).not.toBeNull();
            await act(async () => document.querySelector('[data-testid="outside-customize"]')!
                .dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
            expect(document.querySelector('[data-testid="customize-empty-slot"]')).toBeNull();
        } finally {
            await act(async () => root.unmount());
            measure.mockRestore();
            container.remove();
        }
    });

    it('uses style-owned pointer events throughout the portaled backdrop path', async () => {
        const { Popover } = await import('./Popover');
        const { PopoverPortalTargetProvider } = await import('./PopoverPortalTargetProvider');
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root: Root = createRoot(container);
        const onOptionPress = vi.fn();
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
        const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
        const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;

        HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
            if (this.getAttribute('data-testid') === 'popover-trigger') {
                return rect(100, 100, 180, 40);
            }
            return rect(100, 140, 180, 120);
        };
        globalThis.requestAnimationFrame = (callback) => window.setTimeout(() => callback(performance.now()), 0);
        globalThis.cancelAnimationFrame = (handle) => window.clearTimeout(handle);

        function Harness() {
            const anchorRef = React.useRef<HTMLButtonElement>(null);
            return (
                <PopoverPortalTargetProvider>
                    <button ref={anchorRef} data-testid="popover-trigger" type="button">Open</button>
                    <Popover
                        open
                        anchorRef={anchorRef}
                        placement="bottom"
                        backdrop={{ effect: 'dim', blockOutsidePointerEvents: true }}
                        onRequestClose={() => {}}
                        portal={{ web: true, native: true }}
                    >
                        {() => (
                            <button data-testid="popover-option" type="button" onClick={onOptionPress}>
                                Option
                            </button>
                        )}
                    </Popover>
                </PopoverPortalTargetProvider>
            );
        }

        try {
            await act(async () => {
                root.render(<Harness />);
                await new Promise((resolve) => setTimeout(resolve, 100));
            });

            const option = document.body.querySelector<HTMLButtonElement>('[data-testid="popover-option"]');
            expect(option).not.toBeNull();
            await act(async () => {
                option!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            });
            expect(onOptionPress).toHaveBeenCalledTimes(1);

            const deprecatedPointerEventsWarnings = warning.mock.calls.filter(([message]) => (
                String(message).includes('props.pointerEvents is deprecated. Use style.pointerEvents')
            ));
            expect(deprecatedPointerEventsWarnings).toEqual([]);
        } finally {
            await act(async () => {
                root.unmount();
            });
            warning.mockRestore();
            HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
            globalThis.requestAnimationFrame = originalRequestAnimationFrame;
            globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
            container.remove();
        }
    });
});
