import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import {
    flushHookEffects,
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
import { settingsDefaults } from '@/sync/domains/settings/settings';
import type { BackendTargetRefV2 } from '@happier-dev/protocol';

enableReactActEnvironment();

const missingRequiredSecretScenario = createMissingRequiredSecretScenario();
const routerMock = createRouterMock();
const navigationMock = createNavigationMock();
const routeParamsState = vi.hoisted(() => ({
    value: {
        selectedId: '',
        dataId: 'draft-1',
        machineId: 'm1',
        agentType: 'customAcp',
        backendTarget: JSON.stringify({ kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' }),
        backendTargetKey: 'backend:review-bot:configured:review-bot',
        spawnServerId: 'server-2',
    } as Record<string, string>,
}));
const settingsState = vi.hoisted(() => ({
    current: {
        lastUsedAgent: 'customAcp',
        lastUsedBackendTarget: null as BackendTargetRefV2 | null,
        backendEnabledByTargetKey: null as Record<string, boolean> | null,
        acpCatalogSettingsV1: null as unknown,
    },
}));
type MachineContributionRegistryProjectionDescribeFn =
    typeof import('@/sync/ops/machineContributionRegistryProjection').machineContributionRegistryProjectionDescribe;
const {
    machineContributionRegistryProjectionDescribe,
} = vi.hoisted(() => ({
    machineContributionRegistryProjectionDescribe: vi.fn<MachineContributionRegistryProjectionDescribeFn>(
        async () => ({ supported: false, reason: 'not-supported' }),
    ),
}));

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
            params: () => routeParamsState.value,
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
            useLocalSearchParams: () => routeParamsState.value,
        };
    });

    vi.doMock('@/modal', async () => profileSecretRequirementModalMock.module);

    vi.doMock('@/sync/domains/state/storage', async () =>
        (await import('@/dev/testkit/mocks/storage')).createStorageModuleStub({
            useSetting: getProfileSecretRequirementSetting,
            useSettingMutable: useProfileSecretRequirementSettingMutable,
            useSettings: () => ({
                ...settingsDefaults,
                lastUsedAgent: settingsState.current.lastUsedAgent,
                lastUsedBackendTarget: settingsState.current.lastUsedBackendTarget,
                backendEnabledByTargetKey:
                    settingsState.current.backendEnabledByTargetKey as typeof settingsDefaults.backendEnabledByTargetKey,
                acpCatalogSettingsV1:
                    settingsState.current.acpCatalogSettingsV1 as typeof settingsDefaults.acpCatalogSettingsV1,
            }),
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
            captureProfilesListProps({
                onPressProfile: props.onPressProfile,
                onEditProfile: props.onEditProfile,
                onAddProfilePress: props.onAddProfilePress,
                onDuplicateProfile: props.onDuplicateProfile,
            });
            return null;
        },
    }));

    vi.doMock('@/sync/domains/profiles/profileSecrets', () => ({
        getRequiredSecretEnvVarNames: () => [...missingRequiredSecretScenario.secretEnvVarNames],
    }));

    vi.doMock('@/sync/ops', () => ({
        machinePreviewEnv: vi.fn(async () => ({ supported: false })),
    }));

    vi.doMock('@/sync/ops/machineContributionRegistryProjection', () => ({
        getMachineContributionRegistryProjectionRevision: () => 0,
        subscribeMachineContributionRegistryProjectionInvalidation: () => () => {},
        machineContributionRegistryProjectionDescribe: (...args: Parameters<MachineContributionRegistryProjectionDescribeFn>) =>
            machineContributionRegistryProjectionDescribe(...args),
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
        routeParamsState.value = {
            selectedId: '',
            dataId: 'draft-1',
            machineId: 'm1',
            agentType: 'customAcp',
            backendTarget: JSON.stringify({ kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' }),
            backendTargetKey: 'backend:review-bot:configured:review-bot',
            spawnServerId: 'server-2',
        };
        settingsState.current = {
            lastUsedAgent: 'customAcp',
            lastUsedBackendTarget: null,
            backendEnabledByTargetKey: null,
            acpCatalogSettingsV1: null,
        };

        resetProfileSecretRequirementHarness();
        routerMock.push.mockClear();
        machineContributionRegistryProjectionDescribe.mockReset();
        machineContributionRegistryProjectionDescribe.mockResolvedValue({ supported: false, reason: 'not-supported' });
        navigationMock.getState = () => ({
            index: PICKER_NAV_STATE.index,
            routes: PICKER_NAV_STATE.routes.map((route) => ({ key: route.key })),
        });

        await installProfileSecretRequirementModuleMocks();

        const ProfilePickerScreen = (await import('@/app/(app)/new/pick/profile')).default;
        await renderScreen(React.createElement(ProfilePickerScreen));
        await flushHookEffects({ cycles: 1, turns: 2 });

        const onPressProfile = getCapturedProfilePressHandler();

        await act(async () => {
            await onPressProfile(missingRequiredSecretScenario.profile);
        });

        expect(profileSecretRequirementModalMock.spies.show).not.toHaveBeenCalled();
        expect(routerMock.push).toHaveBeenCalledTimes(1);
        expect(routerMock.push).toHaveBeenCalledWith({
            pathname: '/new/pick/secret-requirement',
            params: expect.objectContaining({
                backendTarget: expect.stringContaining('"review-bot"'),
                backendTargetKey: expect.stringContaining('review-bot'),
                dataId: 'draft-1',
                profileId: 'deepseek',
                machineId: 'm1',
                secretEnvVarName: missingRequiredSecretScenario.secretEnvVarName,
                secretEnvVarNames: missingRequiredSecretScenario.secretEnvVarNames.join(','),
                revertOnCancel: '0',
                spawnServerId: 'server-2',
            }),
        });
    });

    it('rehydrates configured backend params for secret requirement navigation when the route only carries legacy customAcp', async () => {
        routeParamsState.value = {
            selectedId: '',
            dataId: 'draft-1',
            machineId: 'm1',
            agentType: 'customAcp',
            spawnServerId: 'server-2',
        };
        settingsState.current = {
            lastUsedAgent: 'customAcp',
            lastUsedBackendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot', sourceKind: 'configured' },
            backendEnabledByTargetKey: null,
            acpCatalogSettingsV1: {
                v: 2,
                backends: [
                    {
                        id: 'review-bot',
                        name: 'review-bot',
                        title: 'Review Bot',
                        command: 'custom-acp',
                        args: ['serve'],
                        env: {},
                        transportProfile: 'generic',
                        capabilities: {
                            supportsLoadSession: false,
                            supportsModes: 'unknown',
                            supportsModels: 'unknown',
                            supportsConfigOptions: 'unknown',
                            promptImageSupport: 'unknown',
                        },
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
            },
        };

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

        expect(routerMock.push).toHaveBeenCalledWith({
            pathname: '/new/pick/secret-requirement',
            params: expect.objectContaining({
                backendTarget: expect.stringContaining('"configuredBackendId":"review-bot"'),
                backendTargetKey: 'backend:review-bot:configured:review-bot',
                dataId: 'draft-1',
                machineId: 'm1',
                spawnServerId: 'server-2',
            }),
        });
    });

    it('falls back to the preferred built-in target when route params only carry legacy customAcp and no explicit backend target is stored', async () => {
        routeParamsState.value = {
            selectedId: '',
            dataId: 'draft-1',
            machineId: 'm1',
            agentType: 'customAcp',
            spawnServerId: 'server-2',
        };
        settingsState.current = {
            lastUsedAgent: 'customAcp',
            lastUsedBackendTarget: null,
            backendEnabledByTargetKey: null,
            acpCatalogSettingsV1: null,
        };
        machineContributionRegistryProjectionDescribe.mockReset();
        machineContributionRegistryProjectionDescribe.mockResolvedValue({
            supported: true,
            projection: {
                v: 1,
                agentsById: {
                    'acme.review.provider': {
                        id: 'acme.review.provider',
                        title: 'Acme Review Provider',
                        channel: 'plugin',
                        isBuiltIn: false,
                        settingsBackendId: 'acme.review.backend',
                    },
                },
                backendsById: {
                    'acme.review.backend': {
                        id: 'acme.review.backend',
                        backendId: 'acme.review.backend',
                        agentId: 'acme.review.provider',
                        title: 'Acme Review Backend',
                    },
                },
            },
        });

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

        expect(machineContributionRegistryProjectionDescribe).toHaveBeenCalledWith('m1', expect.objectContaining({
            serverId: 'server-2',
            timeoutMs: 10_000,
        }));
        expect(routerMock.push).toHaveBeenCalledWith({
            pathname: '/new/pick/secret-requirement',
            params: expect.objectContaining({
                agentType: 'claude',
                backendTarget: JSON.stringify({ kind: 'backend', backendId: 'claude' }),
                backendTargetKey: 'backend:claude',
                dataId: 'draft-1',
                machineId: 'm1',
                spawnServerId: 'server-2',
            }),
        });
    });
});
