import { describe, expect, it } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { PluginProjectionV2Schema } from '@happier-dev/protocol';
import { ThemeProfileV1Schema } from '@happier-dev/protocol/account/settings/themeProfiles';
import { buildDeferredDaemonProjectionSections, demandedDaemonProjectionSections } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { projectLoadedPluginContributes } from './fullProjection';
import { createResolvedContributionRegistry } from './createResolvedContributionRegistry';
import { buildPluginProjectionV2 } from './projection/v2';
import { normalizePluginUiProjection } from '../../../../../ui/sources/sync/domains/plugins/ui/projection';
import { unionPluginUiProjections } from '../../../../../ui/sources/sync/domains/plugins/ui/projectionUnion';
import { resolvePluginThemeList } from '../../../../../ui/sources/theme/profiles/pluginThemeCatalog';
import { PLUGIN_UI_SECTIONS } from '../../../../../ui/sources/sync/domains/plugins/ui/projectionSections';
import { projectBundledPluginUiDeclaration, projectBundledPluginUiFirstPaintDeclaration } from '../../../../scripts/build-owned/bundledPlugins/uiDeclarations.mjs';

const theme = ThemeProfileV1Schema.parse({ schemaVersion: 1, id: 'paper', name: 'Paper',
    createdAt: '2026-11-16T00:00:00Z', updatedAt: '2026-11-16T00:00:00Z',
    base: { light: 'light', dark: 'dark' }, overrides: { light: {}, dark: {} },
    seeds: { canvas: '#ffffff', accent: '#2244aa' }, style: { radius: 'sharp', fontFamily: 'Inter' },
    css: '[data-surface="card"] { border-radius: 0; }',
});

function authoredProjection(pluginIds: readonly string[], activePluginIds = pluginIds, localIds: readonly string[] = ['paper']) {
    const loadedPlugins: LoadedPlugin[] = pluginIds.map(pluginId => {
        const authored = definePlugin({ id: pluginId, version: '1.0.0', displayName: `Palette ${pluginId}`,
            themes: Object.fromEntries(localIds.map(id => [id, { theme }])) });
        return { pluginId, manifest: normalizePluginManifestV2(authored.manifest), pluginRootPath: `/plugins/${pluginId}`,
            manifestPath: `/plugins/${pluginId}/plugin.json`, daemonEntryPath: null, devDaemonEntryPath: null,
            sourceSpec: { kind: 'path', locator: `/plugins/${pluginId}`, trustPolicy: 'local_trusted', installPolicy: 'link' } };
    });
    const inputs = projectLoadedPluginContributes({ loadResult: { loadedPlugins, diagnosticsByPluginId: {} }, provenance: 'first_party' });
    const registry = createResolvedContributionRegistry({ ...inputs, occurrenceIdsByPluginId: Object.fromEntries(
        activePluginIds.map(id => [id, createPluginRuntimeOccurrenceId(id)])) });
    return PluginProjectionV2Schema.parse(buildPluginProjectionV2({ registry, generation: 1 }));
}

describe('plugin themes', () => {
    it('keeps theme bodies in full declarations without acquiring them for first paint', async () => {
        const { manifest } = definePlugin({ id: 'org.example.palette', version: '1.0.0', themes: { paper: { theme } } });
        const full = await projectBundledPluginUiDeclaration({ packageName: '@example/palette',
            packageVersion: '1.0.0', manifest, artifactGraphs: [] });
        expect(full?.normalizedManifest.contributes.themes).toEqual([{ id: 'paper', theme }]);
        const firstPaint = await projectBundledPluginUiFirstPaintDeclaration(full);
        expect(firstPaint.presentationManifest.contributes.themes).toEqual([]);
    });

    it('demands the admitted theme family for the app-shell theme library', () => {
        const projection = authoredProjection(['org.example.paper']);
        const { manifest } = buildDeferredDaemonProjectionSections({ protocolVersion: 1,
            projectionDigest: 'a'.repeat(64), projection });
        expect(demandedDaemonProjectionSections(manifest, PLUGIN_UI_SECTIONS)).toContain('familiesById.themes');
        expect(resolvePluginThemeList(normalizePluginUiProjection(projection))).toMatchObject([
            { pluginId: 'org.example.paper', contributionId: 'paper', theme: { name: 'Paper' } },
        ]);
    });

    it('retains portable bodies, qualified identities and plugin attribution through admission and withdrawal', () => {
        const ids = ['org.example.ink', 'org.example.paper'];
        const wire = authoredProjection(ids);
        expect(wire.familiesById).toMatchObject({ themes: {
            family: 'themes',
            entriesById: Object.fromEntries(ids.map(id => [`${id}/paper`, {
                pluginId: id, pluginVersion: '1.0.0', occurrenceId: expect.any(String),
                definition: { id: 'paper', theme },
            }])),
        } });
        const projected = normalizePluginUiProjection(wire);
        expect(Object.keys(projected.themesById)).toEqual(ids.map(id => `${id}/paper`));
        for (const id of ids) {
            expect(projected.themesById[`${id}/paper`]).toMatchObject({ pluginId: id, pluginVersion: '1.0.0',
                pluginName: `Palette ${id}`, definition: { id: 'paper', theme } });
        }
        const catalog = resolvePluginThemeList(projected);
        expect(catalog.map(entry => entry.id)).toEqual(ids.map(id => `${id}/paper`));
        expect(catalog[0]).toMatchObject({ pluginId: ids[0], pluginVersion: '1.0.0',
            pluginName: `Palette ${ids[0]}`, contributionId: 'paper' });
        expect(catalog[0]?.theme).toBe(projected.themesById[`${ids[0]}/paper`]?.definition.theme);
        expect(normalizePluginUiProjection(wire, undefined, projected, { previousInput: wire }).themesById).toBe(projected.themesById);
        const retiredWire = authoredProjection(ids, [ids[1]!]);
        expect(retiredWire.familiesById).not.toHaveProperty(['themes', 'entriesById', `${ids[0]}/paper`]);
        expect(retiredWire.familiesById).toHaveProperty(['themes', 'entriesById', `${ids[1]}/paper`]);
        const retired = normalizePluginUiProjection(retiredWire);
        expect(Object.keys(retired.themesById)).toEqual([`${ids[1]}/paper`]);
        expect(resolvePluginThemeList(retired).map(entry => entry.pluginId)).toEqual([ids[1]]);
        expect(() => normalizePluginManifestV2({ schemaVersion: 2, id: ids[0], version: '1.0.0', runtime: { apiVersion: 1 },
            contributes: { themes: [{ id: 'paper', theme: { ...theme, density: 'compact' } }] } })).toThrow();
    });

    it('coalesces the same contribution across Machines and withdraws it only after its final occurrence retires', () => {
        const projection = normalizePluginUiProjection(authoredProjection(['org.example.paper']));
        const projectionB = normalizePluginUiProjection(authoredProjection(['org.example.paper']));
        const member = (machineId: string) => ({ machineId, serverId: 'theme-home', phase: 'current' as const,
            interactionEnabled: true, projection: machineId === 'theme-machine-b' ? projectionB : projection });
        const union = unionPluginUiProjections([member('theme-machine-a'), member('theme-machine-b')]);
        expect(Object.keys(union.pluginUiProjection.themesById)).toEqual(['org.example.paper/paper']);
        const remaining = unionPluginUiProjections([member('theme-machine-b')]);
        expect(remaining.pluginUiProjection.themesById['org.example.paper/paper']?.definition.theme).toEqual(theme);
        const withdrawn = unionPluginUiProjections([]);
        expect(withdrawn.pluginUiProjection).toBeNull();
        expect(resolvePluginThemeList(withdrawn.pluginUiProjection)).toEqual([]);
    });

    it('retains the forty-theme family identity through unchanged declarations', () => {
        const ids = ['org.example.clay', 'org.example.ink', 'org.example.paper', 'org.example.slate'];
        const wire = authoredProjection(ids, ids, Array.from({ length: 10 }, (_, index) => `paper-${index}`));
        const projected = normalizePluginUiProjection(wire);
        const catalog = resolvePluginThemeList(projected);
        expect(catalog).toHaveLength(40);
        const unchanged = normalizePluginUiProjection({ ...wire, generation: wire.generation + 1 }, undefined, projected,
            { previousInput: wire });
        expect(unchanged.themesById).toBe(projected.themesById);
        expect(resolvePluginThemeList(unchanged)).toEqual(catalog);
    });
});
