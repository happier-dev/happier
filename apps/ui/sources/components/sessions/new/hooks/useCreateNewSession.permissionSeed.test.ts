import React from 'react';
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
    type SessionMcpSelectionV1,
} from '@happier-dev/protocol';
import { AIBackendProfileSchema } from '@/sync/domains/profiles/profileCompatibility';
import { renderScreen } from '@/dev/testkit';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';

import { installNewSessionScreenModelCommonModuleMocks } from './newSessionScreenModelTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type SpawnPayloadCapture = {
    serverId?: string;
    permissionMode?: string;
    permissionModeUpdatedAt?: number;
    connectedServices?: unknown;
    mcpSelection?: unknown;
    resume?: string;
    transcriptStorage?: 'persisted' | 'direct';
    windowsRemoteSessionLaunchMode?: 'hidden' | 'windows_terminal' | 'console';
    windowsTerminalWindowName?: string;
} | null;

type AutomationCreateCapture = {
    name: string;
    enabled: boolean;
    schedule: { kind: string; everyMs?: number };
    targetType: 'new_session' | 'existing_session';
    templateCiphertext: string;
    assignments?: Array<{ machineId: string; enabled?: boolean; priority?: number }>;
} | null;

function buildAutomationAuthoringDraft(params: Readonly<{
    prompt: string;
    modelMode: ModelMode;
    permissionMode: PermissionMode;
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
        backendTarget: null,
        transcriptStorage: params.transcriptStorage ?? null,
        profileId: null,
        environmentVariables: null,
        resumeSessionId: null,
        permissionMode: params.permissionMode,
        permissionModeUpdatedAt: null,
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
    const buildSpawnEnvironmentVariablesCapture: { value: Record<string, unknown> | null } = { value: null };
    const automationCaptured: { value: AutomationCreateCapture } = { value: null };
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
    const ensureSessionVisibleForMessageRouteSpy = vi.fn(async (_sessionId: string) => {});
    const refreshAutomationsSpy = vi.fn(async () => {});
    const applySettingsSpy = vi.fn((..._args: unknown[]) => {});
    const updateAutomationSpy = vi.fn(async () => {});
    const updateSessionDraftSpy = vi.fn();
    const saveSessionDraftsSpy = vi.fn();
    const getMachineCapabilitiesSnapshotSpy = vi.fn(() => ({ supported: true, response: { protocolVersion: 1, results: {} } }));
    const prefetchMachineCapabilitiesSpy = vi.fn(async () => {});
    const captureExceptionIfEnabledSpy = vi.fn();
    const syncSendMessageSpy = vi.fn<(...args: unknown[]) => Promise<void>>(async (..._args: unknown[]) => {});
    const followUpSpawnedSessionWithServerScopeSpy = vi.fn(async (params: {
        sessionId: string;
        targetServerId?: string | null;
        initialMessageText?: string | null;
        profileId?: string | null;
    }) => {
        const targetServerId = typeof params.targetServerId === 'string' && params.targetServerId.trim().length > 0
            ? params.targetServerId
            : 'server-a';
        if (targetServerId !== 'server-a') {
            return;
        }

        await refreshSessionsSpy();

        if (typeof params.initialMessageText === 'string' && params.initialMessageText.trim().length > 0) {
            await syncSendMessageSpy(
                params.sessionId,
                params.initialMessageText,
                undefined,
                undefined,
                params.profileId ? { profileId: params.profileId } : undefined,
            );
        }
    });
    const materializeNewSessionCheckoutSpy = vi.fn(async () => ({
        success: true as const,
        path: '/tmp/materialized-worktree',
        sessionPath: '/tmp/materialized-worktree',
        repositoryRootPath: '/tmp/materialized-worktree',
    }));
    const machineSpawnNewSessionSpy = vi.fn<(...args: unknown[]) => Promise<any>>(async (...args: unknown[]) => {
        const opts = args[0] as SpawnPayloadCapture;
        captured.value = opts;
        return { type: 'error', errorCode: 'unexpected', errorMessage: 'stop' };
    });
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
        text: () =>
            createTextModuleMock({
                translate: (key: string) => key,
            }),
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
                updateSessionDraft: updateSessionDraftSpy,
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
            updateAutomation: updateAutomationSpy,
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
            json: async () => ({ mode: 'e2ee', updatedAt: 1 }),
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
        machineSpawnNewSession: (...args: unknown[]) => machineSpawnNewSessionSpy(...args),
        machineBash: (...args: unknown[]) => machineBashSpy(...args),
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

    const { useCreateNewSession } = await import('./useCreateNewSession');
    return {
        useCreateNewSession,
        captured,
        buildSpawnEnvironmentVariablesCapture,
        automationCaptured,
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
        updateAutomationSpy,
        updateSessionDraftSpy,
        saveSessionDraftsSpy,
        materializeNewSessionCheckoutSpy,
        getMachineCapabilitiesSnapshotSpy,
        prefetchMachineCapabilitiesSpy,
        captureExceptionIfEnabledSpy,
        syncSendMessageSpy,
        followUpSpawnedSessionWithServerScopeSpy,
        machineSpawnNewSessionSpy,
    };
}

describe('useCreateNewSession permission seeding', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('passes a canonical permission mode and timestamp into machineSpawnNewSession', async () => {
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
                sessionPrompt: '',
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
        expect(typeof captured.value?.permissionModeUpdatedAt).toBe('number');
        expect(Number.isFinite(captured.value?.permissionModeUpdatedAt)).toBe(true);
        expect((captured.value?.permissionModeUpdatedAt ?? 0)).toBeGreaterThan(0);
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
                sessionPrompt: '',
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

        expect(captured.value?.resume).toBe('sess_old');
        expect(prefetchMachineCapabilitiesSpy).toHaveBeenCalledTimes(0);
    });

    it('passes the selected model as initial message metaOverrides so next-prompt model backends can apply it on the first turn', async () => {
        const {
            useCreateNewSession,
            followUpSpawnedSessionWithServerScopeSpy,
            machineSpawnNewSessionSpy,
        } = await setupUseCreateNewSessionHarness();

        machineSpawnNewSessionSpy.mockResolvedValueOnce({ type: 'success', sessionId: 'sess_target' });

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
                sessionPrompt: 'hello',
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

        expect(followUpSpawnedSessionWithServerScopeSpy).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'sess_target',
            initialMessageText: 'hello',
            metaOverrides: { model: 'gpt' },
        }));
    });

    it('passes connectedServices bindings into machineSpawnNewSession when provided', async () => {
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
                sessionPrompt: '',
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
                anthropic: { source: 'connected', profileId: 'work' },
            },
        });
    });

    it('passes mcpSelection into machineSpawnNewSession when provided', async () => {
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
                sessionPrompt: '',
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

    it('passes transcriptStorage through to machineSpawnNewSession when requested', async () => {
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
                sessionPrompt: '',
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
                sessionPrompt: '',
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

        expect(captured.value?.serverId).toBe('server-b');
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
                sessionPrompt: '',
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
        expect(captured.value?.serverId).toBe('server-a');
    });

    it('routes post-spawn follow-up through the selected non-active server for repo-native worktree launches', async () => {
        const {
            useCreateNewSession,
            refreshSessionsSpy,
            syncSendMessageSpy,
            followUpSpawnedSessionWithServerScopeSpy,
            machineSpawnNewSessionSpy,
        } = await setupUseCreateNewSessionHarness();

        machineSpawnNewSessionSpy.mockResolvedValueOnce({ type: 'success', sessionId: 'sess_target' });

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
                sessionPrompt: 'Ship the scoped follow-up fix',
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

        expect(followUpSpawnedSessionWithServerScopeSpy).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'sess_target',
            targetServerId: 'server-b',
            initialMessageText: 'Ship the scoped follow-up fix',
            profileId: null,
        }));
        expect(refreshSessionsSpy).not.toHaveBeenCalled();
        expect(syncSendMessageSpy).not.toHaveBeenCalled();
    });

    it('alerts and avoids opening a non-hydrated created session when post-spawn follow-up fails for a repo-native worktree launch', async () => {
        const {
            useCreateNewSession,
            captureExceptionIfEnabledSpy,
            modalAlertSpy,
            clearNewSessionDraftSpy,
            ensureSessionVisibleForMessageRouteSpy,
            followUpSpawnedSessionWithServerScopeSpy,
            machineSpawnNewSessionSpy,
            updateSessionDraftSpy,
            saveSessionDraftsSpy,
        } = await setupUseCreateNewSessionHarness();

        machineSpawnNewSessionSpy.mockResolvedValueOnce({ type: 'success', sessionId: 'sess_target' });
        followUpSpawnedSessionWithServerScopeSpy.mockRejectedValueOnce(new Error('follow-up failed'));

        let handleCreateSession: null | (() => Promise<void>) = null;
        const routerReplace = vi.fn();
        const disableDraftPersistence = vi.fn();
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
                router: { push: vi.fn(), replace: routerReplace },
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
                sessionPrompt: 'Ship the scoped follow-up fix',
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
                disableDraftPersistence,
            });

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        await act(async () => {
            await handleCreateSession?.();
        });

        expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'follow-up failed');
        expect(saveSessionDraftsSpy).toHaveBeenCalledWith({ sess_target: 'Ship the scoped follow-up fix' });
        expect(updateSessionDraftSpy).not.toHaveBeenCalled();
        expect(disableDraftPersistence).not.toHaveBeenCalled();
        expect(clearNewSessionDraftSpy).not.toHaveBeenCalled();
        expect(ensureSessionVisibleForMessageRouteSpy).toHaveBeenCalledWith('sess_target', {
            forceRefresh: true,
            serverId: 'server-b',
        });
        expect(routerReplace).not.toHaveBeenCalled();
    });

    it('clears and disables the /new draft before opening a hydrated created session when post-spawn follow-up fails', async () => {
        const {
            useCreateNewSession,
            modalAlertSpy,
            clearNewSessionDraftSpy,
            ensureSessionVisibleForMessageRouteSpy,
            sessions,
            followUpSpawnedSessionWithServerScopeSpy,
            machineSpawnNewSessionSpy,
            updateSessionDraftSpy,
            saveSessionDraftsSpy,
        } = await setupUseCreateNewSessionHarness();

        machineSpawnNewSessionSpy.mockResolvedValueOnce({ type: 'success', sessionId: 'sess_target' });
        followUpSpawnedSessionWithServerScopeSpy.mockRejectedValueOnce(new Error('follow-up failed'));
        ensureSessionVisibleForMessageRouteSpy.mockImplementationOnce(async (sessionId: string) => {
            sessions[sessionId] = { id: sessionId };
        });

        let handleCreateSession: null | (() => Promise<void>) = null;
        const routerReplace = vi.fn();
        const disableDraftPersistence = vi.fn();
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
                sessionPrompt: 'Ship the scoped follow-up fix',
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
                disableDraftPersistence,
            });

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        await act(async () => {
            await handleCreateSession?.();
        });

        expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'follow-up failed');
        expect(saveSessionDraftsSpy).toHaveBeenCalledWith({ sess_target: 'Ship the scoped follow-up fix' });
        expect(updateSessionDraftSpy).toHaveBeenCalledWith('sess_target', 'Ship the scoped follow-up fix');
        expect(disableDraftPersistence).toHaveBeenCalledTimes(1);
        expect(clearNewSessionDraftSpy).toHaveBeenCalledTimes(1);
        expect(routerReplace).toHaveBeenCalledWith('/session/sess_target?serverId=server-b', expect.anything());
    });

    it('encodes the created session route when post-spawn follow-up fails after hydration', async () => {
        const {
            useCreateNewSession,
            modalAlertSpy,
            clearNewSessionDraftSpy,
            ensureSessionVisibleForMessageRouteSpy,
            sessions,
            followUpSpawnedSessionWithServerScopeSpy,
            machineSpawnNewSessionSpy,
            updateSessionDraftSpy,
            saveSessionDraftsSpy,
        } = await setupUseCreateNewSessionHarness();

        machineSpawnNewSessionSpy.mockResolvedValueOnce({ type: 'success', sessionId: 'sess/target' });
        followUpSpawnedSessionWithServerScopeSpy.mockRejectedValueOnce(new Error('follow-up failed'));
        ensureSessionVisibleForMessageRouteSpy.mockImplementationOnce(async (sessionId: string) => {
            sessions[sessionId] = { id: sessionId };
        });

        let handleCreateSession: null | (() => Promise<void>) = null;
        const routerReplace = vi.fn();
        const disableDraftPersistence = vi.fn();
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
                sessionPrompt: 'Ship the scoped follow-up fix',
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
                disableDraftPersistence,
            });

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        await act(async () => {
            await handleCreateSession?.();
        });

        expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'follow-up failed');
        expect(saveSessionDraftsSpy).toHaveBeenCalledWith({ 'sess/target': 'Ship the scoped follow-up fix' });
        expect(updateSessionDraftSpy).toHaveBeenCalledWith('sess/target', 'Ship the scoped follow-up fix');
        expect(disableDraftPersistence).toHaveBeenCalledTimes(1);
        expect(clearNewSessionDraftSpy).toHaveBeenCalledTimes(1);
        expect(routerReplace).toHaveBeenCalledWith('/session/sess%2Ftarget?serverId=server-b', expect.anything());
    });

    it('creates an automation instead of spawning immediately when automation mode is enabled', async () => {
        const {
            useCreateNewSession,
            captured,
            automationCaptured,
            refreshAutomationsSpy,
            materializeNewSessionCheckoutSpy,
        } = await setupUseCreateNewSessionHarness();

        let handleCreateSession: null | (() => Promise<void>) = null;
        const routerPush = vi.fn();
        const routerReplace = vi.fn();
        const disableDraftPersistence = vi.fn();
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
                sessionPrompt: 'Run the nightly maintenance checklist',
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

            handleCreateSession = hook.handleCreateSession as () => Promise<void>;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        await act(async () => {
            await handleCreateSession?.();
        });

        expect(captured.value).toBeNull();
        expect(materializeNewSessionCheckoutSpy).not.toHaveBeenCalled();
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
                sessionPrompt: 'Update the scheduled work',
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
                sessionPrompt: 'Update the scheduled work',
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
                sessionPrompt: 'Update the scheduled work',
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

    it('does not apply Happier replay when resume is requested but vendor resume is unavailable (new-session flow)', async () => {
        const {
            useCreateNewSession,
            modalConfirmSpy,
            syncSendMessageSpy,
            machineSpawnNewSessionSpy,
        } = await setupUseCreateNewSessionHarness();

        machineSpawnNewSessionSpy.mockResolvedValueOnce({ type: 'success', sessionId: 'sess_new' });
        modalConfirmSpy.mockResolvedValueOnce(true);

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
                sessionPrompt: 'PROMPT',
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
        expect(syncSendMessageSpy).toHaveBeenCalledTimes(1);
        expect(syncSendMessageSpy).toHaveBeenCalledWith('sess_new', 'PROMPT', undefined, undefined, undefined);
    });

    it('passes the selected profile id through when sending the first prompt for a new profiled session', async () => {
        const {
            useCreateNewSession,
            syncSendMessageSpy,
            machineSpawnNewSessionSpy,
        } = await setupUseCreateNewSessionHarness();

        machineSpawnNewSessionSpy.mockResolvedValueOnce({ type: 'success', sessionId: 'sess_new' });

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
                sessionPrompt: 'PROMPT',
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

        expect(syncSendMessageSpy).toHaveBeenCalledTimes(1);
        expect(syncSendMessageSpy).toHaveBeenCalledWith(
            'sess_new',
            'PROMPT',
            undefined,
            undefined,
            { profileId: 'profile-test' },
        );
    });

    it('blocks creation when the selected profile is incompatible with the current backend target', async () => {
        const {
            useCreateNewSession,
            modalAlertSpy,
            machineSpawnNewSessionSpy,
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
                sessionPrompt: 'PROMPT',
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
        expect(machineSpawnNewSessionSpy).not.toHaveBeenCalled();
        expect(syncSendMessageSpy).not.toHaveBeenCalled();
    });

    it('can skip sending the initial message when requested', async () => {
        const {
            useCreateNewSession,
            syncSendMessageSpy,
            machineSpawnNewSessionSpy,
        } = await setupUseCreateNewSessionHarness();

        machineSpawnNewSessionSpy.mockResolvedValueOnce({ type: 'success', sessionId: 'sess_new' });

        let handleCreateSession: null | ((opts?: any) => Promise<void>) = null;
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
                sessionPrompt: 'PROMPT',
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

            handleCreateSession = hook.handleCreateSession as any;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        await act(async () => {
            await handleCreateSession?.({ initialMessage: 'skip' });
        });

        expect(syncSendMessageSpy).toHaveBeenCalledTimes(0);
        expect(routerReplace).toHaveBeenCalledWith('/session/sess_new?serverId=server-a', expect.anything());
    });

    it('passes the per-session Windows launch-mode override into machineSpawnNewSession', async () => {
        const {
            useCreateNewSession,
            captured,
            machineSpawnNewSessionSpy,
        } = await setupUseCreateNewSessionHarness();

        machineSpawnNewSessionSpy.mockImplementationOnce(async (...args: unknown[]) => {
            captured.value = args[0] as SpawnPayloadCapture;
            return { type: 'success', sessionId: 'sess_new' };
        });

        let handleCreateSession: null | ((opts?: any) => Promise<void>) = null;
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
                sessionPrompt: '',
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

            handleCreateSession = hook.handleCreateSession as any;
            return React.createElement('View');
        }

        await renderScreen(React.createElement(Test));

        await act(async () => {
            await handleCreateSession?.({ initialMessage: 'skip' });
        });

        expect(captured.value?.windowsRemoteSessionLaunchMode).toBe('windows_terminal');
        expect(captured.value?.windowsTerminalWindowName).toBe('happier-qa');
    });
});
