import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { MarkdownView } from './MarkdownView';
import { renderScreen } from '@/dev/testkit';


declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('./MermaidRenderer', () => ({
  MermaidRenderer: () => null,
}));

vi.mock('../ui/text/Text', () => ({
  Text: (props: any) => React.createElement('Text', props, props.children),
  TextInput: (props: any) => React.createElement('TextInput', props, props.children),
  TextSelectabilityScope: (props: any) => props.children,
}));

vi.mock('./MarkdownSpansView', () => ({
  MarkdownSpansView: ({ spans }: { spans: Array<{ text: string }> }) =>
    React.createElement(
      React.Fragment,
      null,
      spans.map((span, index) => React.createElement('Text', { key: index }, span.text)),
    ),
}));

function flattenStyle(style: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const visit = (node: unknown) => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (typeof node === 'object') Object.assign(out, node);
  };
  visit(style);
  return out;
}

describe('MarkdownView (lists)', () => {
  it('renders unordered list items with hanging-indent rows and nested padding', async () => {
    let tree: renderer.ReactTestRenderer | null = null;
    try {
      tree = (await renderScreen(<MarkdownView
            markdown={[
              '- Parent',
              '  - Child',
            ].join('\n')}
          />)).tree;

      const rows = tree!.root.findAll((node) => node.props?.testID === 'markdown-list-item-row');
      expect(rows).toHaveLength(2);

      const markers = rows.map((row) =>
        row.findAll((node) => node.props?.testID === 'markdown-list-item-marker')[0],
      );
      expect(markers.map((node) => node.props.children)).toEqual(['•', '•']);

      expect(flattenStyle(rows[0].props.style).paddingLeft).toBe(0);
      expect(flattenStyle(rows[1].props.style).paddingLeft).toBe(20);
    } finally {
      act(() => {
        tree?.unmount();
      });
    }
  }, 60_000);
});
