function normalizePath(p) {
  return String(p ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function commonPrefixParts(partsList) {
  if (!partsList.length) return [];
  const first = partsList[0];
  let n = first.length;
  for (const parts of partsList.slice(1)) {
    n = Math.min(n, parts.length, n);
    for (let i = 0; i < n; i += 1) {
      if (parts[i] !== first[i]) {
        n = i;
        break;
      }
    }
  }
  return first.slice(0, n);
}

function pathPrefixLabel(parts, { maxDepth = 4 } = {}) {
  const depth = Math.min(parts.length, Math.max(1, maxDepth));
  return parts.slice(0, depth).join('/');
}

function groupByPrefix(paths, depth) {
  const groups = new Map();
  for (const p of paths) {
    const parts = normalizePath(p).split('/').filter(Boolean);
    const key = parts.slice(0, Math.max(1, Math.min(depth, parts.length))).join('/');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  return groups;
}

/**
 * Plan review slices that:
 * - cover every changed path exactly once
 * - keep each slice at <= maxFiles where possible
 * - prefer directory-prefix grouping (better reviewer context) over raw batching
 *
 * The output is intended for "HEAD-sliced" review: the reviewer gets a focused diff
 * while still having access to the full repo code at HEAD.
 */
export function planPathSlices({ changedPaths, maxFiles = 300, maxPrefixDepth = 6 } = {}) {
  const unique = Array.from(new Set((Array.isArray(changedPaths) ? changedPaths : []).map(normalizePath))).filter(Boolean);
  unique.sort();
  if (!unique.length) return [];

  const limit = Number.isFinite(maxFiles) && maxFiles > 0 ? Math.floor(maxFiles) : 300;
  if (unique.length <= limit) {
    const parts = unique.map((p) => p.split('/').filter(Boolean));
    const prefix = commonPrefixParts(parts);
    return [
      {
        label: prefix.length ? `${pathPrefixLabel(prefix, { maxDepth: 3 })}/` : 'repo/',
        paths: unique,
      },
    ];
  }

  // First pass: top-level directories (plus root files).
  const topGroups = groupByPrefix(unique, 1);

  const slices = [];
  const pushSlice = (label, paths) => {
    const normalized = Array.from(new Set(paths.map(normalizePath))).filter(Boolean).sort();
    if (!normalized.length) return;
    slices.push({ label, paths: normalized });
  };

  for (const [top, paths] of topGroups.entries()) {
    if (paths.length <= limit) {
      pushSlice(top.includes('/') ? top : `${top}/`, paths);
      continue;
    }

    // Iteratively refine prefix depth within this group until all chunks are <= limit.
    let pending = [{ label: top, paths }];
    for (let depth = 2; depth <= maxPrefixDepth && pending.some((x) => x.paths.length > limit); depth += 1) {
      const next = [];
      for (const item of pending) {
        if (item.paths.length <= limit) {
          next.push(item);
          continue;
        }
        const groups = groupByPrefix(item.paths, depth);
        if (groups.size <= 1) {
          next.push(item);
          continue;
        }
        for (const [k, v] of groups.entries()) {
          next.push({ label: k, paths: v });
        }
      }
      pending = next;
    }

    // Final pass: pack refined groups into <=limit windows (greedy, stable order).
    pending.sort((a, b) => a.label.localeCompare(b.label));
    let bucket = [];
    let bucketCount = 0;
    let bucketLabelParts = [];
    const flush = () => {
      if (!bucket.length) return;
      const parts = commonPrefixParts(bucketLabelParts);
      const label = parts.length ? `${pathPrefixLabel(parts, { maxDepth: 4 })}/` : `${top}/`;
      pushSlice(label, bucket);
      bucket = [];
      bucketCount = 0;
      bucketLabelParts = [];
    };

    for (const g of pending) {
      const n = g.paths.length;
      if (n > limit) {
        // Fall back to raw batching for truly massive groups (rare).
        flush();
        for (let i = 0; i < g.paths.length; i += limit) {
          const batch = g.paths.slice(i, i + limit);
          pushSlice(`${g.label}/`, batch);
        }
        continue;
      }
      if (bucketCount + n > limit) {
        flush();
      }
      bucket.push(...g.paths);
      bucketCount += n;
      bucketLabelParts.push(g.label.split('/').filter(Boolean));
    }
    flush();
  }

  // Stable ordering helps humans follow progress.
  slices.sort((a, b) => a.label.localeCompare(b.label));
  return slices;
}

