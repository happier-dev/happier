import * as React from 'react';
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
    useIsFocused: () => true,
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
            pathname: '/',
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
                storage: {
                    getState: () => ({
                        sessions: sessionState ? { s1: sessionState } : {},
                        settings: {
                            sessionMessageSendMode: 'direct',
                            sessionBusySteerSendPolicy: 'steerImmediately',
                        },
                        sessionListViewDataByServerId: {},
                    }),
                } as any,
                useSession: () => sessionState,
                __setSessionForTest: (next: any) => {
                    sessionState = next;
                },
                useIsDataReady: () => true,
                useRealtimeStatus: () => realtimeStatusValue.current,
                useSessionMessages: () => ({ messages: [], isLoaded: true }),
                useSessionTranscriptIds: () => ({ ids: [], isLoaded: true }),
                useSessionPendingMessages: () => ({ messages: [] }),
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
    AgentContentView: (props: any) =>
        React.createElement(
            'AgentContentView',
            props,
            React.createElement(
                React.Fragment,
                null,
                props.placeholder ?? null,
                props.content ?? null,
                props.input ?? null,
            ),
        ),
}));
vi.mock('@/components/appShell/panes/AppPaneScopeHost', () => ({
    AppPaneScopeHost: (props: any) => React.createElement('AppPaneScopeHost', props, props.main ?? null),
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
    ChatHeaderView: () => null,
}));
vi.mock('@/components/sessions/transcript/ChatList', () => ({
    ChatList: () => React.createElement('ChatList'),
}));
vi.mock('@/components/ui/empty/EmptyMessages', () => ({
    EmptyMessages: () => React.createElement('EmptyMessages'),
}));
vi.mock('@/components/ui/forms/Deferred', () => ({
    Deferred: (props: any) => React.createElement(React.Fragment, null, props.children),
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
vi.mock('@/hooks/session/useDraft', () => ({
    useDraft: () => ({ clearDraft: vi.fn() }),
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
vi.mock('@/voice/session/voiceSession', () => ({
    useVoiceSessionSnapshot: () => ({ status: 'disconnected' }),
    voiceSessionManager: {},
}));
vi.mock('@/sync/sync', () => ({
    sync: {
        markSessionViewed: async () => {},
        fetchPendingMessages: async () => {},
        publishSessionPermissionModeToMetadata: async () => {},
        publishSessionAcpSessionModeOverrideToMetadata: async () => {},
        publishSessionAcpConfigOptionOverrideToMetadata: async () => {},
        publishSessionModelOverrideToMetadata: async () => {},
        refreshSessions: async () => {},
        onSessionVisible: onSessionVisibleSpy,
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
    AgentInput: () => null,
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
    resolveSessionComposerSend: () => ({ kind: 'send', text: '' }),
}));
vi.mock('@/sync/domains/permissions/permissionModeApply', () => ({
    applyPermissionModeSelection: async () => {},
}));
vi.mock('@/sync/acp/sessionModeControl', () => ({
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

    async function renderSessionView() {
        const { SessionView } = await import('./SessionView');
        return renderScreen(
            <SessionView id="s1" />,
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
            presence: 'online',
            active: true,
            accessLevel: 'edit',
            metadata: { machineId: 'm1', flavor: 'codex', version: '0.0.0', path: '/tmp', homeDir: '/tmp' },
            agentState: {},
        };
        shouldRenderChatTimelineForSessionMock.mockClear();
        onSessionVisibleSpy.mockClear();
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
                presence: 'online',
                active: true,
                accessLevel: 'edit',
                metadata: { machineId: 'm1', flavor: 'codex', version: '0.0.0', path: '/tmp', homeDir: '/tmp' },
                agentState: {},
            });
        }

        expect(error).toBeNull();
    });
});
