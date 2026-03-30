import { vi } from 'vitest';

type RealtimeModuleFactory = () => unknown | Promise<unknown>;

type InstallRealtimeCommonModuleMocksOptions = Readonly<{
    modal?: RealtimeModuleFactory;
    storage?: RealtimeModuleFactory;
    text?: RealtimeModuleFactory;
}>;

const realtimeModuleState = vi.hoisted(() => ({
    options: {
        modal: undefined as RealtimeModuleFactory | undefined,
        storage: undefined as RealtimeModuleFactory | undefined,
        text: undefined as RealtimeModuleFactory | undefined,
    },
}));

export function installRealtimeCommonModuleMocks(
    options: InstallRealtimeCommonModuleMocksOptions = {},
): void {
    realtimeModuleState.options = {
        modal: options.modal,
        storage: options.storage,
        text: options.text,
    };

    vi.mock('@/modal', async () => {
        const activeOptions = realtimeModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('@/sync/domains/state/storage', async () => {
        const activeOptions = realtimeModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage();
        }

        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            storage: {
                getState: () => ({}),
            } as typeof import('@/sync/domains/state/storage').storage,
        });
    });

    vi.mock('@/text', async () => {
        const activeOptions = realtimeModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });
}
