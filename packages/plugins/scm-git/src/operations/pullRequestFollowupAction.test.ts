import { describe, expect, it } from 'vitest';

import type { ScmHostingProviderRef } from '@happier-dev/plugin-sdk/experimental/scm';

import { createValidatedPullRequestFollowupAction } from './pullRequestFollowupAction.js';

const provider: ScmHostingProviderRef = {
    id: 'scm.github.enterprise',
    kind: 'github',
    displayName: 'GitHub Enterprise',
    baseUrl: 'https://github.example.com/org',
    nameWithOwner: 'org/repo',
    repositoryWebUrl: 'https://github.example.com/org/repo',
    urlSafety: { allowedSchemes: ['https:'] },
};

describe('pull request follow-up action validation', () => {
    it('returns an openUrl action when the target stays under the provider-approved base path', () => {
        expect(createValidatedPullRequestFollowupAction({
            provider,
            purpose: 'pullRequest',
            url: 'https://github.example.com/org/repo/pull/7',
            allowedBaseUrl: 'https://github.example.com/org',
        })).toEqual({
            kind: 'openUrl',
            purpose: 'pullRequest',
            url: 'https://github.example.com/org/repo/pull/7',
            allowedBaseUrl: 'https://github.example.com/org/repo',
            urlSafety: { allowedSchemes: ['https:'] },
        });
    });

    it('falls back to none when a repository provider target stays on the same host but escapes the repository path', () => {
        expect(createValidatedPullRequestFollowupAction({
            provider: {
                ...provider,
                baseUrl: 'https://github.example.com',
                nameWithOwner: 'org/repo',
                repositoryWebUrl: 'https://github.example.com/org/repo',
            },
            purpose: 'pullRequest',
            url: 'https://github.example.com/org/other/pull/7',
            allowedBaseUrl: 'https://github.example.com',
        })).toEqual({ kind: 'none' });
    });

    it('narrows repository providers to repository-scoped allowed base URLs', () => {
        expect(createValidatedPullRequestFollowupAction({
            provider: {
                ...provider,
                baseUrl: 'https://github.example.com',
                nameWithOwner: 'org/repo',
                repositoryWebUrl: 'https://github.example.com/org/repo',
            },
            purpose: 'compose',
            url: 'https://github.example.com/org/repo/compare/main...feature',
            allowedBaseUrl: 'https://github.example.com',
        })).toMatchObject({
            kind: 'openUrl',
            allowedBaseUrl: 'https://github.example.com/org/repo',
        });
    });

    it('falls back to none when the target escapes the provider-approved base path', () => {
        expect(createValidatedPullRequestFollowupAction({
            provider,
            purpose: 'compose',
            url: 'https://github.example.com/other/repo/compare/main...feature',
            allowedBaseUrl: 'https://github.example.com/org',
        })).toEqual({ kind: 'none' });
    });

    it('falls back to none when the scheme is not provider-approved', () => {
        expect(createValidatedPullRequestFollowupAction({
            provider,
            purpose: 'pullRequest',
            url: 'http://github.example.com/org/repo/pull/7',
            allowedBaseUrl: 'https://github.example.com/org',
        })).toEqual({ kind: 'none' });
    });

    it('falls back to none when the target URL contains credentials', () => {
        expect(createValidatedPullRequestFollowupAction({
            provider,
            purpose: 'compose',
            url: 'https://token@github.example.com/org/repo/compare/main...feature',
            allowedBaseUrl: 'https://github.example.com/org',
        })).toEqual({ kind: 'none' });
    });
});
