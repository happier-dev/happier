import React from 'react';
import { createNewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { buildNewSessionAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import type { PermissionMode, ModelMode } from '@/sync/domains/permissions/permissionTypes';
import type { Settings } from '@/sync/domains/settings/settings';
import type { NewSessionAutomationDraft } from '@/sync/domains/automations/automationDraft';
import type { UseMachineEnvPresenceResult } from '@/hooks/machine/useMachineEnvPresence';
import { normalizeSessionAuthoringConnectedServices } from '@/sync/domains/sessionAuthoring/sessionAuthoringNormalization';
import {
    buildBackendTargetKey,
    buildMentionRefForKindV1,
    MENTION_KIND_V1,
    SessionModelSelectionV1Schema,
    type SessionMcpSelectionV1,
    type SessionSpawnNewInputV2,
    type SessionSpawnNewResultV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { AIBackendProfileSchema } from '@/sync/domains/profiles/profileCompatibility';
import { renderScreen } from '@/dev/testkit';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import type { AutomationEditorDraft } from '@/sync/domains/automations/automationEditorDraft';
import type { ServerScopedMachineRpcParams } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';
import type {
    HandleCreateSessionOptions,
    NewSessionAfterCreatedSettlement,
} from './useCreateNewSession';

import { installNewSessionScreenModelCommonModuleMocks } from './newSessionScreenModelTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function invokeHandleCreateSession(
    handleCreateSession: null | ((options?: HandleCreateSessionOptions) => void),
    options?: HandleCreateSessionOptions,
): Promise<void> {
    // The UI handler intentionally exposes a void callback to production callers,
    // while its async implementation remains observable to this hook test.
    await Promise.resolve(handleCreateSession?.(options));
}

const routerSearchParamsState = vi.hoisted(() => ({
    value: {} as Record<string, string | string[] | undefined>,
}));

const accountEncryptionModeMock = vi.hoisted(() => ({
    value: 'e2ee' as 'plain' | 'e2ee',
    fetchAccountEncryptionMode: vi.fn<() => Promise<{
        mode: 'plain' | 'e2ee';
        updatedAt: number;
    }>>(),
}));

vi.mock('@/sync/api/account/apiAccountEncryptionMode', () => ({
    // Account encryption currentness crosses the network boundary; every
    // session-writer test must use this deterministic boundary double.
    fetchAccountEncryptionMode: accountEncryptionModeMock.fetchAccountEncryptionMode,
}));

type SpawnPayloadCapture = SessionSpawnNewInputV2 | null;
type SessionSpawnNewRpcRequest = ServerScopedMachineRpcParams<SessionSpawnNewInputV2>;
type SessionSpawnNewSuccessResult = Extract<SessionSpawnNewResultV1, Readonly<{ type: 'success' }>>;

type AutomationEditorSaveCapture = AutomationEditorDraft | null;

function createScheduleAutomationDraft(params: Readonly<{
    name: string;
    description?: string;
    everyMinutes?: number;
}>): NewSessionAutomationDraft {
    return {
        pendingAutomationId: 'automation-11111111-1111-4111-8111-111111111111',
        enabled: true,
        name: params.name,
        description: params.description ?? '',
        triggers: [{
            clientId: '22222222-2222-4222-8222-222222222222',
            definition: {
                kind: 'schedule',
                enabled: true,
                schedule: {
                    kind: 'interval',
                    everyMs: (params.everyMinutes ?? 15) * 60_000,
                    scheduleExpr: null,
                    timezone: null,
                },
            },
        }],
    };
}

function buildAutomationAuthoringDraft(params: Readonly<{
    prompt: string;
    modelMode: ModelMode;
    permissionMode: PermissionMode;
    permissionModeUpdatedAt?: number | null;
    backendTarget?: Readonly<{ kind: 'backend'; backendId: string }> | null;
    automation: NewSessionAutomationDraft;
    connectedServices?: unknown;
    mcpSelection?: SessionMcpSelectionV1 | null;
    transcriptStorage?: 'persisted' | 'direct' | null;
    checkoutCreationDraft?: {
        kind: 'git_worktree';
        displayName: string;
        baseRef: string | null;
    } | null;
    acpSessionModeId?: string | null;
}>){
    return buildNewSessionAuthoringDraft({
        directory: '/tmp',
        checkoutCreationDraft: params.checkoutCreationDraft ?? null,
        prompt: params.prompt,
        displayText: params.prompt,
        agentId: 'codex',
        backendTarget: params.backendTarget ?? null,
        transcriptStorage: params.transcriptStorage ?? null,
        profileId: null,
        environmentVariables: null,
        resumeSessionId: null,
        permissionMode: params.permissionMode,
        permissionModeUpdatedAt: params.permissionModeUpdatedAt ?? null,
        modelId: params.modelMode === 'default' ? null : params.modelMode,
        modelUpdatedAt: null,
        mcpSelection: params.mcpSelection ?? null,
        connectedServices: normalizeSessionAuthoringConnectedServices(params.connectedServices ?? null),
        terminal: null,
        windowsRemoteSessionLaunchMode: null,
        windowsRemoteSessionConsole: null,
        acpSessionModeId: params.acpSessionModeId ?? null,
        sessionConfigOptionOverrides: null,
        automation: params.automation,
    });
}

async function setupUseCreateNewSessionHarness() {
    const captured: { value: SpawnPayloadCapture } = { value: null };
    const sessionSpawnNewRpcRequest: { value: SessionSpawnNewRpcRequest | null } = { value: null };
    const buildSpawnEnvironmentVariablesCapture: { value: Record<string, unknown> | null } = { value: null };
    const automationCaptured: { value: AutomationEditorSaveCapture } = { value: null };
    const saveAutomationEditorDraftSpy = vi.fn(async (draft: AutomationEditorDraft) => {
        automationCaptured.value = draft;
        return { automationId: draft.automationId ?? draft.pendingAutomationId ?? 'automation-created' };
    });
    const accountEncryptionMode = accountEncryptionModeMock;
    accountEncryptionMode.value = 'e2ee';
    accountEncryptionMode.fetchAccountEncryptionMode.mockReset();
    accountEncryptionMode.fetchAccountEncryptionMode.mockImplementation(async () => ({
        mode: accountEncryptionMode.value,
        updatedAt: 1,
    }));
    const sessions: Record<string, { id: string }> = {};
    const encryptRawSpy = vi.fn(async (value: unknown) => {
        return `cipher:${Buffer.from(JSON.stringify(value)).toString('base64')}`;
    });
    const modalAlertSpy = vi.fn((..._args: unknown[]) => {});
    const modalConfirmSpy = vi.fn(async () => false);
    const clearNewSessionDraftSpy = vi.fn();
    const setActiveServerSpy = vi.fn((..._args: unknown[]) => {});
    const switchConnectionToActiveServerSpy = vi.fn(async (..._args: unknown[]) => ({ token: 'next-token', secret: 'next-secret' }));
    const refreshMachinesSpy = vi.fn(async () => {});
    const refreshSessionsSpy = vi.fn(async () => {});
    const ensureSessionVisibleForMessageRouteSpy = vi.fn(async (sessionId: string) => {
        sessions[sessionId] ??= { id: sessionId };
        return { kind: 'available' };
    });
    const refreshAutomationsSpy = vi.fn(async () => {});
    const applySettingsSpy = vi.fn((..._args: unknown[]) => {});
    const upsertPendingMessageSpy = vi.fn();
    const markSessionOptimisticThinkingSpy = vi.fn();
    const saveSessionDraftsSpy = vi.fn();
    const getMachineCapabilitiesSnapshotSpy = vi.fn(() => ({ supported: true, response: { protocolVersion: 1, results: {} } }));
    const prefetchMachineCapabilitiesSpy = vi.fn(async () => {});
    const captureExceptionIfEnabledSpy = vi.fn();
    const syncSendMessageSpy = vi.fn<(...args: unknown[]) => Promise<void>>(async (..._args: unknown[]) => {});
    const materializeNewSessionCheckoutSpy = vi.fn(async () => ({
        success: true as const,
        path: '/tmp/materialized-worktree',
        sessionPath: '/tmp/materialized-worktree',
        repositoryRootPath: '/tmp/materialized-worktree',
    }));
    const captureSessionSpawnNewRequest = (request: SessionSpawnNewRpcRequest): void => {
        sessionSpawnNewRpcRequest.value = request;
        captured.value = request.payload;
    };
    const sessionSpawnNewRpcSpy = vi.fn(async (request: SessionSpawnNewRpcRequest): Promise<SessionSpawnNewResultV1> => {
        captureSessionSpawnNewRequest(request);
        return { type: 'error', code: 'spawn_failed', retryable: false };
    });
    const executeSessionSpawnNewActionSpy = vi.fn(async (input: SessionSpawnNewInputV2) => ({
        ok: true as const,
        result: await sessionSpawnNewRpcSpy({
            serverId: input.executionTarget.serverId,
            machineId: input.executionTarget.machineId,
            method: RPC_METHODS.SESSION_SPAWN_NEW,
            payload: input,
        }),
    }));
    const mockSessionSpawnSuccess = (sessionId: string): void => {
        sessionSpawnNewRpcSpy.mockImplementationOnce(async (
            request: SessionSpawnNewRpcRequest,
        ): Promise<SessionSpawnNewSuccessResult> => {
            captureSessionSpawnNewRequest(request);
            return {
                type: 'success',
                disposition: 'created',
                sessionId,
                executionTarget: request.payload.executionTarget,
                organizationPlacement: request.payload.organizationPlacement ?? { folderId: null, tagIds: [] },
                initialInput: request.payload.initialInput
                    ? { status: 'accepted', localId: `input-${sessionId}` }
                    : { status: 'notRequested' },
            };
        });
    };
    const machineBashSpy = vi.fn<(...args: unknown[]) => Promise<{
        success: boolean;
        stderr: string;
        stdout: string;
        exitCode: number;
    }>>(async () => ({
        success: true,
        stderr: '',
        stdout: '',
        exitCode: 0,
    }));

    installNewSessionScreenModelCommonModuleMocks({
        // The default testkit translate renders `key(param=value)`, so an alert
        // that names WHICH reference it refused stays observable here. A key
        // called without params still renders as the bare key.
        text: () => createTextModuleMock(),
        routerConfig: {
            router: {
                push: vi.fn(),
                replace: vi.fn(),
                back: vi.fn(),
                setParams: vi.fn(),
            },
            params: () => routerSearchParamsState.value,
            navigation: {},
            pathname: '/new',
        },
    });
    vi.doMock('@/modal', () => ({
        Modal: {
            alert: modalAlertSpy,
            confirm: modalConfirmSpy,
        },
    }));
    vi.doMock('@/sync/domains/state/storage', () => ({
        storage: {
            getState: () => ({
                settings: {},
                machines: { m1: { id: 'm1' } },
                sessions,
                updateSessionPermissionMode: vi.fn(),
                updateSessionModelMode: vi.fn(),
                upsertPendingMessage: upsertPendingMessageSpy,
                markSessionOptimisticThinking: markSessionOptimisticThinkingSpy,
            }),
        },
    }));
    vi.doMock('@/sync/sync', () => ({
        sync: {
            applySettings: vi.fn(),
            saveAutomationEditorDraft: saveAutomationEditorDraftSpy,
            getCredentials: vi.fn(() => ({ token: 't' })),
            encryption: {
                encryptRaw: encryptRawSpy,
                encryptAutomationTemplateRaw: encryptRawSpy,
            },
            decryptSecretValue: vi.fn(),
            refreshAutomations: refreshAutomationsSpy,
            refreshSessions: refreshSessionsSpy,
            ensureSessionVisibleForMessageRoute: ensureSessionVisibleForMessageRouteSpy,
            refreshMachines: refreshMachinesSpy,
            sendMessage: syncSendMessageSpy,
            acquireUserRequestLease: vi.fn(() => vi.fn()),
        },
    }));
    vi.doMock('@/sync/store/settingsWriters', () => ({
        useApplySettings: () => applySettingsSpy,
    }));
    vi.doMock('@/sync/http/client', () => ({
        serverFetch: vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({ mode: accountEncryptionMode.value, updatedAt: 1 }),
        })),
    }));
    vi.doMock('@/sync/domains/state/persistence', () => ({
        clearNewSessionDraft: clearNewSessionDraftSpy,
        loadChangesCursor: () => null,
        loadDeviceAnalyticsId: () => null,
        loadLastChangesCursorByAccountId: () => ({}),
        loadNewSessionDraft: () => null,
        loadPendingSettings: () => ({}),
        loadProfile: () => ({}),
        loadSessionActionDrafts: () => ({}),
        loadSessionDrafts: () => ({}),
        loadSessionLastViewed: () => ({}),
        loadSessionMaterializedMaxSeqById: () => ({}),
        loadSessionModelModes: () => ({}),
        loadSessionModelModeUpdatedAts: () => ({}),
        loadSessionPermissionModes: () => ({}),
        loadSessionPermissionModeUpdatedAts: () => ({}),
        loadSessionReviewCommentsDrafts: () => ({}),
        loadWorkspaceReviewCommentsDrafts: () => ({}),
        loadSettings: () => ({ settings: {}, version: null }),
        loadThemePreference: () => 'adaptive',
        saveChangesCursor: vi.fn(),
        saveDeviceAnalyticsId: vi.fn(),
        saveLastChangesCursorByAccountId: vi.fn(),
        saveSettings: vi.fn(),
        saveNewSessionDraft: vi.fn(),
        loadLocalSettings: () => ({}),
        saveLocalSettings: vi.fn(),
        loadPurchases: () => ({}),
        savePurchases: vi.fn(),
        savePendingSettings: vi.fn(),
        saveProfile: vi.fn(),
        saveSessionActionDrafts: vi.fn(),
        saveSessionDrafts: saveSessionDraftsSpy,
        saveSessionLastViewed: vi.fn(),
        saveSessionMaterializedMaxSeqById: vi.fn(),
        saveSessionModelModes: vi.fn(),
        saveSessionModelModeUpdatedAts: vi.fn(),
        saveSessionPermissionModes: vi.fn(),
        saveSessionPermissionModeUpdatedAts: vi.fn(),
        saveSessionReviewCommentsDrafts: vi.fn(),
        saveWorkspaceReviewCommentsDrafts: vi.fn(),
        clearPersistence: vi.fn(),
    }));
    vi.doMock('@/sync/domains/server/serverRuntime', () => ({
        getActiveServerSnapshot: vi.fn(() => ({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            kind: 'custom',
            generation: 1,
        })),
        setActiveServer: setActiveServerSpy,
    }));
    const { storage: scopeStorage } = await import('@/sync/domains/state/storageStore');
    // Automation authoring captures the same canonical Account lifetime that owns
    // stored-content availability. The test server and credential fixtures
    // above are both for server-a/account-a, so mount that scope through the
    // incumbent store owner instead of registering a test-only reader.
    scopeStorage.setState({ profileScope: { serverId: 'server-a', accountId: 'account-a' } });
    vi.doMock('@/sync/domains/server/selection/serverSelectionResolver', () => ({
        resolveNewSessionServerTarget: vi.fn((params: { requestedServerId?: string | null; allowedServerIds: string[] }) => ({
            targetServerId:
                params.requestedServerId && params.allowedServerIds.includes(params.requestedServerId)
                    ? params.requestedServerId
                    : params.allowedServerIds[0] ?? null,
            rejectedRequestedServerId:
                params.requestedServerId && !params.allowedServerIds.includes(params.requestedServerId)
                    ? params.requestedServerId
                    : null,
        })),
    }));
    vi.doMock('@/sync/domains/profiles/profileUtils', () => ({
        getBuiltInProfile: vi.fn(() => null),
    }));
    vi.doMock('@/sync/domains/features/featureLocalPolicy', () => ({
        resolveLocalFeaturePolicyEnabled: vi.fn((featureId: string, settings: { featureToggles?: Record<string, boolean> }) => settings.featureToggles?.[featureId] === true),
    }));
    vi.doMock('@/utils/system/sentry', () => ({
        captureExceptionIfEnabled: captureExceptionIfEnabledSpy,
    }));
    vi.doMock('@/sync/runtime/orchestration/connectionManager', () => ({
        switchConnectionToActiveServer: switchConnectionToActiveServerSpy,
    }));
    vi.doMock('@/sync/domains/settings/terminalSettings', () => ({
        resolveTerminalSpawnOptions: vi.fn(() => null),
    }));
    vi.doMock('@/hooks/server/useMachineCapabilitiesCache', () => ({
        getMachineCapabilitiesSnapshot: getMachineCapabilitiesSnapshotSpy,
        prefetchMachineCapabilities: prefetchMachineCapabilitiesSpy,
    }));
    vi.doMock('@/agents/catalog/catalog', () => ({
        AGENT_IDS: ['codex', 'claude', 'opencode'],
        isBundledAgentId: (value: unknown) => value === 'codex' || value === 'claude' || value === 'opencode',
        DEFAULT_AGENT_ID: 'codex',
        getAgentCore: vi.fn((agentType: string) => {
            if (agentType === 'opencode') {
                return { model: { supportsSelection: true, nonAcpApplyScope: 'next_prompt' } };
            }

            return { model: { supportsSelection: true, nonAcpApplyScope: 'spawn_only' } };
        }),
        buildSpawnEnvironmentVariablesFromUiState: vi.fn((opts: { environmentVariables?: Record<string, string> }) => {
            buildSpawnEnvironmentVariablesCapture.value = opts as Record<string, unknown>;
            return opts.environmentVariables;
        }),
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
        machineBash: (...args: unknown[]) => machineBashSpy(...args),
    }));
    vi.doMock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
        machineRpcWithServerScope: (request: SessionSpawnNewRpcRequest) => sessionSpawnNewRpcSpy(request),
    }));
    vi.doMock('@/sync/ops/actions/sessionSpawnNewAction', () => ({
        buildManualSessionCreationKey: (userAttemptId: string) => `manual:${userAttemptId}`,
        executeManualSessionSpawnNewAction: async (input: any, _context: unknown, params: any) => ({
            status: 'executed',
            action: await executeSessionSpawnNewActionSpy(input),
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
        executeSessionSpawnNewAction: (input: SessionSpawnNewInputV2) => executeSessionSpawnNewActionSpy(input),
        resolveSessionSpawnNewActionFailureMessageKey: () => 'newSession.actionMethodUnavailable',
        resolveSessionSpawnNewResultFailureMessageKey: () => 'newSession.failedToStart',
    }));
    vi.doMock('@/components/sessions/new/modules/materializeNewSessionCheckout', () => ({
        materializeNewSessionCheckout: materializeNewSessionCheckoutSpy,
    }));
    const { useCreateNewSession: useCreateNewSessionOwner } = await import('./useCreateNewSession');
    const useCreateNewSession: typeof useCreateNewSessionOwner = (params) => useCreateNewSessionOwner({
        ...params,
        draftScope: params.draftScope ?? { serverId: 'server-a', accountId: 'account-a' },
    });
    return {
        useCreateNewSession,
        setLocalSearchParams(nextParams: Record<string, string | string[] | undefined>) {
            routerSearchParamsState.value = { ...nextParams };
        },
        captured,
        buildSpawnEnvironmentVariablesCapture,
        automationCaptured,
        saveAutomationEditorDraftSpy,
        modalAlertSpy,
        clearNewSessionDraftSpy,
        refreshAutomationsSpy,
        upsertPendingMessageSpy,
        markSessionOptimisticThinkingSpy,
        saveSessionDraftsSpy,
        applySettingsSpy,
        materializeNewSessionCheckoutSpy,
        getMachineCapabilitiesSnapshotSpy,
        prefetchMachineCapabilitiesSpy,
        captureExceptionIfEnabledSpy,
        syncSendMessageSpy,
        sessionSpawnNewRpcSpy,
        sessionSpawnNewRpcRequest,
        mockSessionSpawnSuccess,
    };
}

describe('useCreateNewSession permission seeding', () => {
    beforeEach(() => {
        vi.resetModules();
        routerSearchParamsState.value = {};
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('passes a canonical permission mode and timestamp into the strict Action request', async () => {
        const { useCreateNewSession, captured } = await setupUseCreateNewSessionHarness();

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
                permissionMode: 'acceptEdits' as unknown as PermissionMode,
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
                targetServerId: 'server-b',
                allowedTargetServerIds: ['server-a', 'server-b'],
            });

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        await act(async () => {
            await handleCreateSession?.();
        });

        expect(captured.value).not.toBeNull();
        expect(captured.value?.permissionMode).toBe('safe-yolo');
        expect(typeof captured.value?.configuration?.permissionIntent.updatedAtMs).toBe('number');
        expect(Number.isFinite(captured.value?.configuration?.permissionIntent.updatedAtMs)).toBe(true);
        expect((captured.value?.configuration?.permissionIntent.updatedAtMs ?? 0)).toBeGreaterThan(0);
    });

    it('preserves persisted last-used agent settings when the draft has no canonical backendTarget', async () => {
        const { useCreateNewSession, applySettingsSpy } = await setupUseCreateNewSessionHarness();

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
                agentType: 'codex',
                permissionMode: 'acceptEdits' as unknown as PermissionMode,
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
            });

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        await act(async () => {
            await handleCreateSession?.();
        });

        expect(applySettingsSpy).toHaveBeenCalled();
        const settingsUpdate = applySettingsSpy.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined;
        expect(settingsUpdate).toEqual(expect.objectContaining({
            recentMachinePaths: [{ machineId: 'm1', path: '/tmp' }],
        }));
        expect(settingsUpdate).not.toHaveProperty('lastUsedAgent');
        expect(settingsUpdate).not.toHaveProperty('lastUsedBackendTarget');
    });

    it('passes resumeSessionId through without pre-spawn capability probing', async () => {
        const { useCreateNewSession, captured, prefetchMachineCapabilitiesSpy } = await setupUseCreateNewSessionHarness();

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
                agentType: 'opencode' as any,
                permissionMode: 'default' as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore(''),
                resumeSessionId: 'sess_old',
                agentNewSessionOptions: null,
                machineEnvPresence,
                secrets: [],
                secretBindingsByProfileId: {},
                selectedSecretIdByProfileIdByEnvVarName: {},
                sessionOnlySecretValueByProfileIdByEnvVarName: {},
                selectedMachineCapabilities: null,
                targetServerId: 'server-b',
                allowedTargetServerIds: ['server-a', 'server-b'],
            });

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        await act(async () => {
            await handleCreateSession?.();
        });

        expect(captured.value?.configuration?.providerSessionResume?.providerSessionId).toBe('sess_old');
        expect(prefetchMachineCapabilitiesSpy).toHaveBeenCalledTimes(0);
    });

    it('includes the selected model and initial message in the strict Action request', async () => {
        const {
            useCreateNewSession,
            captured,
            mockSessionSpawnSuccess,
            syncSendMessageSpy,
        } = await setupUseCreateNewSessionHarness();

        mockSessionSpawnSuccess('sess_target');

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
                agentType: 'opencode' as any,
                permissionMode: 'default' as PermissionMode,
                modelMode: 'gpt' as any,
                promptStore: createNewSessionPromptStore('hello'),
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
            });

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        await act(async () => {
            await handleCreateSession?.();
        });

        expect(captured.value).toEqual(expect.objectContaining({
            initialInput: { text: 'hello' },
            configuration: expect.objectContaining({
                model: expect.objectContaining({ value: 'gpt' }),
            }),
        }));
        expect(syncSendMessageSpy).not.toHaveBeenCalled();
    });

    it('uses canonical provider selection in the strict Action request when presentation mode is Automatic', async () => {
        const {
            useCreateNewSession,
            captured,
            mockSessionSpawnSuccess,
            syncSendMessageSpy,
        } = await setupUseCreateNewSessionHarness();

        mockSessionSpawnSuccess('sess_target');

        let handleCreateSession: null | (() => Promise<void>) = null;
        const settings = { experiments: false } as unknown as Settings;
        const machineEnvPresence: UseMachineEnvPresenceResult = {
            isPreviewEnvSupported: false,
            isLoading: false,
            meta: {},
            refreshedAt: null,
            refresh: () => {},
        };
        const authoringDraft = buildNewSessionAuthoringDraft({
            directory: '/tmp',
            checkoutCreationDraft: null,
            prompt: 'hello',
            displayText: 'hello',
            agentId: 'opencode',
            backendTarget: { kind: 'backend', backendId: 'opencode' },
            transcriptStorage: null,
            profileId: null,
            environmentVariables: null,
            resumeSessionId: null,
            permissionMode: 'default',
            permissionModeUpdatedAt: null,
            modelSelection: SessionModelSelectionV1Schema.parse({
                v: 1,
                updatedAt: 456,
                ref: {
                    agentTargetKey: 'backend:opencode',
                    providerConnectionId: 'pc_openrouter',
                    modelId: 'default',
                },
            }),
            mcpSelection: null,
            connectedServices: null,
            terminal: null,
            windowsRemoteSessionLaunchMode: null,
            windowsRemoteSessionConsole: null,
            acpSessionModeId: null,
            sessionConfigOptionOverrides: null,
            automation: null,
        });

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
                agentType: 'opencode' as any,
                permissionMode: 'default' as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore('hello'),
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
                authoringDraft,
            });

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));
        await act(async () => {
            await handleCreateSession?.();
        });

        expect(captured.value).toEqual(expect.objectContaining({
            initialInput: { text: 'hello' },
            modelSelection: authoringDraft.modelSelection,
        }));
        expect(syncSendMessageSpy).not.toHaveBeenCalled();
    });

    it('runs local slash actions for the created session without sending the slash text as the first message', async () => {
        const {
            useCreateNewSession,
            captured,
            mockSessionSpawnSuccess,
            syncSendMessageSpy,
        } = await setupUseCreateNewSessionHarness();

        mockSessionSpawnSuccess('sess_runs');

        let handleCreateSession: null | (() => Promise<void>) = null;
        const settings = { experiments: false, featureToggles: { 'execution.runs': true } } as unknown as Settings;
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
                agentType: 'codex' as any,
                permissionMode: 'default' as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore('/h.runs'),
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
            });

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        await act(async () => {
            await handleCreateSession?.();
        });

        expect(captured.value?.initialInput).toBeUndefined();
        expect(syncSendMessageSpy).not.toHaveBeenCalled();
    });

    it('passes connectedServices bindings into the strict Action request when provided', async () => {
        const { useCreateNewSession, captured } = await setupUseCreateNewSessionHarness();

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
                permissionMode: 'acceptEdits' as unknown as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore(''),
                resumeSessionId: '',
                agentNewSessionOptions: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            anthropic: { source: 'connected', profileId: 'work' },
                        },
                    },
                },
                machineEnvPresence,
                secrets: [],
                secretBindingsByProfileId: {},
                selectedSecretIdByProfileIdByEnvVarName: {},
                sessionOnlySecretValueByProfileIdByEnvVarName: {},
                selectedMachineCapabilities: null,
                targetServerId: 'server-b',
                allowedTargetServerIds: ['server-a', 'server-b'],
            });

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        await act(async () => {
            await handleCreateSession?.();
        });

        expect(captured.value).not.toBeNull();
        expect(captured.value?.connectedServices).toEqual({
            v: 1,
            bindingsByServiceId: {
                anthropic: { source: 'connected', selection: 'profile', profileId: 'work' },
            },
        });
    });

    it('passes mcpSelection into the strict Action request when provided', async () => {
        const { useCreateNewSession, captured } = await setupUseCreateNewSessionHarness();

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
                permissionMode: 'default' as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore(''),
                resumeSessionId: '',
                agentNewSessionOptions: null,
                mcpSelection: {
                    v: 1,
                    managedServersEnabled: false,
                    forceIncludeServerIds: ['server-portable'],
                    forceExcludeServerIds: [],
                },
                machineEnvPresence,
                secrets: [],
                secretBindingsByProfileId: {},
                selectedSecretIdByProfileIdByEnvVarName: {},
                sessionOnlySecretValueByProfileIdByEnvVarName: {},
                selectedMachineCapabilities: null,
                targetServerId: null,
                allowedTargetServerIds: ['server-a'],
            });

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        await act(async () => {
            await handleCreateSession?.();
        });

        expect(captured.value?.mcpSelection).toEqual({
            v: 1,
            managedServersEnabled: false,
            forceIncludeServerIds: ['server-portable'],
            forceExcludeServerIds: [],
        });
    });

    it('passes transcriptStorage through to the strict Action request when requested', async () => {
        const { useCreateNewSession, captured } = await setupUseCreateNewSessionHarness();

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
                permissionMode: 'default' as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore(''),
                transcriptStorage: 'direct',
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

        await act(async () => {
            await handleCreateSession?.();
        });

        expect(captured.value?.transcriptStorage).toBe('direct');
    });

    it('routes spawn to the target server without switching global active server', async () => {
        const {
            useCreateNewSession,
            getMachineCapabilitiesSnapshotSpy,
            captured,
            buildSpawnEnvironmentVariablesCapture,
            sessionSpawnNewRpcRequest,
        } = await setupUseCreateNewSessionHarness();

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
                permissionMode: 'acceptEdits' as unknown as PermissionMode,
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
                targetServerId: 'server-b',
                allowedTargetServerIds: ['server-a', 'server-b'],
            });

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        await act(async () => {
            await handleCreateSession?.();
        });

        expect(captured.value?.executionTarget.serverId).toBe('server-b');
        expect(sessionSpawnNewRpcRequest.value).toEqual(expect.objectContaining({
            serverId: 'server-b',
            machineId: 'm1',
            method: RPC_METHODS.SESSION_SPAWN_NEW,
            payload: expect.objectContaining({
                executionTarget: { serverId: 'server-b', machineId: 'm1' },
            }),
        }));
        expect(getMachineCapabilitiesSnapshotSpy).toHaveBeenCalledWith('m1', 'server-b');
        expect(buildSpawnEnvironmentVariablesCapture.value).toMatchObject({
            newSessionOptions: {
                targetServerId: 'server-b',
            },
        });
    });

    it('falls back to active server when targetServerId is outside the allowed target server IDs', async () => {
        const {
            useCreateNewSession,
            modalAlertSpy,
            captured,
        } = await setupUseCreateNewSessionHarness();

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
                permissionMode: 'acceptEdits' as unknown as PermissionMode,
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
                targetServerId: 'server-c',
                allowedTargetServerIds: ['server-a'],
            });

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        await act(async () => {
            await handleCreateSession?.();
        });

        expect(modalAlertSpy).not.toHaveBeenCalledWith('common.error', 'newSession.serverSelectionUnavailable');
        expect(captured.value).not.toBeNull();
        expect(captured.value?.executionTarget.serverId).toBe('server-a');
    });

    it('admits scoped repo-native first prompts atomically through the strict Action', async () => {
        const {
            useCreateNewSession,
            captured,
            syncSendMessageSpy,
            mockSessionSpawnSuccess,
        } = await setupUseCreateNewSessionHarness();

        mockSessionSpawnSuccess('sess_target');

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
            const hook = useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
                router: { push: vi.fn(), replace: vi.fn() },
                selectedMachineId: 'm1',
                selectedPath: '/tmp',
                selectedMachine: { metadata: {} },
                checkoutCreationDraft: {
                    kind: 'git_worktree',
                    displayName: 'feature/scope-fix',
                    baseRef: 'main',
                },
                setIsCreating: vi.fn(),
                setIsResumeSupportChecking: vi.fn(),
                settings,
                useProfiles: false,
                selectedProfileId: null,
                profileMap: new Map(),
                recentMachinePaths: [],
                agentType: 'codex',
                permissionMode: 'acceptEdits' as unknown as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore('Ship the scoped follow-up fix'),
                resumeSessionId: '',
                agentNewSessionOptions: null,
                machineEnvPresence,
                secrets: [],
                secretBindingsByProfileId: {},
                selectedSecretIdByProfileIdByEnvVarName: {},
                sessionOnlySecretValueByProfileIdByEnvVarName: {},
                selectedMachineCapabilities: null,
                targetServerId: 'server-b',
                allowedTargetServerIds: ['server-a', 'server-b'],
            });

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        await act(async () => {
            await handleCreateSession?.();
        });

        expect(captured.value).toEqual(expect.objectContaining({
            executionTarget: { serverId: 'server-b', machineId: 'm1' },
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'feature/scope-fix',
                baseRef: 'main',
            },
            initialInput: { text: 'Ship the scoped follow-up fix' },
        }));
        expect(syncSendMessageSpy).not.toHaveBeenCalled();
    });

    it('creates an automation instead of spawning immediately when automation mode is enabled without Composer attachments', async () => {
        const {
            useCreateNewSession,
            captured,
            automationCaptured,
            refreshAutomationsSpy,
            materializeNewSessionCheckoutSpy,
        } = await setupUseCreateNewSessionHarness();

        let handleCreateSession: null | ReturnType<typeof useCreateNewSession>['handleCreateSession'] = null;
        const routerPush = vi.fn();
        const routerReplace = vi.fn();
        const disableDraftPersistence = vi.fn();
        const settlements: NewSessionAfterCreatedSettlement[] = [];
        const settings = { experiments: false } as unknown as Settings;
        const machineEnvPresence: UseMachineEnvPresenceResult = {
            isPreviewEnvSupported: false,
            isLoading: false,
            meta: {},
            refreshedAt: null,
            refresh: () => {},
        };
        const automationDraft = createScheduleAutomationDraft({
            name: 'Nightly',
            description: 'desc',
        });
        const connectedServices = {
            v: 1 as const,
            bindingsByServiceId: {
                github: {
                    source: 'connected' as const,
                    profileId: 'work',
                },
            },
        };

        function Test() {
            const hook = useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
                router: { push: routerPush, replace: routerReplace },
                selectedMachineId: 'm1',
                selectedPath: '/tmp',
                selectedMachine: { metadata: {} },
                setIsCreating: vi.fn(),
                setIsResumeSupportChecking: vi.fn(),
                checkoutCreationDraft: {
                    kind: 'git_worktree',
                    displayName: 'feature/auth',
                    baseRef: 'main',
                },
                settings,
                useProfiles: false,
                selectedProfileId: null,
                profileMap: new Map(),
                recentMachinePaths: [],
                agentType: 'codex',
                permissionMode: 'acceptEdits' as unknown as PermissionMode,
                modelMode: 'default' as ModelMode,
                acpSessionModeId: 'plan',
                promptStore: createNewSessionPromptStore('Run the nightly maintenance checklist'),
                transcriptStorage: 'direct',
                resumeSessionId: '',
                agentNewSessionOptions: { connectedServices },
                mcpSelection: {
                    v: 1,
                    managedServersEnabled: false,
                    forceIncludeServerIds: ['server-portable'],
                    forceExcludeServerIds: ['server-disabled'],
                },
                machineEnvPresence,
                secrets: [],
                secretBindingsByProfileId: {},
                selectedSecretIdByProfileIdByEnvVarName: {},
                sessionOnlySecretValueByProfileIdByEnvVarName: {},
                selectedMachineCapabilities: null,
                targetServerId: null,
                allowedTargetServerIds: ['server-a'],
                disableDraftPersistence,
                authoringDraft: buildAutomationAuthoringDraft({
                    prompt: 'Run the nightly maintenance checklist',
                    modelMode: 'default' as ModelMode,
                    permissionMode: 'acceptEdits' as unknown as PermissionMode,
                    automation: automationDraft,
                    connectedServices,
                    mcpSelection: {
                        v: 1,
                        managedServersEnabled: false,
                        forceIncludeServerIds: ['server-portable'],
                        forceExcludeServerIds: ['server-disabled'],
                    },
                    transcriptStorage: 'direct',
                    checkoutCreationDraft: {
                        kind: 'git_worktree',
                        displayName: 'feature/auth',
                        baseRef: 'main',
                    },
                    acpSessionModeId: 'plan',
                }),
            });

            handleCreateSession = hook.handleCreateSession;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        await act(async () => {
            await invokeHandleCreateSession(handleCreateSession, {
                hasComposerAttachments: false,
                onAfterCreatedSettled: (settlement) => settlements.push(settlement),
            });
        });

        expect(captured.value).toBeNull();
        expect(materializeNewSessionCheckoutSpy).not.toHaveBeenCalled();
        // An Automation writer that persisted its definition accepted the
        // submission. Reporting `rejected` here told the Composer document
        // owner a save that WORKED had failed, so it never cleared the exact
        // submitted snapshot.
        expect(settlements).toEqual([{ status: 'accepted', sessionId: null }]);
        expect(automationCaptured.value?.name).toBe('Nightly');
        expect(automationCaptured.value?.pendingAutomationId).toBe(
            'automation-11111111-1111-4111-8111-111111111111',
        );
        expect(automationCaptured.value?.triggers).toEqual([
            expect.objectContaining({
                clientId: '22222222-2222-4222-8222-222222222222',
                persisted: null,
                definition: expect.objectContaining({
                    kind: 'schedule',
                    schedule: expect.objectContaining({ kind: 'interval', everyMs: 900_000 }),
                }),
            }),
        ]);
        expect(automationCaptured.value?.assignments[0]?.machineId).toBe('m1');
        expect(refreshAutomationsSpy).toHaveBeenCalledTimes(1);
        expect(disableDraftPersistence).toHaveBeenCalledTimes(1);
        expect(routerReplace).toHaveBeenCalledWith('/automations');
        const templateEnvelope = automationCaptured.value?.executionRecipe.template;
        expect(templateEnvelope?.t).toBe('encrypted');
        const templateCiphertext = templateEnvelope?.t === 'encrypted' ? templateEnvelope.c : '';
        expect(templateCiphertext.length).toBeGreaterThan(0);
        const templatePayload = JSON.parse(
            Buffer.from(templateCiphertext.replace(/^cipher:/, ''), 'base64').toString('utf8'),
        );
        expect(templatePayload).toEqual({
            v: 1,
            prompt: 'Run the nightly maintenance checklist',
        });
        const executionTarget = automationCaptured.value?.executionRecipe.target;
        expect(executionTarget?.kind).toBe('newSession');
        const spawn = executionTarget?.kind === 'newSession' ? executionTarget.spawn : null;
        expect(spawn?.mcpSelection).toEqual({
            v: 1,
            managedServersEnabled: false,
            forceIncludeServerIds: ['server-portable'],
            forceExcludeServerIds: ['server-disabled'],
        });
        expect(spawn?.connectedServices).toEqual({
            v: 1,
            bindingsByServiceId: {
                github: {
                    source: 'connected',
                    selection: 'profile',
                    profileId: 'work',
                },
            },
        });
        expect(spawn?.transcriptStorage).toBe('direct');
        expect(spawn?.agentModeId).toBe('plan');
        expect(spawn?.checkoutCreationDraft).toEqual({
            kind: 'git_worktree',
            displayName: 'feature/auth',
            baseRef: 'main',
        });
    });

    it('rejects Composer attachments before scheduled automation creation and retains the New Session draft', async () => {
        const {
            useCreateNewSession,
            captured,
            automationCaptured,
            clearNewSessionDraftSpy,
            refreshAutomationsSpy,
            modalAlertSpy,
        } = await setupUseCreateNewSessionHarness();

        let handleCreateSession: null | ReturnType<typeof useCreateNewSession>['handleCreateSession'] = null;
        const routerReplace = vi.fn();
        const disableDraftPersistence = vi.fn();
        const setIsCreating = vi.fn();
        const settlements: NewSessionAfterCreatedSettlement[] = [];
        const automationDraft = createScheduleAutomationDraft({
            name: 'Nightly',
            description: 'desc',
        });
        const machineEnvPresence: UseMachineEnvPresenceResult = {
            isPreviewEnvSupported: false,
            isLoading: false,
            meta: {},
            refreshedAt: null,
            refresh: () => {},
        };

        function Test() {
            const hook = useCreateNewSession({
                launchIntentSignature: 'scheduled-automation-composer-attachment',
                router: { push: vi.fn(), replace: routerReplace },
                selectedMachineId: 'm1',
                selectedPath: '/tmp',
                selectedMachine: { metadata: {} },
                setIsCreating,
                setIsResumeSupportChecking: vi.fn(),
                settings: { experiments: false } as unknown as Settings,
                useProfiles: false,
                selectedProfileId: null,
                profileMap: new Map(),
                recentMachinePaths: [],
                agentType: 'codex',
                permissionMode: 'acceptEdits' as unknown as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore('Run the nightly maintenance checklist'),
                transcriptStorage: 'direct',
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
                disableDraftPersistence,
                authoringDraft: buildAutomationAuthoringDraft({
                    prompt: 'Run the nightly maintenance checklist',
                    modelMode: 'default' as ModelMode,
                    permissionMode: 'acceptEdits' as unknown as PermissionMode,
                    automation: automationDraft,
                    transcriptStorage: 'direct',
                }),
            });
            handleCreateSession = hook.handleCreateSession;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));
        await act(async () => {
            await invokeHandleCreateSession(handleCreateSession, {
                hasComposerAttachments: true,
                onAfterCreatedSettled: (settlement) => settlements.push(settlement),
            });
        });

        expect(captured.value).toBeNull();
        expect(automationCaptured.value).toBeNull();
        expect(disableDraftPersistence).not.toHaveBeenCalled();
        expect(clearNewSessionDraftSpy).not.toHaveBeenCalled();
        expect(refreshAutomationsSpy).not.toHaveBeenCalled();
        expect(routerReplace).not.toHaveBeenCalled();
        expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'newSession.failedToStart');
        expect(settlements).toEqual([{ status: 'rejected' }]);
        expect(setIsCreating).toHaveBeenLastCalledWith(false);
    });

    it('rejects a structured Composer reference the rendered token cannot carry and retains the New Session draft', async () => {
        const {
            useCreateNewSession,
            captured,
            automationCaptured,
            clearNewSessionDraftSpy,
            refreshAutomationsSpy,
            modalAlertSpy,
        } = await setupUseCreateNewSessionHarness();

        let handleCreateSession: null | ReturnType<typeof useCreateNewSession>['handleCreateSession'] = null;
        const routerReplace = vi.fn();
        const disableDraftPersistence = vi.fn();
        const setIsCreating = vi.fn();
        const settlements: NewSessionAfterCreatedSettlement[] = [];
        const automationDraft = createScheduleAutomationDraft({
            name: 'Nightly',
            description: 'desc',
        });
        const machineEnvPresence: UseMachineEnvPresenceResult = {
            isPreviewEnvSupported: false,
            isLoading: false,
            meta: {},
            refreshedAt: null,
            refresh: () => {},
        };

        function Test() {
            const hook = useCreateNewSession({
                launchIntentSignature: 'scheduled-automation-composer-reference',
                router: { push: vi.fn(), replace: routerReplace },
                selectedMachineId: 'm1',
                selectedPath: '/tmp',
                selectedMachine: { metadata: {} },
                setIsCreating,
                setIsResumeSupportChecking: vi.fn(),
                settings: { experiments: false } as unknown as Settings,
                useProfiles: false,
                selectedProfileId: null,
                profileMap: new Map(),
                recentMachinePaths: [],
                agentType: 'codex',
                permissionMode: 'acceptEdits' as unknown as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore('Review @docs/README.md'),
                transcriptStorage: 'direct',
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
                disableDraftPersistence,
                authoringDraft: buildAutomationAuthoringDraft({
                    prompt: 'Review @docs/README.md',
                    modelMode: 'default' as ModelMode,
                    permissionMode: 'acceptEdits' as unknown as PermissionMode,
                    automation: automationDraft,
                    transcriptStorage: 'direct',
                }),
            });
            handleCreateSession = hook.handleCreateSession;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));
        await act(async () => {
            await invokeHandleCreateSession(handleCreateSession, {
                composerReferences: [{
                    kind: MENTION_KIND_V1.session,
                    ref: buildMentionRefForKindV1(MENTION_KIND_V1.session, 'sess_01HZX'),
                    token: '@session:nightly-audit-1HZX',
                    label: 'Nightly audit',
                }],
                onAfterCreatedSettled: (settlement) => settlements.push(settlement),
            });
        });

        // The stored Automation template retains only the rendered prompt
        // program. `@session:nightly-audit-1HZX` names no session on its own,
        // so persisting it would store a look-alike token with no identity.
        expect(captured.value).toBeNull();
        expect(automationCaptured.value).toBeNull();
        expect(disableDraftPersistence).not.toHaveBeenCalled();
        expect(clearNewSessionDraftSpy).not.toHaveBeenCalled();
        expect(refreshAutomationsSpy).not.toHaveBeenCalled();
        expect(routerReplace).not.toHaveBeenCalled();
        // The refusal names the reference the user has to remove, instead of
        // the generic launch failure that told them nothing.
        expect(modalAlertSpy).toHaveBeenCalledWith(
            'common.error',
            'automations.unsupportedReference(reference=@session:nightly-audit-1HZX)',
        );
        expect(settlements).toEqual([{ status: 'rejected' }]);
        expect(setIsCreating).toHaveBeenLastCalledWith(false);
    });

    it('creates a scheduled automation for a file mention whose rendered token reaches the template', async () => {
        const {
            useCreateNewSession,
            captured,
            automationCaptured,
            refreshAutomationsSpy,
            modalAlertSpy,
        } = await setupUseCreateNewSessionHarness();

        let handleCreateSession: null | ReturnType<typeof useCreateNewSession>['handleCreateSession'] = null;
        const routerReplace = vi.fn();
        const disableDraftPersistence = vi.fn();
        const setIsCreating = vi.fn();
        const settlements: NewSessionAfterCreatedSettlement[] = [];
        const automationDraft = createScheduleAutomationDraft({
            name: 'Nightly',
            description: 'desc',
        });
        const machineEnvPresence: UseMachineEnvPresenceResult = {
            isPreviewEnvSupported: false,
            isLoading: false,
            meta: {},
            refreshedAt: null,
            refresh: () => {},
        };

        function Test() {
            const hook = useCreateNewSession({
                launchIntentSignature: 'scheduled-automation-file-reference',
                router: { push: vi.fn(), replace: routerReplace },
                selectedMachineId: 'm1',
                selectedPath: '/tmp',
                selectedMachine: { metadata: {} },
                setIsCreating,
                setIsResumeSupportChecking: vi.fn(),
                settings: { experiments: false } as unknown as Settings,
                useProfiles: false,
                selectedProfileId: null,
                profileMap: new Map(),
                recentMachinePaths: [],
                agentType: 'codex',
                permissionMode: 'acceptEdits' as unknown as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore('Review @docs/README.md'),
                transcriptStorage: 'direct',
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
                disableDraftPersistence,
                authoringDraft: buildAutomationAuthoringDraft({
                    prompt: 'Review @docs/README.md',
                    modelMode: 'default' as ModelMode,
                    permissionMode: 'acceptEdits' as unknown as PermissionMode,
                    automation: automationDraft,
                    transcriptStorage: 'direct',
                }),
            });
            handleCreateSession = hook.handleCreateSession;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));
        await act(async () => {
            await invokeHandleCreateSession(handleCreateSession, {
                composerReferences: [{
                    kind: MENTION_KIND_V1.file,
                    ref: buildMentionRefForKindV1(MENTION_KIND_V1.file, 'docs/README.md'),
                    token: '@docs/README.md',
                    label: 'README.md',
                }],
                onAfterCreatedSettled: (settlement) => settlements.push(settlement),
            });
        });

        // "Review @docs/README.md every morning" is a flow that worked. The
        // rendered token carries the whole path, so the later run reaches the
        // same file the picker did and there is nothing to fail closed over.
        expect(captured.value).toBeNull();
        expect(modalAlertSpy).not.toHaveBeenCalled();
        expect(settlements).toEqual([{ status: 'accepted', sessionId: null }]);
        expect(automationCaptured.value?.name).toBe('Nightly');
        expect(refreshAutomationsSpy).toHaveBeenCalledTimes(1);
        expect(disableDraftPersistence).toHaveBeenCalledTimes(1);
        expect(routerReplace).toHaveBeenCalledWith('/automations');
        const templateEnvelope = automationCaptured.value?.executionRecipe.template;
        const templateCiphertext = templateEnvelope?.t === 'encrypted' ? templateEnvelope.c : '';
        const templatePayload = JSON.parse(
            Buffer.from(templateCiphertext.replace(/^cipher:/, ''), 'base64').toString('utf8'),
        );
        expect(templatePayload.prompt).toBe('Review @docs/README.md');
    });

    it('uses the latest automation draft values after rerendering before save', async () => {
        const {
            useCreateNewSession,
            saveAutomationEditorDraftSpy,
        } = await setupUseCreateNewSessionHarness();

        let handleCreateSession: null | (() => Promise<void>) = null;
        const routerPush = vi.fn();
        const routerReplace = vi.fn();
        const settings = { experiments: false } as unknown as Settings;
        const machineEnvPresence: UseMachineEnvPresenceResult = {
            isPreviewEnvSupported: false,
            isLoading: false,
            meta: {},
            refreshedAt: null,
            refresh: () => {},
        };
        const setIsCreating = vi.fn();
        const setIsResumeSupportChecking = vi.fn();
        const profileMap = new Map();
        const recentMachinePaths: never[] = [];
        const secretBindingsByProfileId = {};
        const selectedSecretIdByProfileIdByEnvVarName = {};
        const sessionOnlySecretValueByProfileIdByEnvVarName = {};
        const allowedTargetServerIds = ['server-a'];
        const router = { push: routerPush, replace: routerReplace };
        const selectedMachine = { metadata: {} };

        function Test(props: Readonly<{ automationDraft: NewSessionAutomationDraft }>) {
            const hook = useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
                router,
                selectedMachineId: 'm1',
                selectedPath: '/tmp',
                selectedMachine,
                setIsCreating,
                setIsResumeSupportChecking,
                settings,
                useProfiles: false,
                selectedProfileId: null,
                profileMap,
                recentMachinePaths,
                agentType: 'codex',
                permissionMode: 'acceptEdits' as unknown as PermissionMode,
                modelMode: 'gpt-5' as ModelMode,
                promptStore: createNewSessionPromptStore('Update the scheduled work'),
                transcriptStorage: 'direct',
                resumeSessionId: '',
                agentNewSessionOptions: null,
                mcpSelection: null,
                machineEnvPresence,
                secrets: [],
                secretBindingsByProfileId,
                selectedSecretIdByProfileIdByEnvVarName,
                sessionOnlySecretValueByProfileIdByEnvVarName,
                selectedMachineCapabilities: null,
                targetServerId: null,
                allowedTargetServerIds,
                authoringDraft: buildAutomationAuthoringDraft({
                    prompt: 'Update the scheduled work',
                    modelMode: 'gpt-5' as ModelMode,
                    permissionMode: 'acceptEdits' as unknown as PermissionMode,
                    automation: props.automationDraft,
                    transcriptStorage: 'direct',
                }),
            });

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        const initialDraft = createScheduleAutomationDraft({
            name: 'Nightly edit',
            description: 'desc',
            everyMinutes: 30,
        });
        const updatedDraft: NewSessionAutomationDraft = {
            ...initialDraft,
            name: 'Nightly edit updated',
        };

        let tree: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(Test, { automationDraft: initialDraft }))).tree;
        act(() => {
            tree.update(React.createElement(Test, { automationDraft: updatedDraft }));
        });

        await act(async () => {
            await handleCreateSession?.();
        });

        expect(saveAutomationEditorDraftSpy).toHaveBeenCalledWith(expect.objectContaining({
            name: 'Nightly edit updated',
        }), expect.objectContaining({ isCurrent: expect.any(Function) }));
    });

    it('uses the latest automation draft values even when an older submit handler reference is invoked', async () => {
        const {
            useCreateNewSession,
            saveAutomationEditorDraftSpy,
        } = await setupUseCreateNewSessionHarness();

        let latestHandleCreateSession: null | (() => Promise<void>) = null;
        let initialHandleCreateSession: null | (() => Promise<void>) = null;
        const routerPush = vi.fn();
        const routerReplace = vi.fn();
        const settings = { experiments: false } as unknown as Settings;
        const machineEnvPresence: UseMachineEnvPresenceResult = {
            isPreviewEnvSupported: false,
            isLoading: false,
            meta: {},
            refreshedAt: null,
            refresh: () => {},
        };
        const setIsCreating = vi.fn();
        const setIsResumeSupportChecking = vi.fn();
        const profileMap = new Map();
        const recentMachinePaths: never[] = [];
        const secretBindingsByProfileId = {};
        const selectedSecretIdByProfileIdByEnvVarName = {};
        const sessionOnlySecretValueByProfileIdByEnvVarName = {};
        const allowedTargetServerIds = ['server-a'];
        const router = { push: routerPush, replace: routerReplace };
        const selectedMachine = { metadata: {} };

        function Test(props: Readonly<{ automationDraft: NewSessionAutomationDraft }>) {
            const hook = useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
                router,
                selectedMachineId: 'm1',
                selectedPath: '/tmp',
                selectedMachine,
                setIsCreating,
                setIsResumeSupportChecking,
                settings,
                useProfiles: false,
                selectedProfileId: null,
                profileMap,
                recentMachinePaths,
                agentType: 'codex',
                permissionMode: 'acceptEdits' as unknown as PermissionMode,
                modelMode: 'gpt-5' as ModelMode,
                promptStore: createNewSessionPromptStore('Update the scheduled work'),
                transcriptStorage: 'direct',
                resumeSessionId: '',
                agentNewSessionOptions: null,
                mcpSelection: null,
                machineEnvPresence,
                secrets: [],
                secretBindingsByProfileId,
                selectedSecretIdByProfileIdByEnvVarName,
                sessionOnlySecretValueByProfileIdByEnvVarName,
                selectedMachineCapabilities: null,
                targetServerId: null,
                allowedTargetServerIds,
                authoringDraft: buildAutomationAuthoringDraft({
                    prompt: 'Update the scheduled work',
                    modelMode: 'gpt-5' as ModelMode,
                    permissionMode: 'acceptEdits' as unknown as PermissionMode,
                    automation: props.automationDraft,
                    transcriptStorage: 'direct',
                }),
            });

            if (!initialHandleCreateSession) {
                initialHandleCreateSession = hook.handleCreateSession as () => Promise<void>;
            }
            latestHandleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        const initialDraft = createScheduleAutomationDraft({
            name: 'Nightly edit',
            description: 'desc',
            everyMinutes: 30,
        });
        const updatedDraft: NewSessionAutomationDraft = {
            ...initialDraft,
            name: 'Nightly edit updated again',
        };

        let tree: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(Test, { automationDraft: initialDraft }))).tree;
        if (!initialHandleCreateSession) {
            throw new Error('expected initial handleCreateSession');
        }
        const staleHandleCreateSession: () => Promise<void> = initialHandleCreateSession;
        act(() => {
            tree.update(React.createElement(Test, { automationDraft: updatedDraft }));
        });

        expect(latestHandleCreateSession).toBeTruthy();

        await act(async () => {
            await staleHandleCreateSession();
        });

        expect(saveAutomationEditorDraftSpy).toHaveBeenCalledWith(expect.objectContaining({
            name: 'Nightly edit updated again',
        }), expect.objectContaining({ isCurrent: expect.any(Function) }));
    });

    it('keeps vendor resume and the first message in the strict Action request', async () => {
        const {
            useCreateNewSession,
            captured,
            syncSendMessageSpy,
            mockSessionSpawnSuccess,
        } = await setupUseCreateNewSessionHarness();

        mockSessionSpawnSuccess('sess_new');

        let handleCreateSession: null | (() => Promise<void>) = null;
        const routerReplace = vi.fn();
        const disableDraftPersistence = vi.fn();
        const settings = {
            experiments: false,
            sessionReplayEnabled: true,
            sessionReplayStrategy: 'recent_messages',
            sessionReplayRecentMessagesCount: 100,
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
                router: { push: vi.fn(), replace: routerReplace },
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
                permissionMode: 'acceptEdits' as unknown as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore('PROMPT'),
                resumeSessionId: 'sess_old',
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
            });

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        await act(async () => {
            await handleCreateSession?.();
        });

        expect(disableDraftPersistence).toHaveBeenCalledTimes(1);
        expect(captured.value).toEqual(expect.objectContaining({
            initialInput: { text: 'PROMPT' },
            configuration: expect.objectContaining({
                providerSessionResume: {
                    kind: 'provider_session.v1',
                    providerSessionId: 'sess_old',
                },
            }),
        }));
        expect(syncSendMessageSpy).not.toHaveBeenCalled();
    });

    it('passes the selected profile id through the strict Action request', async () => {
        const {
            useCreateNewSession,
            captured,
            syncSendMessageSpy,
            mockSessionSpawnSuccess,
        } = await setupUseCreateNewSessionHarness();

        mockSessionSpawnSuccess('sess_new');

        let handleCreateSession: null | (() => Promise<void>) = null;
        const routerReplace = vi.fn();
        const settings = {
            experiments: false,
            sessionReplayEnabled: false,
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
                router: { push: vi.fn(), replace: routerReplace },
                selectedMachineId: 'm1',
                selectedPath: '/tmp',
                selectedMachine: { metadata: {} },
                setIsCreating: vi.fn(),
                setIsResumeSupportChecking: vi.fn(),
                settings,
                useProfiles: true,
                selectedProfileId: 'profile-test',
                profileMap: new Map([[
                    'profile-test',
                    AIBackendProfileSchema.parse({
                        id: 'profile-test',
                        name: 'Profile Test',
                        description: undefined,
                        environmentVariables: [],
                        envVarRequirements: [],
                        compatibility: {},
                        defaultPermissionModeByAgent: {},
                        defaultPermissionModeByTargetKey: {},
                        defaultPersistenceModeByAgent: {},
                        defaultPersistenceModeByTargetKey: {},
                        compatibilityByTargetKey: {
                            [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' })]: true,
                        },
                        isBuiltIn: false,
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                        version: '1.0.0',
                    }),
                ]]),
                recentMachinePaths: [],
                agentType: 'codex',
                permissionMode: 'acceptEdits' as unknown as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore('PROMPT'),
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
            });

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        await act(async () => {
            await handleCreateSession?.();
        });

        expect(captured.value).toEqual(expect.objectContaining({
            profileId: 'profile-test',
            initialInput: { text: 'PROMPT' },
        }));
        expect(syncSendMessageSpy).not.toHaveBeenCalled();
    });

    it('blocks creation when the selected profile is incompatible with the current backend target', async () => {
        const {
            useCreateNewSession,
            modalAlertSpy,
            sessionSpawnNewRpcSpy,
            syncSendMessageSpy,
        } = await setupUseCreateNewSessionHarness();

        let handleCreateSession: null | (() => Promise<void>) = null;
        const settings = {
            experiments: false,
            sessionReplayEnabled: false,
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
                useProfiles: true,
                selectedProfileId: 'profile-test',
                profileMap: new Map([[
                    'profile-test',
                    AIBackendProfileSchema.parse({
                        id: 'profile-test',
                        name: 'Profile Test',
                        description: undefined,
                        environmentVariables: [],
                        envVarRequirements: [],
                        compatibility: {},
                        defaultPermissionModeByAgent: {},
                        defaultPermissionModeByTargetKey: {},
                        defaultPersistenceModeByAgent: {},
                        defaultPersistenceModeByTargetKey: {},
                        compatibilityByTargetKey: {
                            [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'claude' })]: true,
                            [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' })]: false,
                        },
                        isBuiltIn: false,
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                        version: '1.0.0',
                    }),
                ]]),
                recentMachinePaths: [],
                agentType: 'codex',
                permissionMode: 'acceptEdits' as unknown as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore('PROMPT'),
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
            });

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        await act(async () => {
            await handleCreateSession?.();
        });

        expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'newSession.aiBackendNotCompatibleWithSelectedProfile');
        expect(sessionSpawnNewRpcSpy).not.toHaveBeenCalled();
        expect(syncSendMessageSpy).not.toHaveBeenCalled();
    });

    it('can skip sending the initial message when requested', async () => {
        const {
            useCreateNewSession,
            captured,
            syncSendMessageSpy,
            mockSessionSpawnSuccess,
        } = await setupUseCreateNewSessionHarness();

        mockSessionSpawnSuccess('sess_new');

        let handleCreateSession: null | ReturnType<typeof useCreateNewSession>['handleCreateSession'] = null;
        const routerReplace = vi.fn();
        const settings = {
            experiments: false,
            sessionReplayEnabled: false,
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
                router: { push: vi.fn(), replace: routerReplace },
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
                permissionMode: 'acceptEdits' as unknown as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore('PROMPT'),
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
            });

            handleCreateSession = hook.handleCreateSession;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        await act(async () => {
            await invokeHandleCreateSession(handleCreateSession, { initialMessage: 'skip' });
        });

        expect(captured.value?.initialInput).toBeUndefined();
        expect(syncSendMessageSpy).toHaveBeenCalledTimes(0);
        expect(routerReplace).toHaveBeenCalledWith('/session/sess_new?serverId=server-a', expect.anything());
    });

    it('passes the per-session Windows launch-mode override into the strict Action request', async () => {
        const {
            useCreateNewSession,
            captured,
        } = await setupUseCreateNewSessionHarness();

        let handleCreateSession: null | ReturnType<typeof useCreateNewSession>['handleCreateSession'] = null;
        const settings = {
            experiments: false,
            sessionWindowsRemoteSessionLaunchMode: 'hidden',
            sessionWindowsTerminalWindowName: 'happier-qa',
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
                selectedMachine: { metadata: { platform: 'win32', windowsRemoteSessionLaunchMode: 'console' } },
                setIsCreating: vi.fn(),
                setIsResumeSupportChecking: vi.fn(),
                settings,
                useProfiles: false,
                selectedProfileId: null,
                profileMap: new Map(),
                recentMachinePaths: [],
                agentType: 'codex',
                permissionMode: 'acceptEdits' as unknown as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore(''),
                resumeSessionId: '',
                agentNewSessionOptions: null,
                windowsRemoteSessionLaunchModeOverride: 'windows_terminal',
                machineEnvPresence,
                secrets: [],
                secretBindingsByProfileId: {},
                selectedSecretIdByProfileIdByEnvVarName: {},
                sessionOnlySecretValueByProfileIdByEnvVarName: {},
                selectedMachineCapabilities: null,
                targetServerId: null,
                allowedTargetServerIds: ['server-a'],
            });

            handleCreateSession = hook.handleCreateSession;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        await act(async () => {
            await invokeHandleCreateSession(handleCreateSession, { initialMessage: 'skip' });
        });

        expect(captured.value?.terminal?.windows?.launchMode).toBe('windows_terminal');
        expect(captured.value?.terminal?.windows?.windowName).toBe('happier-qa');
    });
});
