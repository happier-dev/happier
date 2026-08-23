import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';
import { AIBackendProfileSchema, type AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import type { EnvironmentVariablesListProps } from '@/components/profiles/environmentVariables/EnvironmentVariablesList';
import type { SecretRequirementModalResult } from '@/components/secrets/requirements';
import {
    installProfileEditFormModuleMocks,
    profileEditFormTestState,
    resetProfileEditFormTestState,
} from './profileEditFormTestHelpers';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

resetProfileEditFormTestState();

const capture = vi.hoisted(() => ({
    environmentVariablesListProps: null as EnvironmentVariablesListProps | null,
    setSecretBindings: vi.fn(),
}));

installProfileEditFormModuleMocks({
    storageModule: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSetting: () => ({}),
            useSettings: () => ({
                acpCatalogSettingsV1: { v: 2, backends: [] },
                backendEnabledByTargetKey: {},
            }),
            useAllMachines: () => [],
            useMachine: () => null,
            useSettingMutable: (key: string) => {
                if (key === 'favoriteMachines') return [[], vi.fn()] as const;
                if (key === 'secrets') {
                    return [[{
                        id: 'secret-1',
                        name: 'OpenRouter',
                        kind: 'apiKey',
                        encryptedValue: { _isSecretValue: true, value: 'secret-value' },
                        createdAt: 1,
                        updatedAt: 1,
                    }], vi.fn()] as const;
                }
                if (key === 'secretBindingsByProfileId') {
                    return [{}, capture.setSecretBindings] as const;
                }
                return [{}, vi.fn()] as const;
            },
        });
    },
    environmentVariablesList: () => ({
        EnvironmentVariablesList: (props: EnvironmentVariablesListProps) => {
            capture.environmentVariablesListProps = props;
            return null;
        },
    }),
});

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => ['codex'],
}));

vi.mock('@/agents/catalog/catalog', () => ({
    DEFAULT_AGENT_ID: 'codex',
    getAgentCore: () => ({
        cli: { machineLoginKey: 'codex' },
        sessionStorage: { direct: false },
        subtitleKey: 'agent.codex.subtitle',
    }),
    getAgentBehavior: () => ({
        newSession: {},
    }),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: () => null,
}));

function buildProfile(): AIBackendProfile {
    return AIBackendProfileSchema.parse({
        id: 'profile-1',
        name: 'OpenRouter profile',
        environmentVariables: [{ name: 'TEST_API_KEY', value: '', isSecret: true }],
        defaultPermissionModeByAgent: {},
        defaultPermissionModeByTargetKey: {},
        defaultPersistenceModeByAgent: {},
        defaultPersistenceModeByTargetKey: {},
        compatibility: { codex: true },
        compatibilityByTargetKey: { 'agent:codex': true },
        envVarRequirements: [{ name: 'TEST_API_KEY', kind: 'secret', required: true }],
        isBuiltIn: false,
        createdAt: 1,
        updatedAt: 1,
        version: '1.0.0',
    });
}

function getCapturedEnvironmentVariablesListProps(): EnvironmentVariablesListProps {
    const props = capture.environmentVariablesListProps as EnvironmentVariablesListProps | null;
    if (!props) {
        throw new Error('EnvironmentVariablesList props were not captured');
    }
    return props;
}

describe('ProfileEditForm secret binding draft', () => {
    it('shows a selected default secret immediately without persisting the unsaved draft', async () => {
        capture.environmentVariablesListProps = null;
        capture.setSecretBindings.mockReset();
        profileEditFormTestState.modalShowSpy.mockReset();

        const { ProfileEditForm } = await import('./ProfileEditForm');
        const onSave = vi.fn(() => true);
        const saveRef = { current: null as null | (() => boolean) };
        await renderScreen(React.createElement(ProfileEditForm, {
            profile: buildProfile(),
            machineId: null,
            onSave,
            onCancel: vi.fn(),
            saveRef,
        }));

        expect(getCapturedEnvironmentVariablesListProps().getDefaultSecretNameForSourceVar('TEST_API_KEY')).toBeNull();

        await act(async () => {
            getCapturedEnvironmentVariablesListProps().onPickDefaultSecretForSourceVar('TEST_API_KEY');
        });

        const modalConfig = profileEditFormTestState.modalShowSpy.mock.calls.at(-1)?.[0] as Readonly<{
            props: Readonly<{
                onResolve: (result: SecretRequirementModalResult) => void;
            }>;
        }>;
        await act(async () => {
            modalConfig.props.onResolve({
                action: 'selectSaved',
                envVarName: 'TEST_API_KEY',
                secretId: 'secret-1',
                setDefault: true,
            });
        });

        expect(getCapturedEnvironmentVariablesListProps().getDefaultSecretNameForSourceVar('TEST_API_KEY')).toBe('OpenRouter');
        expect(capture.setSecretBindings).not.toHaveBeenCalled();

        expect(saveRef.current?.()).toBe(true);
        expect(onSave).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'profile-1' }),
            { TEST_API_KEY: 'secret-1' },
        );
    });
});
