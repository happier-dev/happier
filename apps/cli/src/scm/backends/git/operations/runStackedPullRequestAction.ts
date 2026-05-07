import {
    SCM_OPERATION_ERROR_CODES,
    parseScmUpstreamRef,
    type ScmBranchCreateRequest,
    type ScmBranchCreateResponse,
    type ScmCommitCreateRequest,
    type ScmCommitCreateResponse,
    type ScmOperationErrorCode,
    type ScmPullRequestOpenOrReuseRequest,
    type ScmPullRequestOpenOrReuseResponse,
    type ScmPullRequestRunStackedProgressEvent,
    type ScmPullRequestRunStackedRequest,
    type ScmPullRequestRunStackedResponse,
    type ScmPullRequestSummary,
    type ScmRemotePublishRequest,
    type ScmRemotePublishResponse,
    type ScmRemoteRequest,
    type ScmRemoteResponse,
    type ScmWorkingSnapshot,
} from '@happier-dev/protocol';

import type { ScmBackendContext } from '../../../types';

type BranchCreateOperation = (input: {
    context: ScmBackendContext;
    request: ScmBranchCreateRequest;
}) => Promise<ScmBranchCreateResponse>;

type CommitCreateOperation = (input: {
    context: ScmBackendContext;
    request: ScmCommitCreateRequest;
}) => Promise<ScmCommitCreateResponse>;

type RemotePushOperation = (input: {
    context: ScmBackendContext;
    request: ScmRemoteRequest;
}) => Promise<ScmRemoteResponse>;

type RemotePublishOperation = (input: {
    context: ScmBackendContext;
    request: ScmRemotePublishRequest;
}) => Promise<ScmRemotePublishResponse>;

type OpenOrReuseOperation = (input: {
    context: ScmBackendContext;
    request: ScmPullRequestOpenOrReuseRequest;
}) => Promise<ScmPullRequestOpenOrReuseResponse>;

export type RunStackedPullRequestActionDeps = Readonly<{
    readSnapshot(context: ScmBackendContext): Promise<ScmWorkingSnapshot | null>;
    branchCreate: BranchCreateOperation;
    commitCreate: CommitCreateOperation;
    remotePush: RemotePushOperation;
    remotePublish: RemotePublishOperation;
    openOrReuse: OpenOrReuseOperation;
    now?: () => number;
}>;

function normalizeOperationErrorCode(errorCode: string | undefined): ScmOperationErrorCode {
    const values = Object.values(SCM_OPERATION_ERROR_CODES);
    return values.includes(errorCode as ScmOperationErrorCode)
        ? errorCode as ScmOperationErrorCode
        : SCM_OPERATION_ERROR_CODES.COMMAND_FAILED;
}

function failure(
    error: string,
    errorCode: ScmOperationErrorCode = SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
    events: ScmPullRequestRunStackedProgressEvent[] = [],
    now?: () => number,
    phase?: ScmPullRequestRunStackedProgressEvent['phase'],
): ScmPullRequestRunStackedResponse {
    if (events && now) {
        createEvent(events, now, {
            kind: 'action_failed',
            ...(phase ? { phase } : {}),
            message: error,
        });
    }
    return {
        success: false,
        error,
        errorCode,
        events,
    };
}

function shouldCommit(action: ScmPullRequestRunStackedRequest['action']): boolean {
    return action === 'commit' || action === 'commitPush' || action === 'commitPushPr';
}

function shouldPush(input: Readonly<{
    action: ScmPullRequestRunStackedRequest['action'];
    snapshot: ScmWorkingSnapshot;
    activeBranch: string;
    didCreateFeatureBranch: boolean;
}>): boolean {
    if (input.action === 'push' || input.action === 'commitPush' || input.action === 'commitPushPr') {
        return true;
    }
    if (input.action !== 'createPr') {
        return false;
    }
    if (input.didCreateFeatureBranch) {
        return true;
    }
    if (!input.snapshot.branch.upstream) {
        return true;
    }
    return input.snapshot.branch.head === input.activeBranch && input.snapshot.branch.ahead > 0;
}

function shouldCreatePullRequest(action: ScmPullRequestRunStackedRequest['action']): boolean {
    return action === 'createPr' || action === 'commitPushPr';
}

function shouldPushViaConfiguredUpstream(input: Readonly<{
    action: ScmPullRequestRunStackedRequest['action'];
    snapshot: ScmWorkingSnapshot;
    activeBranch: string;
}>): boolean {
    const upstream = parseScmUpstreamRef(input.snapshot.branch.upstream);
    if (!upstream || input.snapshot.branch.head !== input.activeBranch) {
        return false;
    }
    if (input.action === 'createPr') {
        return upstream.branch === input.activeBranch;
    }
    return true;
}

function resolveBaseBranch(request: ScmPullRequestRunStackedRequest): string {
    const requested = request.base?.trim();
    if (requested) return requested;
    return 'main';
}

function createEvent(
    events: ScmPullRequestRunStackedProgressEvent[],
    now: () => number,
    event: Omit<ScmPullRequestRunStackedProgressEvent, 'timestamp'>,
): void {
    events.push({
        ...event,
        timestamp: now(),
    });
}

function resolveCommitScope(request: ScmPullRequestRunStackedRequest): ScmCommitCreateRequest['scope'] {
    return request.filePaths && request.filePaths.length > 0
        ? { kind: 'paths', include: [...request.filePaths] }
        : { kind: 'all-pending' };
}

export function createRunStackedPullRequestAction(deps: RunStackedPullRequestActionDeps) {
    const now = deps.now ?? Date.now;

    return async function runStacked(input: {
        context: ScmBackendContext;
        request: ScmPullRequestRunStackedRequest;
    }): Promise<ScmPullRequestRunStackedResponse> {
        const events: ScmPullRequestRunStackedProgressEvent[] = [];
        createEvent(events, now, {
            kind: 'action_started',
            message: input.request.action,
        });

        const snapshot = await deps.readSnapshot(input.context);
        if (!snapshot?.repo.isRepo || snapshot.branch.detached || !snapshot.branch.head) {
            return failure(
                'Pull request stacked actions require an active Git branch.',
                SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                events,
                now,
            );
        }

        const baseBranch = resolveBaseBranch(input.request);
        let activeBranch = snapshot.branch.head;
        const commitNeeded = shouldCommit(input.request.action);
        const prNeeded = shouldCreatePullRequest(input.request.action);
        let didCreateFeatureBranch = false;

        if (activeBranch === baseBranch) {
            const policy = snapshot.capabilities.defaultBranchPushPolicy ?? 'deny';
            if (policy === 'deny') {
                return failure(
                    'Pull request stacked actions cannot run from the default branch.',
                    SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                    events,
                    now,
                );
            }
            if (policy === 'requires-feature-branch') {
                const featureBranch = input.request.featureBranch?.trim();
                if (!featureBranch) {
                    return failure(
                        'Create or choose a feature branch before running this pull request action.',
                        SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                        events,
                        now,
                    );
                }
                createEvent(events, now, {
                    kind: 'phase_started',
                    phase: 'branch',
                    message: featureBranch,
                });
                const branch = await deps.branchCreate({
                    context: input.context,
                    request: {
                        cwd: input.request.cwd,
                        name: featureBranch,
                        checkout: true,
                        startPoint: activeBranch,
                    },
                });
                if (!branch.success) {
                    return failure(
                        branch.error || 'Feature branch creation failed.',
                        normalizeOperationErrorCode(branch.errorCode),
                        events,
                        now,
                        'branch',
                    );
                }
                activeBranch = featureBranch;
                didCreateFeatureBranch = true;
            }
        }

        let commitSha: string | null = null;
        if (commitNeeded) {
            const message = input.request.commitMessage?.trim();
            if (!message) {
                return failure(
                    'Commit message is required for stacked commit actions.',
                    SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                    events,
                    now,
                );
            }
            createEvent(events, now, {
                kind: 'phase_started',
                phase: 'commit',
                message,
            });
            const committed = await deps.commitCreate({
                context: input.context,
                request: {
                    cwd: input.request.cwd,
                    message,
                    scope: resolveCommitScope(input.request),
                },
            });
            if (!committed.success) {
                return failure(
                    committed.error || 'Commit failed.',
                    normalizeOperationErrorCode(committed.errorCode),
                    events,
                    now,
                    'commit',
                );
            }
            commitSha = committed.commitSha ?? null;
        }

        if (shouldPush({
            action: input.request.action,
            snapshot,
            activeBranch,
            didCreateFeatureBranch,
        })) {
            createEvent(events, now, {
                kind: 'phase_started',
                phase: 'push',
                message: activeBranch,
            });
            const upstream = parseScmUpstreamRef(snapshot.branch.upstream);
            const pushed = shouldPushViaConfiguredUpstream({
                action: input.request.action,
                snapshot,
                activeBranch,
            }) && upstream
                ? await deps.remotePush({
                    context: input.context,
                    request: {
                        cwd: input.request.cwd,
                        remote: upstream.remote,
                        branch: upstream.branch ?? activeBranch,
                    },
                })
                : await deps.remotePublish({
                    context: input.context,
                    request: {
                        cwd: input.request.cwd,
                        remote: snapshot.hostingProvider?.remoteName ?? undefined,
                    },
                });
            if (!pushed.success) {
                return failure(
                    pushed.error || 'Push failed.',
                    normalizeOperationErrorCode(pushed.errorCode),
                    events,
                    now,
                    'push',
                );
            }
        }

        let pullRequest: ScmPullRequestSummary | null = null;
        let composeUrl: string | undefined;
        if (prNeeded) {
            const title = input.request.title?.trim() || input.request.commitMessage?.trim();
            if (!title) {
                return failure(
                    'Pull request title is required.',
                    SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                    events,
                    now,
                );
            }
            createEvent(events, now, {
                kind: 'phase_started',
                phase: 'pr',
                message: title,
            });
            const opened = await deps.openOrReuse({
                context: input.context,
                request: {
                    cwd: input.request.cwd,
                    base: baseBranch,
                    head: activeBranch,
                    title,
                    body: input.request.body ?? '',
                },
            });
            if (!opened.success) {
                return failure(
                    opened.error || 'Pull request creation failed.',
                    normalizeOperationErrorCode(opened.errorCode),
                    events,
                    now,
                    'pr',
                );
            }
            if (opened.kind === 'opened') {
                pullRequest = opened.pullRequest;
            } else {
                composeUrl = opened.composeUrl;
            }
        }

        createEvent(events, now, {
            kind: 'action_finished',
            message: input.request.action,
        });

        return {
            success: true,
            branch: activeBranch,
            commitSha,
            pullRequest,
            ...(composeUrl ? { composeUrl } : {}),
            events,
        };
    };
}
