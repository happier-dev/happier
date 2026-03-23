import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit';
import {
  legacyChatListHarnessState,
  renderLegacyChatList,
  resetLegacyChatListHarness,
} from './ChatList.legacyListTestHarness';
import { installLegacyChatListHarnessCommonModuleMocks } from './chatListLegacyHarnessTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const buildChatListItemsMock = vi.fn((..._args: any[]): any[] => []);

let renderedMessageViewProps: any[] = [];

installLegacyChatListHarnessCommonModuleMocks();

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
  useReducedMotionPreference: () => false,
}));

vi.mock('@/components/sessions/chatListItems', async () => (
  (await import('./ChatList.legacyListTestHarness')).createLegacyChatListItemsModuleMock(buildChatListItemsMock)
));

vi.mock('@/components/sessions/transcript/motion/TranscriptMotionProvider', () => ({
  TranscriptMotionProvider: (props: any) => React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptEnterWrapper', () => ({
  TranscriptEnterWrapper: (props: any) => React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/components/sessions/transcript/scroll/JumpToBottomButton', () => ({
  JumpToBottomButton: () => null,
}));

vi.mock('./ChatFooter', () => ({
  ChatFooter: () => React.createElement('ChatFooter'),
}));

vi.mock('./MessageView', () => ({
  MessageView: (props: any) => {
    renderedMessageViewProps.push(props);
    return React.createElement('MessageView', props);
  },
}));

vi.mock('@/components/sessions/transcript/turns/TurnView', () => ({
  TurnView: () => React.createElement('TurnView'),
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

vi.mock('@/utils/system/fireAndForget', () => ({
  fireAndForget: (p: any) => p,
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

describe('ChatList (thinking expansion controlled)', () => {
  afterEach(() => {
    standardCleanup();
  });

  beforeEach(() => {
    resetLegacyChatListHarness();
    buildChatListItemsMock.mockReset();
    renderedMessageViewProps = [];
  });

  it('controls inline thinking expansion via list-owned state (no per-row state)', async () => {
    legacyChatListHarnessState.settingValues.transcriptGroupingMode = 'linear';
    legacyChatListHarnessState.settingValues.transcriptListImplementation = 'flatlist_legacy';
    legacyChatListHarnessState.settingValues.sessionThinkingDisplayMode = 'inline';
    legacyChatListHarnessState.settingValues.sessionThinkingInlinePresentation = 'summary';

    const thinkingMessage = { kind: 'agent-text', id: 't1', localId: null, createdAt: 1, text: 'think', isThinking: true };
    const normalMessage = { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'answer', isThinking: false };
    legacyChatListHarnessState.sessionMessagesState = {
      isLoaded: true,
      messages: [thinkingMessage, normalMessage],
    };
    buildChatListItemsMock.mockReturnValue([
      { kind: 'message', id: thinkingMessage.id, messageId: thinkingMessage.id, createdAt: thinkingMessage.createdAt, seq: null },
      { kind: 'message', id: normalMessage.id, messageId: normalMessage.id, createdAt: normalMessage.createdAt, seq: null },
    ]);

    const screen = await renderLegacyChatList();

    const firstThinkingProps = renderedMessageViewProps.find((p) => p?.message?.id === 't1');
    const firstNormalProps = renderedMessageViewProps.find((p) => p?.message?.id === 'a1');

    expect(firstThinkingProps?.thinkingExpanded).toBe(false);
    expect(typeof firstThinkingProps?.onThinkingExpandedChange).toBe('function');
    expect(firstNormalProps?.thinkingExpanded).toBeUndefined();
    expect(firstNormalProps?.onThinkingExpandedChange).toBeUndefined();

    await act(async () => {
      firstThinkingProps.onThinkingExpandedChange(true);
    });

    const lastThinkingProps = [...renderedMessageViewProps].reverse().find((p) => p?.message?.id === 't1');
    expect(lastThinkingProps?.thinkingExpanded).toBe(true);

    await screen.unmount();
  });
});
