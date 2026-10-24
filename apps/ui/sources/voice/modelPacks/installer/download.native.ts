import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

import type { ModelPackManifest } from '@/voice/modelPacks/manifest';

import type { InstallerDirectory, InstallerFile, InstallerFs, ModelPackDownloadProgress, Progress } from './types';
import { getPackFile } from './paths';
import { cacheBustUrl, throwIfAborted } from './network';

// Model files are tens to hundreds of MB; whole-file reads exceed Android's per-app JS heap, so the JS
// fallback hashes files through bounded reads.
const HASH_READ_CHUNK_BYTES = 1024 * 1024;

// Packs hold hundreds of small espeak-ng files, so per-request latency dominates a sequential install.
// Measured on the 254 small Kokoro q8 assets from GitHub releases: sequential 55s, 3 parallel 6.1s,
// 6 parallel 2.8s, 12 parallel 1.8s. Six matches the conventional per-host connection limit and bounds
// concurrent native transfer tasks and verification reads; beyond it the gain flattens.
const MAX_PARALLEL_FILE_DOWNLOADS = 6;

// GitHub release downloads intermittently fail with 5xx; one exact asset URL served a sticky 500 for
// minutes while the same asset with any other query string succeeded, so retries use a fresh query. The
// schedule surfaces a real outage within seconds; a manual retry then resumes from verified files.
const TRANSIENT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

const HTTP_FAILURE_PREFIX = 'model_pack_download_failed:';

// Storage failures surface through the native transfer too, but retrying cannot free space or grant access.
const LOCAL_STORAGE_FAILURE = /ENOSPC|no space left|EACCES|permission denied|EROFS|read-only file system/i;

function isTransientTransferFailure(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted || !(error instanceof Error)) return false;
  if (error.message.startsWith(HTTP_FAILURE_PREFIX)) {
    const status = Number(error.message.slice(HTTP_FAILURE_PREFIX.length));
    return status === 408 || status === 429 || status >= 500;
  }
  // Native transport failures (connection reset, DNS, timeouts) carry platform-specific messages.
  return error.message !== 'model_pack_download_cancelled' && !LOCAL_STORAGE_FAILURE.test(error.message);
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  throwIfAborted(signal);
}

type NativeFileHasher = { sha256File(fileUri: string): Promise<string> };

let reportedJsHashFallback = false;

// Hermes has no JIT, so a JS SHA-256 is orders of magnitude slower than native and blocks the JS thread
// for minutes over a pack's largest files, starving the other downloads, progress events, and UI. The
// native hasher streams the file on a background queue. Builds whose native module predates it still verify in JS.
function getNativeFileHasher(): NativeFileHasher | null {
  const native = requireOptionalNativeModule<Partial<NativeFileHasher>>('HappierCryptoWorker');
  if (native && typeof native.sha256File === 'function') return native as NativeFileHasher;
  if (!reportedJsHashFallback) {
    reportedJsHashFallback = true;
    console.warn('[modelPacks] Native SHA-256 unavailable; verifying model files on the JS thread');
  }
  return null;
}

async function sha256FileHexInJs(
  file: Pick<InstallerFile, 'open'>,
  signal: AbortSignal,
  onHashed?: (bytes: number) => void,
): Promise<string> {
  const hash = sha256.create();
  const handle = file.open();
  let hashed = 0;
  try {
    while (true) {
      throwIfAborted(signal);
      const chunk: Uint8Array = handle.readBytes(HASH_READ_CHUNK_BYTES);
      if (chunk.length === 0) break;
      hash.update(chunk);
      hashed += chunk.length;
      onHashed?.(hashed);
      // `readBytes` is synchronous; yield between chunks so hashing does not block the JS thread.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    handle.close();
  }
  return bytesToHex(hash.digest());
}

async function sha256FileHex(
  file: Pick<InstallerFile, 'uri' | 'open'>,
  signal: AbortSignal,
  onHashed?: (bytes: number) => void,
): Promise<string> {
  const native = getNativeFileHasher();
  if (!native) return sha256FileHexInJs(file, signal, onHashed);
  throwIfAborted(signal);
  // One native call per file, so verification reports no intermediate bytes; the file counts as
  // verified once its hash matches. Native hashing is short even for the largest files,
  // so cancellation is honored once it returns.
  const hex = await native.sha256File(file.uri);
  throwIfAborted(signal);
  return hex.toLowerCase();
}

type NativeDownloader = Pick<typeof import('expo-file-system/legacy'), 'createDownloadResumable' | 'FileSystemSessionType'>;

async function downloadToFile(opts: {
  downloader: NativeDownloader;
  url: string;
  fileUri: string;
  signal: AbortSignal;
  onProgress?: (p: Progress) => void;
}): Promise<void> {
  throwIfAborted(opts.signal);
  const { createDownloadResumable, FileSystemSessionType } = opts.downloader;
  // Expo fetch queues native events without backpressure. Keep artifact bytes entirely native;
  // only numeric progress crosses into JS, followed by bounded disk reads for verification.
  const task = createDownloadResumable(opts.url, opts.fileUri, {
    sessionType: FileSystemSessionType.FOREGROUND,
  }, (progress) => opts.onProgress?.({
    loaded: progress.totalBytesWritten,
    total: progress.totalBytesExpectedToWrite,
  }));
  let releasePromise: Promise<void> | undefined;
  const release = () => releasePromise ??= (async () => {
    if (Platform.OS === 'android') {
      // Android's cancel alone retains the native task. Pause removes it; cancel also removes
      // the JS progress subscription when native setup failed before task registration.
      try {
        await task.pauseAsync();
      } finally {
        await task.cancelAsync();
      }
    } else {
      // iOS unregisters completed tasks itself, so pause would fail before unsubscribing.
      await task.cancelAsync();
    }
  })();
  const onAbort = () => {
    // The same promise is awaited below; attach a handler now to avoid an unhandled rejection.
    void release().catch(() => undefined);
  };
  const download = task.downloadAsync();
  opts.signal.addEventListener('abort', onAbort, { once: true });
  if (opts.signal.aborted) onAbort();
  let transferFailed = false;
  try {
    // A cancellation request is not terminal: native writes must settle before hashing/deleting.
    // Model files use native network timeouts; the configured deadline still owns manifest fetches.
    const result = await download;
    throwIfAborted(opts.signal);
    if (!result) throw new Error('model_pack_download_cancelled');
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`${HTTP_FAILURE_PREFIX}${result.status}`);
    }
  } catch (error) {
    transferFailed = true;
    throw error;
  } finally {
    opts.signal.removeEventListener('abort', onAbort);
    try {
      await release();
    } catch (error) {
      if (!transferFailed) throw error;
      // Preserve the causal transfer error, but keep failed cleanup visible by default.
      console.warn('[modelPacks] Failed to release native download', error);
    }
  }
}

async function downloadWithRetry(opts: {
  downloader: NativeDownloader;
  url: string;
  fileUri: string;
  signal: AbortSignal;
  onProgress?: (p: Progress) => void;
}): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      // A cached edge failure is keyed by the exact URL, so retries must not repeat it.
      await downloadToFile({ ...opts, url: attempt === 0 ? opts.url : cacheBustUrl(opts.url) });
      return;
    } catch (error) {
      const retryDelayMs = TRANSIENT_RETRY_DELAYS_MS[attempt];
      if (retryDelayMs === undefined || !isTransientTransferFailure(error, opts.signal)) throw error;
      console.warn(`[modelPacks] Retrying ${opts.url} after transient failure`, error);
      await abortableDelay(retryDelayMs, opts.signal);
    }
  }
}

async function downloadAndVerifyFile(opts: {
  downloader: NativeDownloader;
  fs: InstallerFs;
  rootDir: Pick<InstallerDirectory, 'uri'>;
  entry: ModelPackManifest['files'][number];
  signal: AbortSignal;
  onProgress?: (p: Progress) => void;
  /** Bytes hashed by the current verification pass; a repeated pass starts again from 0. */
  onVerifyProgress?: (bytes: number, source: 'existing' | 'downloaded') => void;
  /** A file left on disk failed verification and is downloaded again. */
  onExistingRejected?: () => void;
}): Promise<void> {
  const file = getPackFile(opts.fs, opts.rootDir, opts.entry.path, { createParents: true });
  if (file.exists) {
    try {
      const actual = await sha256FileHex(file, opts.signal, (bytes) => opts.onVerifyProgress?.(bytes, 'existing'));
      if (actual === opts.entry.sha256.toLowerCase()) return;
      file.delete();
    } catch (error) {
      // A cancelled verification does not invalidate an already downloaded file.
      if (opts.signal.aborted) throw error;
      console.warn('[modelPacks] Failed to verify existing model pack file', error);
      try {
        file.delete();
      } catch (cleanupError) {
        console.warn('[modelPacks] Failed to remove unverified model pack file', cleanupError);
      }
    }
    opts.onExistingRejected?.();
  }

  try {
    // Only the network transfer is retried; local storage and verification failures are final.
    await downloadWithRetry({
      downloader: opts.downloader, url: opts.entry.url, fileUri: file.uri, signal: opts.signal, onProgress: opts.onProgress,
    });

    const actual = await sha256FileHex(file, opts.signal, (bytes) => opts.onVerifyProgress?.(bytes, 'downloaded'));
    if (actual !== opts.entry.sha256.toLowerCase()) {
      throw new Error('model_pack_sha256_mismatch');
    }
  } catch (error) {
    try {
      if (file.exists) file.delete();
    } catch (cleanupError) {
      console.warn('[modelPacks] Failed to remove incomplete model pack file', cleanupError);
    }
    throw error;
  }
}

export async function downloadManifestFiles(opts: {
  fs: InstallerFs;
  rootDir: Pick<InstallerDirectory, 'uri'>;
  manifest: ModelPackManifest;
  signal: AbortSignal;
  onProgress?: (p: ModelPackDownloadProgress) => void;
}): Promise<void> {
  const sizeOf = (f: ModelPackManifest['files'][number]) => (Number.isFinite(f.sizeBytes) ? f.sizeBytes : 0);
  // Largest first: a pack's few big files dominate its transfer and verification time, so they start at
  // once while the remaining workers drain the many small files, instead of starting alone at the end.
  const files = [...opts.manifest.files].sort((a, b) => sizeOf(b) - sizeOf(a));
  const total = files.reduce((acc, f) => acc + sizeOf(f), 0);
  const filesTotal = files.length;
  let loadedTotal = 0;
  let verifiedTotal = 0;
  let filesDone = 0;
  const report = () => opts.onProgress?.({ loaded: loadedTotal, total, verified: verifiedTotal, filesDone, filesTotal });
  throwIfAborted(opts.signal);
  const downloader = await import('expo-file-system/legacy');
  // The first fatal failure stops sibling transfers; the pack then reports that failure, not their aborts.
  const pack = new AbortController();
  const forwardAbort = () => pack.abort();
  opts.signal.addEventListener('abort', forwardAbort, { once: true });
  if (opts.signal.aborted) pack.abort();
  const failures: unknown[] = [];
  let next = 0;

  const installFile = async (f: ModelPackManifest['files'][number]) => {
    let loadedThisFile = 0;
    const advance = (loaded: number) => {
      const delta = loaded - loadedThisFile;
      if (delta <= 0) return false;
      loadedThisFile = loaded;
      loadedTotal += delta;
      return true;
    };
    let verifiedThisFile = 0;
    // Unlike transfer bytes, verification restarts from 0 when a stale file is rehashed after redownload.
    const setVerified = (verified: number) => {
      verifiedTotal += verified - verifiedThisFile;
      verifiedThisFile = verified;
    };
    const clampToFile = (bytes: number) => (Number.isFinite(f.sizeBytes) ? Math.min(bytes, f.sizeBytes) : bytes);
    await downloadAndVerifyFile({
      downloader,
      fs: opts.fs,
      rootDir: opts.rootDir,
      entry: f,
      signal: pack.signal,
      // Native counts error-response bodies too; a failed attempt must not report beyond the asset.
      onProgress: (p) => {
        if (advance(clampToFile(p.loaded))) report();
      },
      onVerifyProgress: (bytes, source) => {
        setVerified(clampToFile(bytes));
        // Bytes an interrupted install left on disk are already present; checking them advances the
        // transfer too, so resuming over a large kept file does not freeze the bar while it is hashed.
        if (source === 'existing') advance(clampToFile(bytes));
        report();
      },
      onExistingRejected: () => {
        // The kept bytes turned out unusable; withdraw them so the redownload is not counted twice.
        loadedTotal -= loadedThisFile;
        loadedThisFile = 0;
        setVerified(0);
        report();
      },
    });
    // Verified files count fully, including ones already present from an interrupted install.
    advance(Number.isFinite(f.sizeBytes) ? f.sizeBytes : loadedThisFile);
    setVerified(Number.isFinite(f.sizeBytes) ? f.sizeBytes : verifiedThisFile);
    filesDone += 1;
    report();
  };

  const worker = async () => {
    while (!pack.signal.aborted && next < files.length) {
      const f = files[next++]!;
      try {
        await installFile(f);
      } catch (error) {
        failures.push(error);
        pack.abort();
      }
    }
  };

  try {
    const workerCount = Math.min(MAX_PARALLEL_FILE_DOWNLOADS, files.length);
    await Promise.all(Array.from({ length: workerCount }, worker));
  } finally {
    opts.signal.removeEventListener('abort', forwardAbort);
  }
  throwIfAborted(opts.signal);
  if (failures.length > 0) throw failures[0];
}
