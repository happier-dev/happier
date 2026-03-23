import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installMessageViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'ios' },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string) => key,
        });
    },
    storage: async (importOriginal) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {
            useSetting: () => null,
            useSession: () => null,
        });
    },
});

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
  isCommittedMessageDiscarded: () => true,
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

describe('MessageView (discarded label)', () => {
  afterEach(() => {
    standardCleanup();
  });

  it('renders the discarded label as selectable', async () => {
    const { MessageView } = await import('./MessageView');

    const message: any = {
      kind: 'user-text',
      localId: 'local-1',
      id: 'm1',
      text: 'hello',
    };

    const screen = await renderScreen(<MessageView message={message} metadata={{} as any} sessionId="s1" />);

    const discarded = screen.findAll(
      (n: any) => n.type === 'Text' && n.props?.children === 'message.discarded',
    )[0]!;
    expect(discarded.props.selectable).toBe(true);
  });
});
