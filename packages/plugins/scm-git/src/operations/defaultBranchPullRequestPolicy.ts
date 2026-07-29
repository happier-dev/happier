import {
  SCM_OPERATION_ERROR_CODES,
  type ScmDefaultBranchPushPolicy,
  type ScmOperationErrorCode,
} from '@happier-dev/plugin-sdk/experimental/scm';

export type DefaultBranchPullRequestAction =
    | Readonly<{
        kind: 'create_feature_branch';
        baseBranch: string;
        currentBranch: string;
    }>
    | Readonly<{
        kind: 'create_feature_branch_and_open_pr';
        baseBranch: string;
        currentBranch: string;
        ahead: number;
    }>;

export type DefaultBranchPullRequestPolicyResult =
    | Readonly<{ kind: 'proceed' }>
    | Readonly<{
        kind: 'blocked';
        errorCode: ScmOperationErrorCode;
        reason: 'missing_branch' | 'base_to_base' | 'feature_branch_required' | 'default_branch_denied';
        action?: DefaultBranchPullRequestAction;
    }>;

export function evaluateDefaultBranchPullRequestPolicy(input: Readonly<{
    policy: ScmDefaultBranchPushPolicy;
    currentBranch: string | null;
    baseBranch: string;
    branchAhead: number;
    requestedHeadBranch?: string | null;
}>): DefaultBranchPullRequestPolicyResult {
    const currentBranch = input.currentBranch?.trim() || null;
    const baseBranch = input.baseBranch.trim();
    const requestedHeadBranch = input.requestedHeadBranch?.trim() || null;
    if (!currentBranch) {
        return {
            kind: 'blocked',
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            reason: 'missing_branch',
        };
    }
    if (requestedHeadBranch && requestedHeadBranch !== baseBranch) {
        return { kind: 'proceed' };
    }
    if (currentBranch !== baseBranch) {
        return { kind: 'proceed' };
    }
    if (input.policy === 'requires-feature-branch') {
        const ahead = Math.max(0, Math.trunc(input.branchAhead));
        return {
            kind: 'blocked',
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            reason: 'feature_branch_required',
            action: ahead > 0
                ? {
                    kind: 'create_feature_branch_and_open_pr',
                    baseBranch,
                    currentBranch,
                    ahead,
                }
                : {
                    kind: 'create_feature_branch',
                    baseBranch,
                    currentBranch,
                },
        };
    }
    return {
        kind: 'blocked',
        errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
        reason: input.policy === 'deny' ? 'default_branch_denied' : 'base_to_base',
    };
}
