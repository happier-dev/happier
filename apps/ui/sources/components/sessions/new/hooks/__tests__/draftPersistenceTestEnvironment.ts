import * as React from 'react';
import { act } from 'react-test-renderer';
import { vi } from 'vitest';

import type { FlushHookEffectsOptions } from '@/dev/testkit';
import { flushHookEffects, renderHook } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit';
import { settingsDefaults } from '@/sync/domains/settings/settings';

import { installNewSessionScreenModelCommonModuleMocks } from '../newSessionScreenModelTestHelpers';

/**
 * Shared test environment for the `useNewSessionScreenModel` draft-persistence
 * suites. Encapsulates the heavy mock graph + hoisted state so each focused
 * test file (path / checkout / core) imports a single module instead of
 * copy-pasting hundreds of lines of `vi.hoisted` / `vi.mock` boilerplate.
 *
 * The module installs all `vi.mock` graph entries on import; tests then call
 * `resetDraftPersistenceState()` from `beforeEach` to restore deterministic
 * fixtures between tests.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export type TestWorkspace = {
    id: string;
    displayName: string;
    locationIds: string[];
    checkoutIds: string[];
    defaultLocationId: string | null;
    defaultCheckoutId: string | null;
};

export type TestWorkspaceLocation = {
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

export type TestWorkspaceCheckout = {
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
    entryIntent?: unknown;
    codexBackendMode?: unknown;
    targetServerId?: string | null;
    windowsRemoteSessionLaunchModeOverride?: { machineId: string; mode: 'hidden' | 'windows_terminal' | 'console' } | null;
    launchUserAttemptId?: string;
});

const cliDetectionState = vi.hoisted(() => ({
    value: {
        available: { codex: true, claude: true } as Record<string, boolean>,
        login: {} as Record<string, unknown>,
        authStatus: {} as Record<string, unknown>,
        resolvedPath: {} as Record<string, unknown>,
        resolvedCommand: {} as Record<string, unknown>,
        resolutionSource: {} as Record<string, unknown>,
        tmux: null as unknown,
        isDetecting: false,
        timestamp: 123,
        refresh: vi.fn(),
    },
}));

const saveNewSessionDraftMock = vi.hoisted(() => vi.fn());
const clearNewSessionDraftMock = vi.hoisted(() => vi.fn());
const loadNewSessionDraftMock = vi.hoisted(() => vi.fn(() => JSON.parse(JSON.stringify(persistedDraft))));
const computeNewSessionInputMaxHeightMock = vi.hoisted(() => vi.fn((_params: unknown) => 100));
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
const allMachinesState = vi.hoisted(() => ({
    value: [
        { id: 'machine-1', metadata: { displayName: 'Machine One', host: 'one', homeDir: '/home/one' } } as Parameters<typeof createMachineFixture>[0],
        { id: 'machine-2', metadata: { displayName: 'Machine Two', host: 'two', homeDir: '/home/two' } } as Parameters<typeof createMachineFixture>[0],
    ],
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
        // Narrowed locally; tests routinely synthesise additional repo
        // worktree shapes so callers spread `repoSnapshotState.value` and
        // override `repo` as needed. `as any` here mirrors the legacy
        // single-suite cast at the fixture site.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
const activeServerAccountScopeState = vi.hoisted(() => ({
    value: { serverId: 'server-a', accountId: 'account-a' } as import('@/sync/domains/scope/serverAccountScope').ServerAccountScope | null,
}));
const accountProfileState = vi.hoisted(() => ({
    value: null as { id: string } | null,
}));

export const settingsState = {
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

function getMockStorageState() {
    return {
        settings: { ...settingsDefaults, ...settingsState },
        sessions: {},
        profileScope: activeServerAccountScopeState.value,
        createSessionActionDraft: createSessionActionDraftMock,
        workspaceLocations: workspaceGraphState.workspaceLocations,
        workspaceCheckouts: workspaceGraphState.workspaceCheckouts,
    };
}

export function notifyMockStorageSubscribers(): void {
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

vi.mock('@/sync/store/hooks', async (importOriginal) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const actual = await importOriginal<any>();
    return {
        ...actual,
        useActiveServerAccountScope: () => activeServerAccountScopeState.value,
        useProfile: () => accountProfileState.value,
    };
});

installNewSessionScreenModelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                get OS() {
                    return platformOsState.value;
                },
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const expoRouterMock = createExpoRouterMock({
            router: { push: routerPushMock, replace: vi.fn(), back: vi.fn(), setParams: routerSetParamsMock },
            params: () => searchParamsState.value as Record<string, string | string[] | undefined>,
            navigation: { setParams: routerSetParamsMock, dispatch: vi.fn() },
            pathname: '/new',
        });
        return expoRouterMock.module;
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
    useIsFocused: () => true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    useFocusEffect: (fn: any) => {
        focusEffectRef.current.push(fn);
    },
}));

vi.doMock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createPartialStorageModuleMock(importOriginal, {
        useAllMachines: () => allMachinesState.value.map((machine) => createMachineFixture(machine)),
        useLaunchSelectionMachines: () => allMachinesState.value.map((machine) => createMachineFixture(machine)),
        useSessionRecentPathEntries: () => [],
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        useSetting: (key: string) => ({ ...settingsDefaults, ...settingsState } as any)[key],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        useSettingMutable: (key: string) => [
            ({ ...settingsDefaults, ...settingsState } as any)[key],
            (next: unknown) => setMockSettingValue(key, next),
        ],
        useSettings: () => ({ ...settingsDefaults, ...settingsState }) as unknown as import('@/sync/domains/settings/settings').Settings,
    });
});

vi.mock('@/sync/domains/state/persistence', async (importOriginal) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const actual = await importOriginal<any>();
    return {
        ...actual,
        loadNewSessionDraft: () => loadNewSessionDraftMock(),
        saveNewSessionDraft: (draft: unknown) => saveNewSessionDraftMock(draft),
        clearNewSessionDraft: () => clearNewSessionDraftMock(),
    };
});

vi.mock('@/scm/scmRepositoryService', () => ({
    scmRepositoryService: {
        readCachedSnapshotForMachinePath: readCachedSnapshotForMachinePathMock,
        fetchSnapshotForMachinePath: fetchSnapshotForMachinePathMock,
        // RUX-12: the enrichment cache lookup runs as part of the light-snapshot
        // fast path in `useNewSessionRepoScmSnapshot`. Return `null` so the
        // resulting effect treats the cache as empty (no enrichment seeded);
        // tests that exercise enrichment behavior set their own implementation.
        readCachedWorktreesEnrichment: vi.fn(() => null),
        fetchWorktreesEnrichment: vi.fn(async () => null),
    },
}));

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => ['codex', 'claude'],
}));

vi.mock('@/agents/catalog/catalog', async (importOriginal) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const actual = await importOriginal<any>();
    return {
        ...actual,
        DEFAULT_AGENT_ID: 'codex',
        isAgentId: (value: unknown) => value === 'codex' || value === 'claude',
        resolveAgentIdFromCliDetectKey: () => 'codex',
        getAgentCore: (_agentId: string) => ({
            model: { defaultMode: 'default', allowedModes: ['default', 'gpt-5'], supportsFreeform: true },
            resume: { supportsVendorResume: false, experimental: false },
            sessionModes: _agentId === 'claude'
                ? {
                    kind: 'staticAgentModes',
                    staticOptions: [
                        { id: 'default', nameKey: 'agentInput.mode.build' },
                        { id: 'plan', nameKey: 'agentInput.mode.plan' },
                    ],
                }
                : { kind: 'none' },
            sessionStorage: { direct: true, persisted: true },
            cli: { detectKey: String(_agentId) },
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const actual = await importOriginal<any>();
    return {
        ...actual,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
        getProfileEnvironmentVariables: () => [],
        isProfileCompatibleWithAgent: () => true,
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
    useCLIDetection: () => cliDetectionState.value,
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    useNewSessionWizardProps: (params: any) => ({
        profiles: {
            selectedProfileId: params.selectedProfileId,
            getProfileSubtitleExtra: params.getProfileSubtitleExtra,
            onPressDefaultEnvironment: params.onPressDefaultEnvironment,
            onPressProfile: params.onPressProfile,
            handleAddProfile: params.handleAddProfile,
            openProfileEdit: params.openProfileEdit,
            handleDuplicateProfile: params.handleDuplicateProfile,
        },
        // Mirrors the real hook: wizard-only sections exist only for the wizard variant.
        wizardSections: params.enabled
            ? {
                layout: {},
                agent: {},
                machine: {},
                footer: {},
            }
            : null,
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
    useNewSessionServerTargetState: (params: { request?: { spawnServerIdParam?: string | null } }) => {
        const requestedServerId = typeof params.request?.spawnServerIdParam === 'string'
            ? params.request.spawnServerIdParam.trim()
            : '';
        const requestedServerAllowed = requestedServerId.length > 0
            && (targetServerState.allowedTargetServerIds.length === 0 || targetServerState.allowedTargetServerIds.includes(requestedServerId));
        const targetServerId = targetServerState.targetServerId ?? (requestedServerAllowed ? requestedServerId : null);

        return {
            serverProfiles: [],
            serverTargets: [],
            resolvedSettingsTarget: { allowedServerIds: targetServerState.allowedTargetServerIds },
            allowedTargetServerIds: targetServerState.allowedTargetServerIds,
            targetServerId,
            targetServerProfile: null,
            targetServerName: targetServerState.targetServerName ?? targetServerId,
            showServerPickerChip: targetServerState.allowedTargetServerIds.length > 1 && !!(targetServerState.targetServerName ?? targetServerId),
        };
    },
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const actual = await importOriginal<any>();
    return actual;
});

vi.mock('@/sync/domains/settings/settings', async (importOriginal) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const actual = await importOriginal<any>();
    return {
        ...actual,
        // Ensure non-enumerable exports used by persistence helpers are available on the mock.
        settingsDefaults: actual.settingsDefaults,
        isProfileCompatibleWithAnyAgent: () => true,
    };
});

vi.mock('@/sync/domains/profiles/profileUtils', () => ({
    getBuiltInProfile: () => null,
    DEFAULT_PROFILES: [],
    getProfilePrimaryCli: () => null,
    isProfileEnabled: (profile: { id: string; defaultEnabled?: boolean }, profileEnabledById?: Record<string, boolean> | null) => {
        const override = profileEnabledById?.[profile.id];
        return typeof override === 'boolean' ? override : profile.defaultEnabled !== false;
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
    computeNewSessionInputMaxHeight: (params: unknown) => computeNewSessionInputMaxHeightMock(params),
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const actual = await importOriginal<any>();
    return {
        ...actual,
        AGENTS_CORE: actual.AGENTS_CORE ?? {},
    };
});

vi.mock('@/utils/sessions/tempDataStore', () => ({
    getTempData: () => tempSessionDataState.value,
}));

// Cached module promise so each focused suite imports the production hook once
// per worker; vitest re-evaluates the test file per worker as expected.
export const useNewSessionScreenModelModulePromise = import('../useNewSessionScreenModel');

export async function runFocusEffects(): Promise<Array<void | (() => void)>> {
    return await Promise.all(focusEffectRef.current.map((effect) => effect()));
}

/** Restores deterministic state for `beforeEach`. */
export function resetDraftPersistenceState(): void {
    platformOsState.value = 'web';
    modalShowMock.mockReset();
    modalAlertMock.mockReset();
    fireAndForgetState.promises = [];
    tryShowDaemonUnavailableAlertForRpcErrorMock.mockReset();
    tryShowDaemonUnavailableAlertForRpcErrorMock.mockReturnValue(false);
    interactionQueueState.callbacks = [];
    focusEffectRef.current = [];
    activeServerAccountScopeState.value = { serverId: 'server-a', accountId: 'account-a' };
    accountProfileState.value = null;
    routerPushMock.mockClear();
    routerSetParamsMock.mockClear();
    featureFlags.mcpServersEnabled = false;
    featureFlags.automationsEnabled = false;
    persistDraftNowRef.current = null;
    saveNewSessionDraftMock.mockClear();
    clearNewSessionDraftMock.mockClear();
    loadNewSessionDraftMock.mockClear();
    computeNewSessionInputMaxHeightMock.mockClear();
    readCachedSnapshotForMachinePathMock.mockReset();
    readCachedSnapshotForMachinePathMock.mockReturnValue(null);
    fetchSnapshotForMachinePathMock.mockReset();
    fetchSnapshotForMachinePathMock.mockImplementation(async () => repoSnapshotState.value);
    machineMcpServersPreviewMock.mockClear();
    searchParamsState.value = {};
    tempSessionDataState.value = null;
    allMachinesState.value = [
        { id: 'machine-1', metadata: { displayName: 'Machine One', host: 'one', homeDir: '/home/one' } } as Parameters<typeof createMachineFixture>[0],
        { id: 'machine-2', metadata: { displayName: 'Machine Two', host: 'two', homeDir: '/home/two' } } as Parameters<typeof createMachineFixture>[0],
    ];
    targetServerState.allowedTargetServerIds = [];
    targetServerState.targetServerId = null;
    targetServerState.targetServerName = null;
    delete persistedDraft.backendTarget;
    delete persistedDraft.codexBackendMode;
    delete persistedDraft.entryIntent;
    persistedDraft.agentType = 'claude';
    persistedDraft.input = 'hello';
    persistedDraft.permissionMode = 'yolo';
    delete persistedDraft.resumeSessionId;
    delete persistedDraft.targetServerId;
    delete persistedDraft.windowsRemoteSessionLaunchModeOverride;
    delete persistedDraft.launchUserAttemptId;
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
    cliDetectionState.value = {
        available: { codex: true, claude: true },
        login: {},
        authStatus: {},
        resolvedPath: {},
        resolvedCommand: {},
        resolutionSource: {},
        tmux: null,
        isDetecting: false,
        timestamp: 123,
        refresh: vi.fn(),
    };
    settingsState.useEnhancedSessionWizard = false;
    settingsState.useProfiles = false;
    (settingsState as any).rememberLastEngineSelectionsV1 = settingsDefaults.rememberLastEngineSelectionsV1;
    (settingsState as any).lastEngineSelectionsByScopeV1 = settingsDefaults.lastEngineSelectionsByScopeV1;
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
    };
    storageSubscriptionState.listeners.clear();
    createSessionActionDraftMock.mockClear();
}

export async function flushInteractionQueue(): Promise<void> {
    while (interactionQueueState.callbacks.length > 0) {
        const callback = interactionQueueState.callbacks.shift();
        callback?.();
        await settleNewSessionScreenModel();
    }
}

export async function settleNewSessionScreenModel(options: FlushHookEffectsOptions = {}): Promise<void> {
    await flushHookEffects({
        cycles: options.cycles ?? 3,
        turns: options.turns ?? 2,
        advanceTimersMs: options.advanceTimersMs,
        runAllTimers: options.runAllTimers,
        frames: options.frames,
    });
}

export async function runFocusEffectsAndSettle(): Promise<Array<void | (() => void)>> {
    let cleanups: Array<void | (() => void)> = [];

    await act(async () => {
        cleanups = await runFocusEffects();
    });
    await settleNewSessionScreenModel();

    return cleanups;
}

export async function renderNewSessionScreenModel(assignModel: (nextModel: unknown) => void): ReturnType<typeof renderHook> {
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

/**
 * Build a minimal test workspace descriptor matching the canonical shape
 * (single location/checkout). Caller-overridable fields default to a
 * deterministic, no-checkouts shape.
 */
export function makeTestWorkspace(overrides: Partial<TestWorkspace> & Pick<TestWorkspace, 'id' | 'displayName'>): TestWorkspace {
    return {
        locationIds: [],
        checkoutIds: [],
        defaultLocationId: null,
        defaultCheckoutId: null,
        ...overrides,
    };
}

/**
 * Build a minimal test profile descriptor. Callers can override
 * `compatibility` per-agent or supply a `compatibilityByTargetKey`. Defaults
 * mark the profile as non-builtin with no env-var requirements.
 */
export function makeTestProfile(overrides: {
    id: string;
    title: string;
    isBuiltIn?: boolean;
    compatibility?: Record<string, boolean>;
    compatibilityByTargetKey?: Record<string, boolean>;
    envVarRequirements?: ReadonlyArray<unknown>;
}): {
    id: string;
    title: string;
    isBuiltIn: boolean;
    compatibility: Record<string, boolean>;
    envVarRequirements: ReadonlyArray<unknown>;
} {
    return {
        isBuiltIn: false,
        compatibility: {},
        envVarRequirements: [],
        ...overrides,
    };
}

/**
 * Build an automation-draft fixture with the canonical default schedule and
 * cron values; callers override only the fields they care about (e.g.
 * `enabled`, `name`, `description`, `timezone`). Returns the exact shape
 * required by `persistedDraft.automationDraft`.
 */
export function makeTestAutomationDraft(overrides: Partial<{
    enabled: boolean;
    name: string;
    description: string;
    scheduleKind: 'interval' | 'cron';
    everyMinutes: number;
    cronExpr: string;
    timezone: string | null;
}> = {}): {
    enabled: boolean;
    name: string;
    description: string;
    scheduleKind: 'interval' | 'cron';
    everyMinutes: number;
    cronExpr: string;
    timezone: string | null;
} {
    return {
        enabled: false,
        name: '',
        description: '',
        scheduleKind: 'interval',
        everyMinutes: 60,
        cronExpr: '0 * * * *',
        timezone: null,
        ...overrides,
    };
}

/**
 * Minimal builder for a primary `TestWorkspaceLocation` that points a
 * given `machineId` at a `path`. Defaults match the canonical
 * `loc_local`/`ws_payments` fixture.
 */
export function makeTestWorkspaceLocation(
    overrides: Partial<TestWorkspaceLocation> & Pick<TestWorkspaceLocation, 'id' | 'workspaceId' | 'machineId' | 'path'>,
): TestWorkspaceLocation {
    return {
        detectedScm: {
            provider: 'git',
            rootPath: overrides.path,
        },
        capabilities: {
            syncEligible: true,
            scmDetected: true,
            checkoutProviderKinds: ['git_worktree'],
        },
        ...overrides,
    };
}

/**
 * Minimal builder for a primary `TestWorkspaceCheckout` (main worktree).
 */
export function makeTestWorkspaceCheckout(
    overrides: Partial<TestWorkspaceCheckout>
        & Pick<TestWorkspaceCheckout, 'id' | 'workspaceId' | 'workspaceLocationId' | 'path' | 'displayName'>
        & { branch?: string },
): TestWorkspaceCheckout {
    const branch = overrides.branch ?? 'main';
    return {
        kind: 'primary',
        status: 'ready',
        syncPolicy: 'inherit',
        scm: {
            git: {
                branch,
                isMainWorktree: true,
                mainRepoPath: overrides.path,
            },
        },
        ...overrides,
    };
}

// Re-export hoisted state objects via a single trailing export block —
// vitest forbids `export const x = vi.hoisted(...)` (the hoist would lift
// the binding above its declaration), but re-exporting an already-hoisted
// local binding is fine because the export emits a separate runtime
// binding.
export {
    accountProfileState,
    activeServerAccountScopeState,
    allMachinesState,
    cliDetectionState,
    clearNewSessionDraftMock,
    computeNewSessionInputMaxHeightMock,
    createSessionActionDraftMock,
    featureFlags,
    fetchSnapshotForMachinePathMock,
    fireAndForgetState,
    focusEffectRef,
    interactionQueueState,
    loadNewSessionDraftMock,
    machineMcpServersPreviewMock,
    modalAlertMock,
    modalShowMock,
    persistDraftNowRef,
    persistedDraft,
    platformOsState,
    readCachedSnapshotForMachinePathMock,
    repoSnapshotState,
    routerPushMock,
    routerSetParamsMock,
    saveNewSessionDraftMock,
    searchParamsState,
    storageSubscriptionState,
    targetServerState,
    tempSessionDataState,
    tryShowDaemonUnavailableAlertForRpcErrorMock,
    useCreateNewSessionArgsRef,
    workspaceGraphState,
};
