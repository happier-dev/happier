import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useNewSessionScreenModel } from './useNewSessionScreenModel';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const pendingFireAndForget = vi.hoisted((): Array<Promise<unknown>> => []);
const applySettingsMock = vi.hoisted(() => vi.fn());
const modalShowMock = vi.hoisted(() => vi.fn(() => 'modal-id'));
const modalAlertMock = vi.hoisted(() => vi.fn());

const enabledAgentIdsState = vi.hoisted(() => ({
    value: ['codex', 'claude'] as Array<'codex' | 'claude' | 'opencode' | 'gemini'>,
}));

const cliAvailabilityState = vi.hoisted(() => ({
    value: {
        timestamp: 1,
        available: { codex: false, claude: true, opencode: null as boolean | null },
    },
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
    codexBackendMode: 'acp',
    installablesPolicyByMachineId: {},
}));

const persistedDraft = vi.hoisted(() => ({
    input: '',
    selectedMachineId: 'machine-1',
    selectedPath: '/repo',
    selectedProfileId: null,
    selectedSecretId: null,
    agentType: 'codex',
    permissionMode: 'default',
    modelMode: 'default',
    acpSessionModeId: 'plan',
    sessionType: 'worktree',
    updatedAt: 123,
}));

vi.mock('react-native', () => ({
    Platform: { OS: 'web', select: (options: any) => options?.web ?? options?.default ?? options?.ios ?? options?.android },
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
                    shadow: { color: '#000' },
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

vi.mock('@/sync/sync', () => ({
    sync: {
        applySettings: applySettingsMock,
        refreshMachinesThrottled: async () => {},
        encryptSecretValue: (v: string) => v,
    },
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
            results: {
                'dep.codex-acp': {
                    ok: true as const,
                    checkedAt: Date.now(),
                    data: {
                        installed: false,
                        installDir: '/tmp',
                        binPath: null,
                        installedVersion: null,
                        distTag: 'latest',
                        lastInstallLogPath: null,
                    },
                },
            },
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
        handleCreateSession: vi.fn(),
    }),
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
    useFeatureEnabled: () => false,
}));

vi.mock('@/components/sessions/new/modules/automationFeatureGate', () => ({
    resolveEffectiveAutomationDraft: ({ draft }: any) => draft,
    shouldShowAutomationActionChips: () => false,
}));

vi.mock('@/components/sessions/new/modules/useAutomationPickerAutoOpen', () => ({
    useAutomationPickerAutoOpen: () => ({ openPickerNow: () => {}, clearOpenPickerParam: () => {} }),
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

vi.mock('@/components/sessions/new/components/EnvironmentVariablesPreviewModal', () => ({
    EnvironmentVariablesPreviewModal: () => null,
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
    useNewSessionPreflightModelsState: () => ({ preflightModels: null, modelOptions: [], probe: { phase: 'idle', refresh: vi.fn() } }),
}));

vi.mock('@/components/sessions/new/hooks/screenModel/useNewSessionPreflightSessionModesState', () => ({
    useNewSessionPreflightSessionModesState: () => ({ acpSessionModeOptions: [], probe: { phase: 'idle', refresh: vi.fn() } }),
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
    useNewSessionWizardProps: () => ({
        layout: {},
        profiles: {},
        agent: {},
        machine: {},
        footer: {},
    }),
}));

describe('useNewSessionScreenModel (installables)', () => {
    beforeEach(() => {
        applySettingsMock.mockClear();
        modalShowMock.mockClear();
        modalAlertMock.mockClear();
        settingsState.codexBackendMode = 'acp';
        settingsState.lastUsedAgent = 'codex';
        persistedDraft.agentType = 'codex';
        enabledAgentIdsState.value = ['codex', 'claude'];
        cliAvailabilityState.value = {
            timestamp: 1,
            available: { codex: false, claude: true, opencode: null },
        };
        pendingFireAndForget.length = 0;
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

        expect(model?.simpleProps?.agentType).toBe('codex');
        expect(machineCapabilitiesInvoke).toHaveBeenCalledWith(
            'machine-1',
            expect.objectContaining({ id: 'dep.codex-acp', method: 'install' }),
            expect.anything(),
        );
    });

    it('cycles to the next detected agent instead of getting stuck on an unavailable intermediate agent', async () => {
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

        await act(async () => {
            model?.simpleProps?.handleAgentClick?.();
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(model?.simpleProps?.agentType).toBe('opencode');
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

    it('opens a picker when many selectable agents exist instead of cycling one-by-one', async () => {
        settingsState.codexBackendMode = 'mcp';
        settingsState.lastUsedAgent = 'claude';
        persistedDraft.agentType = 'claude';
        enabledAgentIdsState.value = ['claude', 'codex', 'opencode', 'gemini'];
        cliAvailabilityState.value = {
            timestamp: 1,
            available: { claude: true, codex: true, opencode: true, gemini: true },
        } as any;
        modalShowMock.mockImplementationOnce(((config: any) => {
            config?.props?.onSelect?.('gemini');
            return 'modal-id';
        }) as any);

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

        await act(async () => {
            model?.simpleProps?.handleAgentClick?.();
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(modalShowMock).toHaveBeenCalledTimes(1);
        expect(model?.simpleProps?.agentType).toBe('gemini');
    });
});
