import { expect, it } from 'vitest';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';
import { derivePluginDaemonContributionRegistrationRights } from '@happier-dev/protocol/plugins/contributions/catalog';
import { projectPluginPortableUiDeclarationsV1 } from '@happier-dev/protocol/plugins/contributions/ui/declarationProjection';
import { createListExtensionSource, createServiceColumnSource } from '../../../../../../../packages/plugin-sdk/fixtures/external-targeted-packages/list-extension-source';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { createPluginRegistrationScope } from '@/sync/domains/plugins/registrationScope';
import { resolveCollectionColumns } from '@/components/ui/lists/collection/collectionColumns';
import { admitPluginListFilterFieldV1, compileEntityListFilterV1, createPluginListFilterFieldRegistryV1,
    type PluginListFilterFactsV1, type PluginListFilterSelectionV1 } from '@happier-dev/plugin-sdk/ui';
import { normalizePluginInstalledUiDeclarations } from './projection';
import { createInstalledPluginUiProjectionPublication, createPluginUiProjectionUnionPublication } from './projectionUnion';
import * as fieldOwner from '@happier-dev/protocol/collections/filter/pluginListFilterFieldV1';

it('addresses public service Resource values by row before applying the existing scalar ingress', () => {
    expect(fieldOwner).toHaveProperty('PluginServiceListFieldResourceInputV1Schema');
    expect(fieldOwner).toHaveProperty('PluginServiceListFieldResourceResultV1Schema');
    const input = { entity: 'service', serverId: 'home', environmentIds: ['zero', 'busy', 'missing'] };
    expect(fieldOwner.PluginServiceListFieldResourceInputV1Schema.parse(input)).toEqual(input);
    const result = fieldOwner.PluginServiceListFieldResourceResultV1Schema.parse({ items: [
        { environmentId: 'zero', value: 0 }, { environmentId: 'busy', value: 7 },
    ] });
    const values = new Map(result.items.map(item => [item.environmentId, item.value]));
    const number = { value: { kind: 'number', unit: '{request}' } } as const;
    expect(fieldOwner.admitPluginListFilterFieldValueV1(number, values.get('zero'))).toEqual({ kind: 'available', value: 0 });
    expect(fieldOwner.admitPluginListFilterFieldValueV1(number, values.get('busy'))).toEqual({ kind: 'available', value: 7 });
    expect(fieldOwner.admitPluginListFilterFieldValueV1(number, values.get('missing'))).toEqual({ kind: 'invalid' });
    expect(fieldOwner.PluginServiceListFieldResourceResultV1Schema.safeParse({ items: [{ environmentId: 'zero', value: {} }] }).success).toBe(false);
});

it('publishes external list declarations to the held-fact consumer and withdraws retired fields without Resource reads', async () => {
    let reads = 0;
    const plugin = createListExtensionSource(() => reads++);
    const parsed = parsePluginManifest(plugin.manifest);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
    const manifest = PluginManifestV2Schema.parse(parsed.manifest);
    const scope = createPluginRegistrationScope({ pluginId: manifest.id, target: { realm: 'daemon' },
        rights: derivePluginDaemonContributionRegistrationRights(manifest.contributes) });
    await plugin.activate(scope.api);
    expect(scope.commit().map(entry => entry.family).sort()).toEqual(['actions', 'resources']);
    const declarations = normalizePluginInstalledUiDeclarations(projectPluginPortableUiDeclarationsV1(manifest));
    const installed = createInstalledPluginUiProjectionPublication();
    const union = createPluginUiProjectionUnionPublication();
    const members = [{ machineId: 'supplier', serverId: 'home', serverIdentityId: 'srv_list',
        projection: declarations, phase: 'current' as const, interactionEnabled: true }];
    const runtime = union.publish(members, new Map()).pluginUiProjection;
    expect(runtime?.listExtensionsById?.['listExtension:com.acme.release:releases']).toBeDefined();
    const models = [declarations];
    const held = installed.publish(models, runtime);
    expect(held?.listExtensionsById).toBeDefined();
    const extension = held?.listExtensionsById['listExtension:com.acme.release:releases'];
    expect(extension?.listExtension.entity).toBe('sessionWork');
    if (!extension) throw new Error('Expected list extension after AppShell publication');
    expect(installed.publish(models, union.publish(members, new Map()).pluginUiProjection)).toBe(held);
    const admitted = admitPluginListFilterFieldV1({ pluginId: manifest.id,
        field: extension.listExtension.filterFields![0]!, factKeys: new Set(['releaseStage']) });
    if (admitted.kind !== 'admitted') throw new Error('Expected admitted held field');
    const selected: PluginListFilterSelectionV1 = { extensions: { [admitted.field.id]: { kind: 'set', include: ['ready'], exclude: [] } } };
    const match = compileEntityListFilterV1(createPluginListFilterFieldRegistryV1<PluginListFilterSelectionV1, PluginListFilterFactsV1>([admitted.field]), selected);
    expect(match({ extensions: { [admitted.field.id]: 'ready' } })).toBe('match');
    expect(match({ extensions: { [admitted.field.id]: 'blocked' } })).toBe('miss');
    const withdrawn = normalizePluginInstalledUiDeclarations({});
    const retiredRuntime = union.publish([{ ...members[0]!, projection: withdrawn }], new Map()).pluginUiProjection;
    const retired = installed.publish([withdrawn], retiredRuntime);
    expect(retired?.listExtensionsById).toEqual({});
    const retiredFields = createPluginListFilterFieldRegistryV1<PluginListFilterSelectionV1, PluginListFilterFactsV1>([]);
    expect(compileEntityListFilterV1(retiredFields, selected)({})).toBe('match');
    expect(compileEntityListFilterV1(retiredFields, selected, 'daemonRule')({})).toBe('unavailable');
    expect(reads).toBe(0);
});

it('restores a retired public service column in the Collection that saved its placement without acquiring its Resource', () => {
    let reads = 0;
    const plugin = createServiceColumnSource(() => reads++);
    const parsed = parsePluginManifest(plugin.manifest);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
    const manifest = PluginManifestV2Schema.parse(parsed.manifest);
    const declarations = normalizePluginInstalledUiDeclarations(projectPluginPortableUiDeclarationsV1(manifest));
    const installed = createInstalledPluginUiProjectionPublication();
    const publication = () => installed.publish([declarations], undefined);
    const held = publication();
    const id = 'listExtension:com.acme.requests:traffic';
    const extension = held?.listExtensionsById[id];
    expect(extension?.listExtension.entity).toBe('service');
    const admitted = admitPluginListFilterFieldV1({ pluginId: manifest.id,
        field: extension?.listExtension.filterFields?.[0], factKeys: new Set() });
    expect(admitted.kind).toBe('admitted');
    if (admitted.kind !== 'admitted') throw new Error('Expected service field admission');
    expect(admitted.field.id).toBe('com.acme.requests/requests');
    expect(admitted.field.declaration.value).toEqual({ kind: 'number', unit: '{request}' });
    expect(admitted.field.declaration.column).toEqual({ title: 'Requests', qualifier: '24 h', width: 112,
        align: 'end', priority: 20, defaultHidden: true });
    const field = { id: admitted.field.id, title: 'Requests', defaultHidden: true };
    const identity = { id: 'name', title: 'Name', primary: true };
    const saved = { orderedIds: [field.id], placements: { [field.id]: 'pinned' as const } };
    const columns = (current: typeof held) => current?.listExtensionsById[id] ? [identity, field] : [identity];
    expect(resolveCollectionColumns(columns(held), saved).visibleIds).toEqual(['name', field.id]);
    const retired = installed.publish([normalizePluginInstalledUiDeclarations({})], undefined);
    expect(resolveCollectionColumns(columns(retired), saved).visibleIds).toEqual(['name']);
    const restored = publication();
    expect(resolveCollectionColumns(columns(restored), saved).visibleIds).toEqual(['name', field.id]);
    expect(resolveCollectionColumns(columns(restored)).visibleIds).toEqual(['name']);
    expect(reads).toBe(0);
});
