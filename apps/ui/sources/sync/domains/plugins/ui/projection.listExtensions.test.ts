import { expect, it } from 'vitest';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';
import { derivePluginDaemonContributionRegistrationRights } from '@happier-dev/protocol/plugins/contributions/catalog';
import { projectPluginPortableUiDeclarationsV1 } from '@happier-dev/protocol/plugins/contributions/ui/declarationProjection';
import { createListExtensionSource, createServiceColumnSource } from '../../../../../../../packages/plugin-sdk/fixtures/external-targeted-packages/list-extension-source';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { createPluginRegistrationScope } from '@/sync/domains/plugins/registrationScope';
import { admitPluginListFilterFieldV1, compileEntityListFilterV1, createPluginListFilterFieldRegistryV1,
    type PluginListFilterFactsV1, type PluginListFilterSelectionV1 } from '@happier-dev/plugin-sdk/ui';
import { normalizePluginInstalledUiDeclarations } from './projection';
import { createInstalledPluginUiProjectionPublication, createPluginUiProjectionUnionPublication } from './projectionUnion';

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
    expect(compileEntityListFilterV1(createPluginListFilterFieldRegistryV1([]), selected)({})).toBe('unavailable');
    expect(reads).toBe(0);
});

it('publishes default-off numeric service column metadata without acquiring its Resource and retires its qualified identity', () => {
    let reads = 0;
    const plugin = createServiceColumnSource(() => reads++);
    const parsed = parsePluginManifest(plugin.manifest);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
    const manifest = PluginManifestV2Schema.parse(parsed.manifest);
    const declarations = normalizePluginInstalledUiDeclarations(projectPluginPortableUiDeclarationsV1(manifest));
    const installed = createInstalledPluginUiProjectionPublication();
    const held = installed.publish([declarations], undefined);
    const extension = held?.listExtensionsById['listExtension:com.acme.requests:traffic'];
    expect(extension?.listExtension.entity).toBe('service');
    const admitted = admitPluginListFilterFieldV1({ pluginId: manifest.id,
        field: extension?.listExtension.filterFields?.[0], factKeys: new Set() });
    expect(admitted.kind).toBe('admitted');
    if (admitted.kind !== 'admitted') throw new Error('Expected service field admission');
    expect(admitted.field.id).toBe('com.acme.requests/requests');
    expect(admitted.field.declaration.value).toEqual({ kind: 'number', unit: '{request}' });
    expect(admitted.field.declaration.column).toEqual({ title: 'Requests', width: 112,
        align: 'end', priority: 20, defaultHidden: true });
    expect(installed.publish([normalizePluginInstalledUiDeclarations({})], undefined)?.listExtensionsById).toEqual({});
    expect(reads).toBe(0);
});
