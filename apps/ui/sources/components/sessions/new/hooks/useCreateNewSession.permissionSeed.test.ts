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
    DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema,
    MENTION_KIND_V1,
    PluginMachineMaterializationV1Schema,
    SessionModelSelectionV1Schema,
    type AutomationDefinitionDetail,
    type AutomationPluginEventDefinitionCreateRequest,
    type AutomationPluginEventDefinitionPatchRequest,
    type PluginMachineExecutionOriginV1,
    type SessionMcpSelectionV1,
    type SessionServerStartSpawnDraftV1,
    type SessionSpawnNewInputV2,
    type SessionSpawnNewResultV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { AIBackendProfileSchema } from '@/sync/domains/profiles/profileCompatibility';
import { renderScreen } from '@/dev/testkit';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { createAutomationDefinitionFromDetail } from '@/sync/domains/automations/automationDefinitionProjection';
import { createPluginEventAutomationAuthoringDraft } from '@/components/automations/editor/pluginEventAutomationDraft';
import type { PluginEventAutomationAuthoringDraft } from '@/components/automations/editor/pluginEventAutomationDraft';
import type { DaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import type { FreshPluginMachineExecutionOriginV1 } from '@/sync/domains/machines/administration/usePluginExecutionOriginSelection';
import type { PluginEventAutomationResolvedTarget } from '@/components/automations/editor/pluginEventAutomationTarget';
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

type AutomationCreateCapture = {
    name: string;
    enabled: boolean;
    schedule: { kind: string; everyMs?: number };
    targetType: 'new_session' | 'existing_session';
    templateCiphertext: string;
    assignments?: Array<{ machineId: string; enabled?: boolean; priority?: number }>;
} | null;

type PluginEventAutomationCreateCapture = AutomationPluginEventDefinitionCreateRequest | null;
type PluginEventAutomationPatchCapture = Readonly<{
    automationId: string;
    input: AutomationPluginEventDefinitionPatchRequest;
}> | null;

function resolveNewSessionEventTarget(input: Readonly<{
    newSessionSpawn?: SessionServerStartSpawnDraftV1 | null;
}>): PluginEventAutomationResolvedTarget | null {
    const spawn = input.newSessionSpawn;
    return spawn
        ? {
            target: { kind: 'newSession', spawn },
            assignmentMachineId: spawn.executionTarget.machineId,
        }
        : null;
}

function resolveExistingSessionEventTarget(): PluginEventAutomationResolvedTarget | null {
    return {
        target: { kind: 'existingSession', sessionId: 'sess_existing_target' },
        assignmentMachineId: 'm1',
    };
}

function createRetainedScheduleAutomationDefinition(id: string) {
    return createAutomationDefinitionFromDetail({
        id,
        name: 'Retained schedule automation',
        description: null,
        enabled: true,
        trigger: {
            kind: 'schedule',
            schedule: {
                kind: 'interval',
                everyMs: 60_000,
                scheduleExpr: null,
                timezone: null,
            },
        },
        targetType: 'newSession',
        existingSessionId: null,
        templateVersion: 1,
        nextRunAt: null,
        lastRunAt: null,
        createdAt: 1,
        updatedAt: 1,
        assignments: [],
        triggerDefinitionEnvelope: null,
        templateCiphertext: '{"kind":"happier_automation_template_plain_v1","payload":{"directory":"/tmp"}}',
    } satisfies AutomationDefinitionDetail);
}

function createStrictPluginEventAutomationDefinition(
    id: string,
    templateVersion = 1,
    enabled = true,
    assignments: AutomationDefinitionDetail['assignments'] = [],
) {
    return createAutomationDefinitionFromDetail({
        id,
        name: 'Current event automation',
        description: null,
        enabled,
        trigger: {
            kind: 'pluginEvent',
            eventRef: {
                pluginId: 'plugin-test',
                localId: 'repository-event',
            },
            sourceSelectorId: 'source-selector',
            sourceContractVersion: 1,
            observation: {
                kind: 'checkpointedPull',
                watcher: null,
            },
        },
        targetType: 'existingSession',
        // The frozen recipe targets a new Session, so the owner projects no association.
        existingSessionId: null,
        templateVersion,
        nextRunAt: null,
        lastRunAt: null,
        createdAt: 1,
        updatedAt: templateVersion,
        assignments,
        triggerDefinitionEnvelope: 'opaque-event-definition',
        executionRecipe: {
            v: 1,
            templateVersion,
            template: { t: 'plain', v: { v: 1, prompt: 'Seeded Event prompt' } },
            triggerEvidence: null,
            target: {
                kind: 'newSession',
                spawn: {
                    executionTarget: { serverId: 'seeded-server', machineId: 'seeded-machine' },
                    directory: '/seeded/project',
                    organizationPlacement: { folderId: 'seeded-folder', tagIds: ['seeded-tag'] },
                    agentTarget: {
                        kind: 'agent',
                        identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
                    },
                    permissionMode: 'safe-yolo',
                    configuration: {
                        mode: { value: null, updatedAtMs: 1 },
                        model: { value: null, updatedAtMs: 1 },
                        permissionIntent: { value: 'safe-yolo', updatedAtMs: 1 },
                        options: {},
                    },
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            github: { source: 'connected', selection: 'profile', profileId: 'seeded-github' },
                        },
                    },
                    terminal: { mode: 'integrated' },
                },
            },
        },
    } satisfies AutomationDefinitionDetail);
}

function createPluginEventEligibleEvent(immutableGenerationId = 'github-generation-a') {
    return DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema.parse({
        event: {
            id: 'acme.github/events/repository',
            identity: { pluginId: 'acme.github', localId: 'events/repository' },
            immutableGenerationId,
            title: 'Repository updates',
            description: null,
            payloadSchema: {
                type: 'object',
                properties: { action: { type: 'string' } },
                required: ['action'],
                additionalProperties: false,
            },
            automation: {
                v: 1,
                eligible: true,
                source: {
                    sourceContractVersion: 3,
                    supportedObservationTransports: ['checkpointedPull'],
                    sourceConfigSchema: {
                        type: 'object',
                        properties: { repositoryId: { type: 'string', minLength: 1 } },
                        required: ['repositoryId'],
                        additionalProperties: false,
                    },
                    setupActionRef: {
                        pluginId: 'acme.github',
                        localId: 'setup/repository-source',
                    },
                },
            },
        },
        setupAction: {
            id: 'acme.github/actions/setup/repository-source',
            identity: { pluginId: 'acme.github', localId: 'setup/repository-source' },
            immutableGenerationId,
            title: 'Configure repository source',
            description: null,
            inputSchema: {
                type: 'object',
                properties: { repository: { type: 'string', minLength: 1 } },
                required: ['repository'],
                additionalProperties: false,
            },
            inputHints: null,
        },
    });
}

function projectionInputsForPluginEvent(
    event: ReturnType<typeof createPluginEventEligibleEvent>,
): DaemonMergedProjectionInputs {
    return {
        mergedProviderProjectionById: {},
        mergedBackendProjectionById: {},
        discoveredBackendIds: [],
        pluginProjectionById: {},
        pluginProjectionV2: null,
        automationEligibleEvents: [event],
        registryDiagnostics: [],
    };
}

function freshPluginEventExecutionOrigin(
    origin: PluginMachineExecutionOriginV1,
): FreshPluginMachineExecutionOriginV1 {
    const materialization = PluginMachineMaterializationV1Schema.parse({
        serverIdentityId: origin.serverIdentityId,
        machineId: origin.materializationRef.machineId,
        materializationId: origin.materializationRef.materializationId,
        pluginId: origin.materializationRef.pluginId,
        version: '1.0.0',
        sourceClass: 'registryPackage',
        portableRelease: true,
        uiArtifacts: [],
        enabled: true,
        trustState: 'trusted',
        observedAt: 1_700_000_000_000,
    });
    return {
        origin,
        materialization,
        machineTarget: {
            kind: 'resolved',
            target: {
                serverIdentityId: origin.serverIdentityId,
                machineId: origin.materializationRef.machineId,
            },
            serverId: 'server-a',
            profile: {
                id: 'server-a',
                name: 'Server A',
                serverUrl: 'https://server-a.invalid',
                serverIdentityId: origin.serverIdentityId,
                createdAt: 1,
                updatedAt: 1,
                lastUsedAt: 1,
            },
            machine: {
                id: origin.materializationRef.machineId,
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                metadata: null,
                metadataVersion: 1,
                daemonState: null,
                daemonStateVersion: 1,
            },
        },
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
        codexBackendMode: null,
        acpSessionModeId: params.acpSessionModeId ?? null,
        sessionConfigOptionOverrides: null,
        automation: params.automation,
    });
}

async function setupUseCreateNewSessionHarness() {
    const captured: { value: SpawnPayloadCapture } = { value: null };
    const sessionSpawnNewRpcRequest: { value: SessionSpawnNewRpcRequest | null } = { value: null };
    const buildSpawnEnvironmentVariablesCapture: { value: Record<string, unknown> | null } = { value: null };
    const automationCaptured: { value: AutomationCreateCapture } = { value: null };
    const pluginEventAutomationCaptured: { value: PluginEventAutomationCreateCapture } = { value: null };
    const pluginEventAutomationCreateError: { value: unknown | null } = { value: null };
    const pluginEventAutomationPatchCaptured: { value: PluginEventAutomationPatchCapture } = { value: null };
    const pluginEventAutomationPatchError: { value: unknown | null } = { value: null };
    const currentPluginEventProjection: { value: DaemonMergedProjectionInputs | null } = { value: null };
    const loadDaemonMergedProjectionInputsSpy = vi.fn(async () => currentPluginEventProjection.value);
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
    const refreshAutomationDefinitionDetailSpy = vi.fn(async (automationId: string) => (
        createRetainedScheduleAutomationDefinition(automationId)
    ));
    const applySettingsSpy = vi.fn((..._args: unknown[]) => {});
    const updateAutomationSpy = vi.fn(async () => {});
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
                initialInput: request.payload.initialMessage
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
            createAutomation: vi.fn(async (input: AutomationCreateCapture) => {
                automationCaptured.value = input;
                return { id: 'auto_1', ...input };
            }),
            createPluginEventAutomationDefinition: vi.fn(async (input: AutomationPluginEventDefinitionCreateRequest) => {
                pluginEventAutomationCaptured.value = input;
                if (pluginEventAutomationCreateError.value !== null) {
                    throw pluginEventAutomationCreateError.value;
                }
                return { id: 'event_auto_1', ...input };
            }),
            updatePluginEventAutomationDefinition: vi.fn(async (
                automationId: string,
                input: AutomationPluginEventDefinitionPatchRequest,
            ) => {
                pluginEventAutomationPatchCaptured.value = { automationId, input };
                if (pluginEventAutomationPatchError.value !== null) {
                    throw pluginEventAutomationPatchError.value;
                }
                return { id: 'event_auto_1', ...input };
            }),
            updateAutomation: updateAutomationSpy,
            refreshAutomationDefinitionDetail: refreshAutomationDefinitionDetailSpy,
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
    const { createServerAccountScope } = await import('@/sync/domains/scope/serverAccountScope');
    const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');
    const activeAccountScope = createServerAccountScope('server-a', 'account-a');
    if (!activeAccountScope) throw new Error('Expected the active Account fixture to be valid');
    // Event authoring captures the same canonical Account lifetime that owns
    // stored-content availability. The test server and credential fixtures
    // above are both for server-a/account-a, so register that real scope
    // instead of bypassing the owner with a submit mock.
    registerStorageStateReader(() => ({ profileScope: activeAccountScope } as never));
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
    vi.doMock('@/components/sessions/new/modules/materializeNewSessionCheckout', () => ({
        materializeNewSessionCheckout: materializeNewSessionCheckoutSpy,
    }));
    vi.doMock('@/agents/backendCatalog/loadDaemonMergedProjectionInputs', () => ({
        loadDaemonMergedProjectionInputs: loadDaemonMergedProjectionInputsSpy,
    }));
    const { useCreateNewSession } = await import('./useCreateNewSession');
    return {
        useCreateNewSession,
        setLocalSearchParams(nextParams: Record<string, string | string[] | undefined>) {
            routerSearchParamsState.value = { ...nextParams };
        },
        captured,
        buildSpawnEnvironmentVariablesCapture,
        automationCaptured,
        pluginEventAutomationCaptured,
        pluginEventAutomationCreateError,
        pluginEventAutomationPatchCaptured,
        pluginEventAutomationPatchError,
        currentPluginEventProjection,
        loadDaemonMergedProjectionInputsSpy,
        accountEncryptionMode,
        sessions,
        encryptRawSpy,
        modalAlertSpy,
        modalConfirmSpy,
        clearNewSessionDraftSpy,
        setActiveServerSpy,
        switchConnectionToActiveServerSpy,
        refreshMachinesSpy,
        refreshSessionsSpy,
        ensureSessionVisibleForMessageRouteSpy,
        refreshAutomationsSpy,
        refreshAutomationDefinitionDetailSpy,
        updateAutomationSpy,
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
            initialMessage: 'hello',
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
            codexBackendMode: null,
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
            initialMessage: 'hello',
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

        expect(captured.value?.initialMessage).toBeUndefined();
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
            initialMessage: 'Ship the scoped follow-up fix',
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
	        const automationDraft: NewSessionAutomationDraft = {
	            enabled: true,
	            name: 'Nightly',
	            description: 'desc',
	            scheduleKind: 'interval',
	            everyMinutes: 15,
	            cronExpr: '0 * * * *',
	            timezone: null,
	        };
        const connectedServices = {
            github: {
                installationId: 'inst_123',
                accountLogin: 'leeroy',
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
        expect(automationCaptured.value?.schedule.kind).toBe('interval');
        expect(automationCaptured.value?.schedule.everyMs).toBe(900000);
        expect(automationCaptured.value?.assignments?.[0]?.machineId).toBe('m1');
        expect(refreshAutomationsSpy).toHaveBeenCalledTimes(1);
        expect(disableDraftPersistence).toHaveBeenCalledTimes(1);
        expect(routerReplace).toHaveBeenCalledWith('/automations');
        const templateEnvelope = JSON.parse(String(automationCaptured.value?.templateCiphertext));
        expect(templateEnvelope.kind).toBe('happier_automation_template_encrypted_v1');
        expect(typeof templateEnvelope.payloadCiphertext).toBe('string');
        expect(templateEnvelope.payloadCiphertext.length).toBeGreaterThan(0);
        const templatePayload = JSON.parse(
            Buffer.from(String(templateEnvelope.payloadCiphertext).replace(/^cipher:/, ''), 'base64').toString('utf8'),
        );
        expect(templatePayload.mcpSelection).toEqual({
            v: 1,
            managedServersEnabled: false,
            forceIncludeServerIds: ['server-portable'],
            forceExcludeServerIds: ['server-disabled'],
        });
        expect(templatePayload.connectedServices).toEqual(connectedServices);
        expect(templatePayload.transcriptStorage).toBe('direct');
        expect(templatePayload.agentModeId).toBe('plan');
        expect(templatePayload.workspaceId).toBeUndefined();
        expect(templatePayload.workspaceLocationId).toBeUndefined();
        expect(templatePayload.workspaceCheckoutId).toBeUndefined();
        expect(templatePayload.checkoutCreationDraft).toEqual({
            kind: 'git_worktree',
            displayName: 'feature/auth',
            baseRef: 'main',
            branchMode: 'new',
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
        const automationDraft: NewSessionAutomationDraft = {
            enabled: true,
            name: 'Nightly',
            description: 'desc',
            scheduleKind: 'interval',
            everyMinutes: 15,
            cronExpr: '0 * * * *',
            timezone: null,
        };
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
        const automationDraft: NewSessionAutomationDraft = {
            enabled: true,
            name: 'Nightly',
            description: 'desc',
            scheduleKind: 'interval',
            everyMinutes: 15,
            cronExpr: '0 * * * *',
            timezone: null,
        };
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
        const automationDraft: NewSessionAutomationDraft = {
            enabled: true,
            name: 'Nightly',
            description: 'desc',
            scheduleKind: 'interval',
            everyMinutes: 15,
            cronExpr: '0 * * * *',
            timezone: null,
        };
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
        const templateEnvelope = JSON.parse(String(automationCaptured.value?.templateCiphertext));
        const templatePayload = JSON.parse(
            Buffer.from(String(templateEnvelope.payloadCiphertext).replace(/^cipher:/, ''), 'base64').toString('utf8'),
        );
        expect(templatePayload.prompt).toBe('Review @docs/README.md');
    });

    it.each([
        {
            title: 'creates an exact current Plugin Event Automation through V3 instead of the retained V2 writer',
            writerErrorCode: null,
            expectedAlert: null,
        },
        {
            title: 'renders stored-content unavailable when the V3 Event writer rejects unavailable stored content',
            writerErrorCode: 'automation_stored_content_unavailable',
            expectedAlert: [
                'settingsPlugins.eventAutomationComposer.storedContentUnavailableTitle',
                'settingsPlugins.eventAutomationComposer.storedContentUnavailableBody',
            ],
        },
    ] as const)('$title', async ({ writerErrorCode, expectedAlert }) => {
        const {
            useCreateNewSession,
            captured,
            automationCaptured,
            pluginEventAutomationCaptured,
            pluginEventAutomationCreateError,
            accountEncryptionMode,
            currentPluginEventProjection,
            loadDaemonMergedProjectionInputsSpy,
            refreshAutomationsSpy,
            modalAlertSpy,
        } = await setupUseCreateNewSessionHarness();
        accountEncryptionMode.value = 'plain';
        if (writerErrorCode) {
            const { AutomationApiError } = await import('@/sync/api/automations/apiAutomations');
            pluginEventAutomationCreateError.value = new AutomationApiError({
                code: writerErrorCode,
                status: 409,
            });
        }

        const event = createPluginEventEligibleEvent();
        currentPluginEventProjection.value = projectionInputsForPluginEvent(event);
        const eventDraft = createPluginEventAutomationAuthoringDraft({
            eligibleEvent: event,
            observation: { kind: 'checkpointedPull' },
            setupResult: {
                v: 1,
                sourceInstanceId: 'repository:42',
                sourceContractVersion: 3,
                sourceConfig: { repositoryId: '42' },
                displayLabel: 'acme/widgets',
            },
            watcherOrigin: {
                serverIdentityId: 'srv_account_a',
                materializationRef: {
                    machineId: 'watcher-machine',
                    materializationId: 'github-materialization-a',
                    pluginId: 'acme.github',
                },
            },
            filter: {
                v: 1,
                all: [{ op: 'eq', field: '/action', value: 'opened' }],
            },
            maximumObservationAgeMs: 30_000,
        });
        expect(eventDraft).not.toBeNull();
        if (!eventDraft) throw new Error('Expected a valid Event Automation draft');
        const verifiedEventDraft = eventDraft;

        let handleCreateSession: null | ReturnType<typeof useCreateNewSession>['handleCreateSession'] = null;
        const routerReplace = vi.fn();
        const disableDraftPersistence = vi.fn();
        const automationDraft: NewSessionAutomationDraft = {
            enabled: true,
            name: 'Repository triage',
            description: 'Run on repository updates',
            scheduleKind: 'interval',
            everyMinutes: 60,
            cronExpr: '0 * * * *',
            timezone: null,
        };
        const machineEnvPresence: UseMachineEnvPresenceResult = {
            isPreviewEnvSupported: false,
            isLoading: false,
            meta: {},
            refreshedAt: null,
            refresh: () => {},
        };

        function Test() {
            const hook = useCreateNewSession({
                launchIntentSignature: 'event-automation-create',
                router: { push: vi.fn(), replace: routerReplace },
                selectedMachineId: 'm1',
                selectedPath: '/tmp',
                selectedMachine: { metadata: {} },
                setIsCreating: vi.fn(),
                setIsResumeSupportChecking: vi.fn(),
                settings: { experiments: false } as unknown as Settings,
                useProfiles: false,
                selectedProfileId: null,
                profileMap: new Map(),
                recentMachinePaths: [],
                agentType: 'codex',
                permissionMode: 'acceptEdits' as unknown as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore('Triage {{input}}'),
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
                eventAutomationDraft: {
                    draft: verifiedEventDraft,
                    resolveFreshWatcherOrigin: () => freshPluginEventExecutionOrigin(verifiedEventDraft.watcherOrigin),
                },
                eventAutomationTargetKind: 'newSession',
                resolveEventAutomationTarget: resolveNewSessionEventTarget,
                authoringDraft: buildAutomationAuthoringDraft({
                    prompt: 'Triage {{input}}',
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
            await invokeHandleCreateSession(handleCreateSession);
        });

        expect(captured.value).toBeNull();
        expect(automationCaptured.value).toBeNull();
        expect(pluginEventAutomationCaptured.value).toEqual(expect.objectContaining({
            name: 'Repository triage',
            description: 'Run on repository updates',
            enabled: true,
            trigger: expect.objectContaining({
                kind: 'pluginEvent',
                eventRef: { pluginId: 'acme.github', localId: 'events/repository' },
                sourceInstanceId: 'repository:42',
                maximumObservationAgeMs: 30_000,
            }),
            executionRecipe: expect.objectContaining({
                templateVersion: 1,
                template: { t: 'plain', v: { v: 1, prompt: 'Triage {{input}}' } },
                target: expect.objectContaining({ kind: 'newSession' }),
            }),
        }));
        expect(loadDaemonMergedProjectionInputsSpy).toHaveBeenCalledWith({
            machineId: 'watcher-machine',
            serverId: 'server-a',
            staleMs: 0,
        });
        if (expectedAlert) {
            expect(refreshAutomationsSpy).not.toHaveBeenCalled();
            expect(routerReplace).not.toHaveBeenCalled();
            expect(modalAlertSpy).toHaveBeenCalledWith(...expectedAlert);
        } else {
            expect(refreshAutomationsSpy).toHaveBeenCalledTimes(1);
            expect(routerReplace).toHaveBeenCalledWith('/automations');
        }
    });

    it('rejects Composer attachments before Event Automation creation and retains the New Session draft', async () => {
        const {
            useCreateNewSession,
            captured,
            automationCaptured,
            pluginEventAutomationCaptured,
            accountEncryptionMode,
            currentPluginEventProjection,
            loadDaemonMergedProjectionInputsSpy,
            refreshAutomationsSpy,
            modalAlertSpy,
            clearNewSessionDraftSpy,
        } = await setupUseCreateNewSessionHarness();
        accountEncryptionMode.value = 'plain';

        const event = createPluginEventEligibleEvent();
        currentPluginEventProjection.value = projectionInputsForPluginEvent(event);
        const eventDraft = createPluginEventAutomationAuthoringDraft({
            eligibleEvent: event,
            observation: { kind: 'checkpointedPull' },
            setupResult: {
                v: 1,
                sourceInstanceId: 'repository:42',
                sourceContractVersion: 3,
                sourceConfig: { repositoryId: '42' },
                displayLabel: 'acme/widgets',
            },
            watcherOrigin: {
                serverIdentityId: 'srv_account_a',
                materializationRef: {
                    machineId: 'watcher-machine',
                    materializationId: 'github-materialization-a',
                    pluginId: 'acme.github',
                },
            },
            filter: {
                v: 1,
                all: [{ op: 'eq', field: '/action', value: 'opened' }],
            },
            maximumObservationAgeMs: 30_000,
        });
        expect(eventDraft).not.toBeNull();
        if (!eventDraft) throw new Error('Expected a valid Event Automation draft');
        const verifiedEventDraft = eventDraft;

        let handleCreateSession: null | ReturnType<typeof useCreateNewSession>['handleCreateSession'] = null;
        const routerReplace = vi.fn();
        const disableDraftPersistence = vi.fn();
        const setIsCreating = vi.fn();
        const settlements: NewSessionAfterCreatedSettlement[] = [];
        const automationDraft: NewSessionAutomationDraft = {
            enabled: true,
            name: 'Repository triage',
            description: 'Run on repository updates',
            scheduleKind: 'interval',
            everyMinutes: 60,
            cronExpr: '0 * * * *',
            timezone: null,
        };
        const machineEnvPresence: UseMachineEnvPresenceResult = {
            isPreviewEnvSupported: false,
            isLoading: false,
            meta: {},
            refreshedAt: null,
            refresh: () => {},
        };

        function Test() {
            const hook = useCreateNewSession({
                launchIntentSignature: 'event-automation-composer-attachment',
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
                promptStore: createNewSessionPromptStore('Triage {{input}}'),
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
                eventAutomationDraft: {
                    draft: verifiedEventDraft,
                    resolveFreshWatcherOrigin: () => freshPluginEventExecutionOrigin(verifiedEventDraft.watcherOrigin),
                },
                eventAutomationTargetKind: 'newSession',
                resolveEventAutomationTarget: resolveNewSessionEventTarget,
                authoringDraft: buildAutomationAuthoringDraft({
                    prompt: 'Triage {{input}}',
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
        expect(pluginEventAutomationCaptured.value).toBeNull();
        expect(loadDaemonMergedProjectionInputsSpy).not.toHaveBeenCalled();
        expect(refreshAutomationsSpy).not.toHaveBeenCalled();
        expect(routerReplace).not.toHaveBeenCalled();
        expect(disableDraftPersistence).not.toHaveBeenCalled();
        expect(clearNewSessionDraftSpy).not.toHaveBeenCalled();
        expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'newSession.failedToStart');
        expect(settlements).toEqual([{ status: 'rejected' }]);
        expect(setIsCreating).toHaveBeenLastCalledWith(false);
    });

    it('persists a picked Session reference into the existing-Session Event recipe', async () => {
        const {
            useCreateNewSession,
            captured,
            automationCaptured,
            pluginEventAutomationCaptured,
            accountEncryptionMode,
            currentPluginEventProjection,
            refreshAutomationsSpy,
            modalAlertSpy,
        } = await setupUseCreateNewSessionHarness();
        accountEncryptionMode.value = 'plain';

        const event = createPluginEventEligibleEvent();
        currentPluginEventProjection.value = projectionInputsForPluginEvent(event);
        const eventDraft = createPluginEventAutomationAuthoringDraft({
            eligibleEvent: event,
            observation: { kind: 'checkpointedPull' },
            setupResult: {
                v: 1,
                sourceInstanceId: 'repository:42',
                sourceContractVersion: 3,
                sourceConfig: { repositoryId: '42' },
                displayLabel: 'acme/widgets',
            },
            watcherOrigin: {
                serverIdentityId: 'srv_account_a',
                materializationRef: {
                    machineId: 'watcher-machine',
                    materializationId: 'github-materialization-a',
                    pluginId: 'acme.github',
                },
            },
            filter: {
                v: 1,
                all: [{ op: 'eq', field: '/action', value: 'opened' }],
            },
            maximumObservationAgeMs: 30_000,
        });
        expect(eventDraft).not.toBeNull();
        if (!eventDraft) throw new Error('Expected a valid Event Automation draft');
        const verifiedEventDraft = eventDraft;

        const sessionMention = {
            kind: MENTION_KIND_V1.session,
            ref: buildMentionRefForKindV1(MENTION_KIND_V1.session, 'sess_01HZX'),
            token: '@session:nightly-audit-1HZX',
            label: 'Nightly audit',
        } as const;
        const prompt = 'Continue @session:nightly-audit-1HZX with {{input}}';

        let handleCreateSession: null | ReturnType<typeof useCreateNewSession>['handleCreateSession'] = null;
        const routerReplace = vi.fn();
        const settlements: NewSessionAfterCreatedSettlement[] = [];
        const machineEnvPresence: UseMachineEnvPresenceResult = {
            isPreviewEnvSupported: false,
            isLoading: false,
            meta: {},
            refreshedAt: null,
            refresh: () => {},
        };

        function Test() {
            const hook = useCreateNewSession({
                launchIntentSignature: 'event-automation-existing-session-composer-reference',
                router: { push: vi.fn(), replace: routerReplace },
                selectedMachineId: 'm1',
                selectedPath: '/tmp',
                selectedMachine: { metadata: {} },
                setIsCreating: vi.fn(),
                setIsResumeSupportChecking: vi.fn(),
                settings: { experiments: false } as unknown as Settings,
                useProfiles: false,
                selectedProfileId: null,
                profileMap: new Map(),
                recentMachinePaths: [],
                agentType: 'codex',
                permissionMode: 'acceptEdits' as unknown as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore(prompt),
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
                disableDraftPersistence: vi.fn(),
                eventAutomationDraft: {
                    draft: verifiedEventDraft,
                    resolveFreshWatcherOrigin: () => freshPluginEventExecutionOrigin(verifiedEventDraft.watcherOrigin),
                },
                eventAutomationTargetKind: 'existingSession',
                resolveEventAutomationTarget: resolveExistingSessionEventTarget,
                authoringDraft: buildAutomationAuthoringDraft({
                    prompt,
                    modelMode: 'default' as ModelMode,
                    permissionMode: 'acceptEdits' as unknown as PermissionMode,
                    automation: {
                        enabled: true,
                        name: 'Nightly follow-up',
                        description: 'Continue the audit thread',
                        scheduleKind: 'interval',
                        everyMinutes: 60,
                        cronExpr: '0 * * * *',
                        timezone: null,
                    },
                    transcriptStorage: 'direct',
                }),
            });
            handleCreateSession = hook.handleCreateSession;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));
        await act(async () => {
            await invokeHandleCreateSession(handleCreateSession, {
                composerReferences: [sessionMention],
                onAfterCreatedSettled: (settlement) => settlements.push(settlement),
            });
        });

        // The Session mention the user picked reaches the durable template in
        // the SAME identity-only shape an interactive send persists, because
        // this target's dispatch hands it to the canonical Session sender.
        expect(captured.value).toBeNull();
        expect(automationCaptured.value).toBeNull();
        expect(accountEncryptionMode.fetchAccountEncryptionMode).toHaveBeenCalledTimes(1);
        expect(modalAlertSpy).not.toHaveBeenCalled();
        expect(pluginEventAutomationCaptured.value).toEqual(expect.objectContaining({
            executionRecipe: expect.objectContaining({
                template: {
                    t: 'plain',
                    v: { v: 1, prompt, mentions: [sessionMention] },
                },
                target: { kind: 'existingSession', sessionId: 'sess_existing_target' },
            }),
        }));
        expect(refreshAutomationsSpy).toHaveBeenCalledTimes(1);
        expect(settlements).toEqual([{ status: 'accepted', sessionId: null }]);
    });

    it('rejects an unpersistable reference on the execution-run Event target through the same guard', async () => {
        const {
            useCreateNewSession,
            captured,
            automationCaptured,
            pluginEventAutomationCaptured,
            accountEncryptionMode,
            currentPluginEventProjection,
            refreshAutomationsSpy,
            modalAlertSpy,
            clearNewSessionDraftSpy,
        } = await setupUseCreateNewSessionHarness();
        accountEncryptionMode.value = 'plain';

        const event = createPluginEventEligibleEvent();
        currentPluginEventProjection.value = projectionInputsForPluginEvent(event);
        const eventDraft = createPluginEventAutomationAuthoringDraft({
            eligibleEvent: event,
            observation: { kind: 'checkpointedPull' },
            setupResult: {
                v: 1,
                sourceInstanceId: 'repository:42',
                sourceContractVersion: 3,
                sourceConfig: { repositoryId: '42' },
                displayLabel: 'acme/widgets',
            },
            watcherOrigin: {
                serverIdentityId: 'srv_account_a',
                materializationRef: {
                    machineId: 'watcher-machine',
                    materializationId: 'github-materialization-a',
                    pluginId: 'acme.github',
                },
            },
            filter: {
                v: 1,
                all: [{ op: 'eq', field: '/action', value: 'opened' }],
            },
            maximumObservationAgeMs: 30_000,
        });
        expect(eventDraft).not.toBeNull();
        if (!eventDraft) throw new Error('Expected a valid Event Automation draft');
        const verifiedEventDraft = eventDraft;

        let handleCreateSession: null | ReturnType<typeof useCreateNewSession>['handleCreateSession'] = null;
        const routerReplace = vi.fn();
        const disableDraftPersistence = vi.fn();
        const setIsCreating = vi.fn();
        const settlements: NewSessionAfterCreatedSettlement[] = [];
        const machineEnvPresence: UseMachineEnvPresenceResult = {
            isPreviewEnvSupported: false,
            isLoading: false,
            meta: {},
            refreshedAt: null,
            refresh: () => {},
        };

        function Test() {
            const hook = useCreateNewSession({
                launchIntentSignature: 'event-automation-execution-run-composer-reference',
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
                promptStore: createNewSessionPromptStore('Triage @session:nightly-audit-1HZX'),
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
                eventAutomationDraft: {
                    draft: verifiedEventDraft,
                    resolveFreshWatcherOrigin: () => freshPluginEventExecutionOrigin(verifiedEventDraft.watcherOrigin),
                },
                eventAutomationTargetKind: 'executionRun',
                resolveEventAutomationTarget: resolveNewSessionEventTarget,
                authoringDraft: buildAutomationAuthoringDraft({
                    prompt: 'Triage @session:nightly-audit-1HZX',
                    modelMode: 'default' as ModelMode,
                    permissionMode: 'acceptEdits' as unknown as PermissionMode,
                    automation: {
                        enabled: true,
                        name: 'Repository triage',
                        description: 'Run on repository updates',
                        scheduleKind: 'interval',
                        everyMinutes: 60,
                        cronExpr: '0 * * * *',
                        timezone: null,
                    },
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

        // The execution-run Event target persists the same rendered prompt, so
        // it fails closed through the ONE refusal owner rather than through a
        // second, reference-blind condition of its own.
        expect(captured.value).toBeNull();
        expect(automationCaptured.value).toBeNull();
        expect(pluginEventAutomationCaptured.value).toBeNull();
        expect(refreshAutomationsSpy).not.toHaveBeenCalled();
        expect(routerReplace).not.toHaveBeenCalled();
        expect(disableDraftPersistence).not.toHaveBeenCalled();
        expect(clearNewSessionDraftSpy).not.toHaveBeenCalled();
        expect(modalAlertSpy).toHaveBeenCalledWith(
            'common.error',
            'automations.unsupportedReference(reference=@session:nightly-audit-1HZX)',
        );
        expect(settlements).toEqual([{ status: 'rejected' }]);
        expect(setIsCreating).toHaveBeenLastCalledWith(false);
    });

    it('fails closed when the same Event setup Action is replaced after setup but before V3 creation', async () => {
        const {
            useCreateNewSession,
            captured,
            automationCaptured,
            pluginEventAutomationCaptured,
            currentPluginEventProjection,
            loadDaemonMergedProjectionInputsSpy,
            modalAlertSpy,
            refreshAutomationsSpy,
            accountEncryptionMode,
        } = await setupUseCreateNewSessionHarness();
        accountEncryptionMode.value = 'plain';

        const setupEvent = createPluginEventEligibleEvent('github-generation-a');
        const replacement = createPluginEventEligibleEvent('github-generation-b');
        currentPluginEventProjection.value = projectionInputsForPluginEvent(replacement);
        const eventDraft = createPluginEventAutomationAuthoringDraft({
            eligibleEvent: setupEvent,
            observation: { kind: 'checkpointedPull' },
            setupResult: {
                v: 1,
                sourceInstanceId: 'repository:42',
                sourceContractVersion: 3,
                sourceConfig: { repositoryId: '42' },
                displayLabel: 'acme/widgets',
            },
            watcherOrigin: {
                serverIdentityId: 'srv_account_a',
                materializationRef: {
                    machineId: 'watcher-machine',
                    materializationId: 'github-materialization-a',
                    pluginId: 'acme.github',
                },
            },
            filter: null,
            maximumObservationAgeMs: null,
        });
        expect(eventDraft).not.toBeNull();
        if (!eventDraft) throw new Error('Expected a valid Event Automation draft');
        const verifiedEventDraft = eventDraft;

        let handleCreateSession: null | (() => Promise<void>) = null;
        const routerReplace = vi.fn();
        const automationDraft: NewSessionAutomationDraft = {
            enabled: true,
            name: 'Repository triage',
            description: 'Run on repository updates',
            scheduleKind: 'interval',
            everyMinutes: 60,
            cronExpr: '0 * * * *',
            timezone: null,
        };
        const machineEnvPresence: UseMachineEnvPresenceResult = {
            isPreviewEnvSupported: false,
            isLoading: false,
            meta: {},
            refreshedAt: null,
            refresh: () => {},
        };

        function Test() {
            const hook = useCreateNewSession({
                launchIntentSignature: 'event-automation-replaced-before-create',
                router: { push: vi.fn(), replace: routerReplace },
                selectedMachineId: 'm1',
                selectedPath: '/tmp',
                selectedMachine: { metadata: {} },
                setIsCreating: vi.fn(),
                setIsResumeSupportChecking: vi.fn(),
                settings: { experiments: false } as unknown as Settings,
                useProfiles: false,
                selectedProfileId: null,
                profileMap: new Map(),
                recentMachinePaths: [],
                agentType: 'codex',
                permissionMode: 'acceptEdits' as unknown as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore('Triage {{input}}'),
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
                eventAutomationDraft: {
                    draft: verifiedEventDraft,
                    resolveFreshWatcherOrigin: () => freshPluginEventExecutionOrigin(verifiedEventDraft.watcherOrigin),
                },
                eventAutomationTargetKind: 'newSession',
                resolveEventAutomationTarget: resolveNewSessionEventTarget,
                authoringDraft: buildAutomationAuthoringDraft({
                    prompt: 'Triage {{input}}',
                    modelMode: 'default' as ModelMode,
                    permissionMode: 'acceptEdits' as unknown as PermissionMode,
                    automation: automationDraft,
                    transcriptStorage: 'direct',
                }),
            });
            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));
        await act(async () => {
            await handleCreateSession?.();
        });

        expect(loadDaemonMergedProjectionInputsSpy).toHaveBeenCalledWith({
            machineId: 'watcher-machine',
            serverId: 'server-a',
            staleMs: 0,
        });
        expect(captured.value).toBeNull();
        expect(automationCaptured.value).toBeNull();
        expect(pluginEventAutomationCaptured.value).toBeNull();
        expect(refreshAutomationsSpy).not.toHaveBeenCalled();
        expect(routerReplace).not.toHaveBeenCalled();
        expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'newSession.failedToStart');
    });

    it('patches an exact current disabled Plugin Event Automation through V3 with the direct-detail version fence', async () => {
        const {
            useCreateNewSession,
            captured,
            automationCaptured,
            pluginEventAutomationCaptured,
            pluginEventAutomationPatchCaptured,
            refreshAutomationDefinitionDetailSpy,
            refreshAutomationsSpy,
            updateAutomationSpy,
            accountEncryptionMode,
            currentPluginEventProjection,
            loadDaemonMergedProjectionInputsSpy,
        } = await setupUseCreateNewSessionHarness();
        accountEncryptionMode.value = 'plain';
        refreshAutomationDefinitionDetailSpy.mockResolvedValueOnce(
            createStrictPluginEventAutomationDefinition('event_current', 3, false, [
                { machineId: 'assignment-primary', enabled: true, priority: 100, updatedAt: 30 },
                { machineId: 'assignment-disabled', enabled: false, priority: -20, updatedAt: 31 },
                { machineId: 'assignment-secondary', enabled: true, priority: 7, updatedAt: null },
            ]),
        );

        const event = createPluginEventEligibleEvent();
        currentPluginEventProjection.value = projectionInputsForPluginEvent(event);
        const eventDraft = createPluginEventAutomationAuthoringDraft({
            eligibleEvent: event,
            observation: { kind: 'checkpointedPull' },
            setupResult: {
                v: 1,
                sourceInstanceId: 'repository:42',
                sourceContractVersion: 3,
                sourceConfig: { repositoryId: '42' },
                displayLabel: 'acme/widgets',
            },
            watcherOrigin: {
                serverIdentityId: 'srv_account_a',
                materializationRef: {
                    machineId: 'watcher-machine',
                    materializationId: 'github-materialization-a',
                    pluginId: 'acme.github',
                },
            },
            filter: null,
            maximumObservationAgeMs: 60_000,
        });
        expect(eventDraft).not.toBeNull();
        if (!eventDraft) throw new Error('Expected a valid Event Automation draft');
        const verifiedEventDraft = eventDraft;

        let handleCreateSession: null | ((options?: HandleCreateSessionOptions) => void) = null;
        const routerReplace = vi.fn();
        const settlements: NewSessionAfterCreatedSettlement[] = [];
        const automationDraft: NewSessionAutomationDraft = {
            enabled: false,
            name: 'Repository triage update',
            description: 'Updated repository automation',
            scheduleKind: 'interval',
            everyMinutes: 60,
            cronExpr: '0 * * * *',
            timezone: null,
        };
        const machineEnvPresence: UseMachineEnvPresenceResult = {
            isPreviewEnvSupported: false,
            isLoading: false,
            meta: {},
            refreshedAt: null,
            refresh: () => {},
        };

        function Test() {
            const hook = useCreateNewSession({
                launchIntentSignature: 'event-automation-patch',
                router: { push: vi.fn(), replace: routerReplace },
                selectedMachineId: 'm1',
                selectedPath: '/tmp',
                selectedMachine: { metadata: {} },
                setIsCreating: vi.fn(),
                setIsResumeSupportChecking: vi.fn(),
                settings: { experiments: false } as unknown as Settings,
                useProfiles: false,
                selectedProfileId: null,
                profileMap: new Map(),
                recentMachinePaths: [],
                agentType: 'codex',
                permissionMode: 'acceptEdits' as unknown as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore('Triage changed {{input}}'),
                automationEditId: 'event_current',
                eventAutomationEdit: {
                    automationId: 'event_current',
                    expectedTemplateVersion: 3,
                },
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
                eventAutomationDraft: {
                    draft: verifiedEventDraft,
                    resolveFreshWatcherOrigin: () => freshPluginEventExecutionOrigin(verifiedEventDraft.watcherOrigin),
                },
                eventAutomationTargetKind: 'newSession',
                resolveEventAutomationTarget: resolveNewSessionEventTarget,
                authoringDraft: buildNewSessionAuthoringDraft({
                    directory: '/hydrated/project',
                    checkoutCreationDraft: {
                        kind: 'git_worktree',
                        displayName: 'Hydrated Event checkout',
                        baseRef: 'main',
                    },
                    prompt: 'Triage changed {{input}}',
                    displayText: 'Triage changed {{input}}',
                    agentId: 'codex',
                    backendTarget: { kind: 'backend', backendId: 'codex' },
                    transcriptStorage: 'direct',
                    profileId: 'profile-hydrated',
                    environmentVariables: null,
                    resumeSessionId: 'provider-session-hydrated',
                    permissionMode: 'plan',
                    permissionModeUpdatedAt: 99,
                    modelSelection: SessionModelSelectionV1Schema.parse({
                        v: 1,
                        updatedAt: 100,
                        ref: {
                            agentTargetKey: 'backend:codex',
                            providerConnectionId: null,
                            modelId: 'gpt-5',
                        },
                    }),
                    mcpSelection: {
                        v: 1,
                        managedServersEnabled: false,
                        forceIncludeServerIds: ['hydrated-mcp'],
                        forceExcludeServerIds: ['legacy-mcp'],
                    },
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            github: { source: 'connected', selection: 'profile', profileId: 'hydrated-github' },
                        },
                    },
                    terminal: {
                        mode: 'tmux',
                        tmux: { sessionName: 'hydrated-event' },
                        windows: { launchMode: 'windows_terminal', console: 'visible', windowName: 'hydrated' },
                    },
                    windowsRemoteSessionLaunchMode: 'windows_terminal',
                    windowsRemoteSessionConsole: 'visible',
                    windowsTerminalWindowName: 'hydrated',
                    experimentalCodexAcp: null,
                    codexBackendMode: null,
                    acpSessionModeId: 'plan',
                    sessionConfigOptionOverrides: {
                        v: 1,
                        updatedAt: 102,
                        overrides: {
                            reasoning: { value: 'high', updatedAt: 102 },
                        },
                    },
                    automation: automationDraft,
                }),
            });
            handleCreateSession = hook.handleCreateSession;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));
        await act(async () => {
            await invokeHandleCreateSession(handleCreateSession, {
                onAfterCreatedSettled: (settlement) => settlements.push(settlement),
            });
        });

        // The V3 Event writer persisted the patch; the Composer document owner
        // must be told the submission was accepted even though no Session id
        // exists to name.
        expect(settlements).toEqual([{ status: 'accepted', sessionId: null }]);
        expect(refreshAutomationDefinitionDetailSpy).toHaveBeenCalledWith('event_current');
        expect(captured.value).toBeNull();
        expect(automationCaptured.value).toBeNull();
        expect(pluginEventAutomationCaptured.value).toBeNull();
        expect(updateAutomationSpy).not.toHaveBeenCalled();
        expect(pluginEventAutomationPatchCaptured.value).toEqual(expect.objectContaining({
            automationId: 'event_current',
            input: expect.objectContaining({
                expectedTemplateVersion: 3,
                name: 'Current event automation',
                description: null,
                enabled: false,
                trigger: expect.objectContaining({
                    kind: 'pluginEvent',
                    eventRef: { pluginId: 'acme.github', localId: 'events/repository' },
                    sourceInstanceId: 'repository:42',
                }),
                executionRecipe: expect.objectContaining({
                    templateVersion: 4,
                    template: { t: 'plain', v: { v: 1, prompt: 'Triage changed {{input}}' } },
                    target: {
                        kind: 'newSession',
                        spawn: expect.objectContaining({
                            executionTarget: { serverId: 'seeded-server', machineId: 'seeded-machine' },
                            organizationPlacement: { folderId: 'seeded-folder', tagIds: ['seeded-tag'] },
                            directory: '/hydrated/project',
                            profileId: 'profile-hydrated',
                            permissionMode: 'plan',
                            configuration: expect.objectContaining({
                                mode: { value: 'plan', updatedAtMs: 99 },
                                permissionIntent: { value: 'plan', updatedAtMs: 99 },
                            }),
                            connectedServices: {
                                v: 1,
                                bindingsByServiceId: {
                                    github: { source: 'connected', selection: 'profile', profileId: 'hydrated-github' },
                                },
                            },
                            terminal: {
                                mode: 'tmux',
                                tmux: { sessionName: 'hydrated-event' },
                                windows: { launchMode: 'windows_terminal', console: 'visible', windowName: 'hydrated' },
                            },
                        }),
                    },
                }),
                assignments: [
                    { machineId: 'assignment-primary', enabled: true, priority: 100 },
                    { machineId: 'assignment-disabled', enabled: false, priority: -20 },
                    { machineId: 'assignment-secondary', enabled: true, priority: 7 },
                ],
            }),
        }));
        expect(loadDaemonMergedProjectionInputsSpy).toHaveBeenCalledWith({
            machineId: 'watcher-machine',
            serverId: 'server-a',
            staleMs: 0,
        });
        expect(refreshAutomationsSpy).toHaveBeenCalledTimes(1);
        expect(routerReplace).toHaveBeenCalledWith('/automations/event_current');
    });

    it('handles a typed stale V3 Event patch conflict without falling through to either V2 writer', async () => {
        const {
            useCreateNewSession,
            captured,
            automationCaptured,
            pluginEventAutomationCaptured,
            pluginEventAutomationPatchCaptured,
            pluginEventAutomationPatchError,
            modalAlertSpy,
            refreshAutomationDefinitionDetailSpy,
            refreshAutomationsSpy,
            updateAutomationSpy,
            accountEncryptionMode,
            currentPluginEventProjection,
        } = await setupUseCreateNewSessionHarness();
        accountEncryptionMode.value = 'plain';
        refreshAutomationDefinitionDetailSpy.mockResolvedValueOnce(
            createStrictPluginEventAutomationDefinition('event_current', 3),
        );
        const { AutomationApiError } = await import('@/sync/api/automations/apiAutomations');
        pluginEventAutomationPatchError.value = new AutomationApiError({
            code: 'automation_template_version_conflict',
            status: 409,
        });

        const event = createPluginEventEligibleEvent();
        currentPluginEventProjection.value = projectionInputsForPluginEvent(event);
        const eventDraft = createPluginEventAutomationAuthoringDraft({
            eligibleEvent: event,
            observation: { kind: 'checkpointedPull' },
            setupResult: {
                v: 1,
                sourceInstanceId: 'repository:42',
                sourceContractVersion: 3,
                sourceConfig: { repositoryId: '42' },
                displayLabel: 'acme/widgets',
            },
            watcherOrigin: {
                serverIdentityId: 'srv_account_a',
                materializationRef: {
                    machineId: 'watcher-machine',
                    materializationId: 'github-materialization-a',
                    pluginId: 'acme.github',
                },
            },
            filter: null,
            maximumObservationAgeMs: null,
        });
        expect(eventDraft).not.toBeNull();
        if (!eventDraft) throw new Error('Expected a valid Event Automation draft');
        const verifiedEventDraft = eventDraft;

        let handleCreateSession: null | (() => Promise<void>) = null;
        const routerReplace = vi.fn();
        const automationDraft: NewSessionAutomationDraft = {
            enabled: true,
            name: 'Repository triage update',
            description: 'Updated repository automation',
            scheduleKind: 'interval',
            everyMinutes: 60,
            cronExpr: '0 * * * *',
            timezone: null,
        };
        const machineEnvPresence: UseMachineEnvPresenceResult = {
            isPreviewEnvSupported: false,
            isLoading: false,
            meta: {},
            refreshedAt: null,
            refresh: () => {},
        };

        function Test() {
            const hook = useCreateNewSession({
                launchIntentSignature: 'event-automation-patch-conflict',
                router: { push: vi.fn(), replace: routerReplace },
                selectedMachineId: 'm1',
                selectedPath: '/tmp',
                selectedMachine: { metadata: {} },
                setIsCreating: vi.fn(),
                setIsResumeSupportChecking: vi.fn(),
                settings: { experiments: false } as unknown as Settings,
                useProfiles: false,
                selectedProfileId: null,
                profileMap: new Map(),
                recentMachinePaths: [],
                agentType: 'codex',
                permissionMode: 'acceptEdits' as unknown as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore('Triage changed {{input}}'),
                automationEditId: 'event_current',
                eventAutomationEdit: {
                    automationId: 'event_current',
                    expectedTemplateVersion: 3,
                },
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
                eventAutomationDraft: {
                    draft: verifiedEventDraft,
                    resolveFreshWatcherOrigin: () => freshPluginEventExecutionOrigin(verifiedEventDraft.watcherOrigin),
                },
                eventAutomationTargetKind: 'newSession',
                resolveEventAutomationTarget: resolveNewSessionEventTarget,
                authoringDraft: buildAutomationAuthoringDraft({
                    prompt: 'Triage changed {{input}}',
                    modelMode: 'default' as ModelMode,
                    permissionMode: 'acceptEdits' as unknown as PermissionMode,
                    permissionModeUpdatedAt: 1,
                    backendTarget: { kind: 'backend', backendId: 'codex' },
                    automation: automationDraft,
                    transcriptStorage: 'direct',
                }),
            });
            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));
        await act(async () => {
            await handleCreateSession?.();
        });

        expect(pluginEventAutomationPatchCaptured.value).toEqual(expect.objectContaining({
            automationId: 'event_current',
            input: expect.objectContaining({ expectedTemplateVersion: 3 }),
        }));
        expect(captured.value).toBeNull();
        expect(automationCaptured.value).toBeNull();
        expect(pluginEventAutomationCaptured.value).toBeNull();
        expect(updateAutomationSpy).not.toHaveBeenCalled();
        expect(refreshAutomationsSpy).not.toHaveBeenCalled();
        expect(routerReplace).not.toHaveBeenCalled();
        expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'automations.edit.updateFailed');
    });

    it('fails closed when the direct Event detail version advanced since the edit was opened', async () => {
        const {
            useCreateNewSession,
            captured,
            automationCaptured,
            pluginEventAutomationCaptured,
            pluginEventAutomationPatchCaptured,
            modalAlertSpy,
            refreshAutomationDefinitionDetailSpy,
            refreshAutomationsSpy,
            updateAutomationSpy,
            accountEncryptionMode,
        } = await setupUseCreateNewSessionHarness();
        accountEncryptionMode.value = 'plain';
        refreshAutomationDefinitionDetailSpy.mockResolvedValueOnce(
            createStrictPluginEventAutomationDefinition('event_current', 4),
        );

        const eventDraft: PluginEventAutomationAuthoringDraft = {
            eventRef: { pluginId: 'acme.github', localId: 'events/repository' },
            observation: { kind: 'checkpointedPull' },
            expectedEventImmutableGenerationId: 'github-generation-a',
            setupActionRef: { pluginId: 'acme.github', localId: 'setup/repository-source' },
            expectedSetupActionImmutableGenerationId: 'github-generation-a',
            source: {
                v: 1,
                sourceInstanceId: 'repository:42',
                sourceContractVersion: 3,
                sourceConfig: { repositoryId: '42' },
                displayLabel: 'acme/widgets',
            },
            watcherOrigin: {
                serverIdentityId: 'srv_account_a',
                materializationRef: {
                    machineId: 'watcher-machine',
                    materializationId: 'github-materialization-a',
                    pluginId: 'acme.github',
                },
            },
            filter: null,
            maximumObservationAgeMs: null,
        };
        const automationDraft: NewSessionAutomationDraft = {
            enabled: true,
            name: 'Repository triage update',
            description: 'Updated repository automation',
            scheduleKind: 'interval',
            everyMinutes: 60,
            cronExpr: '0 * * * *',
            timezone: null,
        };
        const machineEnvPresence: UseMachineEnvPresenceResult = {
            isPreviewEnvSupported: false,
            isLoading: false,
            meta: {},
            refreshedAt: null,
            refresh: () => {},
        };
        let handleCreateSession: null | (() => Promise<void>) = null;
        const routerReplace = vi.fn();

        function Test() {
            const hook = useCreateNewSession({
                launchIntentSignature: 'event-automation-stale-detail',
                router: { push: vi.fn(), replace: routerReplace },
                selectedMachineId: 'm1',
                selectedPath: '/tmp',
                selectedMachine: { metadata: {} },
                setIsCreating: vi.fn(),
                setIsResumeSupportChecking: vi.fn(),
                settings: { experiments: false } as unknown as Settings,
                useProfiles: false,
                selectedProfileId: null,
                profileMap: new Map(),
                recentMachinePaths: [],
                agentType: 'codex',
                permissionMode: 'acceptEdits' as unknown as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore('Triage changed {{input}}'),
                automationEditId: 'event_current',
                eventAutomationEdit: {
                    automationId: 'event_current',
                    expectedTemplateVersion: 3,
                },
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
                eventAutomationDraft: {
                    draft: eventDraft,
                    resolveFreshWatcherOrigin: () => freshPluginEventExecutionOrigin(eventDraft.watcherOrigin),
                },
                eventAutomationTargetKind: 'newSession',
                resolveEventAutomationTarget: resolveNewSessionEventTarget,
                authoringDraft: buildAutomationAuthoringDraft({
                    prompt: 'Triage changed {{input}}',
                    modelMode: 'default' as ModelMode,
                    permissionMode: 'acceptEdits' as unknown as PermissionMode,
                    automation: automationDraft,
                    transcriptStorage: 'direct',
                }),
            });
            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));
        await act(async () => {
            await handleCreateSession?.();
        });

        expect(refreshAutomationDefinitionDetailSpy).toHaveBeenCalledWith('event_current');
        expect(captured.value).toBeNull();
        expect(automationCaptured.value).toBeNull();
        expect(pluginEventAutomationCaptured.value).toBeNull();
        expect(pluginEventAutomationPatchCaptured.value).toBeNull();
        expect(updateAutomationSpy).not.toHaveBeenCalled();
        expect(refreshAutomationsSpy).not.toHaveBeenCalled();
        expect(routerReplace).not.toHaveBeenCalled();
        expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'automations.edit.updateFailed');
    });

    it('fails closed for an E2EE Account before either Automation writer can persist an Event draft', async () => {
        const {
            useCreateNewSession,
            automationCaptured,
            pluginEventAutomationCaptured,
            pluginEventAutomationPatchCaptured,
            accountEncryptionMode,
            modalAlertSpy,
            refreshAutomationDefinitionDetailSpy,
            updateAutomationSpy,
        } = await setupUseCreateNewSessionHarness();
        accountEncryptionMode.value = 'e2ee';

        const eventDraft: PluginEventAutomationAuthoringDraft = {
            eventRef: { pluginId: 'acme.github', localId: 'events/repository' },
            observation: { kind: 'checkpointedPull' },
            expectedEventImmutableGenerationId: 'github-generation-a',
            setupActionRef: { pluginId: 'acme.github', localId: 'setup/repository-source' },
            expectedSetupActionImmutableGenerationId: 'github-generation-a',
            source: {
                v: 1,
                sourceInstanceId: 'repository:42',
                sourceContractVersion: 3,
                sourceConfig: { repositoryId: '42' },
                displayLabel: 'acme/widgets',
            },
            watcherOrigin: {
                serverIdentityId: 'srv_account_a',
                materializationRef: {
                    machineId: 'watcher-machine',
                    materializationId: 'github-materialization-a',
                    pluginId: 'acme.github',
                },
            },
            filter: null,
            maximumObservationAgeMs: null,
        };
        const automationDraft: NewSessionAutomationDraft = {
            enabled: true,
            name: 'Repository triage',
            description: '',
            scheduleKind: 'interval',
            everyMinutes: 60,
            cronExpr: '0 * * * *',
            timezone: null,
        };
        const machineEnvPresence: UseMachineEnvPresenceResult = {
            isPreviewEnvSupported: false,
            isLoading: false,
            meta: {},
            refreshedAt: null,
            refresh: () => {},
        };
        let handleCreateSession: null | (() => Promise<void>) = null;

        function Test() {
            const hook = useCreateNewSession({
                launchIntentSignature: 'event-automation-e2ee',
                router: { push: vi.fn(), replace: vi.fn() },
                selectedMachineId: 'm1',
                selectedPath: '/tmp',
                selectedMachine: { metadata: {} },
                setIsCreating: vi.fn(),
                setIsResumeSupportChecking: vi.fn(),
                settings: { experiments: false } as unknown as Settings,
                useProfiles: false,
                selectedProfileId: null,
                profileMap: new Map(),
                recentMachinePaths: [],
                agentType: 'codex',
                permissionMode: 'acceptEdits' as unknown as PermissionMode,
                modelMode: 'default' as ModelMode,
                promptStore: createNewSessionPromptStore('Triage {{input}}'),
                automationEditId: 'event_current',
                eventAutomationEdit: {
                    automationId: 'event_current',
                    expectedTemplateVersion: 3,
                },
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
                eventAutomationDraft: {
                    draft: eventDraft,
                    resolveFreshWatcherOrigin: () => freshPluginEventExecutionOrigin(eventDraft.watcherOrigin),
                },
                eventAutomationTargetKind: 'newSession',
                resolveEventAutomationTarget: resolveNewSessionEventTarget,
                authoringDraft: buildAutomationAuthoringDraft({
                    prompt: 'Triage {{input}}',
                    modelMode: 'default' as ModelMode,
                    permissionMode: 'acceptEdits' as unknown as PermissionMode,
                    automation: automationDraft,
                    transcriptStorage: 'direct',
                }),
            });
            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));
        await act(async () => {
            await handleCreateSession?.();
        });

        expect(automationCaptured.value).toBeNull();
        expect(pluginEventAutomationCaptured.value).toBeNull();
        expect(pluginEventAutomationPatchCaptured.value).toBeNull();
        expect(updateAutomationSpy).not.toHaveBeenCalled();
        expect(refreshAutomationDefinitionDetailSpy).not.toHaveBeenCalled();
        expect(modalAlertSpy).toHaveBeenCalledWith(
            'settingsPlugins.eventAutomationComposer.storedContentUnavailableTitle',
            'settingsPlugins.eventAutomationComposer.storedContentUnavailableBody',
        );
    });

    it('updates an existing automation instead of creating a new one when automationEditId is provided', async () => {
        const {
            useCreateNewSession,
            captured,
            automationCaptured,
            refreshAutomationsSpy,
            updateAutomationSpy,
            materializeNewSessionCheckoutSpy,
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
        const automationDraft: NewSessionAutomationDraft = {
            enabled: true,
            name: 'Nightly edit',
            description: 'desc',
            scheduleKind: 'interval',
            everyMinutes: 30,
            cronExpr: '0 * * * *',
            timezone: null,
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
                settings,
                useProfiles: false,
                selectedProfileId: null,
                profileMap: new Map(),
                recentMachinePaths: [],
                agentType: 'codex',
                permissionMode: 'acceptEdits' as unknown as PermissionMode,
                modelMode: 'gpt-5' as ModelMode,
                promptStore: createNewSessionPromptStore('Update the scheduled work'),
                automationEditId: 'auto_existing',
                transcriptStorage: 'direct',
                resumeSessionId: '',
                agentNewSessionOptions: null,
                mcpSelection: null,
                machineEnvPresence,
                secrets: [],
                secretBindingsByProfileId: {},
                selectedSecretIdByProfileIdByEnvVarName: {},
                sessionOnlySecretValueByProfileIdByEnvVarName: {},
                selectedMachineCapabilities: null,
                targetServerId: null,
                allowedTargetServerIds: ['server-a'],
                authoringDraft: buildAutomationAuthoringDraft({
                    prompt: 'Update the scheduled work',
                    modelMode: 'gpt-5' as ModelMode,
                    permissionMode: 'acceptEdits' as unknown as PermissionMode,
                    automation: automationDraft,
                    transcriptStorage: 'direct',
                }),
            });

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        await act(async () => {
            await handleCreateSession?.();
        });

        expect(captured.value).toBeNull();
        expect(automationCaptured.value).toBeNull();
        expect(materializeNewSessionCheckoutSpy).not.toHaveBeenCalled();
        expect(updateAutomationSpy).toHaveBeenCalledWith('auto_existing', expect.objectContaining({
            enabled: true,
            name: 'Nightly edit',
            description: 'desc',
            schedule: {
                kind: 'interval',
                everyMs: 1_800_000,
                timezone: null,
            },
            templateCiphertext: expect.any(String),
        }));
        expect(refreshAutomationsSpy).toHaveBeenCalledTimes(1);
        expect(routerReplace).toHaveBeenCalledWith('/automations/auto_existing');
    });

    it('rejects a current Event definition from automationEditId before the retained V2 update', async () => {
        const {
            useCreateNewSession,
            automationCaptured,
            modalAlertSpy,
            refreshAutomationDefinitionDetailSpy,
            refreshAutomationsSpy,
            updateAutomationSpy,
        } = await setupUseCreateNewSessionHarness();
        refreshAutomationDefinitionDetailSpy.mockResolvedValueOnce(
            createStrictPluginEventAutomationDefinition('event_current'),
        );

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
        const automationDraft: NewSessionAutomationDraft = {
            enabled: true,
            name: 'Attempted legacy write',
            description: 'must not reach V2',
            scheduleKind: 'interval',
            everyMinutes: 30,
            cronExpr: '0 * * * *',
            timezone: null,
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
                settings,
                useProfiles: false,
                selectedProfileId: null,
                profileMap: new Map(),
                recentMachinePaths: [],
                agentType: 'codex',
                permissionMode: 'acceptEdits' as unknown as PermissionMode,
                modelMode: 'gpt-5' as ModelMode,
                promptStore: createNewSessionPromptStore('Attempted legacy write'),
                automationEditId: 'event_current',
                transcriptStorage: 'direct',
                resumeSessionId: '',
                agentNewSessionOptions: null,
                mcpSelection: null,
                machineEnvPresence,
                secrets: [],
                secretBindingsByProfileId: {},
                selectedSecretIdByProfileIdByEnvVarName: {},
                sessionOnlySecretValueByProfileIdByEnvVarName: {},
                selectedMachineCapabilities: null,
                targetServerId: null,
                allowedTargetServerIds: ['server-a'],
                authoringDraft: buildAutomationAuthoringDraft({
                    prompt: 'Attempted legacy write',
                    modelMode: 'gpt-5' as ModelMode,
                    permissionMode: 'acceptEdits' as unknown as PermissionMode,
                    automation: automationDraft,
                    transcriptStorage: 'direct',
                }),
            });

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        await act(async () => {
            await handleCreateSession?.();
        });

        expect(refreshAutomationDefinitionDetailSpy).toHaveBeenCalledWith('event_current');
        expect(updateAutomationSpy).not.toHaveBeenCalled();
        expect(automationCaptured.value).toBeNull();
        expect(refreshAutomationsSpy).not.toHaveBeenCalled();
        expect(routerReplace).not.toHaveBeenCalled();
        expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'automations.edit.updateFailed');
    });

    it('uses the latest automation draft values after rerendering before save', async () => {
        const {
            useCreateNewSession,
            updateAutomationSpy,
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
                automationEditId: 'auto_existing',
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

        const initialDraft: NewSessionAutomationDraft = {
            enabled: true,
            name: 'Nightly edit',
            description: 'desc',
            scheduleKind: 'interval',
            everyMinutes: 30,
            cronExpr: '0 * * * *',
            timezone: null,
        };
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

        expect(updateAutomationSpy).toHaveBeenCalledWith('auto_existing', expect.objectContaining({
            name: 'Nightly edit updated',
        }));
    });

    it('uses the latest automation draft values even when an older submit handler reference is invoked', async () => {
        const {
            useCreateNewSession,
            updateAutomationSpy,
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
                automationEditId: 'auto_existing',
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

        const initialDraft: NewSessionAutomationDraft = {
            enabled: true,
            name: 'Nightly edit',
            description: 'desc',
            scheduleKind: 'interval',
            everyMinutes: 30,
            cronExpr: '0 * * * *',
            timezone: null,
        };
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

        expect(updateAutomationSpy).toHaveBeenCalledWith('auto_existing', expect.objectContaining({
            name: 'Nightly edit updated again',
        }));
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
            initialMessage: 'PROMPT',
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
            initialMessage: 'PROMPT',
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

        expect(captured.value?.initialMessage).toBeUndefined();
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
