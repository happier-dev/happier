import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    chatListHarnessState,
    renderChatList,
    requireCapturedLegendListProps,
    resetChatListHarness,
} from '@/dev/testkit/harness/chatListHarness';
import { installChatListHarnessCommonModuleMocks } from '@/dev/testkit/harness/chatListHarnessModuleMocks';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedMessageViewProps: any[] = [];

const buildChatListItemsMock = vi.fn((..._args: any[]): any[] => []);

installChatListHarnessCommonModuleMocks();

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
    MessageViewWithSessionCommon: (props: any) => {
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

vi.mock('@/components/sessions/keyboardAvoidance', async () => {
    const ReactMod = await import('react');
    type KeyboardAvoidanceProps = { children?: React.ReactNode };
    return {
        ComposerKeyboardFloatingInset: (props: KeyboardAvoidanceProps) =>
            ReactMod.createElement(ReactMod.Fragment, null, props.children),
        ComposerKeyboardScrollInset: () => null,
    };
});

vi.mock('@/components/sessions/transcript/turns/TurnView', () => ({
    TurnView: (props: any) => React.createElement('TurnView', props),
    TurnViewWithSessionCommon: (props: any) => React.createElement('TurnViewWithSessionCommon', props),
}));

vi.mock('@/components/sessions/pending/PendingMessagesTranscriptBlock', () => ({
    PendingMessagesTranscriptBlock: () => React.createElement('PendingMessagesTranscriptBlock'),
}));

vi.mock('@/components/sessions/actions/SessionActionDraftCard', () => ({
    SessionActionDraftCard: () => React.createElement('SessionActionDraftCard'),
}));

vi.mock('@/components/sessions/transcript/toolCalls/ToolCallsGroupRow', () => ({
    ToolCallsGroupRow: () => React.createElement('ToolCallsGroupRow'),
    ToolCallsGroupRowWithSessionCommon: () => React.createElement('ToolCallsGroupRow'),
}));

vi.mock('@/sync/domains/state/agentStateCapabilities', () => ({
    getPermissionsInUiWhileLocal: () => ({}),
}));

vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (promise: any) => promise,
}));

vi.mock('@/sync/sync', async () => (
    (await import('@/dev/testkit/harness/chatListHarness')).createChatListHarnessSyncModuleMock()
));

const { ChatList } = await import('./ChatList');

function renderRollbackChatListSession() {
    return renderChatList(
        <ChatList session={{ ...chatListHarnessState.sessionState }} />,
    );
}

function rollbackEligibleTurnStarts(startSeqs: readonly number[]): Record<string, unknown> {
    return {
        rollbackEligibleTurnStarts: startSeqs,
    };
}

describe('ChatList rollback action', () => {
    beforeEach(() => {
        resetChatListHarness();
        capturedMessageViewProps = [];
        buildChatListItemsMock.mockClear();
        chatListHarnessState.sessionPendingState = { messages: [], discarded: [], isLoaded: true };
        chatListHarnessState.sessionState = {
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
        chatListHarnessState.settingValues.transcriptGroupToolCalls = false;
        chatListHarnessState.settingValues.transcriptTurnToolCallsGroupStrategy = 'consecutive_tools';
        chatListHarnessState.settingValues.toolViewTimelineChromeMode = 'cards';
    });

    it('places rollback-to-point on active user messages and marks rolled-back messages historical', async () => {
        chatListHarnessState.settingValues.transcriptGroupingMode = 'linear';
        chatListHarnessState.sessionState = {
            ...chatListHarnessState.sessionState,
            sessionTurns: {
                v: 1,
                sessionId: 'session-1',
                latestTurnId: 'turn-1',
                updatedAt: 99,
                turns: [
                    {
                        turnId: 'turn-1',
                        status: 'completed',
                        startedAt: 1,
                        updatedAt: 99,
                        terminalAt: 99,
                        transcriptAnchors: { startUserMessageSeq: 1, userMessageSeqs: [1], startSeqInclusive: 1, endSeqInclusive: 2 },
                        rollback: { state: 'eligible', updatedAt: 99 },
                    },
                ],
            },
            metadata: {
                flavor: 'codex',
                codexBackendMode: 'appServer',
                sessionRollbackRangesV1: {
                    v: 1,
                    updatedAt: 99,
                    ranges: [{ target: { type: 'latest_turn' }, startSeqInclusive: 3, endSeqInclusive: 3, rolledBackAt: 99 }],
                },
            },
            ...rollbackEligibleTurnStarts([1]),
        };

        const messages = [
            { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'first', seq: 1 },
            { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'reply', seq: 2, isThinking: false },
            { kind: 'agent-text', id: 'a2', localId: null, createdAt: 3, text: 'rolled back', seq: 3, isThinking: false },
        ];
        chatListHarnessState.sessionMessagesState = { isLoaded: true, messages };
        buildChatListItemsMock.mockImplementation((opts: any) => (
            (opts.messageIdsOldestFirst ?? []).map((id: string) => ({
                kind: 'message',
                id,
                messageId: id,
                createdAt: opts.messagesById[id]?.createdAt ?? 0,
                seq: opts.messagesById[id]?.seq ?? null,
            }))
        ));

        const screen = await renderRollbackChatListSession();

        const byId = new Map(capturedMessageViewProps.map((props) => [props.message.id, props]));
        expect(byId.get('u1')?.rollbackAction).toEqual({
            target: { type: 'before_user_message', userMessageSeq: 1 },
            restoredDraftText: 'first',
        });
        expect(byId.get('a1')?.historical).toBe(false);
        expect(byId.get('a1')?.rollbackAction ?? null).toBeNull();
        expect(byId.get('a2')?.rollbackAction ?? null).toBeNull();
        expect(byId.get('a2')?.historical).toBe(true);

        await screen.unmount();
    });

    it('invalidates virtualized rows when rollback eligibility arrives after the messages', async () => {
        chatListHarnessState.settingValues.transcriptGroupingMode = 'linear';
        chatListHarnessState.sessionState = {
            ...chatListHarnessState.sessionState,
            metadata: { flavor: 'codex', codexBackendMode: 'appServer' },
            ...rollbackEligibleTurnStarts([]),
        };

        const messages = [
            { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'first', seq: 1 },
            { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'reply', seq: 2, isThinking: false },
        ];
        chatListHarnessState.sessionMessagesState = { isLoaded: true, messages };
        buildChatListItemsMock.mockImplementation((opts: any) => (
            (opts.messageIdsOldestFirst ?? []).map((id: string) => ({
                kind: 'message',
                id,
                messageId: id,
                createdAt: opts.messagesById[id]?.createdAt ?? 0,
                seq: opts.messagesById[id]?.seq ?? null,
            }))
        ));

        const screen = await renderRollbackChatListSession();
        const before = requireCapturedLegendListProps();

        chatListHarnessState.sessionState = {
            ...chatListHarnessState.sessionState,
            ...rollbackEligibleTurnStarts([1]),
        };
        await screen.update(<ChatList session={{ ...chatListHarnessState.sessionState }} />);

        const after = requireCapturedLegendListProps();
        expect(after.data).toBe(before.data);
        expect(after.renderItem).not.toBe(before.renderItem);
        expect(after.extraData).not.toBe(before.extraData);
        const updatedUserRow = [...capturedMessageViewProps]
            .reverse()
            .find((rowProps) => rowProps.message.id === 'u1');
        expect(updatedUserRow?.rollbackAction).toEqual({
            target: { type: 'before_user_message', userMessageSeq: 1 },
            restoredDraftText: 'first',
        });

        await screen.unmount();
    });

    it('does not place rollback actions on tool-call or agent messages when rollback-to-point is available', async () => {
        chatListHarnessState.settingValues.transcriptGroupingMode = 'linear';
        chatListHarnessState.sessionState = {
            ...chatListHarnessState.sessionState,
            sessionTurns: {
                v: 1,
                sessionId: 'session-1',
                latestTurnId: 'turn-1',
                updatedAt: 1,
                turns: [
                    {
                        turnId: 'turn-1',
                        status: 'completed',
                        startedAt: 1,
                        updatedAt: 1,
                        terminalAt: 1,
                        transcriptAnchors: { startUserMessageSeq: 1, userMessageSeqs: [1], startSeqInclusive: 1, endSeqInclusive: 3 },
                        rollback: { state: 'eligible', updatedAt: 1 },
                    },
                ],
            },
            metadata: { flavor: 'codex', codexBackendMode: 'appServer' },
            ...rollbackEligibleTurnStarts([1]),
        };

        const messages = [
            { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'first', seq: 1 },
            { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'reply', seq: 2, isThinking: false },
            { kind: 'tool-call', id: 't1', localId: null, createdAt: 3, tool: { id: 'tool-1' }, children: [], seq: 3 },
        ];
        chatListHarnessState.sessionMessagesState = { isLoaded: true, messages };
        buildChatListItemsMock.mockImplementation((opts: any) => (
            (opts.messageIdsOldestFirst ?? []).map((id: string) => ({
                kind: 'message',
                id,
                messageId: id,
                createdAt: opts.messagesById[id]?.createdAt ?? 0,
                seq: opts.messagesById[id]?.seq ?? null,
            }))
        ));

        const screen = await renderRollbackChatListSession();

        const byId = new Map(capturedMessageViewProps.map((props) => [props.message.id, props]));
        expect(byId.get('u1')?.rollbackAction).toEqual({
            target: { type: 'before_user_message', userMessageSeq: 1 },
            restoredDraftText: 'first',
        });
        expect(byId.get('a1')?.rollbackAction ?? null).toBeNull();
        expect(byId.get('t1')?.rollbackAction ?? null).toBeNull();

        await screen.unmount();
    });

    it('keeps the current-session row renderer stable when message text streams', async () => {
        chatListHarnessState.settingValues.transcriptGroupingMode = 'linear';
        chatListHarnessState.sessionState = {
            ...chatListHarnessState.sessionState,
            metadata: { flavor: 'codex', codexBackendMode: 'appServer' },
        };

        const messages = [
            { kind: 'agent-text', id: 'a1', localId: null, createdAt: 1, text: 'first', seq: 1, isThinking: false },
        ];
        chatListHarnessState.sessionMessagesState = { isLoaded: true, messages };
        buildChatListItemsMock.mockImplementation((opts: any) => (
            (opts.messageIdsOldestFirst ?? []).map((id: string) => ({
                kind: 'message',
                id,
                messageId: id,
                createdAt: opts.messagesById[id]?.createdAt ?? 0,
                seq: opts.messagesById[id]?.seq ?? null,
            }))
        ));

        const screen = await renderRollbackChatListSession();
        const firstRenderItem = requireCapturedLegendListProps().renderItem;

        chatListHarnessState.sessionMessagesState = {
            isLoaded: true,
            messages: [
                { ...messages[0], text: 'first and streamed more' },
            ],
        };
        chatListHarnessState.sessionState = {
            ...chatListHarnessState.sessionState,
            metadata: { flavor: 'codex', codexBackendMode: 'appServer' },
        };

        await screen.update(<ChatList session={{ ...chatListHarnessState.sessionState }} />);

        expect(requireCapturedLegendListProps().renderItem).toBe(firstRenderItem);

        await screen.unmount();
    });

    it('keeps rollback-to-point attached to user messages when turn grouping is enabled', async () => {
        chatListHarnessState.settingValues.transcriptGroupingMode = 'turns';
        chatListHarnessState.sessionState = {
            ...chatListHarnessState.sessionState,
            sessionTurns: {
                v: 1,
                sessionId: 'session-1',
                latestTurnId: 'turn-2',
                updatedAt: 1,
                turns: [
                    {
                        turnId: 'turn-1',
                        status: 'completed',
                        startedAt: 1,
                        updatedAt: 1,
                        terminalAt: 1,
                        transcriptAnchors: { startUserMessageSeq: 1, userMessageSeqs: [1], startSeqInclusive: 1, endSeqInclusive: 2 },
                        rollback: { state: 'eligible', updatedAt: 1 },
                    },
                    {
                        turnId: 'turn-2',
                        status: 'completed',
                        startedAt: 3,
                        updatedAt: 1,
                        terminalAt: 1,
                        transcriptAnchors: { startUserMessageSeq: 3, userMessageSeqs: [3], startSeqInclusive: 3, endSeqInclusive: 4 },
                        rollback: { state: 'eligible', updatedAt: 1 },
                    },
                ],
            },
            metadata: { flavor: 'codex', codexBackendMode: 'appServer' },
            ...rollbackEligibleTurnStarts([1, 3]),
        };

        const messages = [
            { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'first', seq: 1 },
            { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'reply one', seq: 2, isThinking: false },
            { kind: 'user-text', id: 'u2', localId: null, createdAt: 3, text: 'second', seq: 3 },
            { kind: 'agent-text', id: 'a2', localId: null, createdAt: 4, text: 'reply two', seq: 4, isThinking: false },
        ];
        chatListHarnessState.sessionMessagesState = { isLoaded: true, messages };
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

        const screen = await renderRollbackChatListSession();

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

        await screen.unmount();
    });

    it('hides point rollback for Codex app-server sessions without trusted turn metadata', async () => {
        chatListHarnessState.settingValues.transcriptGroupingMode = 'linear';
        chatListHarnessState.sessionState = {
            ...chatListHarnessState.sessionState,
            metadata: {
                flavor: 'codex',
                codexSessionId: 'thread_123',
                sessionConfigOptionsV1: {
                    v: 1,
                    agentId: 'codex',
                    updatedAt: 1,
                    options: [],
                },
            },
        };

        const messages = [
            { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'first', seq: 1 },
            { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'reply', seq: 2, isThinking: false },
        ];
        chatListHarnessState.sessionMessagesState = { isLoaded: true, messages };
        buildChatListItemsMock.mockImplementation((opts: any) => (
            (opts.messageIdsOldestFirst ?? []).map((id: string) => ({
                kind: 'message',
                id,
                messageId: id,
                createdAt: opts.messagesById[id]?.createdAt ?? 0,
                seq: opts.messagesById[id]?.seq ?? null,
            }))
        ));

        const screen = await renderRollbackChatListSession();

        const byId = new Map(capturedMessageViewProps.map((props) => [props.message.id, props]));
        expect(byId.get('u1')?.rollbackAction ?? null).toBeNull();

        await screen.unmount();
    });

    it('projects checkpoint rollback evidence from canonical turn change sets through the normal ChatList resolver path', async () => {
        chatListHarnessState.settingValues.transcriptGroupingMode = 'linear';
        chatListHarnessState.sessionState = {
            ...chatListHarnessState.sessionState,
            sessionTurns: {
                v: 1,
                sessionId: 'session-1',
                latestTurnId: 'turn-1',
                updatedAt: 1,
                turns: [
                    {
                        turnId: 'turn-1',
                        status: 'completed',
                        startedAt: 1,
                        updatedAt: 1,
                        terminalAt: 1,
                        transcriptAnchors: { startUserMessageSeq: 1, userMessageSeqs: [1], startSeqInclusive: 1, endSeqInclusive: 3 },
                        rollback: { state: 'eligible', updatedAt: 1 },
                    },
                ],
            },
            metadata: {
                flavor: 'codex',
                codexBackendMode: 'appServer',
            },
            ...rollbackEligibleTurnStarts([1]),
        };

        const messages = [
            { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'first', seq: 1 },
            { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'reply', seq: 2, isThinking: false },
            {
                kind: 'tool-call',
                id: 'tool1',
                localId: null,
                createdAt: 3,
                seq: 3,
                children: [],
                tool: {
                    id: 'tool1',
                    name: 'Diff',
                    state: 'completed',
                    input: {
                        files: [{
                            file_path: 'src/app.ts',
                            change_kind: 'modified',
                            source: 'scm_checkpoint',
                            confidence: 'exact',
                            provider: 'scm:git',
                            unified_diff: 'diff --git a/src/app.ts b/src/app.ts\n',
                        }],
                        _happier: {
                            v: 2,
                            provider: 'scm:git',
                            sessionChangeScope: 'turn',
                            turnId: 'turn-1',
                            sessionId: 'session-1',
                            source: 'scm_checkpoint',
                            confidence: 'exact',
                            turnStatus: 'completed',
                            seqRange: { startSeqInclusive: 1, endSeqInclusive: 3 },
                            repositoryCheckpoint: {
                                version: 1,
                                scopeId: 'session-1:/repo',
                                startRef: 'refs/happier/checkpoints/c2Vzc2lvbi0xOi9yZXBv/turn-start/turn-1',
                                finalRef: 'refs/happier/checkpoints/c2Vzc2lvbi0xOi9yZXBv/turn-final/turn-1',
                                baseRefSource: 'turn_start',
                                contentConfidence: 'exact',
                                attributionScope: 'unknown',
                                receipts: [{ id: 'checkpoint.diff_computed' }],
                            },
                        },
                    },
                    createdAt: 3,
                    startedAt: 3,
                    completedAt: 4,
                    description: null,
                    result: { status: 'completed' },
                },
            },
        ];
        chatListHarnessState.sessionMessagesState = { isLoaded: true, messages };
        buildChatListItemsMock.mockImplementation((opts: any) => (
            (opts.messageIdsOldestFirst ?? []).map((id: string) => ({
                kind: 'message',
                id,
                messageId: id,
                createdAt: opts.messagesById[id]?.createdAt ?? 0,
                seq: opts.messagesById[id]?.seq ?? null,
            }))
        ));

        const screen = await renderRollbackChatListSession();

        const byId = new Map(capturedMessageViewProps.map((props) => [props.message.id, props]));
        expect(byId.get('u1')?.rollbackAction).toEqual({
            target: { type: 'before_user_message', userMessageSeq: 1 },
            restoredDraftText: 'first',
            checkpointCodeRollback: {
                conversationRollbackSupported: true,
                turnId: 'turn-1',
                cwd: '/repo',
                expectedStartRef: 'refs/happier/checkpoints/c2Vzc2lvbi0xOi9yZXBv/turn-start/turn-1',
                expectedFinalRef: 'refs/happier/checkpoints/c2Vzc2lvbi0xOi9yZXBv/turn-final/turn-1',
            },
        });

        await screen.unmount();
    });

    it('projects checkpoint code-only rollback through ChatList when conversation rollback is unsupported', async () => {
        chatListHarnessState.settingValues.transcriptGroupingMode = 'linear';
        chatListHarnessState.sessionState = {
            ...chatListHarnessState.sessionState,
            metadata: { flavor: 'codex', codexBackendMode: 'mcp' },
        };

        const messages = [
            { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'first', seq: 1 },
            { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'reply', seq: 2, isThinking: false },
            {
                kind: 'tool-call',
                id: 'tool1',
                localId: null,
                createdAt: 3,
                seq: 3,
                children: [],
                tool: {
                    id: 'tool1',
                    name: 'Diff',
                    state: 'completed',
                    input: {
                        files: [{
                            file_path: 'src/app.ts',
                            change_kind: 'modified',
                            source: 'scm_checkpoint',
                            confidence: 'exact',
                            provider: 'scm:git',
                            unified_diff: 'diff --git a/src/app.ts b/src/app.ts\n',
                        }],
                        _happier: {
                            v: 2,
                            provider: 'scm:git',
                            sessionChangeScope: 'turn',
                            turnId: 'turn-1',
                            sessionId: 'session-1',
                            source: 'scm_checkpoint',
                            confidence: 'exact',
                            turnStatus: 'completed',
                            seqRange: { startSeqInclusive: 1, endSeqInclusive: 3 },
                            repositoryCheckpoint: {
                                version: 1,
                                scopeId: 'session-1:/repo',
                                startRef: 'refs/happier/checkpoints/c2Vzc2lvbi0xOi9yZXBv/turn-start/turn-1',
                                finalRef: 'refs/happier/checkpoints/c2Vzc2lvbi0xOi9yZXBv/turn-final/turn-1',
                                baseRefSource: 'turn_start',
                                contentConfidence: 'exact',
                                attributionScope: 'unknown',
                                receipts: [{ id: 'checkpoint.diff_computed' }],
                            },
                        },
                    },
                    createdAt: 3,
                    startedAt: 3,
                    completedAt: 4,
                    description: null,
                    result: { status: 'completed' },
                },
            },
        ];
        chatListHarnessState.sessionMessagesState = { isLoaded: true, messages };
        buildChatListItemsMock.mockImplementation((opts: any) => (
            (opts.messageIdsOldestFirst ?? []).map((id: string) => ({
                kind: 'message',
                id,
                messageId: id,
                createdAt: opts.messagesById[id]?.createdAt ?? 0,
                seq: opts.messagesById[id]?.seq ?? null,
            }))
        ));

        const screen = await renderRollbackChatListSession();

        const byId = new Map(capturedMessageViewProps.map((props) => [props.message.id, props]));
        expect(byId.get('u1')?.rollbackAction ?? null).toBeNull();
        expect(byId.get('a1')?.rollbackAction).toEqual({
            target: { type: 'latest_turn' },
            restoredDraftText: null,
            checkpointCodeRollback: {
                conversationRollbackSupported: false,
                turnId: 'turn-1',
                cwd: '/repo',
                expectedStartRef: 'refs/happier/checkpoints/c2Vzc2lvbi0xOi9yZXBv/turn-start/turn-1',
                expectedFinalRef: 'refs/happier/checkpoints/c2Vzc2lvbi0xOi9yZXBv/turn-final/turn-1',
            },
        });

        await screen.unmount();
    });

    it('does not show rollback for inactive sessions even when Codex app-server metadata is present', async () => {
        chatListHarnessState.settingValues.transcriptGroupingMode = 'linear';
        chatListHarnessState.sessionState = {
            ...chatListHarnessState.sessionState,
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
        chatListHarnessState.sessionMessagesState = { isLoaded: true, messages };
        buildChatListItemsMock.mockImplementation((opts: any) => (
            (opts.messageIdsOldestFirst ?? []).map((id: string) => ({
                kind: 'message',
                id,
                messageId: id,
                createdAt: opts.messagesById[id]?.createdAt ?? 0,
                seq: opts.messagesById[id]?.seq ?? null,
            }))
        ));

        const screen = await renderRollbackChatListSession();

        const byId = new Map(capturedMessageViewProps.map((props) => [props.message.id, props]));
        expect(byId.get('u1')?.rollbackAction ?? null).toBeNull();

        await screen.unmount();
    });

    it('passes historical rollback state through to nested message views when turn grouping is enabled', async () => {
        chatListHarnessState.settingValues.transcriptGroupingMode = 'turns';
        chatListHarnessState.sessionState = {
            ...chatListHarnessState.sessionState,
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
        chatListHarnessState.sessionMessagesState = { isLoaded: true, messages };
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

        const screen = await renderRollbackChatListSession();

        const byId = new Map(capturedMessageViewProps.map((props) => [props.message.id, props]));
        expect(byId.get('u1')?.historical).toBe(false);
        expect(byId.get('a1')?.historical).toBe(false);
        expect(byId.get('u2')?.historical).toBe(true);
        expect(byId.get('a2')?.historical).toBe(true);

        await screen.unmount();
    });
});
