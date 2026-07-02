import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import {
    installTranscriptCommonModuleMocks,
    resetTranscriptCommonModuleMockState,
} from './transcriptTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const settingValues: Record<string, any> = {};
let renderedMessageViewProps: any[] = [];
let renderedMessageViewWithCommonProps: any[] = [];

vi.mock('@shopify/flash-list', () => ({
  FlashList: () => null,
}));

installTranscriptCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
            },
            View: (props: any) => React.createElement('View', props, props.children),
            ActivityIndicator: () => React.createElement('ActivityIndicator'),
            FlatList: (props: any) => {
                const children = (props.data ?? []).map((item: any, index: number) =>
                    React.createElement(
                        React.Fragment,
                        { key: props.keyExtractor?.(item, index) ?? String(index) },
                        props.renderItem?.({ item, index }),
                    ),
                );
                return React.createElement('FlatList', props, children);
            },
        });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSetting: (key: string) => settingValues[key],
            useSessionForkSupportSource: () => null,
            useSessionMessagesById: () => ({}),
            useSessionMessagesReducerState: () => null,
            useSessionWorkspacePath: () => null,
        });
    },
});

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: () => false,
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/utils/platform/responsive', () => ({
  useHeaderHeight: () => 0,
}));

vi.mock('@/components/sessions/transcript/ChatFooter', () => ({
  ChatFooter: () => React.createElement('ChatFooter'),
}));

vi.mock('@/components/sessions/transcript/MessageView', () => ({
  MessageView: (props: any) => {
    renderedMessageViewProps.push(props);
    return React.createElement('MessageView', props);
  },
  MessageViewWithSessionCommon: (props: any) => {
    renderedMessageViewWithCommonProps.push(props);
    return React.createElement('MessageViewWithSessionCommon', props);
  },
}));

function getRenderedMessageProps(): any[] {
  return [...renderedMessageViewProps, ...renderedMessageViewWithCommonProps];
}

describe('TranscriptList (thinking expansion controlled)', () => {
  beforeEach(() => {
    resetTranscriptCommonModuleMockState();
    for (const k of Object.keys(settingValues)) delete settingValues[k];
    renderedMessageViewProps = [];
    renderedMessageViewWithCommonProps = [];
  });

  it('controls inline thinking expansion via list-owned state', async () => {
    settingValues.transcriptListImplementation = 'flatlist_legacy';
    settingValues.sessionThinkingDisplayMode = 'inline';
    settingValues.sessionThinkingInlinePresentation = 'summary';

    const thinkingMessage = { kind: 'agent-text', id: 't1', localId: null, createdAt: 1, text: 'think', isThinking: true };
    const normalMessage = { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'answer', isThinking: false };

    const { TranscriptList } = await import('./TranscriptList');
    await renderScreen(<TranscriptList
          sessionId="s1"
          metadata={null}
          messages={[thinkingMessage as any, normalMessage as any]}
          interaction={{ canSendMessages: false, canApprovePermissions: false }}
        />);

    const firstThinkingProps = getRenderedMessageProps().find((p) => p?.message?.id === 't1');
    expect(firstThinkingProps?.thinkingExpanded).toBe(false);
    expect(typeof firstThinkingProps?.onThinkingExpandedChange).toBe('function');

    await act(async () => {
      firstThinkingProps.onThinkingExpandedChange(true);
    });

    const lastThinkingProps = [...getRenderedMessageProps()].reverse().find((p) => p?.message?.id === 't1');
    expect(lastThinkingProps?.thinkingExpanded).toBe(true);
  });

  it('renders messages through parent-provided transcript session common', async () => {
    settingValues.transcriptListImplementation = 'flatlist_legacy';
    settingValues.sessionThinkingDisplayMode = 'inline';
    settingValues.sessionThinkingInlinePresentation = 'summary';
    settingValues.sessionThinkingInlineChrome = 'plain';
    settingValues.transcriptStreamingSmoothingEnabled = false;
    settingValues.transcriptStreamingSettleDelayMs = 0;
    settingValues.transcriptStreamingPartialOutputEnabled = true;
    settingValues.transcriptStreamingMarkdownRenderingEnabled = false;
    settingValues.transcriptMessageTimestampDisplayMode = 'always';
    settingValues.sessionReplayEnabled = false;
    settingValues.sessionReplayStrategy = 'recent_messages';
    settingValues.sessionReplaySummaryRunnerV1 = null;
    settingValues.sessionReplayMaxSeedChars = 120_000;
    settingValues.toolViewTimelineChromeMode = 'cards';
    settingValues.transcriptToolCallsCollapsedPreviewCount = 1;
    settingValues.transcriptToolCallsGroupShowBackground = false;

    const message = { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'answer', isThinking: false };

    const { TranscriptList } = await import('./TranscriptList');
    await renderScreen(<TranscriptList
      sessionId="s1"
      metadata={null}
      messages={[message as any]}
      interaction={{ canSendMessages: false, canApprovePermissions: false }}
    />);

    expect(renderedMessageViewProps).toHaveLength(0);
    const renderedRowsForMessage = renderedMessageViewWithCommonProps.filter((p) => p?.message?.id === 'a1');
    expect(renderedRowsForMessage.length).toBeGreaterThan(0);
    expect(renderedRowsForMessage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.objectContaining({ id: 'a1' }),
          messageDisplayCommon: expect.objectContaining({
            transcriptMessageTimestampDisplayMode: 'always',
          }),
          toolChromeCommon: expect.objectContaining({
            toolViewTimelineChromeMode: 'cards',
          }),
        }),
      ]),
    );
    expect(renderedMessageViewWithCommonProps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          forkCommon: expect.any(Object),
          messageDisplayCommon: expect.any(Object),
          toolChromeCommon: expect.any(Object),
          toolRouteCommon: expect.any(Object),
        }),
      ]),
    );
  });
});
