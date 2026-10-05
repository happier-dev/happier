import { describe, expect, it } from 'vitest';
import { splitUnifiedDiffByFile } from './splitUnifiedDiffByFile.js';

describe('splitUnifiedDiffByFile exact evidence', () => {
  it('preserves line endings and trailing content whitespace when requested', () => {
    const first = 'diff --git a/first.txt b/first.txt\n--- a/first.txt\n+++ b/first.txt\n@@ -1 +1 @@\n-old\r\n+new  \r\n';
    const second = 'diff --git a/second.txt b/second.txt\n--- a/second.txt\n+++ b/second.txt\n@@ -1 +1 @@\n-old\n+new\t \n';
    expect(splitUnifiedDiffByFile(first + second, { preserveText: true })).toEqual([first, second]);
    expect(splitUnifiedDiffByFile(first + second)).toEqual([
      first.replace(/\r\n/g, '\n').trimEnd(), second.trimEnd(),
    ]);
  });
});
