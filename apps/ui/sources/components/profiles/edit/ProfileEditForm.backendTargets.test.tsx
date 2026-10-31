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
    codexPresses: [] as Array<() => void>,
    reset() {
        this.customBackendPress = null;
        this.codexPresses = [];
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
    Item: ({ title, subtitle, onPress, testID }: any) => {
        if (title === 'Custom Backend' && typeof onPress === 'function') {
            capture.customBackendPress = onPress;
        }
        // Compatibility rows are the only rows keyed by bare agent id subtitles; they render
        // before dropdown triggers, so index 0 is the compat toggle.
        if (subtitle === 'codex' && typeof onPress === 'function') {
            capture.codexPresses.push(onPress);
        }
        return React.createElement('Item', { title, subtitle, onPress, testID });
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
        expect(onSave.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
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
        expect(onSave.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
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

    it('keeps a compatible default backend target on save', async () => {
        const saveRef = { current: null as null | (() => boolean) };
        const onSave = vi.fn((_: AIBackendProfile) => true);
        const { ProfileEditForm } = await loadProfileEditForm();

        await renderScreen(React.createElement(ProfileEditForm, {
            profile: AIBackendProfileSchema.parse({
                ...buildProfile(),
                compatibilityByTargetKey: {
                    [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' })]: true,
                    [buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'custom-backend' })]: true,
                },
                defaultBackendTargetKey: buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' }),
            }),
            machineId: null,
            onSave,
            onCancel: vi.fn(),
            saveRef,
        }));

        const result = saveRef.current?.();
        expect(result).toBe(true);
        expect(onSave.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
            defaultBackendTargetKey: buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' }),
        }));
    });

    it('clears the default backend target when its backend is toggled off', async () => {
        capture.reset();
        const saveRef = { current: null as null | (() => boolean) };
        const onSave = vi.fn((_: AIBackendProfile) => true);
        const { ProfileEditForm } = await loadProfileEditForm();

        await renderScreen(React.createElement(ProfileEditForm, {
            profile: AIBackendProfileSchema.parse({
                ...buildProfile(),
                compatibilityByTargetKey: {
                    [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' })]: true,
                    [buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'custom-backend' })]: true,
                },
                defaultBackendTargetKey: buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' }),
            }),
            machineId: null,
            onSave,
            onCancel: vi.fn(),
            saveRef,
        }));

        expect(capture.codexPresses.length).toBeGreaterThan(0);
        await act(async () => {
            capture.codexPresses[0]?.();
        });

        const result = saveRef.current?.();
        expect(result).toBe(true);
        expect(onSave.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
            compatibilityByTargetKey: expect.objectContaining({
                [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' })]: false,
            }),
            defaultBackendTargetKey: undefined,
        }));
    });
});

describe('ProfileEditForm default backend preservation', () => {
    it('displays a saved hidden default as unavailable while retaining its selection', async () => {
        const { ProfileEditForm } = await loadProfileEditForm();
        const profile = AIBackendProfileSchema.parse({
            ...buildProfile(),
            compatibilityByTargetKey: { 'agent:codex': true, 'agent:gemini': true },
            defaultBackendTargetKey: 'agent:gemini',
        });
        const rendered = await renderScreen(React.createElement(ProfileEditForm, {
            profile, machineId: null, onSave: vi.fn(() => true), onCancel: vi.fn(),
        }));
        const picker = rendered.tree.findAllByType('DropdownMenu').find((node) => node.props.selectedId === 'agent:gemini');
        expect(picker).toBeDefined();
        const trigger = await renderScreen(picker?.props.trigger({ toggle: vi.fn() }));
        expect(trigger.findByTestId('profile-default-backend-trigger')?.props.title).toBe('common.unavailable');
    });

    it('clears a hidden backend default denied by the saved compatibility map', async () => {
        const saveRef = { current: null as null | (() => boolean) };
        const onSave = vi.fn((_: AIBackendProfile) => true);
        const { ProfileEditForm } = await loadProfileEditForm();
        const profile = AIBackendProfileSchema.parse({
            ...buildProfile(),
            compatibilityByTargetKey: { 'agent:codex': true, 'agent:gemini': false },
            defaultBackendTargetKey: 'agent:gemini',
        });
        await renderScreen(React.createElement(ProfileEditForm, {
            profile, machineId: null, onSave, onCancel: vi.fn(), saveRef,
        }));
        expect(saveRef.current?.()).toBe(true);
        expect(onSave.mock.calls[0]?.[0].compatibilityByTargetKey['agent:gemini']).toBe(false);
        expect(onSave.mock.calls[0]?.[0].defaultBackendTargetKey).toBeUndefined();
    });

    it.each([true, undefined])('preserves a hidden backend default with compatibility %s when saving unrelated content', async (compatibility) => {
        const saveRef = { current: null as null | (() => boolean) };
        const onSave = vi.fn((_: AIBackendProfile) => true);
        const { ProfileEditForm } = await loadProfileEditForm();
        const original = AIBackendProfileSchema.parse({
            ...buildProfile(),
            compatibilityByTargetKey: { 'agent:codex': true, ...(compatibility === undefined ? {} : { 'agent:gemini': compatibility }) },
            defaultBackendTargetKey: 'agent:gemini',
        });
        await renderScreen(React.createElement(ProfileEditForm, {
            profile: original, machineId: null, onSave, onCancel: vi.fn(), saveRef,
        }));
        expect(saveRef.current?.()).toBe(true);
        expect(onSave.mock.calls[0]?.[0].compatibilityByTargetKey['agent:gemini']).toBe(compatibility);
        expect(onSave.mock.calls[0]?.[0].defaultBackendTargetKey).toBe('agent:gemini');
    });
    it('exposes an existing default so it can be cleared with one compatible backend', async () => {
        const saveRef = { current: null as null | (() => boolean) };
        const onSave = vi.fn((_: AIBackendProfile) => true);
        const { ProfileEditForm } = await loadProfileEditForm();
        const original = AIBackendProfileSchema.parse({
            ...buildProfile(), defaultBackendTargetKey: 'agent:codex',
        });
        const rendered = await renderScreen(React.createElement(ProfileEditForm, {
            profile: original, machineId: null, onSave, onCancel: vi.fn(), saveRef,
        }));
        const defaultPickers = rendered.tree.findAllByType('DropdownMenu').filter((node) =>
            node.props.items?.some((item: { id: string }) => item.id === '__none__'));
        expect(defaultPickers.length).toBe(1);
        await act(async () => { defaultPickers[0]?.props.onSelect('__none__'); });
        expect(saveRef.current?.()).toBe(true);
        expect(onSave.mock.calls[0]?.[0].defaultBackendTargetKey).toBeUndefined();
    });
});

describe('ProfileEditForm canonical backend compatibility', () => {
    it('hydrates a late configured backend with canonical compatibility while preserving user edits', async () => {
        capture.reset();
        const saveRef = { current: null as null | (() => boolean) };
        const onSave = vi.fn((_: AIBackendProfile) => true);
        const { ProfileEditForm } = await loadProfileEditForm();
        const profile = AIBackendProfileSchema.parse({ ...buildProfile(), compatibility: {} });
        const props = { profile, machineId: null, onSave, onCancel: vi.fn(), saveRef };
        const originalCatalog = settingsState.acpCatalogSettingsV1;
        const rendered = await renderScreen(React.createElement(ProfileEditForm, props));

        try {
            expect(capture.customBackendPress).toBeTruthy();
            await act(async () => { capture.customBackendPress?.(); });
            settingsState.acpCatalogSettingsV1 = {
                ...originalCatalog,
                backends: [
                    ...originalCatalog.backends,
                    { ...originalCatalog.backends[0]!, id: 'late-backend', name: 'late-backend', title: 'Late Backend' },
                ],
            };
            await act(async () => { rendered.tree.update(React.createElement(ProfileEditForm, props)); });

            expect(saveRef.current?.()).toBe(true);
            expect(onSave.mock.calls[0]?.[0].compatibilityByTargetKey).toEqual(expect.objectContaining({
                'acpBackend:custom-backend': false,
                'acpBackend:late-backend': true,
            }));
        } finally {
            settingsState.acpCatalogSettingsV1 = originalCatalog;
        }
    });

    it('preserves canonical compatibility for an unspecified configured backend', async () => {
        const saveRef = { current: null as null | (() => boolean) };
        const onSave = vi.fn((_: AIBackendProfile) => true);
        const { ProfileEditForm } = await loadProfileEditForm();
        const profile = AIBackendProfileSchema.parse({ ...buildProfile(), compatibility: {} });
        await renderScreen(React.createElement(ProfileEditForm, {
            profile, machineId: null, onSave, onCancel: vi.fn(), saveRef,
        }));
        expect(saveRef.current?.()).toBe(true);
        expect(onSave.mock.calls[0]?.[0].compatibilityByTargetKey['acpBackend:custom-backend']).toBe(true);
    });
});
