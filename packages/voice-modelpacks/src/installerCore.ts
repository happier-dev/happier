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
import { assertManifestPathsSafe, assertPackIdFilesystemSafe, filePathParts } from '@happier-dev/protocol';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

import { assertManifestIntegrityVerifiable } from './integrityGate.js';
import {
  assertManifestUrlsAllowed,
  assertModelPackResolvedAddressesAllowed,
  assertModelPackUrlAllowed,
  type ModelPackUrlPolicy,
} from './urlPolicy.js';
import {
  assertVoiceModelPackDeclaredResourcesV1,
  type VoiceModelPackResourcePolicyV1,
} from './resourcePolicy.js';
import { normalizeVoiceModelPackSha256DigestV1 } from './sha256Digest.js';
import type {
  ModelPackDurableRecoveryRecord,
  ModelPackPromotionPriorInstallV1,
} from './promotionRecovery.js';

/** Progress for a single pack file or the overall install. */
export type ModelPackCoreProgress = Readonly<{
  loaded: number;
  total: number;
  file?: string;
}>;

/** A streamed HTTP body the core reads incrementally. */
export type ModelPackDownloadStream = Readonly<{
  /** Total bytes the server will send for this (possibly ranged) response, when known. */
  contentLength: number | null;
  /** True when the server honored the requested Range (HTTP 206). */
  isPartial: boolean;
  /** Final response URL after redirects. Hosts must expose this for public plugin assets. */
  finalUrl?: string;
  /** Addresses resolved and pinned by the host connection policy. */
  resolvedAddresses?: readonly string[];
  /** Pull the next chunk; resolves `null` when the stream is exhausted. */
  read: () => Promise<Uint8Array | null>;
  /** Stop the underlying response when verification aborts before EOF. */
  cancel?: () => void;
}>;

export type ModelPackDownloadRequest = Readonly<{
  url: string;
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
      sourceDigest: string;
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
        sourceDigest: normalizeVoiceModelPackSha256DigestV1(source.sourceDigest),
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

/**
 * Download one manifest file into staging with Range-resume, incremental hashing,
 * and size validation. Throws (after resetting the partial) on size/hash mismatch.
 */
async function downloadFileResumable(opts: {
  host: ModelPackInstallerHost;
  staging: ModelPackStagingHandle;
  entry: ModelPackManifest['files'][number];
  signal: AbortSignal;
  onFileProgress: (loadedForFile: number) => void;
  urlPolicy?: ModelPackUrlPolicy;
}): Promise<void> {
  const { host, staging, entry, signal } = opts;
  const expectedSha = entry.sha256.trim().toLowerCase();
  const expectedSize = Math.max(0, Math.trunc(entry.sizeBytes));

  const hasher = host.createHasher();
  let loaded = 0;

  // Resume: re-hash any trustworthy partial, else reset it.
  const existing = await staging.partialByteLength(entry.path);
  if (existing > 0 && existing <= expectedSize) {
    let streamed = 0;
    try {
      const reported = await staging.streamPartial(entry.path, async (chunk) => {
        if (chunk.byteLength === 0) return;
        streamed += chunk.byteLength;
        if (streamed > expectedSize) {
          throw new ModelPackInstallError('model_pack_size_mismatch');
        }
        hasher.update(chunk);
        opts.onFileProgress(streamed);
      });
      if (reported !== streamed || streamed !== existing) {
        await staging.resetPartial(entry.path);
        return downloadFileResumable({ ...opts, onFileProgress: opts.onFileProgress });
      } else {
        loaded = streamed;
      }
    } catch (error) {
      await staging.resetPartial(entry.path);
      if (error instanceof ModelPackInstallError) {
        throw error;
      }
      return downloadFileResumable({ ...opts, onFileProgress: opts.onFileProgress });
    }
  } else if (existing > expectedSize) {
    // Corrupt/overlong partial — start over.
    await staging.resetPartial(entry.path);
  }

  // Already complete? Verify hash and skip the network entirely.
  if (loaded === expectedSize && expectedSize > 0) {
    const actualSha = (await hasher.digestHex()).toLowerCase();
    if (actualSha === expectedSha) {
      return;
    }
    await staging.resetPartial(entry.path);
    // Fall through to a clean re-download.
    return downloadFileResumable({ ...opts, onFileProgress: opts.onFileProgress });
  }

  throwIfAborted(signal);

  const stream = await host.openDownload({
    url: entry.url,
    rangeStart: loaded > 0 ? loaded : undefined,
    signal,
  });
  try {
    assertModelPackUrlAllowed(stream.finalUrl ?? entry.url, opts.urlPolicy);
    assertModelPackResolvedAddressesAllowed(stream.resolvedAddresses ?? [], {
      ...opts.urlPolicy,
      requestUrl: stream.finalUrl ?? entry.url,
    });
  } catch (error) {
    stream.cancel?.();
    throw error;
  }

  // If we asked to resume but the server ignored the Range, restart cleanly so we
  // do not append a full body onto an existing prefix.
  if (loaded > 0 && !stream.isPartial) {
    await staging.resetPartial(entry.path);
    loaded = 0;
    const fresh = host.createHasher();
    await consumeStream({
      stream,
      hasher: fresh,
      staging,
      entry,
      startOffset: 0,
      expectedSize,
      signal,
      onFileProgress: opts.onFileProgress,
      finalize: async (finalLoaded) => {
        if (finalLoaded !== expectedSize) {
          await staging.resetPartial(entry.path);
          throw new ModelPackInstallError('model_pack_size_mismatch');
        }
        const actualSha = (await fresh.digestHex()).toLowerCase();
        if (actualSha !== expectedSha) {
          await staging.resetPartial(entry.path);
          throw new ModelPackInstallError('model_pack_sha256_mismatch');
        }
      },
    });
    return;
  }

  await consumeStream({
    stream,
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
}

async function consumeStream(opts: {
  stream: ModelPackDownloadStream;
  hasher: ModelPackHasher;
  staging: ModelPackStagingHandle;
  entry: ModelPackManifest['files'][number];
  startOffset: number;
  expectedSize: number;
  signal: AbortSignal;
  onFileProgress: (loadedForFile: number) => void;
  finalize: (finalLoaded: number) => Promise<void>;
}): Promise<void> {
  let loaded = opts.startOffset;
  let completed = false;
  try {
    for (;;) {
      throwIfAborted(opts.signal);
      const chunk = await opts.stream.read();
      if (chunk === null) break;
      if (chunk.byteLength === 0) continue;
      loaded += chunk.byteLength;
      if (loaded > opts.expectedSize) {
        await opts.staging.resetPartial(opts.entry.path);
        throw new ModelPackInstallError('model_pack_size_mismatch');
      }
      opts.hasher.update(chunk);
      await opts.staging.appendDownloadedChunk(opts.entry.path, chunk);
      opts.onFileProgress(loaded);
    }
    await opts.finalize(loaded);
    completed = true;
  } finally {
    if (!completed) opts.stream.cancel?.();
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
 *  - every file URL satisfies the {@link ModelPackUrlPolicy} (SD-L5: https + host
 *    allowlist),
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
  // SD-L5: only https (+ optional host allowlist) download URLs.
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
    for (const entry of opts.manifest.files) {
      let loadedThisFile = 0;
      await downloadFileResumable({
        host: opts.host,
        staging,
        entry,
        signal: opts.signal,
        onFileProgress: (loadedForFile) => {
          const delta = Math.max(0, loadedForFile - loadedThisFile);
          loadedThisFile = loadedForFile;
          loadedTotal += delta;
          opts.onProgress?.({ loaded: loadedTotal, total, file: entry.path });
        },
        urlPolicy: opts.urlPolicy,
      });
    }

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
    await staging.cleanup().catch(() => undefined);
    throw error;
  } finally {
    // promote() owns backup cleanup on success; this is a best-effort safety net
    // for staging scratch left by a thrown-and-rethrown failure.
    await staging.cleanup().catch(() => undefined);
  }
}
