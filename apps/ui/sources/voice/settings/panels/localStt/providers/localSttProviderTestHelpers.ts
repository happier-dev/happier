import { vi } from 'vitest';

type LocalSttProviderModuleFactory = () => unknown | Promise<unknown>;

type InstallLocalSttProviderCommonModuleMocksOptions = Readonly<{
    modal?: LocalSttProviderModuleFactory;
    text?: LocalSttProviderModuleFactory;
    unistyles?: LocalSttProviderModuleFactory;
}>;

const localSttProviderModuleState = vi.hoisted(() => ({
    options: {
        modal: undefined as LocalSttProviderModuleFactory | undefined,
        text: undefined as LocalSttProviderModuleFactory | undefined,
        unistyles: undefined as LocalSttProviderModuleFactory | undefined,
    },
}));

vi.mock('react-native-unistyles', async () => {
    const activeOptions = localSttProviderModuleState.options;
    if (activeOptions.unistyles) {
        return await activeOptions.unistyles();
    }

    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const activeOptions = localSttProviderModuleState.options;
    if (activeOptions.text) {
        return await activeOptions.text();
    }

    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/modal', async () => {
    const activeOptions = localSttProviderModuleState.options;
    if (activeOptions.modal) {
        return await activeOptions.modal();
    }

    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            prompt: vi.fn(),
            alert: vi.fn(),
        },
    }).module;
});

export function installLocalSttProviderCommonModuleMocks(
    options: InstallLocalSttProviderCommonModuleMocksOptions = {},
): void {
    localSttProviderModuleState.options = {
        modal: options.modal,
        text: options.text,
        unistyles: options.unistyles,
    };
}
