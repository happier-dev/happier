import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlushHookEffectsOptions } from '@/dev/testkit';
import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { renderScreen } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit';
import { installNewSessionScreenModelCommonModuleMocks } from './newSessionScreenModelTestHelpers';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { buildRememberedEngineSelectionScopeKey } from '@/sync/domains/session/authoring/rememberedEngineSelections';
import { ModalPortalTargetProvider } from '@/modal/portal/ModalPortalTarget';
import {
    findCheckoutChip as findSelectionListCheckoutChip,
    findCheckoutChipOptionFromChip,
    getCheckoutChipExistingWorktreeIds,
    getCheckoutChipQuickActionIds,
} from './__tests__/checkoutChipSelectors';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const machineContributionRegistryProjectionDescribeMock = vi.hoisted(() => vi.fn());

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
    targetServerId?: string | null;
    windowsRemoteSessionLaunchModeOverride?: {
        machineId: string;
        mode: 'hidden' | 'windows_terminal' | 'console';
    } | null;
});
const saveNewSessionDraftMock = vi.hoisted(() => vi.fn());
const clearNewSessionDraftMock = vi.hoisted(() => vi.fn());
const loadNewSessionDraftMock = vi.hoisted(() => vi.fn(() => JSON.parse(JSON.stringify(persistedDraft))));
const platformOsState = vi.hoisted(() => ({
    value: 'web' as 'web' | 'ios' | 'android',
}));
const modalShowMock = vi.hoisted(() => vi.fn());
const modalAlertMock = vi.hoisted(() => vi.fn());
const openExternalSessionsResumeIdPickerModalMock = vi.hoisted(() => vi.fn<(args: unknown) => Promise<string | null>>(async () => 'session-picked'));
const fireAndForgetState = vi.hoisted(() => ({
    promises: [] as Promise<unknown>[],
}));
const tryShowDaemonUnavailableAlertForRpcErrorMock = vi.hoisted(() => vi.fn((_args: unknown) => false));
const routerPushMock = vi.hoisted(() => vi.fn());
const routerSetParamsMock = vi.hoisted(() => vi.fn());
const featureFlags = vi.hoisted(() => ({
    mcpServersEnabled: false,
    automationsEnabled: false,
    externalSessionsEnabled: false,
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
const readCachedWorktreesEnrichmentMock = vi.hoisted(() => vi.fn(() => null));
const fetchWorktreesEnrichmentMock = vi.hoisted(() => vi.fn(async () => []));
const targetServerState = vi.hoisted(() => ({
    allowedTargetServerIds: [] as string[],
    targetServerId: null as string | null,
    targetServerName: null as string | null,
}));
const targetServerRequestState = vi.hoisted(() => ({
    requests: [] as unknown[],
}));
const activeMachinesState = vi.hoisted(() => ({
    value: [
        { id: 'machine-1', metadata: { displayName: 'Machine One', host: 'one', homeDir: '/home/one' } },
        { id: 'machine-2', metadata: { displayName: 'Machine Two', host: 'two', homeDir: '/home/two' } },
    ] as Array<{ id: string; metadata: Record<string, unknown> }>,
}));
const machineListByServerIdState = vi.hoisted(() => ({
    value: {} as Record<string, Array<{ id: string; metadata: Record<string, unknown> }> | null>,
}));
const interactionQueueState = vi.hoisted(() => ({
    callbacks: [] as Array<() => void>,
}));
const storageSubscriptionState = vi.hoisted(() => ({
    listeners: new Set<() => void>(),
}));
const createSessionActionDraftMock = vi.hoisted(() => vi.fn());
const activeServerAccountScopeState = vi.hoisted(() => ({
    value: { serverId: 'server-a', accountId: 'account-a' } as import('@/sync/domains/scope/serverAccountScope').ServerAccountScope | null,
}));

function getMockStorageState() {
    return {
        settings: { ...settingsDefaults, ...settingsState },
        profileScope: activeServerAccountScopeState.value,
        createSessionActionDraft: createSessionActionDraftMock,
        workspaceLocations: workspaceGraphState.workspaceLocations,
        workspaceCheckouts: workspaceGraphState.workspaceCheckouts,
        machineListByServerId: machineListByServerIdState.value,
    };
}

vi.mock('@/sync/store/hooks', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        useActiveServerAccountScope: () => activeServerAccountScopeState.value,
    };
});

function notifyMockStorageSubscribers() {
    for (const listener of Array.from(storageSubscriptionState.listeners)) {
        listener();
    }
}

function setMockSettingValue(key: string, valueOrUpdater: unknown): void {
    const previous = (settingsState as Record<string, unknown>)[key];
    (settingsState as Record<string, unknown>)[key] = typeof valueOrUpdater === 'function'
        ? (valueOrUpdater as (value: unknown) => unknown)(previous)
        : valueOrUpdater;
    notifyMockStorageSubscribers();
}

function materializeStorageMachine(input: { id: string; metadata: Record<string, unknown> }) {
    return createMachineFixture({ id: input.id, metadata: input.metadata as any });
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
    actionsSettingsV1: settingsDefaults.actionsSettingsV1,
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
        backends: [] as Array<Record<string, unknown>>,
    },
};

installNewSessionScreenModelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
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
        });
    },
    unistyles: async () => {
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
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    routerConfig: {
        router: { push: routerPushMock, replace: vi.fn(), back: vi.fn(), setParams: routerSetParamsMock },
        params: () => searchParamsState.value as Record<string, string | string[] | undefined>,
        navigation: {},
        pathname: '/new',
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                show: modalShowMock,
                alert: modalAlertMock,
            },
        }).module;
    },
});

vi.mock('@/components/sessions/external/browse/openExternalSessionsResumeIdPickerModal', () => ({
    openExternalSessionsResumeIdPickerModal: (args: unknown) => openExternalSessionsResumeIdPickerModalMock(args),
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/utils/platform/responsive', () => ({
    useHeaderHeight: () => 0,
}));

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

vi.mock('@react-navigation/native', () => ({
    useFocusEffect: (fn: any) => {
        focusEffectRef.current.push(fn);
    },
}));

function installNewSessionScreenModelStorageMock() {
    vi.doMock('@/sync/domains/state/storage', async (importOriginal) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {
            useAllMachines: () => activeMachinesState.value.map(materializeStorageMachine),
            useLaunchSelectionMachines: () => activeMachinesState.value.map(materializeStorageMachine),
            useMachineListByServerId: () => Object.fromEntries(
                Object.entries(machineListByServerIdState.value).map(([serverId, machines]) => [
                    serverId,
                    Array.isArray(machines) ? machines.map(materializeStorageMachine) : machines,
                ]),
            ),
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
            useSettingMutable: (key: string) => [
                ({ ...settingsDefaults, ...settingsState } as any)[key],
                (next: unknown) => setMockSettingValue(key, next),
            ],
            useSettings: () => ({ ...settingsDefaults, ...settingsState }) as unknown as import('@/sync/domains/settings/settings').Settings,
        });
    });
}

vi.mock('@/sync/domains/state/persistence', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        loadNewSessionDraft: () => loadNewSessionDraftMock(),
        saveNewSessionDraft: (draft: unknown) => saveNewSessionDraftMock(draft),
        clearNewSessionDraft: () => clearNewSessionDraftMock(),
    };
});

vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
    machineContributionRegistryProjectionDescribe: (...args: unknown[]) =>
        machineContributionRegistryProjectionDescribeMock(...args),
}));

vi.mock('@/scm/scmRepositoryService', () => ({
    scmRepositoryService: {
        readCachedSnapshotForMachinePath: readCachedSnapshotForMachinePathMock,
        fetchSnapshotForMachinePath: fetchSnapshotForMachinePathMock,
        readCachedWorktreesEnrichment: readCachedWorktreesEnrichmentMock,
        fetchWorktreesEnrichment: fetchWorktreesEnrichmentMock,
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
                : target?.kind === 'builtInAgent'
                    ? `agent:${String(target.agentId ?? '')}`
                    : target?.kind === 'backend'
                        ? (target.configuredBackendId
                            ? `backend:${String(target.backendId ?? '')}:configured:${String(target.configuredBackendId ?? '')}`
                            : `backend:${String(target.backendId ?? '')}`)
                        : 'unknown:unknown';
            const explicitCompatibility = profile?.compatibilityByTargetKey?.[targetKey];
            if (typeof explicitCompatibility === 'boolean') {
                return explicitCompatibility;
            }
            const legacyCompatibility = target?.kind === 'builtInAgent'
                ? profile?.compatibility?.[String(target.agentId ?? '')]
                : target?.kind === 'backend' && !target.configuredBackendId
                    ? profile?.compatibility?.[String(target.backendId ?? '')]
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
    useCLIDetection: () => ({
        available: { codex: true, claude: true } as any,
        login: {} as any,
        authStatus: {} as any,
        resolvedPath: {} as any,
        resolvedCommand: {} as any,
        resolutionSource: {} as any,
        tmux: null,
        isDetecting: false,
        timestamp: 123,
        refresh: vi.fn(),
    }),
}));

vi.mock('@/hooks/machine/useMachineEnvPresence', () => ({
    useMachineEnvPresence: () => ({ isPreviewEnvSupported: true, isLoading: false, meta: {}, refresh: vi.fn() }),
}));

vi.mock('@/hooks/server/useMachineCapabilitiesCache', () => ({
    useMachineCapabilitiesCache: () => ({ state: { status: 'idle' }, refresh: vi.fn() }),
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
        agent: {
            setAgentType: params.setAgentType,
            onAgentPickerSelect: params.onAgentPickerSelect,
        },
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
    useNewSessionServerTargetState: (args: { request?: unknown }) => {
        targetServerRequestState.requests.push(args.request);
        return {
        serverProfiles: [],
        serverTargets: [],
        resolvedSettingsTarget: { allowedServerIds: [] },
        allowedTargetServerIds: targetServerState.allowedTargetServerIds,
        targetServerId: targetServerState.targetServerId,
        targetServerProfile: null,
        targetServerName: targetServerState.targetServerName,
        showServerPickerChip: targetServerState.allowedTargetServerIds.length > 1 && !!targetServerState.targetServerName,
        };
    },
}));

vi.mock('@/hooks/server/useAutomationsSupport', () => ({
    useAutomationsSupport: () => ({ enabled: featureFlags.automationsEnabled }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => {
        if (featureId === 'mcp.servers') return featureFlags.mcpServersEnabled;
        if (featureId === 'sessions.direct') return featureFlags.externalSessionsEnabled;
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

vi.mock('@/components/sessions/new/hooks/newSessionModelModePolicy', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return actual;
});

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
    isProfileEnabled: (profile: { id: string; defaultEnabled?: boolean }, profileEnabledById?: Record<string, boolean> | null) => {
        const override = profileEnabledById?.[profile.id];
        if (typeof override === 'boolean') return override;
        return profile.defaultEnabled !== false;
    },
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

installNewSessionScreenModelStorageMock();

const useNewSessionScreenModelModulePromise = import('./useNewSessionScreenModel');

async function runFocusEffects(): Promise<Array<void | (() => void)>> {
    return await Promise.all(focusEffectRef.current.map((effect) => effect()));
}

describe('useNewSessionScreenModel (draft hydration)', () => {
    afterEach(() => {
        standardCleanup();
    });

    beforeEach(() => {
        machineContributionRegistryProjectionDescribeMock.mockReset();
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({ supported: false, reason: 'not-supported' });

        platformOsState.value = 'web';
        modalShowMock.mockReset();
        modalAlertMock.mockReset();
        openExternalSessionsResumeIdPickerModalMock.mockReset();
        openExternalSessionsResumeIdPickerModalMock.mockResolvedValue('session-picked');
        fireAndForgetState.promises = [];
        tryShowDaemonUnavailableAlertForRpcErrorMock.mockReset();
        tryShowDaemonUnavailableAlertForRpcErrorMock.mockReturnValue(false);
        interactionQueueState.callbacks = [];
        focusEffectRef.current = [];
        activeServerAccountScopeState.value = { serverId: 'server-a', accountId: 'account-a' };
        routerPushMock.mockClear();
        routerSetParamsMock.mockClear();
        featureFlags.mcpServersEnabled = false;
        featureFlags.automationsEnabled = false;
        featureFlags.externalSessionsEnabled = false;
        persistDraftNowRef.current = null;
        saveNewSessionDraftMock.mockClear();
        clearNewSessionDraftMock.mockClear();
        loadNewSessionDraftMock.mockClear();
        readCachedSnapshotForMachinePathMock.mockReset();
        readCachedSnapshotForMachinePathMock.mockImplementation(() => repoSnapshotState.value);
        fetchSnapshotForMachinePathMock.mockReset();
        fetchSnapshotForMachinePathMock.mockImplementation(async () => repoSnapshotState.value);
        readCachedWorktreesEnrichmentMock.mockReset();
        readCachedWorktreesEnrichmentMock.mockReturnValue(null);
        fetchWorktreesEnrichmentMock.mockReset();
        fetchWorktreesEnrichmentMock.mockImplementation(async () => []);
        machineMcpServersPreviewMock.mockClear();
        searchParamsState.value = {};
        tempSessionDataState.value = null;
        targetServerState.allowedTargetServerIds = [];
        targetServerState.targetServerId = null;
        targetServerState.targetServerName = null;
        targetServerRequestState.requests = [];
        activeMachinesState.value = [
            { id: 'machine-1', metadata: { displayName: 'Machine One', host: 'one', homeDir: '/home/one' } },
            { id: 'machine-2', metadata: { displayName: 'Machine Two', host: 'two', homeDir: '/home/two' } },
        ];
        machineListByServerIdState.value = {};
        delete (persistedDraft as any).backendTarget;
        delete persistedDraft.targetServerId;
        delete persistedDraft.windowsRemoteSessionLaunchModeOverride;
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
        persistedDraft.modelMode = 'default';
        persistedDraft.acpSessionModeId = 'plan';
        persistedDraft.sessionConfigOptionOverrides = {
            v: 1,
            updatedAt: 123,
            overrides: {
                speed: { updatedAt: 123, value: 'fast' },
            },
        };
        settingsState.acpCatalogSettingsV1 = {
            v: 2,
            backends: [],
        };
        settingsState.useEnhancedSessionWizard = false;
        settingsState.useProfiles = false;
        (settingsState as any).rememberLastEngineSelectionsV1 = settingsDefaults.rememberLastEngineSelectionsV1;
        (settingsState as any).lastEngineSelectionsByScopeV1 = settingsDefaults.lastEngineSelectionsByScopeV1;
        settingsState.lastUsedProfile = null;
        settingsState.profileEnabledById = {};
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
        if (!checkoutChip) return undefined;

        // Prefer the stable chip contract rather than depending on render-tree structure.
        const labelFromPopover = (checkoutChip as any)?.collapsedOptionsPopover?.label;
        if (typeof labelFromPopover === 'string' && labelFromPopover.length > 0) {
            return labelFromPopover;
        }

        if (typeof (checkoutChip as any)?.collapsedAction === 'function') {
            const action = (checkoutChip as any).collapsedAction({
                tint: '#000',
                dismiss: () => {},
                blurInput: () => {},
            });
            const item = Array.isArray(action) ? action[0] : action;
            const label = item?.label;
            if (typeof label === 'string' && label.length > 0) return label;
        }

        // Fallback: render the chip and locate the label node.
        const chipElement = checkoutChip.render({
            chipStyle: () => null,
            showLabel: true,
            iconColor: '#000',
            textStyle: {},
            countTextStyle: {},
            popoverAnchorRef: { current: null },
        }) as React.ReactElement<{ children?: React.ReactNode }> | undefined;
        if (!chipElement) return undefined;
        const renderedChildren = React.Children.toArray((chipElement as any)?.props?.children) as any[];
        const textNode = renderedChildren.find((child) => child && typeof child === 'object' && 'props' in child && (child as any).props?.children);
        return (textNode as any)?.props?.children;
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

    it('applies the daemon contribution registry projection to agent picker labels without blanking while fetching', async () => {
        let resolveProjection:
            | ((value: Readonly<{ supported: true; projection: unknown }> | Readonly<{ supported: false; reason: string }>) => void)
            | null = null;

        machineContributionRegistryProjectionDescribeMock.mockImplementation(() => {
            return new Promise((resolve) => {
                resolveProjection = resolve as any;
            });
        });

        let model: any = null;
        await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalled();

        const initialLabels = (model?.simpleProps?.agentPickerOptions ?? []).map((o: any) => o?.label);
        expect(initialLabels).not.toContain('Codex (Projected)');

        await act(async () => {
            resolveProjection?.({
                supported: true,
                projection: {
                    v: 1,
                    providersById: {},
                    backendsById: {
                        codex: {
                            id: 'codex',
                            providerId: 'codex',
                            title: 'Codex (Projected)',
                            subtitle: null,
                            providerAgentId: null,
                            iconAgentId: null,
                        },
                    },
                },
            });
        });

        await settleNewSessionScreenModel();

        const nextLabels = (model?.simpleProps?.agentPickerOptions ?? []).map((o: any) => o?.label);
        expect(nextLabels).toContain('Codex (Projected)');
    });

    it('keeps daemon contribution projections cached per server scope for the same machine id', async () => {
        targetServerState.allowedTargetServerIds = ['server-a', 'server-b'];
        targetServerState.targetServerId = 'server-a';
        targetServerState.targetServerName = 'Server A';
        machineContributionRegistryProjectionDescribeMock.mockImplementation(async (_machineId: string, options?: { serverId?: string | null }) => ({
            supported: true,
            projection: {
                v: 1,
                providersById: {},
                backendsById: {
                    codex: {
                        id: 'codex',
                        providerId: 'codex',
                        title: options?.serverId === 'server-b' ? 'Codex (Projected B)' : 'Codex (Projected A)',
                        subtitle: null,
                        providerAgentId: null,
                        iconAgentId: null,
                    },
                },
            },
        }));

        let model: any = null;
        const hook = await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });
        await settleNewSessionScreenModel();

        expect((model?.simpleProps?.agentPickerOptions ?? []).map((o: any) => o?.label)).toContain('Codex (Projected A)');

        targetServerState.targetServerId = 'server-b';
        targetServerState.targetServerName = 'Server B';

        await hook.rerender();
        await settleNewSessionScreenModel();

        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('machine-2', expect.objectContaining({ serverId: 'server-a' }));
        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('machine-2', expect.objectContaining({ serverId: 'server-b' }));
        expect((model?.simpleProps?.agentPickerOptions ?? []).map((o: any) => o?.label)).toContain('Codex (Projected B)');
    });

    it('keeps a routed plugin backend selected during projection loading and switches create-session carrier when projection metadata arrives', async () => {
        let resolveProjection:
            | ((value: Readonly<{ supported: true; projection: unknown }> | Readonly<{ supported: false; reason: string }>) => void)
            | null = null;

        searchParamsState.value = {
            backendTargetKey: 'backend:acme.review.backend',
            backendTarget: JSON.stringify({
                kind: 'backend',
                backendId: 'acme.review.backend',
            }),
        };
        machineContributionRegistryProjectionDescribeMock.mockImplementation(() => {
            return new Promise((resolve) => {
                resolveProjection = resolve as any;
            });
        });

        let model: any = null;
        await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        expect(useCreateNewSessionArgsRef.current).toEqual(expect.objectContaining({
            backendTarget: expect.objectContaining({ kind: 'backend', backendId: 'acme.review.backend' }),
            spawnBackendTarget: expect.objectContaining({ kind: 'backend', backendId: 'acme.review.backend' }),
        }));
        expect(model?.simpleProps?.agentType).not.toBe('customAcp');

        await act(async () => {
            resolveProjection?.({
                supported: true,
                projection: {
                    v: 1,
                    providersById: {
                        'plugin:acme.review': {
                            providerId: 'plugin:acme.review',
                            title: 'Acme Review',
                            subtitle: null,
                            channel: 'plugin',
                            isBuiltIn: false,
                            providerAgentId: 'claude',
                            iconAgentId: 'claude',
                        },
                    },
                    backendsById: {
                        'acme.review.backend': {
                            id: 'acme.review.backend',
                            providerId: 'plugin:acme.review',
                            title: 'Acme Review Backend',
                            subtitle: null,
                            providerAgentId: 'claude',
                            iconAgentId: 'claude',
                        },
                    },
                },
            });
        });

        await settleNewSessionScreenModel();

        expect(useCreateNewSessionArgsRef.current).toEqual(expect.objectContaining({
            agentType: 'claude',
            backendTarget: expect.objectContaining({ kind: 'backend', backendId: 'acme.review.backend' }),
            spawnBackendTarget: expect.objectContaining({ kind: 'backend', backendId: 'acme.review.backend' }),
        }));
    });

    it('clears stale daemon contribution projections when the selected machine becomes unavailable', async () => {
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: {
                v: 1,
                providersById: {},
                backendsById: {
                    codex: {
                        id: 'codex',
                        providerId: 'codex',
                        title: 'Codex (Projected)',
                        subtitle: null,
                        providerAgentId: null,
                        iconAgentId: null,
                    },
                },
            },
        });

        let model: any = null;
        const hook = await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });
        await settleNewSessionScreenModel();

        expect((model?.simpleProps?.agentPickerOptions ?? []).map((o: any) => o?.label)).toContain('Codex (Projected)');

        activeMachinesState.value = [];
        await hook.rerender();
        await settleNewSessionScreenModel();

        expect((model?.simpleProps?.agentPickerOptions ?? []).map((o: any) => o?.label)).not.toContain('Codex (Projected)');
    });

    it('clears remembered Claude plan mode when the user switches the new-session mode back to build', async () => {
        const backendTarget = { kind: 'backend' as const, backendId: 'claude' as const };
        const scopeKey = buildRememberedEngineSelectionScopeKey({
            serverId: null,
            backendTarget,
        });
        (settingsState as any).rememberLastEngineSelectionsV1 = true;
        (settingsState as any).lastEngineSelectionsByScopeV1 = {
            [scopeKey]: {
                v: 1,
                modelId: 'default',
                acpSessionModeId: 'plan',
                sessionConfigOptionOverrides: null,
                updatedAt: 1,
            },
        };
        persistedDraft.backendTarget = backendTarget as any;
        persistedDraft.acpSessionModeId = 'plan';

        let model: any = null;
        await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        expect(model?.simpleProps?.agentType).toBe('claude');
        expect(model?.simpleProps?.acpSessionModeId).toBe('plan');

        await act(async () => {
            model?.simpleProps?.setAcpSessionModeId?.(null);
        });
        await settleNewSessionScreenModel({ cycles: 2, turns: 2 });

        expect(model?.simpleProps?.acpSessionModeId).toBeNull();

        standardCleanup();

        expect((settingsState as any).lastEngineSelectionsByScopeV1?.[scopeKey]?.acpSessionModeId).toBeNull();
    });

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
        expect(model?.simpleProps?.checkoutCreationDraft).toEqual({
            kind: 'git_worktree',
            displayName: 'feature/auth',
            baseRef: 'main',
            branchMode: 'new',
        });
        expect(getCheckoutChipLabel(model)).toBe('newSession.checkout.newWorktree');

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

    it('passes the persisted target server to the server target resolver when the route has no override', async () => {
        persistedDraft.targetServerId = 'server-b' as any;

        await renderNewSessionScreenModel(() => {});

        expect(targetServerRequestState.requests.at(-1)).toEqual(expect.objectContaining({
            persistedTargetServerId: 'server-b',
        }));
    });

    it('passes both route and persisted target servers so the resolver can prefer the route override', async () => {
        persistedDraft.targetServerId = 'server-b' as any;
        searchParamsState.value = {
            spawnServerId: 'server-c',
        };

        await renderNewSessionScreenModel(() => {});

        expect(targetServerRequestState.requests.at(-1)).toEqual(expect.objectContaining({
            spawnServerIdParam: 'server-c',
            persistedTargetServerId: 'server-b',
        }));
    });

    it('persists the selected target server and matching Windows launch override with the new-session draft', async () => {
        targetServerState.allowedTargetServerIds = ['server-a', 'server-b'];
        targetServerState.targetServerId = 'server-b';
        targetServerState.targetServerName = 'Server B';
        persistedDraft.windowsRemoteSessionLaunchModeOverride = {
            machineId: 'machine-2',
            mode: 'console',
        } as any;

        await renderNewSessionScreenModel(() => {});

        await act(async () => {
            persistDraftNowRef.current?.();
        });

        expect(saveNewSessionDraftMock.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
            targetServerId: 'server-b',
            windowsRemoteSessionLaunchModeOverride: {
                machineId: 'machine-2',
                mode: 'console',
            },
        }));
    });

    it('does not persist a Windows launch override from a different machine', async () => {
        persistedDraft.windowsRemoteSessionLaunchModeOverride = {
            machineId: 'machine-1',
            mode: 'console',
        } as any;

        await renderNewSessionScreenModel(() => {});

        await act(async () => {
            persistDraftNowRef.current?.();
        });

        expect(saveNewSessionDraftMock.mock.calls.at(-1)?.[0]).not.toEqual(expect.objectContaining({
            windowsRemoteSessionLaunchModeOverride: expect.anything(),
        }));
    });

    it('keeps the default attachment flow id stable across new-session route remounts', async () => {
        let firstModel: any = null;
        const firstHook = await renderNewSessionScreenModel((nextModel) => {
            firstModel = nextModel;
        });
        const firstAttachmentFlowId = firstModel?.simpleProps?.attachmentFlowId;
        expect(typeof firstAttachmentFlowId).toBe('string');
        expect(firstAttachmentFlowId.length).toBeGreaterThan(0);

        await firstHook.unmount();

        let secondModel: any = null;
        const secondHook = await renderNewSessionScreenModel((nextModel) => {
            secondModel = nextModel;
        });

        expect(secondModel?.simpleProps?.attachmentFlowId).toBe(firstAttachmentFlowId);

        await secondHook.unmount();
    });

    it('does not invalidate the screen model when focus reloads an equivalent draft', async () => {
        let renderCount = 0;

        await renderNewSessionScreenModel(() => {
            renderCount += 1;
        });

        const renderedCount = renderCount;

        const cleanups = await runFocusEffectsAndSettle();
        for (const cleanup of cleanups) {
            if (typeof cleanup === 'function') cleanup();
        }

        expect(loadNewSessionDraftMock).toHaveBeenCalled();
        expect(renderCount).toBeLessThanOrEqual(renderedCount + 1);
    });

    it('keeps the typed path draft available to session creation before the path is committed', async () => {
        let model: any = null;
        await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        const content = model?.simpleProps?.pathPopover?.renderContent?.({
            requestClose: () => {},
        });
        expect(content).toBeTruthy();

        act(() => {
            content.props.onChangeDraftSelectedPath('/repo/custom/subdir');
        });

        expect(model?.simpleProps?.selectedPath).toBe('/repo/custom');
        expect(useCreateNewSessionArgsRef.current).toEqual(expect.objectContaining({
            selectedPath: '/repo/custom',
            getRequestedPath: expect.any(Function),
        }));
        expect((useCreateNewSessionArgsRef.current?.getRequestedPath as (() => string) | undefined)?.()).toBe('/repo/custom/subdir');
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
        expect(model?.simpleProps?.checkoutCreationDraft).toEqual({
            kind: 'git_worktree',
            displayName: 'feature/first-render-fix',
            baseRef: 'main',
            branchMode: 'new',
        });
        expect(getCheckoutChipLabel(model)).toBe('newSession.checkout.newWorktree');
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
            backendTarget: { kind: 'backend', backendId: 'codex' },
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
            authoringDraft: expect.objectContaining({
                directory: '/repo/edit-seed',
                backendTarget: expect.objectContaining({ kind: 'backend', backendId: 'codex' }),
                prompt: 'Review the open pull requests',
                displayText: 'Review the open pull requests',
            }),
        }));

        await act(async () => {
            persistDraftNowRef.current?.();
        });

        expect(saveNewSessionDraftMock).toHaveBeenCalledWith(expect.objectContaining({
            input: 'Review the open pull requests',
            selectedMachineId: 'machine-1',
            selectedPath: '/repo/edit-seed',
            backendTarget: { kind: 'backend', backendId: 'codex' },
            permissionMode: 'acceptEdits',
            automationDraft: expect.objectContaining({
                enabled: true,
                name: 'PR review',
                everyMinutes: 30,
            }),
        }));
    });

    it('lets contextual temp seed data replace persisted selections while preserving draft content', async () => {
        searchParamsState.value = {
            dataId: 'session-config-seed',
        };
        persistedDraft.input = 'Persisted prompt';
        persistedDraft.selectedMachineId = 'machine-2';
        persistedDraft.selectedPath = '/repo/persisted';
        persistedDraft.agentType = 'claude';
        persistedDraft.backendTarget = { kind: 'backend', backendId: 'claude' } as any;
        persistedDraft.permissionMode = 'yolo';
        persistedDraft.resumeSessionId = 'resume-persisted';
        tempSessionDataState.value = {
            prompt: '',
            machineId: 'machine-1',
            directory: '/repo/from-session',
            agentType: 'codex',
            backendTarget: { kind: 'backend', backendId: 'codex' },
            permissionMode: 'acceptEdits',
            modelMode: 'gpt-5',
            acpSessionModeId: 'plan',
            replacePersistedDraftSelections: true,
        };

        let model: any = null;
        await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        expect(model?.simpleProps?.sessionPrompt).toBe('Persisted prompt');
        expect(model?.simpleProps?.agentType).toBe('codex');
        expect(model?.simpleProps?.permissionMode).toBe('acceptEdits');
        expect(model?.simpleProps?.selectedPath).toBe('/repo/from-session');
        expect(model?.simpleProps?.machineName).toBe('Machine One');
        expect(model?.simpleProps?.resumeSessionId).toBe('');
        expect(useCreateNewSessionArgsRef.current).toEqual(expect.objectContaining({
            authoringDraft: expect.objectContaining({
                prompt: 'Persisted prompt',
                displayText: 'Persisted prompt',
                agentId: 'codex',
                backendTarget: { kind: 'backend', backendId: 'codex' },
                permissionMode: 'acceptEdits',
                modelId: 'gpt-5',
                acpSessionModeId: 'plan',
                resumeSessionId: null,
            }),
        }));
        expect(loadNewSessionDraftMock).toHaveBeenCalled();
    });

    it('persists configured backend autosave drafts with the canonical backend target carrier', async () => {
        settingsState.lastUsedAgent = 'codex';
        settingsState.acpCatalogSettingsV1 = {
            v: 2,
            backends: [
                {
                    id: 'review-bot',
                    name: 'review-bot',
                    title: 'Review Bot',
                    command: 'custom-acp',
                    args: ['serve'],
                    env: {},
                    transportProfile: 'generic',
                    capabilities: {
                        supportsLoadSession: false,
                        supportsModes: 'unknown',
                        supportsModels: 'unknown',
                        supportsConfigOptions: 'unknown',
                        promptImageSupport: 'unknown',
                    },
                    createdAt: 1,
                    updatedAt: 1,
                },
            ],
        };
        persistedDraft.agentType = 'codex';
        (persistedDraft as any).backendTarget = { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' };

        let model: any = null;
        await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        expect(model?.simpleProps?.agentType).toBe('codex');
        expect(model?.simpleProps?.agentLabel).toBe('Review Bot');
        await settleNewSessionScreenModel();
        expect(useCreateNewSessionArgsRef.current).toEqual(expect.objectContaining({
            authoringDraft: expect.objectContaining({
                agentId: 'codex',
                backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
            }),
        }));

        await act(async () => {
            persistDraftNowRef.current?.();
        });

        expect(saveNewSessionDraftMock.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
            agentType: 'codex',
            backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
        }));
    });

    it('hydrates the selected backend from backendTargetKey route params while keeping the configured backend label', async () => {
        settingsState.lastUsedAgent = 'claude';
        settingsState.acpCatalogSettingsV1 = {
            v: 2,
            backends: [
                {
                    id: 'review-bot',
                    name: 'review-bot',
                    title: 'Review Bot',
                    command: 'custom-acp',
                    args: ['serve'],
                    env: {},
                    transportProfile: 'generic',
                    capabilities: {
                        supportsLoadSession: false,
                        supportsModes: 'unknown',
                        supportsModels: 'unknown',
                        supportsConfigOptions: 'unknown',
                        promptImageSupport: 'unknown',
                    },
                    createdAt: 1,
                    updatedAt: 1,
                },
            ],
        };
        persistedDraft.agentType = 'claude';
        delete (persistedDraft as any).backendTarget;
        searchParamsState.value = {
            backendTargetKey: 'backend:review-bot:configured:review-bot',
        };

        let model: any = null;
        await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        expect(model?.simpleProps?.agentType).toBe('claude');
        expect(model?.simpleProps?.agentLabel).toBe('Review Bot');
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
            backendTarget: expect.objectContaining({ kind: 'backend', backendId: 'claude' }),
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
        persistedDraft.backendTarget = { kind: 'backend', backendId: 'claude' } as any;

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
            backendTarget: expect.objectContaining({ kind: 'backend', backendId: 'claude' }),
            selectedMachineId: 'machine-2',
            selectedPath: '/repo/custom',
        }));
        expect(saveNewSessionDraftMock.mock.calls.at(-1)?.[0]).toEqual(expect.not.objectContaining({
            selectedWorkspaceId: expect.anything(),
            selectedWorkspaceLocationId: expect.anything(),
            selectedWorkspaceCheckoutId: expect.anything(),
        }));
    });

    it('round-trips the canonical configured backend target when opening profile edit', async () => {
        settingsState.useProfiles = true;
        settingsState.useEnhancedSessionWizard = true;
        settingsState.acpCatalogSettingsV1 = {
            v: 2,
            backends: [
                {
                    id: 'review-bot',
                    name: 'review-bot',
                    title: 'Review Bot',
                    command: 'custom-acp',
                    args: ['serve'],
                    env: {},
                    transportProfile: 'generic',
                    capabilities: {
                        supportsLoadSession: false,
                        supportsModes: 'unknown',
                        supportsModels: 'unknown',
                        supportsConfigOptions: 'unknown',
                        promptImageSupport: 'unknown',
                    },
                    createdAt: 1,
                    updatedAt: 1,
                },
            ],
        };
        persistedDraft.agentType = 'customAcp';
        (persistedDraft as any).backendTarget = { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' };

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
                backendTargetKey: 'backend:review-bot:configured:review-bot',
            }),
        }));
        expect(routerPushMock.mock.calls.at(-1)?.[0]?.params?.backendTarget).toContain('"configuredBackendId":"review-bot"');
    });

    it('drops stale configured backend route params after switching to a built-in backend before opening profile edit', async () => {
        settingsState.useProfiles = true;
        settingsState.useEnhancedSessionWizard = true;
        persistedDraft.agentType = 'claude';
        (persistedDraft as any).backendTarget = { kind: 'builtInAgent', agentId: 'claude' };
        searchParamsState.value = {
            agentType: 'customAcp',
            backendTargetKey: 'backend:stale-review-bot:configured:stale-review-bot',
            backendTarget: JSON.stringify({ kind: 'backend', backendId: 'stale-review-bot', configuredBackendId: 'stale-review-bot' }),
        };

        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        expect(model?.variant).toBe('wizard');
        expect(typeof model?.wizardProps?.profiles?.openProfileEdit).toBe('function');
        expect(typeof model?.wizardProps?.agent?.setAgentType).toBe('function');

        await act(async () => {
            model?.wizardProps?.agent?.setAgentType?.('codex');
        });

        await act(async () => {
            model?.wizardProps?.profiles?.openProfileEdit?.({});
            await flushInteractionQueue();
        });

        const pushPayload = routerPushMock.mock.calls.at(-1)?.[0];
        expect(pushPayload).toEqual(expect.objectContaining({
            pathname: '/new/pick/profile-edit',
            params: expect.objectContaining({
                agentType: 'codex',
                machineId: 'machine-2',
            }),
        }));
        expect(pushPayload?.params?.backendTarget).toContain('"backendId":"codex"');
        expect(pushPayload?.params?.backendTarget).not.toContain('stale-review-bot');
        expect(pushPayload?.params?.backendTargetKey).toBe('backend:codex');
    });

    it('clears backend route seed params after an explicit agent picker selection', async () => {
        searchParamsState.value = {
            agentType: 'codex',
        };
        persistedDraft.agentType = 'claude';
        persistedDraft.backendTarget = { kind: 'backend', backendId: 'claude' } as any;

        let model: any = null;
        const hook = await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        expect(model?.simpleProps?.agentType).toBe('codex');

        const claudeOption = model?.simpleProps?.agentPickerOptions?.find?.((option: { id: string }) => option.id === 'backend:claude');
        expect(claudeOption).toBeTruthy();

        await act(async () => {
            claudeOption?.onSelectImmediate?.();
            await settleNewSessionScreenModel({ cycles: 1, turns: 2 });
        });

        expect(model?.simpleProps?.agentType).toBe('claude');
        expect(routerSetParamsMock).toHaveBeenCalledWith({
            agentType: undefined,
            backendTarget: undefined,
            backendTargetKey: undefined,
        });

        await hook.unmount();
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

    it('lets the path picker own scrolling and edge fades inside the shared path popover', async () => {
        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        expect(model?.simpleProps?.pathPopover?.scrollEnabled).toBe(false);
        expect(model?.simpleProps?.pathPopover?.edgeFades).toBeUndefined();
        expect(model?.simpleProps?.pathPopover?.edgeIndicators).toBeUndefined();
        expect(model?.simpleProps?.pathPopover?.initialVisibility).toBeUndefined();
    });

    it('keeps the path popover mounted when opening the tree browser', async () => {
        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        const requestClose = vi.fn();
        const element = model?.simpleProps?.pathPopover?.renderContent?.({ requestClose });
        expect(element).toBeTruthy();
        expect((element.type as { name?: string }).name).toBe('NewSessionPathSelectionContent');

        const props = element.props as { onBeforeBrowseMachinePath?: unknown };
        expect(props.onBeforeBrowseMachinePath).not.toBe(requestClose);
        expect(props.onBeforeBrowseMachinePath).toBeUndefined();
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

    it('opens the shared direct-sessions resume browser modal from the resume popover without navigating away', async () => {
        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;
        const portalTarget = { tag: 'new-session-parent-modal-target' } as unknown as Element;
        featureFlags.externalSessionsEnabled = true;

        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await renderScreen(
            <ModalPortalTargetProvider target={portalTarget}>
                <Probe />
            </ModalPortalTargetProvider>,
        );

        const requestClose = vi.fn();
        const rendered = model?.simpleProps?.resumePopover?.renderContent?.({ requestClose });
        expect(rendered).toBeTruthy();
        if (!rendered) {
            throw new Error('expected resume popover content');
        }

        const popoverScreen = await renderScreen(rendered);
        await popoverScreen.pressByTestIdAsync('resume-id-browse-trigger');
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(requestClose).toHaveBeenCalledTimes(1);
        expect(openExternalSessionsResumeIdPickerModalMock).toHaveBeenCalledWith(expect.objectContaining({
            webPortalTarget: portalTarget,
            lockScope: expect.objectContaining({
                machineId: 'machine-2',
                providerId: 'claude',
                source: expect.objectContaining({
                    kind: 'claudeConfig',
                }),
            }),
        }));
        expect(routerPushMock).not.toHaveBeenCalled();
        expect(model?.simpleProps?.resumeSessionId).toBe('session-picked');
    });

    it('hides the direct-sessions resume browse trigger when sessions.direct is disabled', async () => {
        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        const requestClose = vi.fn();
        const rendered = model?.simpleProps?.resumePopover?.renderContent?.({ requestClose });
        expect(rendered).toBeTruthy();
        if (!rendered) {
            throw new Error('expected resume popover content');
        }

        const popoverScreen = await renderScreen(rendered);
        expect(popoverScreen.findByTestId('resume-id-browse-trigger')).toBeNull();
        expect(openExternalSessionsResumeIdPickerModalMock).not.toHaveBeenCalled();
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
        expect(saveNewSessionDraftMock).toHaveBeenCalledTimes(0);

        await act(async () => {
            (useCreateNewSessionArgsRef.current?.disableDraftPersistence as (() => void) | undefined)?.();
            clearNewSessionDraftMock();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        await act(async () => {
            await flushInteractionQueue();
        });

        expect(clearNewSessionDraftMock).toHaveBeenCalledTimes(1);
        expect(saveNewSessionDraftMock).toHaveBeenCalledTimes(0);
    });

    it('does not persist a launch draft when the active account scope is cleared', async () => {
        activeServerAccountScopeState.value = null;
        loadNewSessionDraftMock.mockReturnValueOnce(null);

        let model: any = null;
        await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        await act(async () => {
            model?.simpleProps?.setPrompt?.('draft after logout');
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        await act(async () => {
            persistDraftNowRef.current?.();
        });

        expect(saveNewSessionDraftMock).toHaveBeenCalledTimes(0);
    });

    it('does not seed new-session profile selection from a disabled last-used profile', async () => {
        settingsState.useProfiles = true;
        settingsState.useEnhancedSessionWizard = true;
        settingsState.lastUsedProfile = 'profile_disabled';
        settingsState.profileEnabledById = { profile_disabled: false };
        settingsState.profiles = [{
            id: 'profile_disabled',
            name: 'Disabled profile',
            environmentVariables: [],
            defaultPermissionModeByAgent: {},
            defaultPermissionModeByTargetKey: {},
            defaultPersistenceModeByAgent: {},
            defaultPersistenceModeByTargetKey: {},
            isBuiltIn: false,
            compatibility: { claude: true },
            compatibilityByTargetKey: {},
            envVarRequirements: [],
            createdAt: 0,
            updatedAt: 0,
            version: '1.0.0',
        }];

        let model: any = null;
        await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        expect(model?.variant).toBe('wizard');
        expect(model?.wizardProps?.profiles?.selectedProfileId).toBeNull();
    });

    it('keeps the default environment selected even when a workspace graph still carries a legacy default profile', async () => {
        settingsState.useProfiles = true;
        settingsState.useEnhancedSessionWizard = true;
        settingsState.profiles = [{
            id: 'profile_workspace',
            name: 'Workspace profile',
            environmentVariables: [],
            defaultPermissionModeByAgent: {},
            defaultPermissionModeByTargetKey: {},
            defaultPersistenceModeByAgent: {},
            defaultPersistenceModeByTargetKey: {},
            isBuiltIn: false,
            compatibility: { claude: true },
            compatibilityByTargetKey: {},
            envVarRequirements: [],
            createdAt: 0,
            updatedAt: 0,
            version: '1.0.0',
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
                name: 'Workspace profile',
                environmentVariables: [],
                defaultPermissionModeByAgent: {},
                defaultPermissionModeByTargetKey: {},
                defaultPersistenceModeByAgent: {},
                defaultPersistenceModeByTargetKey: {},
                isBuiltIn: false,
                compatibility: { claude: true },
                compatibilityByTargetKey: {},
                envVarRequirements: [],
                createdAt: 0,
                updatedAt: 0,
                version: '1.0.0',
            },
            {
                id: 'profile_docs',
                name: 'Docs profile',
                environmentVariables: [],
                defaultPermissionModeByAgent: {},
                defaultPermissionModeByTargetKey: {},
                defaultPersistenceModeByAgent: {},
                defaultPersistenceModeByTargetKey: {},
                isBuiltIn: false,
                compatibility: { claude: true },
                compatibilityByTargetKey: {},
                envVarRequirements: [],
                createdAt: 0,
                updatedAt: 0,
                version: '1.0.0',
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
        await flushHookEffects({ cycles: 3, turns: 4 });

        try {
        await act(async () => {
            model?.simpleProps?.setCheckoutCreationDraft?.(null);
            await flushHookEffects({ cycles: 1, turns: 2 });
        });

            const checkoutChip = model?.simpleProps?.agentInputExtraActionChips?.find((chip: any) => chip?.key === 'new-session-checkout');
            expect(checkoutChip).toBeTruthy();
            expect(getCheckoutChipLabel(model)).toBe('newSession.checkout.noWorktree');

            const pickerPopover = (checkoutChip as any).collapsedOptionsPopover;
            expect(pickerPopover).toEqual(expect.objectContaining({
                presentation: 'list',
                title: 'newSession.checkout.selectTitle',
                label: 'newSession.checkout.noWorktree',
            }));
            const optionIds = [
                ...getCheckoutChipQuickActionIds(model),
                ...getCheckoutChipExistingWorktreeIds(model),
            ];
            expect(optionIds).toEqual([
                'current_path',
                'create_git_worktree',
            ]);

            const toggleCollapsedPopover = vi.fn();
            const screen = await renderScreen(
                React.createElement(React.Fragment, null, checkoutChip.render({
                    chipStyle: () => null,
                    showLabel: true,
                    iconColor: '#000',
                    textStyle: {},
                    countTextStyle: {},
                    popoverAnchorRef: { current: null },
                    chipAnchorRef: { current: null },
                    toggleCollapsedPopover,
                })),
            );
            screen.pressByTestId('new-session-checkout-chip');
            expect(toggleCollapsedPopover).toHaveBeenCalledWith('new-session-checkout');
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
        await flushHookEffects({ cycles: 3, turns: 4 });

        try {
            const checkoutChip = model?.simpleProps?.agentInputExtraActionChips?.find((chip: any) => chip?.key === 'new-session-checkout');
            expect(checkoutChip).toBeTruthy();

            const pickerPopover = (checkoutChip as any).collapsedOptionsPopover;
            expect(pickerPopover?.presentation).toBe('list');
            const optionIds = [
                ...getCheckoutChipQuickActionIds(model),
                ...getCheckoutChipExistingWorktreeIds(model),
            ];
            expect(optionIds).toEqual([
                'current_path',
                'create_git_worktree',
            ]);

            // With the shared overlay controller, "open" is bridged through ctx.toggleCollapsedPopover.
            const toggleCollapsedPopover = vi.fn();
            await renderScreen(
                React.createElement(React.Fragment, null, checkoutChip.render({
                    chipStyle: () => null,
                    showLabel: true,
                    iconColor: '#000',
                    textStyle: {},
                    countTextStyle: {},
                    popoverAnchorRef: { current: null },
                    chipAnchorRef: { current: null },
                    toggleCollapsedPopover,
                })),
            );
            await flushHookEffects({ cycles: 1, turns: 1 });
            expect(toggleCollapsedPopover).toHaveBeenCalledWith('new-session-checkout');
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
            expect(modalShowMock).not.toHaveBeenCalled();
            const optionIds = [
                ...getCheckoutChipQuickActionIds(model),
                ...getCheckoutChipExistingWorktreeIds(model),
            ];
            expect(optionIds).toContain('current_path');
            expect(getCheckoutChipExistingWorktreeIds(model).length).toBeGreaterThan(0);

            const toggleCollapsedPopover = vi.fn();
            const screen = await renderScreen(
                React.createElement(React.Fragment, null, checkoutChip.render({
                    chipStyle: () => null,
                    showLabel: true,
                    iconColor: '#000',
                    textStyle: {},
                    countTextStyle: {},
                    popoverAnchorRef: { current: null },
                    chipAnchorRef: { current: null },
                    toggleCollapsedPopover,
                })),
            );
            screen.pressByTestId('new-session-checkout-chip');
            expect(toggleCollapsedPopover).toHaveBeenCalledWith('new-session-checkout');
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
            const toggleCollapsedPopover = vi.fn();
            const screen = await renderScreen(
                React.createElement(React.Fragment, null, checkoutChip.render({
                    chipStyle: () => null,
                    showLabel: true,
                    iconColor: '#000',
                    textStyle: {},
                    countTextStyle: {},
                    popoverAnchorRef: { current: null },
                    chipAnchorRef: { current: null },
                    toggleCollapsedPopover,
                })),
            );
            screen.pressByTestId('new-session-checkout-chip');
            expect(toggleCollapsedPopover).toHaveBeenCalledWith('new-session-checkout');

            const optionIds = [
                ...getCheckoutChipQuickActionIds(model),
                ...getCheckoutChipExistingWorktreeIds(model),
            ];
            expect(optionIds).toContain('current_path');
            expect(getCheckoutChipExistingWorktreeIds(model).length).toBeGreaterThan(0);
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

    it('exposes the new-worktree branch drill-down without committing before branch selection', async () => {
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
            const checkoutChip = findSelectionListCheckoutChip(model);
            const createOption = findCheckoutChipOptionFromChip(checkoutChip, 'worktree:quick-actions', 'create_git_worktree');

            expect(createOption).toBeTruthy();
            expect(model?.simpleProps?.checkoutCreationDraft).toBeNull();
            expect(createOption && 'openStep' in createOption ? createOption.openStep?.id : undefined)
                .toBe('worktree-create');
            expect(model?.simpleProps?.checkoutCreationDraft).toBeNull();
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
        const getCheckoutChip = () => findSelectionListCheckoutChip(model);
        expect(getCheckoutChip()?.controlId).toBe('checkout');
        expect(getCheckoutChip()?.collapsedOptionsPopover?.title).toBe('newSession.checkout.selectTitle');
        const initialOptionIds = [
            ...getCheckoutChipQuickActionIds(model),
            ...getCheckoutChipExistingWorktreeIds(model),
        ];
        expect(initialOptionIds).toEqual([
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
        const updatedOptionIds = [
            ...getCheckoutChipQuickActionIds(model),
            ...getCheckoutChipExistingWorktreeIds(model),
        ];
        expect(updatedOptionIds).toEqual([
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

        const getCheckoutChip = () => findSelectionListCheckoutChip(model);
        const checkoutChip = getCheckoutChip();
        expect(checkoutChip).toBeTruthy();
        if (!checkoutChip) {
            throw new Error('Expected checkout chip to render');
        }
        expect(checkoutChip.controlId).toBe('checkout');
        expect(checkoutChip.collapsedOptionsPopover?.title).toBe('newSession.checkout.selectTitle');

        const renderChip = () => checkoutChip.render({
            chipStyle: () => null,
            showLabel: true,
            iconColor: '#000',
            textStyle: {},
            countTextStyle: {},
            popoverAnchorRef: { current: null },
        }) as React.ReactElement<{ children?: React.ReactNode }>;

        const optionIds = [
            ...getCheckoutChipQuickActionIds(model),
            ...getCheckoutChipExistingWorktreeIds(model),
        ];
        expect(optionIds).toEqual([
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

        const getCheckoutChip = () => findSelectionListCheckoutChip(model);
        expect(getCheckoutChip()?.controlId).toBe('checkout');
        expect(getCheckoutChip()?.collapsedOptionsPopover?.title).toBe('newSession.checkout.selectTitle');

        expect(model?.simpleProps?.selectedWorkspaceId).toBeUndefined();
        expect(model?.simpleProps?.selectedWorkspaceLocationId).toBeUndefined();
        expect(model?.simpleProps?.selectedWorkspaceCheckoutId).toBeUndefined();
        expect(getCheckoutChipLabel(model)).toBe('newSession.checkout.noWorktree');

        const checkoutChip = findSelectionListCheckoutChip(model);
        expect(checkoutChip).toBeTruthy();
        if (!checkoutChip) {
            throw new Error('Expected checkout chip to render');
        }

        const renderChip = () => checkoutChip.render({
            chipStyle: () => null,
            showLabel: true,
            iconColor: '#000',
            textStyle: {},
            countTextStyle: {},
            popoverAnchorRef: { current: null },
        }) as React.ReactElement<{ children?: React.ReactNode }>;

        const optionIds = [
            ...getCheckoutChipQuickActionIds(model),
            ...getCheckoutChipExistingWorktreeIds(model),
        ];
        expect(optionIds).toEqual([
            'current_path',
            'create_git_worktree',
        ]);
    });

    it('hydrates machine and path from the selected non-active target server cache', async () => {
        targetServerState.allowedTargetServerIds = ['server-a', 'server-b'];
        targetServerState.targetServerId = 'server-b';
        targetServerState.targetServerName = 'Server B';
        activeMachinesState.value = [
            { id: 'machine-1', metadata: { displayName: 'Machine One', host: 'one', homeDir: '/home/one' } },
        ];
        machineListByServerIdState.value = {
            'server-b': [
                {
                    id: 'machine-remote',
                    metadata: { displayName: 'Remote Builder', host: 'remote-builder', homeDir: '/srv/remote' },
                },
            ],
        };
        persistedDraft.selectedMachineId = 'machine-remote';
        persistedDraft.selectedPath = '/srv/remote/project';
        persistedDraft.selectedWorkspaceId = null as any;
        persistedDraft.selectedWorkspaceLocationId = null as any;
        persistedDraft.selectedWorkspaceCheckoutId = null as any;
        persistedDraft.checkoutCreationDraft = null;

        let model: any = null;
        await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        expect(model?.simpleProps?.machineName).toBe('Remote Builder');
        expect(model?.simpleProps?.selectedPath).toBe('/srv/remote/project');
    });

});
