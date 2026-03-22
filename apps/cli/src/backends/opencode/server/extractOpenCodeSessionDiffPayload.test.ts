import { describe, expect, it } from 'vitest';

import { extractOpenCodeSessionDiffPayload } from './extractOpenCodeSessionDiffPayload';

describe('extractOpenCodeSessionDiffPayload', () => {
  it('collects unified diffs from native session diff rows', () => {
    expect(extractOpenCodeSessionDiffPayload([
      {
        path: 'src/a.ts',
        diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
      },
      {
        filePath: 'src/b.ts',
        unifiedDiff: 'diff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1 +1 @@\n-old\n+new\n',
      },
    ])).toEqual({
      unifiedDiffs: [
        'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new',
        'diff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1 +1 @@\n-old\n+new',
      ],
      textDiffs: [],
    });
  });

  it('falls back to text diffs when unified diffs are unavailable', () => {
    expect(extractOpenCodeSessionDiffPayload([
      {
        file: 'src/c.ts',
        before: 'old\n',
        after: 'new\n',
      },
    ])).toEqual({
      unifiedDiffs: [],
      textDiffs: [{
        filePath: 'src/c.ts',
        oldText: 'old\n',
        newText: 'new\n',
      }],
    });
  });
});
