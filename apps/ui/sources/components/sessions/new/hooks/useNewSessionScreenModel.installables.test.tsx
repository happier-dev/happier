import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    buildBackendTargetKey,
    convertBackendTargetRefV2ToV1,
    readBackendTargetRefV2,
    PluginProjectionV2Schema,
    SessionSpawnNewInputV2Schema,
    SessionSpawnNewResultV1Schema,
    V2SessionListResponseSchema,
    type AcpCatalogSettingsV1,
} from '@happier-dev/protocol';
import { qualifyPluginContributionReferenceV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { BUNDLED_AGENT_CONTRIBUTION_IDENTITIES } from '@happier-dev/agents/agent-ids';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DaemonWorkspaceFileListResponseSchema } from '@happier-dev/protocol/machines/workspaceFiles';
import { MachinesAgentsListOutputSchema } from '@happier-dev/protocol/capabilities';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRecordV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import {
    flushHookEffects,
    renderHook,
    renderScreen,
    createMachineFixture,
    createSessionListRenderableSessionFixture,
} from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createExistingSessionDirectoryPreflightResult, createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createAuthoringMemoryHttpBoundary } from '@/dev/testkit/mocks/authoringMemoryHttp';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { MachineAccessGrantsListResponseV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { readBackendTargetKeyV2, resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { sessionModelSelectionKey } from '@/components/sessions/modelPicker/sessionModelSelectionKey';
import { resetDynamicModelProbeCacheForTests } from '@/sync/domains/models/dynamicModelProbeCache';
import { resetDynamicConfigOptionsProbeCacheForTests } from '@/sync/domains/sessionControl/dynamicConfigOptionsProbeCache';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import type { StorageState } from '@/sync/store/types';
import type { NewSessionDraft } from '@/sync/domains/state/persistence';

import { createProfileCatalogHttpResponse, installNewSessionScreenModelCommonModuleMocks } from './newSessionScreenModelTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function buildBuiltInBackendTargetKey(backendId: string): string {
    return resolveBackendTargetKeyV2({ kind: 'backend', backendId });
}

function buildConfiguredAcpBackendTargetKey(configuredBackendId: string): string {
    return resolveBackendTargetKeyV2({
        kind: 'backend',
        backendId: configuredBackendId,
        configuredBackendId,
    });
}
const CUSTOM_ACP_AGENT_ID = CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1.localId;

function buildProfileCompatibilityTargetKey(target: unknown): string {
    // Real profile compatibility maps are still keyed by V1 backend target keys.
    // Normalize whatever we get into a V1 carrier and then serialize.
    try {
        return buildBackendTargetKey(convertBackendTargetRefV2ToV1(readBackendTargetRefV2(target as any)));
    } catch {
        return buildBackendTargetKey(target as any);
    }
}

const pendingFireAndForget = vi.hoisted((): Array<Promise<unknown>> => []);
const applySettingsMock = vi.hoisted(() => vi.fn());
const modalShowMock = vi.hoisted(() => vi.fn(() => 'modal-id'));
const modalAlertMock = vi.hoisted(() => vi.fn());
const agentInputActionChipActionIdsState = vi.hoisted(() => ({
    value: [] as string[],
}));

const enabledAgentIdsState = vi.hoisted(() => ({
    value: ['codex', 'claude'] as string[],
}));

type CliAvailabilityMockValue = Partial<{
    timestamp: number;
    available: Record<string, boolean | null>;
}>;

const cliAvailabilityDefaults = vi.hoisted(() => ({
    available: { codex: false, claude: true, opencode: null as boolean | null },
}));

const cliAvailabilityState = vi.hoisted(() => ({
    value: {} as CliAvailabilityMockValue,
}));

const featureEnabledState = vi.hoisted(() => ({
    sessionsDirect: false,
}));
const featureEnabledCalls = vi.hoisted(() => [] as Array<Readonly<{ featureId: string; scope: unknown }>>);
const chromeSafeAreaInsetsState = vi.hoisted(() => ({
    value: { top: 0, bottom: 0, left: 0, right: 0 },
}));
const preflightModelOptionsByTargetKeyState = vi.hoisted(() => ({
    value: {} as Record<string, Array<{ value: string; label: string; description?: string }>>,
}));
const preflightSessionModeOptionsByTargetKeyState = vi.hoisted(() => ({
    value: {} as Record<string, Array<{ id: string; name: string; description?: string }>>,
}));
const preflightConfigOptionsByTargetKeyState = vi.hoisted(() => ({
    value: {} as Record<string, Array<{
        id: string;
        name: string;
        type: string;
        currentValue: string;
        description?: string;
        options?: Array<{ value: string; name: string; description?: string }>;
    }>>,
}));

const profileCompatibilityState = vi.hoisted(() => ({
    isProfileCompatibleWithAgent: (((_profile: any, _agentId: string) => true) as (profile: any, agentId: string) => boolean),
    isProfileCompatibleWithBackendTarget: (((_profile: any, _target: any) => true) as (profile: any, target: any) => boolean),
    isProfileCompatibleWithAnyAgent: (((_profile: any, _agentIds: readonly string[]) => true) as (profile: any, agentIds: readonly string[]) => boolean),
    getProfileSupportedAgentIds: (((_profile: any) => [] as string[]) as (profile: any) => string[]),
}));

const testSettingsDefaults = vi.hoisted(() => ({
    recentMachinePaths: [] as Array<{ machineId: string; path: string }>,
    lastUsedAgent: 'codex',
    lastUsedBackendTarget: null as unknown,
    lastUsedPermissionMode: 'default',
    newSessionDefaultPersistenceModeV1: 'persisted' as 'persisted' | 'direct',
    newSessionDefaultPersistenceModeByTargetKeyV1: {} as Record<string, 'persisted' | 'direct'>,
    useEnhancedSessionWizard: false,
    useProfiles: false,
    sessionDefaultPermissionModeByTargetKey: {},
    actionsSettingsV1: {},
    experiments: false,
    featureToggles: {},
    dismissedCLIWarnings: {},
    sessionUseTmux: false,
    sessionTmuxByMachineId: {},
    favoriteDirectories: [],
    favoriteMachines: [],
    favoriteProfiles: [],
    currentFavoriteModelSelectionsV1: [],
    currentRememberedEngineSelectionsByScopeV1: {},
    profiles: [] as AIBackendProfile[],
    profileEnabledById: {} as Record<string, boolean>,
    secrets: [],
    secretBindingsByProfileId: {},
    serverSelectionGroups: [],
    serverSelectionActiveTargetKind: null as 'server' | 'group' | null,
    serverSelectionActiveTargetId: null as string | null,
    codexBackendMode: 'acp',
    installablesPolicyByMachineId: {},
    sessionWindowsRemoteSessionLaunchMode: 'hidden' as 'hidden' | 'windows_terminal' | 'console',
    backendEnabledByTargetKey: {} as Record<string, boolean>,
    mcpServersSettingsV1: {
        v: 1,
        strictMode: false,
        servers: [],
        bindings: [],
    },
    acpCatalogSettingsV1: {
        v: 2 as const,
        backends: [],
    } as AcpCatalogSettingsV1,
}));

const settingsState = vi.hoisted(() => ({
    ...testSettingsDefaults,
}));
const settingsRuntimeState = vi.hoisted(() => ({
    current: settingsState as typeof settingsState | undefined,
}));

const machineState = vi.hoisted(() => ({
    value: [
        { id: 'machine-1', metadata: { displayName: 'Machine One', host: 'one', homeDir: '/home/one' } },
    ] as Array<{ id: string; metadata: Record<string, unknown> }>,
}));

const machineCapabilitiesResultsState = vi.hoisted(() => ({
    value: {
        'dep.codex-acp': {
            ok: true as const,
            checkedAt: Date.now(),
            data: {
                installed: false,
                installDir: '/tmp',
                binPath: null,
                installedVersion: null,
                sourceKind: 'github_release_binary',
                lastInstallLogPath: null,
            },
        },
    } as Record<string, unknown>,
}));
const includeProjectedCodexAcpInstallableState = vi.hoisted(() => ({
    value: false,
}));
const homeState = vi.hoisted(() => ({ targetAccountId: '', targetServerUrl: '', targetServerId: '', activeServerId: '' }));

const storageState = vi.hoisted(() => ({
    // The `@session` picker's real candidate source: session-list rows, per server.
    sessionListRowsByServerId: {} as StorageState['sessionListRowsByServerId'],
}));
const routeParamsState = vi.hoisted(() => ({
    value: {} as Record<string, string | string[] | undefined>,
}));

const persistedDraft = vi.hoisted((): NewSessionDraft => ({
    input: '',
    selectedMachineId: 'machine-1',
    selectedPath: '/repo',
    selectedProfileId: null as string | null,
    selectedSecretId: null,
    agentType: 'codex',
    permissionMode: 'default',
    modelMode: 'default',
    acpSessionModeId: 'plan',
    backendNewSessionOptionStateByTargetKey: {},
    updatedAt: 123,
}));

const initialHookFlushOptions = { cycles: 2, turns: 2 } as const;

let authoringAccount: Readonly<{ dispose(): void }> | null = null;

async function activateAuthoringScope(scope: Readonly<{ serverId: string; accountId: string }>) {
    authoringAccount?.dispose();
    storageStore.getState().activateProfileScope(scope);
    await storageStore.getState().activateSettingsScope(scope);
    authoringAccount = await activateStorageAccountScope(scope);
}

async function renderNewSessionScreenModel(options: Readonly<{ openAgentPicker?: boolean; freshDraft?: boolean }> = {}) {
    const seedStore = () => {
        storageStore.getState().applySettingsLocal(settingsParse(settingsRuntimeState.current ?? {}));
        const machines = machineState.value.map(machine => createMachineFixture({
            ...machine, activeAt: Date.now(), metadata: { ...createMachineFixture().metadata!, ...machine.metadata },
        }));
        storageStore.getState().applyMachines(machines, true, { sourceServerId: homeState.targetServerId });
        storageStore.setState({ sessionListRowsByServerId: storageState.sessionListRowsByServerId });
        const activeScope = storageStore.getState().settingsScope;
        for (const scope of [activeScope, { serverId: homeState.targetServerId, accountId: 'account-1' }]) {
            if (!scope) continue;
            applyAcpCatalogSnapshot(scope, { status: 'ready', revision: 1,
                record: { v: 1, definitions: settingsState.acpCatalogSettingsV1.backends } }, true);
            applyProfileCatalogSnapshot(scope, {
                status: 'ready', source: 'legacy', records: [], diagnostics: [],
                referenceGuardRevision: 'absent', authority: 'inactive', control: null, controlRevision: 'absent',
            }, true, new Map(), { legacyProfiles: settingsState.profiles });
        }
    };
    seedStore();
    const scope = storageStore.getState().settingsScope;
    if (!scope) throw new Error('Installables journey requires its authenticated authoring Account');
    const draftId = crypto.randomUUID();
    routeParamsState.value = { ...routeParamsState.value, draftId };
    // These cases reopen retained authoring. A blank configuration-only user edit
    // deliberately does not create a kept New Session draft.
    if (!options.freshDraft) {
        writeNewSessionDraftToRepository({ scope, draftId, materializationIntent: 'seeded',
            draft: { ...persistedDraft, targetServerId: homeState.targetServerId } });
        expect(readNewSessionDraftFromRepository({ scope, draftId }), 'the model must receive the seeded repository draft').toMatchObject({
            selectedMachineId: persistedDraft.selectedMachineId,
            selectedPath: persistedDraft.selectedPath,
            selectedProfileId: persistedDraft.selectedProfileId,
            acpSessionModeId: persistedDraft.acpSessionModeId,
            targetServerId: homeState.targetServerId,
        });
    }
    const hook = await renderHook<any>(() => useNewSessionScreenModel({ draftId }) as any, {
        flushOptions: initialHookFlushOptions,
    });
    if (options.openAgentPicker) {
        await invokeHookAction(() => {
            const model = hook.getCurrent();
            const picker = model.variant === 'wizard' ? model.wizardProps.agent : model.simpleProps;
            picker.onAgentPickerVisibilityChange(true);
        });
        await vi.waitFor(() => {
            const model = hook.getCurrent();
            const picker = model.variant === 'wizard' ? model.wizardProps.agent : model.simpleProps;
            for (const [agentId, available] of Object.entries(cliAvailabilityState.value.available ?? {})) {
                if (available !== true || !enabledAgentIdsState.value.includes(agentId)) continue;
                expect(picker.agentPickerOptions.find((option: { id: string }) => option.id === buildBuiltInBackendTargetKey(agentId))?.disabled).toBe(false);
            }
        });
    }
    return { ...hook, rerender: async () => {
        await act(async () => { seedStore(); });
        await hook.rerender();
    } };
}

async function invokeHookAction(action: () => void | Promise<void>) {
    await act(async () => {
        await action();
    });
    await flushHookEffects({ cycles: 1, turns: 2 });
}

installNewSessionScreenModelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
                select: (options: any) => options?.web ?? options?.default ?? options?.ios ?? options?.android,
            },
            Text: 'Text',
            TextInput: 'TextInput',
            View: 'View',
            Pressable: 'Pressable',
            Dimensions: {
                get: () => ({ width: 900, height: 800 }),
            },
            InteractionManager: {
                runAfterInteractions: () => ({ cancel: () => {} }),
            },
            useWindowDimensions: () => ({ width: 900, height: 800 }),
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    text: '#000',
                    textSecondary: '#666',
                    shadow: { color: '#000' },
                    modal: { border: '#ddd' },
                    button: { primary: { background: '#00f', tint: '#fff' } },
                    groupped: { sectionTitle: '#999', background: '#fff' },
                    input: { background: '#fff', placeholder: '#999' },
                    radio: { active: '#00f' },
                    divider: '#ddd',
                    surface: '#fff',
                    surfaceHigh: '#f2f2f2',
                    surfaceHighest: '#e9e9e9',
                    surfacePressed: '#ececec',
                    surfacePressedOverlay: '#eee',
                    surfaceSelected: '#f7f7f7',
                    accent: { blue: '#00f' },
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
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                show: modalShowMock,
                alert: modalAlertMock,
                prompt: vi.fn(async () => null),
                confirm: vi.fn(async () => false),
            },
        }).module;
    },
    routerConfig: {
        router: { push: vi.fn(), replace: vi.fn(), back: vi.fn(), setParams: vi.fn() },
        params: () => routeParamsState.value,
        navigation: {},
        pathname: '/new',
    },
});
vi.doUnmock('@/sync/domains/state/storage');

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/components/ui/layout/useChromeSafeAreaInsets', () => ({
    useChromeSafeAreaInsets: () => chromeSafeAreaInsetsState.value,
}));

vi.mock('@/utils/platform/responsive', () => ({
    useHeaderHeight: () => 0,
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@react-navigation/native', () => ({
    useIsFocused: () => true,
    useFocusEffect: (_fn: any) => {},
}));

vi.mock('@/sync/store/settingsWriters', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/store/settingsWriters')>(),
    useApplySettings: () => applySettingsMock,
    useDeleteAiLaunchProfile: () => vi.fn(async () => {}),
}));

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => enabledAgentIdsState.value,
}));





/**
 * The machine RPC transport — a genuine system boundary, and the only thing stubbed on the
 * file-suggestion path. Everything above it (`suggestionFile` → `workspaceFileSearch` →
 * `machineWorkspaceFileList`) runs for real, so the address the host resolved is observed where it
 * actually matters: on the wire.
 */
const machineRpcResult = vi.hoisted(() => ({ value: {} as unknown }));


vi.mock('@/capabilities/installablesRegistry', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/capabilities/installablesRegistry')>();
    return {
        ...actual,
        getInstallablesRegistryEntries: (params?: Parameters<typeof actual.getInstallablesRegistryEntries>[0]) => (
            includeProjectedCodexAcpInstallableState.value && !params
                ? actual.getInstallablesRegistryEntries({
                    projectedInstallables: [{
                        id: 'codex-acp',
                        key: 'codex-acp',
                        capabilityId: 'dep.codex-acp',
                        sourceKind: 'github_release_binary',
                        display: { name: 'Codex ACP' },
                        defaultPolicy: {
                            autoInstallWhenNeeded: true,
                            autoUpdateMode: 'auto',
                        },
                        experimental: true,
                    }],
                })
                : actual.getInstallablesRegistryEntries(params)
        ),
    };
});

vi.mock('@/components/sessions/new/hooks/useNewSessionCapabilitiesPrefetch', () => ({
    useNewSessionCapabilitiesPrefetch: () => {},
}));

vi.mock('@/components/sessions/new/hooks/useNewSessionDraftAutoPersist', () => ({
    useNewSessionDraftAutoPersist: () => {},
}));


vi.mock('@/components/sessions/agentInput/sessionActions/listAgentInputActionChipActionIds', () => ({
    listAgentInputActionChipActionIds: () => agentInputActionChipActionIdsState.value,
}));

vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (promise: Promise<unknown>) => {
        pendingFireAndForget.push(promise);
        void promise.catch(() => {});
    },
}));

vi.mock('@/utils/timing/runAfterInteractionsWithFallback', () => ({
    runAfterInteractionsWithFallback: (fn: () => void) => {
        fn();
        return () => {};
    },
}));

vi.mock('@/utils/sessions/tempDataStore', () => ({
    getTempData: () => null,
}));

vi.mock('@/hooks/server/useAutomationsSupport', () => ({
    useAutomationsSupport: () => ({ enabled: false }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string, scope?: unknown) => {
        featureEnabledCalls.push({ featureId, scope });
        return featureId === 'sessions.direct' ? featureEnabledState.sessionsDirect : false;
    },
}));

vi.mock('@/components/sessions/new/modules/automationFeatureGate', () => ({
    resolveEffectiveAutomationDraft: ({ draft }: any) => draft,
    shouldShowAutomationActionChips: () => false,
}));

vi.mock('@/components/sessions/new/hooks/newSessionModelModePolicy', () => ({
    resolveInitialNewSessionModelMode: () => 'default',
    coerceNewSessionModelMode: ({ modelMode }: any) => modelMode,
}));

vi.mock('@/sync/domains/profiles/profileCompatibility', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        getProfileEnvironmentVariables: () => [],
        isProfileCompatibleWithAgent: (profile: any, agentId: string) =>
            profileCompatibilityState.isProfileCompatibleWithAgent(profile, agentId),
        isProfileCompatibleWithBackendTarget: (profile: any, target: any) =>
            profileCompatibilityState.isProfileCompatibleWithBackendTarget(profile, target),
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
    getProfileSupportedAgentIds: (profile: any) => profileCompatibilityState.getProfileSupportedAgentIds(profile),
    isProfileCompatibleWithAnyAgent: (profile: any, agentIds: readonly string[]) =>
        profileCompatibilityState.isProfileCompatibleWithAnyAgent(profile, agentIds),
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

vi.mock('@/hooks/machine/useMachineEnvPresence', () => ({
    useMachineEnvPresence: () => ({ isPreviewEnvSupported: true, isLoading: false, meta: {}, refresh: vi.fn() }),
}));

vi.mock('@/components/sessions/new/hooks/useSecretRequirementFlow', () => ({
    useSecretRequirementFlow: () => ({
        suppressNextSecretAutoPromptKeyRef: { current: null },
        openSecretRequirementModal: vi.fn(),
        openSecretRequirementModalByKey: vi.fn(),
        selectedSecretIdByProfileIdByEnvVarName: {},
        setSelectedSecretIdByProfileIdByEnvVarName: vi.fn(),
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        setSessionOnlySecretValueByProfileIdByEnvVarName: vi.fn(),
        openSecretValueEdit: vi.fn(),
    }),
}));

// IndexedDB is the browser persistence boundary; the real draft repository prepares and runs beneath it.
vi.mock('@/sync/domains/state/browserRecordStorage', async () => {
    const { createBrowserRecordStorageModuleMock } = await import('@/dev/testkit/mocks/browserRecordStorage');
    return createBrowserRecordStorageModuleMock();
});

// Compile the cold screen graph during collection, before a behavior test owns
// an act scope. Otherwise a timed-out import can resume inside the next case.
const network = await installSessionOpsNetworkBoundary();
const restoreActionExecutorModuleLoader = await installRealActionExecutorModuleLoader();
const createdSessions = new Map<string, ReturnType<typeof createPlainSessionCurrentProjectionRecordFixture>>();
const authoringMemoryHttp = createAuthoringMemoryHttpBoundary();
let promptLibraryHttp = createPromptLibraryCatalogBoundary();
let creationHome: Readonly<{ id: string; accountId: string; serverUrl: string }>;
let creationConnectionActive = false;
function spawnRequests() {
    return network.requests.filter(request => request.method === RPC_METHODS.SESSION_SPAWN_NEW);
}
function dependencyInstallRequests() {
    return network.requests.filter(request => request.method === RPC_METHODS.CAPABILITIES_INVOKE
        && typeof request.payload === 'object' && request.payload !== null
        && 'id' in request.payload && request.payload.id === 'dep.codex-acp'
        && 'method' in request.payload && request.payload.method === 'install');
}
async function restoreCreationAccount() {
    const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
    await loadSyncSingletonForTests();
    const { getActiveServerSnapshot, getServerProfileById } = await import('@/sync/domains/server/serverProfiles');
    const home = getServerProfileById(getActiveServerSnapshot().serverId);
    if (!home) throw new Error('Creation fixture Home is unavailable');
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.id });
    if (!credentials) throw new Error('Creation fixture Account is unavailable');
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    await act(async () => { await restoreConnectionToActiveServer(credentials); });
    creationConnectionActive = true;
}
const { storage: storageStore } = await import('@/sync/domains/state/storageStore');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { applyAcpCatalogSnapshot } = await import('@/sync/store/settings/acpCatalogSnapshot');
const { applyProfileCatalogSnapshot } = await import('@/sync/store/settings/profileCatalogSnapshot');
const { setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
const { writeNewSessionDraftToRepository, readNewSessionDraftFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
const { activateStorageAccountScope } = await import('@/dev/testkit/mocks/storage');
const { useNewSessionScreenModel } = await import('./useNewSessionScreenModel');
afterEach(async () => {
    if (creationConnectionActive) {
        const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
        await disconnectActiveServerConnection();
        creationConnectionActive = false;
    }
    authoringAccount?.dispose();
    authoringAccount = null;
    const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
    await serverScopedRpcSocketPool.stopAll();
    serverScopedRpcSocketPool.resetForTests();
    const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
    resetScopedMachineTransportCacheForTests();
});
afterAll(async () => {
    restoreActionExecutorModuleLoader();
    await network.dispose();
});

describe('useNewSessionScreenModel (installables)', () => {
    beforeEach(async () => {
        // Cases reuse the same Home/machine/Agent with different probe responses.
        // Clearing physical storage alone leaves these module-owned observations warm.
        resetDynamicModelProbeCacheForTests();
        resetDynamicConfigOptionsProbeCacheForTests();
        network.resetRequests();
        const targetHome = await network.addHome('https://installables-target.example.test', 'account-1');
        homeState.targetServerId = targetHome.id;
        homeState.targetAccountId = targetHome.accountId;
        homeState.targetServerUrl = targetHome.serverUrl;
        creationHome = await network.addHome('https://installables-active.example.test', 'acct_active');
        homeState.activeServerId = creationHome.id;
        await setActiveServerId(homeState.activeServerId);
        const { BUNDLED_CANONICAL_AGENT_DECLARATIONS } = await import('@/agents/registry/generatedBundledPluginEntries');
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, installedPackagesById: {},
            agentsById: Object.fromEntries(Object.entries(BUNDLED_AGENT_CONTRIBUTION_IDENTITIES).map(([id, identity]) => [id, {
                id, identity, title: id,
                connectedAccounts: BUNDLED_CANONICAL_AGENT_DECLARATIONS[id as keyof typeof BUNDLED_CANONICAL_AGENT_DECLARATIONS]?.connectedAccounts.map(purpose => ({
                    ...purpose,
                    service: qualifyPluginContributionReferenceV1(purpose.service, identity.pluginId),
                })) ?? [],
                capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
            }])),
            actionsById: {}, familiesById: {},   resourcesById: {}, settingsById: {}, diagnostics: [],
        });
        network.setRpcResponder(async ({ method, payload }) => {
            if (method === RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT) {
                return createExistingSessionDirectoryPreflightResult(payload);
            }
            if (method === RPC_METHODS.SESSION_SPAWN_NEW) {
                const input = SessionSpawnNewInputV2Schema.parse(payload);
                const result = SessionSpawnNewResultV1Schema.parse({
                    type: 'success', disposition: 'created', sessionId: 'session-created',
                    executionTarget: input.executionTarget,
                    organizationPlacement: input.organizationPlacement ?? { folderId: null, tagIds: [] },
                    initialInput: input.initialInput ? { status: 'accepted', localId: 'initial-input' } : { status: 'notRequested' },
                });
                if (result.type !== 'success') throw new Error('Creation boundary returned a non-success fixture');
                createdSessions.set(`${input.executionTarget.serverId}|${result.sessionId}`,
                    createPlainSessionCurrentProjectionRecordFixture({ id: result.sessionId,
                        metadata: { path: '/repo', host: 'fixture-host', machineId: input.executionTarget.machineId } }));
                return result;
            }
            if (method.includes('contributionRegistryProjection.describe')) {
                return { protocolVersion: 1, projection };
            }
            if (method === 'capabilities.detect') {
                const available = { ...cliAvailabilityDefaults.available, ...cliAvailabilityState.value.available };
                const baseFacts = { version: '1', latestVersion: null, update: { supported: false, command: null },
                    signIn: { status: 'signedIn', loginSupport: 'status_only' }, platform: { supported: true },
                    install: { available: true, mode: 'managed', sizeBytes: null, guideUrl: null }, dependencies: [] };
                const facts = Object.entries(available).map(([agentId, installed]) => [`cli.${agentId}`, {
                    ok: true, checkedAt: Date.now(), data: { agentId, title: agentId, installed: installed === true,
                        ...baseFacts },
                }]);
                return { protocolVersion: 1, results: { ...Object.fromEntries(facts),
                    'tool.acpAgentInventory': { ok: true, checkedAt: Date.now(), data: MachinesAgentsListOutputSchema.parse({
                        items: settingsState.acpCatalogSettingsV1.backends.map(definition => ({
                            agentId: 'custom-acp', definitionId: definition.id, title: definition.title,
                            installed: true, managed: false, fit: { kind: 'can_run', via: definition.launch.kind }, ...baseFacts,
                        })),
                    }) },
                    ...machineCapabilitiesResultsState.value } };
            }
            if (method === 'capabilities.invoke' && payload && typeof payload === 'object' && 'method' in payload && 'params' in payload) {
                const params = payload.params;
                const key = readBackendTargetKeyV2(params && typeof params === 'object' && 'backendTarget' in params ? params.backendTarget : null);
                if (key === null) throw new Error('Invalid probe backend target');
                if (payload.method === 'probeModels') return { ok: true, result: { source: 'dynamic',
                    availableModels: (preflightModelOptionsByTargetKeyState.value[key] ?? []).map(model => ({
                        id: model.value, name: model.label, ...(model.description ? { description: model.description } : {}),
                    })), supportsFreeform: false } };
                if (payload.method === 'probeModes') return { ok: true, result: { source: 'dynamic',
                    availableModes: preflightSessionModeOptionsByTargetKeyState.value[key] ?? [] } };
                if (payload.method === 'probeConfigOptions') return { ok: true, result: { source: 'dynamic',
                    configOptions: preflightConfigOptionsByTargetKeyState.value[key] ?? [] } };
            }
            if (method === 'capabilities.invoke' || method === RPC_METHODS.DAEMON_WORKSPACE_FILES_LIST) return machineRpcResult.value;
            return { jobs: [] };
        });
        createdSessions.clear();
        authoringMemoryHttp.reset();
        promptLibraryHttp = createPromptLibraryCatalogBoundary();
        network.setHttpResponder(async (input, init) => {
            const path = new URL(String(input)).pathname;
            const memory = await authoringMemoryHttp.handle(input, init);
            if (memory) return memory;
            const promptLibrary = await promptLibraryHttp.handle(path, init);
            if (promptLibrary) return promptLibrary;
            const serverId = new URL(String(input)).origin === new URL(homeState.targetServerUrl).origin
                ? homeState.targetServerId : creationHome.id;
            const accountId = serverId === homeState.targetServerId ? homeState.targetAccountId : creationHome.accountId;
            if (path === '/v1/account/profile') return Response.json({ id: accountId });
            const machineAccess = /^\/v1\/machines\/([^/]+)\/access$/.exec(path);
            if (machineAccess) return Response.json(MachineAccessGrantsListResponseV1Schema.parse({
                machineId: decodeURIComponent(machineAccess[1]),
                custodian: { accountId, displayName: 'Fixture Account' },
                access: { custodian: { accountId, displayName: 'Fixture Account' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
                canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [],
            }));
            if (path === '/v2/sessions' || path === '/v2/sessions/active') return Response.json(V2SessionListResponseSchema.parse({
                sessions: [...createdSessions].filter(([key]) => key.startsWith(`${serverId}|`)).map(([, session]) => session),
                nextCursor: null, hasNext: false,
            }));
            const sessionRead = /^\/v2\/sessions\/([^/]+)$/.exec(path);
            if (sessionRead) {
                const session = createdSessions.get(`${serverId}|${decodeURIComponent(sessionRead[1])}`);
                return session ? Response.json({ session }) : Response.json({ error: 'not_found' }, { status: 404 });
            }
            if (path === ACP_CATALOG_ROWS_ROUTE_V1) return Response.json({ status: 'present', revision: 1,
                content: { t: 'plain', v: AcpCatalogRecordV1Schema.parse({
                    v: 1, definitions: settingsState.acpCatalogSettingsV1.backends,
                }) },
            });
            const profileResponse = createProfileCatalogHttpResponse(path, settingsState);
            if (profileResponse) return profileResponse;
            if (path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1,
                signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
            if (path === '/v1/account/entity-rows/connected-accounts/purposes') {
                const { ConnectedAccountCatalogRowReadResponseV1Schema, emptyConnectedAccountCatalogRecordV1 } = await import('@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1');
                return Response.json(ConnectedAccountCatalogRowReadResponseV1Schema.parse({ status: 'present', revision: 1,
                    content: { t: 'plain', v: emptyConnectedAccountCatalogRecordV1('purposes') } }));
            }
            return createEmptyAccountBootstrapHttpResponse(path, init);
        });
        const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
        await prepareSessionDraftPersistenceStorage();
        applySettingsMock.mockClear();
        modalShowMock.mockClear();
        modalAlertMock.mockClear();
        agentInputActionChipActionIdsState.value = [];
        settingsRuntimeState.current = settingsState;
        Object.assign(settingsState, structuredClone(testSettingsDefaults));
        settingsState.useEnhancedSessionWizard = false;
        settingsState.newSessionDefaultPersistenceModeV1 = 'persisted';
        settingsState.newSessionDefaultPersistenceModeByTargetKeyV1 = {};
        settingsState.useProfiles = false;
        settingsState.profiles = [];
        settingsState.codexBackendMode = 'acp';
        settingsState.sessionWindowsRemoteSessionLaunchMode = 'hidden';
        settingsState.lastUsedAgent = 'codex';
        settingsState.lastUsedPermissionMode = 'default';
        settingsState.experiments = false;
        settingsState.sessionDefaultPermissionModeByTargetKey = {};
        settingsState.backendEnabledByTargetKey = {};
        settingsState.serverSelectionActiveTargetKind = 'server';
        settingsState.serverSelectionActiveTargetId = homeState.targetServerId;
        const activeScope = { serverId: homeState.activeServerId, accountId: 'acct_active' };
        await activateAuthoringScope(activeScope);
        settingsState.acpCatalogSettingsV1 = {
            v: 2,
            backends: [],
        };
        profileCompatibilityState.isProfileCompatibleWithAgent = () => true;
        profileCompatibilityState.isProfileCompatibleWithBackendTarget = () => true;
        profileCompatibilityState.isProfileCompatibleWithAnyAgent = () => true;
        profileCompatibilityState.getProfileSupportedAgentIds = () => [];
        persistedDraft.agentType = 'codex';
        persistedDraft.input = '';
        persistedDraft.selectedMachineId = 'machine-1';
        persistedDraft.selectedPath = '/repo';
        persistedDraft.selectedProfileId = null;
        persistedDraft.selectedSecretId = null;
        persistedDraft.permissionMode = 'default';
        persistedDraft.modelMode = 'default';
        persistedDraft.acpSessionModeId = 'plan';
        persistedDraft.backendNewSessionOptionStateByTargetKey = {};
        delete (persistedDraft as any).backendTarget;
        delete (persistedDraft as any).resumeSessionId;
        delete (persistedDraft as any).transcriptStorage;
        enabledAgentIdsState.value = ['codex', 'claude'];
        cliAvailabilityState.value = {
            timestamp: 1,
            available: { codex: false, claude: true, opencode: null },
        };
        machineState.value = [
            { id: 'machine-1', metadata: { displayName: 'Machine One', host: 'one', homeDir: '/home/one' } },
        ];
        machineCapabilitiesResultsState.value = {
            'dep.codex-acp': {
                ok: true as const,
                checkedAt: Date.now(),
                data: {
                    installed: false,
                    installDir: '/tmp',
                    binPath: null,
                    installedVersion: null,
                    sourceKind: 'github_release_binary',
                    lastInstallLogPath: null,
                },
            },
        };
        includeProjectedCodexAcpInstallableState.value = false;
        pendingFireAndForget.length = 0;
        featureEnabledState.sessionsDirect = false;
        featureEnabledCalls.length = 0;
        preflightModelOptionsByTargetKeyState.value = {};
        preflightSessionModeOptionsByTargetKeyState.value = {};
        preflightConfigOptionsByTargetKeyState.value = {};
        chromeSafeAreaInsetsState.value = { top: 0, bottom: 0, left: 0, right: 0 };
        routeParamsState.value = {};
        machineRpcResult.value = {};
    });

    it('enables workspace, native skill and slash suggestions before a session exists', async () => {
        routeParamsState.value = { machineId: 'machine-1', path: '/repo' };
        cliAvailabilityState.value = {
            ...cliAvailabilityState.value,
            available: { codex: true, claude: true, opencode: null },
        };
        machineRpcResult.value = { ok: true, result: {
            commands: { supported: true, items: [{ command: 'project-check' }] },
            skills: { supported: true, items: [{
                name: 'project-check', origin: 'codex_native', path: '/repo/.agents/skills/project-check/SKILL.md',
            }] },
        } };
        try {
            const hook = await renderNewSessionScreenModel();
            const model = hook.getCurrent();
            expect(model?.simpleProps?.selectedMachineId).toBe('machine-1');
            expect(model?.simpleProps?.selectedPath).toBe('/repo');
            const nativeCalls = () => network.requests.filter(({ method, payload }) => method === 'capabilities.invoke'
                && typeof payload === 'object' && payload !== null && 'method' in payload && payload.method === 'probeCatalogs');
            expect(nativeCalls()).toEqual([]);
            expect(model?.simpleProps?.emptyAutocompleteKinds).toEqual(['file', 'session', 'composerReference', 'skill', 'slashCommand']);
            await act(async () => {
                const suggestions = await model?.simpleProps?.emptyAutocompleteSuggestions('/go');
                expect(suggestions?.some((suggestion: { text?: string }) => suggestion.text === '/goal')).toBe(true);
            });
            await flushHookEffects();
            const current = hook.getCurrent();
            expect(await current?.simpleProps?.emptyAutocompleteSuggestions('$project')).toEqual(expect.arrayContaining([
                // A chosen skill is inserted as its inline reference token; its identity rides in structuredInput.
                expect.objectContaining({ kind: 'skill', label: 'project-check', structuredInput: expect.objectContaining({ origin: 'vendor', backendId: 'codex' }) }),
            ]));
            expect(await current?.simpleProps?.emptyAutocompleteSuggestions('/project')).toEqual(expect.arrayContaining([
                expect.objectContaining({ text: '/project-check' }),
            ]));
            expect(nativeCalls()).toEqual([expect.objectContaining({
                targetId: 'machine-1', serverUrl: 'https://installables-target.example.test',
                payload: expect.objectContaining({ params: expect.objectContaining({
                    cwd: '/repo', backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' }, environmentVariables: {},
                }) }),
            })]);
        } finally {
            machineRpcResult.value = {};
        }
    });

    it('renders without throwing during initial new-session screen model setup', async () => {
        const hook = await renderNewSessionScreenModel();
        expect(hook.getCurrent()).toBeTruthy();
    });

    it('keeps simple composer padding visual while the scaffold owns the safe-area inset', async () => {
        chromeSafeAreaInsetsState.value = { top: 12, bottom: 34, left: 0, right: 0 };

        const hook = await renderNewSessionScreenModel();
        const model = hook.getCurrent();

        expect(model?.variant).toBe('simple');
        expect(model?.simpleProps?.safeAreaTop).toBe(12);
        expect(model?.simpleProps?.safeAreaBottom).toBe(34);
        expect(model?.simpleProps?.newSessionBottomPadding).toBe(8);
    });

    it('reads sessions.direct in target-server spawn scope', async () => {
        await renderNewSessionScreenModel();

        expect(featureEnabledCalls).toContainEqual({
            featureId: 'sessions.direct',
            scope: { scopeKind: 'spawn', serverId: homeState.targetServerId },
        });
    });

    it('defers dependency preparation to explicit daemon creation on the selected target', async () => {
        routeParamsState.value = { machineId: 'machine-1' };
        // This journey tests a managed helper dependency, not a missing Agent executable.
        cliAvailabilityState.value = { available: { codex: true, claude: true, opencode: null } };
        settingsState.experiments = true;
        includeProjectedCodexAcpInstallableState.value = true;
        (persistedDraft as typeof persistedDraft & { resumeSessionId: string }).resumeSessionId = 'resume-session-1';
        await restoreCreationAccount();
        const hook = await renderNewSessionScreenModel();
        let model = hook.getCurrent();

        await flushHookEffects();
        await Promise.allSettled(pendingFireAndForget);

        expect(model).toBeTruthy();
        expect(model?.variant).toBe('simple');
        expect(model?.simpleProps?.agentType).toBe('codex');
        expect(model?.simpleProps?.selectedMachineId).toBe('machine-1');
        expect(model?.simpleProps?.machineName).toBe('account-1 · Machine One');
        expect(model?.simpleProps?.selectedPath).toBe('/repo');
        expect(model?.simpleProps?.canCreate, JSON.stringify(model?.simpleProps?.connectionStatus)).toBe(true);
        expect(dependencyInstallRequests()).toEqual([]);
        expect(spawnRequests()).toEqual([]);

        await invokeHookAction(() => model?.simpleProps?.handleCreateSession?.());
        expect(modalAlertMock).not.toHaveBeenCalled();

        await waitForHomeGovernance(() => expect(spawnRequests()).toHaveLength(1));
        expect(spawnRequests()[0]).toMatchObject({
            targetId: 'machine-1',
            serverUrl: homeState.targetServerUrl,
            payload: expect.objectContaining({
                executionTarget: { serverId: homeState.targetServerId, machineId: 'machine-1' },
                agentTarget: { kind: 'agent', identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.codex },
            }),
        });
        expect(dependencyInstallRequests()).toEqual([]);
    });

    it('falls back to default settings when settings are temporarily unavailable during startup', async () => {
        settingsRuntimeState.current = undefined;

        const hook = await renderNewSessionScreenModel();
        let model = hook.getCurrent();

        expect(model).toBeTruthy();
        expect(model?.variant).toBe('simple');
    });

    it('does not change hook order when the enhanced wizard flag toggles after mount', async () => {
        settingsState.useEnhancedSessionWizard = false;

        const hook = await renderNewSessionScreenModel();
        let model = hook.getCurrent();

        expect(model?.variant).toBe('simple');

        settingsState.useEnhancedSessionWizard = true;

        await hook.rerender();
        model = hook.getCurrent();

        expect(model?.variant).toBe('wizard');
    });

    it('builds engine picker options and applies a selected backend instead of cycling inline', async () => {
        settingsState.codexBackendMode = 'mcp';
        settingsState.lastUsedAgent = 'claude';
        persistedDraft.agentType = 'claude';
        enabledAgentIdsState.value = ['claude', 'codex', 'opencode'];
        cliAvailabilityState.value = {
            timestamp: 1,
            available: { claude: true, codex: false, opencode: true },
        };

        const hook = await renderNewSessionScreenModel({ openAgentPicker: true });
        let model = hook.getCurrent();

        expect(model?.simpleProps?.agentType).toBe('claude');
        expect(model?.simpleProps?.agentPickerOptions?.map((option: { id: string }) => option.id)).toEqual([
            buildBuiltInBackendTargetKey('claude'),
            buildBuiltInBackendTargetKey('opencode'),
            buildBuiltInBackendTargetKey('codex'),
        ]);

        await invokeHookAction(() => model?.simpleProps?.onAgentPickerSelect?.(buildBuiltInBackendTargetKey('opencode')));

        model = hook.getCurrent();

        expect(model?.simpleProps?.agentType).toBe('opencode');
    });

    it('renders backend picker options with engine detail previews sourced from preflight models', async () => {
        expect(homeState.targetServerId).not.toBe(homeState.activeServerId);
        settingsState.codexBackendMode = 'mcp';
        settingsState.lastUsedAgent = 'claude';
        persistedDraft.agentType = 'claude';
        enabledAgentIdsState.value = ['claude', 'opencode'];
        cliAvailabilityState.value = {
            timestamp: 1,
            available: { claude: true, codex: false, opencode: true },
        };
        preflightModelOptionsByTargetKeyState.value = {
            [buildBuiltInBackendTargetKey('claude')]: [
                { value: 'default', label: 'Claude default', description: 'Uses the backend default.' },
                { value: 'claude-3.7-sonnet', label: 'Claude 3.7 Sonnet', description: 'Balanced coding model.' },
            ],
            [buildBuiltInBackendTargetKey('opencode')]: [
                { value: 'default', label: 'OpenCode default', description: 'Uses the backend default.' },
                { value: 'opencode-fast', label: 'OpenCode Fast', description: 'Lower latency coding model.' },
            ],
        };

        const hook = await renderNewSessionScreenModel({ openAgentPicker: true });
        let model = hook.getCurrent();

        const opencodeOption = model?.simpleProps?.agentPickerOptions?.find?.((option: { id: string }) =>
            option.id === buildBuiltInBackendTargetKey('opencode'));

        const opencodeDetailContent = opencodeOption?.renderDetailContent?.({ onRequestClose: vi.fn() }) ?? opencodeOption?.detailContent ?? null;
        expect(opencodeDetailContent).toBeTruthy();

        const detailScreen = await renderScreen(<>{opencodeDetailContent}</>);
        const { NewSessionEngineOptionDetail } = await import('../components/NewSessionEngineOptionDetail');
        const previewTestId = `model-picker-overlay-option:${sessionModelSelectionKey({
            agentTargetKey: buildBuiltInBackendTargetKey('opencode'),
            providerConnectionId: null,
            modelId: 'opencode-fast',
        })}`;
        await waitForHomeGovernance(() => {
            const detail = detailScreen.tree.root.findByType(NewSessionEngineOptionDetail);
            expect(detail.props).toMatchObject({
                selectedMachineId: 'machine-1', capabilityServerId: homeState.targetServerId, cwd: '/repo',
            });
            expect(detailScreen.findAllHostsByTestId(previewTestId)).toHaveLength(1);
        });
        expect(network.httpRequests.some(({ url }) => {
            const request = new URL(url);
            return request.origin === homeState.targetServerUrl
                && request.pathname === '/v1/account/entity-rows/connected-accounts/purposes';
        })).toBe(true);
        expect(network.requests.some(({ serverUrl, method, payload }) => serverUrl === homeState.targetServerUrl
            && method === RPC_METHODS.CAPABILITIES_INVOKE && payload !== null && typeof payload === 'object'
            && 'id' in payload && payload.id === 'cli.opencode' && 'method' in payload && payload.method === 'probeModels')).toBe(true);
        const previewTexts = detailScreen.findAll((node) => typeof node.props?.children === 'string')
            .map((node) => node.props.children);
        expect(previewTexts).toContain('OpenCode Fast');
        expect(previewTexts).toContain('Lower latency coding model.');
    });

    it('threads ACP session mode options into the session-mode control when the backend exposes them', async () => {
        settingsState.lastUsedAgent = 'claude';
        settingsState.lastUsedBackendTarget = { kind: 'backend', backendId: 'claude' };
        settingsState.acpCatalogSettingsV1 = {
            v: 2,
            backends: [
                {
                    id: 'custom-preset',
                    name: 'custom-preset',
                    title: 'Custom Preset',
                    launch: { kind: 'command' as const, command: 'custom-acp', args: ['serve'] },
                    env: {},
                    capabilities: {
                        supportsLoadSession: false,
                        supportsModes: 'yes',
                        supportsModels: 'yes',
                        supportsConfigOptions: 'unknown',
                        promptImageSupport: 'unknown',
                    },
                    createdAt: 1,
                    updatedAt: 1,
                },
            ],
        };
        enabledAgentIdsState.value = ['claude', 'codex'];
        cliAvailabilityState.value = {
            timestamp: 1,
            available: { claude: true, codex: false, opencode: null },
        } as any;
        preflightSessionModeOptionsByTargetKeyState.value = {
            [buildConfiguredAcpBackendTargetKey('custom-preset')]: [
                { id: 'plan', name: 'Plan', description: 'Structured planning mode.' },
                { id: 'review', name: 'Review', description: 'Review and critique mode.' },
            ],
        };

        const hook = await renderNewSessionScreenModel({ openAgentPicker: true });
        let model = hook.getCurrent();

        const customPresetOption = model?.simpleProps?.agentPickerOptions?.find?.((option: { id: string; onApply?: () => void; renderDetailContent?: () => React.ReactNode; detailContent?: React.ReactNode }) =>
            option.id === buildConfiguredAcpBackendTargetKey('custom-preset'));

        expect(customPresetOption).toBeTruthy();

        const detailElement = (customPresetOption?.renderDetailContent?.({ onRequestClose: vi.fn() }) ?? customPresetOption?.detailContent) as React.ReactElement<{
            onSelectionChange?: (selection: { modelId: string; sessionModeId: string }) => void;
        }> | undefined;
        expect(detailElement).toBeTruthy();

        await invokeHookAction(() => {
            detailElement?.props.onSelectionChange?.({
                modelId: 'default',
                sessionModeId: 'plan',
            });
            customPresetOption?.onApply?.();
        });

        model = hook.getCurrent();

        const modeOptions = model?.simpleProps?.acpSessionModeOptions ?? [];
        expect(modeOptions.some((option: { id: string }) => option.id === 'review')).toBe(true);
    });

    it('applies backend-specific model and ACP mode selections from the engine picker detail pane', async () => {
        settingsState.lastUsedAgent = 'claude';
        settingsState.lastUsedBackendTarget = { kind: 'backend', backendId: 'claude' };
        persistedDraft.agentType = 'claude';
        settingsState.acpCatalogSettingsV1 = {
            v: 2,
            backends: [
                {
                    id: 'custom-preset',
                    name: 'custom-preset',
                    title: 'Custom Preset',
                    launch: { kind: 'command' as const, command: 'custom-acp', args: ['serve'] },
                    env: {},
                    capabilities: {
                        supportsLoadSession: false,
                        supportsModes: 'yes',
                        supportsModels: 'yes',
                        supportsConfigOptions: 'unknown',
                        promptImageSupport: 'unknown',
                    },
                    createdAt: 1,
                    updatedAt: 1,
                },
            ],
        };
        enabledAgentIdsState.value = ['claude', 'codex'];
        cliAvailabilityState.value = {
            timestamp: 1,
            available: { claude: true, codex: false, opencode: null },
        } as any;
        preflightModelOptionsByTargetKeyState.value = {
            [buildConfiguredAcpBackendTargetKey('custom-preset')]: [
                { value: 'default', label: 'Preset default', description: 'Uses the backend default.' },
                { value: 'preset-fast', label: 'Preset Fast', description: 'Fast preset model.' },
            ],
        };
        preflightSessionModeOptionsByTargetKeyState.value = {
            [buildConfiguredAcpBackendTargetKey('custom-preset')]: [
                { id: 'plan', name: 'Plan', description: 'Structured planning mode.' },
                { id: 'review', name: 'Review', description: 'Review and critique mode.' },
            ],
        };
        const hook = await renderNewSessionScreenModel({ openAgentPicker: true });
        let model = hook.getCurrent();

        expect(model?.simpleProps?.agentType).toBe('claude');
        expect(model?.simpleProps?.modelMode).toBe('default');
        expect(model?.simpleProps?.acpSessionModeId).toBe('plan');

        const customPresetOption = model?.simpleProps?.agentPickerOptions?.find?.((option: { id: string; onApply?: () => void; renderDetailContent?: () => React.ReactNode; detailContent?: React.ReactNode }) =>
            option.id === buildConfiguredAcpBackendTargetKey('custom-preset'));
        const detailElement = (customPresetOption?.renderDetailContent?.({ onRequestClose: vi.fn() }) ?? customPresetOption?.detailContent) as React.ReactElement<{
            onSelectionChange?: (selection: { modelId: string; sessionModeId: string }) => void;
        }> | undefined;
        expect(detailElement).toBeTruthy();

        await invokeHookAction(() => {
            detailElement?.props.onSelectionChange?.({
                modelId: 'preset-fast',
                sessionModeId: 'review',
            });
            customPresetOption?.onApply?.();
        });

        model = hook.getCurrent();

        expect(model?.simpleProps?.agentType).toBe(CUSTOM_ACP_AGENT_ID);
        expect(model?.simpleProps?.agentLabel).toBe('Custom Preset');
        expect(model?.simpleProps?.agentPickerSelectedOptionId).toBe(buildConfiguredAcpBackendTargetKey('custom-preset'));
        expect(model?.simpleProps?.modelMode).toBe('preset-fast');
        expect(model?.simpleProps?.acpSessionModeId).toBe('review');
    });

    it('rebuilds backend picker detail content from the latest pending engine selection', async () => {
        settingsState.lastUsedAgent = 'claude';
        settingsState.acpCatalogSettingsV1 = {
            v: 2,
            backends: [
                {
                    id: 'custom-preset',
                    name: 'custom-preset',
                    title: 'Custom Preset',
                    launch: { kind: 'command' as const, command: 'custom-acp', args: ['serve'] },
                    env: {},
                    capabilities: {
                        supportsLoadSession: false,
                        supportsModes: 'yes',
                        supportsModels: 'yes',
                        supportsConfigOptions: 'unknown',
                        promptImageSupport: 'unknown',
                    },
                    createdAt: 1,
                    updatedAt: 1,
                },
            ],
        };
        enabledAgentIdsState.value = ['claude', 'codex'];
        cliAvailabilityState.value = {
            timestamp: 1,
            available: { claude: true, codex: false, opencode: null },
        } as any;

        const hook = await renderNewSessionScreenModel({ openAgentPicker: true });
        let model = hook.getCurrent();

        const customPresetOption = model?.simpleProps?.agentPickerOptions?.find?.((option: { id: string; renderDetailContent?: () => React.ReactNode }) =>
            option.id === buildConfiguredAcpBackendTargetKey('custom-preset'));

        expect(typeof customPresetOption?.renderDetailContent).toBe('function');

        const firstDetailElement = customPresetOption?.renderDetailContent?.({ onRequestClose: vi.fn() }) as React.ReactElement<{
            selection: { modelId: string };
            onSelectionChange?: (selection: { modelId: string; sessionModeId: string; configOverrides?: Record<string, string> }) => void;
        }> | undefined;

        expect(firstDetailElement?.props.selection.modelId).toBe('default');

        await invokeHookAction(() => firstDetailElement?.props.onSelectionChange?.({
            modelId: 'preset-fast',
            sessionModeId: 'default',
            configOverrides: {},
        }));

        const updatedDetailElement = customPresetOption?.renderDetailContent?.({ onRequestClose: vi.fn() }) as React.ReactElement<{
            selection: { modelId: string };
        }> | undefined;

        expect(updatedDetailElement?.props.selection.modelId).toBe('preset-fast');
    });

    it('renders backend picker options with ACP config previews when the backend exposes them', async () => {
        settingsState.lastUsedAgent = 'claude';
        settingsState.lastUsedBackendTarget = { kind: 'backend', backendId: 'claude' };
        settingsState.acpCatalogSettingsV1 = {
            v: 2,
            backends: [
                {
                    id: 'custom-preset',
                    name: 'custom-preset',
                    title: 'Custom Preset',
                    launch: { kind: 'command' as const, command: 'custom-acp', args: ['serve'] },
                    env: {},
                    capabilities: {
                        supportsLoadSession: false,
                        supportsModes: 'yes',
                        supportsModels: 'yes',
                        supportsConfigOptions: 'yes',
                        promptImageSupport: 'unknown',
                    },
                    createdAt: 1,
                    updatedAt: 1,
                },
            ],
        };
        enabledAgentIdsState.value = ['claude', 'codex'];
        cliAvailabilityState.value = {
            timestamp: 1,
            available: { claude: true, codex: false, opencode: null },
        } as any;
        preflightConfigOptionsByTargetKeyState.value = {
            [buildConfiguredAcpBackendTargetKey('custom-preset')]: [
                {
                    id: 'speed',
                    name: 'Speed',
                    type: 'select',
                    currentValue: 'standard',
                    options: [
                        { value: 'standard', name: 'Standard' },
                        { value: 'fast', name: 'Fast' },
                    ],
                },
            ],
        };

        const hook = await renderNewSessionScreenModel({ openAgentPicker: true });
        let model = hook.getCurrent();

        const customPresetOption = model?.simpleProps?.agentPickerOptions?.find?.((option: { id: string }) =>
            option.id === buildConfiguredAcpBackendTargetKey('custom-preset'));

        const customPresetDetailContent = customPresetOption?.renderDetailContent?.({ onRequestClose: vi.fn() }) ?? customPresetOption?.detailContent ?? null;
        expect(customPresetDetailContent).toBeTruthy();

        const detailScreen = await renderScreen(<>{customPresetDetailContent}</>);
        const { NewSessionEngineOptionDetail } = await import('../components/NewSessionEngineOptionDetail');
        await waitForHomeGovernance(() => {
            expect(detailScreen.tree.root.findByType(NewSessionEngineOptionDetail).props).toMatchObject({
                selectedMachineId: 'machine-1', capabilityServerId: homeState.targetServerId, cwd: '/repo',
            });
            expect(detailScreen.findAllHostsByTestId('agent-input-config-option:speed')).toHaveLength(1);
        });
    });

    it('applies backend-specific ACP config selections from the engine picker detail pane', async () => {
        settingsState.lastUsedAgent = 'claude';
        settingsState.lastUsedBackendTarget = { kind: 'backend', backendId: 'claude' };
        persistedDraft.agentType = 'claude';
        settingsState.acpCatalogSettingsV1 = {
            v: 2,
            backends: [
                {
                    id: 'custom-preset',
                    name: 'custom-preset',
                    title: 'Custom Preset',
                    launch: { kind: 'command' as const, command: 'custom-acp', args: ['serve'] },
                    env: {},
                    capabilities: {
                        supportsLoadSession: false,
                        supportsModes: 'yes',
                        supportsModels: 'yes',
                        supportsConfigOptions: 'yes',
                        promptImageSupport: 'unknown',
                    },
                    createdAt: 1,
                    updatedAt: 1,
                },
            ],
        };
        enabledAgentIdsState.value = ['claude', 'codex'];
        cliAvailabilityState.value = {
            timestamp: 1,
            available: { claude: true, codex: false, opencode: null },
        } as any;
        preflightConfigOptionsByTargetKeyState.value = {
            [buildConfiguredAcpBackendTargetKey('custom-preset')]: [
                {
                    id: 'speed',
                    name: 'Speed',
                    type: 'select',
                    currentValue: 'standard',
                    options: [
                        { value: 'standard', name: 'Standard' },
                        { value: 'fast', name: 'Fast' },
                    ],
                },
            ],
        };
        const hook = await renderNewSessionScreenModel({ openAgentPicker: true });
        let model = hook.getCurrent();

        expect(model?.simpleProps?.acpConfigOptionOverrides).toBeNull();

        const customPresetOption = model?.simpleProps?.agentPickerOptions?.find?.((option: { id: string; onApply?: () => void; renderDetailContent?: () => React.ReactNode; detailContent?: React.ReactNode }) =>
            option.id === buildConfiguredAcpBackendTargetKey('custom-preset'));
        const detailElement = (customPresetOption?.renderDetailContent?.({ onRequestClose: vi.fn() }) ?? customPresetOption?.detailContent) as React.ReactElement<{
            onSelectionChange?: (selection: { modelId: string; sessionModeId: string; configOverrides?: Record<string, string> }) => void;
        }> | undefined;
        expect(detailElement).toBeTruthy();

        await invokeHookAction(() => {
            detailElement?.props.onSelectionChange?.({
                modelId: 'default',
                sessionModeId: 'default',
                configOverrides: { speed: 'fast' },
            });
            customPresetOption?.onApply?.();
        });

        model = hook.getCurrent();

        expect(model?.simpleProps?.agentType).toBe(CUSTOM_ACP_AGENT_ID);
        expect(model?.simpleProps?.agentPickerSelectedOptionId).toBe(buildConfiguredAcpBackendTargetKey('custom-preset'));
        expect(model?.simpleProps?.acpConfigOptionOverrides).toEqual({
            v: 1,
            updatedAt: expect.any(Number),
            overrides: {
                speed: {
                    updatedAt: expect.any(Number),
                    value: 'fast',
                },
            },
        });
    });

    it('does not cycle to another unavailable agent when none are selectable', async () => {
        settingsState.codexBackendMode = 'mcp';
        settingsState.lastUsedAgent = 'claude';
        persistedDraft.agentType = 'claude';
        enabledAgentIdsState.value = ['claude', 'codex'];
        cliAvailabilityState.value = {
            timestamp: 1,
            available: { claude: false, codex: false, opencode: null },
        };

        const hook = await renderNewSessionScreenModel();
        let model = hook.getCurrent();

        expect(model?.simpleProps?.agentType).toBe('claude');
        const applySettingsCallsBeforeClick = applySettingsMock.mock.calls.length;

        await invokeHookAction(() => model?.simpleProps?.handleAgentClick?.());

        model = hook.getCurrent();

        expect(model?.simpleProps?.agentType).toBe('claude');
        expect(applySettingsMock.mock.calls.length).toBe(applySettingsCallsBeforeClick);
    });

    it('keeps the current agent when none are selectable and no valid fallback exists', async () => {
        settingsState.codexBackendMode = 'mcp';
        settingsState.lastUsedAgent = 'codex';
        settingsState.lastUsedBackendTarget = { kind: 'backend', backendId: 'codex' };
        persistedDraft.agentType = 'codex';
        enabledAgentIdsState.value = ['claude', 'codex'];
        cliAvailabilityState.value = {
            timestamp: 1,
            available: { claude: false, codex: false, opencode: null },
        };

        const hook = await renderNewSessionScreenModel();
        let model = hook.getCurrent();

        expect(model?.simpleProps?.agentType).toBe('codex');
    });

    it('uses per-agent permission defaults instead of the legacy last-used permission setting', async () => {
        settingsState.lastUsedBackendTarget = { kind: 'backend', backendId: 'codex' };
        settingsState.lastUsedPermissionMode = 'yolo';
        settingsState.sessionDefaultPermissionModeByTargetKey = {
            [buildBuiltInBackendTargetKey('codex')]: 'read-only',
        };
        // Defaults apply to new authoring, not an explicit retained permission mode.
        const hook = await renderNewSessionScreenModel({ freshDraft: true });
        let model = hook.getCurrent();

        expect(model?.simpleProps?.permissionMode).toBe('read-only');
    });

    it('keeps Custom ACP selected when a valid configured ACP backend is chosen even if the custom ACP CLI is unavailable', async () => {
        settingsState.lastUsedAgent = 'claude';
        settingsState.lastUsedBackendTarget = {
            kind: 'backend',
            backendId: 'custom-preset',
            configuredBackendId: 'custom-preset',
        };
        settingsState.acpCatalogSettingsV1 = {
            v: 2,
            backends: [
                {
                    id: 'custom-preset',
                    name: 'custom-preset',
                    title: 'Custom Preset',
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
        settingsState.sessionDefaultPermissionModeByTargetKey = {
            [buildConfiguredAcpBackendTargetKey('custom-preset')]: 'safe-yolo',
        };
        persistedDraft.agentType = 'claude';
        delete (persistedDraft as { permissionMode?: string }).permissionMode;
        (persistedDraft as any).backendTarget = {
            kind: 'backend',
            backendId: 'custom-preset',
            configuredBackendId: 'custom-preset',
        };
        persistedDraft.backendNewSessionOptionStateByTargetKey = {};
        enabledAgentIdsState.value = ['claude'];
        cliAvailabilityState.value = {
            timestamp: 1,
            available: { claude: true, codex: false, opencode: null },
        } as any;

        const hook = await renderNewSessionScreenModel();
        let model = hook.getCurrent();

        expect(model?.simpleProps?.agentType).toBe(CUSTOM_ACP_AGENT_ID);
        expect(model?.simpleProps?.agentLabel).toBe('Custom Preset');
        expect(model?.simpleProps?.agentPickerSelectedOptionId).toBe(buildConfiguredAcpBackendTargetKey('custom-preset'));
        expect(model?.simpleProps?.permissionMode).toBe('safe-yolo');
    });

    it('preserves an authored configured ACP target when it becomes disabled instead of silently launching another Agent', async () => {
        settingsState.lastUsedAgent = 'claude';
        settingsState.lastUsedBackendTarget = { kind: 'backend', backendId: 'claude' };
        settingsState.backendEnabledByTargetKey = {
            [buildConfiguredAcpBackendTargetKey('custom-preset')]: false,
        };
        settingsState.acpCatalogSettingsV1 = {
            v: 2,
            backends: [
                {
                    id: 'custom-preset',
                    name: 'custom-preset',
                    title: 'Custom Preset',
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
        (persistedDraft as any).backendTarget = {
            kind: 'backend',
            backendId: 'custom-preset',
            configuredBackendId: 'custom-preset',
        };
        enabledAgentIdsState.value = ['claude'];
        cliAvailabilityState.value = {
            timestamp: 1,
            available: { claude: true, codex: false, opencode: null },
        } as any;

        const hook = await renderNewSessionScreenModel();
        let model = hook.getCurrent();

        expect(model?.simpleProps?.agentPickerSelectedOptionId).toBe(buildConfiguredAcpBackendTargetKey('custom-preset'));
        expect(model?.simpleProps?.canCreate).toBe(false);
    });

    it('switches to a configured ACP backend when the selected profile is only compatible with that backend target', async () => {
        settingsState.useProfiles = true;
        settingsState.lastUsedAgent = 'claude';
        settingsState.lastUsedBackendTarget = { kind: 'backend', backendId: 'claude' };
        settingsState.acpCatalogSettingsV1 = {
            v: 2,
            backends: [
                {
                    id: 'custom-preset',
                    name: 'custom-preset',
                    title: 'Custom Preset',
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
        settingsState.profiles = [{
            id: 'profile-1',
            name: 'Profile One',
            environmentVariables: [],
            defaultPermissionModeByAgent: {},
            defaultPermissionModeByTargetKey: {},
            defaultPersistenceModeByAgent: {},
            defaultPersistenceModeByTargetKey: {},
            compatibility: {},
            compatibilityByTargetKey: {
                [buildProfileCompatibilityTargetKey({
                    kind: 'backend',
                    backendId: 'custom-preset',
                    configuredBackendId: 'custom-preset',
                })]: true,
                [buildProfileCompatibilityTargetKey({ kind: 'backend', backendId: 'claude' })]: false,
            },
            envVarRequirements: [],
            isBuiltIn: false,
            defaultEnabled: true,
            createdAt: 0,
            updatedAt: 0,
            version: '1.0.0',
        }] as any;
        profileCompatibilityState.isProfileCompatibleWithAnyAgent = () => false;
        profileCompatibilityState.isProfileCompatibleWithBackendTarget = (profile: any, target: any) =>
            profile?.compatibilityByTargetKey?.[buildProfileCompatibilityTargetKey(target)] ?? false;
        persistedDraft.agentType = 'claude';
        persistedDraft.selectedProfileId = 'profile-1';
        (persistedDraft as any).backendTarget = { kind: 'backend', backendId: 'claude' };
        enabledAgentIdsState.value = ['claude'];
        cliAvailabilityState.value = {
            timestamp: 1,
            available: { claude: true, codex: false, opencode: null },
        } as any;

        const hook = await renderNewSessionScreenModel();
        let model = hook.getCurrent();

        expect(model?.simpleProps?.agentType).toBe(CUSTOM_ACP_AGENT_ID);
        expect(model?.simpleProps?.agentLabel).toBe('Custom Preset');
        expect(model?.simpleProps?.agentPickerSelectedOptionId).toBe(buildConfiguredAcpBackendTargetKey('custom-preset'));
        expect(model?.simpleProps?.selectedProfileId).toBe('profile-1');
    });

    it('builds a picker when many selectable agents exist instead of cycling one-by-one', async () => {
        settingsState.codexBackendMode = 'mcp';
        settingsState.lastUsedAgent = 'claude';
        persistedDraft.agentType = 'claude';
        enabledAgentIdsState.value = ['claude', 'codex', 'opencode', 'gemini'];
        cliAvailabilityState.value = {
            timestamp: 1,
            available: { claude: true, codex: true, opencode: true, gemini: true },
        } as any;

        const hook = await renderNewSessionScreenModel({ openAgentPicker: true });
        let model = hook.getCurrent();

        expect(model?.simpleProps?.agentType).toBe('claude');
        const geminiOption = model?.simpleProps?.agentPickerOptions?.find?.((option: { label: string }) =>
            option?.label === 'agentInput.agent.gemini');
        expect(geminiOption).toBeTruthy();

        await invokeHookAction(() => model?.simpleProps?.onAgentPickerSelect?.(geminiOption?.id ?? buildBuiltInBackendTargetKey('gemini')));

        model = hook.getCurrent();

        expect(model?.simpleProps?.agentType).toBe('gemini');
    });

    it('shows a storage chip for direct-capable agents when direct sessions are enabled', async () => {
        featureEnabledState.sessionsDirect = true;
        settingsState.lastUsedAgent = 'codex';
        settingsState.newSessionDefaultPersistenceModeV1 = 'persisted';
        settingsState.newSessionDefaultPersistenceModeByTargetKeyV1 = {};
        persistedDraft.agentType = 'codex';
        cliAvailabilityState.value = {
            timestamp: 1,
            available: { codex: true, claude: true, opencode: true },
        };

        const hook = await renderNewSessionScreenModel();
        let model = hook.getCurrent();

        const chips = model?.simpleProps?.agentInputExtraActionChips ?? [];
        expect(chips.some((chip: { key: string }) => chip.key === 'new-session-storage')).toBe(true);
    });

    it('seeds execution-run action chips with canonical permission defaults', async () => {
        cliAvailabilityState.value = { available: { codex: true, claude: true, opencode: null } };
        agentInputActionChipActionIdsState.value = ['review.start'];
        await setActiveServerId(homeState.targetServerId);
        const scope = { serverId: homeState.targetServerId, accountId: 'account-1' };
        await activateAuthoringScope(scope);

        await restoreCreationAccount();
        const hook = await renderNewSessionScreenModel();
        let model = hook.getCurrent();

        const chips = model?.simpleProps?.agentInputExtraActionChips ?? [];
        const reviewChip = chips.find((chip: { key: string }) => chip.key === 'new-session-action:review.start');
        expect(model?.simpleProps?.selectedPath).toBe('/repo');
        expect(model?.simpleProps?.canCreate, JSON.stringify(model?.simpleProps?.connectionStatus)).toBe(true);
        expect(reviewChip).toBeTruthy();
        expect(reviewChip?.controlId).toBe('shortcuts');
        expect(typeof reviewChip?.collapsedAction).toBe('function');

        const rendered = reviewChip.render({
            chipStyle: () => null,
            iconColor: '#000',
            showLabel: true,
            textStyle: {},
            countTextStyle: {},
            popoverAnchorRef: { current: null },
        }) as React.ReactElement<{ onPress?: () => void }>;

        await invokeHookAction(() => { rendered.props.onPress?.(); });

        await waitForHomeGovernance(() => expect(spawnRequests()).toHaveLength(1));
        await waitForHomeGovernance(() => expect(storageStore.getState().sessionActionDraftsByAddressKey[sessionAddressKey({
            serverId: homeState.targetServerId, sessionId: 'session-created',
        })]).toEqual([
            expect.objectContaining({
                actionId: 'review.start',
                input: expect.objectContaining({
                    permissionMode: 'read_only',
                    changeType: 'uncommitted',
                }),
            }),
        ]));
    });

    it('defaults the storage chip from the global persistence setting', async () => {
        featureEnabledState.sessionsDirect = true;
        settingsState.lastUsedAgent = 'codex';
        settingsState.newSessionDefaultPersistenceModeV1 = 'direct';
        settingsState.newSessionDefaultPersistenceModeByTargetKeyV1 = {};
        settingsState.useProfiles = false;
        settingsState.profiles = [];
        persistedDraft.agentType = 'codex';
        persistedDraft.selectedProfileId = null;
        delete (persistedDraft as any).transcriptStorage;
        cliAvailabilityState.value = {
            timestamp: 1,
            available: { codex: true, claude: true, opencode: true },
        };

        const hook = await renderNewSessionScreenModel();
        let model = hook.getCurrent();

        const chips = model?.simpleProps?.agentInputExtraActionChips ?? [];
        const storageChip = chips.find((chip: { key: string }) => chip.key === 'new-session-storage');
        expect(storageChip).toBeTruthy();
        expect(storageChip?.controlId).toBe('storage');
        expect(storageChip?.collapsedAction).toBeUndefined();
        expect(storageChip?.collapsedOptionsPopover?.selectedOptionId).toBe('direct');
        expect(storageChip?.collapsedOptionsPopover?.presentation).toBe('list');
        const storageOptions = storageChip?.collapsedOptionsPopover?.presentation === 'list'
            ? storageChip.collapsedOptionsPopover.rootStep.sections.flatMap((
                section: Readonly<{ kind: string; options?: ReadonlyArray<Readonly<{ id: string }>> }>,
            ) => (
                section.kind === 'static'
                    ? (section.options ?? []).map((option) => option.id)
                    : []
            ))
            : [];
        expect(storageOptions).toEqual([
            'persisted',
            'direct',
        ]);

        const chipScreen = await renderScreen(storageChip.render({
            chipStyle: () => null,
            iconColor: '#000',
            showLabel: true,
            textStyle: {},
        }));
        expect(chipScreen.getTextContent()).toContain('sessionsList.storageDirectTab');
    });

    it('prefers selected profile storage defaults over account defaults', async () => {
        featureEnabledState.sessionsDirect = true;
        settingsState.lastUsedAgent = 'codex';
        settingsState.lastUsedBackendTarget = { kind: 'backend', backendId: 'codex' };
        settingsState.newSessionDefaultPersistenceModeV1 = 'persisted';
        settingsState.newSessionDefaultPersistenceModeByTargetKeyV1 = {
            [buildBuiltInBackendTargetKey('codex')]: 'persisted',
        };
        settingsState.useProfiles = true;
        settingsState.profiles = [{
            id: 'profile-1',
            name: 'Profile One',
            environmentVariables: [],
            defaultPermissionModeByAgent: {},
            defaultPermissionModeByTargetKey: {},
            defaultPersistenceModeByAgent: {},
            defaultPersistenceModeByTargetKey: {
                [buildBuiltInBackendTargetKey('codex')]: 'direct',
            },
            compatibility: { codex: true, claude: true, gemini: true },
            compatibilityByTargetKey: {},
            envVarRequirements: [],
            isBuiltIn: false,
            defaultEnabled: true,
            createdAt: 0,
            updatedAt: 0,
            version: '1.0.0',
        }];
        persistedDraft.agentType = 'codex';
        persistedDraft.selectedProfileId = 'profile-1';
        delete (persistedDraft as any).transcriptStorage;
        cliAvailabilityState.value = {
            timestamp: 1,
            available: { codex: true, claude: true, opencode: true },
        };

        const hook = await renderNewSessionScreenModel();
        let model = hook.getCurrent();

        const chips = model?.simpleProps?.agentInputExtraActionChips ?? [];
        const storageChip = chips.find((chip: { key: string }) => chip.key === 'new-session-storage');
        expect(storageChip).toBeTruthy();

        const chipScreen = await renderScreen(storageChip.render({
            chipStyle: () => null,
            iconColor: '#000',
            showLabel: true,
            textStyle: {},
        }));
        expect(chipScreen.getTextContent()).toContain('sessionsList.storageDirectTab');
    });

    it('does not offer Direct storage for configured ACP targets whose Agent declares persisted-only storage', async () => {
        featureEnabledState.sessionsDirect = true;
        settingsState.lastUsedAgent = 'claude';
        settingsState.lastUsedBackendTarget = {
            kind: 'backend',
            backendId: 'custom-preset-a',
            configuredBackendId: 'custom-preset-a',
        };
        settingsState.newSessionDefaultPersistenceModeV1 = 'persisted';
        settingsState.newSessionDefaultPersistenceModeByTargetKeyV1 = {
            [buildConfiguredAcpBackendTargetKey('custom-preset-a')]: 'persisted',
            [buildConfiguredAcpBackendTargetKey('custom-preset-b')]: 'direct',
        };
        settingsState.acpCatalogSettingsV1 = {
            v: 2,
            backends: [
                {
                    id: 'custom-preset-a',
                    name: 'custom-preset-a',
                    title: 'Custom Preset A',
                    launch: { kind: 'command' as const, command: 'custom-acp-a', args: ['serve'] },
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
                {
                    id: 'custom-preset-b',
                    name: 'custom-preset-b',
                    title: 'Custom Preset B',
                    launch: { kind: 'command' as const, command: 'custom-acp-b', args: ['serve'] },
                    env: {},
                    capabilities: {
                        supportsLoadSession: false,
                        supportsModes: 'unknown',
                        supportsModels: 'unknown',
                        supportsConfigOptions: 'unknown',
                        promptImageSupport: 'unknown',
                    },
                    createdAt: 2,
                    updatedAt: 2,
                },
            ],
        };
        persistedDraft.agentType = 'claude';
        (persistedDraft as any).backendTarget = {
            kind: 'backend',
            backendId: 'custom-preset-a',
            configuredBackendId: 'custom-preset-a',
        };
        enabledAgentIdsState.value = ['claude'];
        cliAvailabilityState.value = {
            timestamp: 1,
            available: { codex: false, claude: false, opencode: null },
        } as any;
        const hook = await renderNewSessionScreenModel({ openAgentPicker: true });
        let model = hook.getCurrent();

        const expectPersistedOnlyStorage = () => {
            const chips = model?.simpleProps?.agentInputExtraActionChips ?? [];
            const storageChip = chips.find((chip: { key: string }) => chip.key === 'new-session-storage');
            expect(storageChip).toBeUndefined();
        };

        expectPersistedOnlyStorage();

        await invokeHookAction(() => model?.simpleProps?.onAgentPickerSelect?.(buildConfiguredAcpBackendTargetKey('custom-preset-b')));

        model = hook.getCurrent();

        expect(model?.simpleProps?.agentType).toBe(CUSTOM_ACP_AGENT_ID);
        expect(model?.simpleProps?.agentLabel).toBe('Custom Preset B');
        expect(model?.simpleProps?.agentPickerSelectedOptionId).toBe(buildConfiguredAcpBackendTargetKey('custom-preset-b'));
        expectPersistedOnlyStorage();
        await hook.unmount();
    });

    it('offers Windows session-mode choices and requests their facts on picker intent', async () => {
        routeParamsState.value = { machineId: 'machine-1' };
        machineState.value = [
            {
                id: 'machine-1',
                metadata: {
                    displayName: 'Machine One',
                    host: 'one',
                    homeDir: '/home/one',
                    platform: 'win32',
                    windowsRemoteSessionLaunchMode: 'console',
                },
            },
        ];
        settingsState.sessionWindowsRemoteSessionLaunchMode = 'console';
        machineCapabilitiesResultsState.value = {
            ...machineCapabilitiesResultsState.value,
            'tool.windowsTerminal': {
                ok: true as const,
                checkedAt: Date.now(),
                data: {
                    available: true,
                    resolvedPath: 'C:\\Program Files\\WindowsApps\\wt.exe',
                },
            },
        };

        const hook = await renderNewSessionScreenModel();
        let model = hook.getCurrent();

        let chips = model?.simpleProps?.agentInputExtraActionChips ?? [];
        const windowsChip = chips.find((chip: { key: string }) => chip.key === 'new-session-windows-remote-session-launch-mode');
        expect(windowsChip).toBeTruthy();
        const previousRequests = network.requests.length;
        await invokeHookAction(() => windowsChip.onIntent?.());
        await waitForHomeGovernance(() => expect(network.requests.slice(previousRequests)).toContainEqual(expect.objectContaining({
            method: 'capabilities.detect', payload: { requests: [{ id: 'tool.windowsTerminal' }] },
        })));
    });

    it('enables workspace, session, plugin-reference and slash autocomplete before a session exists', async () => {
        const hook = await renderNewSessionScreenModel();
        const model = hook.getCurrent();

        expect(model?.simpleProps?.emptyAutocompleteKinds).toEqual([
            'file',
            'session',
            'composerReference',
            'skill',
            'slashCommand',
        ]);

        const suggestions = await model?.simpleProps?.emptyAutocompleteSuggestions?.('/happier');
        expect(suggestions?.some((suggestion: { text: string }) => suggestion.text === '/happier-diagnose')).toBe(true);
    });

    /**
     * The two capabilities the `'__new_session__'` sentinel used to make impossible: it faked a
     * session so session-addressed lookups would accept a call, and every one of them then
     * answered for no session, so `@` and `@session` offered nothing at all before spawn.
     *
     * They are asserted HERE, at the host, because the host is the only place the arguments are
     * chosen. `emptyAutocompleteKinds` above says a kind is eligible; it does not say the host
     * handed the resolver anything to answer with. The picker's own wiring suite builds its
     * arguments by hand, so it cannot see a host that stops passing them.
     */
    it('addresses the file search at the machine and folder the user picked', async () => {
        routeParamsState.value = { machineId: 'machine-1', path: '/repo' };
        machineRpcResult.value = DaemonWorkspaceFileListResponseSchema.parse({ ok: true,
            paths: ['README.md', 'src/index.ts'], truncated: false });
        const { fileSearchCache } = await import('@/sync/domains/input/suggestionFile');
        // Whole-cache clear: the index is keyed by this workspace address, and a warm entry
        // from an earlier case would serve rows without issuing the RPC this asserts on.
        fileSearchCache.clearCache();

        try {
            const hook = await renderNewSessionScreenModel();
            const model = hook.getCurrent();

            const suggestions = await model?.simpleProps?.emptyAutocompleteSuggestions?.('@REA');
            expect(suggestions?.some((suggestion: { kind?: string; structuredInput?: { label?: string } }) => (
                suggestion.kind === 'file' && suggestion.structuredInput?.label === 'README.md'
            ))).toBe(true);

            // The addressing, not just the presence of rows: without an explicit machine and
            // cwd the daemon searches its OWN working directory and would offer files from a
            // tree the user never chose.
            const fileList = network.requests.filter((request) => request.method === RPC_METHODS.DAEMON_WORKSPACE_FILES_LIST);
            expect(fileList).toHaveLength(1);
            expect(fileList[0]?.targetId).toBe('machine-1');
            expect(fileList[0]?.payload).toMatchObject({ rootPath: '/repo' });
            // The declared spawn target is deliberately not the active Home.
            expect(fileList[0]?.serverUrl).toBe('https://installables-target.example.test');
        } finally {
            fileSearchCache.clearCache();
        }
    });

    it('scopes the `@session` picker to the server this session will spawn on', async () => {
        const row = (id: string) => createSessionListRenderableSessionFixture({
            id,
            seq: 1,
            createdAt: 1,
            updatedAt: 2_000,
            active: true,
            archivedAt: null,
            metadata: { name: `Session ${id}`, path: '/repo' },
        });
        // The target Home and active profile scope deliberately differ, so
        // scoping to the wrong one is observable.
        storageState.sessionListRowsByServerId = {
            [homeState.targetServerId]: { peer: row('peer') },
            [homeState.activeServerId]: { elsewhere: row('elsewhere') },
        };

        try {
            const hook = await renderNewSessionScreenModel();
            const model = hook.getCurrent();

            const suggestions = await model?.simpleProps?.emptyAutocompleteSuggestions?.('@session:');

            expect(suggestions?.map((suggestion: { key: string }) => suggestion.key)).toEqual(['session-peer']);
        } finally {
            storageState.sessionListRowsByServerId = {};
        }
    });

});
