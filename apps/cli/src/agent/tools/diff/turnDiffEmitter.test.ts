import { describe, expect, it } from 'vitest';

import { TurnDiffEmitter } from './turnDiffEmitter';

describe('TurnDiffEmitter', () => {
  it('coalesces multiple text diffs for the same file into earliest oldText and latest newText', () => {
    const emitter = new TurnDiffEmitter();
    emitter.beginTurn();

    emitter.observeTextDiff({ filePath: 'foo.txt', oldText: 'a\nb\nc\n', newText: 'a\nB\nc\n' });
    emitter.observeTextDiff({ filePath: 'foo.txt', oldText: 'a\nB\nc\n', newText: 'a\nB\nC\n' });

    const out = emitter.flushTurn();
    expect(out).toEqual({
      files: [{ file_path: 'foo.txt', oldText: 'a\nb\nc\n', newText: 'a\nB\nC\n' }],
    });
  });

  it('prefers text diffs over unified diffs for the same file', () => {
    const emitter = new TurnDiffEmitter();
    emitter.beginTurn();

    emitter.observeUnifiedDiff({ filePath: 'foo.txt', unifiedDiff: '--- a/foo\n+++ b/foo\n@@\n-old\n+new\n' });
    emitter.observeTextDiff({ filePath: 'foo.txt', oldText: 'old\n', newText: 'new\n' });

    const out = emitter.flushTurn();
    expect(out).toEqual({
      files: [{ file_path: 'foo.txt', oldText: 'old\n', newText: 'new\n' }],
    });
  });

  it('preserves unified description when text override does not include one', () => {
    const emitter = new TurnDiffEmitter();
    emitter.beginTurn();

    emitter.observeUnifiedDiff({
      filePath: 'foo.txt',
      unifiedDiff: '--- a/foo\n+++ b/foo\n@@\n-old\n+new\n',
      description: 'original unified description',
    });
    emitter.observeTextDiff({ filePath: 'foo.txt', oldText: 'old\n', newText: 'new\n' });

    const out = emitter.flushTurn();
    expect(out).toEqual({
      files: [
        {
          file_path: 'foo.txt',
          oldText: 'old\n',
          newText: 'new\n',
          description: 'original unified description',
        },
      ],
    });
  });

  it('emits a unified_diff snapshot when only snapshot diffs were observed', () => {
    const emitter = new TurnDiffEmitter({ snapshotUnifiedDiff: true });
    emitter.beginTurn();

    emitter.observeUnifiedDiffSnapshot({ unifiedDiff: 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@\n-old\n+new\n' });

    const out = emitter.flushTurn();
    expect(out).toEqual({
      unified_diff: 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@\n-old\n+new\n',
    });
  });

  it('resets state after flush', () => {
    const emitter = new TurnDiffEmitter();
    emitter.beginTurn();
    emitter.observeTextDiff({ filePath: 'foo.txt', oldText: 'a', newText: 'b' });
    emitter.flushTurn();
    expect(emitter.flushTurn()).toEqual({});
  });
});
