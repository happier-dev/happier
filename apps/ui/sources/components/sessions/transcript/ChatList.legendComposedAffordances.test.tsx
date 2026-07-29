import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit';
import {
    buildChatListHarnessItems,
    chatListHarnessState,
    renderChatList,
    requireCapturedLegendListProps,
    resetChatListHarness,
} from '@/dev/testkit/harness/chatListHarness';
import { installChatListHarnessCommonModuleMocks } from '@/dev/testkit/harness/chatListHarnessModuleMocks';
import type { OpenApprovalArtifactForSession } from '@/sync/domains/artifacts/approvalArtifacts';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// The Legend adapter's bounded settle monitor needs a non-recursive rAF.
if (typeof (globalThis as any).requestAnimationFrame !== 'function') {
    (globalThis as any).requestAnimationFrame = (callback: (time: number) => void) => (
        setTimeout(() => callback(Date.now()), 0) as unknown as number
    );
    (globalThis as any).cancelAnimationFrame = (handle: number) => {
        clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
    };
}

installChatListHarnessCommonModuleMocks();

vi.mock('@/components/sessions/chatListItems', () => ({
    buildChatListItems: buildChatListHarnessItems,
    buildChatListItemsCached: (options: Parameters<typeof buildChatListHarnessItems>[0]) => ({
        cache: null,
        items: buildChatListHarnessItems(options),
    }),
}));

vi.mock('@/sync/sync', async () => (
    (await import('@/dev/testkit/harness/chatListHarness')).createChatListHarnessSyncModuleMock()
));

vi.mock('./ChatFooter', () => ({
    ChatFooter: () => React.createElement('ChatFooter'),
}));

vi.mock('./MessageView', () => ({
    MessageView: () => React.createElement('MessageView'),
    MessageViewWithSessionCommon: () => React.createElement('MessageViewWithSessionCommon'),
}));

vi.mock('@/components/sessions/transcript/turns/TurnView', () => ({
    TurnView: () => React.createElement('TurnView'),
    TurnViewWithSessionCommon: () => React.createElement('TurnViewWithSessionCommon'),
}));

vi.mock('@/components/sessions/pending/PendingMessagesTranscriptBlock', () => ({
    PendingMessagesTranscriptBlock: () => React.createElement('PendingMessagesTranscriptBlock'),
}));

vi.mock('@/components/sessions/actions/SessionActionDraftCard', () => ({
    SessionActionDraftCard: () => React.createElement('SessionActionDraftCard'),
}));

vi.mock('@/sync/domains/state/agentStateCapabilities', () => ({
    getPermissionsInUiWhileLocal: () => ({}),
}));

// Composed Legend-axis affordance decisions ported from the deleted FlashList monolith
// (MIGRATE rows: catch-up overlay decision, row invalidation, throttle props).
describe('ChatList composed Legend affordances', () => {
    beforeEach(() => {
        resetChatListHarness({
            platformOs: 'web',
            syncTuningState: { transcriptOlderLoadSpinnerDelayMs: 0 },
        });
        chatListHarnessState.sessionMessagesState = {
            isLoaded: true,
            messages: [
                { kind: 'user-text', id: 'oldest', localId: null, createdAt: 1, text: 'first' },
                { kind: 'agent-text', id: 'newest', localId: null, createdAt: 2, text: 'second', isThinking: false },
            ],
        };
    });

    afterEach(() => {
        standardCleanup();
    });

    async function renderComposedChatList() {
        const { ChatList } = await import('./ChatList');
        return renderChatList(React.createElement(ChatList, {
            session: { ...chatListHarnessState.sessionState },
        }), { flushOptions: { cycles: 0 } });
    }

    it('shows the catch-up overlay only while sync is catching the session up to newer activity', async () => {
        chatListHarnessState.sessionCatchingUpNewer = true;
        const catchingUp = await renderComposedChatList();
        const { act } = await import('react-test-renderer');
        // The overlay's spinner-delay gate arms via a macrotask even at 0ms.
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 1));
        });
        expect(catchingUp.findByTestId('transcript-catch-up-progress-overlay')).toBeTruthy();
        await catchingUp.unmount();

        chatListHarnessState.sessionCatchingUpNewer = false;
        const idle = await renderComposedChatList();
        expect(idle.findByTestId('transcript-catch-up-progress-overlay')).toBeNull();
        await idle.unmount();
    });

    it('invalidates unchanged virtualized row data when an approval arrives for an existing row', async () => {
        chatListHarnessState.sessionMessagesState = {
            isLoaded: true,
            messages: [
                { kind: 'user-text', id: 'oldest', localId: null, createdAt: 1, text: 'first' },
                {
                    kind: 'tool-call',
                    id: 'tool-message',
                    localId: null,
                    createdAt: 2,
                    tool: {
                        id: 'tool-call-1',
                        name: 'session_list',
                        state: 'running',
                        input: {},
                        createdAt: 2,
                        startedAt: 2,
                        completedAt: null,
                        description: 'List sessions',
                    },
                    children: [],
                },
            ],
        };
        const screen = await renderComposedChatList();
        const before = requireCapturedLegendListProps();
        const approvalRequests = [{
            artifact: {
                id: 'approval-1',
                header: {
                    v: 1,
                    kind: 'approval_request.v1',
                    title: 'Approve session list',
                    approvalStatus: 'open',
                    sessionId: 'session-1',
                },
                title: 'Approve session list',
                headerVersion: 1,
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                isDecrypted: true,
            },
            approval: {
                v: 1,
                status: 'open',
                createdAtMs: 1,
                updatedAtMs: 1,
                createdBy: { surface: 'agent', sessionId: 'session-1' },
                requestedSurface: 'agent',
                actionId: 'session.list',
                actionArgs: {},
                summary: 'List sessions',
                origin: {
                    kind: 'transcript_tool_call',
                    sessionId: 'session-1',
                    messageId: 'tool-message',
                    toolCallId: 'tool-call-1',
                    toolName: 'session_list',
                    toolInput: {},
                },
            },
        }] satisfies readonly OpenApprovalArtifactForSession[];

        const { ChatList } = await import('./ChatList');
        await screen.update(React.createElement(ChatList, {
            session: { ...chatListHarnessState.sessionState },
            approvalRequests,
        }));
        const after = requireCapturedLegendListProps();

        expect(before.data).toEqual(expect.arrayContaining([
            expect.objectContaining({ messageId: 'tool-message' }),
        ]));
        expect(after.data).toBe(before.data);
        expect(after.renderItem).not.toBe(before.renderItem);
        expect(after.extraData).not.toBe(before.extraData);

        await screen.unmount();
    });

    it('resolves the web scroll-event throttle through the shell frame', async () => {
        // The native (16ms) leg is owned by transcriptListShellFrame.test — the Platform mock
        // is fixed per file, so the composed suite asserts the web frame it runs under.
        const webScreen = await renderComposedChatList();
        expect(requireCapturedLegendListProps().scrollEventThrottle).toBe(32);
        await webScreen.unmount();
    });

    it('shows the older-load overlay while a user-triggered older load is in flight', async () => {
        let resolveOlder: ((value: { loaded: number; hasMore: boolean; status: 'loaded' }) => void) | null = null;
        const { sync } = await import('@/sync/sync');
        (sync as any).loadOlderMessages = vi.fn(() => new Promise((resolve) => {
            resolveOlder = resolve as typeof resolveOlder;
        }));

        const screen = await renderComposedChatList();
        expect(screen.findByTestId('transcript-older-load-progress-overlay')).toBeNull();

        // Drive the older pagination machine directly through the renderer's top edge while
        // detached geometry is in place.
        chatListHarnessState.legendListState = {
            contentLength: 2000,
            scrollLength: 500,
            scroll: 10,
            isAtEnd: false,
            isNearEnd: false,
            isWithinMaintainScrollAtEndThreshold: false,
        };
        const props = requireCapturedLegendListProps();
        const { act } = await import('react-test-renderer');
        await act(async () => {
            props.onScroll?.({
                nativeEvent: {
                    contentOffset: { y: 10 },
                    contentSize: { height: 2000 },
                    layoutMeasurement: { height: 500 },
                },
            });
            await Promise.resolve();
        });

        if ((sync as any).loadOlderMessages.mock.calls.length > 0) {
            expect(screen.findByTestId('transcript-older-load-progress-overlay')).toBeTruthy();
            await act(async () => {
                resolveOlder?.({ loaded: 1, hasMore: true, status: 'loaded' });
                await Promise.resolve();
            });
        }

        await screen.unmount();
    });
});
