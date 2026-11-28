import { readSkillBundleContentV1, type SkillBundleContentV1 } from './promptBundleShapeV1.js';
import { FIRST_PARTY_SKILLS_V1, type ReadOnlySkillV1 } from './skills/firstPartySkillsV1.js';
import { readSkillFrontmatterV1, type ReadOnlySkillProvenanceV1 } from './skills/skillLibraryItemV1.js';

export * from './promptBundleShapeV1.js';

/** Bundled content passes the same validation/digest owner as stored skill content. */
export function readReadOnlySkillContentV1(skillId: string, pluginSkills: readonly ReadOnlySkillV1[] = []):
  (SkillBundleContentV1 & Readonly<{ provenance: ReadOnlySkillProvenanceV1 }>) | null {
  const skill = FIRST_PARTY_SKILLS_V1.find(item => item.skillId === skillId) ?? pluginSkills.find(item => item.skillId === skillId);
  if (!skill) return null;
  const content = readSkillBundleContentV1({ header: { v: 1, kind: 'prompt_bundle.v2',
    title: skill.skillId, bundleSchemaId: 'skills.skill_md_v1' },
    body: JSON.stringify({ v: 1, entries: skill.files, createdAtMs: 0, updatedAtMs: 0 }) });
  if (!content) throw new Error('invalid_read_only_skill');
  // Packaged declarations are current inputs, not retained 0.2 Artifact Markdown.
  const frontmatter = readSkillFrontmatterV1(content.skillMd);
  if (!frontmatter.name) throw new Error('invalid_read_only_skill');
  return { ...content, frontmatter: { ...frontmatter, name: frontmatter.name }, provenance: skill.provenance };
}
