import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { renderHook, renderScreen } from '@/dev/testkit';
import { getActiveViewingSessionActivationId } from '@/sync/domains/session/activeViewingSession';
import {
    beginSessionViewingActivation,
    holdManualUnreadForActivation,
    resetSessionManualUnreadHoldsForTests,
    shouldSuppressAutomaticMarkViewed,
} from '@/sync/domains/session/readState/sessionManualUnreadHold';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { resolveSessionReadableSeq } from '@/sync/domains/session/readCursor/resolveSessionReadableSeq';
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
const transcriptState = vi.hoisted(() => ({
    ids: [] as string[],
    messagesById: {} as Record<string, any>,
    isLoaded: true,
    latestReadyEventSeq: null as number | null,
    latestReadyEventAt: null as number | null,
}));
const focusCleanupState = vi.hoisted(() => ({ current: null as null | (() => void) }));

function getStorageStateForTest() {
    return {
        sessions: { s1: sessionState.current },
        settings: {},
        localSettings: {},
        sessionListViewDataByServerId: {},
    };
}

vi.mock('react-native-reanimated', () => {
    const Animated = {
        View: 'Animated.View',
        createAnimatedComponent: (component: unknown) => component,
    };
    return {
        __esModule: true,
        default: Animated,
        ...Animated,
        useAnimatedProps: (factory: () => unknown) => factory(),
        useAnimatedStyle: (factory: () => unknown) => factory(),
        useSharedValue: (initial: unknown) => ({ value: initial }),
    };
});
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
    useFocusEffect: (effect: () => void | (() => void)) => {
        React.useEffect(() => {
            const cleanup = effect();
            let active = true;
            const runCleanup = () => {
                if (!active) return;
                active = false;
                cleanup?.();
                if (focusCleanupState.current === runCleanup) {
                    focusCleanupState.current = null;
                }
            };
            focusCleanupState.current = runCleanup;
            return runCleanup;
        }, [effect]);
    },
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
vi.mock('@/hooks/session/useDraft', () => ({
    useDraft: () => ({ clearDraft: vi.fn(), setDraftValue: vi.fn() }),
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
        markSessionLiveTailIntent: () => {},
        sendMessage: async () => {},
        enqueuePendingMessage: async () => {},
        submitMessage: async () => {},
        encryption: { getMachineEncryption: () => null },
        onSessionViewportChange: () => {},
    },
}));
vi.mock('@/sync/ops', () => ({
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
        const { localSettingsDefaults } = await import('@/sync/domains/settings/localSettings');
        const readLocalSetting = <K extends keyof LocalSettings>(key: K): LocalSettings[K] => {
            const overrides: Partial<LocalSettings> = {
                acknowledgedCliVersions: {},
                detailsPaneTabsBehavior: 'preview',
                rightPaneWidthPx: 360,
                rightPaneWidthBasisPx: 1200,
                detailsPaneWidthPx: 520,
                detailsPaneWidthBasisPx: 1200,
                sessionsRightPaneDefaultOpen: false,
                uiMultiPanePanelsEnabled: true,
            };
            return (overrides[key] ?? localSettingsDefaults[key]) as LocalSettings[K];
        };
        return createStorageModuleStub({
            storage: Object.assign(
                (selector?: (state: any) => unknown) => {
                    const state = {
                        ...getStorageStateForTest(),
                        localSettings: localSettingsDefaults,
                    };
                    return typeof selector === 'function' ? selector(state) : state;
                },
                {
                    getState: () => ({
                        ...getStorageStateForTest(),
                        localSettings: localSettingsDefaults,
                    }),
                },
                // Boundary fixture: this mimics Zustand's callable store plus getState shape.
            ) as any,
            useSession: () => sessionState.current,
            useAutomations: () => [],
            useSessionAutomationsEnabledCount: () => 0,
            useOpenApprovalArtifactsForSession: () => [],
            useIsDataReady: () => true,
            useRealtimeStatus: () => ({ current: { status: 'connected' } as any }),
            useSessionMessages: () => ({ messages: [], isLoaded: true }),
            useSessionSubagentSourceMessages: () => [],
            useSessionTranscriptIds: () => ({ ids: transcriptState.ids, isLoaded: transcriptState.isLoaded }),
            // Mirror the real useSessionVisibleReadSeq selector: resolve the number through the
            // genuine readable-seq logic from this test's transcript fixture so read-cursor
            // assertions exercise real behavior rather than a hand-picked constant.
            useSessionVisibleReadSeq: (
                _sessionId: string,
                params: { sessionSeq: number | null; latestTurnStatus: unknown },
            ) => {
                if (!transcriptState.isLoaded) return null;
                const messages = transcriptState.ids
                    .map((id) => transcriptState.messagesById[id])
                    .filter((message): message is Record<string, unknown> => Boolean(message));
                return resolveSessionReadableSeq({
                    messages: messages as any,
                    sessionSeq: params.sessionSeq,
                    latestReadyEventSeq: transcriptState.latestReadyEventSeq,
                    latestTurnStatus: params.latestTurnStatus as any,
                    includeTerminalSessionSeq: true,
                });
            },
            useSessionPendingMessages: () => ({ messages: [] }),
            useSessionReviewCommentsDrafts: () => [],
            useSessionUsage: () => null,
            useSetting: () => null,
            useSettings: () => ({ experiments: true, featureToggles: {} }),
            useLocalSettings: () => localSettingsDefaults,
            useLocalSetting: readLocalSetting,
            useLocalSettingMutable: <K extends keyof LocalSettings>(key: K) => [
                readLocalSetting(key),
                vi.fn<(value: LocalSettings[K]) => void>(),
            ],
        });
    },
});
vi.mock('@/sync/store/settingsWriters', () => ({
    useApplyLocalSettings: () => vi.fn(),
}));
vi.mock('@/agents/catalog/catalog', async () => {
    const actual = await vi.importActual<typeof import('@/agents/catalog/catalog')>('@/agents/catalog/catalog');
    return {
        ...actual,
        buildResumeSessionExtrasFromUiState: () => null,
    };
});
vi.mock('@/agents/runtime/resumeCapabilities', () => ({
    canResumeSessionWithOptions: () => false,
    canContinueSessionWithFreshSpawn: () => false,
}));
vi.mock('@/agents/hooks/useResumeCapabilityOptions', () => ({
    useResumeCapabilityOptions: () => [],
}));
vi.mock('@/sync/domains/input/reviewComments/reviewCommentPrompt', () => ({
    buildReviewCommentsDisplayText: () => '',
    buildReviewCommentsPromptText: () => '',
    filterReviewCommentDraftsIncludedInPrompt: (drafts: readonly unknown[]) => drafts,
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
    shouldReadTranscriptForPendingRequests: () => true,
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
    // The in-session Agent picker reads this to decide whether a transcript can be
    // handed to another Agent. An absent `direct` flag means it can, which is the
    // ordinary case these read-cursor tests exercise.
    resolveEffectiveSessionRuntimeControlSurface: () => ({ sessionStorage: {} }),
}));
vi.mock('@/sync/domains/models/modelOptions', () => ({
    findModelOptionForEffectiveModelId: (options: readonly any[], id: string) =>
        (options ?? []).find((o: any) => o.value === id) ?? (options ?? []).find((o: any) => o.extendedContextModelId === id) ?? null,
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
        sessionState.current.latestTurnStatus = null;
        transcriptState.ids = ['m2'];
        transcriptState.messagesById = {
            m2: { id: 'm2', kind: 'agent-text', seq: 2, localId: null, createdAt: 2, text: 'visible' },
        };
        transcriptState.isLoaded = true;
        transcriptState.latestReadyEventSeq = null;
        transcriptState.latestReadyEventAt = null;
        markSessionViewedSpy.mockClear();
        scheduledInteractionCallbacks.length = 0;
        focusCleanupState.current = null;
        resetSessionManualUnreadHoldsForTests();
    });

    it('bounds the blur read mark to the seq visible when leaving the session', async () => {
        const { SessionView } = await import('./SessionView');

        let tree: renderer.ReactTestRenderer | undefined;
        tree = (await renderScreen(<AppPaneProvider>
                    <SessionView id="s1" />
                </AppPaneProvider>)).tree;

        expect(focusCleanupState.current).toBeTypeOf('function');

        // Ignore work scheduled on initial focus; we care about the blur path.
        scheduledInteractionCallbacks.length = 0;
        markSessionViewedSpy.mockClear();

        act(() => {
            focusCleanupState.current?.();
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

        act(() => {
            tree?.unmount();
        });
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

    it('marks the current session seq when opening a non-chat cockpit surface', async () => {
        const { SessionView } = await import('./SessionView');

        let tree: renderer.ReactTestRenderer | undefined;
        tree = (await renderScreen(<AppPaneProvider>
                    <SessionView id="s1" contentOverride={React.createElement('ContentOverride')} />
                </AppPaneProvider>)).tree;

        expect(scheduledInteractionCallbacks.length).toBeGreaterThan(0);

        await act(async () => {
            while (scheduledInteractionCallbacks.length > 0) {
                scheduledInteractionCallbacks.shift()?.();
            }
        });

        expect(markSessionViewedSpy).toHaveBeenCalledWith('s1', { sessionSeq: 2 });

        act(() => {
            tree?.unmount();
        });
    });

    it('bounds focused seq-change read marks to the seq that became visible', async () => {
        const { useSessionViewedLifecycle } = await import('./view/useSessionViewedLifecycle');
        const hook = await renderHook(({ visibleReadSeq }: { visibleReadSeq: number | null }) => {
            useSessionViewedLifecycle({
                sessionId: 's1',
                surfaceFocused: true,
                visibleReadSeq,
            });
        }, {
            initialProps: { visibleReadSeq: 2 },
        });

        scheduledInteractionCallbacks.length = 0;
        markSessionViewedSpy.mockClear();

        vi.useFakeTimers();
        try {
            await hook.rerender({ visibleReadSeq: 4 });

            // A later completion/message reaches storage before the delayed mark fires.
            sessionState.current.seq = 6;
            transcriptState.latestReadyEventSeq = 6;

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

    it('reschedules focused seq-change read marks after a transient visible seq reset', async () => {
        const { useSessionViewedLifecycle } = await import('./view/useSessionViewedLifecycle');
        type RenderHookProps = { visibleReadSeq: number | null };
        const initialProps: RenderHookProps = { visibleReadSeq: 2 };
        const hook = await renderHook(({ visibleReadSeq }: RenderHookProps) => {
            useSessionViewedLifecycle({
                sessionId: 's1',
                surfaceFocused: true,
                visibleReadSeq,
            });
        }, {
            initialProps,
        });

        scheduledInteractionCallbacks.length = 0;
        markSessionViewedSpy.mockClear();

        vi.useFakeTimers();
        try {
            await hook.rerender({ visibleReadSeq: 4 });
            await hook.rerender({ visibleReadSeq: null });
            await hook.rerender({ visibleReadSeq: 4 });

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

    it('does not mark a raw session seq before transcript hydration is ready', async () => {
        transcriptState.isLoaded = false;
        sessionState.current.seq = 10;

        const { SessionView } = await import('./SessionView');

        let tree: renderer.ReactTestRenderer | undefined;
        tree = (await renderScreen(<AppPaneProvider>
                    <SessionView id="s1" />
                </AppPaneProvider>)).tree;

        await act(async () => {
            while (scheduledInteractionCallbacks.length > 0) {
                scheduledInteractionCallbacks.shift()?.();
            }
        });

        expect(markSessionViewedSpy).not.toHaveBeenCalled();

        act(() => {
            tree?.unmount();
        });
    });

    it('does not mark viewed on blur when manual unread is held for the current activation', async () => {
        const { SessionView } = await import('./SessionView');

        let tree: renderer.ReactTestRenderer | undefined;
        tree = (await renderScreen(<AppPaneProvider>
                    <SessionView id="s1" />
                </AppPaneProvider>)).tree;

        scheduledInteractionCallbacks.length = 0;
        markSessionViewedSpy.mockClear();

        holdManualUnreadForActivation({
            sessionId: 's1',
            sessionSeq: 2,
            activationId: getActiveViewingSessionActivationId(),
        });

        act(() => {
            focusCleanupState.current?.();
        });

        expect(scheduledInteractionCallbacks).toHaveLength(0);
        expect(markSessionViewedSpy).not.toHaveBeenCalled();

        act(() => {
            tree?.unmount();
        });
    });

    it('does not mark viewed on focused seq changes when manual unread is held for the current activation', async () => {
        const { SessionView } = await import('./SessionView');

        let tree: renderer.ReactTestRenderer | undefined;
        tree = (await renderScreen(<AppPaneProvider>
                    <SessionView id="s1" />
                </AppPaneProvider>)).tree;

        scheduledInteractionCallbacks.length = 0;
        markSessionViewedSpy.mockClear();

        holdManualUnreadForActivation({
            sessionId: 's1',
            sessionSeq: 2,
            activationId: getActiveViewingSessionActivationId(),
        });

        vi.useFakeTimers();
        try {
            act(() => {
                sessionState.current.seq = 4;
                tree?.update(<AppPaneProvider>
                    <SessionView id="s1" />
                </AppPaneProvider>);
            });

            await act(async () => {
                await vi.advanceTimersByTimeAsync(300);
            });
        } finally {
            vi.useRealTimers();
        }

        expect(markSessionViewedSpy).not.toHaveBeenCalled();

        act(() => {
            tree?.unmount();
        });
    });

    it('preserves another activation unread hold when the current activation auto-marks read on blur', async () => {
        const { SessionView } = await import('./SessionView');

        let tree: renderer.ReactTestRenderer | undefined;
        tree = (await renderScreen(<AppPaneProvider>
                    <SessionView id="s1" />
                </AppPaneProvider>)).tree;

        scheduledInteractionCallbacks.length = 0;
        markSessionViewedSpy.mockClear();

        const currentActivationId = getActiveViewingSessionActivationId();
        expect(currentActivationId).not.toBeNull();
        const otherActivationId = beginSessionViewingActivation('s1');
        expect(otherActivationId).not.toBe(currentActivationId);
        holdManualUnreadForActivation({
            sessionId: 's1',
            sessionSeq: 2,
            activationId: otherActivationId,
        });
        expect(shouldSuppressAutomaticMarkViewed({ sessionId: 's1', sessionSeq: 2, activationId: otherActivationId })).toBe(true);

        act(() => {
            focusCleanupState.current?.();
        });

        expect(scheduledInteractionCallbacks).toHaveLength(1);
        expect(shouldSuppressAutomaticMarkViewed({ sessionId: 's1', sessionSeq: 2, activationId: otherActivationId })).toBe(true);

        await act(async () => {
            const callback = scheduledInteractionCallbacks.shift();
            callback?.();
        });

        expect(markSessionViewedSpy).toHaveBeenCalledTimes(1);
        expect(shouldSuppressAutomaticMarkViewed({ sessionId: 's1', sessionSeq: 2, activationId: otherActivationId })).toBe(true);

        act(() => {
            tree?.unmount();
        });
    });
});
