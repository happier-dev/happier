import { vi } from 'vitest';

type ScmOperationsModuleFactory = () => unknown | Promise<unknown>;

type InstallScmOperationsCommonModuleMocksOptions = Readonly<{
    modal?: ScmOperationsModuleFactory;
    text?: ScmOperationsModuleFactory;
}>;

const scmOperationsModuleState = vi.hoisted(() => ({
    options: {
        modal: undefined as ScmOperationsModuleFactory | undefined,
        text: undefined as ScmOperationsModuleFactory | undefined,
    },
}));

export function installScmOperationsCommonModuleMocks(
    options: InstallScmOperationsCommonModuleMocksOptions = {},
) {
    scmOperationsModuleState.options = {
        modal: options.modal,
        text: options.text,
    };

    vi.mock('@/modal', async () => {
        const activeOptions = scmOperationsModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('@/text', async () => {
        const activeOptions = scmOperationsModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });
}
