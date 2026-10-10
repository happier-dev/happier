/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import * as RadixDialog from '@radix-ui/react-dialog';
import { describe, expect, it, vi } from 'vitest';

import { installModalComponentCommonModuleMocks } from './modalComponentTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installModalComponentCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        // Keep the actual RNW DOM/ref/autofocus contract at the native host boundary.
        // The Node test shim replaces package-name RNW requests; its absolute entry stays real.
        const { getVitestNodeBuiltin } = await import('@/dev/vitestNodeBuiltins');
        const { createRequire } = getVitestNodeBuiltin<Pick<typeof import('node:module'), 'createRequire'>>('node:module');
        const nativeWebPath = createRequire(import.meta.url).resolve('react-native-web');
        const { View, Text, TextInput, Pressable } = await vi.importActual<Pick<
            typeof import('react-native'), 'View' | 'Text' | 'TextInput' | 'Pressable'
        >>(nativeWebPath);
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
                select: <T,>(values: { web?: T; default?: T }) => values.web ?? values.default,
            },
            View,
            Text,
            TextInput,
            Pressable,
        });
    },
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub, createUseLocalSettingMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useLocalSetting: createUseLocalSettingMock(),
    });
});

// The route modal below stands in for Expo Router's web modal (a Radix dialog); the app dialog gets the
// same Radix modules, because both must share Radix's layer and focus-scope stacks.
vi.mock('@/utils/web/radixCjs', async () => {
    const { createRadixCjsRealModule } = await import('@/dev/testkit/mocks/radixCjs');
    return await createRadixCjsRealModule();
});

vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: (props: React.PropsWithChildren<Record<string, unknown>>) => (
        React.createElement('div', props, props.children)
    ),
}));

// These owners import react-native: load them after configuring the shared platform boundary.
const { ESCAPE_LAYER_PRIORITIES, useEscapeLayer } = await import('@/keyboard/escape');
const { FocusReturnProvider, useFocusReturnFallbackRef } = await import('@/keyboard/focusReturn');
const { motionTokens } = await import('@/components/ui/motion/motionTokens');
// Build the real modal graph during collection, outside the default behavioral test budget.
const { ModalProvider } = await import('../ModalProvider');
const { Modal } = await import('../ModalManager');
const { BaseModal } = await import('./BaseModal');

function pressEscape(): void {
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
    }));
}

function UnderlyingOverlay({ onEscape }: { onEscape: () => void }) {
    useEscapeLayer({
        priority: ESCAPE_LAYER_PRIORITIES.overlay,
        allowEditableTarget: true,
        onEscape,
    });
    return null;
}

function ReturnFallback() {
    const ref = useFocusReturnFallbackRef<HTMLButtonElement | null>();
    return <button ref={ref} data-testid="fallback-return">Fallback</button>;
}

describe('BaseModal over a route modal (web)', () => {
    it('cancels a provider-hosted autofocus prompt and returns focus to its opener', async () => {
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        let result: Promise<string | null> | undefined;
        try {
            await act(async () => {
                root.render(<ModalProvider><button data-testid="prompt-opener">Rename</button></ModalProvider>);
            });
            const opener = container.querySelector<HTMLButtonElement>('[data-testid="prompt-opener"]')!;
            opener.focus();
            expect(document.activeElement).toBe(opener);
            await act(async () => {
                result = Modal.prompt('Rename session', 'Enter a name', { defaultValue: 'Session' });
            });
            const input = document.querySelector<HTMLInputElement>('[data-testid="web-prompt-input"]')!;
            expect(input.value).toBe('Session');
            expect(document.activeElement).toBe(input);

            await act(async () => { pressEscape(); });
            await expect(result).resolves.toBeNull();
            await act(async () => { await Promise.resolve(); });
            expect(document.querySelector('[aria-modal="true"]')).toBeNull();
            expect(document.activeElement).toBe(opener);
        } finally {
            await act(async () => { root.unmount(); });
            container.remove();
        }
    });

    it.each(['captured', 'explicit', 'empty-ref'] as const)('returns a provider-hosted autofocus modal using its %s target', async (target) => {
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        function AutofocusModal() {
            return <input autoFocus aria-label="Modal entry" />;
        }

        try {
            await act(async () => {
                root.render(<FocusReturnProvider><ModalProvider>
                    <button data-testid="modal-opener">Open</button>
                    <button data-testid="explicit-return">Return here</button>
                    <ReturnFallback />
                </ModalProvider></FocusReturnProvider>);
            });
            const opener = container.querySelector<HTMLButtonElement>('[data-testid="modal-opener"]')!;
            const explicitTarget = container.querySelector<HTMLButtonElement>('[data-testid="explicit-return"]')!;
            const fallback = container.querySelector<HTMLButtonElement>('[data-testid="fallback-return"]')!;
            opener.focus();
            expect(document.activeElement).toBe(opener);

            await act(async () => {
                Modal.show({
                    component: AutofocusModal,
                    ...(target === 'captured' ? {} : {
                        focusReturnRef: { current: target === 'explicit' ? explicitTarget : null },
                    }),
                });
            });
            const entry = document.querySelector<HTMLInputElement>('input[aria-label="Modal entry"]')!;
            expect(entry.closest('[aria-modal="true"]')!.contains(document.activeElement)).toBe(true);

            await act(async () => { pressEscape(); });
            await act(async () => { await Promise.resolve(); });
            expect(document.activeElement).toBe(target === 'captured' ? opener : target === 'explicit' ? explicitTarget : fallback);
        } finally {
            await act(async () => { root.unmount(); });
            container.remove();
        }
    });

    it('returns from a nested autofocus modal to its outer opener before returning to the page', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        function InnerModal() {
            return <input autoFocus aria-label="Inner entry" />;
        }
        function OuterModal() {
            return <button data-testid="inner-opener">Open inner</button>;
        }
        const onOuterClose = vi.fn();

        try {
            await act(async () => {
                root.render(<ModalProvider><button data-testid="page-opener">Open outer</button></ModalProvider>);
            });
            const opener = container.querySelector<HTMLButtonElement>('[data-testid="page-opener"]')!;
            opener.focus();
            await act(async () => { Modal.show({ component: OuterModal, onRequestClose: onOuterClose }); });
            const innerOpener = document.querySelector<HTMLButtonElement>('[data-testid="inner-opener"]')!;
            await act(async () => {
                innerOpener.focus();
                Modal.show({ component: InnerModal });
            });
            expect(document.querySelector('input[aria-label="Inner entry"]')).not.toBeNull();
            expect(document.querySelector('[data-testid="inner-opener"]')).toBe(innerOpener);
            expect(onOuterClose).not.toHaveBeenCalled();

            await act(async () => { pressEscape(); });
            await act(async () => { await Promise.resolve(); });
            expect(document.activeElement).toBe(innerOpener);
            await act(async () => { vi.advanceTimersByTime(motionTokens.overlay.modal.exitMs); });
            // Radix removes the retired focus scope in its own deferred unmount callback.
            await act(async () => { vi.runOnlyPendingTimers(); });
            expect(document.querySelector('input[aria-label="Inner entry"]')).toBeNull();
            expect(document.querySelector('[data-testid="inner-opener"]')).toBe(innerOpener);
            expect(onOuterClose).not.toHaveBeenCalled();
            await act(async () => { pressEscape(); });
            await act(async () => { await Promise.resolve(); });
            await act(async () => { vi.advanceTimersByTime(motionTokens.overlay.modal.exitMs); });
            await act(async () => { vi.runOnlyPendingTimers(); });
            await act(async () => { await Promise.resolve(); });
            expect(document.querySelector('[aria-modal="true"]')).toBeNull();
            expect(document.activeElement).toBe(opener);
        } finally {
            await act(async () => { root.unmount(); });
            container.remove();
            vi.useRealTimers();
        }
    });

    it('dismisses the modal before an underlying shared Escape layer, including from its input', async () => {
        const onUnderlyingEscape = vi.fn();
        const onDialogClose = vi.fn();
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        const render = (visible: boolean) => <>
            <UnderlyingOverlay onEscape={onUnderlyingEscape} />
            <BaseModal visible={visible} onClose={onDialogClose}>
                <input aria-label="Search" />
            </BaseModal>
        </>;
        try {
            await act(async () => {
                root.render(render(true));
            });
            document.querySelector<HTMLInputElement>('input[aria-label="Search"]')!.focus();
            await act(async () => { pressEscape(); });
            expect(onDialogClose).toHaveBeenCalledTimes(1);
            expect(onUnderlyingEscape).not.toHaveBeenCalled();
            await act(async () => { root.render(render(false)); });
            await act(async () => { pressEscape(); });
            expect(onUnderlyingEscape).toHaveBeenCalledTimes(1);
            expect(onDialogClose).toHaveBeenCalledTimes(1);
        } finally {
            await act(async () => { root.unmount(); });
            container.remove();
        }
    });

    it('owns focus and Escape while it is on top, then hands focus back to the route modal', async () => {
        const onSettingsOpenChange = vi.fn();
        const onDialogClose = vi.fn();
        const settingsContainer = document.createElement('div');
        const dialogContainer = document.createElement('div');
        document.body.append(settingsContainer, dialogContainer);
        const settingsRoot = createRoot(settingsContainer);
        const dialogRoot = createRoot(dialogContainer);
        const triggerRef: { current: HTMLButtonElement | null } = { current: null };

        const renderDialog = (visible: boolean) => (
            <BaseModal visible={visible} onClose={onDialogClose} focusReturnRef={triggerRef}>
                <button data-testid="dialog-first">First</button>
                <button data-testid="dialog-last">Last</button>
            </BaseModal>
        );

        try {
            // The Settings route modal: a modal Radix dialog that traps focus and closes on Escape.
            await act(async () => {
                settingsRoot.render(
                    <RadixDialog.Root open onOpenChange={onSettingsOpenChange}>
                        <RadixDialog.Portal>
                            <RadixDialog.Content aria-describedby={undefined}>
                                <RadixDialog.Title>Settings</RadixDialog.Title>
                                <button ref={triggerRef} data-testid="settings-trigger">Add a Home</button>
                            </RadixDialog.Content>
                        </RadixDialog.Portal>
                    </RadixDialog.Root>,
                );
            });
            triggerRef.current!.focus();
            expect(document.activeElement).toBe(triggerRef.current);

            await act(async () => {
                dialogRoot.render(renderDialog(true));
            });
            const first = document.querySelector<HTMLButtonElement>('[data-testid="dialog-first"]')!;
            const last = document.querySelector<HTMLButtonElement>('[data-testid="dialog-last"]')!;
            const dialogShell = first.closest<HTMLElement>('[aria-modal="true"]')!;

            // The dialog on top owns keyboard focus: the route modal beneath does not pull it back.
            expect(dialogShell.contains(document.activeElement)).toBe(true);
            await act(async () => {
                last.focus();
            });
            expect(document.activeElement).toBe(last);

            // Escape closes only the topmost overlay.
            await act(async () => {
                pressEscape();
            });
            expect(onDialogClose).toHaveBeenCalledTimes(1);
            expect(onSettingsOpenChange).not.toHaveBeenCalled();

            // Closing hands focus back to the control inside Settings that opened the dialog.
            await act(async () => {
                dialogRoot.render(renderDialog(false));
            });
            await act(async () => {
                dialogRoot.unmount();
            });
            await act(async () => {
                await Promise.resolve();
            });
            expect(document.activeElement).toBe(triggerRef.current);

            // And Settings is on top again: Escape now closes it.
            await act(async () => {
                pressEscape();
            });
            expect(onSettingsOpenChange).toHaveBeenCalledWith(false);
        } finally {
            await act(async () => {
                settingsRoot.unmount();
            });
            settingsContainer.remove();
            dialogContainer.remove();
        }
    });
});
