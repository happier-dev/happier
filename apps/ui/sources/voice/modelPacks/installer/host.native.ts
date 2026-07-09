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
 *   intent  `.<packId>.promote-intent` — durable promote-intent marker, present
 *           only across the swap window so a crash there is recoverable on boot
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
  ModelPackInstallerHost,
  ModelPackStagingHandle,
} from '@happier-dev/voice-modelpacks';
import { createSha256Hasher } from '@happier-dev/voice-modelpacks';

import {
  filePathParts,
  getMetaFile,
  getPackRootDir,
  getPackSiblingDir,
  getPackSiblingFile,
} from './paths';
import type { ExpoFsDirectory, ExpoFsFile, InstallerFs } from './types';

const SCRATCH_SUFFIX = '.scratch';
const BACKUP_SUFFIX = '.backup';
const INTENT_SUFFIX = '.promote-intent';

function tryDelete(node: Pick<ExpoFsFile | ExpoFsDirectory, 'exists' | 'delete'>): void {
  try {
    if (node.exists && node.delete) node.delete({ idempotent: true });
  } catch {
    // ignore
  }
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
}): ModelPackInstallerHost {
  const { fs, fetchImpl } = opts;

  return {
    openDownload: createDownloadOpener(fetchImpl, opts.timeoutMs),
    createHasher: createSha256Hasher,
    beginStaging: async (packId): Promise<ModelPackStagingHandle> => {
      // `Directory.move` mutates the instance uri, so never reuse a captured handle
      // across a move. Build a fresh handle for the current path each time.
      const freshScratchDir = () => getPackSiblingDir(fs, packId, SCRATCH_SUFFIX);
      const freshBackupDir = () => getPackSiblingDir(fs, packId, BACKUP_SUFFIX);
      const freshIntentFile = () => getPackSiblingFile(fs, packId, INTENT_SUFFIX);

      let promoted = false;

      // Stable scratch dir: do NOT wipe on begin — a prior interrupted attempt
      // left resumable partials here that the core re-hashes and resumes from.
      tryMkdir(freshScratchDir());

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
        promote: async () => {
          const liveDir = getPackRootDir(fs, packId);
          if (liveDir.exists && freshBackupDir().exists && !freshIntentFile().exists) {
            tryDelete(freshBackupDir());
          }
          // Durable promote-intent marker, written BEFORE the swap window opens so
          // a crash between the two moves is recoverable on boot (X-M1).
          const intent = freshIntentFile();
          try {
            intent.create?.();
          } catch {
            // ignore
          }
          intent.write(JSON.stringify({ packId, startedAtMs: Date.now(), token: randomUUID() }));

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
            if (promoted && backupCreated) {
              tryDelete(freshBackupDir());
            }
            // Intent cleared last: only once the swap window is fully closed is the
            // install state durable.
            if (swapWindowClosed) {
              tryDelete(freshIntentFile());
            }
          }
          return { rootLocation: getPackRootDir(fs, packId).uri };
        },
        cleanup: async () => {
          // On failure keep the scratch dir so the next attempt resumes; only a
          // successful promote consumes it (scratch was moved to live). Never
          // delete the live dir.
          if (promoted) {
            tryDelete(freshScratchDir());
          }
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
export function reconcileExpoModelPackPromotion(opts: { fs: InstallerFs; packId: string }): boolean {
  const { fs, packId } = opts;
  const intentFile = getPackSiblingFile(fs, packId, INTENT_SUFFIX);
  const liveDir = getPackRootDir(fs, packId);
  const backupDir = getPackSiblingDir(fs, packId, BACKUP_SUFFIX);
  if (!intentFile.exists) {
    if (liveDir.exists && backupDir.exists) {
      tryDelete(backupDir);
    }
    return false;
  }

  let restored = false;

  if (!liveDir.exists && backupDir.exists) {
    // Crash in the swap window: roll back to the prior install.
    try {
      backupDir.move(getPackRootDir(fs, packId));
      restored = true;
    } catch {
      // Leave the marker so a later run can retry rather than losing the backup.
      return false;
    }
  } else if (liveDir.exists && backupDir.exists) {
    // Swap completed but backup cleanup was interrupted: drop the stale backup.
    tryDelete(getPackSiblingDir(fs, packId, BACKUP_SUFFIX));
  }

  tryDelete(getPackSiblingFile(fs, packId, INTENT_SUFFIX));
  return restored;
}
