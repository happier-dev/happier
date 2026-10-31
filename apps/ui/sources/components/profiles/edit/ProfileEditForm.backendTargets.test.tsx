import React from 'react';
import { t } from '@/text';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { AIBackendProfileSchema, type AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { buildBackendTargetKey, buildBackendTargetKeyV2 } from '@happier-dev/protocol';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { AcpCatalogRecordV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { ProfileEditForm } from './ProfileEditForm';
import {
    installProfileEditFormModuleMocks,
    resetProfileEditFormTestState,
    publishProfileEditFormAcpCatalogFixture,
    loadProfileEditFormCatalogFixtureOwners,
    publishProfileEditFormPrivateRowFixture,
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
};
const catalogRecord = AcpCatalogRecordV1Schema.parse({
        v: 1,
        definitions: [
            {
                id: 'custom-backend',
                name: 'custom-backend',
                title: 'Custom Backend',
                launch: { kind: 'command' as const, command: 'custom-acp', args: ['serve'] },
                env: {},
                createdAt: 1,
                updatedAt: 1,
            },
        ],
});
let disposeCatalog: (() => void) | undefined;
let disposePrivateRow: (() => void) | undefined;
beforeEach(async () => {
    disposeCatalog = await publishProfileEditFormAcpCatalogFixture(catalogRecord);
    disposePrivateRow = await publishProfileEditFormPrivateRowFixture(buildProfile());
});
afterEach(() => { standardCleanup(); disposePrivateRow?.(); disposeCatalog?.(); disposeCatalog = undefined; });

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
            useCurrentSecretBindingsByProfileIdMutable: () => [{}, vi.fn()] as const,
            useSettingMutable: (key: string) => {
                if (key === 'favoriteMachines') return [[], vi.fn()] as const;
                if (key === 'secrets') return [[], vi.fn()] as const;
                return [[], vi.fn()] as const;
            },
        });
    },
});

async function loadProfileEditForm() {
    return { ProfileEditForm };
}

await loadProfileEditFormCatalogFixtureOwners();

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureId === 'sessions.direct',
}));


vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => ['codex'],
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: ({ title, onPress }: any) => {
        if (title === 'Custom Backend' && typeof onPress === 'function') {
            capture.customBackendPress = onPress;
        }
        return React.createElement('Item', { title, onPress });
    },
}));

function buildProfile(): AIBackendProfile & { profileRecordRevision: number } {
    return { ...AIBackendProfileSchema.parse({
        id: 'p1',
        name: 'P',
        environmentVariables: [],
        defaultPermissionModeByAgent: {},
        defaultPermissionModeByTargetKey: {},
        defaultPersistenceModeByAgent: {},
        defaultPersistenceModeByTargetKey: {},
        compatibility: { codex: true },
        compatibilityByTargetKey: {
            [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' })]: true,
            [buildBackendTargetKeyV2({ kind: 'backend', backendId: 'custom-backend', configuredBackendId: 'custom-backend', sourceKind: 'configured' })]: false,
        },
        envVarRequirements: [],
        isBuiltIn: false,
        createdAt: 0,
        updatedAt: 0,
        version: '1.0.0',
    }), profileRecordRevision: 1 };
}

describe('ProfileEditForm backend targets', () => {
    it('offers a clearable preferred Agent for an imported single-target legacy profile', async () => {
        const saveRef = { current: null as null | (() => boolean) };
        const onSave = vi.fn((_: AIBackendProfile) => true);
        const profile = { ...buildProfile(), defaultBackendTargetKey: 'agent:happier.agent.codex/codex' };
        const screen = await renderScreen(React.createElement(ProfileEditForm, {
            profile, machineId: null, onSave, onCancel: vi.fn(), saveRef,
        }));
        const picker = screen.findAll(node => node.props.selectedId === profile.defaultBackendTargetKey
            && Array.isArray(node.props.items) && node.props.items.some((item: { id: string }) => item.id === '__none__'))
            .find(node => typeof node.props.onSelect === 'function');
        expect(picker).toBeTruthy();
        await act(async () => { picker?.props.onSelect('__none__'); });
        expect(saveRef.current?.()).toBe(true);
        expect(onSave.mock.calls[0]?.[0].defaultBackendTargetKey).toBeUndefined();
    });

    it('shows an unavailable saved default without clearing it on an unrelated save', async () => {
        const saveRef = { current: null as null | (() => boolean) };
        const onSave = vi.fn((_: AIBackendProfile) => true);
        const profile = { ...buildProfile(), defaultBackendTargetKey: 'agent:acme.review/reviewer' };
        const screen = await renderScreen(React.createElement(ProfileEditForm, {
            profile, machineId: null, onSave, onCancel: vi.fn(), saveRef,
        }));
        const picker = screen.findAll(node => node.props.selectedId === profile.defaultBackendTargetKey
            && Array.isArray(node.props.items) && node.props.items.some((item: { id: string }) => item.id === '__none__'))
            .find(node => typeof node.props.onSelect === 'function');
        expect(picker?.props.itemTrigger.subtitle).toBe(t('common.unavailable'));
        expect(saveRef.current?.()).toBe(true);
        expect(onSave.mock.calls[0]?.[0].defaultBackendTargetKey).toBe(profile.defaultBackendTargetKey);
    });

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
                [buildBackendTargetKeyV2({
                    kind: 'backend',
                    backendId: 'custom-backend',
                    configuredBackendId: 'custom-backend',
                    sourceKind: 'configured',
                })]: true,
            }),
        }));
    });

    it('clears the saved default when that target is explicitly disabled', async () => {
        capture.reset();
        const saveRef = { current: null as null | (() => boolean) };
        const onSave = vi.fn((_: AIBackendProfile) => true);
        const targetKey = buildBackendTargetKeyV2({ kind: 'backend', backendId: 'custom-backend', configuredBackendId: 'custom-backend', sourceKind: 'configured' });
        const base = buildProfile();
        const profile = { ...base, defaultBackendTargetKey: targetKey,
            compatibilityByTargetKey: { ...base.compatibilityByTargetKey, [targetKey]: true } };
        await renderScreen(React.createElement(ProfileEditForm, { profile, machineId: null, onSave, onCancel: vi.fn(), saveRef }));
        expect(capture.customBackendPress).toBeTruthy();
        await act(async () => { capture.customBackendPress?.(); });
        expect(saveRef.current?.()).toBe(true);
        expect(onSave.mock.calls[0]?.[0].defaultBackendTargetKey).toBeUndefined();
        expect(onSave.mock.calls[0]?.[0].compatibilityByTargetKey[targetKey]).toBe(false);
    });

    it('persists the canonical machine-login target when exactly one login-capable Agent is compatible', async () => {
        const saveRef = { current: null as null | (() => boolean) };
        const onSave = vi.fn((_: AIBackendProfile) => true);
        const { ProfileEditForm } = await loadProfileEditForm();
        const machineLoginProfile = { ...AIBackendProfileSchema.parse({
            ...buildProfile(),
            authMode: 'machineLogin',
            compatibility: { codex: false, customAcp: false },
            compatibilityByTargetKey: {
                [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' })]: true,
                [buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'custom-backend' })]: false,
            },
        }), profileRecordRevision: 1 };

        await renderScreen(React.createElement(ProfileEditForm, {
            profile: machineLoginProfile,
            machineId: null,
            onSave,
            onCancel: vi.fn(),
            saveRef,
        }));

        const result = saveRef.current?.();
        expect(result).toBe(true);
        expect(onSave.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
            authMode: 'machineLogin',
            requiresMachineLoginTargetKey: buildBackendTargetKeyV2({
                kind: 'backend',
                backendId: 'codex',
            }),
            requiresMachineLogin: undefined,
        }));
    });
});
