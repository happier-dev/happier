import * as React from 'react';
import type { IModal } from '@/modal';

export type ModalModuleRuntimeOptions = Readonly<{
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

export type ModalRuntimeAdapters = Readonly<{
    createMethod?: <TArgs extends unknown[], TResult>(
        implementation?: (...args: TArgs) => TResult,
    ) => (...args: TArgs) => TResult;
}>;

function createRuntimeMethod<TArgs extends unknown[], TResult>(
    implementation?: (...args: TArgs) => TResult,
): (...args: TArgs) => TResult {
    return (...args: TArgs) => implementation?.(...args) as TResult;
}

export function createModalModuleRuntime(
    options: ModalModuleRuntimeOptions = {},
    adapters: ModalRuntimeAdapters = {},
) {
    const createMethod = adapters.createMethod ?? createRuntimeMethod;
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
        show: createMethod<Parameters<IModal['show']>, ReturnType<IModal['show']>>(showImplementation),
        hide: createMethod<Parameters<IModal['hide']>, ReturnType<IModal['hide']>>(hideImplementation),
        update: createMethod<Parameters<IModal['update']>, ReturnType<IModal['update']>>(updateImplementation),
        hideAll: createMethod<Parameters<IModal['hideAll']>, ReturnType<IModal['hideAll']>>(hideAllImplementation),
        alert: createMethod<Parameters<IModal['alert']>, ReturnType<IModal['alert']>>(alertImplementation),
        alertAsync: createMethod<Parameters<IModal['alertAsync']>, ReturnType<IModal['alertAsync']>>(alertAsyncImplementation),
        prompt: createMethod<Parameters<IModal['prompt']>, ReturnType<IModal['prompt']>>(promptImplementation),
        confirm: createMethod<Parameters<IModal['confirm']>, ReturnType<IModal['confirm']>>(confirmImplementation),
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
