import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { CodeIntelligenceCommitV1 } from '@happier-dev/protocol';

import { openCodeIntelligenceStore, type CodeIntelligenceStore } from './codeIntelligenceStore';

const openStores: CodeIntelligenceStore[] = [];
const tempDirs: string[] = [];

async function openTempStore(): Promise<Readonly<{ store: CodeIntelligenceStore; dbPath: string }>> {
  const dir = await mkdtemp(join(tmpdir(), 'code-intelligence-store-'));
  tempDirs.push(dir);
  const dbPath = join(dir, 'ci.sqlite');
  const store = openCodeIntelligenceStore({ dbPath });
  openStores.push(store);
  return { store, dbPath };
}

function buildCommit(overrides: Partial<CodeIntelligenceCommitV1> = {}): CodeIntelligenceCommitV1 {
  return {
    repositoryId: 'repo-1',
    sha: 'a'.repeat(40),
    observedInWorktreePath: '/work/repo',
    branch: 'main',
    subject: 'feat: something',
    authorName: 'Dev',
    committedAtMs: 1_000,
    observedAtMs: 2_000,
    parentCount: 1,
    changedFiles: [],
    changedSymbols: [],
    impactedReferences: [],
    plausibleSessionIds: [],
    analysis: {
      status: 'queued',
      reason: null,
      summary: null,
      riskLevel: 'unknown',
      findings: [],
      providerId: null,
      modelId: null,
      billing: null,
      inputTokens: null,
      outputTokens: null,
      estimatedCostUsd: null,
      retryAfterMs: null,
      attempts: 0,
      updatedAtMs: 2_000,
    },
    ...overrides,
  };
}

afterEach(async () => {
  for (const store of openStores.splice(0)) store.close();
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('code intelligence store', () => {
  it('records a commit once per repository and sha, even when observed from another worktree', async () => {
    const { store } = await openTempStore();

    expect(store.insertCommitIfAbsent(buildCommit())).toBe(true);
    expect(store.insertCommitIfAbsent(buildCommit({ observedInWorktreePath: '/work/repo-wt' }))).toBe(false);
    expect(store.insertCommitIfAbsent(buildCommit({ repositoryId: 'repo-2' }))).toBe(true);

    expect(store.listRecentCommits({ limit: 10 })).toHaveLength(2);
    expect(store.getCommit({ repositoryId: 'repo-1', sha: 'a'.repeat(40) })?.observedInWorktreePath).toBe('/work/repo');
  });

  it('persists events and analysis state across reopen so a restarted client recovers them', async () => {
    const { store, dbPath } = await openTempStore();
    store.insertCommitIfAbsent(buildCommit());
    store.appendEvent({ kind: 'commit_observed', atMs: 2_000, repositoryId: 'repo-1', worktreePath: '/work/repo', sessionId: null, commitSha: 'a'.repeat(40), data: { subject: 'feat: something' } });
    store.updateCommitAnalysis({
      repositoryId: 'repo-1',
      sha: 'a'.repeat(40),
      analysis: { ...buildCommit().analysis, status: 'skipped', reason: 'remote_analysis_disabled', updatedAtMs: 3_000 },
    });
    store.close();
    openStores.splice(openStores.indexOf(store), 1);

    const reopened = openCodeIntelligenceStore({ dbPath });
    openStores.push(reopened);

    const page = reopened.listEventsAfter({ afterSeq: 0, limit: 10 });
    expect(page.events.map((event) => event.kind)).toEqual(['commit_observed']);
    expect(page.latestSeq).toBe(1);
    expect(reopened.getCommit({ repositoryId: 'repo-1', sha: 'a'.repeat(40) })?.analysis.reason).toBe('remote_analysis_disabled');
  });

  it('returns only events after the cursor and flags a cursor that retention already passed', async () => {
    const { store } = await openTempStore();
    for (let index = 0; index < 4; index += 1) {
      store.appendEvent({ kind: 'session_observed', atMs: 1_000 * (index + 1), repositoryId: null, worktreePath: null, sessionId: `s${index}`, commitSha: null, data: {} });
    }

    const tail = store.listEventsAfter({ afterSeq: 2, limit: 10 });
    expect(tail.events.map((event) => event.seq)).toEqual([3, 4]);
    expect(tail.truncated).toBe(false);

    store.prune({ olderThanMs: 2_500 });

    const stale = store.listEventsAfter({ afterSeq: 0, limit: 10 });
    expect(stale.events.map((event) => event.seq)).toEqual([3, 4]);
    expect(stale.truncated).toBe(true);
    expect(store.listEventsAfter({ afterSeq: 2, limit: 10 }).truncated).toBe(false);
  });

  it('keeps repository worktrees together and reports the previous worktree state on update', async () => {
    const { store } = await openTempStore();
    expect(store.upsertRepository({ repositoryId: 'repo-1', displayName: 'repo', commonDirPath: '/work/repo/.git', registrationSource: 'session', nowMs: 1 }).created).toBe(true);
    expect(store.upsertRepository({ repositoryId: 'repo-1', displayName: 'repo', commonDirPath: '/work/repo/.git', registrationSource: 'manual', nowMs: 2 }).created).toBe(false);

    const first = store.upsertWorktree({ repositoryId: 'repo-1', worktreePath: '/work/repo', gitDirPath: '/work/repo/.git', isLinkedWorktree: false, branch: 'main', headCommit: 'a', nowMs: 1 });
    expect(first.previous).toBeNull();
    const second = store.upsertWorktree({ repositoryId: 'repo-1', worktreePath: '/work/repo', gitDirPath: '/work/repo/.git', isLinkedWorktree: false, branch: 'feature', headCommit: 'b', nowMs: 2 });
    expect(second.previous?.branch).toBe('main');
    store.upsertWorktree({ repositoryId: 'repo-1', worktreePath: '/work/repo-wt', gitDirPath: '/work/repo/.git/worktrees/repo-wt', isLinkedWorktree: true, branch: 'fix', headCommit: 'c', nowMs: 3 });

    const [repository] = store.listRepositories();
    expect(repository?.registrationSource).toBe('session');
    expect(repository?.worktrees.map((worktree) => [worktree.worktreePath, worktree.branch])).toEqual([
      ['/work/repo', 'feature'],
      ['/work/repo-wt', 'fix'],
    ]);
  });

  it('sums recorded spend per month for budget enforcement', async () => {
    const { store } = await openTempStore();
    store.recordUsage({ monthKey: '2026-10', providerId: 'p', inputTokens: 10, outputTokens: 5, costUsd: 0.25 });
    store.recordUsage({ monthKey: '2026-10', providerId: 'p', inputTokens: 10, outputTokens: 5, costUsd: 0.5 });
    store.recordUsage({ monthKey: '2026-09', providerId: 'p', inputTokens: 10, outputTokens: 5, costUsd: 9 });

    expect(store.getMonthlySpendUsd({ monthKey: '2026-10' })).toBeCloseTo(0.75);
  });
});
