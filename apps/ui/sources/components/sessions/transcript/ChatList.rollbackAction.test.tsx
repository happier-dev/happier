import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedFlatListProps: any = null;
let capturedMessageViewProps: any[] = [];
let capturedTurnViewProps: any[] = [];

let sessionMessagesState: { messages: any[]; isLoaded: boolean } = { messages: [], isLoaded: true };
let sessionPendingState: { messages: any[]; discarded: any[] } = { messages: [], discarded: [] };
let sessionActionDraftsState: any[] = [];
let sessionState: any = null;

const buildChatListItemsMock = vi.fn((..._args: any[]): any[] => []);

const settingValues: Record<string, any> = {};

vi.mock('@shopify/flash-list', () => ({
    FlashList: () => null,
}));

vi.mock('react-native', async (importOriginal) => {
    const ReactMod = await import('react');
    const actual = await importOriginal<any>();
    return {
        ...actual,
        Platform: {
            OS: 'web',
            select: (spec: any) => {
                if (!spec || typeof spec !== 'object') return undefined;
                return spec.web ?? spec.default;
            },
        },
        View: (props: any) => ReactMod.createElement('View', props, props.children),
        ActivityIndicator: () => ReactMod.createElement('ActivityIndicator'),
        FlatList: (props: any) => {
            capturedFlatListProps = props;
            const data = Array.isArray(props?.data) ? props.data : [];
            const children = data.map((item: any, index: number) => {
                const key = typeof props?.keyExtractor === 'function' ? props.keyExtractor(item, index) : String(index);
                return ReactMod.createElement(ReactMod.Fragment, { key }, props.renderItem?.({ item, index }));
            });
            return ReactMod.createElement('FlatList', null, children);
        },
    };
});

vi.mock('@/utils/platform/responsive', () => ({
    useHeaderHeight: () => 0,
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSession: () => sessionState,
    useSessionTranscriptIds: () => ({
        ids: (sessionMessagesState.messages ?? []).map((message: any) => message.id),
        isLoaded: sessionMessagesState.isLoaded,
    }),
    useSessionMessagesById: () => Object.fromEntries((sessionMessagesState.messages ?? []).map((message: any) => [message.id, message])),
    useForkedTranscriptSnapshot: () => null,
    useSessionPendingMessages: () => sessionPendingState,
    useSessionActionDrafts: () => sessionActionDraftsState,
    useSessionLatestThinkingMessageId: () => null,
    useSessionLatestThinkingMessageActivityAtMs: () => null,
    useMessage: (_sessionId: string, messageId: string) => (sessionMessagesState.messages ?? []).find((message: any) => message.id === messageId) ?? null,
    useSetting: (key: string) => settingValues[key],
    getStorage: () => ({
        getState: () => ({
            sessionMessages: {
                [sessionState?.id ?? 'session-1']: {
                    messagesById: Object.fromEntries((sessionMessagesState.messages ?? []).map((message: any) => [message.id, message])),
                    messagesMap: Object.fromEntries((sessionMessagesState.messages ?? []).map((message: any) => [message.id, message])),
                },
            },
        }),
    }),
}));

vi.mock('@/components/sessions/chatListItems', () => ({
    buildChatListItems: buildChatListItemsMock,
    buildChatListItemsCached: (opts: any) => ({ cache: null, items: buildChatListItemsMock(opts) }),
}));

vi.mock('./ChatFooter', () => ({
    ChatFooter: () => React.createElement('ChatFooter'),
}));

vi.mock('./MessageView', () => ({
    MessageView: (props: any) => {
        capturedMessageViewProps.push(props);
        return React.createElement('MessageView', props);
    },
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptEnterWrapper', () => ({
    TranscriptEnterWrapper: (props: any) => React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptMotionProvider', () => ({
    TranscriptMotionProvider: (props: any) => React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/components/sessions/transcript/motion/resolveTranscriptMotionConfig', () => ({
    resolveTranscriptMotionConfig: () => ({ preset: 'off', animateThinkingEnabled: false }),
}));

vi.mock('@/components/sessions/transcript/scroll/JumpToBottomButton', () => ({
    JumpToBottomButton: () => null,
}));

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => false,
}));

vi.mock('@/components/sessions/transcript/TranscriptRollbackActionButton', () => ({
    TranscriptRollbackActionButton: (props: any) => React.createElement('TranscriptRollbackActionButton', props),
}));

vi.mock('@/components/sessions/transcript/turns/TurnView', async (importOriginal) => {
    const ReactMod = await import('react');
    const actual = await importOriginal<any>();
    return {
        TurnView: (props: any) => {
            capturedTurnViewProps.push(props);
            return ReactMod.createElement(actual.TurnView, props);
        },
    };
});

vi.mock('@/components/sessions/pending/PendingMessagesTranscriptBlock', () => ({
    PendingMessagesTranscriptBlock: () => React.createElement('PendingMessagesTranscriptBlock'),
}));

vi.mock('@/components/sessions/actions/SessionActionDraftCard', () => ({
    SessionActionDraftCard: () => React.createElement('SessionActionDraftCard'),
}));

vi.mock('@/components/sessions/transcript/toolCalls/ToolCallsGroupRow', () => ({
    ToolCallsGroupRow: () => React.createElement('ToolCallsGroupRow'),
}));

vi.mock('@/sync/domains/state/agentStateCapabilities', () => ({
    getPermissionsInUiWhileLocal: () => ({}),
}));

vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (promise: any) => promise,
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        loadOlderMessages: vi.fn(),
        loadNewerMessages: vi.fn(),
        hasDeferredNewerMessages: () => false,
        getSyncTuning: () => ({
            transcriptWebInitialPinStabilizeMs: 0,
            transcriptWebInitialPinRetryIntervalMs: 250,
            transcriptForwardPrefetchThresholdPx: 800,
            transcriptBackwardPrefetchThresholdPx: 0,
            transcriptFlashListEstimatedItemSize: 48,
        }),
    },
}));

describe('ChatList rollback action', () => {
    beforeEach(() => {
        capturedFlatListProps = null;
        capturedMessageViewProps = [];
        capturedTurnViewProps = [];
        buildChatListItemsMock.mockClear();
        sessionMessagesState = { messages: [], isLoaded: true };
        sessionPendingState = { messages: [], discarded: [] };
        sessionActionDraftsState = [];
        sessionState = {
            id: 'session-1',
            seq: 4,
            active: true,
            metadata: { flavor: 'codex', codexBackendMode: 'appServer' },
            accessLevel: null,
            canApprovePermissions: true,
            agentState: null,
            presence: 'online',
            thinking: false,
        };
        for (const key of Object.keys(settingValues)) delete settingValues[key];
        settingValues.transcriptGroupToolCalls = false;
        settingValues.transcriptTurnToolCallsGroupStrategy = 'consecutive_tools';
        settingValues.toolViewTimelineChromeMode = 'cards';
        settingValues.transcriptListImplementation = 'flatlist_legacy';
    });

    it('places rollback-to-point on active user messages and marks rolled-back messages historical', async () => {
        settingValues.transcriptGroupingMode = 'linear';
        sessionState = {
            ...sessionState,
            metadata: {
                flavor: 'codex',
                codexBackendMode: 'appServer',
                sessionRollbackRangesV1: {
                    v: 1,
                    updatedAt: 99,
                    ranges: [{ target: { type: 'latest_turn' }, startSeqInclusive: 3, endSeqInclusive: 3, rolledBackAt: 99 }],
                },
            },
        };

        const messages = [
            { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'first', seq: 1 },
            { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'reply', seq: 2, isThinking: false },
            { kind: 'agent-text', id: 'a2', localId: null, createdAt: 3, text: 'rolled back', seq: 3, isThinking: false },
        ];
        sessionMessagesState = { isLoaded: true, messages };
        buildChatListItemsMock.mockImplementation((opts: any) => (
            (opts.messageIdsOldestFirst ?? []).map((id: string) => ({
                kind: 'message',
                id,
                messageId: id,
                createdAt: opts.messagesById[id]?.createdAt ?? 0,
                seq: opts.messagesById[id]?.seq ?? null,
            }))
        ));

        const { ChatList } = await import('./ChatList');
        act(() => {
            renderer.create(<ChatList session={sessionState} />);
        });

        const byId = new Map(capturedMessageViewProps.map((props) => [props.message.id, props]));
        expect(byId.get('u1')?.rollbackAction).toEqual({
            target: { type: 'before_user_message', userMessageSeq: 1 },
            restoredDraftText: 'first',
        });
        expect(byId.get('a1')?.historical).toBe(false);
        expect(byId.get('a1')?.rollbackAction ?? null).toBeNull();
        expect(byId.get('a2')?.rollbackAction ?? null).toBeNull();
        expect(byId.get('a2')?.historical).toBe(true);
    }, 120000);

    it('does not place rollback actions on tool-call or agent messages when rollback-to-point is available', async () => {
        settingValues.transcriptGroupingMode = 'linear';

        const messages = [
            { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'first', seq: 1 },
            { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'reply', seq: 2, isThinking: false },
            { kind: 'tool-call', id: 't1', localId: null, createdAt: 3, tool: { id: 'tool-1' }, children: [], seq: 3 },
        ];
        sessionMessagesState = { isLoaded: true, messages };
        buildChatListItemsMock.mockImplementation((opts: any) => (
            (opts.messageIdsOldestFirst ?? []).map((id: string) => ({
                kind: 'message',
                id,
                messageId: id,
                createdAt: opts.messagesById[id]?.createdAt ?? 0,
                seq: opts.messagesById[id]?.seq ?? null,
            }))
        ));

        const { ChatList } = await import('./ChatList');
        act(() => {
            renderer.create(<ChatList session={sessionState} />);
        });

        const byId = new Map(capturedMessageViewProps.map((props) => [props.message.id, props]));
        expect(byId.get('u1')?.rollbackAction).toEqual({
            target: { type: 'before_user_message', userMessageSeq: 1 },
            restoredDraftText: 'first',
        });
        expect(byId.get('a1')?.rollbackAction ?? null).toBeNull();
        expect(byId.get('t1')?.rollbackAction ?? null).toBeNull();
    });

    it('keeps rollback-to-point attached to user messages when turn grouping is enabled', async () => {
        settingValues.transcriptGroupingMode = 'turns';

        const messages = [
            { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'first', seq: 1 },
            { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'reply one', seq: 2, isThinking: false },
            { kind: 'user-text', id: 'u2', localId: null, createdAt: 3, text: 'second', seq: 3 },
            { kind: 'agent-text', id: 'a2', localId: null, createdAt: 4, text: 'reply two', seq: 4, isThinking: false },
        ];
        sessionMessagesState = { isLoaded: true, messages };
        buildChatListItemsMock.mockImplementation((opts: any) => {
            if (opts?.includeCommittedMessages === false) return [];
            return messages.map((message) => ({
                kind: 'message',
                id: message.id,
                messageId: message.id,
                createdAt: message.createdAt,
                seq: message.seq,
            }));
        });

        const { ChatList } = await import('./ChatList');
        act(() => {
            renderer.create(<ChatList session={sessionState} />);
        });

        const byId = new Map(capturedMessageViewProps.map((props) => [props.message.id, props]));
        expect(byId.get('u1')?.rollbackAction).toEqual({
            target: { type: 'before_user_message', userMessageSeq: 1 },
            restoredDraftText: 'first',
        });
        expect(byId.get('u2')?.rollbackAction).toEqual({
            target: { type: 'before_user_message', userMessageSeq: 3 },
            restoredDraftText: 'second',
        });
        expect(byId.get('a2')?.rollbackAction ?? null).toBeNull();
    });

    it('shows rollback for older Codex app-server sessions that only have generic codex control metadata', async () => {
        settingValues.transcriptGroupingMode = 'linear';
        sessionState = {
            ...sessionState,
            metadata: {
                flavor: 'codex',
                codexSessionId: 'thread_123',
                sessionConfigOptionsV1: {
                    v: 1,
                    provider: 'codex',
                    updatedAt: 1,
                    options: [],
                },
            },
        };

        const messages = [
            { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'first', seq: 1 },
            { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'reply', seq: 2, isThinking: false },
        ];
        sessionMessagesState = { isLoaded: true, messages };
        buildChatListItemsMock.mockImplementation((opts: any) => (
            (opts.messageIdsOldestFirst ?? []).map((id: string) => ({
                kind: 'message',
                id,
                messageId: id,
                createdAt: opts.messagesById[id]?.createdAt ?? 0,
                seq: opts.messagesById[id]?.seq ?? null,
            }))
        ));

        const { ChatList } = await import('./ChatList');
        act(() => {
            renderer.create(<ChatList session={sessionState} />);
        });

        const byId = new Map(capturedMessageViewProps.map((props) => [props.message.id, props]));
        expect(byId.get('u1')?.rollbackAction).toEqual({
            target: { type: 'before_user_message', userMessageSeq: 1 },
            restoredDraftText: 'first',
        });
    });

    it('does not show rollback for inactive sessions even when Codex app-server metadata is present', async () => {
        settingValues.transcriptGroupingMode = 'linear';
        sessionState = {
            ...sessionState,
            active: false,
            metadata: {
                flavor: 'codex',
                codexBackendMode: 'appServer',
            },
        };

        const messages = [
            { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'first', seq: 1 },
            { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'reply', seq: 2, isThinking: false },
        ];
        sessionMessagesState = { isLoaded: true, messages };
        buildChatListItemsMock.mockImplementation((opts: any) => (
            (opts.messageIdsOldestFirst ?? []).map((id: string) => ({
                kind: 'message',
                id,
                messageId: id,
                createdAt: opts.messagesById[id]?.createdAt ?? 0,
                seq: opts.messagesById[id]?.seq ?? null,
            }))
        ));

        const { ChatList } = await import('./ChatList');
        act(() => {
            renderer.create(<ChatList session={sessionState} />);
        });

        const byId = new Map(capturedMessageViewProps.map((props) => [props.message.id, props]));
        expect(byId.get('u1')?.rollbackAction ?? null).toBeNull();
    });

    it('passes historical rollback state through to nested message views when turn grouping is enabled', async () => {
        settingValues.transcriptGroupingMode = 'turns';
        sessionState = {
            ...sessionState,
            metadata: {
                flavor: 'codex',
                codexBackendMode: 'appServer',
                sessionRollbackRangesV1: {
                    v: 1,
                    updatedAt: 99,
                    ranges: [{ target: { type: 'latest_turn' }, startSeqInclusive: 3, endSeqInclusive: 4, rolledBackAt: 99 }],
                },
            },
        };

        const messages = [
            { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'first', seq: 1 },
            { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'reply one', seq: 2, isThinking: false },
            { kind: 'user-text', id: 'u2', localId: null, createdAt: 3, text: 'second', seq: 3 },
            { kind: 'agent-text', id: 'a2', localId: null, createdAt: 4, text: 'reply two', seq: 4, isThinking: false },
        ];
        sessionMessagesState = { isLoaded: true, messages };
        buildChatListItemsMock.mockImplementation((opts: any) => {
            if (opts?.includeCommittedMessages === false) return [];
            return messages.map((message) => ({
                kind: 'message',
                id: message.id,
                messageId: message.id,
                createdAt: message.createdAt,
                seq: message.seq,
            }));
        });

        const { ChatList } = await import('./ChatList');
        act(() => {
            renderer.create(<ChatList session={sessionState} />);
        });

        const byId = new Map(capturedMessageViewProps.map((props) => [props.message.id, props]));
        expect(byId.get('u1')?.historical).toBe(false);
        expect(byId.get('a1')?.historical).toBe(false);
        expect(byId.get('u2')?.historical).toBe(true);
        expect(byId.get('a2')?.historical).toBe(true);
    });
});
