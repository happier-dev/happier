import { describe, expect, it } from 'vitest';
import { PluginProjectionV2Schema } from '@happier-dev/protocol';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { projectLoadedPluginContributes } from './fullProjection';
import { createResolvedContributionRegistry } from './createResolvedContributionRegistry';
import { buildPluginProjectionV2 } from './projection/v2';
import { normalizePluginUiProjection } from '../../../../../ui/sources/sync/domains/plugins/ui/projection';
import { unionPluginUiProjections } from '../../../../../ui/sources/sync/domains/plugins/ui/projectionUnion';
import { notificationAuthorPlugin, notificationButtons, noticeOnlyAuthorPlugin } from '../../../../../../packages/plugin-sdk/fixtures/external-targeted-packages/target/src/notificationAuthoring';

describe('external notification button declarations', () => {
    it('retains authored buttons through manifest admission, registry, strict wire and UI union without activation', () => {
        const pluginId = 'com.acme.reviews';
        const buttons = notificationButtons;
        const inputs = projectLoadedPluginContributes({ provenance: 'external', loadResult: {
            loadedPlugins: [notificationAuthorPlugin, noticeOnlyAuthorPlugin].map(plugin => ({
                manifest: normalizePluginManifestV2(plugin.manifest), pluginId: plugin.manifest.id,
                pluginRootPath: `/external/${plugin.manifest.id}`, manifestPath: `/external/${plugin.manifest.id}/.happier-plugin/plugin.json`, daemonEntryPath: null,
                devDaemonEntryPath: null, sourceSpec: { kind: 'path' as const, locator: `/external/${plugin.manifest.id}`, trustPolicy: 'local_trusted' as const, installPolicy: 'link' as const },
            })),
            diagnosticsByPluginId: {},
        } });
        const registry = createResolvedContributionRegistry({ ...inputs,
            occurrenceIdsByPluginId: { [pluginId]: createPluginRuntimeOccurrenceId(pluginId),
                [noticeOnlyAuthorPlugin.manifest.id]: createPluginRuntimeOccurrenceId(noticeOnlyAuthorPlugin.manifest.id) } });
        const wire = PluginProjectionV2Schema.parse(buildPluginProjectionV2({ registry, generation: 1 }));
        const id = `${pluginId}/review`;
        expect(wire.familiesById.notificationCategories?.entriesById[id]?.definition.buttons).toEqual(buttons);
        const normalized = normalizePluginUiProjection(wire);
        expect(normalized.notificationCategoriesById[id]?.definition.buttons).toEqual(buttons);
        const next = normalizePluginUiProjection({ ...wire, generation: 2 }, 'web', normalized, { previousInput: wire });
        expect(next.notificationCategoriesById).toBe(normalized.notificationCategoriesById);
        const union = unionPluginUiProjections([{ machineId: 'supplier', serverId: 'home', phase: 'current',
            interactionEnabled: true, projection: normalized }]);
        expect(union.pluginUiProjection?.notificationCategoriesById[id]?.definition.buttons).toEqual(buttons);
        expect(union.pluginUiProjection?.notificationCategoriesById['com.acme.notices/notice']?.definition.buttons).toEqual([buttons[0]]);
        const retired = normalizePluginUiProjection(PluginProjectionV2Schema.parse(buildPluginProjectionV2({
            registry: createResolvedContributionRegistry({}), generation: 3,
        })));
        expect(unionPluginUiProjections([{ machineId: 'supplier', serverId: 'home', phase: 'current',
            interactionEnabled: true, projection: retired }]).pluginUiProjection?.notificationCategoriesById ?? {}).toEqual({});
    });
});
