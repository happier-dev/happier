import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import {
    enableReactActEnvironment,
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

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

const { routerMock, navigationMock } = vi.hoisted(() => ({
    routerMock: {
        push: vi.fn(),
        back: vi.fn(),
        replace: vi.fn(),
        setParams: vi.fn(),
    },
    navigationMock: {
        dispatch: vi.fn(),
        getState: () => ({
            index: 1,
            routes: [{ key: 'a' }, { key: 'b' }],
        }),
        goBack: vi.fn(),
        setParams: vi.fn(),
    },
}));

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                    Platform: { OS: 'ios' },
                }
    );
});

vi.mock('expo-router', async () => {
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
    };
});

vi.mock('@/modal', async () => {
    return profileSecretRequirementModalMock.module;
});

vi.mock('@/sync/domains/state/storage', async (importOriginal) =>
    (await import('@/dev/testkit/mocks/storage')).createStorageModuleMock({
        importOriginal,
        overrides: {
            useSetting: getProfileSecretRequirementSetting,
            useSettingMutable: useProfileSecretRequirementSettingMutable,
        },
    }));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: React.PropsWithChildren<Record<string, never>>) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: () => null,
}));

vi.mock('@/components/profiles/ProfilesList', async () => {
    return {
        ProfilesList: (props: ProfilesListProps) => {
            captureProfilesListProps({ onPressProfile: props.onPressProfile });
            return null;
        },
    };
});

vi.mock('@/sync/domains/profiles/profileSecrets', () => ({
    getRequiredSecretEnvVarNames: () => [...missingRequiredSecretScenario.secretEnvVarNames],
}));

vi.mock('@/sync/ops', () => ({
    machinePreviewEnv: vi.fn(async () => ({ supported: false })),
}));

vi.mock('@/sync/domains/profiles/profileCompatibility', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/profiles/profileCompatibility')>();
    return {
        ...actual,
        getProfileEnvironmentVariables: () => ({}),
    };
});

vi.mock('@/utils/secrets/secretSatisfaction', () => ({
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

vi.mock('@/hooks/machine/useMachineEnvPresence', () => ({
    useMachineEnvPresence: () => ({ isLoading: false, isPreviewEnvSupported: false, meta: {} }),
}));

vi.mock('@/utils/sessions/tempDataStore', () => ({
    storeTempData: () => 'temp',
    getTempData: () => null,
}));

vi.mock('@/components/secrets/requirements', () => ({
    SecretRequirementModal: () => null,
}));

describe('ProfilePickerScreen (native secret requirement)', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('navigates to the secret requirement screen when required secrets are missing', async () => {
        const ProfilePickerScreen = (await import('@/app/(app)/new/pick/profile')).default;
        resetProfileSecretRequirementHarness();
        routerMock.push.mockClear();
        navigationMock.getState = () => ({
            index: PICKER_NAV_STATE.index,
            routes: PICKER_NAV_STATE.routes.map((route) => ({ key: route.key })),
        });

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
