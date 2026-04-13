import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AIBackendProfileSchema } from '@/sync/domains/profiles/profileCompatibility';
import { renderHook, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () =>
    (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
        Platform: { OS: 'ios' },
    }));

vi.mock('@/modal', async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

vi.mock('@/components/secrets/requirements', () => ({
    SecretRequirementModal: () => null,
}));

describe('useSecretRequirementFlow', () => {
    afterEach(() => {
        standardCleanup();
        vi.clearAllMocks();
    });

    it('pushes the native secret requirement route with the current new-session context', async () => {
        const router = { push: vi.fn() };
        const navigation = { dispatch: vi.fn(), setParams: vi.fn() };
        const profile = AIBackendProfileSchema.parse({
            id: 'deepseek',
            name: 'DeepSeek',
            environmentVariables: [],
            defaultPermissionModeByAgent: {},
            defaultPermissionModeByTargetKey: {},
            defaultPersistenceModeByAgent: {},
            defaultPersistenceModeByTargetKey: {},
            compatibility: { codex: true, customAcp: false },
            compatibilityByTargetKey: {},
            envVarRequirements: [{ name: 'DEEPSEEK_AUTH_TOKEN', kind: 'secret', required: true }],
            isBuiltIn: true,
            createdAt: 0,
            updatedAt: 0,
            version: '1.0.0',
        });

        const refs = {
            prevProfileIdBeforeSecretPromptRef: { current: null } satisfies React.MutableRefObject<string | null>,
            lastSecretPromptKeyRef: { current: null } satisfies React.MutableRefObject<string | null>,
            suppressNextSecretAutoPromptKeyRef: { current: null } satisfies React.MutableRefObject<string | null>,
            isSecretRequirementModalOpenRef: { current: false } satisfies React.MutableRefObject<boolean>,
        };

        const { useSecretRequirementFlow } = await import('@/components/sessions/new/hooks/useSecretRequirementFlow');

        const hook = await renderHook(() => useSecretRequirementFlow({
            router,
            navigation,
            routeBackendParams: {
                agentType: 'customAcp',
                backendTarget: JSON.stringify({ kind: 'configuredAcpBackend', backendId: 'review-bot' }),
                backendTargetKey: 'acpBackend:review-bot',
            },
            routeContextParams: {
                dataId: 'draft-1',
                machineId: 'machine-1',
                spawnServerId: 'server-2',
            },
            useProfiles: false,
            selectedProfileId: null,
            selectedProfile: null,
            setSelectedProfileId: vi.fn(),
            shouldShowSecretSection: true,
            selectedMachineId: 'machine-1',
            machineEnvPresence: {
                isLoading: false,
                isPreviewEnvSupported: false,
                meta: {},
                refreshedAt: null,
                refresh: vi.fn(),
            },
            secrets: [],
            setSecrets: vi.fn(),
            secretBindingsByProfileId: {},
            setSecretBindingsByProfileId: vi.fn(),
            selectedSecretIdByProfileIdByEnvVarName: {},
            setSelectedSecretIdByProfileIdByEnvVarName: vi.fn(),
            sessionOnlySecretValueByProfileIdByEnvVarName: {},
            setSessionOnlySecretValueByProfileIdByEnvVarName: vi.fn(),
            secretRequirementResultId: undefined,
            prevProfileIdBeforeSecretPromptRef: refs.prevProfileIdBeforeSecretPromptRef,
            lastSecretPromptKeyRef: refs.lastSecretPromptKeyRef,
            suppressNextSecretAutoPromptKeyRef: refs.suppressNextSecretAutoPromptKeyRef,
            isSecretRequirementModalOpenRef: refs.isSecretRequirementModalOpenRef,
        }));

        await act(async () => {
            hook.getCurrent().openSecretRequirementModal(profile, { revertOnCancel: true });
        });

        expect(router.push).toHaveBeenCalledWith({
            pathname: '/new/pick/secret-requirement',
            params: {
                agentType: 'customAcp',
                backendTarget: JSON.stringify({ kind: 'configuredAcpBackend', backendId: 'review-bot' }),
                backendTargetKey: 'acpBackend:review-bot',
                dataId: 'draft-1',
                machineId: 'machine-1',
                profileId: 'deepseek',
                revertOnCancel: '1',
                secretEnvVarName: 'DEEPSEEK_AUTH_TOKEN',
                secretEnvVarNames: 'DEEPSEEK_AUTH_TOKEN',
                selectedSecretIdByEnvVarName: encodeURIComponent(JSON.stringify({})),
                spawnServerId: 'server-2',
            },
        });
    });
});
