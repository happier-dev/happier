import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('expo-router', () => ({
  Link: (props: any) => React.createElement('Link', props, props.children),
}));

vi.mock('../ui/text/StyledText', () => ({
  Text: (props: any) => React.createElement('Text', props, props.children),
}));

describe('MarkdownSpansView (link rel hardening)', () => {
  it('adds rel="noopener noreferrer" for spans with url', async () => {
    const { MarkdownSpansView } = await import('./MarkdownSpansView');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <MarkdownSpansView
          spans={[{ text: 'example', styles: [], url: 'https://example.com' }] as any}
        />
      );
    });

    const link = tree.root.findByType('Link' as any);
    expect(link.props.target).toBe('_blank');
    expect(link.props.rel).toBe('noopener noreferrer');
  });
});
