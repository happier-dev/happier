import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
  View: 'View',
}));

vi.mock('@/components/ui/code/view/CodeLinesView', () => ({
  CodeLinesView: 'CodeLinesView',
}));

describe('ScmDiffDisplay', () => {
  it('renders parsed unified diff lines via CodeLinesView', async () => {
    const { ScmDiffDisplay } = await import('./ScmDiffDisplay');

    let tree: renderer.ReactTestRenderer | null = null;
    act(() => {
      tree = renderer.create(
        <ScmDiffDisplay
          diffContent={['@@ -1,1 +1,1 @@', '+const value = 1;', ''].join('\n')}
        />,
      );
    });

    const view = tree!.root.findByType('CodeLinesView' as any);
    const lines = view.props.lines as Array<{ renderPrefixText?: string }>;
    expect(lines.some((line) => line.renderPrefixText === '+')).toBe(true);
  });
});
