import { describe, expect, it } from 'vitest';

import { normalizeDiffInput } from './diff';

type DiffFile = {
  file_path?: string;
  unified_diff?: string;
};

function expectFiles(value: Record<string, unknown>): DiffFile[] {
  expect(Array.isArray(value.files)).toBe(true);
  return value.files as DiffFile[];
}

describe('normalizeDiffInput', () => {
  it('derives per-file diff blocks from multi-file unified diffs (diff --git)', () => {
    const raw = [
      'diff --git a/foo.txt b/foo.txt',
      '--- a/foo.txt',
      '+++ b/foo.txt',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/bar.txt b/bar.txt',
      '--- a/bar.txt',
      '+++ b/bar.txt',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ].join('\n');

    const normalized = normalizeDiffInput({ unified_diff: raw });
    const files = expectFiles(normalized);
    expect(files).toHaveLength(2);
    expect(files).toEqual([
      expect.objectContaining({ file_path: 'foo.txt' }),
      expect.objectContaining({ file_path: 'bar.txt' }),
    ]);
    expect(files[0]?.unified_diff).toContain('diff --git a/foo.txt b/foo.txt');
    expect(files[1]?.unified_diff).toContain('diff --git a/bar.txt b/bar.txt');
  });

  it('derives per-file diff blocks from multi-file unified diffs without git headers', () => {
    const raw = [
      '--- a/foo.txt',
      '+++ b/foo.txt',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '--- a/bar.txt',
      '+++ b/bar.txt',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ].join('\n');

    const normalized = normalizeDiffInput({ unified_diff: raw });
    const files = expectFiles(normalized);
    expect(files).toHaveLength(2);
    expect(files).toEqual([
      expect.objectContaining({ file_path: 'foo.txt' }),
      expect.objectContaining({ file_path: 'bar.txt' }),
    ]);
    expect(files[0]?.unified_diff).toContain('+++ b/foo.txt');
    expect(files[1]?.unified_diff).toContain('+++ b/bar.txt');
  });

  it('strips timestamps/metadata from ---/+++ header lines when deriving file paths', () => {
    const raw = [
      '--- a/foo.txt\t2026-02-03 12:00:00.000000000 +0000',
      '+++ b/foo.txt\t2026-02-03 12:00:00.000000000 +0000',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n');

    const normalized = normalizeDiffInput({ unified_diff: raw });
    const files = expectFiles(normalized);
    expect(files).toHaveLength(1);
    expect(files[0]?.file_path).toBe('foo.txt');
  });

  it('preserves pre-populated files when unified_diff is provided', () => {
    const raw = [
      'diff --git a/foo.txt b/foo.txt',
      '--- a/foo.txt',
      '+++ b/foo.txt',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n');

    const files = [{ file_path: 'custom.txt', unified_diff: 'custom-diff' }];
    const normalized = normalizeDiffInput({ unified_diff: raw, files });
    expect(normalized.files).toBe(files);
    expect(normalized.unified_diff).toBe(raw);
  });

  it('prefers explicit unified_diff over diff when both are present', () => {
    const normalized = normalizeDiffInput({
      unified_diff: '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b',
      diff: '--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-x\n+y',
    });

    expect(normalized.unified_diff).toContain('a/a.txt');
    const files = expectFiles(normalized);
    expect(files).toHaveLength(1);
    expect(files[0]?.file_path).toBe('a.txt');
  });

  it('falls back to diff when unified_diff is blank', () => {
    const normalized = normalizeDiffInput({
      unified_diff: '   ',
      diff: '--- a/fallback.txt\n+++ b/fallback.txt\n@@ -1 +1 @@\n-old\n+new',
    });

    expect(normalized.unified_diff).toContain('fallback.txt');
    const files = expectFiles(normalized);
    expect(files[0]?.file_path).toBe('fallback.txt');
  });

  it('wraps non-string, non-record raw inputs into value for safe display', () => {
    const normalized = normalizeDiffInput(42);
    expect(normalized).toEqual({ value: 42 });
  });
});
