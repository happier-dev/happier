import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    chatListHarnessState,
    renderChatList,
    requireCapturedLegendListProps,
    resetChatListHarness,
    standardCleanup,
} from '@/dev/testkit';
import type { SessionMessagesWindowState } from '@/sync/runtime/sessionMessagesWindowState';
import {
    installTranscriptCommonModuleMocks,
    resetTranscriptCommonModuleMockState,
} from './transcriptTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

if (typeof (globalThis as any).requestAnimationFrame !== 'function') {
    (globalThis as any).requestAnimationFrame = (callback: (time: number) => void) => (
        setTimeout(() => callback(Date.now()), 0) as unknown as number
    );
    (globalThis as any).cancelAnimationFrame = (handle: number) => {
        clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
    };
}

const loadTargetWindowMessagesSpy = vi.hoisted(() => vi.fn());
const markSessionLiveTailIntentSpy = vi.hoisted(() => vi.fn());
const viewportControllerMockState = vi.hoisted(() => ({
    resolveInputs: [] as Array<Record<string, unknown>>,
}));

const inactiveTargetWindowState: SessionMessagesWindowState = {
    isWindowMode: false,
    windowId: null,
    targetSeq: null,
    windowMinSeq: null,
    windowMaxSeq: null,
    olderCursor: null,
    newerCursor: null,
    hasMoreOlder: null,
    hasMoreNewer: null,
    activatedAtMs: null,
    lifecycleEpoch: 2,
};

const activeTargetWindowState: SessionMessagesWindowState = {
    isWindowMode: true,
    windowId: 'window-100',
    targetSeq: 2,
    windowMinSeq: 1,
    windowMaxSeq: 2,
    olderCursor: 1,
    newerCursor: 2,
    hasMoreOlder: true,
    hasMoreNewer: false,
    activatedAtMs: 1,
    lifecycleEpoch: 1,
};

let targetWindowState: SessionMessagesWindowState = activeTargetWindowState;

type ChatListComponent = (typeof import('./ChatList'))['ChatList'];

installTranscriptCommonModuleMocks({
    reactNative: async () =>
        (await import('@/dev/testkit/harness/chatListHarness')).createChatListHarnessReactNativeMock({
            platformOs: 'ios',
        }),
    storage: async (importOriginal) =>
        (await import('@/dev/testkit/harness/chatListHarness')).createChatListHarnessStorageMock(importOriginal),
});

beforeEach(() => {
    vi.useFakeTimers({ now: new Date(0) });
    resetTranscriptCommonModuleMockState();
    viewportControllerMockState.resolveInputs = [];
    targetWindowState = activeTargetWindowState;
    resetChatListHarness({
        platformOs: 'ios',
    });
    chatListHarnessState.sessionState = {
        ...chatListHarnessState.sessionState,
        active: true,
        id: 'session-target-window',
        seq: 0,
        metadata: null,
        accessLevel: null,
        canApprovePermissions: true,
    };
    chatListHarnessState.settingValues.transcriptScrollPinOffsetThresholdPx = 72;
    chatListHarnessState.sessionPendingState = { messages: [], discarded: [], isLoaded: true };
    chatListHarnessState.sessionActionDraftsState = [];
    chatListHarnessState.sessionMessagesState = {
        isLoaded: true,
        messages: [
            { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, seq: 1, text: 'hi' },
            { kind: 'assistant-text', id: 'a1', localId: null, createdAt: 2, seq: 2, text: 'streaming...' },
        ],
    };
});

afterEach(() => {
    standardCleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
    resetTranscriptCommonModuleMockState();
});

vi.mock('@legendapp/list/react-native', async () =>
    (await import('@/dev/testkit/harness/chatListHarness')).createLegendChatListModuleMock()
);

vi.mock('@/utils/platform/responsive', () => ({
    useHeaderHeight: () => 0,
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/components/sessions/chatListItems', async () =>
    (await import('@/dev/testkit/harness/chatListHarness')).createChatListHarnessItemsModuleMock(({ messageIdsOldestFirst, messagesById }: any) =>
        (messageIdsOldestFirst ?? []).map((id: string) => {
            const message = messagesById?.[id];
            return { kind: 'message', id: `msg:${id}`, messageId: id, createdAt: message?.createdAt ?? 0, seq: message?.seq ?? null };
        }),
    )
);

vi.mock('./ChatFooter', () => ({
    ChatFooter: () => React.createElement('ChatFooter'),
}));

vi.mock('./MessageView', () => ({
    MessageView: () => React.createElement('MessageView'),
    MessageViewWithSessionCommon: () => React.createElement('MessageViewWithSessionCommon'),
}));

vi.mock('@/components/sessions/pending/PendingMessagesTranscriptBlock', () => ({
    PendingMessagesTranscriptBlock: () => React.createElement('PendingMessagesTranscriptBlock'),
}));

vi.mock('@/components/sessions/actions/SessionActionDraftCard', () => ({
    SessionActionDraftCard: () => React.createElement('SessionActionDraftCard'),
}));

vi.mock('@/components/sessions/transcript/turns/TurnView', () => ({
    TurnView: () => React.createElement('TurnView'),
    TurnViewWithSessionCommon: () => React.createElement('TurnViewWithSessionCommon'),
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptMotionProvider', () => ({
    TranscriptMotionProvider: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/sessions/transcript/motion/resolveTranscriptMotionConfig', () => ({
    resolveTranscriptMotionConfig: () => ({ preset: 'off', animateThinkingEnabled: false }),
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptEnterWrapper', () => ({
    TranscriptEnterWrapper: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/sessions/transcript/scroll/JumpToBottomButton', () => ({
    JumpToBottomButton: (props: any) => React.createElement('JumpToBottomButton', props),
}));

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => false,
}));

vi.mock('@/sync/domains/state/agentStateCapabilities', () => ({
    getPermissionsInUiWhileLocal: () => ({}),
}));

vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (p: Promise<unknown>) => p,
}));

vi.mock('@/sync/sync', async () =>
    (await import('@/dev/testkit/harness/chatListHarness')).createChatListHarnessSyncModuleMock({
        getSessionTargetWindowState: () => targetWindowState,
        hasDeferredNewerMessages: () => false,
        loadTargetWindowMessages: loadTargetWindowMessagesSpy,
        loadOlderMessages: vi.fn(async () => ({ loaded: 0, hasMore: false, status: 'no_more' as const })),
        loadNewerMessages: vi.fn(),
        markSessionLiveTailIntent: markSessionLiveTailIntentSpy,
    })
);

vi.mock('@/components/sessions/transcript/viewport/createTranscriptViewportController', async () => {
    const actual = await vi.importActual<typeof import('@/components/sessions/transcript/viewport/createTranscriptViewportController')>(
        '@/components/sessions/transcript/viewport/createTranscriptViewportController',
    );
    return {
        ...actual,
        createTranscriptViewportController: () => {
            const controller = actual.createTranscriptViewportController();
            return {
                ...controller,
                resolve: (input: Parameters<typeof controller.resolve>[0]) => {
                    viewportControllerMockState.resolveInputs.push(input as unknown as Record<string, unknown>);
                    return controller.resolve(input);
                },
            };
        },
    };
});

async function primeAtBottom(screen: Awaited<ReturnType<typeof renderChatList>>) {
    chatListHarnessState.legendListState = { contentLength: 1200, scrollLength: 600 };
    const legendProps = requireCapturedLegendListProps();
    await act(async () => {
        legendProps.onLoad?.({ elapsedTimeInMs: 12 });
    });
    await screen.settle({ advanceTimersMs: 160, cycles: 1, turns: 1 });
    loadTargetWindowMessagesSpy.mockReset();
    markSessionLiveTailIntentSpy.mockReset();
    viewportControllerMockState.resolveInputs = [];
}

describe('ChatList target-window active live-tail gating', () => {
    it('pages the active target window at the older (top) edge', async () => {
        loadTargetWindowMessagesSpy.mockResolvedValue({
            status: 'loaded',
            windowId: 'window-100',
            targetSeq: 2,
            targetPresent: true,
        });
        const { ChatList } = await import('./ChatList');
        const screen = await renderChatList(
            <ChatList session={chatListHarnessState.sessionState} />,
        );
        await primeAtBottom(screen);

        await act(async () => {
            requireCapturedLegendListProps().onStartReached?.();
            await Promise.resolve();
        });

        expect(loadTargetWindowMessagesSpy).toHaveBeenCalledWith(
            'session-target-window',
            { kind: 'seq', seq: 2 },
            { direction: 'older' },
        );
        expect(markSessionLiveTailIntentSpy).not.toHaveBeenCalled();
    });

    it('exits target-window mode through live-tail intent at the newest edge when no newer pages remain', async () => {
        const { ChatList } = await import('./ChatList');
        const screen = await renderChatList(
            <ChatList session={chatListHarnessState.sessionState} />,
        );
        await primeAtBottom(screen);

        await act(async () => {
            requireCapturedLegendListProps().onEndReached?.();
            await Promise.resolve();
        });

        expect(loadTargetWindowMessagesSpy).not.toHaveBeenCalled();
        expect(markSessionLiveTailIntentSpy).toHaveBeenCalledWith('session-target-window');
    });
});
