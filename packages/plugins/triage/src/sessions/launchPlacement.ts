import type { TriageEntryRepositoryRefV1 } from '@happier-dev/triage-protocol/v1';
import { sameScmHostingRepositoryIdentity } from '@happier-dev/plugin-sdk/scm';
import type { ProjectKeyV1 } from '@happier-dev/plugin-sdk/sessions';

/**
 * Where a one-click Triage action runs, resolved by joining two identities the
 * product already has.
 *
 * A Triage entry that belongs to a forge repository declares that repository in
 * the resolved `hostingProvider` vocabulary
 * (`TriageEntryRepositoryRefV1`). A project's SCM working snapshot
 * (`packages/protocol/src/scm/workingSnapshot.ts`) resolves the SAME identity
 * for the checkout on disk. So the join is equality between two resolved
 * identities — **not** a remote-URL matcher, and not a walk over each machine's
 * recent paths reading its origin. Both of those were proposed and withdrawn:
 * the first makes every source re-implement a URL grammar and breaks the moment
 * two machines spell one remote differently, and the second is a discovery
 * crawl standing in for a registry that already exists.
 *
 * **No index is built here.** `WorkspaceRefV1`
 * (`packages/protocol/src/workspaces/workspaceRefV1.ts`), persisted in Account
 * Settings as `workspaceRefsV1`, already holds `{ id, serverId, machineId,
 * rootPath, label }` for every project the reader has opened, and the
 * `projectKey`-keyed working snapshot already holds that project's resolved
 * forge and its worktrees. This module reads what those two owners already say
 * and decides one thing: whether the answer is unambiguous enough to launch.
 *
 * **The degradation is the feature.** Exactly one reachable candidate launches
 * directly. Zero candidates, several candidates, or candidates on machines that
 * cannot be reached all open the host's New Session surface with what is known
 * prefilled. A one-click action that guessed a machine would put an agent to
 * work in the wrong checkout, and a reader would have no way to see that it had.
 */

/**
 * The one join key, both halves read straight off the incumbent resolved
 * `ScmHostingProviderRef` (`packages/protocol/src/scm/pullRequests.ts`).
 *
 * `kind` is the provider family. `deployment` is the ref's `baseUrl`
 * canonicalized to scheme + host + base path, which distinguishes separate
 * deployments of one forge. `repository` is normalized by the provider rule:
 * GitHub, GitLab, and Bitbucket fold case; Azure DevOps preserves its exact
 * source-owned project/repository identity. Nothing else participates:
 * a clone address, a remote name and a numeric repository id are all spellings
 * that differ between two machines describing one repository.
 */
export type TriageForgeIdentityV1 = TriageEntryRepositoryRefV1;

/**
 * One worktree of a candidate project, as its working snapshot reports it.
 *
 * The list travels with the candidate because it is what makes "fix in a new
 * worktree or in the main checkout?" an answerable question at the moment the
 * reader presses. Resolving it later would mean a second read against a machine
 * the surface has already decided to use.
 */
export type TriageProjectWorktreeV1 = Readonly<{
    path: string;
    branch: string | null;
    isMain: boolean;
    isCurrent: boolean;
}>;

/**
 * One persisted project row plus the two facts its working snapshot resolved.
 *
 * `forge` is absent when no snapshot has resolved one for this project — an
 * unopened project, a non-SCM directory, or a repository with no recognized
 * hosting provider. Such a project is not a candidate for anything; it is
 * silently not matched rather than probed.
 */
export type TriageProjectCandidateV1 = Readonly<{
    projectKey: ProjectKeyV1;
    serverId: string;
    machineId: string;
    rootPath: string;
    label?: string;
    forge?: TriageForgeIdentityV1;
    worktrees: readonly TriageProjectWorktreeV1[];
    /**
     * Whether this project's machine can run a Session right now, read from the
     * incumbent machine inventory. An unreachable candidate is still shown —
     * "the checkout is on the laptop that is asleep" is the useful answer — but
     * it never launches.
     */
    reachable: boolean;
}>;

/**
 * A matched project carried atomically through fallback placement. Server,
 * machine, root, project identity, and worktrees are never split and recombined
 * by a later owner.
 */
export type TriageLaunchCandidateV1 = Readonly<{
    projectKey: ProjectKeyV1;
    serverId: string;
    machineId: string;
    rootPath: string;
    label?: string;
    worktrees: readonly TriageProjectWorktreeV1[];
    reachable: boolean;
}>;

/** Why the press could not resolve one place to run, stated for the reader. */
export type TriageLaunchPlacementPrefillReasonV1 =
    /** The entry names no forge repository. An error group never will. */
    | 'noForgeIdentity'
    /** No project the reader has opened resolves this repository. */
    | 'noMatch'
    /** Projects match, but no machine holding one can be reached. */
    | 'unreachable'
    /** Several reachable checkouts of one repository. Two clones are two choices. */
    | 'ambiguous'
    /**
     * The project registry answered with an admittedly PARTIAL page, so no
     * exact claim about it survives.
     *
     * `noMatch`, `unreachable` and a single-candidate `launch` are all claims
     * that one unread row could overturn — and the launch is the dangerous one:
     * a second checkout of the same repository past the cut turns a genuinely
     * ambiguous placement into an apparent exact match and starts an agent in a
     * checkout the reader never chose. `ambiguous` is the one answer more rows
     * cannot overturn, so it survives a partial read; everything else becomes
     * this.
     */
    | 'incompleteRegistry';

export type TriageLaunchPlacementV1 =
    | Readonly<{ kind: 'launch'; candidate: TriageLaunchCandidateV1 }>
    | Readonly<{
        kind: 'prefill';
        reason: TriageLaunchPlacementPrefillReasonV1;
        /**
         * Every matched project, reachable first. It is what the New Session
         * surface is prefilled from, and it is empty exactly when nothing
         * matched — never a truncation of a larger set.
         */
        candidates: readonly TriageLaunchCandidateV1[];
    }>;

/**
 * Identity equality, component by component, compared EXACTLY.
 *
 * Triage owns no case rule and must not invent one (`PLAN.md` §0a A5a). The
 * repository path's case rule belongs to the FORGE: GitHub addresses
 * `owner/name` case-insensitively, a self-hosted Git forge behind a
 * case-sensitive path need not, and `custom`/`unknown` deployments warrant
 * nothing at all. A universal `toLowerCase()` here applied GitHub's rule to
 * every forge in the vocabulary, so on a case-sensitive one it produced a false
 * MATCH — the one failure mode this module exists to prevent, because a false
 * match is what launches an agent into the wrong checkout.
 *
 * What replaces it is not a weaker join, it is the join moved to its owner:
 * each source publishes the canonical comparable repository identity for the
 * entry, and the project's resolved SCM hosting provider publishes the
 * corresponding canonical identity for the checkout. Two observers of one
 * repository therefore produce equal records, and this module compares them.
 * A malformed or non-canonical source identity degrades to `noMatch` and the reader
 * gets the New Session surface — the honest degradation, never a wrong launch.
 *
 * `deployment` was already exact for the same reason and stays so: it carries
 * a collection or instance base path that IS case-significant, and folding it
 * would collapse two deployments of one forge into one.
 */
function candidateFor(project: TriageProjectCandidateV1): TriageLaunchCandidateV1 {
    return Object.freeze({
        projectKey: project.projectKey,
        serverId: project.serverId,
        machineId: project.machineId,
        rootPath: project.rootPath,
        ...(project.label === undefined ? {} : { label: project.label }),
        worktrees: project.worktrees,
        reachable: project.reachable,
    });
}

/**
 * Presentation order only, and deliberately clock-free.
 *
 * Reachable first, because that is the distinction the reader acts on. Then by
 * root path, so two readings of one registry produce one order. Nothing here
 * decides anything: when two reachable candidates match, the answer is
 * `ambiguous` no matter which one sorts first.
 */
function byReachableThenRootPath(
    left: TriageLaunchCandidateV1,
    right: TriageLaunchCandidateV1,
): number {
    if (left.reachable !== right.reachable) return left.reachable ? -1 : 1;
    if (left.rootPath === right.rootPath) return 0;
    return left.rootPath < right.rootPath ? -1 : 1;
}

function prefill(
    reason: TriageLaunchPlacementPrefillReasonV1,
    candidates: readonly TriageLaunchCandidateV1[],
): TriageLaunchPlacementV1 {
    return Object.freeze({ kind: 'prefill', reason, candidates: Object.freeze(candidates) });
}

/**
 * Resolves where one press runs.
 *
 * It reads two already-resolved facts and makes one decision. It contacts no
 * machine, opens no directory, parses no URL, and never picks between two
 * matches: the whole point of the ambiguous arm is that a reader with two
 * clones of one repository gets to say which one.
 */
export function resolveTriageLaunchPlacementV1(input: Readonly<{
    /** The entry's declared repository. Absent for every non-forge entry. */
    forge?: TriageForgeIdentityV1;
    projects: readonly TriageProjectCandidateV1[];
    /**
     * Whether `projects` is the WHOLE registry rather than a page of it.
     *
     * It defaults to complete because a caller that says nothing is handing
     * over everything it has; a reader that truncated must say so. Exactness is
     * the whole product of this module, and a truncated set cannot support it:
     * the row that would have made the answer ambiguous may simply not be in
     * the array.
     */
    registryComplete?: boolean;
}>): TriageLaunchPlacementV1 {
    const forge = input.forge;
    // An entry with no repository resolves no candidate whatever the registry
    // holds, so a partial read cannot change this answer.
    if (forge === undefined) return prefill('noForgeIdentity', []);

    const matched = input.projects
        .filter((project) => sameScmHostingRepositoryIdentity(project.forge, forge))
        .map(candidateFor)
        .sort(byReachableThenRootPath);

    const reachable = matched.filter((candidate) => candidate.reachable);
    // Two reachable checkouts are two choices no matter how many rows went
    // unread, so this is the one verdict a partial read still supports.
    if (reachable.length > 1) return prefill('ambiguous', matched);
    if (input.registryComplete === false) return prefill('incompleteRegistry', matched);

    if (matched.length === 0) return prefill('noMatch', []);
    if (reachable.length === 0) return prefill('unreachable', matched);

    const only = reachable[0];
    // `reachable.length === 1` already proved this, and the read is here only
    // because the index signature cannot say so.
    if (only === undefined) return prefill('noMatch', matched);
    return Object.freeze({ kind: 'launch', candidate: only });
}
