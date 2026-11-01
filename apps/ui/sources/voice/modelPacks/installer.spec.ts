import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DownloadResumable, DownloadOptions, DownloadProgressData } from 'expo-file-system/legacy';

import { ensureModelPackInstalled, getModelPackInstallSummary, removeModelPack } from '@/voice/modelPacks/installer.native';
import type { ModelPackManifest } from '@/voice/modelPacks/manifest';
import { settleWithFakeClock, useInstallerFakeClock } from '@/voice/modelPacks/installerFakeClock.testHarness';
import type { InstallerSherpaNative } from '@/voice/modelPacks/installer/nativeEngines.native';

const nativeDownload = vi.hoisted(() => vi.fn<(
  url: string, uri: string, options?: DownloadOptions, onProgress?: (progress: DownloadProgressData) => void,
) => Pick<DownloadResumable, 'downloadAsync' | 'pauseAsync' | 'cancelAsync'>>());
// Artifact network and disk IO are native system boundaries, unavailable in the Node test process.
vi.mock('expo-file-system/legacy', () => ({
  createDownloadResumable: nativeDownload,
  FileSystemSessionType: { BACKGROUND: 0, FOREGROUND: 1 },
}));
vi.mock('react-native', async () => {
  const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeNativeMock({ platformOS: 'android' });
});

const PACK_URI = 'file:///docs/happier/voice/modelPacks/example';
const MAX_BOUNDED_READ_BYTES = 4 * 1024 * 1024;

function createFs(files = new Map<string, Uint8Array>(), options: {
  onRead?: () => void;
  openHandles?: Set<object>;
} = {}) {
  const directories = new Set<string>();
  // The OS backup flag belongs to a directory instance and disappears when that directory is deleted.
  const backupExcludedDirectories = new Set<string>();
  function joinUri(parts: Array<string | { uri: string }>) {
    return parts.map((part) => (typeof part === 'string' ? part : part.uri).replace(/\/$/, '')).join('/');
  }
  class Directory {
    uri: string;
    constructor(...parts: Array<string | { uri: string }>) { this.uri = joinUri(parts); }
    get exists() { return directories.has(this.uri) || [...files.keys()].some((key) => key.startsWith(`${this.uri}/`)); }
    // Mirrors expo-file-system: the recursive byte total of contained files, null when the directory is missing.
    get size() {
      const contained = [...files.entries()].filter(([key]) => key.startsWith(`${this.uri}/`));
      if (contained.length === 0 && !directories.has(this.uri)) return null;
      return contained.reduce((acc, [, data]) => acc + data.length, 0);
    }
    create() {
      for (let parent = this.uri; parent.length > 'file://'.length;
        parent = parent.slice(0, parent.lastIndexOf('/'))) {
        if (files.has(parent)) throw new Error('directory_path_is_file');
      }
      directories.add(this.uri);
    }
    delete() {
      for (const dir of directories) if (dir === this.uri || dir.startsWith(`${this.uri}/`)) directories.delete(dir);
      for (const dir of backupExcludedDirectories) if (dir === this.uri || dir.startsWith(`${this.uri}/`)) backupExcludedDirectories.delete(dir);
      for (const key of files.keys()) if (key.startsWith(`${this.uri}/`)) files.delete(key);
    }
  }
  class File {
    uri: string;
    constructor(...parts: Array<string | { uri: string }>) { this.uri = joinUri(parts); }
    get exists() { return files.has(this.uri); }
    create() { if (!this.exists) files.set(this.uri, new Uint8Array()); }
    delete() {
      if (options.openHandles?.size) throw new Error('file_handle_still_open');
      // Deleting a file leaves its folders behind, as on a real filesystem.
      for (let parent = this.uri.slice(0, this.uri.lastIndexOf('/')); parent.length > 'file://'.length;
        parent = parent.slice(0, parent.lastIndexOf('/'))) {
        directories.add(parent);
      }
      files.delete(this.uri);
    }
    write(value: string | Uint8Array) {
      files.set(this.uri, typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value));
    }
    async text() { return new TextDecoder().decode(files.get(this.uri)); }
    // Whole-file reads must stay unavailable: these fixtures also protect the Android heap contract.
    async bytes(): Promise<Uint8Array> { throw new Error('whole_file_read_exceeds_js_heap'); }
    // expo-file-system's File.move updates `uri` to the destination.
    move(destination: { uri: string }) {
      const data = files.get(this.uri);
      if (!data) throw new Error('move_source_missing');
      if (files.has(destination.uri) || new Directory(destination.uri).exists) throw new Error('move_destination_exists');
      // As on a real filesystem, a path that holds a file cannot also be a directory.
      for (let parent = destination.uri.slice(0, destination.uri.lastIndexOf('/')); parent.length > 'file://'.length;
        parent = parent.slice(0, parent.lastIndexOf('/'))) {
        if (files.has(parent)) throw new Error('move_parent_is_file');
      }
      files.delete(this.uri);
      files.set(destination.uri, data);
      this.uri = destination.uri;
    }
    open() {
      let offset = 0;
      const data = files.get(this.uri) ?? new Uint8Array();
      const handle = {};
      options.openHandles?.add(handle);
      return {
        readBytes(length: number) {
          if (length > MAX_BOUNDED_READ_BYTES) throw new Error('read_exceeds_js_heap_budget');
          const chunk = data.slice(offset, offset + length);
          offset += chunk.length;
          options.onRead?.();
          return chunk;
        },
        close() { options.openHandles?.delete(handle); },
      };
    }
  }
  return { Directory, File, Paths: { document: 'file:///docs/' }, files, backupExcludedDirectories };
}

function useNativeDownloads(fs: ReturnType<typeof createFs>, data: (url: string) => Uint8Array, requested: string[] = [], transfer: {
  status?: (url: string) => number;
  // Bytes native reports written; error responses write their body, which can exceed the asset size.
  writtenBytes?: (url: string) => number;
  // Holds the native transfer open so tests can observe how many run at once.
  inFlight?: (url: string) => Promise<void>;
} = {}) {
  nativeDownload.mockImplementation((url, destination, options, onProgress) => ({
    async downloadAsync() {
      requested.push(url);
      await transfer.inFlight?.(url);
      if (new fs.Directory(destination).exists) throw new Error('download_destination_is_directory');
      fs.files.set(destination, new Uint8Array(data(url)));
      const written = transfer.writtenBytes?.(url);
      if (written !== undefined) onProgress?.({ totalBytesWritten: written, totalBytesExpectedToWrite: written });
      return { uri: destination, status: transfer.status?.(url) ?? 200, headers: {}, mimeType: null };
    },
    async pauseAsync() { return { url, fileUri: destination, options: options ?? {}, resumeData: '0' }; },
    async cancelAsync() {},
  }));
}

function fetchManifest(manifest: ModelPackManifest): typeof fetch {
  return async (input) => {
    if (!String(input).includes('manifest.json')) throw new Error('artifact_fetch_crossed_js_boundary');
    return Response.json(manifest);
  };
}

function manifest(files: ModelPackManifest['files'], version = 'v1'): ModelPackManifest {
  return { packId: 'example', kind: 'tts_sherpa', model: 'kokoro', version, files };
}

async function sha256Hex(bytes: Uint8Array) {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(bytes).digest('hex');
}

function multiChunkBytes(seed: number) {
  const bytes = new Uint8Array(MAX_BOUNDED_READ_BYTES * 2 + 12345);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + seed) & 0xff;
  return bytes;
}

const installOptions = {
  packId: 'example', mode: 'download_if_missing' as const, manifestUrl: 'https://example.com/manifest.json', timeoutMs: 120_000,
};

describe('modelPacks installer (native)', () => {
  beforeEach(() => { nativeDownload.mockReset(); });
  afterEach(() => { vi.useRealTimers(); });

  it('rewrites GitHub release file URLs using publisher-authored asset names', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const sha256 = await sha256Hex(bytes);
    const fs = createFs();
    const requested: string[] = [];
    useNativeDownloads(fs, () => bytes, requested);
    const remote = manifest([
      { path: 'model.onnx', url: 'https://github.com/happier/happier-assets/releases/download/model-packs/example__model.onnx?v=1', sha256, sizeBytes: bytes.length },
      // GitHub sanitizes ! into ., so the pack-relative path cannot reproduce the uploaded asset name.
      { path: 'espeak-ng-data/voices/!v/Alex', url: 'https://github.com/happier/happier-assets/releases/download/model-packs/example__espeak-ng-data__voices__.v__Alex?v=1', sha256, sizeBytes: bytes.length },
      // A malformed percent escape is still a valid URL pathname and must be reused without decoding.
      { path: 'notes%ZZ.txt', url: 'https://github.com/happier/happier-assets/releases/download/model-packs/example__notes%ZZ.txt?v=1', sha256, sizeBytes: bytes.length },
    ]);
    await ensureModelPackInstalled({
      ...installOptions, signal: new AbortController().signal,
      manifestUrl: 'https://github.com/happier-dev/happier-assets/releases/download/model-packs/example__manifest.json',
    }, { fs, fetch: fetchManifest(remote) });
    const prefix = 'https://github.com/happier-dev/happier-assets/releases/download/model-packs/';
    expect(requested).toEqual([
      `${prefix}example__model.onnx`,
      `${prefix}example__espeak-ng-data__voices__.v__Alex`,
      `${prefix}example__notes%ZZ.txt`,
    ]);
  });

  describe('large files', () => {
    it('verifies existing and downloaded files without whole-file reads', async () => {
      const existing = multiChunkBytes(1);
      const downloaded = multiChunkBytes(2);
      const fs = createFs(new Map([[`${PACK_URI}/existing.bin`, existing]]));
      const requested: string[] = [];
      useNativeDownloads(fs, () => downloaded, requested);
      await ensureModelPackInstalled({ ...installOptions, signal: new AbortController().signal }, {
        fs, fetch: fetchManifest(manifest([
          { path: 'existing.bin', url: 'https://example.com/existing.bin', sha256: await sha256Hex(existing), sizeBytes: existing.length },
          { path: 'downloaded.bin', url: 'https://example.com/downloaded.bin', sha256: await sha256Hex(downloaded), sizeBytes: downloaded.length },
        ])),
      });
      expect(requested).toEqual(['https://example.com/downloaded.bin']);
      expect(Buffer.from(fs.files.get(`${PACK_URI}/downloaded.bin`) ?? []).equals(Buffer.from(downloaded))).toBe(true);
    });

    it('reports verification progress while a downloaded file is hashed', async () => {
      const bytes = multiChunkBytes(3);
      const fs = createFs();
      useNativeDownloads(fs, () => bytes);
      const progress: Array<{ verified: number; filesDone: number }> = [];
      await ensureModelPackInstalled({
        ...installOptions, signal: new AbortController().signal,
        onProgress: (p) => progress.push({ verified: p.verified, filesDone: p.filesDone }),
      }, {
        fs, fetch: fetchManifest(manifest([
          { path: 'model.onnx', url: 'https://example.com/model.onnx', sha256: await sha256Hex(bytes), sizeBytes: bytes.length },
        ])),
      });
      expect(progress.some((p) => p.filesDone === 0 && p.verified > 0 && p.verified < bytes.length)).toBe(true);
      expect(progress.at(-1)).toEqual({ verified: bytes.length, filesDone: 1 });
    });

    it('advances progress while checking files an interrupted install left on disk', async () => {
      const kept = multiChunkBytes(4);
      const stale = multiChunkBytes(5);
      const fresh = multiChunkBytes(6);
      const fs = createFs(new Map([[`${PACK_URI}/kept.bin`, kept], [`${PACK_URI}/stale.bin`, stale]]));
      useNativeDownloads(fs, () => fresh);
      const progress: Array<{ loaded: number; total: number; filesDone: number }> = [];
      await ensureModelPackInstalled({
        ...installOptions, signal: new AbortController().signal,
        onProgress: (p) => progress.push({ loaded: p.loaded, total: p.total, filesDone: p.filesDone }),
      }, {
        fs, fetch: fetchManifest(manifest([
          { path: 'kept.bin', url: 'https://example.com/kept.bin', sha256: await sha256Hex(kept), sizeBytes: kept.length },
          { path: 'stale.bin', url: 'https://example.com/stale.bin', sha256: await sha256Hex(fresh), sizeBytes: fresh.length },
        ])),
      });
      // Checking a kept file moves the bar instead of leaving it frozen until the whole file is hashed.
      expect(progress.some((p) => p.filesDone === 0 && p.loaded > 0 && p.loaded < kept.length)).toBe(true);
      // A rejected file's checked bytes are withdrawn, so its redownload is not counted twice.
      expect(progress.every((p) => p.loaded <= p.total)).toBe(true);
      expect(progress.at(-1)).toEqual({ loaded: kept.length + fresh.length, total: kept.length + fresh.length, filesDone: 2 });
    });

    it('starts the largest files first so they transfer alongside the small ones', async () => {
      const small = new Uint8Array([1]);
      const medium = new Uint8Array(16).fill(2);
      const large = new Uint8Array(64).fill(3);
      const byUrl = new Map([['https://example.com/large', large], ['https://example.com/medium', medium]]);
      const fs = createFs();
      const requested: string[] = [];
      useNativeDownloads(fs, (url) => byUrl.get(url) ?? small, requested);
      const smallEntries = await Promise.all(Array.from({ length: 8 }, async (_, i) => ({
        path: `espeak-ng-data/f${i}`, url: `https://example.com/f${i}`, sha256: await sha256Hex(small), sizeBytes: small.length,
      })));
      await ensureModelPackInstalled({ ...installOptions, signal: new AbortController().signal }, {
        fs, fetch: fetchManifest(manifest([
          ...smallEntries,
          { path: 'model.onnx', url: 'https://example.com/large', sha256: await sha256Hex(large), sizeBytes: large.length },
          { path: 'voices.bin', url: 'https://example.com/medium', sha256: await sha256Hex(medium), sizeBytes: medium.length },
        ])),
      });
      expect(requested.slice(0, 2)).toEqual(['https://example.com/large', 'https://example.com/medium']);
      expect(requested).toHaveLength(10);
    });

    it('rejects and removes a downloaded file whose SHA-256 does not match', async () => {
      const fs = createFs();
      useNativeDownloads(fs, () => new Uint8Array([4, 5, 6, 7]));
      await expect(ensureModelPackInstalled({ ...installOptions, signal: new AbortController().signal }, {
        fs, fetch: fetchManifest(manifest([
          { path: 'model.bin', url: 'https://example.com/model.bin', sha256: 'a'.repeat(64), sizeBytes: 4 },
        ])),
      })).rejects.toThrow('model_pack_sha256_mismatch');
      expect(fs.files.has(`${PACK_URI}/model.bin`)).toBe(false);
      expect(fs.files.has(`${PACK_URI}/pack.json`)).toBe(false);
    });

    it.each(['existing', 'downloaded'] as const)('stops %s file verification when cancelled and closes its handle', async (state) => {
      const bytes = multiChunkBytes(3);
      const fileUri = `${PACK_URI}/model.bin`;
      const files = new Map<string, Uint8Array>(state === 'existing' ? [[fileUri, bytes]] : []);
      const openHandles = new Set<object>();
      const controller = new AbortController();
      const fs = createFs(files, { openHandles, onRead: () => queueMicrotask(() => controller.abort()) });
      useNativeDownloads(fs, () => bytes);
      await expect(ensureModelPackInstalled({ ...installOptions, signal: controller.signal }, {
        fs, fetch: fetchManifest(manifest([
          { path: 'model.bin', url: 'https://example.com/model.bin', sha256: await sha256Hex(bytes), sizeBytes: bytes.length },
        ])),
      })).rejects.toThrow('aborted');
      expect(openHandles.size).toBe(0);
      expect(files.has(`${PACK_URI}/pack.json`)).toBe(false);
      // Cancelling discards the partial pack, including files kept from an earlier interrupted attempt.
      expect(files.has(fileUri)).toBe(false);
    });
  });

  describe('pack transfer', () => {
    async function packOf(count: number) {
      const bytes = new Uint8Array([9, 8, 7]);
      const sha256 = await sha256Hex(bytes);
      return {
        bytes,
        manifest: manifest(Array.from({ length: count }, (_, i) => ({
          path: `espeak-ng-data/lang/f${i}`, url: `https://example.com/f${i}`, sha256, sizeBytes: bytes.length,
        }))),
      };
    }

    it('retries a transient server error on a cache-distinct URL and completes the pack', async () => {
      useInstallerFakeClock();
      const { bytes, manifest: remote } = await packOf(1);
      const fs = createFs();
      const requested: string[] = [];
      // GitHub has served a sticky 500 for one exact asset URL while the same asset with any other
      // query string succeeded.
      useNativeDownloads(fs, () => bytes, requested, { status: (url) => (url === 'https://example.com/f0' ? 500 : 200) });
      await settleWithFakeClock(ensureModelPackInstalled({ ...installOptions, signal: new AbortController().signal }, {
        fs, fetch: fetchManifest(remote),
      }));
      expect(requested).toHaveLength(2);
      expect(requested[1]).not.toBe(requested[0]);
      expect(requested[1]?.startsWith('https://example.com/f0?')).toBe(true);
      expect(fs.files.has(`${PACK_URI}/pack.json`)).toBe(true);
    });

    it('gives up on a persistent server error with its status and leaves the pack uninstalled', async () => {
      useInstallerFakeClock();
      const { bytes, manifest: remote } = await packOf(1);
      const fs = createFs();
      const requested: string[] = [];
      useNativeDownloads(fs, () => bytes, requested, { status: () => 503 });
      await expect(settleWithFakeClock(ensureModelPackInstalled({ ...installOptions, signal: new AbortController().signal }, {
        fs, fetch: fetchManifest(remote),
      }))).rejects.toThrow('model_pack_download_failed:503');
      expect(requested.length).toBeGreaterThan(1);
      expect(fs.files.has(`${PACK_URI}/espeak-ng-data/lang/f0`)).toBe(false);
      expect(fs.files.has(`${PACK_URI}/pack.json`)).toBe(false);
    });

    it('downloads many small files concurrently within a bound', async () => {
      useInstallerFakeClock();
      const { bytes, manifest: remote } = await packOf(24);
      const fs = createFs();
      let active = 0;
      let peak = 0;
      useNativeDownloads(fs, () => bytes, [], {
        inFlight: async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
        },
      });
      await settleWithFakeClock(ensureModelPackInstalled({ ...installOptions, signal: new AbortController().signal }, {
        fs, fetch: fetchManifest(remote),
      }));
      expect(peak).toBeGreaterThan(1);
      expect(peak).toBeLessThan(24);
      expect(fs.files.has(`${PACK_URI}/pack.json`)).toBe(true);
    });

    it('stops the pack on a non-retryable failure and reports that failure rather than sibling cancellation', async () => {
      useInstallerFakeClock();
      const { bytes, manifest: remote } = await packOf(48);
      const fs = createFs();
      const requested: string[] = [];
      useNativeDownloads(fs, () => bytes, requested, {
        status: (url) => (url === 'https://example.com/f1' ? 404 : 200),
        // The failing file answers last, so earlier siblings have verified by then.
        inFlight: (url) => new Promise((resolve) => setTimeout(resolve, url.endsWith('/f1') ? 30 : 5)),
      });
      await expect(settleWithFakeClock(ensureModelPackInstalled({ ...installOptions, signal: new AbortController().signal }, {
        fs, fetch: fetchManifest(remote),
      }))).rejects.toThrow('model_pack_download_failed:404');
      expect(requested.filter((url) => url === 'https://example.com/f1')).toHaveLength(1);
      expect(requested.length).toBeLessThan(48);
      expect(fs.files.has(`${PACK_URI}/pack.json`)).toBe(false);
      // Unlike a cancellation, a failure keeps verified files so retrying resumes.
      expect(fs.files.has(`${PACK_URI}/espeak-ng-data/lang/f0`)).toBe(true);
    });

    it('discards every downloaded file when the user cancels an install', async () => {
      useInstallerFakeClock();
      const { bytes, manifest: remote } = await packOf(24);
      const fs = createFs();
      const controller = new AbortController();
      let completed = 0;
      useNativeDownloads(fs, () => bytes, [], {
        inFlight: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          completed += 1;
          if (completed === 8) controller.abort();
        },
      });
      await expect(settleWithFakeClock(ensureModelPackInstalled({ ...installOptions, signal: controller.signal }, {
        fs, fetch: fetchManifest(remote),
      }))).rejects.toThrow('aborted');
      expect([...fs.files.keys()].filter((uri) => uri.startsWith(`${PACK_URI}/`))).toEqual([]);
    });

    it('discards files saved by a failed attempt when the user cancels a retry before files download', async () => {
      const fs = createFs();
      fs.files.set(`${PACK_URI}/espeak-ng-data/lang/f0`, new Uint8Array([9, 8, 7]));
      const controller = new AbortController();
      const pending = ensureModelPackInstalled({ ...installOptions, signal: controller.signal }, {
        fs, fetch: () => new Promise<Response>(() => {}),
      });
      controller.abort();
      await expect(pending).rejects.toThrow('aborted');
      expect([...fs.files.keys()].filter((uri) => uri.startsWith(`${PACK_URI}/`))).toEqual([]);
    });

    it('never reports more progress than the pack size when a failed response body is larger than the asset', async () => {
      useInstallerFakeClock();
      const { bytes, manifest: remote } = await packOf(2);
      const fs = createFs();
      const progress: Array<{ ratio: number; verified: number; filesDone: number }> = [];
      // A 500 error page is far larger than a tiny espeak-ng asset.
      useNativeDownloads(fs, () => bytes, [], {
        status: (url) => (url === 'https://example.com/f0' ? 500 : 200),
        writtenBytes: (url) => (url === 'https://example.com/f0' ? 164_854 : bytes.length),
      });
      await settleWithFakeClock(ensureModelPackInstalled({
        ...installOptions, signal: new AbortController().signal,
        onProgress: (p) => progress.push({ ratio: p.loaded / p.total, verified: p.verified, filesDone: p.filesDone }),
      }, { fs, fetch: fetchManifest(remote) }));
      expect(Math.max(...progress.map((p) => p.ratio))).toBe(1);
      // A retried attempt re-reporting bytes already counted adds no report of its own.
      expect(new Set(progress.map((p) => `${p.ratio}:${p.verified}:${p.filesDone}`)).size).toBe(progress.length);
      expect(progress.at(-1)).toEqual({ ratio: 1, verified: bytes.length * 2, filesDone: 2 });
    });

    it('removes update leftovers once a fresh install completes', async () => {
      const { bytes, manifest: remote } = await packOf(1);
      const leftover = 'file:///docs/happier/voice/modelPackUpdates/example/model.onnx';
      const fs = createFs(new Map([[leftover, new Uint8Array([7])]]));
      useNativeDownloads(fs, () => bytes);
      await ensureModelPackInstalled({ ...installOptions, signal: new AbortController().signal }, { fs, fetch: fetchManifest(remote) });
      expect(fs.files.has(leftover)).toBe(false);
    });

    it('counts already verified files toward progress when an interrupted install resumes', async () => {
      const { bytes, manifest: remote } = await packOf(3);
      const fs = createFs(new Map([[`${PACK_URI}/espeak-ng-data/lang/f0`, bytes], [`${PACK_URI}/espeak-ng-data/lang/f1`, bytes]]));
      const progress: Array<{ loaded: number; total: number }> = [];
      useNativeDownloads(fs, () => bytes);
      await ensureModelPackInstalled({
        ...installOptions, signal: new AbortController().signal, onProgress: (p) => progress.push({ loaded: p.loaded, total: p.total }),
      }, { fs, fetch: fetchManifest(remote) });
      expect(progress.at(-1)).toEqual({ loaded: bytes.length * 3, total: bytes.length * 3 });
    });

    it('reports how many pack files are done, counting already verified ones', async () => {
      const { bytes, manifest: remote } = await packOf(3);
      const fs = createFs(new Map([[`${PACK_URI}/espeak-ng-data/lang/f0`, bytes]]));
      const progress: Array<{ filesDone: number; filesTotal: number }> = [];
      useNativeDownloads(fs, () => bytes);
      await ensureModelPackInstalled({
        ...installOptions, signal: new AbortController().signal,
        onProgress: (p) => progress.push({ filesDone: p.filesDone, filesTotal: p.filesTotal }),
      }, { fs, fetch: fetchManifest(remote) });
      expect(progress.every((p) => p.filesTotal === 3)).toBe(true);
      expect(progress.map((p) => p.filesDone)).toEqual([...progress.map((p) => p.filesDone)].sort());
      expect(progress.at(-1)).toEqual({ filesDone: 3, filesTotal: 3 });
    });
  });

  describe('one install per pack', () => {
    async function heldPack() {
      const bytes = new Uint8Array([9, 8, 7]);
      const sha256 = await sha256Hex(bytes);
      const remote = manifest([0, 1].map((i) => ({
        path: `f${i}`, url: `https://example.com/f${i}`, sha256, sizeBytes: bytes.length,
      })));
      const fs = createFs();
      const requested: string[] = [];
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let started!: () => void;
      const transferStarted = new Promise<void>((resolve) => { started = resolve; });
      useNativeDownloads(fs, () => bytes, requested, { inFlight: async () => { started(); await held; } });
      return { fs, remote, requested, release, transferStarted };
    }

    it('joins a second caller to the running install instead of downloading the pack twice', async () => {
      const { fs, remote, requested, release, transferStarted } = await heldPack();
      const firstProgress: number[] = [];
      const secondProgress: number[] = [];
      const first = ensureModelPackInstalled({
        ...installOptions, signal: new AbortController().signal, onProgress: (p) => firstProgress.push(p.filesDone),
      }, { fs, fetch: fetchManifest(remote) });
      await transferStarted;
      const second = ensureModelPackInstalled({
        ...installOptions, signal: new AbortController().signal, onProgress: (p) => secondProgress.push(p.filesDone),
      }, { fs, fetch: fetchManifest(remote) });
      // Give an independent second install time to reach its own transfers while the first is held.
      await new Promise((resolve) => setTimeout(resolve, 20));
      release();
      const [a, b] = await Promise.all([first, second]);
      expect(a).toEqual(b);
      expect(requested.sort()).toEqual(['https://example.com/f0', 'https://example.com/f1']);
      expect(firstProgress.at(-1)).toBe(2);
      expect(secondProgress.at(-1)).toBe(2);
      expect(fs.files.has(`${PACK_URI}/pack.json`)).toBe(true);
    });

    it('cancels the running install and waits for it to settle before removing the pack', async () => {
      const { fs, remote, release, transferStarted } = await heldPack();
      const install = ensureModelPackInstalled({ ...installOptions, signal: new AbortController().signal }, {
        fs, fetch: fetchManifest(remote),
      });
      const outcome = install.then(() => 'installed', (error: Error) => error.message);
      await transferStarted;
      const removed = removeModelPack({ packId: 'example' }, { fs });
      release();
      await removed;
      expect(await outcome).toBe('aborted');
      expect([...fs.files.keys()].filter((uri) => uri.startsWith(`${PACK_URI}/`))).toEqual([]);
    });
  });

  it('refuses to download a pack that does not fit in the free disk space', async () => {
    const bytes = new Uint8Array(10);
    const sha256 = await sha256Hex(bytes);
    const fs = createFs(new Map([[`${PACK_URI}/a.bin`, bytes]]));
    // 10 of the 30 bytes are already on disk, so 20 more are needed.
    Object.assign(fs.Paths, { availableDiskSpace: 19 });
    const requested: string[] = [];
    useNativeDownloads(fs, () => bytes, requested);
    const remote = manifest(['a.bin', 'b.bin', 'c.bin'].map((path) => ({
      path, url: `https://example.com/${path}`, sha256, sizeBytes: bytes.length,
    })));
    await expect(ensureModelPackInstalled({ ...installOptions, signal: new AbortController().signal }, {
      fs, fetch: fetchManifest(remote),
    })).rejects.toMatchObject({ message: 'model_pack_insufficient_storage', requiredBytes: 20, availableBytes: 19 });
    expect(requested).toEqual([]);

    Object.assign(fs.Paths, { availableDiskSpace: 20 });
    await ensureModelPackInstalled({ ...installOptions, signal: new AbortController().signal }, { fs, fetch: fetchManifest(remote) });
    expect(requested.sort()).toEqual(['https://example.com/b.bin', 'https://example.com/c.bin']);
  });

  it('rejects a manifest published for a different model role', async () => {
    const remote = { ...manifest([{ path: 'a.bin', url: 'https://example.com/a.bin', sha256: 'a'.repeat(64), sizeBytes: 1 }]), kind: 'stt_sherpa' as const };
    await expect(ensureModelPackInstalled({ ...installOptions, kind: 'tts_sherpa', signal: new AbortController().signal }, {
      fs: createFs(), fetch: fetchManifest(remote),
    })).rejects.toThrow('model_pack_manifest_kind_mismatch');
  });

  it('rejects pack manifests that contain unsafe paths', async () => {
    await expect(ensureModelPackInstalled({ ...installOptions, signal: new AbortController().signal }, {
      fs: createFs(), fetch: fetchManifest(manifest([
        { path: '../escape.txt', url: 'https://example.com/escape.txt', sha256: 'a'.repeat(64), sizeBytes: 1 },
      ])),
    })).rejects.toThrow('model_pack_invalid_path');
  });

  it.each([
    { paths: ['lang/en', 'lang//en'], code: 'model_pack_path_alias' },
    { paths: ['lang/en', 'lang/ en '], code: 'model_pack_path_alias' },
    { paths: ['lang/en', 'LANG/en'], code: 'model_pack_path_alias' },
    { paths: ['data', 'data/model.bin'], code: 'model_pack_path_file_directory_conflict' },
    { paths: ['pack.json'], code: 'model_pack_reserved_path' },
  ])('rejects conflicting manifest destinations before downloading: $paths', async ({ paths, code }) => {
    const fs = createFs();
    const bytes = new Uint8Array([1]);
    useNativeDownloads(fs, () => bytes);
    const hash = await sha256Hex(bytes);
    await expect(ensureModelPackInstalled({ ...installOptions, signal: new AbortController().signal }, {
      fs, fetch: fetchManifest(manifest(paths.map((path) => ({
        path, url: 'https://example.com/file.bin', sha256: hash, sizeBytes: 1,
      })))),
    })).rejects.toThrow(code);
    expect([...fs.files.keys()]).toEqual([]);
  });

  it('refreshes an installed pack when a requested manual update has a different remote manifest', async () => {
    const fs = createFs();
    const oldManifest = manifest([
      { path: 'model.onnx', url: 'https://example.com/model.onnx', sha256: 'a'.repeat(64), sizeBytes: 1 },
    ]);
    const meta = new fs.File(PACK_URI, 'pack.json');
    meta.write(JSON.stringify({ manifest: oldManifest }));
    const bytes = new Uint8Array([1]);
    useNativeDownloads(fs, () => bytes);
    const remote = manifest([
      { path: 'model.onnx', url: 'https://example.com/model.onnx?rev=2', sha256: await sha256Hex(bytes), sizeBytes: bytes.length },
    ], 'v2');
    await ensureModelPackInstalled({ ...installOptions, signal: new AbortController().signal, updatePolicy: 'manual_update_if_available' }, {
      fs, fetch: fetchManifest(remote),
    });
    const parsed = JSON.parse(await meta.text());
    expect(parsed.manifest.version).toBe('v2');
  });

  describe('manual updates', () => {
    async function installedPack(fs: ReturnType<typeof createFs>, entries: Array<{ path: string; bytes: Uint8Array }>) {
      const installed = manifest(await Promise.all(entries.map(async ({ path, bytes }) => {
        fs.files.set(`${PACK_URI}/${path}`, bytes);
        return { path, url: `https://example.com/v1/${path}`, sha256: await sha256Hex(bytes), sizeBytes: bytes.length };
      })), 'v1');
      new fs.File(PACK_URI, 'pack.json').write(JSON.stringify({ manifest: installed }));
      return installed;
    }

    const updateOptions = { ...installOptions, updatePolicy: 'manual_update_if_available' as const };

    it.each([
      ['data', 'data/model.bin'],
      ['data/model.bin', 'data'],
    ])('recovers reusable staging when a failed update changes %s into %s', async (previousPath, nextPath) => {
      const fs = createFs();
      const original = new Uint8Array([1]);
      const installed = await installedPack(fs, [{ path: 'original.bin', bytes: original }]);
      const next = new Uint8Array([2]);
      const kept = new Uint8Array([3]);
      const nextHash = await sha256Hex(next);
      const keptHash = await sha256Hex(kept);
      const filesFor = (path: string): ModelPackManifest['files'] => [
        { path, url: `https://example.com/${path}`, sha256: nextHash, sizeBytes: 1 },
        { path: 'keep.bin', url: 'https://example.com/keep.bin', sha256: keptHash, sizeBytes: 1 },
        { path: 'fail.bin', url: 'https://example.com/fail.bin', sha256: nextHash, sizeBytes: 1 },
      ];
      useNativeDownloads(fs, (url) => url.endsWith('keep.bin') ? kept : next, [], {
        status: (url) => url.endsWith('fail.bin') ? 404 : 200,
        inFlight: async (url) => {
          if (url.endsWith('fail.bin')) await new Promise((resolve) => setTimeout(resolve, 20));
        },
      });
      await expect(ensureModelPackInstalled({ ...updateOptions, signal: new AbortController().signal }, {
        fs, fetch: fetchManifest(manifest(filesFor(previousPath), 'v2')),
      })).rejects.toThrow('model_pack_download_failed:404');

      const staging = 'file:///docs/happier/voice/modelPackUpdates/example';
      expect(fs.files.get(`${staging}/${previousPath}`)).toEqual(next);
      expect(fs.files.get(`${staging}/keep.bin`)).toEqual(kept);
      expect(fs.files.get(`${PACK_URI}/original.bin`)).toEqual(original);
      expect(JSON.parse(await new fs.File(PACK_URI, 'pack.json').text()).manifest).toEqual(installed);

      const requested: string[] = [];
      useNativeDownloads(fs, (url) => url.endsWith('keep.bin') ? kept : next, requested);
      await ensureModelPackInstalled({ ...updateOptions, signal: new AbortController().signal }, {
        fs, fetch: fetchManifest(manifest(filesFor(nextPath), 'v3')),
      });

      expect(requested).not.toContain('https://example.com/keep.bin');
      expect(fs.files.get(`${PACK_URI}/${nextPath}`)).toEqual(next);
      expect(fs.files.get(`${PACK_URI}/keep.bin`)).toEqual(kept);
      expect(fs.files.has(`${PACK_URI}/${previousPath}`)).toBe(false);
      expect(JSON.parse(await new fs.File(PACK_URI, 'pack.json').text()).manifest.version).toBe('v3');
      expect(new fs.Directory(staging).exists).toBe(false);
    });

    it('downloads only changed files and removes files the new build dropped', async () => {
      const fs = createFs();
      const same = new Uint8Array([1]);
      await installedPack(fs, [
        { path: 'same.bin', bytes: same },
        { path: 'changed.bin', bytes: new Uint8Array([2]) },
        { path: 'dropped.bin', bytes: new Uint8Array([3]) },
      ]);
      const changed = new Uint8Array([4]);
      const added = new Uint8Array([5]);
      const remote = manifest([
        { path: 'same.bin', url: 'https://example.com/v2/same.bin', sha256: await sha256Hex(same), sizeBytes: 1 },
        { path: 'changed.bin', url: 'https://example.com/v2/changed.bin', sha256: await sha256Hex(changed), sizeBytes: 1 },
        { path: 'nested/added.bin', url: 'https://example.com/v2/added.bin', sha256: await sha256Hex(added), sizeBytes: 1 },
      ], 'v2');
      const requested: string[] = [];
      useNativeDownloads(fs, (url) => (url.endsWith('changed.bin') ? changed : added), requested);

      await ensureModelPackInstalled({ ...updateOptions, signal: new AbortController().signal }, { fs, fetch: fetchManifest(remote) });

      expect(requested.sort()).toEqual(['https://example.com/v2/added.bin', 'https://example.com/v2/changed.bin']);
      expect(fs.files.get(`${PACK_URI}/same.bin`)).toEqual(same);
      expect(fs.files.get(`${PACK_URI}/changed.bin`)).toEqual(changed);
      expect(fs.files.get(`${PACK_URI}/nested/added.bin`)).toEqual(added);
      expect(fs.files.has(`${PACK_URI}/dropped.bin`)).toBe(false);
      expect(JSON.parse(await new fs.File(PACK_URI, 'pack.json').text()).manifest.version).toBe('v2');
    });

    it('restores installed files that went missing while updating changed ones', async () => {
      const fs = createFs();
      const kept = new Uint8Array([1]);
      await installedPack(fs, [{ path: 'kept.bin', bytes: kept }, { path: 'changed.bin', bytes: new Uint8Array([2]) }]);
      fs.files.delete(`${PACK_URI}/kept.bin`);
      const changed = new Uint8Array([4]);
      const remote = manifest([
        { path: 'kept.bin', url: 'https://example.com/v2/kept.bin', sha256: await sha256Hex(kept), sizeBytes: 1 },
        { path: 'changed.bin', url: 'https://example.com/v2/changed.bin', sha256: await sha256Hex(changed), sizeBytes: 1 },
      ], 'v2');
      useNativeDownloads(fs, (url) => (url.endsWith('kept.bin') ? kept : changed));

      await ensureModelPackInstalled({ ...updateOptions, signal: new AbortController().signal }, { fs, fetch: fetchManifest(remote) });

      expect(fs.files.get(`${PACK_URI}/kept.bin`)).toEqual(kept);
      expect(fs.files.get(`${PACK_URI}/changed.bin`)).toEqual(changed);
    });

    it('removes update leftovers when the installed pack is already current', async () => {
      const fs = createFs();
      const installed = await installedPack(fs, [{ path: 'model.bin', bytes: new Uint8Array([1]) }]);
      const leftover = 'file:///docs/happier/voice/modelPackUpdates/example/model.bin';
      fs.files.set(leftover, new Uint8Array([9]));
      await ensureModelPackInstalled({ ...updateOptions, signal: new AbortController().signal }, { fs, fetch: fetchManifest(installed) });
      expect(fs.files.has(leftover)).toBe(false);
    });

    it('discards staged update files but keeps the installed pack when the user cancels an update', async () => {
      useInstallerFakeClock();
      const fs = createFs();
      const original = new Uint8Array([2]);
      const installed = await installedPack(fs, [{ path: 'a.bin', bytes: original }, { path: 'b.bin', bytes: original }]);
      const next = new Uint8Array([7]);
      const remote = manifest([
        { path: 'a.bin', url: 'https://example.com/v2/a.bin', sha256: await sha256Hex(next), sizeBytes: 1 },
        { path: 'b.bin', url: 'https://example.com/v2/b.bin', sha256: await sha256Hex(next), sizeBytes: 1 },
      ], 'v2');
      const controller = new AbortController();
      useNativeDownloads(fs, () => next, [], {
        // a.bin finishes; cancelling while b.bin is in flight leaves a staged file behind without cleanup.
        inFlight: async (url) => {
          if (!url.endsWith('b.bin')) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
          controller.abort();
        },
      });

      await expect(settleWithFakeClock(ensureModelPackInstalled({ ...updateOptions, signal: controller.signal }, {
        fs, fetch: fetchManifest(remote),
      }))).rejects.toThrow('aborted');

      expect([...fs.files.keys()].filter((uri) => uri.includes('/modelPackUpdates/'))).toEqual([]);
      expect(fs.files.get(`${PACK_URI}/a.bin`)).toEqual(original);
      expect(JSON.parse(await new fs.File(PACK_URI, 'pack.json').text()).manifest).toEqual(installed);
    });

    it('discards files staged by a failed update when the user cancels a retry before files download', async () => {
      const fs = createFs();
      const installed = await installedPack(fs, [{ path: 'model.bin', bytes: new Uint8Array([1]) }]);
      const staged = 'file:///docs/happier/voice/modelPackUpdates/example/model.bin';
      fs.files.set(staged, new Uint8Array([9]));
      const controller = new AbortController();
      const pending = ensureModelPackInstalled({ ...updateOptions, signal: controller.signal }, {
        fs, fetch: () => new Promise<Response>(() => {}),
      });
      controller.abort();
      await expect(pending).rejects.toThrow('aborted');
      expect(fs.files.has(staged)).toBe(false);
      expect(JSON.parse(await new fs.File(PACK_URI, 'pack.json').text()).manifest).toEqual(installed);
    });

    it('updates a pack whose new build turns a file into a directory', async () => {
      const fs = createFs();
      await installedPack(fs, [{ path: 'data', bytes: new Uint8Array([1]) }]);
      const nested = new Uint8Array([2]);
      const remote = manifest([
        { path: 'data/model.bin', url: 'https://example.com/v2/model.bin', sha256: await sha256Hex(nested), sizeBytes: 1 },
      ], 'v2');
      useNativeDownloads(fs, () => nested);

      await ensureModelPackInstalled({ ...updateOptions, signal: new AbortController().signal }, { fs, fetch: fetchManifest(remote) });

      expect(fs.files.get(`${PACK_URI}/data/model.bin`)).toEqual(nested);
      expect(fs.files.has(`${PACK_URI}/data`)).toBe(false);
      expect(JSON.parse(await new fs.File(PACK_URI, 'pack.json').text()).manifest.version).toBe('v2');
    });

    it('updates a pack whose new build turns a directory into a file', async () => {
      const fs = createFs();
      await installedPack(fs, [{ path: 'data/model.bin', bytes: new Uint8Array([1]) }]);
      const flat = new Uint8Array([2]);
      const remote = manifest([
        { path: 'data', url: 'https://example.com/v2/data', sha256: await sha256Hex(flat), sizeBytes: 1 },
      ], 'v2');
      useNativeDownloads(fs, () => flat);

      await ensureModelPackInstalled({ ...updateOptions, signal: new AbortController().signal }, { fs, fetch: fetchManifest(remote) });

      expect(fs.files.get(`${PACK_URI}/data`)).toEqual(flat);
      expect(fs.files.has(`${PACK_URI}/data/model.bin`)).toBe(false);
      expect(JSON.parse(await new fs.File(PACK_URI, 'pack.json').text()).manifest.version).toBe('v2');
    });

    it('keeps the installed pack usable when an update download fails', async () => {
      const fs = createFs();
      const original = new Uint8Array([2]);
      const installed = await installedPack(fs, [{ path: 'model.bin', bytes: original }]);
      const remote = manifest([
        { path: 'model.bin', url: 'https://example.com/v2/model.bin', sha256: await sha256Hex(new Uint8Array([9])), sizeBytes: 1 },
      ], 'v2');
      const requested: string[] = [];
      useNativeDownloads(fs, () => new Uint8Array([9]), requested, { status: () => 404 });

      await expect(ensureModelPackInstalled({ ...updateOptions, signal: new AbortController().signal }, {
        fs, fetch: fetchManifest(remote),
      })).rejects.toThrow('model_pack_download_failed:404');

      expect(requested).toEqual(['https://example.com/v2/model.bin']);
      expect(fs.files.get(`${PACK_URI}/model.bin`)).toEqual(original);
      expect(JSON.parse(await new fs.File(PACK_URI, 'pack.json').text()).manifest).toEqual(installed);
    });
  });

  it('throws when packs are required but not installed', async () => {
    await expect(ensureModelPackInstalled({
      ...installOptions, signal: new AbortController().signal, mode: 'require_installed', manifestUrl: null,
    }, { fs: createFs() })).rejects.toThrow('model_pack_not_installed');
  });

  it('throws when download is requested but manifestUrl is missing', async () => {
    await expect(ensureModelPackInstalled({
      ...installOptions, signal: new AbortController().signal, manifestUrl: null,
    }, { fs: createFs() })).rejects.toThrow('model_pack_manifest_url_missing');
  });

  it('reports not installed when pack.json is missing', async () => {
    const summary = await getModelPackInstallSummary({ packId: 'example' }, { fs: createFs() });
    expect(summary.installed).toBe(false);
    expect(summary.manifest).toBe(null);
  });

  describe('partial downloads', () => {
    const STAGING_URI = 'file:///docs/happier/voice/modelPackUpdates/example';

    it('reports the bytes an unfinished install left on disk, including staged update files', async () => {
      const fs = createFs(new Map([
        [`${PACK_URI}/espeak-ng-data/lang/f0`, new Uint8Array(3)],
        [`${PACK_URI}/model.onnx`, new Uint8Array(5)],
        [`${STAGING_URI}/model.onnx`, new Uint8Array(2)],
      ]));
      const summary = await getModelPackInstallSummary({ packId: 'example' }, { fs });
      expect(summary.installed).toBe(false);
      expect(summary.partialBytes).toBe(10);
    });

    it('does not count the empty pack directory an install creates up front', async () => {
      const fs = createFs();
      await expect(ensureModelPackInstalled({
        ...installOptions, signal: new AbortController().signal, mode: 'require_installed', manifestUrl: null,
      }, { fs })).rejects.toThrow('model_pack_not_installed');
      expect((await getModelPackInstallSummary({ packId: 'example' }, { fs })).partialBytes).toBe(0);
    });

    it('reports no partial download once the pack is installed', async () => {
      const fs = createFs(new Map([
        [`${PACK_URI}/model.onnx`, new Uint8Array(5)],
        [`${STAGING_URI}/model.onnx`, new Uint8Array(2)],
      ]));
      new fs.File(PACK_URI, 'pack.json').write(JSON.stringify({ manifest: manifest([
        { path: 'model.onnx', url: 'https://example.com/model.onnx', sha256: 'a'.repeat(64), sizeBytes: 5 },
      ]) }));
      const summary = await getModelPackInstallSummary({ packId: 'example' }, { fs });
      expect(summary.installed).toBe(true);
      expect(summary.partialBytes).toBe(0);
    });

    it('discards a partial download', async () => {
      const fs = createFs(new Map([
        [`${PACK_URI}/model.onnx`, new Uint8Array(5)],
        [`${STAGING_URI}/model.onnx`, new Uint8Array(2)],
      ]));
      await removeModelPack({ packId: 'example' }, { fs });
      expect((await getModelPackInstallSummary({ packId: 'example' }, { fs })).partialBytes).toBe(0);
    });
  });

  it('removes without throwing when the directory is missing', async () => {
    await expect(removeModelPack({ packId: 'example' }, { fs: createFs() })).resolves.toBeUndefined();
  });
});

describe('filesystem mutation failures', () => {
  beforeEach(() => nativeDownload.mockReset());
  afterEach(() => vi.useRealTimers());

  it.each(['corrupt', 'unreadable'] as const)('warns without exposing contents when repairing a %s installed receipt', async (failure) => {
    const fs = createFs();
    const privateContents = 'private_receipt_contents';
    new fs.File(PACK_URI, 'pack.json').write(privateContents);
    const BaseFile = fs.File;
    class ReceiptFile extends BaseFile {
      override async text() {
        if (failure === 'unreadable' && this.uri.endsWith('/pack.json')) throw new Error(privateContents);
        return super.text();
      }
    }
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const bytes = new Uint8Array([1]);
      useNativeDownloads(fs, () => bytes);
      const remote = manifest([{ path: 'model.bin', url: 'https://example.com/model.bin', sha256: await sha256Hex(bytes), sizeBytes: 1 }]);
      await ensureModelPackInstalled({ ...installOptions, signal: new AbortController().signal }, {
        fs: { ...fs, File: ReceiptFile }, fetch: fetchManifest(remote),
      });
      expect(fs.files.get(`${PACK_URI}/model.bin`)).toEqual(bytes);
      expect(JSON.parse(await new fs.File(PACK_URI, 'pack.json').text()).manifest).toEqual(remote);
      expect(warning).toHaveBeenCalled();
      expect(warning.mock.calls.flat().map(String).join('\n')).not.toContain(privateContents);
    } finally {
      warning.mockRestore();
    }
  });

  it('rejects installation when the installed receipt cannot be written', async () => {
    const fs = createFs();
    const BaseFile = fs.File;
    class FailingReceiptFile extends BaseFile {
      override write(value: string | Uint8Array) {
        if (this.uri.endsWith('/pack.json')) throw new Error('ENOSPC_receipt_write');
        super.write(value);
      }
    }
    const bytes = new Uint8Array([1, 2, 3]);
    useNativeDownloads(fs, () => bytes);
    const remote = manifest([{ path: 'model.bin', url: 'https://example.com/model.bin', sha256: await sha256Hex(bytes), sizeBytes: bytes.length }]);
    await expect(ensureModelPackInstalled({ ...installOptions, signal: new AbortController().signal }, {
      fs: { ...fs, File: FailingReceiptFile }, fetch: fetchManifest(remote),
    })).rejects.toThrow('ENOSPC_receipt_write');
  });

  it('warns when an existing file cannot be verified before repairing it', async () => {
    const fs = createFs(new Map([[`${PACK_URI}/model.bin`, new Uint8Array([9])]]));
    const readError = new Error('EIO_file_read');
    const BaseFile = fs.File;
    let failRead = true;
    class UnreadableFile extends BaseFile {
      override open() {
        if (failRead) { failRead = false; throw readError; }
        return super.open();
      }
    }
    const bytes = new Uint8Array([1]);
    const remote = manifest([{ path: 'model.bin', url: 'https://example.com/model.bin', sha256: await sha256Hex(bytes), sizeBytes: 1 }]);
    useNativeDownloads(fs, () => bytes);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await ensureModelPackInstalled({ ...installOptions, signal: new AbortController().signal }, {
        fs: { ...fs, File: UnreadableFile }, fetch: fetchManifest(remote),
      });
      expect(fs.files.get(`${PACK_URI}/model.bin`)).toEqual(bytes);
      expect(warning.mock.calls.flat()).toContain(readError);
    } finally { warning.mockRestore(); }
  });

  it('warns when failed verification cannot remove its file and preserves the causal error', async () => {
    const fs = createFs();
    const cleanupError = new Error('EACCES_file_delete');
    const BaseFile = fs.File;
    class UndeletableFile extends BaseFile {
      override delete() { throw cleanupError; }
    }
    const bytes = new Uint8Array([1]);
    const remote = manifest([{ path: 'model.bin', url: 'https://example.com/model.bin', sha256: await sha256Hex(bytes), sizeBytes: 1 }]);
    useNativeDownloads(fs, () => new Uint8Array([9]));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(ensureModelPackInstalled({ ...installOptions, signal: new AbortController().signal }, {
        fs: { ...fs, File: UndeletableFile }, fetch: fetchManifest(remote),
      })).rejects.toThrow('model_pack_sha256_mismatch');
      expect(fs.files.get(`${PACK_URI}/model.bin`)).toEqual(new Uint8Array([9]));
      expect(warning.mock.calls.flat()).toContain(cleanupError);
    } finally { warning.mockRestore(); }
  });

  it('leaves installed bytes intact when the old receipt cannot be invalidated', async () => {
    const fs = createFs();
    const before = new Uint8Array([1]);
    const after = new Uint8Array([2]);
    const old = manifest(await Promise.all(['a.bin', 'b.bin'].map(async (path) => ({ path, url: `https://example.com/v1/${path}`, sha256: await sha256Hex(before), sizeBytes: 1 }))));
    for (const path of ['a.bin', 'b.bin']) fs.files.set(`${PACK_URI}/${path}`, before);
    new fs.File(PACK_URI, 'pack.json').write(JSON.stringify({ manifest: old }));
    const BaseFile = fs.File;
    class UndeletableReceiptFile extends BaseFile {
      override delete() {
        if (this.uri.endsWith('/pack.json')) throw new Error('EACCES_receipt_delete');
        super.delete();
      }
      override move(destination: { uri: string }) {
        if (this.uri.includes('/modelPackUpdates/') && this.uri.endsWith('/b.bin')) throw new Error('EIO_second_file_move');
        super.move(destination);
      }
    }
    useNativeDownloads(fs, () => after);
    const remote = manifest(await Promise.all(['a.bin', 'b.bin'].map(async (path) => ({ path, url: `https://example.com/v2/${path}`, sha256: await sha256Hex(after), sizeBytes: 1 }))), 'v2');
    const injectedFs = { ...fs, File: UndeletableReceiptFile };
    const attempt = ensureModelPackInstalled({ ...installOptions, updatePolicy: 'manual_update_if_available', signal: new AbortController().signal }, {
      fs: injectedFs, fetch: fetchManifest(remote),
    });
    await expect(attempt).rejects.toThrow('EACCES_receipt_delete');
    expect(fs.files.get(`${PACK_URI}/a.bin`)).toEqual(before);
  });

  it('reports failure when removing a partial pack cannot delete its directory', async () => {
    const fs = createFs(new Map([[`${PACK_URI}/model.bin`, new Uint8Array([1])]]));
    const BaseDirectory = fs.Directory;
    class UndeletableDirectory extends BaseDirectory {
      override delete() { throw new Error('EACCES_directory_delete'); }
    }
    await expect(removeModelPack({ packId: 'example' }, { fs: { ...fs, Directory: UndeletableDirectory } })).rejects.toThrow('EACCES_directory_delete');
  });
});

describe('native speech engine lifecycle', () => {
  const PACK_PATH = '/docs/happier/voice/modelPacks/example';

  // The sherpa native module is a platform boundary: it caches engines that hold the pack's model files.
  function createSherpaNative(onRelease: () => void = () => {}, fs?: ReturnType<typeof createFs>) {
    const released: string[] = [];
    return {
      released,
      module: {
        async release({ assetsDir }: { assetsDir: string }) { onRelease(); released.push(assetsDir); },
        async excludeFromBackup({ path }: { path: string }) {
          fs?.backupExcludedDirectories.add(`file://${path}`);
        },
      },
    };
  }

  async function installSingleFilePack(fs: ReturnType<typeof createFs>, sherpaNative: InstallerSherpaNative) {
    const bytes = new Uint8Array([7]);
    useNativeDownloads(fs, () => bytes);
    const files = [{ path: 'model.onnx', url: 'https://example.com/model.onnx', sha256: await sha256Hex(bytes), sizeBytes: 1 }];
    await ensureModelPackInstalled({ ...installOptions, signal: new AbortController().signal }, {
      fs, fetch: fetchManifest(manifest(files)), sherpaNative,
    });
  }

  beforeEach(() => { nativeDownload.mockReset(); });

  it('keeps an installed pack excluded from device backup when it is reused', async () => {
    const fs = createFs();
    const native = createSherpaNative(undefined, fs);
    await installSingleFilePack(fs, native.module);
    await ensureModelPackInstalled({ ...installOptions, signal: new AbortController().signal, mode: 'require_installed' }, {
      fs, sherpaNative: native.module,
    });
    expect(fs.backupExcludedDirectories.has(PACK_URI)).toBe(true);
  });

  it('excludes a recreated pack directory after removing and reinstalling it', async () => {
    const fs = createFs();
    const native = createSherpaNative(undefined, fs);
    await installSingleFilePack(fs, native.module);
    expect(fs.backupExcludedDirectories.has(PACK_URI)).toBe(true);
    await removeModelPack({ packId: 'example' }, { fs, sherpaNative: native.module });
    expect(fs.backupExcludedDirectories.has(PACK_URI)).toBe(false);

    await installSingleFilePack(fs, native.module);
    expect(fs.backupExcludedDirectories.has(PACK_URI)).toBe(true);
  });

  it.each(['install', 'update'] as const)('excludes a recreated %s directory when retrying after cancellation', async (operation) => {
    const fs = createFs();
    const native = createSherpaNative(undefined, fs);
    if (operation === 'update') await installSingleFilePack(fs, native.module);
    const directoryUri = operation === 'update' ? 'file:///docs/happier/voice/modelPackUpdates/example' : PACK_URI;
    const bytes = new Uint8Array([8]);
    const remote = manifest([
      { path: 'model.onnx', url: 'https://example.com/model.onnx?rev=2', sha256: await sha256Hex(bytes), sizeBytes: bytes.length },
    ], 'v2');
    const controller = new AbortController();
    let excludedBeforeCancellation = false;
    useNativeDownloads(fs, () => bytes, [], { inFlight: async () => {
      excludedBeforeCancellation = fs.backupExcludedDirectories.has(directoryUri);
      controller.abort();
    } });
    const options = { ...installOptions, ...(operation === 'update' ? { updatePolicy: 'manual_update_if_available' as const } : {}) };
    await expect(ensureModelPackInstalled({ ...options, signal: controller.signal }, {
      fs, fetch: fetchManifest(remote), sherpaNative: native.module,
    })).rejects.toThrow('aborted');
    expect(excludedBeforeCancellation).toBe(true);
    expect(fs.backupExcludedDirectories.has(directoryUri)).toBe(false);

    let excludedDuringRetry = false;
    useNativeDownloads(fs, () => bytes, [], { inFlight: async () => {
      excludedDuringRetry = fs.backupExcludedDirectories.has(directoryUri);
    } });
    await ensureModelPackInstalled({ ...options, signal: new AbortController().signal }, {
      fs, fetch: fetchManifest(remote), sherpaNative: native.module,
    });
    expect(excludedDuringRetry).toBe(true);
  });

  it('still installs when the platform rejects the backup exclusion', async () => {
    const fs = createFs();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await installSingleFilePack(fs, { excludeFromBackup: async () => { throw new Error('EPERM'); } });
    expect((await getModelPackInstallSummary({ packId: 'example' }, { fs })).installed).toBe(true);
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
  });

  it('unloads native engines before removing a pack', async () => {
    const fs = createFs();
    await installSingleFilePack(fs, {});
    let filesPresentAtRelease = false;
    const native = createSherpaNative(() => { filesPresentAtRelease = fs.files.has(`${PACK_URI}/model.onnx`); });
    await removeModelPack({ packId: 'example' }, { fs, sherpaNative: native.module });
    expect(native.released).toEqual([PACK_PATH]);
    expect(filesPresentAtRelease).toBe(true);
    expect(fs.files.has(`${PACK_URI}/model.onnx`)).toBe(false);
  });

  it.each(['remove', 'update'] as const)('preserves the installed pack when engine release rejects a %s', async (operation) => {
    const fs = createFs();
    await installSingleFilePack(fs, {});
    const oldBytes = fs.files.get(`${PACK_URI}/model.onnx`);
    const oldReceipt = fs.files.get(`${PACK_URI}/pack.json`);
    const error = new Error('native_release_failed');
    const sherpaNative = { release: async () => { throw error; } };
    const next = new Uint8Array([8]);
    useNativeDownloads(fs, () => next);
    const mutation = operation === 'remove'
      ? removeModelPack({ packId: 'example' }, { fs, sherpaNative })
      : ensureModelPackInstalled({ ...installOptions, signal: new AbortController().signal, updatePolicy: 'manual_update_if_available' }, {
        fs, sherpaNative, fetch: fetchManifest(manifest([
          { path: 'model.onnx', url: 'https://example.com/model.onnx?rev=2', sha256: await sha256Hex(next), sizeBytes: 1 },
        ], 'v2')),
      });
    await expect(mutation).rejects.toBe(error);
    expect(fs.files.get(`${PACK_URI}/model.onnx`)).toEqual(oldBytes);
    expect(fs.files.get(`${PACK_URI}/pack.json`)).toEqual(oldReceipt);
  });

  it('unloads native engines before an update swaps the pack files', async () => {
    const fs = createFs();
    await installSingleFilePack(fs, {});
    const oldBytes = fs.files.get(`${PACK_URI}/model.onnx`);
    let bytesAtRelease: Uint8Array | undefined;
    const native = createSherpaNative(() => { bytesAtRelease = fs.files.get(`${PACK_URI}/model.onnx`); });
    const next = new Uint8Array([8]);
    useNativeDownloads(fs, () => next);
    await ensureModelPackInstalled({ ...installOptions, signal: new AbortController().signal, updatePolicy: 'manual_update_if_available' }, {
      fs,
      fetch: fetchManifest(manifest([
        { path: 'model.onnx', url: 'https://example.com/model.onnx?rev=2', sha256: await sha256Hex(next), sizeBytes: 1 },
      ], 'v2')),
      sherpaNative: native.module,
    });
    expect(native.released).toEqual([PACK_PATH]);
    expect(bytesAtRelease).toEqual(oldBytes);
    expect(fs.files.get(`${PACK_URI}/model.onnx`)).toEqual(next);
  });
});
