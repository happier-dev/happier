import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginProjectionV2Schema } from '@happier-dev/protocol';
import { PluginUiArtifactsManifestV2Schema } from '@happier-dev/protocol/plugins/ui';
import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { buildPluginContributionRegistry } from './normalize/package';
import { projectLoadedPluginContributes } from './resolvePluginContributions';
import { createMergedContributionRegistry, createResolvedContributionRegistry } from './createResolvedContributionRegistry';
import { buildPluginProjectionV2 } from './projection/v2';

const generatedUiArtifactsManifest = PluginUiArtifactsManifestV2Schema.parse({ version: 2, entries: [{
    artifactId: 'carry', tier: 'reactNative', entry: 'react-native/carry/entry.cjs.bundle',
    files: [{ relativePath: 'react-native/carry/entry.cjs.bundle', digest: `sha256:${'a'.repeat(64)}`, byteSize: 1 }],
    digest: `sha256:${'b'.repeat(64)}`, builtWith: { bundler: 'esbuild', version: '0.25.0' },
    executable: { exports: ['activateSource', 'activateTarget'] }, hostUiApiRange: '^1.0.0',
}] });

function loaded(pluginId: string): LoadedPlugin {
    return {
        pluginId, pluginRootPath: `/plugins/${pluginId}`, manifestPath: `/plugins/${pluginId}/plugin.json`,
        daemonEntryPath: null, devDaemonEntryPath: null, generatedUiArtifactsManifest,
        sourceSpec: { kind: 'path', locator: `/plugins/${pluginId}`, trustPolicy: 'local_trusted', installPolicy: 'link' },
        manifest: normalizePluginManifestV2({ schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Carry',
            runtime: { apiVersion: 1 }, contributes: {
                dragSources: [{ id: 'item', title: 'Item', referenceSchema: { type: 'string' },
                    client: { artifactId: 'carry', exportName: 'activateSource' }, platforms: ['web', 'ios', 'android'] }],
                dropTargets: [{ id: 'item', title: 'Destination', acceptedKinds: ['session', `plugin:${pluginId}/item`],
                    actions: [{ kind: 'host', actionId: 'session.reports_to.set' }],
                    client: { artifactId: 'carry', exportName: 'activateTarget' }, platforms: ['web', 'ios', 'android'] }],
            },
        }),
    };
}

describe('plugin entity drag projection', () => {
    it('withdraws client-only declarations when their executable occurrence is fenced', async () => {
        const pluginId = 'com.acme.carry';
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-carry-'));
        const contributes = createResolvedContributionRegistry(projectLoadedPluginContributes({
            loadResult: { loadedPlugins: [loaded(pluginId)], diagnosticsByPluginId: {} }, provenance: 'first_party',
        }));
        const registry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir, contributes, generation: 1,
            generationAuthority: { commit: null, generations: new Map(), rejectedGenerations: new Map(), isCurrent: async () => true },
        });
        try {
            expect(registry.contributes.dragSources).toHaveLength(1);
            expect(registry.contributes.dropTargets).toHaveLength(1);
            registry.fencePluginConsumers?.([pluginId]);
            expect(registry.contributes.dragSources).toEqual([]);
            expect(registry.contributes.dropTargets).toEqual([]);
            const projection = buildPluginProjectionV2({ registry: registry.contributes, generation: 2 });
            expect(projection.familiesById.dragSources?.entriesById).toEqual({});
            expect(projection.familiesById.dropTargets?.entriesById).toEqual({});
        } finally {
            await registry.dispose();
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

    it('projects admitted client leaves through qualified families and retires their serving occurrence', () => {
        const ids = ['com.acme.one', 'com.acme.two'];
        const loadedPlugins = ids.map(loaded);
        const normalized = buildPluginContributionRegistry({ loadedPlugins });
        expect(normalized).toMatchObject({ dragSources: [{ pluginId: ids[0] }, { pluginId: ids[1] }],
            dropTargets: [{ pluginId: ids[0] }, { pluginId: ids[1] }] });
        const inputs = projectLoadedPluginContributes({ loadResult: { loadedPlugins, diagnosticsByPluginId: {} }, provenance: 'first_party' });
        const occurrenceIdsByPluginId = Object.fromEntries(ids.map(id => [id, createPluginRuntimeOccurrenceId(id)]));
        const registry = createMergedContributionRegistry({ ...inputs, occurrenceIdsByPluginId }, { agents: [], providers: [] });
        const projection = buildPluginProjectionV2({ registry, generation: 1, pluginUiHostRuntime: {
            reactNativeBundles: { hostRuntime: { hostUiApiVersion: '1.0.0', platform: 'web' } },
        } });
        expect(PluginProjectionV2Schema.safeParse(projection).success).toBe(true);
        for (const family of ['dragSources', 'dropTargets'] as const) {
            expect(Object.keys(projection.familiesById[family]?.entriesById ?? {})).toEqual(ids.map(id => `${id}/item`));
            expect(projection.familiesById[family]?.entriesById[`${ids[0]}/item`]).toMatchObject({
                pluginId: ids[0], pluginVersion: '1.0.0', occurrenceId: occurrenceIdsByPluginId[ids[0]!],
                definition: { id: 'item', client: { artifactId: 'carry', exportName: family === 'dragSources' ? 'activateSource' : 'activateTarget' } },
            });
            expect(projection.familiesById.pluginUi?.entriesById[`reactNativeBundle:${ids[0]}:${family}/item`]).toMatchObject({
                generatedOwnerKind: 'clientContribution', artifactGraph: generatedUiArtifactsManifest.entries[0],
                entry: { exportName: family === 'dragSources' ? 'activateSource' : 'activateTarget' }, runtime: { state: 'loadable' },
            });
        }
        const retired = buildPluginProjectionV2({ registry: createResolvedContributionRegistry({ ...inputs, occurrenceIdsByPluginId: {} }), generation: 2 });
        expect(retired.familiesById.dragSources?.entriesById).toEqual({});
        expect(retired.familiesById.dropTargets?.entriesById).toEqual({});
        expect(retired.familiesById.pluginUi?.entriesById).toEqual({});
    });
});
