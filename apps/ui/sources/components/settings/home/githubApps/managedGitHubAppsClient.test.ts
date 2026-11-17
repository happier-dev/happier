import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ManagedGitHubAppsListOutputV1Schema, ManagedGitHubAppErrorV1Schema } from '@happier-dev/protocol/identity/githubApps';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

const { createManagedGitHubAppsClient } = await import('./managedGitHubAppsClient');
const { resetScopedHomeActionExecutorsForTests } = await import('@/sync/ops/actions/scopedHomeActionExecutor');
// Collect the real executor graph after boundaries, before a test owns its first Action.
await import('@/sync/ops/actions/defaultActionExecutor');

beforeEach(async () => {
    await harness.reset();
    resetScopedHomeActionExecutorsForTests();
});

afterEach(() => {
    resetScopedHomeActionExecutorsForTests();
    vi.clearAllMocks();
});

describe('createManagedGitHubAppsClient', () => {
    it('rejects a non-canonical GitHub App Action input before transport', async () => {
        const serverId = await harness.addHome({
            serverUrl: 'https://github-app-invalid.example',
            name: 'GitHub App Home',
            accountId: 'account-1',
        });
        const scope = createServerAccountScope(serverId, 'account-1')!;
        const inputWithUnknownField = Object.assign(
            { owner: { kind: 'home' as const } },
            { unexpected: true },
        );

        const result = await createManagedGitHubAppsClient(scope).execute(
            'identity.githubApps.list',
            inputWithUnknownField,
        );

        expect(result).toEqual({
            kind: 'failed',
            failure: { code: 'invalid_parameters', retryable: false },
        });
        expect(harness.requestsFor('/v1/identity/github-apps/list')).toHaveLength(0);
    });

    it('lists Home-owned GitHub Apps through the Action-declared scoped route', async () => {
        const serverId = await harness.addHome({
            serverUrl: 'https://github-app-home.example',
            name: 'GitHub App Home',
            accountId: 'account-1',
        });
        const scope = createServerAccountScope(serverId, 'account-1')!;
        harness.answer(serverId, '/v1/identity/github-apps/list', { body: ManagedGitHubAppsListOutputV1Schema.parse({ registrations: [], installations: [] }) });

        const result = await createManagedGitHubAppsClient(scope).execute(
            'identity.githubApps.list',
            { owner: { kind: 'home' } },
        );

        expect(result).toEqual({ kind: 'succeeded', value: { registrations: [], installations: [] } });
        const request = harness.requestsFor('/v1/identity/github-apps/list')[0];
        expect(request?.serverUrl + request?.path).toBe('https://github-app-home.example/v1/identity/github-apps/list');
        expect(request?.method).toBe('POST');
        expect(request?.input).toEqual({ owner: { kind: 'home' } });
    });

    it('preserves a GitHub removal blocker code from the Home', async () => {
        const serverId = await harness.addHome({
            serverUrl: 'https://github-app-blocked.example',
            name: 'GitHub App Home',
            accountId: 'account-1',
        });
        const scope = createServerAccountScope(serverId, 'account-1')!;
        harness.answer(serverId, '/v1/identity/github-apps/remove', { status: 409, body: ManagedGitHubAppErrorV1Schema.parse({
            error: 'github_installation_in_use', blockers: { identityProviderInstances: 2, directorySources: 1 },
        }) });

        const result = await createManagedGitHubAppsClient(scope).execute(
            'identity.githubApps.remove',
            { owner: { kind: 'home' }, installationId: 'installation-1', expectedRevision: 3 },
        );

        expect(result).toEqual({
            kind: 'failed',
            failure: { code: 'github_installation_in_use', retryable: false },
        });
    });

    it('surfaces an ambiguous GitHub App mutation response loss as outcome unknown', async () => {
        const serverId = await harness.addHome({
            serverUrl: 'https://github-app-unknown.example',
            name: 'GitHub App Home',
            accountId: 'account-1',
        });
        const scope = createServerAccountScope(serverId, 'account-1')!;
        harness.answer(serverId, '/v1/identity/github-apps/remove', { dispatchThenFail: true });

        const result = await createManagedGitHubAppsClient(scope).execute(
            'identity.githubApps.remove',
            { owner: { kind: 'home' }, installationId: 'installation-1', expectedRevision: 3 },
        );

        expect(result).toEqual({
            kind: 'failed',
            failure: { code: 'outcome_unknown', retryable: false },
        });
    });
});
