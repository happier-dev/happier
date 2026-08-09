/**
 * Pi session tree-walk helpers, ported from pi's own SessionManager
 * (dist/core/session-manager.js: buildSessionPath, buildContextEntries, _buildIndex).
 *
 * Pi session files are JSONL trees keyed by `id`/`parentId`. The "active branch" is the path
 * from the current leaf to the root, folded at the latest compaction entry. These helpers
 * reproduce pi's own active-context resolution so direct-session import matches what a resumed
 * pi session actually sees — not a second divergent tree resolver.
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
  if (leafId) {
    leaf = index.get(leafId);
  }
  leaf ??= nonHeaderEntries(entries).at(-1);
  if (!leaf) return [];

  const path: PiSessionEntry[] = [];
  let current: PiSessionEntry | undefined = leaf;
  while (current) {
    path.push(current);
    current = current.parentId ? index.get(current.parentId) : undefined;
  }
  path.reverse();
  return path;
}

/**
 * Build the compaction-aware active entry list. Mirrors pi's `buildContextEntries`:
 * 1. take the leaf -> root path;
 * 2. find the latest compaction entry on it;
 * 3. if none, return the whole path;
 * 4. otherwise return [compaction, …entries from firstKeptEntryId up to (not incl.) compaction,
 *    …entries after compaction], dropping older summarized entries.
 *
 * Note: pi's installed SessionManager honors `firstKeptEntryId` only; it does not expand
 * `retainedTail`. This port matches that behavior.
 */
export function buildContextEntries(
  entries: readonly PiSessionEntry[],
  leafId?: string | null,
): PiSessionEntry[] {
  const path = buildSessionPath(entries, leafId);
  let compaction: PiSessionEntry | null = null;
  for (const entry of path) {
    if (entry.type === 'compaction') {
      compaction = entry;
    }
  }
  if (!compaction) {
    return path;
  }
  const compactionEntry = compaction;
  const compactionIdx = path.findIndex((entry) => entry.id === compactionEntry.id);
  if (compactionIdx < 0) {
    return path;
  }

  const contextEntries: PiSessionEntry[] = [compactionEntry];
  let foundFirstKept = false;
  for (let i = 0; i < compactionIdx; i += 1) {
    const entry = path[i]!;
    if (entry.id === compactionEntry.firstKeptEntryId) {
      foundFirstKept = true;
    }
    if (foundFirstKept) {
      contextEntries.push(entry);
    }
  }
  contextEntries.push(...path.slice(compactionIdx + 1));
  return contextEntries;
}
