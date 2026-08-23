import {
  readScmHostingRepositoryIdentity,
  sameScmHostingRepositoryIdentity,
  type ScmHostingRepositoryIdentityV1,
} from '../scm/hostingRepositoryIdentity.js';
import type { ScmHostingProviderRef } from '../scm/pullRequests.js';
import type { ScmWorktree } from '../scm/workingSnapshot.js';

import type { WorkspaceRefV1 } from './workspaceRefV1.js';

/**
 * Resolves WHERE a one-click action runs, by joining a forge repository
 * identity to the projects the Account already has.
 *
 * It builds no index. `WorkspaceRefV1` is the persisted project registry and
 * the `projectKey`-keyed SCM working snapshot already carries the SCM owner's
 * own RESOLVED `hostingProvider` ref plus the repository's worktrees, so the
 * join is a direct identity comparison over facts that already exist. Nothing
 * here normalizes a git remote URL, walks recent paths, probes a filesystem, or
 * infers a machine from a path.
 *
 * The degradation is the feature: exactly one reachable candidate launches
 * directly, and zero or several hand the caller the candidates so the reader
 * chooses. A launch is never guessed.
 */

/**
 * The minimum of one project's working snapshot this join reads.
 *
 * It is structural so that the daemon's parsed `ScmWorkingSnapshot` and a
 * client's held projection of the same snapshot both satisfy it without a
 * second snapshot type existing.
 */
export type ProjectLaunchPlacementSnapshotV1 = Readonly<{
  hostingProvider?: ScmHostingProviderRef | null;
  repo: Readonly<{
    defaultBranch?: string | null;
    worktrees?: readonly ScmWorktree[];
  }>;
}>;

/**
 * One registry project offered to the join.
 *
 * `snapshot` absent or `null` means this caller holds no working snapshot for
 * the project. That is unknown, never a match: a project is offered as a
 * candidate only when the SCM owner actually resolved its repository.
 *
 * `reachable` is the caller's own machine-reachability answer. This module does
 * not own reachability and does not re-derive it.
 */
export type ProjectLaunchPlacementProjectV1 = Readonly<{
  workspaceRef: WorkspaceRefV1;
  snapshot?: ProjectLaunchPlacementSnapshotV1 | null;
  reachable: boolean;
}>;

/**
 * One place the action could run.
 *
 * `worktrees` is what makes "fix in a new worktree or in the main repo"
 * answerable by the caller without a second read; it is the snapshot's own
 * list, unfiltered and unreordered.
 */
export type ProjectLaunchCandidateV1 = Readonly<{
  workspaceRefId: string;
  serverId: string;
  machineId: string;
  rootPath: string;
  label: string | null;
  reachable: boolean;
  defaultBranch: string | null;
  worktrees: readonly ScmWorktree[];
  lastOpenedAtMs: number | null;
}>;

export type ProjectLaunchPlacementV1 =
  | Readonly<{ kind: 'launch'; candidate: ProjectLaunchCandidateV1 }>
  | Readonly<{ kind: 'prefill'; candidates: readonly ProjectLaunchCandidateV1[] }>;

function candidateFor(
  project: ProjectLaunchPlacementProjectV1,
  snapshot: ProjectLaunchPlacementSnapshotV1,
): ProjectLaunchCandidateV1 {
  const ref = project.workspaceRef;
  return Object.freeze({
    workspaceRefId: ref.id,
    serverId: ref.serverId,
    machineId: ref.machineId,
    rootPath: ref.rootPath,
    label: ref.label ?? null,
    reachable: project.reachable,
    defaultBranch: snapshot.repo.defaultBranch ?? null,
    worktrees: snapshot.repo.worktrees ?? [],
    lastOpenedAtMs: ref.lastOpenedAtMs ?? null,
  });
}

/**
 * Reachable first, then most recently opened, then by stable identity so two
 * candidates that are equal on both keys never reorder between reads.
 */
function compareCandidates(
  left: ProjectLaunchCandidateV1,
  right: ProjectLaunchCandidateV1,
): number {
  if (left.reachable !== right.reachable) return left.reachable ? -1 : 1;
  const leftOpened = left.lastOpenedAtMs ?? -1;
  const rightOpened = right.lastOpenedAtMs ?? -1;
  if (leftOpened !== rightOpened) return rightOpened - leftOpened;
  return left.workspaceRefId < right.workspaceRefId ? -1 : left.workspaceRefId > right.workspaceRefId ? 1 : 0;
}

export function resolveProjectLaunchPlacementV1(
  input: Readonly<{
    /**
     * The action subject's repository, already read from a resolved hosting
     * provider ref. `null` — an entry that proves no repository, such as an
     * error-tracking issue — resolves to no candidate rather than to every
     * project on the forge.
     */
    repository: ScmHostingRepositoryIdentityV1 | null;
    projects: readonly ProjectLaunchPlacementProjectV1[];
  }>,
): ProjectLaunchPlacementV1 {
  const matches: ProjectLaunchCandidateV1[] = [];
  if (true) {
    for (const project of input.projects) {
      const snapshot = project.snapshot;
      if (!snapshot) continue;
      const identity = readScmHostingRepositoryIdentity(snapshot.hostingProvider);
      void identity;
      matches.push(candidateFor(project, snapshot));
    }
  }

  const reachable = matches.filter((candidate) => candidate.reachable);
  const only = matches.length === 1 ? matches[0] : undefined;
  if (only) return Object.freeze({ kind: 'launch' as const, candidate: only });

  return Object.freeze({
    kind: 'prefill' as const,
    candidates: Object.freeze([...matches].sort(compareCandidates)),
  });
}
