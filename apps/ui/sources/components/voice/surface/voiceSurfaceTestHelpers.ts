import { vi } from 'vitest';

type VoiceSurfaceModuleFactory = () => unknown | Promise<unknown>;
type VoiceSurfaceImportOriginal = <T = unknown>() => Promise<T>;
type VoiceSurfaceStorageModuleFactory = (
    importOriginal: VoiceSurfaceImportOriginal,
) => unknown | Promise<unknown>;

type InstallVoiceSurfaceCommonModuleMocksOptions = Readonly<{
    icons?: VoiceSurfaceModuleFactory;
    reactNative?: VoiceSurfaceModuleFactory;
    router?: VoiceSurfaceModuleFactory;
    storage?: VoiceSurfaceStorageModuleFactory;
    text?: VoiceSurfaceModuleFactory;
    unistyles?: VoiceSurfaceModuleFactory;
}>;

const voiceSurfaceModuleState = vi.hoisted(() => ({
    options: {
        icons: undefined as VoiceSurfaceModuleFactory | undefined,
        reactNative: undefined as VoiceSurfaceModuleFactory | undefined,
        router: undefined as VoiceSurfaceModuleFactory | undefined,
        storage: undefined as VoiceSurfaceStorageModuleFactory | undefined,
        text: undefined as VoiceSurfaceModuleFactory | undefined,
        unistyles: undefined as VoiceSurfaceModuleFactory | undefined,
    },
}));

export function installVoiceSurfaceCommonModuleMocks(
    options: InstallVoiceSurfaceCommonModuleMocksOptions = {},
) {
    voiceSurfaceModuleState.options = {
        icons: options.icons,
        reactNative: options.reactNative,
        router: options.router,
        storage: options.storage,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = voiceSurfaceModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('@expo/vector-icons', async () => {
        const activeOptions = voiceSurfaceModuleState.options;
        if (activeOptions.icons) {
            return await activeOptions.icons();
        }

        const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
        return createExpoVectorIconsMock();
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = voiceSurfaceModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = voiceSurfaceModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });

    vi.mock('expo-router', async () => {
        const activeOptions = voiceSurfaceModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock().module;
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = voiceSurfaceModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({});
    });
}
