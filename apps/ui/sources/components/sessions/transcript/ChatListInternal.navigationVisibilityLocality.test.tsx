import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createOkFetchResponse, createRootLayoutFeaturesResponse, getServerFetchUrl, standardCleanup } from '@/dev/testkit';
import {
    flashListChatListHarnessState,
    renderFlashListChatListSession,
    resetFlashListChatListHarness,
} from '@/dev/testkit/harness/chatListHarness';
import { installFlashListChatListCommonModuleMocks } from '@/dev/testkit/harness/chatListHarnessModuleMocks';
import { createInactiveSessionMessagesWindowState } from '@/sync/runtime/sessionMessagesWindowState';
import { resetUserMessageHistoryRemoteEntriesForTests } from '@/hooks/session/useUserMessageHistory';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { Message } from '@/sync/domains/messages/messageTypes';

import { getTranscriptNavigationVisibilityStore } from './viewport/visibility/transcriptNavigationVisibilityStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const persistedStorage = vi.hoisted(() => new Map<string, string>());
const loadOlderMessagesMock = vi.hoisted(() => vi.fn());
const loadNewerMessagesMock = vi.hoisted(() => vi.fn());
const loadTargetWindowMessagesMock = vi.hoisted(() => vi.fn());
const fetchUserMessageHistoryPageMock = vi.hoisted(() => vi.fn());
const markSessionLiveTailIntentMock = vi.hoisted(() => vi.fn());
const getSessionTargetWindowStateMock = vi.hoisted(() => vi.fn());
const prefetchForkedTranscriptContextMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));

const buildChatListItemsMock = vi.fn((opts: Readonly<{
    messageIdsOldestFirst?: readonly string[];
    messagesById?: Readonly<Record<string, Message>>;
}>) => (opts.messageIdsOldestFirst ?? []).map((id) => {
    const message = opts.messagesById?.[id];
    return {
        kind: 'message',
        id,
        messageId: id,
        createdAt: message?.createdAt ?? 0,
        seq: typeof message?.seq === 'number' ? message.seq : null,
    };
}));

vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return persistedStorage.get(key);
        }

        set(key: string, value: string) {
            persistedStorage.set(key, value);
        }

        delete(key: string) {
            persistedStorage.delete(key);
        }

        getAllKeys() {
            return [...persistedStorage.keys()];
        }

        clearAll() {
            persistedStorage.clear();
        }
    }

    return { MMKV };
});

installFlashListChatListCommonModuleMocks();

vi.mock('@/components/sessions/chatListItems', async () => (
    (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListItemsModuleMock(buildChatListItemsMock)
));

vi.mock('@/sync/sync', async () => (
    (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListSyncModuleMock({
        fetchUserMessageHistoryPage: fetchUserMessageHistoryPageMock,
        loadOlderMessages: loadOlderMessagesMock,
        loadNewerMessages: loadNewerMessagesMock,
        loadTargetWindowMessages: loadTargetWindowMessagesMock,
        prefetchForkedTranscriptContext: prefetchForkedTranscriptContextMock,
        getSessionViewport: () => null,
        markSessionLiveTailIntent: markSessionLiveTailIntentMock,
        getSessionTargetWindowState: getSessionTargetWindowStateMock,
    })
));

const activeScope: ServerAccountScope = { serverId: 'server-a', accountId: 'account-a' };

/** Two user turns: the rail needs at least two markers to be visible at all. */
function seedTranscriptMessages() {
    flashListChatListHarnessState.sessionMessagesState = {
        isLoaded: true,
        messages: [
            {
                kind: 'user-text',
                id: 'u1',
                localId: 'u1',
                createdAt: 1,
                text: 'Install the dependencies',
                seq: 7,
                transcriptBlockIndex: 0,
            },
            {
                kind: 'agent-text',
                id: 'a1',
                localId: 'a1',
                createdAt: 2,
                text: 'Dependencies are installed',
                seq: 7,
                transcriptBlockIndex: 1,
                isThinking: false,
            },
            {
                kind: 'user-text',
                id: 'u2',
                localId: 'u2',
                createdAt: 3,
                text: 'Run the tests',
                seq: 12,
                transcriptBlockIndex: 0,
            },
        ],
    };
}

/** The FlashList surface answers its visible window from the recycler handle. */
function flashListSurfaceRefHandle(visibleRange: { startIndex: number; endIndex: number }) {
    return {
        scrollToOffset: vi.fn(),
        scrollToIndex: vi.fn(),
        computeVisibleIndices: vi.fn(() => visibleRange),
    };
}

const FIRST_TURN_ANCHOR = 'session-1:user-turn:7';
const SECOND_TURN_ANCHOR = 'session-1:user-turn:12';

describe('ChatList navigation visibility locality', () => {
    beforeEach(() => {
        // History discovery loads server capabilities; settle that HTTP boundary
        // before measuring renders caused by navigation visibility changes.
        const features = createRootLayoutFeaturesResponse();
        vi.stubGlobal('fetch', vi.fn<typeof fetch>((input) => {
            const url = getServerFetchUrl(input);
            if (url.pathname !== '/v1/features') {
                throw new Error(`Unexpected request: ${url}`);
            }
            return createOkFetchResponse(features);
        }));
        persistedStorage.clear();
        loadOlderMessagesMock.mockReset();
        loadNewerMessagesMock.mockReset();
        loadTargetWindowMessagesMock.mockReset();
        fetchUserMessageHistoryPageMock.mockReset();
        fetchUserMessageHistoryPageMock.mockResolvedValue({
            status: 'loaded',
            rows: [],
            hasMore: false,
            nextBeforeSeq: null,
        });
        prefetchForkedTranscriptContextMock.mockClear();
        markSessionLiveTailIntentMock.mockReset();
        getSessionTargetWindowStateMock.mockReset();
        const inactiveWindowState = createInactiveSessionMessagesWindowState();
        getSessionTargetWindowStateMock.mockImplementation(() => inactiveWindowState);
        buildChatListItemsMock.mockClear();
        resetFlashListChatListHarness({
            flashListRefHandle: flashListSurfaceRefHandle({ startIndex: 0, endIndex: 2 }),
            syncTuningState: { transcriptLegendListSpikeSurface: 'flashList' },
        });
        flashListChatListHarnessState.activeServerAccountScope = activeScope;
        flashListChatListHarnessState.sessionState = {
            ...flashListChatListHarnessState.sessionState,
            id: 'session-1',
            seq: 12,
            active: true,
            metadata: { flavor: 'codex', codexBackendMode: 'appServer' },
        };
        flashListChatListHarnessState.settingValues.transcriptGroupingMode = 'linear';
        flashListChatListHarnessState.settingValues.transcriptGroupToolCalls = false;
        resetUserMessageHistoryRemoteEntriesForTests();
        seedTranscriptMessages();
    });

    afterEach(() => {
        act(() => {
            getTranscriptNavigationVisibilityStore('session-1').set(null);
        });
        standardCleanup();
        vi.unstubAllGlobals();
    });

    it('publishes a live anchor from the FlashList surface as soon as a consumer subscribes, with no scroll', async () => {
        const store = getTranscriptNavigationVisibilityStore('session-1');
        // Narrow viewport: the rail stays hidden, so nothing is subscribed while
        // the transcript settles — exactly the state a reader is in before they
        // open the navigation panel.
        const screen = await renderFlashListChatListSession();
        await screen.triggerInitialFill({
            layoutHeight: 600,
            layoutWidth: 500,
            contentHeight: 1800,
            flushOptions: { turns: 2 },
        });

        expect(store.hasSubscribers()).toBe(false);
        expect(store.get().currentAnchorId).toBeNull();

        let unsubscribe = () => {};
        try {
            await act(async () => {
                unsubscribe = store.subscribe(vi.fn());
            });
            await screen.settle({ turns: 2 });

            expect(store.get().currentAnchorId).toBe(FIRST_TURN_ANCHOR);
        } finally {
            unsubscribe();
        }
    });

    // Regression: the host used to gate publication on its OWN measured layout
    // height as well as the renderer's window. On web that state stays 0 for this
    // shell, so a renderer reporting a perfectly good window (observed live:
    // startIndex 56 / endIndex 64, 4 anchors) was still discarded as
    // `unmeasured-viewport` and no marker ever became active. "Am I measured" is
    // the renderer's fact alone.
    it('publishes an anchor from the renderer window even when the host never measures a layout height', async () => {
        const store = getTranscriptNavigationVisibilityStore('session-1');
        const screen = await renderFlashListChatListSession();
        await screen.triggerInitialFill({
            layoutHeight: 0,
            layoutWidth: 500,
            contentHeight: 1800,
            flushOptions: { turns: 2 },
        });

        let unsubscribe = () => {};
        try {
            await act(async () => {
                unsubscribe = store.subscribe(vi.fn());
            });
            await screen.settle({ turns: 2 });

            expect(store.get().currentAnchorId).toBe(FIRST_TURN_ANCHOR);
        } finally {
            unsubscribe();
        }
    });

    it('keeps an anchor crossing inside the rail instead of re-rendering the transcript host', async () => {
        const store = getTranscriptNavigationVisibilityStore('session-1');
        const screen = await renderFlashListChatListSession();
        // Wide viewport: the real rail mounts and subscribes for itself.
        await screen.triggerInitialFill({
            layoutHeight: 600,
            layoutWidth: 1200,
            contentHeight: 1800,
            flushOptions: { turns: 2 },
        });
        await screen.settle({ turns: 2 });

        expect(screen.findByTestId(`transcript-navigation-rail.marker:${FIRST_TURN_ANCHOR}`)
            ?.props.accessibilityState?.selected).toBe(true);
        const hostRendersBeforeCrossing = flashListChatListHarnessState.flashListRenderCount;

        await act(async () => {
            store.set({
                currentAnchorId: SECOND_TURN_ANCHOR,
                visibleAnchorIds: [SECOND_TURN_ANCHOR],
            });
        });

        expect(screen.findByTestId(`transcript-navigation-rail.marker:${SECOND_TURN_ANCHOR}`)
            ?.props.accessibilityState?.selected).toBe(true);
        expect(screen.findByTestId(`transcript-navigation-rail.marker:${FIRST_TURN_ANCHOR}`)
            ?.props.accessibilityState?.selected).toBe(false);
        expect(flashListChatListHarnessState.flashListRenderCount).toBe(hostRendersBeforeCrossing);
    });
});
