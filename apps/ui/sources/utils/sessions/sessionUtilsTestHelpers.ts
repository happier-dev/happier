import { vi } from 'vitest';

type SessionUtilsModuleFactory = () => unknown | Promise<unknown>;
type SessionUtilsImportOriginal = <T = unknown>() => Promise<T>;
type SessionUtilsStorageModuleFactory = (
    importOriginal: SessionUtilsImportOriginal,
) => unknown | Promise<unknown>;

type InstallSessionUtilsCommonModuleMocksOptions = Readonly<{
    storage?: SessionUtilsStorageModuleFactory;
    text?: SessionUtilsModuleFactory;
}>;

const sessionUtilsModuleState = vi.hoisted(() => ({
    options: {
        storage: undefined as SessionUtilsStorageModuleFactory | undefined,
        text: undefined as SessionUtilsModuleFactory | undefined,
    },
}));

export function installSessionUtilsCommonModuleMocks(
    options: InstallSessionUtilsCommonModuleMocksOptions = {},
): void {
    sessionUtilsModuleState.options = {
        storage: options.storage,
        text: options.text,
    };

    vi.mock('@/text', async () => {
        const activeOptions = sessionUtilsModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = sessionUtilsModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({});
    });
}
