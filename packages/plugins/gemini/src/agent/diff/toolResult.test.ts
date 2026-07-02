import { describe, expect, it } from 'vitest';

import { collectGeminiToolResultDiffSignals } from './toolResult.js';

describe('collectGeminiToolResultDiffSignals', () => {
  it('extracts structured text diffs from Gemini ACP array tool results', () => {
    expect(collectGeminiToolResultDiffSignals([
      { type: 'diff', path: 'foo.txt', oldText: 'old', newText: 'new', description: 'edit foo' },
      { type: 'diff', path: '   ', oldText: 'ignored', newText: 'ignored' },
      { type: 'diff', path: 'missing-new', oldText: 'old' },
      { type: 'not-diff', path: 'ignored.txt', oldText: 'old', newText: 'new' },
    ])).toEqual([
      {
        kind: 'text',
        filePath: 'foo.txt',
        oldText: 'old',
        newText: 'new',
        description: 'edit foo',
      },
    ]);
  });

  it('extracts direct unified diff payloads from Gemini ACP object results', () => {
    expect(collectGeminiToolResultDiffSignals({
      file: 'bar.txt',
      patch: '--- a/bar.txt\n+++ b/bar.txt\n@@ -1 +1 @@\n-old\n+new\n',
      description: 'patch bar',
    })).toEqual([
      {
        kind: 'unified',
        filePath: 'bar.txt',
        unifiedDiff: '--- a/bar.txt\n+++ b/bar.txt\n@@ -1 +1 @@\n-old\n+new\n',
        description: 'patch bar',
      },
    ]);
  });

  it('extracts nested output/result arrays and multi-file changes while ignoring malformed entries', () => {
    expect(collectGeminiToolResultDiffSignals({
      output: [
        { type: 'diff', path: 'output.txt', oldText: 'before', newText: 'after' },
      ],
      result: [
        { type: 'diff', path: 'result.txt', oldText: 'one', newText: 'two' },
      ],
      changes: {
        'a.txt': { unified_diff: '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n' },
        '   ': { unified_diff: '--- invalid' },
        'b.txt': { patch: '' },
        'c.txt': { diff: '--- a/c.txt\n+++ b/c.txt\n@@ -1 +1 @@\n-old\n+new\n' },
      },
    })).toEqual([
      {
        kind: 'text',
        filePath: 'output.txt',
        oldText: 'before',
        newText: 'after',
      },
      {
        kind: 'text',
        filePath: 'result.txt',
        oldText: 'one',
        newText: 'two',
      },
      {
        kind: 'unified',
        filePath: 'a.txt',
        unifiedDiff: '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n',
      },
      {
        kind: 'unified',
        filePath: 'c.txt',
        unifiedDiff: '--- a/c.txt\n+++ b/c.txt\n@@ -1 +1 @@\n-old\n+new\n',
      },
    ]);
  });

  it('preserves top-level unified diff precedence over changes maps', () => {
    expect(collectGeminiToolResultDiffSignals({
      path: 'top-level.txt',
      diff: '--- a/top-level.txt\n+++ b/top-level.txt\n@@ -1 +1 @@\n-old\n+new\n',
      changes: {
        'nested.txt': { unified_diff: '--- a/nested.txt\n+++ b/nested.txt\n@@ -1 +1 @@\n-a\n+b\n' },
      },
    })).toEqual([
      {
        kind: 'unified',
        filePath: 'top-level.txt',
        unifiedDiff: '--- a/top-level.txt\n+++ b/top-level.txt\n@@ -1 +1 @@\n-old\n+new\n',
      },
    ]);
  });
});
