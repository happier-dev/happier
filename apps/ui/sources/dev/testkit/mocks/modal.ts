import * as React from 'react';
import { vi } from 'vitest';
import type { IModal } from '@/modal';

import {
    createModalModuleRuntime,
    type ModalModuleRuntimeOptions,
    type ModalRuntimeAdapters,
} from '../runtime/modalRuntime';

export type ModalModuleMockOptions = ModalModuleRuntimeOptions;

export function createModalModuleMock(options: ModalModuleMockOptions = {}) {
    const adapters: ModalRuntimeAdapters = {
        createMethod: <TArgs extends unknown[], TResult>(
            implementation?: (...args: TArgs) => TResult,
        ) => vi.fn((...args: TArgs) => implementation?.(...args) as TResult),
    };

    const runtime = createModalModuleRuntime(options, adapters);

    return {
        spies: runtime.spies as {
            show: ReturnType<typeof vi.fn<IModal['show']>>;
            hide: ReturnType<typeof vi.fn<IModal['hide']>>;
            update: ReturnType<typeof vi.fn<IModal['update']>>;
            hideAll: ReturnType<typeof vi.fn<IModal['hideAll']>>;
            alert: ReturnType<typeof vi.fn<IModal['alert']>>;
            alertAsync: ReturnType<typeof vi.fn<IModal['alertAsync']>>;
            prompt: ReturnType<typeof vi.fn<IModal['prompt']>>;
            confirm: ReturnType<typeof vi.fn<IModal['confirm']>>;
        },
        module: {
            Modal: runtime.module.Modal,
            ModalProvider: ({ active, children }: { active?: boolean; children?: React.ReactNode }) =>
                React.createElement('ModalProvider', { active }, children ?? null),
        },
    };
}
