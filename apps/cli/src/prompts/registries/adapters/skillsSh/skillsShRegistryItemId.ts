type SkillsShRegistryItemRef = Readonly<{
  source: string;
  skillId: string;
}>;

import { normalizeSkillsShCatalogRef } from './skillsShCatalogValidation';

export function buildSkillsShRegistryItemId(sourceId: string, ref: SkillsShRegistryItemRef): string {
  const payload = Buffer.from(JSON.stringify(ref), 'utf8').toString('base64url');
  return `${sourceId}:${payload}`;
}

export function readSkillsShRegistryItemRef(sourceId: string, itemId: string): SkillsShRegistryItemRef | null {
  const prefix = `${sourceId}:`;
  if (!itemId.startsWith(prefix)) return null;
  const encodedPayload = itemId.slice(prefix.length).trim();
  if (!encodedPayload) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (typeof parsed.source !== 'string' || typeof parsed.skillId !== 'string') return null;
    return normalizeSkillsShCatalogRef({
      source: parsed.source,
      skillId: parsed.skillId,
    });
  } catch {
    return null;
  }
}
