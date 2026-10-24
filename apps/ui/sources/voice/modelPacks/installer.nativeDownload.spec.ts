import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DownloadOptions, DownloadPauseState, DownloadProgressData, FileSystemDownloadResult } from 'expo-file-system/legacy';

import { ensureModelPackInstalled, type ModelPackDownloadProgress } from '@/voice/modelPacks/installer.native';
import { settleWithFakeClock, useInstallerFakeClock } from '@/voice/modelPacks/installerFakeClock.testHarness';

type NativeTask = {
  downloadAsync(): Promise<FileSystemDownloadResult | undefined>;
  pauseAsync(): Promise<DownloadPauseState>;
  cancelAsync(): Promise<void>;
};

const nativeBoundary = vi.hoisted(() => ({
  platform: { OS: 'android' as 'android' | 'ios' },
  cryptoWorker: null as null | { sha256File?: (fileUri: string) => Promise<string> },
  createDownloadResumable: vi.fn<(
    url: string, uri: string, options: DownloadOptions | undefined,
    onProgress?: (progress: DownloadProgressData) => void,
  ) => NativeTask>(),
}));

// The native network/filesystem modules are unavailable in the Node test process.
vi.mock('expo-file-system/legacy', () => ({
  createDownloadResumable: nativeBoundary.createDownloadResumable,
  FileSystemSessionType: { BACKGROUND: 0, FOREGROUND: 1 },
}));
vi.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: (name: string) => (name === 'HappierCryptoWorker' ? nativeBoundary.cryptoWorker : null),
}));
vi.mock('react-native', async () => {
  const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeNativeMock({ platformOS: 'android' }, {
    Platform: { get OS() { return nativeBoundary.platform.OS; } },
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function createHarness(options: { status?: number; pending?: boolean; failure?: Error; setupFailure?: Error } = {}) {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const { createHash } = await import('node:crypto');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const files = new Map<string, Uint8Array>();
  const fileUri = 'file:///docs/happier/voice/modelPacks/example/model.bin';
  const metaUri = 'file:///docs/happier/voice/modelPacks/example/pack.json';
  const written = deferred<void>();
  const terminal = deferred<FileSystemDownloadResult | undefined>();
  const lifecycle = { subscribed: false, retainedNativeTask: false, stopRequested: false };
  const jsHashReads = { count: 0 };
  const requestedUrls: string[] = [];
  const nativeUrls: string[] = [];
  const nativeOptions: DownloadOptions[] = [];
  const status = options.status ?? 200;
  const nativeResult = { uri: fileUri, status, headers: {}, mimeType: null };
  const cleanupError = new Error('native_task_not_found');

  function uri(parts: Array<string | { uri: string }>) {
    return parts.map((part) => (typeof part === 'string' ? part : part.uri).replace(/\/$/, '')).join('/');
  }
  class Directory {
    uri: string;
    constructor(...parts: Array<string | { uri: string }>) { this.uri = uri(parts); }
    get exists() { return [...files.keys()].some((path) => path.startsWith(`${this.uri}/`)); }
    create() {}
    delete() {
      for (const path of files.keys()) if (path.startsWith(`${this.uri}/`)) files.delete(path);
    }
  }
  class File {
    uri: string;
    constructor(...parts: Array<string | { uri: string }>) { this.uri = uri(parts); }
    get exists() { return files.has(this.uri); }
    create() { if (!this.exists) files.set(this.uri, new Uint8Array()); }
    delete() { files.delete(this.uri); }
    write(value: string) { files.set(this.uri, new TextEncoder().encode(value)); }
    async text() { return new TextDecoder().decode(files.get(this.uri)); }
    move(destination: { uri: string }) {
      const bytes = files.get(this.uri);
      if (!bytes) throw new Error('move_source_missing');
      if (files.has(destination.uri) || new Directory(destination.uri).exists) throw new Error('move_destination_exists');
      files.delete(this.uri);
      files.set(destination.uri, bytes);
      this.uri = destination.uri;
    }
    open() {
      let offset = 0;
      const fileUri = this.uri;
      return {
        readBytes(length: number) {
          jsHashReads.count += 1;
          if (length > 4 * 1024 * 1024) throw new Error('whole_file_read');
          const chunk = (files.get(fileUri) ?? new Uint8Array()).slice(offset, offset + length);
          offset += chunk.length;
          return chunk;
        },
        close() {},
      };
    }
  }

  nativeBoundary.createDownloadResumable.mockImplementation((url, destination, optionsForTask, onProgress) => ({
    async downloadAsync() {
      nativeUrls.push(url);
      nativeOptions.push(optionsForTask ?? {});
      lifecycle.subscribed = true;
      if (options.setupFailure) throw options.setupFailure;
      lifecycle.retainedNativeTask = true;
      files.set(destination, bytes.slice(0, options.pending || options.failure ? 2 : bytes.length));
      written.resolve();
      onProgress?.({ totalBytesWritten: 2, totalBytesExpectedToWrite: bytes.length });
      if (options.pending) {
        const result = await terminal.promise;
        if (nativeBoundary.platform.OS === 'ios') lifecycle.retainedNativeTask = false;
        return result;
      }
      if (options.failure) {
        if (nativeBoundary.platform.OS === 'ios') lifecycle.retainedNativeTask = false;
        throw options.failure;
      }
      onProgress?.({ totalBytesWritten: bytes.length, totalBytesExpectedToWrite: bytes.length });
      if (nativeBoundary.platform.OS === 'ios') lifecycle.retainedNativeTask = false;
      return { ...nativeResult, uri: destination };
    },
    async pauseAsync() {
      // SDK 54 iOS unregisters completed tasks; its pause method then rejects before removing the JS subscription.
      if (!lifecycle.retainedNativeTask) throw cleanupError;
      lifecycle.stopRequested = true;
      lifecycle.retainedNativeTask = false;
      lifecycle.subscribed = false;
      return { url, fileUri: destination, options: optionsForTask ?? {}, resumeData: '2' };
    },
    async cancelAsync() {
      lifecycle.stopRequested = true;
      lifecycle.subscribed = false;
      // SDK 54 Android cancellation leaves the native UUID registered; pause is its release boundary.
    },
  }));

  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.includes('manifest.json')) return Response.json({
      packId: 'example', kind: 'stt_sherpa', model: 'zipformer', version: 'v1',
      files: [{ path: 'model.bin', url: 'https://example.com/model.bin', sha256, sizeBytes: bytes.length }],
    });
    throw new Error('artifact_fetch_crossed_js_boundary');
  };

  const install = (signal: AbortSignal, onProgress?: (progress: ModelPackDownloadProgress) => void) => ensureModelPackInstalled({
    packId: 'example', mode: 'download_if_missing', manifestUrl: 'https://example.com/manifest.json',
    timeoutMs: 120_000, signal, onProgress,
  }, { fs: { Directory, File, Paths: { document: 'file:///docs/' } }, fetch: fetchImpl });

  return { bytes, sha256, files, fileUri, metaUri, written, terminal, lifecycle, jsHashReads, requestedUrls, nativeUrls, nativeOptions, cleanupError, install };
}

describe('native model pack file downloads', () => {
  beforeEach(() => {
    nativeBoundary.createDownloadResumable.mockReset();
    nativeBoundary.platform.OS = 'android';
    nativeBoundary.cryptoWorker = null;
  });
  afterEach(() => { vi.useRealTimers(); });

  it.each(['android', 'ios'] as const)('downloads files outside JS and releases native resources on %s', async (platform) => {
    nativeBoundary.platform.OS = platform;
    const harness = await createHarness();
    const progress: ModelPackDownloadProgress[] = [];
    await harness.install(new AbortController().signal, (value) => progress.push(value));

    expect(harness.requestedUrls).toHaveLength(1);
    expect(harness.requestedUrls[0]).toContain('manifest.json');
    expect(harness.nativeUrls).toEqual(['https://example.com/model.bin']);
    if (platform === 'ios') expect(harness.nativeOptions[0]?.sessionType).toBe(1);
    expect(harness.files.get(harness.fileUri)).toEqual(harness.bytes);
    expect(harness.files.has(harness.metaUri)).toBe(true);
    // Bytes arrive while the file transfers, then hashing reports verified bytes; it counts as done only once verified.
    expect(progress).toEqual([
      { loaded: 2, total: 4, verified: 0, filesDone: 0, filesTotal: 1 },
      { loaded: 4, total: 4, verified: 0, filesDone: 0, filesTotal: 1 },
      { loaded: 4, total: 4, verified: 4, filesDone: 0, filesTotal: 1 },
      { loaded: 4, total: 4, verified: 4, filesDone: 1, filesTotal: 1 },
    ]);
    expect(harness.lifecycle).toMatchObject({ subscribed: false, retainedNativeTask: false });
  });

  it('verifies downloaded files with the native hasher instead of hashing bytes on the JS thread', async () => {
    const harness = await createHarness();
    const { createHash } = await import('node:crypto');
    const hashedUris: string[] = [];
    nativeBoundary.cryptoWorker = {
      async sha256File(fileUri) {
        hashedUris.push(fileUri);
        return createHash('sha256').update(harness.files.get(fileUri) ?? new Uint8Array()).digest('hex');
      },
    };
    const progress: ModelPackDownloadProgress[] = [];
    await harness.install(new AbortController().signal, (value) => progress.push(value));

    expect(hashedUris).toEqual([harness.fileUri]);
    expect(harness.jsHashReads.count).toBe(0);
    expect(harness.files.has(harness.metaUri)).toBe(true);
    expect(progress.at(-1)).toEqual({ loaded: 4, total: 4, verified: 4, filesDone: 1, filesTotal: 1 });
  });

  it('rejects a downloaded file whose native hash does not match the manifest', async () => {
    const harness = await createHarness();
    nativeBoundary.cryptoWorker = { sha256File: async () => '0'.repeat(64) };
    await expect(harness.install(new AbortController().signal)).rejects.toThrow('model_pack_sha256_mismatch');
    expect(harness.files.has(harness.fileUri)).toBe(false);
    expect(harness.files.has(harness.metaUri)).toBe(false);
  });

  it('fails the install and removes the file when native hashing fails', async () => {
    const harness = await createHarness();
    const hashError = new Error('native_hash_failed');
    nativeBoundary.cryptoWorker = { sha256File: async () => { throw hashError; } };
    await expect(harness.install(new AbortController().signal)).rejects.toBe(hashError);
    expect(harness.jsHashReads.count).toBe(0);
    expect(harness.files.has(harness.fileUri)).toBe(false);
    expect(harness.files.has(harness.metaUri)).toBe(false);
  });

  it('rejects a non-success HTTP result and removes the native-downloaded file', async () => {
    const harness = await createHarness({ status: 404 });
    await expect(harness.install(new AbortController().signal)).rejects.toThrow('model_pack_download_failed:404');
    // A missing asset is permanent; only transient transfer failures are retried.
    expect(harness.nativeUrls).toHaveLength(1);
    expect(harness.files.has(harness.fileUri)).toBe(false);
    expect(harness.files.has(harness.metaUri)).toBe(false);
    expect(harness.lifecycle).toMatchObject({ subscribed: false, retainedNativeTask: false });
  });

  it('removes partial output and releases native resources after a transport failure', async () => {
    const harness = await createHarness({ failure: new Error('native_transport_failed') });
    useInstallerFakeClock();
    await expect(settleWithFakeClock(harness.install(new AbortController().signal))).rejects.toThrow('native_transport_failed');
    // Transport failures are transient on mobile networks, so the file is retried before the pack fails.
    expect(harness.nativeUrls.length).toBeGreaterThan(1);
    expect(harness.files.has(harness.fileUri)).toBe(false);
    expect(harness.files.has(harness.metaUri)).toBe(false);
    expect(harness.lifecycle).toMatchObject({ subscribed: false, retainedNativeTask: false });
  });

  it('fails without retrying when the device runs out of storage during a transfer', async () => {
    const harness = await createHarness({ failure: new Error('java.io.IOException: write failed: ENOSPC (No space left on device)') });
    useInstallerFakeClock();
    await expect(settleWithFakeClock(harness.install(new AbortController().signal))).rejects.toThrow('ENOSPC');
    expect(harness.nativeUrls).toHaveLength(1);
    expect(harness.files.has(harness.fileUri)).toBe(false);
  });

  it('preserves native setup failure while reporting cleanup failure and unsubscribing', async () => {
    const originalError = new Error('native_start_failed');
    const harness = await createHarness({ setupFailure: originalError });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      useInstallerFakeClock();
      await expect(settleWithFakeClock(harness.install(new AbortController().signal))).rejects.toBe(originalError);
      expect(warning.mock.calls.flat()).toContain(harness.cleanupError);
      expect(harness.files.has(harness.metaUri)).toBe(false);
      expect(harness.lifecycle).toMatchObject({ subscribed: false, retainedNativeTask: false });
    } finally {
      warning.mockRestore();
    }
  });

  it.each(['android', 'ios'] as const)('waits for native writing to stop before cancellation cleanup on %s', async (platform) => {
    nativeBoundary.platform.OS = platform;
    const harness = await createHarness({ pending: true });
    const controller = new AbortController();
    let settled = false;
    const outcome = harness.install(controller.signal).then(
      () => { settled = true; return null; },
      (error: unknown) => { settled = true; return error; },
    );
    try {
      const started = await Promise.race([
        harness.written.promise.then(() => true),
        outcome.then(() => false),
      ]);
      expect(started).toBe(true);
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      expect(harness.files.has(harness.fileUri)).toBe(true);
      expect(harness.lifecycle.stopRequested).toBe(true);
    } finally {
      controller.abort();
      harness.terminal.resolve(undefined);
      await outcome;
    }
    expect(await outcome).toBeInstanceOf(Error);
    expect(harness.files.has(harness.fileUri)).toBe(false);
    expect(harness.files.has(harness.metaUri)).toBe(false);
    expect(harness.lifecycle).toMatchObject({ subscribed: false, retainedNativeTask: false });
  });
});
