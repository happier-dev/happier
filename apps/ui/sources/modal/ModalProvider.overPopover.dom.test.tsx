/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { installModalComponentCommonModuleMocks } from './components/modalComponentTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
const { Popover } = await import('@/components/ui/popover/Popover');
const { PresentationNoticeHost } = await import('@/components/sessions/presentation/PresentationNoticeHost');
const { publishPresentationNotice, retirePresentationNotice } = await import('@/components/sessions/presentation/presentationNotices');

it('puts a global modal opened from a retained popover above it and delivers pointer events without dismissing its opener', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const receivedPointer = vi.fn();
    const closePopover = vi.fn();
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        x: 100, y: 100, width: 180, height: 40, top: 100, left: 100, right: 280, bottom: 140, toJSON: () => ({}),
    });
    function Dialog() {
        return <button data-testid="modal-save" onPointerDown={receivedPointer}>Save</button>;
    }
    function Harness() {
        const anchorRef = React.useRef<HTMLButtonElement>(null);
        return <ModalProvider>
            <button ref={anchorRef}>Gallery</button>
            <Popover open anchorRef={anchorRef} portal={{ web: true }} backdrop={false} onRequestClose={closePopover}>
                {() => <button data-testid="rename" onClick={() => Modal.show({ component: Dialog })}>Rename</button>}
            </Popover>
        </ModalProvider>;
    }
    try {
        await act(async () => root.render(<Harness />));
        await vi.waitFor(() => expect(document.querySelector('[data-testid="rename"]')).not.toBeNull());
        await act(async () => document.querySelector('[data-testid="rename"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
        const rename = document.querySelector<HTMLElement>('[data-testid="rename"]')!;
        const popover = rename.closest<HTMLElement>('[id^="popover-"]')!;
        expect(dialog).not.toBeNull();
        expect(popover).not.toBeNull();
        expect(Number(window.getComputedStyle(dialog).zIndex)).toBeGreaterThan(Number(window.getComputedStyle(popover).zIndex));
        const save = document.querySelector('[data-testid="modal-save"]')!;
        await act(async () => save.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
        expect(receivedPointer).toHaveBeenCalledOnce();
        expect(closePopover).not.toHaveBeenCalled();
        await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
        await vi.waitFor(() => expect(document.querySelector('[data-testid="modal-save"]')).toBeNull());
        expect(closePopover).not.toHaveBeenCalled();
    } finally {
        await act(async () => root.unmount());
        measure.mockRestore();
        container.remove();
    }
});

it('puts a body-level menu opened from inside a modal above that modal', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        x: 100, y: 100, width: 180, height: 40, top: 100, left: 100, right: 280, bottom: 140, toJSON: () => ({}),
    });
    function Dialog() {
        const anchorRef = React.useRef<HTMLButtonElement>(null);
        return <>
            <button ref={anchorRef}>All registries</button>
            <Popover open anchorRef={anchorRef} portal={{ web: { target: 'body' } }} onRequestClose={() => {}}>
                {() => <button data-testid="menu-action">Manage registries</button>}
            </Popover>
        </>;
    }
    try {
        await act(async () => root.render(<ModalProvider><span /></ModalProvider>));
        await act(async () => { Modal.show({ component: Dialog }); });
        await vi.waitFor(() => expect(document.querySelector('[data-testid="menu-action"]')).not.toBeNull());
        const action = document.querySelector<HTMLElement>('[data-testid="menu-action"]')!;
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
        const popover = action.closest<HTMLElement>('[id^="popover-"]')!;
        expect(popover).not.toBeNull();
        expect(dialog.contains(popover)).toBe(false);
        expect(Number(window.getComputedStyle(popover).zIndex)).toBeGreaterThan(Number(window.getComputedStyle(dialog).zIndex));
    } finally {
        await act(async () => root.unmount());
        measure.mockRestore();
        container.remove();
    }
});

it('keeps a notice and its Undo above an open modal', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    function Dialog() {
        return <button>Name</button>;
    }
    try {
        await act(async () => root.render(<ModalProvider><PresentationNoticeHost /></ModalProvider>));
        await act(async () => { Modal.show({ component: Dialog }); });
        await act(async () => {
            publishPresentationNotice({ key: 'layer-test', message: 'Renamed', severity: 'info', undo: { label: 'Undo', run: () => {} } });
        });
        const undo = document.querySelector<HTMLElement>('[data-testid="current-session-presentation-notice-undo"]')!;
        const notice = undo.closest<HTMLElement>('[data-testid="current-session-presentation-notice"]')!;
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
        expect(Number(window.getComputedStyle(notice).zIndex)).toBeGreaterThan(Number(window.getComputedStyle(dialog).zIndex));
        await act(async () => { retirePresentationNotice('layer-test'); });
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});
