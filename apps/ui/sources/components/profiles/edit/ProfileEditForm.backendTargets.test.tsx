import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { AIBackendProfileSchema, type AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { buildBackendTargetKey } from '@happier-dev/protocol';
import { ProfileEditForm } from './ProfileEditForm';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('react-native', async () => await import('@/dev/reactNativeStub'));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: vi.fn() }),
    useLocalSearchParams: () => ({}),
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                header: { tint: '#000' },
                textSecondary: '#666',
                button: { secondary: { tint: '#000' }, primary: { background: '#00f' } },
                surface: '#fff',
                text: '#000',
                status: { connected: '#0f0', disconnected: '#f00' },
                input: { placeholder: '#999' },
            },
        },
        rt: { themeName: 'light' },
    }),
    StyleSheet: { create: () => ({}) },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/modal', () => ({
    Modal: {
        show: vi.fn(),
        alert: vi.fn(),
    },
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureId === 'sessions.direct',
}));

const settingsState = {
    opencodeBackendMode: 'server',
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

vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => {
        if (key === 'newSessionDefaultPersistenceModeV1') return 'persisted';
        if (key === 'newSessionDefaultPersistenceModeByTargetKeyV1') return {};
        if (key === 'sessionDefaultPermissionModeByTargetKey') return {};
        return (settingsState as any)[key] ?? {};
    },
    useAllMachines: () => [],
    useMachine: () => null,
    useSettings: () => settingsState,
    useSettingMutable: (key: string) => {
        if (key === 'favoriteMachines') return [[], vi.fn()] as const;
        if (key === 'secrets') return [[], vi.fn()] as const;
        if (key === 'secretBindingsByProfileId') return [{}, vi.fn()] as const;
        return [[], vi.fn()] as const;
    },
}));

vi.mock('@/components/sessions/new/components/MachineSelector', () => ({
    MachineSelector: () => null,
}));

vi.mock('@/hooks/auth/useCLIDetection', () => ({
    useCLIDetection: () => ({ status: 'unknown', login: { codex: false, customAcp: false } }),
}));

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
        cli: { machineLoginKey: agentId === 'customAcp' ? 'customAcp' : 'codex' },
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
    Item: ({ title, onPress }: any) => React.createElement('Item', { title, onPress }),
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
        compatibility: { codex: true, customAcp: false },
        compatibilityByTargetKey: {
            [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' })]: true,
        },
        envVarRequirements: [],
        isBuiltIn: false,
        createdAt: 0,
        updatedAt: 0,
        version: '1.0.0',
    });
}

describe('ProfileEditForm backend targets', () => {
    it('renders configured ACP backends as editable backend rows and persists target compatibility changes', async () => {
        const saveRef = { current: null as null | (() => boolean) };
        const onSave = vi.fn((_: AIBackendProfile) => true);

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                React.createElement(ProfileEditForm, {
                    profile: buildProfile(),
                    machineId: null,
                    onSave,
                    onCancel: vi.fn(),
                    saveRef,
                }),
            );
        });

        const backendRow = tree.root.findAll((node) => node.props?.title === 'Custom Backend')[0];
        expect(backendRow).toBeTruthy();

        await act(async () => {
            backendRow.props.onPress();
        });

        const result = saveRef.current?.();
        expect(result).toBe(true);
        expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
            compatibilityByTargetKey: expect.objectContaining({
                [buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'custom-backend' })]: true,
            }),
        }));
    });

    it('persists canonical machine-login target when exactly one backend target is compatible', async () => {
        const saveRef = { current: null as null | (() => boolean) };
        const onSave = vi.fn((_: AIBackendProfile) => true);

        await act(async () => {
            renderer.create(
                React.createElement(ProfileEditForm, {
                    profile: AIBackendProfileSchema.parse({
                        ...buildProfile(),
                        authMode: 'machineLogin',
                        compatibility: { codex: false, customAcp: false },
                        compatibilityByTargetKey: {
                            [buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'custom-backend' })]: true,
                        },
                    }),
                    machineId: null,
                    onSave,
                    onCancel: vi.fn(),
                    saveRef,
                }),
            );
        });

        const result = saveRef.current?.();
        expect(result).toBe(true);
        expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
            authMode: 'machineLogin',
            requiresMachineLoginTargetKey: buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'custom-backend' }),
            requiresMachineLogin: undefined,
        }));
    });

    it('migrates legacy custom ACP compatibility onto the canonical configured backend target on save', async () => {
        const saveRef = { current: null as null | (() => boolean) };
        const onSave = vi.fn((_: AIBackendProfile) => true);
        const legacyCustomAcpTargetKey = buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'customAcp' });
        const configuredTargetKey = buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'custom-backend' });

        await act(async () => {
            renderer.create(
                React.createElement(ProfileEditForm, {
                    profile: AIBackendProfileSchema.parse({
                        ...buildProfile(),
                        compatibility: { codex: false, customAcp: true },
                        compatibilityByTargetKey: {
                            [legacyCustomAcpTargetKey]: true,
                        },
                        authMode: 'machineLogin',
                    }),
                    machineId: null,
                    onSave,
                    onCancel: vi.fn(),
                    saveRef,
                }),
            );
        });

        const result = saveRef.current?.();
        expect(result).toBe(true);
        expect(onSave).toHaveBeenCalledTimes(1);
        const savedProfile = onSave.mock.calls[0]?.[0] as AIBackendProfile | undefined;
        expect(savedProfile).toEqual(expect.objectContaining({
            authMode: 'machineLogin',
            requiresMachineLoginTargetKey: configuredTargetKey,
        }));
        expect(savedProfile?.compatibilityByTargetKey).toEqual(expect.objectContaining({
            [configuredTargetKey]: true,
        }));
        expect(savedProfile?.compatibilityByTargetKey?.[legacyCustomAcpTargetKey]).toBeUndefined();
    });

});
