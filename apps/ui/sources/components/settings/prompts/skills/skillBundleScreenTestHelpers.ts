import { vi } from 'vitest';

type SkillBundleModuleFactory = () => unknown | Promise<unknown>;
type SkillBundleImportOriginal = <T = unknown>() => Promise<T>;
type SkillBundleStorageModuleFactory = (
    importOriginal: SkillBundleImportOriginal,
) => unknown | Promise<unknown>;

type InstallSkillBundleCommonModuleMocksOptions = Readonly<{
    modal?: SkillBundleModuleFactory;
    reactNative?: SkillBundleModuleFactory;
    router?: SkillBundleModuleFactory;
    storage?: SkillBundleStorageModuleFactory;
    text?: SkillBundleModuleFactory;
    unistyles?: SkillBundleModuleFactory;
}>;

const skillBundleModuleState = vi.hoisted(() => ({
    routerBackSpy: vi.fn(),
    routerPushSpy: vi.fn(),
    routerReplaceSpy: vi.fn(),
    options: {
        modal: undefined as SkillBundleModuleFactory | undefined,
        reactNative: undefined as SkillBundleModuleFactory | undefined,
        router: undefined as SkillBundleModuleFactory | undefined,
        storage: undefined as SkillBundleStorageModuleFactory | undefined,
        text: undefined as SkillBundleModuleFactory | undefined,
        unistyles: undefined as SkillBundleModuleFactory | undefined,
    },
}));

export const skillBundleRouterBackSpy = skillBundleModuleState.routerBackSpy;
export const skillBundleRouterPushSpy = skillBundleModuleState.routerPushSpy;
export const skillBundleRouterReplaceSpy = skillBundleModuleState.routerReplaceSpy;

export function resetSkillBundleCommonModuleMockState() {
    skillBundleModuleState.routerBackSpy.mockReset();
    skillBundleModuleState.routerPushSpy.mockReset();
    skillBundleModuleState.routerReplaceSpy.mockReset();
    skillBundleModuleState.options = {
        modal: undefined,
        reactNative: undefined,
        router: undefined,
        storage: undefined,
        text: undefined,
        unistyles: undefined,
    };
}

export function installSkillBundleCommonModuleMocks(
    options: InstallSkillBundleCommonModuleMocksOptions = {},
) {
    skillBundleModuleState.options = {
        modal: options.modal,
        reactNative: options.reactNative,
        router: options.router,
        storage: options.storage,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = skillBundleModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            TextInput: 'TextInput',
            ScrollView: 'ScrollView',
            Platform: {
                OS: 'web',
                select: ({
                    web,
                    default: defaultValue,
                }: {
                    web?: unknown;
                    default?: unknown;
                }) => web ?? defaultValue,
            },
        });
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = skillBundleModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('expo-router', async () => {
        const activeOptions = skillBundleModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: {
                back: skillBundleModuleState.routerBackSpy,
                push: skillBundleModuleState.routerPushSpy,
                replace: skillBundleModuleState.routerReplaceSpy,
            },
            navigation: { canGoBack: () => false },
        }).module;
    });

    vi.mock('@/text', async () => {
        const activeOptions = skillBundleModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    });

    vi.mock('@/modal', async () => {
        const activeOptions = skillBundleModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = skillBundleModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {
            useArtifacts: () => [],
            useAllMachines: () => [],
            useMachineListByServerId: () => ({}),
            useMachineListStatusByServerId: () => ({}),
            useSettingMutable: () => [null, vi.fn()],
        });
    });
}
