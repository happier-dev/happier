import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { PluginProjectionV2Schema } from '@happier-dev/protocol';
import { loadPluginsFromState } from '@/plugins/discovery/load/installed';
import { PluginStateFileV1Schema } from '@/plugins/store/state';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { projectLoadedPluginContributes } from './fullProjection';
import { createResolvedContributionRegistry } from './createResolvedContributionRegistry';
import { buildPluginProjectionV2 } from './projection/v2';

describe('packaged skill declarations', () => {
  it('projects public declarations without activation and retires disabled or uninstalled skills', async () => {
    const pluginId = 'com.acme.skills';
    const authored = definePlugin({ id: pluginId, version: '1.0.0', displayName: 'Acme skills',
      entrypoints: { daemon: './daemon.mjs' },
      skills: { review: { directory: './resources/skills/review' } },
    });
    expect(authored.manifest.contributes?.skills).toEqual([{ id: 'review', directory: './resources/skills/review' }]);
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-skills-'));
    onTestFinished(() => rm(pluginRoot, { recursive: true, force: true }));
    await mkdir(join(pluginRoot, '.happier-plugin'));
    await mkdir(join(pluginRoot, 'resources/skills/review'), { recursive: true });
    const manifestPath = join(pluginRoot, '.happier-plugin/plugin.json');
    await writeFile(manifestPath, JSON.stringify(authored.manifest));
    await writeFile(join(pluginRoot, 'daemon.mjs'), 'throw new Error("Declaration discovery must be inert");\n');
    await writeFile(join(pluginRoot, 'resources/skills/review/SKILL.md'), '---\nname: review\ndescription: Review a change\n---\nReview the change.\n');
    const state = PluginStateFileV1Schema.parse({ t: 'happier_plugin_state_v1', schemaVersion: 1, plugins: {
      [pluginId]: {
        source: { kind: 'path', locator: pluginRoot, trustPolicy: 'local_trusted', installPolicy: 'link', resolvedPath: pluginRoot, manifestPath },
        compatibility: { status: 'compatible', diagnostics: [] },
        install: { mode: 'link', manifestVersion: '1.0.0', installedPath: null }, state: { enabled: true },
      },
    } });
    const occurrenceId = createPluginRuntimeOccurrenceId(pluginId);
    const registryFor = async (input: typeof state) => createResolvedContributionRegistry({
      ...projectLoadedPluginContributes({ loadResult: await loadPluginsFromState(input), provenance: 'external' }),
      occurrenceIdsByPluginId: { [pluginId]: occurrenceId },
    });
    const registry = await registryFor(state);
    expect(registry.skills).toMatchObject([{ pluginId, pluginName: 'Acme skills', pluginRootPath: pluginRoot,
      identity: { pluginId, localId: 'review' }, definition: { id: 'review', directory: './resources/skills/review' } }]);
    const project = (current: typeof registry) => PluginProjectionV2Schema.parse(buildPluginProjectionV2({ registry: current, generation: 1 }));
    const projection = project(registry);
    expect(projection.familiesById.skills?.entriesById[`${pluginId}/review`]).toMatchObject({
      id: `${pluginId}/review`, pluginId, occurrenceId,
    });
    expect(PluginProjectionV2Schema.safeParse({ ...projection, familiesById: { ...projection.familiesById,
      skills: { family: 'skills', entriesById: { wrong: {
        ...projection.familiesById.skills?.entriesById[`${pluginId}/review`], id: 'wrong',
      } } },
    } }).success).toBe(false);
    const installed = state.plugins[pluginId]!;
    const disabled = await registryFor({ ...state, plugins: { [pluginId]: { ...installed, state: { enabled: false } } } });
    expect(disabled.skills).toEqual([]);
    expect(project(disabled).familiesById.skills?.entriesById).toEqual({});
    expect((await registryFor({ ...state, plugins: {} })).skills).toEqual([]);
    expect((await registryFor(state)).skills).toEqual(registry.skills);
  });
});
