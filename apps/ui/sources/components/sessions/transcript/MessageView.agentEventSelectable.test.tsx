import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  ScrollView: 'ScrollView',
  Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
  Platform: { OS: 'ios', select: (values: any) => values?.ios ?? values?.default },
  Dimensions: { get: () => ({ width: 800, height: 600, scale: 1, fontScale: 1 }) },
  useWindowDimensions: () => ({ width: 800, height: 600, scale: 1, fontScale: 1 }),
}));

vi.mock('react-native-unistyles', () => ({
  useUnistyles: () => ({
    theme: {
      colors: {
        success: '#0a0',
        text: '#111',
        textSecondary: '#555',
        surfaceHighest: '#fff',
        divider: '#ddd',
        input: { background: '#f7f7f7' },
        userMessageBackground: '#eef',
        agentEventText: '#777',
      },
    },
  }),
  StyleSheet: {
    create: (input: any) => {
      const theme = {
        colors: {
          success: '#0a0',
          text: '#111',
          textSecondary: '#555',
          surfaceHighest: '#fff',
          divider: '#ddd',
          input: { background: '#f7f7f7' },
          userMessageBackground: '#eef',
          agentEventText: '#777',
        },
      };
      return typeof input === 'function' ? input(theme, {}) : input;
    },
  },
}));

vi.mock('@/components/markdown/MarkdownView', () => ({
  MarkdownView: (props: any) => React.createElement('MarkdownView', props),
}));

vi.mock('@/components/tools/shell/views/ToolView', () => ({
  ToolView: (props: any) => React.createElement('ToolView', props),
}));

vi.mock('@/components/tools/shell/views/ToolTimelineRow', () => ({
  ToolTimelineRow: (props: any) => React.createElement('ToolTimelineRow', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
  Text: (props: any) => React.createElement('Text', props, props.children),
  TextInput: (props: any) => React.createElement('TextInput', props, props.children),
}));

vi.mock('@/components/sessions/linkedFiles/extractWorkspaceFileMentions', () => ({
  extractWorkspaceFileMentions: () => [],
}));

vi.mock('@/components/sessions/linkedFiles/LinkedWorkspaceFilesRow', () => ({
  LinkedWorkspaceFilesRow: () => null,
}));

vi.mock('@/utils/sessions/discardedCommittedMessages', () => ({
  isCommittedMessageDiscarded: () => false,
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/text', () => ({
  t: (key: string) => key,
}));

vi.mock('@/modal', () => ({
  Modal: { alert: vi.fn() },
}));

vi.mock('expo-clipboard', () => ({
  setStringAsync: vi.fn(),
}));

vi.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
  Octicons: 'Octicons',
}));

vi.mock('@/sync/sync', () => ({
  sync: { submitMessage: vi.fn(), sendMessage: vi.fn() },
}));

vi.mock('@/sync/domains/state/storage', () => ({
  useSetting: () => null,
  useSession: () => null,
}));

describe('MessageView (agent events)', () => {
  it('renders agent-event text as selectable', async () => {
    const { MessageView } = await import('./MessageView');

    const message: any = {
      kind: 'agent-event',
      event: { type: 'message', message: 'hello event' },
    };

    let tree: renderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = renderer.create(<MessageView message={message} metadata={null} sessionId="s1" />);
    });

    const texts = tree!.root.findAllByType('Text' as any);
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.some((n: any) => n.props.selectable === true)).toBe(true);
  });
});
