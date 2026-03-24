import { vi } from 'vitest';

type ErrorUtilityModuleFactory = () => unknown | Promise<unknown>;

type InstallErrorUtilityCommonModuleMocksOptions = Readonly<{
    modal?: ErrorUtilityModuleFactory;
    text?: ErrorUtilityModuleFactory;
}>;

const errorUtilityModuleState = vi.hoisted(() => ({
    options: {
        modal: undefined as ErrorUtilityModuleFactory | undefined,
        text: undefined as ErrorUtilityModuleFactory | undefined,
    },
}));

vi.mock('@/modal', async () => {
    const activeOptions = errorUtilityModuleState.options;
    if (activeOptions.modal) {
        return await activeOptions.modal();
    }

    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

vi.mock('@/text', async () => {
    const activeOptions = errorUtilityModuleState.options;
    if (activeOptions.text) {
        return await activeOptions.text();
    }

    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

export function installErrorUtilityCommonModuleMocks(
    options: InstallErrorUtilityCommonModuleMocksOptions = {},
): void {
    errorUtilityModuleState.options = {
        modal: options.modal,
        text: options.text,
    };
}
