import { mkdir, mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { pluginSkillIdV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { readSkillLibraryCatalog } from '@happier-dev/protocol/prompts/library/skills/readSkillLibraryCatalog';
import { readReadOnlySkillContentV1 } from '@happier-dev/protocol/prompts/library/promptBundleSchemas';
import { readSkillInLibrary, type PromptLibraryArtifactStore } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import { createSkillActionExecuteV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionOperations';
import { SKILL_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { SkillReadResultV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillReadV1';
import { StoredPromptLibraryRecordV1Schema, type PromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { mutateSkillRulesV1, type SkillRulesActionPortV1 } from '@happier-dev/protocol/prompts/library/skillRulesActionsV1';
import { resolveSessionCapabilitiesV1 } from '@happier-dev/protocol/reach/resolveSessionCapabilitiesV1';
import { loadPluginsFromState } from '@/plugins/discovery/load/installed';
import { PluginStateFileV1Schema } from '@/plugins/store/state';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { buildPluginProjectionV2 } from '@/plugins/projection/registry/projection/v2';
import { prepareSessionSkillPlan } from '../runtime/prepareSessionSkillPlan';
import { createSkillStore } from '../store/skillStore';
import { readPluginSkills } from './readPluginSkills';
import { seedPluginSkillDefaults } from './seedPluginSkillDefaults';

describe('plugin library skills', () => {
  it('declares, projects, lists, reads and delivers, retaining inert reach through disable and removal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-skills-runtime-composed-'));
    const pluginId = 'com.acme.skills', pluginRoot = join(root, 'plugin');
    const manifestPath = join(pluginRoot, '.happier-plugin/plugin.json');
    const author = definePlugin({ id: pluginId, version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
      skills: { check: { directory: './resources/skills/check' } } });
    await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
    await mkdir(join(pluginRoot, 'resources/skills/check'), { recursive: true });
    await writeFile(manifestPath, JSON.stringify(author.manifest));
    await writeFile(join(pluginRoot, 'daemon.mjs'), 'throw new Error("Discovery must be inert");');
    await writeFile(join(pluginRoot, 'resources/skills/check/SKILL.md'), '---\nname: check\ndescription: Check a project\nuser-invocable: false\n---\nCheck instructions');
    await writeFile(join(pluginRoot, 'resources/skills/check/check.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const state = PluginStateFileV1Schema.parse({ t: 'happier_plugin_state_v1', schemaVersion: 1, plugins: { [pluginId]: {
      source: { kind: 'path', locator: pluginRoot, trustPolicy: 'local_trusted', installPolicy: 'link', resolvedPath: pluginRoot, manifestPath },
      compatibility: { status: 'compatible', diagnostics: [] }, install: { mode: 'link', manifestVersion: '1.0.0', installedPath: null }, state: { enabled: true },
    } } });
    const skillId = pluginSkillIdV1({ pluginId, localId: 'check' });
    let record: Extract<PromptLibraryRecordV1, { key: 'skill-rules' }> = { key: 'skill-rules', value: { v: 1, rules: [] } };
    let revision = 1;
    const store = createSkillStore({ happyHomeDir: join(root, 'home') });
    const artifacts = { list: async () => ({ items: [], coverage: 'complete' as const }), read: async () => null };
    const project = async (enabled: boolean | null, install = false) => {
      const entry = state.plugins[pluginId]!;
      const registry = createResolvedContributionRegistry({ ...projectLoadedPluginContributes({
        loadResult: await loadPluginsFromState({ ...state, plugins: enabled === null ? {} : { [pluginId]: { ...entry, state: { enabled } } } }),
        provenance: 'external' }), occurrenceIdsByPluginId: { [pluginId]: createPluginRuntimeOccurrenceId(pluginId) } });
      const projection = PluginProjectionV2Schema.parse(buildPluginProjectionV2({ registry, generation: 1 }));
      const skills = await readPluginSkills(undefined, undefined, registry);
      const names = await readSkillLibraryCatalog({ ...artifacts, readPluginSkills: async () => skills });
      const port: SkillRulesActionPortV1 = { serverId: 'home', assertCurrent() {}, matchesServerId: id => id === 'home',
        readCatalog: async () => ({ catalog: { status: 'ready', rows: [{ record, revision }], tombstones: [], diagnostics: [] } }),
        listSkills: async () => names, ruleWriteContext: () => ({ nowMs: 1, newId: () => 'plugin-default' }),
        writeRecord: async input => {
          if (input.expectedRevision !== revision) return { status: 'conflict', revision };
          const next = StoredPromptLibraryRecordV1Schema.parse(input.record);
          if (next.key !== 'skill-rules') throw new Error('Wrong test row');
          record = next; revision++;
          return { status: 'updated', revision };
        } };
      if (install) await seedPluginSkillDefaults({ skills, port });
      const selected = resolveSessionCapabilitiesV1({ context: { machineId: 'machine', machinePlatform: 'posix', directory: root, projectKey: null, agentId: 'test' },
        skills: { items: names.map(item => ({ skillId: item.id, name: item.name })), rules: record.value.rules }, mcp: null, selection: {}, agentAcceptsUserMcp: false }).skills;
      const prepared = await prepareSessionSkillPlan({ artifacts, inventory: [], pluginSkills: skills, selected,
        agentSkills: { delivery: 'session_dir', nativeDisable: 'supported', liveReload: 'supported' }, agentHasActionChannel: true,
        directory: root, home: root, assertCurrent: async () => {} });
      const delivery = await store.ensureSkillSessionDir({ ownerKey: 'session', nativeDisables: [],
        items: prepared.plan.items.filter(item => item.state === 'delivered').map(item => ({ skillId: item.skillId,
          name: item.name, digest: item.digest, files: prepared.contents.get(item.skillId)!.body.entries })) });
      return { registry, projection, skills, names, prepared, delivery, port };
    };
    try {
      const active = await project(true, true);
      expect(active.projection.familiesById.skills?.entriesById[`${pluginId}/check`]).toBeDefined();
      expect(active.names).toContainEqual({ id: skillId, name: 'check' });
      expect(readReadOnlySkillContentV1(skillId, active.skills)).toMatchObject({ provenance: { kind: 'plugin', pluginId }, frontmatter: { userInvocable: false } });
      // Artifact persistence is the only substituted boundary; public Actions,
      // read projection, reach, declarations and disk delivery remain real.
      const actionStore: PromptLibraryArtifactStore = { list: async () => ({ coverage: 'complete', items: [] }), read: async () => null,
        create: async () => { throw new Error('Unexpected Artifact write'); },
        update: async () => { throw new Error('Unexpected Artifact write'); }, delete: async () => { throw new Error('Unexpected Artifact write'); } };
      const actions = createSkillActionExecuteV1({ store: actionStore, skillRules: active.port,
        readPluginSkills: async () => active.skills, randomId: () => 'unused', includeInSession: async () => ({ ok: true }) });
      expect(SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.list'].parse(await actions('skills.list', {}, { surface: 'ui' })).items)
        .toContainEqual(expect.objectContaining({ skillId, name: 'check', provenance: active.skills[0]!.provenance, userInvocable: false }));
      expect(SkillReadResultV1Schema.parse(await readSkillInLibrary({ store: actionStore, pluginSkills: active.skills,
        request: { skillId, file: 'SKILL.md' } }))).toMatchObject({ skillId, provenance: active.skills[0]!.provenance,
          file: { path: 'SKILL.md' } });
      expect(await readFile(join(active.delivery.skillsRoot, 'check/check.sh'), 'utf8')).toContain('exit 0');
      for (const enabled of [false, null] as const) {
        const retired = await project(enabled);
        expect(retired.skills).toEqual([]);
        expect(retired.names.some(item => item.id === skillId)).toBe(false);
        expect(retired.prepared.plan.items.some(item => item.skillId === skillId)).toBe(false);
        await expect(readFile(join(retired.delivery.skillsRoot, 'check/SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(record.value.rules).toHaveLength(1);
      }
      const restored = await project(true);
      await expect(readPluginSkills(undefined, [skillId], {
        skills: restored.registry.skills,
      })).rejects.toMatchObject({ code: 'skill_content_unavailable' });
      expect(restored.prepared.plan.items).toContainEqual(expect.objectContaining({ skillId, state: 'delivered' }));
      expect(await mutateSkillRulesV1(restored.port, { items: [{ skillId }], change: { kind: 'write',
        write: { place: { t: 'allMachines' }, state: 'off' } } })).toMatchObject({ ok: true });
      await seedPluginSkillDefaults({ skills: restored.skills, port: restored.port });
      expect((await project(true)).prepared.plan.items).toContainEqual(expect.objectContaining({ skillId, state: 'off' }));
      await rm(join(pluginRoot, 'resources/skills/check/SKILL.md'));
      await expect(readPluginSkills(undefined, [skillId], restored.registry)).rejects.toMatchObject({ code: 'skill_content_unavailable' });
      await writeFile(join(root, 'outside.md'), '---\nname: outside\n---\nPrivate content');
      await symlink(join(root, 'outside.md'), join(pluginRoot, 'resources/skills/check/SKILL.md'));
      await expect(readPluginSkills(undefined, [skillId], restored.registry)).rejects.toThrow('symlinks are not supported');
      await rm(join(pluginRoot, 'resources/skills/check'), { recursive: true });
      await expect(readPluginSkills(undefined, [skillId], restored.registry)).rejects.toMatchObject({ code: 'skill_content_unavailable' });
    } finally {
      await store.releaseSkillSessionDirs('session');
      await store.collectSkillCache({ libraryDigests: [] });
      await rm(root, { recursive: true, force: true });
    }
  });
});
