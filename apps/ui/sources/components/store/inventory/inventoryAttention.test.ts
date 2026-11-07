import { afterEach, expect, it } from 'vitest';
import { standardCleanup } from '@/dev/testkit';
import { createAccountNoticeArtifactFixture, createServiceHealthNoticeArtifactFixture, createUsageNoticeArtifactFixture } from '@/dev/testkit/fixtures/usageNoticeFixtures';
import { patchInboxArtifactOrder, readInboxArtifactEntry, projectInboxArtifactItems } from '@/sync/domains/artifacts/inboxArtifacts';
import type { InstalledPluginRow } from '../catalog/storeKinds';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness,
    installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';

const rpc = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
const { replacePluginAccountAvailabilityProjection, readPluginAccountAvailability, clearPluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');
const { storage } = await import('@/sync/domains/state/storage');
const { collectManagedInventoryAttention, groupManagedInventoryAttention } = await import('./inventoryAttention');
afterEach(async () => { standardCleanup(); clearPluginAccountAvailabilityProjection(); await account.reset(); });

it('keeps native health conditions for the exact Machine and removes recovered, dismissed and foreign-Home notices', async () => {
    await account.restore({ serverIdentityId: 'srv_inventory_health', machines: [] });
    const scope = storage.getState().settingsScope!;
    const query = { scope, machine: { serverIdentityId: 'srv_inventory_health', machineId: 'machine' }, projectKey: null };
    const open = createServiceHealthNoticeArtifactFixture(scope.serverId, {
        id: 'health-open', ownerAccountId: scope.accountId, sourceServerId: scope.serverId,
        header: { type: 'blocked', readAt: 1 },
    });
    const notices = (artifacts: readonly typeof open[]) => projectInboxArtifactItems(patchInboxArtifactOrder([], artifacts.flatMap(artifact => {
        const entry = readInboxArtifactEntry(artifact); return entry ? [{ next: entry }] : [];
    })), scope.accountId).openAccountNotices;
    const collect = (artifacts: readonly typeof open[], input = query) => collectManagedInventoryAttention({
        query: input, rows: [], notices: notices(artifacts), machines: [], capabilities: [],
    });
    expect(collect([open])).toMatchObject([{ kind: 'notice', key: `notice:${scope.serverId}:health-open`,
        href: expect.stringContaining('health-open') }]);
    expect(collect([open], { ...query, machine: { ...query.machine, machineId: 'other' } })).toEqual([]);
    const foreign = createServiceHealthNoticeArtifactFixture('foreign-home', {
        id: 'foreign-health', ownerAccountId: scope.accountId, sourceServerId: 'foreign-home', header: { type: 'blocked' },
    });
    expect(collect([foreign])).toEqual([]);
    const recovered = createServiceHealthNoticeArtifactFixture(scope.serverId, {
        ...open, header: { ...open.header, type: 'update', healthPhase: 'recovered', resolved: true },
    });
    const dismissed = createServiceHealthNoticeArtifactFixture(scope.serverId, {
        ...open, header: { ...open.header, status: 'dismissed' },
    });
    expect(collect([recovered, dismissed])).toEqual([]);
    expect(rpc.state.requests).toHaveLength(0);
});

it('joins only admitted managed notices, keeps read unresolved conditions and follows settlement without writes', async () => {
    await account.restore({ serverIdentityId: 'srv_inventory_attention', machines: [] });
    const scope = storage.getState().settingsScope!;
    // The native Availability owner produces the managed plugin identity; a notification itemId is never treated as its id.
    replacePluginAccountAvailabilityProjection({ scope, snapshot: { availabilityCursor: 1, intentReads: [], snapshots: [],
        materializations: [{ serverIdentityId: 'srv_inventory_attention', machineId: 'a', materializationId: 'local', pluginId: 'acme.review',
            version: '1', sourceClass: 'localPath', portableRelease: false, uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: 1 }], inventoryComplete: true } });
    const native = readPluginAccountAvailability(scope).readInstalledPlugins();
    if (native.kind !== 'available') throw new Error('Expected native Availability admission');
    const plugin = native.plugins[0]!;
    const row: InstalledPluginRow = { kind: 'plugin', key: 'native-plugin-row', scope, native: plugin, installations: plugin.installations };
    const open = createAccountNoticeArtifactFixture({ id: 'open', ownerAccountId: scope.accountId, header: { type: 'blocked', readAt: 5 } });
    const independent = createAccountNoticeArtifactFixture({ id: 'independent', updatedAt: 3_000, ownerAccountId: scope.accountId, header: {
        type: 'approval', source: { kind: 'plugin', pluginId: 'acme.review', itemId: 'another-condition' } } });
    const foreign = createAccountNoticeArtifactFixture({ id: 'foreign', ownerAccountId: 'other', header: { type: 'blocked' } });
    const unowned = { ...open, id: 'shared', access: 'view' as const };
    const usage = createUsageNoticeArtifactFixture({ id: 'usage', ownerAccountId: scope.accountId });
    const project = (artifacts: readonly typeof open[]) => projectInboxArtifactItems(patchInboxArtifactOrder([], artifacts.flatMap(artifact => {
        const entry = readInboxArtifactEntry(artifact); return entry ? [{ next: entry }] : [];
    })), scope.accountId);
    const notices = project([open, independent, foreign, unowned, usage]);
    const query = { scope, machine: null, projectKey: null };
    const attention = collectManagedInventoryAttention({ query, rows: [row], notices: notices.openAccountNotices, machines: [], capabilities: [] });
    expect(attention.map(entry => entry.key)).toEqual([`notice:${scope.serverId}:independent`, `notice:${scope.serverId}:open`]);
    expect(open.header?.readAt).toBe(5);
    const settled = createAccountNoticeArtifactFixture({ ...open, header: { ...open.header, resolved: true } });
    expect(collectManagedInventoryAttention({ query, rows: [row], notices: project([settled]).openAccountNotices,
        machines: [], capabilities: [] })).toEqual([]);
    expect(collectManagedInventoryAttention({ query: { ...query, machine: { serverIdentityId: 'srv_other', machineId: 'a' } },
        rows: [], notices: notices.openAccountNotices, machines: [], capabilities: [] })).toEqual([]);
    expect(rpc.state.requests).toHaveLength(0);
});

it('says one reason with one fix once for every Machine it holds on, keeping each Machine reachable', () => {
    const machine = (machineId: string, word: string, actionLabel: string) => ({ kind: 'machine' as const, key: `machine:s:${machineId}`,
        href: `/machine/${machineId}`, native: { serverId: 's', machineId, title: `${machineId} ${word}`, word, actionLabel, tab: null } });
    const notice = { ...machine('n', 'x', 'y'), kind: 'notice' } as unknown as Parameters<typeof groupManagedInventoryAttention>[0][number];
    const short = ['a', 'b', 'c'].map(id => machine(id, 'Short on memory', 'Review processes'));
    const disk = machine('d', 'Disk full', 'Free up space');
    const tight = machine('e', 'Short on memory', 'Review');
    const lines = groupManagedInventoryAttention([notice, short[0]!, disk, short[1]!, tight, short[2]!]);
    expect(lines.map(line => line.kind === 'group' ? `group:${line.entries.map(entry => entry.native.machineId).join(',')}` : line.entry.key))
        .toEqual([notice.key, 'group:a,b,c', disk.key, tight.key]);
    const group = lines[1]!;
    expect(group.kind === 'group' ? [group.word, group.actionLabel] : null).toEqual(['Short on memory', 'Review processes']);
    expect(groupManagedInventoryAttention([short[0]!])).toEqual([{ kind: 'one', entry: short[0] }]);
});
