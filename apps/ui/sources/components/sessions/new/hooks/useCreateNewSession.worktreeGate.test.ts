import * as React from 'react';
import { createNewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    buildBackendTargetKey,
    createProviderErrorV1,
    SPAWN_SESSION_ERROR_CODES,
    SPAWN_SESSION_ERROR_DETAIL_KINDS,
} from '@happier-dev/protocol';
import { AIBackendProfileSchema } from '@/sync/domains/profiles/profileCompatibility';
import { settingsDefaults as testSettingsDefaults } from '@/sync/domains/settings/settings';
import type { Session } from '@/sync/domains/state/storageTypes';
import { renderHook as renderLiveHook, renderScreen } from '@/dev/testkit';
import { installNewSessionScreenModelCommonModuleMocks } from './newSessionScreenModelTestHelpers';

const materializeNewSessionCheckoutMock = vi.hoisted(() => vi.fn(async (params?: unknown) => {
    const request = (params ?? {}) as {
        selectedPath?: string;
        checkoutCreationDraft?: { kind?: string } | null;
    };
    const selectedPath = request.selectedPath ?? '/tmp/worktree';
    if (request.checkoutCreationDraft?.kind !== 'git_worktree') {
        return {
            success: true as const,
            path: selectedPath,
            sessionPath: selectedPath,
            repositoryRootPath: selectedPath,
        };
    }

    return {
        success: true as const,
        path: '/tmp/worktree',
        sessionPath: '/tmp/worktree',
        repositoryRootPath: '/tmp/worktree',
    };
}));

const captureExceptionIfEnabledMock = vi.hoisted(() => vi.fn());
const clearNewSessionDraftMock = vi.hoisted(() => vi.fn());
const loadSessionDraftsMock = vi.hoisted(() => vi.fn(() => ({})));
const saveSessionDraftsMock = vi.hoisted(() => vi.fn());
const saveNewSessionDraftMock = vi.hoisted(() => vi.fn());
const storeTempDataMock = vi.hoisted(() => vi.fn(() => 'temp-recovery-1'));
const upsertPendingMessageMock = vi.hoisted(() => vi.fn());
const markSessionOptimisticThinkingMock = vi.hoisted(() => vi.fn());
const updateSessionPermissionModeMock = vi.hoisted(() => vi.fn());
const updateSessionModelModeMock = vi.hoisted(() => vi.fn());
const followUpSpawnedSessionWithServerScopeMock = vi.hoisted(() => vi.fn(async (_params?: unknown) => {}));
const autoPressModalButtonTextState = vi.hoisted(() => ({ value: null as string | null }));
const modalAlertMock = vi.hoisted(() => vi.fn((...args: unknown[]) => {
    const targetText = autoPressModalButtonTextState.value;
    const buttons = args[2];
    if (!targetText || !Array.isArray(buttons)) {
        return;
    }
    const target = buttons.find((button): button is { text?: string; onPress?: () => void } =>
        button && typeof button === 'object' && (button as { text?: unknown }).text === targetText);
    target?.onPress?.();
}));
const storedSessionsState = vi.hoisted(() => ({ sessions: {} as Record<string, Session> }));
const ensureSessionVisibleForMessageRouteMock = vi.hoisted(() => vi.fn(async (sessionId?: unknown, _options?: unknown) => {
    const hydratedSessionId = String(sessionId ?? '').trim();
    if (!hydratedSessionId) {
        return;
    }

    storedSessionsState.sessions[hydratedSessionId] = {
        id: hydratedSessionId,
        createdAt: 1,
        updatedAt: 2,
        seq: 0,
        active: true,
        activeAt: 2,
        encryptionMode: 'plain',
        metadataVersion: 0,
        metadata: null,
        agentStateVersion: 1,
        agentState: null,
    } as Session;
}));
type SessionSpawnNewActionBoundaryOutcome =
    | { type: 'success'; sessionId: string }
    | { type: 'error'; errorCode: string; errorMessage?: string; errorDetail?: unknown };

const sessionSpawnNewActionBoundaryMock = vi.hoisted(() => vi.fn(async (_input?: unknown): Promise<SessionSpawnNewActionBoundaryOutcome> => ({
    type: 'success',
    sessionId: 'session-created',
})));
const machineBashMock = vi.hoisted(() => vi.fn(async () => ({
    success: true,
    stdout: '',
    stderr: '',
    exitCode: 0,
})));
const activeServerSnapshotMockState = vi.hoisted(() => ({ serverId: 'server-a' }));

installNewSessionScreenModelCommonModuleMocks({
    routerConfig: {
        router: {
            push: vi.fn(),
            replace: vi.fn(),
            back: vi.fn(),
            setParams: vi.fn(),
        },
        params: {},
        navigation: {},
        pathname: '/new',
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: modalAlertMock,
            },
        }).module;
    },
    storage: async (importOriginal) => {
        const [
            { createStorageModuleStub, createStorageStoreMock },
            { settingsDefaults },
        ] = await Promise.all([
            import('@/dev/testkit/mocks/storage'),
            import('@/sync/domains/settings/settings'),
        ]);

        return createStorageModuleStub({
            storage: createStorageStoreMock({
                settings: settingsDefaults,
                sessions: storedSessionsState.sessions,
                upsertPendingMessage: upsertPendingMessageMock,
                markSessionOptimisticThinking: markSessionOptimisticThinkingMock,
                updateSessionPermissionMode: updateSessionPermissionModeMock,
                updateSessionModelMode: updateSessionModelModeMock,
            }),
        });
    },
});

vi.mock('@/sync/ops', () => ({
    machineBash: machineBashMock,
}));

vi.mock('@/sync/ops/actions/sessionSpawnNewAction', async () => {
    const actual = await vi.importActual<typeof import('@/sync/ops/actions/sessionSpawnNewAction')>(
        '@/sync/ops/actions/sessionSpawnNewAction',
    );
    return {
        ...actual,
        executeManualSessionSpawnNewAction: async (input: any, _context: unknown, params: any) => {
            const outcome = await sessionSpawnNewActionBoundaryMock(input);
            const custody = {
                v: 3 as const,
                scope: params.scope,
                machineId: input.executionTarget.machineId,
                targetFingerprint: 'worktree-test-fingerprint',
                userAttemptId: params.userAttemptId,
                nonce: params.seedNonce,
                submissionState: 'submitted' as const,
                createdSessionId: outcome.type === 'success' ? outcome.sessionId : null,
                firstTurnLocalId: `spawn-first-turn:${params.seedNonce}`,
                attachmentMessageLocalId: `spawn-attachment:${params.seedNonce}`,
            };
            return {
                status: 'executed' as const,
                action: {
                    ok: true as const,
                    result: outcome.type === 'success'
                        ? {
                            type: 'success' as const,
                            disposition: 'created' as const,
                            sessionId: outcome.sessionId,
                            executionTarget: input.executionTarget,
                            organizationPlacement: input.organizationPlacement ?? { folderId: null, tagIds: [] },
                            initialInput: input.initialInput
                                ? { status: 'accepted' as const, localId: `input-${outcome.sessionId}` }
                                : { status: 'notRequested' as const },
                        }
                        : {
                            type: 'error' as const,
                            code: 'spawn_failed' as const,
                            retryable: false,
                        },
                },
                custody,
            };
        },
        completeManualSessionSpawnNewActionCustody: async () => true,
    };
});

vi.mock('@/components/sessions/new/modules/materializeNewSessionCheckout', () => ({
    materializeNewSessionCheckout: (params: unknown) => materializeNewSessionCheckoutMock(params),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/followUpSpawnedSession', () => ({
    followUpSpawnedSessionWithServerScope: (params: unknown) => followUpSpawnedSessionWithServerScopeMock(params),
    readRecoverableFollowUpPayload: (error: unknown) => {
        if (!(error instanceof Error)) {
            return null;
        }
        return (error as Error & {
            recoverableFollowUpPayload?: unknown;
        }).recoverableFollowUpPayload ?? null;
    },
}));

vi.mock('@/sync/domains/server/selection/serverSelectionResolver', () => ({
    resolveNewSessionServerTarget: vi.fn((params: { requestedServerId?: string | null; allowedServerIds: string[] }) => ({
        targetServerId: params.requestedServerId?.trim() || params.allowedServerIds[0] || null,
        rejectedRequestedServerId: null,
    })),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: vi.fn(() => ({
        serverId: activeServerSnapshotMockState.serverId,
        serverUrl: `https://${activeServerSnapshotMockState.serverId}.example.test`,
        kind: 'custom',
        generation: 1,
    })),
}));

vi.mock('@/sync/domains/features/featureLocalPolicy', () => ({
    resolveLocalFeaturePolicyEnabled: vi.fn((featureId: string, settings: { featureToggles?: Record<string, boolean> }) => settings.featureToggles?.[featureId] === true),
}));

vi.mock('@/utils/system/sentry', () => ({
    captureExceptionIfEnabled: captureExceptionIfEnabledMock,
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        getCredentials: vi.fn(() => ({ token: 't' })),
        encryption: {
            encryptRaw: vi.fn(async (value: unknown) => value),
            encryptAutomationTemplateRaw: vi.fn(async (value: unknown) => value),
        },
        decryptSecretValue: vi.fn(),
        refreshAutomations: vi.fn(async () => {}),
        refreshSessions: vi.fn(async () => {}),
        ensureSessionVisibleForMessageRoute: ensureSessionVisibleForMessageRouteMock,
        refreshMachines: vi.fn(async () => {}),
        sendMessage: vi.fn(async () => {}),
        publishSessionAcpSessionModeOverrideToMetadata: vi.fn(async () => {}),
    },
}));

vi.mock('@/sync/store/settingsWriters', () => ({
    useApplySettings: () => vi.fn(),
}));

vi.mock('@/sync/domains/state/persistence', () => ({
    clearNewSessionDraft: clearNewSessionDraftMock,
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
    loadSessionDrafts: loadSessionDraftsMock,
    saveSessionDrafts: saveSessionDraftsMock,
    loadSessionReviewCommentsDrafts: () => ({}),
    saveSessionReviewCommentsDrafts: vi.fn(),
    loadWorkspaceReviewCommentsDrafts: () => ({}),
    saveWorkspaceReviewCommentsDrafts: vi.fn(),
    loadSessionActionDrafts: () => ({}),
    saveSessionActionDrafts: vi.fn(),
    loadNewSessionDraft: () => null,
    saveNewSessionDraft: saveNewSessionDraftMock,
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

vi.mock('@/utils/sessions/tempDataStore', () => ({
    storeTempData: storeTempDataMock,
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function renderHook<T>(useValue: () => T): Promise<T> {
    let current: T | null = null;

    function Test() {
        current = useValue();
        return null;
    }

    await renderScreen(React.createElement(Test));

    if (!current) throw new Error('Hook did not render');
    return current;
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    materializeNewSessionCheckoutMock.mockReset();
    materializeNewSessionCheckoutMock.mockImplementation(async (params?: unknown) => {
        const request = (params ?? {}) as {
            selectedPath?: string;
            checkoutCreationDraft?: { kind?: string } | null;
        };
        const selectedPath = request.selectedPath ?? '/tmp/worktree';
        if (request.checkoutCreationDraft?.kind !== 'git_worktree') {
            return {
                success: true as const,
                path: selectedPath,
                sessionPath: selectedPath,
                repositoryRootPath: selectedPath,
            };
        }

        return {
            success: true as const,
            path: '/tmp/worktree',
            sessionPath: '/tmp/worktree',
            repositoryRootPath: '/tmp/worktree',
        };
    });
    clearNewSessionDraftMock.mockClear();
    loadSessionDraftsMock.mockClear();
    saveSessionDraftsMock.mockClear();
    saveNewSessionDraftMock.mockClear();
    storeTempDataMock.mockClear();
    upsertPendingMessageMock.mockClear();
    markSessionOptimisticThinkingMock.mockClear();
    updateSessionPermissionModeMock.mockClear();
    updateSessionModelModeMock.mockClear();
    followUpSpawnedSessionWithServerScopeMock.mockReset();
    followUpSpawnedSessionWithServerScopeMock.mockImplementation(async (_params?: unknown) => {});
    autoPressModalButtonTextState.value = null;
    activeServerSnapshotMockState.serverId = 'server-a';
    modalAlertMock.mockClear();
    ensureSessionVisibleForMessageRouteMock.mockClear();
    for (const key of Object.keys(storedSessionsState.sessions)) {
        delete storedSessionsState.sessions[key];
    }
    vi.resetModules();
});

describe('useCreateNewSession (worktree gating)', () => {
    it('does not launch from a stale authoring snapshot while a selection commit is pending', async () => {
        const { useCreateNewSession } = await import('./useCreateNewSession');
        const setIsCreating = vi.fn();
        const params = {
            launchIntentSignature: 'test-launch-intent',
            router: { push: vi.fn(), replace: vi.fn() },
            selectedMachineId: 'machine-1',
            selectedPath: '/repo',
            selectedMachine: { id: 'machine-1', metadata: {} },
            setIsCreating,
            setIsResumeSupportChecking: vi.fn(),
            settings: testSettingsDefaults,
            useProfiles: false,
            selectedProfileId: null,
            profileMap: new Map(),
            recentMachinePaths: [],
            agentType: 'claude' as const,
            permissionMode: 'default' as const,
            modelMode: 'default' as const,
            promptStore: createNewSessionPromptStore('Use the just-confirmed Provider'),
            resumeSessionId: '',
            agentNewSessionOptions: null,
            authoringCommitPending: true,
            machineEnvPresence: {
                isPreviewEnvSupported: false,
                isLoading: false,
                meta: {},
            } as unknown as Parameters<typeof useCreateNewSession>[0]['machineEnvPresence'],
            secrets: [],
            secretBindingsByProfileId: {},
            selectedSecretIdByProfileIdByEnvVarName: {},
            sessionOnlySecretValueByProfileIdByEnvVarName: {},
            selectedMachineCapabilities: null,
            targetServerId: null,
            allowedTargetServerIds: [],
        } satisfies Parameters<typeof useCreateNewSession>[0];
        const hook = await renderHook(() => useCreateNewSession(params));

        await act(async () => {
            await hook.handleCreateSession();
        });

        expect(materializeNewSessionCheckoutMock).not.toHaveBeenCalled();
        expect(sessionSpawnNewActionBoundaryMock).not.toHaveBeenCalled();
        expect(setIsCreating).not.toHaveBeenCalled();
    });

    it('exposes a structured Provider launch refusal for canonical inline recovery without leaking a raw modal', async () => {
        const providerError = createProviderErrorV1('provider_not_enabled_on_machine', {
            connectionId: 'pc_provider',
            machineId: 'machine-1',
        });
        const spawnRefusal = {
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
            errorMessage: providerError.code,
            errorDetail: {
                kind: SPAWN_SESSION_ERROR_DETAIL_KINDS.PROVIDER_ERROR,
                providerError,
            },
        } as const;
        sessionSpawnNewActionBoundaryMock
            .mockResolvedValueOnce(spawnRefusal)
            .mockResolvedValueOnce(spawnRefusal)
            .mockImplementationOnce(async () => {
                activeServerSnapshotMockState.serverId = 'server-b';
                return spawnRefusal;
            });
        const { useCreateNewSession } = await import('./useCreateNewSession');
        const params: Parameters<typeof useCreateNewSession>[0] = {
            launchIntentSignature: 'test-launch-intent',
            router: { push: vi.fn(), replace: vi.fn() },
            selectedMachineId: 'machine-1',
            selectedPath: '/repo',
            selectedMachine: { id: 'machine-1', metadata: {} },
            setIsCreating: vi.fn(),
            setIsResumeSupportChecking: vi.fn(),
            settings: testSettingsDefaults,
            useProfiles: false,
            selectedProfileId: null,
            profileMap: new Map(),
            recentMachinePaths: [],
            agentType: 'claude' as const,
            permissionMode: 'default' as const,
            modelMode: 'auto' as const,
            promptStore: createNewSessionPromptStore('Use the selected Provider'),
            resumeSessionId: '',
            agentNewSessionOptions: null,
            machineEnvPresence: {
                isPreviewEnvSupported: false,
                isLoading: false,
                meta: {},
            } as unknown as Parameters<typeof useCreateNewSession>[0]['machineEnvPresence'],
            secrets: [],
            secretBindingsByProfileId: {},
            selectedSecretIdByProfileIdByEnvVarName: {},
            sessionOnlySecretValueByProfileIdByEnvVarName: {},
            selectedMachineCapabilities: null,
            targetServerId: null,
            allowedTargetServerIds: [],
        };
        const hook = await renderLiveHook(
            (hookParams: Parameters<typeof useCreateNewSession>[0]) => useCreateNewSession(hookParams),
            { initialProps: params },
        );

        await act(async () => {
            await hook.getCurrent().handleCreateSession();
        });

        expect(hook.getCurrent().providerLaunchError).toEqual(providerError);
        expect(hook.getCurrent().retryProviderLaunch).toBeTypeOf('function');
        expect(modalAlertMock).not.toHaveBeenCalled();

        await hook.rerender({
            ...params,
            allowedTargetServerIds: ['server-b'],
        });

        expect(hook.getCurrent().providerLaunchError).toBeNull();

        await hook.rerender(params);

        expect(hook.getCurrent().providerLaunchError).toBeNull();

        await act(async () => {
            await hook.getCurrent().handleCreateSession();
        });

        expect(hook.getCurrent().providerLaunchError).toEqual(providerError);

        await hook.rerender({
            ...params,
            selectedMachineId: 'machine-2',
            selectedMachine: { id: 'machine-2', metadata: {} },
        });

        expect(hook.getCurrent().providerLaunchError).toBeNull();

        await hook.rerender(params);

        expect(hook.getCurrent().providerLaunchError).toBeNull();

        await act(async () => {
            await hook.getCurrent().handleCreateSession();
        });

        expect(hook.getCurrent().providerLaunchError).toBeNull();

        activeServerSnapshotMockState.serverId = 'server-a';
        await hook.rerender(params);

        expect(hook.getCurrent().providerLaunchError).toBeNull();
    });

    it('does not create a worktree when no checkout creation draft is selected', async () => {
        const { useCreateNewSession } = await import('./useCreateNewSession');
        const typecheck = useCreateNewSession;

        const profile = AIBackendProfileSchema.parse({
            id: 'profile-test',
            name: 'Profile Test',
            description: undefined,
            environmentVariables: [],
            envVarRequirements: [{ name: 'REQUIRED_CONFIG', kind: 'config', required: true }],
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
        });

        const params = {
            launchIntentSignature: 'test-launch-intent',
            router: { push: vi.fn(), replace: vi.fn() },
            selectedMachineId: 'machine-1',
            selectedPath: '/repo',
            selectedMachine: { id: 'machine-1', metadata: {} },
            setIsCreating: vi.fn(),
            setIsResumeSupportChecking: vi.fn(),
            settings: {
                ...testSettingsDefaults,
                experiments: true,
                featureToggles: {},
            },
            useProfiles: true,
            selectedProfileId: profile.id,
            profileMap: new Map([[profile.id, profile]]),
            recentMachinePaths: [],
            agentType: 'codex' as const,
            permissionMode: 'default' as const,
            modelMode: 'auto' as const,
            promptStore: createNewSessionPromptStore('hi'),
            resumeSessionId: '',
            agentNewSessionOptions: null,
            // Test fixture: only the fields used by useCreateNewSession are provided.
            machineEnvPresence: {
                isPreviewEnvSupported: true,
                isLoading: false,
                meta: { REQUIRED_CONFIG: { isSet: true } },
            } as unknown as Parameters<typeof typecheck>[0]['machineEnvPresence'],
            secrets: [],
            secretBindingsByProfileId: {},
            selectedSecretIdByProfileIdByEnvVarName: {},
            sessionOnlySecretValueByProfileIdByEnvVarName: {},
            selectedMachineCapabilities: null,
            targetServerId: null,
            allowedTargetServerIds: [],
        } satisfies Parameters<typeof typecheck>[0];

        const hook = await renderHook(() => useCreateNewSession(params));
        await act(async () => {
            await hook.handleCreateSession();
        });

        expect(materializeNewSessionCheckoutMock).toHaveBeenCalledTimes(1);
        expect(materializeNewSessionCheckoutMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            selectedPath: '/repo',
            checkoutCreationDraft: undefined,
            serverId: 'server-a',
        }));
        expect(sessionSpawnNewActionBoundaryMock).toHaveBeenCalledWith(expect.objectContaining({
            directory: '/repo',
            machineId: 'machine-1',
        }));
    });

    it('clears the persisted new-session draft with the screen draft scope after successful creation', async () => {
        const { useCreateNewSession } = await import('./useCreateNewSession');
        const draftScope = { serverId: 'server-a', accountId: 'account-a' };
        const routerReplace = vi.fn();
        const disableDraftPersistence = vi.fn();
        const params = {
            launchIntentSignature: 'test-launch-intent',
            router: { push: vi.fn(), replace: routerReplace },
            selectedMachineId: 'machine-1',
            selectedPath: '/repo',
            selectedMachine: { id: 'machine-1', metadata: {} },
            setIsCreating: vi.fn(),
            setIsResumeSupportChecking: vi.fn(),
            settings: testSettingsDefaults,
            useProfiles: false,
            selectedProfileId: null,
            profileMap: new Map(),
            recentMachinePaths: [],
            agentType: 'codex' as const,
            permissionMode: 'default' as const,
            modelMode: 'auto' as const,
            promptStore: createNewSessionPromptStore('hi'),
            resumeSessionId: '',
            agentNewSessionOptions: null,
            machineEnvPresence: {
                isPreviewEnvSupported: false,
                isLoading: false,
                meta: {},
            } as unknown as Parameters<typeof useCreateNewSession>[0]['machineEnvPresence'],
            secrets: [],
            secretBindingsByProfileId: {},
            selectedSecretIdByProfileIdByEnvVarName: {},
            sessionOnlySecretValueByProfileIdByEnvVarName: {},
            selectedMachineCapabilities: null,
            targetServerId: null,
            allowedTargetServerIds: [],
            draftScope,
            disableDraftPersistence,
        } satisfies Parameters<typeof useCreateNewSession>[0];

        const hook = await renderHook(() => useCreateNewSession(params));
        await act(async () => {
            await hook.handleCreateSession();
        });

        expect(disableDraftPersistence).toHaveBeenCalledTimes(1);
        expect(clearNewSessionDraftMock).toHaveBeenCalledWith(draftScope);
        expect(routerReplace).toHaveBeenCalledWith('/session/session-created?serverId=server-a', expect.anything());
    });

    it('creates a git worktree on the resolved target server when checkoutCreationDraft is selected', async () => {
        const { useCreateNewSession } = await import('./useCreateNewSession');
        const typecheck = useCreateNewSession;

        const profile = AIBackendProfileSchema.parse({
            id: 'profile-test',
            name: 'Profile Test',
            description: undefined,
            environmentVariables: [],
            envVarRequirements: [{ name: 'REQUIRED_CONFIG', kind: 'config', required: true }],
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
        });

        const params = {
            launchIntentSignature: 'test-launch-intent',
            router: { push: vi.fn(), replace: vi.fn() },
            selectedMachineId: 'machine-1',
            selectedPath: '/repo',
            selectedMachine: { id: 'machine-1', metadata: {} },
            setIsCreating: vi.fn(),
            setIsResumeSupportChecking: vi.fn(),
            checkoutCreationDraft: {
                kind: 'git_worktree' as const,
                displayName: 'feature/auth',
                baseRef: 'main',
            },
            settings: {
                ...testSettingsDefaults,
                experiments: true,
                featureToggles: {},
            },
            useProfiles: true,
            selectedProfileId: profile.id,
            profileMap: new Map([[profile.id, profile]]),
            recentMachinePaths: [],
            agentType: 'codex' as const,
            permissionMode: 'default' as const,
            modelMode: 'auto' as const,
            promptStore: createNewSessionPromptStore('hi'),
            resumeSessionId: '',
            agentNewSessionOptions: null,
            machineEnvPresence: {
                isPreviewEnvSupported: true,
                isLoading: false,
                meta: { REQUIRED_CONFIG: { isSet: true } },
            } as unknown as Parameters<typeof typecheck>[0]['machineEnvPresence'],
            secrets: [],
            secretBindingsByProfileId: {},
            selectedSecretIdByProfileIdByEnvVarName: {},
            sessionOnlySecretValueByProfileIdByEnvVarName: {},
            selectedMachineCapabilities: null,
            targetServerId: null,
            allowedTargetServerIds: ['server-a'],
        } satisfies Parameters<typeof typecheck>[0];

        const hook = await renderHook(() => useCreateNewSession(params));
        await act(async () => {
            await hook.handleCreateSession();
        });

        expect(materializeNewSessionCheckoutMock).toHaveBeenCalledTimes(1);
        expect(materializeNewSessionCheckoutMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            selectedPath: '/repo',
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'feature/auth',
                baseRef: 'main',
            },
        }));
    });

    it('keeps worktree creation available without auto-creating a workspace first', async () => {
        const { useCreateNewSession } = await import('./useCreateNewSession');
        const typecheck = useCreateNewSession;

        const profile = AIBackendProfileSchema.parse({
            id: 'profile-test',
            name: 'Profile Test',
            description: undefined,
            environmentVariables: [],
            envVarRequirements: [{ name: 'REQUIRED_CONFIG', kind: 'config', required: true }],
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
        });

        const params = {
            launchIntentSignature: 'test-launch-intent',
            router: { push: vi.fn(), replace: vi.fn() },
            selectedMachineId: 'machine-1',
            selectedPath: '/repo',
            selectedMachine: { id: 'machine-1', metadata: {} },
            setIsCreating: vi.fn(),
            setIsResumeSupportChecking: vi.fn(),
            checkoutCreationDraft: {
                kind: 'git_worktree' as const,
                displayName: 'feature/auth',
                baseRef: 'main',
            },
            settings: {
                ...testSettingsDefaults,
                experiments: true,
                featureToggles: { 'sessions.direct': true },
            },
            useProfiles: true,
            selectedProfileId: profile.id,
            profileMap: new Map([[profile.id, profile]]),
            recentMachinePaths: [],
            agentType: 'codex' as const,
            permissionMode: 'default' as const,
            modelMode: 'auto' as const,
            promptStore: createNewSessionPromptStore('hi'),
            resumeSessionId: '',
            agentNewSessionOptions: null,
            machineEnvPresence: {
                isPreviewEnvSupported: true,
                isLoading: false,
                meta: { REQUIRED_CONFIG: { isSet: true } },
            } as unknown as Parameters<typeof typecheck>[0]['machineEnvPresence'],
            secrets: [],
            secretBindingsByProfileId: {},
            selectedSecretIdByProfileIdByEnvVarName: {},
            sessionOnlySecretValueByProfileIdByEnvVarName: {},
            selectedMachineCapabilities: null,
            targetServerId: null,
            allowedTargetServerIds: [],
        } satisfies Parameters<typeof typecheck>[0];

        const hook = await renderHook(() => useCreateNewSession(params));
        await act(async () => {
            await hook.handleCreateSession();
        });

        expect(materializeNewSessionCheckoutMock).toHaveBeenCalledTimes(1);
        expect(sessionSpawnNewActionBoundaryMock.mock.calls[0]?.[0]).not.toHaveProperty('workspaceId');
        expect(sessionSpawnNewActionBoundaryMock.mock.calls[0]?.[0]).not.toHaveProperty('workspaceLocationId');
        expect(sessionSpawnNewActionBoundaryMock.mock.calls[0]?.[0]).not.toHaveProperty('workspaceCheckoutId');
    });

    it('uses the canonical repository root returned by worktree creation when the selected path is a nested subdirectory', async () => {
        const { useCreateNewSession } = await import('./useCreateNewSession');
        const typecheck = useCreateNewSession;

        materializeNewSessionCheckoutMock.mockResolvedValueOnce({
            success: true,
            path: '/repo/.dev/worktree/feature/auth',
            sessionPath: '/repo/.dev/worktree/feature/auth/packages/app',
            repositoryRootPath: '/repo',
        });

        const params = {
            launchIntentSignature: 'test-launch-intent',
            router: { push: vi.fn(), replace: vi.fn() },
            selectedMachineId: 'machine-1',
            selectedPath: '/repo/packages/app',
            selectedMachine: { id: 'machine-1', metadata: {} },
            setIsCreating: vi.fn(),
            setIsResumeSupportChecking: vi.fn(),
            checkoutCreationDraft: {
                kind: 'git_worktree' as const,
                displayName: 'feature/auth',
                baseRef: 'main',
            },
            settings: {
                ...testSettingsDefaults,
                experiments: true,
                featureToggles: { 'sessions.direct': true },
            },
            useProfiles: false,
            selectedProfileId: null,
            profileMap: new Map(),
            recentMachinePaths: [],
            agentType: 'codex' as const,
            permissionMode: 'default' as const,
            modelMode: 'auto' as const,
            promptStore: createNewSessionPromptStore('Ship the scoped follow-up fix'),
            resumeSessionId: '',
            agentNewSessionOptions: null,
            machineEnvPresence: {
                isPreviewEnvSupported: true,
                isLoading: false,
                meta: {},
            } as unknown as Parameters<typeof typecheck>[0]['machineEnvPresence'],
            secrets: [],
            secretBindingsByProfileId: {},
            selectedSecretIdByProfileIdByEnvVarName: {},
            sessionOnlySecretValueByProfileIdByEnvVarName: {},
            selectedMachineCapabilities: null,
            targetServerId: null,
            allowedTargetServerIds: [],
        } satisfies Parameters<typeof typecheck>[0];

        const hook = await renderHook(() => useCreateNewSession(params));
        await act(async () => {
            await hook.handleCreateSession();
        });

        expect(sessionSpawnNewActionBoundaryMock).toHaveBeenCalledWith(expect.objectContaining({
            directory: '/repo/.dev/worktree/feature/auth/packages/app',
        }));
    });

    it('keeps repo-native worktree creation workspace-free', async () => {
        const { useCreateNewSession } = await import('./useCreateNewSession');
        const typecheck = useCreateNewSession;

        const routerReplace = vi.fn();
        const disableDraftPersistence = vi.fn();
        const setIsCreating = vi.fn();
        const params = {
            launchIntentSignature: 'test-launch-intent',
            router: { push: vi.fn(), replace: routerReplace },
            selectedMachineId: 'machine-1',
            selectedPath: '/repo',
            selectedMachine: { id: 'machine-1', metadata: {} },
            setIsCreating,
            setIsResumeSupportChecking: vi.fn(),
            checkoutCreationDraft: {
                kind: 'git_worktree' as const,
                displayName: 'feature/auth',
                baseRef: 'main',
            },
            settings: {
                ...testSettingsDefaults,
                experiments: true,
                featureToggles: { 'sessions.direct': true },
            },
            useProfiles: false,
            selectedProfileId: null,
            profileMap: new Map(),
            recentMachinePaths: [],
            agentType: 'codex' as const,
            permissionMode: 'default' as const,
            modelMode: 'auto' as const,
            promptStore: createNewSessionPromptStore('Ship the scoped follow-up fix'),
            resumeSessionId: '',
            agentNewSessionOptions: null,
            machineEnvPresence: {
                isPreviewEnvSupported: true,
                isLoading: false,
                meta: {},
            } as unknown as Parameters<typeof typecheck>[0]['machineEnvPresence'],
            secrets: [],
            secretBindingsByProfileId: {},
            selectedSecretIdByProfileIdByEnvVarName: {},
            sessionOnlySecretValueByProfileIdByEnvVarName: {},
            selectedMachineCapabilities: null,
            targetServerId: null,
            allowedTargetServerIds: [],
            disableDraftPersistence,
        } satisfies Parameters<typeof typecheck>[0];

        const hook = await renderHook(() => useCreateNewSession(params));
        await act(async () => {
            await hook.handleCreateSession();
        });

        expect(sessionSpawnNewActionBoundaryMock).toHaveBeenCalledTimes(1);
        expect(sessionSpawnNewActionBoundaryMock.mock.calls[0]?.[0]).not.toHaveProperty('workspaceId');
        expect(sessionSpawnNewActionBoundaryMock.mock.calls[0]?.[0]).not.toHaveProperty('workspaceLocationId');
        expect(sessionSpawnNewActionBoundaryMock.mock.calls[0]?.[0]).not.toHaveProperty('workspaceCheckoutId');
        expect(machineBashMock).not.toHaveBeenCalled();
        expect(disableDraftPersistence).toHaveBeenCalledTimes(1);
        expect(clearNewSessionDraftMock).toHaveBeenCalledTimes(1);
        expect(routerReplace).toHaveBeenCalledWith('/session/session-created?serverId=server-a', expect.anything());
        expect(setIsCreating).not.toHaveBeenCalledWith(false);
    });

    it('removes the created worktree when spawn fails without linked workspace context', async () => {
        const { useCreateNewSession } = await import('./useCreateNewSession');
        const { Modal } = await import('@/modal');
        const typecheck = useCreateNewSession;

        sessionSpawnNewActionBoundaryMock.mockImplementationOnce(async () => ({
            type: 'error',
            errorCode: 'unexpected',
            errorMessage: 'spawn failed',
        } as any));

        const params = {
            launchIntentSignature: 'test-launch-intent',
            router: { push: vi.fn(), replace: vi.fn() },
            selectedMachineId: 'machine-1',
            selectedPath: '/repo',
            selectedMachine: { id: 'machine-1', metadata: {} },
            setIsCreating: vi.fn(),
            setIsResumeSupportChecking: vi.fn(),
            checkoutCreationDraft: {
                kind: 'git_worktree' as const,
                displayName: 'feature/auth',
                baseRef: 'main',
            },
            settings: {
                ...testSettingsDefaults,
                experiments: true,
                featureToggles: { 'sessions.direct': true },
            },
            useProfiles: false,
            selectedProfileId: null,
            profileMap: new Map(),
            recentMachinePaths: [],
            agentType: 'codex' as const,
            permissionMode: 'default' as const,
            modelMode: 'auto' as const,
            promptStore: createNewSessionPromptStore(''),
            resumeSessionId: '',
            agentNewSessionOptions: null,
            machineEnvPresence: {
                isPreviewEnvSupported: true,
                isLoading: false,
                meta: {},
            } as unknown as Parameters<typeof typecheck>[0]['machineEnvPresence'],
            secrets: [],
            secretBindingsByProfileId: {},
            selectedSecretIdByProfileIdByEnvVarName: {},
            sessionOnlySecretValueByProfileIdByEnvVarName: {},
            selectedMachineCapabilities: null,
            targetServerId: null,
            allowedTargetServerIds: [],
        } satisfies Parameters<typeof typecheck>[0];

        const hook = await renderHook(() => useCreateNewSession(params));
        await act(async () => {
            await hook.handleCreateSession();
        });

        expect(machineBashMock).toHaveBeenCalledWith(
            'machine-1',
            { argv: ['git', 'worktree', 'remove', '--force', '--', '/tmp/worktree'] },
            '/repo',
            expect.objectContaining({ serverId: expect.anything() }),
        );
        expect(vi.mocked(Modal.alert)).toHaveBeenCalledWith('common.error', expect.stringContaining('spawn failed'));
    });

    it('removes only the created worktree when spawn fails during a repo-native worktree launch', async () => {
        const { useCreateNewSession } = await import('./useCreateNewSession');
        const { Modal } = await import('@/modal');
        const typecheck = useCreateNewSession;

        sessionSpawnNewActionBoundaryMock.mockImplementationOnce(async () => ({
            type: 'error',
            errorCode: 'unexpected',
            errorMessage: 'spawn failed',
        } as any));

        const params = {
            launchIntentSignature: 'test-launch-intent',
            router: { push: vi.fn(), replace: vi.fn() },
            selectedMachineId: 'machine-1',
            selectedPath: '/repo',
            selectedMachine: { id: 'machine-1', metadata: {} },
            setIsCreating: vi.fn(),
            setIsResumeSupportChecking: vi.fn(),
            checkoutCreationDraft: {
                kind: 'git_worktree' as const,
                displayName: 'feature/auth',
                baseRef: 'main',
            },
            settings: {
                ...testSettingsDefaults,
                experiments: true,
                featureToggles: { 'sessions.direct': true },
            },
            useProfiles: false,
            selectedProfileId: null,
            profileMap: new Map(),
            recentMachinePaths: [],
            agentType: 'codex' as const,
            permissionMode: 'default' as const,
            modelMode: 'auto' as const,
            promptStore: createNewSessionPromptStore(''),
            resumeSessionId: '',
            agentNewSessionOptions: null,
            machineEnvPresence: {
                isPreviewEnvSupported: true,
                isLoading: false,
                meta: {},
            } as unknown as Parameters<typeof typecheck>[0]['machineEnvPresence'],
            secrets: [],
            secretBindingsByProfileId: {},
            selectedSecretIdByProfileIdByEnvVarName: {},
            sessionOnlySecretValueByProfileIdByEnvVarName: {},
            selectedMachineCapabilities: null,
            targetServerId: null,
            allowedTargetServerIds: [],
        } satisfies Parameters<typeof typecheck>[0];

        const hook = await renderHook(() => useCreateNewSession(params));
        await act(async () => {
            await hook.handleCreateSession();
        });

        expect(sessionSpawnNewActionBoundaryMock.mock.calls[0]?.[0]).not.toHaveProperty('workspaceId');
        expect(sessionSpawnNewActionBoundaryMock.mock.calls[0]?.[0]).not.toHaveProperty('workspaceLocationId');
        expect(sessionSpawnNewActionBoundaryMock.mock.calls[0]?.[0]).not.toHaveProperty('workspaceCheckoutId');
        expect(machineBashMock).toHaveBeenCalledWith(
            'machine-1',
            { argv: ['git', 'worktree', 'remove', '--force', '--', '/tmp/worktree'] },
            '/repo',
            expect.objectContaining({ serverId: expect.anything() }),
        );
        expect(vi.mocked(Modal.alert)).toHaveBeenCalledWith('common.error', expect.stringContaining('spawn failed'));
    });

    it('does not attach workspace locations before spawning a repo-native worktree session', async () => {
        const { useCreateNewSession } = await import('./useCreateNewSession');
        const typecheck = useCreateNewSession;

        const params = {
            launchIntentSignature: 'test-launch-intent',
            router: { push: vi.fn(), replace: vi.fn() },
            selectedMachineId: 'machine-1',
            selectedPath: '/repo',
            selectedMachine: { id: 'machine-1', metadata: {} },
            setIsCreating: vi.fn(),
            setIsResumeSupportChecking: vi.fn(),
            checkoutCreationDraft: {
                kind: 'git_worktree' as const,
                displayName: 'feature/auth',
                baseRef: 'main',
            },
            settings: {
                ...testSettingsDefaults,
                experiments: true,
                featureToggles: { 'sessions.direct': true },
            },
            useProfiles: false,
            selectedProfileId: null,
            profileMap: new Map(),
            recentMachinePaths: [],
            agentType: 'codex' as const,
            permissionMode: 'default' as const,
            modelMode: 'auto' as const,
            promptStore: createNewSessionPromptStore(''),
            resumeSessionId: '',
            agentNewSessionOptions: null,
            machineEnvPresence: {
                isPreviewEnvSupported: true,
                isLoading: false,
                meta: {},
            } as unknown as Parameters<typeof typecheck>[0]['machineEnvPresence'],
            secrets: [],
            secretBindingsByProfileId: {},
            selectedSecretIdByProfileIdByEnvVarName: {},
            sessionOnlySecretValueByProfileIdByEnvVarName: {},
            selectedMachineCapabilities: null,
            targetServerId: null,
            allowedTargetServerIds: [],
        } satisfies Parameters<typeof typecheck>[0];

        const hook = await renderHook(() => useCreateNewSession(params));
        await act(async () => {
            await hook.handleCreateSession();
        });

        expect(sessionSpawnNewActionBoundaryMock).toHaveBeenCalledTimes(1);
        expect(sessionSpawnNewActionBoundaryMock.mock.calls[0]?.[0]).not.toHaveProperty('workspaceId');
        expect(sessionSpawnNewActionBoundaryMock.mock.calls[0]?.[0]).not.toHaveProperty('workspaceLocationId');
        expect(sessionSpawnNewActionBoundaryMock.mock.calls[0]?.[0]).not.toHaveProperty('workspaceCheckoutId');
        expect(machineBashMock).not.toHaveBeenCalled();
    });

    it('rolls back the created worktree when spawn requests directory approval without workspace linkage', async () => {
        const { useCreateNewSession } = await import('./useCreateNewSession');
        const { Modal } = await import('@/modal');
        const typecheck = useCreateNewSession;

        sessionSpawnNewActionBoundaryMock.mockImplementationOnce(async () => ({
            type: 'requestToApproveDirectoryCreation',
            directory: '/tmp/worktree',
        } as any));

        const params = {
            launchIntentSignature: 'test-launch-intent',
            router: { push: vi.fn(), replace: vi.fn() },
            selectedMachineId: 'machine-1',
            selectedPath: '/repo',
            selectedMachine: { id: 'machine-1', metadata: {} },
            setIsCreating: vi.fn(),
            setIsResumeSupportChecking: vi.fn(),
            checkoutCreationDraft: {
                kind: 'git_worktree' as const,
                displayName: 'feature/auth',
                baseRef: 'main',
            },
            settings: {
                ...testSettingsDefaults,
                experiments: true,
                featureToggles: { 'sessions.direct': true },
            },
            useProfiles: false,
            selectedProfileId: null,
            profileMap: new Map(),
            recentMachinePaths: [],
            agentType: 'codex' as const,
            permissionMode: 'default' as const,
            modelMode: 'auto' as const,
            promptStore: createNewSessionPromptStore(''),
            resumeSessionId: '',
            agentNewSessionOptions: null,
            machineEnvPresence: {
                isPreviewEnvSupported: true,
                isLoading: false,
                meta: {},
            } as unknown as Parameters<typeof typecheck>[0]['machineEnvPresence'],
            secrets: [],
            secretBindingsByProfileId: {},
            selectedSecretIdByProfileIdByEnvVarName: {},
            sessionOnlySecretValueByProfileIdByEnvVarName: {},
            selectedMachineCapabilities: null,
            targetServerId: null,
            allowedTargetServerIds: [],
        } satisfies Parameters<typeof typecheck>[0];

        const hook = await renderHook(() => useCreateNewSession(params));
        await act(async () => {
            await hook.handleCreateSession();
        });

        expect(machineBashMock).toHaveBeenCalledWith(
            'machine-1',
            { argv: ['git', 'worktree', 'remove', '--force', '--', '/tmp/worktree'] },
            '/repo',
            expect.objectContaining({ serverId: expect.anything() }),
        );
        expect(vi.mocked(Modal.alert)).toHaveBeenCalledWith('common.error', 'newSession.failedToStart');
    });

    it('surfaces worktree cleanup failures even when no workspace artifacts were created', async () => {
        const { useCreateNewSession } = await import('./useCreateNewSession');
        const { Modal } = await import('@/modal');
        const typecheck = useCreateNewSession;

        sessionSpawnNewActionBoundaryMock.mockImplementationOnce(async () => ({
            type: 'error',
            errorCode: 'unexpected',
            errorMessage: 'spawn failed',
        } as any));
        machineBashMock.mockResolvedValueOnce({
            success: false,
            stdout: '',
            stderr: 'cleanup failed',
            exitCode: 1,
        });

        const params = {
            launchIntentSignature: 'test-launch-intent',
            router: { push: vi.fn(), replace: vi.fn() },
            selectedMachineId: 'machine-1',
            selectedPath: '/repo',
            selectedMachine: { id: 'machine-1', metadata: {} },
            setIsCreating: vi.fn(),
            setIsResumeSupportChecking: vi.fn(),
            checkoutCreationDraft: {
                kind: 'git_worktree' as const,
                displayName: 'feature/auth',
                baseRef: 'main',
            },
            settings: {
                ...testSettingsDefaults,
                experiments: true,
                featureToggles: { 'sessions.direct': true },
            },
            useProfiles: false,
            selectedProfileId: null,
            profileMap: new Map(),
            recentMachinePaths: [],
            agentType: 'codex' as const,
            permissionMode: 'default' as const,
            modelMode: 'auto' as const,
            promptStore: createNewSessionPromptStore(''),
            resumeSessionId: '',
            agentNewSessionOptions: null,
            machineEnvPresence: {
                isPreviewEnvSupported: true,
                isLoading: false,
                meta: {},
            } as unknown as Parameters<typeof typecheck>[0]['machineEnvPresence'],
            secrets: [],
            secretBindingsByProfileId: {},
            selectedSecretIdByProfileIdByEnvVarName: {},
            sessionOnlySecretValueByProfileIdByEnvVarName: {},
            selectedMachineCapabilities: null,
            targetServerId: null,
            allowedTargetServerIds: [],
        } satisfies Parameters<typeof typecheck>[0];

        const hook = await renderHook(() => useCreateNewSession(params));
        await act(async () => {
            await hook.handleCreateSession();
        });

        expect(vi.mocked(Modal.alert)).toHaveBeenCalledWith('common.error', expect.stringContaining('cleanup failed'));
    });

    it('rolls back the created worktree when session spawn throws without workspace linkage', async () => {
        const { useCreateNewSession } = await import('./useCreateNewSession');
        const { Modal } = await import('@/modal');
        const typecheck = useCreateNewSession;
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        sessionSpawnNewActionBoundaryMock.mockRejectedValueOnce(new Error('spawn exploded'));

        const params = {
            launchIntentSignature: 'test-launch-intent',
            router: { push: vi.fn(), replace: vi.fn() },
            selectedMachineId: 'machine-1',
            selectedPath: '/repo',
            selectedMachine: { id: 'machine-1', metadata: {} },
            setIsCreating: vi.fn(),
            setIsResumeSupportChecking: vi.fn(),
            checkoutCreationDraft: {
                kind: 'git_worktree' as const,
                displayName: 'feature/auth',
                baseRef: 'main',
            },
            settings: {
                ...testSettingsDefaults,
                experiments: true,
                featureToggles: { 'sessions.direct': true },
            },
            useProfiles: false,
            selectedProfileId: null,
            profileMap: new Map(),
            recentMachinePaths: [],
            agentType: 'codex' as const,
            permissionMode: 'default' as const,
            modelMode: 'auto' as const,
            promptStore: createNewSessionPromptStore(''),
            resumeSessionId: '',
            agentNewSessionOptions: null,
            machineEnvPresence: {
                isPreviewEnvSupported: true,
                isLoading: false,
                meta: {},
            } as unknown as Parameters<typeof typecheck>[0]['machineEnvPresence'],
            secrets: [],
            secretBindingsByProfileId: {},
            selectedSecretIdByProfileIdByEnvVarName: {},
            sessionOnlySecretValueByProfileIdByEnvVarName: {},
            selectedMachineCapabilities: null,
            targetServerId: null,
            allowedTargetServerIds: [],
        } satisfies Parameters<typeof typecheck>[0];

        const hook = await renderHook(() => useCreateNewSession(params));
        await act(async () => {
            await hook.handleCreateSession();
        });

        expect(machineBashMock).toHaveBeenCalledWith(
            'machine-1',
            { argv: ['git', 'worktree', 'remove', '--force', '--', '/tmp/worktree'] },
            '/repo',
            expect.objectContaining({ serverId: expect.anything() }),
        );
        expect(consoleErrorSpy).not.toHaveBeenCalledWith('Failed to roll back new session artifacts', expect.anything());
        expect(consoleErrorSpy).not.toHaveBeenCalledWith('Failed to start session', expect.anything());
        expect(captureExceptionIfEnabledMock).toHaveBeenCalledTimes(1);
        expect(captureExceptionIfEnabledMock).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ message: 'spawn exploded' }),
            expect.objectContaining({
                tags: expect.objectContaining({ area: 'new_session', action: 'create_session' }),
                extra: expect.objectContaining({ phase: 'create_session' }),
            }),
        );
        expect(vi.mocked(Modal.alert)).toHaveBeenCalledWith('common.error', 'spawn exploded');

        consoleErrorSpy.mockRestore();
    });

    it('preserves retryable draft state and avoids opening a non-hydrated session when active follow-up hydration fails before workspace metadata publication', async () => {
        const { useCreateNewSession } = await import('./useCreateNewSession');
        const { Modal } = await import('@/modal');
        const typecheck = useCreateNewSession;

        ensureSessionVisibleForMessageRouteMock.mockImplementation(async () => {});
        autoPressModalButtonTextState.value = 'common.cancel';
        followUpSpawnedSessionWithServerScopeMock.mockImplementationOnce(async (params?: unknown) => {
            const request = (params ?? {}) as { sessionId?: string; targetServerId?: string | null };
            await ensureSessionVisibleForMessageRouteMock(request.sessionId, {
                forceRefresh: true,
                serverId: request.targetServerId || 'server-a',
            });
            throw new Error('Created session is not available locally yet');
        });

        const routerReplace = vi.fn();
        const disableDraftPersistence = vi.fn();
        const setIsCreating = vi.fn();
        const params = {
            launchIntentSignature: 'test-launch-intent',
            router: { push: vi.fn(), replace: routerReplace },
            selectedMachineId: 'machine-1',
            selectedPath: '/repo',
            selectedMachine: { id: 'machine-1', metadata: {} },
            setIsCreating,
            setIsResumeSupportChecking: vi.fn(),
            settings: {
                ...testSettingsDefaults,
                experiments: true,
                featureToggles: { 'sessions.direct': true },
            },
            useProfiles: false,
            selectedProfileId: null,
            profileMap: new Map(),
            recentMachinePaths: [],
            agentType: 'codex' as const,
            permissionMode: 'default' as const,
            modelMode: 'auto' as const,
            promptStore: createNewSessionPromptStore(''),
            resumeSessionId: '',
            agentNewSessionOptions: null,
            machineEnvPresence: {
                isPreviewEnvSupported: true,
                isLoading: false,
                meta: {},
            } as unknown as Parameters<typeof typecheck>[0]['machineEnvPresence'],
            secrets: [],
            secretBindingsByProfileId: {},
            selectedSecretIdByProfileIdByEnvVarName: {},
            sessionOnlySecretValueByProfileIdByEnvVarName: {},
            selectedMachineCapabilities: null,
            targetServerId: null,
            allowedTargetServerIds: [],
            disableDraftPersistence,
        } satisfies Parameters<typeof typecheck>[0];

        const hook = await renderHook(() => useCreateNewSession(params));
        await act(async () => {
            await hook.handleCreateSession();
        });

        expect(sessionSpawnNewActionBoundaryMock).toHaveBeenCalledWith(expect.objectContaining({
            directory: '/repo',
            machineId: 'machine-1',
        }));
        const spawnedOptions = sessionSpawnNewActionBoundaryMock.mock.calls.at(0)?.[0] as
            | {
                workspaceId?: string;
                workspaceLocationId?: string;
                workspaceCheckoutId?: string;
            }
            | undefined;
        expect(spawnedOptions?.workspaceId).toBeUndefined();
        expect(spawnedOptions?.workspaceLocationId).toBeUndefined();
        expect(spawnedOptions?.workspaceCheckoutId).toBeUndefined();
        expect(ensureSessionVisibleForMessageRouteMock).toHaveBeenCalledWith('session-created', expect.objectContaining({
            forceRefresh: true,
            serverId: 'server-a',
        }));
        expect(routerReplace).not.toHaveBeenCalled();
        expect(disableDraftPersistence).not.toHaveBeenCalled();
        expect(clearNewSessionDraftMock).not.toHaveBeenCalled();
        expect(setIsCreating).toHaveBeenCalledWith(false);
        const retryAlertCall = vi.mocked(Modal.alert).mock.calls.find((call) => {
            const buttons = call[2];
            return Array.isArray(buttons) && buttons.some((button) => button?.text === 'common.retry');
        });
        expect(retryAlertCall).toBeTruthy();
        expect(retryAlertCall?.[0]).toBe('errors.daemonUnavailableTitle');
    });

    it('keeps the new-session draft surface active when afterCreated fails after session creation', async () => {
        const { useCreateNewSession } = await import('./useCreateNewSession');
        const { Modal } = await import('@/modal');

        for (const key of Object.keys(storedSessionsState.sessions)) {
            delete storedSessionsState.sessions[key];
        }
        ensureSessionVisibleForMessageRouteMock.mockImplementationOnce(async (sessionId?: unknown) => {
            const hydratedSessionId = String(sessionId ?? '').trim();
            if (!hydratedSessionId) {
                return;
            }

            storedSessionsState.sessions[hydratedSessionId] = {
                id: hydratedSessionId,
                createdAt: 1,
                updatedAt: 2,
                seq: 0,
                active: true,
                activeAt: 2,
                encryptionMode: 'plain',
                metadataVersion: 0,
                metadata: null,
                agentStateVersion: 1,
                agentState: null,
            } as Session;
        });

        const routerReplace = vi.fn();
        const disableDraftPersistence = vi.fn();
        const params = {
            launchIntentSignature: 'test-launch-intent',
            router: { push: vi.fn(), replace: routerReplace },
            selectedMachineId: 'machine-1',
            selectedPath: '/repo',
            selectedMachine: { id: 'machine-1', metadata: {} },
            setIsCreating: vi.fn(),
            setIsResumeSupportChecking: vi.fn(),
            settings: testSettingsDefaults,
            useProfiles: false,
            selectedProfileId: null,
            profileMap: new Map(),
            recentMachinePaths: [],
            agentType: 'codex' as const,
            permissionMode: 'default' as const,
            modelMode: 'auto' as const,
            promptStore: createNewSessionPromptStore('Recover this first message'),
            resumeSessionId: '',
            agentNewSessionOptions: null,
            machineEnvPresence: {
                isPreviewEnvSupported: false,
                isLoading: false,
                meta: {},
            } as unknown as Parameters<typeof useCreateNewSession>[0]['machineEnvPresence'],
            secrets: [],
            secretBindingsByProfileId: {},
            selectedSecretIdByProfileIdByEnvVarName: {},
            sessionOnlySecretValueByProfileIdByEnvVarName: {},
            selectedMachineCapabilities: null,
            targetServerId: null,
            allowedTargetServerIds: [],
            disableDraftPersistence,
        } satisfies Parameters<typeof useCreateNewSession>[0];

        const hook = await renderHook(() => useCreateNewSession(params));
        await act(async () => {
            await hook.handleCreateSession({
                initialMessage: 'skip',
                afterCreated: async () => {
                    const error = new Error('afterCreated failed');
                    Object.assign(error, {
                        recoverableFollowUpPayload: {
                            draftText: 'Recover this first message',
                            attachmentDrafts: [{
                                id: 'draft-retry',
                                source: {
                                    kind: 'native',
                                    uri: 'file:///tmp/retry.txt',
                                    name: 'retry.txt',
                                    sizeBytes: 12,
                                    mimeType: 'text/plain',
                                },
                                status: 'uploaded',
                                uploadedPath: 'uploads/retry.txt',
                                uploadedSizeBytes: 12,
                                uploadedMimeType: 'text/plain',
                                sha256: 'sha-retry',
                            }],
                        },
                    });
                    throw error;
                },
            });
        });

        expect(storeTempDataMock).not.toHaveBeenCalled();
        expect(disableDraftPersistence).not.toHaveBeenCalled();
        expect(clearNewSessionDraftMock).not.toHaveBeenCalled();
        expect(routerReplace).not.toHaveBeenCalled();
        expect(vi.mocked(Modal.alert)).toHaveBeenCalledWith('common.error', 'afterCreated failed');
    });

    it('keeps the new-session surface active when afterCreated fails before the created session hydrates locally', async () => {
        const { useCreateNewSession } = await import('./useCreateNewSession');
        const { readRecoverableFollowUpPayload } = await import('@/sync/runtime/orchestration/serverScopedRpc/followUpSpawnedSession');
        const { Modal } = await import('@/modal');

        autoPressModalButtonTextState.value = 'common.cancel';
        ensureSessionVisibleForMessageRouteMock.mockImplementationOnce(async (sessionId?: unknown) => {
            const hydratedSessionId = String(sessionId ?? '').trim();
            if (!hydratedSessionId) {
                return;
            }

            storedSessionsState.sessions[hydratedSessionId] = {
                id: hydratedSessionId,
                createdAt: 1,
                updatedAt: 2,
                seq: 0,
                active: true,
                activeAt: 2,
                encryptionMode: 'plain',
                metadataVersion: 0,
                metadata: null,
                agentStateVersion: 1,
                agentState: null,
            } as Session;
        });
        ensureSessionVisibleForMessageRouteMock.mockImplementationOnce(async () => {});

        const routerReplace = vi.fn();
        const disableDraftPersistence = vi.fn();
        const params = {
            launchIntentSignature: 'test-launch-intent',
            router: { push: vi.fn(), replace: routerReplace },
            selectedMachineId: 'machine-1',
            selectedPath: '/repo',
            selectedMachine: { id: 'machine-1', metadata: {} },
            setIsCreating: vi.fn(),
            setIsResumeSupportChecking: vi.fn(),
            settings: testSettingsDefaults,
            useProfiles: false,
            selectedProfileId: null,
            profileMap: new Map(),
            recentMachinePaths: [],
            agentType: 'codex' as const,
            permissionMode: 'default' as const,
            modelMode: 'auto' as const,
            promptStore: createNewSessionPromptStore('Investigate this bug'),
            resumeSessionId: '',
            agentNewSessionOptions: null,
            machineEnvPresence: {
                isPreviewEnvSupported: false,
                isLoading: false,
                meta: {},
            } as unknown as Parameters<typeof useCreateNewSession>[0]['machineEnvPresence'],
            secrets: [],
            secretBindingsByProfileId: {},
            selectedSecretIdByProfileIdByEnvVarName: {},
            sessionOnlySecretValueByProfileIdByEnvVarName: {},
            selectedMachineCapabilities: null,
            targetServerId: null,
            allowedTargetServerIds: [],
            disableDraftPersistence,
        } satisfies Parameters<typeof useCreateNewSession>[0];

        const hook = await renderHook(() => useCreateNewSession(params));
        await act(async () => {
            await hook.handleCreateSession({
                initialMessage: 'skip',
                afterCreated: async () => {
                    delete storedSessionsState.sessions['session-created'];
                    const error = new Error('Created session is not available locally yet');
                    Object.assign(error, {
                        recoverableFollowUpPayload: {
                            draftText: 'Investigate this bug\n\n[attachments block]',
                            displayText: 'Investigate this bug',
                            metaOverrides: {
                                happier: {
                                    kind: 'attachments.v1',
                                },
                            },
                            profileId: 'profile-work',
                        },
                    });
                    expect(readRecoverableFollowUpPayload(error)).toEqual(expect.objectContaining({
                        draftText: 'Investigate this bug\n\n[attachments block]',
                    }));
                    throw error;
                },
            });
        });

        expect(saveSessionDraftsMock).not.toHaveBeenCalled();
        expect(saveNewSessionDraftMock).not.toHaveBeenCalled();
        expect(disableDraftPersistence).not.toHaveBeenCalled();
        expect(clearNewSessionDraftMock).not.toHaveBeenCalled();
        expect(routerReplace).not.toHaveBeenCalled();
        const retryAlertCall = vi.mocked(Modal.alert).mock.calls.find((call) => {
            const buttons = call[2];
            return Array.isArray(buttons) && buttons.some((button) => button?.text === 'common.retry');
        });
        expect(retryAlertCall).toBeTruthy();
        expect(retryAlertCall?.[0]).toBe('errors.daemonUnavailableTitle');
    });
});
