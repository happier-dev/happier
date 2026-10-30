/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import { ESCAPE_LAYER_PRIORITIES, EscapeLayerProvider, useEscapeLayer } from './escape';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function EscapeLayerProbe(props: Readonly<{ onEscape: (event: unknown) => boolean | void }>) {
    useEscapeLayer({
        enabled: true,
        priority: ESCAPE_LAYER_PRIORITIES.popover,
        allowEditableTarget: true,
        onEscape: props.onEscape,
    });

    return <input data-testid="escape-target" />;
}

describe('useEscapeLayer', () => {
    it('yields a claimed native-widget Escape to its target without dismissing or restoring the pane', async () => {
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        const closePane = vi.fn();
        const nativeDismiss = vi.fn();
        const focus = vi.fn();
        function Layers() {
            useEscapeLayer({ priority: ESCAPE_LAYER_PRIORITIES.overlay, allowEditableTarget: true, onEscape: closePane });
            useEscapeLayer({ priority: ESCAPE_LAYER_PRIORITIES.composerSuggestions, allowEditableTarget: true,
                focusReturnRef: { current: { focus } }, onEscape: () => 'defer-to-target' });
            return <input />;
        }
        try {
            await act(async () => root.render(<Layers />));
            const input = container.querySelector('input')!;
            input.addEventListener('keydown', nativeDismiss);
            const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
            input.dispatchEvent(event);
            expect(nativeDismiss).toHaveBeenCalledOnce();
            expect(closePane).not.toHaveBeenCalled();
            expect(focus).not.toHaveBeenCalled();
            expect(event.defaultPrevented).toBe(false);
        } finally {
            await act(async () => root.unmount());
            container.remove();
        }
    });

    it('orders nested layers inside their root, preserving a later unrelated modal above them', async () => {
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        const dismissed: string[] = [];
        function Layer({ name, priority, children }: React.PropsWithChildren<{ name: string; priority: number }>) {
            const layer = useEscapeLayer({ priority, allowEditableTarget: true, onEscape: () => { dismissed.push(name); } });
            return <EscapeLayerProvider layer={layer}>{children}</EscapeLayerProvider>;
        }
        const press = () => container.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        try {
            await act(async () => root.render(<Layer name="sheet" priority={ESCAPE_LAYER_PRIORITIES.modal}>
                <Layer name="menu" priority={ESCAPE_LAYER_PRIORITIES.popover}><input /></Layer>
            </Layer>));
            press();
            expect(dismissed).toEqual(['menu']);
            await act(async () => root.render(<>
                <Layer name="sheet" priority={ESCAPE_LAYER_PRIORITIES.modal}>
                    <Layer name="menu" priority={ESCAPE_LAYER_PRIORITIES.popover}><input /></Layer>
                </Layer>
                <Layer name="new-dialog" priority={ESCAPE_LAYER_PRIORITIES.modal}><input /></Layer>
            </>));
            press();
            expect(dismissed).toEqual(['menu', 'new-dialog']);
        } finally {
            await act(async () => root.unmount());
            container.remove();
        }
    });

    it('handles Escape before older document-capture modal listeners observe it', async () => {
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        const modalDocumentCaptureListener = vi.fn();
        const onEscape = vi.fn(() => true);

        document.addEventListener('keydown', modalDocumentCaptureListener, true);

        try {
            await act(async () => {
                root.render(<EscapeLayerProbe onEscape={onEscape} />);
            });

            const target = container.querySelector('[data-testid="escape-target"]');
            expect(target).toBeInstanceOf(HTMLInputElement);

            const event = new KeyboardEvent('keydown', {
                key: 'Escape',
                bubbles: true,
                cancelable: true,
            });
            target!.dispatchEvent(event);

            expect(onEscape).toHaveBeenCalledTimes(1);
            expect(event.defaultPrevented).toBe(true);
            expect(modalDocumentCaptureListener).not.toHaveBeenCalled();
        } finally {
            document.removeEventListener('keydown', modalDocumentCaptureListener, true);
            await act(async () => {
                root.unmount();
            });
            container.remove();
        }
    });

    it('falls back to document when window does not expose DOM event listeners', async () => {
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        const onEscape = vi.fn(() => true);
        const windowAddEventListener = Object.getOwnPropertyDescriptor(window, 'addEventListener');
        const windowRemoveEventListener = Object.getOwnPropertyDescriptor(window, 'removeEventListener');
        const documentAddEventListener = vi.spyOn(document, 'addEventListener');
        const documentRemoveEventListener = vi.spyOn(document, 'removeEventListener');

        Object.defineProperty(window, 'addEventListener', {
            configurable: true,
            value: undefined,
        });
        Object.defineProperty(window, 'removeEventListener', {
            configurable: true,
            value: undefined,
        });

        try {
            await act(async () => {
                root.render(<EscapeLayerProbe onEscape={onEscape} />);
            });

            expect(documentAddEventListener).toHaveBeenCalledWith('keydown', expect.any(Function), true);
            const target = container.querySelector('[data-testid="escape-target"]');
            expect(target).toBeInstanceOf(HTMLInputElement);
            const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
            target!.dispatchEvent(event);
            expect(onEscape).toHaveBeenCalledOnce();
            expect(event.defaultPrevented).toBe(true);

            const registration = documentAddEventListener.mock.calls.find(([type, , capture]) => type === 'keydown' && capture === true);
            expect(registration).toBeDefined();
            await act(async () => { root.render(null); });
            expect(documentRemoveEventListener).toHaveBeenCalledWith('keydown', registration![1], true);
            const afterUnmount = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
            document.dispatchEvent(afterUnmount);
            expect(onEscape).toHaveBeenCalledOnce();
            expect(afterUnmount.defaultPrevented).toBe(false);
        } finally {
            if (windowAddEventListener) {
                Object.defineProperty(window, 'addEventListener', windowAddEventListener);
            }
            if (windowRemoveEventListener) {
                Object.defineProperty(window, 'removeEventListener', windowRemoveEventListener);
            }
            documentAddEventListener.mockRestore();
            documentRemoveEventListener.mockRestore();
            await act(async () => {
                root.unmount();
            });
            container.remove();
        }
    });
});
