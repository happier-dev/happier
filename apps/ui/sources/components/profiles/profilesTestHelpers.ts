import { vi } from 'vitest';

type ProfilesModuleFactory = () => unknown | Promise<unknown>;

type InstallProfilesCommonModuleMocksOptions = Readonly<{
    modal?: ProfilesModuleFactory;
    reactNative?: ProfilesModuleFactory;
    storage?: ProfilesModuleFactory;
    text?: ProfilesModuleFactory;
    unistyles?: ProfilesModuleFactory;
}>;

const profilesModuleState = vi.hoisted(() => ({
    options: {
        modal: undefined as ProfilesModuleFactory | undefined,
        reactNative: undefined as ProfilesModuleFactory | undefined,
        storage: undefined as ProfilesModuleFactory | undefined,
        text: undefined as ProfilesModuleFactory | undefined,
        unistyles: undefined as ProfilesModuleFactory | undefined,
    },
}));

export function installProfilesCommonModuleMocks(
    options: InstallProfilesCommonModuleMocksOptions = {},
): void {
    profilesModuleState.options = {
        modal: options.modal,
        reactNative: options.reactNative,
        storage: options.storage,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = profilesModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = profilesModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = profilesModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });

    vi.mock('@/modal', async () => {
        const activeOptions = profilesModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('@/sync/domains/state/storage', async () => {
        const activeOptions = profilesModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage();
        }

        const { createStorageModuleStub, createUseSettingMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSetting: createUseSettingMock(),
        });
    });
}
