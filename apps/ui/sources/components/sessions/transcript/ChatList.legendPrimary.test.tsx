import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import {
    buildFlashListChatListItems,
    createFlashListChatListWebScroller,
    flashListChatListHarnessState,
    renderChatList,
    requireCapturedLegendListProps,
    resetLegendChatListHarness,
    withFlashListChatListWebScrollerDom,
} from '@/dev/testkit/harness/chatListHarness';
import { installFlashListChatListCommonModuleMocks } from '@/dev/testkit/harness/chatListHarnessModuleMocks';
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

installFlashListChatListCommonModuleMocks();

vi.mock('@/components/sessions/chatListItems', () => ({
    buildChatListItems: buildFlashListChatListItems,
    buildChatListItemsCached: (options: Parameters<typeof buildFlashListChatListItems>[0]) => ({
        cache: null,
        items: buildFlashListChatListItems(options),
    }),
}));

vi.mock('@/sync/sync', async () => (
    (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListSyncModuleMock({
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
    isEnrichedMarkdownRuntimePreloaded: () => true,
    preloadEnrichedMarkdownRuntime: () => Promise.resolve(),
    useEnrichedMarkdownRuntimeStatus: () => 'ready',
}));

const { ChatList } = await import('./ChatList');

describe('ChatList Legend-primary host axis', () => {
    beforeEach(() => {
        resetLegendChatListHarness({ platformOs: 'web' });
        sessionViewportState = null;
        flashListChatListHarnessState.sessionMessagesState = {
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

    async function renderLegendPrimaryChatList() {
        return renderChatList(React.createElement(ChatList, {
            session: { ...flashListChatListHarnessState.sessionState },
        }), { flushOptions: { cycles: 0 } });
    }

    async function publishLegendPaintMetrics(
        screen: Awaited<ReturnType<typeof renderLegendPrimaryChatList>>,
        props: ReturnType<typeof requireCapturedLegendListProps>,
    ) {
        const legendRef = flashListChatListHarnessState.legendListRefHandle as {
            getState: () => Record<string, unknown>;
        };
        const readPreviousState = legendRef.getState;
        legendRef.getState = () => ({
            ...readPreviousState(),
            contentLength: 1_200,
            scrollLength: 640,
        });
        const identityHost = screen.findAllByTestId('transcript-chat-list')
            .find((node) => typeof node.props.onLayout === 'function');
        expect(identityHost).toBeTruthy();
        await act(async () => {
            identityHost?.props.onLayout({
                nativeEvent: {
                    layout: { height: 640, width: 800, x: 0, y: 0 },
                },
            });
            props.onItemSizeChanged({ index: 0, previous: 0, size: 120 });
        });
        await screen.settle();
        legendRef.getState = readPreviousState;
    }

    async function publishLegendLoadAndPhysicalSettlement(
        screen: Awaited<ReturnType<typeof renderLegendPrimaryChatList>>,
        props: ReturnType<typeof requireCapturedLegendListProps>,
    ) {
        const legendRef = flashListChatListHarnessState.legendListRefHandle as {
            getState: () => Record<string, unknown>;
        };
        const readPreviousState = legendRef.getState;
        legendRef.getState = () => ({
            ...readPreviousState(),
            end: props.data.length - 1,
            endBuffered: props.data.length - 1,
            start: 0,
            startBuffered: 0,
        });
        const scroller = createFlashListChatListWebScroller({
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
            await withFlashListChatListWebScrollerDom(scroller, async () => {
                await act(async () => {
                    props.onLoad({ elapsedTimeInMs: 20 });
                    await Promise.resolve();
                });
                await screen.settle();
                await act(async () => {
                    frames.shift()?.(0);
                    await Promise.resolve();
                });
                await screen.settle();
            }, { useImmediateAnimationFrame: false });
        } finally {
            legendRef.getState = readPreviousState;
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
        await publishLegendPaintMetrics(screen, props);
        expect(screen.findAllByTestId('transcript-first-paint-placeholder').length).toBeGreaterThan(0);
        await publishLegendLoadAndPhysicalSettlement(screen, props);
        expect(screen.findAllByTestId('transcript-first-paint-placeholder')).toHaveLength(0);
        expect(props.maintainScrollAtEnd).toEqual(expect.objectContaining({
            animated: false,
            isMaintainingScrollAtEnd: expect.any(Function),
        }));
        expect(flashListChatListHarnessState.flashListRenderCount).toBe(0);

        await screen.unmount();
    });

    it('keeps the existing first-paint placeholder visible while the initial transcript request has no rows', async () => {
        flashListChatListHarnessState.sessionMessagesState = {
            isLoaded: false,
            messages: [],
        };

        const screen = await renderLegendPrimaryChatList();

        expect(requireCapturedLegendListProps().data).toHaveLength(0);
        expect(screen.findAllByTestId('transcript-first-paint-placeholder').length).toBeGreaterThan(0);

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
        expect(flashListChatListHarnessState.flashListRenderCount).toBe(0);

        await screen.unmount();
    });

    it.each([-2, 0, 2])(
        'uses the keyed native entry-placement command for a Legend anchor at offset %i without an entry slice',
        async (itemOffsetPx) => {
            vi.clearAllMocks();
            resetLegendChatListHarness({ platformOs: 'ios' });
            sessionViewportState = {
                anchor: {
                    capturedAtMs: 1,
                    itemId: 'm4',
                    itemOffsetPx,
                    kind: 'message',
                    messageId: 'm4',
                    seq: 4,
                },
                isPinned: false,
                lastUpdatedAt: 1,
                offsetY: 240,
                source: 'observed',
            };
            flashListChatListHarnessState.sessionMessagesState = {
                isLoaded: true,
                messages: Array.from({ length: 6 }, (_, index) => ({
                    kind: index % 2 === 0 ? 'user-text' : 'agent-text',
                    id: `m${index + 1}`,
                    localId: null,
                    createdAt: index + 1,
                    seq: index + 1,
                    text: `message ${index + 1}`,
                    ...(index % 2 === 0 ? {} : { isThinking: false }),
                })),
            };

            const screen = await renderLegendPrimaryChatList();
            const props = requireCapturedLegendListProps();
            await publishLegendPaintMetrics(screen, props);
            const legendRef = flashListChatListHarnessState.legendListRefHandle as Readonly<{
                scrollToIndex: ReturnType<typeof vi.fn>;
                scrollToOffset: ReturnType<typeof vi.fn>;
            }>;

            expect(props.data.map((item: { id: string }) => item.id)).toEqual([
                'm1',
                'm2',
                'm3',
                'm4',
                'm5',
                'm6',
            ]);
            expect(flashListChatListHarnessState.legendListPropsHistory.map((renderedProps) =>
                renderedProps.data.map((item: { id: string }) => item.id)
            )).not.toContainEqual(['m1', 'm2', 'm3', 'm4']);
            expect(legendRef.scrollToIndex).toHaveBeenCalledTimes(1);
            expect(legendRef.scrollToIndex).toHaveBeenCalledWith({
                animated: false,
                index: 3,
                viewOffset: itemOffsetPx,
            });
            expect(legendRef.scrollToOffset).not.toHaveBeenCalled();
            expect(props.initialScrollAtEnd).toBe(false);
            expect(flashListChatListHarnessState.flashListRenderCount).toBe(0);

            await screen.unmount();
        },
    );

    it('uses a prepared same-session tail handoff for the incoming default Legend render', async () => {
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
                        : <ChatList session={{ ...flashListChatListHarnessState.sessionState }} />}
                </TranscriptSameSessionHandoffProvider>
            );
        }

        const screen = await renderChatList(
            <SessionRoute experience="classic" />,
            { flushOptions: { cycles: 0 } },
        );
        await screen.update(<SessionRoute experience="cockpit" />);
        await screen.settle();

        const legendProps = requireCapturedLegendListProps();
        expect(legendProps.initialScrollAtEnd).toBe(true);
        expect(screen.findAllByTestId('transcript-first-paint-placeholder').length).toBeGreaterThan(0);
        await publishLegendLoadAndPhysicalSettlement(screen, legendProps);
        expect(screen.findAllByTestId('transcript-first-paint-placeholder')).toHaveLength(0);
        expect(flashListChatListHarnessState.flashListRenderCount).toBe(0);

        await screen.unmount();
    });
});
