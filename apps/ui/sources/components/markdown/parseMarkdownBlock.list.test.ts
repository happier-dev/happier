import { describe, expect, it } from 'vitest';

import { parseMarkdownBlock } from './parseMarkdownBlock';

describe('parseMarkdownBlock (lists)', () => {
  it('preserves nested unordered-list indentation depth', () => {
    const markdown = [
      '- Parent',
      '  - Child',
      '    - Grandchild',
      '- Sibling',
    ].join('\n');

    const blocks = parseMarkdownBlock(markdown);
    expect(blocks).toMatchObject([
      {
        type: 'list',
        items: [
          { depth: 0, spans: [{ text: 'Parent' }] },
          { depth: 1, spans: [{ text: 'Child' }] },
          { depth: 2, spans: [{ text: 'Grandchild' }] },
          { depth: 0, spans: [{ text: 'Sibling' }] },
        ],
      },
    ]);
  });

  it('preserves nested numbered-list indentation depth', () => {
    const markdown = [
      '1. Parent',
      '  1. Child',
      '    1. Grandchild',
      '2. Sibling',
    ].join('\n');

    const blocks = parseMarkdownBlock(markdown);
    expect(blocks).toMatchObject([
      {
        type: 'numbered-list',
        items: [
          { depth: 0, number: 1, spans: [{ text: 'Parent' }] },
          { depth: 1, number: 1, spans: [{ text: 'Child' }] },
          { depth: 2, number: 1, spans: [{ text: 'Grandchild' }] },
          { depth: 0, number: 2, spans: [{ text: 'Sibling' }] },
        ],
      },
    ]);
  });
});
