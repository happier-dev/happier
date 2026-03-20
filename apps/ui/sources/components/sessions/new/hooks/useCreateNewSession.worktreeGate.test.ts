import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildBackendTargetKey } from '@happier-dev/protocol';
import { AIBackendProfileSchema } from '@/sync/domains/profiles/profileCompatibility';
import type { Session } from '@/sync/domains/state/storageTypes';
import { settingsDefaults } from '@/sync/domains/settings/settings';

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

const saveWorkspaceMock = vi.hoisted(() => vi.fn(async (_input?: unknown, _options?: unknown) => ({
    workspace: {
        id: 'ws_generated',
        displayName: 'repo',
        locationIds: ['loc_generated'],
        checkoutIds: ['checkout_primary_generated'],
        defaultLocationId: 'loc_generated',
        defaultCheckoutId: 'checkout_primary_generated',
    },
})));

const saveWorkspaceLocationMock = vi.hoisted(() => vi.fn(async (_input?: unknown, _options?: unknown) => ({
    workspace: {
        id: 'ws_generated',
        displayName: 'repo',
        locationIds: ['loc_generated'],
        checkoutIds: ['checkout_primary_generated'],
        defaultLocationId: 'loc_generated',
        defaultCheckoutId: 'checkout_primary_generated',
    },
    location: {
        id: 'loc_generated',
        workspaceId: 'ws_generated',
        machineId: 'machine-1',
        path: '/repo',
        capabilities: {
            syncEligible: true,
            scmDetected: true,
            checkoutProviderKinds: ['git_worktree'],
        },
    },
    primaryCheckout: {
        id: 'checkout_primary_generated',
        workspaceId: 'ws_generated',
        workspaceLocationId: 'loc_generated',
        kind: 'primary',
        path: '/repo',
        displayName: 'main',
        status: 'ready',
        syncPolicy: 'inherit',
    },
})));

const saveWorkspaceCheckoutMock = vi.hoisted(() => vi.fn(async (_input?: unknown, _options?: unknown) => ({
    checkout: {
        id: 'checkout_feature_generated',
        workspaceId: 'ws_generated',
        workspaceLocationId: 'loc_generated',
        kind: 'git_worktree',
        path: '/tmp/worktree',
        displayName: 'feature/auth',
        status: 'ready',
        syncPolicy: 'inherit',
    },
})));
const deleteWorkspaceCheckoutMock = vi.hoisted(() => vi.fn(async () => ({ success: true })));
const deleteWorkspaceMock = vi.hoisted(() => vi.fn(async () => ({ success: true })));
const detachWorkspaceLocationMock = vi.hoisted(() => vi.fn(async () => ({ success: true })));
const captureExceptionIfEnabledMock = vi.hoisted(() => vi.fn());
const clearNewSessionDraftMock = vi.hoisted(() => vi.fn());
const loadSessionDraftsMock = vi.hoisted(() => vi.fn(() => ({})));
const saveSessionDraftsMock = vi.hoisted(() => vi.fn());
const saveNewSessionDraftMock = vi.hoisted(() => vi.fn());
const storeTempDataMock = vi.hoisted(() => vi.fn(() => 'temp-recovery-1'));
const updateSessionDraftMock = vi.hoisted(() => vi.fn());
const updateSessionPermissionModeMock = vi.hoisted(() => vi.fn());
const updateSessionModelModeMock = vi.hoisted(() => vi.fn());
const storedSessionsState = vi.hoisted(() => ({ sessions: {} as Record<string, Session> }));
const ensureSessionVisibleForMessageRouteMock = vi.hoisted(() => vi.fn(async (sessionId?: unknown) => {
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
type MachineSpawnNewSessionResult =
    | { type: 'success'; sessionId: string }
    | { type: 'error'; errorCode: string; errorMessage?: string };

const machineSpawnNewSessionMock = vi.hoisted(() => vi.fn(async (_input?: unknown): Promise<MachineSpawnNewSessionResult> => ({
    type: 'success',
    sessionId: 'session-created',
})));
const machineBashMock = vi.hoisted(() => vi.fn(async () => ({
    success: true,
    stdout: '',
    stderr: '',
    exitCode: 0,
})));

vi.mock('@/sync/ops/workspaces', () => ({
    inspectWorkspaceLocationScm: vi.fn(async () => ({ ok: false })),
    saveWorkspace: saveWorkspaceMock,
    saveWorkspaceLocation: saveWorkspaceLocationMock,
    saveWorkspaceCheckout: saveWorkspaceCheckoutMock,
    deleteWorkspaceCheckout: deleteWorkspaceCheckoutMock,
    deleteWorkspace: deleteWorkspaceMock,
    detachWorkspaceLocation: detachWorkspaceLocationMock,
}));

vi.mock('@/sync/ops', () => ({
    machineSpawnNewSession: machineSpawnNewSessionMock,
    machineBash: machineBashMock,
}));

vi.mock('@/components/sessions/new/modules/materializeNewSessionCheckout', () => ({
    materializeNewSessionCheckout: (params: unknown) => materializeNewSessionCheckoutMock(params),
}));

vi.mock('@/sync/domains/server/selection/serverSelectionResolver', () => ({
    resolveNewSessionServerTarget: vi.fn((params: { requestedServerId?: string | null; allowedServerIds: string[] }) => ({
        targetServerId: params.requestedServerId ?? params.allowedServerIds[0] ?? null,
        rejectedRequestedServerId: null,
    })),
}));

vi.mock('@/sync/domains/features/featureLocalPolicy', () => ({
    resolveLocalFeaturePolicyEnabled: vi.fn((featureId: string, settings: { featureToggles?: Record<string, boolean> }) => settings.featureToggles?.[featureId] === true),
}));

vi.mock('@/utils/system/sentry', () => ({
    captureExceptionIfEnabled: captureExceptionIfEnabledMock,
}));

vi.mock('@/modal', () => ({
    Modal: {
        alert: vi.fn(),
        confirm: vi.fn(async () => false),
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
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
        createAutomation: vi.fn(async () => ({})),
        publishSessionAcpSessionModeOverrideToMetadata: vi.fn(async () => {}),
    },
}));

vi.mock('@/sync/store/settingsWriters', () => ({
    useApplySettings: () => vi.fn(),
}));

vi.mock('@/sync/domains/state/storage', () => ({
    storage: {
        getState: () => ({
            settings: settingsDefaults,
            sessions: storedSessionsState.sessions,
            updateSessionDraft: updateSessionDraftMock,
            updateSessionPermissionMode: updateSessionPermissionModeMock,
            updateSessionModelMode: updateSessionModelModeMock,
        }),
    },
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

    await act(async () => {
        renderer.create(React.createElement(Test));
        await Promise.resolve();
    });

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
    updateSessionDraftMock.mockClear();
    updateSessionPermissionModeMock.mockClear();
    updateSessionModelModeMock.mockClear();
    ensureSessionVisibleForMessageRouteMock.mockClear();
    storedSessionsState.sessions = {};
    vi.resetModules();
});

describe('useCreateNewSession (worktree gating)', () => {
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
            router: { push: vi.fn(), replace: vi.fn() },
            selectedMachineId: 'machine-1',
            selectedPath: '/repo',
            selectedMachine: { id: 'machine-1', metadata: {} },
            setIsCreating: vi.fn(),
            setIsResumeSupportChecking: vi.fn(),
            settings: {
                ...settingsDefaults,
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
            sessionPrompt: 'hi',
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
        }));
        expect(machineSpawnNewSessionMock).toHaveBeenCalledWith(expect.objectContaining({
            directory: '/repo',
            machineId: 'machine-1',
        }));
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
                ...settingsDefaults,
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
            sessionPrompt: 'hi',
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
                ...settingsDefaults,
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
            sessionPrompt: 'hi',
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
        expect(saveWorkspaceMock).not.toHaveBeenCalled();
        expect(saveWorkspaceLocationMock).not.toHaveBeenCalled();
        expect(saveWorkspaceCheckoutMock).not.toHaveBeenCalled();
        expect(machineSpawnNewSessionMock.mock.calls[0]?.[0]).not.toHaveProperty('workspaceId');
        expect(machineSpawnNewSessionMock.mock.calls[0]?.[0]).not.toHaveProperty('workspaceLocationId');
        expect(machineSpawnNewSessionMock.mock.calls[0]?.[0]).not.toHaveProperty('workspaceCheckoutId');
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
                ...settingsDefaults,
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
            sessionPrompt: 'Ship the scoped follow-up fix',
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

        expect(saveWorkspaceMock).not.toHaveBeenCalled();
        expect(saveWorkspaceLocationMock).not.toHaveBeenCalled();
        expect(saveWorkspaceCheckoutMock).not.toHaveBeenCalled();
        expect(machineSpawnNewSessionMock).toHaveBeenCalledWith(expect.objectContaining({
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
                ...settingsDefaults,
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
            sessionPrompt: 'Ship the scoped follow-up fix',
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

        expect(saveWorkspaceMock).not.toHaveBeenCalled();
        expect(saveWorkspaceLocationMock).not.toHaveBeenCalled();
        expect(saveWorkspaceCheckoutMock).not.toHaveBeenCalled();
        expect(machineSpawnNewSessionMock).toHaveBeenCalledTimes(1);
        expect(machineSpawnNewSessionMock.mock.calls[0]?.[0]).not.toHaveProperty('workspaceId');
        expect(machineSpawnNewSessionMock.mock.calls[0]?.[0]).not.toHaveProperty('workspaceLocationId');
        expect(machineSpawnNewSessionMock.mock.calls[0]?.[0]).not.toHaveProperty('workspaceCheckoutId');
        expect(machineBashMock).not.toHaveBeenCalled();
        expect(deleteWorkspaceCheckoutMock).not.toHaveBeenCalled();
        expect(deleteWorkspaceMock).not.toHaveBeenCalled();
        expect(detachWorkspaceLocationMock).not.toHaveBeenCalled();
        expect(disableDraftPersistence).toHaveBeenCalledTimes(1);
        expect(clearNewSessionDraftMock).toHaveBeenCalledTimes(1);
        expect(routerReplace).toHaveBeenCalledWith('/session/session-created', expect.anything());
        expect(setIsCreating).not.toHaveBeenCalledWith(false);
    });

    it('removes the created worktree when spawn fails without linked workspace context', async () => {
        const { useCreateNewSession } = await import('./useCreateNewSession');
        const { Modal } = await import('@/modal');
        const typecheck = useCreateNewSession;

        machineSpawnNewSessionMock.mockImplementationOnce(async () => ({
            type: 'error',
            errorCode: 'unexpected',
            errorMessage: 'spawn failed',
        } as any));

        const params = {
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
                ...settingsDefaults,
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
            sessionPrompt: '',
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

        expect(saveWorkspaceCheckoutMock).not.toHaveBeenCalled();
        expect(deleteWorkspaceCheckoutMock).not.toHaveBeenCalled();
        expect(deleteWorkspaceMock).not.toHaveBeenCalled();
        expect(detachWorkspaceLocationMock).not.toHaveBeenCalled();
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

        machineSpawnNewSessionMock.mockImplementationOnce(async () => ({
            type: 'error',
            errorCode: 'unexpected',
            errorMessage: 'spawn failed',
        } as any));

        const params = {
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
                ...settingsDefaults,
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
            sessionPrompt: '',
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

        expect(saveWorkspaceMock).not.toHaveBeenCalled();
        expect(saveWorkspaceLocationMock).not.toHaveBeenCalled();
        expect(saveWorkspaceCheckoutMock).not.toHaveBeenCalled();
        expect(machineSpawnNewSessionMock.mock.calls[0]?.[0]).not.toHaveProperty('workspaceId');
        expect(machineSpawnNewSessionMock.mock.calls[0]?.[0]).not.toHaveProperty('workspaceLocationId');
        expect(machineSpawnNewSessionMock.mock.calls[0]?.[0]).not.toHaveProperty('workspaceCheckoutId');
        expect(deleteWorkspaceCheckoutMock).not.toHaveBeenCalled();
        expect(deleteWorkspaceMock).not.toHaveBeenCalled();
        expect(detachWorkspaceLocationMock).not.toHaveBeenCalled();
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
                ...settingsDefaults,
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
            sessionPrompt: '',
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

        expect(saveWorkspaceMock).not.toHaveBeenCalled();
        expect(saveWorkspaceLocationMock).not.toHaveBeenCalled();
        expect(saveWorkspaceCheckoutMock).not.toHaveBeenCalled();
        expect(machineSpawnNewSessionMock).toHaveBeenCalledTimes(1);
        expect(machineSpawnNewSessionMock.mock.calls[0]?.[0]).not.toHaveProperty('workspaceId');
        expect(machineSpawnNewSessionMock.mock.calls[0]?.[0]).not.toHaveProperty('workspaceLocationId');
        expect(machineSpawnNewSessionMock.mock.calls[0]?.[0]).not.toHaveProperty('workspaceCheckoutId');
        expect(deleteWorkspaceCheckoutMock).not.toHaveBeenCalled();
        expect(detachWorkspaceLocationMock).not.toHaveBeenCalled();
        expect(deleteWorkspaceMock).not.toHaveBeenCalled();
        expect(machineBashMock).not.toHaveBeenCalled();
    });

    it('rolls back the created worktree when spawn requests directory approval without workspace linkage', async () => {
        const { useCreateNewSession } = await import('./useCreateNewSession');
        const { Modal } = await import('@/modal');
        const typecheck = useCreateNewSession;

        machineSpawnNewSessionMock.mockImplementationOnce(async () => ({
            type: 'requestToApproveDirectoryCreation',
            directory: '/tmp/worktree',
        } as any));

        const params = {
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
                ...settingsDefaults,
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
            sessionPrompt: '',
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

        expect(saveWorkspaceCheckoutMock).not.toHaveBeenCalled();
        expect(deleteWorkspaceCheckoutMock).not.toHaveBeenCalled();
        expect(deleteWorkspaceMock).not.toHaveBeenCalled();
        expect(detachWorkspaceLocationMock).not.toHaveBeenCalled();
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

        machineSpawnNewSessionMock.mockImplementationOnce(async () => ({
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
                ...settingsDefaults,
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
            sessionPrompt: '',
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

        expect(deleteWorkspaceMock).not.toHaveBeenCalled();
        expect(deleteWorkspaceCheckoutMock).not.toHaveBeenCalled();
        expect(vi.mocked(Modal.alert)).toHaveBeenCalledWith('common.error', expect.stringContaining('cleanup failed'));
    });

    it('ignores workspace-location persistence failures during repo-native worktree launches because no location attach is attempted', async () => {
        const { useCreateNewSession } = await import('./useCreateNewSession');
        const typecheck = useCreateNewSession;
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        saveWorkspaceLocationMock.mockRejectedValueOnce(new Error('attach failed'));

        const params = {
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
                ...settingsDefaults,
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
            sessionPrompt: '',
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

        expect(machineSpawnNewSessionMock).toHaveBeenCalledTimes(1);
        expect(saveWorkspaceLocationMock).not.toHaveBeenCalled();
        expect(deleteWorkspaceMock).not.toHaveBeenCalled();
        expect(detachWorkspaceLocationMock).not.toHaveBeenCalled();
        expect(machineBashMock).not.toHaveBeenCalled();
        expect(consoleErrorSpy).not.toHaveBeenCalledWith('Failed to start session', expect.anything());
        expect(captureExceptionIfEnabledMock).not.toHaveBeenCalledWith(
            expect.objectContaining({ message: 'attach failed' }),
            expect.anything(),
        );

        consoleErrorSpy.mockRestore();
    });

    it('rolls back the created worktree when session spawn throws without workspace linkage', async () => {
        const { useCreateNewSession } = await import('./useCreateNewSession');
        const { Modal } = await import('@/modal');
        const typecheck = useCreateNewSession;
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        machineSpawnNewSessionMock.mockRejectedValueOnce(new Error('spawn exploded'));

        const params = {
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
                ...settingsDefaults,
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
            sessionPrompt: '',
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

        expect(deleteWorkspaceMock).not.toHaveBeenCalled();
        expect(deleteWorkspaceCheckoutMock).not.toHaveBeenCalled();
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

        const routerReplace = vi.fn();
        const disableDraftPersistence = vi.fn();
        const setIsCreating = vi.fn();
        const params = {
            router: { push: vi.fn(), replace: routerReplace },
            selectedMachineId: 'machine-1',
            selectedPath: '/repo',
            selectedMachine: { id: 'machine-1', metadata: {} },
            setIsCreating,
            setIsResumeSupportChecking: vi.fn(),
            settings: {
                ...settingsDefaults,
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
            sessionPrompt: '',
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

        expect(machineSpawnNewSessionMock).toHaveBeenCalledWith(expect.objectContaining({
            directory: '/repo',
            machineId: 'machine-1',
        }));
        const spawnedOptions = machineSpawnNewSessionMock.mock.calls.at(0)?.[0] as
            | {
                workspaceId?: string;
                workspaceLocationId?: string;
                workspaceCheckoutId?: string;
            }
            | undefined;
        expect(spawnedOptions?.workspaceId).toBeUndefined();
        expect(spawnedOptions?.workspaceLocationId).toBeUndefined();
        expect(spawnedOptions?.workspaceCheckoutId).toBeUndefined();
        expect(updateSessionDraftMock).not.toHaveBeenCalled();
        expect(ensureSessionVisibleForMessageRouteMock).toHaveBeenCalledWith('session-created', { forceRefresh: true });
        expect(routerReplace).not.toHaveBeenCalled();
        expect(disableDraftPersistence).not.toHaveBeenCalled();
        expect(clearNewSessionDraftMock).not.toHaveBeenCalled();
        expect(setIsCreating).toHaveBeenCalledWith(false);
        expect(vi.mocked(Modal.alert)).toHaveBeenCalledWith(
            'common.error',
            expect.stringContaining('Created session is not available locally yet'),
        );
    });

    it('recovers the created-session draft and opens the hydrated session when afterCreated fails', async () => {
        const { useCreateNewSession } = await import('./useCreateNewSession');
        const { Modal } = await import('@/modal');

        storedSessionsState.sessions = {};
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
            router: { push: vi.fn(), replace: routerReplace },
            selectedMachineId: 'machine-1',
            selectedPath: '/repo',
            selectedMachine: { id: 'machine-1', metadata: {} },
            setIsCreating: vi.fn(),
            setIsResumeSupportChecking: vi.fn(),
            settings: settingsDefaults,
            useProfiles: false,
            selectedProfileId: null,
            profileMap: new Map(),
            recentMachinePaths: [],
            agentType: 'codex' as const,
            permissionMode: 'default' as const,
            modelMode: 'auto' as const,
            sessionPrompt: 'Recover this first message',
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

        expect(updateSessionDraftMock).toHaveBeenCalledWith('session-created', 'Recover this first message');
        expect(storeTempDataMock).toHaveBeenCalledWith({
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
        });
        expect(disableDraftPersistence).toHaveBeenCalledTimes(1);
        expect(clearNewSessionDraftMock).toHaveBeenCalledTimes(1);
        expect(routerReplace).toHaveBeenCalledWith('/session/session-created?recoveryDataId=temp-recovery-1', expect.anything());
        expect(vi.mocked(Modal.alert)).toHaveBeenCalledWith('common.error', 'afterCreated failed');
    });

    it('preserves the recoverable created-session payload when afterCreated fails before the created session hydrates locally', async () => {
        const { useCreateNewSession } = await import('./useCreateNewSession');
        const { readRecoverableFollowUpPayload } = await import('@/sync/runtime/orchestration/serverScopedRpc/followUpSpawnedSession');
        const { Modal } = await import('@/modal');

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
            router: { push: vi.fn(), replace: routerReplace },
            selectedMachineId: 'machine-1',
            selectedPath: '/repo',
            selectedMachine: { id: 'machine-1', metadata: {} },
            setIsCreating: vi.fn(),
            setIsResumeSupportChecking: vi.fn(),
            settings: settingsDefaults,
            useProfiles: false,
            selectedProfileId: null,
            profileMap: new Map(),
            recentMachinePaths: [],
            agentType: 'codex' as const,
            permissionMode: 'default' as const,
            modelMode: 'auto' as const,
            sessionPrompt: 'Investigate this bug',
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

        expect(saveSessionDraftsMock).toHaveBeenCalledWith({
            'session-created': 'Investigate this bug\n\n[attachments block]',
        });
        expect(saveNewSessionDraftMock).not.toHaveBeenCalled();
        expect(updateSessionDraftMock).not.toHaveBeenCalled();
        expect(disableDraftPersistence).not.toHaveBeenCalled();
        expect(clearNewSessionDraftMock).not.toHaveBeenCalled();
        expect(routerReplace).not.toHaveBeenCalled();
        expect(vi.mocked(Modal.alert)).toHaveBeenCalledWith('common.error', 'Created session is not available locally yet');
    });
});
