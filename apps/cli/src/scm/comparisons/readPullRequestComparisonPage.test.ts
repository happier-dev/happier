import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readPullRequestComparison } from './readPullRequestComparisonPage';

describe('hosted comparison unified evidence', () => {
  it('uses a fork PR source inventory and exact endpoints instead of a stale local base', async () => {
    const source = { kind: 'pullRequest' as const, locator: { providerId: 'github', repository: 'upstream/repo', number: 17,
      baseOid: 'a'.repeat(40), headOid: 'b'.repeat(40), sourceAction: {
        action: { pluginId: 'happier.scm.forge.github', localId: 'triage/list-github-changed-files' },
        input: { repository: 'upstream/repo', number: 17 },
      } } };
    const rows = Array.from({ length: 4 }, (_, index) => ({ path: `pr-${index}.ts`, status: 'modified',
      diffAvailable: true, evidence: { state: 'available', patch: '@@ -1 +1 @@\n-old\n+new\n' } }));
    const page = { kind: 'changedFiles', omittedRowCount: 0, projectionTruncated: false, rows,
      comparison: { url: 'https://github.com/upstream/repo/pull/17', beforeOid: 'c'.repeat(40), baseOid: source.locator.baseOid, headOid: source.locator.headOid,
        locator: { providerId: 'github', repository: 'upstream/repo', number: 17 }, totalFileCount: 4,
        enumeratedFileCount: 4, freshness: 'current', inventory: 'complete', content: 'complete', reasons: [] } };
    const captured = await readPullRequestComparison({ source, readPage: async () => page });
    expect(captured).toMatchObject({ state: 'complete', before: 'c'.repeat(40), after: 'b'.repeat(40),
      pullRequest: { baseOid: 'a'.repeat(40), url: 'https://github.com/upstream/repo/pull/17' } });
    expect(captured.files.map(file => file.path)).toEqual(rows.map(row => row.path));
    // The source Action transport is the trust boundary. Reject a stale fork's
    // repository or either pinned endpoint before admitting its unrelated files.
    for (const comparison of [
      { ...page.comparison, locator: { ...page.comparison.locator, repository: 'fork/repo' } },
      { ...page.comparison, baseOid: 'd'.repeat(40) },
      { ...page.comparison, headOid: 'd'.repeat(40) },
    ]) {
      const refused = await readPullRequestComparison({ source, readPage: async () => ({ ...page, comparison }) });
      expect(refused.state).toBe('unavailable');
      expect(refused.files).toEqual([]);
    }
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
