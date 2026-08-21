import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionMode, ModelMode } from '@/sync/domains/permissions/permissionTypes';
import type { Settings } from '@/sync/domains/settings/settings';
import type { UseMachineEnvPresenceResult } from '@/hooks/machine/useMachineEnvPresence';
import { renderScreen } from '@/dev/testkit';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';

import { installNewSessionScreenModelCommonModuleMocks } from './newSessionScreenModelTestHelpers';
import { createNewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';
import type { PreflightModelList } from '@/sync/domains/models/modelOptions';
import type { AgentId } from '@/agents/catalog/catalog';
import type { BackendTargetRefV1 } from '@happier-dev/protocol';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

const PI_PREFLIGHT_MODELS: PreflightModelList = {
    availableModels: [
        { id: 'default', name: 'Default' },
        { id: 'zai/glm-5.3', name: 'GLM-5.3' },
        { id: 'lmstudio/hadees/lfm2.5-2.6b@q8_0', name: 'LFM 2.5 2.6B' },
    ],
    supportsFreeform: true,
};

async function setupUseCreateNewSessionHarness(params: Readonly<{
    publishModelsSeedError?: Error;
}> = {}) {
    const publishModelsSeedSpy = vi.fn(async (..._args: unknown[]) => {
        if (params.publishModelsSeedError) throw params.publishModelsSeedError;
    });
    const captureExceptionSpy = vi.fn();
    const modalAlertSpy = vi.fn((..._args: unknown[]) => {});
    const modalConfirmSpy = vi.fn(async () => false);
    const applySettingsSpy = vi.fn((..._args: unknown[]) => {});
    const refreshSessionsSpy = vi.fn(async () => {});
    const refreshAutomationsSpy = vi.fn(async () => {});
    const getMachineCapabilitiesSnapshotSpy = vi.fn(() => ({ supported: true, response: { protocolVersion: 1, results: {} } }));
    const prefetchMachineCapabilitiesSpy = vi.fn(async () => {});
    const syncSendMessageSpy = vi.fn<(...args: unknown[]) => Promise<void>>(async (..._args: unknown[]) => {});
    const machineSpawnNewSessionSpy = vi.fn<(...args: unknown[]) => Promise<any>>(async () => ({
        type: 'success',
        sessionId: 'sess_pi_1',
    }));
    const materializeNewSessionCheckoutSpy = vi.fn(async () => ({
        success: true as const,
        path: '/tmp',
        sessionPath: '/tmp',
        repositoryRootPath: '/tmp',
    }));
    const followUpSpawnedSessionWithServerScopeSpy = vi.fn(async (..._args: unknown[]) => {});

    installNewSessionScreenModelCommonModuleMocks({
        text: () =>
            createTextModuleMock({
                translate: (key: string) => key,
            }),
        storage: async (importOriginal) => {
            const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
            return createPartialStorageModuleMock(importOriginal, {});
        },
    });
    vi.doMock('@/modal', () => ({
        Modal: {
            alert: modalAlertSpy,
            confirm: modalConfirmSpy,
        },
    }));
    vi.doMock('@/sync/sync', () => ({
        sync: {
            applySettings: vi.fn(),
            createAutomation: vi.fn(),
            updateAutomation: vi.fn(),
            getCredentials: vi.fn(() => ({ token: 't' })),
            encryption: {
                encryptRaw: vi.fn(async (value: unknown) => `cipher:${JSON.stringify(value)}`),
                encryptAutomationTemplateRaw: vi.fn(async (value: unknown) => `cipher:${JSON.stringify(value)}`),
            },
            decryptSecretValue: vi.fn(),
            refreshAutomations: refreshAutomationsSpy,
            refreshSessions: refreshSessionsSpy,
            ensureSessionVisibleForMessageRoute: vi.fn(async () => {}),
            refreshMachines: vi.fn(async () => {}),
            sendMessage: syncSendMessageSpy,
            publishSessionModelsSeedToMetadata: publishModelsSeedSpy,
        },
    }));
    vi.doMock('@/sync/store/settingsWriters', () => ({
        useApplySettings: () => applySettingsSpy,
    }));
    vi.doMock('@/sync/http/client', () => ({
        serverFetch: vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({ mode: 'e2ee', updatedAt: 1 }),
        })),
    }));
    vi.doMock('@/sync/domains/server/serverRuntime', () => ({
        getActiveServerSnapshot: vi.fn(() => ({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            kind: 'custom',
            generation: 1,
        })),
        setActiveServer: vi.fn(),
    }));
    vi.doMock('@/sync/domains/server/selection/serverSelectionResolver', () => ({
        resolveNewSessionServerTarget: vi.fn((params: { requestedServerId?: string | null; allowedServerIds: string[] }) => ({
            targetServerId:
                params.requestedServerId && params.allowedServerIds.includes(params.requestedServerId)
                    ? params.requestedServerId
                    : params.allowedServerIds[0] ?? null,
            rejectedRequestedServerId: null,
        })),
    }));
    vi.doMock('@/sync/domains/profiles/profileUtils', () => ({
        getBuiltInProfile: vi.fn(() => null),
    }));
    vi.doMock('@/sync/domains/features/featureLocalPolicy', () => ({
        resolveLocalFeaturePolicyEnabled: vi.fn((_featureId: string, settings: { featureToggles?: Record<string, boolean> }) => settings.featureToggles?.[_featureId] === true),
    }));
    vi.doMock('@/utils/system/sentry', () => ({
        captureExceptionIfEnabled: captureExceptionSpy,
    }));
    vi.doMock('@/sync/runtime/orchestration/connectionManager', () => ({
        switchConnectionToActiveServer: vi.fn(async () => ({ token: 'next-token', secret: 'next-secret' })),
    }));
    vi.doMock('@/sync/domains/settings/terminalSettings', () => ({
        resolveTerminalSpawnOptions: vi.fn(() => null),
    }));
    vi.doMock('@/hooks/server/useMachineCapabilitiesCache', () => ({
        getMachineCapabilitiesSnapshot: getMachineCapabilitiesSnapshotSpy,
        prefetchMachineCapabilities: prefetchMachineCapabilitiesSpy,
    }));
    vi.doMock('@/agents/catalog/catalog', async (importOriginal) => ({
        ...(await importOriginal<Record<string, unknown>>()),
        buildSpawnEnvironmentVariablesFromUiState: vi.fn((opts: { environmentVariables?: Record<string, string> }) => opts.environmentVariables),
        buildSpawnSessionExtrasFromUiState: vi.fn(() => ({})),
        getAgentResumeExperimentsFromSettings: vi.fn(() => ({})),
        getNewSessionPreflightIssues: vi.fn(() => []),
        buildResumeCapabilityOptionsFromUiState: vi.fn(() => ({})),
    }));
    vi.doMock('@/agents/runtime/resumeCapabilities', () => ({
        canAgentResume: vi.fn(() => false),
    }));
    vi.doMock('@/components/sessions/new/modules/formatResumeSupportDetailCode', () => ({
        formatResumeSupportDetailCode: vi.fn(() => ''),
    }));
    vi.doMock('@/sync/ops', () => ({
        machineSpawnNewSession: (...args: unknown[]) => machineSpawnNewSessionSpy(...args),
        machineBash: vi.fn(async () => ({ success: true, stderr: '', stdout: '', exitCode: 0 })),
        completeMachineSpawnAttemptCustody: vi.fn(async () => true),
        resetMachineSpawnAttemptCustody: vi.fn(async () => true),
    }));
    vi.doMock('@/components/sessions/new/modules/materializeNewSessionCheckout', () => ({
        materializeNewSessionCheckout: materializeNewSessionCheckoutSpy,
    }));
    vi.doMock('@/sync/ops/workspaces', () => ({
        deleteWorkspaceCheckout: vi.fn(async () => ({ success: true, workspace: { id: 'ws_generated', locationIds: ['loc_generated'], checkoutIds: [], defaultLocationId: 'loc_generated', defaultCheckoutId: null, displayName: 'workspace' } })),
    }));
    vi.doMock('@/sync/runtime/orchestration/serverScopedRpc/followUpSpawnedSession', () => ({
        followUpSpawnedSessionWithServerScope: followUpSpawnedSessionWithServerScopeSpy,
    }));
    vi.doMock('@/sync/ops/sessionGoals', () => ({
        sessionGoalSet: vi.fn(async () => ({ ok: true as const })),
        sessionGoalClear: vi.fn(async () => ({ ok: true as const })),
    }));
    vi.doMock('@/sync/ops/actions/defaultActionExecutor', () => ({
        createDefaultActionExecutor: vi.fn(() => ({
            execute: vi.fn(async () => ({ ok: true as const })),
        })),
    }));
    vi.doMock('@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache', () => ({
        resolveServerIdForSessionIdFromLocalCache: vi.fn(() => 'server-a'),
    }));

    const { useCreateNewSession } = await import('./useCreateNewSession');
    return {
        useCreateNewSession,
        publishModelsSeedSpy,
        captureExceptionSpy,
        machineSpawnNewSessionSpy,
        modalAlertSpy,
    };
}

type Harness = Awaited<ReturnType<typeof setupUseCreateNewSessionHarness>>;

async function runCreateSession(
    harness: Harness,
    params: Readonly<{
        agentType: AgentId;
        modelMode?: ModelMode;
        preflightModels?: PreflightModelList | null;
        targetServerId?: string;
        backendTarget?: BackendTargetRefV1;
    }>,
): Promise<void> {
    let handleCreateSession: null | (() => Promise<void>) = null;
    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
        isPreviewEnvSupported: false,
        isLoading: false,
        meta: {},
        refreshedAt: null,
        refresh: () => {},
    };

    function Test() {
        const hook = harness.useCreateNewSession({
            launchIntentSignature: 'test-launch-intent',
            router: { push: vi.fn(), replace: vi.fn() },
            selectedMachineId: 'm1',
            selectedPath: '/tmp',
            selectedMachine: { metadata: {} },
            setIsCreating: vi.fn(),
            setIsResumeSupportChecking: vi.fn(),
            settings,
            useProfiles: false,
            selectedProfileId: null,
            profileMap: new Map(),
            recentMachinePaths: [],
            agentType: params.agentType,
            backendTarget: params.backendTarget,
            permissionMode: 'default' as PermissionMode,
            modelMode: params.modelMode ?? ('default' as ModelMode),
            promptStore: createNewSessionPromptStore(''),
            resumeSessionId: '',
            agentNewSessionOptions: null,
            machineEnvPresence,
            secrets: [],
            secretBindingsByProfileId: {},
            selectedSecretIdByProfileIdByEnvVarName: {},
            sessionOnlySecretValueByProfileIdByEnvVarName: {},
            selectedMachineCapabilities: null,
            targetServerId: params.targetServerId ?? 'server-b',
            allowedTargetServerIds: [params.targetServerId ?? 'server-b'],
            preflightModels: params.preflightModels,
        });

        handleCreateSession = hook.handleCreateSession as () => Promise<void>;
        return React.createElement('View');
    }

    await renderScreen(React.createElement(Test));
    await act(async () => {
        await handleCreateSession?.();
    });
}

describe('useCreateNewSession model list seeding', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('seeds sessionModelsV1 from the wizard preflight probe for a dynamic agent without static models', async () => {
        const harness = await setupUseCreateNewSessionHarness();

        await runCreateSession(harness, {
            agentType: 'pi',
            modelMode: 'lmstudio/hadees/lfm2.5-2.6b@q8_0' as ModelMode,
            preflightModels: PI_PREFLIGHT_MODELS,
        });

        expect(harness.publishModelsSeedSpy).toHaveBeenCalledTimes(1);
        expect(harness.publishModelsSeedSpy).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'sess_pi_1',
            serverId: 'server-b',
            agentId: 'pi',
            currentModelId: 'lmstudio/hadees/lfm2.5-2.6b@q8_0',
            availableModels: PI_PREFLIGHT_MODELS.availableModels,
            updatedAt: expect.any(Number),
        }));
    });

    it('reports a best-effort seed failure without failing session creation', async () => {
        const seedError = new Error('seed metadata unavailable');
        const harness = await setupUseCreateNewSessionHarness({ publishModelsSeedError: seedError });
        vi.spyOn(console, 'error').mockImplementation(() => {});

        await runCreateSession(harness, {
            agentType: 'pi',
            preflightModels: PI_PREFLIGHT_MODELS,
        });

        expect(harness.captureExceptionSpy).toHaveBeenCalledWith(seedError);
        expect(harness.modalAlertSpy).not.toHaveBeenCalled();
    });

    it('seeds with the default model marker when no model override was selected', async () => {
        const harness = await setupUseCreateNewSessionHarness();

        await runCreateSession(harness, {
            agentType: 'pi',
            modelMode: 'default' as ModelMode,
            preflightModels: PI_PREFLIGHT_MODELS,
        });

        expect(harness.publishModelsSeedSpy).toHaveBeenCalledWith(expect.objectContaining({
            currentModelId: 'default',
        }));
    });

    it('does not seed when the wizard has no preflight model list', async () => {
        const harness = await setupUseCreateNewSessionHarness();

        await runCreateSession(harness, {
            agentType: 'pi',
            preflightModels: null,
        });

        expect(harness.publishModelsSeedSpy).not.toHaveBeenCalled();
    });

    it('does not seed for agents whose curated static list already populates the picker', async () => {
        // claude ships staticModels in the catalog, so its in-session picker is never empty
        // before the runtime publishes.
        const harness = await setupUseCreateNewSessionHarness();

        await runCreateSession(harness, {
            agentType: 'claude',
            preflightModels: PI_PREFLIGHT_MODELS,
        });

        expect(harness.publishModelsSeedSpy).not.toHaveBeenCalled();
    });

    it('does not seed for static-only probe agents', async () => {
        const harness = await setupUseCreateNewSessionHarness();

        await runCreateSession(harness, {
            agentType: 'qwen',
            preflightModels: PI_PREFLIGHT_MODELS,
        });

        expect(harness.publishModelsSeedSpy).not.toHaveBeenCalled();
    });

    it('does not seed configured ACP backend sessions', async () => {
        const harness = await setupUseCreateNewSessionHarness();

        await runCreateSession(harness, {
            agentType: 'customAcp',
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'backend-1' },
            preflightModels: PI_PREFLIGHT_MODELS,
        });

        expect(harness.machineSpawnNewSessionSpy).toHaveBeenCalledTimes(1);
        expect(harness.publishModelsSeedSpy).not.toHaveBeenCalled();
    });
});
