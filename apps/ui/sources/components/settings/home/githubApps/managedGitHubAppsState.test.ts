import { describe, expect, it } from 'vitest';
import type { ManagedGitHubAppInstallationV1 } from '@happier-dev/protocol';

import {
    INITIAL_MANAGED_GITHUB_APPS_STATE,
    beginManagedGitHubAppsRefresh,
    settleManagedGitHubAppsRefresh,
} from './managedGitHubAppsState';

const registration = {
    id: 'registration-1', owner: { kind: 'home' as const }, githubHost: 'https://github.com',
    githubAppId: '12', githubClientId: 'Iv1.client', githubAppSlug: 'happier',
    githubOwnerId: '22', githubOwnerLogin: 'happier-dev', revision: 2, securityRevision: 1,
    state: 'verified' as const,
    secretHealth: { clientSecretConfigured: true, privateKeyConfigured: true, webhookSecretConfigured: true },
    lastVerifiedAt: '2026-09-01T10:00:00.000Z', createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
};

describe('managedGitHubAppsState', () => {
    it('retains the last known registrations and installations when refresh fails', () => {
        const installation = {
            id: 'installation-1', registrationId: registration.id,
            githubInstallationId: '123', githubOrganizationId: '22', githubOrganizationLogin: 'happier-dev',
            repositorySelection: 'selected', revision: 1, state: 'active',
            verifiedPermissions: { contents: 'read' }, verifiedEvents: ['push'],
            suspendedAt: null, lastVerifiedAt: '2026-09-01T10:00:00.000Z', teamConsumers: [],
        } satisfies ManagedGitHubAppInstallationV1;
        const ready = settleManagedGitHubAppsRefresh(INITIAL_MANAGED_GITHUB_APPS_STATE, {
            kind: 'succeeded',
            value: { registrations: [registration], installations: [installation] },
        });
        const refreshing = beginManagedGitHubAppsRefresh(ready);
        expect(refreshing).toMatchObject({
            kind: 'ready', registrations: [registration], installations: [installation],
            refreshing: true, stale: false,
        });
        const failed = settleManagedGitHubAppsRefresh(refreshing, {
            kind: 'failed',
            failure: { code: 'home_unreachable', retryable: true },
        });

        expect(failed).toMatchObject({
            kind: 'ready', registrations: [registration], installations: [installation],
            refreshing: false, stale: true,
            failure: { code: 'home_unreachable', retryable: true },
        });
    });

    it('never treats an impossible read approval as GitHub App data', () => {
        const state = settleManagedGitHubAppsRefresh(INITIAL_MANAGED_GITHUB_APPS_STATE, {
            kind: 'approval_pending',
            artifactId: 'approval-1',
            approval: {
                artifactId: 'approval-1',
                onExecuted: async () => 'ignored',
            },
        });

        expect(state).toEqual({
            kind: 'unavailable',
            failure: { code: 'invalid_action_output', retryable: false },
        });
    });
});
