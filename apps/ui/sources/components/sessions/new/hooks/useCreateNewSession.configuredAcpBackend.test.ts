import React from 'react';
import { createNewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildNewSessionAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import type { PermissionMode, ModelMode } from '@/sync/domains/permissions/permissionTypes';
import type { EnsureSessionVisibleForRouteResult } from '@/sync/domains/session/sessionRouteHydrationState';
import type { Settings } from '@/sync/domains/settings/settings';
import type { UseMachineEnvPresenceResult } from '@/hooks/machine/useMachineEnvPresence';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installNewSessionScreenModelCommonModuleMocks } from './newSessionScreenModelTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type SpawnPayloadCapture = {
    backendTarget?:
        | { kind: 'backend'; backendId: string; configuredBackendId?: string; sourceKind?: 'built_in' | 'configured' };
    accountSettingsVersionHint?: number;
} | null;

type ConfiguredBackendHarnessOptions = Readonly<{
    deferFollowUp?: boolean;
    spawnSuccess?: boolean;
}>;

type EnsureSessionVisibleForMessageRouteMock = (
    sessionId: string,
    options?: Readonly<{ forceRefresh?: boolean; serverId?: string; includeTurnsProjection?: boolean }>,
) => Promise<EnsureSessionVisibleForRouteResult>;

type ConfiguredBackendStorageState = Readonly<{
    settings: Record<string, unknown>;
    machines: Record<string, Readonly<{ id: string }>>;
    sessions: Record<string, Readonly<{ id: string; active?: boolean }>>;
    updateSessionPermissionMode: ReturnType<typeof vi.fn>;
    updateSessionModelMode: ReturnType<typeof vi.fn>;
    markSessionOptimisticThinking: ReturnType<typeof vi.fn>;
    upsertPendingMessage: ReturnType<typeof vi.fn>;
}>;

const applySettingsMock = vi.hoisted(() => vi.fn());
const clearNewSessionDraftMock = vi.hoisted(() => vi.fn());
const prepareAccountSettingsForDaemonSpawnMock = vi.hoisted(() => vi.fn(async () => ({})));
const executeSessionSpawnNewActionMock = vi.hoisted(() => vi.fn());
const configuredBackendHarnessModuleState = vi.hoisted(() => ({
    captured: null as { value: SpawnPayloadCapture } | null,
    createdAutomationTemplate: null as { value: Record<string, unknown> | null } | null,
    storageState: null as ConfiguredBackendStorageState | null,
    spawnSuccess: false,
    followUpPending: Promise.resolve() as Promise<void>,
    ensureSessionVisibleForMessageRoute: vi.fn<EnsureSessionVisibleForMessageRouteMock>(async (sessionId) => ({
        kind: 'available',
        sessionId,
    })),
}));

async function setupHarness(options?: ConfiguredBackendHarnessOptions) {
    const captured: { value: SpawnPayloadCapture } = { value: null };
    const createdAutomationTemplate: { value: Record<string, unknown> | null } = { value: null };
    const routerReplaceSpy = vi.fn();
    const storageState: ConfiguredBackendStorageState = {
        settings: {},
        machines: { m1: { id: 'm1' } },
        sessions: {},
        updateSessionPermissionMode: vi.fn(),
        updateSessionModelMode: vi.fn(),
        markSessionOptimisticThinking: vi.fn(),
        upsertPendingMessage: vi.fn(),
    };
    const ensureSessionVisibleForMessageRouteSpy = vi.fn<EnsureSessionVisibleForMessageRouteMock>(async (sessionId) => {
        storageState.sessions[sessionId] = {
            id: sessionId,
            active: true,
        };
        return { kind: 'available', sessionId };
    });
    let resolveFollowUp: (() => void) | null = null;
    const followUpPending = options?.deferFollowUp
        ? new Promise<void>((resolve) => {
            resolveFollowUp = resolve;
        })
        : Promise.resolve();
    configuredBackendHarnessModuleState.captured = captured;
    configuredBackendHarnessModuleState.createdAutomationTemplate = createdAutomationTemplate;
    configuredBackendHarnessModuleState.storageState = storageState;
    configuredBackendHarnessModuleState.spawnSuccess = options?.spawnSuccess === true;
    configuredBackendHarnessModuleState.followUpPending = followUpPending;
    configuredBackendHarnessModuleState.ensureSessionVisibleForMessageRoute = ensureSessionVisibleForMessageRouteSpy;

    installNewSessionScreenModelCommonModuleMocks({
        text: async () => {
            const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
            return createTextModuleMock({
                translate: (key: string) => key,
            });
        },
        modal: async () => {
            const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
            return createModalModuleMock({
                spies: {
                    alert: vi.fn(),
                    confirm: vi.fn(async () => false),
                },
            }).module;
        },
        storage: async () => {
            const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
            return createStorageModuleStub({
                storage: {
                    getState: () => configuredBackendHarnessModuleState.storageState,
                },
            });
        },
    });
    vi.doMock('@/sync/sync', () => ({
        sync: {
            getCredentials: vi.fn(() => ({ token: 't' })),
            encryption: {
                encryptRaw: vi.fn(async (value: unknown) => value),
                encryptAutomationTemplateRaw: vi.fn(async (value: unknown) => value),
            },
            saveAutomationEditorDraft: vi.fn(async (input: {
                executionRecipe: { template: { t: string; v?: Record<string, unknown> } };
            }) => {
                if (configuredBackendHarnessModuleState.createdAutomationTemplate) {
                    configuredBackendHarnessModuleState.createdAutomationTemplate.value = input.executionRecipe.template.v ?? null;
                }
                return {};
            }),
            decryptSecretValue: vi.fn(),
            refreshAutomations: vi.fn(async () => {}),
            refreshSessions: vi.fn(async () => {}),
            ensureSessionVisibleForMessageRoute: vi.fn(async (sessionId: string, options?: Readonly<{ forceRefresh?: boolean; serverId?: string }>) =>
                configuredBackendHarnessModuleState.ensureSessionVisibleForMessageRoute(sessionId, options)),
            sendMessage: vi.fn(async () => {}),
            prepareAccountSettingsForDaemonSpawn: prepareAccountSettingsForDaemonSpawnMock,
        },
    }));
    vi.doMock('@/sync/store/settingsWriters', () => ({
        useApplySettings: () => applySettingsMock,
    }));
    vi.doMock('@/sync/domains/state/persistence', () => ({
        loadSettings: () => ({ settings: {}, version: null }),
        loadDeviceAnalyticsId: () => null,
        saveDeviceAnalyticsId: vi.fn(),
        saveSettings: vi.fn(),
        loadPendingSettings: () => ({}),
        savePendingSettings: vi.fn(),
        loadLocalSettings: () => ({}),
        saveLocalSettings: vi.fn(),
        loadThemePreference: () => 'adaptive',
        loadPurchases: () => ({}),
        savePurchases: vi.fn(),
        loadLocalPetSourcesBySourceKey: () => ({}),
        saveLocalPetSourcesBySourceKey: vi.fn(),
        loadSessionDrafts: () => ({}),
        saveSessionDrafts: vi.fn(),
        loadSessionReviewCommentsDrafts: () => ({}),
        saveSessionReviewCommentsDrafts: vi.fn(),
        loadWorkspaceReviewCommentsDrafts: () => ({}),
        saveWorkspaceReviewCommentsDrafts: vi.fn(),
        loadSessionActionDrafts: () => ({}),
        saveSessionActionDrafts: vi.fn(),
        loadNewSessionDraft: () => null,
        saveNewSessionDraft: vi.fn(),
        clearNewSessionDraft: clearNewSessionDraftMock,
        loadSessionPermissionModes: () => ({}),
        saveSessionPermissionModes: vi.fn(),
        loadSessionPermissionModeUpdatedAts: () => ({}),
        saveSessionPermissionModeUpdatedAts: vi.fn(),
        loadSessionLastViewed: () => ({}),
        saveSessionLastViewed: vi.fn(),
        loadSessionModelModes: () => ({}),
        saveSessionModelModes: vi.fn(),
        loadSessionModelModeUpdatedAts: () => ({}),
        saveSessionModelModeUpdatedAts: vi.fn(),
        loadSessionMaterializedMaxSeqById: () => ({}),
        saveSessionMaterializedMaxSeqById: vi.fn(),
        loadChangesCursor: () => null,
        saveChangesCursor: vi.fn(),
        loadLastChangesCursorByAccountId: () => ({}),
        saveLastChangesCursorByAccountId: vi.fn(),
        loadProfile: () => ({}),
        saveProfile: vi.fn(),
        clearPersistence: vi.fn(),
    }));
    vi.doMock('@/sync/domains/server/serverRuntime', () => ({
        getActiveServerSnapshot: vi.fn(() => ({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            kind: 'custom',
            generation: 1,
        })),
    }));
    vi.doMock('@/sync/domains/server/selection/serverSelectionResolver', () => ({
        resolveNewSessionServerTarget: vi.fn((params: { requestedServerId?: string | null; allowedServerIds: string[] }) => ({
            targetServerId: params.requestedServerId ?? params.allowedServerIds[0] ?? null,
            rejectedRequestedServerId: null,
        })),
    }));
    vi.doMock('@/sync/domains/features/featureLocalPolicy', () => ({
        resolveLocalFeaturePolicyEnabled: vi.fn(() => false),
    }));
    vi.doMock('@/utils/profiles/profileConfigRequirements', () => ({
        getMissingRequiredConfigEnvVarNames: vi.fn(() => []),
    }));
    vi.doMock('@/utils/secrets/secretSatisfaction', () => ({
        getSecretSatisfaction: vi.fn(() => ({ isSatisfied: true, items: [] })),
    }));
    vi.doMock('@/sync/domains/profiles/profileUtils', () => ({
        getBuiltInProfile: vi.fn(() => null),
    }));
    vi.doMock('@/sync/domains/session/spawn/windowsRemoteSessionConsole', () => ({
        resolveWindowsRemoteSessionConsoleFromMachineMetadata: vi.fn(() => undefined),
    }));
    vi.doMock('@/components/sessions/new/modules/profileHelpers', () => ({
        transformProfileToEnvironmentVars: vi.fn(() => ({})),
    }));
    vi.doMock('@/sync/runtime/time', () => ({
        nowServerMs: vi.fn(() => Date.now()),
    }));
    vi.doMock('@/sync/domains/automations/encodeAutomationTemplateCiphertextForAccount', () => ({
        encodeAutomationTemplateCiphertextForAccount: vi.fn(async ({ template }: { template: unknown }) => JSON.stringify(template)),
    }));
    vi.doMock('@/sync/domains/input/slashCommands/resolveSessionComposerSend', () => ({
        resolveSessionComposerSend: vi.fn(({ input }: { input: string }) => ({ kind: 'send', text: input })),
    }));
    vi.doMock('@/sync/domains/input/slashCommands/expandPromptTemplateInvocation', () => ({
        expandPromptTemplateInvocation: vi.fn(async () => 'expanded template'),
    }));
    vi.doMock('@/utils/timing/time', () => ({
        delay: vi.fn(async () => {}),
    }));
    vi.doMock('@/utils/errors/daemonUnavailableAlert', () => ({
        showDaemonUnavailableAlert: vi.fn(),
    }));
    vi.doMock('@/hooks/ui/useMountedRef', () => ({
        useMountedRef: vi.fn(() => ({ current: true })),
    }));
    vi.doMock('@/sync/domains/settings/terminalSettings', () => ({
        resolveTerminalSpawnOptions: vi.fn(() => null),
    }));
    vi.doMock('@/hooks/server/useMachineCapabilitiesCache', () => ({
        getMachineCapabilitiesSnapshot: vi.fn(() => ({ supported: true, response: { protocolVersion: 1, results: {} } })),
    }));
    vi.doMock('@/agents/catalog/catalog', async (importOriginal) => {
        const actual = await importOriginal<typeof import('@/agents/catalog/catalog')>();
        return {
            ...actual,
            getAgentCore: vi.fn(() => ({
                model: { supportsSelection: false },
                sessionModes: { kind: 'staticAgentModes' },
            })),
            buildSpawnEnvironmentVariablesFromUiState: vi.fn((opts: { environmentVariables?: Record<string, string> }) => opts.environmentVariables),
            buildSpawnSessionExtrasFromUiState: vi.fn(() => ({})),
            getAgentResumeExperimentsFromSettings: vi.fn(() => ({})),
            getNewSessionPreflightIssues: vi.fn(() => []),
            buildResumeCapabilityOptionsFromUiState: vi.fn(() => ({})),
        };
    });
    vi.doMock('@/sync/ops', () => ({}));
    vi.doMock('@/sync/ops/actions/sessionSpawnNewAction', () => ({
        buildManualSessionCreationKey: (userAttemptId: string) => `manual:${userAttemptId}`,
        executeManualSessionSpawnNewAction: async (input: any, context: unknown, params: any) => ({
            status: 'executed',
            action: await executeSessionSpawnNewActionMock(input, context),
            custody: {
                v: 3,
                scope: params.scope,
                machineId: input.executionTarget.machineId,
                targetFingerprint: 'test-fingerprint',
                userAttemptId: params.userAttemptId,
                nonce: params.seedNonce,
                submissionState: 'submitted',
                createdSessionId: null,
                firstTurnLocalId: `spawn-first-turn:${params.seedNonce}`,
                attachmentMessageLocalId: `spawn-attachment:${params.seedNonce}`,
            },
        }),
        completeManualSessionSpawnNewActionCustody: async () => true,
        executeSessionSpawnNewAction: executeSessionSpawnNewActionMock,
        resolveSessionSpawnNewActionFailureMessageKey: () => 'newSession.failedToStart',
        resolveSessionSpawnNewResultFailureMessageKey: () => 'newSession.failedToStart',
    }));
    vi.doMock('@/sync/runtime/orchestration/serverScopedRpc/followUpSpawnedSession', () => ({
        followUpSpawnedSessionWithServerScope: vi.fn(async () => configuredBackendHarnessModuleState.followUpPending),
    }));

    const { useCreateNewSession: useCreateNewSessionOwner } = await import('./useCreateNewSession');
    const useCreateNewSession: typeof useCreateNewSessionOwner = (params) => useCreateNewSessionOwner({
        ...params,
        draftScope: params.draftScope ?? { serverId: 'server-a', accountId: 'account-a' },
    });
    return {
        useCreateNewSession,
        captured,
        createdAutomationTemplate,
        routerReplaceSpy,
        storageState,
        ensureSessionVisibleForMessageRouteSpy,
        resolveFollowUp: () => resolveFollowUp?.(),
    };
}

describe('useCreateNewSession configured ACP backend spawning', () => {
    beforeEach(() => {
        vi.resetModules();
        applySettingsMock.mockReset();
        clearNewSessionDraftMock.mockClear();
        prepareAccountSettingsForDaemonSpawnMock.mockReset();
        prepareAccountSettingsForDaemonSpawnMock.mockResolvedValue({});
        executeSessionSpawnNewActionMock.mockReset();
    });

    afterEach(() => {
        standardCleanup();
        vi.clearAllMocks();
    });

    it('fails closed without a private spawn when a configured backend target is unrepresentable', async () => {
        const { useCreateNewSession, captured } = await setupHarness();

        let handleCreateSession: null | (() => Promise<void>) = null;
        const settings = {
            experiments: false,
            lastUsedAgent: 'codex',
        } as unknown as Settings;
        const machineEnvPresence: UseMachineEnvPresenceResult = {
            isPreviewEnvSupported: false,
            isLoading: false,
            meta: {},
            refreshedAt: null,
            refresh: () => {},
        };

        function Test() {
            const hook = useCreateNewSession({
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
                agentType: 'customAcp',
                backendTarget: {
                    kind: 'backend',
                    backendId: 'custom-kiro-preset',
                    configuredBackendId: 'custom-kiro-preset',
                    sourceKind: 'configured',
                },
                permissionMode: 'default' as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore(''),
                resumeSessionId: '',
                agentNewSessionOptions: null,
                machineEnvPresence,
                secrets: [],
                secretBindingsByProfileId: {},
                selectedSecretIdByProfileIdByEnvVarName: {},
                sessionOnlySecretValueByProfileIdByEnvVarName: {},
                selectedMachineCapabilities: null,
                targetServerId: 'server-a',
                allowedTargetServerIds: ['server-a'],
            } as any);

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        expect(handleCreateSession).toBeTruthy();
        await handleCreateSession!();

        expect(captured.value).toBeNull();
        expect(executeSessionSpawnNewActionMock).not.toHaveBeenCalled();
        expect(applySettingsMock).toHaveBeenCalledWith({
            recentMachinePaths: [{ machineId: 'm1', path: '/tmp' }],
            lastUsedBackendTarget: { kind: 'backend', backendId: 'custom-kiro-preset', configuredBackendId: 'custom-kiro-preset', sourceKind: 'configured' },
        });
    });

    it('does not prepare account settings for an unrepresentable configured backend target', async () => {
        prepareAccountSettingsForDaemonSpawnMock.mockResolvedValue({ accountSettingsVersionHint: 14 });
        const { useCreateNewSession, captured } = await setupHarness();

        let handleCreateSession: null | (() => Promise<void>) = null;
        const settings = {
            experiments: false,
            lastUsedAgent: 'codex',
        } as unknown as Settings;
        const machineEnvPresence: UseMachineEnvPresenceResult = {
            isPreviewEnvSupported: false,
            isLoading: false,
            meta: {},
            refreshedAt: null,
            refresh: () => {},
        };

        function Test() {
            const hook = useCreateNewSession({
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
                agentType: 'customAcp',
                backendTarget: {
                    kind: 'backend',
                    backendId: 'custom-kiro-preset',
                    configuredBackendId: 'custom-kiro-preset',
                    sourceKind: 'configured',
                },
                permissionMode: 'default' as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore(''),
                resumeSessionId: '',
                agentNewSessionOptions: null,
                machineEnvPresence,
                secrets: [],
                secretBindingsByProfileId: {},
                selectedSecretIdByProfileIdByEnvVarName: {},
                sessionOnlySecretValueByProfileIdByEnvVarName: {},
                selectedMachineCapabilities: null,
                targetServerId: null,
                allowedTargetServerIds: ['server-a'],
            } as any);

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        expect(handleCreateSession).toBeTruthy();
        await handleCreateSession!();

        expect(prepareAccountSettingsForDaemonSpawnMock).not.toHaveBeenCalled();
        expect(captured.value).toBeNull();
        expect(executeSessionSpawnNewActionMock).not.toHaveBeenCalled();
        expect(captured.value).not.toEqual(expect.objectContaining({
            accountSettingsVersionHint: expect.any(Number),
        }));
    });

    it('retains recent-path selection while fail-closing an unrepresentable configured backend target', async () => {
        const { useCreateNewSession, captured } = await setupHarness();

        let handleCreateSession: null | (() => Promise<void>) = null;
        const settings = {
            experiments: false,
            lastUsedAgent: 'codex',
        } as unknown as Settings;
        const machineEnvPresence: UseMachineEnvPresenceResult = {
            isPreviewEnvSupported: false,
            isLoading: false,
            meta: {},
            refreshedAt: null,
            refresh: () => {},
        };

        function Test() {
            const hook = useCreateNewSession({
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
                recentMachinePaths: [
                    { machineId: 'm1', path: '/old/a' },
                    { machineId: 'm1', path: '/tmp' },
                    { machineId: 'm2', path: '/other' },
                ],
                agentType: 'customAcp',
                backendTarget: {
                    kind: 'backend',
                    backendId: 'custom-kiro-preset',
                    configuredBackendId: 'custom-kiro-preset',
                    sourceKind: 'configured',
                },
                permissionMode: 'default' as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore(''),
                resumeSessionId: '',
                agentNewSessionOptions: null,
                machineEnvPresence,
                secrets: [],
                secretBindingsByProfileId: {},
                selectedSecretIdByProfileIdByEnvVarName: {},
                sessionOnlySecretValueByProfileIdByEnvVarName: {},
                selectedMachineCapabilities: null,
                targetServerId: null,
                allowedTargetServerIds: ['server-a'],
            } as any);

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        expect(handleCreateSession).toBeTruthy();
        await handleCreateSession!();

        expect(applySettingsMock).toHaveBeenCalledWith({
            recentMachinePaths: [
                { machineId: 'm1', path: '/tmp' },
                { machineId: 'm1', path: '/old/a' },
                { machineId: 'm2', path: '/other' },
            ],
            lastUsedBackendTarget: {
                kind: 'backend',
                backendId: 'custom-kiro-preset',
                configuredBackendId: 'custom-kiro-preset',
                sourceKind: 'configured',
            },
        });
        expect(captured.value).toBeNull();
        expect(executeSessionSpawnNewActionMock).not.toHaveBeenCalled();
    });

    it('fails closed without private spawning for an unresolved plugin backend target', async () => {
        const { useCreateNewSession, captured } = await setupHarness();

        let handleCreateSession: null | (() => Promise<void>) = null;
        const settings = {
            experiments: false,
            lastUsedAgent: 'codex',
        } as unknown as Settings;
        const machineEnvPresence: UseMachineEnvPresenceResult = {
            isPreviewEnvSupported: false,
            isLoading: false,
            meta: {},
            refreshedAt: null,
            refresh: () => {},
        };

        function Test() {
            const hook = useCreateNewSession({
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
                agentType: 'claude',
                backendTarget: {
                    kind: 'backend',
                    backendId: 'acme.review.backend',
                },
                spawnBackendTarget: {
                    kind: 'backend',
                    backendId: 'acme.review.backend',
                },
                permissionMode: 'default' as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore(''),
                resumeSessionId: '',
                agentNewSessionOptions: null,
                machineEnvPresence,
                secrets: [],
                secretBindingsByProfileId: {},
                selectedSecretIdByProfileIdByEnvVarName: {},
                sessionOnlySecretValueByProfileIdByEnvVarName: {},
                selectedMachineCapabilities: null,
                targetServerId: null,
                allowedTargetServerIds: ['server-a'],
            } as any);

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        expect(handleCreateSession).toBeTruthy();
        await handleCreateSession!();

        expect(captured.value).toBeNull();
        expect(executeSessionSpawnNewActionMock).not.toHaveBeenCalled();
        expect(applySettingsMock).toHaveBeenCalledWith({
            recentMachinePaths: [{ machineId: 'm1', path: '/tmp' }],
            lastUsedBackendTarget: { kind: 'backend', backendId: 'acme.review.backend' },
        });
    });

    it('passes a configured ACP backend target into new-session automation template building', async () => {
        const { useCreateNewSession, createdAutomationTemplate } = await setupHarness();

        let handleCreateSession: null | (() => Promise<void>) = null;
        const settings = {
            experiments: false,
            lastUsedAgent: 'codex',
        } as unknown as Settings;
        const machineEnvPresence: UseMachineEnvPresenceResult = {
            isPreviewEnvSupported: false,
            isLoading: false,
            meta: {},
            refreshedAt: null,
            refresh: () => {},
        };

        function Test() {
            const hook = useCreateNewSession({
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
                agentType: 'customAcp',
                backendTarget: {
                    kind: 'backend',
                    backendId: 'custom-kiro-preset',
                    configuredBackendId: 'custom-kiro-preset',
                    sourceKind: 'configured',
                },
                permissionMode: 'default' as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore(''),
                resumeSessionId: '',
                agentNewSessionOptions: null,
                machineEnvPresence,
                secrets: [],
                secretBindingsByProfileId: {},
                selectedSecretIdByProfileIdByEnvVarName: {},
                sessionOnlySecretValueByProfileIdByEnvVarName: {},
                selectedMachineCapabilities: null,
                targetServerId: null,
                allowedTargetServerIds: ['server-a'],
                authoringDraft: buildNewSessionAuthoringDraft({
                    directory: '/tmp',
                    checkoutCreationDraft: null,
                    prompt: '',
                    displayText: '',
                    agentId: 'customAcp',
                    backendTarget: {
                        kind: 'backend',
                        backendId: 'custom-kiro-preset',
                        configuredBackendId: 'custom-kiro-preset',
                        sourceKind: 'configured',
                    },
                    transcriptStorage: null,
                    profileId: null,
                    environmentVariables: null,
                    resumeSessionId: null,
                    permissionMode: 'default',
                    permissionModeUpdatedAt: null,
                    modelId: null,
                    modelUpdatedAt: null,
                    mcpSelection: null,
                    connectedServices: null,
                    terminal: null,
                    windowsRemoteSessionLaunchMode: null,
                    windowsRemoteSessionConsole: null,
                    codexBackendMode: null,
                    acpSessionModeId: null,
                    sessionConfigOptionOverrides: null,
                    automation: {
                        pendingAutomationId: 'automation-configured-backend',
                        enabled: true,
                        name: 'Nightly',
                        description: '',
                        triggers: [{
                            clientId: 'trigger-configured-backend',
                            definition: {
                                kind: 'schedule',
                                enabled: true,
                                schedule: {
                                    kind: 'interval',
                                    everyMs: 60 * 60_000,
                                    scheduleExpr: null,
                                    timezone: null,
                                },
                            },
                        }],
                    },
                }),
            } as any);

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        expect(handleCreateSession).toBeTruthy();
        await handleCreateSession!();

        expect(createdAutomationTemplate.value).toEqual(expect.objectContaining({
            agent: 'codex',
            backendTarget: { kind: 'backend', backendId: 'custom-kiro-preset', configuredBackendId: 'custom-kiro-preset' },
        }));
    });

    it('retains the configured backend selection state when only legacy customAcp carriers remain', async () => {
        const { useCreateNewSession } = await setupHarness();

        let handleCreateSession: null | (() => Promise<void>) = null;
        const settings = {
            experiments: false,
            lastUsedAgent: 'customAcp',
        } as unknown as Settings;
        const machineEnvPresence: UseMachineEnvPresenceResult = {
            isPreviewEnvSupported: false,
            isLoading: false,
            meta: {},
            refreshedAt: null,
            refresh: () => {},
        };

        function Test() {
            const hook = useCreateNewSession({
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
                agentType: 'customAcp',
                backendTarget: {
                    kind: 'backend',
                    backendId: 'review-bot',
                    configuredBackendId: 'review-bot',
                    sourceKind: 'configured',
                },
                permissionMode: 'default' as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore(''),
                resumeSessionId: '',
                agentNewSessionOptions: null,
                machineEnvPresence,
                secrets: [],
                secretBindingsByProfileId: {},
                selectedSecretIdByProfileIdByEnvVarName: {},
                sessionOnlySecretValueByProfileIdByEnvVarName: {},
                selectedMachineCapabilities: null,
                targetServerId: null,
                allowedTargetServerIds: ['server-a'],
            } as any);

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        expect(handleCreateSession).toBeTruthy();
        await handleCreateSession!();

        expect(applySettingsMock).toHaveBeenCalledWith({
            recentMachinePaths: [{ machineId: 'm1', path: '/tmp' }],
            lastUsedBackendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot', sourceKind: 'configured' },
        });
    });

    it('does not enter the private first-turn follow-up path for an unrepresentable configured target', async () => {
        const {
            useCreateNewSession,
            routerReplaceSpy,
            resolveFollowUp,
            captured,
            storageState,
            ensureSessionVisibleForMessageRouteSpy,
        } = await setupHarness({
            deferFollowUp: true,
            spawnSuccess: true,
        });

        let handleCreateSession: null | (() => Promise<void>) = null;
        const disableDraftPersistence = vi.fn();
        const settings = {
            experiments: false,
            lastUsedAgent: 'codex',
        } as unknown as Settings;
        const machineEnvPresence: UseMachineEnvPresenceResult = {
            isPreviewEnvSupported: false,
            isLoading: false,
            meta: {},
            refreshedAt: null,
            refresh: () => {},
        };

        function Test() {
            const hook = useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
                router: { push: vi.fn(), replace: routerReplaceSpy },
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
                agentType: 'customAcp',
                backendTarget: {
                    kind: 'backend',
                    backendId: 'custom-kiro-preset',
                    configuredBackendId: 'custom-kiro-preset',
                    sourceKind: 'configured',
                },
                permissionMode: 'default' as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore('launch the session'),
                resumeSessionId: '',
                agentNewSessionOptions: null,
                machineEnvPresence,
                secrets: [],
                secretBindingsByProfileId: {},
                selectedSecretIdByProfileIdByEnvVarName: {},
                sessionOnlySecretValueByProfileIdByEnvVarName: {},
                selectedMachineCapabilities: null,
                targetServerId: null,
                allowedTargetServerIds: ['server-a'],
                disableDraftPersistence,
            } as any);

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        expect(handleCreateSession).toBeTruthy();
        const createPromise = handleCreateSession!();
        for (let attempt = 0; attempt < 40; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }

        expect(captured.value).toBeNull();
        expect(executeSessionSpawnNewActionMock).not.toHaveBeenCalled();
        expect(ensureSessionVisibleForMessageRouteSpy).not.toHaveBeenCalled();
        expect(routerReplaceSpy).not.toHaveBeenCalled();
        expect(storageState.upsertPendingMessage).not.toHaveBeenCalled();
        expect(clearNewSessionDraftMock).not.toHaveBeenCalled();
        expect(disableDraftPersistence).not.toHaveBeenCalled();

        resolveFollowUp();
        await createPromise;

        expect(storageState.upsertPendingMessage).not.toHaveBeenCalled();
        expect(routerReplaceSpy).not.toHaveBeenCalled();
        expect(clearNewSessionDraftMock).not.toHaveBeenCalled();
        expect(disableDraftPersistence).not.toHaveBeenCalled();
    });

    it('does not enter route hydration for an unrepresentable configured backend target', async () => {
        const {
            useCreateNewSession,
            routerReplaceSpy,
            resolveFollowUp,
            captured,
            storageState,
            ensureSessionVisibleForMessageRouteSpy,
        } = await setupHarness({
            deferFollowUp: true,
            spawnSuccess: true,
        });
        ensureSessionVisibleForMessageRouteSpy
            .mockImplementationOnce(async (sessionId) => ({
                kind: 'retryable_failure',
                sessionId,
                cause: 'network',
            }))
            .mockImplementation(async (sessionId) => {
                storageState.sessions[sessionId] = {
                    id: sessionId,
                    active: true,
                };
                return { kind: 'available', sessionId };
            });

        let handleCreateSession: null | (() => Promise<void>) = null;
        const settings = {
            experiments: false,
            lastUsedAgent: 'codex',
        } as unknown as Settings;
        const machineEnvPresence: UseMachineEnvPresenceResult = {
            isPreviewEnvSupported: false,
            isLoading: false,
            meta: {},
            refreshedAt: null,
            refresh: () => {},
        };

        function Test() {
            const hook = useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
                router: { push: vi.fn(), replace: routerReplaceSpy },
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
                agentType: 'customAcp',
                backendTarget: {
                    kind: 'backend',
                    backendId: 'custom-kiro-preset',
                    configuredBackendId: 'custom-kiro-preset',
                    sourceKind: 'configured',
                },
                permissionMode: 'default' as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore('launch the session'),
                resumeSessionId: '',
                agentNewSessionOptions: null,
                machineEnvPresence,
                secrets: [],
                secretBindingsByProfileId: {},
                selectedSecretIdByProfileIdByEnvVarName: {},
                sessionOnlySecretValueByProfileIdByEnvVarName: {},
                selectedMachineCapabilities: null,
                targetServerId: 'server-a',
                allowedTargetServerIds: ['server-a'],
            } as any);

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        expect(handleCreateSession).toBeTruthy();
        const createPromise = handleCreateSession!();
        for (let attempt = 0; attempt < 40; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }

        expect(routerReplaceSpy).not.toHaveBeenCalled();
        expect(storageState.upsertPendingMessage).not.toHaveBeenCalled();

        resolveFollowUp();
        await createPromise;

        expect(captured.value).toBeNull();
        expect(executeSessionSpawnNewActionMock).not.toHaveBeenCalled();
        expect(storageState.markSessionOptimisticThinking).not.toHaveBeenCalled();
        expect(storageState.upsertPendingMessage).not.toHaveBeenCalled();
        expect(routerReplaceSpy).not.toHaveBeenCalled();
    });

    it('writes the canonical Codex runtime descriptor into automation templates', async () => {
        const { useCreateNewSession, createdAutomationTemplate } = await setupHarness();

        const { buildSpawnSessionExtrasFromUiState } = await import('@/agents/catalog/catalog');
        (buildSpawnSessionExtrasFromUiState as any).mockReturnValue({
            runtimeDescriptorV1: {
                v: 1,
                agentId: 'codex',
                agent: { backendMode: 'appServer' },
            },
        });

        let handleCreateSession: null | (() => Promise<void>) = null;
        const settings = { codexBackendMode: 'appServer' } as unknown as Settings;
        const machineEnvPresence: UseMachineEnvPresenceResult = {
            isPreviewEnvSupported: false,
            isLoading: false,
            meta: {},
            refreshedAt: null,
            refresh: () => {},
        };

        function Test() {
            const hook = useCreateNewSession({
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
                agentType: 'codex',
                backendTarget: { kind: 'backend', backendId: 'codex' },
                permissionMode: 'default' as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore('Review the repo'),
                resumeSessionId: '',
                agentNewSessionOptions: { experimentalCodexAcp: false },
                machineEnvPresence,
                secrets: [],
                secretBindingsByProfileId: {},
                selectedSecretIdByProfileIdByEnvVarName: {},
                sessionOnlySecretValueByProfileIdByEnvVarName: {},
                selectedMachineCapabilities: null,
                targetServerId: null,
                allowedTargetServerIds: ['server-a'],
                authoringDraft: buildNewSessionAuthoringDraft({
                    directory: '/tmp',
                    checkoutCreationDraft: null,
                    prompt: 'Review the repo',
                    displayText: 'Review the repo',
                    agentId: 'codex',
                    backendTarget: { kind: 'backend', backendId: 'codex' },
                    transcriptStorage: null,
                    profileId: null,
                    environmentVariables: null,
                    resumeSessionId: null,
                    permissionMode: 'default',
                    permissionModeUpdatedAt: null,
                    modelId: null,
                    modelUpdatedAt: null,
                    mcpSelection: null,
                    connectedServices: null,
                    terminal: null,
                    windowsRemoteSessionLaunchMode: null,
                    windowsRemoteSessionConsole: null,
                    codexBackendMode: 'appServer',
                    acpSessionModeId: null,
                    sessionConfigOptionOverrides: null,
                    automation: {
                        pendingAutomationId: 'automation-codex-runtime',
                        enabled: true,
                        name: 'Nightly',
                        description: '',
                        triggers: [{
                            clientId: 'trigger-codex-runtime',
                            definition: {
                                kind: 'schedule',
                                enabled: true,
                                schedule: {
                                    kind: 'interval',
                                    everyMs: 60 * 60_000,
                                    scheduleExpr: null,
                                    timezone: null,
                                },
                            },
                        }],
                    },
                }),
            } as any);

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        expect(handleCreateSession).toBeTruthy();
        await handleCreateSession!();

        expect(createdAutomationTemplate.value).toEqual(expect.objectContaining({
            backendTarget: { kind: 'backend', backendId: 'codex' },
            runtimeDescriptorV1: {
                v: 1,
                agentId: 'codex',
                agent: { backendMode: 'appServer' },
            },
        }));
        expect(createdAutomationTemplate.value).not.toHaveProperty('codexBackendMode');
        expect(createdAutomationTemplate.value).not.toHaveProperty('experimentalCodexAcp');
    });
});
