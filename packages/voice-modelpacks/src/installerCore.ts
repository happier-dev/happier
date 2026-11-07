/**
 * Shared, host-agnostic model-pack INSTALLER CORE.
 *
 * One installer algorithm shared by the UI native installer
 * (`apps/ui/sources/voice/modelPacks/installer.native.ts`) and the daemon-local
 * installer (`apps/cli/src/daemon/voiceInference/voiceModelPackInstaller.ts`).
 *
 * The core is PURE: every filesystem and network effect is supplied by an
 * injected {@link ModelPackInstallerHost}. It imports no `node:*` or Expo FS at
 * module scope, so it is Metro-safe and binary-safe by construction and never
 * spawns a runtime or package manager.
 *
 * Flow (per pack):
 *   plan (path-safety + URL policy + integrity gate) → for each file:
 *   resume-aware streamed download with incremental hashing + size validation →
 *   verify required files → atomically swap the staged dir into place
 *   (live → backup, staging → live) → cleanup, restoring the prior install on any
 *   swap failure.
 *
 * Resume: each file streams into a per-file scratch path. If a partial download
 * already exists there, its bytes are streamed through the hasher and the
 * remaining bytes are requested with an HTTP `Range: bytes=<offset>-` header,
 * then appended. A partial that already satisfies the manifest size+hash is
 * promoted without any network round-trip.
 */

import type { ModelPackManifest } from '@happier-dev/protocol';
import { assertManifestPathsSafe, assertPackIdFilesystemSafe, filePathParts } from '@happier-dev/protocol/voice/modelPacks/pathSafety';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

import { assertManifestIntegrityVerifiable } from './integrityGate.js';
import {
  assertManifestUrlsAllowed,
  assertModelPackUrlAllowed,
  type ModelPackUrlPolicy,
} from './urlPolicy.js';
import {
  assertVoiceModelPackDeclaredResourcesV1,
  type VoiceModelPackResourcePolicyV1,
} from './resourcePolicy.js';
import {
  parseVoiceModelPackArtifactBindingV1,
  type VoiceModelPackArtifactBindingV1,
} from './artifactBinding.js';
import type {
  ModelPackDurableRecoveryRecord,
  ModelPackPromotionPriorInstallV1,
} from './promotionRecovery.js';

/** Progress for a single pack file or the overall install. */
export type ModelPackCoreProgress = Readonly<{
  loaded: number;
  total: number;
  file?: string;
  /** Bytes already checked against their manifest digest; trails `loaded` while transferred files are read back. */
  verified: number;
  filesDone: number;
  filesTotal: number;
}>;

/** A streamed HTTP body the core reads incrementally. */
export type ModelPackDownloadStream = Readonly<{
  /** Total bytes the server will send for this (possibly ranged) response, when known. */
  contentLength: number | null;
  /** True when the server honored the requested Range (HTTP 206). */
  isPartial: boolean;
  /** Final response URL after redirects. Hosts must expose this for public plugin assets. */
  finalUrl?: string;
  /** Pull the next chunk; resolves `null` when the stream is exhausted. */
  read: () => Promise<Uint8Array | null>;
  /** Stop the underlying response when verification aborts before EOF. */
  cancel?: () => void | Promise<void>;
}>;

export type ModelPackDownloadRequest = Readonly<{
  url: string;
  /** Logical installation identity for hosts that transfer artifact bytes directly to disk. */
  packId?: string;
  /** Numeric transport progress before a disk-backed response is read for verification. */
  onProgress?: (loaded: number) => void;
  /** When set, request `bytes=<rangeStart>-` to resume from this byte offset. */
  rangeStart?: number;
  signal: AbortSignal;
}>;

/**
 * Injected host boundary: filesystem + network + content digest. Implemented by
 * the UI (Expo FS) and the daemon (node fs) adapters. The core never touches a
 * concrete fs/network API directly.
 *
 * Path model: the host owns the packs-root layout. The core addresses everything
 * by a `packId` plus relative POSIX-style file paths (already path-safe). Scratch
 * (staging/backup/partial) locations are the host's responsibility; the core only
 * asks the host to stage, promote, back up, restore, and clean up.
 */
export type ModelPackInstallerHost = Readonly<{
  /** Open a (optionally ranged) download stream. */
  openDownload: (request: ModelPackDownloadRequest) => Promise<ModelPackDownloadStream>;

  /** Incremental SHA-256: create → update(chunk)* → digest() → lowercase hex. */
  createHasher: () => ModelPackHasher;

  /**
   * Begin (or resume) a staged install for `packId`. Returns a handle that owns
   * the staging dir and any in-progress partial files for this attempt.
   */
  beginStaging: (packId: string, plan: ModelPackStagingPlan) => Promise<ModelPackStagingHandle>;
}>;

/** Immutable source binding for resumable scratch. */
export type ModelPackInstallSourceBinding =
  | Readonly<{ kind: 'builtin' }>
  | Readonly<{
      kind: 'plugin';
      pluginId: string;
      packId: string;
      pluginVersion: string;
      artifactBinding: VoiceModelPackArtifactBindingV1;
    }>;

/** Opaque plan key plus the exact files that may exist in staging. */
export type ModelPackStagingPlan = Readonly<{
  key: string;
  filePaths: readonly string[];
  files: readonly Readonly<{ path: string; sizeBytes: number }>[];
  totalBytes: number;
}>;

/**
 * Bind resume bytes to every immutable input that determines their meaning.
 * File ordering is normalized because manifest order is not semantic.
 */
export function deriveModelPackStagingPlan(
  manifest: ModelPackManifest,
  source: ModelPackInstallSourceBinding = Object.freeze({ kind: 'builtin' }),
): ModelPackStagingPlan {
  const canonicalSource = source.kind === 'plugin'
    ? Object.freeze({
        ...source,
        artifactBinding: parseVoiceModelPackArtifactBindingV1(source.artifactBinding),
      })
    : source;
  const files = [...manifest.files]
    .map((file) => [file.path, file.url, file.sha256.toLowerCase(), file.sizeBytes] as const)
    .sort((left, right) => left[0].localeCompare(right[0]));
  const encoded = utf8ToBytes(JSON.stringify([
    'happier.voice.model-pack.resume.v1',
    canonicalSource,
    manifest.packId,
    manifest.kind,
    manifest.model,
    manifest.version,
    files,
  ]));
  return Object.freeze({
    key: bytesToHex(sha256(encoded)).toLowerCase(),
    filePaths: Object.freeze(files.map(([path]) => path)),
    files: Object.freeze(files.map(([path, , , sizeBytes]) => Object.freeze({ path, sizeBytes }))),
    totalBytes: files.reduce((sum, file) => sum + file[3], 0),
  });
}

export type ModelPackHasher = Readonly<{
  update: (chunk: Uint8Array) => void;
  digestHex: () => Promise<string>;
}>;

/**
 * Per-attempt staging handle. Owns the staged file tree and resume scratch for a
 * single {@link installModelPackWithHost} call. All methods address files by the
 * manifest-relative path.
 */
export type ModelPackStagingHandle = Readonly<{
  /**
   * Inspect an already-downloaded partial for `filePath`, returning its current
   * byte length (0 when absent) so the core can resume.
   */
  partialByteLength: (filePath: string) => Promise<number>;

  /** Copy a live file into scratch; false means no source file was present. The core verifies it. */
  copyInstalledFile: (filePath: string) => Promise<boolean>;

  /**
   * Stream existing partial bytes into `onChunk` for resume re-hashing. Returns
   * the byte count streamed. Hosts must not materialize the full partial.
   */
  streamPartial: (filePath: string, onChunk: (chunk: Uint8Array) => void | Promise<void>) => Promise<number>;

  /** Truncate/reset a partial when a resume cannot be trusted. */
  resetPartial: (filePath: string) => Promise<void>;

  /** Append a downloaded chunk to the staged file. */
  appendDownloadedChunk: (filePath: string, chunk: Uint8Array) => Promise<void>;

  /** Persist the verified manifest as `pack.json` in the staged tree. */
  writeManifest: (manifest: ModelPackManifest) => Promise<void>;

  /**
   * Atomically promote the staged tree to the live pack location, backing up and
   * (on failure) restoring the prior install. Returns the live pack location.
   */
  promote: (priorInstall?: ModelPackPromotionPriorInstallV1) => Promise<ModelPackPromotionTransaction>;

  /** Best-effort cleanup of staging/backup scratch (idempotent). */
  cleanup: () => Promise<void>;
}>;

export type ModelPackPromotionTransaction = Readonly<{
  rootLocation: string;
  prepareDurableCommit: (recovery: ModelPackDurableRecoveryRecord) => Promise<void>;
  markDurableCommitted: () => Promise<void>;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
  completeRollback: () => Promise<void>;
}>;

export type ModelPackInstallCoreResult = Readonly<{
  packId: string;
  rootLocation: string;
  manifest: ModelPackManifest;
}>;

export class ModelPackInstallError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'ModelPackInstallError';
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ModelPackInstallError('aborted');
  }
}

// Source measurements on the 254 small Kokoro assets justify six simultaneous transfers.
const MAX_PARALLEL_FILE_DOWNLOADS = 6;
// GitHub release edges can retain a failing exact URL; retry with a distinct query.
const TRANSIENT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

class RetryableTransferFailure {
  constructor(readonly original: unknown) {}
}

function isTransientTransferFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message;
  const status = /^model_pack_download_failed:(\d+)(?::|$)/.exec(message);
  if (status) {
    const code = Number(status[1]);
    return code === 408 || code === 429 || (code >= 500 && code < 600);
  }
  if (/ENOSPC|EACCES|EROFS|no space left|permission denied|read-only file system/i.test(message)) return false;
  // The adapter may include platform-specific native/network errors. Local file operations,
  // policy rejection, verification, and setup errors must never enter the retry loop.
  // Expo iOS includes NSError.description. Restrict its domain to actual transport codes;
  // NSURLErrorDomain also contains permanent filesystem errors (-3000 through -3005).
  const appleCode = /NSURLErrorDomain\s+Code=(-?\d+)/.exec(message);
  if (appleCode) return [-1001, -1003, -1004, -1005, -1006, -1009].includes(Number(appleCode[1]));
  // Node fetch preserves the underlying socket/DNS error in cause.
  const cause = error.cause instanceof Error ? error.cause : undefined;
  const codes = [error, cause].map(value => value && 'code' in value ? String(value.code) : '');
  return codes.some(code => /^(ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)$/.test(code))
    || message === 'timeout'
    || /UnknownHostException|Unable to resolve host|Socket(?:Timeout)?Exception|connection (?:reset|refused)|network request failed|network is unreachable|native_transport_failed|model_pack_download_transport_failed|pinned_http_(?:wall|idle)_timeout/i.test(message);
}

async function transferBoundary<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) {
    if (isTransientTransferFailure(error)) throw new RetryableTransferFailure(error);
    throw error;
  }
}

async function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve) => {
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  throwIfAborted(signal);
}

/**
 * Download one manifest file into staging with Range-resume, incremental hashing,
 * and size validation. Throws (after resetting the partial) on size/hash mismatch.
 */
async function downloadFileResumable(opts: {
  host: ModelPackInstallerHost;
  packId: string;
  staging: ModelPackStagingHandle;
  entry: ModelPackManifest['files'][number];
  signal: AbortSignal;
  /** `verifiedForFile` is set once bytes are hashed; a restarted pass reports it from 0 again. */
  onFileProgress: (loadedForFile: number, verifiedForFile?: number) => void;
  /** Withdraw discarded file bytes, or only hash progress when a full response replaces a Range prefix. */
  onProgressReset: (scope: 'file' | 'verification') => void;
  urlPolicy?: ModelPackUrlPolicy;
  transferUrl?: string;
}): Promise<void> {
  const { host, staging, entry, signal } = opts;
  const expectedSha = entry.sha256.trim().toLowerCase();
  const expectedSize = Math.max(0, Math.trunc(entry.sizeBytes));

  let hasher = host.createHasher();
  let loaded = 0;

  // Resume: re-hash any trustworthy partial, else reset it.
  const existing = await staging.partialByteLength(entry.path);
  throwIfAborted(signal);
  if (existing > 0 && existing <= expectedSize) {
    let streamed = 0;
    try {
      const reported = await staging.streamPartial(entry.path, async (chunk) => {
        throwIfAborted(signal);
        if (chunk.byteLength === 0) return;
        streamed += chunk.byteLength;
        if (streamed > expectedSize) {
          throw new ModelPackInstallError('model_pack_size_mismatch');
        }
        hasher.update(chunk);
        opts.onFileProgress(streamed, streamed);
        throwIfAborted(signal);
      });
      throwIfAborted(signal);
      if (reported !== streamed || streamed !== existing) {
        await staging.resetPartial(entry.path);
        opts.onProgressReset('file');
        return downloadFileResumable({ ...opts, onFileProgress: opts.onFileProgress });
      } else {
        loaded = streamed;
      }
    } catch (error) {
      // Cancelling verification does not invalidate the existing resumable prefix.
      throwIfAborted(signal);
      await staging.resetPartial(entry.path);
      opts.onProgressReset('file');
      if (error instanceof ModelPackInstallError) {
        throw error;
      }
      return downloadFileResumable({ ...opts, onFileProgress: opts.onFileProgress });
    }
  } else if (existing > expectedSize) {
    // Corrupt/overlong partial — start over.
    await staging.resetPartial(entry.path);
    opts.onProgressReset('file');
  }

  // Already complete? Verify hash and skip the network entirely.
  if (loaded === expectedSize && expectedSize > 0) {
    const actualSha = (await hasher.digestHex()).toLowerCase();
    if (actualSha === expectedSha) {
      return;
    }
    await staging.resetPartial(entry.path);
    opts.onProgressReset('file');
    // Fall through to a clean re-download.
    return downloadFileResumable({ ...opts, onFileProgress: opts.onFileProgress });
  }

  throwIfAborted(signal);

  const stream = await transferBoundary(() => host.openDownload({
    url: opts.transferUrl ?? entry.url,
    packId: opts.packId,
    onProgress: (written) => opts.onFileProgress(Math.min(expectedSize, loaded + Math.max(0, written))),
    rangeStart: loaded > 0 ? loaded : undefined,
    signal,
  }));
  try {
    assertModelPackUrlAllowed(stream.finalUrl ?? entry.url, opts.urlPolicy);

    // An ignored Range sends a full body, so reset the prefix before appending it.
    if (loaded > 0 && !stream.isPartial) {
      await staging.resetPartial(entry.path);
      loaded = 0;
      hasher = host.createHasher();
      opts.onProgressReset('verification');
    }

    await consumeStream({
      stream: { ...stream, read: () => transferBoundary(() => stream.read()) },
      hasher,
      staging,
      entry,
      startOffset: loaded,
      expectedSize,
      signal,
      onFileProgress: opts.onFileProgress,
      finalize: async (finalLoaded) => {
        if (finalLoaded !== expectedSize) {
          await staging.resetPartial(entry.path);
          throw new ModelPackInstallError('model_pack_size_mismatch');
        }
        const actualSha = (await hasher.digestHex()).toLowerCase();
        if (actualSha !== expectedSha) {
          await staging.resetPartial(entry.path);
          throw new ModelPackInstallError('model_pack_sha256_mismatch');
        }
      },
    });
  } catch (error) {
    await cancelDownloadAfterFailure(stream);
    throw error;
  }
}

async function consumeStream(opts: {
  stream: ModelPackDownloadStream;
  hasher: ModelPackHasher;
  staging: ModelPackStagingHandle;
  entry: ModelPackManifest['files'][number];
  startOffset: number;
  expectedSize: number;
  signal: AbortSignal;
  onFileProgress: (loadedForFile: number, verifiedForFile?: number) => void;
  finalize: (finalLoaded: number) => Promise<void>;
}): Promise<void> {
  let loaded = opts.startOffset;
  for (;;) {
    throwIfAborted(opts.signal);
    const chunk = await opts.stream.read();
    throwIfAborted(opts.signal);
    if (chunk === null) break;
    if (chunk.byteLength === 0) continue;
    loaded += chunk.byteLength;
    if (loaded > opts.expectedSize) {
      await opts.staging.resetPartial(opts.entry.path);
      throw new ModelPackInstallError('model_pack_size_mismatch');
    }
    opts.hasher.update(chunk);
    await opts.staging.appendDownloadedChunk(opts.entry.path, chunk);
    opts.onFileProgress(loaded, loaded);
  }
  await opts.finalize(loaded);
}

async function cancelDownloadAfterFailure(stream: ModelPackDownloadStream): Promise<void> {
  try { await stream.cancel?.(); } catch (error) {
    console.warn('model_pack_download_cleanup_failed', error);
  }
}

/**
 * Install (or atomically replace) a model pack using an injected host.
 *
 * Pure orchestration: planning, resume-aware download, verification, atomic swap,
 * and restore-on-failure live here; every effect is delegated to {@link host}.
 *
 * Preconditions enforced before any staging/network resource is opened:
 *  - pack id + every file path are filesystem-safe (path traversal rejected),
 *  - every file URL satisfies the {@link ModelPackUrlPolicy} (HTTPS without
 *    configured URL credentials),
 *  - every file declares a verifiable sha256 digest + positive size (SD-M3).
 */
export async function installModelPackWithHost(opts: {
  host: ModelPackInstallerHost;
  packId: string;
  manifest: ModelPackManifest;
  signal: AbortSignal;
  urlPolicy?: ModelPackUrlPolicy;
  resourcePolicy?: VoiceModelPackResourcePolicyV1;
  sourceBinding?: ModelPackInstallSourceBinding;
  priorInstall?: ModelPackPromotionPriorInstallV1;
  priorManifest?: ModelPackManifest;
  onProgress?: (progress: ModelPackCoreProgress) => void;
  durableCommit?: Readonly<{
    recovery: ModelPackDurableRecoveryRecord;
    commit: (result: ModelPackInstallCoreResult) => Promise<void>;
    rollback: (result: ModelPackInstallCoreResult) => Promise<void>;
  }>;
}): Promise<ModelPackInstallCoreResult> {
  const packId = assertPackIdFilesystemSafe(opts.packId, () => new ModelPackInstallError('model_pack_invalid_pack_id'));
  if (opts.manifest.packId !== packId) {
    throw new ModelPackInstallError('model_pack_manifest_packid_mismatch');
  }
  // Reject unsafe file paths before opening any staging or network resource.
  assertManifestPathsSafe(opts.manifest);
  for (const entry of opts.manifest.files) {
    // Normalizes + re-validates each path; throws model_pack_invalid_path.
    filePathParts(entry.path);
  }

  // SD-M3: refuse to download/promote a pack we cannot verify.
  assertManifestIntegrityVerifiable(opts.manifest);
  assertVoiceModelPackDeclaredResourcesV1(opts.manifest.files, opts.resourcePolicy);
  // SD-L5: HTTPS download URLs without configured URL credentials.
  assertManifestUrlsAllowed(opts.manifest, opts.urlPolicy);

  throwIfAborted(opts.signal);

  const total = opts.manifest.files.reduce(
    (sum, f) => sum + (Number.isFinite(f.sizeBytes) ? Math.max(0, Math.trunc(f.sizeBytes)) : 0),
    0,
  );
  const staging = await opts.host.beginStaging(
    packId,
    deriveModelPackStagingPlan(opts.manifest, opts.sourceBinding),
  );

  let loadedTotal = 0;
  let promotion: ModelPackPromotionTransaction | null = null;
  let durableCommitted = false;
  try {
    const priorFiles = new Map((opts.priorManifest?.packId === packId ? opts.priorManifest.files : [])
      .map((file) => [file.path, file]));
    const pack = new AbortController();
    const forwardAbort = () => pack.abort();
    opts.signal.addEventListener('abort', forwardAbort, { once: true });
    if (opts.signal.aborted) pack.abort();
    let next = 0;
    let verifiedTotal = 0;
    let filesDone = 0;
    const failures: unknown[] = [];
    // Largest first: a pack's few big files dominate its transfer and verification time, so they start
    // at once while the remaining workers drain the many small files, instead of starting alone at the end.
    const files = [...opts.manifest.files].sort((left, right) => right.sizeBytes - left.sizeBytes);
    const report = (file: string) => opts.onProgress?.({
      loaded: loadedTotal, total, file, verified: verifiedTotal, filesDone, filesTotal: files.length,
    });
    const installFile = async (entry: ModelPackManifest['files'][number]) => {
      const prior = priorFiles.get(entry.path);
      if (prior && prior.sizeBytes === entry.sizeBytes && prior.sha256.toLowerCase() === entry.sha256.toLowerCase()
        && await staging.partialByteLength(entry.path) === 0 && await staging.copyInstalledFile(entry.path)) {
        // A copied live file is not a resumable prefix. Corrupt/truncated live bytes must be
        // replaced from byte zero; the existing helper verifies complete copies by digest.
        if (await staging.partialByteLength(entry.path) !== entry.sizeBytes) await staging.resetPartial(entry.path);
      }
      let loadedThisFile = 0;
      let verifiedThisFile = 0;
      for (let attempt = 0; ; attempt += 1) {
        try {
          let transferUrl = entry.url;
          if (attempt > 0) {
            const url = new URL(entry.url);
            url.searchParams.set('happierCacheBust', String(Date.now()));
            transferUrl = url.toString();
          }
          await downloadFileResumable({
            host: opts.host, packId, staging, entry, signal: pack.signal, urlPolicy: opts.urlPolicy, transferUrl,
            onProgressReset: (scope) => {
              if (scope === 'file') {
                loadedTotal -= loadedThisFile;
                loadedThisFile = 0;
              }
              verifiedTotal -= verifiedThisFile;
              verifiedThisFile = 0;
              report(entry.path);
            },
            onFileProgress: (loadedForFile, verifiedForFile) => {
              const nextLoaded = Math.max(loadedThisFile, loadedForFile);
              loadedTotal += nextLoaded - loadedThisFile;
              loadedThisFile = nextLoaded;
              // A retry rehashes the kept prefix from zero; keep the bar from sliding back.
              const nextVerified = Math.max(verifiedThisFile, verifiedForFile ?? 0);
              verifiedTotal += nextVerified - verifiedThisFile;
              verifiedThisFile = nextVerified;
              report(entry.path);
            },
          });
          break;
        } catch (error) {
          if (!(error instanceof RetryableTransferFailure)) throw error;
          const delay = TRANSIENT_RETRY_DELAYS_MS[attempt];
          if (pack.signal.aborted || delay === undefined) throw error.original;
          console.warn('model_pack_download_retry', { attempt: attempt + 1, error: error.original });
          await waitForRetry(delay, pack.signal);
        }
      }
      loadedTotal += Math.max(0, entry.sizeBytes - loadedThisFile);
      verifiedTotal += entry.sizeBytes - verifiedThisFile;
      filesDone += 1;
      report(entry.path);
    };
    const worker = async () => {
      while (!pack.signal.aborted && next < files.length) {
        const entry = files[next++]!;
        try { await installFile(entry); } catch (error) {
          failures.push(error);
          pack.abort();
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL_FILE_DOWNLOADS, files.length) }, worker));
    } finally {
      opts.signal.removeEventListener('abort', forwardAbort);
    }
    throwIfAborted(opts.signal);
    if (failures.length > 0) throw failures[0];

    throwIfAborted(opts.signal);
    await staging.writeManifest(opts.manifest);
    throwIfAborted(opts.signal);
    promotion = await staging.promote(opts.priorInstall);
    const result = { packId, rootLocation: promotion.rootLocation, manifest: opts.manifest };
    throwIfAborted(opts.signal);
    if (opts.durableCommit) {
      await promotion.prepareDurableCommit(opts.durableCommit.recovery);
      await opts.durableCommit.commit(result);
      durableCommitted = true;
      await promotion.markDurableCommitted();
      throwIfAborted(opts.signal);
    }
    await promotion.commit();
    promotion = null;
    return result;
  } catch (error) {
    let bytesRolledBack = promotion === null;
    if (promotion) {
      try {
        await promotion.rollback();
        bytesRolledBack = true;
      } catch {
        bytesRolledBack = false;
      }
    }
    let metadataRolledBack = !durableCommitted;
    if (durableCommitted && opts.durableCommit) {
      try {
        await opts.durableCommit.rollback({
          packId,
          rootLocation: promotion?.rootLocation ?? '',
          manifest: opts.manifest,
        });
        metadataRolledBack = true;
      } catch {
        metadataRolledBack = false;
      }
    }
    if (promotion && bytesRolledBack && metadataRolledBack) {
      await promotion.completeRollback().catch(() => undefined);
    }
    throw error;
  } finally {
    // promote() owns backup cleanup on success; this is a best-effort safety net
    // for staging scratch left by a thrown-and-rethrown failure.
    await staging.cleanup().catch((error) => console.warn('model_pack_staging_cleanup_failed', error));
  }
}
