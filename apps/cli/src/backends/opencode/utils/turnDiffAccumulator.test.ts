import { describe, expect, it } from 'vitest';

import { OpenCodeTurnDiffAccumulator } from './turnDiffAccumulator';

describe('OpenCodeTurnDiffAccumulator', () => {
  it('coalesces multiple edit tool-results for the same file into a single before/after pair', () => {
    const acc = new OpenCodeTurnDiffAccumulator();

    acc.beginTurn();
    acc.observeToolResult('Edit', {
      metadata: {
        filediff: {
          file: 'a.txt',
          before: 'before-1\n',
          after: 'after-1\n',
        },
      },
    });
    acc.observeToolResult('Edit', {
      metadata: {
        filediff: {
          file: 'a.txt',
          before: 'after-1\n',
          after: 'after-2\n',
        },
      },
    });

    const flushed = acc.flushTurn();
    expect(flushed).toEqual({
      files: [{ file_path: 'a.txt', oldText: 'before-1\n', newText: 'after-2\n' }],
    });
  });

  it('captures multiple files and preserves first-seen ordering', () => {
    const acc = new OpenCodeTurnDiffAccumulator();

    acc.beginTurn();
    acc.observeToolResult('Edit', {
      output: {
        metadata: {
          filediff: { file: 'b.txt', before: 'b0', after: 'b1' },
        },
      },
    });
    acc.observeToolResult('Edit', {
      metadata: {
        filediff: { file: 'a.txt', before: 'a0', after: 'a1' },
      },
    });
    acc.observeToolResult('Edit', {
      metadata: {
        filediff: { file: 'b.txt', before: 'b1', after: 'b2' },
      },
    });

    const flushed = acc.flushTurn();
    expect(flushed).toEqual({
      files: [
        { file_path: 'b.txt', oldText: 'b0', newText: 'b2' },
        { file_path: 'a.txt', oldText: 'a0', newText: 'a1' },
      ],
    });
  });

  it('ignores tool-results that do not include filediff metadata', () => {
    const acc = new OpenCodeTurnDiffAccumulator();

    acc.beginTurn();
    acc.observeToolResult('Edit', { ok: true });
    acc.observeToolResult('Bash', { metadata: { exit: 0 } });

    expect(acc.flushTurn()).toEqual({ files: [] });
  });
});

