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
        } finally {
            if (windowAddEventListener) {
                Object.defineProperty(window, 'addEventListener', windowAddEventListener);
            }
            if (windowRemoveEventListener) {
                Object.defineProperty(window, 'removeEventListener', windowRemoveEventListener);
            }
            documentAddEventListener.mockRestore();
            await act(async () => {
                root.unmount();
            });
            container.remove();
        }
    });
});
