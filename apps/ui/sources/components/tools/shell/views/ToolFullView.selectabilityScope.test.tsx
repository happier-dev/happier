import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeToolCall } from './ToolView.testHelpers';
import {
  renderScreen,
  standardCleanup,
} from '@/dev/testkit';
import { Text } from '@/components/ui/text/Text';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/sync/sync', () => ({
  sync: {
    ensureSidechainMessagesLoaded: vi.fn(),
  },
}));

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

vi.mock('@/sync/domains/state/storage', async (importOriginal) =>
  (await import('@/dev/testkit/mocks/storage')).createStorageModuleMock({
    importOriginal,
    overrides: {
      useSetting: () => false,
      useSessionTranscriptDraftMessages: () => [],
    },
  }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                    View: 'View',
                                    Text: 'Text',
                                    ScrollView: 'ScrollView',
                                    Pressable: 'Pressable',
                                    Platform: { OS: 'ios', select: (value: any) => value?.ios ?? value?.default ?? value?.web ?? null },
                                    useWindowDimensions: () => ({ width: 800, height: 600 }),
                                  }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('@/components/ui/media/CodeView', () => ({
  CodeView: () => null,
}));

vi.mock('@/components/tools/catalog', () => ({
  knownTools: {
    execute: { title: 'Terminal' },
  },
}));

vi.mock('@/components/tools/renderers/system/StructuredResultView', () => ({
  StructuredResultView: () => null,
}));

vi.mock('../permissions/PermissionFooter', () => ({
  PermissionFooter: () => null,
}));

const DummyFullView = () => {
  // Intentionally omit `selectable` so the test asserts the scope drives the default.
  return <Text>select me</Text>;
};

vi.mock('@/components/tools/renderers/core/_registry', () => ({
  getToolViewComponent: (toolName: string) => {
    if (toolName === 'execute') {
      return () => React.createElement(DummyFullView);
    }
    return null;
  },
}));

describe('ToolFullView (text selection scope)', () => {
  afterEach(() => {
    standardCleanup();
  });

  it('defaults tool renderer content to selectable in the full view', async () => {
    const { ToolFullView } = await import('./ToolFullView');

    const tool = makeToolCall({
      name: 'Run echo hello',
      input: { _acp: { kind: 'execute', title: 'Run echo hello' }, command: ['/bin/zsh', '-lc', 'echo hello'] },
      result: { stdout: 'hello\n', stderr: '' },
      description: 'Run echo hello',
    });

    const screen = await renderScreen(React.createElement(ToolFullView, { tool, metadata: null, messages: [] }));

    const hostTextNodes = screen.findAllByType('Text' as any);
    const target = hostTextNodes.find((n) => Array.isArray(n.props.children) ? n.props.children.includes('select me') : n.props.children === 'select me');
    expect(target).toBeTruthy();
    expect(target!.props.selectable).toBe(true);
  });
});
