import { describe, expect, it } from 'vitest';
import { splitUnifiedDiffByFile } from './splitUnifiedDiffByFile';

describe('splitUnifiedDiffByFile', () => {
  it('splits multi-file unified diffs into ordered blocks', () => {
    const diff = [
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

    const blocks = splitUnifiedDiffByFile(diff);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain('diff --git a/foo.txt b/foo.txt');
    expect(blocks[1]).toContain('diff --git a/bar.txt b/bar.txt');
  });

  it('splits multi-file diffs even without diff --git headers', () => {
    const diff = [
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

    const blocks = splitUnifiedDiffByFile(diff);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain('+++ b/foo.txt');
    expect(blocks[1]).toContain('+++ b/bar.txt');
  });
});
