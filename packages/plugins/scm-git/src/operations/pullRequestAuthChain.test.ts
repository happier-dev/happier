import { describe, expect, it } from 'vitest';

import {
  SCM_OPERATION_ERROR_CODES,
  type ScmHostingProviderRef,
  type ScmPullRequestSummary,
} from '@happier-dev/plugin-sdk/experimental/scm';

import {
    matchesBranchHeadContext,
    readDuplicatePullRequestHint,
} from './pullRequestAuthChain.js';

const provider: ScmHostingProviderRef = {
    id: 'scm.github',
    kind: 'github',
    displayName: 'GitHub',
    baseUrl: 'https://github.com',
    nameWithOwner: 'happier-dev/happier',
    urlSafety: { allowedSchemes: ['https:'] },
};

function createPullRequest(overrides: Partial<ScmPullRequestSummary> = {}): ScmPullRequestSummary {
    return {
        provider,
        number: 42,
        title: 'Open PR',
        url: 'https://github.com/happier-dev/happier/pull/42',
        baseBranch: 'main',
        headBranch: 'feature/scm-pr-6',
        state: 'open',
        ...overrides,
    };
}

describe('pull request auth-chain helpers', () => {
    it('reads typed duplicate PR hints before falling back to parsed URLs', () => {
        const pullRequest = createPullRequest();
        const error = Object.assign(new Error('duplicate'), {
            errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_ALREADY_EXISTS,
            pullRequest,
            url: 'https://github.com/happier-dev/happier/pull/99',
        });

        expect(readDuplicatePullRequestHint(error)).toEqual({
            kind: 'pullRequest',
            pullRequest,
        });
    });

    it('uses parsed duplicate URLs only as untrusted hints', () => {
        const error = Object.assign(new Error('A pull request already exists: https://github.com/happier-dev/happier/pull/42'), {
            errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_ALREADY_EXISTS,
        });

        expect(readDuplicatePullRequestHint(error)).toEqual({
            kind: 'reference',
            reference: { url: 'https://github.com/happier-dev/happier/pull/42' },
        });
    });

    it('validates base branch, head branch, provider, and head repository before reuse', () => {
        expect(matchesBranchHeadContext({
            pullRequest: createPullRequest({
                headRepositoryNameWithOwner: 'happier-dev/happier',
            } as Partial<ScmPullRequestSummary>),
            provider,
            baseBranch: 'main',
            headBranch: 'feature/scm-pr-6',
        })).toBe(true);

        expect(matchesBranchHeadContext({
            pullRequest: createPullRequest({
                headBranch: 'feature/other',
                headRepositoryNameWithOwner: 'happier-dev/happier',
            } as Partial<ScmPullRequestSummary>),
            provider,
            baseBranch: 'main',
            headBranch: 'feature/scm-pr-6',
        })).toBe(false);

        expect(matchesBranchHeadContext({
            pullRequest: createPullRequest({
                headRepositoryNameWithOwner: 'someone/fork',
            } as Partial<ScmPullRequestSummary>),
            provider,
            baseBranch: 'main',
            headBranch: 'feature/scm-pr-6',
        })).toBe(false);
    });

    it('validates Azure DevOps organization/project/repository head coordinates before reuse', () => {
        const azureProvider: ScmHostingProviderRef = {
            id: 'scm.azure-devops',
            kind: 'azure-devops',
            displayName: 'Azure DevOps',
            baseUrl: 'https://dev.azure.com/happier-dev',
            nameWithOwner: 'happier-dev/platform/happier',
            urlSafety: { allowedSchemes: ['https:'] },
        };
        const azurePullRequest = createPullRequest({
            provider: azureProvider,
            url: 'https://dev.azure.com/happier-dev/platform/_git/happier/pullrequest/42',
            headRepositoryNameWithOwner: 'happier-dev/platform/happier',
        } as Partial<ScmPullRequestSummary>);

        expect(matchesBranchHeadContext({
            pullRequest: azurePullRequest,
            provider: azureProvider,
            baseBranch: 'main',
            headBranch: 'feature/scm-pr-6',
        })).toBe(true);

        expect(matchesBranchHeadContext({
            pullRequest: {
                ...azurePullRequest,
                headRepositoryNameWithOwner: 'happier-dev/other-project/happier',
            },
            provider: azureProvider,
            baseBranch: 'main',
            headBranch: 'feature/scm-pr-6',
        })).toBe(false);
    });

    it('rejects duplicate reuse when the pull request lacks head repository context', () => {
        expect(matchesBranchHeadContext({
            pullRequest: createPullRequest(),
            provider,
            baseBranch: 'main',
            headBranch: 'feature/scm-pr-6',
        })).toBe(false);
    });
});
