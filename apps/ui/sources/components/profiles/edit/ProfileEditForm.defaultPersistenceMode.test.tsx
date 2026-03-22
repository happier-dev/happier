import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { AIBackendProfileSchema, type AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { buildBackendTargetKey } from '@happier-dev/protocol';
import { ProfileEditForm } from './ProfileEditForm';
import type { ProfileEditFormProps } from './ProfileEditForm';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionTypeSelectorSpy = vi.hoisted(() => vi.fn(() => null));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const expoRouterMock = createExpoRouterMock({
        router: { push: vi.fn() },
        params: {},
    });
    return expoRouterMock.module;
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            show: vi.fn(),
            alert: vi.fn(),
        },
    }).module;
});

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureId === 'sessions.direct',
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    useSetting: (key: string) => {
        if (key === 'newSessionDefaultPersistenceModeV1') return 'persisted';
        if (key === 'newSessionDefaultPersistenceModeByTargetKeyV1') return {};
        return {};
    },
    useAllMachines: () => [],
    useMachine: () => null,
    useSettings: () => ({ opencodeBackendMode: 'server' }),
    useSettingMutable: (key: string) => {
        if (key === 'favoriteMachines') return [[], vi.fn()] as const;
        if (key === 'secrets') return [[], vi.fn()] as const;
        if (key === 'secretBindingsByProfileId') return [{}, vi.fn()] as const;
        return [[], vi.fn()] as const;
    },
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

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => ['codex'],
}));

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['codex'],
    DEFAULT_AGENT_ID: 'codex',
    getAgentCore: () => ({
        sessionStorage: { direct: true, persisted: true },
        permissions: { modeGroup: 'codexLike' },
        cli: { machineLoginKey: 'codex' },
        ui: { agentPickerIconName: 'terminal-outline' },
        displayNameKey: 'agent.codex',
    }),
    getAgentBehavior: () => ({
        newSession: {
            supportsTranscriptStorageMode: () => true,
        },
    }),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: () => null,
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: () => null,
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

function buildProfile(overrides: Record<string, unknown> = {}): AIBackendProfile {
    return AIBackendProfileSchema.parse({
        id: 'p1',
        name: 'P',
        environmentVariables: [],
        defaultPermissionModeByAgent: {},
        defaultPermissionModeByTargetKey: {},
        defaultPersistenceModeByAgent: { codex: 'direct' },
        defaultPersistenceModeByTargetKey: {},
        compatibility: { codex: true, claude: true, gemini: true },
        compatibilityByTargetKey: {
            'agent:codex': true,
            'agent:claude': true,
            'agent:gemini': true,
        },
        envVarRequirements: [],
        isBuiltIn: false,
        createdAt: 0,
        updatedAt: 0,
        version: '1.0.0',
        ...overrides,
    });
}

describe('ProfileEditForm default persistence mode', () => {
    it('does not render the legacy default session type control anymore', async () => {
        sessionTypeSelectorSpy.mockClear();

        await renderScreen(React.createElement(ProfileEditForm, {
                    profile: buildProfile(),
                    machineId: null,
                    onSave: vi.fn(() => true),
                    onCancel: vi.fn(),
                    saveRef: { current: null },
                }));

        expect(sessionTypeSelectorSpy).not.toHaveBeenCalled();
    });

    it('persists built-in transcript storage defaults only in canonical target-keyed form when saving', async () => {
        const saveRef = { current: null as null | (() => boolean) };
        const onSave = vi.fn<ProfileEditFormProps['onSave']>(() => true);

        await renderScreen(React.createElement(ProfileEditForm, {
                    profile: buildProfile({
                        defaultPersistenceModeByAgent: {},
                        defaultPersistenceModeByTargetKey: { 'agent:codex': 'direct' },
                    }),
                    machineId: null,
                    onSave,
                    onCancel: vi.fn(),
                    saveRef,
                }));

        expect(saveRef.current).toBeTruthy();
        const result = saveRef.current?.();
        expect(result).toBe(true);
        expect(onSave).toHaveBeenCalledTimes(1);
        const saved = onSave.mock.calls[0]?.[0];
        expect(saved).toBeTruthy();
        expect(saved).toEqual(expect.objectContaining({
            defaultPersistenceModeByTargetKey: { 'agent:codex': 'direct' },
        }));
        expect(saved!.defaultPersistenceModeByAgent).toEqual({});
    });

    it('preserves canonical target-keyed compatibility and defaults when saving', async () => {
        const saveRef = { current: null as null | (() => boolean) };
        const onSave = vi.fn<ProfileEditFormProps['onSave']>(() => true);

        await renderScreen(React.createElement(ProfileEditForm, {
                    profile: buildProfile({
                        defaultPermissionModeByTargetKey: {
                            'agent:codex': 'read-only',
                            [buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'custom-preset' })]: 'safe-yolo',
                        },
                        defaultPersistenceModeByTargetKey: {
                            'agent:codex': 'direct',
                            [buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'custom-preset' })]: 'persisted',
                        },
                        compatibilityByTargetKey: {
                            'agent:codex': true,
                            [buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'custom-preset' })]: true,
                        },
                    }),
                    machineId: null,
                    onSave,
                    onCancel: vi.fn(),
                    saveRef,
                }));

        expect(saveRef.current).toBeTruthy();
        const result = saveRef.current?.();
        expect(result).toBe(true);
        expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
            compatibilityByTargetKey: {
                'agent:codex': true,
                [buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'custom-preset' })]: true,
            },
            defaultPermissionModeByTargetKey: {
                'agent:codex': 'read-only',
                [buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'custom-preset' })]: 'safe-yolo',
            },
            defaultPersistenceModeByTargetKey: {
                'agent:codex': 'direct',
                [buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'custom-preset' })]: 'persisted',
            },
        }));
    });

    it('does not mirror canonical built-in defaults back into legacy profile fields on save', async () => {
        const saveRef = { current: null as null | (() => boolean) };
        const onSave = vi.fn<ProfileEditFormProps['onSave']>(() => true);

        await renderScreen(React.createElement(ProfileEditForm, {
                    profile: buildProfile({
                        defaultPermissionModeByAgent: {},
                        defaultPersistenceModeByAgent: {},
                        compatibility: {},
                        defaultPermissionModeByTargetKey: {
                            [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' })]: 'read-only',
                        },
                        defaultPersistenceModeByTargetKey: {
                            [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' })]: 'direct',
                        },
                        compatibilityByTargetKey: {
                            [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' })]: true,
                        },
                    }),
                    machineId: null,
                    onSave,
                    onCancel: vi.fn(),
                    saveRef,
                }));

        expect(saveRef.current).toBeTruthy();
        const result = saveRef.current?.();
        expect(result).toBe(true);
        expect(onSave).toHaveBeenCalledTimes(1);
        const saved = onSave.mock.calls[0]?.[0];
        expect(saved).toBeTruthy();
        expect(saved).toEqual(expect.objectContaining({
            compatibility: {},
            compatibilityByTargetKey: {
                [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' })]: true,
            },
            defaultPermissionModeByTargetKey: {
                [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' })]: 'read-only',
            },
            defaultPersistenceModeByTargetKey: {
                [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' })]: 'direct',
            },
        }));
        expect(saved!.defaultPermissionModeByAgent).toEqual({});
        expect(saved!.defaultPersistenceModeByAgent).toEqual({});
        expect(saved!.requiresMachineLogin).toBeUndefined();
        expect('defaultSessionType' in saved!).toBe(false);
    });
});
