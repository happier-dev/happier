import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import type { AiLaunchProfile } from '@happier-dev/protocol';
import { createEmptyCustomProfile } from '@/sync/domains/profiles/profileMutations';
import {
    createNavigationMock,
    createRouterMock,
    enableReactActEnvironment,
    installPickerCommonModuleMocks,
    parseJsonRouteParam,
    PICKER_NAV_STATE,
    PICKER_THEME_COLORS,
} from './testHarness';
import { createUseSettingMutableMockFromReader } from '@/dev/testkit/mocks/storage';

enableReactActEnvironment();

const routerMock = createRouterMock();
const navigationMock = createNavigationMock() as ReturnType<typeof createNavigationMock> & {
    setOptions: ReturnType<typeof vi.fn>;
    addListener: ReturnType<typeof vi.fn>;
};
navigationMock.setOptions = vi.fn();
navigationMock.addListener = vi.fn(() => ({ remove: vi.fn() }));
const capturedFormPropsRef = { current: null as any };
const routeParamsState = vi.hoisted(() => ({
    current: {
        profileData: JSON.stringify({
            id: 'new',
            name: '',
            isBuiltIn: false,
            compatibility: { claude: true, codex: true, gemini: true },
        }),
        machineId: 'machine-2',
        dataId: 'draft-1',
        agentType: 'customAcp',
        spawnServerId: 'server-2',
    } as Record<string, string>,
}));
const settingsState = vi.hoisted(() => ({
    current: {
        lastUsedAgent: 'customAcp',
        lastUsedBackendTarget: null as unknown,
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

installPickerCommonModuleMocks({
    reactNative: async () =>
        (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
            Platform: { OS: 'ios' },
            useWindowDimensions: () => ({ width: 390, height: 844 }),
            KeyboardAvoidingView: (props: any) => React.createElement('KeyboardAvoidingView', props, props.children),
        }),
    expoRouter: async () =>
        ({
            ...(await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
                navigation: navigationMock,
                params: () => routeParamsState.current,
                router: {
                    push: routerMock.push,
                    back: routerMock.back,
                    replace: routerMock.replace,
                    setParams: routerMock.setParams,
                },
            }).module,
            useNavigation: () => navigationMock,
        }),
    unistyles: async () =>
        (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock({
            theme: {
                colors: {
                    background: PICKER_THEME_COLORS.background,
                    chrome: PICKER_THEME_COLORS.chrome,
                },
            },
            runtime: { insets: { bottom: 0 } },
        }),
    text: async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
    storage: async (importOriginal) =>
        (await import('@/dev/testkit/mocks/storage')).createStorageModuleMock({
            importOriginal,
            overrides: {
                useSettingMutable: createUseSettingMutableMockFromReader((key) => {
                    if (key === 'profiles') {
                        return [[], vi.fn()];
                    }
                    return [null, vi.fn()];
                }),
                useSettings: () => ({
                    ...settingsDefaults,
                    lastUsedAgent: settingsState.current.lastUsedAgent,
                    lastUsedBackendTarget:
                        settingsState.current.lastUsedBackendTarget as unknown as typeof settingsDefaults.lastUsedBackendTarget,
                    backendEnabledByTargetKey:
                        settingsState.current.backendEnabledByTargetKey as unknown as typeof settingsDefaults.backendEnabledByTargetKey,
                    acpCatalogSettingsV1:
                        settingsState.current.acpCatalogSettingsV1 as unknown as typeof settingsDefaults.acpCatalogSettingsV1,
                }),
            },
        }),
    modal: async () =>
        (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
            spies: {
                alert: vi.fn(),
                show: vi.fn(),
            },
        }).module,
});

vi.mock('@/components/profiles/edit', () => ({
    LaunchProfileEditForm: (props: any) => {
        capturedFormPropsRef.current = props;
        return React.createElement('ProfileEditForm');
    },
}));

vi.mock('expo-constants', () => ({
    default: { statusBarHeight: 0 },
}));

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@react-navigation/elements', () => ({
    useHeaderHeight: () => 0,
}));
vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 1024 },
    useLayoutMaxWidth: () => 1024,
    useLayoutMaxWidthStyle: () => ({ maxWidth: 1024 }),
}));
vi.mock('@/sync/domains/profiles/profileUtils', () => ({
    DEFAULT_PROFILES: [],
    getBuiltInProfile: () => null,
    getBuiltInProfileNameKey: () => null,
    resolveProfileById: () => null,
}));
vi.mock('@/sync/domains/profiles/profileMutations', () => ({
    convertBuiltInProfileToCustom: <T,>(profile: T) => profile,
    createEmptyCustomProfile: () => ({ id: 'new', name: '', isBuiltIn: false, compatibility: { claude: true, codex: true, gemini: true } }),
    duplicateProfileForEdit: <T,>(profile: T) => profile,
}));
vi.mock('@/utils/ui/promptUnsavedChangesAlert', () => ({
    promptUnsavedChangesAlert: vi.fn(async () => 'keep'),
}));
vi.mock('@/components/ui/keyboardAvoidance', () => ({
    KeyboardAwareScreen: ({ children, ...props }: any) =>
        React.createElement('KeyboardAwareScreen', props, children),
}));
vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
    machineContributionRegistryProjectionDescribe: (...args: Parameters<MachineContributionRegistryProjectionDescribeFn>) =>
        machineContributionRegistryProjectionDescribe(...args),
    getMachineContributionRegistryProjectionRevision: () => 0,
    subscribeMachineContributionRegistryProjectionInvalidation: () => () => {},
    machinePluginSecretStatus: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSecretSet: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSecretDelete: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
}));

describe('ProfileEditScreen replace fallback', () => {
    beforeEach(() => {
        capturedFormPropsRef.current = null;
        routeParamsState.current = {
            profileData: JSON.stringify({
                id: 'new',
                name: '',
                isBuiltIn: false,
                compatibility: { claude: true, codex: true, gemini: true },
            }),
            machineId: 'machine-2',
            dataId: 'draft-1',
            agentType: 'customAcp',
            spawnServerId: 'server-2',
        };
        settingsState.current = {
            lastUsedAgent: 'customAcp',
            lastUsedBackendTarget: null,
            backendEnabledByTargetKey: null,
            acpCatalogSettingsV1: null,
        };
        routerMock.replace.mockClear();
        routerMock.push.mockClear();
        routerMock.back.mockClear();
        routerMock.setParams.mockClear();
        navigationMock.dispatch.mockClear();
        navigationMock.goBack.mockClear();
        navigationMock.setParams.mockClear();
        navigationMock.getState = vi.fn(() => ({
            index: PICKER_NAV_STATE.index,
            routes: PICKER_NAV_STATE.routes.map((route) => ({ key: route.key })),
        }));
        machineContributionRegistryProjectionDescribe.mockReset();
        machineContributionRegistryProjectionDescribe.mockResolvedValue({ supported: false, reason: 'not-supported' });
    });

    afterEach(() => {
        standardCleanup();
    });

    it('falls back to the preferred built-in target when route params only carry legacy customAcp even when merged projection lists discovered plugin backends', async () => {
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

        const ProfileEditScreen = (await import('@/app/(app)/new/pick/profile-edit')).default;
        await act(async () => {
            await renderScreen(React.createElement(ProfileEditScreen));
        });
        await flushHookEffects({ cycles: 1, turns: 2 });

        const onSave = capturedFormPropsRef.current?.onSave as ((profile: AiLaunchProfile) => boolean) | undefined;
        expect(typeof onSave).toBe('function');

        let saved: boolean | undefined;
        await act(async () => {
            saved = onSave?.({
                ...createEmptyCustomProfile(),
                id: 'profile-new',
                name: 'New Profile',
            } satisfies AiLaunchProfile);
        });
        expect(saved).toBe(true);

        expect(machineContributionRegistryProjectionDescribe).toHaveBeenCalledWith('machine-2', expect.objectContaining({
            serverId: 'server-2',
            timeoutMs: 10_000,
        }));
        expect(routerMock.replace).toHaveBeenCalledTimes(1);
        const [call] = routerMock.replace.mock.calls;
        const args = call?.[0] as any;

        expect(args).toEqual(expect.objectContaining({
            pathname: '/new',
            params: expect.objectContaining({
                agentType: 'claude',
                backendTargetKey: 'backend:claude',
                dataId: 'draft-1',
                machineId: 'machine-2',
                profileId: 'profile-new',
                spawnServerId: 'server-2',
            }),
        }));

        const backendTarget = parseJsonRouteParam(args?.params?.backendTarget) as any;
        expect(backendTarget).toMatchObject({ kind: 'backend', backendId: 'claude' });
    });
});
