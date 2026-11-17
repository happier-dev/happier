import { describe, expect, it, vi } from 'vitest';
import type { DownloadOptions, DownloadProgressData, DownloadResumable } from 'expo-file-system/legacy';

import { checkModelPackUpdateAvailable, ensureModelPackInstalled, findRunningModelPackInstall, getModelPackInstallSummary, removeModelPack } from '@/voice/modelPacks/installer.native';
import { isModelPackCancellation } from '@/voice/modelPacks/installer/network';
import { createMemFs, createMemNativeDownload } from '@/voice/modelPacks/installerTestFs';
import { deriveModelPackStagingPlan } from '@happier-dev/voice-modelpacks';
import { createDeferred } from '@/dev/testkit';

const nativeDownload = vi.hoisted(() => vi.fn<(
  url: string, uri: string, options?: DownloadOptions, progress?: (value: DownloadProgressData) => void,
) => Pick<DownloadResumable, 'downloadAsync' | 'pauseAsync' | 'cancelAsync'>>());
vi.mock('expo-file-system/legacy', () => ({ createDownloadResumable: nativeDownload,
  FileSystemSessionType: { BACKGROUND: 0, FOREGROUND: 1 } }));
vi.mock('react-native', async () => {
  const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeNativeMock({ platformOS: 'android' });
});

describe('modelPacks installer (native)', () => {
  it.each(['observer', 'removal'] as const)('settles shared installation and native cleanup when cancelled by %s', async (canceller) => {
    const { fs, files, root } = createMemFs();
    const manifest = { packId: `cancel-${canceller}`, kind: 'tts_sherpa', model: 'kokoro', version: 'v1',
      files: [{ path: 'model.bin', url: 'https://example.com/model.bin', sizeBytes: 1,
        sha256: '4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a' }] };
    let transferSignal: AbortSignal | null = null;
    const transferStarted = createDeferred<void>();
    const fetchImpl: typeof fetch = async (input, init) => {
      if (String(input).includes('manifest.json')) return Response.json(manifest);
      transferSignal = init?.signal ?? null;
      transferStarted.resolve();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    };
    const overrides = { fs, fetch: fetchImpl, download: createMemNativeDownload(fs, fetchImpl), invalidatePackRuntime: async () => {} };
    const firstController = new AbortController();
    const started = ensureModelPackInstalled({ packId: manifest.packId, mode: 'download_if_missing',
      manifestUrl: 'https://example.com/manifest.json', timeoutMs: null, signal: firstController.signal }, overrides);
    const startedOutcome = started.catch((error: unknown) => error);
    await transferStarted.promise;
    expect(transferSignal).not.toBeNull();
    const running = await findRunningModelPackInstall({ packId: manifest.packId }, overrides);
    expect(running).not.toBeNull();
    const controller = new AbortController();
    const followed = running!.follow({ signal: controller.signal }).catch((error: unknown) => error);
    if (canceller === 'observer') controller.abort();
    else await removeModelPack({ packId: manifest.packId }, overrides);
    expect(isModelPackCancellation(await followed, controller.signal)).toBe(true);
    expect(isModelPackCancellation(await startedOutcome, firstController.signal)).toBe(true);
    expect((transferSignal as AbortSignal | null)?.aborted).toBe(true);
    expect(await findRunningModelPackInstall({ packId: manifest.packId }, overrides)).toBeNull();
    expect([...files.keys()].some(path => path.startsWith(`${root}/.${manifest.packId}.downloads/`))).toBe(false);
    expect(files.has(`${root}/${manifest.packId}/pack.json`)).toBe(false);
  });

  it('shares a running install with another caller for the same pack directory', async () => {
    const { fs, files, root } = createMemFs();
    const bytes = new Uint8Array([1]);
    const manifest = { packId: 'shared-install', kind: 'tts_sherpa', model: 'kokoro', version: 'v1',
      files: [{ path: 'model.bin', url: 'https://example.com/model.bin', sizeBytes: 1,
        sha256: '4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a' }] };
    let releaseDownload!: () => void;
    const downloadHeld = new Promise<void>(resolve => { releaseDownload = resolve; });
    const artifactRequests: string[] = [];
    const artifactRequested = createDeferred<void>();
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).includes('manifest.json')) return Response.json(manifest);
      artifactRequests.push(String(input));
      artifactRequested.resolve();
      await downloadHeld;
      return new Response(bytes);
    };
    const overrides = { fs, fetch: fetchImpl, download: createMemNativeDownload(fs, fetchImpl), invalidatePackRuntime: async () => {} };
    const request = { packId: manifest.packId, mode: 'download_if_missing' as const,
      manifestUrl: 'https://example.com/manifest.json', timeoutMs: null, signal: new AbortController().signal };
    const first = ensureModelPackInstalled(request, overrides);
    await artifactRequested.promise;
    expect(artifactRequests).toHaveLength(1);
    const followerProgress: number[] = [];
    const second = ensureModelPackInstalled({ ...request, signal: new AbortController().signal,
      onProgress: progress => followerProgress.push(progress.loaded) }, overrides);
    const results = Promise.allSettled([first, second]);
    releaseDownload();
    expect((await results).map(result => result.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(artifactRequests).toEqual(['https://example.com/model.bin']);
    expect(followerProgress.at(-1)).toBe(bytes.length);
    expect(files.get(`${root}/shared-install/model.bin`)).toEqual(bytes);
  });

  it('checks remaining model bytes against free space before downloading and accepts a fitting resumed install', async () => {
    const { fs, files, root } = createMemFs();
    const bytes = new Uint8Array([1, 2, 3]);
    const { createHash } = await import('node:crypto');
    const manifest = { packId: 'disk-check', kind: 'tts_sherpa' as const, model: 'kokoro', version: 'v1',
      files: [{ path: 'model.bin', url: 'https://example.com/model.bin', sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') }] };
    const artifactRequests: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      if (String(input).includes('manifest.json')) return Response.json(manifest);
      artifactRequests.push(String(input));
      const ranged = new Headers(init?.headers).get('Range') === 'bytes=2-';
      return new Response(ranged ? bytes.slice(2) : bytes, { status: ranged ? 206 : 200 });
    };
    const request = { packId: manifest.packId, mode: 'download_if_missing' as const,
      manifestUrl: 'https://example.com/manifest.json', timeoutMs: null, signal: new AbortController().signal };
    const overrides = { fs, fetch: fetchImpl, download: createMemNativeDownload(fs, fetchImpl), invalidatePackRuntime: async () => {} };
    fs.Paths.availableDiskSpace = 2;
    await expect(ensureModelPackInstalled(request, overrides)).rejects.toThrow('model_pack_insufficient_disk_space');
    expect(artifactRequests).toEqual([]);
    files.set(`${root}/.disk-check.scratch/.resume-plan.json`, new TextEncoder().encode(JSON.stringify({
      schemaVersion: 1, ...deriveModelPackStagingPlan(manifest),
    })));
    files.set(`${root}/.disk-check.scratch/model.bin`, bytes.slice(0, 2));
    fs.Paths.availableDiskSpace = 1;
    await ensureModelPackInstalled(request, overrides);
    expect(files.get(`${root}/disk-check/model.bin`)).toEqual(bytes);
    expect(artifactRequests).toEqual(['https://example.com/model.bin']);
  });

  it('excludes native staging, transfer and recreated installed directories from backup', async () => {
    const { fs, files, root, backupExcludedDirectories } = createMemFs();
    const bytes = new Uint8Array([1]);
    const manifest = { packId: 'backup-check', kind: 'tts_sherpa', model: 'kokoro', version: 'v1',
      files: [{ path: 'model.bin', url: 'https://example.com/model.bin', sizeBytes: 1,
        sha256: '4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a' }] };
    const excludedAtDownload: boolean[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).includes('manifest.json')) return Response.json(manifest);
      excludedAtDownload.push(backupExcludedDirectories.has(`${root}/.backup-check.scratch`)
        && backupExcludedDirectories.has(`${root}/.backup-check.downloads`));
      return new Response(bytes);
    };
    const overrides = { fs, fetch: fetchImpl, download: createMemNativeDownload(fs, fetchImpl),
      invalidatePackRuntime: async () => {}, excludeFromBackup: async (uri: string) => { backupExcludedDirectories.add(uri); } };
    const request = { packId: manifest.packId, mode: 'download_if_missing' as const,
      manifestUrl: 'https://example.com/manifest.json', timeoutMs: null, signal: new AbortController().signal };
    await ensureModelPackInstalled(request, overrides);
    expect(backupExcludedDirectories.has(`${root}/backup-check`)).toBe(true);
    // An upgrade can first encounter a pack installed before backup exclusion existed.
    backupExcludedDirectories.delete(`${root}/backup-check`);
    await ensureModelPackInstalled({ ...request, mode: 'require_installed' }, overrides);
    expect(backupExcludedDirectories.has(`${root}/backup-check`)).toBe(true);
    await removeModelPack({ packId: manifest.packId }, overrides);
    expect(backupExcludedDirectories.has(`${root}/backup-check`)).toBe(false);
    await ensureModelPackInstalled(request, overrides);
    expect(files.get(`${root}/backup-check/model.bin`)).toEqual(bytes);
    expect(backupExcludedDirectories.has(`${root}/backup-check`)).toBe(true);
    expect(excludedAtDownload).toEqual([true, true]);
  });

  it.each(['installed', 'download'] as const)('rejects a %s pack published for a different speech role', async (source) => {
    const { fs, files, root } = createMemFs();
    const bytes = new Uint8Array([1]);
    const manifest = { packId: 'role-check', kind: 'tts_sherpa', model: 'kokoro', version: 'v1',
      files: [{ path: 'model.onnx', url: 'https://example.com/model.onnx', sizeBytes: bytes.length,
        sha256: '4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a' }] };
    if (source === 'installed') {
      files.set(`${root}/role-check/pack.json`, new TextEncoder().encode(JSON.stringify({ manifest })));
      files.set(`${root}/role-check/model.onnx`, bytes);
    }
    const request = { packId: manifest.packId, mode: 'download_if_missing' as const,
      kind: 'stt_sherpa' as const, manifestUrl: 'https://example.com/manifest.json', timeoutMs: null,
      signal: new AbortController().signal };
    const fetchImpl: typeof fetch = async (input) => String(input).includes('manifest.json')
      ? Response.json(manifest) : new Response(bytes);
    await expect(ensureModelPackInstalled(request, {
      fs, fetch: fetchImpl, download: createMemNativeDownload(fs, fetchImpl), invalidatePackRuntime: async () => {},
    })).rejects.toThrow('model_pack_manifest_kind_mismatch');
  });

  it.each(['voices', 'defaultVoiceId', 'frontend'] as const)('updates runtime metadata (%s) even when model files are unchanged', async (field) => {
    const { fs, files } = createMemFs();
    const bytes = new Uint8Array([1]);
    const manifest = { packId: 'metadata-update', kind: 'tts_sherpa', model: 'kokoro', version: 'v1',
      voices: [{ id: 'voice-a', title: 'A', sid: 0 }, { id: 'voice-b', title: 'B', sid: 1 }],
      defaultVoiceId: 'voice-a', frontend: { lang: 'en-us' },
      files: [{ path: 'model.onnx', url: 'https://example.com/model.onnx', sizeBytes: bytes.length,
        sha256: '4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a' }] };
    const metaUri = 'file:///docs/happier/voice/modelPacks/metadata-update/pack.json';
    files.set(metaUri, new TextEncoder().encode(JSON.stringify({ manifest })));
    files.set('file:///docs/happier/voice/modelPacks/metadata-update/model.onnx', bytes);
    const changes = { voices: [{ id: 'voice-a', title: 'A corrected', sid: 1 }, { id: 'voice-b', title: 'B', sid: 0 }],
      defaultVoiceId: 'voice-b', frontend: { lang: 'fr-fr' } };
    const updated = { ...manifest, [field]: changes[field] };
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : 'url' in input ? input.url : input.toString();
      return url.includes('manifest.json') ? Response.json(updated) : new Response(bytes);
    };
    const overrides = { fs, fetch: fetchImpl, download: createMemNativeDownload(fs, fetchImpl),
      invalidatePackRuntime: async () => {} };
    const request = { packId: manifest.packId, manifestUrl: 'https://example.com/manifest.json',
      timeoutMs: null, signal: new AbortController().signal };

    expect(await checkModelPackUpdateAvailable(request, overrides)).toMatchObject({ updateAvailable: true });
    const installed = await ensureModelPackInstalled({ ...request, mode: 'download_if_missing',
      updatePolicy: 'manual_update_if_available' }, overrides);
    expect(installed.manifest).toEqual(updated);
    expect(JSON.parse(new TextDecoder().decode(files.get(metaUri)))).toMatchObject({ manifest: updated });
    expect(await checkModelPackUpdateAvailable(request, overrides)).toMatchObject({ updateAvailable: false });
  });

  it.each(['corrupt', 'unreadable'] as const)('distinguishes %s receipts without exposing their contents', async (failure) => {
    const { fs, files, root } = createMemFs();
    const packId = 'receipt-warning';
    const privateContents = 'private_receipt_contents';
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const BaseFile = fs.File;
    class ReceiptFile extends BaseFile {
      constructor(...args: unknown[]) {
        super(...args);
        const readText = this.text.bind(this);
        this.text = async () => {
          if (failure === 'unreadable' && this.uri.endsWith('/pack.json')) throw new Error(privateContents);
          return readText();
        };
      }
    }
    const boundary = { ...fs, File: ReceiptFile };
    try {
      const normalFile = new ReceiptFile(root, packId, 'normal-read.txt');
      normalFile.write(privateContents);
      await expect(normalFile.text()).resolves.toBe(privateContents);
      expect((await getModelPackInstallSummary({ packId }, { fs: boundary })).installed).toBe(false);
      expect(warning).not.toHaveBeenCalled();
      files.set(`${root}/${packId}/pack.json`, new TextEncoder().encode(privateContents));
      if (failure === 'unreadable') {
        await expect(getModelPackInstallSummary({ packId }, { fs: boundary })).rejects.toThrow(privateContents);
        await expect(checkModelPackUpdateAvailable({ packId, manifestUrl: null, timeoutMs: null,
          signal: new AbortController().signal }, { fs: boundary })).rejects.toThrow(privateContents);
        expect(warning).not.toHaveBeenCalled();
        return;
      }
      expect((await getModelPackInstallSummary({ packId }, { fs: boundary })).installed).toBe(false);
      expect(warning).toHaveBeenCalled();
      expect(warning.mock.calls.flat()).toContain('SyntaxError');
      expect(warning.mock.calls.flat().map(String).join('\n')).not.toContain(privateContents);
      warning.mockClear();
      const update = await checkModelPackUpdateAvailable({ packId, manifestUrl: null, timeoutMs: null,
        signal: new AbortController().signal }, { fs: boundary, invalidatePackRuntime: async () => {} });
      expect(update.installed).toBe(false);
      expect(warning).toHaveBeenCalled();
      expect(warning.mock.calls.flat()).toContain('SyntaxError');
      expect(warning.mock.calls.flat().map(String).join('\n')).not.toContain(privateContents);
    } finally { warning.mockRestore(); }
  });

  it('keeps artifact transfer native with foreground lifetime and numeric progress', async () => {
    const { createHash } = await import('node:crypto');
    const { fs, files } = createMemFs();
    const bytes = new Uint8Array([1, 2, 3]);
    const manifest = { packId: 'native-download', kind: 'tts_sherpa', model: 'kokoro', version: 'v1',
      files: [{ path: 'model.onnx', url: 'https://example.com/model.onnx', sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') }] };
    const progress: number[] = [];
    nativeDownload.mockImplementation((_url, uri, options, onProgress) => {
      expect(options?.sessionType).toBe(1);
      return {
        async downloadAsync() {
          files.set(uri, bytes);
          onProgress?.({ totalBytesWritten: bytes.length, totalBytesExpectedToWrite: bytes.length });
          return { uri, status: 200, headers: {}, mimeType: null };
        },
        async pauseAsync() { return { url: manifest.files[0]!.url, fileUri: uri, options: options ?? {} }; },
        async cancelAsync() {},
      };
    });
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      if (!String(input).includes('manifest.json')) throw new Error('artifact_fetch_crossed_js_boundary');
      return Response.json(manifest);
    });
    try {
      await ensureModelPackInstalled({ packId: manifest.packId, mode: 'download_if_missing',
        manifestUrl: 'https://example.com/manifest.json', timeoutMs: null,
        signal: new AbortController().signal, onProgress: (value) => progress.push(value.loaded) },
        { fs, invalidatePackRuntime: async () => {} });
      expect(files.get('file:///docs/happier/voice/modelPacks/native-download/model.onnx')).toEqual(bytes);
      expect([...files.keys()].some(path => path.includes('/.native-download.downloads/'))).toBe(false);
      expect(progress.every((loaded, index) => loaded <= bytes.length && loaded >= (progress[index - 1] ?? 0))).toBe(true);
    } finally {
      vi.unstubAllGlobals(); nativeDownload.mockReset();
    }
  });

  it('awaits native transfer termination after cancellation before deleting its temporary file', async () => {
    const { createHash } = await import('node:crypto');
    const { fs, files } = createMemFs();
    const bytes = new Uint8Array([1]);
    const manifest = { packId: 'cancel-native', kind: 'tts_sherpa', model: 'kokoro', version: 'v1',
      files: [{ path: 'model.onnx', url: 'https://example.com/model.onnx', sizeBytes: 1,
        sha256: createHash('sha256').update(bytes).digest('hex') }] };
    let finish!: () => void;
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const terminal = new Promise<void>((resolve) => { finish = resolve; });
    let targetUri = '';
    nativeDownload.mockImplementation((url, uri, options) => {
      targetUri = uri;
      return {
        async downloadAsync() { files.set(uri, bytes); started(); await terminal; return undefined; },
        async pauseAsync() { return { url, fileUri: uri, options: options ?? {} }; },
        async cancelAsync() {},
      };
    });
    const controller = new AbortController();
    const install = ensureModelPackInstalled({ packId: manifest.packId, mode: 'download_if_missing',
      manifestUrl: 'https://example.com/manifest.json', timeoutMs: 1,
      signal: controller.signal }, { fs, fetch: async (input) => {
        if (!String(input).includes('manifest.json')) throw new Error('artifact_fetch_crossed_js_boundary');
        return Response.json(manifest);
      }, invalidatePackRuntime: async () => {} });
    let settled = false;
    const outcome = install.then(() => { settled = true; return null; }, (error: unknown) => { settled = true; return error; });
    // Also allow the pre-fix implementation to settle, so RED does not hang on absent native wiring.
    await Promise.race([running, outcome]);
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const settledBeforeTerminal = settled;
    const retainedBeforeTerminal = files.has(targetUri);
    finish();
    try {
      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('aborted');
      expect(settledBeforeTerminal).toBe(false);
      expect(retainedBeforeTerminal).toBe(true);
      expect(files.has(targetUri)).toBe(false);
    } finally { nativeDownload.mockReset(); }
  });

  it.each(['setup', 'http'] as const)('preserves native %s failure when task cleanup also fails', async (failure) => {
    const { createHash } = await import('node:crypto');
    const { fs } = createMemFs();
    const bytes = new Uint8Array([1]);
    const manifest = { packId: 'setup-failure', kind: 'tts_sherpa', model: 'kokoro', version: 'v1',
      files: [{ path: 'model.onnx', url: 'https://example.com/model.onnx', sizeBytes: 1,
        sha256: createHash('sha256').update(bytes).digest('hex') }] };
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    nativeDownload.mockImplementation(() => ({
      async downloadAsync() {
        if (failure === 'setup') throw new Error('native_setup_failed');
        return { uri: 'file:///unused', status: 503, headers: {}, mimeType: null };
      },
      async pauseAsync() { throw new Error('native_task_unregistered'); },
      async cancelAsync() {},
    }));
    try {
      await expect(ensureModelPackInstalled({ packId: manifest.packId, mode: 'download_if_missing',
        manifestUrl: 'https://example.com/manifest.json', timeoutMs: null,
        signal: new AbortController().signal }, { fs, fetch: async (input) => {
          if (!String(input).includes('manifest.json')) throw new Error('artifact_fetch_crossed_js_boundary');
          return Response.json(manifest);
        }, invalidatePackRuntime: async () => {} })).rejects.toThrow(failure === 'setup' ? 'native_setup_failed' : 'model_pack_download_failed:503');
      expect(warning).toHaveBeenCalledWith('model_pack_native_download_cleanup_failed', expect.any(Error));
    } finally { warning.mockRestore(); nativeDownload.mockReset(); }
  });

  it('allows an explicitly unbounded model-pack download to finish after a slow manifest read', async () => {
    vi.useFakeTimers();
    try {
      const { createHash } = await import('node:crypto');
      const bytes = new Uint8Array([1]);
      const { fs } = createMemFs();
      let finishManifest: ((response: Response) => void) | undefined;
      const manifest = { packId: 'slow-download', kind: 'tts_sherpa', model: 'kokoro', version: 'v1',
        files: [{ path: 'model.onnx', url: 'https://example.com/model.onnx', sizeBytes: 1,
          sha256: createHash('sha256').update(bytes).digest('hex') }] };
      const fetchImpl: typeof fetch = async (input) => String(input).includes('manifest.json')
        ? await new Promise<Response>((resolve) => { finishManifest = resolve; })
        : new Response(bytes, { status: 200, headers: { 'content-length': '1' } });
      const install = ensureModelPackInstalled({ packId: 'slow-download', mode: 'download_if_missing',
        manifestUrl: 'https://example.com/manifest.json',
        timeoutMs: null,
        signal: new AbortController().signal }, { download: createMemNativeDownload(fs, fetchImpl), fs, fetch: fetchImpl, invalidatePackRuntime: async () => {} });
      const outcome = install.then(() => 'installed', (error: unknown) => error instanceof Error ? error.message : String(error));
      await vi.advanceTimersByTimeAsync(300_000);
      finishManifest?.(Response.json(manifest));
      await vi.runAllTimersAsync();
      expect(await outcome).toBe('installed');
      expect(await getModelPackInstallSummary({ packId: 'slow-download' }, { fs })).toMatchObject({ installed: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects pack ids that attempt to escape the model packs root directory', async () => {
    const { fs } = createMemFs();

    await expect(
      ensureModelPackInstalled(
        {
          packId: '../escape',
          mode: 'download_if_missing',
          manifestUrl: 'https://example.com/manifest.json',
          timeoutMs: 5000,
          signal: new AbortController().signal,
        },
        { download: createMemNativeDownload(fs, (async () => ({ ok: false })) as any),
          fs: fs,
          fetch: (async () => ({ ok: false })) as any,
        },
      ),
    ).rejects.toThrow(/model_pack_invalid_pack_id/);
  });

  it('reports progress without exceeding total (streaming body)', async () => {
    const { createHash } = await import('node:crypto');
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];
    const expectedSha = createHash('sha256').update(Buffer.concat(chunks.map((c) => Buffer.from(c)))).digest('hex');

    const { fs } = createMemFs();
    const progressCalls: Array<{ loaded: number; total: number }> = [];

    const fetchImpl = async (url: string) => {
      if (url.includes('manifest.json')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            packId: 'example',
            kind: 'tts_sherpa',
            model: 'kokoro',
            version: 'v1',
            files: [
              {
                path: 'model.onnx',
                url: 'https://example.com/model.onnx',
                sha256: expectedSha,
                sizeBytes: 4,
              },
            ],
          }),
        } as any;
      }
      return {
        ok: true,
        status: 200,
        headers: { get: (k: string) => (k.toLowerCase() === 'content-length' ? '4' : null) },
        body: {
          getReader() {
            let i = 0;
            return {
              async read() {
                if (i >= chunks.length) return { done: true, value: undefined };
                const value = chunks[i++]!;
                return { done: false, value };
              },
            };
          },
        },
      } as any;
    };

    await ensureModelPackInstalled(
      {
        packId: 'example',
        mode: 'download_if_missing',
        manifestUrl: 'https://example.com/manifest.json',
        timeoutMs: 5000,
        signal: new AbortController().signal,
        onProgress: (p) => progressCalls.push({ loaded: p.loaded, total: p.total }),
      },
      { download: createMemNativeDownload(fs as any, fetchImpl as any),
        fs: fs as any,
        fetch: fetchImpl as any,
      },
    );

    expect(progressCalls.length).toBeGreaterThan(1);
    const last = progressCalls[progressCalls.length - 1]!;
    expect(last.total).toBe(4);
    expect(last.loaded).toBe(4);
    for (const call of progressCalls) {
      expect(call.loaded).toBeLessThanOrEqual(call.total);
    }
  });

  it('fetches each manifest file from its as-authored URL (no host-specific rewrite)', async () => {
    const { createHash } = await import('node:crypto');
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const expectedSha = createHash('sha256').update(Buffer.from(bytes)).digest('hex');

    const { fs } = createMemFs();

    const manifestUrl = 'https://github.com/happier-dev/happier-assets/releases/download/model-packs/example__manifest.json';
    // The file URL the manifest declares is trusted verbatim — the installer
    // does not rewrite it to match the manifest origin.
    const fileUrl = 'https://cdn.example.com/packs/example/model.onnx?v=1';
    const requestedFileUrls: string[] = [];

    const fetchImpl = async (url: string) => {
      if (url.includes('__manifest.json')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            packId: 'example',
            kind: 'tts_sherpa',
            model: 'kokoro',
            version: 'v1',
            files: [
              {
                path: 'model.onnx',
                url: fileUrl,
                sha256: expectedSha,
                sizeBytes: bytes.length,
              },
            ],
          }),
        } as any;
      }

      requestedFileUrls.push(url);
      return {
        ok: true,
        status: 200,
        headers: { get: (k: string) => (k.toLowerCase() === 'content-length' ? String(bytes.length) : null) },
        body: {
          getReader() {
            let done = false;
            return {
              async read() {
                if (done) return { done: true, value: undefined };
                done = true;
                return { done: false, value: bytes };
              },
            };
          },
        },
      } as any;
    };

    await ensureModelPackInstalled(
      {
        packId: 'example',
        mode: 'download_if_missing',
        manifestUrl,
        timeoutMs: 5000,
        signal: new AbortController().signal,
      },
      { download: createMemNativeDownload(fs as any, fetchImpl as any),
        fs: fs as any,
        fetch: fetchImpl as any,
      },
    );

    expect(requestedFileUrls).toEqual([fileUrl]);
  });

  it('rejects pack manifests that contain unsafe paths', async () => {
    const { fs } = createMemFs();

    const fetchImpl = async (_url: string) => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          packId: 'example',
          kind: 'tts_sherpa',
          model: 'kokoro',
          version: 'v1',
          files: [
            {
              path: '../escape.txt',
              url: 'https://example.com/escape.txt',
              sha256: 'a'.repeat(64),
              sizeBytes: 1,
            },
          ],
        }),
      } as any;
    };

    await expect(
      ensureModelPackInstalled(
        {
          packId: 'example',
          mode: 'download_if_missing',
          manifestUrl: 'https://example.com/manifest.json',
          timeoutMs: 5000,
          signal: new AbortController().signal,
        },
        { download: createMemNativeDownload(fs, fetchImpl as any),
          fs: fs,
          fetch: fetchImpl as any,
        },
      ),
    ).rejects.toThrow(/model_pack_invalid_path/);
  });

  it('refreshes an installed pack when manual_update_if_available is requested and the remote manifest differs', async () => {
    const { fs, files } = createMemFs();
    const sha256Byte1 = '4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a';
    const metaUri = 'file:///docs/happier/voice/modelPacks/example/pack.json';

    // Seed an installed pack.json with manifest A.
    files.set(
      metaUri,
      new TextEncoder().encode(
        JSON.stringify({
          manifest: {
            packId: 'example',
            kind: 'tts_sherpa',
            model: 'kokoro',
            version: 'v1',
            files: [
              {
                path: 'model.onnx',
                url: 'https://example.com/model.onnx',
                sha256: 'a'.repeat(64),
                sizeBytes: 1,
              },
            ],
          },
        }),
      ),
    );

    const fetchImpl = async (url: string) => {
      // Remote manifest B with a different sha256 forces refresh.
      if (url.includes('manifest.json')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            packId: 'example',
            kind: 'tts_sherpa',
            model: 'kokoro',
            version: 'v2',
            files: [
              {
                path: 'model.onnx',
                url: 'https://example.com/model.onnx?rev=2',
                sha256: sha256Byte1,
                sizeBytes: 1,
              },
            ],
          }),
        } as any;
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => '1' },
        arrayBuffer: async () => new Uint8Array([1]).buffer,
      } as any;
    };

    await ensureModelPackInstalled(
      {
        packId: 'example',
        mode: 'download_if_missing',
        updatePolicy: 'manual_update_if_available',
        manifestUrl: 'https://example.com/manifest.json',
        timeoutMs: 5000,
        signal: new AbortController().signal,
      },
      { download: createMemNativeDownload(fs as any, fetchImpl as any),
        fs: fs as any,
        fetch: fetchImpl as any,
      },
    );

    // pack.json should now contain version v2.
    const finalMeta = files.get(metaUri);
    expect(finalMeta).toBeDefined();
    const parsed = JSON.parse(new TextDecoder().decode(finalMeta!));
    expect(parsed?.manifest?.version).toBe('v2');
  });

  it('throws when packs are required but not installed', async () => {
    await expect(
      ensureModelPackInstalled(
        {
          packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
          mode: 'require_installed',
          manifestUrl: null,
          timeoutMs: 5000,
          signal: new AbortController().signal,
        },
        { fs: createMemFs().fs },
      ),
    ).rejects.toThrow(/model_pack_not_installed/);
  });

  it('throws when download is requested but manifestUrl is missing', async () => {
    await expect(
      ensureModelPackInstalled(
        {
          packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
          mode: 'download_if_missing',
          manifestUrl: null,
          timeoutMs: 5000,
          signal: new AbortController().signal,
        },
        { fs: createMemFs().fs },
      ),
    ).rejects.toThrow(/model_pack_manifest_url_missing/);
  });

  it('reports not installed when pack.json is missing', async () => {
    const summary = await getModelPackInstallSummary(
      { packId: 'kokoro-82m-v1.0-onnx-q8-wasm' },
      { fs: createMemFs().fs },
    );

    expect(summary.installed).toBe(false);
    expect(summary.manifest).toBe(null);
  });

  it.each(['summary', 'ensure', 'update'] as const)('propagates a refused native manifest read through %s and distinguishes invalid or missing installs', async caller => {
    const { fs, files, root } = createMemFs();
    const packId = `read-${caller}`;
    const manifest = { packId, kind: 'tts_sherpa', model: 'kokoro', version: 'v1',
      files: [{ path: 'model.bin', url: 'https://example.test/model.bin', sizeBytes: 1, sha256: 'a'.repeat(64) }] };
    files.set(`${root}/${packId}/pack.json`, new TextEncoder().encode(JSON.stringify({ manifest })));
    files.set(`${root}/${packId}/model.bin`, new Uint8Array([1]));
    const read = () => caller === 'summary' ? getModelPackInstallSummary({ packId }, { fs })
      : caller === 'ensure' ? ensureModelPackInstalled({ packId, mode: 'require_installed', manifestUrl: null,
        timeoutMs: null, signal: new AbortController().signal }, { fs })
        : checkModelPackUpdateAvailable({ packId, manifestUrl: null, timeoutMs: null,
          signal: new AbortController().signal }, { fs });
    const refusal = new Error('native_storage_refused');
    const text = vi.spyOn(fs.File.prototype, 'text').mockRejectedValue(refusal);
    try { await expect(read()).rejects.toBe(refusal); }
    finally { text.mockRestore(); }
    await expect(read()).resolves.toMatchObject(caller === 'ensure' ? { manifest } : { installed: true });
    files.set(`${root}/${packId}/pack.json`, new TextEncoder().encode('{}'));
    if (caller === 'ensure') await expect(read()).rejects.toThrow('model_pack_not_installed');
    else await expect(read()).resolves.toMatchObject({ installed: false });
    files.clear();
    if (caller === 'ensure') await expect(read()).rejects.toThrow('model_pack_not_installed');
    else await expect(read()).resolves.toMatchObject({ installed: false });
  });

  it('removes without throwing when the directory is missing', async () => {
    await expect(
      removeModelPack({ packId: 'kokoro-82m-v1.0-onnx-q8-wasm' }, { fs: createMemFs().fs }),
    ).resolves.toBeUndefined();
  });
});
