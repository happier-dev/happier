import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import {
    clearActiveViewingSessionsForServerScopeReset,
    isSessionVisible,
} from '@/sync/domains/session/activeViewingSession';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Makes "this piece of session chrome was torn down and rebuilt" observable, so a spec can assert
 * the surface survived a route change instead of only that it re-rendered.
 */
function useSurfaceMountTracking(surfaceName: string): void {
    React.useEffect(() => {
        surfaceMountSpy(surfaceName);
        return () => {
            surfaceUnmountSpy(surfaceName);
        };
    }, [surfaceName]);
}

const previousDev = (globalThis as { __DEV__?: boolean }).__DEV__;
const shouldRenderChatTimelineForSessionMock = vi.fn((_args: any) => true);
const realtimeStatusValue = vi.hoisted(() => ({ current: { status: 'connected' } as any }));
const onSessionVisibleSpy = vi.hoisted(() => vi.fn());
const markSessionLiveTailIntentSpy = vi.hoisted(() => vi.fn());
const fetchPendingMessagesSpy = vi.hoisted(() => vi.fn(async (_sessionId: string) => undefined));
const chatHeaderRenderSpy = vi.hoisted(() => vi.fn());
const chatListRenderSpy = vi.hoisted(() => vi.fn());
const surfaceMountSpy = vi.hoisted(() => vi.fn());
const surfaceUnmountSpy = vi.hoisted(() => vi.fn());
const appPaneScopeHostRenderSpy = vi.hoisted(() => vi.fn());
const deferredRenderSpy = vi.hoisted(() => vi.fn());
const agentContentViewRenderSpy = vi.hoisted(() => vi.fn());
const agentInputRenderSpy = vi.hoisted(() => vi.fn());
const pendingMessagesHookSpy = vi.hoisted(() => vi.fn());
const subagentSourceMessagesHookSpy = vi.hoisted(() => vi.fn());
const sessionExecutionRunsSupportedHookSpy = vi.hoisted(() => vi.fn());
const selectSyncErrorForServerSpy = vi.hoisted(() => vi.fn((_syncError: unknown, _serverId: string | null) => null));
// Route focus and pathname are reactive in production (React Navigation / expo-router re-render
// their subscribers on a route change). These stores keep that property so a spec can move the
// route mid-test and observe what the mounted tree does, instead of only what a fresh mount does.
const createReactiveRouteState = vi.hoisted(() => <TValue,>(initialValue: TValue) => {
    const listeners = new Set<() => void>();
    const state = {
        current: initialValue,
        read: () => state.current,
        set: (nextValue: TValue) => {
            state.current = nextValue;
            for (const listener of listeners) listener();
        },
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
    return state;
});
const sessionScreenFocusState = vi.hoisted(() => createReactiveRouteState(true));
const routerPathnameState = vi.hoisted(() => createReactiveRouteState('/'));
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
let sessionUsageState: any = null;
const sessionUsageListeners = new Set<() => void>();
const storageListeners = new Set<() => void>();
const subagentSourceMessagesListeners = new Set<() => void>();
const committedMessagesListeners = new Set<() => void>();
let subagentSourceMessagesState: readonly any[] = [];
let committedMessagesState: readonly any[] = [];
let committedMessageIdsState: readonly string[] = [];
let committedMessagesSnapshot: { messages: readonly any[]; isLoaded: boolean } = { messages: [], isLoaded: true };
let committedMessageIdsSnapshot: { ids: readonly string[]; isLoaded: boolean } = { ids: [], isLoaded: true };
let sessionListViewDataByServerIdState: Record<string, any[] | null> = {};

function setCommittedMessagesForTest(messages: readonly any[], ids: readonly string[] = messages.map((message) => message.id)) {
    const idsChanged =
        ids.length !== committedMessageIdsState.length
        || ids.some((id, index) => id !== committedMessageIdsState[index]);
    committedMessagesState = messages;
    if (idsChanged) {
        committedMessageIdsState = ids;
        committedMessageIdsSnapshot = { ids: committedMessageIdsState, isLoaded: true };
    }
    committedMessagesSnapshot = { messages: committedMessagesState, isLoaded: true };
}

function getStorageStateForTest() {
    return {
        sessions: sessionState ? { [sessionState.id]: sessionState } : {},
        settings: {
            sessionMessageSendMode: 'agent_queue',
            sessionBusySteerSendPolicy: 'steerImmediately',
        },
        sessionListViewDataByServerId: sessionListViewDataByServerIdState,
    };
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

function setSessionUsageState(next: any) {
    sessionUsageState = next;
    for (const listener of sessionUsageListeners) {
        listener();
    }
}

function emitStorageChangeForTest() {
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
    useIsFocused: () => React.useSyncExternalStore(
        sessionScreenFocusState.subscribe,
        sessionScreenFocusState.read,
        sessionScreenFocusState.read,
    ),
}));
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ credentials: authCredentials }),
}));

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
    const { createServerProfilesModuleMock } = await import('@/dev/testkit/mocks/serverProfiles');
    return createServerProfilesModuleMock({
        importOriginal,
        overrides: {
            listServerProfiles: () => [{
                id: 'server-profile',
                name: 'Server',
                serverUrl: 'https://server.example.test',
                serverIdentityId: 'server-actual',
                legacyServerIds: ['server-alias'],
                createdAt: 1,
                updatedAt: 1,
                lastUsedAt: 1,
            }],
        },
    });
});

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
            pathname: () => React.useSyncExternalStore(
                routerPathnameState.subscribe,
                routerPathnameState.read,
                routerPathnameState.read,
            ),
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
                    { getState: getStorageStateForTest },
                ) as any,
                useSession: () => sessionState,
                __setSessionForTest: (next: any) => {
                    sessionState = next;
                },
                useIsDataReady: () => true,
                useRealtimeStatus: () => realtimeStatusValue.current,
                useSessionMessages: () => React.useSyncExternalStore(
                    (listener) => {
                        committedMessagesListeners.add(listener);
                        return () => committedMessagesListeners.delete(listener);
                    },
                    () => committedMessagesSnapshot,
                    () => committedMessagesSnapshot,
                ),
                useSessionTranscriptIds: () => React.useSyncExternalStore(
                    (listener) => {
                        committedMessagesListeners.add(listener);
                        return () => committedMessagesListeners.delete(listener);
                    },
                    () => committedMessageIdsSnapshot,
                    () => committedMessageIdsSnapshot,
                ),
                useSessionVisibleReadSeq: () => React.useSyncExternalStore(
                    (listener) => {
                        committedMessagesListeners.add(listener);
                        return () => committedMessagesListeners.delete(listener);
                    },
                    getVisibleReadSeqForTest,
                    getVisibleReadSeqForTest,
                ),
                useSessionPendingMessages: () => {
                    pendingMessagesHookSpy();
                    return { messages: [] };
                },
                useSessionSubagentSourceMessages: () => {
                    subagentSourceMessagesHookSpy();
                    return React.useSyncExternalStore(
                        (listener) => {
                            subagentSourceMessagesListeners.add(listener);
                            return () => subagentSourceMessagesListeners.delete(listener);
                        },
                        () => subagentSourceMessagesState,
                        () => subagentSourceMessagesState,
                    );
                },
                useSessionReviewCommentsDrafts: () => [],
                useSessionUsage: () => React.useSyncExternalStore(
                    (listener) => {
                        sessionUsageListeners.add(listener);
                        return () => sessionUsageListeners.delete(listener);
                    },
                    () => sessionUsageState,
                    () => sessionUsageState,
                ),
                useActiveServerAccountScope: () => ({ serverId: 'server-1', accountId: 'account-1' }),
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
                useSessionAutomationsEnabledCount: () => 0,
                useOpenApprovalArtifactsForSession: () => [],
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
    ChatHeaderView: React.memo((props: any) => {
        chatHeaderRenderSpy(props);
        useSurfaceMountTracking('ChatHeaderView');
        return null;
    }),
}));
vi.mock('@/components/sessions/transcript/ChatList', () => ({
    ChatList: (props: any) => {
        chatListRenderSpy(props);
        useSurfaceMountTracking('ChatList');
        return React.createElement('ChatList');
    },
}));
vi.mock('@/components/ui/empty/EmptyMessages', () => ({
    EmptyMessages: () => React.createElement('EmptyMessages'),
}));
vi.mock('@/components/ui/forms/Deferred', () => ({
    Deferred: (props: Readonly<{ children?: React.ReactNode; enabled?: boolean; fallback?: React.ReactNode }>) => {
        deferredRenderSpy(props);
        return React.createElement(React.Fragment, null, props.children);
    },
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
vi.mock('@/hooks/server/useSessionExecutionRunsSupported', () => ({
    useSessionExecutionRunsSupported: () => {
        sessionExecutionRunsSupportedHookSpy();
        return false;
    },
}));
vi.mock('@/utils/platform/responsive', () => ({
    getDeviceType: () => 'phone',
    useDeviceType: () => 'phone',
    useHeaderHeight: () => 0,
    useIsLandscape: () => false,
    useIsTablet: () => false,
}));
vi.mock('@/hooks/session/useDraft', () => ({
    useDraft: (_sessionId: string, value: string, onChange: (next: string) => void) => {
        const latestValue = React.useRef(value);
        latestValue.current = value;

        const setDraftValue = React.useCallback((nextValueOrUpdater: string | ((currentValue: string) => string)) => {
            const nextValue = typeof nextValueOrUpdater === 'function'
                ? nextValueOrUpdater(latestValue.current)
                : nextValueOrUpdater;
            latestValue.current = nextValue;
            onChange(nextValue);
        }, [onChange]);

        return {
            clearDraft: () => setDraftValue(''),
            setDraftValue,
            clearDraftForSessionIfCurrentValueMatches: (snapshot: Readonly<{ text: string }>) => {
                if (latestValue.current !== snapshot.text) return false;
                setDraftValue('');
                return true;
            },
            restoreDraftForSessionIfCurrentValueMatches: (
                snapshot: Readonly<{ text: string }>,
                expectedCurrentValue: string,
            ) => {
                if (latestValue.current !== expectedCurrentValue) return false;
                setDraftValue(snapshot.text);
                return true;
            },
            restoreDraft: setDraftValue,
            restoreComposerSnapshot: (snapshot: Readonly<{ text: string }>) => setDraftValue(snapshot.text),
        };
    },
}));
vi.mock('@/components/sessions/model/inactiveSessionUi', () => ({
    getInactiveSessionUiState: () => ({ noticeKind: 'none', inactiveStatusTextKey: null, shouldShowInput: true }),
}));
vi.mock('@/components/sessions/model/resolveSessionMachineReachability', () => ({
    resolveSessionMachineReachability: () => true,
}));
vi.mock('@/components/sessions/model/useSessionMachineReachability', () => ({
    useSessionMachineReachability: () => ({ machineReachable: true, machineOnline: true }),
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
        markSessionViewed: async () => {},
        fetchPendingMessages: fetchPendingMessagesSpy,
        publishSessionPermissionModeToMetadata: async () => {},
        publishSessionAcpSessionModeOverrideToMetadata: async () => {},
        publishSessionAcpConfigOptionOverrideToMetadata: async () => {},
        publishSessionModelOverrideToMetadata: async () => {},
        refreshSessions: async () => {},
        refreshSessionForSubmit: async (sessionId: string) => sessionState?.id === sessionId ? sessionState : null,
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
    // Match production AgentInput's memo boundary; this spec asserts stability at that boundary.
    AgentInput: React.memo((props: any) => {
        agentInputRenderSpy(props);
        useSurfaceMountTracking('AgentInput');
        return null;
    }),
}));
vi.mock('@/utils/system/versionUtils', () => ({
    isVersionSupported: () => true,
    MINIMUM_CLI_VERSION: '0.0.0',
}));
vi.mock('@/agents/catalog/catalog', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        getAgentCore: () => ({
            displayNameKey: 'agents.codex',
            cli: { spawnAgent: 'codex' },
            model: { defaultMode: 'default' },
            resume: { vendorResumeIdField: null },
            uiConnectedService: { serviceId: null, label: 'Codex', connectRoute: null },
        }),
        resolveAgentIdFromFlavor: () => 'codex',
        DEFAULT_AGENT_ID: 'codex',
    };
});
vi.mock('@/agents/hooks/useResumeCapabilityOptions', () => ({
    useResumeCapabilityOptions: () => ({ resumeCapabilityOptions: {} }),
}));
vi.mock('@/agents/runtime/resumeCapabilities', () => ({
    canResumeSessionWithOptions: () => true,
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
vi.mock('@/scm/scmStatusSync', () => ({
    scmStatusSync: { run: async () => {}, invalidateFromAutoRefresh: () => {} },
}));
vi.mock('@/sync/ops/actions/sessionActionExecutor', () => ({
    createSessionActionExecutor: () => ({ execute: vi.fn() }),
}));
vi.mock('@/sync/domains/input/slashCommands/resolveSessionComposerSend', () => ({
    resolveSessionComposerSend: ({ input }: { input: string }) => ({ kind: 'send', text: input }),
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

    async function renderSessionView(props: Partial<React.ComponentProps<typeof import('./SessionView').SessionView>> = {}) {
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
            accessLevel: 'edit',
            agentStateVersion: 1,
            metadata: { machineId: 'm1', flavor: 'codex', version: '0.0.0', path: '/tmp', homeDir: '/tmp' },
            agentState: {},
        };
        setSessionUsageState(null);
        shouldRenderChatTimelineForSessionMock.mockClear();
        onSessionVisibleSpy.mockClear();
        markSessionLiveTailIntentSpy.mockClear();
        chatHeaderRenderSpy.mockClear();
        chatListRenderSpy.mockClear();
        surfaceMountSpy.mockClear();
        surfaceUnmountSpy.mockClear();
        agentContentViewRenderSpy.mockClear();
        appPaneScopeHostRenderSpy.mockClear();
        deferredRenderSpy.mockClear();
        agentInputRenderSpy.mockClear();
        fetchPendingMessagesSpy.mockClear();
        pendingMessagesHookSpy.mockClear();
        subagentSourceMessagesHookSpy.mockClear();
        sessionExecutionRunsSupportedHookSpy.mockClear();
        selectSyncErrorForServerSpy.mockClear();
        subagentSourceMessagesState = [];
        setCommittedMessagesForTest([]);
        sessionListViewDataByServerIdState = {};
        clearActiveViewingSessionsForServerScopeReset();
        subagentSourceMessagesListeners.clear();
        committedMessagesListeners.clear();
        storageListeners.clear();
        sessionScreenFocusState.current = true;
        routerPathnameState.current = '/';
    });

    afterEach(() => {
        syncPerformanceTelemetry.configure({ enabled: false });
        syncPerformanceTelemetry.reset();
        standardCleanup();
        clearActiveViewingSessionsForServerScopeReset();
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
        expect(deferredRenderSpy.mock.calls.at(-1)?.[0]).toMatchObject({
            enabled: true,
        });
        expect(agentContentViewRenderSpy.mock.calls.at(-1)?.[0]?.placeholder).toBeNull();

        await screen.unmount();
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

    it('synchronously re-runs transcript activation after a server-scope reset while warm route switches remain the control', async () => {
        const screen = await renderSessionView();
        const { SessionView } = await import('./SessionView');

        expect(onSessionVisibleSpy).toHaveBeenLastCalledWith('s1');
        expect(onSessionVisibleSpy).toHaveBeenCalledTimes(1);

        sessionState = { ...sessionState, id: 's2' };
        await screen.update(<SessionView id="s2" />);
        expect(onSessionVisibleSpy).toHaveBeenLastCalledWith('s2');

        sessionState = { ...sessionState, id: 's1' };
        await screen.update(<SessionView id="s1" />);
        expect(onSessionVisibleSpy).toHaveBeenLastCalledWith('s1');
        expect(onSessionVisibleSpy).toHaveBeenCalledTimes(3);

        await act(async () => {
            clearActiveViewingSessionsForServerScopeReset();
        });

        // No timer or later socket/update turn: activation must be reacquired in the
        // reset commit so onSessionVisible can restore viewport intent before paint.
        expect(onSessionVisibleSpy).toHaveBeenLastCalledWith('s1');
        expect(onSessionVisibleSpy).toHaveBeenCalledTimes(4);

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

    it('keeps cached route hydration content mounted without marking the transcript pending', async () => {
        const screen = await renderSessionView({
            routeHydrationState: { kind: 'loading', sessionId: 's1', reason: 'store-miss' },
        });

        expect(chatListRenderSpy).toHaveBeenCalled();
        expect(chatListRenderSpy.mock.calls.at(-1)?.[0]).toMatchObject({
            routeHydrationPending: false,
        });
        expect(agentContentViewRenderSpy.mock.calls.at(-1)?.[0]?.placeholder).toBeNull();

        await screen.unmount();
    });

    it('mounts cached committed transcripts without waiting for the deferred first-paint window', async () => {
        setCommittedMessagesForTest([{
            id: 'm1',
            kind: 'agent-text',
            localId: null,
            createdAt: 1,
            text: 'cached message',
            isThinking: false,
        }], ['m1']);

        const screen = await renderSessionView();

        expect(chatListRenderSpy).toHaveBeenCalled();
        expect(deferredRenderSpy.mock.calls.at(-1)?.[0]).toMatchObject({
            enabled: true,
        });

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

    it('does not render a cached same-id session from another server when routeServerId is the only scope hint', async () => {
        sessionState = {
            ...sessionState,
            serverId: 'server-b',
        };
        sessionListViewDataByServerIdState = {
            'server-b': [{ type: 'session', session: { id: 's1' } }],
        };

        const screen = await renderSessionView({ routeServerId: 'server-a' });

        expect(chatHeaderRenderSpy).toHaveBeenCalledWith(expect.objectContaining({
            title: 'errors.sessionDeleted',
        }));
        expect(chatHeaderRenderSpy).not.toHaveBeenCalledWith(expect.objectContaining({
            title: 'tmp',
        }));
        expect(chatListRenderSpy).not.toHaveBeenCalled();
        expect(screen.findAllByTestId('session-root-unavailable')).toHaveLength(1);
        const scopedServerIds = selectSyncErrorForServerSpy.mock.calls.map((call) => call[1]);
        expect(scopedServerIds).toContain('server-a');
        expect(scopedServerIds).not.toContain('server-b');

        await screen.unmount();
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
        chatHeaderRenderSpy.mockClear();
        chatListRenderSpy.mockClear();

        sessionState = {
            ...sessionState,
            updatedAt: 200,
            activeAt: 200,
            thinkingAt: 200,
        };
        await screen.update(<SessionView id="s1" />);

        expect(chatHeaderRenderSpy).not.toHaveBeenCalled();
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

        await flushHookEffects({ cycles: 2, turns: 1 });
        appPaneScopeHostRenderSpy.mockClear();
        chatHeaderRenderSpy.mockClear();
        agentInputRenderSpy.mockClear();
        chatListRenderSpy.mockClear();

        await act(async () => {
            setCommittedMessagesForTest([
                { id: 'm1', seq: 26, role: 'assistant', content: 'hello' },
            ]);
            for (const listener of committedMessagesListeners) {
                listener();
            }
            await Promise.resolve();
        });
        await flushHookEffects({ cycles: 2, turns: 1 });

        expect(appPaneScopeHostRenderSpy).not.toHaveBeenCalled();
        expect(chatHeaderRenderSpy).not.toHaveBeenCalled();
        expect(agentInputRenderSpy).not.toHaveBeenCalled();
        expect(chatListRenderSpy).toHaveBeenCalled();

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

    it('keeps the session input stable for committed-sequence-only streaming updates', async () => {
        const screen = await renderSessionView();

        await flushHookEffects({ cycles: 2, turns: 1 });
        agentInputRenderSpy.mockClear();

        await act(async () => {
            sessionState = {
                ...sessionState,
                seq: 26,
            };
            emitStorageChangeForTest();
            await Promise.resolve();
        });

        expect(agentInputRenderSpy).not.toHaveBeenCalled();

        await screen.unmount();
    });

    it('keeps the session input stable for committed message content streaming updates', async () => {
        setCommittedMessagesForTest([{
            id: 'm1',
            kind: 'agent-text',
            localId: null,
            createdAt: 1,
            text: 'hello',
            isThinking: true,
        }], ['m1']);
        const screen = await renderSessionView();

        await flushHookEffects({ cycles: 2, turns: 1 });
        agentInputRenderSpy.mockClear();

        await act(async () => {
            setCommittedMessagesForTest([{
                ...committedMessagesState[0],
                text: 'hello streaming update',
            }], ['m1']);
            for (const listener of committedMessagesListeners) {
                listener();
            }
            await Promise.resolve();
        });

        expect(agentInputRenderSpy).not.toHaveBeenCalled();

        await screen.unmount();
    });

    it('keeps the transcript host stable for visible-read sequence updates while viewing', async () => {
        setCommittedMessagesForTest([{
            id: 'm1',
            kind: 'agent-text',
            localId: null,
            createdAt: 1,
            seq: 25,
            text: 'hello',
            isThinking: true,
        }], ['m1']);
        const screen = await renderSessionView();

        await flushHookEffects({ cycles: 2, turns: 1 });
        chatListRenderSpy.mockClear();
        shouldRenderChatTimelineForSessionMock.mockClear();

        await act(async () => {
            setCommittedMessagesForTest([{
                ...committedMessagesState[0],
                seq: 26,
                text: 'hello streaming update',
            }], ['m1']);
            for (const listener of committedMessagesListeners) {
                listener();
            }
            await Promise.resolve();
        });

        expect(chatListRenderSpy).not.toHaveBeenCalled();
        expect(shouldRenderChatTimelineForSessionMock).not.toHaveBeenCalled();

        await screen.unmount();
    });

    it('does not subscribe to transcript pending messages when cockpit content overrides the transcript body', async () => {
        const { SessionView } = await import('./SessionView');
        const screen = await renderScreen(
            <SessionView id="s1" contentOverride={React.createElement('ContentOverride')} />,
            {
                wrapper: AppPaneProviderWrapper,
            },
        );

        expect(pendingMessagesHookSpy).not.toHaveBeenCalled();
        expect(screen.findAllByType('ContentOverride' as any)).toHaveLength(1);

        await screen.unmount();
    });

    it('does not subscribe to subagent source messages from the cockpit shell body', async () => {
        const { SessionView } = await import('./SessionView');
        const screen = await renderScreen(
            <SessionView id="s1" contentOverride={React.createElement('ContentOverride')} />,
            {
                wrapper: AppPaneProviderWrapper,
            },
        );

        expect(subagentSourceMessagesHookSpy).not.toHaveBeenCalled();

        await screen.unmount();
    });

    it('does not mount session chrome or transcript subscribers when retained behind another route', async () => {
        sessionScreenFocusState.current = false;
        const screen = await renderSessionView();

        expect(chatHeaderRenderSpy).not.toHaveBeenCalled();
        expect(pendingMessagesHookSpy).not.toHaveBeenCalled();
        expect(subagentSourceMessagesHookSpy).not.toHaveBeenCalled();
        expect(sessionExecutionRunsSupportedHookSpy).not.toHaveBeenCalled();
        expect(chatListRenderSpy).not.toHaveBeenCalled();
        expect(agentInputRenderSpy).not.toHaveBeenCalled();
        expect(onSessionVisibleSpy).not.toHaveBeenCalled();

        await screen.unmount();
    });

    it.each([
        ['/new', 'new-session modal'],
        ['/new/pick/machine', 'new-session sub-route'],
        ['/direct/browse', 'browse existing session modal'],
    ] as const)('keeps the session surface painted and mounted while the %s overlay route is open (%s)', async (modalPathname, _label) => {
        routerPathnameState.current = '/session/s1';
        const { SessionView } = await import('./SessionView');

        const screen = await renderScreen(
            <SessionView id="s1" />,
            {
                wrapper: AppPaneProviderWrapper,
            },
        );

        expect(screen.findAllByType('ChatList' as any)).toHaveLength(1);
        expect(surfaceMountSpy.mock.calls.map(([name]) => name).sort()).toEqual([
            'AgentInput',
            'ChatHeaderView',
            'ChatList',
        ]);

        // The overlay opens over the session route: the stack blurs the session screen, but the
        // navigator keeps that screen painted behind the modal, so the surface must stay painted.
        await act(async () => {
            sessionScreenFocusState.set(false);
            routerPathnameState.set(modalPathname);
        });
        await flushHookEffects();

        expect(screen.findAllByType('ChatList' as any)).toHaveLength(1);
        expect(surfaceUnmountSpy).not.toHaveBeenCalled();
        expect(surfaceMountSpy).toHaveBeenCalledTimes(3);

        // Closing the overlay restores the surface without remounting it.
        await act(async () => {
            sessionScreenFocusState.set(true);
            routerPathnameState.set('/session/s1');
        });
        await flushHookEffects();

        expect(screen.findAllByType('ChatList' as any)).toHaveLength(1);
        expect(surfaceUnmountSpy).not.toHaveBeenCalled();
        expect(surfaceMountSpy).toHaveBeenCalledTimes(3);

        await screen.unmount();
    });

    it('releases a session surface anchored to a different session route when an overlay route opens', async () => {
        routerPathnameState.current = '/session/other-session';
        const { SessionView } = await import('./SessionView');

        const screen = await renderScreen(
            <SessionView id="s1" />,
            {
                wrapper: AppPaneProviderWrapper,
            },
        );

        expect(screen.findAllByType('ChatList' as any)).toHaveLength(1);

        await act(async () => {
            sessionScreenFocusState.set(false);
            routerPathnameState.set('/new');
        });
        await flushHookEffects();

        expect(screen.findAllByType('ChatList' as any)).toHaveLength(0);
        expect(surfaceUnmountSpy).toHaveBeenCalledWith('ChatList');

        await screen.unmount();
    });

    it('tracks route-anchored painted sessions as visible under the accepted session server for realtime routing', async () => {
        sessionScreenFocusState.current = false;
        routerPathnameState.current = '/new';
        sessionState.serverId = 'server-actual';
        const { SessionView } = await import('./SessionView');

        const screen = await renderScreen(
            <SessionView id="s1" routeAnchorOverride={true} routeServerId="server-alias" />,
            {
                wrapper: AppPaneProviderWrapper,
            },
        );

        expect(isSessionVisible('s1', 'server-actual')).toBe(true);
        expect(isSessionVisible('s1', 'server-unrelated')).toBe(false);

        await screen.unmount();
        expect(isSessionVisible('s1', 'server-actual')).toBe(false);
    });

    it('does not resolve execution-run header support from the cockpit shell body', async () => {
        const { SessionView } = await import('./SessionView');
        const screen = await renderScreen(
            <SessionView id="s1" contentOverride={React.createElement('ContentOverride')} />,
            {
                wrapper: AppPaneProviderWrapper,
            },
        );

        expect(sessionExecutionRunsSupportedHookSpy).not.toHaveBeenCalled();

        await screen.unmount();
    });

    it('keeps the transcript viewport callback stable across session rerenders', async () => {
        const screen = await renderSessionView();
        const { SessionView } = await import('./SessionView');

        const initialViewportChange = chatListRenderSpy.mock.calls.at(-1)?.[0]?.onViewportChange;
        expect(typeof initialViewportChange).toBe('function');
        chatHeaderRenderSpy.mockClear();
        chatListRenderSpy.mockClear();

        await screen.update(<SessionView id="s1" jumpToSeq={99} />);

        const nextViewportChange = chatListRenderSpy.mock.calls.at(-1)?.[0]?.onViewportChange;
        expect(chatHeaderRenderSpy).not.toHaveBeenCalled();
        expect(nextViewportChange).toBe(initialViewportChange);

        await screen.unmount();
    });

    it('requests mounted transcript follow without duplicating the sync live-tail owner after send', async () => {
        const screen = await renderSessionView();

        const initialFollowBottomIntentKey = chatListRenderSpy.mock.calls.at(-1)?.[0]?.followBottomIntentKey;
        const initialAgentInputProps = agentInputRenderSpy.mock.calls.at(-1)?.[0];
        expect(typeof initialAgentInputProps?.onChangeText).toBe('function');

        await act(async () => {
            initialAgentInputProps.onChangeText('hello from the composer');
        });
        await flushHookEffects({ cycles: 2, turns: 1 });

        const sendAgentInputProps = agentInputRenderSpy.mock.calls.at(-1)?.[0];
        expect(typeof sendAgentInputProps?.onSend).toBe('function');

        await act(async () => {
            sendAgentInputProps.onSend();
            await Promise.resolve();
            await Promise.resolve();
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        const nextFollowBottomIntentKey = chatListRenderSpy.mock.calls.at(-1)?.[0]?.followBottomIntentKey;
        expect(nextFollowBottomIntentKey).not.toBe(initialFollowBottomIntentKey);
        expect(markSessionLiveTailIntentSpy).not.toHaveBeenCalled();

        await screen.unmount();
    });

    it('keeps the transcript host stable when token usage updates during streaming', async () => {
        setSessionUsageState({
            inputTokens: 100,
            outputTokens: 10,
            cacheCreation: 0,
            cacheRead: 0,
            contextSize: 200,
        });
        const screen = await renderSessionView();

        await flushHookEffects({ cycles: 2, turns: 1 });
        chatListRenderSpy.mockClear();
        shouldRenderChatTimelineForSessionMock.mockClear();

        await act(async () => {
            setSessionUsageState({
                ...sessionUsageState,
                outputTokens: 11,
                contextSize: 201,
            });
            await Promise.resolve();
        });

        expect(chatListRenderSpy).not.toHaveBeenCalled();
        expect(shouldRenderChatTimelineForSessionMock).not.toHaveBeenCalled();

        await screen.unmount();
    });
});
