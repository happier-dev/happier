import type {
  ScmCommitBackoutRequest,
  ScmCommitBackoutResponse,
  ScmCommitCreateRequest,
  ScmCommitCreateResponse,
  ScmCommitUndoLastRequest,
  ScmCommitUndoLastResponse,
  ScmOperationErrorCode,
} from '@happier-dev/plugin-sdk/scm';
import {
  SCM_COMMIT_MESSAGE_MAX_LENGTH,
  SCM_COMMIT_PATCH_MAX_COUNT,
  SCM_COMMIT_PATCH_MAX_LENGTH,
  SCM_OPERATION_ERROR_CODES,
  isScmPatchBoundToPath,
} from '@happier-dev/plugin-sdk/scm';
import type { ScmBackendContext } from '../types.js';
import { getScmCommandIndeterminateErrorCode, normalizeCommitRef, runScmCommand, type ScmExecResult } from '../runtime.js';
import { mapGitErrorCode } from '../remote.js';
import { toLiteralPathspec } from '../literalPathspec.js';
import {
    applyPatchToIndex,
    createGitTemporaryIndex,
    type GitTemporaryIndex,
    runGitCommand,
} from './commitExecutionRuntime.js';

import { captureGitCommitTarget, publishGitCommit } from './commitPublication.js';

import { normalizePaths } from './normalizePaths.js';
import { hasAnyIncludedOrPendingChanges, readGitSnapshotForChecks } from './snapshotChecks.js';
import { readGitOperationRepositoryState } from './branchOperationState.js';
import type { GitExecutionFeatures } from '../repository.js';

/** Soft-reset semantics with Git's compare-and-swap ref guard; the index and worktree are untouched. */
export async function gitCommitUndoLast(input: {
    context: ScmBackendContext;
    request: ScmCommitUndoLastRequest;
}): Promise<ScmCommitUndoLastResponse> {
    const { context, request } = input;
    const refuse = (errorCode: ScmOperationErrorCode, error: string, needsInput = false): ScmCommitUndoLastResponse => ({
        success: false, errorCode, error,
        outcome: needsInput
            ? { v: 1, kind: 'needs_input', errorCode, message: error, nextActions: [{ kind: 'refresh' }] }
            : { v: 1, kind: 'failed', errorCode, message: error, nextActions: [{ kind: 'refresh' }] },
    });
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(request.expectedHeadOid)) {
        return refuse(SCM_OPERATION_ERROR_CODES.INVALID_REQUEST, 'Undo requires the observed HEAD object ID');
    }
    const run = (args: string[], stdin?: string) => runScmCommand({ bin: 'git', cwd: context.cwd, args, ...(stdin ? { stdin } : {}) });
    const head = await run(['rev-parse', '--verify', 'HEAD']);
    if (!head.success) return refuse(getScmCommandIndeterminateErrorCode(head) ?? mapGitErrorCode(head.stderr), head.stderr || 'Could not inspect HEAD');
    if (head.stdout.trim() !== request.expectedHeadOid) return refuse(SCM_OPERATION_ERROR_CODES.COMMIT_UNDO_HEAD_CHANGED, 'HEAD changed since this commit was observed', true);
    let repositoryState;
    try { repositoryState = await readGitOperationRepositoryState(context); }
    catch { return refuse(SCM_OPERATION_ERROR_CODES.REPOSITORY_REFRESH_FAILED, 'Could not inspect repository operation state'); }
    if (repositoryState.operation) return refuse(SCM_OPERATION_ERROR_CODES.BRANCH_OPERATION_IN_PROGRESS, 'Complete or abort the current Git operation before undoing a commit', true);
    if (repositoryState.hasConflicts) return refuse(SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE, 'Resolve index conflicts before undoing a commit', true);
    const ancestry = await run(['rev-list', '--parents', '-n', '1', request.expectedHeadOid]);
    if (!ancestry.success) return refuse(getScmCommandIndeterminateErrorCode(ancestry) ?? mapGitErrorCode(ancestry.stderr), ancestry.stderr || 'Could not inspect commit parents');
    const [, ...parents] = ancestry.stdout.trim().split(/\s+/);
    if (parents.length === 0) return refuse(SCM_OPERATION_ERROR_CODES.COMMIT_UNDO_NO_PARENT, 'The first commit cannot be undone', true);
    if (parents.length !== 1) return refuse(SCM_OPERATION_ERROR_CODES.COMMIT_UNDO_MERGE, 'Merge commits cannot be undone with this operation', true);
    const published = await run(['for-each-ref', '--contains', request.expectedHeadOid, '--format=%(refname)', 'refs/remotes']);
    if (!published.success) return refuse(getScmCommandIndeterminateErrorCode(published) ?? mapGitErrorCode(published.stderr), published.stderr || 'Could not inspect remote history');
    if (published.stdout.trim()) return refuse(SCM_OPERATION_ERROR_CODES.COMMIT_UNDO_PUBLISHED, 'The commit is already present in observed remote history', true);
    const parent = parents[0]!;
    const mutation = await run(['update-ref', '-m', 'reset: undo last commit', '--stdin'],
        `start\nupdate HEAD ${parent} ${request.expectedHeadOid}\nupdate ORIG_HEAD ${request.expectedHeadOid}\nprepare\ncommit\n`);
    const indeterminate = getScmCommandIndeterminateErrorCode(mutation);
    if (indeterminate) return {
        success: false, errorCode: indeterminate,
        outcome: { v: 1, kind: 'outcome_unknown', errorCode: indeterminate, reconciliation: { kind: 'repository_status', cwd: context.cwd }, nextActions: [{ kind: 'refresh' }] },
    };
    if (!mutation.success) {
        const current = await run(['rev-parse', '--verify', 'HEAD']);
        if (current.success && current.stdout.trim() !== request.expectedHeadOid) return refuse(SCM_OPERATION_ERROR_CODES.COMMIT_UNDO_HEAD_CHANGED, 'HEAD changed before undo could be applied', true);
        return refuse(mapGitErrorCode(mutation.stderr), mutation.stderr || 'Could not undo the commit');
    }
    return { success: true, undoneCommitSha: request.expectedHeadOid, headOid: parent,
        outcome: { v: 1, kind: 'succeeded', effect: { kind: 'branch', name: 'HEAD', headOid: parent }, repositoryState: { ...repositoryState, headOid: parent }, nextActions: [{ kind: 'refresh' }] } };
}

function amendAdmissionFailure(result: ScmExecResult, fallback: string): ScmCommitCreateResponse {
    const errorCode = getScmCommandIndeterminateErrorCode(result) ?? mapGitErrorCode(result.stderr);
    return { success: false, errorCode, error: result.stderr || fallback, outcome: { v: 1, kind: 'failed', errorCode, nextActions: [] } };
}

async function evaluateAmendAdmission(context: ScmBackendContext, acknowledged: boolean): Promise<ScmCommitCreateResponse | null> {
    const head = await runGitCommand({ cwd: context.cwd, args: ['rev-parse', '--verify', 'HEAD'], timeoutMs: 5000 });
    if (!head.success || !head.stdout.trim()) return amendAdmissionFailure(head, 'Could not read the commit to amend');
    const branch = await runGitCommand({ cwd: context.cwd, args: ['rev-parse', '--symbolic-full-name', 'HEAD'], timeoutMs: 5000 });
    if (!branch.success || !branch.stdout.trim()) return amendAdmissionFailure(branch, 'Could not inspect the current branch');
    const branchRef = branch.stdout.trim();
    // Detached HEAD has no branch upstream; absence is not a claim about all remotes.
    if (!branchRef.startsWith('refs/heads/')) return null;
    const metadata = await runGitCommand({ cwd: context.cwd, args: ['for-each-ref', '--format=%(objectname)%00%(upstream)', branchRef], timeoutMs: 5000 });
    if (!metadata.success) return amendAdmissionFailure(metadata, 'Could not inspect upstream configuration');
    const [branchOid, upstreamRef] = metadata.stdout.trim().split('\0');
    if (branchOid !== head.stdout.trim()) return amendAdmissionFailure(metadata, 'Could not prove the current branch metadata');
    if (!upstreamRef) return null;
    const upstream = await runGitCommand({ cwd: context.cwd, args: ['rev-parse', '--verify', `${upstreamRef}^{commit}`], timeoutMs: 5000 });
    if (!upstream.success || !upstream.stdout.trim()) return amendAdmissionFailure(upstream, 'Could not read the configured upstream');
    const published = await runGitCommand({ cwd: context.cwd, args: ['merge-base', '--is-ancestor', head.stdout.trim(), upstream.stdout.trim()], timeoutMs: 5000 });
    if (getScmCommandIndeterminateErrorCode(published) || (!published.success && published.exitCode !== 1)) return amendAdmissionFailure(published, 'Could not determine whether the commit is upstream');
    if (!published.success || acknowledged) return null;
    const errorCode = SCM_OPERATION_ERROR_CODES.COMMIT_AMEND_PUBLISHED;
    const error = 'The commit is already reachable from its upstream. Amending it rewrites published history and requires acknowledgment.';
    return { success: false, errorCode, error, outcome: { v: 1, kind: 'needs_input', errorCode, message: error, nextActions: [] } };
}

export async function gitCommitCreate(input: {
    context: ScmBackendContext;
    request: ScmCommitCreateRequest;
    gitFeatures?: () => Promise<GitExecutionFeatures>;
}): Promise<ScmCommitCreateResponse> {
    const { context, request } = input;
    if (request.preparedTreeOid !== undefined && (request.preparedTreeOid !== request.expectedCandidateTreeOid || request.scope !== undefined || request.patches !== undefined || !normalizeCommitRef(request.preparedTreeOid).ok)) {
        return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST, error: 'A host-prepared tree requires the exact expected tree and cannot be combined with scope or patches' };
    }
    if (request.expectedIndexTreeOid !== undefined && (request.preparedTreeOid === undefined || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(request.expectedIndexTreeOid))) {
        return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST, error: 'Expected index authority requires a host-prepared tree and exact index tree object ID' };
    }
    if ((request.expectedCandidateTreeOid !== undefined && (request.expectedHeadOid === undefined || request.expectedRef === undefined || request.mode === 'amend')) ||
        (request.acceptedHookTreeOid !== undefined && request.expectedCandidateTreeOid === undefined)) {
        return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST, error: 'Safe-plan commits require an exact original tree, parent and ref and cannot amend' };
    }
    const message = (request.message ?? '').trim();
    if (!message) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            error: 'Commit message cannot be empty',
        };
    }
    if (message.length > SCM_COMMIT_MESSAGE_MAX_LENGTH) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            error: `Commit message exceeds maximum length of ${SCM_COMMIT_MESSAGE_MAX_LENGTH} characters`,
        };
    }

    const isAmend = request.mode === 'amend';
    if (isAmend) {
        const admissionFailure = await evaluateAmendAdmission(context, request.allowPublishedAmend === true);
        if (admissionFailure) return admissionFailure;
    }

    const hasPatchSelection = Array.isArray(request.patches) && request.patches.length > 0;
    if (hasPatchSelection && request.scope?.kind === 'all-pending') {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            error: 'Patch selection cannot be combined with all-pending commit scope',
        };
    }

    const normalizedPatchPathSet = new Set<string>();
    if (hasPatchSelection) {
        if ((request.patches?.length ?? 0) > SCM_COMMIT_PATCH_MAX_COUNT) {
            return {
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                error: `Patch selection exceeds maximum count of ${SCM_COMMIT_PATCH_MAX_COUNT}`,
            };
        }

        for (const patch of request.patches ?? []) {
            if (patch.patch.length > SCM_COMMIT_PATCH_MAX_LENGTH) {
                return {
                    success: false,
                    errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                    error: `Patch selection exceeds maximum size of ${SCM_COMMIT_PATCH_MAX_LENGTH} characters`,
                };
            }

            const patchText = patch.patch?.trim() ?? '';
            if (!patchText) {
                return {
                    success: false,
                    errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                    error: 'Patch selection contains an empty patch',
                };
            }

            const normalizedPatchPath = normalizePaths([patch.path], context.cwd);
            if (!normalizedPatchPath.ok) {
                return {
                    success: false,
                    errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH,
                    error: normalizedPatchPath.error,
                };
            }
            const normalizedDeclaredPath = normalizedPatchPath.normalizedPaths[0]!;
            if (!isScmPatchBoundToPath(normalizedDeclaredPath, patch.patch)) {
                return {
                    success: false,
                    errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                    error: `Patch content is not bound to declared path: ${normalizedDeclaredPath}`,
                };
            }
            normalizedPatchPathSet.add(normalizedDeclaredPath);
        }
    }

    const captured = await captureGitCommitTarget(context, request);
    if (!captured.success) return captured.response;
    const target = captured.target;
    const withPublication = (response: ScmCommitCreateResponse): ScmCommitCreateResponse => ({
        ...response,
        publication: response.publication ?? { state: 'not_published', expectedHeadOid: target.headOid, expectedRef: target.ref, indexReconciliation: 'not_required' },
    });
    if (request.expectedCandidateTreeOid !== undefined && (target.mergeHeads.length || target.cherryPickOid || target.stateFiles.some((file) => file.name === 'REVERT_HEAD' && file.content !== null))) {
        return withPublication({ success: false, errorCode: SCM_OPERATION_ERROR_CODES.BRANCH_OPERATION_IN_PROGRESS, error: 'Complete the current Git operation before applying a commit plan' });
    }
    const tempIndex = await createGitTemporaryIndex({
        cwd: context.cwd,
        seed: request.preparedTreeOid !== undefined ? { kind: 'tree', treeOid: request.preparedTreeOid } : request.scope?.kind === 'all-pending' || (!isAmend && !request.scope && !hasPatchSelection)
            ? 'current-index'
            : { kind: 'tree', treeOid: target.baseTreeOid },
    });
    if (!tempIndex.success) return withPublication(tempIndex);
    const temporaryIndex: GitTemporaryIndex = tempIndex.tempIndex;
    const gitEnv = temporaryIndex.env;
    let commitResponse: ScmCommitCreateResponse | undefined;
    const prepareAndPublish = async (): Promise<ScmCommitCreateResponse> => {
        if (request.scope?.kind === 'all-pending') {
            const stageAll = await runGitCommand({
                cwd: context.cwd,
                args: ['add', '-A'],
                timeoutMs: 10_000,
                env: gitEnv,
            });
            if (!stageAll.success) {
                return {
                    success: false,
                    errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                    error: stageAll.stderr || 'Failed to stage pending changes',
                };
            }
        }

        if (request.scope?.kind === 'paths') {
            const normalizedInclude = normalizePaths(request.scope.include, context.cwd);
            if (!normalizedInclude.ok) {
                return {
                    success: false,
                    errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH,
                    error: normalizedInclude.error,
                };
            }

            const normalizedExclude = request.scope.exclude && request.scope.exclude.length > 0
                ? normalizePaths(request.scope.exclude, context.cwd)
                : { ok: true as const, normalizedPaths: [] as string[] };
            if (!normalizedExclude.ok) {
                return {
                    success: false,
                    errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH,
                    error: normalizedExclude.error,
                };
            }

            const excludedSet = new Set(normalizedExclude.normalizedPaths);
            const effectiveScope = new Set(normalizedInclude.normalizedPaths.filter((path) => !excludedSet.has(path)));
            if (hasPatchSelection) {
                for (const path of normalizedPatchPathSet) {
                    effectiveScope.delete(path);
                }
            }
            if (effectiveScope.size === 0 && !hasPatchSelection) {
                return {
                    success: false,
                    errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                    error: 'Commit scope excludes all included paths',
                };
            }

            if (effectiveScope.size > 0) {
                const includeResult = await runGitCommand({
                    cwd: context.cwd,
                    args: ['add', '-A', '--', ...Array.from(effectiveScope, toLiteralPathspec)],
                    timeoutMs: 10_000,
                    env: gitEnv,
                });
                if (!includeResult.success) {
                    return {
                        success: false,
                        errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                        error: includeResult.stderr || 'Failed to stage scoped commit paths',
                    };
                }
            }
        }

        if (hasPatchSelection) {
            for (const patch of request.patches ?? []) {
                const patchResult = await applyPatchToIndex({
                    cwd: context.cwd,
                    patch: patch.patch,
                    env: gitEnv,
                });
                if (patchResult) {
                    return patchResult;
                }
            }
        }

        const hasIncludedChanges = await runGitCommand({
            cwd: context.cwd,
            args: ['diff', '--cached', '--quiet', target.baseTreeOid],
            timeoutMs: 5000,
            env: gitEnv,
        });
        if (!hasIncludedChanges.success && hasIncludedChanges.exitCode !== 1) {
            return {
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                error: hasIncludedChanges.stderr
                    ? `Failed to inspect included changes: ${hasIncludedChanges.stderr}`
                    : 'Failed to inspect included changes',
            };
        }
        if (hasIncludedChanges.exitCode === 0 && !isAmend && !target.mergeHeads.length) {
            return {
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.COMMIT_REQUIRED,
                error: 'No included changes to commit',
            };
        }

        return publishGitCommit({ context, request, target, index: temporaryIndex, message, gitFeatures: input.gitFeatures });
    };
    try {
        commitResponse = withPublication(await prepareAndPublish());
        return commitResponse;
    } finally {
        try { temporaryIndex.cleanup(); } catch (error) {
            const cleanupError = error instanceof Error ? error.message : String(error);
            if (commitResponse) {
                commitResponse.success = false;
                commitResponse.errorCode = SCM_OPERATION_ERROR_CODES.COMMAND_FAILED;
                commitResponse.error = [commitResponse.error, `Temporary commit index cleanup failed: ${cleanupError}`].filter(Boolean).join('\n');
                if (commitResponse.commitSha) commitResponse.outcome = { v: 1, kind: 'effect_applied_with_warning', errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, effect: { kind: 'commit', commitSha: commitResponse.commitSha }, nextActions: [{ kind: 'refresh' }] };
            } else return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, error: cleanupError,
                publication: { state: 'not_published', expectedHeadOid: target.headOid, expectedRef: target.ref, indexReconciliation: 'not_required' } };
        }
    }
}

export async function gitCommitBackout(input: {
    context: ScmBackendContext;
    request: ScmCommitBackoutRequest;
}): Promise<ScmCommitBackoutResponse> {
    const { context, request } = input;
    const snapshotResponse = await readGitSnapshotForChecks(context);
    if (!snapshotResponse.success || !snapshotResponse.snapshot) {
        return {
            success: false,
            errorCode: snapshotResponse.errorCode ?? SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
            error: snapshotResponse.error || 'Failed to evaluate repository state',
        };
    }

    const snapshot = snapshotResponse.snapshot;
    if (snapshot.branch.detached) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            error: 'Backout is unavailable while HEAD is detached',
        };
    }
    if (hasAnyIncludedOrPendingChanges(snapshot) || snapshot.hasConflicts) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE,
            error: 'Working tree must be clean before backout',
        };
    }

    const commitRef = normalizeCommitRef(request.commit);
    if (!commitRef.ok) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            error: commitRef.error,
        };
    }

    const parents = await runScmCommand({
        bin: 'git',
        cwd: context.cwd,
        args: ['rev-list', '--parents', '-n', '1', commitRef.commit],
        timeoutMs: 5000,
    });
    if (!parents.success) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
            error: parents.stderr || 'Failed to inspect commit parents',
        };
    }

    const parentTokens = parents.stdout.trim().split(/\s+/).filter((token) => token.length > 0);
    if (parentTokens.length > 2) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            error: 'Backout for merge commits is not supported yet.',
        };
    }

    const backout = await runScmCommand({
        bin: 'git',
        cwd: context.cwd,
        args: ['revert', '--no-edit', commitRef.commit],
        timeoutMs: 20_000,
    });
    let repositoryState;
    try {
        repositoryState = await readGitOperationRepositoryState(context);
    } catch {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
            error: 'Could not refresh repository state after backout',
            stdout: backout.stdout,
            stderr: backout.stderr,
            outcome: { v: 1, kind: 'outcome_unknown', errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, reconciliation: { kind: 'repository_status', cwd: context.cwd }, nextActions: [{ kind: 'refresh' }] },
        };
    }
    const indeterminateErrorCode = getScmCommandIndeterminateErrorCode(backout);
    if (indeterminateErrorCode && !repositoryState.hasConflicts) return { success: false, errorCode: indeterminateErrorCode, error: backout.stderr || 'Backout completion could not be determined', stdout: backout.stdout, stderr: backout.stderr, outcome: { v: 1, kind: 'outcome_unknown', errorCode: indeterminateErrorCode, repositoryState, reconciliation: { kind: 'repository_status', cwd: context.cwd }, nextActions: [{ kind: 'refresh' }] } };
    return backout.success
        ? { success: true, stdout: backout.stdout, stderr: backout.stderr, outcome: { v: 1, kind: 'succeeded', repositoryState, nextActions: [] } }
        : {
            success: false,
            errorCode: mapGitErrorCode(backout.stderr),
            error: backout.stderr || 'Failed to backout commit',
            stderr: backout.stderr,
            outcome: repositoryState.hasConflicts
                ? { v: 1, kind: 'conflicted', errorCode: SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE, repositoryState, nextActions: [{ kind: 'resolve_conflicts' }, { kind: 'abort' }] }
                : { v: 1, kind: 'failed', errorCode: mapGitErrorCode(backout.stderr), repositoryState, nextActions: [] },
        };
}
