import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, readFile, readdir, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

// Retired engine schema marker is intentionally local: the replacement must not import
// the deleted replication implementation.
const WORKSPACE_REPLICATION_SCHEMA_VERSION = 1;
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

const LEGACY_DIRECTORY_NAME = 'workspace-replication';
const RETIRED_DIRECTORY_PREFIX = 'workspace-replication.retired-v1-';
const RETIREMENT_MARKER_NAME = 'retirement.json';
const LEGACY_CHILD_DIRECTORIES = new Set(['cas', 'jobs', 'relationships', 'staging']);
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_SCAN_ENTRIES = 2_000;
const MAX_INSTALLATION_ID_LENGTH = 256;

export type WorkspaceSyncLegacyStateInspection = Readonly<
  | { status: 'absent'; path: string }
  | { status: 'legacy_workspace_sync_state_unknown'; path: string; reason: string }
  | {
      status: 'legacy_workspace_sync_state_unsupported';
      classification: 'retired_v1';
      path: string;
      quarantinePath: string;
      schemaVersion: 1;
      inventoryHash: string;
    }
>;

export type InspectRetiredWorkspaceReplicationStateInput = Readonly<{
  activeServerDir: string;
  installationId?: string;
  nowMs?: number;
  randomSuffix?: string;
}>;

type InventoryEntry = Readonly<{ name: string; size: number }>;

function unknown(path: string, reason: string): WorkspaceSyncLegacyStateInspection {
  return { status: 'legacy_workspace_sync_state_unknown', path, reason };
}

function isKnownLockOrTemporaryName(name: string): boolean {
  // These are the lock/temp artifacts emitted by the retired stores. Keep this
  // deliberately narrow: an arbitrary root child must fail closed.
  return /^(?:\.?lock(?:[.-].*)?|.*[.-]lock|(?:\.?tmp|temp)(?:[.-].*)?|.*[.-](?:tmp|temp)(?:[.-].*)?)$/u.test(name);
}

async function readInventory(rootPath: string): Promise<Readonly<{ entries: readonly InventoryEntry[]; hash: string }> | null> {
  const entries = await readdir(rootPath, { withFileTypes: true });
  if (entries.length > MAX_SCAN_ENTRIES) return null;
  const inventory: InventoryEntry[] = [];
  for (const entry of entries) {
    if (entry.name === RETIREMENT_MARKER_NAME) return null;
    if (!LEGACY_CHILD_DIRECTORIES.has(entry.name) && !isKnownLockOrTemporaryName(entry.name)) return null;
    const entryPath = join(rootPath, entry.name);
    const entryStat = await lstat(entryPath).catch(() => null);
    if (!entryStat) return null;
    if (LEGACY_CHILD_DIRECTORIES.has(entry.name) && (!entryStat.isDirectory() || entryStat.isSymbolicLink())) return null;
    if (entryStat.isSymbolicLink()) return null;
    inventory.push({ name: entry.name, size: entryStat.size });
  }
  inventory.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const hash = createHash('sha256').update(JSON.stringify(inventory)).digest('hex');
  return { entries: inventory, hash };
}

async function containsV1Record(directoryPath: string, state: { count: number }, depth = 0): Promise<boolean> {
  if (depth > 8 || state.count >= MAX_SCAN_ENTRIES) return false;
  const entries = await readdir(directoryPath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    state.count += 1;
    if (state.count > MAX_SCAN_ENTRIES) return false;
    const entryPath = join(directoryPath, entry.name);
    const entryStat = await lstat(entryPath).catch(() => null);
    if (!entryStat || entryStat.isSymbolicLink()) return false;
    if (entryStat.isDirectory()) {
      if (await containsV1Record(entryPath, state, depth + 1)) return true;
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.json') || entryStat.size > MAX_RECORD_BYTES) continue;
    const parsed = await readFile(entryPath, 'utf8')
      .then((raw) => JSON.parse(raw) as unknown)
      .catch(() => null);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      && (parsed as Record<string, unknown>).schemaVersion === WORKSPACE_REPLICATION_SCHEMA_VERSION) {
      return true;
    }
  }
  return false;
}

async function hasV1Record(rootPath: string): Promise<boolean> {
  const state = { count: 0 };
  for (const directoryName of LEGACY_CHILD_DIRECTORIES) {
    const directoryPath = join(rootPath, directoryName);
    const directoryStat = await lstat(directoryPath).catch(() => null);
    if (!directoryStat) continue;
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return false;
    if (await containsV1Record(directoryPath, state)) return true;
  }
  return false;
}

function isOwnedAndPrivate(rootStat: Awaited<ReturnType<typeof lstat>>): boolean {
  if (typeof process.getuid === 'function' && rootStat.uid !== process.getuid()) return false;
  // A group/other writable bit means another principal may mutate the state.
  if ((Number(rootStat.mode) & 0o022) !== 0) return false;
  return true;
}

export async function inspectRetiredWorkspaceReplicationState(
  input: InspectRetiredWorkspaceReplicationStateInput,
): Promise<WorkspaceSyncLegacyStateInspection> {
  const activeServerDir = resolve(input.activeServerDir);
  const statePath = join(activeServerDir, LEGACY_DIRECTORY_NAME);
  const initialStat = await lstat(statePath).catch((error: unknown) => {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? null : undefined;
  });
  if (initialStat === null) return { status: 'absent', path: statePath };
  if (!initialStat || !initialStat.isDirectory() || initialStat.isSymbolicLink()) {
    return unknown(statePath, 'not_a_real_directory');
  }

  const canonicalActiveServerDir = await realpathSafe(activeServerDir);
  const canonicalParent = await stat(activeServerDir).catch(() => null);
  const canonicalStatePath = await realpathSafe(statePath);
  if (!canonicalParent || !canonicalActiveServerDir || !canonicalStatePath
    || dirname(canonicalStatePath) !== canonicalActiveServerDir
    || basename(canonicalStatePath) !== LEGACY_DIRECTORY_NAME) {
    return unknown(statePath, 'path_replacement');
  }
  if (!isOwnedAndPrivate(canonicalParent)) return unknown(statePath, 'parent_ownership_or_permissions');
  const canonicalStateStat = await lstat(canonicalStatePath).catch(() => null);
  if (!canonicalStateStat || !canonicalStateStat.isDirectory() || canonicalStateStat.isSymbolicLink()) {
    return unknown(statePath, 'path_replacement');
  }
  if (typeof canonicalStateStat.dev === 'number' && typeof canonicalParent.dev === 'number'
    && canonicalStateStat.dev !== canonicalParent.dev) {
    return unknown(statePath, 'mount_replacement');
  }
  if (!isOwnedAndPrivate(canonicalStateStat)) return unknown(statePath, 'ownership_or_permissions');

  const inventory = await readInventory(canonicalStatePath).catch(() => null);
  if (!inventory) return unknown(statePath, 'unrecognized_child');
  if (!(await hasV1Record(canonicalStatePath))) return unknown(statePath, 'recognized_v1_record_missing');

  const nowMs = input.nowMs ?? Date.now();
  const suffix = input.randomSuffix && input.randomSuffix.length <= 64 && /^[A-Za-z0-9_-]+$/u.test(input.randomSuffix)
    ? input.randomSuffix
    : randomUUID().replaceAll('-', '');
  const quarantinePath = join(activeServerDir, `${RETIRED_DIRECTORY_PREFIX}${String(nowMs)}-${suffix}`);
  const markerPath = join(canonicalStatePath, RETIREMENT_MARKER_NAME);
  const installationId = typeof input.installationId === 'string'
    && input.installationId.length > 0
    && input.installationId.length <= MAX_INSTALLATION_ID_LENGTH
    ? input.installationId
    : 'unknown';
  try {
    await writeJsonAtomic(markerPath, {
      detectedSchemaVersion: WORKSPACE_REPLICATION_SCHEMA_VERSION,
      detectedAtMs: nowMs,
      installationId,
      inventoryHash: inventory.hash,
    });
    await rename(canonicalStatePath, quarantinePath);
  } catch {
    await unlink(markerPath).catch(() => undefined);
    return unknown(statePath, 'quarantine_failed');
  }

  await chmod(quarantinePath, 0o700).catch(() => undefined);
  return {
    status: 'legacy_workspace_sync_state_unsupported',
    classification: 'retired_v1',
    path: statePath,
    quarantinePath,
    schemaVersion: WORKSPACE_REPLICATION_SCHEMA_VERSION,
    inventoryHash: inventory.hash,
  };
}

async function realpathSafe(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}
