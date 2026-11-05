import 'fake-indexeddb/auto';
import * as React from 'react';
import { createReactNavigationNativeMock } from '@/dev/testkit/mocks/reactNavigation';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderScreen as renderCanonicalScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { renderHook } from '@/dev/testkit';
import { createPlainSessionByIdResponseFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createPendingMessageFixture, createSessionMessagesFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { configureConnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import type { Socket } from 'socket.io-client';
import type { StorageState } from '@/sync/store/types';
import { shallow } from 'zustand/vanilla/shallow';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { normalizeVoiceSettingsLocalDelta } from '@/sync/domains/settings/voiceSettingsPersistence';
import { clearSessionSurfaceVisibilityForServerScopeReset } from '@/sync/domains/session/sessionSurfaceVisibility';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { MINIMUM_CLI_PENDING_QUEUE_V2_VERSION } from '@/utils/system/versionUtils';
import { DiscussionSelectionSourceV1Schema } from '@happier-dev/protocol/discussions/content';
import { RpcError, RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpcErrors';
import type { ChatListInternalProps } from '@/components/sessions/transcript/chatListTypes';


// Static pane/runtime imports use the same Socket boundary as the restored Home.
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

// The patched streaming package is an external renderer boundary and can be absent
// before the UI postinstall lane materializes it; this composer test does not exercise it.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => [],
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const previousDev = (globalThis as { __DEV__?: boolean }).__DEV__;
const shouldRenderChatTimelineForSessionMock = vi.fn();
const chatHeaderRenderSpy = vi.hoisted(() => vi.fn());
const chatListRenderSpy = vi.hoisted(() => vi.fn());
const transcriptSourceIdentitySpy = vi.hoisted(() => vi.fn());
const appPaneScopeHostRenderSpy = vi.hoisted(() => vi.fn());
const agentContentViewRenderSpy = vi.hoisted(() => vi.fn());
const agentInputRenderSpy = vi.hoisted(() => vi.fn());
const nonSteerablePromptAlertAsyncSpy = vi.hoisted(() => vi.fn());
// Route focus and pathname are reactive in production (React Navigation / expo-router re-render
// their subscribers on a route change). These stores keep that property so a spec can move the
// route on a mounted tree and observe what the surface does, not only what a fresh mount does.
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
const sessionSubagentsHookSpy = vi.hoisted(() => vi.fn());
const selectSyncErrorForServerSpy = vi.hoisted(() => vi.fn((_syncError: unknown, _serverId: string | null | undefined) => null));
const approvalArtifactsSpy = vi.hoisted(() => vi.fn());
const pendingOutboundSendPromises = vi.hoisted(() => [] as Promise<unknown>[]);
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

let sessionState: any = null;
let machineState = createMachineFixture({ id: 'm1', activeAt: Date.now() });
let committedMessagesState: any[] = [];
let pendingMessagesState: any[] = [];
let committedMessagesLoadedState = true;
let transcriptIdsState: string[] = [];
let transcriptIdsLoadedState = true;
let transcriptLoadIssueState: any = null;
let concurrentSessionListCacheByServerIdState: Record<string, any> = {};
const fixtureSettings = {
    ...settingsDefaults,
    experiments: true,
    sessionMessageSendMode: 'agent_queue' as const,
    sessionBusySteerSendPolicy: 'steer_immediately' as const,
    sessionNonSteerableSendPrompt: 'on' as const,
};
let messageFixtureInput: readonly unknown[] | null = null;
let messageFixtureIds: readonly string[] | null = null;
let messageFixtureLoaded: boolean | null = null;
let messageFixture = createSessionMessagesFixture();
let pendingFixtureInput: readonly unknown[] | null = null;
let pendingFixture: StorageState['sessionPending'][string] = { messages: [], discarded: [], isLoaded: true };

function getStorageStateForTest() {
    if (messageFixtureInput !== committedMessagesState || messageFixtureIds !== transcriptIdsState
        || messageFixtureLoaded !== transcriptIdsLoadedState) {
        messageFixtureInput = committedMessagesState;
        messageFixtureIds = transcriptIdsState;
        messageFixtureLoaded = transcriptIdsLoadedState;
        messageFixture = createSessionMessagesFixture({
            messageIdsOldestFirst: transcriptIdsState,
            messagesById: Object.fromEntries(committedMessagesState.map((message) => [message.id, message])),
            // Canonical message publications replace the row snapshot, not
            // the Session's in-place reducer. These fixtures have no reducer
            // changes and must not manufacture another tool-route dependency.
            reducerState: messageFixture.reducerState,
            isLoaded: transcriptIdsLoadedState,
            messagesVersion: messageFixture.messagesVersion + 1,
        });
    }
    if (pendingFixtureInput !== pendingMessagesState) {
        pendingFixtureInput = pendingMessagesState;
        pendingFixture = {
            messages: pendingMessagesState.map((message) => createPendingMessageFixture(message)),
            discarded: [],
            isLoaded: true,
        };
    }
    return {
        isDataReady: true,
        isSessionDraftsReady: true,
        sessions: sessionState ? { [sessionState.id]: sessionState } : {},
        sessionMessages: sessionState ? { [sessionState.id]: messageFixture } : {},
        sessionPending: sessionState ? { [sessionState.id]: pendingFixture } : {},
        sessionTranscriptLoadIssues: transcriptLoadIssueState
            ? { [sessionState?.id ?? 's1']: transcriptLoadIssueState }
            : {},
        concurrentSessionListCacheByServerId: concurrentSessionListCacheByServerIdState,
    };
}

function emitCommittedMessagesChangeForTest(): void {
    // A transcript publication is not a Session/pending/Machine snapshot. Those
    // owners may have advanced since the cached fixture was first mounted.
    const { sessionMessages } = getStorageStateForTest();
    shellStorage.setState((current) => shallow(current.sessionMessages, sessionMessages)
        ? current
        : { ...current, sessionMessages });
}

function emitStorageChangeForTest(): void {
    const { sessions } = getStorageStateForTest();
    shellStorage.setState((current) => shallow(current.sessions, sessions)
        ? current
        : { ...current, sessions });
}

function readMountedSessionForTest() {
    const session = shellStorage.getState().sessions[sessionState.id];
    if (!session) throw new Error('Expected the mounted transcript Session');
    return session;
}

function publishStorageFixture(): void {
    const scope = runtime.accountScope;
    if (!scope) throw new Error('Expected the real transcript Account scope');
    shellStorage.getState().applyMachines([machineState], true, {
        sourceServerId: scope.serverId, sourceAccountId: scope.accountId,
    });
    const fixture = getStorageStateForTest();
    shellStorage.setState((current) => {
        const patch = Object.fromEntries(Object.entries(fixture).filter(([key, value]) =>
            !shallow(current[key as keyof StorageState], value)));
        return Object.keys(patch).length ? { ...current, ...patch } : current;
    });
}

vi.mock('expo-linear-gradient', () => ({
    LinearGradient: 'LinearGradient',
}));
vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));
vi.mock('react-native-safe-area-context', () => {
    const insets = { top: 0, bottom: 0, left: 0, right: 0 };
    return {
        initialWindowMetrics: {
            frame: { x: 0, y: 0, width: 0, height: 0 },
            insets,
        },
        SafeAreaInsetsContext: React.createContext(null),
        SafeAreaProvider: ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, children),
        useSafeAreaInsets: () => insets,
    };
});
vi.mock('@react-navigation/native', () => ({
    ...createReactNavigationNativeMock(),
    useFocusEffect: () => {},
    useIsFocused: () => React.useSyncExternalStore(
        sessionScreenFocusState.subscribe,
        sessionScreenFocusState.read,
        sessionScreenFocusState.read,
    ),
}));

vi.mock('react-native', async () => {
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
    });
vi.mock('react-native-unistyles', async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: themeColors,
        });
    });
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
        translate: (key: string) => key,
    });
});
vi.mock('@/modal', async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alertAsync: (...args) => nonSteerablePromptAlertAsyncSpy(...args),
            },
        }).module;
    });
vi.mock('expo-router', async () => {
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
    });

vi.mock('@/components/sessions/transcript/AgentContentView', () => ({
    AgentContentView: React.memo((props: any) => {
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
    }),
}));
vi.mock('@/components/appShell/panes/AppPaneScopeHost', () => ({
    AppPaneScopeHost: React.memo((props: any) => {
        appPaneScopeHostRenderSpy(props);
        return React.createElement('AppPaneScopeHost', props, props.main ?? null);
    }),
}));
vi.mock('@/components/sessions/panes/useRegisterSessionPaneDriver', () => ({
    useRegisterSessionPaneDriver: () => 'pane-scope-test',
}));
vi.mock('@/components/sessions/panes/url/useSessionPaneUrlSync', () => ({
    useSessionPaneUrlSync: () => {},
}));
vi.mock('@/components/sessions/transcript/ChatHeaderView', () => ({
    ChatHeaderView: React.memo((props: any) => {
        chatHeaderRenderSpy(props);
        return null;
    }),
}));
// Keep ChatList's real memo and source subscriptions; its visual leaf also has
// a shallow React.memo boundary in production (ChatListInternal.tsx).
vi.mock('@/components/sessions/transcript/ChatListInternal', async () => {
    const { useSessionTranscriptSource } = await import('@/components/sessions/transcript/source/SessionTranscriptSourceContext');
    const { useTranscriptSelectionActions, useTranscriptSelectionState } = await import('@/components/sessions/transcript/messageSelection/TranscriptMessageSelectionContext');
    return {
        ChatListInternal: React.memo((props: ChatListInternalProps) => {
            const source = useSessionTranscriptSource();
            const selection = useTranscriptSelectionState();
            const selectionActions = useTranscriptSelectionActions();
            transcriptSourceIdentitySpy({ sessionId: source.sessionId, serverId: source.serverId });
            chatListRenderSpy(props);
            return React.createElement('ChatList', {
                onSelectMessage: selectionActions.enter,
                selectedMessageCount: selection.count,
            });
        }),
    };
});
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
vi.mock('@/utils/platform/responsive', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/platform/responsive')>(),
    getDeviceType: () => 'phone',
    useDeviceType: () => 'phone',
    useHeaderHeight: () => 0,
    useIsLandscape: () => false,
    useIsTablet: () => false,
}));
vi.mock('@/sync/runtime/connectivity/syncErrorScope', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/runtime/connectivity/syncErrorScope')>();
    return { ...actual, selectSyncErrorForServer: (...args: Parameters<typeof actual.selectSyncErrorForServer>) => {
        selectSyncErrorForServerSpy(...args);
        return actual.selectSyncErrorForServer(...args);
    } };
});
vi.mock('@/voice/session/voiceSession', () => ({
    useVoiceSessionSnapshot: () => ({ status: 'disconnected' }),
    voiceSessionManager: {},
}));
vi.mock('@/utils/system/fireAndForget', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/system/fireAndForget')>();
    return { ...actual, fireAndForget: (promise: Promise<unknown>, options?: Parameters<typeof actual.fireAndForget>[1]) => {
        if (options?.tag?.startsWith('SessionView.sendMessage.') || options?.tag === 'SessionView.composer.dispatch') {
            pendingOutboundSendPromises.push(promise);
        }
        return actual.fireAndForget(promise, options);
    } };
});
vi.mock('@/utils/timing/runAfterInteractionsWithFallback', () => ({
    runAfterInteractionsWithFallback: (callback: () => void) => {
        callback();
        return () => {};
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
vi.mock('@/components/sessions/agentInput', () => ({
    AgentInput: React.memo((props: any) => {
        agentInputRenderSpy(props);
        return React.createElement('AgentInput', props);
    }),
}));
// Telemetry leaves the process through this SDK; tracking policy and Sync stay real.
vi.mock('posthog-react-native', () => ({
    default: class PostHogBoundary {
        optIn = vi.fn(async () => {});
        optOut = vi.fn(async () => {});
        capture = vi.fn();
        identify = vi.fn();
        reset = vi.fn();
    },
}));
vi.mock('@/hooks/server/useAutomationsSupport', () => ({
    useAutomationsSupport: () => ({ enabled: false }),
}));
vi.mock('@/hooks/session/useSessionSubagents', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/hooks/session/useSessionSubagents')>();
    return { ...actual, useSessionSubagents: (input: Parameters<typeof actual.useSessionSubagents>[0]) => {
        sessionSubagentsHookSpy(input);
        return actual.useSessionSubagents(input);
    } };
});
vi.mock('@/sync/domains/artifacts/approvalArtifacts', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/artifacts/approvalArtifacts')>();
    return { ...actual, listOpenApprovalArtifactsForSession: (...args: Parameters<typeof actual.listOpenApprovalArtifactsForSession>) => {
        approvalArtifactsSpy(...args);
        return actual.listOpenApprovalArtifactsForSession(...args);
    } };
});
vi.mock('@/sync/domains/permissions/permissionModeApply', () => ({
    applyPermissionModeSelection: async () => {},
}));
vi.mock('@/sync/domains/session/control/localControlSwitch', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/session/control/localControlSwitch')>();
    return { ...actual, shouldRenderChatTimelineForSession: (args: Parameters<typeof actual.shouldRenderChatTimelineForSession>[0]) => {
        shouldRenderChatTimelineForSessionMock(args);
        return actual.shouldRenderChatTimelineForSession(args);
    } };
});
vi.doUnmock('@/sync/domains/state/storage');
vi.doUnmock('@/hooks/session/useDraft');
await loadSyncSingletonForTests();
const { sync } = await import('@/sync/sync');
// These observe the real owner; the network boundary below owns every reply.
const onSessionVisibleSpy = vi.spyOn(sync, 'onSessionVisible');
const markSessionLiveTailIntentSpy = vi.spyOn(sync, 'markSessionLiveTailIntent');
const fetchPendingMessagesSpy = vi.spyOn(sync, 'fetchPendingMessages');
const markSessionViewedSpy = vi.spyOn(sync, 'markSessionViewed');
const sendMessageSpy = vi.spyOn(sync, 'sendMessage');
const enqueuePendingMessageSpy = vi.spyOn(sync, 'enqueuePendingMessage');
let activeSocket: Socket | undefined;
let firstPendingAck: Promise<void> | undefined;
let transcriptReadGate: ReturnType<typeof createDeferred<void>> | undefined;
let preparingSessionReadPath: string | undefined;
const admittedSessionIds = new Set<string>();
const homeSessionResponses = new Map<string, ReturnType<typeof createPlainSessionByIdResponseFixture>>();
const observedHttpReads = new Set<string>();
const runtime = installSessionPaneRuntimeTestHarness({
    configureSocket: socket => { activeSocket = socket; },
    rpc: async () => { throw new RpcError(RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE, RPC_ERROR_CODES.METHOD_NOT_AVAILABLE); },
    request: async (url, init) => {
        const path = new URL(String(url)).pathname;
        // These cases measure cached/loading projection subscriptions. A concurrent
        // transport migration is another input, so hold reads at the HTTP boundary
        // until unmount; the real consumer still receives its canonical response.
        if (/^\/v1\/sessions\/[^/]+\/messages$/.test(path) && (init?.method ?? 'GET') === 'GET') {
            observedHttpReads.add(path);
            await transcriptReadGate?.promise;
            return Response.json({ messages: [], hasMore: false, nextBeforeSeq: null });
        }
        if (path.endsWith('/pending') && (init?.method ?? 'GET') === 'GET') {
            observedHttpReads.add(path);
            await transcriptReadGate?.promise;
            return Response.json({ pending: [] });
        }
        if (/^\/v2\/sessions\/[^/]+$/.test(path) && (init?.method ?? 'GET') === 'GET') {
            observedHttpReads.add(path);
            // Retain the actual plain Home wire seed, not a later cached E2EE
            // projection, when this request is released after unmount.
            const response = homeSessionResponses.get(path);
            if (path !== preparingSessionReadPath) await transcriptReadGate?.promise;
            if (response) return Response.json(response);
        }
        if (path.endsWith('/pending') && init?.method === 'POST') {
            const body: unknown = JSON.parse(String(init.body));
            if (!body || typeof body !== 'object' || !('localId' in body) || typeof body.localId !== 'string') {
                throw new Error('Expected the real pending enqueue wire request');
            }
            const acknowledgement = firstPendingAck;
            firstPendingAck = undefined;
            await acknowledgement;
            return Response.json({ requestedAction: { v: 1, kind: 'enqueue' },
                pending: { localId: body.localId }, didWrite: true });
        }
        return null;
    },
});
const shellStorageModule = await import('@/sync/domains/state/storage');
const { storage: shellStorage } = shellStorageModule;
const executionSupportModule = await import('@/hooks/server/useSessionExecutionRunsSupported');
const sessionExecutionRunsSupportedHookSpy = vi.spyOn(executionSupportModule, 'useSessionExecutionRunsSupported');
// Observe subscription placement without replacing the owners' behavior.
const pendingMessagesHookSpy = vi.spyOn(shellStorageModule, 'useSessionPendingMessages');
const transcriptIdsHookSpy = vi.spyOn(shellStorageModule, 'useSessionTranscriptIds');
const subagentSourceMessagesHookSpy = vi.spyOn(shellStorageModule, 'useSessionSubagentSourceMessages');
const { SessionView } = await import('./SessionView');

const { NavigationContext, useNavigation } = await import('@react-navigation/native');

async function prepareScreenStorage() {
    const serverId = sessionState?.serverId ?? 'srv_transcript_primary';
    if (runtime.serverId !== serverId) {
        await act(async () => {
            await runtime.restoreRealm({ serverUrl: `https://${serverId}`, serverIdentityId: serverId, accountId: 'account-1' });
        });
        admittedSessionIds.clear();
        homeSessionResponses.clear();
        applyFixturePreferences();
    }
    await act(async () => {
        publishStorageFixture();
        if (sessionState && !admittedSessionIds.has(sessionState.id)) {
            // Store-only cached rows are not Home admission. Use the real exact
            // reader once before testing retained projections, then hold refreshes.
            const sessionId: string = sessionState.id;
            const path = `/v2/sessions/${encodeURIComponent(sessionId)}`;
            homeSessionResponses.set(path, createPlainSessionByIdResponseFixture(sessionState));
            preparingSessionReadPath = path;
            try {
                const result = await sync.ensureSessionVisibleForMessageRoute(sessionId, {
                    forceRefresh: true, serverId: runtime.serverId, hydrateMessages: false,
                });
                expect(result).toMatchObject({ kind: 'available', sessionId });
                expect(observedHttpReads.has(path)).toBe(true);
                admittedSessionIds.add(sessionId);
            } finally {
                preparingSessionReadPath = undefined;
            }
            publishStorageFixture();
        }
    });
}

async function renderScreen(...args: Parameters<typeof renderCanonicalScreen>) {
    await prepareScreenStorage();
    const screen = await renderCanonicalScreen(...args);
    return {
        ...screen,
        update: async (...updateArgs: Parameters<typeof screen.update>) => {
            await prepareScreenStorage();
            return screen.update(...updateArgs);
        },
    };
}

function applyFixturePreferences() {
    shellStorage.setState({ settings: fixtureSettings });
    shellStorage.getState().applyLocalSettings({ uiMultiPanePanelsEnabled: false }, { persist: false });
}

describe('SessionView (transcript rendering for seq-only sessions)', () => {
    const AppPaneProviderWrapper = ({ children }: { children?: React.ReactNode }) => {
        const navigation = useNavigation<NonNullable<React.ContextType<typeof NavigationContext>>>();
        return <NavigationContext.Provider value={navigation}>
            <runtime.Wrapper>{children ?? null}</runtime.Wrapper>
        </NavigationContext.Provider>;
    };

    async function renderSessionView(props?: Partial<React.ComponentProps<typeof SessionView>>) {
        return renderScreen(
            <SessionView id="s1" {...props} />,
            {
                wrapper: AppPaneProviderWrapper,
            },
        );
    }

    async function renderSendingSessionView() {
        // A send passes the real Action front door, which freshly reads the
        // Session before handing it to Sync. Projection-only tests hold those
        // reads to isolate updates; an outbound journey must let them settle.
        transcriptReadGate?.resolve();
        return renderSessionView();
    }

    beforeEach(async () => {
        await runtime.restoreRealm({ serverUrl: 'https://server-1', serverIdentityId: 'srv_transcript_primary', accountId: 'account-1' });
        applyFixturePreferences();
        (globalThis as { __DEV__?: boolean }).__DEV__ = false;
        firstPendingAck = undefined;
        preparingSessionReadPath = undefined;
        admittedSessionIds.clear();
        homeSessionResponses.clear();
        observedHttpReads.clear();
        transcriptReadGate = createDeferred<void>();
        machineState = createMachineFixture({ id: 'm1', activeAt: Date.now() });
        sessionState = createSessionFixture({
            id: 's1',
            serverId: 'srv_transcript_primary',
            seq: 25,
            updatedAt: 100,
            presence: 'online',
            active: true,
            agentStateVersion: 1,
            pendingVersion: 1,
            pendingCount: 0,
            metadata: { machineId: 'm1', flavor: 'codex', version: MINIMUM_CLI_PENDING_QUEUE_V2_VERSION,
                path: '/tmp', homeDir: '/tmp', host: 'tester.local' },
            agentState: {},
        });
        committedMessagesState = [];
        pendingMessagesState = [];
        committedMessagesLoadedState = true;
        transcriptIdsState = [];
        transcriptIdsLoadedState = true;
        messageFixture = createSessionMessagesFixture();
        messageFixtureInput = null;
        messageFixtureIds = null;
        messageFixtureLoaded = null;
        transcriptLoadIssueState = null;
        concurrentSessionListCacheByServerIdState = {};
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
        nonSteerablePromptAlertAsyncSpy.mockReset();
        nonSteerablePromptAlertAsyncSpy.mockResolvedValue(undefined);
        pendingMessagesHookSpy.mockClear();
        transcriptIdsHookSpy.mockClear();
        subagentSourceMessagesHookSpy.mockClear();
        sessionSubagentsHookSpy.mockClear();
        sessionExecutionRunsSupportedHookSpy.mockClear();
        selectSyncErrorForServerSpy.mockClear();
        approvalArtifactsSpy.mockClear();
        sendMessageSpy.mockClear();
        enqueuePendingMessageSpy.mockClear();
        pendingOutboundSendPromises.length = 0;
        sessionScreenFocusState.current = true;
        routerPathnameState.current = '/';
        // Establish the default plain Session's real Home membership before a
        // case changes its retained state (including already-opened E2EE content).
        await prepareScreenStorage();
    });

    afterEach(async () => {
        syncPerformanceTelemetry.configure({ enabled: false });
        syncPerformanceTelemetry.reset();
        standardCleanup();
        await act(async () => { transcriptReadGate?.resolve(); });
        vi.clearAllMocks();
        (globalThis as { __DEV__?: boolean }).__DEV__ = previousDev;
    });

    it('does not rerender an ordinary SessionView for unrelated Voice settings changes', async () => {
        const screen = await renderSessionView();
        await flushHookEffects();
        // This real hook runs once in SessionView's render; child commits do not count.
        expect(sessionExecutionRunsSupportedHookSpy).toHaveBeenCalled();
        sessionExecutionRunsSupportedHookSpy.mockClear();
        for (let change = 0; change < 3; change++) {
            await act(async () => {
                const settings = shellStorage.getState().settings;
                const voice = settings.voice;
                shellStorage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({ voice: {
                    ...voice,
                    privacy: { ...voice.privacy, recentMessagesCount: voice.privacy.recentMessagesCount + 1 },
                } }, settings));
                expect(shellStorage.getState().settings.voice.privacy.recentMessagesCount).toBe(voice.privacy.recentMessagesCount + 1);
            });
        }
        expect(sessionExecutionRunsSupportedHookSpy).not.toHaveBeenCalled();
        await screen.unmount();
    });

    it('updates a Voice carrier service subtitle separately from an ordinary SessionView', async () => {
        const { useVoiceConversationHeaderSubtitle } = await import('@/voice/presence/useVoiceConversationHeaderSubtitle');
        const { buildSystemSessionMetadataV1 } = await import('@happier-dev/protocol/sessions/metadata/systemSessionV1');
        const { VOICE_CONVERSATION_SYSTEM_SESSION_KEY } = await import('@happier-dev/protocol/voice/sessionBinding');
        const { t } = await import('@/text');
        const selectProvider = async (providerId: 'off' | 'local_direct') => act(async () => {
            const settings = shellStorage.getState().settings;
            shellStorage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({
                voice: { ...settings.voice, providerId },
            }, settings));
        });
        await selectProvider('off');
        let metadata: unknown = {};
        const hook = await renderHook(() => useVoiceConversationHeaderSubtitle(metadata), { wrapper: runtime.Wrapper });
        expect(hook.getCurrent()).toBeUndefined();
        metadata = buildSystemSessionMetadataV1({ key: VOICE_CONVERSATION_SYSTEM_SESSION_KEY, hidden: true });
        await hook.rerender();
        const where = t('voiceMoments.globalVoice');
        expect(hook.getCurrent()).toBe(where);
        await selectProvider('local_direct');
        expect(hook.getCurrent()?.startsWith(`${where} · `)).toBe(true);
        expect(hook.getCurrent()!.length).toBeGreaterThan(`${where} · `.length);
        await selectProvider('off');
        expect(hook.getCurrent()).toBe(where);
        metadata = {};
        await hook.rerender();
        expect(hook.getCurrent()).toBeUndefined();
        await hook.unmount();
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
        await waitForHomeGovernance(() => expect(observedHttpReads.has('/v1/sessions/s1/messages')).toBe(true));

        await screen.unmount();
    });

    it.each(['linked', 'converted_operation'] as const)(
        'renders the empty external-session transcript surface for %s',
        async (state) => {
            sessionState = {
                ...sessionState,
                seq: 0,
                metadata: {
                    ...sessionState.metadata,
                    ...(state === 'linked' ? {
                        externalSessionV1: {
                            v: 1,
                            agentId: 'codex',
                            machineId: 'm1',
                            remoteSessionId: 'remote-1',
                            source: { kind: 'codexHome', home: 'user' },
                        },
                    } : {
                        externalSessionOperationPresentationV1: {
                            v: 1,
                            operationId: 'operation-1',
                            revision: 4,
                            kind: 'materialize',
                            status: 'running',
                            phase: 'importing',
                        },
                    }),
                },
            };
            const screen = await renderSessionView();

            expect(screen.findAllByType('ChatList')).toHaveLength(1);

            await screen.unmount();
        },
    );

    it('reveals the exact hidden post-Voice session with its hydrated late-result transcript', async () => {
        const hiddenSessionId = 'global-voice-late-result';
        const resultMessageId = 'global-voice-late-result-message';
        sessionState = {
            ...sessionState,
            id: hiddenSessionId,
            serverId: 'srv_transcript_a',
            seq: 2,
            lastViewedSessionSeq: 1,
            active: false,
            presence: 'offline',
            metadata: {
                ...sessionState.metadata,
                systemSessionV1: {
                    v: 1,
                    key: 'voice_conversation_retired',
                    hidden: true,
                },
            },
        };
        committedMessagesState = [{
            id: resultMessageId,
            kind: 'agent-text',
            role: 'agent',
            createdAt: 2_000,
            seq: 2,
            text: 'The delegated task completed after Voice ended.',
            content: [{
                type: 'text',
                text: 'The delegated task completed after Voice ended.',
            }],
        }];
        transcriptIdsState = [resultMessageId];

        const screen = await renderSessionView({
            id: hiddenSessionId,
            routeServerId: 'srv_transcript_a',
        });

        expect(onSessionVisibleSpy).toHaveBeenCalledTimes(1);
        expect(onSessionVisibleSpy).toHaveBeenCalledWith(hiddenSessionId);
        expect(shouldRenderChatTimelineForSessionMock).toHaveBeenCalledWith(
            expect.objectContaining({
                committedMessagesCount: 1,
            }),
        );
        expect(chatListRenderSpy.mock.calls.at(-1)?.[0]).toMatchObject({
            sessionId: hiddenSessionId,
            sessionServerId: 'srv_transcript_a',
            metadata: {
                systemSessionV1: {
                    key: 'voice_conversation_retired',
                    hidden: true,
                },
            },
        });
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
            text: 'Cached transcript content',
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

    it('settles a seq-only transcript read failure on the retry banner instead of a second spinner', async () => {
        committedMessagesLoadedState = false;
        transcriptIdsLoadedState = false;
        transcriptLoadIssueState = { kind: 'read_failed', errorCode: 'internal_error' };
        sessionState = { ...sessionState, serverId: 'srv_transcript_primary' };
        routerPathnameState.current = '/session/s1';

        const screen = await renderSessionView({ routeServerId: 'srv_transcript_primary' });
        const { WarningActionBanner } = await import('./view/WarningActionBanner');

        expect(screen.findAllHostsByTestId('session.externalTranscript.loadIssue')).toHaveLength(1);
        expect(screen.findAllByProps({ accessibilityRole: 'progressbar' })).toHaveLength(0);
        expect(screen.findAllByType('ChatList')).toHaveLength(0);
        expect(screen.tree.root.findAllByType(WarningActionBanner)
            .find((banner) => banner.props.testID === 'session.externalTranscript.loadIssue')?.props.title
        ).toBe('externalSessions.sharingTranscriptUnavailableTitle');

        await screen.unmount();
    });

    it('does not call a pending-only failed transcript a retained transcript', async () => {
        sessionState = { ...sessionState, seq: 0, serverId: 'srv_transcript_primary' };
        committedMessagesState = [];
        transcriptIdsState = [];
        pendingMessagesState = [{ id: 'pending-only' }];
        transcriptLoadIssueState = { kind: 'read_failed', errorCode: 'internal_error' };
        routerPathnameState.current = '/session/s1';

        const screen = await renderSessionView({ routeServerId: 'srv_transcript_primary' });
        const { WarningActionBanner } = await import('./view/WarningActionBanner');

        expect(screen.tree.root.findAllByType(WarningActionBanner)
            .find((banner) => banner.props.testID === 'session.externalTranscript.loadIssue')?.props.title
        ).toBe('externalSessions.sharingTranscriptUnavailableTitle');

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

        await act(async () => {
            if (!activeSocket) throw new Error('Expected the restored Account Socket boundary');
            configureConnectedServerSocketBoundary(activeSocket);
            activeSocket.connect();
        });
        expect(onSessionVisibleSpy).toHaveBeenCalledTimes(1);
        await act(async () => {
            activeSocket?.disconnect();
        });
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
            clearSessionSurfaceVisibilityForServerScopeReset();
        });

        // No timer or later socket/update turn: activation must be reacquired in the
        // reset commit so onSessionVisible can restore viewport intent before paint.
        expect(onSessionVisibleSpy).toHaveBeenLastCalledWith('s1');
        expect(onSessionVisibleSpy).toHaveBeenCalledTimes(4);

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

    it('keeps a previously presented same-session subtree mounted across transient surface hiding', async () => {
        const { SessionView } = await import('./SessionView');
        const mountedSpy = vi.fn();
        const unmountedSpy = vi.fn();

        function ContinuityProbe() {
            React.useEffect(() => {
                mountedSpy();
                return () => {
                    unmountedSpy();
                };
            }, []);
            return React.createElement('ContinuityProbe');
        }

        const screen = await renderScreen(
            <SessionView
                id="s1"
                contentOverride={<ContinuityProbe />}
                surfaceFocusedOverride={true}
                surfaceVisibleOverride={true}
                routeAnchorOverride={true}
            />,
            {
                wrapper: AppPaneProviderWrapper,
                flushOptions: { cycles: 0, turns: 0 },
            },
        );

        expect(mountedSpy).toHaveBeenCalledTimes(1);
        expect(unmountedSpy).not.toHaveBeenCalled();

        await screen.update(
            <SessionView
                id="s1"
                contentOverride={<ContinuityProbe />}
                surfaceFocusedOverride={false}
                surfaceVisibleOverride={false}
                routeAnchorOverride={false}
            />,
        );

        expect(screen.findAllByType('ContinuityProbe')).toHaveLength(1);
        expect(screen.findByTestId('session-view-retained-surface:s1')?.props).toMatchObject({
            pointerEvents: 'none',
            style: expect.objectContaining({ opacity: 0 }),
        });
        expect(mountedSpy).toHaveBeenCalledTimes(1);
        expect(unmountedSpy).not.toHaveBeenCalled();

        await screen.update(
            <SessionView
                id="s1"
                contentOverride={<ContinuityProbe />}
                surfaceFocusedOverride={true}
                surfaceVisibleOverride={true}
                routeAnchorOverride={true}
            />,
        );

        expect(screen.findByTestId('session-view-retained-surface:s1')?.props).toMatchObject({
            pointerEvents: 'auto',
            style: expect.objectContaining({ opacity: 1 }),
        });
        expect(mountedSpy).toHaveBeenCalledTimes(1);
        expect(unmountedSpy).not.toHaveBeenCalled();

        await screen.unmount();
        expect(unmountedSpy).toHaveBeenCalledTimes(1);
    });

    it('preserves an exact Session address subtree but remounts address-local state when the Home changes', async () => {
        const { SessionView } = await import('./SessionView');
        const mountedTokens: object[] = [];

        function ContinuityProbe() {
            const [token] = React.useState(() => ({}));
            mountedTokens.push(token);
            return React.createElement('ContinuityProbe');
        }

        const render = (serverId: string) => {
            sessionState = { ...sessionState, serverId };
            return (
                <SessionView
                    id="s1"
                    routeServerId={serverId}
                    contentOverride={<ContinuityProbe />}
                    surfaceFocusedOverride={true}
                    surfaceVisibleOverride={true}
                    routeAnchorOverride={true}
                />
            );
        };
        const screen = await renderScreen(render('srv_transcript_a'), {
            wrapper: AppPaneProviderWrapper,
            flushOptions: { cycles: 0, turns: 0 },
        });
        const serverAToken = mountedTokens.at(-1);

        await screen.update(render('srv_transcript_a'));
        expect(mountedTokens.at(-1)).toBe(serverAToken);

        await screen.update(render('srv_transcript_b'));
        expect(mountedTokens.at(-1)).not.toBe(serverAToken);

        await screen.unmount();
    });

    it('keeps the transcript data key qualified and remounts when hydration resolves a different Home', async () => {
        const { SessionView } = await import('./SessionView');
        sessionState = { ...sessionState, serverId: 'srv_transcript_a' };
        const screen = await renderScreen(
            <SessionView
                id="s1"
                routeHydrationState={{ kind: 'loading', sessionId: 's1', serverId: 'srv_transcript_a', reason: 'refreshing' }}
            />,
            { wrapper: AppPaneProviderWrapper },
        );

        expect(chatListRenderSpy.mock.calls.at(-1)?.[0]?.sessionSurfaceKey).toBe(
            JSON.stringify(['srv_transcript_a', 's1']),
        );

        sessionState = { ...sessionState, serverId: 'srv_transcript_b' };
        await screen.update(
            <SessionView
                id="s1"
                routeHydrationState={{ kind: 'available', sessionId: 's1', serverId: 'srv_transcript_b' }}
            />,
        );

        expect(chatListRenderSpy.mock.calls.at(-1)?.[0]?.sessionSurfaceKey).toBe(
            JSON.stringify(['srv_transcript_b', 's1']),
        );
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

    it.each([
        ['/new', 'new-session modal'],
        ['/new/pick/machine', 'new-session sub-route'],
        ['/direct/browse', 'browse existing session modal'],
    ] as const)('keeps the session surface presented and mounted while the %s overlay route is open (%s)', async (modalPathname, _label) => {
        routerPathnameState.current = '/session/s1';
        const { SessionView } = await import('./SessionView');
        const mountedSpy = vi.fn();
        const unmountedSpy = vi.fn();

        function ContinuityProbe() {
            React.useEffect(() => {
                mountedSpy();
                return () => {
                    unmountedSpy();
                };
            }, []);
            return React.createElement('ContinuityProbe');
        }

        const screen = await renderScreen(
            <SessionView id="s1" contentOverride={<ContinuityProbe />} />,
            {
                wrapper: AppPaneProviderWrapper,
            },
        );

        expect(mountedSpy).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('session-view-retained-surface:s1')?.props).toMatchObject({
            pointerEvents: 'auto',
            style: expect.objectContaining({ opacity: 1 }),
        });

        // The overlay opens over the session route: the stack blurs the session screen, but the
        // navigator keeps that screen painted behind the modal, so the surface must stay presented.
        await act(async () => {
            sessionScreenFocusState.set(false);
            routerPathnameState.set(modalPathname);
        });
        await flushHookEffects();

        expect(screen.findAllByType('ContinuityProbe')).toHaveLength(1);
        expect(screen.findByTestId('session-view-retained-surface:s1')?.props).toMatchObject({
            pointerEvents: 'auto',
            style: expect.objectContaining({ opacity: 1 }),
        });
        expect(mountedSpy).toHaveBeenCalledTimes(1);
        expect(unmountedSpy).not.toHaveBeenCalled();

        // Closing the overlay restores the surface without remounting it.
        await act(async () => {
            sessionScreenFocusState.set(true);
            routerPathnameState.set('/session/s1');
        });
        await flushHookEffects();

        expect(screen.findByTestId('session-view-retained-surface:s1')?.props).toMatchObject({
            pointerEvents: 'auto',
            style: expect.objectContaining({ opacity: 1 }),
        });
        expect(mountedSpy).toHaveBeenCalledTimes(1);
        expect(unmountedSpy).not.toHaveBeenCalled();

        await screen.unmount();
    });

    it('stops presenting a session surface anchored to a different session route when an overlay route opens', async () => {
        routerPathnameState.current = '/session/other-session';
        const { SessionView } = await import('./SessionView');

        const screen = await renderScreen(
            <SessionView id="s1" />,
            {
                wrapper: AppPaneProviderWrapper,
            },
        );

        expect(screen.findByTestId('session-view-retained-surface:s1')?.props).toMatchObject({
            style: expect.objectContaining({ opacity: 1 }),
        });

        await act(async () => {
            sessionScreenFocusState.set(false);
            routerPathnameState.set('/new');
        });
        await flushHookEffects();

        expect(screen.findByTestId('session-view-retained-surface:s1')?.props).toMatchObject({
            pointerEvents: 'none',
            style: expect.objectContaining({ opacity: 0 }),
        });

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

    it('does not render a restore prompt for an available encrypted Session in a real authenticated Account', async () => {
        sessionState = { ...sessionState, encryptionMode: 'e2ee', encryptedContentAvailability: 'ready' };

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
                serverId: 'srv_transcript_b',
            };
            concurrentSessionListCacheByServerIdState = {
                'srv_transcript_b': {
                    serverName: 'Server B',
                    sessions: {
                        s1: { id: 's1' },
                    },
                },
            };

            // Account restore is real asynchronous I/O, not part of the viewed timer.
            await prepareScreenStorage();
            vi.useFakeTimers();
            const screen = await renderSessionView({ routeServerId: 'srv_transcript_a' });

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
            expect(scopedServerIds).toContain('srv_transcript_a');
            expect(scopedServerIds).not.toContain('srv_transcript_b');

            await screen.unmount();
        } finally {
            vi.useRealTimers();
        }
    });

    it('shows the existing Home recovery surface when a deep link has no address yet', async () => {
        const { SessionInvalidLinkFallback } = await import('./SessionInvalidLinkFallback');
        const previousSession = sessionState;
        sessionState = null;

        try {
            const screen = await renderSessionView();
            expect(screen.findAllByType(SessionInvalidLinkFallback)).toHaveLength(1);
            await screen.unmount();
        } finally {
            sessionState = previousSession;
        }

    });

    it('shows loading while an addressless deep link is still hydrating', async () => {
        const { ActivitySpinner } = await import('@/components/ui/feedback/ActivitySpinner');
        const previousSessionState = sessionState;
        sessionState = null;
        try {
            const screen = await renderSessionView({
                routeHydrationState: { kind: 'loading', sessionId: 's1', reason: 'cold' },
            });
            expect(screen.findAllByType(ActivitySpinner)).toHaveLength(1);
            await screen.unmount();
        } finally {
            sessionState = previousSessionState;
        }
    });

    it('keeps the transcript host stable for session timestamp-only updates', async () => {
        const screen = await renderSessionView();
        const { SessionView } = await import('./SessionView');

        await flushHookEffects({ cycles: 2, turns: 1 });
        chatListRenderSpy.mockClear();

        sessionState = readMountedSessionForTest();
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

        sessionState = readMountedSessionForTest();
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

    it('binds the primary transcript to its exact session source', async () => {
        transcriptSourceIdentitySpy.mockClear();
        const screen = await renderSessionView();
        expect(transcriptSourceIdentitySpy).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1' }));
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
            committedMessagesState = [{
                id: 'm1', kind: 'agent-text', localId: null, createdAt: 1,
                seq: 26, role: 'agent', text: 'hello',
            }];
            transcriptIdsState = ['m1'];
            emitCommittedMessagesChangeForTest();
            await Promise.resolve();
        });
        await flushHookEffects({ cycles: 2, turns: 1 });

        expect(appPaneScopeHostRenderSpy).not.toHaveBeenCalled();
        expect(chatHeaderRenderSpy).not.toHaveBeenCalled();
        expect(agentInputRenderSpy).not.toHaveBeenCalled();
        expect(chatListRenderSpy).toHaveBeenCalled();

        await act(async () => { screen.findByType('ChatList').props.onSelectMessage('m1'); });
        expect(screen.findByType('ChatList').props.selectedMessageCount).toBe(1);
        await act(async () => {
            committedMessagesState = [...committedMessagesState, {
                id: 'm2', kind: 'agent-text', localId: null, createdAt: 2,
                seq: 27, role: 'agent', text: 'another message',
            }];
            transcriptIdsState = ['m1', 'm2'];
            emitCommittedMessagesChangeForTest();
        });
        await flushHookEffects({ cycles: 2, turns: 1 });
        expect(screen.findByType('ChatList').props.selectedMessageCount).toBe(1);
        await act(async () => {
            committedMessagesState = [];
            transcriptIdsState = [];
            emitCommittedMessagesChangeForTest();
        });
        await flushHookEffects({ cycles: 2, turns: 1 });
        expect(screen.findByType('ChatList').props.selectedMessageCount).toBe(0);
        expect(appPaneScopeHostRenderSpy).not.toHaveBeenCalled();
        expect(agentInputRenderSpy).not.toHaveBeenCalled();

        await screen.unmount();
    });

    it('uses the supplied activity Session without subscribing to an unused live Session', async () => {
        const { useSessionAgentActivity } = await import('@/hooks/session/useSessionAgentActivity');
        let suppliedSession: ReturnType<typeof readMountedSessionForTest> | null | undefined = readMountedSessionForTest();
        let renders = 0;
        const hook = await renderHook(() => {
            renders += 1;
            return useSessionAgentActivity({ sessionId: 's1', serverId: runtime.serverId, session: suppliedSession });
        }, { wrapper: runtime.Wrapper });
        const publishSequence = async () => {
            await act(async () => {
                shellStorage.setState(state => ({ sessions: { ...state.sessions,
                    s1: { ...state.sessions.s1!, seq: (state.sessions.s1?.seq ?? 0) + 1 } } }));
            });
            await flushHookEffects({ cycles: 2, turns: 1 });
        };

        renders = 0;
        await publishSequence();
        expect(renders).toBe(0);

        suppliedSession = null;
        await hook.rerender();
        renders = 0;
        await publishSequence();
        expect(renders).toBe(0);

        suppliedSession = undefined;
        await hook.rerender();
        renders = 0;
        await publishSequence();
        expect(renders).toBeGreaterThan(0);
        await hook.unmount();
    });

    it('keeps the session shell and composer stable for seq-only streaming updates', async () => {
        const screen = await renderSessionView();

        await flushHookEffects({ cycles: 5, turns: 5 });
        appPaneScopeHostRenderSpy.mockClear();
        chatHeaderRenderSpy.mockClear();
        agentInputRenderSpy.mockClear();
        chatListRenderSpy.mockClear();

        await act(async () => {
            sessionState = readMountedSessionForTest();
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

    it('updates the shell header when the session title changes through storage', async () => {
        const screen = await renderSessionView();
        await flushHookEffects({ cycles: 5, turns: 5 });
        chatHeaderRenderSpy.mockClear();

        await act(async () => {
            sessionState = readMountedSessionForTest();
            sessionState = {
                ...sessionState,
                metadata: {
                    ...sessionState.metadata,
                    summary: { text: 'Updated session title', updatedAt: 200 },
                },
            };
            emitStorageChangeForTest();
        });
        await flushHookEffects({ cycles: 2, turns: 1 });

        expect(chatHeaderRenderSpy).toHaveBeenCalledWith(expect.objectContaining({
            title: 'Updated session title',
        }));
        await screen.unmount();
    });

    it('keeps the transcript host stable for pending-version-only updates while still refreshing pending messages', async () => {
        const screen = await renderSessionView();

        await flushHookEffects({ cycles: 2, turns: 1 });
        chatListRenderSpy.mockClear();
        shouldRenderChatTimelineForSessionMock.mockClear();
        fetchPendingMessagesSpy.mockClear();

        await act(async () => {
            sessionState = readMountedSessionForTest();
            sessionState = {
                ...sessionState,
                pendingVersion: 2,
                pendingCount: 1,
            };
            emitStorageChangeForTest();
            await Promise.resolve();
        });
        await flushHookEffects({ cycles: 5, turns: 5 });

        expect(chatListRenderSpy).not.toHaveBeenCalled();
        expect(fetchPendingMessagesSpy).toHaveBeenCalledWith('s1');

        await screen.unmount();
    });

    it('keeps the transcript host stable for metadata freshness-only updates', async () => {
        sessionState = {
            ...sessionState,
            metadata: {
                ...sessionState.metadata,
                summary: { text: 'Summary', updatedAt: 100 },
                sessionModesV1: {
                    v: 1,
                    agentId: 'codex',
                    updatedAt: 100,
                    currentModeId: 'default',
                    availableModes: [{ id: 'default', name: 'Default' }],
                },
                sessionModelsV1: {
                    v: 1,
                    agentId: 'codex',
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

        sessionState = readMountedSessionForTest();
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

    it('requests mounted transcript follow without duplicating the sync live-tail owner after send', async () => {
        const screen = await renderSendingSessionView();
        const outboundText = 'hello from the composer';

        const initialFollowBottomIntentKey = chatListRenderSpy.mock.calls.at(-1)?.[0]?.followBottomIntentKey;
        markSessionLiveTailIntentSpy.mockClear();
        const initialAgentInputProps = agentInputRenderSpy.mock.calls.at(-1)?.[0];
        expect(typeof initialAgentInputProps?.onChangeText).toBe('function');

        await act(async () => {
            initialAgentInputProps.onChangeText(outboundText);
        });
        await flushHookEffects({ cycles: 2, turns: 1 });

        const sendAgentInputProps = agentInputRenderSpy.mock.calls.at(-1)?.[0];
        expect(typeof sendAgentInputProps?.onSend).toBe('function');

        await act(async () => {
            // This test replaces AgentInput with a host spy, so provide the same live-input
            // override that the real composer supplies when its local text is fresher than props.
            sendAgentInputProps.onSend({ inputTextOverride: outboundText });
            await Promise.all(pendingOutboundSendPromises.splice(0));
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        const nextFollowBottomIntentKey = chatListRenderSpy.mock.calls.at(-1)?.[0]?.followBottomIntentKey;
        expect(enqueuePendingMessageSpy).toHaveBeenCalledOnce();
        expect(sendMessageSpy).not.toHaveBeenCalled();
        expect(markSessionLiveTailIntentSpy).toHaveBeenCalledExactlyOnceWith('s1');
        expect(nextFollowBottomIntentKey).not.toBe(initialFollowBottomIntentKey);

        await screen.unmount();
    });

    it('admits one same-tick composer send and releases after its outbound handoff', async () => {
        const screen = await renderSendingSessionView();
        const firstOutboundHandoff = createDeferred<void>();
        const firstText = 'first same-tick composer send';
        const secondText = 'second composer send after handoff';
        firstPendingAck = firstOutboundHandoff.promise;

        let agentInputProps = agentInputRenderSpy.mock.calls.at(-1)?.[0];
        await act(async () => {
            agentInputProps.onChangeText(firstText);
        });
        await flushHookEffects({ cycles: 2, turns: 1 });

        agentInputProps = agentInputRenderSpy.mock.calls.at(-1)?.[0];
        await act(async () => {
            agentInputProps.onSend({ inputTextOverride: firstText });
            agentInputProps.onSend({ inputTextOverride: firstText });
            await Promise.resolve();
        });

        try {
            await vi.waitFor(() => expect(enqueuePendingMessageSpy).toHaveBeenCalledOnce());
        } finally {
            firstOutboundHandoff.resolve(undefined);
            await act(async () => {
                await Promise.all(pendingOutboundSendPromises.splice(0));
            });
        }

        await flushHookEffects({ cycles: 2, turns: 1 });
        agentInputProps = agentInputRenderSpy.mock.calls.at(-1)?.[0];
        await act(async () => {
            agentInputProps.onChangeText(secondText);
        });
        await flushHookEffects({ cycles: 2, turns: 1 });

        agentInputProps = agentInputRenderSpy.mock.calls.at(-1)?.[0];
        await act(async () => {
            agentInputProps.onSend({ inputTextOverride: secondText });
            await Promise.all(pendingOutboundSendPromises.splice(0));
        });

        expect(enqueuePendingMessageSpy).toHaveBeenCalledTimes(2);
        await screen.unmount();
    });

    it.each(['current', 'foreign'] as const)('preserves only %s-Home Discussion provenance through the real outbound draft handoff', async (home) => {
        const { getSessionDraftSnapshot, readSessionDiscussionSelectionSourceFromDraft, writeExistingSessionDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        const { findPendingOutboxMessage } = await import('@/sync/domains/state/pendingOutboxPersistence');
        const scope = runtime.accountScope;
        if (!scope) throw new Error('Expected the captured Session Account scope');
        const source = DiscussionSelectionSourceV1Schema.parse({
            kind: 'discussion', serverId: home === 'current' ? scope.serverId : 'foreign-home',
            discussionId: 'discussion-a', messageIds: ['discussion-message-a'],
        });
        const screen = await renderSendingSessionView();
        const text = 'Review the unsent Discussion selection';
        await act(async () => {
            agentInputRenderSpy.mock.calls.at(-1)?.[0].onChangeText(text);
            writeExistingSessionDraft({ scope, sessionId: 's1', patch: { sessionDiscussionSelectionSourceV1: source } });
        });
        await flushHookEffects({ cycles: 2, turns: 1 });
        expect(agentInputRenderSpy.mock.calls.at(-1)?.[0].value).toBe(text);
        expect(readSessionDiscussionSelectionSourceFromDraft(getSessionDraftSnapshot(scope, { kind: 'session', sessionId: 's1' })?.document)).toEqual(source);
        await act(async () => {
            agentInputRenderSpy.mock.calls.at(-1)?.[0].onSend({ inputTextOverride: text });
            await Promise.all(pendingOutboundSendPromises.splice(0));
        });
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(enqueuePendingMessageSpy).toHaveBeenCalledOnce();
        const handoff = await enqueuePendingMessageSpy.mock.results[0]!.value;
        const stored = await findPendingOutboxMessage('s1', handoff.localId, scope);
        expect(stored).not.toBeNull();
        const expectedMeta = home === 'current'
            ? expect.objectContaining({ happierStructuredInputV1: expect.objectContaining({ sessionDiscussionSelectionSourceV1: source }) })
            : expect.not.objectContaining({ happierStructuredInputV1: expect.objectContaining({ sessionDiscussionSelectionSourceV1: expect.anything() }) });
        // The real Sync owner accepted durable outbound custody; HTTP dispatch is
        // separately owned by its outbox and need not have occurred at this point.
        expect(enqueuePendingMessageSpy.mock.calls[0]?.slice(0, 2)).toEqual(['s1', text]);
        expect(stored?.rawRecord).toMatchObject({ role: 'user', content: { type: 'text', text }, meta: expectedMeta });
        expect(readSessionDiscussionSelectionSourceFromDraft(getSessionDraftSnapshot(scope, { kind: 'session', sessionId: 's1' })?.document)).toBeNull();
        await screen.unmount();
    });

    it('reserves before an active-turn non-steerable prompt', async () => {
        const promptDismissal = createDeferred<void>();
        const text = '/compact same-tick prompt';
        nonSteerablePromptAlertAsyncSpy.mockImplementationOnce(async () => await promptDismissal.promise);
        sessionState = {
            ...sessionState,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: Date.now(),
        };
        const screen = await renderSessionView();

        let agentInputProps = agentInputRenderSpy.mock.calls.at(-1)?.[0];
        await act(async () => {
            agentInputProps.onChangeText(text);
        });
        await flushHookEffects({ cycles: 2, turns: 1 });

        agentInputProps = agentInputRenderSpy.mock.calls.at(-1)?.[0];
        await act(async () => {
            agentInputProps.onSend({ inputTextOverride: text });
            agentInputProps.onSend({ inputTextOverride: text });
            await Promise.resolve();
        });

        try {
            expect(nonSteerablePromptAlertAsyncSpy).toHaveBeenCalledOnce();
            expect(enqueuePendingMessageSpy).not.toHaveBeenCalled();
        } finally {
            promptDismissal.resolve(undefined);
            await act(async () => {
                await Promise.all(pendingOutboundSendPromises.splice(0));
            });
        }

        expect(enqueuePendingMessageSpy).not.toHaveBeenCalled();
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
