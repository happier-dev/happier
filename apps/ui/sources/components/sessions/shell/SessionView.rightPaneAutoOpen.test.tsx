import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createModalModuleMock } from '@/dev/testkit/mocks/modal';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { createUnistylesMock } from '@/dev/testkit/mocks/unistyles';
import { localSettingsDefaults, type LocalSettings } from '@/sync/domains/settings/localSettings';
import { settingsDefaults, type Settings } from '@/sync/domains/settings/settings';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const previousDev = (globalThis as { __DEV__?: boolean }).__DEV__;
const openRightSpy = vi.hoisted(() => vi.fn());
const setRightTabSpy = vi.hoisted(() => vi.fn());
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
    box: {
        warning: { background: '#fff4cc', border: '#f0d98a', text: '#000' },
    },
}));

let sessionsRightPaneDefaultOpen = false;
let rightScopeState: any = null;
let authCredentials: any = { token: 't', secret: 's' };
let uiMultiPanePanelsEnabledSetting: any = true;
let lastUrlSyncEnabled: boolean | null = null;
let sessionScreenFocused = true;
let mockPathname = '/session/s1';
let pendingMessagesState: { messages: any[]; discarded: any[]; isLoaded: boolean } = {
    messages: [],
    discarded: [],
    isLoaded: true,
};
const fetchPendingMessagesSpy = vi.fn(async (_sessionId?: string) => {});

installSessionShellCommonModuleMocks({
    reactNative: async () =>
        createReactNativeWebMock({
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
            useWindowDimensions: () => ({ width: 1200, height: 800 }),
        }),
    unistyles: async () =>
        createUnistylesMock({
            theme: themeColors,
            runtime: {
                hairlineWidth: 1,
            },
        }),
    text: async () =>
        createTextModuleMock({
            translate: (key: string) => key,
        }),
    modal: async () => createModalModuleMock().module,
    router: async () =>
        createExpoRouterMock({
            pathname: () => mockPathname,
            router: {
                push: vi.fn(),
                back: vi.fn(),
                replace: vi.fn(),
                setParams: vi.fn(),
            },
        }).module,
    storage: async () => {
        const session: any = {
            id: 's1',
            seq: 1,
            presence: 'online',
            active: true,
            accessLevel: 'edit',
            metadata: { machineId: 'm1', flavor: 'codex', version: '0.0.0', path: '/tmp', homeDir: '/tmp' },
            agentState: {},
        };

        return createStorageModuleStub({
            storage: {
                getState: () => ({
                    sessions: { s1: session },
                    settings: {},
                    sessionListViewDataByServerId: {},
                }),
            } as any,
            useSession: () => session,
            useIsDataReady: () => true,
            useRealtimeStatus: () => 'connected',
            useSessionMessages: () => ({ messages: [], isLoaded: true }),
            useSessionTranscriptIds: () => ({ ids: [], isLoaded: true }),
            useSessionPendingMessages: () => pendingMessagesState,
            useSessionReviewCommentsDrafts: () => [],
            useSessionUsage: () => null,
            useLocalSetting: <K extends keyof LocalSettings>(key: K) => {
                const overrides: Partial<LocalSettings> = {
                    acknowledgedCliVersions: {},
                    uiMultiPanePanelsEnabled: uiMultiPanePanelsEnabledSetting,
                    detailsPaneTabsBehavior: 'preview',
                    rightPaneWidthPx: 360,
                    rightPaneWidthBasisPx: 1200,
                    detailsPaneWidthPx: 520,
                    detailsPaneWidthBasisPx: 1200,
                    sessionsRightPaneDefaultOpen,
                };
                return (overrides[key] ?? localSettingsDefaults[key]) as LocalSettings[K];
            },
            useLocalSettingMutable: <K extends keyof LocalSettings>(key: K) => [
                (({
                    acknowledgedCliVersions: {},
                    uiMultiPanePanelsEnabled: uiMultiPanePanelsEnabledSetting,
                    detailsPaneTabsBehavior: 'preview',
                    rightPaneWidthPx: 360,
                    rightPaneWidthBasisPx: 1200,
                    detailsPaneWidthPx: 520,
                    detailsPaneWidthBasisPx: 1200,
                    sessionsRightPaneDefaultOpen,
                } as Partial<LocalSettings>)[key] ?? localSettingsDefaults[key]) as LocalSettings[K],
                vi.fn<(value: LocalSettings[K]) => void>(),
            ],
            useSetting: <K extends keyof Settings>(key: K) => settingsDefaults[key],
            useSettings: () => ({ ...settingsDefaults, experiments: true, featureToggles: {} }),
            useAutomations: () => [],
            useMachine: () => null,
        });
    },
});

vi.mock('react-native-reanimated', () => ({}));
vi.mock('expo-linear-gradient', () => ({
    LinearGradient: 'LinearGradient',
}));
vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@react-navigation/native', () => ({
    useFocusEffect: () => {},
    useIsFocused: () => sessionScreenFocused,
}));
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ credentials: authCredentials }),
}));

vi.mock('@/components/sessions/transcript/AgentContentView', () => ({
    AgentContentView: (props: any) => React.createElement('AgentContentView', props, props.input ?? null),
}));
vi.mock('@/components/appShell/panes/AppPaneScopeHost', () => ({
    AppPaneScopeHost: (props: any) => React.createElement('AppPaneScopeHost', props, props.main ?? null),
}));
vi.mock('@/components/sessions/panes/useRegisterSessionPaneDriver', () => ({
    useRegisterSessionPaneDriver: () => 'session:s1',
}));
vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        openRight: openRightSpy,
        setRightTab: setRightTabSpy,
        closeRight: vi.fn(),
        openDetailsTab: vi.fn(),
        closeDetails: vi.fn(),
        pinDetailsTab: vi.fn(),
        closeDetailsTab: vi.fn(),
        setActiveDetailsTab: vi.fn(),
        setRightTabState: vi.fn(),
        scopeState: rightScopeState,
    }),
}));
vi.mock('@/components/sessions/panes/url/useSessionPaneUrlSync', () => ({
    useSessionPaneUrlSync: (input: any) => {
        lastUrlSyncEnabled = Boolean(input?.enabled);
    },
}));
vi.mock('@/components/sessions/transcript/ChatHeaderView', () => ({
    ChatHeaderView: () => null,
}));
vi.mock('@/components/sessions/transcript/ChatList', () => ({
    ChatList: () => React.createElement('ChatList'),
}));
vi.mock('@/components/sessions/pending/PendingMessagesDragReorderList', () => ({
    PendingMessagesDragReorderList: () => React.createElement('PendingMessagesDragReorderList'),
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
    getDeviceType: () => 'tablet',
    useDeviceType: () => 'tablet',
    useHeaderHeight: () => 0,
    useIsLandscape: () => false,
    useIsTablet: () => true,
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
            fetchPendingMessages: (sessionId: string) => fetchPendingMessagesSpy(sessionId),
            publishSessionPermissionModeToMetadata: async () => {},
            publishSessionAcpSessionModeOverrideToMetadata: async () => {},
            publishSessionAcpConfigOptionOverrideToMetadata: async () => {},
        publishSessionModelOverrideToMetadata: async () => {},
        refreshSessions: async () => {},
        onSessionVisible: () => () => {},
        sendMessage: async () => {},
        enqueuePendingMessage: async () => {},
        submitMessage: async () => {},
        encryption: { getMachineEncryption: () => null },
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
    shouldRenderChatTimelineForSession: () => true,
    shouldRequestRemoteControl: () => false,
    shouldRequestRemoteControlAfterPendingEnqueue: () => false,
}));
vi.mock('@/sync/runtime/time', () => ({
    nowServerMs: () => 0,
}));
vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: () => {},
}));

describe('SessionView (right pane auto-open)', () => {
    const AppPaneProviderWrapper = ({ children }: { children?: React.ReactNode }) => (
        <AppPaneProvider>{children ?? null}</AppPaneProvider>
    );

    async function renderSessionView(paneUrlState?: Record<string, unknown>) {
        const { SessionView } = await import('./SessionView');
        return renderScreen(
            <SessionView id="s1" paneUrlState={paneUrlState as any} />,
            {
                wrapper: AppPaneProviderWrapper,
            },
        );
    }

    beforeEach(() => {
        (globalThis as { __DEV__?: boolean }).__DEV__ = false;
        sessionsRightPaneDefaultOpen = false;
        rightScopeState = {
            right: { isOpen: false, activeTabId: null, tabState: {} },
            details: { isOpen: false, tabs: [], activeTabKey: null },
        };
        authCredentials = { token: 't', secret: 's' };
        uiMultiPanePanelsEnabledSetting = true;
        lastUrlSyncEnabled = null;
        sessionScreenFocused = true;
        mockPathname = '/session/s1';
        pendingMessagesState = {
            messages: [],
            discarded: [],
            isLoaded: true,
        };
        openRightSpy.mockReset();
        setRightTabSpy.mockReset();
        fetchPendingMessagesSpy.mockReset();
    });

    afterEach(() => {
        standardCleanup();
        vi.clearAllMocks();
        (globalThis as { __DEV__?: boolean }).__DEV__ = previousDev;
    });

    it('opens right pane on first visit when sessionsRightPaneDefaultOpen is enabled and no prior tab state exists', async () => {
        sessionsRightPaneDefaultOpen = true;

        const screen = await renderSessionView();

        expect(openRightSpy).toHaveBeenCalledWith({ tabId: 'files' });

        await screen.unmount();
    });

    it('does not force open right pane when the user previously interacted (activeTabId set)', async () => {
        sessionsRightPaneDefaultOpen = true;
        rightScopeState = {
            right: { isOpen: false, activeTabId: 'git', tabState: {} },
            details: { isOpen: false, tabs: [], activeTabKey: null },
        };

        const screen = await renderSessionView();

        expect(openRightSpy).not.toHaveBeenCalled();

        await screen.unmount();
    });

    it('does not open right pane when the setting is disabled', async () => {
        const screen = await renderSessionView();

        expect(openRightSpy).not.toHaveBeenCalled();

        await screen.unmount();
    });

    it('keeps URL pane sync enabled when multi-pane setting is unset', async () => {
        uiMultiPanePanelsEnabledSetting = undefined;

        const screen = await renderSessionView({ rightTabId: 'git' });

        expect(lastUrlSyncEnabled).toBe(true);

        await screen.unmount();
    });

    it('disables URL pane sync while the browser is on the details route', async () => {
        mockPathname = '/session/s1/details';

        const screen = await renderSessionView({ rightTabId: 'git' });

        expect(lastUrlSyncEnabled).toBe(false);

        await screen.unmount();
    });

    it('re-fetches pending messages when the session view remounts with a pending queue rendered', async () => {
        const { PendingMessagesTranscriptBlock } = await import('@/components/sessions/pending/PendingMessagesTranscriptBlock');
        const { SessionView } = await import('./SessionView');
        const tree = React.createElement(
            React.Fragment,
            null,
            React.createElement(PendingMessagesTranscriptBlock, {
                sessionId: 's1',
                pendingMessages: [
                    {
                        id: 'p1',
                        text: 'pending',
                        displayText: undefined,
                        createdAt: 1,
                        updatedAt: 1,
                        localId: 'p1',
                        rawRecord: {},
                    },
                ],
                discardedMessages: [],
            }),
            React.createElement(SessionView, { id: 's1' }),
        );
        const screen = await renderScreen(tree, {
            wrapper: AppPaneProviderWrapper,
        });

        // `SessionView` fetches pending messages via `runAfterInteractionsWithFallback`, which schedules
        // a `setTimeout(0)` on web. Wait a tick so the side-effect can run deterministically.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));

        expect(fetchPendingMessagesSpy).toHaveBeenCalledTimes(1);
        expect(fetchPendingMessagesSpy).toHaveBeenCalledWith('s1');

        await screen.unmount();

        const remountedScreen = await renderScreen(tree, {
            wrapper: AppPaneProviderWrapper,
        });

        await new Promise<void>((resolve) => setTimeout(resolve, 0));

        expect(fetchPendingMessagesSpy).toHaveBeenCalledTimes(2);
        expect(fetchPendingMessagesSpy).toHaveBeenNthCalledWith(1, 's1');
        expect(fetchPendingMessagesSpy).toHaveBeenNthCalledWith(2, 's1');

        await remountedScreen.unmount();
    });
});
