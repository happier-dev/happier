/**
 * Expo-FS host adapter for the shared model-pack installer core.
 *
 * Implements {@link ModelPackInstallerHost} on top of Expo `File`/`Directory`
 * and native file transfers, so the UI native installer runs the one shared
 * `installModelPackWithHost` algorithm (resume-aware download → verify → atomic
 * swap → restore-on-failure) instead of a parallel implementation.
 *
 * Layout (all siblings of the live pack so promotion is a same-filesystem move):
 *   live    `<document>/happier/voice/modelPacks/<packId>`
 *   scratch `.<packId>.scratch`        — STABLE per-pack partial store. Survives a
 *           failed/aborted attempt so the NEXT attempt resumes via HTTP `Range`
 *           from the partial offset (FIND-010). Cleared only after a successful
 *           promote.
 *   backup  `.<packId>.backup`         — STABLE name; the prior live tree during
 *           the swap window.
 *   intent  `.<packId>.promote-intent` — durable promotion transaction marker,
 *           present through swap and commit so a crash can be rolled back
 *           (X-M1, via {@link reconcileExpoModelPackPromotion}).
 *
 * Artifact transfer stays native in a temporary sibling file; only numeric
 * progress crosses into JS. Bounded disk chunks are verified by the shared core
 * and appended to scratch. Interrupted new tails are retried; existing scratch
 * prefixes survive cancellation and still resume through HTTP Range.
 *
 * Digest: chunks are hashed incrementally, so native installs do not retain
 * downloaded chunks until finalize. Hermes has no JIT, so a JS SHA-256 is far
 * slower than native and blocks the JS thread for minutes over a pack's largest
 * files; the native `HappierCryptoWorker.Sha256` keeps the digest state natively.
 * Builds whose native module predates it use the shared JS implementation.
 */

import { requireOptionalNativeModule } from 'expo-modules-core';

import { randomUUID } from '@/platform/randomUUID';

import type {
  ModelPackHasher,
  ModelPackDownloadRequest,
  ModelPackDownloadStream,
  ModelPackDurableRecoveryRecord,
  ModelPackInstallerHost,
  ModelPackPromotionIntentV1,
  ModelPackPromotionPriorInstallV1,
  ModelPackStagingPlan,
  ModelPackStagingHandle,
  ModelPackCoreProgress,
} from '@happier-dev/voice-modelpacks';
import type { ModelPackManifest } from '@happier-dev/protocol/voice/modelPacks/manifest';
import {
  createSha256Hasher,
  isLegacyModelPackPromotionIntent,
  MODEL_PACK_PROMOTION_INTENT_MAX_BYTES,
  parseModelPackPromotionIntentV1,
} from '@happier-dev/voice-modelpacks';

import {
  filePathParts,
  getMetaFile,
  getPackRootDir,
  getPackSiblingDir,
  getPackSiblingFile,
} from './paths';
import type { ExpoFsDirectory, ExpoFsFile, InstallerFs, InvalidatePackRuntime } from './types';
import { downloadNativeModelPackFile, type NativeModelPackDownload } from './nativeDownload';
import { ModelPackInsufficientDiskSpaceError, ModelPackInstallCancelledError } from './errors';
import { isModelPackCancellation, raceWithAbort, throwIfAborted } from './network';

const SCRATCH_SUFFIX = '.scratch';
const BACKUP_SUFFIX = '.backup';
const INTENT_SUFFIX = '.promote-intent';
const RESUME_PLAN_FILE = '.resume-plan.json';
const DOWNLOAD_SUFFIX = '.download';
const DOWNLOADS_SUFFIX = '.downloads';
export type ExpoModelPackOperationLease = Readonly<{
  key: string;
  token: symbol;
  release: () => void;
}>;

type InstallResult = Readonly<{ packDirUri: string; manifest: ModelPackManifest }>;
type InstallObserver = Readonly<{ signal: AbortSignal; onProgress?: (progress: ModelPackCoreProgress) => void }>;
type RunningInstall = {
  identity: string;
  controller: AbortController;
  promise: Promise<InstallResult>;
  listeners: Set<(progress: ModelPackCoreProgress) => void>;
  lastProgress: ModelPackCoreProgress | null;
};
const activeOperations = new Map<string, { token: symbol; install?: RunningInstall }>();

async function followInstall(install: RunningInstall, observer: InstallObserver): Promise<InstallResult> {
  const cancel = () => install.controller.abort();
  if (observer.signal.aborted) cancel();
  else observer.signal.addEventListener('abort', cancel, { once: true });
  const listener = observer.onProgress;
  if (listener) {
    install.listeners.add(listener);
    if (install.lastProgress) listener(install.lastProgress);
  }
  try {
    return await install.promise;
  } catch (error) {
    if (!observer.signal.aborted && isModelPackCancellation(error, install.controller.signal)) {
      throw new ModelPackInstallCancelledError();
    }
    throw error;
  } finally {
    observer.signal.removeEventListener('abort', cancel);
    if (listener) install.listeners.delete(listener);
  }
}

export function findRunningExpoModelPackInstall(fs: InstallerFs, packId: string): {
  follow: (observer: InstallObserver) => Promise<InstallResult>;
} | null {
  const install = activeOperations.get(installKeyFor(fs, packId))?.install;
  return install && !install.controller.signal.aborted ? { follow: observer => followInstall(install, observer) } : null;
}

/** The host's existing directory lease owns the install from manifest fetch through native cleanup. */
export async function runExpoModelPackInstall(opts: InstallObserver & {
  fs: InstallerFs;
  packId: string;
  identity: string;
  run: (context: { lease: ExpoModelPackOperationLease; signal: AbortSignal;
    onProgress: (progress: ModelPackCoreProgress) => void }) => Promise<InstallResult>;
}): Promise<InstallResult> {
  const key = installKeyFor(opts.fs, opts.packId);
  for (let running = activeOperations.get(key)?.install; running; running = activeOperations.get(key)?.install) {
    throwIfAborted(opts.signal);
    if (!running.controller.signal.aborted && running.identity === opts.identity) return followInstall(running, opts);
    await raceWithAbort(opts.signal, [running.promise.catch(() => undefined)]);
  }
  throwIfAborted(opts.signal);
  const lease = acquireOperationLease(opts.fs, opts.packId);
  const install: RunningInstall = {
    identity: opts.identity,
    controller: new AbortController(),
    listeners: new Set(),
    lastProgress: null,
    promise: Promise.resolve().then(() => opts.run({ lease, signal: install.controller.signal,
      onProgress: progress => {
        install.lastProgress = progress;
        for (const listener of install.listeners) listener(progress);
      },
    })).finally(lease.release),
  };
  activeOperations.set(key, { token: lease.token, install });
  return followInstall(install, opts);
}

/** Payload retained for retry/discard; host metadata is not downloaded model data. */
export function getExpoModelPackPartialBytes(opts: { fs: InstallerFs; packId: string }): number {
  const scratch = getPackSiblingDir(opts.fs, opts.packId, SCRATCH_SUFFIX);
  if (!scratch.exists) return 0;
  const count = (directory: ExpoFsDirectory, root: boolean): number => {
    let total = 0;
    for (const entry of directory.list()) {
      if (root && (entry.name === RESUME_PLAN_FILE || entry.name === 'pack.json')) continue;
      if ('list' in entry) {
        total += count(entry, false);
      } else {
        const size = entry.size;
        if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) {
          throw new Error('model_pack_partial_size_unavailable');
        }
        total += size;
      }
    }
    return total;
  };
  return count(scratch, true);
}

function installKeyFor(fs: InstallerFs, packId: string): string {
  return getPackRootDir(fs, packId).uri;
}

function acquireOperationLease(fs: InstallerFs, packId: string): ExpoModelPackOperationLease {
  const key = installKeyFor(fs, packId);
  if (activeOperations.has(key)) throw new Error('model_pack_install_already_in_progress');
  const token = Symbol(key);
  activeOperations.set(key, { token });
  let released = false;
  return Object.freeze({
    key,
    token,
    release: () => {
      if (released) return;
      released = true;
      if (activeOperations.get(key)?.token === token) activeOperations.delete(key);
    },
  });
}

function assertOperationAvailable(
  fs: InstallerFs,
  packId: string,
  lease?: ExpoModelPackOperationLease,
): void {
  const key = installKeyFor(fs, packId);
  const activeToken = activeOperations.get(key)?.token;
  if (activeToken && activeToken !== lease?.token) {
    throw new Error('model_pack_install_already_in_progress');
  }
}

function tryDelete(node: Pick<ExpoFsFile | ExpoFsDirectory, 'exists' | 'delete'>): void {
  try {
    if (node.exists && node.delete) node.delete();
  } catch (error) {
    console.warn('model_pack_file_cleanup_failed', error);
  }
}

function deleteRequired(node: Pick<ExpoFsFile | ExpoFsDirectory, 'exists' | 'delete'>): void {
  if (!node.exists) return;
  if (!node.delete) throw new Error('model_pack_scratch_cleanup_unavailable');
  node.delete();
  if (node.exists) throw new Error('model_pack_scratch_cleanup_failed');
}

function tryMkdir(dir: Pick<ExpoFsDirectory, 'create'>): void {
  try {
    dir.create?.({ intermediates: true, idempotent: true });
  } catch {
    // ignore
  }
}

function assertStagingFitsOnDisk(fs: InstallerFs, directory: ExpoFsDirectory, plan: ModelPackStagingPlan): void {
  let available: unknown;
  try {
    available = fs.Paths.availableDiskSpace;
  } catch (error) {
    console.warn('model_pack_free_disk_space_unavailable', error);
    return;
  }
  if (typeof available !== 'number' || !Number.isFinite(available) || available < 0) {
    console.warn('model_pack_free_disk_space_unavailable');
    return;
  }
  let reusableBytes = 0;
  for (const entry of plan.files) {
    const file = stagedFile(fs, directory, entry.path);
    const size = file.exists ? file.size : 0;
    if (typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 && size <= entry.sizeBytes) reusableBytes += size;
  }
  const requiredBytes = Math.max(0, plan.totalBytes - reusableBytes);
  if (requiredBytes > available) throw new ModelPackInsufficientDiskSpaceError(requiredBytes, available);
}

export async function excludeDirectoryFromBackup(
  directoryUri: string,
  exclude?: (directoryUri: string) => Promise<void>,
): Promise<void> {
  try {
    await exclude?.(directoryUri);
  } catch (error) {
    console.warn('model_pack_backup_exclusion_failed', error instanceof Error ? error.name : 'unknown');
  }
}

function ensureParentDirs(fs: InstallerFs, rootDir: ExpoFsDirectory, parentParts: readonly string[]): ExpoFsDirectory {
  let dir = rootDir;
  for (const part of parentParts) {
    dir = new fs.Directory(dir, part);
    tryMkdir(dir);
  }
  return dir;
}

function stagedFile(fs: InstallerFs, scratchDir: ExpoFsDirectory, filePath: string): ExpoFsFile {
  const parts = filePathParts(filePath);
  const parentParts = parts.slice(0, -1);
  const filename = parts[parts.length - 1]!;
  const dir = ensureParentDirs(fs, scratchDir, parentParts);
  return new fs.File(dir, filename);
}

// Large models must never be materialized in the JS heap. This reader owns both native
// partial rehashes and completed native-transfer bodies, with one bounded handle lifecycle.
async function* readFileChunks(file: ExpoFsFile): AsyncGenerator<Uint8Array, void, undefined> {
  const handle = file.open();
  try {
    for (;;) {
      const chunk = handle.readBytes(1024 * 1024);
      if (chunk.byteLength === 0) return;
      yield chunk;
      // Native reads are synchronous: give cancellation and rendering a task between chunks.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    handle.close();
  }
}

async function streamFile(file: ExpoFsFile, onChunk: (chunk: Uint8Array) => void | Promise<void>): Promise<number> {
  let total = 0;
  for await (const chunk of readFileChunks(file)) {
    total += chunk.byteLength;
    await onChunk(chunk);
  }
  return total;
}

function pruneScratchTreeToPlan(
  scratchDir: ExpoFsDirectory,
  filePaths: readonly string[],
): void {
  const allowedFiles = new Set(filePaths);
  allowedFiles.add(RESUME_PLAN_FILE);
  const allowedDirectories = new Set<string>();
  for (const filePath of filePaths) {
    const parts = filePathParts(filePath);
    for (let length = 1; length < parts.length; length += 1) {
      allowedDirectories.add(parts.slice(0, length).join('/'));
    }
  }

  const visit = (directory: ExpoFsDirectory, parentParts: readonly string[]): void => {
    for (const entry of directory.list()) {
      const parts = [...parentParts, entry.name];
      const relativePath = parts.join('/');
      const isDirectory = typeof (entry as ExpoFsDirectory).list === 'function';
      if (isDirectory && allowedDirectories.has(relativePath)) {
        visit(entry as ExpoFsDirectory, parts);
      } else if (!(isDirectory === false && allowedFiles.has(relativePath))) {
        deleteRequired(entry);
      }
    }
  };

  visit(scratchDir, []);
}

type NativeSha256 = { update(chunk: Uint8Array): void; digestHex(): string };

let reportedJsHashFallback = false;

function createModelPackHasher(): ModelPackHasher {
  const Sha256 = requireOptionalNativeModule<{ Sha256?: new () => NativeSha256 }>('HappierCryptoWorker')?.Sha256;
  if (typeof Sha256 !== 'function') {
    if (!reportedJsHashFallback) {
      reportedJsHashFallback = true;
      console.warn('[modelPacks] Native SHA-256 unavailable; verifying model files on the JS thread');
    }
    return createSha256Hasher();
  }
  const native = new Sha256();
  return {
    update: (chunk) => native.update(chunk),
    digestHex: async () => native.digestHex().toLowerCase(),
  };
}

/** Native transfer followed by bounded disk reads through the shared installer core. */
function createDownloadOpener(
  fs: InstallerFs,
  download: NativeModelPackDownload,
  excludeFromBackup?: (directoryUri: string) => Promise<void>,
): (request: ModelPackDownloadRequest) => Promise<ModelPackDownloadStream> {
  return async (request) => {
    if (!request.packId) throw new Error('model_pack_download_packid_missing');
    // The pack lease owns directory cleanup; each concurrent transfer owns one native file.
    const temporaryDir = getPackSiblingDir(fs, request.packId, DOWNLOADS_SUFFIX);
    const temporaryDirectoryExisted = temporaryDir.exists;
    tryMkdir(temporaryDir);
    if (!temporaryDirectoryExisted) await excludeDirectoryFromBackup(temporaryDir.uri, excludeFromBackup);
    const temporaryFile = new fs.File(temporaryDir, randomUUID());
    let chunks: ReturnType<typeof readFileChunks> | undefined;
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      try { await chunks?.return(); } finally { deleteRequired(temporaryFile); }
    };
    try {
      deleteRequired(temporaryFile);
      const result = await download({
        url: request.url, fileUri: temporaryFile.uri, rangeStart: request.rangeStart,
        signal: request.signal, onProgress: request.onProgress,
      });
      const lengthHeader = Object.entries(result.headers).find(([name]) => name.toLowerCase() === 'content-length')?.[1];
      const contentLength = lengthHeader ? Number(lengthHeader) : null;
      const reader = readFileChunks(temporaryFile);
      chunks = reader;
      return {
        contentLength: Number.isFinite(contentLength) ? contentLength : null,
        isPartial: result.status === 206,
        read: async () => {
          const result = await reader.next();
          if (result.done) { await close(); return null; }
          return result.value;
        },
        cancel: close,
      };
    } catch (error) {
      try { await close(); } catch (cleanupError) {
        console.warn('model_pack_download_cleanup_failed', cleanupError);
      }
      throw error;
    }
  };
}

export function createExpoModelPackInstallerHost(opts: {
  fs: InstallerFs;
  download?: NativeModelPackDownload;
  /**
   * Awaited immediately before and again after this pack's live directory bytes
   * change. Native engines cache by that stable directory path: the first
   * retirement drops engines built from the predecessor, and the second closes
   * the creator window between that retirement and the filesystem mutation.
   */
  invalidatePackRuntime?: InvalidatePackRuntime;
  excludeFromBackup?: (directoryUri: string) => Promise<void>;
  operationLease?: ExpoModelPackOperationLease;
}): ModelPackInstallerHost {
  const { fs } = opts;

  return {
    openDownload: createDownloadOpener(fs, opts.download ?? downloadNativeModelPackFile, opts.excludeFromBackup),
    createHasher: createModelPackHasher,
    beginStaging: async (packId, plan: ModelPackStagingPlan): Promise<ModelPackStagingHandle> => {
      const lease = opts.operationLease ?? acquireOperationLease(fs, packId);
      assertOperationAvailable(fs, packId, lease);
      const releaseStagingLease = () => { if (!opts.operationLease) lease.release(); };
      // `Directory.move` mutates the instance uri, so never reuse a captured handle
      // across a move. Build a fresh handle for the current path each time.
      const freshScratchDir = () => getPackSiblingDir(fs, packId, SCRATCH_SUFFIX);
      const freshBackupDir = () => getPackSiblingDir(fs, packId, BACKUP_SUFFIX);
      const freshIntentFile = () => getPackSiblingFile(fs, packId, INTENT_SUFFIX);
      const invalidateLivePackRuntime = async (): Promise<void> => {
        await opts.invalidatePackRuntime?.(getPackRootDir(fs, packId).uri);
      };

      let promoted = false;
      let promotionSettled = false;
      let promotionRecovery: ModelPackDurableRecoveryRecord | null = null;
      let promotionPhase: 'swap_prepared' | 'metadata_pending' | 'metadata_committed' | 'rollback_pending' = 'swap_prepared';
      let promotionPriorInstall: ModelPackPromotionPriorInstallV1 = null;
      const promotionStartedAtMs = Date.now();
      const promotionToken = randomUUID();

      const writeIntent = () => freshIntentFile().write(JSON.stringify({
        schemaVersion: 1,
        packId,
        phase: promotionPhase,
        startedAtMs: promotionStartedAtMs,
        token: promotionToken,
        priorInstall: promotionPriorInstall,
        recovery: promotionRecovery,
      }));

      const freshResumePlanFile = () => new fs.File(freshScratchDir(), RESUME_PLAN_FILE);

      try {
        let storedPlanKey: string | null = null;
        try {
          if (freshResumePlanFile().exists) {
            const stored = JSON.parse(await freshResumePlanFile().text()) as { key?: unknown };
            storedPlanKey = typeof stored.key === 'string' ? stored.key : null;
          }
        } catch {
          storedPlanKey = null;
        }
        if (storedPlanKey !== plan.key) {
          deleteRequired(freshScratchDir());
        } else if (freshScratchDir().exists) {
          pruneScratchTreeToPlan(freshScratchDir(), plan.filePaths);
        }
        assertStagingFitsOnDisk(fs, freshScratchDir(), plan);
        tryMkdir(freshScratchDir());
        await excludeDirectoryFromBackup(freshScratchDir().uri, opts.excludeFromBackup);
        const resumePlanFile = freshResumePlanFile();
        try {
          resumePlanFile.create?.();
        } catch {
          // ignore; write creates/replaces on supported Expo hosts
        }
        resumePlanFile.write(JSON.stringify({ schemaVersion: 1, key: plan.key, filePaths: plan.filePaths }));
      } catch (error) {
        releaseStagingLease();
        throw error;
      }

      return {
        copyInstalledFile: async (filePath) => {
          const source = stagedFile(fs, getPackRootDir(fs, packId), filePath);
          if (!source.exists) return false;
          const target = stagedFile(fs, freshScratchDir(), filePath);
          // Expo copy does not overwrite an empty file retained after a failed append.
          deleteRequired(target);
          source.copy(target);
          return true;
        },
        partialByteLength: async (filePath) => {
          const file = stagedFile(fs, freshScratchDir(), filePath);
          if (!file.exists) return 0;
          // Prefer the cheap size property; fall back to a streaming count only
          // if absent so resume never materializes the whole partial.
          if (typeof file.size === 'number' && file.size >= 0) return file.size;
          try {
            return await streamFile(file, () => undefined);
          } catch (error) {
            console.warn('model_pack_partial_read_failed', error);
            return 0;
          }
        },
        streamPartial: async (filePath, onChunk) => {
          const file = stagedFile(fs, freshScratchDir(), filePath);
          if (!file.exists) return 0;
          return streamFile(file, onChunk);
        },
        resetPartial: async (filePath) => {
          const file = stagedFile(fs, freshScratchDir(), filePath);
          deleteRequired(file);
        },
        appendDownloadedChunk: async (filePath, chunk) => {
          // LB-L1: append in place — no read-back / concat / full rewrite.
          const file = stagedFile(fs, freshScratchDir(), filePath);
          if (!file.exists) {
            try {
              file.create?.();
            } catch {
              // ignore
            }
          }
          file.write(chunk, { append: true });
        },
        writeManifest: async (manifest) => {
          const meta = getMetaFile(fs, freshScratchDir());
          try {
            meta.create?.();
          } catch {
            // ignore
          }
          meta.write(JSON.stringify({ manifest }));
        },
        promote: async (declaredPriorInstall) => {
          const liveDir = getPackRootDir(fs, packId);
          promotionPriorInstall = declaredPriorInstall === undefined
            ? (liveDir.exists
                ? Object.freeze({ scopeKey: `filesystem:${liveDir.uri}`, identityKey: packId })
                : null)
            : declaredPriorInstall;
          if (liveDir.exists && freshBackupDir().exists && !freshIntentFile().exists) {
            deleteRequired(freshBackupDir());
          }
          deleteRequired(freshResumePlanFile());
          // Durable promote-intent marker, written BEFORE the swap window opens so
          // a crash between the two moves is recoverable on boot (X-M1).
          const intent = freshIntentFile();
          try {
            intent.create?.();
          } catch {
            // ignore
          }
          writeIntent();

          // The live bytes are about to be replaced: drop everything keyed on this
          // directory while it still holds the superseded pack.
          await invalidateLivePackRuntime();

          let backupCreated = false;
          let swapWindowClosed = false;
          try {
            if (liveDir.exists) {
              liveDir.move(freshBackupDir());
              backupCreated = true;
            } else {
              swapWindowClosed = true;
            }
            freshScratchDir().move(getPackRootDir(fs, packId));
            promoted = true;
            swapWindowClosed = true;
            await excludeDirectoryFromBackup(getPackRootDir(fs, packId).uri, opts.excludeFromBackup);
          } catch (error) {
            let rollbackRestored = !backupCreated;
            if (!promoted && backupCreated) {
              try {
                freshBackupDir().move(getPackRootDir(fs, packId));
                rollbackRestored = true;
              } catch {
                rollbackRestored = false;
              }
            }
            if (rollbackRestored) {
              swapWindowClosed = true;
            }
            if (swapWindowClosed && !promoted) {
              // A creator can begin after the pre-swap retirement and before a
              // failed swap restores the predecessor. Retire it again before
              // exposing that restored directory to a later attempt.
              await invalidateLivePackRuntime();
            }
            throw error;
          } finally {
            if (swapWindowClosed && !promoted) {
              tryDelete(freshIntentFile());
            }
          }
          return {
            rootLocation: getPackRootDir(fs, packId).uri,
            prepareDurableCommit: async (recovery) => {
              if (promotionSettled) throw new Error('model_pack_promotion_settled');
              promotionRecovery = recovery;
              promotionPhase = 'metadata_pending';
              writeIntent();
            },
            markDurableCommitted: async () => {
              if (promotionSettled) throw new Error('model_pack_promotion_settled');
              promotionPhase = 'metadata_committed';
              writeIntent();
            },
            commit: async () => {
              if (promotionSettled) return;
              // A load may have started after the pre-swap invalidation and
              // completed while the filesystem move was in progress. Retire it
              // before this promotion can complete, so only a later load can
              // publish an engine for the successor bytes.
              await invalidateLivePackRuntime();
              deleteRequired(freshIntentFile());
              promotionSettled = true;
              tryDelete(freshBackupDir());
            },
            rollback: async () => {
              if (promotionSettled) return;
              promotionPhase = 'rollback_pending';
              writeIntent();
              // Rollback swaps the promoted bytes back out of the same live path,
              // so anything cached against it is stale again.
              await invalidateLivePackRuntime();
              const liveDir = getPackRootDir(fs, packId);
              deleteRequired(liveDir);
              if (backupCreated && freshBackupDir().exists) {
                if (promotionPriorInstall) freshBackupDir().move(getPackRootDir(fs, packId));
                else deleteRequired(freshBackupDir());
              } else if (promotionPriorInstall) {
                throw new Error('model_pack_promotion_prior_missing');
              }
              await invalidateLivePackRuntime();
              promoted = false;
            },
            completeRollback: async () => {
              if (promotionSettled) return;
              promotionSettled = true;
              deleteRequired(freshIntentFile());
            },
          };
        },
        cleanup: async () => {
          // On failure keep the scratch dir so the next attempt resumes; only a
          // successful promote consumes it (scratch was moved to live). Never
          // delete the live dir.
          if (promoted) {
            tryDelete(freshScratchDir());
          }
          try {
            deleteRequired(getPackSiblingDir(fs, packId, DOWNLOADS_SUFFIX));
            deleteRequired(getPackSiblingFile(fs, packId, DOWNLOAD_SUFFIX));
          } finally { releaseStagingLease(); }
        },
      };
    },
  };
}

/**
 * Boot-time reconciliation for a single pack (X-M1). Mirrors the daemon node
 * host: if a promote-intent marker survives, roll the interrupted atomic swap
 * forward or back deterministically. Returns true when a backup was restored.
 *
 * Without an OS directory listing on the Expo `Directory` handle, callers pass
 * the candidate `packId`s to reconcile (the catalog/settings layer already knows
 * the installable pack ids). Safe to call for any pack id; a no-op when no intent
 * marker is present.
 */
export async function reconcileExpoModelPackPromotion(opts: {
  fs: InstallerFs;
  packId: string;
  outcome?: 'commit' | 'rollback';
  /** Awaited on both sides of a rollback that rewrites the live directory (see `createExpoModelPackInstallerHost`). */
  invalidatePackRuntime?: InvalidatePackRuntime;
  operationLease?: ExpoModelPackOperationLease;
}): Promise<boolean> {
  return reconcileExpoModelPackPromotionOwned(opts, opts.operationLease);
}

async function reconcileExpoModelPackPromotionOwned(opts: {
  fs: InstallerFs;
  packId: string;
  outcome?: 'commit' | 'rollback';
  invalidatePackRuntime?: InvalidatePackRuntime;
}, lease?: ExpoModelPackOperationLease): Promise<boolean> {
  const { fs, packId } = opts;
  assertOperationAvailable(fs, packId, lease);
  deleteRequired(getPackSiblingDir(fs, packId, DOWNLOADS_SUFFIX));
  deleteRequired(getPackSiblingFile(fs, packId, DOWNLOAD_SUFFIX));
  const intentFile = getPackSiblingFile(fs, packId, INTENT_SUFFIX);
  const liveDir = getPackRootDir(fs, packId);
  const backupDir = getPackSiblingDir(fs, packId, BACKUP_SUFFIX);
  if (!intentFile.exists) {
    if (liveDir.exists && backupDir.exists) {
      deleteRequired(backupDir);
    }
    return false;
  }

  let raw: unknown;
  try {
    if (
      typeof intentFile.size === 'number'
      && (!Number.isSafeInteger(intentFile.size)
        || intentFile.size < 0
        || intentFile.size > MODEL_PACK_PROMOTION_INTENT_MAX_BYTES)
    ) {
      throw new Error('model_pack_promotion_intent_invalid');
    }
    raw = JSON.parse(await intentFile.text()) as unknown;
  } catch {
    throw new Error('model_pack_promotion_intent_invalid');
  }
  let intent: ModelPackPromotionIntentV1;
  try {
    intent = parseModelPackPromotionIntentV1(raw, packId);
  } catch {
    if (!isLegacyModelPackPromotionIntent(raw, packId)) {
      throw new Error('model_pack_promotion_intent_invalid');
    }
    if (liveDir.exists && !backupDir.exists) {
      throw new Error('model_pack_promotion_legacy_ambiguous');
    }
    intent = {
      schemaVersion: 1,
      packId,
      phase: 'swap_prepared',
      startedAtMs: 0,
      token: 'legacy',
      priorInstall: backupDir.exists
        ? Object.freeze({ scopeKey: `legacy-filesystem:${liveDir.uri}`, identityKey: packId })
        : null,
      recovery: null,
    };
  }

  const outcome = opts.outcome ?? (intent.phase === 'swap_prepared'
    ? 'rollback'
    : null);
  if (!outcome) throw new Error('model_pack_promotion_outcome_required');

  if (outcome === 'commit') {
    if (!liveDir.exists) throw new Error('model_pack_promotion_live_missing');
    deleteRequired(intentFile);
    deleteRequired(backupDir);
    return false;
  }

  let restored = false;
  let liveBytesMutated = false;

  if (backupDir.exists) {
    // Crash in the swap window: roll back to the prior install. The live bytes
    // change here too, so this is a live-directory mutation like promote/remove.
    await opts.invalidatePackRuntime?.(liveDir.uri);
    try {
      if (liveDir.exists) {
        deleteRequired(liveDir);
        liveBytesMutated = true;
      }
      if (intent.priorInstall) {
        backupDir.move(getPackRootDir(fs, packId));
        liveBytesMutated = true;
        restored = true;
      } else {
        deleteRequired(backupDir);
      }
    } catch (error) {
      // Leave the marker so a later run can retry rather than losing the backup,
      // and stop callers from observing a topology that did not converge.
      throw new Error('model_pack_promotion_rollback_failed', { cause: error });
    }
  } else if (intent.priorInstall && !liveDir.exists) {
    throw new Error('model_pack_promotion_prior_missing');
  } else if (liveDir.exists && !intent.priorInstall) {
    // Uncommitted first install has no prior tree to restore.
    await opts.invalidatePackRuntime?.(liveDir.uri);
    deleteRequired(liveDir);
    liveBytesMutated = true;
  }

  if (liveBytesMutated) {
    // A creator can start after the pre-mutation retirement and load bytes that
    // this recovery just replaced or deleted. Close that window before removing
    // the durable marker that tells a later caller reconciliation is complete.
    await opts.invalidatePackRuntime?.(liveDir.uri);
  }
  deleteRequired(getPackSiblingFile(fs, packId, INTENT_SUFFIX));
  return restored;
}

function throwIfRemoveAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('model_pack_remove_aborted');
}

export async function removeExpoModelPackWithHost(opts: {
  fs: InstallerFs;
  packId: string;
  signal?: AbortSignal;
  /** Awaited on both sides of a live-directory deletion (see `createExpoModelPackInstallerHost`). */
  invalidatePackRuntime?: InvalidatePackRuntime;
}): Promise<void> {
  const { fs, packId, signal } = opts;
  const install = activeOperations.get(installKeyFor(fs, packId))?.install;
  if (install) {
    install.controller.abort();
    await install.promise.catch(() => undefined);
  }
  const lease = acquireOperationLease(fs, packId);
  try {
    throwIfRemoveAborted(signal);
    await reconcileExpoModelPackPromotionOwned(
      { fs, packId, outcome: 'rollback', invalidatePackRuntime: opts.invalidatePackRuntime },
      lease,
    );
    throwIfRemoveAborted(signal);

    deleteRequired(getPackSiblingDir(fs, packId, SCRATCH_SUFFIX));
    throwIfRemoveAborted(signal);
    const liveDir = getPackRootDir(fs, packId);
    const hadLivePack = liveDir.exists;
    await opts.invalidatePackRuntime?.(liveDir.uri);
    deleteRequired(liveDir);
    if (hadLivePack) {
      // The first retirement only reaches engines already published. A creator
      // that began in the interval before this delete can finish against the
      // predecessor bytes, so retire the directory again before remove reports
      // success (or observes a late caller abort).
      await opts.invalidatePackRuntime?.(liveDir.uri);
    }
    throwIfRemoveAborted(signal);
    deleteRequired(getPackSiblingDir(fs, packId, BACKUP_SUFFIX));
    throwIfRemoveAborted(signal);
    deleteRequired(getPackSiblingFile(fs, packId, INTENT_SUFFIX));
  } finally {
    lease.release();
  }
}
