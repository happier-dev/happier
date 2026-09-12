import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { AIBackendProfileSchema, type AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol';
import { renderScreen } from '@/dev/testkit';
import { installProfileEditFormModuleMocks } from './profileEditFormTestHelpers';
import { ProfileEditForm } from './ProfileEditForm';
import type { ProfileEditFormProps } from './ProfileEditForm';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionTypeSelectorSpy = vi.hoisted(() => vi.fn(() => null));

const builtInBackendTargetKey = (backendId: string) => buildBackendTargetKeyV2({
    kind: 'backend',
    backendId,
    sourceKind: 'built_in',
});
const configuredBackendTargetKey = (backendId: string) => buildBackendTargetKeyV2({
    kind: 'backend',
    backendId,
    configuredBackendId: backendId,
    sourceKind: 'configured',
});

installProfileEditFormModuleMocks({
    storageModule: async () => {
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
            useCurrentSecretBindingsByProfileIdMutable: () => [{}, vi.fn()] as const,
            useSettingMutable: (key: string) => {
                if (key === 'favoriteMachines') return [[], vi.fn()] as const;
                if (key === 'secrets') return [[], vi.fn()] as const;
                return [[], vi.fn()] as const;
            },
        });
    },
});

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureId === 'sessions.direct',
}));

vi.mock('@/hooks/auth/useCLIDetection', () => ({
    useCLIDetection: () => ({ status: 'unknown' }),
}));

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => ['codex'],
}));

vi.mock('@/agents/catalog/catalog', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/agents/catalog/catalog')>();
    return {
        ...actual,
        AGENT_IDS: ['codex'],
        DEFAULT_AGENT_ID: 'codex',
        isBundledAgentId: (value: unknown): value is typeof actual.DEFAULT_AGENT_ID =>
            typeof value === 'string' && value === 'codex',
        getAgentCore: () => {
            const core = actual.getAgentCore('codex');
            return {
                ...core,
                sessionStorage: { ...core.sessionStorage, direct: true, persisted: true },
                permissions: { ...core.permissions, modeGroup: 'codexLike' },
                cli: { ...core.cli, machineLoginKey: 'codex' },
                ui: { ...core.ui, agentPickerIconName: 'terminal-outline' },
            };
        },
        getAgentBehavior: () => {
            const behavior = actual.getAgentBehavior('codex');
            return {
                ...behavior,
                newSession: {
                    ...behavior.newSession,
                    supportsTranscriptStorageMode: () => true,
                },
            };
        },
    };
});

vi.mock('@/components/ui/lists/Item', () => ({
    Item: () => null,
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
            [builtInBackendTargetKey('codex')]: true,
            [builtInBackendTargetKey('claude')]: true,
            [builtInBackendTargetKey('gemini')]: true,
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
                        defaultPersistenceModeByTargetKey: { [builtInBackendTargetKey('codex')]: 'direct' },
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
            defaultPersistenceModeByTargetKey: { [builtInBackendTargetKey('codex')]: 'direct' },
        }));
        expect(saved!.defaultPersistenceModeByAgent).toEqual({});
    });

    it('preserves canonical target-keyed compatibility and defaults when saving', async () => {
        const saveRef = { current: null as null | (() => boolean) };
        const onSave = vi.fn<ProfileEditFormProps['onSave']>(() => true);

        await renderScreen(React.createElement(ProfileEditForm, {
                    profile: buildProfile({
                        defaultPermissionModeByTargetKey: {
                            [builtInBackendTargetKey('codex')]: 'read-only',
                            [configuredBackendTargetKey('custom-preset')]: 'safe-yolo',
                        },
                        defaultPersistenceModeByTargetKey: {
                            [builtInBackendTargetKey('codex')]: 'direct',
                            [configuredBackendTargetKey('custom-preset')]: 'persisted',
                        },
                        compatibilityByTargetKey: {
                            [builtInBackendTargetKey('codex')]: true,
                            [configuredBackendTargetKey('custom-preset')]: true,
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
        expect(onSave.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
            compatibilityByTargetKey: expect.objectContaining({
                [builtInBackendTargetKey('codex')]: true,
                [configuredBackendTargetKey('custom-preset')]: true,
            }),
            defaultPermissionModeByTargetKey: expect.objectContaining({
                [builtInBackendTargetKey('codex')]: 'read-only',
                [configuredBackendTargetKey('custom-preset')]: 'safe-yolo',
            }),
            defaultPersistenceModeByTargetKey: expect.objectContaining({
                [builtInBackendTargetKey('codex')]: 'direct',
                [configuredBackendTargetKey('custom-preset')]: 'persisted',
            }),
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
                            [builtInBackendTargetKey('codex')]: 'read-only',
                        },
                        defaultPersistenceModeByTargetKey: {
                            [builtInBackendTargetKey('codex')]: 'direct',
                        },
                        compatibilityByTargetKey: {
                            [builtInBackendTargetKey('codex')]: true,
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
            compatibilityByTargetKey: expect.objectContaining({
                [builtInBackendTargetKey('codex')]: true,
            }),
            defaultPermissionModeByTargetKey: {
                [builtInBackendTargetKey('codex')]: 'read-only',
            },
            defaultPersistenceModeByTargetKey: {
                [builtInBackendTargetKey('codex')]: 'direct',
            },
        }));
        expect(saved!.defaultPermissionModeByAgent).toEqual({});
        expect(saved!.defaultPersistenceModeByAgent).toEqual({});
        expect(saved!.requiresMachineLogin).toBeUndefined();
        expect('defaultSessionType' in saved!).toBe(false);
    });
});
