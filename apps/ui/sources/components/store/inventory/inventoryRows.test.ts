import { expect, it } from 'vitest';
import type { PluginMachineMaterializationV1 } from '@happier-dev/protocol/plugins/availability';
import type { InstalledPluginRow, InstalledProviderRow, InstalledSkillRow } from '../catalog/storeKinds';
import { createProviderConnectionViewFixture } from '@/dev/testkit/harness/providerSettingsHarness';
import { createSkillsSurfaceItem } from '@/dev/testkit/harness/skillsSurfaceHarness';
import { inventoryMachineKey, inventoryWhereWords, partitionIncludedRows, presentInventoryRow, type ManagedInventoryRowPresentation } from './inventoryRows';
import { t } from '@/text';

const scope = { serverId: 'srv_included', accountId: 'acct_included' };
const input = { scope, machine: null, projectKey: null };

function pluginRow(pluginId: string, sourceClass: PluginMachineMaterializationV1['sourceClass']): InstalledPluginRow {
    const materialization: PluginMachineMaterializationV1 = { serverIdentityId: 'srv_included', machineId: 'm1',
        materializationId: `${pluginId}-m1`, pluginId, version: '1.0.0', sourceClass, portableRelease: false,
        uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: 1 };
    const installation = { materialization } as InstalledPluginRow['installations'][number];
    return { kind: 'plugin', scope, key: `plugin:${pluginId}`, installations: [installation],
        native: { pluginId, installations: [installation] } as InstalledPluginRow['native'] };
}

it('keeps plugins that ship with Happier apart from the ones the person added', () => {
    const added = pluginRow('example.added', 'localPath');
    const bundled = pluginRow('example.bundled', 'bundledFirstParty');
    expect(presentInventoryRow(bundled, input).included).toBe(true);
    expect(presentInventoryRow(added, input).included).toBe(false);
    const presentations = new Map([added, bundled].map(row => [row.key, presentInventoryRow(row, input)]));
    expect(partitionIncludedRows([bundled, added], presentations)).toEqual({ added: [added], included: [bundled] });
});

it('counts first-party skills as included and the person\'s own skills as added', () => {
    const skill = (skillId: string, provenance: InstalledSkillRow['native']['provenance']): InstalledSkillRow =>
        ({ kind: 'skill', scope, key: `skill:${skillId}`, reach: [], native: createSkillsSurfaceItem(skillId, { provenance }) }) as InstalledSkillRow;
    expect(presentInventoryRow(skill('happier', { kind: 'first_party' } as InstalledSkillRow['native']['provenance']), input).included).toBe(true);
    expect(presentInventoryRow(skill('mine', { kind: 'written' } as InstalledSkillRow['native']['provenance']), input).included).toBe(false);
});

it('says where in words: the one Machine, every Machine, or how many, never a list of Machine names', () => {
    const ids = ['m1', 'm2', 'm3', 'm4'];
    const names = { byId: new Map(ids.map(id => [id, `Machine ${id}`])),
        byKey: new Map(ids.map(id => [inventoryMachineKey(scope, { serverIdentityId: 'srv_included', machineId: id }), `Machine ${id}`])) };
    const on = (machineIds: readonly string[]) => ({ ...presentInventoryRow(pluginRow('example.where', 'localPath'), input),
        machines: machineIds.map(machineId => ({ serverIdentityId: 'srv_included', machineId })) }) as ManagedInventoryRowPresentation;
    expect(inventoryWhereWords(on(['m2']), input, names)).toBe('Machine m2');
    expect(inventoryWhereWords(on(ids), input, names)).toBe(t('storeInstalled.everyMachine'));
    expect(inventoryWhereWords(on(['m1', 'm2', 'm3']), input, names)).toBe(t('allMachines.machinesCount', { count: 3 }));
    expect(inventoryWhereWords(on(['m1', 'm2', 'm3']), { ...input, machine: { serverIdentityId: 'srv_included', machineId: 'm1' } }, names)).toBeNull();
});


it('files a switched-off provider under the same Off condition as every other kind, so the filter offers one Off', () => {
    const view = createProviderConnectionViewFixture({ grants: { accountEnabled: false, enabledMachineIds: [] } });
    const provider = { kind: 'provider', scope, key: 'provider:off', native: {}, catalog: {}, view } as unknown as InstalledProviderRow;
    const skill = { kind: 'skill', scope, key: 'skill:off', reach: [], native: createSkillsSurfaceItem('off-skill', { rules: [] }) } as unknown as InstalledSkillRow;
    const skillStatuses = presentInventoryRow(skill, input).facts.fields.status ?? [];
    expect(skillStatuses).toContain('off');
    expect(presentInventoryRow(provider, input).facts.fields.status).toEqual(['off']);
});
