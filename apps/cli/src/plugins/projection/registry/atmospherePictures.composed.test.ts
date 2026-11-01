import { describe, expect, it } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { PluginProjectionV2Schema } from '@happier-dev/protocol';
import { ATMOSPHERE_PICTURES } from '@happier-dev/brand/atmosphere';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { projectLoadedPluginContributes } from './fullProjection';
import { createResolvedContributionRegistry } from './createResolvedContributionRegistry';
import { buildPluginProjectionV2 } from './projection/v2';
import { normalizePluginUiProjection } from '../../../../../ui/sources/sync/domains/plugins/ui/projection';
import { resolveAtmospherePictureCatalog } from '../../../../../ui/sources/components/atmosphere/pictureCatalog';
import { unionPluginUiProjections } from '../../../../../ui/sources/sync/domains/plugins/ui/projectionUnion';
import { resolveAtmosphere } from '../../../../../ui/sources/components/atmosphere/resolveAtmosphere';
import { DEFAULT_HOME_ATMOSPHERE } from '@happier-dev/protocol/account/settings/accountSettings';

describe('plugin atmosphere pictures', () => {
    it('projects real authored pictures with qualified identity, release looks and occurrence retirement', () => {
        const { id: _builtinId, ...picture } = ATMOSPHERE_PICTURES[0]!;
        const pluginId = 'com.acme.atmosphere';
        const authored = definePlugin({ id: pluginId, version: '1.0.0', atmospherePictures: {
            sky: { ...picture, title: 'Plugin sky', credit: { ...picture.credit, licence: 'CC BY 4.0' } },
        } });
        const manifest = normalizePluginManifestV2(authored.manifest);
        const loaded: LoadedPlugin = { pluginId, manifest, pluginRootPath: '/plugins/sky', manifestPath: '/plugins/sky/plugin.json',
            daemonEntryPath: null, devDaemonEntryPath: null,
            sourceSpec: { kind: 'path', locator: '/plugins/sky', trustPolicy: 'local_trusted', installPolicy: 'link' } };
        const inputs = projectLoadedPluginContributes({ loadResult: { loadedPlugins: [loaded], diagnosticsByPluginId: {} }, provenance: 'first_party' });
        const registry = createResolvedContributionRegistry({ ...inputs, occurrenceIdsByPluginId: { [pluginId]: createPluginRuntimeOccurrenceId(pluginId) } });
        const projection = buildPluginProjectionV2({ registry, generation: 1 });
        expect(PluginProjectionV2Schema.safeParse(projection).success).toBe(true);
        const catalog = resolveAtmospherePictureCatalog(normalizePluginUiProjection(projection));
        expect(catalog).toHaveLength(ATMOSPHERE_PICTURES.length + 1);
        expect(catalog.find(entry => entry.id === `${pluginId}/sky`)).toEqual({ ...picture, id: `${pluginId}/sky`, title: 'Plugin sky', credit: { ...picture.credit, licence: 'CC BY 4.0' } });
        const union = unionPluginUiProjections([{ machineId: 'picture-machine', serverId: 'picture-home', phase: 'current', interactionEnabled: true,
            projection: normalizePluginUiProjection(projection) }]);
        expect(resolveAtmospherePictureCatalog(union.pluginUiProjection).find(entry => entry.id === `${pluginId}/sky`)).toEqual(catalog.at(-1));
        const selected = resolveAtmosphere({ surface: 'home', home: { ...DEFAULT_HOME_ATMOSPHERE, source: 'picture',
            picture: { ref: { kind: 'builtin', id: `${pluginId}/sky` }, layout: 'horizon' } },
            pictures: catalog, pictureRecord: { localId: `builtin:${pluginId}/sky`, kind: 'builtin', source: picture.src, createdAtMs: 1, size: 1, data: 'cached-picture' },
            isPhone: false, glassSettings: { glassBlurEnabled: false },
            glassEnvironment: {}, reduceTransparency: false, reducedMotion: false });
        expect(selected.source).toBe('picture');
        expect(selected.builtinPicture).toEqual(catalog.at(-1));
        const retired = buildPluginProjectionV2({ registry: createResolvedContributionRegistry({ ...inputs, occurrenceIdsByPluginId: {} }), generation: 2 });
        expect(resolveAtmospherePictureCatalog(normalizePluginUiProjection(retired))).toEqual(ATMOSPHERE_PICTURES);
        expect(() => normalizePluginManifestV2({ ...authored.manifest, contributes: { atmospherePictures: [{ ...manifest.contributes?.atmospherePictures?.[0], src: { ...picture.src, unexpected: true } }] } })).toThrow();
    });
});
