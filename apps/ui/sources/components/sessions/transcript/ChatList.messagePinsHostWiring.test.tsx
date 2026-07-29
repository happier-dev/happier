import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit';
import {
    chatListHarnessState,
    renderChatListHarnessSession,
    resetChatListHarness,
} from '@/dev/testkit/harness/chatListHarness';
import { installChatListHarnessCommonModuleMocks } from '@/dev/testkit/harness/chatListHarnessModuleMocks';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { PersistedSessionMessagePinV1 } from '@/sync/domains/messages/pins/sessionMessagePins';
import type { Message } from '@/sync/domains/messages/messageTypes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const persistedStorage = vi.hoisted(() => new Map<string, string>());
const loadOlderMessagesMock = vi.hoisted(() => vi.fn());
const loadNewerMessagesMock = vi.hoisted(() => vi.fn());
const prefetchForkedTranscriptContextMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));

let capturedMessageViewProps: Array<Record<string, any>> = [];
let capturedToolGroupRowProps: Array<Record<string, any>> = [];

const buildChatListItemsMock = vi.fn((opts: Readonly<{
    messageIdsOldestFirst?: readonly string[];
    messagesById?: Readonly<Record<string, Message>>;
}>) => {
    const ids = opts.messageIdsOldestFirst ?? [];
    return ids.map((id) => {
        const message = opts.messagesById?.[id];
        if (message?.kind === 'tool-call') {
            return {
                kind: 'tool-calls-group',
                id: `tool-group:${id}`,
                toolMessageIds: [id],
                createdAt: message.createdAt,
            };
        }
        return {
            kind: 'message',
            id,
            messageId: id,
            createdAt: message?.createdAt ?? 0,
            seq: typeof message?.seq === 'number' ? message.seq : null,
        };
    });
});

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

installChatListHarnessCommonModuleMocks();

vi.mock('@/components/sessions/chatListItems', async () => (
    (await import('@/dev/testkit/harness/chatListHarness')).createChatListHarnessItemsModuleMock(buildChatListItemsMock)
));

vi.mock('./ChatFooter', () => ({
    ChatFooter: () => React.createElement('ChatFooter'),
}));

vi.mock('./MessageView', () => ({
    MessageView: (props: Record<string, any>) => {
        capturedMessageViewProps.push(props);
        return React.createElement('MessageView', props);
    },
    MessageViewWithSessionCommon: (props: Record<string, any>) => {
        capturedMessageViewProps.push(props);
        return React.createElement('MessageViewWithSessionCommon', props);
    },
}));

vi.mock('@/components/sessions/transcript/toolCalls/ToolCallsGroupRow', () => ({
    ToolCallsGroupRow: (props: Record<string, any>) => {
        capturedToolGroupRowProps.push(props);
        return React.createElement('ToolCallsGroupRow', props);
    },
    ToolCallsGroupRowWithSessionCommon: (props: Record<string, any>) => {
        capturedToolGroupRowProps.push(props);
        return React.createElement('ToolCallsGroupRowWithSessionCommon', props);
    },
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
    useEnrichedMarkdownRuntimeStatus: () => 'ready',
}));

vi.mock('@/sync/domains/state/agentStateCapabilities', () => ({
    getPermissionsInUiWhileLocal: () => ({}),
}));

vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (promise: Promise<unknown> | unknown) => promise,
}));

vi.mock('@/sync/sync', async () => (
    (await import('@/dev/testkit/harness/chatListHarness')).createChatListHarnessSyncModuleMock({
        loadOlderMessages: loadOlderMessagesMock,
        loadNewerMessages: loadNewerMessagesMock,
        prefetchForkedTranscriptContext: prefetchForkedTranscriptContextMock,
        getSessionViewport: () => null,
    })
));

const scopeA: ServerAccountScope = { serverId: 'server-a', accountId: 'account-a' };
const scopeB: ServerAccountScope = { serverId: 'server-a', accountId: 'account-b' };

function pin(overrides: Partial<PersistedSessionMessagePinV1> = {}): PersistedSessionMessagePinV1 {
    return {
        version: 1,
        sessionId: 'session-1',
        seq: 7,
        transcriptBlockIndex: 0,
        routeMessageId: 'local:u1',
        role: 'user',
        pinnedAtMs: 1_000,
        label: null,
        ...overrides,
    };
}

function seedTranscriptMessages() {
    chatListHarnessState.sessionMessagesState = {
        isLoaded: true,
        messages: [
            {
                kind: 'user-text',
                id: 'u1',
                localId: 'u1',
                createdAt: 1,
                text: 'Remember this setup step',
                seq: 7,
                transcriptBlockIndex: 0,
            },
            {
                kind: 'agent-text',
                id: 'a1',
                localId: 'a1',
                createdAt: 2,
                text: 'The setup step is pinned context',
                seq: 7,
                transcriptBlockIndex: 1,
                isThinking: false,
            },
            {
                kind: 'tool-call',
                id: 'tool1',
                localId: 'tool1',
                createdAt: 3,
                seq: 8,
                transcriptBlockIndex: 2,
                tool: {
                    id: 'call-1',
                    name: 'shell',
                    state: 'completed',
                    input: {},
                    createdAt: 3,
                    startedAt: 3,
                    completedAt: 4,
                    description: null,
                },
                children: [],
            },
        ],
    };
}

describe('ChatList message pins host wiring', () => {
    beforeEach(() => {
        persistedStorage.clear();
        loadOlderMessagesMock.mockReset();
        loadNewerMessagesMock.mockReset();
        prefetchForkedTranscriptContextMock.mockClear();
        capturedMessageViewProps = [];
        capturedToolGroupRowProps = [];
        buildChatListItemsMock.mockClear();
        resetChatListHarness({
            syncTuningState: {
            },
        });
        chatListHarnessState.activeServerAccountScope = scopeA;
        chatListHarnessState.sessionState = {
            ...chatListHarnessState.sessionState,
            id: 'session-1',
            seq: 8,
            active: true,
            metadata: { flavor: 'codex', codexBackendMode: 'appServer' },
        };
        chatListHarnessState.settingValues.transcriptGroupingMode = 'linear';
        chatListHarnessState.settingValues.transcriptGroupToolCalls = true;
        chatListHarnessState.settingValues.toolViewTimelineChromeMode = 'cards';
    });

    afterEach(() => {
        standardCleanup();
    });

    it('loads scoped persisted pins and forwards pin state plus toggle callbacks to message and tool rows', async () => {
        const {
            readPersistedSessionMessagePins,
            savePersistedSessionMessagePins,
        } = await import('@/sync/domains/state/sessionMessagePinsPersistence');
        const scopedUserPin = pin();
        const otherScopePin = pin({
            seq: 99,
            transcriptBlockIndex: 0,
            routeMessageId: 'server:other-scope',
            pinnedAtMs: 2_000,
        });
        savePersistedSessionMessagePins('session-1', [scopedUserPin], scopeA);
        savePersistedSessionMessagePins('session-1', [otherScopePin], scopeB);
        seedTranscriptMessages();

        const screen = await renderChatListHarnessSession();

        const userRowProps = capturedMessageViewProps.filter((props) => props.message?.id === 'u1').at(-1);
        const assistantRowProps = capturedMessageViewProps.filter((props) => props.message?.id === 'a1').at(-1);
        const toolRowProps = capturedMessageViewProps.filter((props) => props.message?.id === 'tool1').at(-1)
            ?? capturedToolGroupRowProps.filter((props) => props.toolMessageIds?.includes('tool1')).at(-1);

        expect(userRowProps?.messagePins).toEqual([scopedUserPin]);
        expect(assistantRowProps?.messagePins).toEqual([scopedUserPin]);
        expect(toolRowProps?.messagePins).toEqual([scopedUserPin]);
        expect(typeof userRowProps?.onToggleMessagePin).toBe('function');
        expect(typeof assistantRowProps?.onToggleMessagePin).toBe('function');
        expect(typeof toolRowProps?.onToggleToolPin).toBe('function');

        const assistantPin = pin({
            seq: 7,
            transcriptBlockIndex: 1,
            routeMessageId: 'local:a1',
            role: 'assistant',
            pinnedAtMs: 3_000,
        });
        await act(async () => {
            userRowProps?.onToggleMessagePin?.(assistantPin);
        });

        expect(readPersistedSessionMessagePins('session-1', scopeA)).toEqual([
            scopedUserPin,
            assistantPin,
        ]);
        expect(readPersistedSessionMessagePins('session-1', scopeB)).toEqual([otherScopePin]);

        await screen.unmount();
    });
});
