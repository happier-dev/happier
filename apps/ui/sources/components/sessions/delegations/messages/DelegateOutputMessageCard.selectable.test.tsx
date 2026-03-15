import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
  View: 'View',
}));

vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    create: (input: any) => {
      const theme = {
        colors: {
          surfaceHighest: '#fff',
          divider: '#ddd',
          text: '#111',
          textSecondary: '#555',
        },
      };
      return typeof input === 'function' ? input(theme, {}) : input;
    },
  },
}));

vi.mock('@/text', () => ({
  t: (key: string) => {
    if (key === 'delegation.output.title') return 'Delegation output';
    if (key === 'delegation.output.deliverablesTitle') return 'Deliverables';
    return String(key);
  },
}));

vi.mock('@/components/ui/text/Text', () => ({
  Text: (props: any) => React.createElement('Text', props, props.children),
}));

describe('DelegateOutputMessageCard (selection)', () => {
  it('renders deliverable text as selectable', async () => {
    const { DelegateOutputMessageCard } = await import('./DelegateOutputMessageCard');

    const payload: any = {
      kind: 'delegate_output.v1',
      summary: 'Summary',
      deliverables: [{ id: 'd1', title: 'Title', details: 'Details' }],
    };

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<DelegateOutputMessageCard payload={payload} />);
    });

    const findTextNode = (text: string) =>
      tree.root.findAll((n: any) => n.type === 'Text' && n.props?.children === text)[0]!;

    expect(findTextNode('Delegation output').props.selectable).toBe(true);
    expect(findTextNode('Summary').props.selectable).toBe(true);
    expect(findTextNode('Deliverables').props.selectable).toBe(true);
    expect(findTextNode('Title').props.selectable).toBe(true);
    expect(findTextNode('Details').props.selectable).toBe(true);
  });
});

