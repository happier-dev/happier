import { describe, expect, it } from 'vitest';

import { SCM_OPERATION_ERROR_CODES } from './scm.js';
import {
  ScmBranchIntegrationRequestSchema,
  ScmBranchIntegrationResponseSchema,
  ScmBranchOperationControlRequestSchema,
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

  it('parses branch integration requests and operation state responses', () => {
    const merge = ScmBranchIntegrationRequestSchema.parse({
      cwd: '.',
      sourceRef: ' origin/main ',
    });
    const control = ScmBranchOperationControlRequestSchema.parse({
      cwd: '.',
      operation: 'rebase',
    });
    const response = ScmBranchIntegrationResponseSchema.parse({
      success: false,
      errorCode: SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE,
      operationState: {
        kind: 'rebase',
        sourceRef: 'origin/main',
        canContinue: true,
        canAbort: true,
      },
    });

    expect(merge.sourceRef).toBe('origin/main');
    expect(control.operation).toBe('rebase');
    expect(response.operationState?.kind).toBe('rebase');
    expect(ScmBranchIntegrationRequestSchema.safeParse({
      cwd: '.',
      sourceRef: '--exec=hack',
    }).success).toBe(false);
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
