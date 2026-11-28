import { execFile } from 'node:child_process';
import { accessSync, constants, watch, type BigIntStats, type FSWatcher } from 'node:fs';
import { lstat, open, readdir, readFile, realpath, type FileHandle } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { resolveMachineAgentExecutionPlacementV1 } from '@happier-dev/protocol/machines/agentIsolationV1';
import { withPinnedUnixPath } from '@/utils/fs/unixPinnedPath';

const WORKSPACE_GROUP_NAME = 'happier-workspace';
const SHARED_AGENT_USERNAME = 'happier-agent';
// Linux O_PATH pins unreadable/symlink-checked entries without opening devices or FIFOs.
const O_PATH = 0x200000;
const PIN_DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const PIN_ENTRY_FLAGS = O_PATH | constants.O_NOFOLLOW;
const ACL_BATCH_SIZE = 64;
const MAX_TRACKED_ROOTS = 32;
const MAX_DIRTY_PATHS = 256;
const MAX_GRANTED_INODES = 50_000;
const STANDARD_POSIX_BIN_DIRS = ['/usr/bin', '/bin', '/usr/local/bin'] as const;

export type IsolatedWorkerWorkspaceAccessTarget =
  | Readonly<{ kind: 'exact_uid'; uid: number }>
  | Readonly<{ kind: 'shared_group'; gid: number }>;

export type IsolatedWorkerWorkspaceAccessSnapshot = Readonly<{
  enabled?: boolean;
  memberProvisioning?: 'linuxUsersV1';
  status?: Readonly<{ kind?: string }>;
  localTransport?: Readonly<{ agentUid?: number }>;
}>;

export type ResolveIsolatedWorkerWorkspaceAccessTargetInput = Readonly<{
  snapshot: IsolatedWorkerWorkspaceAccessSnapshot | null | undefined;
  isCustodianRequester: boolean;
  platform?: NodeJS.Platform;
  ownUid?: number;
  resolveOwnerMemberUid?: () => Promise<number | null>;
  resolveWorkspaceGid?: () => Promise<number | null>;
  resolveSharedAgentUid?: () => Promise<number | null>;
  readProcessGroups?: () => readonly number[];
}>;

export type ReconcileIsolatedWorkerWorkspaceAccessInput = Readonly<{
  rootPath: string;
  snapshot: IsolatedWorkerWorkspaceAccessSnapshot | null | undefined;
  isCustodianRequester: boolean;
  resolveOwnerMemberUid?: () => Promise<number | null>;
  signal?: AbortSignal;
}>;

export type IsolatedWorkerWorkspaceAccessReconcileStats = Readonly<{
  mode: 'noop' | 'warm_clean' | 'incremental' | 'full';
  entriesInspected: number;
  entriesMutated: number;
  aclCommandsExecuted: number;
}>;

export type IsolatedWorkerWorkspaceAccessReconcilerOptions = Readonly<{
  platform?: NodeJS.Platform;
  ownUid?: number;
  resolveWorkspaceGid?: () => Promise<number | null>;
  resolveSharedAgentUid?: () => Promise<number | null>;
  readProcessGroups?: () => readonly number[];
  runSetfacl?: (args: readonly string[], signal?: AbortSignal) => Promise<void>;
  watchRoot?: (
    canonicalRoot: string,
    onEvent: (eventType: string, filename: string | Buffer | null) => void,
  ) => FSWatcher;
}>;

export type IsolatedWorkerWorkspaceAccessReconciler = Readonly<{
  reconcile(input: ReconcileIsolatedWorkerWorkspaceAccessInput): Promise<IsolatedWorkerWorkspaceAccessReconcileStats>;
  dispose(): void;
}>;

type TrackedRootState = {
  key: string;
  canonicalRoot: string;
  rootDev: bigint;
  rootIno: bigint;
  rootMtimeNs: bigint;
  rootCtimeNs: bigint;
  watcher: FSWatcher | null;
  watcherHealthy: boolean;
  ancestorsGranted: boolean;
  fullScanNeeded: boolean;
  dirtyPaths: Set<string>;
  grantedInodes: Map<string, bigint>;
};

type PendingAclItem = Readonly<{
  handle: FileHandle;
  inodeKey: string;
}>;

type PendingAclBatch = {
  isDir: boolean;
  aclSpec: string;
  items: PendingAclItem[];
};

const NOOP_STATS: IsolatedWorkerWorkspaceAccessReconcileStats = Object.freeze({
  mode: 'noop',
  entriesInspected: 0,
  entriesMutated: 0,
  aclCommandsExecuted: 0,
});

function descriptorPath(handle: FileHandle): string {
  return `/proc/${process.pid}/fd/${handle.fd}`;
}

function isPositiveSafeUidOrGid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isBenignFsRaceError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP' || code === 'EACCES';
}

function isBenignSetfaclEntryError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const errno = error as NodeJS.ErrnoException & { stderr?: unknown };
  if (typeof errno.syscall === 'string' && errno.syscall.startsWith('spawn')) {
    return false;
  }
  if (
    errno.code === 'ENOENT'
    || errno.code === 'EACCES'
    || errno.code === 'EPERM'
    || errno.code === 'EOPNOTSUPP'
  ) {
    return true;
  }
  const detail = `${typeof errno.stderr === 'string' ? errno.stderr : ''}\n${typeof errno.message === 'string' ? errno.message : ''}`;
  return /\b(?:ENOENT|EACCES|EPERM|EOPNOTSUPP)\b|No such file or directory|Permission denied|Operation not permitted|Operation not supported/i.test(detail);
}

async function reopenPinnedForMutation(handle: FileHandle): Promise<FileHandle | null> {
  try {
    return await open(descriptorPath(handle), constants.O_RDONLY | constants.O_NONBLOCK)
      .catch(() => open(descriptorPath(handle), constants.O_WRONLY | constants.O_NONBLOCK));
  } catch (error) {
    if (isBenignFsRaceError(error)) return null;
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'EPERM' || code === 'EROFS') return null;
    throw error;
  }
}

function resolvePosixExecutable(name: string): string {
  const envDirs = String(process.env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const dir of [...envDirs, ...STANDARD_POSIX_BIN_DIRS]) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try next candidate directory.
    }
  }
  return name;
}

async function readLocalPosixNumericId(
  database: 'group' | 'passwd',
  entryName: string,
): Promise<number | null> {
  try {
    const raw = await readFile(database === 'group' ? '/etc/group' : '/etc/passwd', 'utf8');
    for (const line of raw.split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const fields = line.split(':');
      if (fields[0] === entryName && fields.length >= 3) {
        const parsed = Number.parseInt(fields[2] ?? '', 10);
        if (isPositiveSafeUidOrGid(parsed)) return parsed;
      }
    }
  } catch {
    // Fall back to getent for NSS/LDAP/systemd-homed accounts.
  }
  return await new Promise<number | null>(resolve => {
    execFile(resolvePosixExecutable('getent'), [database, entryName], { encoding: 'utf8' }, (error, stdout) => {
      if (error || !stdout) return resolve(null);
      const fields = stdout.trim().split(':');
      const parsed = Number.parseInt(fields[2] ?? '', 10);
      resolve(isPositiveSafeUidOrGid(parsed) ? parsed : null);
    });
  });
}

function readCurrentProcessGroups(): readonly number[] {
  const groups = new Set<number>();
  const primary = process.getgid?.();
  if (typeof primary === 'number') groups.add(primary);
  for (const gid of process.getgroups?.() ?? []) groups.add(gid);
  return [...groups];
}

function defaultRunSetfacl(args: readonly string[], signal?: AbortSignal): Promise<void> {
  const executable = resolvePosixExecutable('setfacl');
  return new Promise((resolve, reject) => {
    execFile(executable, [...args], { encoding: 'utf8', ...(signal ? { signal } : {}) }, (error, _stdout, stderr) => {
      if (error) {
        if (stderr && !('stderr' in error && (error as { stderr?: unknown }).stderr)) {
          (error as { stderr?: string }).stderr = stderr;
        }
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function permissionAccess(bits: number): string {
  return `${bits & 4 ? 'r' : '-'}${bits & 2 ? 'w' : '-'}${bits & 1 ? 'x' : '-'}`;
}

function buildExactUidAclSpec(ownerBits: number, ownUid: number, targetUid: number, isDir: boolean): string {
  const owner = permissionAccess(ownerBits);
  const accessEntries = [
    `user::${owner}`,
    `user:${targetUid}:${owner}`,
    'group::---',
    `mask::${owner}`,
    'other::---',
  ];
  if (!isDir) return accessEntries.join(',');
  return [
    ...accessEntries,
    `default:user::${owner}`,
    `default:user:${ownUid}:${owner}`,
    `default:user:${targetUid}:${owner}`,
    'default:group::---',
    `default:mask::${owner}`,
    'default:other::---',
  ].join(',');
}

function computeCanonicalSharedGroupMode(currentMode: number, isDir: boolean): number {
  const baseMode = currentMode & ~(isDir ? 0o4000 : 0o6000) & ~0o007;
  return baseMode
    | 0o060
    | ((isDir || (baseMode & 0o111) !== 0) ? 0o010 : 0)
    | (isDir ? 0o2000 : 0);
}

function targetCacheKey(target: IsolatedWorkerWorkspaceAccessTarget): string {
  return target.kind === 'exact_uid' ? `u:${target.uid}` : `g:${target.gid}`;
}

function recordGrantedInode(state: TrackedRootState, inodeKey: string, ctimeNs: bigint): void {
  if (state.grantedInodes.size >= MAX_GRANTED_INODES && !state.grantedInodes.has(inodeKey)) {
    const oldest = state.grantedInodes.keys().next().value;
    if (oldest !== undefined) state.grantedInodes.delete(oldest);
  }
  state.grantedInodes.set(inodeKey, ctimeNs);
}

function closeTrackedRootWatcher(state: TrackedRootState): void {
  state.watcherHealthy = false;
  const watcher = state.watcher;
  state.watcher = null;
  if (!watcher) return;
  try {
    watcher.close();
  } catch {
    // Closing an errored/already-closed watcher is best effort.
  }
}

function normalizeRelativeDirtyPath(raw: string | Buffer | null): string | null {
  if (raw === null || raw === undefined) return null;
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  if (!text || text.includes('\0')) return null;
  const segments = text.replaceAll('\\', '/').split('/').filter(part => part !== '' && part !== '.');
  if (segments.length === 0 || segments.some(part => part === '..')) return null;
  return segments.join('/');
}

/**
 * Decides the single canonical Linux filesystem grant needed so an isolated
 * custodian execution identity (`hpm-<owner>` on `linuxUsersV1` or
 * `happier-agent` on `sharedAgent`) can read daemon-synced worker files without
 * exposing them to any other member or host user.
 */
export async function resolveIsolatedWorkerWorkspaceAccessTarget(
  input: ResolveIsolatedWorkerWorkspaceAccessTargetInput,
): Promise<IsolatedWorkerWorkspaceAccessTarget | null> {
  const platform = input.platform ?? process.platform;
  if (platform !== 'linux') return null;
  if (!input.snapshot?.enabled || !input.isCustodianRequester) return null;

  const ownUid = input.ownUid ?? process.getuid?.();
  if (typeof ownUid !== 'number') return null;

  const placement = resolveMachineAgentExecutionPlacementV1({
    policy: {
      enabled: true,
      ...(input.snapshot.memberProvisioning ? { memberProvisioning: input.snapshot.memberProvisioning } : {}),
    },
    platform,
  });

  if (placement === 'member') {
    const ownerMemberUid = await input.resolveOwnerMemberUid?.();
    if (!isPositiveSafeUidOrGid(ownerMemberUid) || ownerMemberUid === ownUid) return null;
    return { kind: 'exact_uid', uid: ownerMemberUid };
  }

  if (placement === 'sharedAgent') {
    if (input.snapshot.status?.kind !== 'effective') return null;
    const workspaceGid = await (input.resolveWorkspaceGid
      ? input.resolveWorkspaceGid()
      : readLocalPosixNumericId('group', WORKSPACE_GROUP_NAME));
    const processGroups = input.readProcessGroups ? input.readProcessGroups() : readCurrentProcessGroups();
    if (isPositiveSafeUidOrGid(workspaceGid) && processGroups.includes(workspaceGid)) {
      return { kind: 'shared_group', gid: workspaceGid };
    }
    const agentUid = isPositiveSafeUidOrGid(input.snapshot.localTransport?.agentUid)
      ? input.snapshot.localTransport.agentUid
      : await (input.resolveSharedAgentUid
        ? input.resolveSharedAgentUid()
        : readLocalPosixNumericId('passwd', SHARED_AGENT_USERNAME));
    if (!isPositiveSafeUidOrGid(agentUid) || agentUid === ownUid) return null;
    return { kind: 'exact_uid', uid: agentUid };
  }

  return null;
}

/**
 * Stateful, fd-pinned reconciler for custodian worker copies on isolated Linux hosts.
 *
 * - Cold pass: iterative fd-pinned DFS (`stack.pop()`, bounded open FDs) with
 *   batched `setfacl` (up to 64 pinned `/proc/self/fd/*` paths per invocation)
 *   or zero-fork `fchown`/`fchmod` on `shared_group`.
 * - Warm steady-state: O(1) pinned root `fstat` + healthy recursive `fs.watch`
 *   with zero directory walks and zero `setfacl` forks.
 * - Warm incremental: reconciles only dirty paths observed since the last pass
 *   (descending into newly created/changed subdirectories) and filters out
 *   self-induced `IN_ATTRIB` events via cached post-grant `ctimeNs`.
 */
export function createIsolatedWorkerWorkspaceAccessReconciler(
  options: IsolatedWorkerWorkspaceAccessReconcilerOptions = {},
): IsolatedWorkerWorkspaceAccessReconciler {
  const platform = options.platform ?? process.platform;
  const runSetfacl = options.runSetfacl ?? defaultRunSetfacl;
  const watchRoot = options.watchRoot
    ?? ((canonicalRoot, onEvent) => watch(canonicalRoot, { recursive: true, persistent: false }, onEvent));

  let cachedWorkspaceGidPromise: Promise<number | null> | null = null;
  let cachedSharedAgentUidPromise: Promise<number | null> | null = null;
  const resolveWorkspaceGid = options.resolveWorkspaceGid ?? (() => {
    cachedWorkspaceGidPromise ??= readLocalPosixNumericId('group', WORKSPACE_GROUP_NAME);
    return cachedWorkspaceGidPromise;
  });
  const resolveSharedAgentUid = options.resolveSharedAgentUid ?? (() => {
    cachedSharedAgentUidPromise ??= readLocalPosixNumericId('passwd', SHARED_AGENT_USERNAME);
    return cachedSharedAgentUidPromise;
  });

  const trackedRoots = new Map<string, TrackedRootState>();
  const inflightByRootKey = new Map<string, Promise<IsolatedWorkerWorkspaceAccessReconcileStats>>();
  let disposed = false;

  function touchLru(state: TrackedRootState): void {
    trackedRoots.delete(state.key);
    trackedRoots.set(state.key, state);
    while (trackedRoots.size > MAX_TRACKED_ROOTS) {
      const oldestKey = trackedRoots.keys().next().value;
      if (oldestKey === undefined) break;
      const evicted = trackedRoots.get(oldestKey);
      trackedRoots.delete(oldestKey);
      if (evicted) closeTrackedRootWatcher(evicted);
    }
  }

  function ensureWatcher(state: TrackedRootState): void {
    if (disposed || state.watcherHealthy) return;
    try {
      const watcher = watchRoot(state.canonicalRoot, (_eventType, filename) => {
        if (!state.watcherHealthy) return;
        const normalized = normalizeRelativeDirtyPath(filename);
        if (!normalized) {
          state.fullScanNeeded = true;
          return;
        }
        if (state.dirtyPaths.size >= MAX_DIRTY_PATHS && !state.dirtyPaths.has(normalized)) {
          state.dirtyPaths.clear();
          state.fullScanNeeded = true;
          return;
        }
        state.dirtyPaths.add(normalized);
      });
      watcher.on('error', () => {
        state.fullScanNeeded = true;
        closeTrackedRootWatcher(state);
      });
      state.watcher = watcher;
      state.watcherHealthy = true;
    } catch {
      state.watcherHealthy = false;
      state.fullScanNeeded = true;
    }
  }

  async function reconcileRootInternal(
    input: ReconcileIsolatedWorkerWorkspaceAccessInput,
    target: IsolatedWorkerWorkspaceAccessTarget,
    ownUid: number,
  ): Promise<IsolatedWorkerWorkspaceAccessReconcileStats> {
    input.signal?.throwIfAborted();
    if (!isAbsolute(input.rootPath) || input.rootPath.includes('\0')) return NOOP_STATS;

    // Refuse symlinked roots before resolving canonical path.
    let observedRoot;
    try {
      observedRoot = await lstat(input.rootPath, { bigint: true });
    } catch (error) {
      if (isBenignFsRaceError(error)) return NOOP_STATS;
      throw error;
    }
    if (observedRoot.isSymbolicLink() || !observedRoot.isDirectory() || Number(observedRoot.uid) !== ownUid) {
      return NOOP_STATS;
    }

    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(input.rootPath);
    } catch (error) {
      if (isBenignFsRaceError(error)) return NOOP_STATS;
      throw error;
    }

    const key = `${canonicalRoot}\0${targetCacheKey(target)}`;

    return await withPinnedUnixPath(canonicalRoot, true, false, async (rootHandle) => {
      input.signal?.throwIfAborted();
      const rootStat = await rootHandle.stat({ bigint: true });
      if (
        !rootStat.isDirectory()
        || rootStat.dev !== observedRoot.dev
        || rootStat.ino !== observedRoot.ino
        || Number(rootStat.uid) !== ownUid
      ) {
        return NOOP_STATS;
      }

      let state = trackedRoots.get(key);
      if (state && (state.rootDev !== rootStat.dev || state.rootIno !== rootStat.ino)) {
        closeTrackedRootWatcher(state);
        trackedRoots.delete(key);
        state = undefined;
      }

      const isCold = !state;
      if (!state) {
        state = {
          key,
          canonicalRoot,
          rootDev: rootStat.dev,
          rootIno: rootStat.ino,
          rootMtimeNs: rootStat.mtimeNs,
          rootCtimeNs: rootStat.ctimeNs,
          watcher: null,
          watcherHealthy: false,
          ancestorsGranted: false,
          fullScanNeeded: true,
          dirtyPaths: new Set<string>(),
          grantedInodes: new Map<string, bigint>(),
        };
        touchLru(state);
      } else {
        touchLru(state);
      }

      // Always yield one event-loop turn on warm checks so libuv's I/O poll drains
      // pending inotify events (including subdirectory writes that leave rootStat
      // mtime/ctime unchanged) before deciding warm_clean.
      if (
        !isCold
        && state.watcherHealthy
        && !state.fullScanNeeded
        && state.dirtyPaths.size === 0
      ) {
        await new Promise<void>(resolve => setImmediate(resolve));
        input.signal?.throwIfAborted();
        if (
          state.dirtyPaths.size === 0
          && (rootStat.mtimeNs !== state.rootMtimeNs || rootStat.ctimeNs !== state.rootCtimeNs)
        ) {
          state.fullScanNeeded = true;
        }
      }

      // Warm steady-state fast-path: O(1), zero tree walks, zero setfacl forks.
      if (
        !isCold
        && state.watcherHealthy
        && !state.fullScanNeeded
        && state.dirtyPaths.size === 0
        && rootStat.mtimeNs === state.rootMtimeNs
        && rootStat.ctimeNs === state.rootCtimeNs
      ) {
        return {
          mode: 'warm_clean',
          entriesInspected: 0,
          entriesMutated: 0,
          aclCommandsExecuted: 0,
        };
      }

      const activeState = state;
      const runMode: 'full' | 'incremental' = (isCold || activeState.fullScanNeeded || !activeState.watcherHealthy)
        ? 'full'
        : 'incremental';

      let entriesInspected = 0;
      let entriesMutated = 0;
      let aclCommandsExecuted = 0;

      const pendingBatches = new Map<string, PendingAclBatch>();
      let pendingHandleCount = 0;

      const closeAllPendingHandles = async (): Promise<void> => {
        const batches = [...pendingBatches.values()];
        pendingBatches.clear();
        pendingHandleCount = 0;
        for (const batch of batches) {
          for (const item of batch.items) {
            await item.handle.close().catch(() => undefined);
          }
        }
      };

      const flushPendingBatches = async (): Promise<void> => {
        if (pendingBatches.size === 0) return;
        const batches = [...pendingBatches.values()];
        pendingBatches.clear();
        pendingHandleCount = 0;
        try {
          for (const batch of batches) {
            input.signal?.throwIfAborted();
            if (batch.items.length === 0) continue;
            const buildArgs = (items: readonly PendingAclItem[]) => [
              ...(batch.isDir ? ['-k'] : []),
              '--set',
              batch.aclSpec,
              '--',
              ...items.map(item => descriptorPath(item.handle)),
            ];
            const recordItemSuccess = async (item: PendingAclItem): Promise<void> => {
              try {
                const after = await item.handle.stat({ bigint: true });
                recordGrantedInode(activeState, item.inodeKey, after.ctimeNs);
              } catch (error) {
                if (!isBenignFsRaceError(error)) throw error;
              }
              entriesMutated += 1;
            };
            try {
              aclCommandsExecuted += 1;
              await runSetfacl(buildArgs(batch.items), input.signal);
              for (const item of batch.items) {
                await recordItemSuccess(item);
              }
            } catch (batchError) {
              if (input.signal?.aborted) throw batchError;
              if (batch.items.length === 1) {
                if (isBenignSetfaclEntryError(batchError)) continue;
                throw batchError;
              }
              // Multi-FD batch failed: retry per item so one bad entry does not abort
              // ACL grants for the remaining valid entries in the batch.
              for (const item of batch.items) {
                input.signal?.throwIfAborted();
                try {
                  aclCommandsExecuted += 1;
                  await runSetfacl(buildArgs([item]), input.signal);
                  await recordItemSuccess(item);
                } catch (itemError) {
                  if (input.signal?.aborted) throw itemError;
                  if (isBenignSetfaclEntryError(itemError)) continue;
                  throw itemError;
                }
              }
            }
          }
        } finally {
          for (const batch of batches) {
            for (const item of batch.items) {
              await item.handle.close().catch(() => undefined);
            }
          }
        }
      };

      const reconcilePinnedAncestors = async (): Promise<void> => {
        if (target.kind !== 'exact_uid' || activeState.ancestorsGranted) return;
        const ancestorSegments = canonicalRoot.split('/').filter(Boolean).slice(0, -1);
        if (ancestorSegments.length === 0) {
          activeState.ancestorsGranted = true;
          return;
        }
        const pinnedHandles: FileHandle[] = [];
        try {
          let parentHandle: FileHandle;
          try {
            parentHandle = await open('/', PIN_DIR_FLAGS);
          } catch (error) {
            if (isBenignFsRaceError(error)) return;
            throw error;
          }
          pinnedHandles.push(parentHandle);
          for (const segment of ancestorSegments) {
            input.signal?.throwIfAborted();
            let nextHandle: FileHandle;
            try {
              nextHandle = await open(
                `${descriptorPath(parentHandle)}/${segment}`,
                O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW,
              );
            } catch (error) {
              if (isBenignFsRaceError(error)) return;
              throw error;
            }
            pinnedHandles.push(nextHandle);
            parentHandle = nextHandle;
          }

          // Walk upward from immediate parent above canonicalRoot, stopping at `/`
          // (index 0) or any non-daemon-owned directory.
          const needsTraversal: FileHandle[] = [];
          for (let i = pinnedHandles.length - 1; i >= 1; i -= 1) {
            input.signal?.throwIfAborted();
            const handle = pinnedHandles[i]!;
            const ancestorStat = await handle.stat({ bigint: true });
            if (!ancestorStat.isDirectory() || Number(ancestorStat.uid) !== ownUid) {
              break;
            }
            if ((Number(ancestorStat.mode) & 0o001) === 0) {
              needsTraversal.push(handle);
            }
          }

          if (needsTraversal.length > 0) {
            const buildAncestorArgs = (handles: readonly FileHandle[]) => [
              '-m',
              `u:${target.uid}:--x`,
              '--',
              ...handles.map(handle => descriptorPath(handle)),
            ];
            try {
              aclCommandsExecuted += 1;
              await runSetfacl(buildAncestorArgs(needsTraversal), input.signal);
            } catch (batchError) {
              if (input.signal?.aborted) throw batchError;
              if (needsTraversal.length === 1) {
                if (!isBenignSetfaclEntryError(batchError)) throw batchError;
              } else {
                for (const handle of needsTraversal) {
                  input.signal?.throwIfAborted();
                  try {
                    aclCommandsExecuted += 1;
                    await runSetfacl(buildAncestorArgs([handle]), input.signal);
                  } catch (itemError) {
                    if (input.signal?.aborted) throw itemError;
                    if (!isBenignSetfaclEntryError(itemError)) throw itemError;
                  }
                }
              }
            }
          }
          activeState.ancestorsGranted = true;
        } finally {
          for (let i = pinnedHandles.length - 1; i >= 0; i -= 1) {
            await pinnedHandles[i]!.close().catch(() => undefined);
          }
        }
      };

      /**
       * Reconciles a single pinned entry. Returns `true` if ownership of `handle`
       * was transferred to a pending ACL batch (caller MUST NOT close it), or
       * `false` if caller remains responsible for closing `handle`.
       */
      const reconcilePinnedEntry = async (
        handle: FileHandle,
        observed: BigIntStats,
        allowTransferHandle: boolean,
      ): Promise<boolean> => {
        entriesInspected += 1;
        if (observed.isSymbolicLink()) return false;
        const isDir = observed.isDirectory();
        const isFile = observed.isFile();
        if (!isDir && !isFile) return false;
        if (Number(observed.uid) !== ownUid) return false;
        // Hardlink safety: never weaken permissions on inodes linked outside the copy.
        if (isFile && observed.nlink !== 1n) return false;

        const inodeKey = `${observed.dev}:${observed.ino}`;
        if (activeState.grantedInodes.get(inodeKey) === observed.ctimeNs) {
          return false;
        }

        const currentMode = Number(observed.mode & 0o7777n);

        if (target.kind === 'shared_group') {
          const canonicalMode = computeCanonicalSharedGroupMode(currentMode, isDir);
          if (Number(observed.gid) === target.gid && currentMode === canonicalMode) {
            recordGrantedInode(activeState, inodeKey, observed.ctimeNs);
            return false;
          }
          // Reopen pinned inode directly via /proc/self/fd/<fd>; never follows renames or symlinks.
          const writable = await reopenPinnedForMutation(handle);
          if (!writable) return false;
          try {
            if (Number(observed.gid) !== target.gid) {
              await writable.chown(ownUid, target.gid);
            }
            await writable.chmod(canonicalMode);
            const after = await writable.stat({ bigint: true });
            recordGrantedInode(activeState, inodeKey, after.ctimeNs);
            entriesMutated += 1;
          } finally {
            await writable.close().catch(() => undefined);
          }
          return false;
        }

        // exact_uid ACL mode.
        const specialMask = isDir ? 0o4000 : 0o6000;
        let effectiveMode = currentMode;
        if ((currentMode & specialMask) !== 0) {
          const stripped = currentMode & ~specialMask;
          const writable = await reopenPinnedForMutation(handle);
          if (!writable) return false;
          try {
            await writable.chmod(stripped);
            effectiveMode = stripped;
          } finally {
            await writable.close().catch(() => undefined);
          }
        }

        const ownerBits = (effectiveMode >> 6) & 7;
        const aclSpec = buildExactUidAclSpec(ownerBits, ownUid, target.uid, isDir);
        const batchKey = `${isDir ? 'd' : 'f'}:${aclSpec}`;

        // Clone an O_PATH pin when caller owns the handle (e.g., rootHandle or DFS dirHandle).
        // Reopening /proc/<pid>/fd/<fd> must omit O_NOFOLLOW (which would open the procfs
        // magic symlink itself); it re-pins the already-verified inode directly without traversal.
        const batchHandle = allowTransferHandle
          ? handle
          : await open(descriptorPath(handle), O_PATH);
        let batch = pendingBatches.get(batchKey);
        if (!batch) {
          batch = { isDir, aclSpec, items: [] };
          pendingBatches.set(batchKey, batch);
        }
        batch.items.push({ handle: batchHandle, inodeKey });
        pendingHandleCount += 1;
        if (pendingHandleCount >= ACL_BATCH_SIZE) {
          await flushPendingBatches();
        }
        return allowTransferHandle;
      };

      const walkSubtreePinned = async (startDirHandle: FileHandle, includeStartDir: boolean): Promise<void> => {
        type StackFrame = {
          dirHandle: FileHandle;
          ownedHandle: boolean;
          names: string[] | null;
          index: number;
        };
        const stack: StackFrame[] = [{
          dirHandle: startDirHandle,
          ownedHandle: false,
          names: null,
          index: 0,
        }];
        try {
          if (includeStartDir) {
            const startStat = await startDirHandle.stat({ bigint: true });
            await reconcilePinnedEntry(startDirHandle, startStat, false);
          }
          while (stack.length > 0) {
            input.signal?.throwIfAborted();
            const frame = stack[stack.length - 1]!;
            if (frame.names === null) {
              try {
                frame.names = await readdir(descriptorPath(frame.dirHandle));
              } catch (error) {
                if (!isBenignFsRaceError(error)) throw error;
                frame.names = [];
              }
            }
            if (frame.index >= frame.names.length) {
              stack.pop();
              if (frame.ownedHandle) {
                await frame.dirHandle.close().catch(() => undefined);
              }
              continue;
            }
            const name = frame.names[frame.index++]!;
            if (!name || name === '.' || name === '..' || name.includes('\0') || name.includes('/')) continue;

            let childHandle: FileHandle;
            try {
              childHandle = await open(`${descriptorPath(frame.dirHandle)}/${name}`, PIN_ENTRY_FLAGS);
            } catch (error) {
              if (isBenignFsRaceError(error)) continue;
              throw error;
            }

            let transferred = false;
            try {
              const childStat = await childHandle.stat({ bigint: true });
              if (childStat.isSymbolicLink()) continue;
              if (childStat.isDirectory()) {
                if (Number(childStat.uid) !== ownUid) continue;
                await reconcilePinnedEntry(childHandle, childStat, false);
                let readableChildDir: FileHandle;
                try {
                  readableChildDir = await open(`${descriptorPath(frame.dirHandle)}/${name}`, PIN_DIR_FLAGS);
                } catch (error) {
                  if (isBenignFsRaceError(error)) continue;
                  throw error;
                }
                const reopenedStat = await readableChildDir.stat({ bigint: true });
                if (reopenedStat.dev !== childStat.dev || reopenedStat.ino !== childStat.ino || Number(reopenedStat.uid) !== ownUid) {
                  await readableChildDir.close().catch(() => undefined);
                  continue;
                }
                stack.push({
                  dirHandle: readableChildDir,
                  ownedHandle: true,
                  names: null,
                  index: 0,
                });
              } else if (childStat.isFile()) {
                transferred = await reconcilePinnedEntry(childHandle, childStat, true);
              }
            } finally {
              if (!transferred) {
                await childHandle.close().catch(() => undefined);
              }
            }
          }
        } finally {
          while (stack.length > 0) {
            const frame = stack.pop()!;
            if (frame.ownedHandle) {
              await frame.dirHandle.close().catch(() => undefined);
            }
          }
        }
      };

      const reconcileDirtyPathPinned = async (relPath: string): Promise<void> => {
        const segments = relPath.split('/').filter(Boolean);
        if (segments.length === 0) return;

        let currentDir = rootHandle;
        const openedDirs: FileHandle[] = [];
        try {
          for (let i = 0; i < segments.length; i += 1) {
            input.signal?.throwIfAborted();
            const segment = segments[i]!;
            const isLeaf = i === segments.length - 1;

            let entryHandle: FileHandle;
            try {
              entryHandle = await open(`${descriptorPath(currentDir)}/${segment}`, PIN_ENTRY_FLAGS);
            } catch (error) {
              if (isBenignFsRaceError(error)) return;
              throw error;
            }

            let transferred = false;
            try {
              const entryStat = await entryHandle.stat({ bigint: true });
              if (entryStat.isSymbolicLink() || Number(entryStat.uid) !== ownUid) return;

              if (entryStat.isDirectory()) {
                await reconcilePinnedEntry(entryHandle, entryStat, false);
                let nextDir: FileHandle;
                try {
                  nextDir = await open(`${descriptorPath(currentDir)}/${segment}`, PIN_DIR_FLAGS);
                } catch (error) {
                  if (isBenignFsRaceError(error)) return;
                  throw error;
                }
                const nextStat = await nextDir.stat({ bigint: true });
                if (nextStat.dev !== entryStat.dev || nextStat.ino !== entryStat.ino || Number(nextStat.uid) !== ownUid) {
                  await nextDir.close().catch(() => undefined);
                  return;
                }
                openedDirs.push(nextDir);
                currentDir = nextDir;
                if (isLeaf) {
                  // Newly created/changed directory: walk its subtree to catch files written
                  // before recursive inotify attached to the new directory.
                  await walkSubtreePinned(nextDir, false);
                }
                continue;
              }

              if (isLeaf && entryStat.isFile()) {
                transferred = await reconcilePinnedEntry(entryHandle, entryStat, true);
              }
              return;
            } finally {
              if (!transferred) {
                await entryHandle.close().catch(() => undefined);
              }
            }
          }
        } finally {
          for (let i = openedDirs.length - 1; i >= 0; i -= 1) {
            await openedDirs[i]!.close().catch(() => undefined);
          }
        }
      };

      try {
        if (runMode === 'full') {
          // Start recursive watcher BEFORE cold walk so concurrent Mutagen writes to
          // already-visited directories during the walk are captured into dirtyPaths.
          ensureWatcher(activeState);
          activeState.dirtyPaths.clear();
          activeState.fullScanNeeded = !activeState.watcherHealthy;
          await reconcilePinnedAncestors();
          await walkSubtreePinned(rootHandle, true);
          await flushPendingBatches();
          // Drain self-induced IN_ATTRIB events (and any concurrent writes captured
          // during the cold walk): grantedInodes skips self-mutations with 0 forks.
          if (activeState.watcherHealthy) {
            await new Promise<void>(resolve => setImmediate(resolve));
            input.signal?.throwIfAborted();
            if (activeState.dirtyPaths.size > 0) {
              const postColdDirty = [...activeState.dirtyPaths];
              activeState.dirtyPaths.clear();
              for (const relPath of postColdDirty) {
                await reconcileDirtyPathPinned(relPath);
              }
              await flushPendingBatches();
            }
          }
        } else {
          const drained = [...activeState.dirtyPaths];
          activeState.dirtyPaths.clear();
          for (const relPath of drained) {
            await reconcileDirtyPathPinned(relPath);
          }
          await flushPendingBatches();
        }
      } catch (error) {
        activeState.fullScanNeeded = true;
        await closeAllPendingHandles();
        throw error;
      }

      const afterRootStat = await rootHandle.stat({ bigint: true });
      activeState.rootMtimeNs = afterRootStat.mtimeNs;
      activeState.rootCtimeNs = afterRootStat.ctimeNs;

      return {
        mode: runMode,
        entriesInspected,
        entriesMutated,
        aclCommandsExecuted,
      };
    });
  }

  return {
    async reconcile(input): Promise<IsolatedWorkerWorkspaceAccessReconcileStats> {
      if (disposed || platform !== 'linux') return NOOP_STATS;
      input.signal?.throwIfAborted();

      const ownUid = options.ownUid ?? process.getuid?.();
      if (typeof ownUid !== 'number') return NOOP_STATS;

      const target = await resolveIsolatedWorkerWorkspaceAccessTarget({
        snapshot: input.snapshot,
        isCustodianRequester: input.isCustodianRequester,
        platform,
        ownUid,
        resolveOwnerMemberUid: input.resolveOwnerMemberUid,
        resolveWorkspaceGid,
        resolveSharedAgentUid,
        readProcessGroups: options.readProcessGroups,
      });
      if (!target) return NOOP_STATS;

      const lockKey = `${input.rootPath}\0${targetCacheKey(target)}`;
      const previous = inflightByRootKey.get(lockKey);
      const current = (previous ? previous.catch(() => NOOP_STATS) : Promise.resolve(NOOP_STATS))
        .then(() => reconcileRootInternal(input, target, ownUid));
      inflightByRootKey.set(lockKey, current);
      try {
        return await current;
      } finally {
        if (inflightByRootKey.get(lockKey) === current) {
          inflightByRootKey.delete(lockKey);
        }
      }
    },

    dispose(): void {
      disposed = true;
      for (const state of trackedRoots.values()) {
        closeTrackedRootWatcher(state);
      }
      trackedRoots.clear();
    },
  };
}
