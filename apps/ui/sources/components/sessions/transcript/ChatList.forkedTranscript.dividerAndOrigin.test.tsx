import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import type { StorageState } from '@/sync/store/types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedMessageViewProps: any[] = [];

let sessionState: any = null;
let forkSnapshot: any = null;

const useMessageMock = vi.fn();

const settingValues: Record<string, any> = {};
const flashListRuntime = vi.hoisted(() => ({ mock: null as any }));

function createStorageState() {
    return {
        sessions: {
            'child-1': sessionState,
            'parent-1': {
                id: 'parent-1',
                seq: 3,
                metadata: null,
                accessLevel: null,
                canApprovePermissions: true,
                agentState: null,
            },
        },
        sessionMessages: {
            'child-1': {
                messagesById: { c1: forkSnapshot?.combinedMessagesById?.c1 },
                messagesMap: { c1: forkSnapshot?.combinedMessagesById?.c1 },
            },
            'parent-1': {
                messagesById: { p1: forkSnapshot?.combinedMessagesById?.p1 },
                messagesMap: { p1: forkSnapshot?.combinedMessagesById?.p1 },
            },
        },
        updateSessionDraft: vi.fn(),
        // Test boundary fixture: ChatList reads only these populated slices from storage state here.
    } as unknown as Partial<StorageState>;
}

beforeEach(() => {
    if (flashListRuntime.mock) {
        flashListRuntime.mock.state.props = null;
    }
    capturedMessageViewProps = [];
    useMessageMock.mockReset();
    Object.keys(settingValues).forEach((k) => delete settingValues[k]);

    sessionState = {
        id: 'child-1',
        seq: 10,
        metadata: null,
        accessLevel: null,
        canApprovePermissions: true,
        agentState: null,
    };

    forkSnapshot = {
        segments: [
            {
                sessionId: 'parent-1',
                isReadOnlyContext: true,
                cutoffSeqInclusive: 3,
                messageIdsOldestFirst: ['p1'],
            },
            {
                sessionId: 'child-1',
                isReadOnlyContext: false,
                cutoffSeqInclusive: null,
                messageIdsOldestFirst: ['c1'],
            },
        ],
        combinedMessageIdsOldestFirst: ['p1', 'c1'],
        combinedMessagesById: {
            p1: { kind: 'agent-text', id: 'p1', createdAt: 1, text: 'parent', isThinking: false },
            c1: { kind: 'agent-text', id: 'c1', createdAt: 2, text: 'child', isThinking: false },
        },
        messageOriginById: {
            p1: { sessionId: 'parent-1', isReadOnlyContext: true },
            c1: { sessionId: 'child-1', isReadOnlyContext: false },
        },
        isLoaded: true,
    };

    useMessageMock.mockImplementation((sessionId: string, messageId: string) => {
        return { kind: 'agent-text', id: messageId, createdAt: 1, text: `${sessionId}:${messageId}`, isThinking: false };
    });

    settingValues.transcriptListImplementation = 'flash_v2';
    settingValues.transcriptGroupingMode = 'linear';
    settingValues.transcriptAnimateNewItemsEnabled = false;
    settingValues.transcriptAnimateToolExpandCollapseEnabled = false;
    settingValues.transcriptAnimateThinkingEnabled = false;
});

afterEach(() => {
    standardCleanup();
});

vi.mock('@shopify/flash-list', async () => {
    const { createCapturingFlashListMock } = await import('@/dev/testkit/mocks/flashList');
    const flashListMock = createCapturingFlashListMock({ renderItems: true });
    flashListRuntime.mock = flashListMock;
    return flashListMock.module;
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                Platform: {
                                    OS: 'ios',
                                    select: (values: any) => values?.ios ?? values?.default,
                                },
                                View: (props: any) => React.createElement('View', props, props.children),
                                Text: (props: any) => React.createElement('Text', props, props.children),
                                Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
                                ActivityIndicator: () => React.createElement('ActivityIndicator'),
                                FlatList: () => React.createElement('FlatList'),
                            }
    );
});

vi.mock('@/utils/platform/responsive', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    useHeaderHeight: () => 0,
  };
});

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock, createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            storage: createStorageStoreMock(createStorageState()),
            useSession: () => sessionState,
            useSessionTranscriptIds: () => ({ ids: ['c1'], isLoaded: true }),
            useSessionMessagesById: () => ({
                c1: { kind: 'agent-text', id: 'c1', localId: null, createdAt: 2, text: 'child', isThinking: false },
            }),
            useForkedTranscriptSnapshot: () => forkSnapshot,
            useSessionPendingMessages: () => ({ messages: [], discarded: [], isLoaded: true }),
            useSessionActionDrafts: () => ([]),
            useSessionLatestThinkingMessageId: () => null,
            useSessionLatestThinkingMessageActivityAtMs: () => null,
            useMessage: useMessageMock,
            useSetting: (key: string) => settingValues[key],
            getStorage: () => createStorageStoreMock(createStorageState()),
        },
    });
});

vi.mock('@/components/sessions/chatListItems', () => ({
  buildChatListItems: ({ messageIdsOldestFirst, messagesById }: any) =>
    (messageIdsOldestFirst ?? []).map((id: string) => {
      const m = messagesById?.[id];
      return { kind: 'message', id: `msg:${id}`, messageId: id, createdAt: m?.createdAt ?? 0, seq: 1 };
    }),
  buildChatListItemsCached: (opts: any) => ({
    cache: null,
    items: (opts?.messageIdsOldestFirst ?? []).map((id: string) => {
      const m = opts?.messagesById?.[id];
      return { kind: 'message', id: `msg:${id}`, messageId: id, createdAt: m?.createdAt ?? 0, seq: 1 };
    }),
  }),
}));

vi.mock('./ChatFooter', () => ({
  ChatFooter: () => React.createElement('ChatFooter'),
}));

vi.mock('./MessageView', () => ({
  MessageView: (props: any) => {
    capturedMessageViewProps.push(props);
    return React.createElement('MessageView');
  },
}));

vi.mock('@/components/sessions/pending/PendingMessagesTranscriptBlock', () => ({
  PendingMessagesTranscriptBlock: () => React.createElement('PendingMessagesTranscriptBlock'),
}));

vi.mock('@/components/sessions/actions/SessionActionDraftCard', () => ({
  SessionActionDraftCard: () => React.createElement('SessionActionDraftCard'),
}));

vi.mock('@/components/sessions/transcript/turns/TurnView', () => ({
  TurnView: () => React.createElement('TurnView'),
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptMotionProvider', () => ({
  TranscriptMotionProvider: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/sessions/transcript/motion/resolveTranscriptMotionConfig', () => ({
  resolveTranscriptMotionConfig: () => ({ preset: 'off', animateThinkingEnabled: false }),
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptEnterWrapper', () => ({
  TranscriptEnterWrapper: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/sessions/transcript/scroll/JumpToBottomButton', () => ({
  JumpToBottomButton: () => null,
}));

vi.mock('@/components/sessions/transcript/scroll/transcriptScrollPinController', async () => {
  const actual = await vi.importActual<any>('@/components/sessions/transcript/scroll/transcriptScrollPinController');
  return actual;
});

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
  useReducedMotionPreference: () => false,
}));

vi.mock('@/components/sessions/transcript/thinking/resolveActiveThinkingMessageId', () => ({
  resolveActiveThinkingMessageId: () => null,
}));

vi.mock('@/sync/domains/state/agentStateCapabilities', () => ({
  getPermissionsInUiWhileLocal: () => ({}),
}));

vi.mock('@/sync/sync', () => ({
  sync: {
    loadOlderMessages: vi.fn(),
    loadOlderMessagesForkAware: vi.fn(),
    loadNewerMessages: vi.fn(),
    hasDeferredNewerMessages: () => false,
    getSyncTuning: () => ({
      transcriptForwardPrefetchThresholdPx: 0,
      transcriptBackwardPrefetchThresholdPx: 0,
      transcriptFlashListEstimatedItemSize: 120,
      transcriptWebInitialPinStabilizeMs: 3000,
      transcriptWebInitialPinRetryIntervalMs: 250,
    }),
  },
}));

describe('ChatList (forked transcript)', () => {
    async function renderChatList() {
        const { ChatList } = await import('./ChatList');
        return renderScreen(<ChatList session={{ ...sessionState }} />);
    }

    it('injects a fork divider row between ancestor context and child messages', async () => {
        const screen = await renderChatList();

        const data = flashListRuntime.mock.state.props?.data ?? [];
        expect(Array.isArray(data)).toBe(true);

        const dividerIndex = data.findIndex((it: any) => it?.kind === 'fork-divider');
        expect(dividerIndex).toBe(1);
        expect(data[dividerIndex]).toEqual(
            expect.objectContaining({
                kind: 'fork-divider',
                parentSessionId: 'parent-1',
                childSessionId: 'child-1',
                parentCutoffSeqInclusive: 3,
            }),
        );

        await screen.unmount();
    });

    it('disables permission approvals when the session is inactive (presence offline)', async () => {
        sessionState.presence = 'offline';

        const screen = await renderChatList();

        const childMessageView = capturedMessageViewProps.find((props) => props?.sessionId === 'child-1');
        expect(childMessageView).toBeTruthy();
        expect(childMessageView.interaction).toEqual(
            expect.objectContaining({
                canApprovePermissions: false,
                permissionDisabledReason: 'inactive',
            }),
        );

        await screen.unmount();
    });

    it('renders ancestor messages by reading them from their origin sessionId and marks them read-only', async () => {
        const screen = await renderChatList();

        expect(useMessageMock).toHaveBeenCalledWith('parent-1', 'p1');
        expect(useMessageMock).toHaveBeenCalledWith('child-1', 'c1');

        const firstMessageView = capturedMessageViewProps[0];
        expect(firstMessageView).toBeTruthy();
        expect(firstMessageView.sessionId).toBe('parent-1');
        expect(firstMessageView.interaction).toEqual(
            expect.objectContaining({
                canSendMessages: false,
                canApprovePermissions: false,
                permissionDisabledReason: 'readOnly',
                disableToolNavigation: true,
            }),
        );

        await screen.unmount();
    });

    it('loads older messages via fork-aware paging when reaching the start of the list', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderForkAware = (syncMod as any).sync.loadOlderMessagesForkAware as ReturnType<typeof vi.fn>;
        loadOlderForkAware.mockResolvedValueOnce({ loaded: 0, hasMore: true, status: 'loaded' });

        const screen = await renderChatList();

        await act(async () => {
            flashListRuntime.mock.state.props?.onLayout?.({ nativeEvent: { layout: { height: 200 } } });
            flashListRuntime.mock.state.props?.onContentSizeChange?.(0, 400);
            await flushHookEffects({ cycles: 1, turns: 2 });
        });

        await act(async () => {
            flashListRuntime.mock.state.props?.onStartReached?.();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(loadOlderForkAware).toHaveBeenCalledWith('child-1');

        await screen.unmount();
    });
});
