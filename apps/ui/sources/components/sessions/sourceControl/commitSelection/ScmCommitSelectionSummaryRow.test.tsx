import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  Platform: { OS: 'ios', select: (s: any) => s.ios ?? s.default },
}));

vi.mock('@/components/ui/text/Text', () => ({
  Text: 'Text',
}));

vi.mock('@/constants/Typography', () => ({
  Typography: { default: () => ({}) },
}));

vi.mock('@/text', () => ({
  t: (_k: string, vars?: any) => (vars?.count != null ? `selected:${vars.count}` : 'clear'),
}));

describe('ScmCommitSelectionSummaryRow', () => {
  it('renders and calls onClear', async () => {
    const { ScmCommitSelectionSummaryRow } = await import('./ScmCommitSelectionSummaryRow');
    const onClear = vi.fn();

    const theme = {
      colors: {
        divider: '#ddd',
        surface: '#fff',
        surfaceHigh: '#f5f5f5',
        input: { background: '#f5f5f5' },
        textSecondary: '#666',
        textLink: '#00f',
      },
    };

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<ScmCommitSelectionSummaryRow theme={theme} count={3} onClear={onClear} density="compact" />);
    });
    const pressable = tree.root.findByType('Pressable' as any);

    await act(async () => {
      pressable.props.onPress();
    });

    expect(onClear).toHaveBeenCalled();
  });
});
