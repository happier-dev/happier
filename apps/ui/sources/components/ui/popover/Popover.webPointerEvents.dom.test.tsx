/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import { installPopoverCommonModuleMocks } from './popoverTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// This must render react-native-web's real DOM primitives: the regression is its
// deprecated prop warning, which a React test-renderer or local View shim cannot observe.
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
