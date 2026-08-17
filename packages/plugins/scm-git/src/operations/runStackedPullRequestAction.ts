import type {
  ScmBranchCreateRequest,
  ScmBranchCreateResponse,
  ScmCommitCreateRequest,
  ScmCommitCreateResponse,
  ScmOperationErrorCode,
  ScmPullRequestOpenOrReuseRequest,
  ScmPullRequestOpenOrReuseResponse,
  ScmPullRequestRunStackedRequest,
  ScmPullRequestRunStackedPhase,
  ScmPullRequestRunStackedProgressEvent,
  ScmPullRequestRunStackedResponse,
  ScmRemoteRequest,
  ScmRemotePublishResponse,
  ScmRemoteResponse,
  ScmWorkingSnapshot,
} from '@happier-dev/plugin-sdk/scm';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/plugin-sdk/scm';

import type { ScmBackendContext } from '../types.js';
import { getGitSnapshot } from '../repository.js';
import { gitBranchCreate } from './branchOperations.js';
import { gitCommitCreate } from './commitOperations.js';
import { gitRemotePublish } from './publishOperations.js';
import { gitRemotePush } from './remoteOperations.js';
import { gitPullRequestOpenOrReuse } from './pullRequestOpenOrReuseOperation.js';
import { resolvePullRequestBranchPublishPlan } from './pullRequestBranchPublishSafety.js';
import { evaluateDefaultBranchPullRequestPolicy } from './defaultBranchPullRequestPolicy.js';

export type GitRunStackedPullRequestAction = Readonly<{
    runStacked(input: Readonly<{
        context: ScmBackendContext;
        request: ScmPullRequestRunStackedRequest;
    }>): Promise<ScmPullRequestRunStackedResponse>;
}>;

type GitRunStackedPullRequestActionDeps = Readonly<{
    branchCreate?: (input: Readonly<{
        context: ScmBackendContext;
        request: ScmBranchCreateRequest;
    }>) => Promise<ScmBranchCreateResponse>;
    commitCreate?: (input: Readonly<{
        context: ScmBackendContext;
        request: ScmCommitCreateRequest;
    }>) => Promise<ScmCommitCreateResponse>;
    remotePush?: (input: Readonly<{
        context: ScmBackendContext;
        request: ScmRemoteRequest;
    }>) => Promise<ScmRemoteResponse>;
    pullRequestOpenOrReuse?: (input: Readonly<{
        context: ScmBackendContext;
        request: ScmPullRequestOpenOrReuseRequest;
    }>) => Promise<ScmPullRequestOpenOrReuseResponse>;
    readSnapshot?: (input: Readonly<{ context: ScmBackendContext }>) => Promise<ScmWorkingSnapshot | null>;
    publishActiveBranch?: (input: Readonly<{
        context: ScmBackendContext;
        request: { cwd?: string };
        headBranch: string;
        reason: 'missing_upstream' | 'upstream_points_at_base';
    }>) => Promise<Readonly<{
        success: boolean;
        error?: string;
        errorCode?: ScmOperationErrorCode;
    }>>;
    now?: () => number;
}>;

type ProgressEventInput = Readonly<{
    kind: ScmPullRequestRunStackedProgressEvent['kind'];
    phase?: ScmPullRequestRunStackedPhase;
    message?: string;
    output?: string;
}>;

function phasesForAction(action: ScmPullRequestRunStackedRequest['action']): readonly ScmPullRequestRunStackedPhase[] {
    switch (action) {
        case 'commit':
            return ['commit'];
        case 'push':
            return ['push'];
        case 'openOrReuse':
            return ['pr'];
        case 'commitAndPush':
            return ['commit', 'push'];
        case 'pushAndOpenOrReuse':
            return ['push', 'pr'];
        case 'commitPushAndOpenOrReuse':
            return ['commit', 'push', 'pr'];
    }
}

function errorResponse(input: Readonly<{
    error: string;
    errorCode?: ScmOperationErrorCode;
    events: readonly ScmPullRequestRunStackedProgressEvent[];
}>): ScmPullRequestRunStackedResponse {
    return {
        success: false,
        error: input.error,
        ...(input.errorCode ? { errorCode: input.errorCode } : {}),
        events: [...input.events],
    };
}

export function createGitRunStackedPullRequestAction(
    deps?: GitRunStackedPullRequestActionDeps,
): GitRunStackedPullRequestAction {
    const branchCreate = deps?.branchCreate ?? gitBranchCreate;
    const commitCreate = deps?.commitCreate ?? gitCommitCreate;
    const remotePush = deps?.remotePush ?? gitRemotePush;
    const pullRequestOpenOrReuse = deps?.pullRequestOpenOrReuse ?? gitPullRequestOpenOrReuse;
    const readSnapshot = deps?.readSnapshot ?? (async ({ context }) => {
        const response = await getGitSnapshot({ context });
        return response.success ? response.snapshot ?? null : null;
    });
    const publishActiveBranch = deps?.publishActiveBranch ?? (async (
        input: Readonly<{
            context: ScmBackendContext;
            request: { cwd?: string };
        }>,
    ): Promise<ScmRemotePublishResponse> => gitRemotePublish(input));
    const now = deps?.now ?? Date.now;

    return Object.freeze({
        async runStacked({ context, request }) {
            const events: ScmPullRequestRunStackedProgressEvent[] = [];
            const append = (event: ProgressEventInput) => {
                events.push({ ...event, timestamp: now() });
            };
            append({ kind: 'action_started' });

            let commitSha: string | null = null;
            let openOrReuseResponse: ScmPullRequestOpenOrReuseResponse | null = null;
            const requestedBaseBranch = request.base?.trim() || null;
            const requestedFeatureBranch = request.featureBranch?.trim() || null;
            const requestHeadBranch = request.head?.trim() || null;
            if (requestedFeatureBranch && requestHeadBranch && requestedFeatureBranch !== requestHeadBranch) {
                const message = 'Requested feature branch must match the pull request head branch';
                append({ kind: 'action_failed', message });
                return errorResponse({
                    error: message,
                    errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                    events,
                });
            }
            const requestedHeadBranch = requestedFeatureBranch ?? requestHeadBranch;
            let effectiveHeadBranch = requestedHeadBranch;
            const workflowPhases = phasesForAction(request.action);
            const mutatesCurrentBranch = workflowPhases.includes('commit');
            if (requestedBaseBranch && requestedHeadBranch && requestedBaseBranch === requestedHeadBranch) {
                const message = 'Create a feature branch before opening a pull request from the default branch';
                append({ kind: 'action_failed', message });
                return errorResponse({
                    error: message,
                    errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                    events,
                });
            }
            const preflightSnapshot = (requestedBaseBranch || (requestedFeatureBranch && mutatesCurrentBranch))
                && workflowPhases.some((phase) => phase === 'commit' || phase === 'push' || phase === 'pr')
                ? await readSnapshot({ context })
                : null;
            const canCreateRequestedFeatureBranch =
                requestedBaseBranch
                && requestedFeatureBranch
                && preflightSnapshot?.branch.head === requestedBaseBranch
                && (
                    request.defaultBranchPushPolicy
                    ?? preflightSnapshot.capabilities.defaultBranchPushPolicy
                ) === 'requires-feature-branch';
            if (canCreateRequestedFeatureBranch) {
                append({ kind: 'phase_started', phase: 'branch', message: requestedFeatureBranch });
                const branch = await branchCreate({
                    context,
                    request: {
                        ...(request.cwd ? { cwd: request.cwd } : {}),
                        name: requestedFeatureBranch,
                        checkout: true,
                        startPoint: requestedBaseBranch,
                    },
                });
                if (!branch.success) {
                    append({ kind: 'action_failed', phase: 'branch', message: branch.error });
                    return errorResponse({
                        error: branch.error ?? 'Feature branch creation failed',
                        errorCode: branch.errorCode,
                        events,
                    });
                }
                effectiveHeadBranch = requestedFeatureBranch;
                append({ kind: 'phase_finished', phase: 'branch' });
            }
            if (
                mutatesCurrentBranch
                && requestedFeatureBranch
                && !canCreateRequestedFeatureBranch
                && preflightSnapshot?.branch.head !== requestedFeatureBranch
            ) {
                const message = 'Checkout the requested feature branch before committing pull request changes';
                append({ kind: 'action_failed', message });
                return errorResponse({
                    error: message,
                    errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                    events,
                });
            }
            const preflightDefaultBranchPolicy = preflightSnapshot?.branch.head && requestedBaseBranch
                ? evaluateDefaultBranchPullRequestPolicy({
                    policy: request.defaultBranchPushPolicy ?? preflightSnapshot.capabilities.defaultBranchPushPolicy ?? 'deny',
                    currentBranch: preflightSnapshot.branch.head,
                    baseBranch: requestedBaseBranch,
                    branchAhead: preflightSnapshot.branch.ahead,
                    requestedHeadBranch: effectiveHeadBranch,
                })
                : null;
            if (preflightDefaultBranchPolicy?.kind === 'blocked') {
                const message = 'Create a feature branch before opening a pull request from the default branch';
                append({ kind: 'action_failed', message });
                return errorResponse({
                    error: message,
                    errorCode: preflightDefaultBranchPolicy.errorCode,
                    events,
                });
            }

            for (const phase of workflowPhases) {
                append({ kind: 'phase_started', phase });
                if (phase === 'commit') {
                    const commit = await commitCreate({
                        context,
                        request: {
                            ...(request.cwd ? { cwd: request.cwd } : {}),
                            message: request.commitMessage ?? request.title ?? 'Update source-control changes',
                            ...(request.filePaths?.length ? { scope: { kind: 'paths', include: request.filePaths } } : {}),
                        },
                    });
                    if (!commit.success) {
                        append({ kind: 'action_failed', phase, message: commit.error });
                        return errorResponse({
                            error: commit.error ?? 'Commit failed',
                            errorCode: commit.errorCode,
                            events,
                        });
                    }
                    commitSha = commit.commitSha ?? null;
                    append({ kind: 'phase_finished', phase });
                    continue;
                }

                if (phase === 'push') {
                    const baseBranch = request.base;
                    const headBranch = effectiveHeadBranch;
                    const pushRequest = {
                        ...(request.cwd ? { cwd: request.cwd } : {}),
                        ...(headBranch ? { branch: headBranch } : {}),
                    };
                    const snapshot = preflightSnapshot ?? (!baseBranch
                        ? null
                        : await readSnapshot({ context }));
                    const defaultBranchPolicy = !preflightDefaultBranchPolicy && snapshot?.branch.head && baseBranch
                        ? evaluateDefaultBranchPullRequestPolicy({
                            policy: request.defaultBranchPushPolicy ?? snapshot.capabilities.defaultBranchPushPolicy ?? 'deny',
                            currentBranch: snapshot.branch.head,
                            baseBranch,
                            branchAhead: snapshot.branch.ahead,
                            requestedHeadBranch: headBranch,
                        })
                        : null;
                    if (defaultBranchPolicy?.kind === 'blocked') {
                        const message = 'Create a feature branch before pushing changes for a pull request from the default branch';
                        append({ kind: 'action_failed', phase, message });
                        return errorResponse({
                            error: message,
                            errorCode: defaultBranchPolicy.errorCode,
                            events,
                        });
                    }
                    const publishPlan = canCreateRequestedFeatureBranch && requestedFeatureBranch
                        ? {
                            kind: 'publish_active_branch' as const,
                            branch: requestedFeatureBranch,
                            reason: 'missing_upstream' as const,
                        }
                        : !headBranch && snapshot?.branch.head && !snapshot.branch.detached && baseBranch
                        ? resolvePullRequestBranchPublishPlan({
                            activeBranch: snapshot.branch.head,
                            baseBranch,
                            upstream: snapshot.branch.upstream,
                        })
                        : null;
                    const push = publishPlan?.kind === 'publish_active_branch'
                        ? await publishActiveBranch({
                            context,
                            request: {
                                ...(request.cwd ? { cwd: request.cwd } : {}),
                            },
                            headBranch: publishPlan.branch,
                            reason: publishPlan.reason,
                        })
                        : await remotePush({
                            context,
                            request: pushRequest,
                        });
                    if (!push.success) {
                        append({ kind: 'action_failed', phase, message: push.error });
                        return errorResponse({
                            error: push.error ?? 'Push failed',
                            errorCode: push.errorCode,
                            events,
                        });
                    }
                    append({ kind: 'phase_finished', phase });
                    continue;
                }

                if (!request.base) {
                    append({ kind: 'action_failed', phase, message: 'Base branch is required before opening a pull request' });
                    return errorResponse({
                        error: 'Base branch is required before opening a pull request',
                        errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                        events,
                    });
                }

                const opened = await pullRequestOpenOrReuse({
                    context,
                    request: {
                        ...(request.cwd ? { cwd: request.cwd } : {}),
                        base: request.base,
                        ...(effectiveHeadBranch ? { head: effectiveHeadBranch } : {}),
                        ...(request.title ? { title: request.title } : {}),
                        ...(request.body !== undefined ? { body: request.body } : {}),
                        ...(request.defaultBranchPushPolicy ? { defaultBranchPushPolicy: request.defaultBranchPushPolicy } : {}),
                    },
                });
                if (!opened.success) {
                    append({ kind: 'action_failed', phase, message: opened.error });
                    return errorResponse({
                        error: opened.error ?? 'Pull request open-or-reuse failed',
                        errorCode: opened.errorCode,
                        events,
                    });
                }
                openOrReuseResponse = opened;
                append({ kind: 'phase_finished', phase });
            }

            append({ kind: 'action_finished' });
            return {
                success: true,
                ...(openOrReuseResponse?.pullRequest !== undefined ? { pullRequest: openOrReuseResponse.pullRequest } : {}),
                ...(openOrReuseResponse?.composeUrl ? { composeUrl: openOrReuseResponse.composeUrl } : {}),
                branch: effectiveHeadBranch,
                commitSha,
                nextAction: openOrReuseResponse?.nextAction ?? { kind: 'none' },
                events,
            };
        },
    });
}

const gitRunStackedPullRequestAction = createGitRunStackedPullRequestAction();

export const gitPullRequestRunStacked = gitRunStackedPullRequestAction.runStacked;
