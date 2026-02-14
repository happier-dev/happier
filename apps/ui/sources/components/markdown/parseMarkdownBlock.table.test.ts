import { describe, expect, it } from 'vitest';

import { parseMarkdownBlock } from './parseMarkdownBlock';

describe('parseMarkdownBlock (tables)', () => {
  it('preserves intentionally empty cells inside pipe-delimited rows', () => {
    const markdown = [
      '| A | | C |',
      '| --- | --- | --- |',
      '| 1 | | 3 |',
      '',
    ].join('\n');

    const blocks = parseMarkdownBlock(markdown);
    const table = blocks.find((b) => b.type === 'table');
    expect(table).toBeTruthy();
    expect(table).toMatchObject({
      type: 'table',
      headers: ['A', '', 'C'],
      rows: [['1', '', '3']],
    });
  });

  it('pads short rows to match the header column count', () => {
    const markdown = [
      '| A | B | C |',
      '| --- | --- | --- |',
      '| 1 | 2 |',
      '',
    ].join('\n');

    const blocks = parseMarkdownBlock(markdown);
    const table = blocks.find((b) => b.type === 'table');
    expect(table).toBeTruthy();
    expect(table).toMatchObject({
      type: 'table',
      headers: ['A', 'B', 'C'],
      rows: [['1', '2', '']],
    });
  });
});

