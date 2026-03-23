import React from 'react';
import { vi } from 'vitest';

type ModuleFactory = () => unknown | Promise<unknown>;

type InstallProfileEditFormModuleMocksOptions = Readonly<{
    reactNative?: ModuleFactory;
    storageModule?: ModuleFactory;
}>;

const profileEditFormTestState = vi.hoisted(() => ({
    routerPushSpy: vi.fn(),
    routerBackSpy: vi.fn(),
    routerReplaceSpy: vi.fn(),
    routerSetParamsSpy: vi.fn(),
    navigationSetOptionsSpy: vi.fn(),
    modalShowSpy: vi.fn(),
    modalAlertSpy: vi.fn(),
    options: {
        reactNative: undefined as ModuleFactory | undefined,
        storageModule: undefined as ModuleFactory | undefined,
    },
}));

export function resetProfileEditFormTestState() {
    profileEditFormTestState.routerPushSpy.mockReset();
    profileEditFormTestState.routerBackSpy.mockReset();
    profileEditFormTestState.routerReplaceSpy.mockReset();
    profileEditFormTestState.routerSetParamsSpy.mockReset();
    profileEditFormTestState.navigationSetOptionsSpy.mockReset();
    profileEditFormTestState.modalShowSpy.mockReset();
    profileEditFormTestState.modalAlertSpy.mockReset();
    profileEditFormTestState.options = {
        reactNative: undefined,
        storageModule: undefined,
    };
}

export function installProfileEditFormModuleMocks(
    options: InstallProfileEditFormModuleMocksOptions = {},
) {
    profileEditFormTestState.options = {
        reactNative: options.reactNative,
        storageModule: options.storageModule,
    };

    vi.mock('@/text', async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });

    vi.mock('react-native', async () => {
        if (profileEditFormTestState.options.reactNative) {
            return await profileEditFormTestState.options.reactNative();
        }
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('expo-router', async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: {
                push: profileEditFormTestState.routerPushSpy,
                back: profileEditFormTestState.routerBackSpy,
                replace: profileEditFormTestState.routerReplaceSpy,
                setParams: profileEditFormTestState.routerSetParamsSpy,
            },
            navigation: {
                setOptions: profileEditFormTestState.navigationSetOptionsSpy,
            },
            params: {},
        }).module;
    });

    vi.mock('react-native-unistyles', async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@expo/vector-icons', async () => {
        const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
        return createExpoVectorIconsMock();
    });

    vi.mock('@/modal', async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                show: (...args: unknown[]) => profileEditFormTestState.modalShowSpy(...args),
                alert: (...args: unknown[]) => profileEditFormTestState.modalAlertSpy(...args),
            },
        }).module;
    });

    vi.mock('@/sync/domains/state/storage', async () => {
        if (profileEditFormTestState.options.storageModule) {
            return await profileEditFormTestState.options.storageModule();
        }
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSetting: () => ({}),
            useSettings: () => ({}),
            useAllMachines: () => [],
            useMachine: () => null,
            useSettingMutable: () => [[], vi.fn()] as const,
        });
    });

    vi.mock('@/components/sessions/new/components/MachineSelector', () => ({
        MachineSelector: () => null,
    }));

    vi.mock('@/hooks/auth/useCLIDetection', () => ({
        useCLIDetection: () => ({ status: 'unknown' }),
    }));

    vi.mock('@/components/profiles/environmentVariables/EnvironmentVariablesList', () => ({
        EnvironmentVariablesList: () => null,
    }));

    vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
        DropdownMenu: () => null,
    }));

    vi.mock('@/components/ui/lists/ItemList', () => ({
        ItemList: ({ children }: { children?: React.ReactNode }) =>
            React.createElement(React.Fragment, null, children),
    }));

    vi.mock('@/components/ui/lists/ItemGroup', () => ({
        ItemGroup: ({ children }: { children?: React.ReactNode }) =>
            React.createElement(React.Fragment, null, children),
    }));

    vi.mock('@/components/ui/forms/Switch', () => ({
        Switch: () => null,
    }));

    vi.mock('@/utils/sessions/machineUtils', () => ({
        isMachineOnline: () => true,
    }));

    vi.mock('@/sync/domains/profiles/profileUtils', () => ({
        getBuiltInProfileDocumentation: () => null,
    }));

    vi.mock('@/sync/domains/permissions/permissionTypes', () => ({
        normalizeProfileDefaultPermissionMode: <T,>(value: T) => value,
    }));

    vi.mock('@/sync/domains/permissions/permissionModeOptions', () => ({
        getPermissionModeLabelForAgentType: () => '',
        getPermissionModeOptionsForAgentType: () => [],
        normalizePermissionModeForAgentType: <T,>(value: T) => value,
    }));

    vi.mock('@/components/ui/layout/layout', () => ({
        layout: { maxWidth: 900 },
    }));

    vi.mock('@/utils/profiles/envVarTemplate', () => ({
        parseEnvVarTemplate: () => ({ variables: [] }),
    }));

    vi.mock('@/components/secrets/requirements', () => ({
        SecretRequirementModal: () => null,
    }));
}

export { profileEditFormTestState };
