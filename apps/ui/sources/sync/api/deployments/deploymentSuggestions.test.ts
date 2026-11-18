import { afterEach, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { DeploySuggestionCatalogV1Schema } from '@happier-dev/protocol/deployments/suggestions/deploySuggestionsV1';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

// Only the Home HTTP and installed Machine transport are replaced.
vi.mock('socket.io-client', async importOriginal => (await import('@/dev/testkit/harness/serverAccountConnectionHarness'))
    .createSocketIoClientBoundary(importOriginal));
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { createUiAccountAction } = await import('@/sync/ops/actions/accountActionDeps');
const { createUiDeploymentActionDeps } = await import('./deploymentActions');
afterEach(async () => { await homes.reset(); });

it.each(['available', 'unavailable'] as const)('settles the UI catalog forge section from its installed publisher read (%s)', async status => {
    const serverId = await homes.addHome({ name: 'Starter publishers', serverUrl: 'https://starter-publishers.test',
        serverIdentityId: 'srv_starter_publishers', accountId: 'owner', currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const forges = [{ providerKind: 'github', title: 'GitHub' }];
    const catalog = DeploySuggestionCatalogV1Schema.parse({ starters: [], apps: [], targets: [], stores: [], machines: [],
        forges, issues: [] });
    const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId,
        runtimeAccountId: account.accountId } as const;
    const operands: unknown[] = [];
    let control = true;
    try {
        await publishMachineInventoryForTest(account, [createMachineFixture({ id: 'publisher', activeAt: Date.now(),
            access: { custodian: { accountId: account.accountId, displayName: 'Owner' }, role: 'manage',
                resourceMode: 'plain', accessState: 'ready' } })]);
        await answerExternalActionAccountForHome(homes, serverId, { actionId: 'deployments.suggestions.catalog',
            machineId: 'publisher', tokenEpoch: 0, execute: input => {
                operands.push(input);
                return !control && status === 'unavailable'
                    ? { ...catalog, forges: [], issues: [{ section: 'forges', code: 'hosting_unavailable' }] }
                    : catalog;
            } });
        // The same Account and Machine carrier must work before testing the missing UI binding.
        expect(await createUiAccountAction({ account })({ actionId: 'deployments.suggestions.catalog', input: {}, context }))
            .toEqual(catalog);
        control = false;
        operands.length = 0;
        const execution = await createActionExecutor(createUiDeploymentActionDeps(account))
            .execute('deployments.suggestions.catalog', {}, context);
        expect(execution.ok).toBe(true);
        if (!execution.ok) throw new Error(execution.errorCode);
        const listed = DeploySuggestionCatalogV1Schema.parse(execution.result);
        expect(listed.forges).toEqual(status === 'available' ? forges : []);
        expect(listed.issues?.filter(issue => issue.section === 'forges')).toEqual(status === 'available' ? []
            : [{ section: 'forges', code: 'hosting_unavailable' }]);
        expect(operands).toEqual([{ projection: 'forges' }]);
    } finally { account.dispose(); }
});
