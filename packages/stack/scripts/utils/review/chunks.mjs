export async function planCommitChunks({ baseCommit, commits, maxFiles, countFilesBetween }) {
  if (!Array.isArray(commits)) throw new Error('[review] planCommitChunks: commits must be an array');
  const max = Number(maxFiles);
  if (!Number.isFinite(max) || max <= 0) throw new Error('[review] planCommitChunks: maxFiles must be a positive number');
  if (typeof countFilesBetween !== 'function') throw new Error('[review] planCommitChunks: countFilesBetween must be a function');

  const list = commits.map((c) => String(c ?? '').trim()).filter(Boolean);
  if (!list.length) return [];

  const chunks = [];
  let base = String(baseCommit ?? '').trim();
  if (!base) throw new Error('[review] planCommitChunks: baseCommit is required');
  let startIndex = 0;

  while (startIndex < list.length) {
    let lo = startIndex;
    let hi = list.length - 1;
    let bestIndex = -1;
    let bestCount = -1;

    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const head = list[mid];
      // eslint-disable-next-line no-await-in-loop
      const n = await countFilesBetween({ base, head });
      if (!Number.isFinite(n) || n < 0) throw new Error('[review] planCommitChunks: countFilesBetween returned invalid count');

      if (n <= max) {
        bestIndex = mid;
        bestCount = n;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    // If even the smallest chunk exceeds the limit, emit a single over-limit chunk so the caller can decide what to do.
    if (bestIndex === -1) {
      const head = list[startIndex];
      // eslint-disable-next-line no-await-in-loop
      const n = await countFilesBetween({ base, head });
      chunks.push({ base, head, fileCount: n, overLimit: true });
      base = head;
      startIndex += 1;
      continue;
    }

    const head = list[bestIndex];
    chunks.push({ base, head, fileCount: bestCount, overLimit: false });
    base = head;
    startIndex = bestIndex + 1;
  }

  return chunks;
}
