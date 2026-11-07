import { authoringMemoryDefaults, projectAuthoringMemory } from '@/sync/store/domains/authoringMemory';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlushHookEffectsOptions } from '@/dev/testkit/hooks/flushHookEffects';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createProfileCatalogHttpResponse, installNewSessionScreenModelCommonModuleMocks } from './newSessionScreenModelTestHelpers';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import {
    attachCurrentSessionAuthoringSelectionsRuntimeProjection,
    mergeCurrentFavoriteModelSelectionsIntoRaw,
    mergeCurrentRememberedEngineSelectionsIntoRaw,
    readRetainedFavoriteModelSelectionsV1,
} from '@/sync/domains/settings/sessionAuthoringSelectionPersistence';
import { buildRememberedEngineSelectionScopeKey } from '@/sync/domains/session/authoring/rememberedEngineSelections';
import { PluginProjectionV2Schema, ProviderConnectionIdSchema, SessionModelSelectionV1Schema } from '@happier-dev/protocol';
import { DaemonProviderModelProjectionResponseV1Schema, RPC_METHODS, RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRecordV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import type { PluginUiSessionPlacementCandidateV1 } from '@happier-dev/protocol/plugins/ui';
import type { SessionModelProjectionGroup } from '@/components/sessions/modelPicker/buildSessionModelPickerSections';
import { ModalPortalTargetProvider } from '@/modal/portal/ModalPortalTarget';
import type { NewSessionAutomationDraft } from '@/sync/domains/automations/automationDraft';
import {
    findCheckoutChip as findSelectionListCheckoutChip,
    findCheckoutChipOptionFromChip,
    getCheckoutChipExistingWorktreeIds,
    getCheckoutChipQuickActionIds,
} from './__tests__/checkoutChipSelectors';
import { resetSessionDraftRepositoryForTests } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import 'fake-indexeddb/auto';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { activateStorageAccountScope } from '@/dev/testkit/runtime/storageRuntime';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';

// This screen-model graph never renders Markdown. Its AgentInput leaf imports
// the patched third-party streaming utility, which can be absent before the UI
// postinstall lane materializes it.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => [],
}));

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
    capabilitySelection: { mcp: {
        v: 1,
        managedServersEnabled: false,
        forceIncludeServerIds: ['server-portable'],
        forceExcludeServerIds: ['server-disabled'],
    } },
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
        pendingAutomationId: null,
        enabled: false,
        name: '',
        description: '',
        triggers: [],
    } as NewSessionAutomationDraft,
    updatedAt: 123,
}) as {
    input: string;
    selectedMachineId: string;
    selectedPath: string;
    selectedProfileId: null;
    selectedSecretId: null;
    capabilitySelection: import('@happier-dev/protocol/reach/sessionCapabilitySelectionV1').SessionCapabilitySelectionV1;
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
    automationDraft: NewSessionAutomationDraft;
    updatedAt: number;
    backendTarget?: { kind: 'builtInAgent'; agentId: string };
    access?: import('@happier-dev/protocol').SessionInitialAccessDraftV1 | null;
    primaryTeamId?: string | null;
    resumeSessionId?: string | null;
    targetServerId?: string | null;
    placementCandidates?: readonly PluginUiSessionPlacementCandidateV1[];
    windowsRemoteSessionLaunchModeOverride?: {
        machineId: string;
        mode: 'hidden' | 'windows_terminal' | 'console';
    } | null;
});
const saveNewSessionDraftMock = vi.hoisted(() => vi.fn());
const clearNewSessionDraftMock = vi.hoisted(() => vi.fn());
const loadNewSessionDraftMock = vi.hoisted(() => vi.fn(() => JSON.parse(JSON.stringify(persistedDraft))));
const persistedDraftRevisionState = vi.hoisted(() => ({ value: 1 }));
const useRealDraftRepository = vi.hoisted(() => ({ value: false }));
const runTeamActionMock = vi.hoisted(() => vi.fn(async () => ({
    kind: 'failed' as const,
    failure: { kind: 'unreachable' as const, retryable: true, code: null },
})));

const platformOsState = vi.hoisted(() => ({
    value: 'web' as 'web' | 'ios' | 'android',
}));
const modalShowMock = vi.hoisted(() => vi.fn());
const modalAlertMock = vi.hoisted(() => vi.fn());
const modalConfirmMock = vi.hoisted(() => vi.fn(async () => false));
const openExternalSessionsResumeIdPickerModalMock = vi.hoisted(() => vi.fn<(args: unknown) => Promise<string | null>>(async () => 'session-picked'));
const fireAndForgetState = vi.hoisted(() => ({
    promises: [] as Promise<unknown>[],
}));
const tryShowDaemonUnavailableAlertForRpcErrorMock = vi.hoisted(() => vi.fn((_args: unknown) => false));
const routerPushMock = vi.hoisted(() => vi.fn());
const routerSetParamsMock = vi.hoisted(() => vi.fn());
const featureFlags = vi.hoisted(() => ({
    automationsEnabled: false,
    externalSessionsEnabled: false,
    providersEnabled: false,
}));
const agentResumeSupportState = vi.hoisted(() => ({ supportsVendorResume: false }));
const externalSessionBrowseSupportState = vi.hoisted(() => ({ supported: false }));
const automationActionChipsState = vi.hoisted(() => ({
    enabled: false,
}));
const describeProviderModelsMock = vi.hoisted(() => vi.fn());

function daemonAgentProjection(input: Readonly<{
    title: string;
    identity?: Readonly<{ pluginId: string; localId: string }>;
    catalogAgentId?: string;
}>) {
    const identity = input.identity ?? { pluginId: 'happier.agent.codex', localId: 'codex' };
    const id = identity.pluginId === `happier.agent.${identity.localId}`
        ? identity.localId : `${identity.pluginId}/${identity.localId}`;
    return PluginProjectionV2Schema.parse({
        v: 2,
        generation: 1,
        agentsById: {
            [id]: {
                id, identity, title: input.title, channel: input.identity ? 'plugin' : 'stable',
                catalogAgentId: input.catalogAgentId ?? (input.identity ? undefined : 'codex'),
                capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
            },
        },
        familiesById: {},
    });
}

function agentTarget(agentId: string) {
    return { kind: 'agent' as const, identity: { pluginId: `happier.agent.${agentId}`, localId: agentId } };
}

const reviewAgentTarget = { kind: 'agent' as const, identity: { pluginId: 'acme.review', localId: 'review' } };
const projectedCodexIdentity = { pluginId: 'acme.projected', localId: 'codex' };
const configuredReviewAgentTarget = {
    kind: 'agent' as const,
    identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' },
    definitionId: 'review-bot',
};

function retainedProviderProjectionGroup(): SessionModelProjectionGroup {
    const connectionId = ProviderConnectionIdSchema.parse('pc_stale');
    return {
        connectionId,
        providerName: 'Gateway',
        connectionName: 'Stale cache',
        connectionRole: 'named',
        connectionDisplayNameMode: 'custom',
        connectionRevision: 1,
        authorization: { authorized: true },
        manualModelPolicy: 'allowed',
        supportsFreeformModelIds: true,
        suppressedConnectedServiceIds: [],
        modelLoadAction: 'descriptor_absent',
        rows: [{
            ref: {
                agentTargetKey: 'agent:happier.agent.claude/claude',
                providerConnectionId: connectionId,
                modelId: 'stale-provider-model',
            },
            descriptor: { id: 'stale-provider-model', name: 'Stale Provider model' },
            sources: { manual: false, static: true, probe: false },
            confidence: 'verified_static',
            compatibility: {
                result: {
                    status: 'verified',
                    selectedProtocol: 'openai-responses',
                    evidence: { sourceUrls: ['https://example.test'], verifiedAt: '2026-07-12' },
                },
                compatibilityFingerprint: 'compatibility:v1:stale',
                confirmed: true,
            },
            endpointHealth: 'available',
            catalog: { stale: false },
            loadState: 'unknown',
            visibility: 'visible',
        }],
    };
}
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
const activeServerAccountScopeState = vi.hoisted(() => ({
    value: { serverId: 'server-a', accountId: 'account-a' } as import('@/sync/domains/scope/serverAccountScope').ServerAccountScope | null,
}));

function getMockStorageState() {
    return fixtureStorage.getState();
}

function invalidateMockStorageSnapshot() {
    fixtureStorage.setState({
        settings: attachCurrentSessionAuthoringSelectionsRuntimeProjection({ ...settingsDefaults, ...settingsState }),
        authoringMemory: projectAuthoringMemory(authoringMemoryState),
        profileScope: activeServerAccountScopeState.value,
        settingsScope: activeServerAccountScopeState.value,
        profile: profileDefaults,
    });
    publishFixtureMachines();
}

function notifyMockStorageSubscribers() {
    invalidateMockStorageSnapshot();
}

function setMockSettingValue(key: string, valueOrUpdater: unknown): void {
    const previous = (settingsState as Record<string, unknown>)[key];
    (settingsState as Record<string, unknown>)[key] = typeof valueOrUpdater === 'function'
        ? (valueOrUpdater as (value: unknown) => unknown)(previous)
        : valueOrUpdater;
    invalidateMockStorageSnapshot();
    notifyMockStorageSubscribers();
}

// Machine fixtures are referentially heavy. Real storage hooks hand back the same
// record for an unchanged input, so cache fixtures per input-array identity: a test
// that replaces `activeMachinesState.value` gets fresh fixtures, while every render
// against the same array reuses them instead of churning derived identity.
const machineFixturesByInputArray = new WeakMap<object, Array<ReturnType<typeof createMachineFixture>>>();

function materializeStorageMachines(inputs: ReadonlyArray<{ id: string; metadata: Record<string, unknown> }>): Array<ReturnType<typeof createMachineFixture>> {
    const cached = machineFixturesByInputArray.get(inputs);
    if (cached) return cached;
    const fixtures = inputs.map((input) => createMachineFixture({ id: input.id, metadata: input.metadata as any, activeAt: Date.now() }));
    machineFixturesByInputArray.set(inputs, fixtures);
    return fixtures;
}

type FixtureMachineLists = Record<string, Array<ReturnType<typeof createMachineFixture>> | null>;
const machineListByServerIdFixturesByState = new WeakMap<object, FixtureMachineLists>();

function readMockMachineListByServerId(): FixtureMachineLists {
    const state = machineListByServerIdState.value;
    const cached = machineListByServerIdFixturesByState.get(state);
    if (cached) return cached;
    const next = Object.fromEntries(Object.entries(state).map(([serverId, machines]) => [
        serverId,
        Array.isArray(machines) ? materializeStorageMachines(machines) : machines,
    ]));
    machineListByServerIdFixturesByState.set(state, next);
    return next;
}

function publishFixtureMachines() {
    const scope = activeServerAccountScopeState.value;
    if (!scope) return;
    fixtureStorage.getState().applyMachines(materializeStorageMachines(activeMachinesState.value), true, {
        sourceServerId: scope.serverId,
        sourceAccountId: scope.accountId,
    });
    for (const [serverId, machines] of Object.entries(readMockMachineListByServerId())) {
        if (machines) fixtureStorage.getState().applyMachines(machines, true, {
            sourceServerId: serverId,
            sourceAccountId: serverId === scope.serverId ? scope.accountId : 'account-b',
        });
    }
}

const profileEnabledById: Record<string, boolean> = {};
const settingsState = {
    ...settingsDefaults,
    lastUsedAgent: 'codex',
    lastUsedPermissionMode: 'default',
    useEnhancedSessionWizard: false,
    useProfiles: false,
    sessionDefaultPermissionModeByTargetKey: {},
    actionsSettingsV1: settingsDefaults.actionsSettingsV1,
    experiments: false,
    featureToggles: {},
    sessionUseTmux: false,
    sessionTmuxByMachineId: {},
    favoriteDirectories: [],
    favoriteMachines: [],
    favoriteProfiles: [] as string[],
    profiles: [] as any[],
    profileEnabledById,
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

const authoringMemoryState = { ...authoringMemoryDefaults };
const initialSettingsState = structuredClone(settingsState);

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
                confirm: modalConfirmMock,
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

vi.mock('@/utils/platform/responsive', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/utils/platform/responsive')>()),
    useHeaderHeight: () => 0,
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/sessions/agentInput/components/AgentInputChipPickerPopover', () => ({
    AgentInputChipPickerPopover: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('AgentInputChipPickerPopover', props, props.children),
}));

vi.mock('@react-navigation/native', () => ({
    useIsFocused: () => true,
    useFocusEffect: (fn: any) => {
        focusEffectRef.current.push(fn);
    },
}));

function installNewSessionScreenModelStorageMock() {
    vi.doMock('@/sync/domains/state/storage', async (importOriginal) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {
            storage: fixtureStorage,
            useSetting: (key: string) => ({ ...settingsDefaults, ...settingsState } as any)[key],
            useSettingMutable: (key: string) => [
                ({ ...settingsDefaults, ...settingsState } as any)[key],
                (next: unknown) => setMockSettingValue(key, next),
            ],
            useCurrentFavoriteModelSelectionsV1Mutable: () => {
                const settings = getMockStorageState().settings;
                return [
                    settings.currentFavoriteModelSelectionsV1,
                    (next: typeof settings.currentFavoriteModelSelectionsV1) => {
                        setMockSettingValue('favoriteModelSelectionsV1', mergeCurrentFavoriteModelSelectionsIntoRaw({
                            rawFavorites: readRetainedFavoriteModelSelectionsV1(settings),
                            currentFavorites: settings.currentFavoriteModelSelectionsV1,
                            nextFavorites: next,
                        }));
                    },
                ] as const;
            },
            useCurrentRememberedEngineSelectionsByScopeV1Mutable: () => {
                const memory = getMockStorageState().authoringMemory;
                return [
                    memory.currentRememberedEngineSelectionsByScopeV1,
                    (next: typeof memory.currentRememberedEngineSelectionsByScopeV1) => {
                        authoringMemoryState.lastEngineSelectionsByScopeV1 = mergeCurrentRememberedEngineSelectionsIntoRaw({
                            rawSelections: memory.lastEngineSelectionsByScopeV1,
                            currentSelections: memory.currentRememberedEngineSelectionsByScopeV1,
                            nextSelections: next,
                        });
                        notifyMockStorageSubscribers();
                    },
                ] as const;
            },
            useSettings: () => getMockStorageState().settings as unknown as import('@/sync/domains/settings/settings').Settings,
        });
    });
}

// The screen model now owns persisted New Session reads/writes through the
// synchronized draft repository adapter. Keep this large screen-model fixture at
// that boundary: repository merge/currentness behavior has its own owner tests,
// while every assertion below continues to inspect the exact draft projected by
// the real authoring model.
vi.mock('@/components/sessions/composer/newSessionDraftRepositoryAdapter', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/sessions/composer/newSessionDraftRepositoryAdapter')>();
    return {
        ...actual,
        readNewSessionDraftFromRepository: (...args: Parameters<typeof actual.readNewSessionDraftFromRepository>) =>
            useRealDraftRepository.value ? actual.readNewSessionDraftFromRepository(...args) : loadNewSessionDraftMock(),
        readNewSessionDraftProjectionFromRepository: (...args: Parameters<typeof actual.readNewSessionDraftProjectionFromRepository>) => {
            if (useRealDraftRepository.value) return actual.readNewSessionDraftProjectionFromRepository(...args);
            const draft = loadNewSessionDraftMock();
            return draft ? { draft, revision: persistedDraftRevisionState.value } : null;
        },
        writeNewSessionAuthoringDraftToRepository: (...args: Parameters<typeof actual.writeNewSessionAuthoringDraftToRepository>) =>
            useRealDraftRepository.value ? actual.writeNewSessionAuthoringDraftToRepository(...args) : saveNewSessionDraftMock(args[0].draft),
    };
});

// Team discovery is a network boundary. The screen-model corridor keeps the
// real access-draft controller and repository integration below it.
vi.mock('@/sync/ops/teams/teamActionClient', () => ({
    runTeamAction: runTeamActionMock,
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
        getAgentCore: (agentId: string) => {
            const core = actual.getAgentCore(agentId);
            if (!core) return core;
            return {
            // Keep the real bundled core facts (displayNameKey etc.) so catalog
            // presentation keeps its AgentCoreConfig contract under the mock.
            ...core,
            model: { defaultMode: 'default', allowedModes: ['default', 'gpt-5'], supportsFreeform: true },
            resume: { supportsVendorResume: agentResumeSupportState.supportsVendorResume, experimental: false },
            sessionStorage: { direct: true, persisted: true },
            cli: { detectKey: String(agentId) },
            };
        },
        buildResumeCapabilityOptionsFromUiState: ({ settings }: any) => ({ accountSettings: settings }),
        getAgentResumeExperimentsFromSettings: () => ({}),
        buildNewSessionOptionsFromUiState: () => ({}),
        getNewSessionAgentInputExtraActionChips: () => [],
        getNewSessionRelevantInstallableDepKeys: () => [],
    };
});

vi.mock('@/agents/runtime/resumeCapabilities', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        canAgentResume: () => agentResumeSupportState.supportsVendorResume,
    };
});

vi.mock('@/components/sessions/external/browse/resolveExternalSessionBrowseLockedSourceOption', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        canBrowseExternalSessions: () => externalSessionBrowseSupportState.supported,
        resolveExternalSessionBrowseLockedSource: () => externalSessionBrowseSupportState.supported
            ? { kind: 'claudeConfig' }
            : null,
    };
});

vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (promise: Promise<unknown> | null | undefined) => {
        if (promise) {
            fireAndForgetState.promises.push(promise);
            void promise.catch(() => {});
        }
    },
}));

vi.mock('@/utils/sessions/recentPaths', () => ({
    getRecentPathsForMachine: () => [],
}));


vi.mock('@/hooks/machine/useMachineEnvPresence', () => ({
    useMachineEnvPresence: () => ({ isPreviewEnvSupported: true, isLoading: false, meta: {}, refresh: vi.fn() }),
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
            handleCreateSession: vi.fn(),
        };
    },
}));

vi.mock('@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState', () => ({
    useNewSessionPreflightModelsState: () => ({ preflightModels: null, modelOptions: [], probe: { phase: 'idle', refresh: vi.fn() } }),
}));

vi.mock('@/components/sessions/new/hooks/screenModel/useNewSessionPreflightSessionModesState', () => ({
    useNewSessionPreflightSessionModesState: () => ({ preflightModes: null, modeOptions: [], probe: { phase: 'idle', refresh: vi.fn() } }),
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
        if (featureId === 'sessions.direct') return featureFlags.externalSessionsEnabled;
        if (featureId === 'providers') return featureFlags.providersEnabled;
        return false;
    },
}));

vi.mock('@/components/sessions/new/modules/automationFeatureGate', () => ({
    resolveEffectiveAutomationDraft: ({ draft }: any) => draft,
    shouldShowAutomationActionChips: () => automationActionChipsState.enabled,
}));

vi.mock('@/utils/errors/daemonUnavailableAlert', () => ({
    tryShowDaemonUnavailableAlertForRpcError: (args: unknown) => tryShowDaemonUnavailableAlertForRpcErrorMock(args),
}));

vi.mock('@/components/sessions/new/hooks/useSecretRequirementFlow', () => ({
    useSecretRequirementFlow: () => ({ openSecretRequirementModal: vi.fn() }),
}));





vi.mock('@/utils/secrets/secretSatisfaction', () => ({
    getSecretSatisfaction: () => ({ missingRequired: [], missingOptional: [] }),
}));

vi.mock('@/hooks/ui/useKeyboardHeight', () => ({
    useKeyboardHeight: () => 0,
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


vi.mock('@/utils/sessions/tempDataStore', () => ({
    getTempData: () => tempSessionDataState.value,
}));

const network = await installSessionOpsNetworkBoundary();
afterAll(() => network.dispose());
await loadSyncSingletonForTests();
const { storage: fixtureStorage } = await import('@/sync/domains/state/storageStore');
const fixtureStorageInitialState = fixtureStorage.getState();
const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { resetAcpCatalogEngineForTests } = await import('@/sync/engine/settings/acpCatalogEngine');
const { resetAcpCatalogSnapshotsForTests } = await import('@/sync/store/settings/acpCatalogSnapshot');
const { resetProfileCatalogEngineForTests } = await import('@/sync/engine/settings/profileCatalogEngine');
const { resetProfileCatalogSnapshotsForTests } = await import('@/sync/store/settings/profileCatalogSnapshot');
const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
let activeStorageScope: Awaited<ReturnType<typeof activateStorageAccountScope>> | null = null;
installNewSessionScreenModelStorageMock();

const { useNewSessionScreenModel } = await import('./useNewSessionScreenModel');
const useNewSessionScreenModelModulePromise = Promise.resolve({ useNewSessionScreenModel });

async function runFocusEffects(): Promise<Array<void | (() => void)>> {
    return await Promise.all(focusEffectRef.current.map((effect) => effect()));
}

describe('useNewSessionScreenModel (draft hydration)', () => {
    afterEach(() => {
        standardCleanup();
        activeStorageScope?.dispose();
        activeStorageScope = null;
        resetSessionDraftRepositoryForTests();
    });

    beforeEach(async () => {
        useRealDraftRepository.value = false;
        resetAcpCatalogEngineForTests();
        resetAcpCatalogSnapshotsForTests();
        resetProfileCatalogEngineForTests();
        resetProfileCatalogSnapshotsForTests();
        resetServerFeaturesClientForTests();
        for (const key of Object.keys(settingsState)) Reflect.deleteProperty(settingsState, key);
        Object.assign(settingsState, structuredClone(initialSettingsState));
        network.resetRequests();
        const home = await network.addHome('https://server-a', 'account-a');
        await network.addHome('https://server-b', 'account-b');
        const { setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
        await setActiveServerId(home.id);
        fixtureStorage.setState(fixtureStorageInitialState, true);
        activeStorageScope = await activateStorageAccountScope({ serverId: home.id, accountId: home.accountId });
        const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
        await prepareSessionDraftPersistenceStorage();
        clearDaemonMergedProjectionCacheForTests();
        machineContributionRegistryProjectionDescribeMock.mockReset();
        const defaultProjection = daemonAgentProjection({ title: 'Codex' });
        const claudeProjection = daemonAgentProjection({ title: 'Claude', identity: agentTarget('claude').identity, catalogAgentId: 'claude' });
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({ supported: true, projection: {
            ...defaultProjection,
            agentsById: { ...defaultProjection.agentsById, ...claudeProjection.agentsById },
        } });
        network.setRpcAckResponder(async (request) => {
            if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                const serverId = request.serverUrl === home.serverUrl ? home.id : 'server-b';
                const answer = await machineContributionRegistryProjectionDescribeMock(request.targetId, { serverId });
                if (answer.supported) return { ok: true, result: { protocolVersion: 1, projection: answer.projection } };
            }
            if (request.method === RPC_METHODS.CAPABILITIES_DETECT) {
                const payload = request.payload;
                const requests = payload && typeof payload === 'object' && 'requests' in payload && Array.isArray(payload.requests)
                    ? payload.requests : [];
                return { ok: true, result: { protocolVersion: 1, results: Object.fromEntries(requests.flatMap((capability: unknown) => {
                    if (!capability || typeof capability !== 'object' || !('id' in capability) || typeof capability.id !== 'string'
                        || !capability.id.startsWith('cli.')) return [];
                    return [[capability.id, { ok: true, checkedAt: Date.now(), data: {
                        installed: true, version: '1', latestVersion: '1',
                        update: { supported: false, command: null },
                        signIn: { status: 'signedIn', loginSupport: 'status_only' },
                        platform: { supported: true },
                        install: { available: false, mode: 'manual', sizeBytes: null, guideUrl: null },
                        dependencies: [],
                    } }]];
                })) } };
            }
            if (request.method === RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION) {
                const answer = await describeProviderModelsMock(request.payload);
                return { ok: true, result: DaemonProviderModelProjectionResponseV1Schema.parse({
                    ...answer, currentSelectionRecovery: null,
                }) };
            }
            return { ok: false, error: 'RPC method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
        });
        const artifactBoundary = createArtifactStoreBoundary({
            ownerAccountId: () => activeServerAccountScopeState.value?.accountId ?? null,
            encryptionMode: 'plain',
        });
        network.setHttpResponder(async (input, init) => {
            const url = new URL(String(input));
            const path = url.pathname;
            const artifactResponse = artifactBoundary.handle(`${path}${url.search}`, init);
            if (artifactResponse) return artifactResponse;
            if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({
                features: { providers: { enabled: featureFlags.providersEnabled } },
            }));
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v2/account/settings') {
                const { profiles: _profiles, acpCatalogSettingsV1: _acp, ...settings } = settingsState;
                return Response.json({ content: { t: 'plain', v: settings }, version: 1 });
            }
            if (path === ACP_CATALOG_ROWS_ROUTE_V1) return Response.json({ status: 'present', revision: 1,
                content: { t: 'plain', v: AcpCatalogRecordV1Schema.parse({
                    v: 1, definitions: settingsState.acpCatalogSettingsV1.backends,
                }) },
            });
            const profileResponse = createProfileCatalogHttpResponse(path, settingsState);
            if (profileResponse) return profileResponse;
            return null;
        });

        platformOsState.value = 'web';
        modalShowMock.mockReset();
        modalAlertMock.mockReset();
        modalConfirmMock.mockReset();
        modalConfirmMock.mockResolvedValue(false);
        openExternalSessionsResumeIdPickerModalMock.mockReset();
        openExternalSessionsResumeIdPickerModalMock.mockResolvedValue('session-picked');
        fireAndForgetState.promises = [];
        tryShowDaemonUnavailableAlertForRpcErrorMock.mockReset();
        tryShowDaemonUnavailableAlertForRpcErrorMock.mockReturnValue(false);
        interactionQueueState.callbacks = [];
        focusEffectRef.current = [];
        activeServerAccountScopeState.value = { serverId: 'server-a', accountId: 'account-a' };
        delete persistedDraft.placementCandidates;
        delete persistedDraft.access;
        delete persistedDraft.primaryTeamId;
        routerPushMock.mockClear();
        routerSetParamsMock.mockClear();
        featureFlags.automationsEnabled = false;
        featureFlags.externalSessionsEnabled = false;
        featureFlags.providersEnabled = false;
        agentResumeSupportState.supportsVendorResume = false;
        externalSessionBrowseSupportState.supported = false;
        automationActionChipsState.enabled = false;
        describeProviderModelsMock.mockReset();
        describeProviderModelsMock.mockResolvedValue({
            status: 'success',
            agentTargetKey: 'agent:happier.agent.claude/claude',
            groups: [],
        });
        persistDraftNowRef.current = null;
        saveNewSessionDraftMock.mockClear();
        clearNewSessionDraftMock.mockClear();
        loadNewSessionDraftMock.mockClear();
        persistedDraftRevisionState.value = 1;
        readCachedSnapshotForMachinePathMock.mockReset();
        readCachedSnapshotForMachinePathMock.mockImplementation(() => repoSnapshotState.value);
        fetchSnapshotForMachinePathMock.mockReset();
        fetchSnapshotForMachinePathMock.mockImplementation(async () => repoSnapshotState.value);
        readCachedWorktreesEnrichmentMock.mockReset();
        readCachedWorktreesEnrichmentMock.mockReturnValue(null);
        fetchWorktreesEnrichmentMock.mockReset();
        fetchWorktreesEnrichmentMock.mockImplementation(async () => []);
        searchParamsState.value = {};
        tempSessionDataState.value = null;
        targetServerState.allowedTargetServerIds = [home.id];
        targetServerState.targetServerId = home.id;
        targetServerState.targetServerName = 'Server A';
        targetServerRequestState.requests = [];
        activeMachinesState.value = [
            { id: 'machine-1', metadata: { displayName: 'Machine One', host: 'one', homeDir: '/home/one' } },
            { id: 'machine-2', metadata: { displayName: 'Machine Two', host: 'two', homeDir: '/home/two' } },
        ];
        machineListByServerIdState.value = { 'server-b': activeMachinesState.value };
        delete (persistedDraft as any).backendTarget;
        delete (persistedDraft as any).composerAttachments;
        delete persistedDraft.targetServerId;
        delete persistedDraft.windowsRemoteSessionLaunchModeOverride;
        delete (persistedDraft as any).codexBackendMode;
        persistedDraft.agentType = 'claude';
        persistedDraft.input = 'hello';
        persistedDraft.permissionMode = 'yolo';
        delete persistedDraft.resumeSessionId;
        persistedDraft.selectedMachineId = 'machine-2';
        persistedDraft.selectedPath = '/repo/custom';
        persistedDraft.selectedWorkspaceId = 'ws_payments';
        persistedDraft.selectedWorkspaceLocationId = 'loc_local';
        persistedDraft.selectedWorkspaceCheckoutId = 'checkout_feature_auth';
        persistedDraft.updatedAt = 123;
        persistedDraft.automationDraft = {
            pendingAutomationId: null,
            enabled: false,
            name: '',
            description: '',
            triggers: [],
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
        authoringMemoryState.lastEngineSelectionsByScopeV1 = authoringMemoryDefaults.lastEngineSelectionsByScopeV1;
        authoringMemoryState.lastUsedProfile = null;
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
        invalidateMockStorageSnapshot();
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

    function expectNewWorktreeCheckoutChip(model: any, displayName: string): void {
        const label = String(getCheckoutChipLabel(model) ?? '');
        expect(label).toContain('newSession.checkout.newWorktree');
        expect(label).toContain(displayName);
    }

    async function flushInteractionQueue() {
        // Settle next-tick fallbacks first: runAfterInteractionsWithFallback
        // schedules a 0ms timeout on web instead of InteractionManager.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        await settleNewSessionScreenModel();
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

    async function waitForModelAssertion(assertion: () => void) {
        await vi.waitFor(async () => {
            await settleNewSessionScreenModel();
            assertion();
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

    async function renderNewSessionScreenModel(
        assignModel: (nextModel: unknown) => void,
        input?: Readonly<{ draftId: string }>,
    ) {
        invalidateMockStorageSnapshot();
        const hook = await renderHook(() => {
            const nextModel = useNewSessionScreenModel(input);
            assignModel(nextModel);
            return nextModel;
        }, {
            flushOptions: {
                cycles: 3,
                turns: 2,
            },
        });
        return {
            ...hook,
            rerender: async () => {
                await act(async () => { publishFixtureMachines(); });
                await hook.rerender();
            },
        };
    }

    async function renderNewSessionProbe(Probe: React.ComponentType) {
        invalidateMockStorageSnapshot();
        return renderScreen(React.createElement(Probe));
    }

    it('keeps machine recovery inert until the spawn Home resolves, then opens scoped Agent sign-in', async () => {
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const { serverAccountScopedResourceKey } = await import('@/sync/domains/scope/serverAccountScope');
        const { machineAgentInventoryStore } = await import('@/agents/machineAgents/machineAgentInventoryStore');
        const { useMachineAgent } = await import('@/agents/machineAgents/useMachineAgents');
        const { machineCollectionHref } = await import('@/components/settings/machines/collection/machineCollectionModel');
        const profile = { id: getActiveServerSnapshot().serverId };
        const accountId = 'new-session-blocker-account';
        const machineId = 'machine-2';
        const inventoryKey = serverAccountScopedResourceKey({ serverId: profile.id, accountId }, 'machine-agents', machineId);
        await network.addHome('https://server-a', accountId);
        activeStorageScope?.dispose();
        activeStorageScope = await activateStorageAccountScope({ serverId: profile.id, accountId });
        let hook: Awaited<ReturnType<typeof renderNewSessionScreenModel>> | null = null;
        let unmountAgent: (() => Promise<void>) | null = null;
        try {
            activeServerAccountScopeState.value = { serverId: profile.id, accountId };
            // Retain the exact authored machine while the Home resolver is pending.
            // A legacy unqualified machine id cannot select a machine without a Home.
            persistedDraft.targetServerId = profile.id;
            invalidateMockStorageSnapshot();
            targetServerState.targetServerId = null;
            hook = await renderNewSessionScreenModel(() => {});
            const agent = await renderHook(() => useMachineAgent({ serverId: profile.id, machineId, agentId: 'claude', load: false }));
            unmountAgent = agent.unmount;
            await act(async () => { machineAgentInventoryStore.publish(inventoryKey, {
                status: 'ready', lastCheckedAt: Date.now(), items: [{
                    agentId: 'claude', title: 'Claude', installed: true, version: '1', latestVersion: '1',
                    update: { supported: false, command: null },
                    signIn: { status: 'signedOut', loginSupport: 'status_only' },
                    platform: { supported: true },
                    install: { available: false, mode: 'manual', sizeBytes: null, guideUrl: null }, dependencies: [],
                }],
            }); });
            expect(agent.getCurrent()).toMatchObject({
                agentId: 'claude', stale: false, state: 'needsSignIn', signIn: { status: 'signedOut' },
            });
            await waitForModelAssertion(() => {
                const model = hook!.getCurrent();
                expect(model.variant).toBe('simple');
                if (model.variant !== 'simple') throw new Error('Expected the simple composer');
                expect(useCreateNewSessionArgsRef.current).toEqual(expect.objectContaining({
                    selectedMachineId: machineId,
                    authoringDraft: expect.objectContaining({
                        executionTarget: { kind: 'machine', target: { serverId: profile.id, machineId } },
                        agentTarget: agentTarget('claude'),
                    }),
                }));
                expect(model.simpleProps.connectionStatus).toMatchObject({
                    text: 'newSession.machineUnavailableStatus', recovery: 'machine', isPulsing: false,
                });
                expect(model.simpleProps.connectionStatus?.action).toBeUndefined();
                expect(model.simpleProps.canCreate).toBe(false);
            });
            expect(routerPushMock).not.toHaveBeenCalled();
            targetServerState.targetServerId = profile.id;
            machineListByServerIdState.value = { [profile.id]: activeMachinesState.value };
            await hook.rerender();
            await waitForModelAssertion(() => {
                const model = hook!.getCurrent();
                if (model.variant !== 'simple') throw new Error('Expected the simple composer');
                expect(model.simpleProps.connectionStatus?.action).toMatchObject({
                    testID: 'new-session-agent-blocker.action', disabled: false,
                });
            });
            const resolvedModel = hook.getCurrent();
            if (resolvedModel.variant !== 'simple') throw new Error('Expected the simple composer');
            await act(async () => { resolvedModel.simpleProps.connectionStatus?.action?.onPress(); });
            expect(routerPushMock).toHaveBeenLastCalledWith(machineCollectionHref({ machineId, serverId: profile.id }));
        } finally {
            await unmountAgent?.();
            await hook?.unmount();
            machineAgentInventoryStore.publish(inventoryKey, { status: 'ready', items: [], descriptors: [], lastCheckedAt: null });
        }
    });

    // Typing is the hottest interaction on this screen. The composer must stay fully controlled and
    // fully live, but the live text must not be a render dependency of the ~1,900-line screen model:
    // while it is, every keystroke re-executes the whole hook tree, rebuilds the authoring draft and
    // authoring context, and invalidates both screen-variant prop builders.
    //
    // Both halves belong in one case: publishing the text without re-rendering is only correct if the
    // draft that gets persisted (and submitted) still carries the text the model never saw.
    it('publishes live composer text without re-rendering the model, and still persists it', async () => {
        let model: any = null;
        let renderCount = 0;

        await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
            renderCount += 1;
        });

        const promptStore = model?.simpleProps?.promptStore;
        expect(promptStore?.getPrompt()).toBe('hello');

        const rendersBeforeTyping = renderCount;
        const observed: string[] = [];
        const unsubscribe = promptStore.subscribe(() => {
            observed.push(promptStore.getPrompt());
        });

        for (const next of ['hello w', 'hello wo', 'hello wor']) {
            await act(async () => {
                model?.simpleProps?.setSessionPrompt(next);
            });
        }

        unsubscribe();

        // Every keystroke reaches subscribers (the composer input stays live)...
        expect(observed).toEqual(['hello w', 'hello wo', 'hello wor']);
        expect(promptStore.getPrompt()).toBe('hello wor');
        // ...while the screen model itself never re-runs for them.
        expect(renderCount).toBe(rendersBeforeTyping);

        // ...and the draft that gets written still carries the text the model never rendered.
        saveNewSessionDraftMock.mockClear();
        await act(async () => {
            persistDraftNowRef.current?.();
        });

        expect(saveNewSessionDraftMock).toHaveBeenLastCalledWith(expect.objectContaining({
            input: 'hello wor',
        }));
    });

    it('keeps real repository keystrokes in the composer leaf and reads live launch text', async () => {
        useRealDraftRepository.value = true;
        const adapter = await vi.importActual<typeof import('@/components/sessions/composer/newSessionDraftRepositoryAdapter')>(
            '@/components/sessions/composer/newSessionDraftRepositoryAdapter');
        const scope = activeServerAccountScopeState.value;
        const draftId = 'qbp2-real-typing';
        if (!scope) throw new Error('Expected the typing fixture Account scope');
        adapter.writeNewSessionDraftToRepository({ scope, draftId, materializationIntent: 'seeded', draft: {
            input: persistedDraft.input, selectedMachineId: persistedDraft.selectedMachineId,
            selectedPath: persistedDraft.selectedPath, selectedProfileId: null, selectedSecretId: null,
            agentType: 'claude', permissionMode: 'yolo', acpSessionModeId: persistedDraft.acpSessionModeId,
            updatedAt: persistedDraft.updatedAt,
        } });
        expect(adapter.readNewSessionDraftFromRepository({ scope, draftId })?.input).toBe('hello');
        const { NewSessionComposerCard } = await import('../components/NewSessionComposerCard');
        let model!: ReturnType<typeof useNewSessionScreenModel>;
        let renders = 0;
        function TypingScreen() {
            model = useNewSessionScreenModel({ draftId });
            renders += 1;
            if (model.variant !== 'simple') throw new Error('Expected a mounted simple composer');
            return React.createElement(NewSessionComposerCard, {
                panelProps: model.simpleProps, layout: 'embedded', attachments: false, voiceAffordance: 'none',
            });
        }
        const screen = await renderNewSessionProbe(TypingScreen);
        await flushInteractionQueue();
        const before = renders;
        const readIntent = useCreateNewSessionArgsRef.current?.readLaunchIntentSignature;
        if (typeof readIntent !== 'function' || model.variant !== 'simple') throw new Error('Expected a mounted composer');
        const composer = model.simpleProps;
        const signatureBefore = readIntent();
        const text = 'hello twenty-two chars';
        for (let index = 1; index <= text.length; index += 1) {
            await act(async () => {
                const editor = screen.findAllByTestId('new-session-composer-input').find(node =>
                    typeof node.props.onChangeText === 'function' && typeof node.props.onStateChange === 'function');
                if (!editor || typeof editor.props.onChangeText !== 'function') throw new Error('Expected mounted editor callbacks');
                editor.props.onChangeText(text.slice(0, index));
                editor.props.onStateChange?.({ text: text.slice(0, index), selection: { start: index, end: index } });
            });
        }
        expect(composer.promptStore.getPrompt()).toBe(text);
        expect(adapter.readNewSessionDraftFromRepository({ scope, draftId })?.input).toBe(text);
        expect(composer.composerDocument?.captureSubmissionSnapshot()?.text).toBe(text);
        expect(readIntent()).not.toBe(signatureBefore);
        expect(renders - before).toBe(0);
    });

    it('hydrates and persists generic composer attachments through the New Session document owner', async () => {
        const composerAttachment = {
            v: 1,
            instanceId: 'issue-42',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42',
            value: { issueId: 42 },
            presentation: { label: 'Issue #42', typeLabel: 'Issue' },
        };
        (persistedDraft as any).composerAttachments = [composerAttachment];

        let model: any = null;
        await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        expect(model?.simpleProps?.composerDocument?.attachments).toEqual([composerAttachment]);

        saveNewSessionDraftMock.mockClear();
        await act(async () => {
            persistDraftNowRef.current?.();
        });

        expect(saveNewSessionDraftMock).toHaveBeenLastCalledWith(expect.objectContaining({
            composerAttachments: [composerAttachment],
        }));
    });

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
        expect(initialLabels).toContain('agentInput.agent.codex');
        expect(initialLabels).not.toContain('Codex (Projected)');

        await act(async () => {
            resolveProjection?.({
                supported: true,
                projection: daemonAgentProjection({ title: 'Codex (Projected)', identity: projectedCodexIdentity, catalogAgentId: 'codex' }),
            });
        });

        await settleNewSessionScreenModel();

        await waitForModelAssertion(() => {
            const nextLabels = (model?.simpleProps?.agentPickerOptions ?? []).map((o: any) => o?.label);
            expect(nextLabels).toContain('Codex (Projected)');
        });
    });

    it('keeps daemon contribution projections cached per server scope for the same machine id', async () => {
        targetServerState.allowedTargetServerIds = ['server-a', 'server-b'];
        targetServerState.targetServerId = 'server-a';
        targetServerState.targetServerName = 'Server A';
        machineContributionRegistryProjectionDescribeMock.mockImplementation(async (_machineId: string, options?: { serverId?: string | null }) => ({
            supported: true,
            projection: daemonAgentProjection({ title: options?.serverId === 'server-b' ? 'Codex (Projected B)' : 'Codex (Projected A)',
                identity: projectedCodexIdentity, catalogAgentId: 'codex' }),
        }));

        let model: any = null;
        const hook = await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });
        await settleNewSessionScreenModel();

        await waitForModelAssertion(() => {
            expect((model?.simpleProps?.agentPickerOptions ?? []).map((o: any) => o?.label)).toContain('Codex (Projected A)');
        });

        targetServerState.targetServerId = 'server-b';
        targetServerState.targetServerName = 'Server B';

        await hook.rerender();
        await settleNewSessionScreenModel();

        await waitForModelAssertion(() => {
            expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('machine-2', expect.objectContaining({ serverId: 'server-a' }));
            expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('machine-2', expect.objectContaining({ serverId: 'server-b' }));
            expect((model?.simpleProps?.agentPickerOptions ?? []).map((o: any) => o?.label)).toContain('Codex (Projected B)');
        });
    });

    it('keeps a routed plugin backend identity separate from optional bundled behavior metadata', async () => {
        let resolveProjection:
            | ((value: Readonly<{ supported: true; projection: unknown }> | Readonly<{ supported: false; reason: string }>) => void)
            | null = null;

        searchParamsState.value = {
            backendTargetKey: 'agent:acme.review/review',
            backendTarget: JSON.stringify(reviewAgentTarget),
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
            backendTarget: reviewAgentTarget,
            authoringDraft: expect.objectContaining({ agentTarget: null }),
        }));
        expect(model?.simpleProps?.agentType).toBe('acme.review/review');

        await act(async () => {
            resolveProjection?.({
                supported: true,
                projection: daemonAgentProjection({ title: 'Acme Review Agent', identity: reviewAgentTarget.identity, catalogAgentId: 'claude' }),
            });
        });

        await settleNewSessionScreenModel();

        await waitForModelAssertion(() => {
            expect(useCreateNewSessionArgsRef.current).toEqual(expect.objectContaining({
                authoringDraft: expect.objectContaining({ agentTarget: reviewAgentTarget }),
            }));
            expect(model?.simpleProps?.agentType).toBe('acme.review/review');
            expect(model?.simpleProps?.agentLabel).toBe('Acme Review Agent');
        });
    });

    it('retains an authored absent machine and its Agent display until the machine is explicitly cleared', async () => {
        settingsState.useEnhancedSessionWizard = true;
        const projectedTarget = { kind: 'agent' as const, identity: projectedCodexIdentity };
        searchParamsState.value = {
            backendTargetKey: 'agent:acme.projected/codex',
            backendTarget: JSON.stringify(projectedTarget),
        };
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: daemonAgentProjection({ title: 'Codex (Projected)', identity: projectedCodexIdentity, catalogAgentId: 'codex' }),
        });

        let model: any = null;
        const hook = await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });
        await settleNewSessionScreenModel();

        await waitForModelAssertion(() => {
            expect(model?.wizardProps?.agent?.agentPickerOptions).toEqual(expect.arrayContaining([
                expect.objectContaining({ id: 'agent:acme.projected/codex', label: 'Codex (Projected)' }),
            ]));
            expect(model?.wizardProps?.agent?.agentLabel).toBe('Codex (Projected)');
        });

        activeMachinesState.value = [];
        await hook.rerender();
        await settleNewSessionScreenModel();

        expect(model?.wizardProps?.machine?.selectedMachine).toBeNull();
        expect(model?.wizardProps?.machine?.selectedPath).toBe('/repo/custom');
        expect(model?.wizardProps?.agent?.agentPickerOptions).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'agent:acme.projected/codex', label: 'Codex (Projected)' }),
        ]));
        expect(model?.wizardProps?.agent?.agentLabel).toBe('Codex (Projected)');
        expect(useCreateNewSessionArgsRef.current).toEqual(expect.objectContaining({
            authoringDraft: expect.objectContaining({
                executionTarget: { kind: 'machine', target: { serverId: 'server-a', machineId: 'machine-2' } },
                agentTarget: projectedTarget,
            }),
        }));
        // Retained authored identity is display continuity, not permission to spawn.
        expect(model?.wizardProps?.footer?.canCreate).toBe(false);

        await act(async () => { model?.wizardProps?.machine?.setSelectedMachineId(null); });
        await settleNewSessionScreenModel();

        expect((model?.wizardProps?.agent?.agentPickerOptions ?? []).map((o: any) => o?.label)).not.toContain('Codex (Projected)');
        expect(useCreateNewSessionArgsRef.current).toEqual(expect.objectContaining({
            authoringDraft: expect.objectContaining({ executionTarget: null, agentTarget: null }),
        }));
        expect(model?.wizardProps?.footer?.canCreate).toBe(false);
    });

    it('ignores stale built-in profile catalog entries that no longer resolve', async () => {
        settingsState.favoriteProfiles = ['missing-built-in-profile'];

        let model: any = null;
        await expect(renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        })).resolves.toBeTruthy();

        expect(model?.simpleProps ?? model?.wizardProps).toBeTruthy();
    });

    it('clears remembered Claude plan mode when the user switches the new-session mode back to build', async () => {
        const backendTarget = { kind: 'backend' as const, backendId: 'claude' as const };
        const scopeKey = buildRememberedEngineSelectionScopeKey({
            serverId: 'server-a',
            backendTarget,
        });
        (settingsState as any).rememberLastEngineSelectionsV1 = true;
        authoringMemoryState.lastEngineSelectionsByScopeV1 = {
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

        expect(projectAuthoringMemory(authoringMemoryState).currentRememberedEngineSelectionsByScopeV1[scopeKey]?.acpSessionModeId).toBeNull();
    });

    it('does not expose a retained Provider projection after the spawn-scoped feature decision disables Providers', async () => {
        settingsState.useEnhancedSessionWizard = true;
        featureFlags.providersEnabled = true;
        const retainedGroup = retainedProviderProjectionGroup();
        const providerProjection = createDeferred<{
            status: 'success';
            agentTargetKey: string;
            groups: readonly SessionModelProjectionGroup[];
        }>();
        describeProviderModelsMock.mockReturnValue(providerProjection.promise);

        type CapturedWizardModel = Readonly<{
            wizardProps?: Readonly<{
                agent?: Readonly<{
                    providerModelGroups?: readonly SessionModelProjectionGroup[];
                    providerModelProjectionAuthoritative?: boolean;
                    modelSelection?: ReturnType<typeof SessionModelSelectionV1Schema.parse> | null;
                    setModelSelection?: (selection: ReturnType<typeof SessionModelSelectionV1Schema.parse> | null) => void;
                }>;
            }>;
        }>;
        const renderedModels: CapturedWizardModel[] = [];
        const hook = await renderNewSessionScreenModel((nextModel) => {
            renderedModels.push(nextModel as CapturedWizardModel);
        });
        expect(renderedModels.at(-1)?.wizardProps?.agent?.providerModelProjectionAuthoritative).toBe(false);
        await waitForModelAssertion(() => { expect(describeProviderModelsMock).toHaveBeenCalled(); });

        providerProjection.resolve({
            status: 'success',
            agentTargetKey: 'agent:happier.agent.claude/claude',
            groups: [retainedGroup],
        });
        await settleNewSessionScreenModel();
        await waitForModelAssertion(() => {
            expect(renderedModels.at(-1)?.wizardProps?.agent?.providerModelGroups).toEqual([retainedGroup]);
            expect(renderedModels.at(-1)?.wizardProps?.agent?.providerModelProjectionAuthoritative).toBe(true);
        });

        const exactSelection = SessionModelSelectionV1Schema.parse({
            v: 1,
            updatedAt: 100,
            ref: {
                ...retainedGroup.rows[0]?.ref,
                agentTargetKey: 'agent:happier.agent.claude/claude',
            },
        });
        await act(async () => {
            renderedModels.at(-1)?.wizardProps?.agent?.setModelSelection?.(exactSelection);
        });
        await settleNewSessionScreenModel({ cycles: 2, turns: 2 });

        const disabledRenderStart = renderedModels.length;
        featureFlags.providersEnabled = false;
        await hook.rerender();
        await settleNewSessionScreenModel();

        const disabledRenders = renderedModels.slice(disabledRenderStart);
        expect(disabledRenders.length).toBeGreaterThan(0);
        expect(disabledRenders.every((model) => (
            (model.wizardProps?.agent?.providerModelGroups ?? []).length === 0
        ))).toBe(true);
        expect(disabledRenders.every((model) => (
            model.wizardProps?.agent?.providerModelProjectionAuthoritative === false
        ))).toBe(true);
        expect(disabledRenders.at(-1)?.wizardProps?.agent?.modelSelection).toEqual(exactSelection);
    }, 120_000);

    it('shares the pending experimental-model transaction with compact agent-picker details', async () => {
        settingsState.useEnhancedSessionWizard = true;
        featureFlags.providersEnabled = true;
        const modalResult = createDeferred<boolean>();
        modalConfirmMock.mockReturnValueOnce(modalResult.promise);

        let model: any = null;
        await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });
        await settleNewSessionScreenModel();

        const initialOption = model?.wizardProps?.agent?.agentPickerOptions?.find?.(
            (option: { id: string }) => option.id === 'agent:happier.agent.claude/claude',
        );
        const initialConfirmation = model?.wizardProps?.agent?.experimentalModelConfirmation;
        expect(initialOption).toBeTruthy();
        expect(initialConfirmation).toBeTruthy();

        let confirmationResult!: Promise<boolean>;
        await act(async () => {
            confirmationResult = initialConfirmation.confirm({
                kind: 'confirm-experimental',
                connectionId: ProviderConnectionIdSchema.parse('pc_work'),
                expectedConnectionRevision: 1,
                agentTargetKey: initialOption.id,
                modelId: 'experimental-model',
                compatibilityFingerprint: 'compatibility:v1:experimental',
                providerName: 'Gateway',
                modelName: 'Experimental model',
            }, vi.fn());
            await Promise.resolve();
        });
        await settleNewSessionScreenModel({ cycles: 1, turns: 1 });

        const pendingConfirmation = model?.wizardProps?.agent?.experimentalModelConfirmation;
        const pendingOption = model?.wizardProps?.agent?.agentPickerOptions?.find?.(
            (option: { id: string }) => option.id === initialOption.id,
        );
        const detail = pendingOption?.renderDetailContent?.();
        expect(pendingConfirmation?.pending).toBe(true);
        expect(model?.wizardProps?.footer?.canCreate).toBe(false);
        expect(useCreateNewSessionArgsRef.current).toEqual(expect.objectContaining({
            authoringCommitPending: true,
        }));
        expect(React.isValidElement<{ experimentalConfirmation?: unknown }>(detail)).toBe(true);
        if (!React.isValidElement<{ experimentalConfirmation?: unknown }>(detail)) {
            throw new Error('Expected the compact agent picker to render an engine detail');
        }
        expect(detail.props.experimentalConfirmation).toBe(pendingConfirmation);

        await act(async () => {
            modalResult.resolve(false);
            await confirmationResult;
        });
    });

    it('remembers the exact Provider-bound model selection chosen in the enhanced wizard', async () => {
        const backendTarget = { kind: 'backend' as const, backendId: 'codex' as const };
        const scopeKey = buildRememberedEngineSelectionScopeKey({ serverId: 'server-a', backendTarget });
        (settingsState as any).rememberLastEngineSelectionsV1 = true;
        (settingsState as any).useEnhancedSessionWizard = true;
        persistedDraft.agentType = 'codex';
        persistedDraft.backendTarget = backendTarget as any;
        const selection = SessionModelSelectionV1Schema.parse({
            v: 1,
            updatedAt: 100,
            ref: {
                agentTargetKey: 'agent:happier.agent.codex/codex',
                providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'),
                modelId: 'shared-model',
            },
        });

        let model: any = null;
        await renderNewSessionScreenModel((nextModel) => { model = nextModel; });
        expect(model?.variant).toBe('wizard');
        expect(typeof model?.wizardProps?.agent?.setModelSelection).toBe('function');
        await act(async () => {
            model?.wizardProps?.agent?.setModelSelection?.(selection);
        });
        await settleNewSessionScreenModel({ cycles: 2, turns: 2 });
        standardCleanup();

        expect(projectAuthoringMemory(authoringMemoryState).currentRememberedEngineSelectionsByScopeV1[scopeKey]?.modelSelection).toEqual(selection);
    });

    it('does not remember stale engine state when route params select a different backend', async () => {
        const codexTarget = { kind: 'backend' as const, backendId: 'codex' as const };
        const opencodeTarget = { kind: 'backend' as const, backendId: 'opencode' as const };
        const codexScopeKey = buildRememberedEngineSelectionScopeKey({
            serverId: 'server-a',
            backendTarget: codexTarget,
        });
        const opencodeScopeKey = buildRememberedEngineSelectionScopeKey({
            serverId: 'server-a',
            backendTarget: opencodeTarget,
        });
        (settingsState as any).rememberLastEngineSelectionsV1 = true;
        authoringMemoryState.lastEngineSelectionsByScopeV1 = {
            [codexScopeKey]: {
                v: 1,
                modelId: 'gpt-5.5',
                acpSessionModeId: 'plan',
                sessionConfigOptionOverrides: null,
                updatedAt: 1,
            },
        };
        persistedDraft.agentType = 'codex';
        persistedDraft.backendTarget = codexTarget as any;
        persistedDraft.modelMode = 'gpt-5.5';
        persistedDraft.acpSessionModeId = 'plan';
        searchParamsState.value = {
            backendTarget: JSON.stringify(opencodeTarget),
            backendTargetKey: 'agent:happier.agent.opencode/opencode',
        };

        await renderNewSessionScreenModel(() => {});
        await settleNewSessionScreenModel();

        standardCleanup();

        expect(authoringMemoryState.lastEngineSelectionsByScopeV1?.[opencodeScopeKey]).toBeUndefined();
        expect(projectAuthoringMemory(authoringMemoryState).currentRememberedEngineSelectionsByScopeV1[codexScopeKey]?.modelSelection?.ref.modelId).toBe('gpt-5.5');
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
        expect(useCreateNewSessionArgsRef.current?.launchIntentSignature).toEqual(expect.any(String));
        expect(model?.simpleProps?.checkoutCreationDraft).toEqual({
            kind: 'git_worktree',
            displayName: 'feature/auth',
            baseRef: 'main',
            branchMode: 'new',
        });
        expectNewWorktreeCheckoutChip(model, 'feature/auth');

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

    it('includes the source-context recipe in the launch attempt identity', async () => {
        searchParamsState.value = { dataId: 'source-context-seed' };
        const sourceContext = {
            v: 1,
            kind: 'session_replay',
            sourceSessionId: 'session-source',
            forkPoint: { type: 'seq', upToSeqInclusive: 12 },
        } as const;
        tempSessionDataState.value = {
            sourceContext,
            sourceContextServerId: 'server-a',
        };

        await renderNewSessionScreenModel(() => {});

        const signature = JSON.parse(String(useCreateNewSessionArgsRef.current?.launchIntentSignature));
        expect(signature.sourceContext).toEqual(sourceContext);
    });

    it('retains launch identity through attempt persistence and reads live typed intent before another render', async () => {
        const hook = await renderNewSessionScreenModel(() => {});
        await settleNewSessionScreenModel();
        const readArgs = () => {
            // The test's mocked hook captures the real screen-model producer.
            const args = useCreateNewSessionArgsRef.current as Parameters<typeof import('./useCreateNewSession').useCreateNewSession>[0] | null;
            if (!args?.readLaunchIntentSignature) throw new Error('Expected the live launch intent reader');
            return { ...args, readLaunchIntentSignature: args.readLaunchIntentSignature };
        };
        const signature = readArgs().readLaunchIntentSignature();
        await act(async () => { readArgs().onLaunchUserAttemptIdChange?.('retained-user-attempt'); });
        await settleNewSessionScreenModel();
        expect(readArgs().readLaunchIntentSignature()).toBe(signature);
        expect(readArgs().launchUserAttemptId).toBe('retained-user-attempt');

        readArgs().promptStore.setPrompt('A different authored request');
        expect(readArgs().readLaunchIntentSignature()).not.toBe(signature);
        await hook.rerender();
        await settleNewSessionScreenModel();
        expect(readArgs().launchUserAttemptId).toBeNull();
    });

    it('reads an authored Bot name change in launch intent before another render', async () => {
        Object.assign(persistedDraft, { initialSessionFacts: { bot: { kind: 'bot' } } });
        try {
            const hook = await renderNewSessionScreenModel(() => {});
            await settleNewSessionScreenModel();
            const creation = hook.getCurrent().botCreation;
            const readIntent = useCreateNewSessionArgsRef.current?.readLaunchIntentSignature;
            if (!creation || typeof readIntent !== 'function') throw new Error('Expected the authored Bot name and launch identity');
            const before = readIntent();
            creation.onSessionNameChange('A different Bot name');
            expect(readIntent()).not.toBe(before);
        } finally { Reflect.deleteProperty(persistedDraft, 'initialSessionFacts'); }
    });

    it('uses the repository-selected access and Team context for both persistence and launch', async () => {
        persistedDraft.access = { grants: [{
            subject: { kind: 'account', accountId: 'alice' },
            accessLevel: 'view',
            canApprovePermissions: false,
        }] };
        persistedDraft.primaryTeamId = 'team-old';
        let model: any = null;
        await renderNewSessionScreenModel((nextModel) => { model = nextModel; });

        persistedDraft.access = { grants: [{
            subject: { kind: 'account', accountId: 'bob' },
            accessLevel: 'edit',
            canApprovePermissions: false,
        }] };
        persistedDraft.primaryTeamId = 'team-synced';
        persistedDraftRevisionState.value = 2;
        await act(async () => {
            await runFocusEffects();
        });
        await settleNewSessionScreenModel();

        expect(model).not.toBeNull();
        expect(useCreateNewSessionArgsRef.current).toEqual(expect.objectContaining({
            authoringDraft: expect.objectContaining({
                access: persistedDraft.access,
                primaryTeamId: 'team-synced',
            }),
        }));

        await act(async () => {
            model?.simpleProps?.setSessionPrompt('unrelated prompt edit');
        });
        saveNewSessionDraftMock.mockClear();
        await act(async () => { persistDraftNowRef.current?.(); });
        expect(saveNewSessionDraftMock).toHaveBeenLastCalledWith(expect.objectContaining({
            input: 'unrelated prompt edit',
            access: persistedDraft.access,
            primaryTeamId: 'team-synced',
        }));
    });

    it('uses the repository-selected access and Team context for wizard persistence and launch', async () => {
        (settingsState as any).useEnhancedSessionWizard = true;
        persistedDraft.access = { grants: [{
            subject: { kind: 'account', accountId: 'alice' },
            accessLevel: 'view',
            canApprovePermissions: false,
        }] };
        persistedDraft.primaryTeamId = 'team-old';
        let model: any = null;
        await renderNewSessionScreenModel((nextModel) => { model = nextModel; });
        expect(model?.variant).toBe('wizard');

        persistedDraft.access = { grants: [{
            subject: { kind: 'account', accountId: 'bob' },
            accessLevel: 'edit',
            canApprovePermissions: false,
        }] };
        persistedDraft.primaryTeamId = 'team-synced';
        persistedDraftRevisionState.value = 2;
        await act(async () => {
            await runFocusEffects();
        });
        await settleNewSessionScreenModel();

        expect(model).not.toBeNull();
        expect(useCreateNewSessionArgsRef.current).toEqual(expect.objectContaining({
            authoringDraft: expect.objectContaining({
                access: persistedDraft.access,
                primaryTeamId: 'team-synced',
            }),
        }));

        await act(async () => {
            model?.wizardProps?.footer?.setSessionPrompt('unrelated wizard prompt edit');
        });
        saveNewSessionDraftMock.mockClear();
        await act(async () => { persistDraftNowRef.current?.(); });
        expect(saveNewSessionDraftMock).toHaveBeenLastCalledWith(expect.objectContaining({
            input: 'unrelated wizard prompt edit',
            access: persistedDraft.access,
            primaryTeamId: 'team-synced',
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

    it('keeps the attachment flow id stable when the route remounts the same draft', async () => {
        const draftId = 'draft-attachment-remount';
        let firstModel: any = null;
        const firstHook = await renderNewSessionScreenModel((nextModel) => {
            firstModel = nextModel;
        }, { draftId });
        const firstAttachmentFlowId = firstModel?.simpleProps?.attachmentFlowId;
        expect(typeof firstAttachmentFlowId).toBe('string');
        expect(firstAttachmentFlowId.length).toBeGreaterThan(0);

        await firstHook.unmount();

        let secondModel: any = null;
        const secondHook = await renderNewSessionScreenModel((nextModel) => {
            secondModel = nextModel;
        }, { draftId });

        expect(secondModel?.simpleProps?.attachmentFlowId).toBe(firstAttachmentFlowId);

        await secondHook.unmount();
    });

    it('leaves an ambiguous seeded placement unresolved until the reader selects its normal route inputs', async () => {
        const draftId = 'draft-placement-candidates';
        const candidates = [{
            projectKey: { id: 'project-api' },
            serverId: 'server-api',
            machineId: 'machine-api',
            rootPath: '/worktrees/api',
            label: 'API',
            reachable: true,
            worktrees: [],
        }, {
            projectKey: { id: 'project-web' },
            serverId: 'server-web',
            machineId: 'machine-web',
            rootPath: '/worktrees/web',
            label: 'Web',
            reachable: true,
            worktrees: [],
        }];
        persistedDraft.placementCandidates = candidates;

        let model: any = null;
        const hook = await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        }, { draftId });

        // One where-it-runs control: the candidates lead the folder chip's own picker, with no second chip.
        expect(model?.simpleProps?.agentInputExtraActionChips?.find(
            (entry: any) => entry?.key === 'new-session-seeded-placement',
        )).toBeUndefined();
        const requestClose = vi.fn();
        const content = model?.simpleProps?.pathPopover?.renderContent?.({ requestClose });
        const section = content?.props?.leadingSections?.[0];
        if (!section || section.kind !== 'static') throw new Error('expected seeded placement options in the folder picker');

        // Presentation alone never turns the first candidate into a target.
        expect(routerSetParamsMock).not.toHaveBeenCalled();
        expect(section.options).toHaveLength(2);

        await act(async () => {
            section.options[1]?.onSelect?.();
        });

        expect(routerSetParamsMock).toHaveBeenCalledWith({
            spawnServerId: 'server-web',
            machineId: 'machine-web',
            directory: '/worktrees/web',
        });
        expect(saveNewSessionDraftMock.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
            placementCandidates: [],
            targetServerId: 'server-web',
            selectedMachineId: 'machine-web',
            selectedPath: '/worktrees/web',
            executionTarget: { kind: 'machine', target: { serverId: 'server-web', machineId: 'machine-web' } },
        }));
        expect(requestClose).toHaveBeenCalled();
        await settleNewSessionScreenModel();
        const settled = model?.simpleProps?.pathPopover?.renderContent?.({ requestClose: () => {} });
        expect(settled?.props?.leadingSections ?? []).toHaveLength(0);

        await hook.unmount();
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
        expectNewWorktreeCheckoutChip(model, 'feature/first-render-fix');
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

        expect(model?.simpleProps?.promptStore?.getPrompt()).toBe('Persisted prompt');
        expect(model?.simpleProps?.agentType).toBe('codex');
        expect(model?.simpleProps?.permissionMode).toBe('safe-yolo');
        expect(model?.simpleProps?.selectedPath).toBe('/repo/from-session');
        expect(model?.simpleProps?.machineName).toBe('Machine One');
        expect(model?.simpleProps?.resumeSessionId).toBe('');
        expect(useCreateNewSessionArgsRef.current).toEqual(expect.objectContaining({
            authoringDraft: expect.objectContaining({
                prompt: 'Persisted prompt',
                displayText: 'Persisted prompt',
                agentTarget: agentTarget('codex'),
                permissionMode: 'safe-yolo',
                modelSelection: expect.objectContaining({
                    ref: expect.objectContaining({ modelId: 'gpt-5' }),
                }),
                acpSessionModeId: 'plan',
                resumeSessionId: null,
            }),
        }));
        expect(loadNewSessionDraftMock).toHaveBeenCalled();
    });

    it('drops a persisted Claude model when a route-selected Codex backend owns the new session', async () => {
        searchParamsState.value = {
            backendTarget: JSON.stringify({ kind: 'backend', backendId: 'codex' }),
            backendTargetKey: 'agent:happier.agent.codex/codex',
        };
        persistedDraft.agentType = 'claude';
        persistedDraft.backendTarget = { kind: 'backend', backendId: 'claude' } as any;
        persistedDraft.modelMode = 'claude-opus-4-8';

        let model: any = null;
        await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        expect(model?.simpleProps?.agentType).toBe('codex');
        expect(model?.simpleProps?.modelMode).toBe('default');
        expect(useCreateNewSessionArgsRef.current).toEqual(expect.objectContaining({
            authoringDraft: expect.objectContaining({
                agentTarget: agentTarget('codex'),
                modelSelection: null,
            }),
        }));
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
                    launch: { kind: 'command' as const, command: 'custom-acp', args: ['serve'] },
                    env: {},
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

        await waitForModelAssertion(() => {
            expect(model?.simpleProps?.agentType).toBe('custom-acp');
            expect(model?.simpleProps?.agentLabel).toBe('Review Bot');
        });
        await settleNewSessionScreenModel();
        expect(useCreateNewSessionArgsRef.current).toEqual(expect.objectContaining({
            authoringDraft: expect.objectContaining({
                agentTarget: configuredReviewAgentTarget,
            }),
        }));

        await act(async () => {
            persistDraftNowRef.current?.();
        });

        expect(saveNewSessionDraftMock.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
            agentTarget: configuredReviewAgentTarget,
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
                    launch: { kind: 'command' as const, command: 'custom-acp', args: ['serve'] },
                    env: {},
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

        await waitForModelAssertion(() => {
            expect(model?.simpleProps?.agentType).toBe('custom-acp');
            expect(model?.simpleProps?.agentLabel).toBe('Review Bot');
            expect(useCreateNewSessionArgsRef.current).toEqual(expect.objectContaining({
                authoringDraft: expect.objectContaining({ agentTarget: configuredReviewAgentTarget }),
            }));
        });
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
        expectNewWorktreeCheckoutChip(model, 'feature/focused-browser-fix');
    });

    it('re-hydrates prompt and resume selection coherently when a newer draft is loaded on focus', async () => {
        persistedDraft.input = 'Old persisted prompt';
        persistedDraft.resumeSessionId = 'sess_old';
        persistedDraft.updatedAt = 123;

        let model: any = null;
        await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        expect(model?.simpleProps?.promptStore?.getPrompt()).toBe('Old persisted prompt');
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

        expect(model?.simpleProps?.promptStore?.getPrompt()).toBe('Focused draft prompt');
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

    it('hydrates capabilitySelection into the capabilities chip flow and persists it with the draft', async () => {
        saveNewSessionDraftMock.mockClear();
        persistDraftNowRef.current = null;

        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await renderNewSessionProbe(Probe);

        expect(Array.isArray(model?.simpleProps?.agentInputExtraActionChips)).toBe(true);
        expect(model?.simpleProps?.agentInputExtraActionChips).toContainEqual(expect.objectContaining({
            key: 'session-capabilities',
            controlId: 'capabilities',
        }));

        await act(async () => {
            persistDraftNowRef.current?.();
        });

        expect(saveNewSessionDraftMock).toHaveBeenCalledWith(expect.objectContaining({
            agentTarget: agentTarget('claude'),
            capabilitySelection: { mcp: {
                v: 1,
                managedServersEnabled: false,
                forceIncludeServerIds: ['server-portable'],
                forceExcludeServerIds: ['server-disabled'],
            } },
        }));

    });

    it('persists canonical inferred workspace selection in autosaved drafts', async () => {
        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        function Probe() {
            useNewSessionScreenModel();
            return null;
        }

        await renderNewSessionProbe(Probe);

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

        await renderNewSessionProbe(Probe);

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
            agentTarget: agentTarget('claude'),
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
                    launch: { kind: 'command' as const, command: 'custom-acp', args: ['serve'] },
                    env: {},
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

        await renderNewSessionProbe(Probe);

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
                backendTargetKey: 'agent:happier.agent.custom-acp/custom-acp:definition:review-bot',
            }),
        }));
        expect(JSON.parse(routerPushMock.mock.calls.at(-1)?.[0]?.params?.backendTarget)).toEqual(configuredReviewAgentTarget);
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

        await renderNewSessionProbe(Probe);

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
                backendTargetKey: 'agent:happier.agent.codex/codex',
                machineId: 'machine-2',
            }),
        }));
        expect(JSON.parse(pushPayload?.params?.backendTarget)).toEqual(agentTarget('codex'));
        expect(pushPayload?.params?.backendTarget).not.toContain('stale-review-bot');
        expect(pushPayload?.params?.backendTargetKey).toBe('agent:happier.agent.codex/codex');
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

        const claudeOption = model?.simpleProps?.agentPickerOptions?.find?.((option: { id: string }) => option.id === 'agent:happier.agent.claude/claude');
        expect(claudeOption).toBeTruthy();

        await act(async () => {
            model?.simpleProps?.onAgentPickerSelect?.(claudeOption.id);
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

        await renderNewSessionProbe(Probe);

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

        await renderNewSessionProbe(Probe);

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

        await renderNewSessionProbe(Probe);

        const requestClose = vi.fn();
        const element = model?.simpleProps?.pathPopover?.renderContent?.({ requestClose });
        expect(element).toBeTruthy();
        // The popover wrapper reads recent paths at intent, then renders the shared path content.
        expect((element.type as { name?: string }).name).toBe('NewSessionPopoverPathSelectionContent');

        const props = element.props as { onBeforeBrowseMachinePath?: unknown };
        expect(props.onBeforeBrowseMachinePath).not.toBe(requestClose);
        expect(props.onBeforeBrowseMachinePath).toBeUndefined();
    });

    it('keeps the current route stable and exposes a shared resume popover in the simple panel when resume is available', async () => {
        agentResumeSupportState.supportsVendorResume = true;
        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await renderNewSessionProbe(Probe);

        expect(model?.simpleProps?.showResumePicker).toBe(true);
        expect(typeof model?.simpleProps?.resumePopover?.renderContent).toBe('function');
        expect(routerSetParamsMock).not.toHaveBeenCalled();
        expect(routerPushMock).not.toHaveBeenCalled();
    });

    it('opens the shared direct-sessions resume browser modal from the resume popover without navigating away', async () => {
        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;
        const portalTarget = { tag: 'new-session-parent-modal-target' } as unknown as Element;
        featureFlags.externalSessionsEnabled = true;
        externalSessionBrowseSupportState.supported = true;

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
        expect(rendered.props.resumeBrowse).toEqual(expect.objectContaining({ enabled: true }));

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
        agentResumeSupportState.supportsVendorResume = true;
        externalSessionBrowseSupportState.supported = true;
        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await renderNewSessionProbe(Probe);

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

        await renderNewSessionProbe(Probe);

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

        await renderNewSessionProbe(Probe);

        await act(async () => {
            // Hold the native interaction queue at the platform boundary so cancellation
            // precedes delivery; the web zero-delay fallback would already have fired.
            platformOsState.value = 'ios';
            try { model?.wizardProps?.profiles?.openProfileEdit?.({}); }
            finally { platformOsState.value = 'web'; }
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
        authoringMemoryState.lastUsedProfile = 'profile_disabled';
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
        await waitForModelAssertion(() => {
            expect(model?.wizardProps?.profiles?.profiles).toEqual(expect.arrayContaining([
                expect.objectContaining({ id: 'profile_disabled' }),
            ]));
            expect(model?.wizardProps?.profiles?.selectedProfileId).toBeNull();
        });
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

        await renderNewSessionProbe(Probe);

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

    it('keeps an explicit Default Environment selection when last-used profile state changes', async () => {
        settingsState.useProfiles = true;
        settingsState.useEnhancedSessionWizard = true;
        authoringMemoryState.lastUsedProfile = 'profile_previous';
        const previousProfile = {
            id: 'profile_previous',
            name: 'Previous profile',
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
        };
        settingsState.profiles = [
            previousProfile,
            { ...previousProfile, id: 'profile_new', name: 'New profile' },
        ];

        let model: any = null;
        const hook = await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        await waitForModelAssertion(() => {
            expect(model?.wizardProps?.profiles?.profiles).toEqual(expect.arrayContaining([
                expect.objectContaining({ id: 'profile_previous' }),
                expect.objectContaining({ id: 'profile_new' }),
            ]));
            expect(model?.wizardProps?.profiles?.selectedProfileId).toBe('profile_previous');
        });

        await act(async () => {
            model?.wizardProps?.profiles?.onPressDefaultEnvironment?.();
            await flushHookEffects({ cycles: 1, turns: 2 });
        });
        expect(model?.wizardProps?.profiles?.selectedProfileId).toBeNull();

        authoringMemoryState.lastUsedProfile = 'profile_new';
        await hook.rerender();

        expect(model?.wizardProps?.profiles?.selectedProfileId).toBeNull();
    });

    it('persists updated checkout creation draft state after in-memory changes', async () => {
        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await renderNewSessionProbe(Probe);

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

        await renderNewSessionProbe(Probe);

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

        await renderNewSessionProbe(Probe);

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

        await renderNewSessionProbe(Probe);

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

        await renderNewSessionProbe(Probe);
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

        await renderNewSessionProbe(Probe);
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

        await renderNewSessionProbe(Probe);

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

        await renderNewSessionProbe(Probe);

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

        await renderNewSessionProbe(Probe);

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

        await renderNewSessionProbe(Probe);

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

        await renderNewSessionProbe(Probe);

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

        await renderNewSessionProbe(Probe);

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

        expect(model?.simpleProps?.machineName).toBe('account-b · Remote Builder');
        expect(model?.simpleProps?.selectedPath).toBe('/srv/remote/project');
    });

});
