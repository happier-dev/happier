import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const persistedDraft = vi.hoisted(() => ({
    input: 'hello',
    selectedMachineId: 'machine-2',
    selectedPath: '/repo/custom',
    selectedProfileId: null,
    selectedSecretId: null,
    agentType: 'claude',
    permissionMode: 'yolo',
    modelMode: 'default',
    acpSessionModeId: 'plan',
    sessionType: 'worktree',
    updatedAt: 123,
}));

const settingsState = vi.hoisted(() => ({
    recentMachinePaths: [] as Array<{ machineId: string; path: string }>,
    lastUsedAgent: 'codex',
    lastUsedPermissionMode: 'default',
    useEnhancedSessionWizard: false,
    useProfiles: false,
    sessionDefaultPermissionModeByAgent: {},
    actionsSettingsV1: {},
    experiments: false,
    featureToggles: {},
    dismissedCLIWarnings: {},
    sessionUseTmux: false,
    sessionTmuxByMachineId: {},
    favoriteDirectories: [],
    favoriteMachines: [],
    favoriteProfiles: [],
    profiles: [],
    secrets: [],
    secretBindingsByProfileId: {},
    serverSelectionGroups: [],
    serverSelectionActiveTargetKind: null,
    serverSelectionActiveTargetId: null,
}));

vi.mock('react-native', () => ({
    Platform: { OS: 'web', select: (options: any) => options?.web ?? options?.default ?? options?.ios ?? options?.android },
    View: 'View',
    Pressable: 'Pressable',
    Dimensions: { get: () => ({ width: 900, height: 800 }) },
    InteractionManager: { runAfterInteractions: (fn: any) => fn() },
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
                button: { primary: { background: '#00f', tint: '#fff' } },
                groupped: { sectionTitle: '#999', background: '#fff' },
                divider: '#ddd',
                surface: '#fff',
                surfacePressedOverlay: '#eee',
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
                    button: { primary: { background: '#00f', tint: '#fff' } },
                    groupped: { sectionTitle: '#999', background: '#fff' },
                    divider: '#ddd',
                    surface: '#fff',
                    surfacePressedOverlay: '#eee',
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
    useAllMachines: () => ([
        { id: 'machine-1', metadata: { displayName: 'Machine One', host: 'one', homeDir: '/home/one' } },
        { id: 'machine-2', metadata: { displayName: 'Machine Two', host: 'two', homeDir: '/home/two' } },
    ]),
    storage: {
        getState: () => ({
            settings: settingsState,
            createSessionActionDraft: vi.fn(),
        }),
    },
    useSetting: (key: string) => (settingsState as any)[key],
    useSettingMutable: (key: string) => [(settingsState as any)[key], vi.fn()],
    useSettings: () => settingsState,
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
            model: { defaultMode: 'default', allowedModes: ['default'], supportsFreeform: true },
            resume: { supportsVendorResume: false, runtimeGate: null, experimental: false },
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

vi.mock('@/sync/domains/permissions/permissionModeOptions', () => ({
    normalizePermissionModeForAgentType: (mode: string) => mode,
}));

vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: () => {},
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        applySettings: () => {},
        refreshMachinesThrottled: async () => {},
        encryptSecretValue: (v: string) => v,
    },
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
    useNewSessionDraftAutoPersist: () => {},
}));

vi.mock('@/components/sessions/new/hooks/useCreateNewSession', () => ({
    useCreateNewSession: () => ({
        canCreate: true,
        connectionStatus: 'ok',
        handleCreateSession: vi.fn(),
    }),
}));

vi.mock('@/components/sessions/new/hooks/useNewSessionWizardProps', () => ({
    useNewSessionWizardProps: () => ({}),
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
        allowedTargetServerIds: [],
        targetServerId: null,
        targetServerProfile: null,
        targetServerName: null,
        showServerPickerChip: false,
    }),
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

vi.mock('@/components/sessions/new/modules/useAutomationPickerAutoOpen', () => ({
    useAutomationPickerAutoOpen: () => ({ openPickerNow: () => {}, clearOpenPickerParam: () => {} }),
}));

vi.mock('@/components/sessions/new/modules/useNewSessionConnectedServices', () => ({
    useNewSessionConnectedServices: () => ({ connectedServicesAuthChip: null }),
}));

vi.mock('@/utils/sessions/machineUtils', () => ({
    isMachineOnline: () => true,
}));

vi.mock('@/utils/worktree/createWorktree', () => ({
    createWorktree: async () => ({ success: true, worktreePath: '/tmp', branchName: 'b' }),
}));

vi.mock('@/modal', () => ({
    Modal: { show: () => {}, alert: () => {} },
}));

vi.mock('@/components/sessions/new/components/EnvironmentVariablesPreviewModal', () => ({
    EnvironmentVariablesPreviewModal: () => null,
}));

vi.mock('@/components/sessions/new/hooks/useSecretRequirementFlow', () => ({
    useSecretRequirementFlow: () => ({ openSecretRequirementModal: vi.fn() }),
}));

vi.mock('@/components/sessions/new/modules/profileHelpers', () => ({
    useProfileMap: () => new Map(),
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
        getProfileEnvironmentVariables: () => [],
        isProfileCompatibleWithAgent: () => true,
        isProfileCompatibleWithAnyAgent: () => true,
        AIBackendProfile: actual.AIBackendProfile ?? {},
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

vi.mock('@/components/sessions/agentInput/actionChips/listAgentInputActionChipActionIds', () => ({
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
    getTempData: () => null,
}));

describe('useNewSessionScreenModel (draft hydration)', () => {
    it('hydrates permission, agent, and path from the persisted draft', async () => {
        const { useNewSessionScreenModel } = await import('./useNewSessionScreenModel');

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

        expect(model?.variant).toBe('simple');
        expect(model?.simpleProps?.agentType).toBe('claude');
        expect(model?.simpleProps?.permissionMode).toBe('yolo');
        expect(model?.simpleProps?.sessionType).toBe('worktree');
        expect(model?.simpleProps?.acpSessionModeId).toBe('plan');
        expect(model?.simpleProps?.machineName).toBe('Machine Two');
        expect(model?.simpleProps?.selectedPath).toBe('/repo/custom');
    });
});
