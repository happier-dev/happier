import { describe, expect, it } from 'vitest';

describe('GitHub default branch metadata', () => {
  it('maps repository default branch payloads without policy decisions', async () => {
    const mod = await import('./defaultBranch.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    expect(mod.mapGithubDefaultBranch({
      default_branch: 'main',
      default_branch_ref: { sha: 'base-sha' },
    })).toEqual({
      name: 'main',
      sha: 'base-sha',
    });
  });
});
