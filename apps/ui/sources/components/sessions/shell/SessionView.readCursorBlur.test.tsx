import * as React from 'react';
import { createReactNavigationNativeMock } from '@/dev/testkit/mocks/reactNavigation';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { renderScreen as renderCanonicalScreen } from '@/dev/testkit/render/renderScreen';
import 'fake-indexeddb/auto';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createSessionFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

let markSessionViewedSpy: MockInstance<typeof import('@/sync/sync')['sync']['markSessionViewed']>;
const readCursorRequests: Array<{ homeUrl: string; input: unknown }> = [];
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary(socket => {
    vi.mocked(socket.connect).mockImplementation(() => {
        socket.connected = true;
        for (const listener of socket.listeners('connect')) listener();
        return socket;
    });
    vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event: string, input: unknown) => {
        if (event === 'update-read-cursor') {
            readCursorRequests.push({ homeUrl: socket.io.uri, input });
            return { result: 'success', lastViewedSessionSeq: (input as { lastViewedSessionSeq: number }).lastViewedSessionSeq };
        }
        return { v: 1, ok: true, admittedSessionIds: [] };
    });
});
const scheduledInteractionCallbacks = vi.hoisted<(() => void)[]>(() => []);
const sessionState = vi.hoisted(() => ({
    current: {
        id: 's1',
        serverId: 'server-1',
        seq: 2,
        presence: 'online',
        active: true,
        accessLevel: 'edit',
        modelMode: { defaultMode: 'build' },
        metadata: { machineId: 'm1', flavor: 'codex', version: '0.0.0', path: '/tmp', homeDir: '/tmp' },
        agentState: {},
    } as any,
}));
vi.mock('expo-linear-gradient', () => ({
    LinearGradient: 'LinearGradient',
}));
vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));
vi.mock('react-native-safe-area-context', () => ({
    initialWindowMetrics: null,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@react-navigation/native', () => ({
    ...createReactNavigationNativeMock(),
    useFocusEffect: () => {},
    useIsFocused: () => true,
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
vi.mock('@/voice/session/voiceSession', () => ({
    useVoiceSessionSnapshot: () => ({ status: 'disconnected' }),
    voiceSessionManager: {},
}));
vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
    createDefaultActionExecutor: () => ({ execute: vi.fn() }),
}));
vi.mock('@/components/sessions/agentInput', () => ({
    AgentInput: () => null,
}));
installSessionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            useWindowDimensions: () => ({ width: 1200, height: 800 }),
            Platform: { OS: 'ios' },
            InteractionManager: { runAfterInteractions: (callback: () => void) => {
                scheduledInteractionCallbacks.push(callback);
                return { cancel: () => {} };
            } },
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
    storage: async importOriginal => importOriginal(),
});
vi.mock('@/sync/store/settingsWriters', () => ({
    useApplyLocalSettings: () => vi.fn(),
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
vi.mock('@/components/sessions/agentInput/routing/ExecutionRunRequestedActionChip', () => ({
    ExecutionRunRequestedActionChip: () => null,
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
    resolveEffectiveConfiguredRuntimeControlSurface: () => ({ localControl: { supported: true } }),
}));
vi.mock('@/sync/domains/models/modelOptions', () => ({
    findModelOptionForEffectiveModelId: (options: any, effectiveModelId: any) =>
        options?.find?.((option: any) => option.value === effectiveModelId)
            ?? options?.find?.((option: any) => option.value === String(effectiveModelId ?? '').replace(/\[[^\]]*\]$/u, ''))
            ?? null,
    isModelSelectableForSession: () => true,
}));
vi.mock('@/sync/domains/session/control/localControlSwitch', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/session/control/localControlSwitch')>(),
    shouldRenderChatTimelineForSession: () => true,
}));
vi.mock('@/sync/domains/session/control/controlSwitchUiTimeout', () => ({
    readControlSwitchUiTimeoutMsFromEnv: () => 1000,
}));

vi.doUnmock('@/sync/domains/state/storage');
vi.doUnmock('@/hooks/session/useDraft');
vi.doUnmock('@/agents/registry/registryUiBehavior');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { storage } = await import('@/sync/domains/state/storage');
let account: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
let previousStorage: ReturnType<typeof storage.getState>;
function applyVisibleFixtureSeq(seq: number) {
    sessionState.current.seq = seq;
    storage.getState().applySessions([{ ...storage.getState().sessions.s1!, seq }]);
}
async function renderScreen(...args: Parameters<typeof renderCanonicalScreen>) {
    storage.getState().applySessions([createSessionFixture({ ...sessionState.current, accessLevel: 'owner', serverId: account.home.id })]);
    return renderCanonicalScreen(<InjectedAuthProvider credentials={account.credentials}>{args[0]}</InjectedAuthProvider>, args[1]);
}

describe('SessionView read cursor on blur', () => {
    beforeEach(async () => {
        previousStorage = storage.getState();
        await home.reset();
        await home.addHome({ name: 'Cursor Home', serverUrl: 'https://server-1', accountId: 'account-a' });
        await home.addHome({ name: 'Previous Home', serverUrl: 'https://home-b', accountId: 'account-a', active: false });
        await home.addHome({ name: 'Next Home', serverUrl: 'https://home-a', accountId: 'account-a', active: false });
        await loadSyncSingletonForTests();
        account = await restoreServerAccountForTest({ serverUrl: 'https://server-1', request: async url => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (path.endsWith('/pending')) return Response.json({ pending: [] });
            if (path.endsWith('/messages')) return Response.json({ messages: [], hasMore: false, nextBeforeSeq: null });
            return new Response('{}', { status: 404 });
        } });
        sessionState.current = createSessionFixture({ ...sessionState.current, serverId: account.home.id, accessLevel: 'owner', seq: 2 });
        storage.getState().applySessions([sessionState.current, createSessionFixture({ id: 's2', serverId: account.home.id, seq: 9 })]);
        storage.getState().applyServerScopedSessionListRows('home-b', [createSessionListRenderableSessionFixture({ id: 'same-session', seq: 2 })], { source: 'rowOnly', mode: 'append' });
        storage.setState({ isDataReady: true });
        const { sync } = await import('@/sync/sync');
        markSessionViewedSpy = vi.spyOn(sync, 'markSessionViewed');
        markSessionViewedSpy.mockClear();
        readCursorRequests.length = 0;
        scheduledInteractionCallbacks.length = 0;
    });

    afterEach(async () => {
        vi.useRealTimers();
        await standardCleanup();
        const { scmStatusSync } = await import('@/scm/scmStatusSync');
        scmStatusSync.stop('s1', account.home.id);
        markSessionViewedSpy.mockRestore();
        await account.dispose();
        await home.reset();
        storage.setState(previousStorage, true);
    });

    it('bounds the blur read mark to the seq visible when leaving the session', async () => {
        const { useSessionViewedLifecycle } = await import('./view/useSessionViewedLifecycle');
        const hook = await renderHook((props: {
            address: { serverId: string; sessionId: string };
            visibleReadSeq: number | null;
            surfaceFocused: boolean;
        }) => {
            useSessionViewedLifecycle(props);
            return null;
        }, {
            initialProps: {
                address: { serverId: 'server-1', sessionId: 's1' },
                visibleReadSeq: 2,
                surfaceFocused: true,
            },
        });

        // Ignore work scheduled on initial focus; we care about the blur path.
        scheduledInteractionCallbacks.length = 0;
        markSessionViewedSpy.mockClear();

        await hook.rerender({
            address: { serverId: 'server-1', sessionId: 's1' },
            visibleReadSeq: 2,
            surfaceFocused: false,
        });

        expect(scheduledInteractionCallbacks).toHaveLength(1);

        // Simulate a later assistant message landing after navigation away.
        applyVisibleFixtureSeq(4);

        await act(async () => {
            const callback = scheduledInteractionCallbacks.shift();
            callback?.();
        });

        expect(markSessionViewedSpy).toHaveBeenCalledTimes(1);
        expect(markSessionViewedSpy).toHaveBeenCalledWith({ serverId: 'server-1', sessionId: 's1' }, { sessionSeq: 2 });
        await waitForHomeGovernance(() => expect(readCursorRequests).toEqual([
            { homeUrl: 'https://server-1', input: { sid: 's1', lastViewedSessionSeq: 2 } },
        ]));
        expect(storage.getState().sessions.s1?.lastViewedSessionSeq).toBe(2);

        await hook.unmount();
    });

    it('keeps a deferred blur mark bound to the Home observed before focus changes', async () => {
        const { useSessionViewedLifecycle } = await import('./view/useSessionViewedLifecycle');
        const hook = await renderHook((props: {
            address: { serverId: string; sessionId: string };
            visibleReadSeq: number | null;
            surfaceFocused: boolean;
        }) => {
            useSessionViewedLifecycle(props);
            return null;
        }, {
            initialProps: {
                address: { serverId: 'home-b', sessionId: 'same-session' },
                visibleReadSeq: 2,
                surfaceFocused: true,
            },
        });

        scheduledInteractionCallbacks.length = 0;
        markSessionViewedSpy.mockClear();

        await hook.rerender({
            address: { serverId: 'home-a', sessionId: 'same-session' },
            visibleReadSeq: 9,
            surfaceFocused: false,
        });

        expect(scheduledInteractionCallbacks).toHaveLength(1);
        await act(async () => {
            scheduledInteractionCallbacks.shift()?.();
        });

        expect(markSessionViewedSpy).toHaveBeenCalledTimes(1);
        expect(markSessionViewedSpy).toHaveBeenCalledWith(
            { serverId: 'home-b', sessionId: 'same-session' },
            { sessionSeq: 2 },
        );
        await waitForHomeGovernance(() => expect(readCursorRequests).toEqual([
            { homeUrl: 'https://home-b', input: { sid: 'same-session', lastViewedSessionSeq: 2 } },
        ]));
        expect(storage.getState().sessionListRowsByServerId['home-b']?.['same-session']?.lastViewedSessionSeq).toBe(2);

        await hook.unmount();
    });

    it('uses the previous session seq when a focused session view switches sessions', async () => {
        const { useSessionViewedLifecycle } = await import('./view/useSessionViewedLifecycle');
        const hook = await renderHook((props: {
            address: { serverId: string; sessionId: string };
            visibleReadSeq: number | null;
            surfaceFocused: boolean;
        }) => {
            useSessionViewedLifecycle(props);
            return null;
        }, {
            initialProps: {
                address: { serverId: 'server-1', sessionId: 's1' },
                visibleReadSeq: 2,
                surfaceFocused: true,
            },
        });

        scheduledInteractionCallbacks.length = 0;
        markSessionViewedSpy.mockClear();

        await hook.rerender({
            address: { serverId: 'server-1', sessionId: 's2' },
            visibleReadSeq: 9,
            surfaceFocused: true,
        });

        await act(async () => {
            while (scheduledInteractionCallbacks.length > 0) {
                scheduledInteractionCallbacks.shift()?.();
            }
        });

        expect(markSessionViewedSpy).toHaveBeenCalledWith({ serverId: 'server-1', sessionId: 's1' }, { sessionSeq: 2 });
        expect(markSessionViewedSpy).toHaveBeenCalledWith({ serverId: 'server-1', sessionId: 's2' }, { sessionSeq: 9 });
        expect(markSessionViewedSpy).not.toHaveBeenCalledWith({ serverId: 'server-1', sessionId: 's1' }, { sessionSeq: 9 });

        await hook.unmount();
    });

    it('suppresses the focused seq-change mark when the current activation was manually held unread', async () => {
        const {
            getCurrentSessionViewingActivationId,
            holdManualUnreadForActivation,
            resetSessionManualUnreadHoldsForTests,
        } = await import('@/sync/domains/session/readState/sessionManualUnreadHold');
        resetSessionManualUnreadHoldsForTests();
        applyVisibleFixtureSeq(4);

        const { useSessionViewedLifecycle } = await import('./view/useSessionViewedLifecycle');
        const hook = await renderHook((props: {
            address: { serverId: string; sessionId: string };
            visibleReadSeq: number | null;
            surfaceFocused: boolean;
        }) => {
            useSessionViewedLifecycle(props);
            return null;
        }, {
            initialProps: {
                address: { serverId: 'server-1', sessionId: 's1' },
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
                address: { serverId: 'server-1', sessionId: 's1' },
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
        applyVisibleFixtureSeq(2);

        const initialHookProps: {
            address: { serverId: string; sessionId: string };
            visibleReadSeq: number | null;
            surfaceFocused: boolean;
        } = {
            address: { serverId: 'server-1', sessionId: 's1' },
            visibleReadSeq: 2,
            surfaceFocused: true,
        };
        const { useSessionViewedLifecycle } = await import('./view/useSessionViewedLifecycle');
        const hook = await renderHook((props: {
            address: { serverId: string; sessionId: string };
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
                address: { serverId: 'server-1', sessionId: 's1' },
                visibleReadSeq: 4,
                surfaceFocused: true,
            });
            await hook.rerender({
                address: { serverId: 'server-1', sessionId: 's1' },
                visibleReadSeq: null,
                surfaceFocused: true,
            });
            await hook.rerender({
                address: { serverId: 'server-1', sessionId: 's1' },
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
        expect(markSessionViewedSpy).toHaveBeenCalledWith({ serverId: 'server-1', sessionId: 's1' }, { sessionSeq: 4 });

        await hook.unmount();
    });

    it('bounds focused seq-change read marks to the seq that became visible', async () => {
        applyVisibleFixtureSeq(2);

        const { useSessionViewedLifecycle } = await import('./view/useSessionViewedLifecycle');
        const hook = await renderHook((props: {
            address: { serverId: string; sessionId: string };
            visibleReadSeq: number | null;
            surfaceFocused: boolean;
        }) => {
            useSessionViewedLifecycle(props);
            return null;
        }, {
            initialProps: {
                address: { serverId: 'server-1', sessionId: 's1' },
                visibleReadSeq: 2,
                surfaceFocused: true,
            },
        });

        scheduledInteractionCallbacks.length = 0;
        markSessionViewedSpy.mockClear();

        vi.useFakeTimers();
        try {
            await hook.rerender({
                address: { serverId: 'server-1', sessionId: 's1' },
                visibleReadSeq: 4,
                surfaceFocused: true,
            });

            // A later completion/message reaches storage before the delayed mark fires.
            applyVisibleFixtureSeq(6);

            await act(async () => {
                await vi.advanceTimersByTimeAsync(300);
            });
        } finally {
            vi.useRealTimers();
        }

        expect(markSessionViewedSpy).toHaveBeenCalledTimes(1);
        expect(markSessionViewedSpy).toHaveBeenCalledWith({ serverId: 'server-1', sessionId: 's1' }, { sessionSeq: 4 });

        await hook.unmount();
    });

    it('does not mark a raw session seq before the visible seq is ready', async () => {
        applyVisibleFixtureSeq(10);

        const { useSessionViewedLifecycle } = await import('./view/useSessionViewedLifecycle');
        const hook = await renderHook((props: {
            address: { serverId: string; sessionId: string };
            visibleReadSeq: number | null;
            surfaceFocused: boolean;
        }) => {
            useSessionViewedLifecycle(props);
            return null;
        }, {
            initialProps: {
                address: { serverId: 'server-1', sessionId: 's1' },
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

        expect(markSessionViewedSpy).toHaveBeenCalledWith({ serverId: 'server-1', sessionId: 's1' }, { sessionSeq: 2 });

        await screen.unmount();
    });
});
