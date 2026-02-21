// @ts-check

/**
 * @param {{ tag: string; title: string; notes: string; targetSha: string }} input
 * @returns {string[]}
 */
export function buildRollingReleaseEditArgs(input) {
  const tag = String(input.tag ?? '').trim();
  const title = String(input.title ?? '').trim();
  const notes = String(input.notes ?? '');
  const targetSha = String(input.targetSha ?? '').trim();

  if (!tag) throw new Error('tag is required');
  if (!title) throw new Error('title is required');
  if (!targetSha) throw new Error('targetSha is required');

  return ['release', 'edit', tag, '--title', title, '--notes', notes, '--target', targetSha];
}

