import { createHash } from 'node:crypto';
import { getModelPackInstallSummary, removeModelPack } from '@/voice/modelPacks/installer.native';

import { describe, expect, it, vi } from 'vitest';

import type { ModelPackManifest } from '@happier-dev/protocol/voice/modelPacks/manifest';
import {
  deriveModelPackStagingPlan,
  installModelPackWithHost,
  MODEL_PACK_PROMOTION_INTENT_MAX_BYTES,
} from '@happier-dev/voice-modelpacks';

import { createExpoModelPackInstallerHost, reconcileExpoModelPackPromotion } from '@/voice/modelPacks/installer/host.native';
import { createMemFs, createMemNativeDownload } from '@/voice/modelPacks/installerTestFs';

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

const PACK_DIR = 'file:///docs/happier/voice/modelPacks/resume';

function makeManifest(bytes: Uint8Array): ModelPackManifest {
  return {
    packId: 'resume',
    kind: 'tts_sherpa',
    model: 'kokoro',
    version: 'v1',
    files: [{ path: 'model.bin', url: 'https://example.com/model.bin', sha256: sha256Hex(bytes), sizeBytes: bytes.length }],
  } as ModelPackManifest;
}

function seedResumePlan(files: Map<string, Uint8Array>, manifest: ModelPackManifest): void {
  files.set(
    'file:///docs/happier/voice/modelPacks/.resume.scratch/.resume-plan.json',
    new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, ...deriveModelPackStagingPlan(manifest) })),
  );
}

function streamResponse(bytes: Uint8Array, status: number): any {
  let idx = 0;
  return {
    ok: true,
    status,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-length' ? String(bytes.length) : null) },
    body: {
      getReader: () => ({
        read: async () => {
          if (idx === 0) {
            idx = 1;
            return { done: false, value: bytes };
          }
          return { done: true, value: undefined };
        },
      }),
    },
  };
}

describe('Expo native host — real Range resume (FIND-010)', () => {
  it('reports failed partial reads and rejects required reset failure while absent files stay quiet', async () => {
    const { fs, files } = createMemFs();
    const bytes = new Uint8Array([1]);
    const manifest = makeManifest(bytes);
    seedResumePlan(files, manifest);
    files.set('file:///docs/happier/voice/modelPacks/.resume.scratch/model.bin', bytes);
    files.set(`${PACK_DIR}/model.bin`, bytes);
    files.set(`${PACK_DIR}/pack.json`, new TextEncoder().encode(JSON.stringify({ manifest })));
    const readError = new Error('EIO_partial_read');
    const cleanupError = new Error('EACCES_partial_delete');
    const BaseFile = fs.File;
    class FaultyFile extends BaseFile {
      constructor(...args: unknown[]) {
        super(...args);
        Object.defineProperty(this, 'size', { get: () => Number.NaN });
      }
      override open(): ReturnType<InstanceType<typeof BaseFile>['open']> { throw readError; }
      override delete() { throw cleanupError; }
    }
    const host = createExpoModelPackInstallerHost({ fs: { ...fs, File: FaultyFile } });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const staging = await host.beginStaging('resume', deriveModelPackStagingPlan(manifest));
    try {
      expect(await staging.partialByteLength('absent.bin')).toBe(0);
      await staging.resetPartial('absent.bin');
      expect(warning.mock.calls.some(call => call[0] === 'model_pack_partial_read_failed')).toBe(false);
      expect(await staging.partialByteLength('model.bin')).toBe(0);
      await expect(staging.resetPartial('model.bin')).rejects.toBe(cleanupError);
      expect(files.get('file:///docs/happier/voice/modelPacks/.resume.scratch/model.bin')).toEqual(bytes);
      expect(files.get(`${PACK_DIR}/model.bin`)).toEqual(bytes);
      expect(warning.mock.calls.flat()).toContain(readError);
    } finally { await staging.cleanup(); warning.mockRestore(); }
  });

  it('retains its existing prefix and retries only the interrupted native tail', async () => {
    const { fs, files } = createMemFs();
    const full = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const prefix = full.slice(0, 3);
    const manifest = makeManifest(full);
    const scratchFile = 'file:///docs/happier/voice/modelPacks/.resume.scratch/model.bin';
    files.set(scratchFile, prefix);
    seedResumePlan(files, manifest);
    const controller = new AbortController();
    const host = createExpoModelPackInstallerHost({ fs, download: async (request) => {
      expect(request.rangeStart).toBe(prefix.length);
      files.set(request.fileUri, full.slice(prefix.length, prefix.length + 1));
      request.onProgress?.(1);
      controller.abort();
      throw new Error('aborted');
    } });
    await expect(installModelPackWithHost({ host, packId: 'resume', manifest, signal: controller.signal })).rejects.toThrow('aborted');
    expect(files.get(scratchFile)).toEqual(prefix);
    expect([...files.keys()].some(path => path.includes('/.resume.downloads/'))).toBe(false);
    const retryHost = createExpoModelPackInstallerHost({ fs, download: createMemNativeDownload(fs, async (_url, init) => {
      expect((init?.headers as Record<string, string>).Range).toBe('bytes=3-');
      return new Response(full.slice(prefix.length), { status: 206 });
    }) });
    await installModelPackWithHost({ host: retryHost, packId: 'resume', manifest, signal: new AbortController().signal });
    expect(files.get(`${PACK_DIR}/model.bin`)).toEqual(full);
  });

  it.each(['open failure', 'write failure'] as const)('closes native transfer handles and removes its tail on %s without replacing live bytes', async (outcome) => {
    const { fs, files } = createMemFs();
    const bytes = new Uint8Array([1, 2, 3]);
    const prior = new Uint8Array([9, 9]);
    files.set(`${PACK_DIR}/model.bin`, prior);
    const BaseFile = fs.File;
    let activeHandles = 0;
    class DiskFile extends BaseFile {
      open() {
        if (outcome === 'open failure' && this.uri.includes('/.resume.downloads/')) throw new Error('disk_open_failed');
        const handle = super.open();
        activeHandles += 1;
        return { readBytes: handle.readBytes, close: () => { activeHandles -= 1; handle.close(); } };
      }
      write(content: string | Uint8Array, options?: { append?: boolean }) {
        if (outcome === 'write failure' && typeof content !== 'string' && this.uri.endsWith('/.resume.scratch/model.bin')) {
          throw new Error('disk_write_failed');
        }
        super.write(content, options);
      }
    }
    fs.File = DiskFile;
    const host = createExpoModelPackInstallerHost({ fs,
      download: createMemNativeDownload(fs, async () => new Response(bytes)) });
    await expect(installModelPackWithHost({ host, packId: 'resume', manifest: makeManifest(bytes),
      signal: new AbortController().signal })).rejects.toThrow(outcome === 'open failure' ? 'disk_open_failed' : 'disk_write_failed');
    expect(activeHandles).toBe(0);
    expect([...files.keys()].some(path => path.includes('/.resume.downloads/'))).toBe(false);
    expect(files.get(`${PACK_DIR}/model.bin`)).toEqual(prior);
  });

  it.each(['success', 'cancel', 'read failure'] as const)('closes bounded native partial reads on %s and retains cancelled bytes for resume', async (outcome) => {
    const { fs, files } = createMemFs();
    const chunkBytes = 1024 * 1024;
    const prefix = new Uint8Array(chunkBytes + 1).fill(7);
    const full = new Uint8Array(prefix.length + (outcome === 'success' ? 0 : 1)).fill(7);
    const manifest = makeManifest(full);
    const scratchFile = 'file:///docs/happier/voice/modelPacks/.resume.scratch/model.bin';
    files.set(scratchFile, prefix);
    seedResumePlan(files, manifest);
    const BaseFile = fs.File;
    let activeHandles = 0;
    const readLengths: number[] = [];
    let failRead = outcome === 'read failure';
    class TracingFile extends BaseFile {
      open() {
        const handle = super.open();
        activeHandles += 1;
        let closed = false;
        return {
          readBytes: (length: number) => {
            readLengths.push(length);
            if (failRead) throw new Error('native_read_failed');
            return handle.readBytes(length);
          },
          close: () => {
            if (!closed) activeHandles -= 1;
            closed = true;
            handle.close();
          },
        };
      }
    }
    fs.File = TracingFile;
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      if (failRead) throw new Error('native_read_failed');
      return new Response(full);
    });
    const host = createExpoModelPackInstallerHost({ download: createMemNativeDownload(fs, fetchImpl), fs });
    const install = installModelPackWithHost({ host, packId: 'resume', manifest, signal: controller.signal,
      onProgress: () => { if (outcome === 'cancel') controller.abort(); } });
    if (outcome === 'success') {
      await install;
      expect(Buffer.from(files.get(`${PACK_DIR}/model.bin`)!).equals(Buffer.from(full))).toBe(true);
      expect(fetchImpl).not.toHaveBeenCalled();
    } else if (outcome === 'cancel') {
      await expect(install).rejects.toThrow('aborted');
      expect(Buffer.from(files.get(scratchFile)!).equals(Buffer.from(prefix))).toBe(true);
      expect(readLengths).toHaveLength(1);
      expect(fetchImpl).not.toHaveBeenCalled();
    } else {
      await expect(install).rejects.toThrow('native_read_failed');
    }
    expect(readLengths.length).toBeGreaterThan(0);
    expect(readLengths.every((length) => length <= chunkBytes)).toBe(true);
    expect(activeHandles).toBe(0);
    if (outcome === 'cancel') {
      failRead = false;
      fetchImpl.mockImplementation(async (_input, init) => {
        expect((init?.headers as Record<string, string>).Range).toBe(`bytes=${prefix.length}-`);
        return new Response(full.slice(prefix.length), { status: 206 });
      });
      await installModelPackWithHost({ host, packId: 'resume', manifest, signal: new AbortController().signal });
      expect(Buffer.from(files.get(`${PACK_DIR}/model.bin`)!).equals(Buffer.from(full))).toBe(true);
      expect(activeHandles).toBe(0);
    }
  });

  it('does not promote an unlisted file even when scratch has the current immutable plan', async () => {
    const { fs, files } = createMemFs();
    const current = new Uint8Array([1, 2, 3]);
    const manifest = makeManifest(current);
    files.set('file:///docs/happier/voice/modelPacks/.resume.scratch/removed.bin', new Uint8Array([9, 9]));
    files.set('file:///docs/happier/voice/modelPacks/.resume.scratch/model.bin', current);
    seedResumePlan(files, manifest);
    const host = createExpoModelPackInstallerHost({ download: createMemNativeDownload(fs, (async () => {
        throw new Error('current verified partial must not redownload');
      }) as any),
      fs,

    });

    await installModelPackWithHost({
      host,
      packId: 'resume',
      manifest,
      signal: new AbortController().signal,
    });

    expect(files.has(`${PACK_DIR}/model.bin`)).toBe(true);
    expect(files.has(`${PACK_DIR}/removed.bin`)).toBe(false);
  });

  it('verifies transferred bytes with the native incremental hasher when the binary provides one', async () => {
    const { installOptionalNativeModuleForTests } = await import('@/dev/expoModulesCoreStub');
    let nativeHashedBytes = 0;
    class Sha256 {
      private readonly hash = createHash('sha256');
      update(chunk: Uint8Array) { nativeHashedBytes += chunk.byteLength; this.hash.update(chunk); }
      digestHex() { return this.hash.digest('hex'); }
    }
    const restore = installOptionalNativeModuleForTests('HappierCryptoWorker', { Sha256 });
    try {
      const { fs, files } = createMemFs();
      const full = new Uint8Array(Array.from({ length: 10 }, (_, i) => i + 1));
      const host = createExpoModelPackInstallerHost({ download: createMemNativeDownload(fs, (async () => streamResponse(full, 200)) as typeof fetch), fs });
      await installModelPackWithHost({ host, packId: 'resume', manifest: makeManifest(full), signal: new AbortController().signal });

      expect(nativeHashedBytes).toBe(full.length);
      expect(Array.from(files.get(`${PACK_DIR}/model.bin`)!)).toEqual(Array.from(full));
    } finally {
      restore();
    }
  });

  it('rejects a transferred file whose native digest does not match the manifest', async () => {
    const { installOptionalNativeModuleForTests } = await import('@/dev/expoModulesCoreStub');
    class Sha256 {
      update() {}
      digestHex() { return '0'.repeat(64); }
    }
    const restore = installOptionalNativeModuleForTests('HappierCryptoWorker', { Sha256 });
    try {
      const { fs, files } = createMemFs();
      const full = new Uint8Array([1, 2, 3, 4]);
      const host = createExpoModelPackInstallerHost({ download: createMemNativeDownload(fs, (async () => streamResponse(full, 200)) as typeof fetch), fs });
      await expect(installModelPackWithHost({ host, packId: 'resume', manifest: makeManifest(full), signal: new AbortController().signal }))
        .rejects.toThrow('model_pack_sha256_mismatch');
      expect(files.has(`${PACK_DIR}/model.bin`)).toBe(false);
    } finally {
      restore();
    }
  });

  it('appends chunks incrementally rather than rewriting the whole staged file (LB-L1)', async () => {
    const { fs, files } = createMemFs();
    const chunkBytes = 1024 * 1024;
    const full = new Uint8Array(chunkBytes * 2 + 3).fill(7);

    // Spy on File.write to assert append-mode writes (no full-buffer rewrites).
    const writeCalls: Array<{ append: boolean; length: number }> = [];
    const OriginalFile = fs.File;
    const BaseFile = OriginalFile;
    class TracingFile extends BaseFile {
      write(data: string | Uint8Array, options?: { append?: boolean }) {
        if (typeof data !== 'string' && this.uri.endsWith('/.resume.scratch/model.bin')) {
          writeCalls.push({ append: Boolean(options?.append), length: data.byteLength });
        }
        return super.write(data, options);
      }
    }
    (fs as any).File = TracingFile;

    // Deliver the body in three separate chunks so multiple appends happen.
    const fetchImpl = vi.fn(async () => {
      const chunks = [full.slice(0, chunkBytes), full.slice(chunkBytes, chunkBytes * 2), full.slice(chunkBytes * 2)];
      let i = 0;
      return {
        ok: true,
        status: 200,
        headers: { get: (k: string) => (k.toLowerCase() === 'content-length' ? String(full.length) : null) },
        body: { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }) }) },
      } as any;
    });

    const host = createExpoModelPackInstallerHost({ download: createMemNativeDownload(fs, fetchImpl as any), fs });
    await installModelPackWithHost({ host, packId: 'resume', manifest: makeManifest(full), signal: new AbortController().signal });

    // Every binary write of a downloaded chunk must be an append, and each append
    // is bounded by the native read budget — never a growing full-file rewrite.
    const chunkAppends = writeCalls.filter((c) => c.append);
    expect(chunkAppends.length).toBeGreaterThanOrEqual(3);
    for (const call of chunkAppends) {
      expect(call.length).toBeLessThanOrEqual(chunkBytes);
    }
    expect(Buffer.from(files.get(`${PACK_DIR}/model.bin`)!).equals(Buffer.from(full))).toBe(true);
  });

  it('streams existing partial bytes without reading the whole partial through File.bytes', async () => {
    const { fs, files } = createMemFs();
    const full = new Uint8Array(Array.from({ length: 10 }, (_, i) => i + 1));
    const manifest = makeManifest(full);
    files.set('file:///docs/happier/voice/modelPacks/.resume.scratch/model.bin', full.slice(0, 4));
    seedResumePlan(files, manifest);

    const OriginalFile = fs.File;
    class TracingFile extends (OriginalFile as any) {
      get size() {
        return undefined;
      }
      async bytes() {
        if (this.uri.endsWith('/.resume.scratch/model.bin')) {
          throw new Error('partial_bytes_should_not_be_called');
        }
        return super.bytes();
      }
    }
    (fs as any).File = TracingFile;

    let observedRange: string | null = null;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      observedRange = (init?.headers as Record<string, string> | undefined)?.Range ?? null;
      const start = observedRange ? Number(observedRange.replace('bytes=', '').replace('-', '')) : 0;
      return streamResponse(full.slice(start), 206);
    });

    const host = createExpoModelPackInstallerHost({ download: createMemNativeDownload(fs, fetchImpl as any), fs });
    await installModelPackWithHost({ host, packId: 'resume', manifest, signal: new AbortController().signal });

    expect(observedRange).toBe('bytes=4-');
    expect(Array.from(files.get(`${PACK_DIR}/model.bin`)!)).toEqual(Array.from(full));
  });
});

describe('Expo native host per-pack install ownership', () => {
  it('rejects a concurrent same-pack owner before shared scratch can be rewritten', async () => {
    const { fs, files } = createMemFs();
    const firstBytes = new Uint8Array([1, 2, 3, 4]);
    const secondBytes = new Uint8Array([9, 8, 7, 6]);
    const firstManifest = makeManifest(firstBytes);
    const secondManifest = { ...makeManifest(secondBytes), version: 'v2' } as ModelPackManifest;
    let releaseFirst!: () => void;
    const firstPaused = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstProgress!: () => void;
    const firstWroteScratch = new Promise<void>((resolve) => { firstProgress = resolve; });
    let firstRead = 0;
    const firstHost = createExpoModelPackInstallerHost({ download: createMemNativeDownload(fs, (async () => ({
        ...streamResponse(firstBytes, 200),
        body: {
          getReader: () => ({
            read: async () => {
              firstRead += 1;
              if (firstRead === 1) return { done: false, value: firstBytes.slice(0, 2) };
              if (firstRead === 2) {
                await firstPaused;
                return { done: false, value: firstBytes.slice(2) };
              }
              return { done: true, value: undefined };
            },
          }),
        },
      })) as typeof fetch),
      fs,

    });
    const secondHost = createExpoModelPackInstallerHost({ download: createMemNativeDownload(fs, (async () => streamResponse(secondBytes, 200)) as typeof fetch),
      fs,

    });

    const firstInstall = installModelPackWithHost({
      host: firstHost,
      packId: 'resume',
      manifest: firstManifest,
      signal: new AbortController().signal,
      onProgress: ({ loaded }) => { if (loaded === 2) firstProgress(); },
    });
    await firstWroteScratch;
    let secondError: unknown;
    try {
      await installModelPackWithHost({
        host: secondHost,
        packId: 'resume',
        manifest: secondManifest,
        signal: new AbortController().signal,
      });
    } catch (error) {
      secondError = error;
    } finally {
      releaseFirst();
    }

    await expect(firstInstall).resolves.toMatchObject({ packId: 'resume' });
    expect(secondError).toMatchObject({ message: 'model_pack_install_already_in_progress' });
    const installedBytes = files.get(`${PACK_DIR}/model.bin`)!;
    expect(sha256Hex(installedBytes)).toBe(sha256Hex(firstBytes));
  });

  it('allows different packs to download concurrently under independent owners', async () => {
    const { fs, files } = createMemFs();
    const bytesByPack = {
      alpha: new Uint8Array([1, 3, 5, 7]),
      beta: new Uint8Array([2, 4, 6, 8]),
    } as const;
    let readersReady = 0;
    let releaseReaders!: () => void;
    const bothReadersReady = new Promise<void>((resolve) => { releaseReaders = resolve; });
    const install = (packId: keyof typeof bytesByPack) => {
      const bytes = bytesByPack[packId];
      let delivered = false;
      const host = createExpoModelPackInstallerHost({ download: createMemNativeDownload(fs, (async () => ({
          ...streamResponse(bytes, 200),
          body: {
            getReader: () => ({
              read: async () => {
                if (delivered) return { done: true, value: undefined };
                delivered = true;
                readersReady += 1;
                if (readersReady === 2) releaseReaders();
                await bothReadersReady;
                return { done: false, value: bytes };
              },
            }),
          },
        })) as typeof fetch),
        fs,

      });
      const manifest = { ...makeManifest(bytes), packId } as ModelPackManifest;
      return installModelPackWithHost({
        host,
        packId,
        manifest,
        signal: new AbortController().signal,
      });
    };

    await expect(Promise.all([install('alpha'), install('beta')])).resolves.toHaveLength(2);
    for (const [packId, bytes] of Object.entries(bytesByPack)) {
      const installedBytes = files.get(`file:///docs/happier/voice/modelPacks/${packId}/model.bin`)!;
      expect(sha256Hex(installedBytes)).toBe(sha256Hex(bytes));
    }
  });
});

describe('reconcileExpoModelPackPromotion — crash-window recovery (X-M1)', () => {
  it('rejects an oversized marker from its exposed size without reading its text', async () => {
    const { fs, files } = createMemFs();
    const packId = 'oversized';
    const intentUri = `file:///docs/happier/voice/modelPacks/.${packId}.promote-intent`;
    expect(MODEL_PACK_PROMOTION_INTENT_MAX_BYTES).toBe(64 * 1024);
    files.set(intentUri, new Uint8Array(MODEL_PACK_PROMOTION_INTENT_MAX_BYTES + 1));
    const OriginalFile = fs.File;
    let markerTextRead = false;
    class NoOversizedMarkerReadFile extends (OriginalFile as any) {
      async text() {
        if (this.uri === intentUri) markerTextRead = true;
        return super.text();
      }
    }
    (fs as any).File = NoOversizedMarkerReadFile;

    await expect(reconcileExpoModelPackPromotion({ fs, packId }))
      .rejects.toThrow('model_pack_promotion_intent_invalid');
    expect(markerTextRead).toBe(false);
    expect(files.has(intentUri)).toBe(true);
  });

  it('preserves a prior verified upgrade when swap_prepared crashed before the first rename', async () => {
    const { fs, files } = createMemFs();
    const packId = 'upgrade-before-rename';
    const liveManifest = `file:///docs/happier/voice/modelPacks/${packId}/pack.json`;
    const intentUri = `file:///docs/happier/voice/modelPacks/.${packId}.promote-intent`;
    files.set(liveManifest, new TextEncoder().encode(JSON.stringify({ version: 'v1' })));
    files.set(intentUri, new TextEncoder().encode(JSON.stringify({
      schemaVersion: 1,
      packId,
      phase: 'swap_prepared',
      startedAtMs: 1,
      token: 'upgrade-before-rename',
      priorInstall: { scopeKey: 'device', identityKey: packId },
      recovery: null,
    })));

    await reconcileExpoModelPackPromotion({ fs, packId });
    expect(JSON.parse(new TextDecoder().decode(files.get(liveManifest)!)).version).toBe('v1');
    expect(files.has(intentUri)).toBe(false);
  });

  it('fails closed when rollback expects a prior verified install but neither live nor backup exists', async () => {
    const { fs, files } = createMemFs();
    const packId = 'upgrade-prior-missing';
    const intentUri = `file:///docs/happier/voice/modelPacks/.${packId}.promote-intent`;
    files.set(intentUri, new TextEncoder().encode(JSON.stringify({
      schemaVersion: 1,
      packId,
      phase: 'swap_prepared',
      startedAtMs: 1,
      token: 'upgrade-prior-missing',
      priorInstall: { scopeKey: 'device', identityKey: packId },
      recovery: null,
    })));

    await expect(Promise.resolve(reconcileExpoModelPackPromotion({ fs, packId })))
      .rejects.toThrow('model_pack_promotion_prior_missing');
    expect(files.has(intentUri)).toBe(true);
  });

  it('does not restore a displaced unverified tree when the marker records no verified prior', async () => {
    const { fs, files } = createMemFs();
    const packId = 'first-with-unverified-displacement';
    const liveManifest = `file:///docs/happier/voice/modelPacks/${packId}/pack.json`;
    const backupManifest = `file:///docs/happier/voice/modelPacks/.${packId}.backup/pack.json`;
    const intentUri = `file:///docs/happier/voice/modelPacks/.${packId}.promote-intent`;
    files.set(liveManifest, new TextEncoder().encode(JSON.stringify({ version: 'candidate' })));
    files.set(backupManifest, new TextEncoder().encode(JSON.stringify({ version: 'unverified' })));
    files.set(intentUri, new TextEncoder().encode(JSON.stringify({
      schemaVersion: 1,
      packId,
      phase: 'swap_prepared',
      startedAtMs: 1,
      token: 'first-with-unverified-displacement',
      priorInstall: null,
      recovery: null,
    })));

    await reconcileExpoModelPackPromotion({ fs, packId });
    expect(files.has(liveManifest)).toBe(false);
    expect(files.has(backupManifest)).toBe(false);
    expect(files.has(intentUri)).toBe(false);
  });

  it('fails callers closed and retains the marker when prior-byte restoration fails', async () => {
    const { fs, files } = createMemFs();
    const packId = 'restore-retry';
    const backupRoot = `file:///docs/happier/voice/modelPacks/.${packId}.backup`;
    const liveRoot = `file:///docs/happier/voice/modelPacks/${packId}`;
    const intentUri = `file:///docs/happier/voice/modelPacks/.${packId}.promote-intent`;
    files.set(`${backupRoot}/pack.json`, new TextEncoder().encode(JSON.stringify({ version: 'v1' })));
    files.set(intentUri, new TextEncoder().encode(JSON.stringify({
      schemaVersion: 1,
      packId,
      phase: 'swap_prepared',
      startedAtMs: 1,
      token: 'restore-retry',
      priorInstall: { scopeKey: 'device', identityKey: packId },
      recovery: null,
    })));
    const OriginalDirectory = fs.Directory;
    class FailingRestoreDirectory extends (OriginalDirectory as any) {
      move(destination: { uri: string }) {
        if (this.uri === backupRoot && destination.uri === liveRoot) throw new Error('restore_failed');
        return super.move(destination);
      }
    }
    (fs as any).Directory = FailingRestoreDirectory;

    await expect(reconcileExpoModelPackPromotion({ fs, packId }))
      .rejects.toThrow('model_pack_promotion_rollback_failed');
    expect(files.has(intentUri)).toBe(true);
    expect(files.has(`${backupRoot}/pack.json`)).toBe(true);
  });

  it('retains malformed and metadata_committed markers without collapsing them as rollback', async () => {
    const malformed = createMemFs();
    const malformedUri = 'file:///docs/happier/voice/modelPacks/.malformed.promote-intent';
    malformed.files.set(malformedUri, new TextEncoder().encode('{truncated'));
    await expect(Promise.resolve(reconcileExpoModelPackPromotion({ fs: malformed.fs, packId: 'malformed' })))
      .rejects.toThrow('model_pack_promotion_intent_invalid');
    expect(malformed.files.has(malformedUri)).toBe(true);

    const committed = createMemFs();
    const committedUri = 'file:///docs/happier/voice/modelPacks/.committed.promote-intent';
    committed.files.set(committedUri, new TextEncoder().encode(JSON.stringify({
      schemaVersion: 1,
      packId: 'committed',
      phase: 'metadata_committed',
      startedAtMs: 1,
      token: 'committed',
      priorInstall: null,
      recovery: { kind: 'test', value: {} },
    })));
    await expect(Promise.resolve(reconcileExpoModelPackPromotion({ fs: committed.fs, packId: 'committed' })))
      .rejects.toThrow('model_pack_promotion_outcome_required');
    expect(committed.files.has(committedUri)).toBe(true);
  });
  it('restores the backup to live when live is missing + backup + intent marker present', async () => {
    const { fs, files } = createMemFs();
    const backupRoot = 'file:///docs/happier/voice/modelPacks/.crash.backup';
    files.set(`${backupRoot}/pack.json`, new TextEncoder().encode(JSON.stringify({ version: 'v1' })));
    files.set('file:///docs/happier/voice/modelPacks/.crash.promote-intent', new TextEncoder().encode('{}'));

    const restored = await reconcileExpoModelPackPromotion({ fs, packId: 'crash' });
    expect(restored).toBe(true);

    const liveManifest = files.get('file:///docs/happier/voice/modelPacks/crash/pack.json');
    expect(liveManifest).toBeDefined();
    expect(JSON.parse(new TextDecoder().decode(liveManifest!)).version).toBe('v1');
    expect(files.has('file:///docs/happier/voice/modelPacks/.crash.promote-intent')).toBe(false);
    expect(files.has(`${backupRoot}/pack.json`)).toBe(false);
  });

  it('restores backup when live and intent exist because durable commit had not completed', async () => {
    const { fs, files } = createMemFs();
    files.set('file:///docs/happier/voice/modelPacks/done/pack.json', new TextEncoder().encode(JSON.stringify({ version: 'v2' })));
    files.set('file:///docs/happier/voice/modelPacks/.done.backup/pack.json', new TextEncoder().encode(JSON.stringify({ version: 'v1' })));
    files.set('file:///docs/happier/voice/modelPacks/.done.promote-intent', new TextEncoder().encode('{}'));

    const restored = await reconcileExpoModelPackPromotion({ fs, packId: 'done' });
    expect(restored).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(
      files.get('file:///docs/happier/voice/modelPacks/done/pack.json')!,
    )).version).toBe('v1');
    expect(files.has('file:///docs/happier/voice/modelPacks/.done.backup/pack.json')).toBe(false);
    expect(files.has('file:///docs/happier/voice/modelPacks/.done.promote-intent')).toBe(false);
  });

  it('fails closed for an ambiguous legacy live-without-backup marker', async () => {
    const { fs, files } = createMemFs();
    files.set('file:///docs/happier/voice/modelPacks/first/pack.json', new TextEncoder().encode('{}'));
    files.set('file:///docs/happier/voice/modelPacks/.first.promote-intent', new TextEncoder().encode('{}'));

    await expect(reconcileExpoModelPackPromotion({ fs, packId: 'first' }))
      .rejects.toThrow('model_pack_promotion_legacy_ambiguous');
    expect(files.has('file:///docs/happier/voice/modelPacks/first/pack.json')).toBe(true);
    expect(files.has('file:///docs/happier/voice/modelPacks/.first.promote-intent')).toBe(true);
  });

  it('drops a stale backup even when the intent marker is already gone', async () => {
    const { fs, files } = createMemFs();
    files.set('file:///docs/happier/voice/modelPacks/done/pack.json', new TextEncoder().encode(JSON.stringify({ version: 'v2' })));
    files.set('file:///docs/happier/voice/modelPacks/.done.backup/pack.json', new TextEncoder().encode('{}'));

    const restored = await reconcileExpoModelPackPromotion({ fs, packId: 'done' });
    expect(restored).toBe(false);
    expect(files.has('file:///docs/happier/voice/modelPacks/done/pack.json')).toBe(true);
    expect(files.has('file:///docs/happier/voice/modelPacks/.done.backup/pack.json')).toBe(false);
  });

  it('is a no-op when no intent marker is present', async () => {
    const { fs } = createMemFs();
    expect(await reconcileExpoModelPackPromotion({ fs, packId: 'missing' })).toBe(false);
  });
});

describe('Expo native host promote rollback intent safety', () => {
  it('keeps the promote intent when rollback restore fails after live was moved to backup', async () => {
    const { fs, files } = createMemFs();
    const packId = 'resume';
    const full = new Uint8Array([5, 6, 7, 8]);
    const liveRoot = 'file:///docs/happier/voice/modelPacks/resume';
    const scratchRoot = 'file:///docs/happier/voice/modelPacks/.resume.scratch';
    const backupRoot = 'file:///docs/happier/voice/modelPacks/.resume.backup';
    const intentUri = 'file:///docs/happier/voice/modelPacks/.resume.promote-intent';

    files.set(`${liveRoot}/pack.json`, new TextEncoder().encode(JSON.stringify({ version: 'v1' })));
    files.set(`${liveRoot}/model.bin`, new Uint8Array([1, 2, 3, 4]));

    const OriginalDirectory = fs.Directory;
    class FailingDirectory extends (OriginalDirectory as any) {
      move(destination: { uri: string }) {
        if (this.uri === scratchRoot && destination.uri === liveRoot) {
          throw new Error('promote_failed_after_backup');
        }
        if (this.uri === backupRoot && destination.uri === liveRoot) {
          throw new Error('restore_failed');
        }
        return super.move(destination);
      }
    }
    (fs as any).Directory = FailingDirectory;

    const host = createExpoModelPackInstallerHost({ download: createMemNativeDownload(fs, (async () => streamResponse(full, 200)) as any),
      fs,

    });

    await expect(
      installModelPackWithHost({
        host,
        packId,
        manifest: makeManifest(full),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('promote_failed_after_backup');

    expect(files.has(intentUri)).toBe(true);
    expect(files.has(`${backupRoot}/pack.json`)).toBe(true);
    expect(files.has(`${liveRoot}/pack.json`)).toBe(false);
  });

  it('rolls forward a metadata-committed crash without restoring the backup', async () => {
    const { fs, files } = createMemFs();
    const packId = 'committed';
    const oldBytes = new Uint8Array([1, 1, 1]);
    const newBytes = new Uint8Array([2, 2, 2]);
    files.set(`file:///docs/happier/voice/modelPacks/${packId}/model.bin`, oldBytes);
    files.set(`file:///docs/happier/voice/modelPacks/${packId}/pack.json`, new TextEncoder().encode('{}'));
    const manifest = makeManifest(newBytes) as ModelPackManifest;
    manifest.packId = packId;
    const host = createExpoModelPackInstallerHost({ download: createMemNativeDownload(fs, (async () => streamResponse(newBytes, 200)) as typeof fetch),
      fs,

    });
    const staging = await host.beginStaging(packId, deriveModelPackStagingPlan(manifest));
    await staging.appendDownloadedChunk('model.bin', newBytes);
    await staging.writeManifest(manifest);
    const priorInstall = { scopeKey: 'device', identityKey: packId } as const;
    const promotion = await staging.promote(priorInstall);
    expect(JSON.parse(new TextDecoder().decode(
      files.get(`file:///docs/happier/voice/modelPacks/.${packId}.promote-intent`)! as Uint8Array,
    )).priorInstall).toEqual(priorInstall);
    await promotion.prepareDurableCommit({ kind: 'test', value: { before: 'v1', after: 'v2' } });
    await promotion.markDurableCommitted();
    await staging.cleanup();

    await reconcileExpoModelPackPromotion({ fs, packId, outcome: 'commit' });
    expect(files.get(`file:///docs/happier/voice/modelPacks/${packId}/model.bin`)).toEqual(newBytes);
    expect(files.has(`file:///docs/happier/voice/modelPacks/.${packId}.backup/model.bin`)).toBe(false);
    expect(files.has(`file:///docs/happier/voice/modelPacks/.${packId}.promote-intent`)).toBe(false);
  });

  it('keeps rollback_pending visible when durable metadata rollback fails', async () => {
    const { fs, files } = createMemFs();
    const packId = 'metadata-rollback-failure';
    const oldBytes = new Uint8Array([1, 1, 1]);
    const newBytes = new Uint8Array([2, 2, 2]);
    files.set(`file:///docs/happier/voice/modelPacks/${packId}/model.bin`, oldBytes);
    files.set(`file:///docs/happier/voice/modelPacks/${packId}/pack.json`, new TextEncoder().encode('{}'));
    const manifest = makeManifest(newBytes) as ModelPackManifest;
    manifest.packId = packId;
    const controller = new AbortController();
    const host = createExpoModelPackInstallerHost({ download: createMemNativeDownload(fs, (async () => streamResponse(newBytes, 200)) as typeof fetch),
      fs,

    });

    await expect(installModelPackWithHost({
      host,
      packId,
      manifest,
      signal: controller.signal,
      durableCommit: {
        recovery: { kind: 'test', value: { before: 'v1', after: 'v2' } },
        commit: async () => { controller.abort(); },
        rollback: async () => { throw new Error('metadata_rollback_failed'); },
      },
    })).rejects.toThrow('aborted');

    expect(files.get(`file:///docs/happier/voice/modelPacks/${packId}/model.bin`)).toEqual(oldBytes);
    const intent = files.get(`file:///docs/happier/voice/modelPacks/.${packId}.promote-intent`);
    expect(new TextDecoder().decode(intent)).toContain('rollback_pending');
  });
});

describe('native concurrent model-pack transfers', () => {
  it('reports only resumable payload bytes and clears them through explicit removal', async () => {
    const { fs, files, root } = createMemFs();
    files.set(`${root}/.summary.scratch/model.bin`, new Uint8Array([1, 2]));
    files.set(`${root}/.summary.scratch/lang/en`, new Uint8Array([3, 4, 5]));
    files.set(`${root}/.summary.scratch/.resume-plan.json`, new TextEncoder().encode('{}'));
    files.set(`${root}/.summary.scratch/pack.json`, new TextEncoder().encode('{}'));
    const overrides = { fs, invalidatePackRuntime: async () => {} };
    expect(await getModelPackInstallSummary({ packId: 'summary' }, overrides)).toMatchObject({ installed: false, partialBytes: 5 });
    await removeModelPack({ packId: 'summary' }, overrides);
    expect(await getModelPackInstallSummary({ packId: 'summary' }, overrides)).toMatchObject({ installed: false, partialBytes: 0 });
  });

  it('uses an independent native destination for every overlapping transfer and cleans all temporary files', async () => {
    const { fs, files } = createMemFs();
    const entries = Array.from({ length: 12 }, (_, index) => {
      const bytes = new Uint8Array([index + 1]);
      return { bytes, path: `lang/f${index}`, url: `https://example.com/f${index}`, sizeBytes: 1, sha256: createHash('sha256').update(bytes).digest('hex') };
    });
    const destinations = new Set<string>();
    let active = 0;
    let peak = 0;
    const host = createExpoModelPackInstallerHost({ fs, download: async request => {
      expect(destinations.has(request.fileUri)).toBe(false);
      destinations.add(request.fileUri);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active -= 1;
      const entry = entries.find(entry => entry.url === request.url)!;
      files.set(request.fileUri, entry.bytes);
      return { status: 200, headers: {} };
    } });
    await installModelPackWithHost({ host, packId: 'example', manifest: { packId: 'example', kind: 'tts_sherpa', model: 'kokoro', version: 'v1', files: entries }, signal: new AbortController().signal });
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(6);
    expect(destinations.size).toBe(12);
    for (const entry of entries) expect(files.get(`file:///docs/happier/voice/modelPacks/example/${entry.path}`)).toEqual(entry.bytes);
    expect([...files.keys()].some(path => path.includes('.downloads'))).toBe(false);
  });
});

describe('Expo installed-file reuse after storage failure', () => {
  it('replaces an empty scratch file when copying verified installed bytes', async () => {
    const memory = createMemFs();
    const BaseFile = memory.fs.File;
    let failWrite = true;
    class StorageFailureFile extends BaseFile {
      write(...args: Parameters<InstanceType<typeof BaseFile>['write']>) {
        if (failWrite && this.uri.endsWith('/model.bin')) throw new Error('ENOSPC');
        super.write(...args);
      }
    }
    const bytes = new Uint8Array([1, 2, 3]);
    const manifest = { ...makeManifest(bytes), version: 'v2' };
    const host = createExpoModelPackInstallerHost({
      fs: { ...memory.fs, File: StorageFailureFile },
      download: async () => { throw new Error('unchanged file should be reused'); },
    });
    memory.files.set(`${PACK_DIR}/model.bin`, bytes);
    const staging = await host.beginStaging('resume', deriveModelPackStagingPlan(manifest));
    await expect(staging.appendDownloadedChunk('model.bin', bytes)).rejects.toThrow('ENOSPC');
    await staging.cleanup();
    expect(memory.files.get(`${memory.root}/.resume.scratch/model.bin`)?.byteLength).toBe(0);
    failWrite = false;
    await installModelPackWithHost({ host, packId: 'resume', manifest,
      priorManifest: { ...manifest, version: 'v1' }, signal: new AbortController().signal });
    expect(memory.files.get(`${PACK_DIR}/model.bin`)).toEqual(bytes);
  });
});
