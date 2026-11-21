import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isPluginSkillIdV1, pluginSkillIdV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import type { ReadOnlySkillV1 } from '@happier-dev/protocol/prompts/library/skills/firstPartySkillsV1';
import { projectPromptBundleActionEntriesV1, readReadOnlySkillContentV1, validatePromptBundleBodyV1AgainstSchemaId } from '@happier-dev/protocol/prompts/library/promptBundleSchemas';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { collectPromptBundleDirectoryEntries } from '@/prompts/assets/shared/promptBundleDirectory';
import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';

export type PluginLibrarySkill = ReadOnlySkillV1 & Readonly<{ provenance: Readonly<{ kind: 'plugin'; pluginId: string; occurrenceId: string }> }>;
/** The caller's authoritative registry supplies ownership; the bundle owner reads package bytes. */
export async function readPluginSkills(
  signal: AbortSignal | undefined,
  skillIds: readonly string[] | undefined,
  registry: Pick<ResolvedContributionRegistry, 'skills' | 'occurrenceIdsByPluginId'>,
  options?: Readonly<{ availableOnly: boolean }>,
): Promise<readonly PluginLibrarySkill[]> {
  if (skillIds && !skillIds.some(isPluginSkillIdV1)) return [];
  const skills: PluginLibrarySkill[] = [];
  for (const declaration of registry.skills ?? []) {
    if (skillIds && !skillIds.includes(pluginSkillIdV1(declaration.identity))) continue;
    signal?.throwIfAborted();
    try {
      const occurrenceId = registry.occurrenceIdsByPluginId?.[declaration.pluginId];
      if (!occurrenceId) throw new Error('Plugin skill occurrence unavailable');
      const root = await realpath(declaration.pluginRootPath);
      const directory = await realpath(resolve(root, declaration.definition.directory));
      if (!isCanonicalAbsolutePathInsideRoot(root, directory)) {
        throw Object.assign(new Error('Plugin skill directory escapes its package'), { code: 'skill_content_unavailable' });
      }
      const skill: PluginLibrarySkill = { skillId: pluginSkillIdV1(declaration.identity),
        provenance: { kind: 'plugin', pluginId: declaration.pluginId, occurrenceId },
        files: projectPromptBundleActionEntriesV1(collectPromptBundleDirectoryEntries(directory)) };
      const validation = validatePromptBundleBodyV1AgainstSchemaId({ bundleSchemaId: 'skills.skill_md_v1',
        body: { v: 1, entries: [...skill.files], createdAtMs: 0, updatedAtMs: 0 } });
      if (!validation.ok || !readReadOnlySkillContentV1(skill.skillId, [skill])) {
        throw Object.assign(new Error('Plugin skill content unavailable'), { code: 'skill_content_unavailable' });
      }
      skills.push(skill);
    } catch (error) {
      signal?.throwIfAborted();
      if (options?.availableOnly) continue;
      throw Object.assign(error instanceof Error ? error : new Error('Plugin skill content unavailable'), { code: 'skill_content_unavailable' });
    }
  }
  signal?.throwIfAborted();
  return skills;
}
