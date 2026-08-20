/**
 * Pi session tree-walk helpers, aligned with Pi's SessionManager active-branch traversal.
 *
 * Pi session files are JSONL trees keyed by `id`/`parentId`. The "active branch" is the path
 * from the current leaf to the root. Direct-session history uses that complete path; compaction
 * affects Pi's model context but does not remove historical records from the browser.
 *
 * The session header (`type: 'session'`) is not part of the tree and is excluded everywhere.
 */

export interface PiSessionEntry {
  readonly type: string;
  readonly id: string;
  // Optional because the `session` header entry carries no parentId; headers are filtered out of
  // all tree walks before parentId is read.
  readonly parentId?: string | null;
  /** ISO timestamp string on real pi entries. */
  readonly timestamp?: string;
  /** Present on `compaction` entries; the first entry id retained after summarization. */
  readonly firstKeptEntryId?: string;
  readonly [key: string]: unknown;
}

/**
 * Index non-header entries by id (mirrors pi's `buildEntryIndex`, header-excluded).
 */
function indexEntries(entries: readonly PiSessionEntry[]): Map<string, PiSessionEntry> {
  const index = new Map<string, PiSessionEntry>();
  for (const entry of entries) {
    if (entry.type === 'session') continue;
    index.set(entry.id, entry);
  }
  return index;
}

function nonHeaderEntries(entries: readonly PiSessionEntry[]): PiSessionEntry[] {
  return entries.filter((entry) => entry.type !== 'session');
}

/**
 * Resolve the active leaf id on load: the last non-header entry in file order.
 * Mirrors pi's `_buildIndex`, which assigns `leafId` at each iteration so the final entry wins.
 * There is no persisted leaf pointer in the file; this is fully re-derivable from contents.
 */
export function resolveActiveLeafId(entries: readonly PiSessionEntry[]): string | null {
  let leafId: string | null = null;
  for (const entry of entries) {
    if (entry.type === 'session') continue;
    leafId = entry.id;
  }
  return leafId;
}

/**
 * Walk from the leaf to the root via `parentId`, returning the path in root -> leaf order.
 * When `leafId` is omitted, defaults to the last non-header entry (pi's load default).
 * When `leafId` is explicitly `null`, returns `[]` (pi's reset-leaf semantics).
 */
export function buildSessionPath(
  entries: readonly PiSessionEntry[],
  leafId?: string | null,
): PiSessionEntry[] {
  if (leafId === null) return [];
  const index = indexEntries(entries);
  let leaf: PiSessionEntry | undefined;
  if (leafId !== undefined) {
    leaf = index.get(leafId);
    if (!leaf) return [];
  } else {
    leaf = nonHeaderEntries(entries).at(-1);
  }
  if (!leaf) return [];

  const path: PiSessionEntry[] = [];
  const visitedIds = new Set<string>();
  let current: PiSessionEntry | undefined = leaf;
  while (current) {
    if (visitedIds.has(current.id)) break;
    visitedIds.add(current.id);
    path.push(current);
    current = current.parentId ? index.get(current.parentId) : undefined;
  }
  path.reverse();
  return path;
}
