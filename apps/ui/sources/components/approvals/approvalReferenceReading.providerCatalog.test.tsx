import { afterEach, beforeEach, expect, it } from 'vitest';
import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { DEFAULT_PROVIDER_SETTINGS_V1 } from '@happier-dev/protocol/providers/settings/v1';
import { ProviderConnectionsCatalogV1Schema, splitProviderSettingsV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { applyProviderCatalogSnapshot, resetProviderCatalogSnapshotsForTests } from '@/sync/store/settings/providerCatalogSnapshot';

installApprovalCommonModuleMocks();
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { readApprovalReferenceForConfirmation } = await import('./approvalReferenceReading');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');

beforeEach(async () => { standardCleanup(); resetProviderCatalogSnapshotsForTests(); await harness.reset(); });
afterEach(standardCleanup);

it('confirms the exact personal connection and model among thousands without scanning unrelated rows, and observes its rename', async () => {
    const home = await harness.addHome({ name: 'Approval Home', serverUrl: 'https://personal-provider-reference.test',
        accountId: 'recipient', serverIdentityId: 'srv_personal_provider' });
    const account = await captureLazyActionAccountContext(home);
    const scope = { serverId: account.serverId, accountId: account.accountId };
    let unrelatedReads = 0;
    const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...splitProviderSettingsV1(DEFAULT_PROVIDER_SETTINGS_V1).catalog,
        connections: Array.from({ length: 1_000 }, (_, index) => ({ v: 1, id: `pc_${index}`,
            source: { kind: 'contribution', contributionKey: 'acme.gateway/gateway' }, role: 'named',
            displayName: `Gateway ${index}`, displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 })),
        manualModelsByConnectionId: { pc_999: [{ id: 'model', name: 'Named model', addedAt: 1 }] },
    });
    const countedConnections = catalog.connections.map(connection => connection.id === 'pc_999' ? connection : { ...connection, get id() {
        unrelatedReads += 1; return connection.id;
    } });
    applyProviderCatalogSnapshot(scope, { status: 'ready', revision: 1, catalog: { ...catalog, connections: countedConnections } }, true);
    unrelatedReads = 0;
    try {
        expect(await readApprovalReferenceForConfirmation({ kind: 'providerConnection', id: 'pc_999' }, account))
            .toMatchObject({ text: 'Gateway 999', named: true });
        expect(await readApprovalReferenceForConfirmation({ kind: 'providerModel', id: 'model', connectionId: 'pc_999',
            agentTargetKey: 'agent:happier.agent.codex/codex' }, account)).toMatchObject({ text: 'Named model', named: true });
        await readApprovalReferenceForConfirmation({ kind: 'providerConnection', id: 'pc_absent' }, account);
        expect(unrelatedReads).toBe(0);
        applyProviderCatalogSnapshot(scope, { status: 'ready', revision: 2, catalog: { ...catalog,
            connections: countedConnections.map(connection => connection.id === 'pc_999' ? { ...connection, displayName: 'Renamed gateway' } : connection),
        } }, true);
        unrelatedReads = 0;
        expect(await readApprovalReferenceForConfirmation({ kind: 'providerConnection', id: 'pc_999' }, account))
            .toMatchObject({ text: 'Renamed gateway', named: true });
        expect(unrelatedReads).toBe(0);
    } finally { account.dispose(); }
});
