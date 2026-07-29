import {
  isRecord,
  parseTimestampMs,
  readString,
} from '@happier-dev/plugin-sdk/experimental/sessions/fileStores';

const PI_V3_ENTRY_TYPES = new Set([
  'branch_summary',
  'compaction',
  'custom',
  'custom_message',
  'file',
  'label',
  'leaf',
  'message',
  'model_change',
  'session_info',
  'thinking_level_change',
]);

export type PiV3SessionHeader = Readonly<{
  version: 3;
  sessionId: string;
  cwd: string | null;
  createdAtMs: number | null;
}>;

export type PiV3SessionTreeEntry = Readonly<{
  id: string;
  parentId: string | null;
  type: string;
  timestampMs: number | null;
  knownType: boolean;
  record: Readonly<Record<string, unknown>>;
}>;

export type PiV3SessionTreeFold = Readonly<{
  header: PiV3SessionHeader | null;
  activeLeafId: string | null;
  activeBranch: readonly PiV3SessionTreeEntry[];
  diagnostics: Readonly<{
    duplicateEntryIds: readonly string[];
    missingParentIds: readonly string[];
    cycleEntryIds: readonly string[];
  }>;
}>;

function readPiV3Header(record: unknown): PiV3SessionHeader | null {
  if (!isRecord(record) || record.type !== 'session' || record.version !== 3) return null;
  const sessionId = readString(record.id);
  if (!sessionId) return null;
  return {
    version: 3,
    sessionId,
    cwd: readString(record.cwd),
    createdAtMs: parseTimestampMs(record.timestamp),
  };
}

function readTreeEntry(record: unknown): PiV3SessionTreeEntry | null {
  if (!isRecord(record)) return null;
  const type = readString(record.type);
  const id = readString(record.id);
  if (!type || type === 'session' || !id) return null;
  if (record.parentId !== null && typeof record.parentId !== 'string') return null;
  const parentId = record.parentId === null ? null : readString(record.parentId);
  if (record.parentId !== null && !parentId) return null;
  return {
    id,
    parentId,
    type,
    timestampMs: parseTimestampMs(record.timestamp),
    knownType: PI_V3_ENTRY_TYPES.has(type),
    record,
  };
}

/**
 * Folds already-scanned Pi JSONL values into the active root-to-leaf branch.
 * File I/O, JSON parsing, and byte bounds stay with the canonical SDK scanner.
 */
export function foldPiV3SessionTree(
  records: readonly unknown[],
  options: Readonly<{ activeLeafId?: string | null }> = {},
): PiV3SessionTreeFold {
  const header = records.map(readPiV3Header).find((candidate) => candidate !== null) ?? null;
  const entries = records.flatMap((record) => {
    const entry = readTreeEntry(record);
    return entry ? [entry] : [];
  });
  const byId = new Map<string, PiV3SessionTreeEntry>();
  const duplicateEntryIds = new Set<string>();
  for (const entry of entries) {
    if (byId.has(entry.id)) duplicateEntryIds.add(entry.id);
    byId.set(entry.id, entry);
  }

  const activeLeaf = options.activeLeafId === undefined
    ? entries.at(-1) ?? null
    : options.activeLeafId === null
      ? null
      : byId.get(options.activeLeafId) ?? null;
  const activeBranchNewestFirst: PiV3SessionTreeEntry[] = [];
  const seen = new Set<string>();
  const missingParentIds = new Set<string>();
  const cycleEntryIds = new Set<string>();
  let cursor = activeLeaf;
  while (cursor) {
    if (seen.has(cursor.id)) {
      cycleEntryIds.add(cursor.id);
      break;
    }
    seen.add(cursor.id);
    activeBranchNewestFirst.push(cursor);
    if (cursor.parentId === null) break;
    const parent = byId.get(cursor.parentId) ?? null;
    if (!parent) {
      missingParentIds.add(cursor.parentId);
      break;
    }
    cursor = parent;
  }

  return {
    header,
    activeLeafId: activeLeaf?.id ?? null,
    activeBranch: activeBranchNewestFirst.reverse(),
    diagnostics: {
      duplicateEntryIds: [...duplicateEntryIds].sort(),
      missingParentIds: [...missingParentIds].sort(),
      cycleEntryIds: [...cycleEntryIds].sort(),
    },
  };
}
