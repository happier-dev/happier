import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { renderHook, renderScreen } from '@/dev/testkit';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

const markSessionViewedSpy = vi.hoisted(() => vi.fn(async () => {}));
const scheduledInteractionCallbacks = vi.hoisted<(() => void)[]>(() => []);
const sessionState = vi.hoisted(() => ({
    current: {
        id: 's1',
        seq: 2,
        presence: 'online',
        active: true,
        accessLevel: 'edit',
        modelMode: { defaultMode: 'build' },
        metadata: { machineId: 'm1', flavor: 'codex', version: '0.0.0', path: '/tmp', homeDir: '/tmp' },
        agentState: {},
    } as any,
}));
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
        scopeState: { right: { isOpen: false, activeTabId: null, tabState: {} }, details: { isOpen: false, tabs: [], activeTabKey: null } },
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
vi.mock('@/components/sessions/actions/SessionHeaderSubagentsButton', () => ({
    SessionHeaderSubagentsButton: () => null,
}));
vi.mock('@/components/sessions/actions/SessionHeaderTerminalButton', () => ({
    SessionHeaderTerminalButton: () => null,
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
    useSessionExecutionRunsSupported: () => false,
}));
vi.mock('@/hooks/session/files/useWarmRepositoryDirectoryCacheOnSessionOpen', () => ({
    useWarmRepositoryDirectoryCacheOnSessionOpen: () => {},
}));
vi.mock('@/utils/platform/responsive', () => ({
    getDeviceType: () => 'tablet',
    useDeviceType: () => 'tablet',
    useHeaderHeight: () => 0,
    useIsLandscape: () => false,
    useIsTablet: () => true,
}));
vi.mock('@/components/sessions/model/inactiveSessionUi', () => ({
    getInactiveSessionUiState: () => ({ noticeKind: 'none', inactiveStatusTextKey: null, shouldShowInput: true }),
}));
vi.mock('@/components/sessions/model/useSessionMachineReachability', () => ({
    useSessionMachineReachability: () => ({ machineReachable: true, machineOnline: true, machineRpcTargetAvailable: true }),
    useSessionReachableMachineTarget: () => null,
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
        markSessionViewed: markSessionViewedSpy,
        fetchPendingMessages: vi.fn(async () => {}),
        publishSessionPermissionModeToMetadata: async () => {},
        publishSessionAcpSessionModeOverrideToMetadata: async () => {},
        publishSessionAcpConfigOptionOverrideToMetadata: async () => {},
        publishSessionModelOverrideToMetadata: async () => {},
        refreshSessions: async () => {},
        onSessionVisible: () => {},
        sendMessage: async () => {},
        enqueuePendingMessage: async () => {},
        submitMessage: async () => {},
        encryption: { getMachineEncryption: () => null },
        onSessionViewportChange: () => {},
    },
}));
vi.mock('@/sync/ops', () => ({
    continueSessionWithReplay: vi.fn(),
    sessionAbort: vi.fn(),
    resumeSession: vi.fn(),
    sessionAttachmentsUploadFile: vi.fn(),
    sessionSwitch: vi.fn(async () => true),
}));
vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
    createDefaultActionExecutor: () => ({ execute: vi.fn() }),
}));
vi.mock('@/components/sessions/agentInput', () => ({
    AgentInput: () => null,
}));
vi.mock('@/utils/timing/runAfterInteractionsWithFallback', () => ({
    runAfterInteractionsWithFallback: (callback: () => void) => {
        scheduledInteractionCallbacks.push(callback);
        return () => {};
    },
}));
installSessionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            useWindowDimensions: () => ({ width: 1200, height: 800 }),
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            router: { push: vi.fn(), back: vi.fn(), setParams: vi.fn() },
            pathname: '/',
        });
        return routerMock.module;
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            storage: {
	                getState: () => ({
	                    sessions: { s1: sessionState.current },
	                    settings: {},
	                    concurrentSessionListCacheByServerId: {},
	                }),
	            },
	            useSession: () => sessionState.current,
	            useAutomations: () => [],
            useIsDataReady: () => true,
            useRealtimeStatus: () => ({ current: { status: 'connected' } as any }),
            useSessionMessages: () => ({ messages: [], isLoaded: true }),
            useSessionTranscriptIds: () => ({ ids: [], isLoaded: true }),
            useSessionSubagentSourceMessages: () => [],
            useSessionPendingMessages: () => ({ messages: [] }),
            useSessionReviewCommentsDrafts: () => [],
            useWorkspaceReviewCommentsDrafts: () => [],
            useSessionUsage: () => null,
            useSetting: () => null,
            useSettings: () => ({ experiments: true, featureToggles: {} }),
            useLocalSetting: (key: string) => {
                if (key === 'acknowledgedCliVersions') return {};
                if (key === 'detailsPaneTabsBehavior') return 'preview';
                if (key === 'rightPaneWidthPx') return 360;
                if (key === 'rightPaneWidthBasisPx') return 1200;
                if (key === 'detailsPaneWidthPx') return 520;
                if (key === 'detailsPaneWidthBasisPx') return 1200;
                if (key === 'sessionsRightPaneDefaultOpen') return false;
                if (key === 'sessionPermissionModeApplyTiming') return 'immediate';
                if (key === 'uiMultiPanePanelsEnabled') return true;
                return null;
            },
        });
    },
});
vi.mock('@/sync/store/settingsWriters', () => ({
    useApplyLocalSettings: () => vi.fn(),
}));
vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['codex'],
    DEFAULT_AGENT_ID: 'codex',
    buildResumeSessionExtrasFromUiState: () => null,
    getAgentCore: () => ({
        cli: { detectKey: 'codex' },
        uiConnectedService: { serviceId: null, label: 'Codex', connectRoute: null },
        model: { defaultMode: 'default' },
        resume: { vendorResumeIdField: null },
        sessionModes: { kind: 'none' },
    }),
    getAgentResumeExperimentsFromSettings: () => null,
    getNewSessionRelevantInstallableDepKeys: () => [],
    isAgentId: (value: unknown) => value === 'codex',
    resolveAgentIdFromFlavor: () => 'codex',
}));
vi.mock('@/agents/runtime/resumeCapabilities', () => ({
    canResumeSessionWithOptions: () => false,
}));
vi.mock('@/agents/hooks/useResumeCapabilityOptions', () => ({
    useResumeCapabilityOptions: () => [],
}));
vi.mock('@/sync/domains/input/reviewComments/reviewCommentPrompt', () => ({
    buildReviewCommentsDisplayText: () => '',
    buildReviewCommentsPromptText: () => '',
}));
vi.mock('@/sync/domains/input/reviewComments/reviewCommentMeta', () => ({
    buildReviewCommentsV1MetaPayload: () => ({}),
}));
vi.mock('@/sync/domains/input/slashCommands/resolveSessionComposerSend', () => ({
    resolveSessionComposerSend: () => null,
}));
vi.mock('@/sync/domains/input/slashCommands/expandPromptTemplateInvocation', () => ({
    expandPromptTemplateInvocation: () => null,
}));
vi.mock('@/sync/domains/permissions/permissionModeApply', () => ({
    applyPermissionModeSelection: vi.fn(),
}));
vi.mock('@/sync/domains/sessionControl/sessionModeControl', () => ({
    supportsSessionModeOverrides: () => false,
}));
vi.mock('@/track', () => ({
    tracking: null,
    trackMessageSent: vi.fn(),
}));
vi.mock('@/utils/platform/platform', () => ({
    isRunningOnMac: () => false,
}));
vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => 'uuid',
}));
vi.mock('@/utils/sessions/sessionUtils', () => ({
    formatPathRelativeToHome: () => '/tmp',
    getSessionAvatarId: () => 'avatar',
    getSessionName: () => 'Session',
    listPendingPermissionRequests: () => [],
    listPendingUserActionRequests: () => [],
    shouldShowAbortButtonForSessionState: () => false,
    useSessionStatus: () => 'online',
}));
vi.mock('@/utils/system/versionUtils', () => ({
    isVersionSupported: () => true,
    MINIMUM_CLI_VERSION: '0.0.0',
}));
vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (promise: Promise<unknown> | void) => promise,
}));
vi.mock('@/capabilities/ensureAgentInstallablesBackground', () => ({
    ensureAgentInstallablesBackground: () => {},
}));
vi.mock('@/sync/domains/pending/pendingQueueWake', () => ({
    getPendingQueueWakeResumeOptions: () => null,
}));
vi.mock('@/sync/domains/permissions/permissionModeOverride', () => ({
    getPermissionModeOverrideForSpawn: () => null,
}));
vi.mock('@/sync/domains/models/modelOverride', () => ({
    getModelOverrideForSpawn: () => null,
}));
vi.mock('@/components/sessions/agentInput/routing/RecipientChip', () => ({
    RecipientChip: () => null,
}));
vi.mock('@/components/sessions/agentInput/routing/useSessionRecipientState', () => ({
    useSessionRecipientState: () => ({
        recipientId: null,
        recipientChipProps: null,
        participantSidechainIds: [],
        selectedParticipant: null,
    }),
}));
vi.mock('@/components/sessions/agentInput/routing/ExecutionRunDeliveryChip', () => ({
    ExecutionRunDeliveryChip: () => null,
}));
vi.mock('@/sync/domains/input/participants/resolveParticipantRoutedSend', async () => {
    const actual = await vi.importActual<typeof import('@/sync/domains/input/participants/resolveParticipantRoutedSend')>(
        '@/sync/domains/input/participants/resolveParticipantRoutedSend',
    );
    return {
        ...actual,
        resolveParticipantRoutedSend: () => null,
    };
});
vi.mock('@/hooks/session/useEnsureSidechainsLoaded', () => ({
    useEnsureSidechainsLoaded: () => {},
}));
vi.mock('@/hooks/session/useSessionSubagents', () => ({
    useSessionSubagents: () => ({ subagents: [], participantTargets: [], sidechainIds: [] }),
}));
vi.mock('@/agents/registry/sessionSubagentUiBehavior', () => ({
    hasSessionSubagentLaunchCards: () => false,
}));
vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
    isExecutionRunNotRunningSendError: () => false,
    sessionExecutionRunSend: vi.fn(),
}));
vi.mock('@/sync/runtime/time', () => ({
    nowServerMs: () => 0,
}));
vi.mock('@/sync/domains/session/resume/resumeSessionBase', () => ({
    buildResumeSessionBaseOptionsFromSession: () => null,
}));
vi.mock('@/sync/domains/session/resume/happierReplayPrompt', () => ({
    resolveHappierReplayConfig: () => null,
}));
vi.mock('@/sync/domains/session/control/submitMode', () => ({
    chooseSubmitMode: () => 'submit',
}));
vi.mock('@/sync/domains/session/control/sessionLocalControl', () => ({
    getSessionLocalControlState: () => null,
    isSessionLocallyAttached: () => true,
}));
vi.mock('@/sync/domains/session/control/effectiveRuntimeControlSurface', () => ({
    supportsEffectiveLocalControlForSession: () => true,
}));
vi.mock('@/sync/domains/session/subagents/deriveSessionSubagentCounts', () => ({
    deriveSessionSubagentCounts: () => ({ total: 0, active: 0 }),
}));
vi.mock('@/sync/domains/models/modelOptions', () => ({
    findModelOptionForEffectiveModelId: (options: any, effectiveModelId: any) =>
        options?.find?.((option: any) => option.value === effectiveModelId)
            ?? options?.find?.((option: any) => option.value === String(effectiveModelId ?? '').replace(/\[[^\]]*\]$/u, ''))
            ?? null,
    isModelSelectableForSession: () => true,
}));
vi.mock('@/sync/domains/session/control/localControlSwitch', () => ({
    shouldRenderChatTimelineForSession: () => true,
    shouldRequestRemoteControl: () => false,
    shouldRequestRemoteControlAfterPendingEnqueue: () => false,
}));
vi.mock('@/sync/domains/session/control/controlSwitchUiTimeout', () => ({
    readControlSwitchUiTimeoutMsFromEnv: () => 1000,
}));

describe('SessionView read cursor on blur', () => {
    beforeEach(() => {
        sessionState.current.seq = 2;
        markSessionViewedSpy.mockClear();
        scheduledInteractionCallbacks.length = 0;
    });

    it('bounds the blur read mark to the seq visible when leaving the session', async () => {
        const { useSessionViewedLifecycle } = await import('./view/useSessionViewedLifecycle');
        const hook = await renderHook((props: {
            sessionId: string;
            visibleReadSeq: number | null;
            surfaceFocused: boolean;
        }) => {
            useSessionViewedLifecycle(props);
            return null;
        }, {
            initialProps: {
                sessionId: 's1',
                visibleReadSeq: 2,
                surfaceFocused: true,
            },
        });

        // Ignore work scheduled on initial focus; we care about the blur path.
        scheduledInteractionCallbacks.length = 0;
        markSessionViewedSpy.mockClear();

        await hook.rerender({
            sessionId: 's1',
            visibleReadSeq: 2,
            surfaceFocused: false,
        });

        expect(scheduledInteractionCallbacks).toHaveLength(1);

        // Simulate a later assistant message landing after navigation away.
        sessionState.current.seq = 4;

        await act(async () => {
            const callback = scheduledInteractionCallbacks.shift();
            callback?.();
        });

        expect(markSessionViewedSpy).toHaveBeenCalledTimes(1);
        expect(markSessionViewedSpy).toHaveBeenCalledWith('s1', { sessionSeq: 2 });

        await hook.unmount();
    });

    it('uses the previous session seq when a focused session view switches sessions', async () => {
        const { useSessionViewedLifecycle } = await import('./view/useSessionViewedLifecycle');
        const hook = await renderHook((props: {
            sessionId: string;
            visibleReadSeq: number | null;
            surfaceFocused: boolean;
        }) => {
            useSessionViewedLifecycle(props);
            return null;
        }, {
            initialProps: {
                sessionId: 's1',
                visibleReadSeq: 2,
                surfaceFocused: true,
            },
        });

        scheduledInteractionCallbacks.length = 0;
        markSessionViewedSpy.mockClear();

        await hook.rerender({
            sessionId: 's2',
            visibleReadSeq: 9,
            surfaceFocused: true,
        });

        await act(async () => {
            while (scheduledInteractionCallbacks.length > 0) {
                scheduledInteractionCallbacks.shift()?.();
            }
        });

        expect(markSessionViewedSpy).toHaveBeenCalledWith('s1', { sessionSeq: 2 });
        expect(markSessionViewedSpy).toHaveBeenCalledWith('s2', { sessionSeq: 9 });
        expect(markSessionViewedSpy).not.toHaveBeenCalledWith('s1', { sessionSeq: 9 });

        await hook.unmount();
    });

    it('suppresses the focused seq-change mark when the current activation was manually held unread', async () => {
        const {
            getCurrentSessionViewingActivationId,
            holdManualUnreadForActivation,
            resetSessionManualUnreadHoldsForTests,
        } = await import('@/sync/domains/session/readState/sessionManualUnreadHold');
        resetSessionManualUnreadHoldsForTests();
        sessionState.current.seq = 4;

        const { useSessionViewedLifecycle } = await import('./view/useSessionViewedLifecycle');
        const hook = await renderHook((props: {
            sessionId: string;
            visibleReadSeq: number | null;
            surfaceFocused: boolean;
        }) => {
            useSessionViewedLifecycle(props);
            return null;
        }, {
            initialProps: {
                sessionId: 's1',
                visibleReadSeq: 4,
                surfaceFocused: true,
            },
        });

        scheduledInteractionCallbacks.length = 0;
        markSessionViewedSpy.mockClear();

        const activationId = getCurrentSessionViewingActivationId('s1');
        holdManualUnreadForActivation({ sessionId: 's1', sessionSeq: 4, activationId });

        vi.useFakeTimers();
        try {
            await hook.rerender({
                sessionId: 's1',
                visibleReadSeq: 5,
                surfaceFocused: true,
            });

            await act(async () => {
                await vi.advanceTimersByTimeAsync(300);
            });
        } finally {
            vi.useRealTimers();
        }

        expect(scheduledInteractionCallbacks).toHaveLength(0);
        expect(markSessionViewedSpy).not.toHaveBeenCalled();

        await hook.unmount();
    });

    it('reschedules focused seq-change read marks after a transient visible seq reset', async () => {
        sessionState.current.seq = 2;

        const initialHookProps: {
            sessionId: string;
            visibleReadSeq: number | null;
            surfaceFocused: boolean;
        } = {
            sessionId: 's1',
            visibleReadSeq: 2,
            surfaceFocused: true,
        };
        const { useSessionViewedLifecycle } = await import('./view/useSessionViewedLifecycle');
        const hook = await renderHook((props: {
            sessionId: string;
            visibleReadSeq: number | null;
            surfaceFocused: boolean;
        }) => {
            useSessionViewedLifecycle(props);
            return null;
        }, {
            initialProps: initialHookProps,
        });

        scheduledInteractionCallbacks.length = 0;
        markSessionViewedSpy.mockClear();

        vi.useFakeTimers();
        try {
            await hook.rerender({
                sessionId: 's1',
                visibleReadSeq: 4,
                surfaceFocused: true,
            });
            await hook.rerender({
                sessionId: 's1',
                visibleReadSeq: null,
                surfaceFocused: true,
            });
            await hook.rerender({
                sessionId: 's1',
                visibleReadSeq: 4,
                surfaceFocused: true,
            });

            await act(async () => {
                await vi.advanceTimersByTimeAsync(300);
            });
        } finally {
            vi.useRealTimers();
        }

        expect(markSessionViewedSpy).toHaveBeenCalledTimes(1);
        expect(markSessionViewedSpy).toHaveBeenCalledWith('s1', { sessionSeq: 4 });

        await hook.unmount();
    });

    it('bounds focused seq-change read marks to the seq that became visible', async () => {
        sessionState.current.seq = 2;

        const { useSessionViewedLifecycle } = await import('./view/useSessionViewedLifecycle');
        const hook = await renderHook((props: {
            sessionId: string;
            visibleReadSeq: number | null;
            surfaceFocused: boolean;
        }) => {
            useSessionViewedLifecycle(props);
            return null;
        }, {
            initialProps: {
                sessionId: 's1',
                visibleReadSeq: 2,
                surfaceFocused: true,
            },
        });

        scheduledInteractionCallbacks.length = 0;
        markSessionViewedSpy.mockClear();

        vi.useFakeTimers();
        try {
            await hook.rerender({
                sessionId: 's1',
                visibleReadSeq: 4,
                surfaceFocused: true,
            });

            // A later completion/message reaches storage before the delayed mark fires.
            sessionState.current.seq = 6;

            await act(async () => {
                await vi.advanceTimersByTimeAsync(300);
            });
        } finally {
            vi.useRealTimers();
        }

        expect(markSessionViewedSpy).toHaveBeenCalledTimes(1);
        expect(markSessionViewedSpy).toHaveBeenCalledWith('s1', { sessionSeq: 4 });

        await hook.unmount();
    });

    it('does not mark a raw session seq before the visible seq is ready', async () => {
        sessionState.current.seq = 10;

        const { useSessionViewedLifecycle } = await import('./view/useSessionViewedLifecycle');
        const hook = await renderHook((props: {
            sessionId: string;
            visibleReadSeq: number | null;
            surfaceFocused: boolean;
        }) => {
            useSessionViewedLifecycle(props);
            return null;
        }, {
            initialProps: {
                sessionId: 's1',
                visibleReadSeq: null,
                surfaceFocused: true,
            },
        });

        await act(async () => {
            while (scheduledInteractionCallbacks.length > 0) {
                scheduledInteractionCallbacks.shift()?.();
            }
        });

        expect(markSessionViewedSpy).not.toHaveBeenCalled();

        await hook.unmount();
    });

    it('marks the current session seq when opening a non-chat cockpit surface', async () => {
        const { SessionView } = await import('./SessionView');
        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionView id="s1" contentOverride={React.createElement('ContentOverride')} />
            </AppPaneProvider>,
        );

        await act(async () => {
            while (scheduledInteractionCallbacks.length > 0) {
                scheduledInteractionCallbacks.shift()?.();
            }
        });

        expect(markSessionViewedSpy).toHaveBeenCalledWith('s1', { sessionSeq: 2 });

        await screen.unmount();
    });
});
