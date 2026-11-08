import type { SkillLibraryItemV1 } from './skillLibraryItemV1.js';

export function renderSkillReadGuidanceV1(sessionId?: string): string {
  const session = sessionId ? ` and sessionId ${JSON.stringify(sessionId)}` : ' and the current sessionId';
  return `When a request matches a skill supplied by Happier, use skills_read with its name${session} to load its instructions and supporting files on demand. This also applies when a SKILL.md path is advertised: use the returned instructions directly instead of reading that path through the shell.`;
}

/** Metadata only; bodies remain behind the session-bound skill read Action. */
export function renderSkillIndexV1(items: readonly SkillLibraryItemV1[], sessionId?: string): string {
  const lines = items.filter(item => !item.disableModelInvocation).map(item => `${item.name}: ${item.description}`);
  if (lines.length === 0) return '';
  return `${lines.join('\n')}\n${renderSkillReadGuidanceV1(sessionId)}`;
}
