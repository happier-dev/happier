import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readPullRequestComparison } from './readPullRequestComparisonPage';

describe('hosted comparison unified evidence', () => {
  it('uses the attested merge base as before while retaining the selected base-tip freshness witness', async () => {
    const comparison = await readPullRequestComparison({
      source: { kind: 'pullRequest', locator: { providerId: 'github', repository: 'owner/repo', number: 17,
        baseOid: 'a'.repeat(40), headOid: 'b'.repeat(40),
        sourceAction: { action: { pluginId: 'happier.scm.forge.github', localId: 'triage/list-github-changed-files' }, input: {} } } },
      readPage: async () => ({ kind: 'changedFiles', omittedRowCount: 0, projectionTruncated: false,
        rows: [{ path: 'file.ts', status: 'modified', diffAvailable: true,
          evidence: { state: 'available', patch: '@@ -1 +1 @@\n-old\n+new\n' } }],
        comparison: { beforeOid: 'c'.repeat(40), baseOid: 'a'.repeat(40), headOid: 'b'.repeat(40),
          locator: { providerId: 'github', repository: 'owner/repo', number: 17 },
          totalFileCount: 1, enumeratedFileCount: 1, freshness: 'current', inventory: 'complete', content: 'complete', reasons: [] },
      }),
    });
    expect(comparison).toMatchObject({ before: 'c'.repeat(40), after: 'b'.repeat(40), state: 'complete',
      pullRequest: { baseOid: 'a'.repeat(40) } });
    expect(comparison.files[0]?.unifiedDiff).toContain('-old\n+new\n');
  });

  it('frames renamed provider fragments with lossless Git paths', async () => {
    const path = 'new\tname\n"quoted"\\file.ts';
    const previousPath = 'old\tname\n"quoted"\\file.ts';
    const comparison = await readPullRequestComparison({
      source: { kind: 'pullRequest', locator: { providerId: 'github', repository: 'owner/repo', number: 17,
        sourceAction: { action: { pluginId: 'happier.scm.forge.github', localId: 'triage/list-github-changed-files' }, input: {} } } },
      // Authenticated source Action transport is the boundary; framing stays real.
      readPage: async () => ({ kind: 'changedFiles', omittedRowCount: 0, projectionTruncated: false,
        rows: [{ path, previousPath, status: 'renamed', diffAvailable: true,
          evidence: { state: 'available', patch: '@@ -1 +1 @@\n-old\n+new\n' } }],
        comparison: { beforeOid: 'a'.repeat(40), baseOid: 'a'.repeat(40), headOid: 'b'.repeat(40),
          locator: { providerId: 'github', repository: 'owner/repo', number: 17 },
          totalFileCount: 1, enumeratedFileCount: 1, freshness: 'current', inventory: 'complete', content: 'complete', reasons: [] },
      }),
    });
    expect(comparison.state).toBe('complete');
    expect(comparison.files[0]).toMatchObject({ path, previousPath, changeKind: 'renamed' });
    const unifiedDiff = comparison.files[0]?.unifiedDiff ?? '';
    // Parse outside a repository: Git otherwise filters paths by the package's worktree prefix.
    const cwd = mkdtempSync(join(tmpdir(), 'happier-pr-framing-'));
    try {
      const stats = execFileSync('git', ['apply', '--numstat', '-z', '-'], { cwd, input: unifiedDiff, encoding: 'utf8' });
      expect(stats).toBe(`1\t1\t${path}\0`);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it.each(['beforeOid', 'baseOid', 'headOid'] as const)('retains the usable prefix but refuses a changed %s on the next page', async (endpoint) => {
    let page = 0;
    const comparison = await readPullRequestComparison({
      source: { kind: 'pullRequest', locator: { providerId: 'github', repository: 'owner/repo', number: 17,
        sourceAction: { action: { pluginId: 'happier.scm.forge.github', localId: 'triage/list-github-changed-files' }, input: {} } } },
      readPage: async () => {
        const first = page++ === 0;
        return { kind: 'changedFiles', omittedRowCount: 0, projectionTruncated: false,
          rows: [{ path: first ? 'prefix.ts' : 'mixed.ts', status: 'modified', diffAvailable: true,
            evidence: { state: 'available', patch: '@@ -1 +1 @@\n-old\n+new\n' } }],
          ...(first ? { continuation: 'second' } : {}),
          comparison: { beforeOid: 'c'.repeat(40), baseOid: 'a'.repeat(40), headOid: 'b'.repeat(40),
            ...(!first ? { [endpoint]: 'd'.repeat(40) } : {}),
            locator: { providerId: 'github', repository: 'owner/repo', number: 17 },
            totalFileCount: 2, enumeratedFileCount: first ? 1 : 2, freshness: 'current',
            inventory: first ? 'incomplete' : 'complete', content: 'complete', reasons: first ? ['pages_pending'] : [] },
        };
      },
    });
    expect(comparison).toMatchObject({ before: 'c'.repeat(40), after: 'b'.repeat(40), state: 'incomplete', freshness: 'stale' });
    expect(comparison.files.map(file => file.path)).toEqual(['prefix.ts']);
  });
});
