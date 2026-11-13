import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Imported from their own testkit modules rather than the `@/dev/testkit`
 * barrel. The barrel re-exports `fixtures/agentCatalogFixtures`, whose
 * production projection reaches `@/sync/runtime/orchestration/connectionManager`
 * and, through it, `@/sync/http/client` and the reachability fetch. Evaluating
 * that graph on this file's first import binds the real transports and freezes
 * the applied active Home to the built-in default *before*
 * `installHomeGovernanceBoundaries` can install either boundary, so every Home
 * request leaves the harness and the screen never settles. This is the same
 * rule the harness states for its own late imports.
 */
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import {
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

async function addHome(): Promise<Readonly<{ serverId: string; accountId: string }>> {
    const accountId = 'account-admin';
    const serverId = await harness.addHome({
        name: 'Approval Home',
        serverUrl: 'https://approval-home.example',
        accountId,
    });
    return { serverId, accountId };
}

beforeAll(async () => {
    // The front door loads its real executor on first dispatch. Finish that
    // shared graph after installing transports and before a case owns an Action.
    await import('@/sync/domains/state/storage');
    await import('@/sync/ops/actions/defaultActionExecutor');
    await import('./githubApps/managedGitHubAppsClient');
    await import('./identity/managedIdentityProviderClient');
});

beforeEach(async () => {
    const { Modal } = await import('@/modal');
    vi.mocked(Modal.confirm).mockReset().mockResolvedValue(false);
    await harness.reset();
    const { resetScopedHomeActionExecutorsForTests } = await import(
        '@/sync/ops/actions/scopedHomeActionExecutor'
    );
    resetScopedHomeActionExecutorsForTests();
});

afterEach(async () => {
    const { resetScopedHomeActionExecutorsForTests } = await import(
        '@/sync/ops/actions/scopedHomeActionExecutor'
    );
    resetScopedHomeActionExecutorsForTests();
    standardCleanup();
});

describe('Home administration Action approval convergence', () => {
    it('runs a direct present-user mutation without inventing a second default approval', async () => {
        const scope = await addHome();
        harness.answer(scope.serverId, '/v1/identity/github-apps/remove', {
            body: { removed: true },
        });
        const { createManagedGitHubAppsClient } = await import(
            './githubApps/managedGitHubAppsClient'
        );

        const result = await createManagedGitHubAppsClient(scope).execute(
            'identity.githubApps.remove',
            {
                owner: { kind: 'home' },
                installationId: 'installation-1',
                expectedRevision: 1,
            },
        );

        expect(result).toEqual({ kind: 'succeeded', value: { removed: true } });
        expect(harness.requestsFor('/v1/identity/github-apps/remove')).toHaveLength(1);
        expect(harness.requestsFor('/v1/artifacts')).toEqual([]);
    });

    it('sends no identity-provider mutation when local Ask confirmation is declined', async () => {
        const scope = await addHome();
        await harness.requireUiApproval(scope.serverId, 'identity.providers.enable');
        const { createManagedIdentityProviderClient } = await import(
            './identity/managedIdentityProviderClient'
        );

        const result = await createManagedIdentityProviderClient(scope).execute(
            'identity.providers.enable',
            {
                owner: { kind: 'home' },
                id: 'provider-1',
                expectedRevision: 1,
                expectedSecurityRevision: 1,
            },
        );

        expect(result).toEqual({ kind: 'failed', failure: { code: 'approval_canceled', retryable: false } });
        expect(harness.requestsFor('/v1/identity/providers/enable')).toEqual([]);
        expect(harness.requestsFor('/v1/artifacts')).toHaveLength(0);
    });

    it('executes a GitHub App mutation once after local Ask confirmation is accepted', async () => {
        const scope = await addHome();
        await harness.requireUiApproval(scope.serverId, 'identity.githubApps.remove');
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.confirm).mockResolvedValueOnce(true);
        harness.answer(scope.serverId, '/v1/identity/github-apps/remove', { body: { removed: true } });
        const { createManagedGitHubAppsClient } = await import(
            './githubApps/managedGitHubAppsClient'
        );

        const result = await createManagedGitHubAppsClient(scope).execute(
            'identity.githubApps.remove',
            {
                owner: { kind: 'home' },
                installationId: 'installation-1',
                expectedRevision: 1,
            },
        );

        expect(result).toEqual({ kind: 'succeeded', value: { removed: true } });
        expect(harness.requestsFor('/v1/identity/github-apps/remove')).toHaveLength(1);
        expect(harness.requestsFor('/v1/artifacts')).toHaveLength(0);
    });

    it('sends no provider list read when local Ask confirmation is declined', async () => {
        const scope = await addHome();
        await harness.requireUiApproval(scope.serverId, 'identity.providers.list');
        const { createManagedIdentityProviderClient } = await import(
            './identity/managedIdentityProviderClient'
        );

        const result = await createManagedIdentityProviderClient(scope).execute(
            'identity.providers.list',
            { owner: { kind: 'home' } },
        );

        expect(result).toEqual({
            kind: 'failed',
            failure: { code: 'approval_canceled', retryable: false },
        });
        expect(harness.requestsFor('/v1/identity/providers/list')).toEqual([]);
        expect(harness.requestsFor('/v1/artifacts')).toHaveLength(0);
    });
});
