import { describe, expect, it } from 'vitest';

import { resolvePullRequestBranchPublishPlan } from './pullRequestBranchPublishSafety';

describe('resolvePullRequestBranchPublishPlan', () => {
    it('publishes the active feature branch when no upstream is configured', () => {
        expect(resolvePullRequestBranchPublishPlan({
            activeBranch: 'feature/scm-pr-6',
            baseBranch: 'main',
            upstream: null,
        })).toEqual({
            kind: 'publish_active_branch',
            branch: 'feature/scm-pr-6',
            reason: 'missing_upstream',
        });
    });

    it('publishes the active feature branch when its upstream points at the base branch', () => {
        expect(resolvePullRequestBranchPublishPlan({
            activeBranch: 'feature/scm-pr-6',
            baseBranch: 'main',
            upstream: 'origin/main',
        })).toEqual({
            kind: 'publish_active_branch',
            branch: 'feature/scm-pr-6',
            reason: 'upstream_points_at_base',
        });
    });

    it('keeps a normal same-branch upstream as safe', () => {
        expect(resolvePullRequestBranchPublishPlan({
            activeBranch: 'feature/scm-pr-6',
            baseBranch: 'main',
            upstream: 'origin/feature/scm-pr-6',
        })).toEqual({
            kind: 'upstream_ok',
            branch: 'feature/scm-pr-6',
            upstream: 'origin/feature/scm-pr-6',
        });
    });
});
