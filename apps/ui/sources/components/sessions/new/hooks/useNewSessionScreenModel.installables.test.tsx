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

const profileCompatibilityState = vi.hoisted(() => ({
    isProfileCompatibleWithAgent: (((_profile: any, _agentId: string) => true) as (profile: any, agentId: string) => boolean),
    isProfileCompatibleWithBackendTarget: (((_profile: any, _target: any) => true) as (profile: any, target: any) => boolean),
    isProfileCompatibleWithAnyAgent: (((_profile: any, _agentIds: readonly string[]) => true) as (profile: any, agentIds: readonly string[]) => boolean),
    getProfileSupportedAgentIds: (((_profile: any) => [] as string[]) as (profile: any) => string[]),
}));

const settingsState = vi.hoisted(() => ({
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
    acpCatalogSettingsV1: {
        v: 2 as const,
        backends: [],
    } as AcpCatalogSettingsV1,
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
    sessionType: 'worktree',
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
    useAllMachines: () => machineState.value,
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
    useFeatureEnabled: (featureId: string) => featureId === 'sessions.direct' ? featureEnabledState.sessionsDirect : false,
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
        settingsDefaults: actual.settingsDefaults,
        isProfileCompatibleWithAnyAgent: (profile: any, agentIds: readonly string[]) =>
            profileCompatibilityState.isProfileCompatibleWithAnyAgent(profile, agentIds),
    };
});

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
        persistedDraft.sessionType = 'worktree';
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
            const geminiOption = config?.props?.options?.find?.((option: { id: string; label: string }) => option?.label === 'agentInput.agent.gemini');
            config?.props?.onSelect?.(geminiOption?.id ?? 'agent:gemini');
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

    it('shows a Windows session-mode chip on Windows machines and cycles inline through the available modes', async () => {
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
                    resolvedPath: 'C:\\\\Program Files\\\\WindowsApps\\\\wt.exe',
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

        let chipTree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            chipTree = renderer.create(windowsChip.render({
                chipStyle: () => null,
                iconColor: '#000',
                showLabel: true,
                textStyle: {},
            }));
            await Promise.resolve();
        });
        expect(JSON.stringify(chipTree!.toJSON())).toContain('windowsRemoteSessionLaunchMode.shortConsole');

        await act(async () => {
            chipTree!.root.findByType('Pressable').props.onPress();
            await Promise.resolve();
            await Promise.resolve();
        });

        chips = model?.simpleProps?.agentInputExtraActionChips ?? [];
        const updatedChip = chips.find((chip: { key: string }) => chip.key === 'new-session-windows-remote-session-launch-mode');
        expect(updatedChip).toBeTruthy();

        await act(async () => {
            chipTree = renderer.create(updatedChip.render({
                chipStyle: () => null,
                iconColor: '#000',
                showLabel: true,
                textStyle: {},
            }));
            await Promise.resolve();
        });
        expect(JSON.stringify(chipTree!.toJSON())).toContain('windowsRemoteSessionLaunchMode.shortHidden');
    });

});
