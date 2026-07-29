import { describe, expect, it } from 'vitest';

import { SCM_OPERATION_ERROR_CODES } from './index.js';
import {
  ScmStashDropRequestSchema,
  ScmStashListResponseSchema,
  ScmStashShowResponseSchema,
} from './stash.js';

describe('scmStash protocol contracts', () => {
  it('parses stash list responses including unmanaged stashes', () => {
    const parsed = ScmStashListResponseSchema.parse({
      success: true,
      stashes: [
        {
          stashRef: 'stash@{0}',
          kind: 'branch',
          branch: 'main',
          createdAt: Date.now(),
          message: '!!Happier<main>: WIP on main',
        },
        {
          stashRef: 'stash@{1}',
          kind: 'unmanaged',
          message: 'WIP on main: 1234567 unmanaged',
        },
      ],
      totalCount: 2,
    });

    expect(parsed.stashes?.[0]?.stashRef).toBe('stash@{0}');
    expect(parsed.stashes?.[1]?.kind).toBe('unmanaged');
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
