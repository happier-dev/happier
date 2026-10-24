import type { CodeIntelligenceCommitV1, CodeIntelligenceRepositoryV1 } from '@happier-dev/protocol';

import { listNewCommits, resolveObservedCheckout, type ObservedCheckout } from '../git/observedGit';
import type { CodeIntelligenceStore } from '../store/codeIntelligenceStore';
import { buildCommitObservation } from './buildCommitObservation';

/**
 * A ref update (pull, rebase, merge) can bring in many commits at once. Only the newest are
 * observed individually so one fetch cannot flood the activity feed and analysis queue; the
 * omitted count is reported on the event.
 */
const MAX_COMMITS_PER_REF_UPDATE = 50;

export type CheckoutObservation = Readonly<{
  checkout: ObservedCheckout;
  newCommits: CodeIntelligenceCommitV1[];
}>;

/**
 * Reconciles one working directory against the store: registers its repository and worktree on
 * first sight (a baseline only — history is never back-filled), reports branch switches, and
 * records commits that became reachable from HEAD since the previous observation. Commits are
 * keyed by repository and SHA, so the same commit reached from another worktree or by a branch
 * pointer move is never observed twice.
 */
export async function observeCheckout(input: Readonly<{
  store: CodeIntelligenceStore;
  cwd: string;
  registrationSource: CodeIntelligenceRepositoryV1['registrationSource'];
  excludedPathPrefixes: readonly string[];
  resolvePlausibleSessionIds: (worktreePath: string) => string[];
  /** The session whose sweep triggered this observation, before it is itself stored. */
  additionalPlausibleSessionIds?: readonly string[];
  /**
   * Filesystem policy. The working directory is asked before git runs in it, then the resolved
   * worktree and git common dir; a refused checkout is never read or registered.
   */
  isPathAllowed?: (path: string) => boolean;
  nowMs: () => number;
}>): Promise<CheckoutObservation | null> {
  const isPathAllowed = input.isPathAllowed ?? (() => true);
  if (!isPathAllowed(input.cwd)) return null;
  const checkout = await resolveObservedCheckout({ cwd: input.cwd });
  if (!checkout) return null;
  if (!isPathAllowed(checkout.worktreePath) || !isPathAllowed(checkout.commonDirPath)) return null;
  const { store } = input;
  const observedAtMs = input.nowMs();

  const { created } = store.upsertRepository({
    repositoryId: checkout.repositoryId,
    displayName: checkout.displayName,
    commonDirPath: checkout.commonDirPath,
    registrationSource: input.registrationSource,
    nowMs: observedAtMs,
  });
  if (created) {
    store.appendEvent({
      kind: 'repository_registered',
      atMs: observedAtMs,
      repositoryId: checkout.repositoryId,
      worktreePath: checkout.worktreePath,
      sessionId: null,
      commitSha: null,
      data: { displayName: checkout.displayName, source: input.registrationSource },
    });
  }

  const previous = store.getWorktree({ worktreePath: checkout.worktreePath });
  if (!previous) {
    store.appendEvent({
      kind: 'worktree_observed',
      atMs: observedAtMs,
      repositoryId: checkout.repositoryId,
      worktreePath: checkout.worktreePath,
      sessionId: null,
      commitSha: checkout.headCommit,
      data: { branch: checkout.branch, isLinkedWorktree: checkout.isLinkedWorktree },
    });
  } else if (previous.branch !== checkout.branch) {
    store.appendEvent({
      kind: 'branch_changed',
      atMs: observedAtMs,
      repositoryId: checkout.repositoryId,
      worktreePath: checkout.worktreePath,
      sessionId: null,
      commitSha: checkout.headCommit,
      data: { from: previous.branch, to: checkout.branch },
    });
  }

  // The HEAD checkpoint only moves once every commit it covers is recorded, so a git read that
  // fails part-way is retried on the next observation instead of being skipped for good.
  let checkpoint = previous ? previous.headCommit : checkout.headCommit;
  const newCommits: CodeIntelligenceCommitV1[] = [];
  if (previous && checkout.headCommit && previous.headCommit !== checkout.headCommit) {
    const range = await listNewCommits({
      worktreePath: checkout.worktreePath,
      previousHead: previous.headCommit,
      currentHead: checkout.headCommit,
      maxCommits: MAX_COMMITS_PER_REF_UPDATE,
    });
    const plausibleSessionIds = [...new Set([
      ...input.resolvePlausibleSessionIds(checkout.worktreePath),
      ...(input.additionalPlausibleSessionIds ?? []),
    ])];
    let complete = range !== null;
    for (const [index, sha] of (range?.shas ?? []).entries()) {
      if (store.getCommit({ repositoryId: checkout.repositoryId, sha })) continue;
      const commit = await buildCommitObservation({
        repositoryId: checkout.repositoryId,
        worktreePath: checkout.worktreePath,
        branch: checkout.branch,
        sha,
        excludedPathPrefixes: input.excludedPathPrefixes,
        plausibleSessionIds,
        nowMs: input.nowMs(),
      });
      if (!commit) {
        complete = false;
        break;
      }
      if (!store.insertCommitIfAbsent(commit)) continue;
      newCommits.push(commit);
      store.appendEvent({
        kind: 'commit_observed',
        atMs: commit.observedAtMs,
        repositoryId: checkout.repositoryId,
        worktreePath: checkout.worktreePath,
        sessionId: null,
        commitSha: commit.sha,
        data: {
          subject: commit.subject,
          branch: commit.branch,
          changedFiles: commit.changedFileCount ?? commit.changedFiles.length,
          changedSymbols: commit.changedSymbols.length,
          ...(index === 0 && range && range.omittedCount > 0 ? { omittedOlderCommits: range.omittedCount } : {}),
        },
      });
    }
    if (complete) checkpoint = checkout.headCommit;
  }

  store.upsertWorktree({
    repositoryId: checkout.repositoryId,
    worktreePath: checkout.worktreePath,
    gitDirPath: checkout.gitDirPath,
    isLinkedWorktree: checkout.isLinkedWorktree,
    branch: checkout.branch,
    headCommit: checkpoint,
    nowMs: observedAtMs,
  });

  return { checkout, newCommits };
}
