import { describe, expect, it } from 'vitest';

import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/plugin-sdk/scm';

import { evaluateDefaultBranchPullRequestPolicy } from './defaultBranchPullRequestPolicy.js';

describe('evaluateDefaultBranchPullRequestPolicy', () => {
    it('allows feature branches to open pull requests into the base branch', () => {
        expect(evaluateDefaultBranchPullRequestPolicy({
            policy: 'deny',
            currentBranch: 'feature/scm-pr-6',
            baseBranch: 'main',
            branchAhead: 1,
        })).toEqual({ kind: 'proceed' });
    });

    it('returns a create_feature_branch action for clean default-branch attempts', () => {
        expect(evaluateDefaultBranchPullRequestPolicy({
            policy: 'requires-feature-branch',
            currentBranch: 'main',
            baseBranch: 'main',
            branchAhead: 0,
        })).toEqual({
            kind: 'blocked',
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            reason: 'feature_branch_required',
            action: {
                kind: 'create_feature_branch',
                baseBranch: 'main',
                currentBranch: 'main',
            },
        });
    });

    it('returns a create_feature_branch_and_open_pr action for ahead default-branch attempts', () => {
        expect(evaluateDefaultBranchPullRequestPolicy({
            policy: 'requires-feature-branch',
            currentBranch: 'main',
            baseBranch: 'main',
            branchAhead: 2,
        })).toEqual({
            kind: 'blocked',
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            reason: 'feature_branch_required',
            action: {
                kind: 'create_feature_branch_and_open_pr',
                baseBranch: 'main',
                currentBranch: 'main',
                ahead: 2,
            },
        });
    });

    it('denies base-to-base pull requests before any mutation', () => {
        expect(evaluateDefaultBranchPullRequestPolicy({
            policy: 'deny',
            currentBranch: 'main',
            baseBranch: 'main',
            branchAhead: 1,
        })).toEqual({
            kind: 'blocked',
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            reason: 'default_branch_denied',
        });
    });
});
