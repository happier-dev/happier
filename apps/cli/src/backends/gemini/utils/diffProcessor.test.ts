import { describe, expect, it } from 'vitest';

import type { DiffToolCall, DiffToolResult } from './diffProcessor';
import { GeminiDiffProcessor } from './diffProcessor';

type EmittedMessage = DiffToolCall | DiffToolResult;

function collectByType(messages: EmittedMessage[]): {
  calls: DiffToolCall[];
  results: DiffToolResult[];
} {
  const calls = messages.filter((message): message is DiffToolCall => message.type === 'tool-call');
  const results = messages.filter((message): message is DiffToolResult => message.type === 'tool-call-result');
  return { calls, results };
}

describe('GeminiDiffProcessor', () => {
  it('buffers fs-edit diffs during a turn and emits a single Diff tool call on flushTurn', () => {
    const emitted: EmittedMessage[] = [];
    const processor = new GeminiDiffProcessor((message) => emitted.push(message));

    const diff = ['--- a/foo.txt', '+++ b/foo.txt', '@@ -1 +1 @@', '-old', '+new'].join('\n');

    processor.processFsEdit('foo.txt', 'edit foo', diff);
    expect(emitted).toHaveLength(0);

    processor.flushTurn();

    const { calls, results } = collectByType(emitted);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('Diff');
    expect(calls[0].input.files).toEqual([
      expect.objectContaining({ file_path: 'foo.txt', unified_diff: diff }),
    ]);
    expect(results).toHaveLength(1);
    expect(results[0].callId).toBe(calls[0].callId);
  });

  it('captures text diffs from ACP tool results and emits them as Diff.files entries', () => {
    const emitted: EmittedMessage[] = [];
    const processor = new GeminiDiffProcessor((message) => emitted.push(message));

    processor.processToolResult(
      'edit',
      [{ type: 'diff', path: 'foo.txt', oldText: 'one\ntwo\n', newText: 'one\nTWO\n' }],
      'replace-1',
    );
    processor.flushTurn();

    const { calls } = collectByType(emitted);
    expect(calls).toHaveLength(1);
    expect(calls[0].input.files).toEqual([
      expect.objectContaining({
        file_path: 'foo.txt',
        oldText: 'one\ntwo\n',
        newText: 'one\nTWO\n',
      }),
    ]);
  });

  it('coalesces multiple text diffs for the same file into earliest oldText and latest newText', () => {
    const emitted: EmittedMessage[] = [];
    const processor = new GeminiDiffProcessor((message) => emitted.push(message));

    processor.processToolResult('edit', [{ type: 'diff', path: 'foo.txt', oldText: 'a\nb\n', newText: 'a\nB\n' }], 'replace-1');
    processor.processToolResult('edit', [{ type: 'diff', path: 'foo.txt', oldText: 'a\nB\n', newText: 'A\nB\n' }], 'replace-2');
    processor.flushTurn();

    const { calls } = collectByType(emitted);
    expect(calls).toHaveLength(1);
    expect(calls[0].input.files).toEqual([
      expect.objectContaining({ file_path: 'foo.txt', oldText: 'a\nb\n', newText: 'A\nB\n' }),
    ]);
  });

  it('emits only valid text-diff entries from mixed malformed result payloads', () => {
    const emitted: EmittedMessage[] = [];
    const processor = new GeminiDiffProcessor((message) => emitted.push(message));

    processor.processToolResult(
      'edit',
      [
        { type: 'diff', path: 'valid.txt', oldText: 'old', newText: 'new' },
        { type: 'diff', path: '   ', oldText: 'old', newText: 'new' },
        { type: 'diff', path: 'missing-old', newText: 'new' },
        { type: 'diff', path: 'missing-new', oldText: 'old' },
        { type: 'not-diff', path: 'ignored.txt', oldText: 'old', newText: 'new' },
      ],
      'replace-3',
    );
    processor.flushTurn();

    const { calls } = collectByType(emitted);
    expect(calls).toHaveLength(1);
    expect(calls[0].input.files).toEqual([
      expect.objectContaining({ file_path: 'valid.txt', oldText: 'old', newText: 'new' }),
    ]);
  });

  it('handles mixed valid and invalid multi-file unified diffs from result.changes', () => {
    const emitted: EmittedMessage[] = [];
    const processor = new GeminiDiffProcessor((message) => emitted.push(message));

    processor.processToolResult(
      'patch',
      {
        changes: {
          'a.txt': { unified_diff: '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n' },
          '   ': { unified_diff: '--- invalid' },
          'b.txt': { patch: '' },
          'c.txt': { diff: '--- a/c.txt\n+++ b/c.txt\n@@ -1 +1 @@\n-old\n+new\n' },
        },
      },
      'patch-1',
    );
    processor.flushTurn();

    const { calls } = collectByType(emitted);
    expect(calls).toHaveLength(1);
    expect(calls[0].input.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file_path: 'a.txt' }),
        expect.objectContaining({ file_path: 'c.txt' }),
      ]),
    );
    expect(calls[0].input.files).toHaveLength(2);
  });

  it('does not emit diffs when no diff text is available', () => {
    const emitted: EmittedMessage[] = [];
    const processor = new GeminiDiffProcessor((message) => emitted.push(message));

    processor.processFsEdit('foo.txt', 'edit foo', undefined);
    processor.processToolResult('edit', [{ type: 'diff', path: 'foo.txt', oldText: 'old', newText: null }], 'replace-4');
    processor.flushTurn();

    expect(emitted).toHaveLength(0);
  });

  it('supports setting a callback after construction', () => {
    const emitted: EmittedMessage[] = [];
    const processor = new GeminiDiffProcessor();
    processor.setMessageCallback((message) => emitted.push(message));

    processor.processFsEdit('late.txt', 'late', '--- a/late.txt\n+++ b/late.txt\n@@ -1 +1 @@\n-old\n+new\n');
    processor.flushTurn();

    const { calls, results } = collectByType(emitted);
    expect(calls).toHaveLength(1);
    expect(results).toHaveLength(1);
  });

  it('flushes and resets in one step via completeTurn', () => {
    const emitted: EmittedMessage[] = [];
    const processor = new GeminiDiffProcessor((message) => emitted.push(message));

    processor.processFsEdit('foo.txt', 'edit foo', '--- a/foo.txt\n+++ b/foo.txt\n@@ -1 +1 @@\n-old\n+new\n');
    processor.completeTurn();

    const { calls, results } = collectByType(emitted);
    expect(calls).toHaveLength(1);
    expect(results).toHaveLength(1);

    processor.flushTurn();
    expect(emitted).toHaveLength(2);
  });
});
