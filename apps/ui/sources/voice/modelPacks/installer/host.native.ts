/**
 * Expo-FS host adapter for the shared model-pack installer core.
 *
 * Implements {@link ModelPackInstallerHost} on top of Expo `File`/`Directory`
 * and `fetch`, so the UI native installer runs the one shared
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
 * Streaming: chunks are appended with `file.write(chunk, { append: true })`
 * (LB-L1), so a large pack is written incrementally instead of read+concat+
 * rewriting the whole staged file on every chunk.
 *
 * Digest: the adapter uses the shared incremental SHA-256 implementation, so
 * native installs do not retain downloaded chunks until finalize.
 */

import { randomUUID } from '@/platform/randomUUID';

import type {
  ModelPackDownloadRequest,
  ModelPackDownloadStream,
  ModelPackDurableRecoveryRecord,
  ModelPackInstallerHost,
  ModelPackPromotionIntentV1,
  ModelPackPromotionPriorInstallV1,
  ModelPackStagingPlan,
  ModelPackStagingHandle,
} from '@happier-dev/voice-modelpacks';
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

const SCRATCH_SUFFIX = '.scratch';
const BACKUP_SUFFIX = '.backup';
const INTENT_SUFFIX = '.promote-intent';
const RESUME_PLAN_FILE = '.resume-plan.json';
type ExpoModelPackOperationLease = Readonly<{
  key: string;
  token: symbol;
  release: () => void;
}>;

const activeOperationTokens = new Map<string, symbol>();

function installKeyFor(fs: InstallerFs, packId: string): string {
  return getPackRootDir(fs, packId).uri;
}

function acquireOperationLease(fs: InstallerFs, packId: string): ExpoModelPackOperationLease {
  const key = installKeyFor(fs, packId);
  if (activeOperationTokens.has(key)) throw new Error('model_pack_install_already_in_progress');
  const token = Symbol(key);
  activeOperationTokens.set(key, token);
  let released = false;
  return Object.freeze({
    key,
    token,
    release: () => {
      if (released) return;
      released = true;
      if (activeOperationTokens.get(key) === token) activeOperationTokens.delete(key);
    },
  });
}

function assertOperationAvailable(
  fs: InstallerFs,
  packId: string,
  lease?: ExpoModelPackOperationLease,
): void {
  const key = installKeyFor(fs, packId);
  const activeToken = activeOperationTokens.get(key);
  if (activeToken && activeToken !== lease?.token) {
    throw new Error('model_pack_install_already_in_progress');
  }
}

function tryDelete(node: Pick<ExpoFsFile | ExpoFsDirectory, 'exists' | 'delete'>): void {
  try {
    if (node.exists && node.delete) node.delete({ idempotent: true });
  } catch {
    // ignore
  }
}

function deleteRequired(node: Pick<ExpoFsFile | ExpoFsDirectory, 'exists' | 'delete'>): void {
  if (!node.exists) return;
  if (!node.delete) throw new Error('model_pack_scratch_cleanup_unavailable');
  node.delete({ idempotent: true });
  if (node.exists) throw new Error('model_pack_scratch_cleanup_failed');
}

function tryMkdir(dir: Pick<ExpoFsDirectory, 'create'>): void {
  try {
    dir.create?.({ intermediates: true, idempotent: true });
  } catch {
    // ignore
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

async function streamFile(file: ExpoFsFile, onChunk: (chunk: Uint8Array) => void | Promise<void>): Promise<number> {
  const readable = (file as ExpoFsFile & { readableStream?: () => ReadableStream<Uint8Array> }).readableStream;
  if (typeof readable !== 'function') {
    throw new Error('model_pack_partial_stream_unavailable');
  }
  const reader = readable.call(file).getReader();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return total;
      if (!value || value.byteLength === 0) continue;
      const chunk = new Uint8Array(value);
      total += chunk.byteLength;
      await onChunk(chunk);
    }
  } finally {
    reader.releaseLock?.();
  }
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

/**
 * Open a download stream. When `rangeStart` is set, request the remaining bytes
 * with an HTTP Range header; `isPartial` reflects whether the server honored it
 * (HTTP 206).
 */
function createDownloadOpener(
  fetchImpl: typeof fetch,
  timeoutMs: number,
): (request: ModelPackDownloadRequest) => Promise<ModelPackDownloadStream> {
  return async (request) => {
    const headers: Record<string, string> = {};
    if (request.rangeStart && request.rangeStart > 0) {
      headers.Range = `bytes=${request.rangeStart}-`;
    }
    const response = await Promise.race([
      fetchImpl(request.url, { signal: request.signal, headers }),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
        (timer as unknown as { unref?: () => void })?.unref?.();
      }),
    ]);
    if (!response.ok) {
      throw new Error(`model_pack_download_failed:${response.status}`);
    }

    const isPartial = response.status === 206;
    const contentLengthHeader = response.headers.get('content-length');
    const contentLength = contentLengthHeader ? Number(contentLengthHeader) : null;

    const body = (response as unknown as { body?: { getReader?: () => any } }).body;
    const reader = body?.getReader?.();
    if (reader) {
      return {
        contentLength: Number.isFinite(contentLength) ? contentLength : null,
        isPartial,
        read: async () => {
          const { done, value } = await reader.read();
          if (done) return null;
          return value ? new Uint8Array(value) : new Uint8Array();
        },
        cancel: () => {
          void reader.cancel?.().catch?.(() => undefined);
        },
      };
    }

    // No streaming body: deliver the full buffer once.
    const buf = new Uint8Array(await response.arrayBuffer());
    let delivered = false;
    return {
      contentLength: buf.byteLength,
      isPartial,
      read: async () => {
        if (delivered) return null;
        delivered = true;
        return buf;
      },
    };
  };
}

export function createExpoModelPackInstallerHost(opts: {
  fs: InstallerFs;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  /**
   * Awaited immediately before this pack's live directory bytes change, while
   * the superseded pack is still the one on disk. Native engines cache by that
   * stable directory path, so dropping them after the swap would leave a window
   * in which the replaced pack still serves its predecessor's bytes.
   */
  invalidatePackRuntime?: InvalidatePackRuntime;
}): ModelPackInstallerHost {
  const { fs, fetchImpl } = opts;

  return {
    openDownload: createDownloadOpener(fetchImpl, opts.timeoutMs),
    createHasher: createSha256Hasher,
    beginStaging: async (packId, plan: ModelPackStagingPlan): Promise<ModelPackStagingHandle> => {
      const lease = acquireOperationLease(fs, packId);
      // `Directory.move` mutates the instance uri, so never reuse a captured handle
      // across a move. Build a fresh handle for the current path each time.
      const freshScratchDir = () => getPackSiblingDir(fs, packId, SCRATCH_SUFFIX);
      const freshBackupDir = () => getPackSiblingDir(fs, packId, BACKUP_SUFFIX);
      const freshIntentFile = () => getPackSiblingFile(fs, packId, INTENT_SUFFIX);

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
        tryMkdir(freshScratchDir());
        const resumePlanFile = freshResumePlanFile();
        try {
          resumePlanFile.create?.();
        } catch {
          // ignore; write creates/replaces on supported Expo hosts
        }
        resumePlanFile.write(JSON.stringify({ schemaVersion: 1, key: plan.key, filePaths: plan.filePaths }));
      } catch (error) {
        lease.release();
        throw error;
      }

      return {
        partialByteLength: async (filePath) => {
          const file = stagedFile(fs, freshScratchDir(), filePath);
          if (!file.exists) return 0;
          // Prefer the cheap size property; fall back to a streaming count only
          // if absent so resume never materializes the whole partial.
          if (typeof file.size === 'number' && file.size >= 0) return file.size;
          try {
            return await streamFile(file, () => undefined);
          } catch {
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
          tryDelete(file);
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
            tryDelete(freshBackupDir());
          }
          tryDelete(freshResumePlanFile());
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
          await opts.invalidatePackRuntime?.(getPackRootDir(fs, packId).uri);

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
              promotionSettled = true;
              tryDelete(freshIntentFile());
              tryDelete(freshBackupDir());
            },
            rollback: async () => {
              if (promotionSettled) return;
              promotionPhase = 'rollback_pending';
              writeIntent();
              // Rollback swaps the promoted bytes back out of the same live path,
              // so anything cached against it is stale again.
              await opts.invalidatePackRuntime?.(getPackRootDir(fs, packId).uri);
              deleteRequired(getPackRootDir(fs, packId));
              if (backupCreated && freshBackupDir().exists) {
                if (promotionPriorInstall) freshBackupDir().move(getPackRootDir(fs, packId));
                else deleteRequired(freshBackupDir());
              } else if (promotionPriorInstall) {
                throw new Error('model_pack_promotion_prior_missing');
              }
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
          lease.release();
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
  /** Awaited before a rollback rewrites the live directory (see `createExpoModelPackInstallerHost`). */
  invalidatePackRuntime?: InvalidatePackRuntime;
}): Promise<boolean> {
  return reconcileExpoModelPackPromotionOwned(opts);
}

async function reconcileExpoModelPackPromotionOwned(opts: {
  fs: InstallerFs;
  packId: string;
  outcome?: 'commit' | 'rollback';
  invalidatePackRuntime?: InvalidatePackRuntime;
}, lease?: ExpoModelPackOperationLease): Promise<boolean> {
  const { fs, packId } = opts;
  assertOperationAvailable(fs, packId, lease);
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

  if (backupDir.exists) {
    // Crash in the swap window: roll back to the prior install. The live bytes
    // change here too, so this is a live-directory mutation like promote/remove.
    await opts.invalidatePackRuntime?.(liveDir.uri);
    try {
      if (liveDir.exists) deleteRequired(liveDir);
      if (intent.priorInstall) {
        backupDir.move(getPackRootDir(fs, packId));
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
    deleteRequired(liveDir);
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
  /** Awaited before the live directory is deleted (see `createExpoModelPackInstallerHost`). */
  invalidatePackRuntime?: InvalidatePackRuntime;
}): Promise<void> {
  const { fs, packId, signal } = opts;
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
    await opts.invalidatePackRuntime?.(getPackRootDir(fs, packId).uri);
    deleteRequired(getPackRootDir(fs, packId));
    throwIfRemoveAborted(signal);
    deleteRequired(getPackSiblingDir(fs, packId, BACKUP_SUFFIX));
    throwIfRemoveAborted(signal);
    deleteRequired(getPackSiblingFile(fs, packId, INTENT_SUFFIX));
  } finally {
    lease.release();
  }
}
