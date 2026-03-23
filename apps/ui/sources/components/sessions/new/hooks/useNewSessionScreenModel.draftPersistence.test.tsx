import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlushHookEffectsOptions } from '@/dev/testkit';
import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { renderScreen } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit';
import { settingsDefaults } from '@/sync/domains/settings/settings';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type TestWorkspace = {
    id: string;
    displayName: string;
    locationIds: string[];
    checkoutIds: string[];
    defaultLocationId: string | null;
    defaultCheckoutId: string | null;
};

type TestWorkspaceLocation = {
    id: string;
    workspaceId: string;
    machineId: string;
    path: string;
    detectedScm: {
        provider: string;
        rootPath: string;
    };
    capabilities: {
        syncEligible: boolean;
        scmDetected: boolean;
        checkoutProviderKinds: string[];
    };
};

type TestWorkspaceCheckout = {
    id: string;
    workspaceId: string;
    workspaceLocationId: string;
    kind: string;
    path: string;
    displayName: string;
    status: string;
    syncPolicy: string;
    scm: {
        git: {
            branch: string;
            isMainWorktree: boolean;
            mainRepoPath: string;
        };
    };
};

const persistedDraft = vi.hoisted(() => ({
    input: 'hello',
    selectedMachineId: 'machine-2',
    selectedPath: '/repo/custom',
    selectedProfileId: null,
    selectedSecretId: null,
    mcpSelection: {
        v: 1,
        managedServersEnabled: false,
        forceIncludeServerIds: ['server-portable'],
        forceExcludeServerIds: ['server-disabled'],
    },
    selectedWorkspaceId: 'ws_payments',
    selectedWorkspaceLocationId: 'loc_local',
    selectedWorkspaceCheckoutId: 'checkout_feature_auth',
    checkoutCreationDraft: {
        kind: 'git_worktree',
        displayName: 'feature/auth',
        baseRef: 'main',
    } as { kind: 'git_worktree'; displayName: string; baseRef: string } | null,
    agentType: 'claude',
    permissionMode: 'yolo',
    modelMode: 'default',
    acpSessionModeId: 'plan',
    sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 123,
        overrides: {
            speed: { updatedAt: 123, value: 'fast' },
        },
    },
    automationDraft: {
        enabled: false,
        name: '',
        description: '',
        scheduleKind: 'interval' as const,
        everyMinutes: 60,
        cronExpr: '0 * * * *',
        timezone: null,
    } as {
        enabled: boolean;
        name: string;
        description: string;
        scheduleKind: 'interval' | 'cron';
        everyMinutes: number;
        cronExpr: string;
        timezone: string | null;
    },
    updatedAt: 123,
}) as {
    input: string;
    selectedMachineId: string;
    selectedPath: string;
    selectedProfileId: null;
    selectedSecretId: null;
    mcpSelection: {
        v: number;
        managedServersEnabled: boolean;
        forceIncludeServerIds: string[];
        forceExcludeServerIds: string[];
    };
    selectedWorkspaceId: string;
    selectedWorkspaceLocationId: string;
    selectedWorkspaceCheckoutId: string;
    checkoutCreationDraft: { kind: 'git_worktree'; displayName: string; baseRef: string } | null;
    agentType: string;
    permissionMode: string;
    modelMode: string;
    acpSessionModeId: string;
    sessionConfigOptionOverrides: {
        v: number;
        updatedAt: number;
        overrides: Record<string, { updatedAt: number; value: string }>;
    };
    automationDraft: {
        enabled: boolean;
        name: string;
        description: string;
        scheduleKind: 'interval' | 'cron';
        everyMinutes: number;
        cronExpr: string;
        timezone: string | null;
    };
    updatedAt: number;
    backendTarget?: { kind: 'builtInAgent'; agentId: string };
    resumeSessionId?: string | null;
});
const saveNewSessionDraftMock = vi.hoisted(() => vi.fn());
const clearNewSessionDraftMock = vi.hoisted(() => vi.fn());
const loadNewSessionDraftMock = vi.hoisted(() => vi.fn(() => JSON.parse(JSON.stringify(persistedDraft))));
const platformOsState = vi.hoisted(() => ({
    value: 'web' as 'web' | 'ios' | 'android',
}));
const modalShowMock = vi.hoisted(() => vi.fn());
const modalAlertMock = vi.hoisted(() => vi.fn());
const fireAndForgetState = vi.hoisted(() => ({
    promises: [] as Promise<unknown>[],
}));
const tryShowDaemonUnavailableAlertForRpcErrorMock = vi.hoisted(() => vi.fn((_args: unknown) => false));
const routerPushMock = vi.hoisted(() => vi.fn());
const routerSetParamsMock = vi.hoisted(() => vi.fn());
const featureFlags = vi.hoisted(() => ({
    mcpServersEnabled: false,
    automationsEnabled: false,
}));
const persistDraftNowRef = vi.hoisted(() => ({
    current: null as null | (() => void),
}));
const useCreateNewSessionArgsRef = vi.hoisted(() => ({
    current: null as null | Record<string, unknown>,
}));
const focusEffectRef = vi.hoisted(() => ({
    current: [] as Array<() => void | (() => void)>,
}));
const searchParamsState = vi.hoisted(() => ({
    value: {} as Record<string, unknown>,
}));
const tempSessionDataState = vi.hoisted(() => ({
    value: null as null | Record<string, unknown>,
}));
const machineMcpServersPreviewMock = vi.hoisted(() => vi.fn(async (_machineId: string, _request: unknown, _options?: unknown) => ({
    ok: true,
    builtIn: [{
        key: 'built-in:happier',
        name: 'happier',
        title: 'Happier',
        transport: 'stdio',
        authMode: 'none',
        selected: true,
        selectable: false,
        availability: 'active',
        sourceKind: 'builtIn',
        scopeKind: 'builtIn',
    }],
    managed: [{
        key: 'managed:playwright',
        serverId: 'server-portable',
        name: 'playwright',
        title: 'Playwright',
        transport: 'stdio',
        authMode: 'none',
        selected: true,
        selectable: true,
        availability: 'active',
        sourceKind: 'managed',
        scopeKind: 'allMachines',
        reasonCode: 'forced_included',
        portability: 'portable',
        defaultSelected: false,
    }],
    detected: [],
})));
const workspaceGraphState = vi.hoisted(() => ({
    workspacesByServerId: {
        'server-a': [
            {
                id: 'ws_payments',
                displayName: 'Payments',
                locationIds: ['loc_local'],
                checkoutIds: ['checkout_feature_auth'],
                defaultLocationId: 'loc_local',
                defaultCheckoutId: 'checkout_feature_auth',
            },
        ],
        'server-b': [],
    } as Record<string, TestWorkspace[]>,
    workspaceLocations: {
        loc_local: {
            id: 'loc_local',
            workspaceId: 'ws_payments',
            machineId: 'machine-2',
            path: '/repo/custom',
            detectedScm: {
                provider: 'git',
                rootPath: '/repo/custom',
            },
            capabilities: {
                syncEligible: true,
                scmDetected: true,
                checkoutProviderKinds: ['git_worktree'],
            },
        },
    } as Record<string, TestWorkspaceLocation>,
    workspaceCheckouts: {
        checkout_feature_auth: {
            id: 'checkout_feature_auth',
            workspaceId: 'ws_payments',
            workspaceLocationId: 'loc_local',
            kind: 'primary',
            path: '/repo/custom',
            displayName: 'main',
            status: 'ready',
            syncPolicy: 'inherit',
            scm: {
                git: {
                    branch: 'main',
                    isMainWorktree: true,
                    mainRepoPath: '/repo/custom',
                },
            },
        },
    } as Record<string, TestWorkspaceCheckout>,
}));
const repoSnapshotState = vi.hoisted(() => ({
    value: {
        projectKey: 'machine-2:/repo/custom',
        fetchedAt: 123,
        repo: {
            isRepo: true,
            rootPath: '/repo/custom',
            backendId: 'git',
            mode: '.git',
            worktrees: [
                { path: '/repo/custom', branch: 'main', isCurrent: true },
            ],
        },
        capabilities: {
            readStatus: true,
            readDiffFile: true,
            readDiffCommit: true,
            readLog: true,
            writeInclude: true,
            writeExclude: true,
            writeCommit: true,
            writeCommitPathSelection: true,
            writeCommitLineSelection: true,
            writeBackout: true,
            writeRemoteFetch: true,
            writeRemotePull: true,
            writeRemotePush: true,
            writeRemotePublish: true,
            readBranches: true,
            writeBranchCreate: true,
            writeBranchCheckout: true,
            readStash: true,
            writeStash: true,
            worktreeCreate: true,
            changeSetModel: 'index' as const,
            supportedDiffAreas: ['included', 'pending', 'both'] as const,
        },
        branch: { head: 'main', upstream: 'origin/main', ahead: 0, behind: 0, detached: false },
        stashCount: 0,
        hasConflicts: false,
        entries: [],
        totals: {
            includedFiles: 0,
            pendingFiles: 0,
            untrackedFiles: 0,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 0,
            pendingRemoved: 0,
        },
    } as any,
}));
const fetchSnapshotForMachinePathMock = vi.hoisted(() => vi.fn(async () => repoSnapshotState.value));
const readCachedSnapshotForMachinePathMock = vi.hoisted(() => vi.fn(() => null));
const targetServerState = vi.hoisted(() => ({
    allowedTargetServerIds: [] as string[],
    targetServerId: null as string | null,
    targetServerName: null as string | null,
}));
const interactionQueueState = vi.hoisted(() => ({
    callbacks: [] as Array<() => void>,
}));
const storageSubscriptionState = vi.hoisted(() => ({
    listeners: new Set<() => void>(),
}));
const createSessionActionDraftMock = vi.hoisted(() => vi.fn());

function getMockStorageState() {
    return {
        settings: { ...settingsDefaults, ...settingsState },
        createSessionActionDraft: createSessionActionDraftMock,
        workspaceLocations: workspaceGraphState.workspaceLocations,
        workspaceCheckouts: workspaceGraphState.workspaceCheckouts,
    };
}

function notifyMockStorageSubscribers() {
    for (const listener of Array.from(storageSubscriptionState.listeners)) {
        listener();
    }
}

const settingsState = {
    ...settingsDefaults,
    recentMachinePaths: [] as Array<{ machineId: string; path: string }>,
    lastUsedAgent: 'codex',
    lastUsedProfile: null as string | null,
    lastUsedPermissionMode: 'default',
    useEnhancedSessionWizard: false,
    useProfiles: false,
    sessionDefaultPermissionModeByTargetKey: {},
    actionsSettingsV1: {},
    experiments: false,
    featureToggles: {},
    dismissedCLIWarnings: settingsDefaults.dismissedCLIWarnings,
    sessionUseTmux: false,
    sessionTmuxByMachineId: {},
    favoriteDirectories: [],
    favoriteMachines: [],
    favoriteProfiles: [],
    profiles: [] as any[],
    secrets: [],
    secretBindingsByProfileId: {},
    serverSelectionGroups: [],
    serverSelectionActiveTargetKind: null,
    serverSelectionActiveTargetId: null,
    acpCatalogSettingsV1: {
        v: 2 as const,
        backends: [],
    },
};

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                                            Platform: {
                                                                get OS() {
                                                                            return platformOsState.value;
                                                                        },
                                                                select: (options: any) => options?.[platformOsState.value] ?? options?.default ?? options?.ios ?? options?.android,
                                                            },
                                                            View: 'View',
                                                            Text: 'Text',
                                                            Pressable: 'Pressable',
                                                            Dimensions: {
                                                                get: () => ({ width: 900, height: 800 }),
                                                            },
                                                            InteractionManager: {
                                                                runAfterInteractions: (fn: () => void) => {
                                                                    interactionQueueState.callbacks.push(fn);
                                                                    return {
                                                                        cancel: () => {
                                                                            interactionQueueState.callbacks = interactionQueueState.callbacks.filter((callback) => callback !== fn);
                                                                        },
                                                                    };
                                                                },
                                                            },
                                                            useWindowDimensions: () => ({ width: 900, height: 800 }),
                                                        }
    );
});

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/utils/platform/responsive', () => ({
    useHeaderHeight: () => 0,
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            dark: false,
            colors: {
                accent: { blue: '#00f' },
                input: { placeholder: '#999' },
                text: '#000',
                textSecondary: '#666',
                button: { primary: { background: '#00f', tint: '#fff' } },
                groupped: { sectionTitle: '#999', background: '#fff' },
                divider: '#ddd',
                surface: '#fff',
                surfaceHigh: '#f5f5f5',
                surfaceHighest: '#f0f0f0',
                surfaceSelected: '#eef4ff',
                surfacePressed: '#eee',
                surfacePressedOverlay: '#eee',
                modal: { border: '#ddd' },
                radio: { active: '#00f' },
                shadow: { color: '#000', opacity: 0.2 },
                textDestructive: '#c00',
            },
        },
        rt: { themeName: 'light' },
    });
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/sessions/agentInput/components/AgentInputChipPickerPopover', () => ({
    AgentInputChipPickerPopover: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('AgentInputChipPickerPopover', props, props.children),
}));

vi.mock('@/components/automations/editor/AutomationSettingsForm', () => ({
    AutomationSettingsForm: (props: Record<string, unknown>) => React.createElement('AutomationSettingsForm', props),
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const expoRouterMock = createExpoRouterMock({
        router: { push: routerPushMock, replace: vi.fn(), back: vi.fn(), setParams: routerSetParamsMock },
        params: () => searchParamsState.value as Record<string, string | string[] | undefined>,
        navigation: {},
        pathname: '/new',
    });
    return expoRouterMock.module;
});

vi.mock('@react-navigation/native', () => ({
    useFocusEffect: (fn: any) => {
        focusEffectRef.current.push(fn);
    },
}));

vi.mock('@/sync/domains/state/persistence', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        loadNewSessionDraft: () => loadNewSessionDraftMock(),
        saveNewSessionDraft: (draft: unknown) => saveNewSessionDraftMock(draft),
        clearNewSessionDraft: () => clearNewSessionDraftMock(),
    };
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    useAllMachines: () => ([
        createMachineFixture({ id: 'machine-1', metadata: { displayName: 'Machine One', host: 'one', homeDir: '/home/one' } as any }),
        createMachineFixture({ id: 'machine-2', metadata: { displayName: 'Machine Two', host: 'two', homeDir: '/home/two' } as any }),
    ]),
    useMachineListByServerId: () => ({}),
    useMachineListStatusByServerId: () => ({}),
    storage: Object.assign((selector: (state: ReturnType<typeof getMockStorageState>) => unknown) => React.useSyncExternalStore(
        (listener: () => void) => {
            storageSubscriptionState.listeners.add(listener);
            return () => {
                storageSubscriptionState.listeners.delete(listener);
            };
        },
        () => selector(getMockStorageState()),
        () => selector(getMockStorageState()),
    ), {
        getState: () => getMockStorageState(),
    }) as unknown as typeof import('@/sync/domains/state/storage').storage,
    useSetting: (key: string) => ({ ...settingsDefaults, ...settingsState } as any)[key],
    useSettingMutable: (key: string) => [(settingsState as any)[key], vi.fn()],
    useSettings: () => ({ ...settingsDefaults, ...settingsState }) as unknown as import('@/sync/domains/settings/settings').Settings,
});
});

vi.mock('@/scm/scmRepositoryService', () => ({
    scmRepositoryService: {
        readCachedSnapshotForMachinePath: readCachedSnapshotForMachinePathMock,
        fetchSnapshotForMachinePath: fetchSnapshotForMachinePathMock,
    },
}));

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => ['codex', 'claude'],
}));

vi.mock('@/agents/catalog/catalog', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        DEFAULT_AGENT_ID: 'codex',
        isAgentId: (value: unknown) => value === 'codex' || value === 'claude',
        resolveAgentIdFromCliDetectKey: () => 'codex',
        getAgentCore: (_agentId: string) => ({
            model: { defaultMode: 'default', allowedModes: ['default', 'gpt-5'], supportsFreeform: true },
            resume: { supportsVendorResume: false, experimental: false },
            sessionStorage: { direct: true, persisted: true },
            cli: { detectKey: String(_agentId) },
        }),
        buildResumeCapabilityOptionsFromUiState: ({ settings }: any) => ({ accountSettings: settings }),
        getAgentResumeExperimentsFromSettings: () => ({}),
        buildNewSessionOptionsFromUiState: () => ({}),
        getNewSessionAgentInputExtraActionChips: () => [],
        getNewSessionRelevantInstallableDepKeys: () => [],
    };
});

vi.mock('@/sync/domains/permissions/permissionDefaults', () => ({
    readAccountPermissionDefaults: () => ({}),
    resolveNewSessionDefaultPermissionMode: () => 'default',
}));

vi.mock('@/sync/domains/profiles/profileCompatibility', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        isProfileCompatibleWithBackendTarget: (profile: any, target: any) => {
            const targetKey = target?.kind === 'configuredAcpBackend'
                ? `acpBackend:${String(target.backendId ?? '')}`
                : `agent:${String(target?.agentId ?? '')}`;
            const explicitCompatibility = profile?.compatibilityByTargetKey?.[targetKey];
            if (typeof explicitCompatibility === 'boolean') {
                return explicitCompatibility;
            }
            const legacyCompatibility = target?.kind === 'builtInAgent'
                ? profile?.compatibility?.[String(target.agentId ?? '')]
                : undefined;
            if (typeof legacyCompatibility === 'boolean') {
                return legacyCompatibility;
            }
            return profile?.isBuiltIn === true;
        },
    };
});

vi.mock('@/sync/domains/permissions/permissionModeOptions', () => ({
    normalizePermissionModeForAgentType: (mode: string) => mode,
}));

vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (promise: Promise<unknown> | null | undefined) => {
        if (promise) {
            fireAndForgetState.promises.push(promise);
            void promise.catch(() => {});
        }
    },
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        applySettings: () => {},
        refreshMachinesThrottled: async () => {},
        encryptSecretValue: (v: string) => v,
    },
}));

vi.mock('@/sync/store/settingsWriters', () => ({
    useApplySettings: () => vi.fn(),
}));

vi.mock('@/utils/sessions/recentPaths', () => ({
    getRecentPathsForMachine: () => [],
}));

vi.mock('@/hooks/auth/useCLIDetection', () => ({
    useCLIDetection: () => ({ available: { codex: true, claude: true } }),
}));

vi.mock('@/hooks/machine/useMachineEnvPresence', () => ({
    useMachineEnvPresence: () => ({ isPreviewEnvSupported: true, isLoading: false, meta: {}, refresh: vi.fn() }),
}));

vi.mock('@/hooks/server/useMachineCapabilitiesCache', () => ({
    useMachineCapabilitiesCache: () => ({ state: { status: 'idle' } }),
    prefetchMachineCapabilities: async () => {},
    prefetchMachineCapabilitiesIfStale: async () => {},
    getMachineCapabilitiesSnapshot: () => null,
}));

vi.mock('@/components/sessions/new/hooks/useNewSessionCapabilitiesPrefetch', () => ({
    useNewSessionCapabilitiesPrefetch: () => {},
}));

vi.mock('@/components/sessions/new/hooks/useNewSessionDraftAutoPersist', () => ({
    useNewSessionDraftAutoPersist: ({ persistDraftNow }: { persistDraftNow: () => void }) => {
        persistDraftNowRef.current = persistDraftNow;
    },
}));

vi.mock('@/components/sessions/new/hooks/useCreateNewSession', () => ({
    useCreateNewSession: (args: Record<string, unknown>) => {
        useCreateNewSessionArgsRef.current = args;
        return {
        canCreate: true,
        connectionStatus: 'ok',
        handleCreateSession: vi.fn(),
        };
    },
}));

vi.mock('@/components/sessions/new/hooks/useNewSessionWizardProps', () => ({
    useNewSessionWizardProps: (params: any) => ({
        layout: {},
        profiles: {
            selectedProfileId: params.selectedProfileId,
            getProfileSubtitleExtra: params.getProfileSubtitleExtra,
            onPressDefaultEnvironment: params.onPressDefaultEnvironment,
            onPressProfile: params.onPressProfile,
            handleAddProfile: params.handleAddProfile,
            openProfileEdit: params.openProfileEdit,
            handleDuplicateProfile: params.handleDuplicateProfile,
        },
        agent: {},
        machine: {},
        footer: {},
    }),
}));

vi.mock('@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState', () => ({
    useNewSessionPreflightModelsState: () => ({ preflightModels: null, modelOptions: [], probe: { phase: 'idle', refresh: vi.fn() } }),
}));

vi.mock('@/components/sessions/new/hooks/screenModel/useNewSessionPreflightSessionModesState', () => ({
    useNewSessionPreflightSessionModesState: () => ({ preflightModes: null, modeOptions: [], probe: { phase: 'idle', refresh: vi.fn() } }),
}));

vi.mock('@/components/sessions/new/modules/canCreateNewSession', () => ({
    canCreateNewSession: () => true,
}));

vi.mock('@/components/sessions/new/modules/resolveNewSessionCapabilityServerId', () => ({
    resolveNewSessionCapabilityServerId: () => null,
}));

vi.mock('@/components/sessions/new/hooks/serverTarget/useNewSessionServerTargetState', () => ({
    useNewSessionServerTargetState: () => ({
        serverProfiles: [],
        serverTargets: [],
        resolvedSettingsTarget: { allowedServerIds: [] },
        allowedTargetServerIds: targetServerState.allowedTargetServerIds,
        targetServerId: targetServerState.targetServerId,
        targetServerProfile: null,
        targetServerName: targetServerState.targetServerName,
        showServerPickerChip: targetServerState.allowedTargetServerIds.length > 1 && !!targetServerState.targetServerName,
    }),
}));

vi.mock('@/hooks/server/useAutomationsSupport', () => ({
    useAutomationsSupport: () => ({ enabled: featureFlags.automationsEnabled }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => {
        if (featureId === 'mcp.servers') return featureFlags.mcpServersEnabled;
        return false;
    },
}));

vi.mock('@/sync/ops/machineMcpServers', () => ({
    machineMcpServersPreview: (...args: [string, unknown, unknown?]) => machineMcpServersPreviewMock(...args),
}));

vi.mock('@/components/sessions/new/modules/automationFeatureGate', () => ({
    resolveEffectiveAutomationDraft: ({ draft }: any) => draft,
    shouldShowAutomationActionChips: () => false,
}));

vi.mock('@/components/sessions/new/modules/useNewSessionConnectedServices', () => ({
    useNewSessionConnectedServices: () => ({ connectedServicesAuthChip: null }),
}));

vi.mock('@/utils/sessions/machineUtils', () => ({
    isMachineOnline: () => true,
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            show: modalShowMock,
            alert: modalAlertMock,
        },
    }).module;
});

vi.mock('@/utils/errors/daemonUnavailableAlert', () => ({
    tryShowDaemonUnavailableAlertForRpcError: (args: unknown) => tryShowDaemonUnavailableAlertForRpcErrorMock(args),
}));

vi.mock('@/components/sessions/new/hooks/useSecretRequirementFlow', () => ({
    useSecretRequirementFlow: () => ({ openSecretRequirementModal: vi.fn() }),
}));

vi.mock('@/components/sessions/new/modules/profileHelpers', () => ({
    useProfileMap: (profiles: Array<{ id: string }>) => new Map(profiles.map((profile) => [profile.id, profile])),
    transformProfileToEnvironmentVars: () => [],
}));

vi.mock('@/components/sessions/new/hooks/newSessionModelModePolicy', () => ({
    resolveInitialNewSessionModelMode: () => 'default',
    coerceNewSessionModelMode: ({ modelMode }: any) => modelMode,
}));

vi.mock('@/sync/domains/settings/settings', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        // Ensure non-enumerable exports used by persistence helpers are available on the mock.
        settingsDefaults: actual.settingsDefaults,
        isProfileCompatibleWithAnyAgent: () => true,
    };
});

vi.mock('@/sync/domains/profiles/profileCompatibility', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        getProfileEnvironmentVariables: () => [],
        isProfileCompatibleWithAgent: () => true,
    };
});

vi.mock('@/sync/domains/profiles/profileUtils', () => ({
    getBuiltInProfile: () => null,
    DEFAULT_PROFILES: [],
    getProfilePrimaryCli: () => null,
    getProfileSupportedAgentIds: () => [],
    isProfileCompatibleWithAnyAgent: () => true,
}));

vi.mock('@/agents/runtime/cliWarnings', () => ({
    applyCliWarningDismissal: () => ({}),
    isCliWarningDismissed: () => false,
}));

vi.mock('@/utils/secrets/secretSatisfaction', () => ({
    getSecretSatisfaction: () => ({ missingRequired: [], missingOptional: [] }),
}));

vi.mock('@/hooks/ui/useKeyboardHeight', () => ({
    useKeyboardHeight: () => 0,
}));

vi.mock('@/components/sessions/agentInput/inputMaxHeight', () => ({
    computeNewSessionInputMaxHeight: () => 100,
}));

vi.mock('@/components/sessions/new/newSessionScreenStyles', () => ({
    newSessionScreenStyles: {},
}));

vi.mock('@/components/sessions/new/modules/automationChipModel', () => ({
    getAutomationChipLabel: () => 'Automation',
}));

vi.mock('@/components/sessions/agentInput/sessionActions/listAgentInputActionChipActionIds', () => ({
    listAgentInputActionChipActionIds: () => [],
}));

vi.mock('@happier-dev/protocol', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        getActionSpec: () => ({ title: 'Action' }),
    };
});

vi.mock('@/sync/domains/actions/buildActionDraftInput', () => ({
    buildActionDraftInput: () => ({}),
}));

vi.mock('@happier-dev/agents', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        AGENTS_CORE: actual.AGENTS_CORE ?? {},
    };
});

vi.mock('@/utils/sessions/tempDataStore', () => ({
    getTempData: () => tempSessionDataState.value,
}));

const useNewSessionScreenModelModulePromise = import('./useNewSessionScreenModel');

async function runFocusEffects(): Promise<Array<void | (() => void)>> {
    return await Promise.all(focusEffectRef.current.map((effect) => effect()));
}

describe('useNewSessionScreenModel (draft hydration)', () => {
    afterEach(() => {
        standardCleanup();
    });

    beforeEach(() => {
        platformOsState.value = 'web';
        modalShowMock.mockReset();
        modalAlertMock.mockReset();
        fireAndForgetState.promises = [];
        tryShowDaemonUnavailableAlertForRpcErrorMock.mockReset();
        tryShowDaemonUnavailableAlertForRpcErrorMock.mockReturnValue(false);
        interactionQueueState.callbacks = [];
        focusEffectRef.current = [];
        routerPushMock.mockClear();
        routerSetParamsMock.mockClear();
        featureFlags.mcpServersEnabled = false;
        featureFlags.automationsEnabled = false;
        persistDraftNowRef.current = null;
        saveNewSessionDraftMock.mockClear();
        clearNewSessionDraftMock.mockClear();
        loadNewSessionDraftMock.mockClear();
        readCachedSnapshotForMachinePathMock.mockReset();
        readCachedSnapshotForMachinePathMock.mockReturnValue(null);
        fetchSnapshotForMachinePathMock.mockReset();
        fetchSnapshotForMachinePathMock.mockImplementation(async () => repoSnapshotState.value);
        machineMcpServersPreviewMock.mockClear();
        searchParamsState.value = {};
        tempSessionDataState.value = null;
        targetServerState.allowedTargetServerIds = [];
        targetServerState.targetServerId = null;
        targetServerState.targetServerName = null;
        delete (persistedDraft as any).backendTarget;
        delete (persistedDraft as any).codexBackendMode;
        persistedDraft.agentType = 'claude';
        persistedDraft.input = 'hello';
        persistedDraft.permissionMode = 'yolo';
        delete persistedDraft.resumeSessionId;
        persistedDraft.selectedMachineId = 'machine-2';
        persistedDraft.selectedPath = '/repo/custom';
        persistedDraft.updatedAt = 123;
        persistedDraft.automationDraft = {
            enabled: false,
            name: '',
            description: '',
            scheduleKind: 'interval',
            everyMinutes: 60,
            cronExpr: '0 * * * *',
            timezone: null,
        };
        persistedDraft.checkoutCreationDraft = {
            kind: 'git_worktree',
            displayName: 'feature/auth',
            baseRef: 'main',
        };
        settingsState.acpCatalogSettingsV1 = {
            v: 2,
            backends: [],
        };
        settingsState.useEnhancedSessionWizard = false;
        settingsState.useProfiles = false;
        settingsState.lastUsedProfile = null;
        settingsState.profiles = [];
        workspaceGraphState.workspacesByServerId = {
            'server-a': [
                {
                    id: 'ws_payments',
                    displayName: 'Payments',
                    locationIds: ['loc_local'],
                    checkoutIds: ['checkout_feature_auth'],
                    defaultLocationId: 'loc_local',
                    defaultCheckoutId: 'checkout_feature_auth',
                },
            ],
            'server-b': [],
        };
        workspaceGraphState.workspaceLocations = {
            loc_local: {
                id: 'loc_local',
                workspaceId: 'ws_payments',
                machineId: 'machine-2',
                path: '/repo/custom',
                detectedScm: {
                    provider: 'git',
                    rootPath: '/repo/custom',
                },
                capabilities: {
                    syncEligible: true,
                    scmDetected: true,
                    checkoutProviderKinds: ['git_worktree'],
                },
            },
        };
        workspaceGraphState.workspaceCheckouts = {
            checkout_feature_auth: {
                id: 'checkout_feature_auth',
                workspaceId: 'ws_payments',
                workspaceLocationId: 'loc_local',
                kind: 'primary',
                path: '/repo/custom',
                displayName: 'main',
                status: 'ready',
                syncPolicy: 'inherit',
                scm: {
                    git: {
                        branch: 'main',
                        isMainWorktree: true,
                        mainRepoPath: '/repo/custom',
                    },
                },
            },
        };
        repoSnapshotState.value = {
            projectKey: 'machine-2:/repo/custom',
            fetchedAt: 123,
            repo: {
                isRepo: true,
                rootPath: '/repo/custom',
                backendId: 'git',
                mode: '.git',
                worktrees: [
                    { path: '/repo/custom', branch: 'main', isCurrent: true },
                ],
            },
            capabilities: {
                readStatus: true,
                readDiffFile: true,
                readDiffCommit: true,
                readLog: true,
                writeInclude: true,
                writeExclude: true,
                writeCommit: true,
                writeCommitPathSelection: true,
                writeCommitLineSelection: true,
                writeBackout: true,
                writeRemoteFetch: true,
                writeRemotePull: true,
                writeRemotePush: true,
                writeRemotePublish: true,
                readBranches: true,
                writeBranchCreate: true,
                writeBranchCheckout: true,
                readStash: true,
                writeStash: true,
                worktreeCreate: true,
                changeSetModel: 'index' as const,
                supportedDiffAreas: ['included', 'pending', 'both'] as const,
            },
            branch: { head: 'main', upstream: 'origin/main', ahead: 0, behind: 0, detached: false },
            stashCount: 0,
            hasConflicts: false,
            entries: [],
            totals: {
                includedFiles: 0,
                pendingFiles: 0,
                untrackedFiles: 0,
                includedAdded: 0,
                includedRemoved: 0,
                pendingAdded: 0,
                pendingRemoved: 0,
            },
        } as any;
        storageSubscriptionState.listeners.clear();
        createSessionActionDraftMock.mockClear();
    });

    function getCheckoutChipLabel(model: any): React.ReactNode {
        const checkoutChip = model?.simpleProps?.agentInputExtraActionChips?.find((chip: any) => chip?.key === 'new-session-checkout');
        const chipElement = checkoutChip?.render({
            chipStyle: () => null,
            showLabel: true,
            iconColor: '#000',
            textStyle: {},
            countTextStyle: {},
            popoverAnchorRef: { current: null },
        }) as React.ReactElement<{ children?: React.ReactNode }> | undefined;
        const chipPressable = React.Children.toArray(chipElement?.props?.children)[0] as React.ReactElement<{
            children?: React.ReactNode;
        }> | undefined;
        const renderedChildren = Array.isArray(chipPressable?.props?.children)
            ? (chipPressable.props.children as React.ReactElement[])
            : null;
        const renderedLabelNode = renderedChildren?.[1] as React.ReactElement<{ children?: React.ReactNode }> | undefined;
        return renderedLabelNode?.props?.children;
    }

    async function flushInteractionQueue() {
        while (interactionQueueState.callbacks.length > 0) {
            const callback = interactionQueueState.callbacks.shift();
            callback?.();
            await settleNewSessionScreenModel();
        }
    }

    async function settleNewSessionScreenModel(options: FlushHookEffectsOptions = {}) {
        await flushHookEffects({
            cycles: options.cycles ?? 3,
            turns: options.turns ?? 2,
            advanceTimersMs: options.advanceTimersMs,
            runAllTimers: options.runAllTimers,
            frames: options.frames,
        });
    }

    async function runFocusEffectsAndSettle() {
        let cleanups: Array<void | (() => void)> = [];

        await act(async () => {
            cleanups = await runFocusEffects();
        });
        await settleNewSessionScreenModel();

        return cleanups;
    }

    async function renderNewSessionScreenModel(assignModel: (nextModel: unknown) => void) {
        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        return renderHook(() => {
            const nextModel = useNewSessionScreenModel();
            assignModel(nextModel);
            return nextModel;
        }, {
            flushOptions: {
                cycles: 3,
                turns: 2,
            },
        });
    }

    it('hydrates permission, agent, and path from the persisted draft', async () => {
        let model: any = null;
        await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        expect(model?.variant).toBe('simple');
        expect(model?.simpleProps?.agentType).toBe('claude');
        expect(model?.simpleProps?.permissionMode).toBe('yolo');
        expect(model?.simpleProps?.acpSessionModeId).toBe('plan');
        expect(model?.simpleProps?.acpConfigOptionOverrides).toEqual({
            v: 1,
            updatedAt: 123,
            overrides: {
                speed: { updatedAt: 123, value: 'fast' },
            },
        });
        expect(model?.simpleProps?.machineName).toBe('Machine Two');
        expect(typeof model?.simpleProps?.machinePopover?.renderContent).toBe('function');
        expect(model?.simpleProps?.selectedPath).toBe('/repo/custom');
        expect(model?.simpleProps?.checkoutCreationDraft).toBeNull();
        expect(getCheckoutChipLabel(model)).toBe('newSession.checkout.noWorktree');

        await act(async () => {
            persistDraftNowRef.current?.();
        });

        expect(saveNewSessionDraftMock).toHaveBeenCalledWith(expect.objectContaining({
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 123,
                overrides: {
                    speed: { updatedAt: 123, value: 'fast' },
                },
            },
        }));
    });

    it('hydrates scoped worktree intent on first render when the target server is already resolved', async () => {
        targetServerState.allowedTargetServerIds = ['server-a', 'server-b'];
        targetServerState.targetServerId = 'server-b';
        targetServerState.targetServerName = 'Server B';
        persistedDraft.selectedWorkspaceId = 'ws_payments';
        persistedDraft.selectedWorkspaceLocationId = 'loc_local';
        persistedDraft.selectedWorkspaceCheckoutId = null as any;
        persistedDraft.checkoutCreationDraft = {
            kind: 'git_worktree',
            displayName: 'feature/first-render-fix',
            baseRef: 'main',
        };

        workspaceGraphState.workspacesByServerId['server-b'] = [{
            id: 'ws_payments',
            displayName: 'Payments',
            locationIds: ['loc_local'],
            checkoutIds: [],
            defaultLocationId: 'loc_local',
            defaultCheckoutId: null as any,
        } as TestWorkspace];

        let model: any = null;
        await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        expect(loadNewSessionDraftMock).toHaveBeenCalled();
        expect(model?.simpleProps?.selectedWorkspaceId).toBeUndefined();
        expect(model?.simpleProps?.selectedWorkspaceLocationId).toBeUndefined();
        expect(model?.simpleProps?.selectedWorkspaceCheckoutId).toBeUndefined();
        expect(model?.simpleProps?.checkoutCreationDraft).toBeNull();
        expect(getCheckoutChipLabel(model)).toBe('newSession.checkout.noWorktree');
        const getServerChip = () => model?.simpleProps?.agentInputExtraActionChips?.find((chip: any) => chip?.key === 'new-session-target-server');
        expect(getServerChip()?.controlId).toBe('server');
        expect(getServerChip()?.collapsedContentPopover).toEqual(expect.objectContaining({
            title: 'Server B',
            label: 'Server B',
        }));
    });

    it('infers linked workspace context on first render when the selected path already belongs to a workspace', async () => {
        persistedDraft.selectedWorkspaceId = null as any;
        persistedDraft.selectedWorkspaceLocationId = null as any;
        persistedDraft.selectedWorkspaceCheckoutId = null as any;
        persistedDraft.checkoutCreationDraft = null;

        let model: any = null;
        await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        expect(model?.simpleProps?.selectedWorkspaceId).toBeUndefined();
        expect(model?.simpleProps?.selectedWorkspaceLocationId).toBeUndefined();
        expect(model?.simpleProps?.selectedWorkspaceCheckoutId).toBeUndefined();
        expect(useCreateNewSessionArgsRef.current).toEqual(expect.objectContaining({
            authoringDraft: expect.objectContaining({
                checkoutCreationDraft: null,
            }),
        }));
    });

    it('rehydrates persisted codex backend mode into the shared authoring draft and autosave payload', async () => {
        persistedDraft.agentType = 'codex';
        persistedDraft.backendTarget = { kind: 'builtInAgent', agentId: 'codex' };
        (persistedDraft as any).codexBackendMode = 'appServer';

        let model: any = null;
        await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        expect(useCreateNewSessionArgsRef.current).toEqual(expect.objectContaining({
            codexBackendModeOverride: 'appServer',
            authoringDraft: expect.objectContaining({
                backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                codexBackendMode: 'appServer',
            }),
        }));

        await act(async () => {
            persistDraftNowRef.current?.();
        });

        expect(saveNewSessionDraftMock).toHaveBeenCalledWith(expect.objectContaining({
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            codexBackendMode: 'appServer',
        }));
    });

    it('exposes an automation submit accessibility label when automation is enabled in the draft', async () => {
        featureFlags.automationsEnabled = true;
        persistedDraft.automationDraft = {
            enabled: true,
            name: 'Daily summary',
            description: '',
            scheduleKind: 'interval',
            everyMinutes: 60,
            cronExpr: '0 * * * *',
            timezone: null,
        };
        let model: any = null;
        await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        expect(model?.simpleProps?.submitAccessibilityLabel).toBe('automations.create.createButtonTitle');
    });

    it('resets stale automation-only draft fields when the route explicitly starts a fresh automation create flow', async () => {
        featureFlags.automationsEnabled = true;
        persistedDraft.automationDraft = {
            enabled: true,
            name: 'Legacy automation',
            description: 'Carryover description',
            scheduleKind: 'interval',
            everyMinutes: 90,
            cronExpr: '0 * * * *',
            timezone: 'Europe/Zurich',
        };
        searchParamsState.value = {
            automation: '1',
        };
        let model: any = null;
        await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        expect(model?.simpleProps?.submitAccessibilityLabel).toBe('automations.create.createButtonTitle');
        await act(async () => {
            persistDraftNowRef.current?.();
        });

        expect(saveNewSessionDraftMock).toHaveBeenCalledWith(expect.objectContaining({
            automationDraft: expect.objectContaining({
                enabled: true,
                name: '',
                description: '',
                scheduleKind: 'interval',
                everyMinutes: 60,
                cronExpr: '0 * * * *',
                timezone: null,
            }),
        }));
    });

    it('drops stale in-memory automation mode when focus reloads a plain /new draft after automation create', async () => {
        featureFlags.automationsEnabled = true;
        persistedDraft.automationDraft = {
            enabled: false,
            name: '',
            description: '',
            scheduleKind: 'interval',
            everyMinutes: 60,
            cronExpr: '0 * * * *',
            timezone: null,
        };
        searchParamsState.value = {
            automation: '1',
        };
        let model: any = null;
        const hook = await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        expect(model?.simpleProps?.submitAccessibilityLabel).toBe('automations.create.createButtonTitle');

        searchParamsState.value = {};
        persistedDraft.automationDraft = {
            enabled: false,
            name: '',
            description: '',
            scheduleKind: 'interval',
            everyMinutes: 60,
            cronExpr: '0 * * * *',
            timezone: null,
        };
        persistedDraft.updatedAt = 456;

        await hook.rerender();
        const cleanups = await runFocusEffectsAndSettle();
        for (const cleanup of cleanups) {
            if (typeof cleanup === 'function') cleanup();
        }

        expect(model?.simpleProps?.submitAccessibilityLabel).toBeUndefined();
        expect(useCreateNewSessionArgsRef.current).toEqual(expect.objectContaining({
            authoringDraft: expect.objectContaining({
                automation: null,
            }),
        }));
    });

    it('does not rehydrate plain /new into automation mode after autosaving a forced automation route draft', async () => {
        featureFlags.automationsEnabled = true;
        persistedDraft.automationDraft = {
            enabled: false,
            name: '',
            description: '',
            scheduleKind: 'interval',
            everyMinutes: 60,
            cronExpr: '0 * * * *',
            timezone: null,
        };
        searchParamsState.value = {
            automation: '1',
        };

        let automationRouteModel: any = null;
        let plainRouteModel: any = null;
        const automationRouteHook = await renderNewSessionScreenModel((nextModel) => {
            automationRouteModel = nextModel;
        });

        expect(automationRouteModel?.simpleProps?.submitAccessibilityLabel).toBe('automations.create.createButtonTitle');

        await act(async () => {
            persistDraftNowRef.current?.();
        });

        const savedAutomationDraft = saveNewSessionDraftMock.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined;
        expect(savedAutomationDraft).toEqual(expect.objectContaining({
            automationDraft: expect.objectContaining({
                enabled: true,
            }),
            entryIntent: 'automation',
        }));

        persistedDraft.automationDraft = savedAutomationDraft?.automationDraft as any;
        (persistedDraft as any).entryIntent = savedAutomationDraft?.entryIntent;
        persistedDraft.updatedAt = Number(savedAutomationDraft?.updatedAt ?? 456);
        searchParamsState.value = {};

        await automationRouteHook.unmount();
        await renderNewSessionScreenModel((nextModel) => {
            plainRouteModel = nextModel;
        });

        expect(plainRouteModel?.simpleProps?.submitAccessibilityLabel).toBeUndefined();
        expect(useCreateNewSessionArgsRef.current).toEqual(expect.objectContaining({
            authoringDraft: expect.objectContaining({
                automation: null,
            }),
        }));
    });

    it('hydrates temp edit seed data and exposes save semantics for automation editing', async () => {
        settingsState.useProfiles = true;
        searchParamsState.value = {
            dataId: 'temp-edit-seed',
            automation: '1',
            automationEditId: 'auto-1',
        };
        tempSessionDataState.value = {
            prompt: 'Review the open pull requests',
            machineId: 'machine-1',
            path: '/repo/edit-seed',
            agentType: 'codex',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            codexBackendMode: 'appServer',
            transcriptStorage: 'direct',
            permissionMode: 'acceptEdits',
            automationDraft: {
                enabled: true,
                name: 'PR review',
                description: 'Nightly review',
                scheduleKind: 'interval',
                everyMinutes: 30,
                cronExpr: '0 * * * *',
                timezone: null,
            },
        };

        let model: any = null;
        await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        expect(model?.simpleProps?.agentType).toBe('codex');
        expect(model?.simpleProps?.selectedPath).toBe('/repo/edit-seed');
        expect(model?.simpleProps?.permissionMode).toBe('acceptEdits');
        expect(model?.simpleProps?.submitAccessibilityLabel).toBe('automations.edit.saveAutomationLabel');
        expect(useCreateNewSessionArgsRef.current).toEqual(expect.objectContaining({
            codexBackendModeOverride: 'appServer',
            authoringDraft: expect.objectContaining({
                directory: '/repo/edit-seed',
                backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                prompt: 'Review the open pull requests',
                displayText: 'Review the open pull requests',
                codexBackendMode: 'appServer',
            }),
        }));
        expect((useCreateNewSessionArgsRef.current?.authoringDraft as any)?.experimentalCodexAcp).toBeNull();

        await act(async () => {
            persistDraftNowRef.current?.();
        });

        expect(saveNewSessionDraftMock).toHaveBeenCalledWith(expect.objectContaining({
            input: 'Review the open pull requests',
            selectedMachineId: 'machine-1',
            selectedPath: '/repo/edit-seed',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            permissionMode: 'acceptEdits',
            automationDraft: expect.objectContaining({
                enabled: true,
                name: 'PR review',
                everyMinutes: 30,
            }),
        }));
    });

    it('re-hydrates the worktree checkout selection when a newer draft is loaded on focus', async () => {
        persistedDraft.selectedWorkspaceId = null as any;
        persistedDraft.selectedWorkspaceLocationId = null as any;
        persistedDraft.selectedWorkspaceCheckoutId = null as any;
        persistedDraft.checkoutCreationDraft = null;
        persistedDraft.updatedAt = 123;

        let model: any = null;
        await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        expect(getCheckoutChipLabel(model)).toBe('newSession.checkout.noWorktree');

        persistedDraft.selectedWorkspaceId = 'ws_payments';
        persistedDraft.selectedWorkspaceLocationId = 'loc_local';
        persistedDraft.selectedWorkspaceCheckoutId = null as any;
        persistedDraft.checkoutCreationDraft = {
            kind: 'git_worktree',
            displayName: 'feature/focused-browser-fix',
            baseRef: 'main',
        };
        persistedDraft.updatedAt = 456;

        const cleanups = await runFocusEffectsAndSettle();
        for (const cleanup of cleanups) {
            if (typeof cleanup === 'function') cleanup();
        }

        expect(model?.simpleProps?.selectedWorkspaceId).toBeUndefined();
        expect(model?.simpleProps?.selectedWorkspaceLocationId).toBeUndefined();
        expect(model?.simpleProps?.selectedWorkspaceCheckoutId).toBeUndefined();
        expect(model?.simpleProps?.checkoutCreationDraft).toMatchObject({
            kind: 'git_worktree',
            displayName: 'feature/focused-browser-fix',
            baseRef: 'main',
        });
        expect(getCheckoutChipLabel(model)).toBe('newSession.checkout.newWorktree');
    });

    it('re-hydrates prompt and resume selection coherently when a newer draft is loaded on focus', async () => {
        persistedDraft.input = 'Old persisted prompt';
        persistedDraft.resumeSessionId = 'sess_old';
        persistedDraft.updatedAt = 123;

        let model: any = null;
        await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        expect(model?.simpleProps?.sessionPrompt).toBe('Old persisted prompt');
        expect(model?.simpleProps?.resumeSessionId).toBe('sess_old');
        expect(useCreateNewSessionArgsRef.current).toEqual(expect.objectContaining({
            authoringDraft: expect.objectContaining({
                prompt: 'Old persisted prompt',
                displayText: 'Old persisted prompt',
                resumeSessionId: 'sess_old',
            }),
        }));

        persistedDraft.input = 'Focused draft prompt';
        persistedDraft.resumeSessionId = 'sess_new';
        persistedDraft.selectedWorkspaceId = 'ws_payments';
        persistedDraft.selectedWorkspaceLocationId = 'loc_local';
        persistedDraft.selectedWorkspaceCheckoutId = 'checkout_feature_auth';
        persistedDraft.updatedAt = 456;

        const cleanups = await runFocusEffectsAndSettle();
        for (const cleanup of cleanups) {
            if (typeof cleanup === 'function') cleanup();
        }

        expect(model?.simpleProps?.sessionPrompt).toBe('Focused draft prompt');
        expect(model?.simpleProps?.resumeSessionId).toBe('sess_new');
        expect(useCreateNewSessionArgsRef.current).toEqual(expect.objectContaining({
            authoringDraft: expect.objectContaining({
                prompt: 'Focused draft prompt',
                displayText: 'Focused draft prompt',
                resumeSessionId: 'sess_new',
            }),
        }));

        await act(async () => {
            persistDraftNowRef.current?.();
        });

        expect(saveNewSessionDraftMock).toHaveBeenCalledWith(expect.objectContaining({
            input: 'Focused draft prompt',
            resumeSessionId: 'sess_new',
        }));
    });

    it('hydrates mcpSelection into the MCP chip flow and persists it with the draft', async () => {
        featureFlags.mcpServersEnabled = true;
        saveNewSessionDraftMock.mockClear();
        machineMcpServersPreviewMock.mockClear();
        persistDraftNowRef.current = null;

        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        expect(machineMcpServersPreviewMock).toHaveBeenCalledWith(
            'machine-2',
            expect.objectContaining({
                agentId: 'claude',
                directory: '/repo/custom',
                selection: expect.objectContaining({
                    managedServersEnabled: false,
                    forceIncludeServerIds: ['server-portable'],
                    forceExcludeServerIds: ['server-disabled'],
                }),
            }),
            expect.anything(),
        );
        expect(Array.isArray(model?.simpleProps?.agentInputExtraActionChips)).toBe(true);
        expect(model?.simpleProps?.agentInputExtraActionChips.some((chip: any) => chip?.key === 'new-session-mcp')).toBe(true);
        expect(model?.simpleProps?.agentInputExtraActionChips.find((chip: any) => chip?.key === 'new-session-mcp')?.controlId).toBe('mcp');

        await act(async () => {
            persistDraftNowRef.current?.();
        });

        expect(saveNewSessionDraftMock).toHaveBeenCalledWith(expect.objectContaining({
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            mcpSelection: {
                v: 1,
                managedServersEnabled: false,
                forceIncludeServerIds: ['server-portable'],
                forceExcludeServerIds: ['server-disabled'],
            },
        }));

        featureFlags.mcpServersEnabled = false;
    });

    it('persists canonical inferred workspace selection in autosaved drafts', async () => {
        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        function Probe() {
            useNewSessionScreenModel();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        await act(async () => {
            persistDraftNowRef.current?.();
        });

        expect(saveNewSessionDraftMock.mock.calls.at(-1)?.[0]).toEqual(expect.not.objectContaining({
            selectedWorkspaceId: expect.anything(),
            selectedWorkspaceLocationId: expect.anything(),
            selectedWorkspaceCheckoutId: expect.anything(),
        }));
        const latestDraft = saveNewSessionDraftMock.mock.calls.at(-1)?.[0];
        expect(latestDraft).toBeTruthy();
        expect('sessionType' in (latestDraft as Record<string, unknown>)).toBe(false);
    });

    it('persists the canonical authoring draft before opening profile edit', async () => {
        settingsState.useProfiles = true;
        settingsState.useEnhancedSessionWizard = true;
        persistedDraft.backendTarget = { kind: 'builtInAgent', agentId: 'claude' };

        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        expect(model?.variant).toBe('wizard');
        expect(typeof model?.wizardProps?.profiles?.openProfileEdit).toBe('function');

        await act(async () => {
            model?.wizardProps?.profiles?.openProfileEdit?.({});
            await flushInteractionQueue();
        });

        expect(routerPushMock).toHaveBeenCalledWith(expect.objectContaining({
            pathname: '/new/pick/profile-edit',
            params: expect.objectContaining({
                machineId: 'machine-2',
            }),
        }));
        expect(saveNewSessionDraftMock.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            selectedMachineId: 'machine-2',
            selectedPath: '/repo/custom',
        }));
        expect(saveNewSessionDraftMock.mock.calls.at(-1)?.[0]).toEqual(expect.not.objectContaining({
            selectedWorkspaceId: expect.anything(),
            selectedWorkspaceLocationId: expect.anything(),
            selectedWorkspaceCheckoutId: expect.anything(),
        }));
    });

    it('keeps the current route stable and exposes a shared path popover when the new-session route starts without a dataId', async () => {
        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        expect(model?.simpleProps?.handlePathClick).toBeUndefined();
        expect(typeof model?.simpleProps?.pathPopover?.renderContent).toBe('function');
        expect(routerSetParamsMock).not.toHaveBeenCalled();
        expect(routerPushMock).not.toHaveBeenCalled();
    });

    it('keeps the current route stable and exposes a shared resume popover in the simple panel when resume is available', async () => {
        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        expect(model?.simpleProps?.showResumePicker).toBe(true);
        expect(typeof model?.simpleProps?.resumePopover?.renderContent).toBe('function');
        expect(routerSetParamsMock).not.toHaveBeenCalled();
        expect(routerPushMock).not.toHaveBeenCalled();
    });

    it('keeps the profile picker on the current route and exposes a shared profile popover in the simple panel', async () => {
        settingsState.useProfiles = true;
        settingsState.useEnhancedSessionWizard = false;

        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        expect(typeof model?.simpleProps?.profilePopover?.renderContent).toBe('function');
        expect(routerSetParamsMock).not.toHaveBeenCalled();
        expect(routerPushMock).not.toHaveBeenCalled();
    });

    it('drops already-queued profile-edit draft persistence after draft persistence is disabled and cleared', async () => {
        settingsState.useProfiles = true;
        settingsState.useEnhancedSessionWizard = true;

        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        await act(async () => {
            model?.wizardProps?.profiles?.openProfileEdit?.({});
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(routerPushMock).toHaveBeenCalledWith(expect.objectContaining({
            pathname: '/new/pick/profile-edit',
        }));
        expect(interactionQueueState.callbacks).toHaveLength(1);
        expect(saveNewSessionDraftMock).not.toHaveBeenCalled();

        await act(async () => {
            (useCreateNewSessionArgsRef.current?.disableDraftPersistence as (() => void) | undefined)?.();
            clearNewSessionDraftMock();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        await act(async () => {
            await flushInteractionQueue();
        });

        expect(clearNewSessionDraftMock).toHaveBeenCalledTimes(1);
        expect(saveNewSessionDraftMock).not.toHaveBeenCalled();
    });

    it('keeps the default environment selected even when a workspace graph still carries a legacy default profile', async () => {
        settingsState.useProfiles = true;
        settingsState.useEnhancedSessionWizard = true;
        settingsState.profiles = [{
            id: 'profile_workspace',
            title: 'Workspace profile',
            isBuiltIn: false,
            compatibility: { claude: true },
            envVarRequirements: [],
        }];
        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        expect(model?.variant).toBe('wizard');
        expect(model?.wizardProps?.profiles?.selectedProfileId).toBeNull();
        expect(model?.wizardProps?.profiles?.getProfileSubtitleExtra?.({ id: 'profile_workspace' })).toBeNull();
        expect(model?.wizardProps?.profiles?.getProfileSubtitleExtra?.({ id: 'profile_other' })).toBeNull();

        await act(async () => {
            model?.wizardProps?.profiles?.onPressDefaultEnvironment?.();
            await flushHookEffects({ cycles: 1, turns: 2 });
        });

        expect(model?.wizardProps?.profiles?.selectedProfileId).toBeNull();
    });

    it('does not reseed profile selection from legacy workspace defaults after clearing back to the default environment', async () => {
        settingsState.useProfiles = true;
        settingsState.useEnhancedSessionWizard = true;
        settingsState.profiles = [
            {
                id: 'profile_workspace',
                title: 'Workspace profile',
                isBuiltIn: false,
                compatibility: { claude: true },
                envVarRequirements: [],
            },
            {
                id: 'profile_docs',
                title: 'Docs profile',
                isBuiltIn: false,
                compatibility: { claude: true },
                envVarRequirements: [],
            },
        ];
        workspaceGraphState.workspacesByServerId['server-a'] = [
            {
                id: 'ws_payments',
                displayName: 'Payments',
                locationIds: ['loc_local'],
                checkoutIds: ['checkout_feature_auth'],
                defaultLocationId: 'loc_local',
                defaultCheckoutId: 'checkout_feature_auth',
            },
            {
                id: 'ws_docs',
                displayName: 'Docs',
                locationIds: ['loc_docs'],
                checkoutIds: ['checkout_docs_main'],
                defaultLocationId: 'loc_docs',
                defaultCheckoutId: 'checkout_docs_main',
            },
        ];
        workspaceGraphState.workspaceLocations.loc_docs = {
            id: 'loc_docs',
            workspaceId: 'ws_docs',
            machineId: 'machine-2',
            path: '/repo/docs',
            detectedScm: {
                provider: 'git',
                rootPath: '/repo/docs',
            },
            capabilities: {
                syncEligible: true,
                scmDetected: true,
                checkoutProviderKinds: ['git_worktree' as const],
            },
        };
        workspaceGraphState.workspaceCheckouts.checkout_docs_main = {
            id: 'checkout_docs_main',
            workspaceId: 'ws_docs',
            workspaceLocationId: 'loc_docs',
            kind: 'primary',
            path: '/repo/docs',
            displayName: 'docs-main',
            status: 'ready',
            syncPolicy: 'inherit',
            scm: {
                git: {
                    branch: 'main',
                    isMainWorktree: true,
                    mainRepoPath: '/repo/docs',
                },
            },
        };
        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        const hook = await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        expect(model?.wizardProps?.profiles?.selectedProfileId).toBeNull();

        await act(async () => {
            model?.wizardProps?.profiles?.onPressDefaultEnvironment?.();
            await flushHookEffects({ cycles: 1, turns: 2 });
        });

        expect(model?.wizardProps?.profiles?.selectedProfileId).toBeNull();

        searchParamsState.value = {
            machineId: 'machine-2',
            path: '/repo/docs',
        };

        await hook.rerender();

        expect(model?.wizardProps?.profiles?.selectedProfileId).toBeNull();
        expect(model?.wizardProps?.profiles?.getProfileSubtitleExtra?.({ id: 'profile_docs' })).toBeNull();
        expect(model?.wizardProps?.profiles?.getProfileSubtitleExtra?.({ id: 'profile_workspace' })).toBeNull();
    });

    it('persists updated checkout creation draft state after in-memory changes', async () => {
        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        await act(async () => {
            model?.simpleProps?.setCheckoutCreationDraft?.({
                kind: 'git_worktree',
                displayName: 'feature/payment-sync',
                baseRef: 'develop',
            });
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        await act(async () => {
            persistDraftNowRef.current?.();
        });

        expect(saveNewSessionDraftMock).toHaveBeenCalledWith(expect.objectContaining({
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'feature/payment-sync',
                baseRef: 'develop',
            },
        }));
    });

    it('fails closed back to the inferred workspace selection after invalid in-memory changes', async () => {
        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        expect(model?.simpleProps?.setSelectedWorkspaceId).toBeUndefined();
        expect(model?.simpleProps?.setSelectedWorkspaceLocationId).toBeUndefined();
        expect(model?.simpleProps?.setSelectedWorkspaceCheckoutId).toBeUndefined();

        await act(async () => {
            persistDraftNowRef.current?.();
        });

        expect(saveNewSessionDraftMock.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
            selectedMachineId: 'machine-2',
            selectedPath: '/repo/custom',
        }));
        expect(saveNewSessionDraftMock.mock.calls.at(-1)?.[0]).toEqual(expect.not.objectContaining({
            selectedWorkspaceId: expect.anything(),
            selectedWorkspaceLocationId: expect.anything(),
            selectedWorkspaceCheckoutId: expect.anything(),
        }));
    });

    it('clears stale workspace linkage after the selected path changes to an unrelated route path', async () => {
        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        const hook = await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        expect(model?.simpleProps?.selectedWorkspaceId).toBeUndefined();
        expect(model?.simpleProps?.selectedWorkspaceLocationId).toBeUndefined();
        expect(model?.simpleProps?.selectedWorkspaceCheckoutId).toBeUndefined();

        searchParamsState.value = {
            machineId: 'machine-2',
            path: '/repo/unlinked',
        };

        await hook.rerender();

        expect(model?.simpleProps?.selectedPath).toBe('/repo/unlinked');
        expect(model?.simpleProps?.selectedWorkspaceId).toBeUndefined();
        expect(model?.simpleProps?.selectedWorkspaceLocationId).toBeUndefined();
        expect(model?.simpleProps?.selectedWorkspaceCheckoutId).toBeUndefined();
        expect(model?.simpleProps?.checkoutCreationDraft).toBeNull();
        expect(useCreateNewSessionArgsRef.current).toEqual(expect.objectContaining({
            authoringDraft: expect.objectContaining({
                directory: '/repo/unlinked',
                checkoutCreationDraft: null,
            }),
        }));

        await act(async () => {
            persistDraftNowRef.current?.();
        });

        expect(saveNewSessionDraftMock).toHaveBeenCalledWith(expect.objectContaining({
            selectedMachineId: 'machine-2',
            selectedPath: '/repo/unlinked',
        }));
        expect(saveNewSessionDraftMock.mock.calls.at(-1)?.[0]).not.toEqual(expect.objectContaining({
            selectedWorkspaceId: expect.anything(),
        }));
        expect(saveNewSessionDraftMock.mock.calls.at(-1)?.[0]).not.toEqual(expect.objectContaining({
            selectedWorkspaceLocationId: expect.anything(),
        }));
        expect(saveNewSessionDraftMock.mock.calls.at(-1)?.[0]).not.toEqual(expect.objectContaining({
            selectedWorkspaceCheckoutId: expect.anything(),
        }));
        expect(saveNewSessionDraftMock.mock.calls.at(-1)?.[0]).not.toEqual(expect.objectContaining({
            checkoutCreationDraft: expect.anything(),
        }));
    });

    it('clears stale workspace linkage after the selected machine changes to a different machine route', async () => {
        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        const hook = await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        searchParamsState.value = {
            machineId: 'machine-1',
        };

        await hook.rerender();

        expect(model?.simpleProps?.machineName).toBe('Machine One');
        expect(model?.simpleProps?.selectedPath).toBe('/home/one');
        expect(model?.simpleProps?.selectedWorkspaceId).toBeUndefined();
        expect(model?.simpleProps?.selectedWorkspaceLocationId).toBeUndefined();
        expect(model?.simpleProps?.selectedWorkspaceCheckoutId).toBeUndefined();
        expect(model?.simpleProps?.checkoutCreationDraft).toBeNull();
        expect(useCreateNewSessionArgsRef.current).toEqual(expect.objectContaining({
            authoringDraft: expect.objectContaining({
                directory: '/home/one',
                checkoutCreationDraft: null,
            }),
        }));
    });

    it('keeps repo-native path and worktree chip visible when machine/path route params arrive as string arrays', async () => {
        searchParamsState.value = {
            machineId: ['machine-2'],
            path: ['/repo/unlinked'],
        };
        persistedDraft.selectedWorkspaceId = null as any;
        persistedDraft.selectedWorkspaceLocationId = null as any;
        persistedDraft.selectedWorkspaceCheckoutId = null as any;
        persistedDraft.checkoutCreationDraft = null;
        repoSnapshotState.value = {
            ...repoSnapshotState.value,
            projectKey: 'machine-2:/repo/unlinked',
            repo: {
                ...repoSnapshotState.value.repo,
                rootPath: '/repo/unlinked',
                worktrees: [
                    { path: '/repo/unlinked', branch: 'main', isCurrent: true, isMain: true },
                    { path: '/repo/unlinked-feature', branch: 'feature/demo', isCurrent: false },
                ],
            },
        } as any;
        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        expect(model?.simpleProps?.selectedPath).toBe('/repo/unlinked');
        const checkoutChip = model?.simpleProps?.agentInputExtraActionChips?.find((chip: any) => chip?.key === 'new-session-checkout');
        expect(checkoutChip).toBeTruthy();
        expect(getCheckoutChipLabel(model)).toBe('newSession.checkout.noWorktree');
    });

    it('hydrates the selected path from the canonical directory route param', async () => {
        searchParamsState.value = {
            machineId: 'machine-2',
            directory: '/repo/from-directory',
        } as any;
        persistedDraft.selectedWorkspaceId = null as any;
        persistedDraft.selectedWorkspaceLocationId = null as any;
        persistedDraft.selectedWorkspaceCheckoutId = null as any;
        persistedDraft.checkoutCreationDraft = null;
        repoSnapshotState.value = {
            ...repoSnapshotState.value,
            projectKey: 'machine-2:/repo/from-directory',
            repo: {
                ...repoSnapshotState.value.repo,
                rootPath: '/repo/from-directory',
            },
        } as any;
        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        expect(model?.simpleProps?.selectedPath).toBe('/repo/from-directory');
    });

    it('surfaces a checkout chip that opens the worktree picker from an unlinked git repo', async () => {
        persistedDraft.checkoutCreationDraft = null;
        workspaceGraphState.workspacesByServerId['server-a'] = [];
        workspaceGraphState.workspaceLocations = {};
        workspaceGraphState.workspaceCheckouts = {};
        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        try {
        await act(async () => {
            model?.simpleProps?.setCheckoutCreationDraft?.(null);
            await flushHookEffects({ cycles: 1, turns: 2 });
        });

            const checkoutChip = model?.simpleProps?.agentInputExtraActionChips?.find((chip: any) => chip?.key === 'new-session-checkout');
            expect(checkoutChip).toBeTruthy();

            const chipElement = checkoutChip.render({
                chipStyle: () => null,
                showLabel: true,
                iconColor: '#000',
                textStyle: {},
                countTextStyle: {},
                popoverAnchorRef: { current: null },
            }) as React.ReactElement<{
                children?: React.ReactNode;
            }>;
            const chipPressable = React.Children.toArray(chipElement?.props?.children)[0] as React.ReactElement<{
                onPress?: () => void;
                accessibilityLabel?: string;
                children?: React.ReactNode;
            }> | undefined;

            expect(typeof chipPressable?.props?.onPress).toBe('function');
            expect(chipPressable?.props?.accessibilityLabel).toBe('newSession.checkout.selectTitle');

            const renderedChildren = Array.isArray(chipPressable?.props?.children)
                ? (chipPressable.props.children as React.ReactElement[])
                : null;
            const renderedLabelNode = renderedChildren?.[1] as React.ReactElement<{ children?: React.ReactNode }> | undefined;
            const renderedLabel = renderedChildren
                ? renderedLabelNode?.props?.children
                : undefined;
            expect(renderedLabel).toBe('newSession.checkout.noWorktree');

        await act(async () => {
            chipPressable?.props?.onPress?.();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

            expect(model?.simpleProps?.checkoutCreationDraft).toBeNull();

            const updatedCheckoutChip = model?.simpleProps?.agentInputExtraActionChips?.find((chip: any) => chip?.key === 'new-session-checkout');
            const updatedChipElement = updatedCheckoutChip.render({
                chipStyle: () => null,
                showLabel: true,
                iconColor: '#000',
                textStyle: {},
                countTextStyle: {},
                popoverAnchorRef: { current: null },
            }) as React.ReactElement<{ children?: React.ReactNode }>;
            const updatedChildren = React.Children.toArray(updatedChipElement?.props?.children) as React.ReactElement[];
            const pickerPopover = updatedChildren[1] as React.ReactElement<{
                open?: boolean;
                options?: ReadonlyArray<{ id: string }>;
            }> | undefined;

            expect(pickerPopover?.props?.open).toBe(true);
            expect(pickerPopover?.props?.options?.map((option) => option.id)).toEqual([
                'current_path',
                'create_git_worktree',
            ]);
        } finally {
            repoSnapshotState.value = {
                ...repoSnapshotState.value,
                repo: {
                    ...repoSnapshotState.value.repo,
                    worktrees: [{ path: '/repo/custom', branch: 'main', isCurrent: true }],
                },
            };
            workspaceGraphState.workspacesByServerId['server-a'] = [
                {
                    id: 'ws_payments',
                    displayName: 'Payments',
                    locationIds: ['loc_local'],
                    checkoutIds: ['checkout_feature_auth'],
                    defaultLocationId: 'loc_local',
                    defaultCheckoutId: 'checkout_feature_auth',
                },
            ];
            workspaceGraphState.workspaceCheckouts = {
                checkout_feature_auth: {
                    id: 'checkout_feature_auth',
                    workspaceId: 'ws_payments',
                    workspaceLocationId: 'loc_local',
                    kind: 'primary',
                    path: '/repo/custom',
                    displayName: 'main',
                    status: 'ready',
                    syncPolicy: 'inherit',
                    scm: {
                        git: {
                            branch: 'main',
                            isMainWorktree: true,
                            mainRepoPath: '/repo/custom',
                        },
                    },
                },
            };
        }
    });

    it('auto-opens the worktree picker when the route explicitly requests a new worktree flow', async () => {
        persistedDraft.checkoutCreationDraft = null;
        workspaceGraphState.workspacesByServerId['server-a'] = [];
        workspaceGraphState.workspaceLocations = {};
        workspaceGraphState.workspaceCheckouts = {};
        searchParamsState.value = {
            worktree: 'new',
        };
        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        try {
            const checkoutChip = model?.simpleProps?.agentInputExtraActionChips?.find((chip: any) => chip?.key === 'new-session-checkout');
            expect(checkoutChip).toBeTruthy();

            const chipElement = checkoutChip.render({
                chipStyle: () => null,
                showLabel: true,
                iconColor: '#000',
                textStyle: {},
                countTextStyle: {},
                popoverAnchorRef: { current: null },
            }) as React.ReactElement<{ children?: React.ReactNode }>;
            const renderedChildren = React.Children.toArray(chipElement?.props?.children) as React.ReactElement[];
            const pickerPopover = renderedChildren[1] as React.ReactElement<{
                open?: boolean;
                options?: ReadonlyArray<{ id: string }>;
            }> | undefined;

            expect(pickerPopover?.props?.open).toBe(true);
            expect(pickerPopover?.props?.options?.map((option) => option.id)).toEqual([
                'current_path',
                'create_git_worktree',
            ]);
        } finally {
            searchParamsState.value = {};
            repoSnapshotState.value = {
                ...repoSnapshotState.value,
                repo: {
                    ...repoSnapshotState.value.repo,
                    worktrees: [{ path: '/repo/custom', branch: 'main', isCurrent: true }],
                },
            };
            workspaceGraphState.workspacesByServerId['server-a'] = [
                {
                    id: 'ws_payments',
                    displayName: 'Payments',
                    locationIds: ['loc_local'],
                    checkoutIds: ['checkout_feature_auth'],
                    defaultLocationId: 'loc_local',
                    defaultCheckoutId: 'checkout_feature_auth',
                },
            ];
            workspaceGraphState.workspaceCheckouts = {
                checkout_feature_auth: {
                    id: 'checkout_feature_auth',
                    workspaceId: 'ws_payments',
                    workspaceLocationId: 'loc_local',
                    kind: 'primary',
                    path: '/repo/custom',
                    displayName: 'main',
                    status: 'ready',
                    syncPolicy: 'inherit',
                    scm: {
                        git: {
                            branch: 'main',
                            isMainWorktree: true,
                            mainRepoPath: '/repo/custom',
                        },
                    },
                },
            };
        }
    });

    it('uses the shared checkout picker popover on ios when checkout options require a picker', async () => {
        platformOsState.value = 'ios';
        persistedDraft.checkoutCreationDraft = null;
        workspaceGraphState.workspacesByServerId['server-a'] = [
            {
                ...workspaceGraphState.workspacesByServerId['server-a'][0],
                checkoutIds: ['checkout_feature_auth', 'checkout_release', 'checkout_hotfix'],
                defaultCheckoutId: 'checkout_feature_auth',
            },
        ];
        workspaceGraphState.workspaceCheckouts = {
            checkout_feature_auth: {
                id: 'checkout_feature_auth',
                workspaceId: 'ws_payments',
                workspaceLocationId: 'loc_local',
                kind: 'primary',
                path: '/repo/custom',
                displayName: 'main',
                status: 'ready',
                syncPolicy: 'inherit',
                scm: {
                    git: {
                        branch: 'main',
                        isMainWorktree: true,
                        mainRepoPath: '/repo/custom',
                    },
                },
            },
            checkout_release: {
                id: 'checkout_release',
                workspaceId: 'ws_payments',
                workspaceLocationId: 'loc_local',
                kind: 'git_worktree',
                path: '/repo/release',
                displayName: 'release',
                status: 'ready',
                syncPolicy: 'inherit',
                scm: {
                    git: {
                        branch: 'release',
                        isMainWorktree: false,
                        mainRepoPath: '/repo/custom',
                    },
                },
            },
            checkout_hotfix: {
                id: 'checkout_hotfix',
                workspaceId: 'ws_payments',
                workspaceLocationId: 'loc_local',
                kind: 'git_worktree',
                path: '/repo/hotfix',
                displayName: 'hotfix',
                status: 'ready',
                syncPolicy: 'inherit',
                scm: {
                    git: {
                        branch: 'hotfix',
                        isMainWorktree: false,
                        mainRepoPath: '/repo/custom',
                    },
                },
            },
        };
        repoSnapshotState.value = {
            ...repoSnapshotState.value,
            repo: {
                ...repoSnapshotState.value.repo,
                worktrees: [
                    { path: '/repo/custom', branch: 'main', isCurrent: true },
                    { path: '/repo/hotfix', branch: 'hotfix', isCurrent: false },
                    { path: '/repo/release', branch: 'release', isCurrent: false },
                ],
            },
        };
        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        try {
            const checkoutChip = model?.simpleProps?.agentInputExtraActionChips?.find((chip: any) => chip?.key === 'new-session-checkout');
            expect(checkoutChip).toBeTruthy();
            expect(checkoutChip?.controlId).toBe('checkout');
            expect(checkoutChip?.collapsedOptionsPopover?.title).toBe('newSession.checkout.selectTitle');

            const renderCheckoutChip = () => checkoutChip.render({
                chipStyle: () => null,
                showLabel: true,
                iconColor: '#000',
                textStyle: {},
                countTextStyle: {},
                popoverAnchorRef: { current: null },
            }) as React.ReactElement<{ children?: React.ReactNode }>;

            const initialChipElement = renderCheckoutChip();
            const initialChildren = React.Children.toArray(initialChipElement?.props?.children) as React.ReactElement[];
            const chipPressable = initialChildren[0] as React.ReactElement<{ onPress?: () => void }> | undefined;

            expect(typeof chipPressable?.props?.onPress).toBe('function');

        await act(async () => {
            chipPressable?.props?.onPress?.();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

            const updatedCheckoutChip = model?.simpleProps?.agentInputExtraActionChips?.find((chip: any) => chip?.key === 'new-session-checkout');
            const updatedChipElement = updatedCheckoutChip.render({
                chipStyle: () => null,
                showLabel: true,
                iconColor: '#000',
                textStyle: {},
                countTextStyle: {},
                popoverAnchorRef: { current: null },
            }) as React.ReactElement<{ children?: React.ReactNode }>;
            const updatedChildren = React.Children.toArray(updatedChipElement?.props?.children) as React.ReactElement[];
            const pickerPopover = updatedChildren[1] as React.ReactElement<{
                open?: boolean;
                options?: unknown;
            }> | undefined;

            expect(modalShowMock).not.toHaveBeenCalled();
            expect(pickerPopover).toBeTruthy();
            expect(pickerPopover?.props?.open).toBe(true);
            expect(pickerPopover?.props?.options).toHaveLength(4);
            expect(pickerPopover?.props?.options).toEqual([
                expect.objectContaining({
                    id: 'current_path',
                    sectionId: 'current',
                }),
                expect.objectContaining({
                    id: 'create_git_worktree',
                    sectionId: 'actions',
                }),
                expect.objectContaining({
                    id: 'checkout:/repo/hotfix',
                    sectionId: 'linked',
                    label: 'hotfix',
                }),
                expect.objectContaining({
                    id: 'checkout:/repo/release',
                    sectionId: 'linked',
                    label: 'release',
                }),
            ]);
        } finally {
            platformOsState.value = 'web';
            repoSnapshotState.value = {
                ...repoSnapshotState.value,
                repo: {
                    ...repoSnapshotState.value.repo,
                    worktrees: [{ path: '/repo/custom', branch: 'main', isCurrent: true }],
                },
            };
            workspaceGraphState.workspacesByServerId['server-a'] = [
                {
                    id: 'ws_payments',
                    displayName: 'Payments',
                    locationIds: ['loc_local'],
                    checkoutIds: ['checkout_feature_auth'],
                    defaultLocationId: 'loc_local',
                    defaultCheckoutId: 'checkout_feature_auth',
                },
            ];
            workspaceGraphState.workspaceCheckouts = {
                checkout_feature_auth: {
                    id: 'checkout_feature_auth',
                    workspaceId: 'ws_payments',
                    workspaceLocationId: 'loc_local',
                    kind: 'primary',
                    path: '/repo/custom',
                    displayName: 'main',
                    status: 'ready',
                    syncPolicy: 'inherit',
                    scm: {
                        git: {
                            branch: 'main',
                            isMainWorktree: true,
                            mainRepoPath: '/repo/custom',
                        },
                    },
                },
            };
        }
    });

    it('opens the shared checkout picker when an existing repo worktree is available without workspace linkage', async () => {
        persistedDraft.checkoutCreationDraft = null;
        workspaceGraphState.workspacesByServerId['server-a'] = [];
        workspaceGraphState.workspaceLocations = {};
        workspaceGraphState.workspaceCheckouts = {};
        repoSnapshotState.value = {
            ...repoSnapshotState.value,
            repo: {
                ...repoSnapshotState.value.repo,
                worktrees: [
                    { path: '/repo/custom', branch: 'main', isCurrent: true },
                    { path: '/repo/release', branch: 'release', isCurrent: false },
                ],
            },
        };

        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        try {
            const checkoutChip = model?.simpleProps?.agentInputExtraActionChips?.find((chip: any) => chip?.key === 'new-session-checkout');
            expect(checkoutChip).toBeTruthy();

            const renderCheckoutChip = () => checkoutChip.render({
                chipStyle: () => null,
                showLabel: true,
                iconColor: '#000',
                textStyle: {},
                countTextStyle: {},
                popoverAnchorRef: { current: null },
            }) as React.ReactElement<{ children?: React.ReactNode }>;

            const initialChipElement = renderCheckoutChip();
            const initialChildren = React.Children.toArray(initialChipElement?.props?.children) as React.ReactElement[];
            const chipPressable = initialChildren[0] as React.ReactElement<{ onPress?: () => void }> | undefined;

            expect(typeof chipPressable?.props?.onPress).toBe('function');

            await act(async () => {
                chipPressable?.props?.onPress?.();
                await flushHookEffects({ cycles: 1, turns: 1 });
            });

            expect(model?.simpleProps?.checkoutCreationDraft).toBeNull();

            const updatedCheckoutChip = model?.simpleProps?.agentInputExtraActionChips?.find((chip: any) => chip?.key === 'new-session-checkout');
            const updatedChipElement = updatedCheckoutChip.render({
                chipStyle: () => null,
                showLabel: true,
                iconColor: '#000',
                textStyle: {},
                countTextStyle: {},
                popoverAnchorRef: { current: null },
            }) as React.ReactElement<{ children?: React.ReactNode }>;
            const updatedChildren = React.Children.toArray(updatedChipElement?.props?.children) as React.ReactElement[];
            const pickerPopover = updatedChildren[1] as React.ReactElement<{
                open?: boolean;
                options?: unknown;
            }> | undefined;

            expect(pickerPopover).toBeTruthy();
            expect(pickerPopover?.props?.open).toBe(true);
            expect(pickerPopover?.props?.options).toHaveLength(3);
            expect(pickerPopover?.props?.options).toEqual([
                expect.objectContaining({
                    id: 'current_path',
                    sectionId: 'current',
                }),
                expect.objectContaining({
                    id: 'create_git_worktree',
                    sectionId: 'actions',
                }),
                expect.objectContaining({
                    id: 'checkout:/repo/release',
                    sectionId: 'linked',
                    label: 'release',
                }),
            ]);
        } finally {
            repoSnapshotState.value = {
                ...repoSnapshotState.value,
                repo: {
                    ...repoSnapshotState.value.repo,
                    worktrees: [{ path: '/repo/custom', branch: 'main', isCurrent: true }],
                },
            };
            workspaceGraphState.workspacesByServerId['server-a'] = [
                {
                    id: 'ws_payments',
                    displayName: 'Payments',
                    locationIds: ['loc_local'],
                    checkoutIds: ['checkout_feature_auth'],
                    defaultLocationId: 'loc_local',
                    defaultCheckoutId: 'checkout_feature_auth',
                },
            ];
            workspaceGraphState.workspaceLocations = {
                loc_local: {
                    id: 'loc_local',
                    workspaceId: 'ws_payments',
                    machineId: 'machine-2',
                    path: '/repo/custom',
                    detectedScm: {
                        provider: 'git',
                        rootPath: '/repo/custom',
                    },
                    capabilities: {
                        syncEligible: true,
                        scmDetected: true,
                        checkoutProviderKinds: ['git_worktree'],
                    },
                },
            };
            workspaceGraphState.workspaceCheckouts = {
                checkout_feature_auth: {
                    id: 'checkout_feature_auth',
                    workspaceId: 'ws_payments',
                    workspaceLocationId: 'loc_local',
                    kind: 'primary',
                    path: '/repo/custom',
                    displayName: 'main',
                    status: 'ready',
                    syncPolicy: 'inherit',
                    scm: {
                        git: {
                            branch: 'main',
                            isMainWorktree: true,
                            mainRepoPath: '/repo/custom',
                        },
                    },
                },
            };
        }
    });

    it('commits the selected new-worktree base ref only when the picker apply action runs', async () => {
        persistedDraft.checkoutCreationDraft = null;
        workspaceGraphState.workspacesByServerId['server-a'] = [];
        workspaceGraphState.workspaceLocations = {};
        workspaceGraphState.workspaceCheckouts = {};
        repoSnapshotState.value = {
            ...repoSnapshotState.value,
            repo: {
                ...repoSnapshotState.value.repo,
                worktrees: [
                    { path: '/repo/custom', branch: 'main', isCurrent: true },
                    { path: '/repo/release', branch: 'release', isCurrent: false },
                ],
            },
        };

        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        try {
            const checkoutChip = model?.simpleProps?.agentInputExtraActionChips?.find((chip: any) => chip?.key === 'new-session-checkout');
            const createOption = checkoutChip?.collapsedOptionsPopover?.options?.find((option: any) => option.id === 'create_git_worktree');

            expect(createOption).toBeTruthy();
            expect(model?.simpleProps?.checkoutCreationDraft).toBeNull();

            const detailElement = createOption.renderDetailContent?.() as React.ReactElement<{
                onSelectionChange?: (value: { baseRef: string | null; sourceKind: 'current' | 'local' | 'remote' }) => void;
            }> | undefined;
            expect(detailElement?.props?.onSelectionChange).toBeTypeOf('function');

        await act(async () => {
            detailElement?.props?.onSelectionChange?.({
                baseRef: 'origin/release',
                sourceKind: 'remote',
            });
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(model?.simpleProps?.checkoutCreationDraft).toBeNull();

        await act(async () => {
            createOption.onApply?.();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

            expect(model?.simpleProps?.checkoutCreationDraft).toEqual({
                kind: 'git_worktree',
                displayName: expect.any(String),
                baseRef: 'origin/release',
                branchMode: 'new',
            });
        } finally {
            repoSnapshotState.value = {
                ...repoSnapshotState.value,
                repo: {
                    ...repoSnapshotState.value.repo,
                    worktrees: [{ path: '/repo/custom', branch: 'main', isCurrent: true }],
                },
            };
            workspaceGraphState.workspacesByServerId['server-a'] = [
                {
                    id: 'ws_payments',
                    displayName: 'Payments',
                    locationIds: ['loc_local'],
                    checkoutIds: ['checkout_feature_auth'],
                    defaultLocationId: 'loc_local',
                    defaultCheckoutId: 'checkout_feature_auth',
                },
            ];
            workspaceGraphState.workspaceLocations = {
                loc_local: {
                    id: 'loc_local',
                    workspaceId: 'ws_payments',
                    machineId: 'machine-2',
                    path: '/repo/custom',
                    detectedScm: {
                        provider: 'git',
                        rootPath: '/repo/custom',
                    },
                    capabilities: {
                        syncEligible: true,
                        scmDetected: true,
                        checkoutProviderKinds: ['git_worktree'],
                    },
                },
            };
            workspaceGraphState.workspaceCheckouts = {
                checkout_feature_auth: {
                    id: 'checkout_feature_auth',
                    workspaceId: 'ws_payments',
                    workspaceLocationId: 'loc_local',
                    kind: 'primary',
                    path: '/repo/custom',
                    displayName: 'main',
                    status: 'ready',
                    syncPolicy: 'inherit',
                    scm: {
                        git: {
                            branch: 'main',
                            isMainWorktree: true,
                            mainRepoPath: '/repo/custom',
                        },
                    },
                },
            };
        }
    });

    it('reacts to workspace graph updates without requiring an unrelated rerender', async () => {
        workspaceGraphState.workspaceLocations = {};
        workspaceGraphState.workspaceCheckouts = {};
        persistedDraft.selectedWorkspaceId = null as any;
        persistedDraft.selectedWorkspaceLocationId = null as any;
        persistedDraft.selectedWorkspaceCheckoutId = null as any;
        persistedDraft.checkoutCreationDraft = null;
        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        expect(getCheckoutChipLabel(model)).toBe('newSession.checkout.noWorktree');
        const getCheckoutChip = () => model?.simpleProps?.agentInputExtraActionChips?.find((chip: any) => chip?.key === 'new-session-checkout');
        expect(getCheckoutChip()?.controlId).toBe('checkout');
        expect(getCheckoutChip()?.collapsedOptionsPopover?.title).toBe('newSession.checkout.selectTitle');
        const renderCheckoutChip = () => getCheckoutChip()?.render({
            chipStyle: () => null,
            showLabel: true,
            iconColor: '#000',
            textStyle: {},
            countTextStyle: {},
            popoverAnchorRef: { current: null },
        }) as React.ReactElement<{ children?: React.ReactNode }> | undefined;
        const initialPopover = React.Children.toArray(renderCheckoutChip()?.props?.children)[1] as React.ReactElement<{
            open?: boolean;
            options?: ReadonlyArray<{ id: string }>;
        }> | undefined;
        expect(initialPopover?.props?.open).toBe(false);
        expect(initialPopover?.props?.options?.map((option) => option.id)).toEqual([
            'current_path',
            'create_git_worktree',
        ]);

        await act(async () => {
            workspaceGraphState.workspaceLocations = {
                loc_local: {
                    id: 'loc_local',
                    workspaceId: 'ws_payments',
                    machineId: 'machine-2',
                    path: '/repo/custom',
                    detectedScm: {
                        provider: 'git',
                        rootPath: '/repo/custom',
                    },
                    capabilities: {
                        syncEligible: true,
                        scmDetected: true,
                        checkoutProviderKinds: ['git_worktree'],
                    },
                },
            };
            workspaceGraphState.workspaceCheckouts = {
                checkout_feature_auth: {
                    id: 'checkout_feature_auth',
                    workspaceId: 'ws_payments',
                    workspaceLocationId: 'loc_local',
                    kind: 'primary',
                    path: '/repo/custom',
                    displayName: 'main',
                    status: 'ready',
                    syncPolicy: 'inherit',
                    scm: {
                        git: {
                            branch: 'main',
                            isMainWorktree: true,
                            mainRepoPath: '/repo/custom',
                        },
                    },
                },
            };
            notifyMockStorageSubscribers();
            await flushHookEffects({ cycles: 1, turns: 2 });
        });

        expect(getCheckoutChipLabel(model)).toBe('newSession.checkout.noWorktree');
        const updatedPopover = React.Children.toArray(renderCheckoutChip()?.props?.children)[1] as React.ReactElement<{
            open?: boolean;
            options?: ReadonlyArray<{ id: string }>;
        }> | undefined;
        expect(updatedPopover?.props?.open).toBe(false);
        expect(updatedPopover?.props?.options?.map((option) => option.id)).toEqual([
            'current_path',
            'create_git_worktree',
        ]);
    });

    it('does not surface workspace creation in the checkout chip when the selected path is not yet linked', async () => {
        persistedDraft.selectedMachineId = 'machine-2';
        persistedDraft.selectedPath = '/repo/unlinked';
        persistedDraft.selectedWorkspaceId = null as any;
        persistedDraft.selectedWorkspaceLocationId = null as any;
        persistedDraft.selectedWorkspaceCheckoutId = null as any;
        persistedDraft.checkoutCreationDraft = null;
        workspaceGraphState.workspacesByServerId['server-a'] = [];
        workspaceGraphState.workspaceLocations = {};
        workspaceGraphState.workspaceCheckouts = {};

        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        const getCheckoutChip = () => model?.simpleProps?.agentInputExtraActionChips?.find((chip: any) => chip?.key === 'new-session-checkout');
        expect(getCheckoutChip()).toBeTruthy();
        expect(getCheckoutChip()?.controlId).toBe('checkout');
        expect(getCheckoutChip()?.collapsedOptionsPopover?.title).toBe('newSession.checkout.selectTitle');

        const renderChip = () => getCheckoutChip().render({
            chipStyle: () => null,
            showLabel: true,
            iconColor: '#000',
            textStyle: {},
            countTextStyle: {},
            popoverAnchorRef: { current: null },
        }) as React.ReactElement<{ children?: React.ReactNode }>;

        const chipElement = renderChip();
        const renderedChildren = React.Children.toArray(chipElement.props.children);
        expect(renderedChildren).toHaveLength(2);
        const pickerPopover = renderedChildren[1] as React.ReactElement<{
            open?: boolean;
            options?: ReadonlyArray<{ id: string }>;
        }> | undefined;
        expect(pickerPopover?.props?.open).toBe(false);
        expect(pickerPopover?.props?.options?.map((option) => option.id)).toEqual([
            'current_path',
            'create_git_worktree',
        ]);
        expect(model?.simpleProps?.selectedWorkspaceId).toBeUndefined();
        expect(model?.simpleProps?.selectedWorkspaceLocationId).toBeUndefined();
        expect(model?.simpleProps?.selectedWorkspaceCheckoutId).toBeUndefined();
        expect(routerPushMock).not.toHaveBeenCalled();
    });

    it('fails closed to the selected target server workspace graph when another server owns the matching checkout path', async () => {
        targetServerState.allowedTargetServerIds = ['server-a', 'server-b'];
        targetServerState.targetServerId = 'server-b';
        targetServerState.targetServerName = 'Server B';
        persistedDraft.selectedMachineId = 'machine-2';
        persistedDraft.selectedPath = '/repo/custom';
        persistedDraft.selectedWorkspaceId = null as any;
        persistedDraft.selectedWorkspaceLocationId = null as any;
        persistedDraft.selectedWorkspaceCheckoutId = null as any;
        persistedDraft.checkoutCreationDraft = null;

        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        const getCheckoutChip = () => model?.simpleProps?.agentInputExtraActionChips?.find((chip: any) => chip?.key === 'new-session-checkout');
        expect(getCheckoutChip()?.controlId).toBe('checkout');
        expect(getCheckoutChip()?.collapsedOptionsPopover?.title).toBe('newSession.checkout.selectTitle');

        expect(model?.simpleProps?.selectedWorkspaceId).toBeUndefined();
        expect(model?.simpleProps?.selectedWorkspaceLocationId).toBeUndefined();
        expect(model?.simpleProps?.selectedWorkspaceCheckoutId).toBeUndefined();
        expect(getCheckoutChipLabel(model)).toBe('newSession.checkout.noWorktree');

        const checkoutChip = model?.simpleProps?.agentInputExtraActionChips?.find((chip: any) => chip?.key === 'new-session-checkout');
        expect(checkoutChip).toBeTruthy();

        const renderChip = () => checkoutChip.render({
            chipStyle: () => null,
            showLabel: true,
            iconColor: '#000',
            textStyle: {},
            countTextStyle: {},
            popoverAnchorRef: { current: null },
        }) as React.ReactElement<{ children?: React.ReactNode }>;

        const renderedChildren = React.Children.toArray(renderChip().props.children);
        expect(renderedChildren).toHaveLength(2);
        const pickerPopover = renderedChildren[1] as React.ReactElement<{
            open?: boolean;
            options?: ReadonlyArray<{ id: string }>;
        }> | undefined;
        expect(pickerPopover?.props?.open).toBe(false);
        expect(pickerPopover?.props?.options?.map((option) => option.id)).toEqual([
            'current_path',
            'create_git_worktree',
        ]);
    });

});
