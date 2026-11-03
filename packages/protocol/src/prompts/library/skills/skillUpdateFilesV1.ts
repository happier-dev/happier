import { decodeBase64, encodeBase64 } from '../../../crypto/base64.js';
import { compareThreeWayTextV1, resolveThreeWayTextV1 } from '../../../diff/threeWayText.js';
import type { SkillFileInputV1, SkillUpdateChoiceV1, SkillUpdateFileV1 } from './skillActionSchemasV1.js';

const text = (file: SkillFileInputV1) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(decodeBase64(file.contentBase64, 'base64'));
function equal(left: SkillFileInputV1 | null, right: SkillFileInputV1 | null) {
  return left === right || left !== null && right !== null && left.contentBase64 === right.contentBase64
    && left.contentKind === right.contentKind && left.unixMode === right.unixMode;
}

/** One file comparison owner for fetched upstream and inline template releases. */
export function compareSkillUpdateFilesV1(mine: readonly SkillFileInputV1[], theirs: readonly SkillFileInputV1[], base?: readonly SkillFileInputV1[]): SkillUpdateFileV1[] {
  const mineByPath = new Map(mine.map(file => [file.path, file]));
  const theirsByPath = new Map(theirs.map(file => [file.path, file]));
  const baseByPath = new Map(base?.map(file => [file.path, file]));
  const paths = [...new Set([...mineByPath.keys(), ...theirsByPath.keys(), ...baseByPath.keys()])].sort();
  return paths.map(path => {
    const left = mineByPath.get(path) ?? null, right = theirsByPath.get(path) ?? null, original = baseByPath.get(path) ?? null;
    return { path, mine: left, theirs: right, changed: !equal(left, right), ...(base ? { base: original } : {}),
      ...(base && left?.contentKind === 'utf8' && right?.contentKind === 'utf8' && (!original || original.contentKind === 'utf8')
        ? { comparison: compareThreeWayTextV1(original ? text(original) : '', text(left), text(right)) } : {}) };
  });
}

export type SkillUpdateFileChoicesV1 = Readonly<{
  choices?: Readonly<Record<string, SkillUpdateChoiceV1>>;
  hunkChoices?: Readonly<Record<string, Readonly<Record<string, SkillUpdateChoiceV1>>>>;
}>;

/** Binary/removal choices stay whole-file; text choices resolve overlaps while retaining disjoint edits. */
export function resolveSkillUpdateFilesV1(files: readonly SkillUpdateFileV1[], input: SkillUpdateFileChoicesV1):
  Readonly<{ ok: true; files: SkillFileInputV1[]; changed: boolean }> | Readonly<{ ok: false; code: 'invalid_update_choice' }> {
  const resolved: SkillFileInputV1[] = [];
  let changed = false;
  const accept = (original: SkillUpdateFileV1, selected: SkillFileInputV1 | null) => {
    changed ||= !equal(original.mine, selected);
    if (selected) resolved.push(selected);
  };
  for (const file of files) {
    const choice = input.choices?.[file.path];
    if (file.base === undefined && choice === 'both' && file.mine?.contentKind === 'utf8' && file.theirs?.contentKind === 'utf8') {
      const comparison = compareThreeWayTextV1('', text(file.mine), text(file.theirs));
      const merged = resolveThreeWayTextV1(comparison, Object.fromEntries(comparison.segments.filter(segment => segment.kind === 'conflict').map(segment => [String(segment.index), 'both'])));
      accept(file, { ...file.mine, contentBase64: encodeBase64(new TextEncoder().encode(merged), 'base64') });
      continue;
    }
    if (file.comparison) {
      const defaults = Object.fromEntries(file.comparison.segments.filter(segment => segment.kind === 'conflict').map(segment => [String(segment.index), choice ?? 'mine']));
      const merged = resolveThreeWayTextV1(file.comparison, { ...defaults, ...input.hunkChoices?.[file.path] });
      const metadata = choice === 'theirs' || choice === undefined && file.mine?.unixMode === file.base?.unixMode ? file.theirs! : file.mine!;
      accept(file, { ...metadata, contentBase64: encodeBase64(new TextEncoder().encode(merged), 'base64') });
      continue;
    }
    if (choice === 'both' || Object.keys(input.hunkChoices?.[file.path] ?? {}).length) return { ok: false, code: 'invalid_update_choice' };
    const selected = choice === 'mine' ? file.mine : choice === 'theirs' ? file.theirs
      : file.base !== undefined && !equal(file.mine, file.base) ? file.mine : file.theirs;
    accept(file, selected);
  }
  return { ok: true, files: resolved, changed };
}
