import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit';
import {
    buildChatListHarnessItems,
    chatListHarnessState,
    createChatListHarnessWebScroller,
    renderChatList,
    requireCapturedLegendListProps,
    resetChatListHarness,
    withChatListHarnessWebScrollerDom,
} from '@/dev/testkit/harness/chatListHarness';
import { installChatListHarnessCommonModuleMocks } from '@/dev/testkit/harness/chatListHarnessModuleMocks';
import {
    TranscriptSameSessionHandoffProvider,
    useTranscriptSameSessionHandoffRoute,
} from './viewport/lifecycle/transcriptSameSessionHandoff';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let sessionViewportState: Readonly<{
    anchor: Readonly<{
        capturedAtMs: number;
        itemId: string;
        itemOffsetPx: number;
        kind: 'message';
        messageId: string;
        seq?: number;
    }> | null;
    isPinned: boolean;
    lastUpdatedAt: number;
    offsetY: number;
    source: 'default' | 'observed';
}> | null = null;

const markdownRuntimeMockState = vi.hoisted(() => ({
    listeners: new Set<() => void>(),
    preload: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    status: 'ready' as 'pending' | 'ready' | 'failed',
}));

function setMarkdownRuntimeStatus(status: 'pending' | 'ready' | 'failed'): void {
    markdownRuntimeMockState.status = status;
    for (const listener of markdownRuntimeMockState.listeners) {
        listener();
    }
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
    (await import('@/dev/testkit/harness/chatListHarness')).createChatListHarnessSyncModuleMock({
        getSessionViewport: () => sessionViewportState,
    })
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

vi.mock('@/components/markdown/enriched/preloadEnrichedMarkdownRuntime', () => ({
    isEnrichedMarkdownRuntimePreloaded: () => markdownRuntimeMockState.status === 'ready',
    preloadEnrichedMarkdownRuntime: markdownRuntimeMockState.preload,
    useEnrichedMarkdownRuntimeStatus: () => React.useSyncExternalStore(
        (listener) => {
            markdownRuntimeMockState.listeners.add(listener);
            return () => {
                markdownRuntimeMockState.listeners.delete(listener);
            };
        },
        () => markdownRuntimeMockState.status,
        () => markdownRuntimeMockState.status,
    ),
}));

const { ChatList } = await import('./ChatList');

describe('ChatList Legend-primary host axis', () => {
    beforeEach(() => {
        resetChatListHarness({ platformOs: 'web' });
        sessionViewportState = null;
        chatListHarnessState.sessionMessagesState = {
            isLoaded: true,
            messages: [
                { kind: 'user-text', id: 'oldest', localId: null, createdAt: 1, text: 'first' },
                { kind: 'agent-text', id: 'newest', localId: null, createdAt: 2, text: 'second', isThinking: false },
            ],
        };
        markdownRuntimeMockState.listeners.clear();
        markdownRuntimeMockState.preload.mockReset();
        markdownRuntimeMockState.preload.mockImplementation(() => Promise.resolve());
        markdownRuntimeMockState.status = 'ready';
    });

    afterEach(() => {
        standardCleanup();
    });

    async function renderLegendPrimaryChatList() {
        return renderChatList(React.createElement(ChatList, {
            session: { ...chatListHarnessState.sessionState },
        }), { flushOptions: { cycles: 0 } });
    }

    async function publishLegendLoadAndPhysicalSettlement(
        screen: Awaited<ReturnType<typeof renderLegendPrimaryChatList>>,
        props: ReturnType<typeof requireCapturedLegendListProps>,
        afterLoad?: () => void | Promise<void>,
    ) {
        const previousState = chatListHarnessState.legendListState;
        chatListHarnessState.legendListState = {
            contentLength: 1_200,
            end: props.data.length - 1,
            endBuffered: props.data.length - 1,
            scroll: 560,
            scrollLength: 640,
            start: 0,
            startBuffered: 0,
        };
        const scroller = createChatListHarnessWebScroller({
            clientHeight: 640,
            scrollHeight: 1_200,
            scrollTop: 560,
        });
        const frames: FrameRequestCallback[] = [];
        const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
        const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
        globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
            frames.push(callback);
            return frames.length;
        };
        globalThis.cancelAnimationFrame = () => {};
        try {
            await withChatListHarnessWebScrollerDom(scroller, async () => {
                await act(async () => {
                    props.onLoad({ elapsedTimeInMs: 20 });
                    await Promise.resolve();
                });
                await screen.settle();
                await afterLoad?.();
                await screen.settle();
                await act(async () => {
                    frames.shift()?.(0);
                    await Promise.resolve();
                });
                await screen.settle();
            }, { useImmediateAnimationFrame: false });
        } finally {
            chatListHarnessState.legendListState = previousState;
            globalThis.requestAnimationFrame = previousRequestAnimationFrame;
            globalThis.cancelAnimationFrame = previousCancelAnimationFrame;
        }
    }

    it('uses Legend as the default composed host and starts live-tail entries at the end', async () => {
        const screen = await renderLegendPrimaryChatList();
        const props = requireCapturedLegendListProps();

        expect(props.data.map((item: { id: string }) => item.id)).toEqual(['oldest', 'newest']);
        expect(props.initialScrollAtEnd).toBe(true);
        expect(screen.findAllByTestId('transcript-first-paint-placeholder').length).toBeGreaterThan(0);
        await publishLegendLoadAndPhysicalSettlement(screen, props);
        expect(screen.findAllByTestId('transcript-first-paint-placeholder')).toHaveLength(0);
        expect(props.maintainScrollAtEnd).toEqual(expect.objectContaining({
            animated: false,
            isMaintainingScrollAtEnd: expect.any(Function),
        }));

        await screen.unmount();
    });

    it('keeps the existing first-paint placeholder visible while the initial transcript request has no rows', async () => {
        chatListHarnessState.sessionMessagesState = {
            isLoaded: false,
            messages: [],
        };

        const screen = await renderLegendPrimaryChatList();

        expect(requireCapturedLegendListProps().data).toHaveLength(0);
        expect(screen.findAllByTestId('transcript-first-paint-placeholder').length).toBeGreaterThan(0);

        await screen.unmount();
    });

    it('keeps the Markdown runtime cover after Legend first paint until readiness publishes', async () => {
        setMarkdownRuntimeStatus('pending');

        const screen = await renderLegendPrimaryChatList();
        const props = requireCapturedLegendListProps();

        expect(screen.findAllByTestId('transcript-first-paint-placeholder')).not.toHaveLength(0);
        await publishLegendLoadAndPhysicalSettlement(screen, props, async () => {
            expect(screen.findAllByTestId('transcript-first-paint-placeholder')).not.toHaveLength(0);
            act(() => {
                setMarkdownRuntimeStatus('ready');
            });
        });

        expect(screen.findAllByTestId('transcript-first-paint-placeholder')).toHaveLength(0);

        await screen.unmount();
    });

    it('keeps an observed detached entry unpinned on the Legend host', async () => {
        sessionViewportState = {
            anchor: null,
            isPinned: false,
            lastUpdatedAt: 1,
            offsetY: 320,
            source: 'observed',
        };

        const screen = await renderLegendPrimaryChatList();
        const props = requireCapturedLegendListProps();

        expect(props.initialScrollAtEnd).toBe(false);

        await screen.unmount();
    });

    it('uses a staged same-session tail handoff for the incoming default Legend render', async () => {
        sessionViewportState = {
            anchor: null,
            isPinned: false,
            lastUpdatedAt: 1,
            offsetY: 320,
            source: 'observed',
        };
        const outgoingMountToken = {};

        function OutgoingTranscript() {
            const route = useTranscriptSameSessionHandoffRoute();
            React.useLayoutEffect(() => route.registerProducer({
                captureForHandoff: () => ({
                    source: 'physical-exit',
                    viewport: {
                        anchor: null,
                        capturedAtMs: 20,
                        isPinned: true,
                        offsetY: 0,
                        shouldRestoreViewport: false,
                    },
                }),
                experience: 'classic',
                mountToken: outgoingMountToken,
                sessionId: 'session-1',
            }), [route]);
            return null;
        }

        function SessionRoute(props: Readonly<{ experience: 'classic' | 'cockpit' }>) {
            return (
                <TranscriptSameSessionHandoffProvider
                    desiredExperience={props.experience}
                    sessionId="session-1"
                >
                    {(experience) => experience === 'classic'
                        ? <OutgoingTranscript />
                        : <ChatList session={{ ...chatListHarnessState.sessionState }} />}
                </TranscriptSameSessionHandoffProvider>
            );
        }

        const screen = await renderChatList(
            <SessionRoute experience="classic" />,
            { flushOptions: { cycles: 0 } },
        );
        await screen.update(<SessionRoute experience="cockpit" />);
        await screen.settle();

        expect(requireCapturedLegendListProps().initialScrollAtEnd).toBe(true);

        await screen.unmount();
    });
});
