import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { makeToolCall } from './ToolView.testHelpers';
import { Text } from '@/components/ui/text/Text';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/text', () => ({
  t: (key: string) => key,
}));

vi.mock('@/sync/domains/state/storage', () => ({
  useSetting: () => false,
}));

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
  it('defaults tool renderer content to selectable in the full view', async () => {
    const { ToolFullView } = await import('./ToolFullView');

    const tool = makeToolCall({
      name: 'Run echo hello',
      input: { _acp: { kind: 'execute', title: 'Run echo hello' }, command: ['/bin/zsh', '-lc', 'echo hello'] },
      result: { stdout: 'hello\n', stderr: '' },
      description: 'Run echo hello',
    });

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(ToolFullView, { tool, metadata: null, messages: [] }));
    });

    const hostTextNodes = tree.root.findAllByType('Text' as any);
    const target = hostTextNodes.find((n) => Array.isArray(n.props.children) ? n.props.children.includes('select me') : n.props.children === 'select me');
    expect(target).toBeTruthy();
    expect(target!.props.selectable).toBe(true);
  });
});
