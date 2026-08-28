import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BUNDLED_CANONICAL_AGENT_CONTRIBUTION_IDENTITIES } from '@/agents/registry/generatedBundledPluginEntries';
import { publishProjectedAgentUiBehaviorDescriptors } from '@/agents/registry/agentUiBehaviorProjection';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import {
    flushHookEffects,
    renderHook,
} from '@/dev/testkit';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';

import { installNewSessionScreenModelCommonModuleMocks } from './newSessionScreenModelTestHelpers';

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
 * on the screen-model owner. The daemon spawn Action is the only other mocked
 * boundary — it is the wire this corridor must never emit a stale target on.
 */

const ACME_AGENT_ID = 'acme.review.provider';
const ACME_PLUGIN_ID = 'acme.review';
const ACME_LOCAL_ID = 'provider';
const ACME_IDENTITY = { pluginId: ACME_PLUGIN_ID, localId: ACME_LOCAL_ID } as const;
const ACME_TARGET_KEY = resolveBackendTargetKeyV2({ kind: 'agent', identity: ACME_IDENTITY });
const CLAUDE_TARGET_KEY = resolveBackendTargetKeyV2({
    kind: 'agent',
    identity: BUNDLED_CANONICAL_AGENT_CONTRIBUTION_IDENTITIES.claude,
});

type ProjectionPhase = 'idle' | 'loading' | 'ready' | 'unsupported' | 'error';

const projectionState = vi.hoisted(() => ({
    phase: 'ready' as ProjectionPhase,
    inputs: null as Record<string, unknown> | null,
}));

vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
    useDaemonMergedProjectionInputs: () => ({
        phase: projectionState.phase,
        inputs: projectionState.inputs,
    }),
}));

function buildAcmeProjectionInputs(params: Readonly<{
    title: string;
    generation: number;
}>): Record<string, unknown> {
    return {
        mergedProviderProjectionById: {
            [ACME_AGENT_ID]: {
                agentId: ACME_AGENT_ID,
                identity: ACME_IDENTITY,
                projectionGeneration: params.generation,
                title: params.title,
                isBuiltIn: false,
            },
        },
        mergedBackendProjectionById: {
            'acme.review.backend': {
                backendId: 'acme.review.backend',
                agentId: ACME_AGENT_ID,
                title: params.title,
                capabilities: { session: { supported: true } },
            },
        },
        discoveredBackendIds: ['acme.review.backend'],
        pluginProjectionById: {},
        pluginProjectionV2: null,
        registryDiagnostics: [],
    };
}

function setProjection(phase: ProjectionPhase, inputs: Record<string, unknown> | null): void {
    projectionState.phase = phase;
    projectionState.inputs = inputs;
}

const pendingFireAndForget = vi.hoisted((): Array<Promise<unknown>> => []);
const applySettingsMock = vi.hoisted(() => vi.fn());
const modalAlertMock = vi.hoisted(() => vi.fn());
const sessionSpawnNewActionBoundarySpy = vi.hoisted(() => vi.fn(async (_input: unknown) => ({
    type: 'error' as const,
    errorCode: 'DAEMON_RPC_UNAVAILABLE' as const,
    errorMessage: 'Daemon RPC is not available',
})));
const cliAvailabilityRefreshMock = vi.hoisted(() => vi.fn());

const cliAvailabilityState = vi.hoisted(() => ({
    value: {
        available: { claude: true } as Record<string, boolean | null>,
    } as Partial<{
        available: Record<string, boolean | null>;
        authStatus: Record<string, unknown>;
        isDetecting: boolean;
        timestamp: number;
    }>,
}));

const enabledAgentIdsState = vi.hoisted(() => ({
    value: ['claude'] as string[],
}));

const machineState = vi.hoisted(() => ({
    value: [
        { id: 'machine-1', metadata: { displayName: 'Machine One', host: 'one', homeDir: '/home/one' } },
        { id: 'machine-2', metadata: { displayName: 'Machine Two', host: 'two', homeDir: '/home/two' } },
    ] as Array<{ id: string; metadata: Record<string, unknown> }>,
}));

const routeParamsState = vi.hoisted(() => ({
    value: { machineId: 'machine-1' } as Record<string, string | string[] | undefined>,
}));

const storageState = vi.hoisted(() => ({
    workspaceLocations: {} as Record<string, unknown>,
    workspaceCheckouts: {} as Record<string, unknown>,
    sessionListRowStateByServerId: {} as Record<string, Record<string, unknown>>,
}));

const getMockStorageState = vi.hoisted(() => () => ({
    settings: {},
    workspaceLocations: storageState.workspaceLocations,
    workspaceCheckouts: storageState.workspaceCheckouts,
    sessions: {} as Record<string, unknown>,
    sessionListRowStateByServerId: storageState.sessionListRowStateByServerId,
    createSessionActionDraft: undefined,
}));

const testSettingsDefaults = vi.hoisted(() => ({
    recentMachinePaths: [] as Array<{ machineId: string; path: string }>,
    lastUsedAgent: 'claude',
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

const settingsState = vi.hoisted(() => ({
    ...testSettingsDefaults,
}));
const settingsRuntimeState = vi.hoisted(() => ({
    current: settingsState as typeof settingsState | undefined,
}));

const initialHookFlushOptions = { cycles: 2, turns: 2 } as const;

async function renderNewSessionScreenModel() {
    const { useNewSessionScreenModel } = await import('./useNewSessionScreenModel');
    return renderHook<any>(() => useNewSessionScreenModel() as any, {
        flushOptions: initialHookFlushOptions,
    });
}

async function flushModel(): Promise<any> {
    await flushHookEffects({ cycles: 1, turns: 2 });
    await Promise.allSettled(pendingFireAndForget);
}

async function invokeHookAction(action: () => void | Promise<void>) {
    await act(async () => {
        await action();
    });
    await flushModel();
}

function pickerOptionIds(model: any): string[] {
    return ((model?.simpleProps?.agentPickerOptions ?? []) as Array<{ id?: string }>)
        .map((option) => String(option.id ?? ''));
}

function pickerOption(model: any, targetKey: string): { id: string; label?: string; subtitle?: string; disabled?: boolean } | undefined {
    return ((model?.simpleProps?.agentPickerOptions ?? []) as Array<{ id: string; label?: string; subtitle?: string; disabled?: boolean }>)
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
    storage: async (importOriginal) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit/createPartialStorageModuleMock');
        return createPartialStorageModuleMock(importOriginal, {
            // Boundary fixture: this suite only consumes the machine id + metadata shape.
            useAllMachines: (() => machineState.value as any) as any,
            useLaunchSelectionMachines: (() => machineState.value as any) as any,
            useMachineListByServerId: () => ({
                s1: machineState.value as any,
            }),
            useMachineListStatusByServerId: () => ({}),
            storage: Object.assign((selector: (state: ReturnType<typeof getMockStorageState>) => unknown) => selector(getMockStorageState()), {
                getState: () => getMockStorageState(),
            }) as any,
            useSetting: (key: string) => (settingsRuntimeState.current as any)?.[key] ?? (testSettingsDefaults as any)[key],
            useSettingMutable: (key: string) => [
                (settingsRuntimeState.current as any)?.[key] ?? (testSettingsDefaults as any)[key],
                vi.fn(),
            ],
            useCurrentFavoriteModelSelectionsV1Mutable: () => [
                (settingsRuntimeState.current as any)?.currentFavoriteModelSelectionsV1
                    ?? (testSettingsDefaults as any).currentFavoriteModelSelectionsV1,
                vi.fn(),
            ],
            useCurrentRememberedEngineSelectionsByScopeV1Mutable: () => [
                (settingsRuntimeState.current as any)?.currentRememberedEngineSelectionsByScopeV1
                    ?? (testSettingsDefaults as any).currentRememberedEngineSelectionsByScopeV1,
                vi.fn(),
            ],
            // Boundary fixture: the suite overrides only the settings fields it actually reads.
            useSettings: (() => (settingsRuntimeState.current ?? testSettingsDefaults) as any) as any,
        });
    },
});

vi.mock('react-native-safe-area-context', () => ({
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

vi.mock('@react-navigation/native', () => ({
    useIsFocused: () => true,
    useFocusEffect: (_fn: any) => {},
}));

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

vi.mock('@/sync/sync', () => ({
    sync: {
        refreshMachinesThrottled: async () => {},
        encryptSecretValue: (v: string) => v,
        decryptSecretValue: (v: string | null) => v ?? '',
        acquireUserRequestLease: () => () => {},
        getCredentials: () => ({ secret: 'test-secret' }),
        refreshAutomations: async () => {},
        refreshSessions: async () => {},
        refreshMachines: async () => {},
        sendMessage: async () => {},
        ensureSessionVisibleForMessageRoute: async () => {},
    },
}));

vi.mock('@/sync/store/settingsWriters', () => ({
    useApplySettings: () => applySettingsMock,
}));

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => enabledAgentIdsState.value,
}));

vi.mock('@/hooks/auth/useCLIDetection', () => ({
    useCLIDetection: () => ({
        refresh: cliAvailabilityRefreshMock,
        isDetecting: false,
        timestamp: 1,
        available: cliAvailabilityState.value.available ?? {},
        login: {},
        authStatus: cliAvailabilityState.value.authStatus ?? {},
        resolvedPath: {},
        resolvedCommand: {},
        resolutionSource: {},
        tmux: null,
    }),
}));

vi.mock('@/utils/sessions/machineUtils', () => ({
    isMachineOnline: () => true,
}));

const ensureAgentInstallablesBackgroundMock = vi.hoisted(() => vi.fn(async (_params?: unknown) => {}));

vi.mock('@/capabilities/ensureAgentInstallablesBackground', () => ({
    ensureAgentInstallablesBackground: (params: unknown) => ensureAgentInstallablesBackgroundMock(params),
}));

const machineCapabilitiesInvoke = vi.hoisted(() =>
    vi.fn(async () => ({ supported: true, response: { ok: true, result: null } })),
);
const machineCapabilitiesCacheRefreshMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/ops', () => ({
    machineCapabilitiesInvoke,
}));

vi.mock('@/hooks/server/useMachineCapabilitiesCache', () => ({
    useMachineCapabilitiesCache: () => ({ state: { status: 'idle' }, refresh: machineCapabilitiesCacheRefreshMock }),
    prefetchMachineCapabilities: async () => {},
    prefetchMachineCapabilitiesIfStale: async () => {},
    getMachineCapabilitiesSnapshot: () => ({
        response: {
            protocolVersion: 1 as const,
            results: {},
        },
    }),
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

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: 's_active' }),
    subscribeActiveServer: (fn: any) => {
        fn({ serverId: 's_active' });
        return () => {};
    },
}));

vi.mock('@/components/sessions/new/modules/useNewSessionConnectedServices', () => ({
    useNewSessionConnectedServices: () => ({
        connectedServicesAuthChip: null,
    }),
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
        settingsDefaults: testSettingsDefaults,
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

vi.mock('@/components/sessions/new/hooks/serverTarget/useNewSessionServerTargetState', () => ({
    useNewSessionServerTargetState: () => ({
        serverProfiles: [],
        serverTargets: [],
        resolvedSettingsTarget: { allowedServerIds: [] },
        allowedTargetServerIds: [],
        targetServerId: 's1',
        targetServerProfile: null,
        targetServerName: null,
        showServerPickerChip: false,
        serverSelectionProps: {},
        resolveTargetServerId: () => 's1',
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

vi.mock('@/components/sessions/new/hooks/useNewSessionWizardProps', () => ({
    useNewSessionWizardProps: () => {
        React.useMemo(() => null, []);
        return {
            layout: {},
            profiles: {},
            agent: {},
            machine: {},
            footer: {},
        };
    },
}));

// The daemon spawn Action is the wire this corridor must never emit a stale
// qualified target on. The outcome shape mirrors the sibling create-owner
// suites: a retryable machine_offline error keeps the assertion surface on the
// payload without dragging route-recovery timing into these tests.
vi.mock('@/sync/ops/actions/sessionSpawnNewAction', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/ops/actions/sessionSpawnNewAction')>(
        '@/sync/ops/actions/sessionSpawnNewAction',
    );
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

async function selectAcmeTarget(hook: Awaited<ReturnType<typeof renderNewSessionScreenModel>>): Promise<any> {
    let model = hook.getCurrent();
    await invokeHookAction(() => model?.simpleProps?.onAgentPickerSelect?.(ACME_TARGET_KEY));
    model = hook.getCurrent();
    return model;
}

describe('useNewSessionScreenModel (Agent projection currentness)', () => {
    beforeEach(() => {
        applySettingsMock.mockClear();
        modalAlertMock.mockClear();
        sessionSpawnNewActionBoundarySpy.mockClear();
        ensureAgentInstallablesBackgroundMock.mockClear();
        cliAvailabilityRefreshMock.mockClear();
        cliAvailabilityState.value = { available: { claude: true } };
        enabledAgentIdsState.value = ['claude'];
        routeParamsState.value = { machineId: 'machine-1' };
        settingsRuntimeState.current = { ...testSettingsDefaults };
        publishProjectedAgentUiBehaviorDescriptors({
            machineId: 'machine-1',
            descriptorsByAgentId: {},
        });
        publishProjectedAgentUiBehaviorDescriptors({
            machineId: 'machine-2',
            descriptorsByAgentId: {},
        });
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
        expect(model?.simpleProps?.selectedBackendTargetKey).toBe(ACME_TARGET_KEY);
        expect(model?.simpleProps?.selectedBackendEntryTargetKey).toBe(ACME_TARGET_KEY);

        // The same machine advances generation: the canonical projection hook
        // reports `loading` while retaining the previous inputs as inert
        // metadata. The stale entry must not stay displayed or resolved.
        setProjection('loading', buildAcmeProjectionInputs({ title: 'Acme Review Provider', generation: 7 }));
        await flushModel();
        model = hook.getCurrent();

        expect(pickerOptionIds(model)).not.toContain(ACME_TARGET_KEY);
        expect(model?.simpleProps?.selectedBackendEntryTargetKey).toBeUndefined();
        expect(model?.simpleProps?.agentLabel).not.toBe('Acme Review Provider');

        // Bundled host defaults do not depend on the machine projection and stay usable.
        expect(pickerOptionIds(model)).toContain(CLAUDE_TARGET_KEY);

        // Submitting while the projection loads cannot launch the stale target.
        await invokeHookAction(() => model?.simpleProps?.handleCreateSession?.());

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
        await flushModel();
        model = hook.getCurrent();
        expect(pickerOptionIds(model)).not.toContain(ACME_TARGET_KEY);

        // The authoritative generation-8 projection arrives for the same
        // qualified Agent: the same target becomes selectable again with the
        // current generation's presentation, and the preferred target is
        // restored instead of being silently dropped.
        setProjection('ready', buildAcmeProjectionInputs({ title: 'Acme Review Provider v8', generation: 8 }));
        await flushModel();
        model = hook.getCurrent();

        expect(pickerOptionIds(model)).toContain(ACME_TARGET_KEY);
        const acmeOption = pickerOption(model, ACME_TARGET_KEY);
        expect(acmeOption?.disabled).toBe(false);
        expect(acmeOption?.subtitle).toBeUndefined();
        expect(model?.simpleProps?.selectedBackendEntryTargetKey).toBe(ACME_TARGET_KEY);
        expect(model?.simpleProps?.agentLabel).toBe('Acme Review Provider v8');
        expect(model?.simpleProps?.agentPickerSelectedOptionId).toBe(ACME_TARGET_KEY);

        await hook.unmount();
    });

    it('drops the stale external target when the authoritative projection arrives without it', async () => {
        setProjection('ready', buildAcmeProjectionInputs({ title: 'Acme Review Provider', generation: 7 }));
        const hook = await renderNewSessionScreenModel();
        let model = hook.getCurrent();
        await flushModel();
        model = await selectAcmeTarget(hook);
        expect(model?.simpleProps?.selectedBackendTargetKey).toBe(ACME_TARGET_KEY);

        // Retired: the next authoritative generation no longer projects the Agent.
        const retiredProjection = buildAcmeProjectionInputs({ title: 'unused', generation: 8 });
        setProjection('ready', {
            ...retiredProjection,
            mergedProviderProjectionById: {},
            mergedBackendProjectionById: {},
            discoveredBackendIds: [],
        });
        await flushModel();
        model = hook.getCurrent();

        expect(pickerOptionIds(model)).not.toContain(ACME_TARGET_KEY);
        expect(model?.simpleProps?.selectedBackendEntryTargetKey).toBeUndefined();
        expect(model?.simpleProps?.selectedBackendTargetKey).not.toBe(ACME_TARGET_KEY);

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
        routeParamsState.value = { machineId: 'machine-2' };
        setProjection('loading', null);
        await flushModel();
        model = hook.getCurrent();

        expect(model?.simpleProps?.selectedMachineId).toBe('machine-2');
        expect(pickerOptionIds(model)).not.toContain(ACME_TARGET_KEY);

        // And machine-2's own authoritative projection does not project it either.
        setProjection('ready', {
            ...buildAcmeProjectionInputs({ title: 'unused', generation: 3 }),
            mergedProviderProjectionById: {},
            mergedBackendProjectionById: {},
            discoveredBackendIds: [],
        });
        await flushModel();
        model = hook.getCurrent();

        expect(pickerOptionIds(model)).not.toContain(ACME_TARGET_KEY);
        expect(model?.simpleProps?.selectedBackendEntryTargetKey).toBeUndefined();

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
        cliAvailabilityState.value = { available: { claude: true, [ACME_AGENT_ID]: false } };
        setProjection('ready', buildAcmeProjectionInputs({ title: 'Acme Review Provider', generation: 7 }));
        const hook = await renderNewSessionScreenModel();
        let model = hook.getCurrent();
        await flushModel();
        model = hook.getCurrent();

        const acmeOption = pickerOption(model, ACME_TARGET_KEY);
        expect(acmeOption).toBeTruthy();
        expect(acmeOption?.disabled).toBe(false);
        expect(pickerOptionIds(model)).toContain(ACME_TARGET_KEY);
        model = await selectAcmeTarget(hook);
        expect(model?.simpleProps?.selectedBackendEntryTargetKey).toBe(ACME_TARGET_KEY);

        // While the projection is not current, the remediable-but-stale entry
        // is absent rather than presented as runnable.
        setProjection('loading', buildAcmeProjectionInputs({ title: 'Acme Review Provider', generation: 7 }));
        await flushModel();
        model = hook.getCurrent();
        expect(pickerOptionIds(model)).not.toContain(ACME_TARGET_KEY);
        expect(model?.simpleProps?.selectedBackendEntryTargetKey).toBeUndefined();

        await hook.unmount();
    });
});
