/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { installModalComponentCommonModuleMocks } from './components/modalComponentTestHelpers';
import type { CustomModalInjectedProps } from './types';

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
const { ModalProvider, useVisibleModalId, useVisibleModalKind, useModalContentId } = await import('./ModalProvider');
const { Modal } = await import('./ModalManager');
const { motionTokens } = await import('@/components/ui/motion/motionTokens');

/**
 * A route that presents modally (Settings) hosts its own ModalProvider inside the app's root one. The
 * one reader of "which dialog is in front" (the current-UI context) sits above that route, so a dialog
 * shown through the nested host must reach it; otherwise every command a foreground dialog publishes is
 * withheld as background and its controls do nothing (the Share composer on Settings › Usage, 2026-11-07).
 */
it('reports a dialog shown through a nested route-scoped host to readers above it, and retires it on close', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const seen: Array<Readonly<{ kind: string | null; id: string | null }>> = [];
    let contentId: string | null = null;
    function Reader() {
        const kind = useVisibleModalKind();
        const id = useVisibleModalId();
        seen.push({ kind, id });
        return null;
    }
    function Dialog() {
        contentId = useModalContentId();
        return <div data-testid="nested-dialog" />;
    }
    let modalId = '';
    try {
        // The app's root host is registered first; a modally presented route mounts its host later and
        // becomes the current one, exactly as Settings does.
        const app = (route: boolean) => <ModalProvider>
            <Reader />
            {route ? <ModalProvider active><div data-testid="route" /></ModalProvider> : null}
        </ModalProvider>;
        await act(async () => root.render(app(false)));
        await act(async () => root.render(app(true)));
        expect(seen.at(-1)).toEqual({ kind: null, id: null });
        await act(async () => { modalId = Modal.show({ component: Dialog }); });
        expect(document.querySelector('[data-testid="nested-dialog"]')).not.toBeNull();
        // The dialog is hosted by the route's provider, not the root.
        expect(contentId).toBe(modalId);
        expect(seen.at(-1)).toEqual({ kind: 'custom', id: modalId });
        await act(async () => { Modal.hide(modalId); });
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 400)); });
        expect(seen.at(-1)).toEqual({ kind: null, id: null });
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});

it('dismisses a root-hosted dialog by id after a nested route host mounts, while nested dialogs still dismiss', async () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let rootModalId = '';
    let nestedModalId = '';
    function RootDialog() {
        return <button data-testid="root-dismiss" onClick={() => Modal.hide(rootModalId)}>Dismiss</button>;
    }
    function NestedDialog() {
        return <button data-testid="nested-dismiss" onClick={() => Modal.hide(nestedModalId)}>Dismiss</button>;
    }
    const app = (route: boolean) => <ModalProvider>
        {route ? <ModalProvider active><div data-testid="route" /></ModalProvider> : null}
    </ModalProvider>;
    try {
        await act(async () => root.render(app(false)));
        await act(async () => { rootModalId = Modal.show({ component: RootDialog }); });
        expect(document.querySelector('[data-testid="root-dismiss"]')).not.toBeNull();

        // SPA navigation registers a new host while the original dialog remains open.
        await act(async () => root.render(app(true)));
        await act(async () => { nestedModalId = Modal.show({ component: NestedDialog }); });
        const nestedDismiss = document.querySelector<HTMLButtonElement>('[data-testid="nested-dismiss"]');
        expect(nestedDismiss).not.toBeNull();
        await act(async () => { nestedDismiss!.click(); });
        await act(async () => { vi.advanceTimersByTime(motionTokens.overlay.modal.exitMs); });
        expect(document.querySelector('[data-testid="nested-dismiss"]')).toBeNull();

        const rootDismiss = document.querySelector<HTMLButtonElement>('[data-testid="root-dismiss"]');
        expect(rootDismiss).not.toBeNull();
        await act(async () => { rootDismiss!.click(); });
        await act(async () => { vi.advanceTimersByTime(motionTokens.overlay.modal.exitMs); });
        expect(document.querySelector('[data-testid="root-dismiss"]')).toBeNull();
    } finally {
        await act(async () => root.unmount());
        vi.useRealTimers();
        container.remove();
    }
});

it('updates a root-hosted dialog by id after a nested route host mounts, while nested dialogs still update', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const renders = { root: 0, nested: 0 };
    function Dialog({ testId, value }: CustomModalInjectedProps & Readonly<{ testId: string; value: string }>) {
        if (testId === 'root-value') renders.root += 1;
        else renders.nested += 1;
        return <div data-testid={testId}>{value}</div>;
    }
    const app = (route: boolean) => <ModalProvider>
        {route ? <ModalProvider active><div data-testid="route" /></ModalProvider> : null}
    </ModalProvider>;
    let rootModalId = '';
    let nestedModalId = '';
    try {
        await act(async () => root.render(app(false)));
        await act(async () => { rootModalId = Modal.show({ component: Dialog, props: { testId: 'root-value', value: 'before' } }); });
        await act(async () => root.render(app(true)));
        await act(async () => { nestedModalId = Modal.show({ component: Dialog, props: { testId: 'nested-value', value: 'before' } }); });
        const rootRendersBeforeNestedUpdate = renders.root;
        await act(async () => { Modal.update<React.ComponentProps<typeof Dialog>>(nestedModalId, { value: 'after' }); });
        expect(document.querySelector('[data-testid="nested-value"]')?.textContent).toBe('after');
        expect(document.querySelector('[data-testid="root-value"]')?.textContent).toBe('before');
        expect(renders.root).toBe(rootRendersBeforeNestedUpdate);

        const nestedRendersBeforeRootUpdate = renders.nested;
        await act(async () => { Modal.update<React.ComponentProps<typeof Dialog>>(rootModalId, { value: 'after' }); });
        expect(document.querySelector('[data-testid="root-value"]')?.textContent).toBe('after');
        expect(document.querySelector('[data-testid="nested-value"]')?.textContent).toBe('after');
        expect(renders.nested).toBe(nestedRendersBeforeRootUpdate);
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});
