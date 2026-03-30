import { describe, expect, it } from 'vitest';

import { SCM_OPERATION_ERROR_CODES } from './scm.js';
import {
  ScmBranchCheckoutResponseSchema,
  ScmBranchListRequestSchema,
  ScmBranchListResponseSchema,
} from './scmBranches.js';

describe('scmBranches protocol contracts', () => {
  it('parses branch list requests with backend preference and remotes toggle', () => {
    const parsed = ScmBranchListRequestSchema.parse({
      cwd: '.',
      backendPreference: {
        kind: 'prefer',
        backendId: 'git',
      },
      includeRemotes: true,
    });

    expect(parsed.backendPreference?.backendId).toBe('git');
    expect(parsed.includeRemotes).toBe(true);
  });

  it('parses branch list responses with upstream metadata', () => {
    const parsed = ScmBranchListResponseSchema.parse({
      success: true,
      branches: [
        { name: 'main', type: 'local', isCurrent: true, upstream: 'origin/main' },
        { name: 'origin/main', type: 'remote', isCurrent: false },
      ],
    });

    expect(parsed.branches?.[0]?.name).toBe('main');
    expect(parsed.branches?.[0]?.upstream).toBe('origin/main');
    expect(parsed.branches?.[1]?.type).toBe('remote');
  });

  it('parses branch checkout responses with stash metadata', () => {
    const parsed = ScmBranchCheckoutResponseSchema.parse({
      success: true,
      didCreateStash: true,
      didPopStash: false,
      stashRef: 'stash@{0}',
    });

    expect(parsed.didCreateStash).toBe(true);
    expect(parsed.stashRef).toBe('stash@{0}');
  });

  it('accepts deterministic unsupported feature errors', () => {
    const parsed = ScmBranchListResponseSchema.parse({
      success: false,
      errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
      error: 'The selected backend does not support branch operations',
    });

    expect(parsed.success).toBe(false);
    expect(parsed.errorCode).toBe(SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED);
  });
});

