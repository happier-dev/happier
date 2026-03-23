import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  flashListChatListHarnessState,
  renderFlashListChatList,
  resetFlashListChatListHarness,
  standardCleanup,
} from '@/dev/testkit';
import {
  installTranscriptCommonModuleMocks,
  resetTranscriptCommonModuleMockState,
} from './transcriptTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installTranscriptCommonModuleMocks({
  reactNative: async () =>
    (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListReactNativeMock({
      platformOs: 'web',
    }),
  storage: async (importOriginal) =>
    (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListStorageMock(importOriginal),
});

beforeEach(() => {
  resetTranscriptCommonModuleMockState();
  resetFlashListChatListHarness({ platformOs: 'web' });
  flashListChatListHarnessState.sessionMessagesState = {
    messages: [{ kind: 'user-text', id: 'm1', localId: 'u1', createdAt: 1, text: 'hi' }],
    isLoaded: true,
  };
  flashListChatListHarnessState.sessionPendingState = { messages: [], discarded: [], isLoaded: true };
  flashListChatListHarnessState.sessionActionDraftsState = [];
  flashListChatListHarnessState.sessionState = {
    ...flashListChatListHarnessState.sessionState,
    id: 'session-1',
    seq: 0,
    metadata: null,
    accessLevel: null,
    canApprovePermissions: true,
    presence: 'online',
  };
});

afterEach(() => {
  resetTranscriptCommonModuleMockState();
  standardCleanup();
});

vi.mock('@/components/ui/lists/flashListCompat/FlashListCompat', async () =>
  (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListModuleMock()
);

vi.mock('@/utils/platform/responsive', () => ({
  useHeaderHeight: () => 0,
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/components/sessions/chatListItems', async () =>
  (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListItemsModuleMock(({ messageIdsOldestFirst, messagesById }: any) =>
    (messageIdsOldestFirst ?? []).map((id: string) => {
      const message = messagesById?.[id];
      return { kind: 'message', id: `msg:${id}`, messageId: id, createdAt: message?.createdAt ?? 0, seq: null };
    }),
  )
);

vi.mock('./ChatFooter', () => ({
  ChatFooter: () => React.createElement('ChatFooter'),
}));

vi.mock('./MessageView', () => ({
  MessageView: () => React.createElement('MessageView'),
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

vi.mock('@/components/sessions/transcript/toolCalls/ToolCallsGroupRow', () => ({
  ToolCallsGroupRow: () => React.createElement('ToolCallsGroupRow'),
}));

vi.mock('@/components/sessions/transcript/forkContext/ForkDividerRow', () => ({
  ForkDividerRow: () => React.createElement('ForkDividerRow'),
}));

vi.mock('@/components/sessions/transcript/forkContext/injectForkContextRows', () => ({
  injectForkContextRows: ({ baseItems }: any) => baseItems,
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptMotionProvider', () => ({
  TranscriptMotionProvider: ({ children }: any) => React.createElement('TranscriptMotionProvider', null, children),
}));

vi.mock('@/components/sessions/transcript/motion/resolveTranscriptMotionConfig', () => ({
  resolveTranscriptMotionConfig: () => ({}),
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptEnterWrapper', () => ({
  TranscriptEnterWrapper: ({ children }: any) => React.createElement('TranscriptEnterWrapper', null, children),
}));

vi.mock('@/components/sessions/transcript/scroll/JumpToBottomButton', () => ({
  JumpToBottomButton: () => React.createElement('JumpToBottomButton'),
}));

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
  useReducedMotionPreference: () => false,
}));

vi.mock('@/utils/sessions/deriveTranscriptInteraction', () => ({
  deriveTranscriptInteraction: () => ({ canSendMessages: true, canApprovePermissions: true, isSessionActive: true }),
}));

describe('ChatList (FlashList v2 web crash fallback)', () => {
  it('falls back to FlatList on web when FlashList throws "not enough layouts"', async () => {
    flashListChatListHarnessState.settingValues.transcriptListImplementation = 'flash_v2';

    const globalWindowContainer = globalThis as unknown as { window?: unknown };
    const previousWindow = globalWindowContainer.window;
    const listeners = new Map<string, EventListenerOrEventListenerObject[]>();
    try {
      globalWindowContainer.window = {
        addEventListener: (type: string, fn: EventListenerOrEventListenerObject) => {
          const entries = listeners.get(type) ?? [];
          entries.push(fn);
          listeners.set(type, entries);
        },
        removeEventListener: (type: string, fn: EventListenerOrEventListenerObject) => {
          const entries = listeners.get(type) ?? [];
          listeners.set(
            type,
            entries.filter((entry) => entry !== fn),
          );
        },
      };

      const { ChatList } = await import('./ChatList');
      const screen = await renderFlashListChatList(
        <ChatList session={flashListChatListHarnessState.sessionState} />
      );

      expect(screen.requireCapturedFlashListProps()).toBeTruthy();
      expect(listeners.get('error')?.length ?? 0).toBeGreaterThan(0);

      const errorMessage = 'index out of bounds, not enough layouts';
      const handler = (listeners.get('error') ?? [])[0];
      expect(typeof handler).toBe('function');

      const fakeEvent = {
        message: errorMessage,
        error: new Error(errorMessage),
        preventDefault: vi.fn(),
        stopImmediatePropagation: vi.fn(),
      } as unknown as ErrorEvent;

      await act(async () => {
        (handler as EventListener)(fakeEvent);
      });

      expect(screen.requireCapturedFlashListProps()).toBeTruthy();
      expect(screen.findAllByType('FlatList' as any).length).toBeGreaterThan(0);
    } finally {
      globalWindowContainer.window = previousWindow;
    }
  });

  it('does not fall back for unrelated "index out of bounds" errors', async () => {
    flashListChatListHarnessState.settingValues.transcriptListImplementation = 'flash_v2';

    const globalWindowContainer = globalThis as unknown as { window?: unknown };
    const previousWindow = globalWindowContainer.window;
    const listeners = new Map<string, EventListenerOrEventListenerObject[]>();
    try {
      globalWindowContainer.window = {
        addEventListener: (type: string, fn: EventListenerOrEventListenerObject) => {
          const entries = listeners.get(type) ?? [];
          entries.push(fn);
          listeners.set(type, entries);
        },
        removeEventListener: (type: string, fn: EventListenerOrEventListenerObject) => {
          const entries = listeners.get(type) ?? [];
          listeners.set(
            type,
            entries.filter((entry) => entry !== fn),
          );
        },
      };

      const { ChatList } = await import('./ChatList');
      const screen = await renderFlashListChatList(
        <ChatList session={flashListChatListHarnessState.sessionState} />
      );

      expect(screen.requireCapturedFlashListProps()).toBeTruthy();
      expect(listeners.get('error')?.length ?? 0).toBeGreaterThan(0);

      const errorMessage = 'index out of bounds';
      const handler = (listeners.get('error') ?? [])[0];
      expect(typeof handler).toBe('function');

      const fakeEvent = {
        message: errorMessage,
        error: new Error(errorMessage),
        preventDefault: vi.fn(),
        stopImmediatePropagation: vi.fn(),
      } as unknown as ErrorEvent;

      await act(async () => {
        (handler as EventListener)(fakeEvent);
      });

      expect(screen.requireCapturedFlashListProps()).toBeTruthy();
      expect(screen.findAllByType('FlatList' as any)).toHaveLength(0);
    } finally {
      globalWindowContainer.window = previousWindow;
    }
  });
});
