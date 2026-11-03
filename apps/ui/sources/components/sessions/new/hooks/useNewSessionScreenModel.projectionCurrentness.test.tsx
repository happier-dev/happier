import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { buildQualifiedPluginContributionKey, PluginProjectionV2Schema, type MachineAgentInventoryItem } from '@happier-dev/protocol';
import { BUNDLED_AGENT_CONTRIBUTION_IDENTITIES } from '@happier-dev/agents/agent-ids';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { publishDaemonMergedProjectionInputs } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import {
    flushHookEffects,
    renderHook,
    createMachineFixture,
} from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import type { Machine } from '@/sync/domains/state/storageTypes';

import { installNewSessionScreenModelCommonModuleMocks } from './newSessionScreenModelTestHelpers';

// Like the neighboring hook-only journeys, this model never renders Markdown.
// Keep the patched third-party SDK boundary isolated, not the real model/parser.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Markdown rendering is outside this hook-only journey'); },
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * New Session Agent-projection currentness.
 *
 * The screen model is the New Session currentness owner: everything it
 * projects for Agent selection (catalog entries, picker options, preferred
 * target restoration, create admission) must derive only from an
 * authoritative `ready` machine projection. The machine projection hook's own
 * phase/retention contract (a same-machine generation advance surfaces as
 * `loading` while it intentionally retains the previous inputs as inert
 * metadata) is proven by `useDaemonMergedProjectionInputs.test.tsx`; this
 * suite feeds that documented shape directly so the deciding assertions stay
 * on the screen-model owner. Inventory and readiness use the real scoped
 * owners beneath the credential and daemon HTTP/Socket.IO test boundaries;
 * the daemon spawn Action records any attempt to emit a stale target.
 */

const ACME_PLUGIN_ID = 'acme.review';
const ACME_LOCAL_ID = 'provider';
const ACME_IDENTITY = { pluginId: ACME_PLUGIN_ID, localId: ACME_LOCAL_ID } as const;
const ACME_AGENT_ID = buildQualifiedPluginContributionKey(ACME_IDENTITY);
const ACME_TARGET_KEY = resolveBackendTargetKeyV2({ kind: 'agent', identity: ACME_IDENTITY });
const CLAUDE_TARGET_KEY = resolveBackendTargetKeyV2({
    kind: 'agent',
    identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.claude,
});

type ProjectionPhase = 'idle' | 'loading' | 'ready' | 'unsupported' | 'error';

const projectionState = vi.hoisted(() => ({
    phase: 'ready' as ProjectionPhase,
    inputs: null as Record<string, unknown> | null,
}));
const serverState = vi.hoisted(() => ({ id: 's1' }));
const inventoryState = vi.hoisted(() => ({ installed: true }));

vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
    useDaemonMergedProjectionInputs: () => ({
        phase: projectionState.phase,
        inputs: projectionState.inputs,
    }),
}));

function buildAcmeProjectionInputs(params: Readonly<{
    title: string;
    generation: number;
    hasAgent?: boolean;
}>): Record<string, unknown> {
    const projection = PluginProjectionV2Schema.parse({
        v: 2, generation: params.generation,
        installedPackagesById: {}, actionsById: {}, familiesById: {},
         resourcesById: {}, settingsById: {}, diagnostics: [],
        agentsById: params.hasAgent === false ? {} : { [ACME_AGENT_ID]: {
            id: ACME_AGENT_ID, title: params.title,
            capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        } },
    });
    return {
        ...publishDaemonMergedProjectionInputs({ projection }),
        mergedProviderProjectionById: params.hasAgent === false ? {} : {
            [ACME_AGENT_ID]: {
                agentId: ACME_AGENT_ID,
                identity: ACME_IDENTITY,
                projectionGeneration: params.generation,
                title: params.title,
                isBuiltIn: false,
            },
        },
        mergedBackendProjectionById: params.hasAgent === false ? {} : {
            'acme.review.backend': {
                backendId: 'acme.review.backend',
                agentId: ACME_AGENT_ID,
                title: params.title,
                capabilities: { session: { supported: true } },
            },
        },
        discoveredBackendIds: params.hasAgent === false ? [] : ['acme.review.backend'],
        pluginProjectionById: {},
        pluginProjectionV2: projection,
        registryDiagnostics: [],
    };
}

function setProjection(phase: ProjectionPhase, inputs: Record<string, unknown> | null): void {
    projectionState.phase = phase;
    projectionState.inputs = inputs;
}

const pendingFireAndForget = vi.hoisted((): Array<Promise<unknown>> => []);
const modalAlertMock = vi.hoisted(() => vi.fn());
const sessionSpawnNewActionBoundarySpy = vi.hoisted(() => vi.fn(async (_input: unknown) => ({
    type: 'error' as const,
    errorCode: 'DAEMON_RPC_UNAVAILABLE' as const,
    errorMessage: 'Daemon RPC is not available',
})));

const enabledAgentIdsState = vi.hoisted(() => ({
    value: ['claude'] as string[],
}));

const machineState = vi.hoisted((): { value: Machine[] } => ({ value: [] }));

const routeParamsState = vi.hoisted(() => ({
    value: { machineId: 'machine-1' } as Record<string, string | string[] | undefined>,
}));

const testSettingsDefaults = vi.hoisted(() => ({
    recentMachinePaths: [] as Array<{ machineId: string; path: string }>,
    lastUsedAgent: 'claude',
    lastUsedBackendTarget: null as unknown,
    lastUsedPermissionMode: 'default',
    newSessionDefaultPersistenceModeV1: 'persisted' as 'persisted' | 'direct',
    newSessionDefaultPersistenceModeByTargetKeyV1: {} as Record<string, 'persisted' | 'direct'>,
    useEnhancedSessionWizard: true,
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
    providerDefaultModelSelectionsByAgentTargetKeyV1: {},
    secrets: [],
    secretBindingsByProfileId: {},
    serverSelectionGroups: [],
    serverSelectionActiveTargetKind: null,
    serverSelectionActiveTargetId: null,
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
    },
}));

const initialHookFlushOptions = { cycles: 2, turns: 2 } as const;

async function renderNewSessionScreenModel() {
    const { useNewSessionScreenModel } = await import('./useNewSessionScreenModel');
    getStorage().getState().applySettingsLocal({ useEnhancedSessionWizard: false });
    const hook = await renderHook(() => useNewSessionScreenModel(), {
        flushOptions: initialHookFlushOptions,
    });
    // Opening the real picker is what demands all Agent facts. Merely mounting
    // the screen intentionally probes only its selected Agent.
    await invokeHookAction(() => {
        const model = hook.getCurrent();
        if (model.variant !== 'simple') throw new Error('Expected the simple New Session surface');
        model.simpleProps.onAgentPickerVisibilityChange?.(true);
    });
    await act(async () => {
        getStorage().getState().applySettingsLocal({ useEnhancedSessionWizard: true });
    });
    await hook.rerender();
    return hook;
}

async function flushModel(): Promise<void> {
    await flushHookEffects({ cycles: 1, turns: 2 });
    await Promise.allSettled(pendingFireAndForget);
}

async function invokeHookAction(action: () => void | Promise<void>) {
    await act(async () => {
        await action();
    });
    await flushModel();
}

type ScreenModel = ReturnType<typeof import('./useNewSessionScreenModel')['useNewSessionScreenModel']>;

function wizard(model: ScreenModel) {
    if (model.variant !== 'wizard') throw new Error('Expected the enhanced New Session surface');
    return model.wizardProps;
}

function pickerOptionIds(model: ScreenModel): string[] {
    return (wizard(model).agent.agentPickerOptions ?? [])
        .map((option) => String(option.id ?? ''));
}

function pickerOption(model: ScreenModel, targetKey: string) {
    return (wizard(model).agent.agentPickerOptions ?? [])
        .find((option) => option.id === targetKey);
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
                show: vi.fn(() => 'modal-id'),
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
// Keep selectors, writers and consumers on one real store. Async partial mocks
// can wait on their own module through the model's Action/settings import graph.
vi.doUnmock('@/sync/domains/state/storage');

vi.mock('react-native-safe-area-context', () => ({
    initialWindowMetrics: null,
    SafeAreaInsetsContext: React.createContext({ top: 0, bottom: 0, left: 0, right: 0 }),
    SafeAreaProvider: ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/components/ui/layout/useChromeSafeAreaInsets', () => ({
    useChromeSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/utils/platform/responsive', () => ({
    useHeaderHeight: () => 0,
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return { ...createReactNavigationNativeMock(), useFocusEffect: () => {} };
});

vi.mock('@/sync/domains/state/persistence', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        loadNewSessionDraft: () => ({
            input: '',
            selectedMachineId: 'machine-1',
            selectedPath: '/repo',
            selectedProfileId: null,
            selectedSecretId: null,
            agentType: 'claude',
            permissionMode: 'default',
            modelMode: 'default',
            acpSessionModeId: null,
            backendNewSessionOptionStateByTargetKey: {},
            updatedAt: 123,
        }),
        saveNewSessionDraft: () => {},
    };
});

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => enabledAgentIdsState.value,
}));


const ensureAgentInstallablesBackgroundMock = vi.hoisted(() => vi.fn(async (_params?: unknown) => {}));

vi.mock('@/capabilities/ensureAgentInstallablesBackground', () => ({
    ensureAgentInstallablesBackground: (params: unknown) => ensureAgentInstallablesBackgroundMock(params),
}));


vi.mock('@/components/sessions/new/hooks/useNewSessionCapabilitiesPrefetch', () => ({
    useNewSessionCapabilitiesPrefetch: () => {},
}));

vi.mock('@/components/sessions/new/hooks/useNewSessionDraftAutoPersist', () => ({
    useNewSessionDraftAutoPersist: () => {},
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
    storeTempData: vi.fn(() => 'temp-data-key'),
}));

vi.mock('@/hooks/server/useAutomationsSupport', () => ({
    useAutomationsSupport: () => ({ enabled: false }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/components/sessions/new/modules/automationFeatureGate', () => ({
    resolveEffectiveAutomationDraft: ({ draft }: any) => draft,
    shouldShowAutomationActionChips: () => false,
}));

vi.mock('@/components/sessions/new/modules/profileHelpers', () => ({
    useProfileMap: (profiles: Array<{ id: string }>) => new Map(profiles.map((profile) => [profile.id, profile])),
    transformProfileToEnvironmentVars: () => [],
}));

vi.mock('@/components/sessions/new/hooks/newSessionModelModePolicy', () => ({
    resolveInitialNewSessionModelMode: () => 'default',
    coerceNewSessionModelMode: ({ modelMode }: any) => modelMode,
}));

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

vi.mock('@/components/sessions/new/hooks/serverTarget/useNewSessionServerTargetState', () => ({
    useNewSessionServerTargetState: () => ({
        serverProfiles: [],
        serverTargets: [],
        resolvedSettingsTarget: { allowedServerIds: [] },
        allowedTargetServerIds: [],
        targetServerId: serverState.id,
        targetServerProfile: null,
        targetServerName: null,
        showServerPickerChip: false,
        serverSelectionProps: {},
        resolveTargetServerId: () => serverState.id,
    }),
}));

vi.mock('@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState', () => ({
    useNewSessionPreflightModelsState: () => ({
        preflightModels: null,
        modelOptions: [],
        probe: { phase: 'idle', refresh: vi.fn() },
    }),
}));

vi.mock('@/components/sessions/new/hooks/screenModel/useNewSessionPreflightSessionModesState', () => ({
    useNewSessionPreflightSessionModesState: () => ({
        preflightModes: null,
        modeOptions: [],
        probe: { phase: 'idle', refresh: vi.fn() },
    }),
}));

vi.mock('@/components/sessions/new/hooks/screenModel/useNewSessionPreflightConfigOptionsState', () => ({
    useNewSessionPreflightConfigOptionsState: () => ({
        configOptions: null,
        probe: { phase: 'idle', refresh: vi.fn() },
    }),
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

// The daemon spawn Action is the wire this corridor must never emit a stale
// qualified target on. The outcome shape mirrors the sibling create-owner
// suites: a retryable machine_offline error keeps the assertion surface on the
// payload without dragging route-recovery timing into these tests.
vi.mock('@/sync/ops/actions/sessionSpawnNewAction', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/ops/actions/sessionSpawnNewAction')>();
    return {
        ...actual,
        executeManualSessionSpawnNewAction: async (input: any, _context: any, params: any) => {
            await sessionSpawnNewActionBoundarySpy(input);
            const custody = {
                v: 3 as const,
                scope: params.scope,
                machineId: input.executionTarget.machineId,
                targetFingerprint: 'test-fingerprint',
                userAttemptId: params.userAttemptId,
                nonce: params.seedNonce,
                submissionState: 'submitted' as const,
                createdSessionId: null,
                firstTurnLocalId: `spawn-first-turn:${params.seedNonce}`,
                attachmentMessageLocalId: `spawn-attachment:${params.seedNonce}`,
            };
            return {
                status: 'executed' as const,
                action: {
                    ok: true as const,
                    result: {
                        type: 'error' as const,
                        code: 'machine_offline' as const,
                        retryable: true,
                    },
                },
                custody,
            };
        },
        completeManualSessionSpawnNewActionCustody: async () => true,
    };
});

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/followUpSpawnedSession', () => ({
    followUpSpawnedSessionWithServerScope: vi.fn(async () => {}),
    readRecoverableFollowUpPayload: (error: unknown) => {
        if (!(error instanceof Error)) return null;
        const payload = (error as Error & { recoverableFollowUpPayload?: unknown }).recoverableFollowUpPayload;
        if (
            typeof payload === 'object'
            && payload !== null
            && 'draftText' in payload
            && typeof (payload as { draftText?: unknown }).draftText === 'string'
        ) {
            return payload;
        }
        return null;
    },
}));

async function selectAcmeTarget(hook: Awaited<ReturnType<typeof renderNewSessionScreenModel>>) {
    await vi.waitFor(() => expect(pickerOption(hook.getCurrent(), ACME_TARGET_KEY)?.disabled, JSON.stringify({
        rpc: network.requests.map(({ method, targetId }) => ({ method, targetId })),
        credentialHomes: [...new Set(network.credentialRequests.map(({ serverUrl }) => serverUrl))],
        http: [...new Set(network.httpRequests.map(({ url }) => new URL(url).pathname))],
        sockets: network.socketBoundaries.length,
    })).toBe(false));
    let model = hook.getCurrent();
    await invokeHookAction(() => wizard(model).agent.onAgentPickerSelect?.(ACME_TARGET_KEY));
    model = hook.getCurrent();
    return model;
}

// Real credential admission, scoped transport, inventory and readiness owners;
// only device credentials and daemon HTTP/Socket.IO ACKs are test boundaries.
const network = await installSessionOpsNetworkBoundary();
// As in useMachineAgents.test.tsx, physical Socket.IO must be installed before
// importing the real storage/model graph that captures its transport adapter.
await loadSyncSingletonForTests();
const { getStorage } = await import('@/sync/domains/state/storageStore');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { AIBackendProfileSchema } = await import('@/sync/domains/profiles/profileCompatibility');
const { applyProfileCatalogSnapshot, resetProfileCatalogSnapshotsForTests } = await import('@/sync/store/settings/profileCatalogSnapshot');
const { publishProjectedAgentUiBehaviorDescriptors } = await import('@/agents/registry/agentUiBehaviorProjection');
const inventoryItem: MachineAgentInventoryItem = {
    agentId: ACME_AGENT_ID, title: 'Acme Review Provider', installed: true,
    version: '1', latestVersion: null, update: { supported: false, command: null },
    signIn: { status: 'signedIn', loginSupport: 'status_only' }, platform: { supported: true },
    install: { available: true, mode: 'managed', sizeBytes: null, guideUrl: null }, dependencies: [],
};
afterEach(async () => {
    const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
    await serverScopedRpcSocketPool.stopAll();
    serverScopedRpcSocketPool.resetForTests();
    const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
    resetScopedMachineTransportCacheForTests();
});
afterAll(() => network.dispose());

describe('useNewSessionScreenModel (Agent projection currentness)', () => {
    // Cold source compilation of the model's plugin graph belongs to setup,
    // not the first hook's behavior timeout (measured at 125s on mac2-linux).
    beforeAll(async () => {
        await import('./useNewSessionScreenModel');
    }, 180_000);

    beforeEach(async () => {
        modalAlertMock.mockClear();
        sessionSpawnNewActionBoundarySpy.mockClear();
        ensureAgentInstallablesBackgroundMock.mockClear();
        inventoryState.installed = true;
        network.resetRequests();
        // The UI test harness resets persisted Homes before each test. Register
        // this credential-backed Home in the same lifetime as its real inventory.
        serverState.id = (await network.addHome('https://new-session-currentness.example.test', 'currentness-account')).id;
        const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
        await prepareSessionDraftPersistenceStorage();
        network.setHttpResponder(async (input) => new URL(String(input)).pathname === '/v1/account/encryption'
            ? Response.json({ mode: 'plain', updatedAt: 1 }) : null);
        network.setRpcResponder(async ({ method }) => {
            if (method.includes('contributionRegistryProjection.describe')) return {
                protocolVersion: 1, projection: projectionState.inputs?.pluginProjectionV2,
            };
            if (method === 'capabilities.detect') return { protocolVersion: 1, results: {
                [`cli.${ACME_AGENT_ID}`]: { ok: true, checkedAt: Date.now(), data: { ...inventoryItem, installed: inventoryState.installed } },
                'cli.claude': { ok: true, checkedAt: Date.now(), data: { ...inventoryItem, agentId: 'claude', title: 'Claude', installed: true } },
            } };
            return { jobs: [] };
        });
        machineState.value = ['machine-1', 'machine-2'].map((id) => createMachineFixture({
            id, active: true, activeAt: Date.now(),
            metadata: { ...createMachineFixture().metadata!, displayName: id, host: id, homeDir: `/home/${id}` },
        }));
        getStorage().getState().applyMachines(machineState.value);
        getStorage().setState({ machineListByServerId: { [serverState.id]: machineState.value } });
        const { publishMachineContributionRegistryProjectionInvalidation } = await import('@/sync/ops/machineContributionRegistryProjectionRevision');
        for (const machineId of ['machine-1', 'machine-2']) {
            publishMachineContributionRegistryProjectionInvalidation({ serverId: serverState.id, machineId });
        }
        enabledAgentIdsState.value = ['claude'];
        routeParamsState.value = { machineId: 'machine-1' };
        getStorage().getState().applySettingsLocal(settingsParse(testSettingsDefaults));
        publishProjectedAgentUiBehaviorDescriptors({
            machineId: 'machine-1',
            descriptorsByAgentId: {},
        });
        publishProjectedAgentUiBehaviorDescriptors({
            machineId: 'machine-2',
            descriptorsByAgentId: {},
        });
    });

    it('opens with profiles and a retained configured Agent without losing its definition', async () => {
        const target = {
            kind: 'agent',
            identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES['custom-acp'],
            definitionId: 'review-agent',
        } as const;
        getStorage().getState().applySettingsLocal({
            useProfiles: true,
            useEnhancedSessionWizard: true,
            lastUsedBackendTarget: target,
        });
        setProjection('ready', null);
        const profile = AIBackendProfileSchema.parse({
            id: 'review-profile', name: 'Review profile', compatibility: {},
        });
        const scope = { serverId: serverState.id, accountId: 'configured-agent-profile-test' };
        const previousScope = getStorage().getState().settingsScope;
        getStorage().setState({ settingsScope: scope });
        // Publish an admitted retained Profile through its real scoped owner;
        // the model no longer reads the legacy Settings profiles array.
        applyProfileCatalogSnapshot(scope, {
            status: 'ready', source: 'legacy', records: [], diagnostics: [],
            referenceGuardRevision: 'absent', authority: 'inactive',
            control: null, controlRevision: 'absent',
        }, true, new Map(), { legacyProfiles: [profile] });

        // The real model filters this profile through the real UI compatibility
        // owner and Protocol parser. Lowering the configured target to the
        // Custom ACP container loses definitionId and used to throw here.
        let hook: Awaited<ReturnType<typeof renderNewSessionScreenModel>> | undefined;
        try {
            hook = await renderNewSessionScreenModel();
            const model = wizard(hook.getCurrent());
            expect(model.profiles.profiles.map((entry: AIBackendProfile) => entry.id)).toContain(profile.id);
            expect(model.agent.agentPickerSelectedOptionId).toBe(
                'agent:happier.agent.custom-acp/custom-acp:definition:review-agent',
            );
            // Missing catalog availability must retain intent, not silently
            // select a bundled fallback or dispatch a Session spawn.
            expect(model.agent.selectedBackendEntry).toBeNull();
            expect(sessionSpawnNewActionBoundarySpy).not.toHaveBeenCalled();
        } finally {
            await hook?.unmount();
            getStorage().setState({ settingsScope: previousScope });
            resetProfileCatalogSnapshotsForTests();
        }
    });

    it('hides the stale external Agent entry while the same machine advances generation and its projection loads', async () => {
        // Generation 7 is authoritative: the external Agent is displayed and selectable.
        setProjection('ready', buildAcmeProjectionInputs({ title: 'Acme Review Provider', generation: 7 }));
        const hook = await renderNewSessionScreenModel();
        let model = hook.getCurrent();
        await flushModel();
        model = hook.getCurrent();

        expect(pickerOptionIds(model)).toContain(ACME_TARGET_KEY);
        model = await selectAcmeTarget(hook);
        expect(wizard(model).agent.agentPickerSelectedOptionId).toBe(ACME_TARGET_KEY);
        expect(wizard(model).agent.selectedBackendEntry?.backendTargetKey).toBe(ACME_TARGET_KEY);

        // The same machine advances generation: the canonical projection hook
        // reports `loading` while retaining the previous inputs as inert
        // metadata. The stale entry must not stay displayed or resolved.
        setProjection('loading', buildAcmeProjectionInputs({ title: 'Acme Review Provider', generation: 7 }));
        await hook.rerender();
        await flushModel();
        model = hook.getCurrent();

        expect(pickerOptionIds(model)).not.toContain(ACME_TARGET_KEY);
        expect(wizard(model).agent.selectedBackendEntry?.backendTargetKey).toBeUndefined();
        expect(wizard(model).agent.agentLabel).not.toBe('Acme Review Provider');
        expect(wizard(model).agent.agentPickerSelectedOptionId).toBe(ACME_TARGET_KEY);
        expect(wizard(model).footer.canCreate).toBe(false);
        expect(wizard(model).footer.connectionStatus?.text).toBe('machineAgents.checking');

        // The current picker owner uses its compact single-bundled-Agent
        // presentation instead of an option array when no external entry exists.
        expect(wizard(model).agent.enabledAgentIds).toEqual(['claude']);
        expect(wizard(model).agent.agentPickerOptions).toBeUndefined();

        // Submitting while the projection loads cannot launch the stale target.
        await invokeHookAction(() => wizard(model).footer.handleCreateSession?.());

        expect(sessionSpawnNewActionBoundarySpy).not.toHaveBeenCalled();
        expect(modalAlertMock).toHaveBeenCalledWith('common.error', 'newSession.failedToStart');

        await hook.unmount();
    });

    it('restores the same target with the current generation and its choices when the authoritative projection arrives', async () => {
        setProjection('ready', buildAcmeProjectionInputs({ title: 'Acme Review Provider', generation: 7 }));
        const hook = await renderNewSessionScreenModel();
        let model = hook.getCurrent();
        await flushModel();
        model = await selectAcmeTarget(hook);

        // Same-machine generation advance → loading.
        setProjection('loading', buildAcmeProjectionInputs({ title: 'Acme Review Provider', generation: 7 }));
        await hook.rerender();
        await flushModel();
        model = hook.getCurrent();
        expect(pickerOptionIds(model)).not.toContain(ACME_TARGET_KEY);

        // The authoritative generation-8 projection arrives for the same
        // qualified Agent: the same target becomes selectable again with the
        // current generation's presentation, and the preferred target is
        // restored instead of being silently dropped.
        setProjection('ready', buildAcmeProjectionInputs({ title: 'Acme Review Provider v8', generation: 8 }));
        await hook.rerender();
        await flushModel();
        model = hook.getCurrent();

        expect(pickerOptionIds(model)).toContain(ACME_TARGET_KEY);
        const acmeOption = pickerOption(model, ACME_TARGET_KEY);
        expect(acmeOption?.disabled).toBe(false);
        expect(acmeOption?.subtitle).toBeUndefined();
        expect(wizard(model).agent.selectedBackendEntry?.backendTargetKey).toBe(ACME_TARGET_KEY);
        expect(wizard(model).agent.agentLabel).toBe('Acme Review Provider v8');
        expect(wizard(model).agent.agentPickerSelectedOptionId).toBe(ACME_TARGET_KEY);

        await hook.unmount();
    });

    it('drops the retired external entry without replacing the authored target', async () => {
        setProjection('ready', buildAcmeProjectionInputs({ title: 'Acme Review Provider', generation: 7 }));
        const hook = await renderNewSessionScreenModel();
        let model = hook.getCurrent();
        await flushModel();
        model = await selectAcmeTarget(hook);
        expect(wizard(model).agent.agentPickerSelectedOptionId).toBe(ACME_TARGET_KEY);

        // Retired: the next authoritative generation no longer projects the Agent.
        setProjection('ready', buildAcmeProjectionInputs({ title: 'unused', generation: 8, hasAgent: false }));
        await hook.rerender();
        await flushModel();
        model = hook.getCurrent();

        expect(pickerOptionIds(model)).not.toContain(ACME_TARGET_KEY);
        // The selection owner preserves explicit picker intent. A catalog
        // withdrawal removes availability; it cannot pick a different Agent.
        expect(wizard(model).agent.selectedBackendEntry).toBeNull();
        expect(wizard(model).agent.agentPickerSelectedOptionId).toBe(ACME_TARGET_KEY);
        expect(wizard(model).footer.canCreate).toBe(false);
        await invokeHookAction(() => wizard(hook.getCurrent()).footer.handleCreateSession?.());
        expect(sessionSpawnNewActionBoundarySpy).not.toHaveBeenCalled();

        await hook.unmount();
    });

    it('never reuses the prior machine entry after switching to another machine', async () => {
        setProjection('ready', buildAcmeProjectionInputs({ title: 'Acme Review Provider', generation: 7 }));
        const hook = await renderNewSessionScreenModel();
        let model = hook.getCurrent();
        await flushModel();
        model = await selectAcmeTarget(hook);
        expect(pickerOptionIds(model)).toContain(ACME_TARGET_KEY);

        // Switch machines: the projection scope changes. Even while the new
        // machine's projection is loading, machine-1's entry must not appear.
        setProjection('loading', null);
        await invokeHookAction(() => wizard(model).machine.setSelectedMachineId('machine-2'));
        await flushModel();
        model = hook.getCurrent();

        expect(wizard(model).machine.selectedMachine?.id).toBe('machine-2');
        expect(pickerOptionIds(model)).not.toContain(ACME_TARGET_KEY);

        // And machine-2's own authoritative projection does not project it either.
        setProjection('ready', buildAcmeProjectionInputs({ title: 'unused', generation: 3, hasAgent: false }));
        await hook.rerender();
        await flushModel();
        model = hook.getCurrent();

        expect(pickerOptionIds(model)).not.toContain(ACME_TARGET_KEY);
        expect(wizard(model).agent.selectedBackendEntry).toBeNull();
        expect(wizard(model).agent.agentPickerSelectedOptionId).toBe(ACME_TARGET_KEY);
        expect(wizard(model).footer.canCreate).toBe(false);
        await invokeHookAction(() => wizard(hook.getCurrent()).footer.handleCreateSession?.());
        expect(sessionSpawnNewActionBoundarySpy).not.toHaveBeenCalled();

        await hook.unmount();
    });

    it('keeps installable remediation selectable for a projected Agent whose CLI is not detected, only while its projection is current', async () => {
        // The projected descriptor declares an installable dependency but
        // explicitly withholds CLI-less selectability: the Agent is
        // remediation-selectable, not silently runnable.
        publishProjectedAgentUiBehaviorDescriptors({
            machineId: 'machine-1',
            descriptorsByAgentId: {
                [ACME_AGENT_ID]: {
                    newSession: {
                        relevantInstallableDepKeys: ['acme.cli'],
                        canSelectWithoutDetectedCli: false,
                    },
                },
            },
        });
        inventoryState.installed = false;
        setProjection('ready', buildAcmeProjectionInputs({ title: 'Acme Review Provider', generation: 7 }));
        const hook = await renderNewSessionScreenModel();
        let model = hook.getCurrent();
        await flushModel();
        model = hook.getCurrent();

        const { machineAgentInventoryStore } = await import('@/agents/machineAgents/machineAgentInventoryStore');
        const { serverAccountScopedResourceKey } = await import('@/sync/domains/scope/serverAccountScope');
        const inventoryKey = serverAccountScopedResourceKey(
            { serverId: serverState.id, accountId: 'currentness-account' }, 'machine-agents', 'machine-1',
        );
        await vi.waitFor(() => {
            expect(machineAgentInventoryStore.read(inventoryKey)).toMatchObject({ status: 'ready' });
            expect(machineAgentInventoryStore.read(inventoryKey).agents).toEqual(expect.arrayContaining([
                expect.objectContaining({ agentId: ACME_AGENT_ID, state: 'notInstalled', installed: false, stale: false }),
            ]));
            expect(pickerOption(hook.getCurrent(), ACME_TARGET_KEY)?.disabled).toBe(false);
        });
        model = hook.getCurrent();
        const acmeOption = pickerOption(model, ACME_TARGET_KEY);
        expect(acmeOption).toBeTruthy();
        expect(acmeOption?.disabled).toBe(false);
        expect(pickerOptionIds(model)).toContain(ACME_TARGET_KEY);
        await invokeHookAction(() => wizard(model).agent.onAgentPickerSelect?.(ACME_TARGET_KEY));
        model = hook.getCurrent();
        // Setup rows deliberately never apply an unready Agent to the draft.
        expect(acmeOption?.closeOnSelectImmediate).toBe(false);
        expect(acmeOption?.renderDetailContent).toBeTypeOf('function');
        expect(wizard(model).agent.selectedBackendEntry?.backendTargetKey).toBe(CLAUDE_TARGET_KEY);
        expect(sessionSpawnNewActionBoundarySpy).not.toHaveBeenCalled();

        // While the projection is not current, the remediable-but-stale entry
        // is absent rather than presented as runnable.
        setProjection('loading', buildAcmeProjectionInputs({ title: 'Acme Review Provider', generation: 7 }));
        await hook.rerender();
        await flushModel();
        model = hook.getCurrent();
        expect(pickerOptionIds(model)).not.toContain(ACME_TARGET_KEY);
        expect(wizard(model).agent.selectedBackendEntry?.backendTargetKey).toBe(CLAUDE_TARGET_KEY);

        await hook.unmount();
    });
});
