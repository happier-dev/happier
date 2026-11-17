import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sealPrivateLabelV1 } from '@happier-dev/protocol/crypto/privateLabelV1';
import { TeamCredentialResourceMutationResultV1Schema, TeamCredentialExternalApiKeyRevokeOutputV1Schema,
    TeamCredentialExternalApiKeyRevokeAllOutputV1Schema } from '@happier-dev/protocol/teams';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup, teamCredentialResourceFixture } from '@/dev/testkit';
import { applyTeamCredentialResource, getTeamCredentialResourceSnapshot, resetTeamsSnapshotsForTests } from '@/sync/store/teams/teamsSnapshots';
import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { teamCredentialDisplayNameBinding } from './teamCredentialLabels';

const confirmNative = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { confirm: confirmNative } }).module;
});
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
// Resolve the lazy Action graph during collection, outside interaction deadlines.
await import('@/sync/ops/actions/defaultActionExecutor');
const operations = await import('./teamCredentialOperations');

async function target() {
    const serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://home.example', accountId: 'account', credentialResourcesEnabled: true });
    return { scope: createServerAccountScope(serverId, 'account')!, address: { serverId, teamId: 'team-a' } };
}
const updated = () => TeamCredentialResourceMutationResultV1Schema.parse({ resourceId: 'resource-a', revision: 4 });

beforeEach(async () => {
    await harness.reset();
    resetTeamsSnapshotsForTests();
    confirmNative.mockClear();
});
afterEach(() => { resetTeamsSnapshotsForTests(); standardCleanup(); });

describe('teamCredentialOperations outcome recovery', () => {
    it('marks the canonical resource projection stale when the dispatched mutation loses its response', async () => {
        const context = await target();
        applyTeamCredentialResource({ ...context, resource: teamCredentialResourceFixture({ id: 'resource-a', teamId: 'team-a' }), observedAt: 1 });
        const path = '/v1/teams/credential-resources/update';
        harness.answer(context.scope.serverId, path, { dispatchThenFail: true });

        const outcome = await operations.updateTeamCredentialResource({ ...context, resourceId: 'resource-a', expectedRevision: 3, enabled: false });

        expect(outcome).toMatchObject({ kind: 'failed', failure: { kind: 'outcome_unknown', retryable: false } });
        expect(harness.requestsFor(path)).toHaveLength(1);
        expect(getTeamCredentialResourceSnapshot(context.scope, context.address, 'resource-a')?.stale).toBe(true);
    });

    it('dispatches a surface-confirmed deletion and invalidates the accepted resource', async () => {
        const context = await target();
        applyTeamCredentialResource({ ...context, resource: teamCredentialResourceFixture({ id: 'resource-a', teamId: 'team-a' }), observedAt: 1 });
        const path = '/v1/teams/credential-resources/delete';
        harness.answer(context.scope.serverId, path, { body: updated() });

        await expect(operations.deleteTeamCredentialResource({ ...context, resourceId: 'resource-a', expectedRevision: 3, confirmedByPresentUser: true }))
            .resolves.toEqual({ kind: 'succeeded', value: updated() });

        expect(harness.requestsFor(path)[0]?.input).toEqual({ resourceId: 'resource-a', expectedRevision: 3 });
        expect(confirmNative).not.toHaveBeenCalled();
        expect(getTeamCredentialResourceSnapshot(context.scope, context.address, 'resource-a')?.stale).toBe(true);
    });

    it('sends the complete editor replacement in one revision-checked update', async () => {
        const context = await target();
        const path = '/v1/teams/credential-resources/update';
        harness.answer(context.scope.serverId, path, { body: updated() });
        const replacement = {
            enabled: true,
            displayName: sealPrivateLabelV1({ mode: 'plain', binding: teamCredentialDisplayNameBinding('resource-a'), value: 'Shared provider' }),
            sessionUsePolicy: 'team_context_required' as const,
            requestPolicy: null,
            allMembersAllowedRoutes: ['brokered' as const],
            groupGrants: [], memberGrants: [], usageLimitDelta: { upserts: [], deleteIds: ['limit-a'] },
        };

        await expect(operations.updateTeamCredentialResource({ ...context, resourceId: 'resource-a', expectedRevision: 3, replacement }))
            .resolves.toEqual({ kind: 'succeeded', value: updated() });

        expect(harness.requestsFor(path)[0]?.input).toEqual({ resourceId: 'resource-a', expectedRevision: 3, replacement });
    });

    it('deletes a limit through the real Action front door with one surface confirmation', async () => {
        const context = await target();
        const path = '/v1/teams/credential-resources/limits/delete';
        harness.answer(context.scope.serverId, path, { body: updated() });
        await expect(operations.deleteTeamCredentialUsageLimit({ ...context, resourceId: 'resource-a', expectedRevision: 3,
            limitId: 'limit-a', confirmedByPresentUser: true })).resolves.toEqual({ kind: 'succeeded', value: updated() });
        expect(harness.requestsFor(path)[0]?.input).toEqual({ resourceId: 'resource-a', expectedRevision: 3, limitId: 'limit-a' });
        expect(confirmNative).not.toHaveBeenCalled();
    });

    it('revokes the exact external key through the real Action front door', async () => {
        const context = await target();
        const path = '/v1/teams/credential-resources/external-keys/revoke';
        const value = TeamCredentialExternalApiKeyRevokeOutputV1Schema.parse({ keyId: '00000000-0000-4000-8000-000000000001', revoked: true });
        harness.answer(context.scope.serverId, path, { body: value });
        await expect(operations.revokeTeamCredentialExternalApiKey({ scope: context.scope, resourceId: 'resource-a', keyId: '00000000-0000-4000-8000-000000000001', confirmedByPresentUser: true }))
            .resolves.toEqual({ kind: 'succeeded', value });
        expect(harness.requestsFor(path)[0]?.input).toEqual({ resourceId: 'resource-a', keyId: '00000000-0000-4000-8000-000000000001' });
        expect(confirmNative).not.toHaveBeenCalled();
    });

    it('revokes all external keys for the exact resource through the real Action front door', async () => {
        const context = await target();
        const path = '/v1/teams/credential-resources/external-keys/revoke-all';
        const value = TeamCredentialExternalApiKeyRevokeAllOutputV1Schema.parse({ resourceId: 'resource-a', revokedCount: 2 });
        harness.answer(context.scope.serverId, path, { body: value });
        await expect(operations.revokeAllTeamCredentialExternalApiKeys({ scope: context.scope, resourceId: 'resource-a', confirmedByPresentUser: true }))
            .resolves.toEqual({ kind: 'succeeded', value });
        expect(harness.requestsFor(path)[0]?.input).toEqual({ resourceId: 'resource-a' });
        expect(confirmNative).not.toHaveBeenCalled();
    });
});
