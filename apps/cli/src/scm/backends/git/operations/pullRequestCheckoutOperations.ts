import {
    SCM_OPERATION_ERROR_CODES,
    type ScmOperationErrorCode,
    type ScmPullRequestCheckoutRequest,
    type ScmPullRequestCheckoutResponse,
    type ScmPullRequestGetResponse,
    type ScmPullRequestPrepareWorktreeRequest,
    type ScmPullRequestPrepareWorktreeResponse,
    type ScmPullRequestSummary,
    type ScmWorkingSnapshot,
} from '@happier-dev/protocol';

import type { ScmBackendContext } from '../../../types';
import { createWorkspaceCheckoutWithSourceController } from '../../../sourceController/workspaceCheckoutOperations';
import { runScmCommand } from '../../../runtime';
import { buildScmNonInteractiveEnv } from '../../shared/nonInteractiveEnv';
import { mapGitErrorCode } from '../remote';
import { gitBranchCheckoutWithoutStash } from './branchOperations';
import { resolvePullRequestReferenceNumber } from './pullRequestReference';

type GitPullRequestCheckoutOperationDeps = Readonly<{
    readSnapshot(context: ScmBackendContext): Promise<ScmWorkingSnapshot | null>;
    getPullRequest(input: {
        context: ScmBackendContext;
        request: { cwd?: string; prReference: { number: number } };
    }): Promise<ScmPullRequestGetResponse>;
}>;

type PullRequestOperationFailure = Readonly<{
    success: false;
    error: string;
    errorCode: ScmOperationErrorCode;
}>;

type PullRequestTargetRef = Readonly<{
    ref: string;
    fetchRefspec?: string;
}>;

function failed(
    error: string,
    errorCode: ScmOperationErrorCode = SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
): PullRequestOperationFailure {
    return {
        success: false,
        errorCode,
        error,
    };
}

function resolveRemoteName(snapshot: ScmWorkingSnapshot): string {
    return snapshot.hostingProvider?.remoteName?.trim() || 'origin';
}

function inferBaseBranch(snapshot: ScmWorkingSnapshot): string {
    const upstream = snapshot.branch.upstream?.trim();
    if (!upstream) return 'main';
    const slashIndex = upstream.indexOf('/');
    if (slashIndex < 0 || slashIndex === upstream.length - 1) return upstream;
    return upstream.slice(slashIndex + 1);
}

function normalizeOperationErrorCode(errorCode: string | undefined): ScmOperationErrorCode {
    const values = Object.values(SCM_OPERATION_ERROR_CODES);
    return values.includes(errorCode as ScmOperationErrorCode)
        ? errorCode as ScmOperationErrorCode
        : SCM_OPERATION_ERROR_CODES.COMMAND_FAILED;
}

async function resolvePullRequest(input: {
    context: ScmBackendContext;
    request: ScmPullRequestCheckoutRequest | ScmPullRequestPrepareWorktreeRequest;
    snapshot: ScmWorkingSnapshot;
    getPullRequest: GitPullRequestCheckoutOperationDeps['getPullRequest'];
}): Promise<{ ok: true; pullRequest: ScmPullRequestSummary } | { ok: false; error: string; errorCode: ScmOperationErrorCode }> {
    const reference = input.request.prReference;
    if ('headBranch' in reference) {
        const headBranch = reference.headBranch.trim();
        if (!headBranch) {
            return {
                ok: false,
                error: 'Pull request head branch is required.',
                errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            };
        }
        const provider = input.snapshot.hostingProvider;
        if (!provider || !provider.nameWithOwner) {
            return {
                ok: false,
                error: 'A supported hosting provider is required for pull request checkout.',
                errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
            };
        }
        return {
            ok: true,
            pullRequest: {
                provider,
                number: null,
                title: headBranch,
                url: `${provider.baseUrl}/${provider.nameWithOwner}/tree/${encodeURIComponent(headBranch)}`,
                baseBranch: inferBaseBranch(input.snapshot),
                headBranch,
                state: 'unknown',
            },
        };
    }

    const number = resolvePullRequestReferenceNumber(reference);
    if (number == null) {
        return {
            ok: false,
            error: 'Pull request URL references are only supported for GitHub-style /pull/<number> URLs.',
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
        };
    }

    const response = await input.getPullRequest({
        context: input.context,
        request: {
            cwd: input.request.cwd,
            prReference: { number },
        },
    });
    if (!response.success) {
        return {
            ok: false,
            error: response.error,
            errorCode: normalizeOperationErrorCode(response.errorCode),
        };
    }
    if (!response.pullRequest) {
        return {
            ok: false,
            error: 'Pull request was not found.',
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
        };
    }
    return {
        ok: true,
        pullRequest: response.pullRequest,
    };
}

async function readCommitSha(cwd: string, ref: string): Promise<string | null> {
    if (!ref.trim() || ref.trim().startsWith('-')) return null;
    const result = await runScmCommand({
        bin: 'git',
        cwd,
        args: ['rev-parse', '--verify', `${ref}^{commit}`],
        timeoutMs: 10_000,
        env: buildScmNonInteractiveEnv(),
    });
    return result.success ? result.stdout.trim() || null : null;
}

async function readCurrentBranch(cwd: string): Promise<string | null> {
    const result = await runScmCommand({
        bin: 'git',
        cwd,
        args: ['rev-parse', '--abbrev-ref', 'HEAD'],
        timeoutMs: 10_000,
        env: buildScmNonInteractiveEnv(),
    });
    if (!result.success) return null;
    const branch = result.stdout.trim();
    return branch && branch !== 'HEAD' ? branch : null;
}

async function fetchPullRequestRemote(input: {
    context: ScmBackendContext;
    remoteName: string;
    cwd?: string;
    refspec?: string;
}): Promise<{ ok: true } | { ok: false; error: string; errorCode: ScmOperationErrorCode }> {
    const args = ['fetch', '--prune', input.remoteName];
    if (input.refspec) {
        args.push(input.refspec);
    }
    const response = await runScmCommand({
        bin: 'git',
        cwd: input.cwd ?? input.context.cwd,
        args,
        timeoutMs: 30_000,
        env: buildScmNonInteractiveEnv(),
    });
    return response.success
        ? { ok: true }
        : {
            ok: false,
            error: response.stderr || 'Fetch failed.',
            errorCode: mapGitErrorCode(response.stderr),
        };
}

function resolvePullRequestTargetRef(input: {
    remoteName: string;
    pullRequest: ScmPullRequestSummary;
}): PullRequestTargetRef {
    if (input.pullRequest.number != null) {
        if (input.pullRequest.provider.kind === 'github') {
            const ref = `refs/remotes/${input.remoteName}/pull/${input.pullRequest.number}/head`;
            return {
                ref,
                fetchRefspec: `refs/pull/${input.pullRequest.number}/head:${ref}`,
            };
        }
        if (input.pullRequest.provider.kind === 'gitlab') {
            const ref = `refs/remotes/${input.remoteName}/merge-requests/${input.pullRequest.number}/head`;
            return {
                ref,
                fetchRefspec: `refs/merge-requests/${input.pullRequest.number}/head:${ref}`,
            };
        }
    }

    return {
        ref: `${input.remoteName}/${input.pullRequest.headBranch}`,
    };
}

async function assertLocalBranchMatchesTarget(input: {
    cwd: string;
    branchName: string;
    targetSha: string;
}): Promise<{ ok: true } | { ok: false; error: string; errorCode: ScmOperationErrorCode }> {
    const localHeadSha = await readCommitSha(input.cwd, input.branchName);
    if (!localHeadSha || localHeadSha === input.targetSha) {
        return { ok: true };
    }
    return {
        ok: false,
        error: `Local branch "${input.branchName}" already exists and does not match the requested pull request tip.`,
        errorCode: SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE,
    };
}

export function createGitPullRequestCheckoutOperations(deps: GitPullRequestCheckoutOperationDeps) {
    async function checkout(input: {
        context: ScmBackendContext;
        request: ScmPullRequestCheckoutRequest;
    }): Promise<ScmPullRequestCheckoutResponse> {
        const snapshot = await deps.readSnapshot(input.context);
        if (!snapshot?.hostingProvider) {
            return failed(
                'A supported hosting provider is required for pull request checkout.',
                SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
            );
        }

        const resolved = await resolvePullRequest({
            context: input.context,
            request: input.request,
            snapshot,
            getPullRequest: deps.getPullRequest,
        });
        if (!resolved.ok) {
            return failed(resolved.error, resolved.errorCode);
        }

        const remoteName = resolveRemoteName(snapshot);
        const fetched = await fetchPullRequestRemote({
            context: input.context,
            remoteName,
            refspec: resolvePullRequestTargetRef({
                remoteName,
                pullRequest: resolved.pullRequest,
            }).fetchRefspec,
        });
        if (!fetched.ok) {
            return failed(fetched.error, fetched.errorCode);
        }

        const targetRef = resolvePullRequestTargetRef({
            remoteName,
            pullRequest: resolved.pullRequest,
        });
        const headSha = await readCommitSha(input.context.cwd, targetRef.ref);
        if (!headSha) {
            return failed(
                `Remote pull request branch was not found: ${targetRef.ref}`,
                SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            );
        }

        const localBranchMatch = await assertLocalBranchMatchesTarget({
            cwd: input.context.cwd,
            branchName: resolved.pullRequest.headBranch,
            targetSha: headSha,
        });
        if (!localBranchMatch.ok) {
            return failed(localBranchMatch.error, localBranchMatch.errorCode);
        }

        const switched = await gitBranchCheckoutWithoutStash({
            context: input.context,
            name: resolved.pullRequest.headBranch,
            startPoint: targetRef.ref,
        });
        if (!switched.success) {
            return failed(
                switched.error || 'Branch checkout failed',
                switched.errorCode ?? mapGitErrorCode(switched.stderr ?? switched.error ?? ''),
            );
        }

        return {
            success: true,
            branch: resolved.pullRequest.headBranch,
            headSha,
            baseSha: null,
        };
    }

    async function prepareWorktree(input: {
        context: ScmBackendContext;
        request: ScmPullRequestPrepareWorktreeRequest;
    }): Promise<ScmPullRequestPrepareWorktreeResponse> {
        const sourcePath = input.request.sourcePath || input.context.cwd;
        if (input.request.mode === 'local') {
            const local = await checkout({
                context: input.context,
                request: {
                    cwd: input.request.cwd,
                    prReference: input.request.prReference,
                },
            });
            return local.success
                ? {
                    success: true,
                    targetPath: input.context.cwd,
                    branch: local.branch,
                    head: local.headSha,
                }
                : local;
        }

        const sourceContext = {
            ...input.context,
            cwd: sourcePath,
        };
        const snapshot = await deps.readSnapshot(sourceContext);
        if (!snapshot?.hostingProvider) {
            return failed(
                'A supported hosting provider is required for pull request worktree preparation.',
                SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
            );
        }

        const resolved = await resolvePullRequest({
            context: sourceContext,
            request: input.request,
            snapshot,
            getPullRequest: deps.getPullRequest,
        });
        if (!resolved.ok) {
            return failed(
                resolved.error,
                resolved.errorCode,
            );
        }

        const remoteName = resolveRemoteName(snapshot);
        const fetched = await fetchPullRequestRemote({
            context: sourceContext,
            remoteName,
            cwd: sourcePath,
            refspec: resolvePullRequestTargetRef({
                remoteName,
                pullRequest: resolved.pullRequest,
            }).fetchRefspec,
        });
        if (!fetched.ok) {
            return failed(fetched.error, fetched.errorCode);
        }

        const targetRef = resolvePullRequestTargetRef({
            remoteName,
            pullRequest: resolved.pullRequest,
        });
        const headSha = await readCommitSha(sourcePath, targetRef.ref);
        if (!headSha) {
            return failed(
                `Remote pull request branch was not found: ${targetRef.ref}`,
                SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            );
        }

        const created = await createWorkspaceCheckoutWithSourceController({
            sourcePath,
            checkoutCreation: {
                kind: 'git_worktree',
                displayName: resolved.pullRequest.headBranch,
                baseRef: targetRef.ref,
            },
        });
        if (!created) {
            return failed(
                'The selected source-control backend does not support pull request worktree preparation.',
                SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
            );
        }

        return {
            success: true,
            targetPath: created.targetPath,
            branch: await readCurrentBranch(created.targetPath) ?? resolved.pullRequest.headBranch,
            head: headSha,
        };
    }

    return {
        checkout,
        prepareWorktree,
    };
}
