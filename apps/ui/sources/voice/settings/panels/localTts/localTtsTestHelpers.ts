import { vi } from 'vitest';

type LocalTtsModuleFactory = () => unknown | Promise<unknown>;

type InstallLocalTtsCommonModuleMocksOptions = Readonly<{
    modal?: LocalTtsModuleFactory;
    text?: LocalTtsModuleFactory;
    unistyles?: LocalTtsModuleFactory;
}>;

const localTtsModuleState = vi.hoisted(() => ({
    options: {
        modal: undefined as LocalTtsModuleFactory | undefined,
        text: undefined as LocalTtsModuleFactory | undefined,
        unistyles: undefined as LocalTtsModuleFactory | undefined,
    },
}));

export function installLocalTtsCommonModuleMocks(
    options: InstallLocalTtsCommonModuleMocksOptions = {},
) {
    localTtsModuleState.options = {
        modal: options.modal,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = localTtsModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = localTtsModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });

    vi.mock('@/modal', async () => {
        const activeOptions = localTtsModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });
}
