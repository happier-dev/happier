import { createScmOperationUnknownOutcome, normalizeScmOperationOutcome, type ScmPullRequestOpenOrReuseRequest, type ScmPullRequestOpenOrReuseResponse } from '@happier-dev/protocol/scm';

import type { ScmProjectOperationKind, ScmProjectOperationLogEntry, BeginScmProjectOperationResult } from '@/sync/runtime/orchestration/projectManager';
import { withSessionProjectScmOperationLock } from '@/scm/operations/withOperationLock';
import { reportSessionScmOperation } from '@/scm/operations/reporting';
import { selectScmCreatePrResult } from '@/scm/pullRequests/selectScmCreatePrResult';
import { sessionScmPullRequestOpenOrReuse } from '@/sync/ops/sessionScm';

import type { GitPullRequestCreateOutcome } from './gitPullRequestFormState';

type GitPullRequestOperationState = Readonly<{
    beginSessionProjectScmOperation: (sessionId: string, operation: ScmProjectOperationKind, serverId?: string) => BeginScmProjectOperationResult;
    finishSessionProjectScmOperation: (sessionId: string, operationId: string, serverId?: string) => boolean;
    updateSessionProjectScmOperationProgress: (sessionId: string, operationId: string, progressText?: string, serverId?: string) => boolean;
    appendSessionProjectScmOperation: (sessionId: string, entry: Omit<ScmProjectOperationLogEntry, 'id' | 'sessionId'>, serverId?: string) => void;
}>;

/**
 * Creates the session's pull request from the form (title, body, base, draft) through the one PR RPC, inside the
 * project SCM operation lock, and records the result in the operation log the pane's outcome line reads. A draft is
 * asked for only when the daemon advertises draft creation; an older daemon would silently open a regular PR.
 */
export async function createSessionGitPullRequest(input: Readonly<{
    state: GitPullRequestOperationState;
    sessionId: string;
    serverId?: string;
    machineReachable: boolean;
    draftSupported: boolean;
    request: Readonly<{ base: string; head: string; title: string; body: string; draft: boolean }>;
}>): Promise<GitPullRequestCreateOutcome> {
    const title = input.request.title.trim();
    const request: ScmPullRequestOpenOrReuseRequest = {
        base: input.request.base,
        head: input.request.head,
        ...(title ? { title } : {}),
        body: input.request.body,
        ...(input.draftSupported && input.request.draft ? { draft: true } : {}),
    };
    const lock = await withSessionProjectScmOperationLock({
        state: input.state,
        sessionId: input.sessionId,
        ...(input.serverId === undefined ? {} : { serverId: input.serverId }),
        operation: 'create_pr',
        run: async (): Promise<GitPullRequestCreateOutcome> => {
            let response: ScmPullRequestOpenOrReuseResponse;
            try {
                response = await sessionScmPullRequestOpenOrReuse(input.sessionId, request, input.serverId);
            } catch (error) {
                response = { success: false, error: error instanceof Error ? error.message : String(error ?? ''), outcome: createScmOperationUnknownOutcome({ kind: 'pull_request', head: request.head ?? input.request.head, base: request.base }) };
            }
            const outcome = selectScmCreatePrResult(response, input.machineReachable);
            const terminalOutcome = outcome.outcome ?? normalizeScmOperationOutcome(response);
            reportSessionScmOperation({
                state: input.state,
                sessionId: input.sessionId,
                ...(input.serverId === undefined ? {} : { serverId: input.serverId }),
                operation: 'create_pr',
                status: terminalOutcome.kind === 'succeeded' ? 'success' : 'failed',
                outcome: terminalOutcome,
                surface: 'update',
                detail: outcome.kind === 'failed' ? outcome.message : outcome.url,
                ...(outcome.kind === 'failed' ? { rawError: outcome.message } : {}),
                ...(!response.success && response.errorCode ? { errorCode: response.errorCode } : {}),
                tracking: null,
            });
            return outcome;
        },
    });
    return lock.started ? lock.value : { kind: 'blocked', message: lock.message };
}
