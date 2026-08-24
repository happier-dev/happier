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
let capturedBuildChatListItemsOptions: any[] = [];
let capturedToolCallsGroupRowProps: any[] = [];
let capturedToolGroupUnitHeaderProps: any[] = [];
let capturedToolGroupUnitToolProps: any[] = [];

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
    capturedBuildChatListItemsOptions = [];
    capturedToolCallsGroupRowProps = [];
    capturedToolGroupUnitHeaderProps = [];
    capturedToolGroupUnitToolProps = [];
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

// ChatListInternal reads session-screen navigation focus for the S-E reveal
// revalidation; keep this host suite navigation-context-free.
vi.mock('@/components/sessions/shell/useSessionScreenIsFocused', () => ({
    useSessionScreenIsFocused: () => true,
}));

// This suite documents flash_v2 semantics (N2c row decomposition, FlashList fill
// loop) and reads the captured FlashList props; pin the FlashList escape hatch like
// the monolith regression lane now that default composition is Legend. Without the
// pin the suite mounted the REAL @legendapp/list package (requestAnimationFrame
// crash) — the documented stale-mock class from the 2026-07-10 review.
vi.mock('@/sync/runtime/syncTuning', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/runtime/syncTuning')>();
    return {
        ...actual,
        loadSyncTuning: () => ({
            ...actual.loadSyncTuning(),
            transcriptLegendListSpikeSurface: 'flashList' as const,
        }),
    };
});

vi.mock('@/components/ui/lists/flashListCompat/FlashListCompat', async () => {
    const { createCapturingFlashListMock } = await import('@/dev/testkit/mocks/flashList');
    const flashListMock = createCapturingFlashListMock({ renderItems: true });
    flashListRuntime.mock = flashListMock;
    return {
        ...flashListMock.module,
        LayoutCommitObserver: ({ children, onCommitLayoutEffect }: any) => {
            React.useLayoutEffect(() => {
                onCommitLayoutEffect?.();
            });
            return React.createElement(React.Fragment, null, children);
        },
        useLayoutState: (initialState: any) => {
            const [state, setState] = React.useState(() => (
                typeof initialState === 'function' ? initialState() : initialState
            ));
            return [state, setState];
        },
        useRecyclingState: (initialState: any, _deps: React.DependencyList, onReset?: () => void) => {
            const [state, setState] = React.useState(() => (
                typeof initialState === 'function' ? initialState() : initialState
            ));
            React.useLayoutEffect(() => {
                setState(typeof initialState === 'function' ? initialState() : initialState);
                onReset?.();
            }, _deps);
            return [state, setState];
        },
        flashListRuntime: { usingFallback: false },
    };
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
            useSessionTranscriptIds: () => ({ ids: ['c1'], isLoaded: true, hasRetainedContent: false }),
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
    items: (() => {
      capturedBuildChatListItemsOptions.push(opts);
      const items: any[] = [];
      for (const id of opts?.messageIdsOldestFirst ?? []) {
        const m = opts?.messagesById?.[id];
        if (opts?.groupConsecutiveToolCalls === true && m?.kind === 'tool-call') {
          items.push({
            kind: 'tool-calls-group',
            id: `tool-group:${id}`,
            toolMessageIds: [id],
            createdAt: m?.createdAt ?? 0,
            originSessionId: opts?.forkMetadataByMessageId?.[id]?.originSessionId,
            isReadOnlyContext: opts?.forkMetadataByMessageId?.[id]?.isReadOnlyContext === true,
          });
          continue;
        }
        items.push({
          kind: 'message',
          id: `msg:${id}`,
          messageId: id,
          createdAt: m?.createdAt ?? 0,
          seq: 1,
          ...(opts?.forkMetadataByMessageId?.[id]?.originSessionId
            ? { originSessionId: opts.forkMetadataByMessageId[id].originSessionId }
            : null),
          ...(opts?.forkMetadataByMessageId?.[id]?.isReadOnlyContext === true
            ? { isReadOnlyContext: true }
            : null),
        });
      }
      return items;
    })(),
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
  MessageViewWithSessionCommon: (props: any) => {
    capturedMessageViewProps.push(props);
    return React.createElement('MessageViewWithSessionCommon');
  },
}));

vi.mock('@/components/sessions/transcript/toolCalls/ToolCallsGroupRow', () => ({
  ToolCallsGroupRow: (props: any) => {
    capturedToolCallsGroupRowProps.push(props);
    return React.createElement('ToolCallsGroupRow');
  },
  ToolCallsGroupRowWithSessionCommon: (props: any) => {
    capturedToolCallsGroupRowProps.push(props);
    return React.createElement('ToolCallsGroupRowWithSessionCommon');
  },
}));

// N2c per-unit rows: under flash_v2 tool groups render as header/expand/tool/footer units.
vi.mock('@/components/sessions/transcript/toolCalls/units/ToolCallsGroupUnitHeaderRow', () => ({
  ToolCallsGroupUnitHeaderRow: (props: any) => {
    capturedToolGroupUnitHeaderProps.push(props);
    return React.createElement('ToolCallsGroupUnitHeaderRow');
  },
  ToolCallsGroupUnitHeaderRowWithSessionCommon: (props: any) => {
    capturedToolGroupUnitHeaderProps.push(props);
    return React.createElement('ToolCallsGroupUnitHeaderRowWithSessionCommon');
  },
}));

vi.mock('@/components/sessions/transcript/toolCalls/units/ToolCallsGroupUnitToolRow', () => ({
  ToolCallsGroupUnitToolRow: (props: any) => {
    capturedToolGroupUnitToolProps.push(props);
    return React.createElement('ToolCallsGroupUnitToolRow');
  },
  ToolCallsGroupUnitToolRowWithSessionCommon: (props: any) => {
    capturedToolGroupUnitToolProps.push(props);
    return React.createElement('ToolCallsGroupUnitToolRowWithSessionCommon');
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
  TurnViewWithSessionCommon: () => React.createElement('TurnViewWithSessionCommon'),
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

vi.mock('@/components/sessions/transcript/scroll/transcriptBottomFollowMode', async () => {
  const actual = await vi.importActual<any>('@/components/sessions/transcript/scroll/transcriptBottomFollowMode');
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

vi.mock('@/sync/sync', async () =>
  (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListSyncModuleMock({
    loadOlderMessagesForkAware: vi.fn(),
    hasDeferredNewerMessages: () => false,
  }),
);

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

    it('preserves selected activity-feed grouped tool settings for forked sessions', async () => {
        settingValues.transcriptGroupToolCalls = true;
        settingValues.toolViewTimelineChromeMode = 'activity_feed';

        const screen = await renderChatList();

        const opts = capturedBuildChatListItemsOptions.at(-1);
        expect(opts).toBeTruthy();
        expect(opts.groupConsecutiveToolCalls).toBe(true);
        expect(opts.forkBoundarySignature).toBe('c1');
        expect(opts.forkBoundaryBeforeMessageIds.has('c1')).toBe(true);

        await screen.unmount();
    });

    it('renders ancestor-origin top-level tool groups as read-only through the current session', async () => {
        settingValues.transcriptGroupToolCalls = true;
        settingValues.toolViewTimelineChromeMode = 'activity_feed';
        forkSnapshot.combinedMessagesById.p1 = {
            kind: 'tool-call',
            id: 'p1',
            createdAt: 1,
            callId: 'call-parent',
            toolName: 'shell',
            state: 'completed',
            tool: {
                name: 'shell',
                state: 'completed',
                permission: { status: 'granted' },
            },
        };

        const screen = await renderChatList();

        // N2c: under flash_v2 the group renders as per-unit rows; the read-only
        // ancestor-origin interaction must reach both the header and tool units.
        const readOnlyInteraction = expect.objectContaining({
            canSendMessages: false,
            canApprovePermissions: false,
            permissionDisabledReason: 'readOnly',
            disableToolNavigation: true,
        });
        const headerProps = capturedToolGroupUnitHeaderProps[0];
        expect(headerProps).toBeTruthy();
        expect(headerProps.sessionId).toBe('child-1');
        expect(headerProps.toolMessages.map((m: any) => m.id)).toEqual(['p1']);
        expect(headerProps.interaction).toEqual(readOnlyInteraction);

        const toolProps = capturedToolGroupUnitToolProps[0];
        expect(toolProps).toBeTruthy();
        expect(toolProps.sessionId).toBe('child-1');
        expect(toolProps.message?.id).toBe('p1');
        expect(toolProps.interaction).toEqual(readOnlyInteraction);

        await screen.unmount();
    });

    it('preserves selected turns mode and still inserts fork dividers', async () => {
        settingValues.transcriptGroupingMode = 'turns';
        settingValues.transcriptGroupToolCalls = true;
        settingValues.toolViewTimelineChromeMode = 'activity_feed';

        const screen = await renderChatList();

        const data = flashListRuntime.mock.state.props?.data ?? [];
        // N2c: turn items decompose into per-unit/message rows under flash_v2 — the
        // turns-mode invariant is that committed content was NOT built through the
        // linear items builder and decomposed message rows carry the `msg:` ids.
        expect(data.some((it: any) => it?.kind === 'turn')).toBe(false);
        expect(data.some((it: any) => it?.kind === 'message' && typeof it?.id === 'string' && it.id.startsWith('msg:'))).toBe(true);
        expect(data.some((it: any) => it?.kind === 'fork-divider')).toBe(true);
        expect(capturedBuildChatListItemsOptions).toHaveLength(0);

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

        const ancestorMessageView = capturedMessageViewProps.find((props) => (
            props?.sessionId === 'parent-1' && props?.message?.id === 'p1'
        ));
        expect(ancestorMessageView).toBeTruthy();
        expect(ancestorMessageView.interaction).toEqual(
            expect.objectContaining({
                canSendMessages: false,
                canApprovePermissions: false,
                permissionDisabledReason: 'readOnly',
                disableToolNavigation: true,
            }),
        );

        await screen.unmount();
    });

    it('loads older messages via fork-aware paging when the transcript needs older pages', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderForkAware = (syncMod as any).sync.loadOlderMessagesForkAware as ReturnType<typeof vi.fn>;
        loadOlderForkAware.mockResolvedValueOnce({ loaded: 0, hasMore: false, status: 'no_more' });

        const screen = await renderChatList();

        // An under-filled viewport drives the initial-fill loop through ChatList.loadOlder,
        // which must route through the fork-aware sync paging entrypoint.
        await act(async () => {
            flashListRuntime.mock.state.props?.onLayout?.({ nativeEvent: { layout: { height: 200 } } });
            flashListRuntime.mock.state.props?.onContentSizeChange?.(0, 100);
            await flushHookEffects({ cycles: 2, turns: 3 });
        });

        expect(loadOlderForkAware).toHaveBeenCalledWith('child-1', { limit: 64 });

        await screen.unmount();
    });
});
