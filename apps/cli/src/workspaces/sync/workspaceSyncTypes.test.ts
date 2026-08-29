import { describe, expect, it } from 'vitest';
import { computeWorkspaceSyncPolicyDigest } from './workspaceSyncTypes';

describe('workspace sync types', () => {
  it('computes a stable policy digest independent of pattern order', () => {
    const left = computeWorkspaceSyncPolicyDigest({
      v: 1, selection: 'git_worktree', extraIgnorePatterns: ['dist', 'node_modules'],
      extraIncludePatterns: [], includeGitDirectory: false,
    });
    const right = computeWorkspaceSyncPolicyDigest({
      v: 1, selection: 'git_worktree', extraIgnorePatterns: ['node_modules', 'dist'],
      extraIncludePatterns: [], includeGitDirectory: false,
    });
    expect(left).toBe(right);
    expect(left).toMatch(/^[a-f0-9]{64}$/);
  });
});
