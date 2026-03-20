import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBackendTargetKey, type AcpCatalogSettingsV1 } from '@happier-dev/protocol';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';

import { useNewSessionScreenModel } from './useNewSessionScreenModel';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const pendingFireAndForget = vi.hoisted((): Array<Promise<unknown>> => []);
const applySettingsMock = vi.hoisted(() => vi.fn());
const modalShowMock = vi.hoisted(() => vi.fn(() => 'modal-id'));
const modalAlertMock = vi.hoisted(() => vi.fn());
const createSessionActionDraftMock = vi.hoisted(() => vi.fn());
const handleCreateSessionMock = vi.hoisted(() =>
    vi.fn((opts?: { afterCreated?: (context: { sessionId: string; effectiveSpawnServerId: string | null }) => void | Promise<void> }) => {
        return opts?.afterCreated?.({ sessionId: 'session-created', effectiveSpawnServerId: null });
    }),
);
const agentInputActionChipActionIdsState = vi.hoisted(() => ({
    value: [] as string[],
}));

const enabledAgentIdsState = vi.hoisted(() => ({
    value: ['codex', 'claude'] as string[],
}));

const cliAvailabilityState = vi.hoisted(() => ({
    value: {
        timestamp: 1,
        available: { codex: false, claude: true, opencode: null as boolean | null },
    },
}));

const featureEnabledState = vi.hoisted(() => ({
    sessionsDirect: false,
}));
const featureEnabledCalls = vi.hoisted(() => [] as Array<Readonly<{ featureId: string; scope: unknown }>>);
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
    profiles: [] as AIBackendProfile[],
    secrets: [],
    secretBindingsByProfileId: {},
    serverSelectionGroups: [],
    serverSelectionActiveTargetKind: null,
    serverSelectionActiveTargetId: null,
    codexBackendMode: 'acp',
    installablesPolicyByMachineId: {},
    sessionWindowsRemoteSessionLaunchMode: 'hidden' as 'hidden' | 'windows_terminal' | 'console',
    backendEnabledByTargetKey: {} as Record<string, boolean>,
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

const storageState = vi.hoisted(() => ({
    workspaceLocations: {} as Record<string, unknown>,
    workspaceCheckouts: {} as Record<string, unknown>,
}));

const getMockStorageState = vi.hoisted(() => () => ({
    settings: settingsRuntimeState.current ?? testSettingsDefaults,
    workspaceLocations: storageState.workspaceLocations,
    workspaceCheckouts: storageState.workspaceCheckouts,
    createSessionActionDraft: createSessionActionDraftMock,
}));

const persistedDraft = vi.hoisted(() => ({
    input: '',
    selectedMachineId: 'machine-1',
    selectedPath: '/repo',
    selectedProfileId: null as string | null,
    selectedSecretId: null,
    agentType: 'codex' as string,
    permissionMode: 'default',
    modelMode: 'default',
    acpSessionModeId: 'plan',
    agentNewSessionOptionStateByAgentId: {},
    updatedAt: 123,
}));

vi.mock('react-native', () => ({
    Platform: { OS: 'web', select: (options: any) => options?.web ?? options?.default ?? options?.ios ?? options?.android },
    Text: 'Text',
    View: 'View',
    Pressable: 'Pressable',
    Dimensions: { get: () => ({ width: 900, height: 800 }) },
    // Simulate a web environment where InteractionManager callbacks may never fire.
    InteractionManager: { runAfterInteractions: () => ({ cancel: () => {} }) },
    useWindowDimensions: () => ({ width: 900, height: 800 }),
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/utils/platform/responsive', () => ({
    useHeaderHeight: () => 0,
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
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
    }),
    StyleSheet: {
        create: (styles: any) => {
            const theme = {
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
            };
            const runtime = { themeName: 'light' };
            return typeof styles === 'function' ? styles(theme, runtime) : styles;
        },
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), setParams: vi.fn() }),
    useNavigation: () => ({}),
    usePathname: () => '/new',
    useLocalSearchParams: () => ({}),
}));

vi.mock('@react-navigation/native', () => ({
    useFocusEffect: (_fn: any) => {},
}));

vi.mock('@/sync/domains/state/persistence', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        loadNewSessionDraft: () => persistedDraft,
        saveNewSessionDraft: () => {},
    };
});

vi.mock('@/sync/domains/state/storage', () => ({
    useAllMachines: () => machineState.value,
    storage: Object.assign((selector: (state: ReturnType<typeof getMockStorageState>) => unknown) => selector(getMockStorageState()), {
        getState: () => getMockStorageState(),
    }),
    useSetting: (key: string) => (settingsRuntimeState.current as any)?.[key] ?? (testSettingsDefaults as any)[key],
    useSettingMutable: (key: string) => [
        (settingsRuntimeState.current as any)?.[key] ?? (testSettingsDefaults as any)[key],
        vi.fn(),
    ],
    useSettings: () => settingsRuntimeState.current ?? testSettingsDefaults,
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        refreshMachinesThrottled: async () => {},
        encryptSecretValue: (v: string) => v,
    },
}));

vi.mock('@/sync/store/settingsWriters', () => ({
    useApplySettings: () => applySettingsMock,
}));

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => enabledAgentIdsState.value,
}));

vi.mock('@/hooks/auth/useCLIDetection', () => ({
    useCLIDetection: () => cliAvailabilityState.value,
}));

vi.mock('@/utils/sessions/machineUtils', () => ({
    isMachineOnline: () => true,
}));

const machineCapabilitiesInvoke = vi.hoisted(() =>
    vi.fn(async () => ({ supported: true, response: { ok: true, result: null } })),
);

vi.mock('@/sync/ops', () => ({
    machineCapabilitiesInvoke,
}));

vi.mock('@/hooks/server/useMachineCapabilitiesCache', () => ({
    useMachineCapabilitiesCache: () => ({ state: { status: 'idle' } }),
    prefetchMachineCapabilities: async () => {},
    prefetchMachineCapabilitiesIfStale: async () => {},
    getMachineCapabilitiesSnapshot: () => ({
        response: {
            protocolVersion: 1 as const,
            results: machineCapabilitiesResultsState.value,
        },
    }),
}));

vi.mock('@/components/sessions/new/hooks/useNewSessionCapabilitiesPrefetch', () => ({
    useNewSessionCapabilitiesPrefetch: () => {},
}));

vi.mock('@/components/sessions/new/hooks/useNewSessionDraftAutoPersist', () => ({
    useNewSessionDraftAutoPersist: () => {},
}));

vi.mock('@/components/sessions/new/hooks/useCreateNewSession', () => ({
    useCreateNewSession: () => ({
        canCreate: true,
        connectionStatus: 'ok',
        handleCreateSession: handleCreateSessionMock,
    }),
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

vi.mock('@/modal', () => ({
    Modal: { show: modalShowMock, alert: modalAlertMock },
}));

vi.mock('@/components/sessions/new/modules/profileHelpers', () => ({
    useProfileMap: (profiles: Array<{ id: string }>) => new Map(profiles.map((profile) => [profile.id, profile])),
    transformProfileToEnvironmentVars: () => [],
}));

vi.mock('@/components/sessions/new/hooks/newSessionModelModePolicy', () => ({
    resolveInitialNewSessionModelMode: () => 'default',
    coerceNewSessionModelMode: ({ modelMode }: any) => modelMode,
}));

vi.mock('@/sync/domains/settings/settings', () => ({
    settingsDefaults: testSettingsDefaults,
    isProfileCompatibleWithAnyAgent: (profile: any, agentIds: readonly string[]) =>
        profileCompatibilityState.isProfileCompatibleWithAnyAgent(profile, agentIds),
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
    getProfileSupportedAgentIds: (profile: any) => profileCompatibilityState.getProfileSupportedAgentIds(profile),
    isProfileCompatibleWithAnyAgent: (profile: any, agentIds: readonly string[]) =>
        profileCompatibilityState.isProfileCompatibleWithAnyAgent(profile, agentIds),
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
    useNewSessionPreflightModelsState: (params: { backendTarget: any }) => {
        const targetKey = buildBackendTargetKey(params.backendTarget);
        return {
            preflightModels: null,
            modelOptions: preflightModelOptionsByTargetKeyState.value[targetKey] ?? [],
            probe: { phase: 'idle', refresh: vi.fn() },
        };
    },
}));

vi.mock('@/components/sessions/new/hooks/screenModel/useNewSessionPreflightSessionModesState', () => ({
    useNewSessionPreflightSessionModesState: (params: { backendTarget: any }) => {
        const targetKey = buildBackendTargetKey(params.backendTarget);
        return {
            preflightModes: null,
            modeOptions: preflightSessionModeOptionsByTargetKeyState.value[targetKey] ?? [],
            probe: { phase: 'idle', refresh: vi.fn() },
        };
    },
}));

vi.mock('@/components/sessions/new/hooks/screenModel/useNewSessionPreflightConfigOptionsState', () => ({
    useNewSessionPreflightConfigOptionsState: (params: { backendTarget: any }) => {
        const targetKey = buildBackendTargetKey(params.backendTarget);
        return {
            configOptions: preflightConfigOptionsByTargetKeyState.value[targetKey] ?? null,
            probe: { phase: 'idle', refresh: vi.fn() },
        };
    },
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

describe('useNewSessionScreenModel (installables)', () => {
    beforeEach(() => {
        applySettingsMock.mockClear();
        modalShowMock.mockClear();
        modalAlertMock.mockClear();
        createSessionActionDraftMock.mockReset();
        handleCreateSessionMock.mockReset();
        agentInputActionChipActionIdsState.value = [];
        settingsRuntimeState.current = settingsState;
        settingsState.useEnhancedSessionWizard = false;
        settingsState.newSessionDefaultPersistenceModeV1 = 'persisted';
        settingsState.newSessionDefaultPersistenceModeByTargetKeyV1 = {};
        settingsState.useProfiles = false;
        settingsState.profiles = [];
        settingsState.codexBackendMode = 'acp';
        settingsState.sessionWindowsRemoteSessionLaunchMode = 'hidden';
        settingsState.lastUsedAgent = 'codex';
        settingsState.lastUsedPermissionMode = 'default';
        settingsState.sessionDefaultPermissionModeByTargetKey = {};
        settingsState.backendEnabledByTargetKey = {};
        settingsState.acpCatalogSettingsV1 = {
            v: 2,
            backends: [],
        };
        profileCompatibilityState.isProfileCompatibleWithAgent = () => true;
        profileCompatibilityState.isProfileCompatibleWithBackendTarget = () => true;
        profileCompatibilityState.isProfileCompatibleWithAnyAgent = () => true;
        profileCompatibilityState.getProfileSupportedAgentIds = () => [];
        persistedDraft.agentType = 'codex';
        persistedDraft.selectedProfileId = null;
        persistedDraft.selectedSecretId = null;
        persistedDraft.permissionMode = 'default';
        persistedDraft.modelMode = 'default';
        persistedDraft.acpSessionModeId = 'plan';
        persistedDraft.agentNewSessionOptionStateByAgentId = {};
        delete (persistedDraft as any).backendTarget;
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
        pendingFireAndForget.length = 0;
        featureEnabledState.sessionsDirect = false;
        featureEnabledCalls.length = 0;
        preflightModelOptionsByTargetKeyState.value = {};
        preflightSessionModeOptionsByTargetKeyState.value = {};
        preflightConfigOptionsByTargetKeyState.value = {};
    });

    it('renders without throwing during initial new-session screen model setup', async () => {
        function Probe() {
            useNewSessionScreenModel();
            return null;
        }

        await act(async () => {
            expect(() => renderer.create(React.createElement(Probe))).not.toThrow();
        });
    });

    it('reads sessions.direct in target-server spawn scope', async () => {
        function Probe() {
            useNewSessionScreenModel();
            return null;
        }

        await act(async () => {
            renderer.create(React.createElement(Probe));
        });

        expect(featureEnabledCalls).toContainEqual({
            featureId: 'sessions.direct',
            scope: { scopeKind: 'spawn', serverId: 's1' },
        });
    });

    it('triggers background codex-acp install even when codex CLI is not detected', async () => {
        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await act(async () => {
            renderer.create(React.createElement(Probe));
            await Promise.resolve();
            await Promise.resolve();
        });

        await act(async () => {
            await Promise.allSettled(pendingFireAndForget);
        });

        expect(model).toBeTruthy();
        expect(model?.variant).toBe('simple');
        expect(machineCapabilitiesInvoke).toHaveBeenCalledWith(
            'machine-1',
            expect.objectContaining({ id: 'dep.codex-acp', method: 'install' }),
            expect.anything(),
        );
    });

    it('falls back to default settings when settings are temporarily unavailable during startup', async () => {
        settingsRuntimeState.current = undefined;

        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await act(async () => {
            renderer.create(React.createElement(Probe));
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(model).toBeTruthy();
        expect(model?.variant).toBe('simple');
    });

    it('does not change hook order when the enhanced wizard flag toggles after mount', async () => {
        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        settingsState.useEnhancedSessionWizard = false;

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(Probe));
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(model?.variant).toBe('simple');

        settingsState.useEnhancedSessionWizard = true;

        await act(async () => {
            tree!.update(React.createElement(Probe));
            await Promise.resolve();
            await Promise.resolve();
        });

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

        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await act(async () => {
            renderer.create(React.createElement(Probe));
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(model?.simpleProps?.agentType).toBe('claude');
        expect(model?.simpleProps?.agentPickerOptions?.map((option: { id: string }) => option.id)).toEqual([
            'agent:claude',
            'agent:opencode',
        ]);

        await act(async () => {
            model?.simpleProps?.onAgentPickerSelect?.('agent:opencode');
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(model?.simpleProps?.agentType).toBe('opencode');
    });

    it('renders backend picker options with engine detail previews sourced from preflight models', async () => {
        settingsState.codexBackendMode = 'mcp';
        settingsState.lastUsedAgent = 'claude';
        persistedDraft.agentType = 'claude';
        enabledAgentIdsState.value = ['claude', 'opencode'];
        cliAvailabilityState.value = {
            timestamp: 1,
            available: { claude: true, codex: false, opencode: true },
        };
        preflightModelOptionsByTargetKeyState.value = {
            [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'claude' })]: [
                { value: 'default', label: 'Claude default', description: 'Uses the backend default.' },
                { value: 'claude-3.7-sonnet', label: 'Claude 3.7 Sonnet', description: 'Balanced coding model.' },
            ],
            [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'opencode' })]: [
                { value: 'default', label: 'OpenCode default', description: 'Uses the backend default.' },
                { value: 'opencode-fast', label: 'OpenCode Fast', description: 'Lower latency coding model.' },
            ],
        };

        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await act(async () => {
            renderer.create(React.createElement(Probe));
            await Promise.resolve();
            await Promise.resolve();
        });

        const opencodeOption = model?.simpleProps?.agentPickerOptions?.find?.((option: { id: string }) =>
            option.id === buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'opencode' }));

        const opencodeDetailContent = opencodeOption?.renderDetailContent?.() ?? opencodeOption?.detailContent ?? null;
        expect(opencodeDetailContent).toBeTruthy();

        let detailTree: renderer.ReactTestRenderer;
        await act(async () => {
            detailTree = renderer.create(React.createElement(React.Fragment, null, opencodeDetailContent));
            await Promise.resolve();
        });

        const previewItems = detailTree!.root.findAll((node) => node.props?.testID === 'model-picker-overlay-option:opencode-fast');
        expect(previewItems).toHaveLength(1);
        const previewItem = previewItems.at(0);
        expect(previewItem).toBeDefined();
        const previewTexts = detailTree!.root.findAll((node) => typeof node.props?.children === 'string')
            .map((node) => node.props.children);
        expect(previewTexts).toContain('OpenCode Fast');
        expect(previewTexts).toContain('Lower latency coding model.');
    });

    it('renders backend picker options with ACP mode previews when the backend exposes them', async () => {
        settingsState.lastUsedAgent = 'claude';
        settingsState.acpCatalogSettingsV1 = {
            v: 2,
            backends: [
                {
                    id: 'custom-preset',
                    name: 'custom-preset',
                    title: 'Custom Preset',
                    command: 'custom-acp',
                    args: ['serve'],
                    env: {},
                    transportProfile: 'generic',
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
        enabledAgentIdsState.value = ['claude', 'customAcp'];
        cliAvailabilityState.value = {
            timestamp: 1,
            available: { claude: true, customAcp: false, codex: false, opencode: null },
        } as any;
        preflightSessionModeOptionsByTargetKeyState.value = {
            [buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'custom-preset' })]: [
                { id: 'plan', name: 'Plan', description: 'Structured planning mode.' },
                { id: 'review', name: 'Review', description: 'Review and critique mode.' },
            ],
        };

        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await act(async () => {
            renderer.create(React.createElement(Probe));
            await Promise.resolve();
            await Promise.resolve();
        });

        const customPresetOption = model?.simpleProps?.agentPickerOptions?.find?.((option: { id: string }) =>
            option.id === buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'custom-preset' }));

        const customPresetDetailContent = customPresetOption?.renderDetailContent?.() ?? customPresetOption?.detailContent ?? null;
        expect(customPresetDetailContent).toBeTruthy();

        let detailTree: renderer.ReactTestRenderer;
        await act(async () => {
            detailTree = renderer.create(React.createElement(React.Fragment, null, customPresetDetailContent));
            await Promise.resolve();
        });

        const modePreviewItems = detailTree!.root.findAll((node) => node.props?.testID === 'agent-input-session-mode-option:review');
        expect(modePreviewItems).toHaveLength(1);
        const modePreviewItem = modePreviewItems.at(0);
        expect(modePreviewItem).toBeDefined();
    });

    it('applies backend-specific model and ACP mode selections from the engine picker detail pane', async () => {
        settingsState.lastUsedAgent = 'claude';
        settingsState.acpCatalogSettingsV1 = {
            v: 2,
            backends: [
                {
                    id: 'custom-preset',
                    name: 'custom-preset',
                    title: 'Custom Preset',
                    command: 'custom-acp',
                    args: ['serve'],
                    env: {},
                    transportProfile: 'generic',
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
        enabledAgentIdsState.value = ['claude', 'customAcp'];
        cliAvailabilityState.value = {
            timestamp: 1,
            available: { claude: true, customAcp: false, codex: false, opencode: null },
        } as any;
        preflightModelOptionsByTargetKeyState.value = {
            [buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'custom-preset' })]: [
                { value: 'default', label: 'Preset default', description: 'Uses the backend default.' },
                { value: 'preset-fast', label: 'Preset Fast', description: 'Fast preset model.' },
            ],
        };
        preflightSessionModeOptionsByTargetKeyState.value = {
            [buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'custom-preset' })]: [
                { id: 'plan', name: 'Plan', description: 'Structured planning mode.' },
                { id: 'review', name: 'Review', description: 'Review and critique mode.' },
            ],
        };
        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await act(async () => {
            renderer.create(React.createElement(Probe));
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(model?.simpleProps?.agentType).toBe('claude');
        expect(model?.simpleProps?.modelMode).toBe('default');
        expect(model?.simpleProps?.acpSessionModeId).toBe('plan');

        const customPresetOption = model?.simpleProps?.agentPickerOptions?.find?.((option: { id: string; onApply?: () => void; renderDetailContent?: () => React.ReactNode; detailContent?: React.ReactNode }) =>
            option.id === buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'custom-preset' }));
        const detailElement = (customPresetOption?.renderDetailContent?.() ?? customPresetOption?.detailContent) as React.ReactElement<{
            onSelectionChange?: (selection: { modelId: string; sessionModeId: string }) => void;
        }> | undefined;
        expect(detailElement).toBeTruthy();

        await act(async () => {
            detailElement?.props.onSelectionChange?.({
                modelId: 'preset-fast',
                sessionModeId: 'review',
            });
            customPresetOption?.onApply?.();
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(model?.simpleProps?.agentType).toBe('customAcp');
        expect(model?.simpleProps?.agentLabel).toBe('Custom Preset');
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
                    command: 'custom-acp',
                    args: ['serve'],
                    env: {},
                    transportProfile: 'generic',
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
        enabledAgentIdsState.value = ['claude', 'customAcp'];
        cliAvailabilityState.value = {
            timestamp: 1,
            available: { claude: true, customAcp: false, codex: false, opencode: null },
        } as any;

        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await act(async () => {
            renderer.create(React.createElement(Probe));
            await Promise.resolve();
            await Promise.resolve();
        });

        const customPresetOption = model?.simpleProps?.agentPickerOptions?.find?.((option: { id: string; renderDetailContent?: () => React.ReactNode }) =>
            option.id === buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'custom-preset' }));

        expect(typeof customPresetOption?.renderDetailContent).toBe('function');

        const firstDetailElement = customPresetOption?.renderDetailContent?.() as React.ReactElement<{
            selectedModelId?: string;
            onSelectionChange?: (selection: { modelId: string; sessionModeId: string; configOverrides?: Record<string, string> }) => void;
        }> | undefined;

        expect(firstDetailElement?.props.selectedModelId).toBe('default');

        act(() => {
            firstDetailElement?.props.onSelectionChange?.({
                modelId: 'preset-fast',
                sessionModeId: 'default',
                configOverrides: {},
            });
        });

        const updatedDetailElement = customPresetOption?.renderDetailContent?.() as React.ReactElement<{
            selectedModelId?: string;
        }> | undefined;

        expect(updatedDetailElement?.props.selectedModelId).toBe('preset-fast');
    });

    it('renders backend picker options with ACP config previews when the backend exposes them', async () => {
        settingsState.lastUsedAgent = 'claude';
        settingsState.acpCatalogSettingsV1 = {
            v: 2,
            backends: [
                {
                    id: 'custom-preset',
                    name: 'custom-preset',
                    title: 'Custom Preset',
                    command: 'custom-acp',
                    args: ['serve'],
                    env: {},
                    transportProfile: 'generic',
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
        enabledAgentIdsState.value = ['claude', 'customAcp'];
        cliAvailabilityState.value = {
            timestamp: 1,
            available: { claude: true, customAcp: false, codex: false, opencode: null },
        } as any;
        preflightConfigOptionsByTargetKeyState.value = {
            [buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'custom-preset' })]: [
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

        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await act(async () => {
            renderer.create(React.createElement(Probe));
            await Promise.resolve();
            await Promise.resolve();
        });

        const customPresetOption = model?.simpleProps?.agentPickerOptions?.find?.((option: { id: string }) =>
            option.id === buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'custom-preset' }));

        const customPresetDetailContent = customPresetOption?.renderDetailContent?.() ?? customPresetOption?.detailContent ?? null;
        expect(customPresetDetailContent).toBeTruthy();

        let detailTree: renderer.ReactTestRenderer;
        await act(async () => {
            detailTree = renderer.create(React.createElement(React.Fragment, null, customPresetDetailContent));
            await Promise.resolve();
        });

        const configPreviewItems = detailTree!.root.findAll((node) => node.props?.testID === 'agent-input-config-option:speed');
        expect(configPreviewItems).toHaveLength(1);
    });

    it('applies backend-specific ACP config selections from the engine picker detail pane', async () => {
        settingsState.lastUsedAgent = 'claude';
        settingsState.acpCatalogSettingsV1 = {
            v: 2,
            backends: [
                {
                    id: 'custom-preset',
                    name: 'custom-preset',
                    title: 'Custom Preset',
                    command: 'custom-acp',
                    args: ['serve'],
                    env: {},
                    transportProfile: 'generic',
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
        enabledAgentIdsState.value = ['claude', 'customAcp'];
        cliAvailabilityState.value = {
            timestamp: 1,
            available: { claude: true, customAcp: false, codex: false, opencode: null },
        } as any;
        preflightConfigOptionsByTargetKeyState.value = {
            [buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'custom-preset' })]: [
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
        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await act(async () => {
            renderer.create(React.createElement(Probe));
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(model?.simpleProps?.acpConfigOptionOverrides).toBeNull();

        const customPresetOption = model?.simpleProps?.agentPickerOptions?.find?.((option: { id: string; onApply?: () => void; renderDetailContent?: () => React.ReactNode; detailContent?: React.ReactNode }) =>
            option.id === buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'custom-preset' }));
        const detailElement = (customPresetOption?.renderDetailContent?.() ?? customPresetOption?.detailContent) as React.ReactElement<{
            onSelectionChange?: (selection: { modelId: string; sessionModeId: string; configOverrides?: Record<string, string> }) => void;
        }> | undefined;
        expect(detailElement).toBeTruthy();

        await act(async () => {
            detailElement?.props.onSelectionChange?.({
                modelId: 'default',
                sessionModeId: 'default',
                configOverrides: { speed: 'fast' },
            });
            customPresetOption?.onApply?.();
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(model?.simpleProps?.agentType).toBe('customAcp');
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

        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await act(async () => {
            renderer.create(React.createElement(Probe));
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(model?.simpleProps?.agentType).toBe('claude');
        const applySettingsCallsBeforeClick = applySettingsMock.mock.calls.length;

        await act(async () => {
            model?.simpleProps?.handleAgentClick?.();
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(model?.simpleProps?.agentType).toBe('claude');
        expect(applySettingsMock.mock.calls.length).toBe(applySettingsCallsBeforeClick);
    });

    it('keeps the current agent when none are selectable and no valid fallback exists', async () => {
        settingsState.codexBackendMode = 'mcp';
        settingsState.lastUsedAgent = 'codex';
        persistedDraft.agentType = 'codex';
        enabledAgentIdsState.value = ['claude', 'codex'];
        cliAvailabilityState.value = {
            timestamp: 1,
            available: { claude: false, codex: false, opencode: null },
        };

        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await act(async () => {
            renderer.create(React.createElement(Probe));
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(model?.simpleProps?.agentType).toBe('codex');
    });

    it('uses per-agent permission defaults instead of the legacy last-used permission setting', async () => {
        settingsState.lastUsedPermissionMode = 'yolo';
        settingsState.sessionDefaultPermissionModeByTargetKey = {
            [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' })]: 'read-only',
        };
        delete (persistedDraft as { permissionMode?: string }).permissionMode;

        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await act(async () => {
            renderer.create(React.createElement(Probe));
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(model?.simpleProps?.permissionMode).toBe('read-only');
    });

    it('keeps Custom ACP selected when a valid configured ACP backend is chosen even if the custom ACP CLI is unavailable', async () => {
        settingsState.lastUsedAgent = 'customAcp';
        settingsState.acpCatalogSettingsV1 = {
            v: 2,
            backends: [
                {
                    id: 'custom-preset',
                    name: 'custom-preset',
                    title: 'Custom Preset',
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
        settingsState.sessionDefaultPermissionModeByTargetKey = {
            [buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'custom-preset' })]: 'safe-yolo',
            [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'customAcp' })]: 'read-only',
        };
        persistedDraft.agentType = 'customAcp';
        delete (persistedDraft as { permissionMode?: string }).permissionMode;
        (persistedDraft as any).backendTarget = { kind: 'configuredAcpBackend', backendId: 'custom-preset' };
        persistedDraft.agentNewSessionOptionStateByAgentId = {};
        enabledAgentIdsState.value = ['customAcp', 'claude'];
        cliAvailabilityState.value = {
            timestamp: 1,
            available: { customAcp: false, claude: true, codex: false, opencode: null },
        } as any;

        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await act(async () => {
            renderer.create(React.createElement(Probe));
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(model?.simpleProps?.agentType).toBe('customAcp');
        expect(model?.simpleProps?.agentLabel).toBe('Custom Preset');
        expect(model?.simpleProps?.permissionMode).toBe('safe-yolo');
    });

    it('falls back to an enabled built-in backend when a persisted configured ACP backend is disabled by target key', async () => {
        settingsState.lastUsedAgent = 'claude';
        settingsState.backendEnabledByTargetKey = {
            [buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'custom-preset' })]: false,
        };
        settingsState.acpCatalogSettingsV1 = {
            v: 2,
            backends: [
                {
                    id: 'custom-preset',
                    name: 'custom-preset',
                    title: 'Custom Preset',
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
        (persistedDraft as any).backendTarget = { kind: 'configuredAcpBackend', backendId: 'custom-preset' };
        enabledAgentIdsState.value = ['claude', 'customAcp'];
        cliAvailabilityState.value = {
            timestamp: 1,
            available: { claude: true, customAcp: false, codex: false, opencode: null },
        } as any;

        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await act(async () => {
            renderer.create(React.createElement(Probe));
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(model?.simpleProps?.agentType).toBe('claude');
        expect(model?.simpleProps?.agentLabel).toBe('agentInput.agent.claude');
    });

    it('switches to a configured ACP backend when the selected profile is only compatible with that backend target', async () => {
        settingsState.useProfiles = true;
        settingsState.lastUsedAgent = 'claude';
        settingsState.acpCatalogSettingsV1 = {
            v: 2,
            backends: [
                {
                    id: 'custom-preset',
                    name: 'custom-preset',
                    title: 'Custom Preset',
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
                [buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'custom-preset' })]: true,
                [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'claude' })]: false,
            },
            envVarRequirements: [],
            isBuiltIn: false,
            createdAt: 0,
            updatedAt: 0,
            version: '1.0.0',
        }] as any;
        profileCompatibilityState.isProfileCompatibleWithAnyAgent = () => false;
        profileCompatibilityState.isProfileCompatibleWithBackendTarget = (profile: any, target: any) =>
            profile?.compatibilityByTargetKey?.[buildBackendTargetKey(target)] ?? false;
        persistedDraft.agentType = 'claude';
        persistedDraft.selectedProfileId = 'profile-1';
        (persistedDraft as any).backendTarget = { kind: 'builtInAgent', agentId: 'claude' };
        enabledAgentIdsState.value = ['claude', 'customAcp'];
        cliAvailabilityState.value = {
            timestamp: 1,
            available: { claude: true, customAcp: false, codex: false, opencode: null },
        } as any;

        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await act(async () => {
            renderer.create(React.createElement(Probe));
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(model?.simpleProps?.agentType).toBe('customAcp');
        expect(model?.simpleProps?.agentLabel).toBe('Custom Preset');
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

        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await act(async () => {
            renderer.create(React.createElement(Probe));
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(model?.simpleProps?.agentType).toBe('claude');
        const geminiOption = model?.simpleProps?.agentPickerOptions?.find?.((option: { label: string }) =>
            option?.label === 'agentInput.agent.gemini');
        expect(geminiOption).toBeTruthy();

        await act(async () => {
            model?.simpleProps?.onAgentPickerSelect?.(geminiOption?.id ?? 'agent:gemini');
            await Promise.resolve();
            await Promise.resolve();
        });

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

        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await act(async () => {
            renderer.create(React.createElement(Probe));
            await Promise.resolve();
            await Promise.resolve();
        });

        const chips = model?.simpleProps?.agentInputExtraActionChips ?? [];
        expect(chips.some((chip: { key: string }) => chip.key === 'new-session-storage')).toBe(true);
    });

    it('seeds execution-run action chips with UI-normalized permission defaults', async () => {
        agentInputActionChipActionIdsState.value = ['review.start'];

        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await act(async () => {
            renderer.create(React.createElement(Probe));
            await Promise.resolve();
            await Promise.resolve();
        });

        const chips = model?.simpleProps?.agentInputExtraActionChips ?? [];
        const reviewChip = chips.find((chip: { key: string }) => chip.key === 'new-session-action:review.start');
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

        await act(async () => {
            rendered.props.onPress?.();
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(handleCreateSessionMock).toHaveBeenCalledTimes(1);
        expect(createSessionActionDraftMock).toHaveBeenCalledWith(
            'session-created',
            expect.objectContaining({
                actionId: 'review.start',
                input: expect.objectContaining({
                    permissionMode: 'read-only',
                    changeType: 'uncommitted',
                }),
            }),
        );
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

        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await act(async () => {
            renderer.create(React.createElement(Probe));
            await Promise.resolve();
            await Promise.resolve();
        });

        const chips = model?.simpleProps?.agentInputExtraActionChips ?? [];
        const storageChip = chips.find((chip: { key: string }) => chip.key === 'new-session-storage');
        expect(storageChip).toBeTruthy();
        expect(storageChip?.controlId).toBe('storage');
        expect(typeof storageChip?.collapsedAction).toBe('function');

        let chipTree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            chipTree = renderer.create(storageChip.render({
                chipStyle: () => null,
                iconColor: '#000',
                showLabel: true,
                textStyle: {},
            }));
            await Promise.resolve();
        });
        expect(JSON.stringify(chipTree!.toJSON())).toContain('sessionsList.storageDirectTab');
    });

    it('prefers selected profile storage defaults over account defaults', async () => {
        featureEnabledState.sessionsDirect = true;
        settingsState.lastUsedAgent = 'codex';
        settingsState.newSessionDefaultPersistenceModeV1 = 'persisted';
        settingsState.newSessionDefaultPersistenceModeByTargetKeyV1 = { 'agent:codex': 'persisted' };
        settingsState.useProfiles = true;
        settingsState.profiles = [{
            id: 'profile-1',
            name: 'Profile One',
            environmentVariables: [],
            defaultPermissionModeByAgent: {},
            defaultPermissionModeByTargetKey: {},
            defaultPersistenceModeByAgent: {},
            defaultPersistenceModeByTargetKey: { 'agent:codex': 'direct' },
            compatibility: { codex: true, claude: true, gemini: true },
            compatibilityByTargetKey: {},
            envVarRequirements: [],
            isBuiltIn: false,
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

        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await act(async () => {
            renderer.create(React.createElement(Probe));
            await Promise.resolve();
            await Promise.resolve();
        });

        const chips = model?.simpleProps?.agentInputExtraActionChips ?? [];
        const storageChip = chips.find((chip: { key: string }) => chip.key === 'new-session-storage');
        expect(storageChip).toBeTruthy();

        let chipTree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            chipTree = renderer.create(storageChip.render({
                chipStyle: () => null,
                iconColor: '#000',
                showLabel: true,
                textStyle: {},
            }));
            await Promise.resolve();
        });
        expect(JSON.stringify(chipTree!.toJSON())).toContain('sessionsList.storageDirectTab');
    });

    it('recomputes transcript storage when switching configured ACP backend targets through the backend picker', async () => {
        featureEnabledState.sessionsDirect = true;
        settingsState.lastUsedAgent = 'customAcp';
        settingsState.newSessionDefaultPersistenceModeV1 = 'persisted';
        settingsState.newSessionDefaultPersistenceModeByTargetKeyV1 = {
            [buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'custom-preset-a' })]: 'persisted',
            [buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'custom-preset-b' })]: 'direct',
        };
        settingsState.acpCatalogSettingsV1 = {
            v: 2,
            backends: [
                {
                    id: 'custom-preset-a',
                    name: 'custom-preset-a',
                    title: 'Custom Preset A',
                    command: 'custom-acp-a',
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
                {
                    id: 'custom-preset-b',
                    name: 'custom-preset-b',
                    title: 'Custom Preset B',
                    command: 'custom-acp-b',
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
                    createdAt: 2,
                    updatedAt: 2,
                },
            ],
        };
        persistedDraft.agentType = 'customAcp';
        (persistedDraft as any).backendTarget = { kind: 'configuredAcpBackend', backendId: 'custom-preset-a' };
        enabledAgentIdsState.value = ['customAcp'];
        cliAvailabilityState.value = {
            timestamp: 1,
            available: { customAcp: false, codex: false, claude: false, opencode: null },
        } as any;
        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(Probe));
            await Promise.resolve();
            await Promise.resolve();
        });

        const renderStorageChipText = () => {
            const chips = model?.simpleProps?.agentInputExtraActionChips ?? [];
            const storageChip = chips.find((chip: { key: string }) => chip.key === 'new-session-storage');
            expect(storageChip).toBeTruthy();
            let chipTree: renderer.ReactTestRenderer | null = null;
            void act(() => {
                chipTree = renderer.create(storageChip.render({
                    chipStyle: () => null,
                    iconColor: '#000',
                    showLabel: true,
                    textStyle: {},
                }));
            });
            return JSON.stringify(chipTree!.toJSON());
        };

        expect(renderStorageChipText()).toContain('sessionsList.storagePersistedTab');

        await act(async () => {
            model?.simpleProps?.onAgentPickerSelect?.(buildBackendTargetKey({
                kind: 'configuredAcpBackend',
                backendId: 'custom-preset-b',
            }));
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(model?.simpleProps?.agentType).toBe('customAcp');
        expect(model?.simpleProps?.agentLabel).toBe('Custom Preset B');
        expect(renderStorageChipText()).toContain('sessionsList.storageDirectTab');
        act(() => {
            tree?.unmount();
        });
    });

    it('shows a Windows session-mode chip on Windows machines through the canonical control and shared options popover', async () => {
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
        settingsState.sessionWindowsRemoteSessionLaunchMode = 'hidden';
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

        let model: any = null;
        function Probe() {
            model = useNewSessionScreenModel();
            return null;
        }

        await act(async () => {
            renderer.create(React.createElement(Probe));
            await Promise.resolve();
            await Promise.resolve();
        });

        let chips = model?.simpleProps?.agentInputExtraActionChips ?? [];
        const windowsChip = chips.find((chip: { key: string }) => chip.key === 'new-session-windows-remote-session-launch-mode');
        expect(windowsChip).toBeTruthy();
        expect(windowsChip?.controlId).toBe('windowsRemoteSessionMode');
        expect(windowsChip?.collapsedOptionsPopover).toEqual(expect.objectContaining({
            title: 'machine.windows.remoteSessionModeTitle',
            selectedOptionId: 'console',
        }));

        let chipTree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            chipTree = renderer.create(windowsChip.render({
                chipStyle: () => null,
                iconColor: '#000',
                showLabel: true,
                textStyle: {},
                countTextStyle: {},
                popoverAnchorRef: { current: null },
            }));
            await Promise.resolve();
        });
        expect(JSON.stringify(chipTree!.toJSON())).toContain('windowsRemoteSessionLaunchMode.shortConsole');

        await act(async () => {
            windowsChip.collapsedOptionsPopover?.onSelect('hidden');
            await Promise.resolve();
            await Promise.resolve();
        });

        chips = model?.simpleProps?.agentInputExtraActionChips ?? [];
        const updatedChip = chips.find((chip: { key: string }) => chip.key === 'new-session-windows-remote-session-launch-mode');
        expect(updatedChip).toBeTruthy();
        expect(updatedChip?.collapsedOptionsPopover).toEqual(expect.objectContaining({
            selectedOptionId: 'hidden',
        }));

        await act(async () => {
            chipTree = renderer.create(updatedChip.render({
                chipStyle: () => null,
                iconColor: '#000',
                showLabel: true,
                textStyle: {},
                countTextStyle: {},
                popoverAnchorRef: { current: null },
            }));
            await Promise.resolve();
        });
        expect(JSON.stringify(chipTree!.toJSON())).toContain('windowsRemoteSessionLaunchMode.shortHidden');
    });

});
