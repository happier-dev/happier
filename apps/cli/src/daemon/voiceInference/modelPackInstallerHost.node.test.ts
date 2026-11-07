import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ModelPackManifest } from '@happier-dev/protocol';
import { deriveModelPackStagingPlan, installModelPackWithHost, parseModelPackPromotionIntentV1 } from '@happier-dev/voice-modelpacks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createNodeModelPackDownloadOpener,
  createNodeModelPackInstallerHost,
  reconcileModelPackPromotions,
  readModelPackPromotionIntents,
} from './nodeModelPackInstallerHost';
import type { NodeModelPackDownloadTransport } from './nodeModelPackInstallerHost';
import { bindProcessLogger, Logger } from '../../ui/logger';

// Filesystem IO is a system boundary. Mock its named export so the injected
// failure reaches Vite's module graph as well as the test's import.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

let root: string;
let packsRootDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'happier-node-host-'));
  packsRootDir = join(root, 'packs');
  await mkdir(packsRootDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const fetchBackedTransport: NodeModelPackDownloadTransport = async (request) => {
  const response = await fetch(request.url, { signal: request.signal, headers: request.headers });
  const headers: Record<string, string | undefined> = {};
  for (const name of ['content-length', 'location']) headers[name] = response.headers.get(name) ?? undefined;
  const reader = response.body?.getReader();
  let delivered = false;
  return {
    status: response.status,
    headers,
    contentLength: Number.isFinite(Number(headers['content-length'])) ? Number(headers['content-length']) : null,
    read: reader
      ? async () => {
          const next = await reader.read();
          return next.done ? null : next.value ?? new Uint8Array();
        }
      : async () => {
          if (delivered) return null;
          delivered = true;
          return new Uint8Array(await response.arrayBuffer());
        },
    cancel: () => {
      void reader?.cancel().catch(() => undefined);
    },
  };
};

function createTestNodeModelPackInstallerHost(
  options: Omit<Parameters<typeof createNodeModelPackInstallerHost>[0], 'transport'>,
) {
  return createNodeModelPackInstallerHost({
    ...options,
    transport: fetchBackedTransport,
  });
}

describe('node model-pack installer host — real Range resume (FIND-010)', () => {
  it('logs failed postcommit backup cleanup without failing commit or replacing new live bytes', async () => {
    const packId = 'backup-cleanup-warning';
    const bytes = new Uint8Array([2]);
    const manifest = { packId, kind: 'tts_sherpa', model: 'kokoro', version: 'v2',
      files: [{ path: 'model.bin', url: 'https://models.example/model.bin', sha256: sha256Hex(bytes), sizeBytes: 1 }] } satisfies ModelPackManifest;
    const liveDir = join(packsRootDir, packId);
    const backupDir = join(packsRootDir, `.${packId}.backup`);
    await mkdir(liveDir);
    await writeFile(join(liveDir, 'model.bin'), new Uint8Array([1]));
    const logPath = join(root, 'backup-warning.log');
    await writeFile(logPath, '');
    const log = new Logger({ logFilePath: logPath, pruneCurrentProcessLogs: false, allowDangerousRemoteLogging: false });
    const restore = bindProcessLogger(log);
    const cleanupError = Object.assign(new Error('EACCES_postcommit_backup_cleanup'), { code: 'EACCES' });
    const remove = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rm;
    // Node filesystem IO is the system boundary; all other paths use the real implementation.
    const removeSpy = vi.mocked(rm).mockImplementation(async (path, options) => {
      if (String(path) === backupDir) throw cleanupError;
      return remove(path, options);
    });
    try {
      const host = createTestNodeModelPackInstallerHost({ packsRootDir });
      const staging = await host.beginStaging(packId, deriveModelPackStagingPlan(manifest));
      try {
        await staging.appendDownloadedChunk('model.bin', bytes);
        await staging.writeManifest(manifest);
        const promotion = await staging.promote({ scopeKey: 'fixture', identityKey: packId });
        await expect(promotion.commit()).resolves.toBeUndefined();
        expect(removeSpy).toHaveBeenCalledWith(backupDir, { recursive: true, force: true });
        expect(await readFile(join(liveDir, 'model.bin'))).toEqual(Buffer.from(bytes));
        expect(await exists(join(packsRootDir, `.${packId}.promote-intent`))).toBe(false);
        expect(await exists(backupDir)).toBe(true);
        log.flushSync();
        expect(await readFile(logPath, 'utf8')).toContain(cleanupError.message);
      } finally { await staging.cleanup(); }
    } finally {
      try {
        removeSpy.mockImplementation(remove);
      } finally { restore(); }
    }
  });

  it.each(['first install', 'update'] as const)('rejects commit intent deletion before settling a node %s and permits rollback', async (mode) => {
    const before = new Uint8Array([1]);
    const after = new Uint8Array([2]);
    const packId = 'intent-delete';
    const manifest = { packId, kind: 'tts_sherpa', model: 'kokoro', version: 'v2',
      files: [{ path: 'model.bin', url: 'https://models.example/model.bin', sha256: sha256Hex(after), sizeBytes: 1 }] } satisfies ModelPackManifest;
    const liveDir = join(packsRootDir, packId);
    if (mode === 'update') {
      await mkdir(liveDir);
      await writeFile(join(liveDir, 'model.bin'), before);
    }
    const host = createTestNodeModelPackInstallerHost({ packsRootDir });
    const staging = await host.beginStaging(packId, deriveModelPackStagingPlan(manifest));
    try {
      await staging.appendDownloadedChunk('model.bin', after);
      await staging.writeManifest(manifest);
      const promotion = await staging.promote(mode === 'update' ? { scopeKey: 'fixture', identityKey: packId } : null);
      const marker = join(packsRootDir, `.${packId}.promote-intent`);
      const intent = await readFile(marker);
      await rm(marker);
      await mkdir(marker);
      await writeFile(join(marker, 'blocks-delete'), 'retained');
      await expect(promotion.commit()).rejects.toMatchObject({ code: 'ERR_FS_EISDIR' });
      await rm(marker, { recursive: true });
      await writeFile(marker, intent);
      await promotion.rollback();
      await promotion.completeRollback();
      expect(await exists(liveDir)).toBe(mode === 'update');
      if (mode === 'update') expect(await readFile(join(liveDir, 'model.bin'))).toEqual(Buffer.from(before));
      expect(await readModelPackPromotionIntents(packsRootDir)).toEqual([]);
    } finally { await staging.cleanup(); }
  });

  it('logs genuine partial stat failures and rejects required reset failure while absent files stay quiet', async () => {
    const logPath = join(root, 'warning.log');
    await writeFile(logPath, '');
    const log = new Logger({ logFilePath: logPath, pruneCurrentProcessLogs: false, allowDangerousRemoteLogging: false });
    const restore = bindProcessLogger(log);
    const manifest = { packId: 'warning-pack', kind: 'tts_sherpa', model: 'kokoro', version: 'v1',
      files: [{ path: 'model.bin', url: 'https://models.example/model.bin', sha256: sha256Hex(new Uint8Array([1])), sizeBytes: 1 }] } satisfies ModelPackManifest;
    const host = createTestNodeModelPackInstallerHost({ packsRootDir });
    const staging = await host.beginStaging(manifest.packId, deriveModelPackStagingPlan(manifest));
    try {
      expect(await staging.partialByteLength('absent.bin')).toBe(0);
      await staging.resetPartial('absent.bin');
      log.flushSync();
      expect(await readFile(logPath, 'utf8')).toBe('');
      const scratch = join(packsRootDir, '.warning-pack.scratch');
      await writeFile(join(scratch, 'blocked'), 'file');
      expect(await staging.partialByteLength('blocked/model.bin')).toBe(0);
      log.flushSync();
      const statLog = await readFile(logPath, 'utf8');
      await writeFile(logPath, '');
      await mkdir(join(scratch, 'model.bin'));
      await writeFile(join(scratch, 'model.bin', 'retained.bin'), 'retained');
      await expect(staging.resetPartial('model.bin')).rejects.toMatchObject({ code: 'ERR_FS_EISDIR' });
      expect(await readFile(join(scratch, 'model.bin', 'retained.bin'), 'utf8')).toBe('retained');
      log.flushSync();
      expect(statLog).toContain('ENOTDIR');
    } finally { await staging.cleanup(); restore(); }
  });

  it('logs cleanup failure after promotion without replacing the installed bytes', async () => {
    const logPath = join(root, 'cleanup-warning.log');
    await writeFile(logPath, '');
    const log = new Logger({ logFilePath: logPath, pruneCurrentProcessLogs: false, allowDangerousRemoteLogging: false });
    const restore = bindProcessLogger(log);
    const bytes = new Uint8Array([1]);
    const manifest = { packId: 'cleanup-warning', kind: 'tts_sherpa', model: 'kokoro', version: 'v1',
      files: [{ path: 'model.bin', url: 'https://models.example/model.bin', sha256: sha256Hex(bytes), sizeBytes: 1 }] } satisfies ModelPackManifest;
    const host = createTestNodeModelPackInstallerHost({ packsRootDir });
    const staging = await host.beginStaging(manifest.packId, deriveModelPackStagingPlan(manifest));
    let cleaned = false;
    try {
      await staging.appendDownloadedChunk('model.bin', bytes);
      await staging.writeManifest(manifest);
      const promotion = await staging.promote(null);
      await promotion.commit();
      const retainedRoot = join(root, 'retained-packs');
      await rename(packsRootDir, retainedRoot);
      await writeFile(packsRootDir, 'blocks cleanup path');
      await expect(rm(join(packsRootDir, '.cleanup-warning.scratch'), { recursive: true, force: true })).rejects.toMatchObject({ code: 'ENOTDIR' });
      await staging.cleanup();
      cleaned = true;
      expect(await readFile(join(retainedRoot, manifest.packId, 'model.bin'))).toEqual(Buffer.from(bytes));
      log.flushSync();
      expect(await readFile(logPath, 'utf8')).toContain('ENOTDIR');
    } finally { if (!cleaned) await staging.cleanup(); restore(); }
  });

  it('drops retired persisted promotion fields and rejects malformed known recovery identity', async () => {
    const marker = join(packsRootDir, '.stored-pack.promote-intent');
    const canonical = { schemaVersion: 1, packId: 'stored-pack', phase: 'metadata_pending',
      startedAtMs: 100, token: 'token-a', priorInstall: { scopeKey: 'scope-a', identityKey: 'identity-a' },
      recovery: { kind: 'owner-a', value: { ownerData: true } } };
    await writeFile(marker, JSON.stringify({ ...canonical, retired: true,
      priorInstall: { ...canonical.priorInstall, retired: true }, recovery: { ...canonical.recovery, retired: true } }));
    expect(await readModelPackPromotionIntents(packsRootDir)).toEqual([canonical]);
    expect(() => parseModelPackPromotionIntentV1({ ...canonical, retired: true }, canonical.packId)).toThrow('model_pack_promotion_intent_invalid');
    await writeFile(marker, JSON.stringify({ ...canonical, priorInstall: { ...canonical.priorInstall, identityKey: 12 } }));
    await expect(readModelPackPromotionIntents(packsRootDir)).rejects.toThrow('model_pack_promotion_intent_invalid');
  });

  it('installs signed HTTPS redirects through the real core without persisting their query or forwarding credentials', async () => {
    const bytes = Buffer.from('signed model bytes');
    const signedUrl = 'https://release-assets.example/model.bin?sig=transport-secret&jwt=transport-token';
    const transport = vi.fn<NodeModelPackDownloadTransport>(async (request) => {
      if (request.url === 'https://models.example/model.bin') {
        return { status: 302, headers: { location: signedUrl }, contentLength: 0,
          read: async () => null, cancel: () => undefined };
      }
      expect(request.url).toBe(signedUrl);
      expect(Object.keys(request.headers).map((name) => name.toLowerCase())).not.toContain('authorization');
      let sent = false;
      return { status: 200, headers: {}, contentLength: bytes.length,
        read: async () => { if (sent) return null; sent = true; return bytes; },
        cancel: () => undefined };
    });
    const host = createNodeModelPackInstallerHost({ packsRootDir,
      transport: transport });
    const manifest = { packId: 'signed-asset-pack', kind: 'tts_sherpa', model: 'kokoro', version: 'v1',
      files: [{ path: 'model.bin', url: 'https://models.example/model.bin',
        sha256: sha256Hex(bytes), sizeBytes: bytes.length }] } satisfies ModelPackManifest;
    const progress: unknown[] = [];
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    try {
      await installModelPackWithHost({ host, packId: manifest.packId, manifest,
        signal: new AbortController().signal, onProgress: (event) => { progress.push(event); } });
      expect(await readFile(join(packsRootDir, manifest.packId, 'model.bin'))).toEqual(bytes);
      const persisted = await readFile(join(packsRootDir, manifest.packId, 'pack.json'), 'utf8');
      expect(JSON.parse(persisted)).toEqual(manifest);
      expect(JSON.stringify([persisted, progress, logs.map((log) => log.mock.calls)])).not.toContain('transport-secret');
      expect(await readdir(packsRootDir)).toEqual([manifest.packId]);
      const stream = await host.openDownload({ url: manifest.files[0].url, signal: new AbortController().signal });
      expect(stream.finalUrl).toBe('https://release-assets.example/model.bin');
      stream.cancel?.();
    } finally {
      for (const log of logs) log.mockRestore();
    }
  });

  it.each(['connect', 'read'] as const)('keeps signed redirect queries out of %s errors', async (failure) => {
    const signedUrl = 'https://release-assets.example/model.bin?jwt=transport-secret';
    const transport = vi.fn<NodeModelPackDownloadTransport>(async (request) => {
      if (request.url === 'https://models.example/model.bin') {
        return { status: 302, headers: { location: signedUrl }, contentLength: 0,
          read: async () => null, cancel: () => undefined };
      }
      if (failure === 'connect') throw new Error(`request failed: ${request.url}`);
      return { status: 200, headers: {}, contentLength: null,
        read: async () => { throw new Error(`body failed: ${request.url}`); }, cancel: () => undefined };
    });
    const openDownload = createNodeModelPackDownloadOpener({
      transport: transport });
    const pending = async () => {
      const stream = await openDownload({ url: 'https://models.example/model.bin', signal: new AbortController().signal });
      await stream.read();
    };
    await expect(pending()).rejects.toMatchObject({ message: 'model_pack_download_transport_failed' });
  });

  it.each([
    ['http://cdn.example/model.bin?jwt=transport-secret', 'model_pack_url_insecure_scheme'],
    ['http://127.0.0.1/model.bin?jwt=transport-secret', 'model_pack_url_insecure_scheme'],
    ['https://user:pass@cdn.example/model.bin?jwt=transport-secret', 'model_pack_url_credentials_forbidden'],
  ])('refuses unsafe signed redirect %s before connecting', async (location, code) => {
    const transport = vi.fn<NodeModelPackDownloadTransport>().mockResolvedValue({ status: 302,
      headers: { location }, contentLength: 0, read: async () => null, cancel: () => undefined });
    const openDownload = createNodeModelPackDownloadOpener({
      urlPolicy: { allowInsecureLoopback: true },
      transport: transport });
    await expect(openDownload({ url: 'https://models.example/model.bin', signal: new AbortController().signal })).rejects.toThrow(code);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('settles caller cancellation while the network ignores the abort signal', async () => {
    const controller = new AbortController();
    const transport = vi.fn<NodeModelPackDownloadTransport>(async () => await new Promise(() => undefined));
    const openDownload = createNodeModelPackDownloadOpener({
      transport: transport,
    });

    const pending = openDownload({
      url: 'https://models.example/model.bin',
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(transport).toHaveBeenCalledOnce();
  });

  it('cancels a response that settles at the same boundary as caller cancellation', async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const response = {
      status: 200,
      headers: {},
      contentLength: null,
      read: async () => null,
      cancel,
    };
    const transport = vi.fn<NodeModelPackDownloadTransport>(() => new Promise((resolve) => {
      resolve(response);
      queueMicrotask(() => controller.abort());
    }));
    const openDownload = createNodeModelPackDownloadOpener({
      transport: transport,
    });

    await expect(openDownload({
      url: 'https://models.example/model.bin',
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(['caller', 'stream'] as const)('settles an in-flight response read on %s cancellation', async (cancelFrom) => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const transport = vi.fn<NodeModelPackDownloadTransport>().mockResolvedValue({
      status: 200, headers: {}, contentLength: null,
      read: async () => await new Promise(() => undefined), cancel,
    });
    const stream = await createNodeModelPackDownloadOpener({ transport })({
      url: 'https://models.example/model.bin', signal: controller.signal,
    });
    const pending = stream.read();
    if (cancelFrom === 'caller') controller.abort();
    else stream.cancel?.();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('does not start a cancelled download', async () => {
    const controller = new AbortController();
    controller.abort();
    const transport = vi.fn<NodeModelPackDownloadTransport>();
    await expect(createNodeModelPackDownloadOpener({ transport })({
      url: 'https://models.example/model.bin', signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(transport).not.toHaveBeenCalled();
  });

  it('keeps a progressing download usable beyond the former thirty-minute wall cap', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const transport = vi.fn<NodeModelPackDownloadTransport>().mockResolvedValue({
      status: 200,
      headers: {},
      contentLength: null,
      read: async () => new Uint8Array([1]),
      cancel,
    });
    const openDownload = createNodeModelPackDownloadOpener({
      transport: transport,
    });
    try {
      const stream = await openDownload({
        url: 'https://models.example/model.bin',
        signal: new AbortController().signal,
      });
      for (let minute = 0; minute < 31; minute += 1) {
        await vi.advanceTimersByTimeAsync(60_000);
        await expect(stream.read()).resolves.toEqual(new Uint8Array([1]));
      }
      expect(cancel).not.toHaveBeenCalled();
      stream.cancel?.();
    } finally { vi.useRealTimers(); }
  });

  it('follows an HTTPS redirect to a LAN mirror without a second network admission', async () => {
    const transport = vi.fn<NodeModelPackDownloadTransport>(async (request) => {
      if (request.url === 'https://models.example/model.bin') {
        return {
          status: 302,
          headers: { location: 'https://192.168.1.2/model.bin' },
          contentLength: 0,
          read: async () => null,
          cancel: () => undefined,
        };
      }
      return {
        status: 200,
        headers: { 'content-length': '3' },
        contentLength: 3,
        read: (() => {
          let sent = false;
          return async () => {
            if (sent) return null;
            sent = true;
            return new Uint8Array([1, 2, 3]);
          };
        })(),
        cancel: () => undefined,
      };
    });
    const options = {
      packsRootDir,
      transport: transport,
    };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error('legacy_fetch_must_not_run'); }) as typeof fetch;
    try {
      const stream = await createNodeModelPackInstallerHost(options).openDownload({
        url: 'https://models.example/model.bin',
        signal: new AbortController().signal,
      });
      expect(stream.finalUrl).toBe('https://192.168.1.2/model.bin');
      await expect(stream.read()).resolves.toEqual(new Uint8Array([1, 2, 3]));
      await expect(stream.read()).resolves.toBeNull();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('maps malformed redirect locations to a stable model-pack transport error', async () => {
    const transport = vi.fn<NodeModelPackDownloadTransport>().mockResolvedValue({
      status: 302,
      headers: { location: 'http://[invalid' },
      contentLength: 0,
      read: async () => null,
      cancel: () => undefined,
    });
    const host = createNodeModelPackInstallerHost({
      packsRootDir,
      transport: transport,
    });

    await expect(host.openDownload({
      url: 'https://models.example/model.bin',
      signal: new AbortController().signal,
    })).rejects.toThrow('model_pack_redirect_invalid');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('follows a valid redirect chain beyond the former five-hop cap and cancels redirect bodies', async () => {
    const cancel = vi.fn();
    let redirectCount = 0;
    const transport = vi.fn<NodeModelPackDownloadTransport>(async (request) => ({
      status: redirectCount >= 8 ? 200 : 302,
      headers: { location: new URL(`/hop-${++redirectCount}`, request.url).toString() },
      contentLength: 0,
      read: async () => null,
      cancel,
    }));
    const host = createNodeModelPackInstallerHost({
      packsRootDir,
      transport: transport,
    });

    const stream = await host.openDownload({
      url: 'https://models.example/model.bin',
      signal: new AbortController().signal,
    });
    await expect(stream.read()).resolves.toBeNull();
    expect(transport).toHaveBeenCalledTimes(9);
    expect(cancel).toHaveBeenCalledTimes(8);
  });

  it('passes a bracketed IPv6 model-pack URL to the standard transport', async () => {
    const transport = vi.fn<NodeModelPackDownloadTransport>().mockResolvedValue({
      status: 200,
      headers: { 'content-length': '0' },
      contentLength: 0,
      read: async () => null,
      cancel: () => undefined,
    });
    const host = createNodeModelPackInstallerHost({
      packsRootDir,
      urlPolicy: { allowInsecureLoopback: true },
      transport: transport,
    });

    const stream = await host.openDownload({
      url: 'https://[::1]:4873/model.bin',
      signal: new AbortController().signal,
    });

    expect(transport).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://[::1]:4873/model.bin',
    }));
  });

  it('uses the standard transport for an explicitly allowed loopback development asset', async () => {
    const bytes = new Uint8Array([3, 1, 4]);
    const server = createServer((_request, response) => {
      response.statusCode = 200;
      response.setHeader('content-length', String(bytes.byteLength));
      response.end(Buffer.from(bytes));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new TypeError('Expected a TCP test listener');
      const manifest: ModelPackManifest = {
        packId: 'loopbackpack',
        kind: 'tts_sherpa',
        model: 'kokoro',
        version: 'v1',
        files: [{
          path: 'model.bin',
          url: `http://127.0.0.1:${address.port}/model.bin`,
          sha256: sha256Hex(bytes),
          sizeBytes: bytes.byteLength,
        }],
      } as ModelPackManifest;
      const urlPolicy = { allowInsecureLoopback: true } as const;
      const host = createNodeModelPackInstallerHost({ packsRootDir, urlPolicy });
      const direct = await host.openDownload({
        url: manifest.files[0]!.url,
        signal: new AbortController().signal,
      });
      while (await direct.read() !== null) {
        // Drain this first request; the full installer below exercises the core.
      }
      await installModelPackWithHost({
        host,
        packId: manifest.packId,
        manifest,
        signal: new AbortController().signal,
        urlPolicy,
      });
      await expect(readFile(join(packsRootDir, manifest.packId, 'model.bin')))
        .resolves.toEqual(Buffer.from(bytes));
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('does not promote an unlisted file even when scratch has the current immutable plan', async () => {
    const packId = 'prunepack';
    const scratchDir = join(packsRootDir, `.${packId}.scratch`);
    await mkdir(scratchDir, { recursive: true });
    await writeFile(join(scratchDir, 'removed.bin'), Buffer.from([9, 9, 9]));

    const currentBytes = new Uint8Array([1, 2, 3]);
    const manifest: ModelPackManifest = {
      packId,
      kind: 'tts_sherpa',
      model: 'kokoro',
      version: 'v2',
      files: [{
        path: 'current.bin',
        url: 'https://example.com/current.bin',
        sha256: sha256Hex(currentBytes),
        sizeBytes: currentBytes.length,
      }],
    } as ModelPackManifest;

    await writeFile(join(scratchDir, 'current.bin'), currentBytes);
    await writeFile(
      join(scratchDir, '.resume-plan.json'),
      JSON.stringify({ schemaVersion: 1, ...deriveModelPackStagingPlan(manifest) }),
      'utf8',
    );

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('current verified partial must not redownload');
    }) as typeof fetch;
    try {
      const host = createTestNodeModelPackInstallerHost({ packsRootDir });
      await installModelPackWithHost({ host, packId, manifest, signal: new AbortController().signal });
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(await exists(join(packsRootDir, packId, 'current.bin'))).toBe(true);
    expect(await exists(join(packsRootDir, packId, 'removed.bin'))).toBe(false);
  });

  it('resumes from the partial byte offset with an HTTP Range request across two attempts', async () => {
    const fullBytes = new Uint8Array(Array.from({ length: 12 }, (_, i) => i + 1));
    const sha = sha256Hex(fullBytes);
    const manifest: ModelPackManifest = {
      packId: 'resumepack',
      kind: 'tts_sherpa',
      model: 'kokoro',
      version: 'v1',
      files: [{ path: 'model.bin', url: 'https://example.com/model.bin', sha256: sha, sizeBytes: fullBytes.length }],
    } as ModelPackManifest;

    const rangeHeaders: Array<string | null> = [];
    let attempt = 0;

    // Attempt 1: stream the first 5 bytes, then ABORT mid-stream (an aborted
    // transfer leaves the appended partial in place — it is not a size mismatch).
    // Attempt 2: must send `Range: bytes=5-` and stream the remaining 7 bytes.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      attempt += 1;
      const range = (init?.headers as Record<string, string> | undefined)?.Range ?? null;
      rangeHeaders.push(range);

      if (attempt === 1) {
        const prefix = fullBytes.slice(0, 5);
        let idx = 0;
        return {
          ok: true,
          status: 200,
          headers: { get: (k: string) => (k.toLowerCase() === 'content-length' ? String(fullBytes.length) : null) },
          body: {
            getReader: () => ({
              read: async () => {
                if (idx === 0) {
                  idx = 1;
                  return { done: false, value: prefix };
                }
                // Abort the transfer: leaves a 5-byte partial in scratch.
                throw Object.assign(new Error('network_drop'), { name: 'AbortError' });
              },
            }),
          },
        } as unknown as Response;
      }

      const start = range ? Number(range.replace('bytes=', '').replace('-', '')) : 0;
      const remaining = fullBytes.slice(start);
      let idx = 0;
      return {
        ok: true,
        status: 206,
        headers: { get: (k: string) => (k.toLowerCase() === 'content-length' ? String(remaining.length) : null) },
        body: {
          getReader: () => ({
            read: async () => {
              if (idx === 0) {
                idx = 1;
                return { done: false, value: remaining };
              }
              return { done: true, value: undefined };
            },
          }),
        },
      } as unknown as Response;
    }) as typeof fetch;

    try {
      const host = createTestNodeModelPackInstallerHost({ packsRootDir });

      await expect(
        installModelPackWithHost({ host, packId: 'resumepack', manifest, signal: new AbortController().signal }),
      ).rejects.toThrow();

      await installModelPackWithHost({ host, packId: 'resumepack', manifest, signal: new AbortController().signal });

      // First attempt issued no Range; the retry resumed from byte 5.
      expect(rangeHeaders[0]).toBeNull();
      expect(rangeHeaders[1]).toBe('bytes=5-');

      const installed = await readFile(join(packsRootDir, 'resumepack', 'model.bin'));
      expect(Array.from(new Uint8Array(installed))).toEqual(Array.from(fullBytes));
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('issues a Range request seeded from a surviving scratch partial across host instances', async () => {
    const fullBytes = new Uint8Array(Array.from({ length: 10 }, (_, i) => i + 1));
    const sha = sha256Hex(fullBytes);
    const manifest: ModelPackManifest = {
      packId: 'seedpack',
      kind: 'tts_sherpa',
      model: 'kokoro',
      version: 'v1',
      files: [{ path: 'model.bin', url: 'https://example.com/model.bin', sha256: sha, sizeBytes: fullBytes.length }],
    } as ModelPackManifest;

    // Pre-seed a trustworthy partial (first 4 bytes) in the STABLE scratch dir,
    // as a prior interrupted attempt would have left it.
    const scratchDir = join(packsRootDir, '.seedpack.scratch');
    await mkdir(scratchDir, { recursive: true });
    await writeFile(join(scratchDir, 'model.bin'), Buffer.from(fullBytes.slice(0, 4)));
    await writeFile(
      join(scratchDir, '.resume-plan.json'),
      JSON.stringify({ schemaVersion: 1, ...deriveModelPackStagingPlan(manifest) }),
      'utf8',
    );

    let observedRange: string | null = null;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      observedRange = (init?.headers as Record<string, string> | undefined)?.Range ?? null;
      const start = observedRange ? Number(observedRange.replace('bytes=', '').replace('-', '')) : 0;
      const remaining = fullBytes.slice(start);
      let idx = 0;
      return {
        ok: true,
        status: 206,
        headers: { get: (k: string) => (k.toLowerCase() === 'content-length' ? String(remaining.length) : null) },
        body: {
          getReader: () => ({
            read: async () => {
              if (idx === 0) {
                idx = 1;
                return { done: false, value: remaining };
              }
              return { done: true, value: undefined };
            },
          }),
        },
      } as unknown as Response;
    }) as typeof fetch;

    try {
      const host = createTestNodeModelPackInstallerHost({ packsRootDir });
      await installModelPackWithHost({ host, packId: 'seedpack', manifest, signal: new AbortController().signal });
      expect(observedRange).toBe('bytes=4-');
      const installed = await readFile(join(packsRootDir, 'seedpack', 'model.bin'));
      expect(Array.from(new Uint8Array(installed))).toEqual(Array.from(fullBytes));
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('reconcileModelPackPromotions — crash-window recovery (X-M1)', () => {
  it('fails closed and preserves a malformed recovery marker', async () => {
    const intentPath = join(packsRootDir, '.malformed.promote-intent');
    await writeFile(intentPath, '{truncated', 'utf8');
    await expect(reconcileModelPackPromotions(packsRootDir)).rejects.toThrow('model_pack_promotion_intent_invalid');
    expect(await exists(intentPath)).toBe(true);
  });

  it('fails closed and preserves an oversized promotion marker', async () => {
    const intentPath = join(packsRootDir, '.oversized.promote-intent');
    await writeFile(intentPath, Buffer.alloc(64 * 1024 + 1, 0x20));
    await expect(reconcileModelPackPromotions(packsRootDir)).rejects.toThrow('model_pack_promotion_intent_invalid');
    expect(await exists(intentPath)).toBe(true);
  });

  it('does not reinterpret a malformed v1 transaction marker as a legacy swap marker', async () => {
    const intentPath = join(packsRootDir, '.malformed-v1.promote-intent');
    await writeFile(intentPath, JSON.stringify({
      schemaVersion: 1,
      packId: 'malformed-v1',
      phase: 'metadata_pending',
      startedAtMs: Date.now(),
      token: 'token',
      priorInstall: null,
      recovery: { kind: 42, value: null },
    }), 'utf8');

    await expect(reconcileModelPackPromotions(packsRootDir)).rejects.toThrow('model_pack_promotion_intent_invalid');
    expect(await exists(intentPath)).toBe(true);
  });

  it('preserves a prior verified upgrade when swap_prepared crashed before the first rename', async () => {
    const packId = 'upgrade-before-rename';
    const liveDir = join(packsRootDir, packId);
    const intentPath = join(packsRootDir, `.${packId}.promote-intent`);
    await mkdir(liveDir, { recursive: true });
    await writeFile(join(liveDir, 'pack.json'), JSON.stringify({ version: 'v1' }), 'utf8');
    await writeFile(intentPath, JSON.stringify({
      schemaVersion: 1,
      packId,
      phase: 'swap_prepared',
      startedAtMs: 1,
      token: 'upgrade-before-rename',
      priorInstall: { scopeKey: 'account/machine', identityKey: 'plugin/pack' },
      recovery: null,
    }), 'utf8');

    await expect(reconcileModelPackPromotions(packsRootDir)).resolves.toEqual([]);
    await expect(readFile(join(liveDir, 'pack.json'), 'utf8')).resolves.toContain('v1');
    expect(await exists(intentPath)).toBe(false);
  });

  it('fails closed when rollback expects a prior verified install but neither live nor backup exists', async () => {
    const packId = 'upgrade-prior-missing';
    const intentPath = join(packsRootDir, `.${packId}.promote-intent`);
    await writeFile(intentPath, JSON.stringify({
      schemaVersion: 1,
      packId,
      phase: 'swap_prepared',
      startedAtMs: 1,
      token: 'upgrade-prior-missing',
      priorInstall: { scopeKey: 'account/machine', identityKey: 'plugin/pack' },
      recovery: null,
    }), 'utf8');

    await expect(reconcileModelPackPromotions(packsRootDir)).rejects.toThrow('model_pack_promotion_prior_missing');
    expect(await exists(intentPath)).toBe(true);
  });

  it('does not restore a displaced unverified tree when the marker records no verified prior', async () => {
    const packId = 'first-with-unverified-displacement';
    const liveDir = join(packsRootDir, packId);
    const backupDir = join(packsRootDir, `.${packId}.backup`);
    const intentPath = join(packsRootDir, `.${packId}.promote-intent`);
    await mkdir(liveDir, { recursive: true });
    await writeFile(join(liveDir, 'pack.json'), JSON.stringify({ version: 'candidate' }), 'utf8');
    await mkdir(backupDir, { recursive: true });
    await writeFile(join(backupDir, 'pack.json'), JSON.stringify({ version: 'unverified' }), 'utf8');
    await writeFile(intentPath, JSON.stringify({
      schemaVersion: 1,
      packId,
      phase: 'swap_prepared',
      startedAtMs: 1,
      token: 'first-with-unverified-displacement',
      priorInstall: null,
      recovery: null,
    }), 'utf8');

    await reconcileModelPackPromotions(packsRootDir);
    expect(await exists(liveDir)).toBe(false);
    expect(await exists(backupDir)).toBe(false);
    expect(await exists(intentPath)).toBe(false);
  });

  it('restores the backup to live when a crash left live missing + backup present + intent marker', async () => {
    const packId = 'crashpack';
    const backupDir = join(packsRootDir, `.${packId}.backup`);
    const intentFile = join(packsRootDir, `.${packId}.promote-intent`);

    // Simulate the crash window: live was renamed to backup, scratch->live never ran.
    await mkdir(backupDir, { recursive: true });
    await writeFile(join(backupDir, 'pack.json'), JSON.stringify({ packId, version: 'v1' }), 'utf8');
    await writeFile(intentFile, JSON.stringify({ packId, startedAtMs: Date.now() }), 'utf8');

    const restored = await reconcileModelPackPromotions(packsRootDir);
    expect(restored).toContain(packId);

    // Live restored, backup + intent cleared.
    const liveManifest = JSON.parse(await readFile(join(packsRootDir, packId, 'pack.json'), 'utf8'));
    expect(liveManifest.version).toBe('v1');
    const remaining = await readdir(packsRootDir);
    expect(remaining).not.toContain(`.${packId}.backup`);
    expect(remaining).not.toContain(`.${packId}.promote-intent`);
  });

  it('restores backup when live and intent exist because durable commit had not completed', async () => {
    const packId = 'donepack';
    await mkdir(join(packsRootDir, packId), { recursive: true });
    await writeFile(join(packsRootDir, packId, 'pack.json'), JSON.stringify({ packId, version: 'v2' }), 'utf8');
    await mkdir(join(packsRootDir, `.${packId}.backup`), { recursive: true });
    await writeFile(join(packsRootDir, `.${packId}.backup`, 'pack.json'), JSON.stringify({ packId, version: 'v1' }), 'utf8');
    await writeFile(join(packsRootDir, `.${packId}.promote-intent`), '{}', 'utf8');

    const restored = await reconcileModelPackPromotions(packsRootDir);
    expect(restored).toContain(packId);

    const remaining = await readdir(packsRootDir);
    expect(remaining).toContain(packId);
    expect(remaining).not.toContain(`.${packId}.backup`);
    expect(remaining).not.toContain(`.${packId}.promote-intent`);
    await expect(readFile(join(packsRootDir, packId, 'pack.json'), 'utf8')).resolves.toContain('"v1"');
  });

  it('fails closed for an ambiguous legacy live-without-backup marker', async () => {
    const packId = 'uncommitted-first';
    await mkdir(join(packsRootDir, packId), { recursive: true });
    await writeFile(join(packsRootDir, packId, 'pack.json'), '{}', 'utf8');
    await writeFile(join(packsRootDir, `.${packId}.promote-intent`), '{}', 'utf8');

    await expect(reconcileModelPackPromotions(packsRootDir))
      .rejects.toThrow('model_pack_promotion_intent_invalid');
    expect(await exists(join(packsRootDir, packId))).toBe(true);
    expect(await exists(join(packsRootDir, `.${packId}.promote-intent`))).toBe(true);
  });

  it('drops a stale backup without an intent marker before the next promotion', async () => {
    const packId = 'orphanbackup';
    await mkdir(join(packsRootDir, packId), { recursive: true });
    await writeFile(join(packsRootDir, packId, 'pack.json'), JSON.stringify({ packId, version: 'v1' }), 'utf8');
    await mkdir(join(packsRootDir, `.${packId}.backup`), { recursive: true });
    await writeFile(join(packsRootDir, `.${packId}.backup`, 'pack.json'), JSON.stringify({ packId, version: 'older' }), 'utf8');

    const bytes = new Uint8Array([7, 8, 9]);
    const manifest: ModelPackManifest = {
      packId,
      kind: 'tts_sherpa',
      model: 'kokoro',
      version: 'v2',
      files: [{ path: 'model.bin', url: 'https://example.com/model.bin', sha256: sha256Hex(bytes), sizeBytes: bytes.length }],
    } as ModelPackManifest;

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      let delivered = false;
      return {
        ok: true,
        status: 200,
        headers: { get: (k: string) => (k.toLowerCase() === 'content-length' ? String(bytes.length) : null) },
        body: {
          getReader: () => ({
            read: async () => {
              if (delivered) return { done: true, value: undefined };
              delivered = true;
              return { done: false, value: bytes };
            },
          }),
        },
      } as unknown as Response;
    }) as typeof fetch;
    try {
      const host = createTestNodeModelPackInstallerHost({ packsRootDir });
      await installModelPackWithHost({ host, packId, manifest, signal: new AbortController().signal });
    } finally {
      globalThis.fetch = realFetch;
    }

    const installed = JSON.parse(await readFile(join(packsRootDir, packId, 'pack.json'), 'utf8'));
    expect(installed.version).toBe('v2');
    const remaining = await readdir(packsRootDir);
    expect(remaining).not.toContain(`.${packId}.backup`);
  });

  it('is a no-op when there are no pending intent markers', async () => {
    await mkdir(join(packsRootDir, 'plainpack'), { recursive: true });
    const restored = await reconcileModelPackPromotions(packsRootDir);
    expect(restored).toEqual([]);
  });
});

describe('node host atomicity regression — failed update keeps the prior live pack', () => {
  it('writes the scoped prior-install identity in swap_prepared before promotion can advance', async () => {
    const packId = 'prior-marker';
    const oldBytes = new Uint8Array([1, 2]);
    const newBytes = new Uint8Array([3, 4]);
    await mkdir(join(packsRootDir, packId), { recursive: true });
    await writeFile(join(packsRootDir, packId, 'model.bin'), oldBytes);
    await writeFile(join(packsRootDir, packId, 'pack.json'), JSON.stringify({ version: 'v1' }), 'utf8');
    const manifest = {
      packId,
      kind: 'tts_sherpa',
      model: 'kokoro',
      version: 'v2',
      files: [{
        path: 'model.bin',
        url: 'https://example.com/model.bin',
        sha256: sha256Hex(newBytes),
        sizeBytes: newBytes.byteLength,
      }],
    } as ModelPackManifest;
    const host = createTestNodeModelPackInstallerHost({ packsRootDir });
    const staging = await host.beginStaging(packId, deriveModelPackStagingPlan(manifest));
    await staging.appendDownloadedChunk('model.bin', newBytes);
    await staging.writeManifest(manifest);
    const priorInstall = { scopeKey: 'account/machine', identityKey: 'plugin/pack' } as const;
    const promotion = await staging.promote(priorInstall);

    const marker = JSON.parse(await readFile(join(packsRootDir, `.${packId}.promote-intent`), 'utf8'));
    expect(marker).toMatchObject({ phase: 'swap_prepared', priorInstall });

    await promotion.rollback();
    await promotion.completeRollback();
    await staging.cleanup();
  });
  it('allows only one in-process staged install per root and pack, then releases after cleanup', async () => {
    const manifest: ModelPackManifest = {
      packId: 'singleflight',
      kind: 'tts_sherpa',
      model: 'kokoro',
      version: 'v1',
      files: [{
        path: 'model.bin',
        url: 'https://example.com/model.bin',
        sha256: 'a'.repeat(64),
        sizeBytes: 1,
      }],
    } as ModelPackManifest;
    const plan = deriveModelPackStagingPlan(manifest);
    expect(plan.totalBytes).toBe(1);
    const first = await createTestNodeModelPackInstallerHost({ packsRootDir })
      .beginStaging(manifest.packId, plan);
    await expect(createTestNodeModelPackInstallerHost({ packsRootDir })
      .beginStaging(manifest.packId, plan))
      .rejects.toThrow('model_pack_install_already_in_progress');

    await first.cleanup();
    const retry = await createTestNodeModelPackInstallerHost({ packsRootDir })
      .beginStaging(manifest.packId, plan);
    await retry.cleanup();
  });

  it('refuses staging before filesystem mutation when declared bytes plus disk headroom do not fit', async () => {
    const manifest: ModelPackManifest = {
      packId: 'diskfull',
      kind: 'tts_sherpa',
      model: 'kokoro',
      version: 'v1',
      files: [{
        path: 'model.bin',
        url: 'https://example.com/model.bin',
        sha256: 'a'.repeat(64),
        sizeBytes: 1024,
      }],
    } as ModelPackManifest;
    const host = createNodeModelPackInstallerHost({
      packsRootDir,
      resolveAvailableDiskBytes: async () => 1024,
      minFreeDiskHeadroomBytes: 1,
    });
    await expect(host.beginStaging(manifest.packId, deriveModelPackStagingPlan(manifest)))
      .rejects.toThrow('model_pack_insufficient_disk_space');
    expect(await readdir(packsRootDir)).toEqual([]);
  });

  it('charges disk headroom only for bytes still missing from a matching resumable plan', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const manifest: ModelPackManifest = {
      packId: 'diskresume',
      kind: 'tts_sherpa',
      model: 'kokoro',
      version: 'v1',
      files: [{
        path: 'model.bin',
        url: 'https://example.com/model.bin',
        sha256: sha256Hex(bytes),
        sizeBytes: bytes.byteLength,
      }],
    } as ModelPackManifest;
    const plan = deriveModelPackStagingPlan(manifest);
    const scratchDir = join(packsRootDir, '.diskresume.scratch');
    await mkdir(scratchDir, { recursive: true });
    await writeFile(join(scratchDir, 'model.bin'), bytes);
    await writeFile(
      join(scratchDir, '.resume-plan.json'),
      JSON.stringify({ schemaVersion: 1, ...plan }),
      'utf8',
    );
    const host = createNodeModelPackInstallerHost({
      packsRootDir,
      resolveAvailableDiskBytes: async () => 16,
      minFreeDiskHeadroomBytes: 16,
    });

    const staging = await host.beginStaging(manifest.packId, plan);
    await staging.cleanup();
  });

  it('leaves the live pack intact when the new download fails, and retains scratch for resume', async () => {
    const packId = 'keeplive';
    const oldBytes = new Uint8Array([1, 2, 3, 4]);
    await mkdir(join(packsRootDir, packId), { recursive: true });
    await writeFile(join(packsRootDir, packId, 'model.bin'), Buffer.from(oldBytes));
    await writeFile(join(packsRootDir, packId, 'pack.json'), JSON.stringify({ version: 'v1' }), 'utf8');

    const newBytes = new Uint8Array([5, 6, 7, 8]);
    const manifest: ModelPackManifest = {
      packId,
      kind: 'tts_sherpa',
      model: 'kokoro',
      version: 'v2',
      files: [{ path: 'model.bin', url: 'https://example.com/v2.bin', sha256: sha256Hex(newBytes), sizeBytes: newBytes.length }],
    } as ModelPackManifest;

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: false, status: 500 }) as unknown as Response) as typeof fetch;
    try {
      const host = createTestNodeModelPackInstallerHost({ packsRootDir });
      await expect(
        installModelPackWithHost({ host, packId, manifest, signal: new AbortController().signal }),
      ).rejects.toThrow();
    } finally {
      globalThis.fetch = realFetch;
    }

    // Live pack must survive unchanged.
    const surviving = JSON.parse(await readFile(join(packsRootDir, packId, 'pack.json'), 'utf8'));
    expect(surviving.version).toBe('v1');
    const survivingModel = await readFile(join(packsRootDir, packId, 'model.bin'));
    expect(Array.from(new Uint8Array(survivingModel))).toEqual(Array.from(oldBytes));
  });

  it('restores the exact prior live tree when the durable metadata commit fails after promotion', async () => {
    const packId = 'durableupgrade';
    const oldModel = new Uint8Array([1, 2, 3, 4]);
    const oldManifest = JSON.stringify({ version: 'v1', marker: 'exact-prior-bytes' });
    await mkdir(join(packsRootDir, packId), { recursive: true });
    await writeFile(join(packsRootDir, packId, 'model.bin'), oldModel);
    await writeFile(join(packsRootDir, packId, 'pack.json'), oldManifest, 'utf8');

    const newModel = new Uint8Array([5, 6, 7, 8]);
    const manifest: ModelPackManifest = {
      packId,
      kind: 'tts_sherpa',
      model: 'kokoro',
      version: 'v2',
      files: [{
        path: 'model.bin',
        url: 'https://example.com/v2.bin',
        sha256: sha256Hex(newModel),
        sizeBytes: newModel.length,
      }],
    } as ModelPackManifest;

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => streamResponseForTest(newModel)) as typeof fetch;
    try {
      await expect(installModelPackWithHost({
        host: createTestNodeModelPackInstallerHost({ packsRootDir }),
        packId,
        manifest,
        signal: new AbortController().signal,
        durableCommit: {
          recovery: { kind: 'test', value: null },
          commit: async () => { throw new Error('state_record_failed'); },
          rollback: async () => undefined,
        },
      })).rejects.toThrow('state_record_failed');
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(await readFile(join(packsRootDir, packId, 'model.bin'))).toEqual(Buffer.from(oldModel));
    expect(await readFile(join(packsRootDir, packId, 'pack.json'), 'utf8')).toBe(oldManifest);
    expect(await exists(join(packsRootDir, `.${packId}.backup`))).toBe(false);
    expect(await exists(join(packsRootDir, `.${packId}.promote-intent`))).toBe(false);
  });

  it('removes a first install when its durable metadata commit fails', async () => {
    const packId = 'durablefirst';
    const model = new Uint8Array([5, 6, 7, 8]);
    const manifest: ModelPackManifest = {
      packId,
      kind: 'tts_sherpa',
      model: 'kokoro',
      version: 'v1',
      files: [{
        path: 'model.bin',
        url: 'https://example.com/v1.bin',
        sha256: sha256Hex(model),
        sizeBytes: model.length,
      }],
    } as ModelPackManifest;

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => streamResponseForTest(model)) as typeof fetch;
    try {
      await expect(installModelPackWithHost({
        host: createTestNodeModelPackInstallerHost({ packsRootDir }),
        packId,
        manifest,
        signal: new AbortController().signal,
        durableCommit: {
          recovery: { kind: 'test', value: null },
          commit: async () => { throw new Error('state_record_failed'); },
          rollback: async () => undefined,
        },
      })).rejects.toThrow('state_record_failed');
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(await exists(join(packsRootDir, packId))).toBe(false);
  });

  it('retains rollback_pending recovery when durable metadata rollback fails after bytes restore', async () => {
    const packId = 'rollbackpending';
    const oldModel = new Uint8Array([1, 2, 3, 4]);
    await mkdir(join(packsRootDir, packId), { recursive: true });
    await writeFile(join(packsRootDir, packId, 'model.bin'), oldModel);
    await writeFile(join(packsRootDir, packId, 'pack.json'), JSON.stringify({ version: 'v1' }), 'utf8');
    const newModel = new Uint8Array([5, 6, 7, 8]);
    const manifest: ModelPackManifest = {
      packId,
      kind: 'tts_sherpa',
      model: 'kokoro',
      version: 'v2',
      files: [{ path: 'model.bin', url: 'https://example.com/v2.bin', sha256: sha256Hex(newModel), sizeBytes: newModel.length }],
    } as ModelPackManifest;
    const controller = new AbortController();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => streamResponseForTest(newModel)) as typeof fetch;
    try {
      await expect(installModelPackWithHost({
        host: createTestNodeModelPackInstallerHost({ packsRootDir }),
        packId,
        manifest,
        signal: controller.signal,
        durableCommit: {
          recovery: { kind: 'test', value: { before: 'v1', after: 'v2' } },
          commit: async () => { controller.abort(); },
          rollback: async () => { throw new Error('metadata_rollback_failed'); },
        },
      })).rejects.toThrow('aborted');
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(await readFile(join(packsRootDir, packId, 'model.bin'))).toEqual(Buffer.from(oldModel));
    await expect(readFile(join(packsRootDir, `.${packId}.promote-intent`), 'utf8'))
      .resolves.toContain('rollback_pending');
  });

  it('keeps the promote intent when rollback restore fails after live was moved to backup', async () => {
    const packId = 'restorefail';
    const liveDir = join(packsRootDir, packId);
    const scratchDir = join(packsRootDir, `.${packId}.scratch`);
    const backupDir = join(packsRootDir, `.${packId}.backup`);
    const intentFile = join(packsRootDir, `.${packId}.promote-intent`);

    const oldBytes = new Uint8Array([1, 2, 3, 4]);
    await mkdir(liveDir, { recursive: true });
    await writeFile(join(liveDir, 'model.bin'), Buffer.from(oldBytes));
    await writeFile(join(liveDir, 'pack.json'), JSON.stringify({ version: 'v1' }), 'utf8');

    const newBytes = new Uint8Array([5, 6, 7, 8]);
    const manifest: ModelPackManifest = {
      packId,
      kind: 'tts_sherpa',
      model: 'kokoro',
      version: 'v2',
      files: [{ path: 'model.bin', url: 'https://example.com/v2.bin', sha256: sha256Hex(newBytes), sizeBytes: newBytes.length }],
    } as ModelPackManifest;

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => streamResponseForTest(newBytes)) as typeof fetch;
    try {
      const realRename = await import('node:fs/promises').then((mod) => mod.rename);
      const host = createTestNodeModelPackInstallerHost({
        packsRootDir,
        renamePath: async (from, to) => {
          if (from === scratchDir && to === liveDir) {
            throw new Error('promote_failed_after_backup');
          }
          if (from === backupDir && to === liveDir) {
            throw new Error('restore_failed');
          }
          return realRename(from, to);
        },
      });

      await expect(
        installModelPackWithHost({ host, packId, manifest, signal: new AbortController().signal }),
      ).rejects.toThrow('promote_failed_after_backup');

      expect(await exists(intentFile)).toBe(true);
      expect(await exists(backupDir)).toBe(true);
      expect(await exists(liveDir)).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

function streamResponseForTest(bytes: Uint8Array): Response {
  let delivered = false;
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-length' ? String(bytes.length) : null) },
    body: {
      getReader: () => ({
        read: async () => {
          if (delivered) return { done: true, value: undefined };
          delivered = true;
          return { done: false, value: bytes };
        },
      }),
    },
  } as unknown as Response;
}

it('copies installed bytes into independent staging without changing live bytes', async () => {
  const packsRootDir = await mkdtemp(join(tmpdir(), 'happier-pr560-copy-'));
  try {
    const live = join(packsRootDir, 'example');
    await mkdir(live);
    const bytes = new Uint8Array([1, 2, 3]);
    await writeFile(join(live, 'model.bin'), bytes);
    const manifest = { packId: 'example', kind: 'tts_sherpa' as const, model: 'kokoro', version: 'v1',
      files: [{ path: 'model.bin', url: 'https://example.com/model.bin', sha256: 'a'.repeat(64), sizeBytes: 3 }] };
    const host = createNodeModelPackInstallerHost({ packsRootDir });
    const staging = await host.beginStaging('example', deriveModelPackStagingPlan(manifest));
    try {
      expect(await staging.copyInstalledFile('missing.bin')).toBe(false);
      expect(await staging.copyInstalledFile('model.bin')).toBe(true);
      expect(await staging.partialByteLength('model.bin')).toBe(3);
      const chunks: Uint8Array[] = [];
      expect(await staging.streamPartial('model.bin', chunk => { chunks.push(chunk); })).toBe(3);
      expect(Buffer.concat(chunks)).toEqual(Buffer.from(bytes));
      await staging.appendDownloadedChunk('model.bin', new Uint8Array([4]));
      expect(await readFile(join(live, 'model.bin'))).toEqual(Buffer.from(bytes));
    } finally { await staging.cleanup(); }
  } finally { await rm(packsRootDir, { recursive: true, force: true }); }
});
