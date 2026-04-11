// @ts-check

/**
 * `gh release edit --target <commitish>` is forwarded to the GitHub Releases API as
 * `target_commitish`, which rejects raw commit SHAs. Keep release targeting driven
 * by the tag ref itself and only edit title/notes here.
 *
 * @param {{ tag: string; title: string; notes: string }} input
 * @returns {string[]}
 */
export function buildRollingReleaseEditArgs(input) {
  const tag = String(input.tag ?? '').trim();
  const title = String(input.title ?? '').trim();
  const notes = String(input.notes ?? '');

  if (!tag) throw new Error('tag is required');
  if (!title) throw new Error('title is required');

  return ['release', 'edit', tag, '--title', title, '--notes', notes];
}
