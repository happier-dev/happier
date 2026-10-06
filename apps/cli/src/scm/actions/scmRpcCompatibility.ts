import { ScmRepositoryCloneInputSchema } from '@happier-dev/protocol/scm/repositoryClone';
import { ScmRequestBaseSchema } from '@happier-dev/protocol/scm/requestBase';

// Clone's public Action input is strictly domain-only. Machine/session RPC
// transports also carry validated SCM envelope fields; consume them only here.
const ScmRepositoryCloneRpcRequestSchema = ScmRepositoryCloneInputSchema
    .extend(ScmRequestBaseSchema.shape)
    .transform(({ cwd: _cwd, backendPreference: _backendPreference, outcomeVersion: _outcomeVersion, ...request }) => request);

export function parseScmRepositoryCloneRpcRequest(input: unknown) {
    return ScmRepositoryCloneRpcRequestSchema.safeParse(input);
}

/**
 * Wire-only projection for ../0.2 HEAD 17ba05df68d4d3d4cad1c1241b58e63805db37ed.
 * Remove when that predecessor is no longer supported. Domain outcomes remain current.
 */
export function projectScmLegacyRpcResponse(args: Readonly<{
    actionId: string;
    request: unknown;
    response: unknown;
}>): unknown {
    const { request, response } = args;
    if (request && typeof request === 'object' && 'outcomeVersion' in request && request.outcomeVersion === 1) return response;
    if (!response || typeof response !== 'object' || Array.isArray(response)) return response;
    const current = response as Readonly<Record<string, unknown>>;
    const errorCode = current.errorCode;
    const state = current.operationState;
    const legacyCode = typeof errorCode === 'string' && !LEGACY_SCM_RPC_ERROR_CODES.has(errorCode) ? 'COMMAND_FAILED' : errorCode;
    const legacyState = state && typeof state === 'object' && 'kind' in state && state.kind !== 'merge' && state.kind !== 'rebase' ? null : state;
    // scmWorktrees.ts in the pinned predecessor requires these strings even
    // for failure. They are wire placeholders, never canonical identities.
    const legacyWorktreeFailure = args.actionId === 'scm.worktree.create' && current.success === false;
    if (legacyCode === errorCode && legacyState === state && !legacyWorktreeFailure) return response;
    return {
        ...current,
        ...(legacyCode !== errorCode ? { errorCode: legacyCode } : {}),
        ...(legacyState !== state ? { operationState: legacyState } : {}),
        ...(legacyWorktreeFailure ? { worktreePath: '', branchName: '' } : {}),
    };
}

const LEGACY_SCM_RPC_ERROR_CODES: ReadonlySet<string> = new Set([
    'NOT_REPOSITORY', 'INVALID_PATH', 'INVALID_REQUEST', 'COMMAND_FAILED', 'CHANGE_APPLY_FAILED',
    'COMMIT_REQUIRED', 'CONFLICTING_WORKTREE', 'REMOTE_AUTH_REQUIRED', 'REMOTE_UPSTREAM_REQUIRED',
    'REMOTE_NON_FAST_FORWARD', 'REMOTE_FF_ONLY_REQUIRED', 'REMOTE_REJECTED', 'REMOTE_NOT_FOUND',
    'REMOTE_ALREADY_EXISTS', 'BRANCH_OPERATION_IN_PROGRESS', 'BRANCH_OPERATION_NOT_IN_PROGRESS',
    'FEATURE_UNSUPPORTED', 'BACKEND_UNAVAILABLE',
]);
