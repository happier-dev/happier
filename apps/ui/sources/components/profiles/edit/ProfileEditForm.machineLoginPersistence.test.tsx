import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { AIBackendProfileSchema, type AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { buildBackendTargetKey } from '@happier-dev/protocol';
import { renderScreen } from '@/dev/testkit';
import {
    installProfileEditFormModuleMocks,
    resetProfileEditFormTestState,
} from './profileEditFormTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

resetProfileEditFormTestState();
installProfileEditFormModuleMocks({
    storageModule: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSetting: () => ({}),
            useAllMachines: () => [],
            useMachine: () => null,
            useSettings: () => settingsState,
            useSettingMutable: () => [{}, vi.fn()] as const,
        });
    },
});

vi.doMock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        rt: { themeName: 'light' },
    });
});

vi.doMock('@/hooks/auth/useCLIDetection', () => ({
    useCLIDetection: () => ({ status: 'unknown', login: { codex: false, customAcp: false } }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

const settingsState = {
    acpCatalogSettingsV1: {
        v: 2 as const,
        backends: [
            {
                id: 'custom-backend',
                name: 'custom-backend',
                title: 'Custom Backend',
                command: 'custom-acp',
                args: ['serve'],
                env: {},
                createdAt: 1,
                updatedAt: 1,
            },
        ],
    },
};

vi.mock('@/components/profiles/environmentVariables/EnvironmentVariablesList', () => ({
    EnvironmentVariablesList: () => null,
}));

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => ['codex', 'customAcp'],
}));

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['codex', 'customAcp'],
    DEFAULT_AGENT_ID: 'codex',
    getAgentCore: (agentId: string) => ({
        permissions: { modeGroup: 'codexLike' },
        // Both targets share the same machine-login key; this is the scenario that used to save an ambiguous profile.
        cli: { machineLoginKey: 'codex' },
        ui: { agentPickerIconName: 'terminal-outline' },
        sessionStorage: { direct: false },
        displayNameKey: agentId === 'customAcp' ? 'agent.customAcp' : 'agent.codex',
        subtitleKey: 'profiles.aiBackend.subtitle',
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
    Item: ({ title, onPress }: { title?: string; onPress?: () => void }) => React.createElement('Item', { title, onPress }),
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

function buildProfile(): AIBackendProfile {
    return AIBackendProfileSchema.parse({
        id: 'p1',
        name: 'P',
        environmentVariables: [],
        defaultPermissionModeByAgent: {},
        defaultPermissionModeByTargetKey: {},
        defaultPersistenceModeByAgent: {},
        defaultPersistenceModeByTargetKey: {},
        compatibility: { codex: true, customAcp: true },
        compatibilityByTargetKey: {
            [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' })]: true,
            [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'customAcp' })]: true,
        },
        authMode: 'machineLogin',
        envVarRequirements: [],
        isBuiltIn: false,
        createdAt: 0,
        updatedAt: 0,
        version: '1.0.0',
    });
}

describe('ProfileEditForm machine-login persistence', () => {
    it('clears machine-login persistence when multiple compatible targets share a machine-login key', async () => {
        const { ProfileEditForm } = await import('./ProfileEditForm');
        const saveRef = { current: null as null | (() => boolean) };
        const onSave = vi.fn((_: AIBackendProfile) => true);
        const legacyCustomAcpTargetKey = buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'customAcp' });
        const configuredTargetKey = buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'custom-backend' });

        await renderScreen(React.createElement(ProfileEditForm, {
                    profile: buildProfile(),
                    machineId: null,
                    onSave,
                    onCancel: vi.fn(),
                    saveRef,
                }));

        const result = saveRef.current?.();
        expect(result).toBe(true);
        expect(onSave).toHaveBeenCalledTimes(1);
        const savedProfile = onSave.mock.calls[0]?.[0] as AIBackendProfile | undefined;
        expect(savedProfile).toEqual(expect.objectContaining({
            authMode: undefined,
            requiresMachineLoginTargetKey: undefined,
        }));
        expect(savedProfile?.compatibilityByTargetKey).toEqual(expect.objectContaining({
            [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' })]: true,
            [configuredTargetKey]: true,
        }));
        expect(savedProfile?.compatibilityByTargetKey?.[legacyCustomAcpTargetKey]).toBeUndefined();
    });
});
