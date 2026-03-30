import { vi } from 'vitest';

type SystemToolRendererModuleFactory = () => unknown | Promise<unknown>;

type InstallSystemToolRendererCommonModuleMocksOptions = Readonly<{
    modal?: SystemToolRendererModuleFactory;
    text?: SystemToolRendererModuleFactory;
}>;

const systemToolRendererModuleState = vi.hoisted(() => ({
    options: {
        modal: undefined as SystemToolRendererModuleFactory | undefined,
        text: undefined as SystemToolRendererModuleFactory | undefined,
    },
}));

vi.mock('@/text', async () => {
    const activeOptions = systemToolRendererModuleState.options;
    if (activeOptions.text) {
        return await activeOptions.text();
    }

    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/modal', async () => {
    const activeOptions = systemToolRendererModuleState.options;
    if (activeOptions.modal) {
        return await activeOptions.modal();
    }

    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

export function installSystemToolRendererCommonModuleMocks(
    options: InstallSystemToolRendererCommonModuleMocksOptions = {},
): void {
    systemToolRendererModuleState.options = {
        modal: options.modal,
        text: options.text,
    };
}
