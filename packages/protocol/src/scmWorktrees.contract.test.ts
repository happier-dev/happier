import { describe, expect, it } from 'vitest';

import {
  ScmWorktreeCreateRequestSchema,
  ScmWorktreePruneRequestSchema,
  ScmWorktreeRemoveRequestSchema,
} from './scmWorktrees.js';

describe('scmWorktrees protocol contracts', () => {
  it('accepts a cwd-only prune request', () => {
    const parsed = ScmWorktreePruneRequestSchema.parse({
      cwd: '/repo',
    });

    expect(parsed.cwd).toBe('/repo');
  });

  it('accepts optional create-worktree displayName, baseRef, and branchMode fields', () => {
    const parsed = ScmWorktreeCreateRequestSchema.parse({
      cwd: '/repo/packages/app',
      displayName: 'feature/auth',
      baseRef: 'origin/main',
      branchMode: 'existing',
    });

    expect(parsed).toMatchObject({
      cwd: '/repo/packages/app',
      displayName: 'feature/auth',
      baseRef: 'origin/main',
      branchMode: 'existing',
    });
  });

  it('requires a worktree path for remove requests', () => {
    expect(() => ScmWorktreeRemoveRequestSchema.parse({
      cwd: '/repo',
    })).toThrow();

    const parsed = ScmWorktreeRemoveRequestSchema.parse({
      cwd: '/repo',
      worktreePath: '/repo/.dev/worktree/feature-auth',
    });

    expect(parsed.worktreePath).toBe('/repo/.dev/worktree/feature-auth');
  });
});
