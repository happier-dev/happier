import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const settingValues: Record<string, any> = {};
let renderedMessageViewProps: any[] = [];

vi.mock('@shopify/flash-list', () => ({
  FlashList: () => null,
}));

vi.mock('react-native', async () => {
  const ReactMod = await import('react');
  const stub = await import('@/dev/reactNativeStub');
  return {
    ...stub,
    Platform: { ...(stub as any).Platform, OS: 'web' },
    View: (props: any) => ReactMod.createElement('View', props, props.children),
    ActivityIndicator: () => ReactMod.createElement('ActivityIndicator'),
    FlatList: (props: any) => {
      const children = (props.data ?? []).map((item: any, index: number) =>
        ReactMod.createElement(
          ReactMod.Fragment,
          { key: props.keyExtractor?.(item, index) ?? String(index) },
          props.renderItem?.({ item, index }),
        ),
      );
      return ReactMod.createElement('FlatList', props, children);
    },
  };
});

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/utils/platform/responsive', () => ({
  useHeaderHeight: () => 0,
}));

vi.mock('@/sync/domains/state/storage', () => ({
  useSetting: (key: string) => settingValues[key],
}));

vi.mock('@/components/sessions/transcript/ChatFooter', () => ({
  ChatFooter: () => React.createElement('ChatFooter'),
}));

vi.mock('@/components/sessions/transcript/MessageView', () => ({
  MessageView: (props: any) => {
    renderedMessageViewProps.push(props);
    return React.createElement('MessageView', props);
  },
}));

describe('TranscriptList (thinking expansion controlled)', () => {
  beforeEach(() => {
    for (const k of Object.keys(settingValues)) delete settingValues[k];
    renderedMessageViewProps = [];
  });

  it('controls inline thinking expansion via list-owned state', async () => {
    settingValues.transcriptListImplementation = 'flatlist_legacy';
    settingValues.sessionThinkingDisplayMode = 'inline';
    settingValues.sessionThinkingInlinePresentation = 'summary';

    const thinkingMessage = { kind: 'agent-text', id: 't1', localId: null, createdAt: 1, text: 'think', isThinking: true };
    const normalMessage = { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'answer', isThinking: false };

    const { TranscriptList } = await import('./TranscriptList');
    await act(async () => {
      renderer.create(
        <TranscriptList
          sessionId="s1"
          metadata={null}
          messages={[thinkingMessage as any, normalMessage as any]}
          interaction={{ canSendMessages: false, canApprovePermissions: false }}
        />,
      );
    });

    const firstThinkingProps = renderedMessageViewProps.find((p) => p?.message?.id === 't1');
    expect(firstThinkingProps?.thinkingExpanded).toBe(false);
    expect(typeof firstThinkingProps?.onThinkingExpandedChange).toBe('function');

    await act(async () => {
      firstThinkingProps.onThinkingExpandedChange(true);
    });

    const lastThinkingProps = [...renderedMessageViewProps].reverse().find((p) => p?.message?.id === 't1');
    expect(lastThinkingProps?.thinkingExpanded).toBe(true);
  });
});
