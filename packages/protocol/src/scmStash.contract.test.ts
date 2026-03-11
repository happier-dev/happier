import { describe, expect, it } from 'vitest';

import { SCM_OPERATION_ERROR_CODES } from './scm.js';
import {
  ScmStashDropRequestSchema,
  ScmStashListResponseSchema,
  ScmStashShowResponseSchema,
} from './scmStash.js';

describe('scmStash protocol contracts', () => {
  it('parses managed stash list responses', () => {
    const parsed = ScmStashListResponseSchema.parse({
      success: true,
      managedStashes: [
        {
          stashRef: 'stash@{0}',
          kind: 'branch',
          branch: 'main',
          createdAt: Date.now(),
          message: '!!Happier<main>: WIP on main',
        },
      ],
      managedCount: 1,
      totalCount: 2,
    });

    expect(parsed.managedStashes?.[0]?.stashRef).toBe('stash@{0}');
    expect(parsed.managedCount).toBe(1);
    expect(parsed.totalCount).toBe(2);
  });

  it('parses stash show responses with bounded diffs', () => {
    const parsed = ScmStashShowResponseSchema.parse({
      success: true,
      diff: 'diff --git a/a.txt b/a.txt\n@@ -1 +1 @@\n-old\n+new\n',
      truncated: false,
    });

    expect(parsed.diff).toContain('diff --git');
    expect(parsed.truncated).toBe(false);
  });

  it('parses stash drop requests', () => {
    const parsed = ScmStashDropRequestSchema.parse({
      cwd: '.',
      stashRef: 'stash@{0}',
    });

    expect(parsed.stashRef).toBe('stash@{0}');
  });

  it('accepts deterministic unsupported feature errors', () => {
    const parsed = ScmStashListResponseSchema.parse({
      success: false,
      errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
      error: 'The selected backend does not support stash operations',
    });

    expect(parsed.success).toBe(false);
    expect(parsed.errorCode).toBe(SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED);
  });
});

