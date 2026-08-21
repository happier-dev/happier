import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactTestInstance } from 'react-test-renderer';

import {
    buildAgentActivityEntryId,
    type SessionAgentActivityEntryV1,
    type SessionAgentActivityHeadlineV1,
} from '@happier-dev/protocol';

import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createModalModuleMock } from '@/dev/testkit/mocks/modal';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { createStorageModuleStub, createStorageStoreMock } from '@/dev/testkit/mocks/storage';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { createUnistylesMock } from '@/dev/testkit/mocks/unistyles';
import { localSettingsDefaults, type LocalSettings } from '@/sync/domains/settings/localSettings';
import { settingsDefaults, type Settings } from '@/sync/domains/settings/settings';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The work-state chip, asserted where it is BUILT rather than where it is formatted.
 *
 * `sessionActivityPresentation` owns the composition and has its own tests, and those tests stay
 * green for a host that never calls it, calls it with the wrong tally, or throws its answer away
 * and re-passes a static `accessibilityLabel` at the call site. That last one is the live defect
 * this file exists for: `AgentInputStatusBadge` resolves its accessible name as
 * `accessibilityLabel ?? label`, so naming the SURFACE there announces "Session work state" to a
 * screen reader and silently deletes the only channel by which the composer carries live agent
 * work (R-12, §4.6).
 *
 * So this renders the real `SessionView`, lets the real `useSessionAgentActivity` derive the tally
 * from a published headline, and reads the accessible name off the real badge component. The one
 * substitution is the composer itself: like every other `SessionView` host test, `AgentInput` is
 * stubbed — but this stub renders the badges the host handed it through the REAL
 * `AgentInputStatusBadge`, so the name asserted here is the name a screen reader would read.
 */

const previousDev = (globalThis as { __DEV__?: boolean }).__DEV__;
const SESSION_ID = 's1';
const RUN_ID = 'implicit:agent-activity';
const BADGE_TEST_ID = 'session-work-state-status-badge';

/** Params are rendered into the key so an assertion can see the number that reached `t(...)`. */
function formatTranslationKey(key: string, params?: Record<string, unknown>): string {
    if (!params) return key;
    const rendered = Object.entries(params)
        .map(([name, value]) => `${name}=${String(value)}`)
        .join(',');
    return `${key}(${rendered})`;
}

function publishedAgent(index: number): SessionAgentActivityEntryV1 {
    return {
        entryId: buildAgentActivityEntryId({
            kind: 'workflow_agent',
            runId: RUN_ID,
            agentId: `toolu_${index}`,
        }),
        kind: 'workflow_agent',
        title: `Agent ${index}`,
        status: 'running',
        updatedAt: 5_000,
        startedAt: 1_000,
        runId: RUN_ID,
        parentId: buildAgentActivityEntryId({ kind: 'workflow_run', runId: RUN_ID }),
    };
}

/** The headline the CLI publishes: a run box plus its live members. */
function makeHeadline(runningAgentCount: number): SessionAgentActivityHeadlineV1 {
    return {
        v: 1,
        backendId: 'claude',
        updatedAt: 5_000,
        activeEntries: [
            {
                entryId: buildAgentActivityEntryId({ kind: 'workflow_run', runId: RUN_ID }),
                kind: 'workflow_run',
                title: 'Agent activity',
                status: 'running',
                updatedAt: 5_000,
                runId: RUN_ID,
            },
            ...Array.from({ length: runningAgentCount }, (_unused, index) => publishedAgent(index + 1)),
        ],
    };
}

function makeSession(runningAgentCount: number): any {
    return {
        id: SESSION_ID,
        seq: 1,
        presence: 'online',
        active: true,
        accessLevel: 'edit',
        metadata: {
            machineId: 'm1',
            flavor: 'claude',
            version: '0.0.0',
            path: '/tmp',
            host: '',
            homeDir: '/tmp',
            sessionAgentActivityHeadlineV1: makeHeadline(runningAgentCount),
        },
        agentState: {},
    };
}

let sessionSnapshot: any = makeSession(3);
let pendingMessagesState: { messages: any[]; discarded: any[]; isLoaded: boolean } = {
    messages: [],
    discarded: [],
    isLoaded: true,
};

installSessionShellCommonModuleMocks({
    reactNative: async () =>
        createReactNativeWebMock({
            Platform: {
                OS: 'web',
                select: (spec: Record<string, unknown>) =>
                    spec && Object.prototype.hasOwnProperty.call(spec, 'web')
                        ? (spec as any).web
                        : (spec as any).default,
            },
            useWindowDimensions: () => ({ width: 1200, height: 800 }),
        }),
    // The real light theme, because the real badge is rendered: it reads `state.<variant>.onTint`
    // and the text roles, and a partial fixture would fail on chrome rather than on wiring.
    unistyles: async () => createUnistylesMock(),
    text: async () => createTextModuleMock({ translate: formatTranslationKey }),
    modal: async () => createModalModuleMock().module,
    router: async () =>
        createExpoRouterMock({
            pathname: () => '/session/s1',
            router: {
                push: vi.fn(),
                back: vi.fn(),
                replace: vi.fn(),
                setParams: vi.fn(),
            },
        }).module,
    storage: async () => {
        const storage = createStorageStoreMock({
            sessions: { [SESSION_ID]: sessionSnapshot },
            settings: settingsDefaults,
            sessionListViewDataByServerId: {},
        });

        return createStorageModuleStub({
            storage,
            useSession: () => sessionSnapshot,
            useIsDataReady: () => true,
            useRealtimeStatus: () => 'connected',
            useSessionMessages: () => ({ messages: [], isLoaded: true }),
            useSessionTranscriptIds: () => ({ ids: [], isLoaded: true }),
            useSessionPendingMessages: () => pendingMessagesState,
            // No transcript at all: the tally has to come from the published headline, which is the
            // cold-open path every count surface depends on (R-3).
            useSessionSubagentSourceMessages: () => [],
            useSessionReviewCommentsDrafts: () => [],
            useSessionUsage: () => null,
            useLocalSetting: <K extends keyof LocalSettings>(key: K) => {
                const overrides: Partial<LocalSettings> = {
                    acknowledgedCliVersions: {},
                    uiMultiPanePanelsEnabled: true,
                    detailsPaneTabsBehavior: 'preview',
                    rightPaneWidthPx: 360,
                    rightPaneWidthBasisPx: 1200,
                    detailsPaneWidthPx: 520,
                    detailsPaneWidthBasisPx: 1200,
                    sessionsRightPaneDefaultOpen: false,
                };
                return (overrides[key] ?? localSettingsDefaults[key]) as LocalSettings[K];
            },
            useLocalSettingMutable: <K extends keyof LocalSettings>(key: K) => [
                localSettingsDefaults[key],
                vi.fn<(value: LocalSettings[K]) => void>(),
            ],
            useSetting: <K extends keyof Settings>(key: K) => settingsDefaults[key],
            useSettings: () => ({ ...settingsDefaults, experiments: true, featureToggles: {} }),
            useAutomations: () => [],
            useSessionAutomationsEnabledCount: () => 0,
            useOpenApprovalArtifactsForSession: () => [],
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
    useIsFocused: () => true,
}));
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ credentials: { token: 't', secret: 's' } }),
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
        openRight: vi.fn(),
        setRightTab: vi.fn(),
        closeRight: vi.fn(),
        openDetailsTab: vi.fn(),
        closeDetails: vi.fn(),
        pinDetailsTab: vi.fn(),
        closeDetailsTab: vi.fn(),
        setActiveDetailsTab: vi.fn(),
        setRightTabState: vi.fn(),
        scopeState: {
            right: { isOpen: false, activeTabId: null, tabState: {} },
            details: { isOpen: false, tabs: [], activeTabKey: null },
        },
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
    useDraft: () => ({ clearDraft: vi.fn(), setDraftValue: vi.fn() }),
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
        onSessionVisible: () => () => {},
        markSessionLiveTailIntent: () => {},
        sendMessage: async () => {},
        enqueuePendingMessage: async () => {},
        submitMessage: async () => {},
        ensureSidechainMessagesLoaded: async () => 'loaded' as const,
        getSyncTuning: () => ({ sidechainDemandHydrationConcurrencyLimit: 2 }),
        encryption: { getMachineEncryption: () => null },
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
// A genuine boundary: the execution-run RPCs the roster would otherwise call for real.
vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
    sessionExecutionRunList: vi.fn(async () => ({ ok: true, runs: [] })),
    sessionExecutionRunStop: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
    createDefaultActionExecutor: () => ({ execute: vi.fn() }),
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
vi.mock('@/sync/domains/sessionControl/sessionModeControl', () => ({
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

// The composer is stubbed like it is in every other `SessionView` host test — but the badges it was
// handed are rendered through the real `AgentInputStatusBadge`, so `accessibilityLabel ?? label` is
// resolved by production code rather than restated by this file.
vi.mock('@/components/sessions/agentInput', async () => {
    const { AgentInputStatusBadge } = await import('@/components/sessions/agentInput/status/AgentInputStatusBadge');
    return {
        AgentInput: (props: any) => React.createElement(
            'View',
            { testID: 'session-composer-input' },
            ...(props.statusBadges ?? []).map(({ key, renderPopover, onPress, ...badge }: any) => (
                React.createElement(AgentInputStatusBadge, {
                    key,
                    ...badge,
                    // Mirrors `AgentInput`: a badge carrying a popover is pressable, which is the
                    // branch whose accessible name falls back to the visible label.
                    onPress: renderPopover ? () => {} : onPress,
                })
            )),
        ),
    };
});

type Screen = Awaited<ReturnType<typeof renderScreen>>;

/** The label the pill actually painted, read off the rendered text node. */
function readPaintedLabel(screen: Screen): string {
    const labelNode = screen.findByTestId(`${BADGE_TEST_ID}:pill:label`);
    if (!labelNode) throw new Error('the work-state chip painted no label');
    return (labelNode.children as ReactTestInstance['children'])
        .filter((child): child is string => typeof child === 'string')
        .join('');
}

/** The name a screen reader announces for the chip. */
function readAnnouncedLabel(screen: Screen): string {
    const badge = screen.findByTestId(BADGE_TEST_ID);
    if (!badge) throw new Error('the work-state chip did not render');
    return String(badge.props.accessibilityLabel ?? '');
}

describe('SessionView (work-state chip call site)', () => {
    const AppPaneProviderWrapper = ({ children }: { children?: React.ReactNode }) => (
        <AppPaneProvider>{children ?? null}</AppPaneProvider>
    );

    async function renderSessionView() {
        const { SessionView } = await import('./SessionView');
        return renderScreen(<SessionView id={SESSION_ID} />, { wrapper: AppPaneProviderWrapper });
    }

    beforeEach(() => {
        (globalThis as { __DEV__?: boolean }).__DEV__ = false;
        sessionSnapshot = makeSession(3);
        pendingMessagesState = { messages: [], discarded: [], isLoaded: true };
    });

    afterEach(() => {
        standardCleanup();
        vi.clearAllMocks();
        (globalThis as { __DEV__?: boolean }).__DEV__ = previousDev;
    });

    it('announces the live tally on the chip rather than the name of the surface', async () => {
        const screen = await renderSessionView();

        // The counts reached the presentation, and the composed label reached the badge. The
        // headline names a run and its three agents, so the chip says so: the run is the stable
        // unit and its complement is the producer's, never a bare "3 agents" (RULING-10).
        const painted = readPaintedLabel(screen);
        expect(painted).toContain('session.agentActivity.composer.workflowsWithAgents');
        expect(painted).toContain('workflows=1');
        expect(painted).toContain('agents=3');

        // R-12: the accessible name IS the live state. Re-passing a static string at the call site
        // replaces the visible label for a screen reader, and this is the only assertion in the
        // repository that would notice.
        expect(readAnnouncedLabel(screen)).toBe(painted);

        await screen.unmount();
    });

    it('tracks the tally it was handed instead of a fixed number', async () => {
        sessionSnapshot = makeSession(1);

        const screen = await renderSessionView();

        expect(readPaintedLabel(screen)).toContain('agents=1');
        expect(readAnnouncedLabel(screen)).toContain('agents=1');

        await screen.unmount();
    });
});
