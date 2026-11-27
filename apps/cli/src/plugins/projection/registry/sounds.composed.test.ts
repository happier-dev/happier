import { describe, expect, it } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { PluginProjectionV2Schema } from '@happier-dev/protocol';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { projectLoadedPluginContributes } from './fullProjection';
import { createResolvedContributionRegistry } from './createResolvedContributionRegistry';
import { buildPluginProjectionV2 } from './projection/v2';
import { normalizePluginUiProjection } from '../../../../../ui/sources/sync/domains/plugins/ui/projection';
import { unionPluginUiProjections } from '../../../../../ui/sources/sync/domains/plugins/ui/projectionUnion';

describe('plugin sounds', () => {
    it('exposes qualified data-only sounds through the UI projection and retires them with the plugin', () => {
        const pluginId = 'com.acme.sounds';
        const definition = { label: 'Coin', src: 'https://example.com/coin.wav',
            credit: { author: 'Acme', licence: 'CC0', url: 'https://example.com/credits' } };
        const authored = definePlugin({ id: pluginId, version: '1.0.0', sounds: { coin: definition } });
        const manifest = normalizePluginManifestV2(authored.manifest);
        const loaded: LoadedPlugin = { pluginId, manifest, pluginRootPath: '/plugins/sounds', manifestPath: '/plugins/sounds/plugin.json',
            daemonEntryPath: null, devDaemonEntryPath: null,
            sourceSpec: { kind: 'path', locator: '/plugins/sounds', trustPolicy: 'local_trusted', installPolicy: 'link' } };
        const inputs = projectLoadedPluginContributes({ loadResult: { loadedPlugins: [loaded], diagnosticsByPluginId: {} }, provenance: 'first_party' });
        const project = (occurrenceIdsByPluginId: Readonly<Record<string, string>>, generation: number) => {
            const registry = createResolvedContributionRegistry({ ...inputs, occurrenceIdsByPluginId });
            const projection = PluginProjectionV2Schema.parse(buildPluginProjectionV2({ registry, generation }));
            return unionPluginUiProjections([{ machineId: 'machine', serverId: 'home', phase: 'current', interactionEnabled: true,
                projection: normalizePluginUiProjection(projection) }]).pluginUiProjection;
        };
        const id = `${pluginId}/coin`;
        expect(project({ [pluginId]: createPluginRuntimeOccurrenceId(pluginId) }, 1)?.soundsById[id]?.definition).toEqual({
            id: 'coin', ...definition,
        });
        expect(project({}, 2)?.soundsById[id]).toBeUndefined();
    });
});
