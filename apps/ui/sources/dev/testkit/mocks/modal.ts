import * as React from 'react';
import type { IModal } from '@/modal';
import { vi } from 'vitest';

export type ModalModuleMockOptions = Readonly<{
    confirmResult?: boolean;
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
    const showImplementation = options.spies?.show ?? (() => 'modal-id');
    const hideImplementation = options.spies?.hide ?? (() => {});
    const updateImplementation = options.spies?.update ?? (() => {});
    const hideAllImplementation = options.spies?.hideAll ?? (() => {});
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
            ModalProvider: ({ active, children }: { active?: boolean; children?: React.ReactNode }) =>
                React.createElement('ModalProvider', { active }, children ?? null),
        },
    };
}
