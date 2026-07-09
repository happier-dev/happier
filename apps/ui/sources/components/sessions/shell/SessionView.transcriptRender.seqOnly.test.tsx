import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const previousDev = (globalThis as { __DEV__?: boolean }).__DEV__;
const shouldRenderChatTimelineForSessionMock = vi.fn((_args: any) => true);
const realtimeStatusValue = vi.hoisted(() => ({ current: { status: 'connected' } as any }));
const onSessionVisibleSpy = vi.hoisted(() => vi.fn());
const markSessionLiveTailIntentSpy = vi.hoisted(() => vi.fn());
const fetchPendingMessagesSpy = vi.hoisted(() => vi.fn(async (_sessionId: string) => undefined));
const markSessionViewedSpy = vi.hoisted(() => vi.fn(async () => {}));
const chatHeaderRenderSpy = vi.hoisted(() => vi.fn());
const chatListRenderSpy = vi.hoisted(() => vi.fn());
const appPaneScopeHostRenderSpy = vi.hoisted(() => vi.fn());
const agentContentViewRenderSpy = vi.hoisted(() => vi.fn());
const agentInputRenderSpy = vi.hoisted(() => vi.fn());
const sessionScreenFocusState = vi.hoisted(() => ({ current: true }));
const pendingMessagesHookSpy = vi.hoisted(() => vi.fn());
const transcriptIdsHookSpy = vi.hoisted(() => vi.fn());
const subagentSourceMessagesHookSpy = vi.hoisted(() => vi.fn());
const sessionSubagentsHookSpy = vi.hoisted(() => vi.fn());
const sessionExecutionRunsSupportedHookSpy = vi.hoisted(() => vi.fn());
const selectSyncErrorForServerSpy = vi.hoisted(() => vi.fn((_syncError: unknown, _serverId: string | null) => null));
const approvalArtifactsSpy = vi.hoisted(() => vi.fn());
const routerPathnameState = vi.hoisted(() => ({ current: '/' }));
const themeColors = vi.hoisted(() => ({
    text: '#000',
    textSecondary: '#666',
    textLink: '#00f',
    surface: '#fff',
    surfaceHigh: '#f5f5f5',
    surfaceSelected: '#eef4ff',
    divider: '#ddd',
    border: '#ddd',
    indigo: '#5856D6',
    radio: { active: '#007AFF' },
    accent: {
        blue: '#007AFF',
        green: '#34C759',
        orange: '#FF9500',
        yellow: '#FFCC00',
        red: '#FF3B30',
        indigo: '#5856D6',
        purple: '#AF52DE',
    },
    modal: { border: '#ddd' },
    input: { background: '#f5f5f5' },
    header: { tint: '#000' },
    status: { error: '#f00' },
    shadow: { color: '#000', opacity: 0.2 },
    groupped: { background: '#F5F5F5', chevron: '#C7C7CC', sectionTitle: '#8E8E93' },
}));

let authCredentials: any = { token: 't', secret: 's' };
let sessionState: any = null;
let committedMessagesState: any[] = [];
let committedMessagesLoadedState = true;
let transcriptIdsState: string[] = [];
let transcriptIdsLoadedState = true;
let transcriptIdsSnapshot: { ids: readonly string[]; isLoaded: boolean } = { ids: transcriptIdsState, isLoaded: transcriptIdsLoadedState };
let concurrentSessionListCacheByServerIdState: Record<string, any> = {};
const committedMessagesListeners = new Set<() => void>();
const storageListeners = new Set<() => void>();

function getStorageStateForTest() {
    return {
        sessions: sessionState ? { s1: sessionState } : {},
        machines: {},
        sessionMessages: {},
        sessionPending: {},
        sessionListRenderables: {},
        settings: {
            sessionMessageSendMode: 'agent_queue',
            sessionBusySteerSendPolicy: 'steer_immediately',
        },
        concurrentSessionListCacheByServerId: concurrentSessionListCacheByServerIdState,
    };
}

function getTranscriptIdsSnapshotForTest(): { ids: readonly string[]; isLoaded: boolean } {
    if (transcriptIdsSnapshot.ids !== transcriptIdsState || transcriptIdsSnapshot.isLoaded !== transcriptIdsLoadedState) {
        transcriptIdsSnapshot = { ids: transcriptIdsState, isLoaded: transcriptIdsLoadedState };
    }
    return transcriptIdsSnapshot;
}

function getVisibleReadSeqForTest(): number | null {
    let latestSeq: number | null = null;
    for (const message of committedMessagesState) {
        const seq = typeof message?.seq === 'number' && Number.isFinite(message.seq)
            ? Math.trunc(message.seq)
            : null;
        if (seq === null) continue;
        latestSeq = latestSeq === null ? seq : Math.max(latestSeq, seq);
    }
    return latestSeq;
}

function emitCommittedMessagesChangeForTest(): void {
    for (const listener of committedMessagesListeners) {
        listener();
    }
}

function emitStorageChangeForTest(): void {
    for (const listener of storageListeners) {
        listener();
    }
}

vi.mock('react-native-reanimated', () => ({}));
vi.mock('expo-linear-gradient', () => ({
    LinearGradient: 'LinearGradient',
}));
vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@react-navigation/native', () => ({
    useFocusEffect: () => {},
    useIsFocused: () => sessionScreenFocusState.current,
}));
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ credentials: authCredentials }),
}));

installSessionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Text: 'Text',
            Pressable: 'Pressable',
            ActivityIndicator: 'ActivityIndicator',
            Platform: {
                OS: 'web',
                select: (spec: Record<string, unknown>) =>
                    spec && Object.prototype.hasOwnProperty.call(spec, 'web')
                        ? (spec as any).web
                        : (spec as any).default,
            },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: themeColors,
        });
    },
    text: async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
        translate: (key: string) => key,
    }),
    modal: async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module,
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            pathname: () => routerPathnameState.current,
            router: {
                push: vi.fn(),
                back: vi.fn(),
                replace: vi.fn(),
                setParams: vi.fn(),
            },
        }).module;
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                storage: Object.assign(
                    (selector?: (state: any) => unknown) => {
                        const readSnapshot = () => {
                            const state = getStorageStateForTest();
                            return typeof selector === 'function' ? selector(state) : state;
                        };
                        return React.useSyncExternalStore(
                            (listener) => {
                                storageListeners.add(listener);
                                return () => storageListeners.delete(listener);
                            },
                            readSnapshot,
                            readSnapshot,
                        );
                    },
                    {
                        getState: getStorageStateForTest,
                        subscribe: (listener: () => void) => {
                            storageListeners.add(listener);
                            return () => storageListeners.delete(listener);
                        },
                    },
                ) as any,
	                useSession: () => sessionState,
	                __setSessionForTest: (next: any) => {
                    sessionState = next;
                },
                useIsDataReady: () => true,
                useRealtimeStatus: () => realtimeStatusValue.current,
                useSessionMessages: () => ({ messages: committedMessagesState, isLoaded: committedMessagesLoadedState }),
                useSessionTranscriptIds: (sessionId: string) => {
                    transcriptIdsHookSpy(sessionId);
                    return React.useSyncExternalStore(
                        (listener) => {
                            committedMessagesListeners.add(listener);
                            return () => committedMessagesListeners.delete(listener);
                        },
                        getTranscriptIdsSnapshotForTest,
                        getTranscriptIdsSnapshotForTest,
                    );
                },
                useSessionVisibleReadSeq: () => React.useSyncExternalStore(
                    (listener) => {
                        committedMessagesListeners.add(listener);
                        return () => committedMessagesListeners.delete(listener);
                    },
                    getVisibleReadSeqForTest,
                    getVisibleReadSeqForTest,
                ),
                useSessionPendingMessages: (sessionId: string) => {
                    pendingMessagesHookSpy(sessionId);
                    return { messages: [] };
                },
                useSessionSubagentSourceMessages: (sessionId: string) => {
                    subagentSourceMessagesHookSpy(sessionId);
                    return [];
                },
                useSessionReviewCommentsDrafts: () => [],
                useSessionUsage: () => null,
                useLocalSetting: (key: string) => {
                    if (key === 'acknowledgedCliVersions') return {};
                    if (key === 'uiMultiPanePanelsEnabled') return false;
                    if (key === 'detailsPaneTabsBehavior') return 'preview';
                    if (key === 'rightPaneWidthPx') return 360;
                    if (key === 'rightPaneWidthBasisPx') return 1200;
                    if (key === 'detailsPaneWidthPx') return 520;
                    if (key === 'detailsPaneWidthBasisPx') return 1200;
                    return {};
                },
                useLocalSettingMutable: () => [null, vi.fn()],
                useSetting: () => null,
                useSettings: () => ({ experiments: true, featureToggles: {} }),
                useAutomations: () => [],
                useMachine: () => null,
            } as any,
        });
    },
});

vi.mock('@/components/sessions/transcript/AgentContentView', () => ({
    AgentContentView: (props: any) => {
        agentContentViewRenderSpy(props);
        return React.createElement(
            'AgentContentView',
            props,
            React.createElement(
                React.Fragment,
                null,
                props.placeholder ?? null,
                props.content ?? null,
                props.input ?? null,
            ),
        );
    },
}));
vi.mock('@/components/appShell/panes/AppPaneScopeHost', () => ({
    AppPaneScopeHost: (props: any) => {
        appPaneScopeHostRenderSpy(props);
        return React.createElement('AppPaneScopeHost', props, props.main ?? null);
    },
}));
vi.mock('@/components/sessions/panes/useRegisterSessionPaneDriver', () => ({
    useRegisterSessionPaneDriver: () => 'pane-scope-test',
}));
vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        openRight: vi.fn(),
        setRightTab: vi.fn(),
        scopeState: null,
    }),
}));
vi.mock('@/components/sessions/panes/url/useSessionPaneUrlSync', () => ({
    useSessionPaneUrlSync: () => {},
}));
vi.mock('@/components/sessions/transcript/ChatHeaderView', () => ({
    ChatHeaderView: (props: any) => {
        chatHeaderRenderSpy(props);
        return null;
    },
}));
vi.mock('@/components/sessions/transcript/ChatList', () => ({
    ChatList: (props: any) => {
        chatListRenderSpy(props);
        return React.createElement('ChatList');
    },
}));
vi.mock('@/components/ui/empty/EmptyMessages', () => ({
    EmptyMessages: () => React.createElement('EmptyMessages'),
}));
vi.mock('@/components/sessions/actions/SessionHeaderActionMenu', () => ({
    SessionHeaderActionMenu: () => null,
}));
vi.mock('@/components/voice/surface/VoiceSurface', () => ({
    VoiceSurface: () => null,
}));
vi.mock('@/components/sessions/attachments/AttachmentFilePicker', () => ({
    AttachmentFilePicker: () => null,
}));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));
vi.mock('@/utils/platform/responsive', () => ({
    getDeviceType: () => 'phone',
    useDeviceType: () => 'phone',
    useHeaderHeight: () => 0,
    useIsLandscape: () => false,
    useIsTablet: () => false,
}));
vi.mock('@/components/sessions/model/inactiveSessionUi', () => ({
    getInactiveSessionUiState: () => ({ noticeKind: 'none', inactiveStatusTextKey: null, shouldShowInput: true }),
}));
vi.mock('@/components/sessions/model/resolveSessionMachineReachability', () => ({
    resolveSessionMachineReachability: () => true,
}));
vi.mock('@/components/sessions/model/useSessionMachineReachability', () => ({
    useSessionMachineReachability: () => ({ machineReachable: true, machineOnline: true }),
    useSessionReachableMachineTarget: () => null,
}));
vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'server-1' }),
    subscribeActiveServer: () => () => {},
}));
vi.mock('@/sync/runtime/connectivity/syncErrorScope', () => ({
    selectSyncErrorForServer: (syncError: unknown, serverId: string | null) => selectSyncErrorForServerSpy(syncError, serverId),
}));
vi.mock('@/voice/session/voiceSession', () => ({
    useVoiceSessionSnapshot: () => ({ status: 'disconnected' }),
    voiceSessionManager: {},
}));
vi.mock('@/sync/sync', () => ({
    sync: {
        markSessionViewed: markSessionViewedSpy,
        fetchPendingMessages: fetchPendingMessagesSpy,
        publishSessionPermissionModeToMetadata: async () => {},
        publishSessionAcpSessionModeOverrideToMetadata: async () => {},
        publishSessionAcpConfigOptionOverrideToMetadata: async () => {},
        publishSessionModelOverrideToMetadata: async () => {},
        refreshSessions: async () => {},
        onSessionVisible: onSessionVisibleSpy,
        markSessionLiveTailIntent: markSessionLiveTailIntentSpy,
        sendMessage: async () => {},
        enqueuePendingMessage: async () => {},
        submitMessage: async () => {},
        encryption: {
            getMachineEncryption: () => null,
        },
    },
}));
vi.mock('@/sync/ops', async (importOriginal) => {
    const { createSyncOpsModuleMock } = await import('@/dev/testkit/mocks/syncOps');
    return createSyncOpsModuleMock({
        importOriginal,
        overrides: {
            continueSessionWithReplay: vi.fn(),
            sessionAbort: vi.fn(),
            resumeSession: vi.fn(),
            sessionAttachmentsUploadFile: vi.fn(),
            sessionSwitch: vi.fn(),
        },
    });
});
vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
    createDefaultActionExecutor: () => ({ execute: vi.fn() }),
}));
vi.mock('@/components/sessions/agentInput', () => ({
    AgentInput: (props: any) => {
        agentInputRenderSpy(props);
        return React.createElement('AgentInput', props);
    },
}));
vi.mock('@/utils/system/versionUtils', () => ({
    isVersionSupported: () => true,
    MINIMUM_CLI_VERSION: '0.0.0',
}));
vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['codex'],
    DEFAULT_AGENT_ID: 'codex',
    buildResumeSessionExtrasFromUiState: () => null,
    getAgentCore: () => ({
        displayNameKey: 'agents.codex',
        cli: { spawnAgent: 'codex' },
        model: { defaultMode: 'default' },
        resume: { vendorResumeIdField: null },
        uiConnectedService: { serviceId: null, label: 'Codex', connectRoute: null },
    }),
    getAgentResumeExperimentsFromSettings: () => null,
    getNewSessionRelevantInstallableDepKeys: () => [],
    isAgentId: (value: unknown) => value === 'codex',
    resolveAgentIdFromFlavor: () => 'codex',
}));
vi.mock('@/agents/hooks/useResumeCapabilityOptions', () => ({
    useResumeCapabilityOptions: () => ({ resumeCapabilityOptions: {} }),
}));
vi.mock('@/agents/runtime/resumeCapabilities', () => ({
    canResumeSessionWithOptions: () => true,
    canContinueSessionWithFreshSpawn: () => false,
    canResumeOrContinueSessionWithOptions: () => true,
    getAgentVendorResumeId: () => '',
}));
vi.mock('@/hooks/server/useMachineCapabilitiesCache', () => ({
    prefetchMachineCapabilities: async () => {},
    getMachineCapabilitiesSnapshot: () => null,
    useMachineCapabilitiesCache: () => ({ state: { status: 'idle' } }),
}));
vi.mock('@/utils/sessions/machineUtils', () => ({
    isMachineOnline: () => true,
}));
vi.mock('@/track', () => ({
    tracking: { track: vi.fn() },
    trackMessageSent: vi.fn(),
}));
vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => 'uuid',
}));
vi.mock('@/hooks/server/useAutomationsSupport', () => ({
    useAutomationsSupport: () => ({ enabled: false }),
}));
vi.mock('@/hooks/server/useSessionExecutionRunsSupported', () => ({
    useSessionExecutionRunsSupported: (sessionId: string) => {
        sessionExecutionRunsSupportedHookSpy(sessionId);
        return false;
    },
}));
vi.mock('@/hooks/session/useSessionSubagents', () => ({
    useSessionSubagents: (input: unknown) => {
        sessionSubagentsHookSpy(input);
        return { subagents: [], participantTargets: [], sidechainIds: [] };
    },
}));
vi.mock('@/sync/domains/artifacts/approvalArtifacts', () => ({
    listOpenApprovalArtifactsForSession: (...args: unknown[]) => {
        approvalArtifactsSpy(...args);
        return [];
    },
}));
vi.mock('@/scm/scmStatusSync', () => ({
    scmStatusSync: { run: async () => {}, invalidateFromAutoRefresh: () => {} },
}));
vi.mock('@/sync/ops/actions/sessionActionExecutor', () => ({
    createSessionActionExecutor: () => ({ execute: vi.fn() }),
}));
vi.mock('@/sync/domains/input/slashCommands/resolveSessionComposerSend', () => ({
    resolveSessionComposerSend: (args: { input: string }) => ({ kind: 'send', text: args.input }),
}));
vi.mock('@/sync/domains/permissions/permissionModeApply', () => ({
    applyPermissionModeSelection: async () => {},
}));
vi.mock('@/sync/domains/sessionControl/sessionModeControl', () => ({
    supportsSessionModeOverrides: () => false,
}));
vi.mock('@/sync/domains/session/control/localControlSwitch', () => ({
    shouldRenderChatTimelineForSession: (args: any) => shouldRenderChatTimelineForSessionMock(args),
    shouldRequestRemoteControl: () => false,
    shouldRequestRemoteControlAfterPendingEnqueue: () => false,
}));
vi.mock('@/sync/runtime/time', () => ({
    nowServerMs: () => 0,
}));
vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (promise: any) => promise,
}));

describe('SessionView (transcript rendering for seq-only sessions)', () => {
    const AppPaneProviderWrapper = ({ children }: { children?: React.ReactNode }) => (
        <AppPaneProvider>{children ?? null}</AppPaneProvider>
    );

    async function renderSessionView(props?: Partial<React.ComponentProps<(typeof import('./SessionView'))['SessionView']>>) {
        const { SessionView } = await import('./SessionView');
        return renderScreen(
            <SessionView id="s1" {...props} />,
            {
                wrapper: AppPaneProviderWrapper,
            },
        );
    }

    beforeEach(() => {
        (globalThis as { __DEV__?: boolean }).__DEV__ = false;
        authCredentials = { token: 't', secret: 's' };
        realtimeStatusValue.current = { status: 'connected' };
        sessionState = {
            id: 's1',
            seq: 25,
            updatedAt: 100,
            presence: 'online',
            active: true,
            agentStateVersion: 1,
            accessLevel: 'edit',
            metadata: { machineId: 'm1', flavor: 'codex', version: '0.0.0', path: '/tmp', homeDir: '/tmp' },
            agentState: {},
        };
        committedMessagesState = [];
        committedMessagesLoadedState = true;
        transcriptIdsState = [];
        transcriptIdsLoadedState = true;
        concurrentSessionListCacheByServerIdState = {};
        committedMessagesListeners.clear();
        storageListeners.clear();
        shouldRenderChatTimelineForSessionMock.mockClear();
        onSessionVisibleSpy.mockClear();
        markSessionLiveTailIntentSpy.mockClear();
        markSessionViewedSpy.mockClear();
        fetchPendingMessagesSpy.mockClear();
        chatHeaderRenderSpy.mockClear();
        chatListRenderSpy.mockClear();
        agentContentViewRenderSpy.mockClear();
        appPaneScopeHostRenderSpy.mockClear();
        agentInputRenderSpy.mockClear();
        pendingMessagesHookSpy.mockClear();
        transcriptIdsHookSpy.mockClear();
        subagentSourceMessagesHookSpy.mockClear();
        sessionSubagentsHookSpy.mockClear();
        sessionExecutionRunsSupportedHookSpy.mockClear();
        selectSyncErrorForServerSpy.mockClear();
        approvalArtifactsSpy.mockClear();
        sessionScreenFocusState.current = true;
        routerPathnameState.current = '/';
    });

    afterEach(() => {
        syncPerformanceTelemetry.configure({ enabled: false });
        syncPerformanceTelemetry.reset();
        standardCleanup();
        vi.clearAllMocks();
        (globalThis as { __DEV__?: boolean }).__DEV__ = previousDev;
    });

    it('renders ChatList when session.seq > 0 even if visible committed messages are empty', async () => {
        const screen = await renderSessionView();

        expect(shouldRenderChatTimelineForSessionMock).toHaveBeenCalledWith(
            expect.objectContaining({
                committedMessagesCount: 0,
                pendingMessagesCount: 0,
                forceRenderFooter: true,
            }),
        );
        expect(agentContentViewRenderSpy.mock.calls.at(-1)?.[0]?.placeholder).toBeNull();

        await screen.unmount();
    });

    it('renders ChatList immediately for an already-loaded seq-only transcript', async () => {
        const screen = await renderSessionView();

        expect(screen.findAllByType('ChatList')).toHaveLength(1);

        await screen.unmount();
    });

    it('passes cached route hydration pending state to the transcript instead of remounting as blank content', async () => {
        const screen = await renderSessionView({
            routeHydrationState: { kind: 'loading', sessionId: 's1', reason: 'store-miss' },
        });

        expect(chatListRenderSpy).toHaveBeenCalled();
        expect(chatListRenderSpy.mock.calls.at(-1)?.[0]).toMatchObject({
            routeHydrationPending: true,
        });

        await screen.unmount();
    });

    it('renders ChatList immediately for an unhydrated seq-only transcript that still has transcript scope', async () => {
        committedMessagesLoadedState = false;
        transcriptIdsLoadedState = false;

        const screen = await renderSessionView();

        expect(shouldRenderChatTimelineForSessionMock).toHaveBeenCalledWith(
            expect.objectContaining({
                committedMessagesCount: 0,
                pendingMessagesCount: 0,
                forceRenderFooter: true,
            }),
        );
        expect(screen.findAllByType('ChatList')).toHaveLength(1);

        await screen.unmount();
    });

    it('renders ChatList immediately from cached committed messages even before transcript ids settle', async () => {
        sessionState.seq = 1;
        committedMessagesState = [{
            id: 'm-1',
            kind: 'agent-text',
            role: 'agent',
            createdAt: 1,
            content: [],
        }];
        committedMessagesLoadedState = true;
        transcriptIdsState = [];
        transcriptIdsLoadedState = false;

        const screen = await renderSessionView();

        expect(screen.findAllByType('ChatList')).toHaveLength(1);

        await screen.unmount();
    });

    it('keeps ChatList deferred while transcript data is still loading without cached transcript state', async () => {
        vi.useFakeTimers();
        try {
            sessionState.seq = 0;
            committedMessagesState = [];
            committedMessagesLoadedState = false;
            transcriptIdsState = [];
            transcriptIdsLoadedState = false;

            const screen = await renderSessionView();

            expect(screen.findAllByType('ChatList')).toHaveLength(0);
            expect(screen.tree.root.findAllByProps({ accessibilityRole: 'progressbar' })).toHaveLength(1);

            await act(async () => {
                await vi.advanceTimersByTimeAsync(20);
            });

            expect(screen.findAllByType('ChatList')).toHaveLength(0);
            expect(screen.tree.root.findAllByProps({ accessibilityRole: 'progressbar' })).toHaveLength(1);

            await screen.unmount();
        } finally {
            vi.useRealTimers();
        }
    });

    it('forces transcript render for forked sessions even when child has no messages', async () => {
        sessionState.seq = 0;
        sessionState.metadata.forkV1 = {
            v: 1,
            parentSessionId: 'parent-1',
            parentCutoffSeqInclusive: 9,
        };

        const screen = await renderSessionView();

        expect(shouldRenderChatTimelineForSessionMock).toHaveBeenCalledWith(
            expect.objectContaining({
                committedMessagesCount: 0,
                pendingMessagesCount: 0,
                forceRenderFooter: true,
            }),
        );

        await screen.unmount();
    });

    it('does not re-run onSessionVisible when realtimeStatus changes', async () => {
        const screen = await renderSessionView();
        const { SessionView } = await import('./SessionView');

        expect(onSessionVisibleSpy).toHaveBeenCalledTimes(1);

        realtimeStatusValue.current = { status: 'disconnected' };
        await screen.update(<SessionView id="s1" />);

        expect(onSessionVisibleSpy).toHaveBeenCalledTimes(1);

        await screen.unmount();
    });

    it('does not mark a retained hidden split leaf as visible until that surface becomes visible again', async () => {
        const { SessionView } = await import('./SessionView');

        const screen = await renderScreen(
            <SessionView
                id="s1"
                surfaceFocusedOverride={false}
                surfaceVisibleOverride={false}
                routeAnchorOverride={false}
            />,
            {
                wrapper: AppPaneProviderWrapper,
            },
        );

        expect(onSessionVisibleSpy).not.toHaveBeenCalled();

        await screen.update(
            <SessionView
                id="s1"
                surfaceFocusedOverride={true}
                surfaceVisibleOverride={true}
                routeAnchorOverride={false}
            />,
        );

        expect(onSessionVisibleSpy).toHaveBeenCalledTimes(1);

        await screen.unmount();
    });

    it('marks a visible route-anchor surface as visible even while navigation focus is false', async () => {
        const { SessionView } = await import('./SessionView');

        const screen = await renderScreen(
            <SessionView
                id="s1"
                surfaceFocusedOverride={false}
                surfaceVisibleOverride={true}
                routeAnchorOverride={true}
            />,
            {
                wrapper: AppPaneProviderWrapper,
            },
        );

        expect(onSessionVisibleSpy).toHaveBeenCalledTimes(1);

        await screen.unmount();
    });

    it('does not mount session chrome or transcript body when retained behind another route', async () => {
        sessionScreenFocusState.current = false;

        const screen = await renderSessionView();

        expect(chatHeaderRenderSpy).not.toHaveBeenCalled();
        expect(chatListRenderSpy).not.toHaveBeenCalled();
        expect(agentInputRenderSpy).not.toHaveBeenCalled();
        expect(onSessionVisibleSpy).not.toHaveBeenCalled();
        expect(pendingMessagesHookSpy).not.toHaveBeenCalled();
        expect(transcriptIdsHookSpy).not.toHaveBeenCalled();
        expect(subagentSourceMessagesHookSpy).not.toHaveBeenCalled();
        expect(sessionSubagentsHookSpy).not.toHaveBeenCalled();
        expect(sessionExecutionRunsSupportedHookSpy).not.toHaveBeenCalled();
        expect(approvalArtifactsSpy).not.toHaveBeenCalled();

        await screen.unmount();
    });

    it('keeps an owned session route painted while the navigation focus is transitioning', async () => {
        sessionScreenFocusState.current = false;
        routerPathnameState.current = '/session/s1/details';

        const screen = await renderSessionView();

        expect(chatHeaderRenderSpy).toHaveBeenCalled();
        expect(chatListRenderSpy).toHaveBeenCalled();

        await screen.unmount();
    });

    it('does not render a restore prompt for encrypted sessions when credentials include dataKey material', async () => {
        authCredentials = { token: 't', encryption: { publicKey: 'pk', machineKey: 'mk' } };

        const screen = await renderSessionView();

        expect(screen.findAllByTestId('session-encrypted-locked').length).toBe(0);
        expect(screen.findAllByTestId('session-encrypted-locked-restore').length).toBe(0);

        await screen.unmount();
    });

    it('records open-to-transcript telemetry when the transcript is usable and telemetry is enabled', async () => {
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        const screen = await renderSessionView();
        await flushHookEffects({ cycles: 1, turns: 1 });

        const openEvent = syncPerformanceTelemetry
            .snapshot()
            .events.find((event) => event.name === 'ui.sessions.openToTranscript');

        expect(openEvent).toBeTruthy();
        expect(openEvent?.fields).toMatchObject({
            transcript: 1,
            empty: 0,
            committedMessages: 0,
            pendingMessages: 0,
        });
        expect(Object.values(openEvent?.fields ?? {}).every((value) => typeof value === 'number')).toBe(true);

        await screen.unmount();
    });

    it('does not record open-to-transcript telemetry when telemetry is disabled', async () => {
        syncPerformanceTelemetry.configure({ enabled: false });
        syncPerformanceTelemetry.reset();

        const screen = await renderSessionView();
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(syncPerformanceTelemetry.snapshot().events).toEqual([]);

        await screen.unmount();
    });

    it('does not mark a route-rejected scoped session as viewed', async () => {
        vi.useFakeTimers();
        try {
            committedMessagesState = [{
                id: 'm1',
                kind: 'agent-text',
                localId: null,
                createdAt: 1,
                seq: 25,
                text: 'hello',
            }];
            transcriptIdsState = ['m1'];
            sessionState = {
                ...sessionState,
                serverId: 'server-b',
            };
            concurrentSessionListCacheByServerIdState = {
                'server-b': {
                    serverName: 'Server B',
                    sessions: {
                        s1: { id: 's1' },
                    },
                },
            };

            const screen = await renderSessionView({ routeServerId: 'server-a' });

            await act(async () => {
                await vi.runOnlyPendingTimersAsync();
                await Promise.resolve();
            });

            expect(screen.findAllByTestId('session-root-unavailable')).toHaveLength(1);
            expect(onSessionVisibleSpy).not.toHaveBeenCalled();
            expect(markSessionViewedSpy).not.toHaveBeenCalled();
            expect(sessionExecutionRunsSupportedHookSpy).not.toHaveBeenCalledWith('s1');
            expect(sessionSubagentsHookSpy).not.toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1' }));
            const scopedServerIds = selectSyncErrorForServerSpy.mock.calls.map((call) => call[1]);
            expect(scopedServerIds).toContain('server-a');
            expect(scopedServerIds).not.toContain('server-b');

            await screen.unmount();
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not crash when the session is missing (e.g. deep link before hydration)', async () => {
        const storageModule = await import('@/sync/domains/state/storage');
        (storageModule as any).__setSessionForTest(null);
        expect((storageModule as any).useSession()).toBeNull();

        let error: unknown = null;
        try {
            await renderSessionView();
        } catch (err) {
            error = err;
        } finally {
            (storageModule as any).__setSessionForTest({
                id: 's1',
                seq: 25,
                updatedAt: 100,
                presence: 'online',
                active: true,
                accessLevel: 'edit',
                metadata: { machineId: 'm1', flavor: 'codex', version: '0.0.0', path: '/tmp', homeDir: '/tmp' },
                agentState: {},
            });
        }

        expect(error).toBeNull();
    });

    it('keeps the transcript host stable for session timestamp-only updates', async () => {
        const screen = await renderSessionView();
        const { SessionView } = await import('./SessionView');

        await flushHookEffects({ cycles: 2, turns: 1 });
        chatListRenderSpy.mockClear();

        sessionState = {
            ...sessionState,
            updatedAt: 200,
            activeAt: 200,
            thinkingAt: 200,
        };
        await screen.update(<SessionView id="s1" />);

        expect(chatListRenderSpy).not.toHaveBeenCalled();

        await screen.unmount();
    });

    it('keeps the transcript host stable for read-cursor-only updates', async () => {
        sessionState = {
            ...sessionState,
            lastViewedSessionSeq: 25,
            metadata: {
                ...sessionState.metadata,
                readStateV1: {
                    v: 1,
                    sessionSeq: 25,
                    pendingActivityAt: 0,
                    updatedAt: 100,
                },
            },
        };

        const screen = await renderSessionView();
        const { SessionView } = await import('./SessionView');

        await flushHookEffects({ cycles: 2, turns: 1 });
        chatListRenderSpy.mockClear();

        sessionState = {
            ...sessionState,
            lastViewedSessionSeq: 26,
            metadata: {
                ...sessionState.metadata,
                readStateV1: {
                    v: 1,
                    sessionSeq: 26,
                    pendingActivityAt: 0,
                    updatedAt: 200,
                },
            },
        };
        await screen.update(<SessionView id="s1" />);

        expect(chatListRenderSpy).not.toHaveBeenCalled();

        await screen.unmount();
    });

    it('keeps the session shell stable for committed-message-id-only updates while refreshing the transcript', async () => {
        const screen = await renderSessionView();

        await flushHookEffects({ cycles: 5, turns: 5 });
        appPaneScopeHostRenderSpy.mockClear();
        chatHeaderRenderSpy.mockClear();
        agentInputRenderSpy.mockClear();
        chatListRenderSpy.mockClear();

        await act(async () => {
            committedMessagesState = [{ id: 'm1', seq: 26, role: 'assistant', content: 'hello' }];
            transcriptIdsState = ['m1'];
            emitCommittedMessagesChangeForTest();
            await Promise.resolve();
        });
        await flushHookEffects({ cycles: 2, turns: 1 });

        expect(appPaneScopeHostRenderSpy).not.toHaveBeenCalled();
        expect(chatHeaderRenderSpy).not.toHaveBeenCalled();
        expect(agentInputRenderSpy).not.toHaveBeenCalled();
        expect(chatListRenderSpy).toHaveBeenCalled();

        await screen.unmount();
    });

    it('keeps the session shell and composer stable for seq-only streaming updates', async () => {
        const screen = await renderSessionView();

        await flushHookEffects({ cycles: 5, turns: 5 });
        appPaneScopeHostRenderSpy.mockClear();
        chatHeaderRenderSpy.mockClear();
        agentInputRenderSpy.mockClear();
        chatListRenderSpy.mockClear();

        await act(async () => {
            sessionState = {
                ...sessionState,
                seq: 26,
                updatedAt: 200,
                activeAt: 200,
            };
            emitStorageChangeForTest();
            await Promise.resolve();
        });
        await flushHookEffects({ cycles: 2, turns: 1 });

        expect(appPaneScopeHostRenderSpy).not.toHaveBeenCalled();
        expect(chatHeaderRenderSpy).not.toHaveBeenCalled();
        expect(agentInputRenderSpy).not.toHaveBeenCalled();
        expect(chatListRenderSpy).not.toHaveBeenCalled();

        await screen.unmount();
    });

    it('keeps the transcript host stable for pending-version-only updates while still refreshing pending messages', async () => {
        vi.useFakeTimers();
        try {
            const screen = await renderSessionView();

            await flushHookEffects({ cycles: 2, turns: 1 });
            await act(async () => {
                await vi.runOnlyPendingTimersAsync();
            });
            chatListRenderSpy.mockClear();
            shouldRenderChatTimelineForSessionMock.mockClear();
            fetchPendingMessagesSpy.mockClear();

            await act(async () => {
                sessionState = {
                    ...sessionState,
                    pendingVersion: 2,
                    pendingCount: 1,
                };
                emitStorageChangeForTest();
                await Promise.resolve();
            });
            await flushHookEffects({ cycles: 5, turns: 5 });
            await act(async () => {
                await vi.runOnlyPendingTimersAsync();
            });

            expect(chatListRenderSpy).not.toHaveBeenCalled();
            expect(shouldRenderChatTimelineForSessionMock).not.toHaveBeenCalled();
            expect(fetchPendingMessagesSpy).toHaveBeenCalledWith('s1');

            await screen.unmount();
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps the transcript host stable for metadata freshness-only updates', async () => {
        sessionState = {
            ...sessionState,
            metadata: {
                ...sessionState.metadata,
                summary: { text: 'Summary', updatedAt: 100 },
                sessionModesV1: {
                    v: 1,
                    provider: 'codex',
                    updatedAt: 100,
                    currentModeId: 'default',
                    availableModes: [{ id: 'default', name: 'Default' }],
                },
                sessionModelsV1: {
                    v: 1,
                    provider: 'codex',
                    updatedAt: 100,
                    currentModelId: 'model-a',
                    availableModels: [{ id: 'model-a', name: 'Model A' }],
                },
            },
        };

        const screen = await renderSessionView();
        const { SessionView } = await import('./SessionView');

        await flushHookEffects({ cycles: 2, turns: 1 });
        chatListRenderSpy.mockClear();

        sessionState = {
            ...sessionState,
            metadataVersion: 2,
            metadata: {
                ...sessionState.metadata,
                summary: { text: 'Summary', updatedAt: 200 },
                sessionModesV1: {
                    ...sessionState.metadata.sessionModesV1,
                    updatedAt: 200,
                },
                sessionModelsV1: {
                    ...sessionState.metadata.sessionModelsV1,
                    updatedAt: 200,
                },
            },
        };
        await screen.update(<SessionView id="s1" />);

        expect(chatListRenderSpy).not.toHaveBeenCalled();

        await screen.unmount();
    });

    it('keeps the session shell stable for visible-read sequence updates while viewing', async () => {
        committedMessagesState = [{
            id: 'm1',
            kind: 'agent-text',
            localId: null,
            createdAt: 1,
            seq: 25,
            text: 'hello',
            isThinking: true,
        }];
        transcriptIdsState = ['m1'];
        const screen = await renderSessionView();

        await flushHookEffects({ cycles: 2, turns: 1 });
        chatHeaderRenderSpy.mockClear();
        chatListRenderSpy.mockClear();
        shouldRenderChatTimelineForSessionMock.mockClear();

        await act(async () => {
            committedMessagesState = [{
                ...committedMessagesState[0],
                seq: 26,
                text: 'hello streaming update',
            }];
            emitCommittedMessagesChangeForTest();
            await Promise.resolve();
        });

        expect(chatHeaderRenderSpy).not.toHaveBeenCalled();
        expect(chatListRenderSpy).not.toHaveBeenCalled();
        expect(shouldRenderChatTimelineForSessionMock).not.toHaveBeenCalled();

        await screen.unmount();
    });

    it('re-arms transcript bottom follow when the user sends a message', async () => {
        const screen = await renderSessionView();

        const initialFollowBottomIntentKey = chatListRenderSpy.mock.calls.at(-1)?.[0]?.followBottomIntentKey;
        let agentInput = screen.tree.root.findByType('AgentInput' as any);
        expect(typeof agentInput.props?.onChangeText).toBe('function');

        await act(async () => {
            agentInput.props.onChangeText('hello from the composer');
        });
        await flushHookEffects({ cycles: 2, turns: 1 });

        agentInput = screen.tree.root.findByType('AgentInput' as any);
        expect(agentInput.props.value).toBe('hello from the composer');
        expect(typeof agentInput.props?.onSend).toBe('function');

        await act(async () => {
            agentInput.props.onSend();
            await Promise.resolve();
            await Promise.resolve();
        });
        await flushHookEffects({ cycles: 5, turns: 5 });

        expect(markSessionLiveTailIntentSpy).toHaveBeenCalledWith('s1');
        const nextFollowBottomIntentKey = chatListRenderSpy.mock.calls.at(-1)?.[0]?.followBottomIntentKey;
        expect(nextFollowBottomIntentKey).not.toBe(initialFollowBottomIntentKey);

        await screen.unmount();
    });

    it('keeps the transcript viewport callback stable across session rerenders', async () => {
        const screen = await renderSessionView();
        const { SessionView } = await import('./SessionView');

        const initialViewportChange = chatListRenderSpy.mock.calls.at(-1)?.[0]?.onViewportChange;
        expect(typeof initialViewportChange).toBe('function');
        chatListRenderSpy.mockClear();

        await screen.update(<SessionView id="s1" jumpToSeq={99} />);

        const nextViewportChange = chatListRenderSpy.mock.calls.at(-1)?.[0]?.onViewportChange;
        expect(nextViewportChange).toBe(initialViewportChange);

        await screen.unmount();
    });
});
