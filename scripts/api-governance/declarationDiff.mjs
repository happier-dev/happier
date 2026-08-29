function normalizeHeading(heading) {
  return heading.slice(4).replaceAll('`', '');
}

function declarationBlocks(contents) {
  const blocks = new Map();
  let heading;
  let lines = [];
  const commit = () => {
    if (heading !== undefined) blocks.set(normalizeHeading(heading), lines.join('\n'));
  };
  for (const line of contents.split('\n')) {
    if (line.startsWith('### `')) {
      commit();
      heading = line;
      lines = [line];
      continue;
    }
    if (heading !== undefined) lines.push(line);
  }
  commit();
  return blocks;
}

/**
 * Classifies every declaration block responsible for a report drift. These are
 * complete mechanical facts; compatibility remains owned by the release
 * comparator and human review.
 */
export function classifyDeclarationDiff(previousContents, nextContents) {
  const previous = declarationBlocks(previousContents ?? "");
  const next = declarationBlocks(nextContents ?? "");
  const added = [];
  const removed = [];
  const changed = [];

  for (const heading of next.keys()) {
    if (!previous.has(heading)) added.push(heading);
    else if (previous.get(heading) !== next.get(heading)) changed.push(heading);
  }
  for (const heading of previous.keys()) {
    if (!next.has(heading)) removed.push(heading);
  }
  const sort = (values) => Object.freeze(values.sort((left, right) => left.localeCompare(right)));
  return Object.freeze({ added: sort(added), removed: sort(removed), changed: sort(changed) });
}

/** Backwards-compatible combined drift identity list for ordinary no-drift presentation. */
export function summarizeDeclarationDiff(previousContents, nextContents) {
  const classified = classifyDeclarationDiff(previousContents, nextContents);
  return Object.freeze(
    [...classified.added, ...classified.removed, ...classified.changed]
      .sort((left, right) => left.localeCompare(right)),
  );
}

/**
 * Bounds a complete changed-block identity list for human display. A truncated
 * sample always carries a label naming the unshown remainder, so bounded log
 * output can never be mistaken for the complete fact set.
 */
export function renderDeclarationDiffSample(changedBlocks, limit = 5, label = 'changed declaration blocks') {
  const sample = changedBlocks.slice(0, limit);
  const remaining = changedBlocks.length - sample.length;
  return Object.freeze(remaining > 0
    ? [...sample, `… and ${remaining} more ${label} (${changedBlocks.length} total)`]
    : [...sample]);
}
