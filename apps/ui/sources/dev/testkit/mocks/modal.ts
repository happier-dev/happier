import * as React from 'react';
import type { IModal } from '@/modal';
import { vi } from 'vitest';

export type ModalModuleMockOptions = Readonly<{
    confirmResult?: boolean;
    /** Mount real custom modal content beneath the mocked presentation boundary. */
    renderCustomModals?: boolean;
    /** Keep transient confirmation dialogs open for tests that press their real public controls. */
    settleTransientConfirmations?: boolean;
    spies?: Partial<{
        show: IModal['show'];
        hide: IModal['hide'];
        update: IModal['update'];
        hideAll: IModal['hideAll'];
        alert: IModal['alert'];
        alertAsync: IModal['alertAsync'];
        prompt: IModal['prompt'];
        confirm: IModal['confirm'];
    }>;
}>;

export function createModalModuleMock(options: ModalModuleMockOptions = {}) {
    const confirmResult = options.confirmResult ?? false;
    // IModal's generic config is the boundary's own component/props contract.
    type CustomModalConfig = Parameters<IModal['show']>[0];
    let modals: ReadonlyArray<Readonly<{ id: string; config: CustomModalConfig }>> = [];
    let nextModalId = 0;
    const listeners = new Set<() => void>();
    const publish = () => { for (const listener of listeners) listener(); };
    const showImplementation = options.spies?.show ?? ((config: Parameters<IModal['show']>[0]) => {
        const candidate = config as Readonly<{
            chrome?: Readonly<{ testID?: string }>;
            props?: Readonly<{ onConfirm?(): void; onCancel?(): void }>;
        }>;
        if (candidate.chrome?.testID === 'app-shell-transient-interaction-dialog' && options.settleTransientConfirmations !== false) {
            queueMicrotask(() => {
                if (confirmResult) candidate.props?.onConfirm?.();
                else candidate.props?.onCancel?.();
            });
        }
        if (options.renderCustomModals) {
            const id = `modal-${++nextModalId}`;
            modals = [...modals, { id, config }];
            publish();
            return id;
        }
        return 'modal-id';
    });
    const hideImplementation = options.spies?.hide ?? ((id: string) => {
        if (!options.renderCustomModals) return;
        modals = modals.filter((modal) => modal.id !== id);
        publish();
    });
    const updateImplementation = options.spies?.update ?? ((id: string, props: Record<string, unknown>) => {
        if (!options.renderCustomModals) return;
        modals = modals.map((modal) => modal.id === id
            ? { ...modal, config: { ...modal.config, props } } : modal);
        publish();
    });
    const hideAllImplementation = options.spies?.hideAll ?? (() => {
        if (!options.renderCustomModals) return;
        modals = [];
        publish();
    });
    const alertImplementation = options.spies?.alert;
    const alertAsyncImplementation = options.spies?.alertAsync ?? (async (...args: Parameters<IModal['alertAsync']>) => {
        alertImplementation?.(...args);
    });
    const promptImplementation = options.spies?.prompt ?? (async () => null);
    const confirmImplementation = options.spies?.confirm ?? (async () => confirmResult);
    const spies = {
        show: vi.fn<IModal['show']>(showImplementation),
        hide: vi.fn<IModal['hide']>(hideImplementation),
        update: vi.fn<IModal['update']>(updateImplementation),
        hideAll: vi.fn<IModal['hideAll']>(hideAllImplementation),
        alert: alertImplementation ? vi.fn<IModal['alert']>(alertImplementation) : vi.fn<IModal['alert']>(),
        alertAsync: vi.fn<IModal['alertAsync']>(alertAsyncImplementation),
        prompt: vi.fn<IModal['prompt']>(promptImplementation),
        confirm: vi.fn<IModal['confirm']>(confirmImplementation),
    };
    const context = {
        state: { modals: [] },
        showModal: spies.show,
        hideModal: spies.hide,
        hideAllModals: spies.hideAll,
        updateCustomModalProps: spies.update,
    };

    function CustomContentProvider({ active, children }: { active?: boolean; children?: React.ReactNode }) {
        const snapshot = React.useSyncExternalStore(
            (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
            () => modals,
            () => modals,
        );
        return React.createElement('ModalProvider', { active }, children ?? null,
            snapshot.map(({ id, config }) => React.createElement(config.component, {
                ...config.props,
                key: id,
                onClose: () => spies.hide(id),
            })));
    }

    function ModalProvider({ active, children }: { active?: boolean; children?: React.ReactNode }) {
        return options.renderCustomModals
            ? React.createElement(CustomContentProvider, { active, children })
            : React.createElement('ModalProvider', { active }, children ?? null);
    }

    return {
        spies,
        module: {
            Modal: {
                show: spies.show,
                hide: spies.hide,
                update: spies.update,
                hideAll: spies.hideAll,
                alert: spies.alert,
                alertAsync: spies.alertAsync,
                prompt: spies.prompt,
                confirm: spies.confirm,
            },
            ModalProvider,
            useOptionalModal: () => ({
                state: { modals: [] },
                showModal: spies.show,
                hideModal: spies.hide,
                hideAllModals: spies.hideAll,
                updateCustomModalProps: spies.update,
            }),
        },
    };
}
