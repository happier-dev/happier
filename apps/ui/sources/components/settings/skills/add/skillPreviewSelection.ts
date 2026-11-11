import type { SkillInstallPreviewV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { skillSourceIdentityV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';

type Previewed = Pick<SkillInstallPreviewV1, 'path' | 'siblingSkills' | 'inLibrary'> & Partial<Pick<SkillInstallPreviewV1, 'provenance'>>;

/** Upload folders use their path; linked folders use the library owner's source identity. */
export function skillPreviewKey(item: Pick<Previewed, 'path' | 'provenance'>, siblingPath = item.path): string {
  return (item.provenance ? skillSourceIdentityV1(item.provenance, siblingPath) : null) ?? siblingPath;
}

/** Everything previewed that is new starts ticked: the person unticks what they do not want. A held skill is never added again. */
export function tickAllSkillPreviews(items: readonly Previewed[]): ReadonlySet<string> {
  return new Set(items.filter((item) => item.inLibrary === undefined).map(item => skillPreviewKey(item)));
}

/**
 * Ticking a skill ticks the siblings it refers to, so the reference holds once it is added; unticking changes
 * only that skill, and a sibling can be unticked on its own.
 */
export function toggleSkillPreview(
  items: readonly Previewed[],
  ticked: ReadonlySet<string>,
  key: string,
): ReadonlySet<string> {
  const next = new Set(ticked);
  if (next.delete(key)) return next;
  next.add(key);
  const listed = tickAllSkillPreviews(items);
  const item = items.find(item => skillPreviewKey(item) === key);
  if (item) for (const sibling of item.siblingSkills ?? []) {
    const siblingKey = skillPreviewKey(item, sibling.path);
    if (listed.has(siblingKey)) next.add(siblingKey);
  }
  return next;
}

/**
 * What the footer offers when nothing previewed is new: Open for the one held skill, Done (close the dialog) when
 * several are held (an Open would not say which); null while anything can still be added.
 */
export function readAllHeldFooter(
  items: readonly Pick<SkillInstallPreviewV1, 'inLibrary'>[],
): Readonly<{ kind: 'open'; skillId: string }> | Readonly<{ kind: 'done' }> | null {
  const first = items[0]?.inLibrary;
  if (first === undefined || !items.every((item) => item.inLibrary !== undefined)) return null;
  return items.length === 1 ? { kind: 'open', skillId: first } : { kind: 'done' };
}
