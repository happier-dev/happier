import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installToolShellCommonModuleMocks, makeToolCall } from './ToolView.testHelpers';
import {
  renderScreen,
  standardCleanup,
} from '@/dev/testkit';
import { Text } from '@/components/ui/text/Text';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installToolShellCommonModuleMocks({
});

vi.mock('@/sync/sync', () => ({
  sync: {
    ensureSidechainMessagesLoaded: vi.fn(),
  },
}));

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
