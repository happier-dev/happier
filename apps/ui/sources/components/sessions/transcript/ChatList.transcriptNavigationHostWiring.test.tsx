import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit';
import {
    flashListChatListHarnessState,
    renderFlashListChatListSession,
    resetFlashListChatListHarness,
} from '@/dev/testkit/harness/chatListHarness';
import { installFlashListChatListCommonModuleMocks } from '@/dev/testkit/harness/chatListHarnessModuleMocks';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { PersistedSessionMessagePinV1 } from '@/sync/domains/messages/pins/sessionMessagePins';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { resetUserMessageHistoryRemoteEntriesForTests } from '@/hooks/session/useUserMessageHistory';
import type { TranscriptNavigationEntry } from './navigation/transcriptNavigationTypes';
import type { TranscriptNavigationRailJumpRequest } from './navigation/TranscriptNavigationRail';
import { getTranscriptNavigationVisibilityStore } from '@/components/sessions/transcript/viewport/visibility/transcriptNavigationVisibilityStore';
import type { TranscriptViewportCommand } from './viewport/transcriptViewportTypes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const persistedStorage = vi.hoisted(() => new Map<string, string>());
const loadOlderMessagesMock = vi.hoisted(() => vi.fn());
const loadNewerMessagesMock = vi.hoisted(() => vi.fn());
const loadTargetWindowMessagesMock = vi.hoisted(() => vi.fn());
const fetchUserMessageHistoryPageMock = vi.hoisted(() => vi.fn());
const prefetchForkedTranscriptContextMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const jumpToTranscriptSeqMock = vi.hoisted(() => vi.fn(async (params: {
    targetSeq: number;
    getIndex: () => number | null;
    scrollToIndex: (index: number) => void;
}) => {
    const index = params.getIndex();
    if (index !== null) {
        params.scrollToIndex(index);
        return { status: 'scrolled' as const };
    }
    return { status: 'not_found' as const };
}));
const performTranscriptViewportCommandMock = vi.hoisted(() => vi.fn((_command: TranscriptViewportCommand) => true));

let capturedNavigationRailProps: Array<{
    entries: readonly TranscriptNavigationEntry[];
    onJumpToEntry: (entry: TranscriptNavigationEntry, request: TranscriptNavigationRailJumpRequest) => void;
}> = [];

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

vi.mock('./navigation/TranscriptNavigationRail', () => ({
    TranscriptNavigationRail: (props: {
        entries: readonly TranscriptNavigationEntry[];
        onJumpToEntry: (entry: TranscriptNavigationEntry, request: TranscriptNavigationRailJumpRequest) => void;
    }) => {
        capturedNavigationRailProps.push(props);
        return React.createElement(
            'TranscriptNavigationRail',
            { testID: 'mounted-transcript-navigation-rail' },
            props.entries.map((entry) => React.createElement(
                'Pressable',
                {
                    key: entry.id,
                    testID: `mounted-nav-entry:${entry.kind}:${entry.seq ?? 'none'}`,
                    onPress: () => props.onJumpToEntry(entry, {
                        align: entry.kind === 'user-turn' ? 'top' : 'center',
                        scope: { kind: 'main', sessionId: entry.sessionId },
                        source: 'rail',
                        target: entry.routeMessageId
                            ? {
                                kind: 'route-message-id',
                                routeMessageId: entry.routeMessageId,
                                seqHint: entry.seq,
                                transcriptBlockIndex: entry.transcriptBlockIndex,
                                role: entry.role,
                            }
                            : { kind: 'seq', seq: entry.seq ?? 0 },
                    }),
                },
                entry.label,
            )),
        );
    },
}));

vi.mock('@/components/sessions/transcript/navigation/TranscriptNavigationRail', () => ({
    TranscriptNavigationRail: (props: {
        entries: readonly TranscriptNavigationEntry[];
        onJumpToEntry: (entry: TranscriptNavigationEntry, request: TranscriptNavigationRailJumpRequest) => void;
    }) => {
        capturedNavigationRailProps.push(props);
        return React.createElement(
            'TranscriptNavigationRail',
            { testID: 'mounted-transcript-navigation-rail' },
            props.entries.map((entry) => React.createElement(
                'Pressable',
                {
                    key: entry.id,
                    testID: `mounted-nav-entry:${entry.kind}:${entry.seq ?? 'none'}`,
                    onPress: () => props.onJumpToEntry(entry, {
                        align: entry.kind === 'user-turn' ? 'top' : 'center',
                        scope: { kind: 'main', sessionId: entry.sessionId },
                        source: 'rail',
                        target: entry.routeMessageId
                            ? {
                                kind: 'route-message-id',
                                routeMessageId: entry.routeMessageId,
                                seqHint: entry.seq,
                                transcriptBlockIndex: entry.transcriptBlockIndex,
                                role: entry.role,
                            }
                            : { kind: 'seq', seq: entry.seq ?? 0 },
                    }),
                },
                entry.label,
            )),
        );
    },
}));

vi.mock('@/utils/sessions/jumpToTranscriptSeq', () => ({
    jumpToTranscriptSeq: jumpToTranscriptSeqMock,
}));

vi.mock('./viewport/performTranscriptViewportCommand', () => ({
    performTranscriptViewportCommand: performTranscriptViewportCommandMock,
    resolveIndexScrollWriter: () => 'web-dom-restore',
}));

vi.mock('@/components/sessions/transcript/viewport/performTranscriptViewportCommand', () => ({
    performTranscriptViewportCommand: performTranscriptViewportCommandMock,
    resolveIndexScrollWriter: () => 'web-dom-restore',
}));

vi.mock('./ChatFooter', () => ({
    ChatFooter: () => React.createElement('ChatFooter'),
}));

vi.mock('./MessageView', () => ({
    MessageView: (props: Record<string, unknown>) => React.createElement('MessageView', props),
    MessageViewWithSessionCommon: (props: Record<string, unknown>) => React.createElement('MessageViewWithSessionCommon', props),
}));

vi.mock('@/components/sessions/transcript/toolCalls/ToolCallsGroupRow', () => ({
    ToolCallsGroupRow: (props: Record<string, unknown>) => React.createElement('ToolCallsGroupRow', props),
    ToolCallsGroupRowWithSessionCommon: (props: Record<string, unknown>) => React.createElement('ToolCallsGroupRowWithSessionCommon', props),
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

vi.mock('@/components/sessions/transcript/motion/TranscriptMotionProvider', () => ({
    TranscriptMotionProvider: (props: React.PropsWithChildren) => React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptEnterWrapper', () => ({
    TranscriptEnterWrapper: (props: React.PropsWithChildren) => React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/components/sessions/transcript/scroll/JumpToBottomButton', () => ({
    JumpToBottomButton: () => null,
}));

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => false,
}));

vi.mock('@/components/markdown/enriched/preloadEnrichedMarkdownRuntime', () => ({
    isEnrichedMarkdownRuntimePreloaded: () => true,
    preloadEnrichedMarkdownRuntime: () => Promise.resolve(),
}));

vi.mock('@/sync/domains/state/agentStateCapabilities', () => ({
    getPermissionsInUiWhileLocal: () => ({}),
}));

vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (promise: Promise<unknown> | unknown) => promise,
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession', () => ({
    usePreferredServerIdForSession: () => 'server-a',
}));

vi.mock('@/sync/domains/features/featureDecisionRuntime', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/features/featureDecisionRuntime')>();
    return {
        ...actual,
        useServerFeaturesSnapshotForServerId: () => ({
            status: 'ready',
            features: {
                capabilities: {
                    session: {
                        messages: {
                            role: true,
                        },
                    },
                },
            },
        }),
    };
});

vi.mock('@/sync/sync', async () => (
    (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListSyncModuleMock({
        fetchUserMessageHistoryPage: fetchUserMessageHistoryPageMock,
        loadOlderMessages: loadOlderMessagesMock,
        loadNewerMessages: loadNewerMessagesMock,
        loadTargetWindowMessages: loadTargetWindowMessagesMock,
        prefetchForkedTranscriptContext: prefetchForkedTranscriptContextMock,
        getSessionViewport: () => null,
    })
));

const activeScope: ServerAccountScope = { serverId: 'server-a', accountId: 'account-a' };

function pin(overrides: Partial<PersistedSessionMessagePinV1> = {}): PersistedSessionMessagePinV1 {
    return {
        version: 1,
        sessionId: 'session-1',
        seq: 7,
        transcriptBlockIndex: 1,
        routeMessageId: 'local:a1',
        role: 'assistant',
        pinnedAtMs: 1_000,
        label: null,
        ...overrides,
    };
}

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

describe('ChatList transcript navigation host wiring', () => {
    beforeEach(() => {
        persistedStorage.clear();
        loadOlderMessagesMock.mockReset();
        loadNewerMessagesMock.mockReset();
        loadTargetWindowMessagesMock.mockReset();
        fetchUserMessageHistoryPageMock.mockReset();
        fetchUserMessageHistoryPageMock.mockResolvedValue({
            status: 'loaded',
            entries: [],
            hasMore: false,
            nextBeforeSeq: null,
        });
        prefetchForkedTranscriptContextMock.mockClear();
        jumpToTranscriptSeqMock.mockClear();
        performTranscriptViewportCommandMock.mockClear();
        capturedNavigationRailProps = [];
        buildChatListItemsMock.mockClear();
        resetFlashListChatListHarness();
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
        flashListChatListHarnessState.settingValues.toolViewTimelineChromeMode = 'cards';
        resetUserMessageHistoryRemoteEntriesForTests();
    });

    afterEach(() => {
        act(() => {
            getTranscriptNavigationVisibilityStore('session-1').set(null);
        });
        standardCleanup();
    });

    it('derives mounted navigation entries from loaded user messages and pins, then jumps through the existing viewport path', async () => {
        const { savePersistedSessionMessagePins } = await import('@/sync/domains/state/sessionMessagePinsPersistence');
        const assistantPin = pin();
        savePersistedSessionMessagePins('session-1', [assistantPin], activeScope);
        seedTranscriptMessages();

        const screen = await renderFlashListChatListSession();

        const latestRailProps = capturedNavigationRailProps.at(-1);
        expect(latestRailProps?.entries.map((entry) => ({
            kind: entry.kind,
            seq: entry.seq,
            transcriptBlockIndex: entry.transcriptBlockIndex,
            role: entry.role,
            pinned: entry.pinned,
            promptPreview: entry.promptPreview,
            responsePreview: entry.responsePreview,
        }))).toEqual([
            {
                kind: 'user-turn',
                seq: 7,
                transcriptBlockIndex: 0,
                role: 'user',
                pinned: false,
                promptPreview: 'Install the dependencies',
                responsePreview: 'Dependencies are installed',
            },
            {
                kind: 'pinned-assistant',
                seq: 7,
                transcriptBlockIndex: 1,
                role: 'assistant',
                pinned: true,
                promptPreview: 'Install the dependencies',
                responsePreview: 'Dependencies are installed',
            },
            {
                kind: 'user-turn',
                seq: 12,
                transcriptBlockIndex: 0,
                role: 'user',
                pinned: false,
                promptPreview: 'Run the tests',
                responsePreview: null,
            },
        ]);
        const { transcriptNavigationPaneStore } = await import('./navigation/transcriptNavigationPaneStore');
        const paneSnapshot = transcriptNavigationPaneStore.get('session-1');
        expect(paneSnapshot.entries).toBe(latestRailProps?.entries);
        expect(paneSnapshot.activeEntryId).toBeNull();
        expect(typeof paneSnapshot.onEntryPress).toBe('function');

        screen.pressByTestId('mounted-nav-entry:user-turn:7');

        expect(performTranscriptViewportCommandMock.mock.calls.some(([command]) => (
            command.kind === 'jump-to-seq' &&
            command.seq === 7 &&
            command.routeMessageId === 'local:u1' &&
            command.transcriptBlockIndex === 0 &&
            command.role === 'user' &&
            command.align?.kind === 'top-with-item-offset' &&
            command.align.itemOffsetPx === 24
        ))).toBe(true);

        performTranscriptViewportCommandMock.mockClear();
        jumpToTranscriptSeqMock.mockClear();

        screen.pressByTestId('mounted-nav-entry:pinned-assistant:7');

        expect(jumpToTranscriptSeqMock).not.toHaveBeenCalled();
        expect(performTranscriptViewportCommandMock.mock.calls.some(([command]) => (
            command.kind === 'jump-to-seq' &&
            command.seq === 7 &&
            command.routeMessageId === 'local:a1' &&
            command.transcriptBlockIndex === 1 &&
            command.role === 'assistant' &&
            command.align?.kind === 'center'
        ))).toBe(true);
        expect(loadOlderMessagesMock).not.toHaveBeenCalled();
        expect(loadNewerMessagesMock).not.toHaveBeenCalled();

        await screen.unmount();
    });

    it('routes far rail and panel entries through the target-window path without paging older first', async () => {
        const { savePersistedSessionMessagePins } = await import('@/sync/domains/state/sessionMessagePinsPersistence');
        savePersistedSessionMessagePins('session-1', [
            pin({
                routeMessageId: 'server:far-assistant',
                seq: 500,
                transcriptBlockIndex: 1,
                role: 'assistant',
            }),
        ], activeScope);
        seedTranscriptMessages();
        loadTargetWindowMessagesMock.mockResolvedValue({
            status: 'loaded',
            windowId: 'target:session-1:500',
            targetSeq: 500,
            targetPresent: true,
            rawSeqs: [499, 500, 501],
            appliedSeqs: [499, 500, 501],
            olderCursor: 499,
            newerCursor: 501,
            hasMoreOlder: true,
            hasMoreNewer: true,
        });

        const screen = await renderFlashListChatListSession();
        screen.pressByTestId('mounted-nav-entry:pinned-assistant:500');

        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(loadTargetWindowMessagesMock).toHaveBeenCalledWith(
            'session-1',
            {
                kind: 'route-message-id',
                routeMessageId: 'server:far-assistant',
                seqHint: 500,
            },
            expect.objectContaining({ direction: 'initial' }),
        );
        expect(loadOlderMessagesMock).not.toHaveBeenCalled();

        const { transcriptNavigationPaneStore } = await import('./navigation/transcriptNavigationPaneStore');
        const paneSnapshot = transcriptNavigationPaneStore.get('session-1');
        const farEntry = paneSnapshot.entries.find((entry) => entry.seq === 500);
        expect(farEntry).toBeDefined();
        const onEntryPress = paneSnapshot.onEntryPress;
        expect(onEntryPress).toBeTypeOf('function');
        if (!onEntryPress) {
            throw new Error('Expected transcript navigation pane to expose an entry press handler');
        }
        await act(async () => {
            onEntryPress(farEntry!);
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(loadTargetWindowMessagesMock).toHaveBeenCalledTimes(2);
        expect(loadOlderMessagesMock).not.toHaveBeenCalled();

        await screen.unmount();
    });

    it('routes loaded-but-not-mounted rail entries through the target-window path', async () => {
        seedTranscriptMessages();
        loadTargetWindowMessagesMock.mockResolvedValue({
            status: 'loaded',
            windowId: 'target:session-1:335',
            targetSeq: 335,
            targetPresent: true,
            rawSeqs: [333, 334, 335, 336],
            appliedSeqs: [333, 334, 335, 336],
            olderCursor: 333,
            newerCursor: 336,
            hasMoreOlder: true,
            hasMoreNewer: true,
        });

        const screen = await renderFlashListChatListSession();
        const latestRailProps = capturedNavigationRailProps.at(-1);
        expect(latestRailProps).toBeDefined();
        const entry: TranscriptNavigationEntry = {
            id: 'user-turn:335',
            sessionId: 'session-1',
            kind: 'user-turn',
            role: 'user',
            seq: 335,
            transcriptBlockIndex: 0,
            routeMessageId: 'server:u335',
            pinned: false,
            pinnedAtMs: null,
            promptPreview: 'Loaded but not rendered',
            responsePreview: null,
            label: 'Loaded but not rendered',
            createdAtMs: 335,
            loaded: true,
        };

        await act(async () => {
            await (latestRailProps!.onJumpToEntry(entry, {
                align: 'top',
                scope: { kind: 'main', sessionId: 'session-1' },
                source: 'rail',
                target: {
                    kind: 'route-message-id',
                    routeMessageId: 'server:u335',
                    seqHint: 335,
                    transcriptBlockIndex: 0,
                    role: 'user',
                },
            }) as unknown as Promise<unknown>);
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(loadTargetWindowMessagesMock).toHaveBeenCalledWith(
            'session-1',
            {
                kind: 'route-message-id',
                routeMessageId: 'server:u335',
                seqHint: 335,
            },
            expect.objectContaining({ direction: 'initial' }),
        );
        expect(performTranscriptViewportCommandMock).not.toHaveBeenCalledWith(expect.objectContaining({
            kind: 'jump-to-seq',
            seq: 335,
        }));

        await screen.unmount();
    });

    it('adds remote prior user turns from the shared history API to mounted navigation entries', async () => {
        seedTranscriptMessages();
        fetchUserMessageHistoryPageMock.mockResolvedValue({
            status: 'loaded',
            entries: [{ seq: 3, createdAt: 30, text: 'Earlier remote prompt' }],
            hasMore: false,
            nextBeforeSeq: null,
        });
        loadTargetWindowMessagesMock.mockResolvedValue({
            status: 'loaded',
            windowId: 'target:session-1:3',
            targetSeq: 3,
            targetPresent: true,
            rawSeqs: [3],
            appliedSeqs: [3],
            olderCursor: 3,
            newerCursor: 3,
            hasMoreOlder: true,
            hasMoreNewer: true,
        });

        const screen = await renderFlashListChatListSession();
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(fetchUserMessageHistoryPageMock).toHaveBeenCalledWith('session-1', {
            limit: 25,
            beforeSeq: 7,
        });
        const latestRailProps = capturedNavigationRailProps.at(-1);
        expect(latestRailProps?.entries.map((entry) => ({
            kind: entry.kind,
            seq: entry.seq,
            loaded: entry.loaded,
            promptPreview: entry.promptPreview,
            responsePreview: entry.responsePreview,
        }))).toEqual([
            {
                kind: 'user-turn',
                seq: 3,
                loaded: false,
                promptPreview: 'Earlier remote prompt',
                responsePreview: null,
            },
            {
                kind: 'user-turn',
                seq: 7,
                loaded: true,
                promptPreview: 'Install the dependencies',
                responsePreview: 'Dependencies are installed',
            },
            {
                kind: 'user-turn',
                seq: 12,
                loaded: true,
                promptPreview: 'Run the tests',
                responsePreview: null,
            },
        ]);

        const { transcriptNavigationPaneStore } = await import('./navigation/transcriptNavigationPaneStore');
        expect(transcriptNavigationPaneStore.get('session-1').entries).toBe(latestRailProps?.entries);

        screen.pressByTestId('mounted-nav-entry:user-turn:3');
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(loadTargetWindowMessagesMock).toHaveBeenCalledWith(
            'session-1',
            { kind: 'seq', seq: 3 },
            expect.objectContaining({ direction: 'older' }),
        );
        expect(loadOlderMessagesMock).not.toHaveBeenCalled();

        await screen.unmount();
    });
});
