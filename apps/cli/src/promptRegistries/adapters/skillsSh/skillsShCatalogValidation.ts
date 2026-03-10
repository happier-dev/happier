const SOURCE_SEGMENT_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;
const SKILL_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,199})$/;

export type SkillsShCatalogRef = Readonly<{
  source: string;
  skillId: string;
}>;

function isValidSourceSegment(value: string): boolean {
  return SOURCE_SEGMENT_PATTERN.test(value);
}

export function isValidSkillsShSource(value: string): boolean {
  const [owner, repo, ...rest] = value.trim().split('/');
  if (rest.length > 0) return false;
  if (!owner || !repo) return false;
  return isValidSourceSegment(owner) && isValidSourceSegment(repo);
}

export function isValidSkillsShSkillId(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('/')) return false;
  if (trimmed.includes('..')) return false;
  return SKILL_ID_PATTERN.test(trimmed);
}

export function normalizeSkillsShCatalogRef(ref: Readonly<{
  source: string;
  skillId: string;
}>): SkillsShCatalogRef | null {
  const source = ref.source.trim();
  const skillId = ref.skillId.trim();
  if (!isValidSkillsShSource(source)) return null;
  if (!isValidSkillsShSkillId(skillId)) return null;
  return { source, skillId };
}
