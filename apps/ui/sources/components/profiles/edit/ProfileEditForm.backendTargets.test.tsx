import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { AIBackendProfileSchema, type AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { buildBackendTargetKey } from '@happier-dev/protocol';
import { renderScreen } from '@/dev/testkit';
import {
    installProfileEditFormModuleMocks,
    resetProfileEditFormTestState,
} from './profileEditFormTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

resetProfileEditFormTestState();

const capture = vi.hoisted(() => ({
    customBackendPress: null as null | (() => void),
    reset() {
        this.customBackendPress = null;
    },
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

installProfileEditFormModuleMocks({
    storageModule: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
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
        });
    },
});

async function loadProfileEditForm() {
    return await import('./ProfileEditForm');
}

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureId === 'sessions.direct',
}));

vi.mock('@/hooks/auth/useCLIDetection', () => ({
    useCLIDetection: () => ({ status: 'unknown', login: { codex: false, customAcp: false } }),
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

vi.mock('@/components/ui/lists/Item', () => ({
    Item: ({ title, onPress }: any) => {
        if (title === 'Custom Backend' && typeof onPress === 'function') {
            capture.customBackendPress = onPress;
        }
        return React.createElement('Item', { title, onPress });
    },
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
        capture.reset();
        const saveRef = { current: null as null | (() => boolean) };
        const onSave = vi.fn((_: AIBackendProfile) => true);
        const { ProfileEditForm } = await loadProfileEditForm();

        await renderScreen(React.createElement(ProfileEditForm, {
            profile: buildProfile(),
            machineId: null,
            onSave,
            onCancel: vi.fn(),
            saveRef,
        }));

        expect(capture.customBackendPress).toBeTruthy();

        await act(async () => {
            capture.customBackendPress?.();
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
        const { ProfileEditForm } = await loadProfileEditForm();

        await renderScreen(React.createElement(ProfileEditForm, {
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
        }));

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
        const { ProfileEditForm } = await loadProfileEditForm();

        await renderScreen(React.createElement(ProfileEditForm, {
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
        }));

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
