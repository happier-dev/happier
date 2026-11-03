/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { installModalComponentCommonModuleMocks } from './components/modalComponentTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// A desktop window: jsdom lays nothing out, so the window size the app reads is given here.
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1440 });
Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 900 });
installModalComponentCommonModuleMocks({ reactNative: async () => {
    const { getVitestNodeBuiltin } = await import('@/dev/vitestNodeBuiltins');
    const { createRequire } = getVitestNodeBuiltin<Pick<typeof import('node:module'), 'createRequire'>>('node:module');
    // The package-name RNW request has a Node shim; its absolute entry is the real DOM boundary.
    return await vi.importActual(createRequire(import.meta.url).resolve('react-native-web'));
}, text: async () => await vi.importActual('@/text') });
vi.mock('@/utils/web/radixCjs', async () => {
    const { createRadixCjsRealModule } = await import('@/dev/testkit/mocks/radixCjs');
    return await createRadixCjsRealModule();
});
vi.mock('react-native-keyboard-controller', async () => {
    const { View } = await vi.importActual<typeof import('react-native-web')>('react-native-web');
    return { KeyboardAvoidingView: View };
});

// Resolve the real component graph during collection, outside behavior-test deadlines.
const { ModalProvider } = await import('./ModalProvider');
const { Modal } = await import('./ModalManager');

it('hangs a card opened with its trigger anchor from that trigger, without a scrim, and closes it on Escape', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        x: 900, y: 40, width: 80, height: 32, top: 40, left: 900, right: 980, bottom: 72, toJSON: () => ({}),
    });
    function ShareBody() {
        return <button data-testid="share-body">Copy link</button>;
    }
    function Harness() {
        const anchorRef = React.useRef<HTMLButtonElement>(null);
        return <ModalProvider>
            <button ref={anchorRef} data-testid="share-trigger" onClick={() => Modal.show({
                component: ShareBody,
                chrome: { kind: 'card', title: 'Share Weekly report', phonePresentation: 'sheet', scrollHost: 'bounded',
                    anchor: { kind: 'view', ref: anchorRef } },
            })}>Share</button>
        </ModalProvider>;
    }
    try {
        await act(async () => root.render(<Harness />));
        await act(async () => document.querySelector('[data-testid="share-trigger"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        await vi.waitFor(() => expect(document.querySelector('[data-testid="share-body"]')).not.toBeNull());
        const body = document.querySelector<HTMLElement>('[data-testid="share-body"]')!;
        // The card sits in the anchored popover layer, not in a centred modal with its scrim.
        expect(body.closest('[id^="popover-"]')).not.toBeNull();
        expect(document.querySelector('[data-happy-modal-layer]')).toBeNull();
        // Pressing inside the card keeps it open.
        await act(async () => body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
        expect(document.querySelector('[data-testid="share-body"]')).not.toBeNull();
        await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
        await vi.waitFor(() => expect(document.querySelector('[data-testid="share-body"]')).toBeNull());
    } finally {
        await act(async () => root.unmount());
        measure.mockRestore();
        container.remove();
    }
});

it.each([390, 1440])('returns an anchored sheet to its persistent trigger after its opening menu unmounts (%i px)', async (width) => {
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: width });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    window.dispatchEvent(new Event('resize'));
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    function ShareBody() {
        return <button data-testid="share-body">Copy link</button>;
    }
    function Harness() {
        const anchorRef = React.useRef<HTMLDivElement>(null);
        const [menuOpen, setMenuOpen] = React.useState(false);
        return <ModalProvider>
            <div ref={anchorRef}><button data-testid="share-trigger" onClick={() => setMenuOpen(true)}>More</button></div>
            {menuOpen && <button data-testid="share-menu-item" onClick={() => {
                Modal.show({
                    component: ShareBody,
                    chrome: { kind: 'card', title: 'Share Weekly report', phonePresentation: 'sheet',
                        anchor: { kind: 'view', ref: anchorRef } },
                });
                setMenuOpen(false);
            }}>Share</button>}
        </ModalProvider>;
    }
    try {
        await act(async () => root.render(<Harness />));
        const trigger = document.querySelector<HTMLButtonElement>('[data-testid="share-trigger"]')!;
        await act(async () => trigger.click());
        const menuItem = document.querySelector<HTMLButtonElement>('[data-testid="share-menu-item"]')!;
        menuItem.focus();
        await act(async () => menuItem.click());
        await vi.waitFor(() => expect(document.querySelector('[data-testid="share-body"]')).not.toBeNull());
        expect(menuItem.isConnected).toBe(false);
        expect(document.querySelector('[data-testid="share-body"]')!.closest('[id^="popover-"]') !== null).toBe(width === 1440);
        await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
        await vi.waitFor(() => expect(document.querySelector('[data-testid="share-body"]')).toBeNull());
        expect(document.activeElement).toBe(trigger);
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});
