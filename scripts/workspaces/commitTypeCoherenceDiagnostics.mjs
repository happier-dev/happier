const messageOf = (row) => JSON.stringify([row.file, row.code, row.text.replace(/\s+/gu, ' ').trim()]);
// Unchanged source positions retain the existing baseline identity even when an imported
// type changes its printed spelling. Replaced positions require message matching below.
const locationOf = (row) => JSON.stringify([row.file, row.line, row.column, row.code]);

function increment(counts, key) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function consume(counts, key) {
  const remaining = counts.get(key) ?? 0;
  if (!remaining) return false;
  counts.set(key, remaining - 1);
  return true;
}

/** Zero-context Git hunks retain unambiguous positions outside replaced/deleted lines. */
export function diagnosticHunks(patch) {
  return [...patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gmu)].map((match) => ({
    oldStart: Number(match[1]), oldCount: Number(match[2] ?? 1),
    newStart: Number(match[3]), newCount: Number(match[4] ?? 1),
  }));
}

/** Compare occurrences, not sets: an additional identical diagnostic is still new. */
export function newDiagnostics(baseRows, headRows, hunksByFile) {
  const located = new Map();
  const ambiguous = new Map();
  for (const row of baseRows) {
    let offset = 0;
    let replaced = false;
    const hunks = hunksByFile.get(row.file) ?? [];
    for (const [index, hunk] of hunks.entries()) {
      if (hunk.oldCount > 0 && row.line >= hunk.oldStart && row.line < hunk.oldStart + hunk.oldCount) {
        // Only this replacement can inherit its ambiguous old diagnostic. A different
        // inserted hunk cannot spend it to hide a newly introduced identical error.
        increment(ambiguous, JSON.stringify([index, messageOf(row)]));
        replaced = true;
        break;
      }
      if (row.line < hunk.oldStart || (hunk.oldCount === 0 && row.line === hunk.oldStart)) break;
      offset += hunk.newCount - hunk.oldCount;
    }
    if (!replaced) increment(located, locationOf({ ...row, line: row.line + offset }));
  }
  // Exact remapped occurrences take priority over ambiguous message matches.
  return headRows.filter(row => !consume(located, locationOf(row))).filter(row => {
    const hunks = hunksByFile.get(row.file) ?? [];
    const index = hunks.findIndex(hunk => hunk.oldCount > 0
      && row.line >= hunk.newStart && row.line < hunk.newStart + hunk.newCount);
    return index < 0 || !consume(ambiguous, JSON.stringify([index, messageOf(row)]));
  });
}
