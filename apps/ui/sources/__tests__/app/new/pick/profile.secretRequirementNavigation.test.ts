import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import {
    createNavigationMock,
    createRouterMock,
    enableReactActEnvironment,
    PICKER_THEME_COLORS,
    PICKER_NAV_STATE,
} from './testHarness';
import {
    captureProfilesListProps,
    createMissingRequiredSecretScenario,
    getCapturedProfilePressHandler,
    getProfileSecretRequirementSetting,
    profileSecretRequirementModalMock,
    resetProfileSecretRequirementHarness,
    useProfileSecretRequirementSettingMutable,
} from './profileSecretRequirementTestHarness';
import type { ProfilesListProps } from '@/components/profiles/ProfilesList';

enableReactActEnvironment();

const missingRequiredSecretScenario = createMissingRequiredSecretScenario();
const routerMock = createRouterMock();
const navigationMock = createNavigationMock();

async function installProfileSecretRequirementModuleMocks() {
    vi.doMock('@expo/vector-icons', async () =>
        (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

    vi.doMock('@/text', async () =>
        (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

    vi.doMock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                            Platform: { OS: 'ios' },
                        }
    );
});

    vi.doMock('react-native-unistyles', async () =>
        (await import('@/dev/testkit')).createUnistylesMock({
            theme: { colors: PICKER_THEME_COLORS },
        }));

    vi.doMock('expo-router', async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const module = createExpoRouterMock({
            navigation: navigationMock,
            params: { selectedId: '', machineId: 'm1' },
            router: {
                push: routerMock.push,
                back: routerMock.back,
                replace: routerMock.replace,
                setParams: routerMock.setParams,
            },
        }).module;

        return {
            ...module,
            useNavigation: () => navigationMock,
            useLocalSearchParams: () => ({ selectedId: '', machineId: 'm1' }),
        };
    });

    vi.doMock('@/modal', async () => profileSecretRequirementModalMock.module);

    vi.doMock('@/sync/domains/state/storage', async () =>
        (await import('@/dev/testkit/mocks/storage')).createStorageModuleStub({
            useSetting: getProfileSecretRequirementSetting,
            useSettingMutable: useProfileSecretRequirementSettingMutable,
        }));

    vi.doMock('@/components/ui/lists/ItemGroup', () => ({
        ItemGroup: ({ children }: React.PropsWithChildren<Record<string, never>>) =>
            React.createElement(React.Fragment, null, children),
    }));

    vi.doMock('@/components/ui/lists/Item', () => ({
        Item: () => null,
    }));

    vi.doMock('@/components/profiles/ProfilesList', () => ({
        ProfilesList: (props: ProfilesListProps) => {
            captureProfilesListProps({ onPressProfile: props.onPressProfile });
            return null;
        },
    }));

    vi.doMock('@/sync/domains/profiles/profileSecrets', () => ({
        getRequiredSecretEnvVarNames: () => [...missingRequiredSecretScenario.secretEnvVarNames],
    }));

    vi.doMock('@/sync/ops', () => ({
        machinePreviewEnv: vi.fn(async () => ({ supported: false })),
    }));

    vi.doMock('@/sync/domains/profiles/profileCompatibility', async (importOriginal) => {
        const actual = await importOriginal<typeof import('@/sync/domains/profiles/profileCompatibility')>();
        return {
            ...actual,
            getProfileEnvironmentVariables: () => ({}),
        };
    });

    vi.doMock('@/utils/secrets/secretSatisfaction', () => ({
        getSecretSatisfaction: () => ({
            isSatisfied: false,
            items: [
                {
                    envVarName: missingRequiredSecretScenario.secretEnvVarName,
                    required: true,
                    isSatisfied: false,
                },
            ],
        }),
    }));

    vi.doMock('@/hooks/machine/useMachineEnvPresence', () => ({
        useMachineEnvPresence: () => ({ isLoading: false, isPreviewEnvSupported: false, meta: {} }),
    }));

    vi.doMock('@/utils/sessions/tempDataStore', () => ({
        storeTempData: () => 'temp',
        getTempData: () => null,
    }));

    vi.doMock('@/components/secrets/requirements', () => ({
        SecretRequirementModal: () => null,
    }));
}

describe('ProfilePickerScreen (native secret requirement)', () => {
    afterEach(() => {
        standardCleanup();
        vi.resetModules();
    });

    it('navigates to the secret requirement screen when required secrets are missing', async () => {
        resetProfileSecretRequirementHarness();
        routerMock.push.mockClear();
        navigationMock.getState = () => ({
            index: PICKER_NAV_STATE.index,
            routes: PICKER_NAV_STATE.routes.map((route) => ({ key: route.key })),
        });

        await installProfileSecretRequirementModuleMocks();

        const ProfilePickerScreen = (await import('@/app/(app)/new/pick/profile')).default;
        await renderScreen(React.createElement(ProfilePickerScreen));

        const onPressProfile = getCapturedProfilePressHandler();

        await act(async () => {
            await onPressProfile(missingRequiredSecretScenario.profile);
        });

        expect(profileSecretRequirementModalMock.spies.show).not.toHaveBeenCalled();
        expect(routerMock.push).toHaveBeenCalledTimes(1);
        expect(routerMock.push).toHaveBeenCalledWith({
            pathname: '/new/pick/secret-requirement',
            params: expect.objectContaining({
                profileId: 'deepseek',
                machineId: 'm1',
                secretEnvVarName: missingRequiredSecretScenario.secretEnvVarName,
                secretEnvVarNames: missingRequiredSecretScenario.secretEnvVarNames.join(','),
                revertOnCancel: '0',
            }),
        });
    });
});
