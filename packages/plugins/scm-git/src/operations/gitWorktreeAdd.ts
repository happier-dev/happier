import { isAbsolute } from 'node:path';

import { runScmCommand, type ScmExecResult } from '../runtime.js';
import { readRepositoryFileSystem } from '../repositoryFileSystem.js';
import { buildScmNonInteractiveEnv } from '../providers/shared/nonInteractiveEnv.js';
import { withGitWorktreeMutation } from './worktreeMutationQueue.js';

/**
 * The one place this package runs `git worktree add`.
 *
 * Two callers create worktrees for entirely different product reasons — the
 * user-facing `scm.worktree.create` operation and the workspace-checkout
 * materializer the pull-request preparation path realizes through — and both
 * previously carried their own argument builder, their own invocation, their
 * own "already exists" string test and their own suffixed-name fallback. That
 * is one concept with two owners: a flag added for one caller silently did not
 * apply to the other, and the two `already exists` tests did not even agree on
 * case.
 *
 * What stays with each caller is what genuinely differs: which directory it
 * prepares first, how it validates its own request, and how it maps a failure
 * into its own response shape. Only the git invocation and the naming policy
 * live here.
 */

export type GitWorktreeBranchModeV1 = 'new' | 'existing';

const GIT_WORKTREE_ADD_TIMEOUT_MS = 60_000;

/**
 * The worktree path is always passed after `--`, and a base ref always last, so
 * a name that begins with a dash can never be read as an option. `existing`
 * checks out a branch that already exists rather than creating one, which is
 * why it carries no base ref: the branch's own tip is the base.
 */
export function buildGitWorktreeAddArgs(params: Readonly<{
    branchName: string;
    worktreePath: string;
    branchMode: GitWorktreeBranchModeV1;
    baseRef?: string | null;
    force?: boolean;
}>): string[] {
    if (params.branchMode === 'existing') {
        return ['worktree', 'add', ...(params.force ? ['--force'] : []), '--', params.worktreePath, params.branchName];
    }

    const args = ['worktree', 'add', ...(params.force ? ['--force'] : []), '-b', params.branchName, '--', params.worktreePath];
    if (params.baseRef) args.push(params.baseRef);
    return args;
}

/**
 * Runs the add from the repository root, so a relative worktree path resolves
 * against the repository rather than the daemon's own working directory.
 */
export async function runGitWorktreeAdd(input: Readonly<{
    repoRoot: string;
    worktreePath: string;
    branchName: string;
    branchMode: GitWorktreeBranchModeV1;
    baseRef?: string | null;
    force?: boolean;
}>): Promise<ScmExecResult> {
    const paths = readRepositoryFileSystem().commandPaths;
    const worktreePath = paths && isAbsolute(input.worktreePath)
        ? paths.toCommandPath(input.worktreePath)
        : input.worktreePath;
    return await withGitWorktreeMutation(input.repoRoot, () => runScmCommand({
        bin: 'git',
        cwd: input.repoRoot,
        args: buildGitWorktreeAddArgs({
            branchName: input.branchName,
            worktreePath,
            branchMode: input.branchMode,
            baseRef: input.baseRef ?? null,
            force: input.force,
        }),
        timeoutMs: GIT_WORKTREE_ADD_TIMEOUT_MS,
        env: buildScmNonInteractiveEnv(),
    }));
}

/**
 * The single failure git reports when either the branch or the directory is
 * taken, and the only failure a suffixed retry may answer. Matched
 * case-insensitively because git's wording differs between the branch and the
 * path collision.
 */
export function isGitWorktreeAlreadyExistsFailure(value: unknown): boolean {
    const message = value instanceof Error ? value.message : String(value ?? '');
    return message.toLowerCase().includes('already exists');
}

/**
 * How many names one create may try before it reports the collision. The first
 * attempt is the requested name itself.
 */
export const GIT_WORKTREE_NAME_ATTEMPT_LIMIT = 4;

/** `feature`, then `feature-2`, `feature-3`, `feature-4`. */
export function gitWorktreeNameForAttempt(branchName: string, attempt: number): string {
    return attempt <= 1 ? branchName : `${branchName}-${attempt}`;
}
