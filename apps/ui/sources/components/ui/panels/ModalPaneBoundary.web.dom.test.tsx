/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ModalPaneBoundaryView, useModalPaneBoundary } from './ModalPaneBoundary';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.replaceChildren(); });

it('keeps structural pane focus as a fallback without painting a browser outline or suppressing control focus', async () => {
    function Pane() {
        const boundary = useModalPaneBoundary({ active: false, label: 'Editor', onRequestClose: () => {} });
        return <ModalPaneBoundaryView testID="pane" ref={boundary.setUnderlayFocusRef} {...boundary.underlayProps}>
            <button style={{ outlineWidth: 2, outlineStyle: 'solid', outlineColor: 'blue' }}>Edit</button>
        </ModalPaneBoundaryView>;
    }
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container); roots.push(root);
    await act(async () => root.render(<Pane />));
    const pane = container.querySelector<HTMLElement>('[data-testid="pane"]')!;
    pane.focus();
    expect(document.activeElement).toBe(pane);
    expect(getComputedStyle(pane).outlineStyle).toBe('none');
    const button = container.querySelector('button')!;
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(getComputedStyle(button).outlineWidth).toBe('2px');
});
