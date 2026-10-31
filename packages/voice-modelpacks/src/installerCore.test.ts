import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { ModelPackManifest } from '@happier-dev/protocol/voice/modelPacks/manifest';
import { VOICE_MODEL_PACK_CONTRIBUTION_MAX_FILES_V1 } from '@happier-dev/protocol/voice/modelPacks/contributionV1';

import { deriveModelPackStagingPlan, installModelPackWithHost } from './installerCore.js';
import { createMemoryModelPackInstallerHost, type MemoryHostState } from './installerCore.testHost.js';

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

function manifestFor(files: ModelPackManifest['files']): ModelPackManifest {
  return {
    packId: 'example',
    kind: 'tts_sherpa',
    model: 'kokoro',
    version: 'v1',
    files,
  };
}

function runInstall(
  host: ReturnType<typeof createMemoryModelPackInstallerHost>,
  manifest: ModelPackManifest,
  opts: {
    onProgress?: (p: { loaded: number; total: number; file?: string }) => void;
    urlPolicy?: { allowedHosts?: readonly string[] };
    resourcePolicy?: { maxFiles: number; maxFileBytes: number; maxTotalBytes: number };
  } = {},
) {
  return installModelPackWithHost({
    host: host.host,
    packId: manifest.packId,
    manifest,
    signal: new AbortController().signal,
    urlPolicy: opts.urlPolicy,
    resourcePolicy: opts.resourcePolicy,
    onProgress: opts.onProgress,
  });
}

describe('installModelPackWithHost (shared core)', () => {
  it('withdraws rejected existing bytes before downloading their replacement', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const memory = createMemoryModelPackInstallerHost();
    const url = 'https://example.com/model.onnx';
    const manifest = manifestFor([
      { path: 'model.onnx', url, sha256: sha256Hex(bytes), sizeBytes: bytes.length },
    ]);
    memory.seedPartialDownload('example/model.onnx', new Uint8Array(bytes.length).fill(9), deriveModelPackStagingPlan(manifest).key);
    memory.serveFile(url, bytes, { chunks: [bytes.slice(0, 2), bytes.slice(2)] });
    const progress: unknown[] = [];
    let replacementStartedAt: unknown;
    await installModelPackWithHost({
      host: { ...memory.host, openDownload: async request => {
        replacementStartedAt = progress.at(-1);
        return memory.host.openDownload(request);
      } },
      packId: manifest.packId, manifest, signal: new AbortController().signal,
      onProgress: event => progress.push(event),
    });
    expect(replacementStartedAt).toMatchObject({ loaded: 0, verified: 0, filesDone: 0 });
    expect(progress).toContainEqual(expect.objectContaining({ loaded: 2, verified: 2, filesDone: 0 }));
    expect(progress.at(-1)).toMatchObject({ loaded: bytes.length, verified: bytes.length, filesDone: 1 });
    expect(memory.read('example/model.onnx')).toEqual(bytes);
  });

  it.each([0, 2])('keeps progress monotonic when transport completes before verification with prefix %i', async (prefixLength) => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const host = createMemoryModelPackInstallerHost();
    host.serveFile('https://example.com/model.onnx', bytes, { chunks: [bytes.slice(0, 2), bytes.slice(2)] });
    const manifest = manifestFor([
      { path: 'model.onnx', url: 'https://example.com/model.onnx', sha256: sha256Hex(bytes), sizeBytes: bytes.length },
    ]);
    if (prefixLength) host.seedPartialDownload('example/model.onnx', bytes.slice(0, prefixLength), deriveModelPackStagingPlan(manifest).key);
    const baseHost = host.host;
    const loaded: number[] = [];
    const progress: Array<{ loaded: number; verified: number }> = [];
    let beforeReplacementRead: { loaded: number; verified: number } | undefined;
    await installModelPackWithHost({
      host: {
        ...baseHost,
        openDownload: async (request) => {
          request.onProgress?.(bytes.length);
          // The server ignores Range and sends a complete replacement response.
          const stream = await baseHost.openDownload({ ...request, rangeStart: undefined });
          let firstRead = true;
          return { ...stream, read: async () => {
            if (firstRead) {
              firstRead = false;
              beforeReplacementRead = progress.at(-1);
            }
            return stream.read();
          } };
        },
      },
      packId: manifest.packId, manifest, signal: new AbortController().signal,
      onProgress: (event) => {
        loaded.push(event.loaded);
        progress.push({ loaded: event.loaded, verified: event.verified });
        expect(event.total).toBe(bytes.length);
      },
    });
    // A full native transfer already arrived, but its replacement hash starts
    // at zero after the Range prefix and its hasher are discarded.
    expect(beforeReplacementRead).toEqual({ loaded: bytes.length, verified: 0 });
    expect(loaded[prefixLength ? 1 : 0]).toBe(bytes.length);
    expect(loaded.every((value, index) => value <= bytes.length && value >= (loaded[index - 1] ?? 0))).toBe(true);
    expect(progress.at(-1)).toEqual({ loaded: bytes.length, verified: bytes.length });
    expect(host.read('example/model.onnx')).toEqual(bytes);
  });

  it('stops a cancelled partial rehash without discarding its resumable prefix', async () => {
    const bytes = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
    const host = createMemoryModelPackInstallerHost();
    host.serveFile('https://example.com/model.onnx', bytes);
    const manifest = manifestFor([
      { path: 'model.onnx', url: 'https://example.com/model.onnx', sha256: sha256Hex(bytes), sizeBytes: bytes.length },
    ]);
    host.seedPartialDownload('example/model.onnx', bytes.slice(0, 4), deriveModelPackStagingPlan(manifest).key);
    const baseHost = host.host;
    let partialChunks = 0;
    const streamingHost = {
      ...baseHost,
      beginStaging: async (...args: Parameters<typeof baseHost.beginStaging>) => {
        const staging = await baseHost.beginStaging(...args);
        return {
          ...staging,
          streamPartial: async (_path: string, onChunk: (chunk: Uint8Array) => void | Promise<void>) => {
            for (const chunk of [bytes.slice(0, 2), bytes.slice(2, 4)]) {
              partialChunks += 1;
              await onChunk(chunk);
            }
            return 4;
          },
        };
      },
    };
    const controller = new AbortController();
    await expect(installModelPackWithHost({ host: streamingHost, packId: manifest.packId, manifest,
      signal: controller.signal, onProgress: () => controller.abort() })).rejects.toThrow('aborted');
    expect(partialChunks).toBe(1);
    expect(host.requestedUrls()).toEqual([]);
    await runInstall(host, manifest);
    expect(host.rangeRequestsFor('https://example.com/model.onnx')).toEqual([{ start: 4 }]);
    expect(host.read('example/model.onnx')).toEqual(bytes);
  });

  it('binds resumable staging to plugin identity, version, and exact artifact binding', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const manifest = manifestFor([
      { path: 'model.onnx', url: 'https://example.com/model.onnx', sha256: sha256Hex(bytes), sizeBytes: bytes.length },
    ]);
    const source = {
      kind: 'plugin',
      pluginId: 'plugin.example',
      packId: manifest.packId,
      pluginVersion: '1.0.0',
      artifactBinding: {
        kind: 'sourceIntegrity',
        integrity: `sha512-${'a'.repeat(86)}==`,
      },
    } as const;

    const original = deriveModelPackStagingPlan(manifest, source);

    expect(deriveModelPackStagingPlan(manifest, {
      ...source,
      artifactBinding: { kind: 'sourceIntegrity', integrity: `sha512-${'b'.repeat(86)}==` },
    }).key).not.toBe(original.key);
    expect(deriveModelPackStagingPlan(manifest, { ...source, pluginVersion: '1.0.1' }).key).not.toBe(original.key);
    expect(deriveModelPackStagingPlan(manifest, { ...source, pluginId: 'plugin.other' }).key).not.toBe(original.key);
    expect(deriveModelPackStagingPlan(manifest, {
      ...source,
      artifactBinding: {
        kind: 'materialization',
        sourceCustody: { kind: 'development', registeredRootId: 'development-root-1' },
      },
    }).key).not.toBe(original.key);
  });

  it('rejects declared resource excess before staging or network I/O', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const host = createMemoryModelPackInstallerHost();
    host.serveFile('https://example.com/model.onnx', bytes);
    const manifest = manifestFor([
      { path: 'model.onnx', url: 'https://example.com/model.onnx', sha256: sha256Hex(bytes), sizeBytes: bytes.length },
    ]);

    await expect(runInstall(host, manifest, {
      resourcePolicy: { maxFiles: 1, maxFileBytes: 3, maxTotalBytes: 10 },
    })).rejects.toThrow('model_pack_file_size_limit_exceeded');
    expect(host.requestedUrls()).toEqual([]);
    expect(host.leftovers()).toEqual([]);
  });

  it('installs the canonical 362-file Kokoro graph under the shared default file ceiling', async () => {
    expect(VOICE_MODEL_PACK_CONTRIBUTION_MAX_FILES_V1).toBeGreaterThanOrEqual(362);
    const host = createMemoryModelPackInstallerHost();
    const files = Array.from({ length: 362 }, (_, index) => {
      const bytes = new Uint8Array([index % 251]);
      const path = `espeak-ng-data/voices/v${String(index).padStart(4, '0')}`;
      const url = `https://example.com/${path}`;
      host.serveFile(url, bytes);
      return { path, url, sha256: sha256Hex(bytes), sizeBytes: bytes.length };
    });

    const result = await runInstall(host, manifestFor(files));
    expect(result.manifest.files).toHaveLength(362);
    expect(host.requestedUrls()).toHaveLength(362);
    expect(host.leftovers()).toEqual([]);
  });

  it('rejects an unsafe final redirect destination before consuming response bytes', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const memory = createMemoryModelPackInstallerHost();
    const host = {
      ...memory.host,
      openDownload: async () => ({
        contentLength: bytes.length,
        isPartial: false,
        finalUrl: 'https://127.0.0.1/model.onnx',
        resolvedAddresses: ['127.0.0.1'],
        read: async () => bytes,
      }),
    };
    const manifest = manifestFor([
      { path: 'model.onnx', url: 'https://example.com/model.onnx', sha256: sha256Hex(bytes), sizeBytes: bytes.length },
    ]);
    await expect(installModelPackWithHost({
      host,
      packId: manifest.packId,
      manifest,
      signal: new AbortController().signal,
      urlPolicy: { requireResolvedAddresses: true },
    })).rejects.toThrow('model_pack_url_private_destination');
  });

  it('installs a fresh pack: files land under the live dir and pack.json is written', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const host = createMemoryModelPackInstallerHost();
    host.serveFile('https://example.com/model.onnx', bytes);
    const manifest = manifestFor([
      { path: 'model.onnx', url: 'https://example.com/model.onnx', sha256: sha256Hex(bytes), sizeBytes: bytes.length },
    ]);

    const result = await runInstall(host, manifest);

    expect(result.manifest.version).toBe('v1');
    expect(host.read('example/model.onnx')).toEqual(bytes);
    const meta = host.readText('example/pack.json');
    expect(JSON.parse(meta!).manifest.version).toBe('v1');
    expect(host.leftovers()).toEqual([]);
  });

  it('stages and promotes every manifest byte including non-runtime support files', async () => {
    const paths = [
      'LICENSES/Apache-2.0.txt',
      'LICENSES/GPL-3.0.txt',
      'LICENSES/README.txt',
      'THIRD_PARTY_NOTICES.txt',
      'decoder.onnx',
      'encoder.onnx',
      'joiner.onnx',
      'tokens.txt',
    ];
    const host = createMemoryModelPackInstallerHost();
    const files = paths.map((path, index) => {
      const bytes = new Uint8Array([index + 1]);
      const url = `https://example.com/${path}`;
      host.serveFile(url, bytes);
      return { path, url, sha256: sha256Hex(bytes), sizeBytes: bytes.length };
    });
    const manifest = manifestFor(files);

    await runInstall(host, manifest);

    for (const [index, path] of paths.entries()) {
      expect(host.read(`example/${path}`), path).toEqual(new Uint8Array([index + 1]));
    }
    expect(host.requestedUrls()).toEqual(files.map((file) => file.url));
    expect(host.leftovers()).toEqual([]);
  });

  it('rejects + cleans up on sha256 mismatch, leaving no half-state', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const host = createMemoryModelPackInstallerHost();
    host.serveFile('https://example.com/model.onnx', bytes);
    const manifest = manifestFor([
      { path: 'model.onnx', url: 'https://example.com/model.onnx', sha256: 'a'.repeat(64), sizeBytes: bytes.length },
    ]);

    await expect(runInstall(host, manifest)).rejects.toThrow('model_pack_sha256_mismatch');
    expect(host.read('example/model.onnx')).toBeUndefined();
    expect(host.readText('example/pack.json')).toBeUndefined();
    expect(host.leftovers()).toEqual([]);
  });

  it('rejects on size mismatch (downloaded bytes exceed manifest sizeBytes)', async () => {
    const actual = new Uint8Array([1, 2, 3, 4]);
    const host = createMemoryModelPackInstallerHost();
    host.serveFile('https://example.com/model.onnx', actual);
    const cancel = vi.fn();
    const baseHost = host.host;
    const cancellableHost = {
      ...baseHost,
      openDownload: async (...args: Parameters<typeof baseHost.openDownload>) => ({
        ...await baseHost.openDownload(...args),
        cancel,
      }),
    };
    // Manifest claims 1 byte but server returns 4.
    const manifest = manifestFor([
      { path: 'model.onnx', url: 'https://example.com/model.onnx', sha256: sha256Hex(actual.slice(0, 1)), sizeBytes: 1 },
    ]);

    await expect(installModelPackWithHost({
      host: cancellableHost,
      packId: manifest.packId,
      manifest,
      signal: new AbortController().signal,
    })).rejects.toThrow('model_pack_size_mismatch');
    expect(cancel).toHaveBeenCalledOnce();
    expect(host.leftovers()).toEqual([]);
  });

  it('awaits opened-response cleanup when resetting an ignored Range fails', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const host = createMemoryModelPackInstallerHost();
    const manifest = manifestFor([
      { path: 'model.onnx', url: 'https://example.com/model.onnx', sha256: sha256Hex(bytes), sizeBytes: bytes.length },
    ]);
    host.serveFile('https://example.com/model.onnx', bytes);
    host.seedPartialDownload('example/model.onnx', bytes.slice(0, 2), deriveModelPackStagingPlan(manifest).key);
    const baseHost = host.host;
    let resetStarted!: () => void;
    const resetting = new Promise<void>((resolve) => { resetStarted = resolve; });
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { finishCleanup = resolve; });
    let cancelled = false;
    let cleanupFinished = false;
    const install = installModelPackWithHost({
      host: {
        ...baseHost,
        beginStaging: async (...args) => ({
          ...await baseHost.beginStaging(...args),
          resetPartial: async () => { resetStarted(); throw new Error('disk_reset_failed'); },
        }),
        openDownload: async (request) => ({
          ...await baseHost.openDownload({ ...request, rangeStart: undefined }),
          cancel: async () => { cancelled = true; await cleanup; cleanupFinished = true; },
        }),
      },
      packId: manifest.packId, manifest, signal: new AbortController().signal,
    });
    let settled = false;
    const outcome = install.catch((error: unknown) => { settled = true; return error; });
    await Promise.race([resetting, outcome]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const settledBeforeCleanup = settled;
    finishCleanup();
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('disk_reset_failed');
    expect(cancelled).toBe(true);
    expect(settledBeforeCleanup).toBe(false);
    expect(cleanupFinished).toBe(true);
    expect(host.read('example/model.onnx')).toBeUndefined();
  });

  it('resumes a partial download via HTTP Range and completes successfully', async () => {
    const bytes = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
    const host = createMemoryModelPackInstallerHost();
    host.serveFile('https://example.com/model.onnx', bytes);

    const manifest = manifestFor([
      { path: 'model.onnx', url: 'https://example.com/model.onnx', sha256: sha256Hex(bytes), sizeBytes: bytes.length },
    ]);
    // Seed a partial from a previous attempt for this exact immutable plan.
    host.seedPartialDownload('example/model.onnx', bytes.slice(0, 3), deriveModelPackStagingPlan(manifest).key);

    await runInstall(host, manifest);

    // The server must have been asked for the remaining bytes via a Range request.
    const ranges = host.rangeRequestsFor('https://example.com/model.onnx');
    expect(ranges.length).toBeGreaterThan(0);
    expect(ranges.some((r) => r.start === 3)).toBe(true);

    expect(host.read('example/model.onnx')).toEqual(bytes);
    expect(host.leftovers()).toEqual([]);
  });

  it('streams existing partial bytes into the hasher without materializing the whole partial', async () => {
    const bytes = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
    const host = createMemoryModelPackInstallerHost();
    host.serveFile('https://example.com/model.onnx', bytes);
    const manifest = manifestFor([
      { path: 'model.onnx', url: 'https://example.com/model.onnx', sha256: sha256Hex(bytes), sizeBytes: bytes.length },
    ]);
    host.seedPartialDownload('example/model.onnx', bytes.slice(0, 4), deriveModelPackStagingPlan(manifest).key);
    const baseHost = host.host;
    const streamingHost = {
      ...baseHost,
      beginStaging: async (...args: Parameters<typeof baseHost.beginStaging>) => {
        const staging = await baseHost.beginStaging(...args);
        return {
          ...staging,
          readPartial: async () => {
            throw new Error('read_partial_should_not_be_called');
          },
          streamPartial: async (_filePath: string, onChunk: (chunk: Uint8Array) => void | Promise<void>) => {
            await onChunk(bytes.slice(0, 2));
            await onChunk(bytes.slice(2, 4));
            return 4;
          },
        };
      },
    } as typeof baseHost;

    await installModelPackWithHost({
      host: streamingHost,
      packId: manifest.packId,
      manifest,
      signal: new AbortController().signal,
    });

    expect(host.rangeRequestsFor('https://example.com/model.onnx')).toEqual([{ start: 4 }]);
    expect(host.read('example/model.onnx')).toEqual(bytes);
  });

  it('promotes a fully-present partial without any network round-trip', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const host = createMemoryModelPackInstallerHost();
    // No serveFile: any download attempt would 404.
    const manifest = manifestFor([
      { path: 'model.onnx', url: 'https://example.com/model.onnx', sha256: sha256Hex(bytes), sizeBytes: bytes.length },
    ]);
    host.seedPartialDownload('example/model.onnx', bytes, deriveModelPackStagingPlan(manifest).key);

    await runInstall(host, manifest);

    expect(host.requestedUrls()).not.toContain('https://example.com/model.onnx');
    expect(host.read('example/model.onnx')).toEqual(bytes);
    expect(host.leftovers()).toEqual([]);
  });

  it('never promotes an unlisted partial left by an older manifest', async () => {
    const staleBytes = new Uint8Array([7, 7, 7]);
    const currentBytes = new Uint8Array([1, 2, 3, 4]);
    const host = createMemoryModelPackInstallerHost();
    host.seedPartialDownload('example/removed.bin', staleBytes);
    host.serveFile('https://example.com/current.bin', currentBytes);

    const manifest = manifestFor([
      {
        path: 'current.bin',
        url: 'https://example.com/current.bin',
        sha256: sha256Hex(currentBytes),
        sizeBytes: currentBytes.length,
      },
    ]);

    await runInstall(host, manifest);

    expect(host.read('example/current.bin')).toEqual(currentBytes);
    expect(host.read('example/removed.bin')).toBeUndefined();
  });

  it('restore-on-failure: a failed update preserves the prior install', async () => {
    const oldBytes = new Uint8Array([1, 2, 3, 4]);
    const host = createMemoryModelPackInstallerHost();
    const oldManifest = manifestFor([
      { path: 'model.onnx', url: 'https://example.com/v1', sha256: sha256Hex(oldBytes), sizeBytes: oldBytes.length },
    ]);
    oldManifest.version = 'v1';

    // Seed an installed pack.
    host.seedInstalled('example', { 'model.onnx': oldBytes }, oldManifest);

    // New manifest's download fails (server 500).
    const newBytes = new Uint8Array([9, 9, 9, 9]);
    const newManifest = manifestFor([
      { path: 'model.onnx', url: 'https://example.com/v2', sha256: sha256Hex(newBytes), sizeBytes: newBytes.length },
    ]);
    newManifest.version = 'v2';
    host.failUrl('https://example.com/v2');

    await expect(runInstall(host, newManifest)).rejects.toThrow();

    // The prior install survives intact.
    expect(host.read('example/model.onnx')).toEqual(oldBytes);
    const meta = host.readText('example/pack.json');
    expect(JSON.parse(meta!).manifest.version).toBe('v1');
    expect(host.leftovers()).toEqual([]);
  });

  it('atomic swap: a successful update replaces the live pack with no leftovers', async () => {
    const oldBytes = new Uint8Array([1, 2, 3, 4]);
    const host = createMemoryModelPackInstallerHost();
    const oldManifest = manifestFor([
      { path: 'model.onnx', url: 'https://example.com/v1', sha256: sha256Hex(oldBytes), sizeBytes: oldBytes.length },
    ]);
    oldManifest.version = 'v1';
    host.seedInstalled('example', { 'model.onnx': oldBytes }, oldManifest);

    const newBytes = new Uint8Array([5, 6, 7, 8]);
    host.serveFile('https://example.com/v2', newBytes);
    const newManifest = manifestFor([
      { path: 'model.onnx', url: 'https://example.com/v2', sha256: sha256Hex(newBytes), sizeBytes: newBytes.length },
    ]);
    newManifest.version = 'v2';

    const result = await runInstall(host, newManifest);

    expect(result.manifest.version).toBe('v2');
    expect(host.read('example/model.onnx')).toEqual(newBytes);
    expect(JSON.parse(host.readText('example/pack.json')!).manifest.version).toBe('v2');
    expect(host.leftovers()).toEqual([]);
  });

  it('rolls back both live bytes and durable metadata when cancellation wins after metadata commit', async () => {
    const oldBytes = new Uint8Array([1, 2, 3, 4]);
    const newBytes = new Uint8Array([5, 6, 7, 8]);
    const host = createMemoryModelPackInstallerHost();
    const oldManifest = manifestFor([
      { path: 'model.onnx', url: 'https://example.com/v1', sha256: sha256Hex(oldBytes), sizeBytes: oldBytes.length },
    ]);
    oldManifest.version = 'v1';
    host.seedInstalled('example', { 'model.onnx': oldBytes }, oldManifest);
    host.serveFile('https://example.com/v2', newBytes);
    const newManifest = manifestFor([
      { path: 'model.onnx', url: 'https://example.com/v2', sha256: sha256Hex(newBytes), sizeBytes: newBytes.length },
    ]);
    newManifest.version = 'v2';
    const controller = new AbortController();
    let durableVersion = 'v1';

    await expect(installModelPackWithHost({
      host: host.host,
      packId: newManifest.packId,
      manifest: newManifest,
      signal: controller.signal,
      durableCommit: {
        recovery: { kind: 'test', value: null },
        commit: async () => {
          durableVersion = 'v2';
          controller.abort();
        },
        rollback: async () => {
          durableVersion = 'v1';
        },
      },
    })).rejects.toThrow('aborted');

    expect(durableVersion).toBe('v1');
    expect(host.read('example/model.onnx')).toEqual(oldBytes);
    expect(JSON.parse(host.readText('example/pack.json')!).manifest.version).toBe('v1');
  });

  it('reports incremental progress without exceeding total (chunked body)', async () => {
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const host = createMemoryModelPackInstallerHost();
    host.serveFile('https://example.com/model.onnx', bytes, { chunks });
    const manifest = manifestFor([
      { path: 'model.onnx', url: 'https://example.com/model.onnx', sha256: sha256Hex(bytes), sizeBytes: bytes.length },
    ]);

    const progress: Array<{ loaded: number; total: number }> = [];
    await runInstall(host, manifest, { onProgress: (p) => progress.push({ loaded: p.loaded, total: p.total }) });

    expect(progress.length).toBeGreaterThan(1);
    for (const p of progress) {
      expect(p.loaded).toBeLessThanOrEqual(p.total);
    }
    expect(progress[progress.length - 1]!.loaded).toBe(4);
    expect(progress[progress.length - 1]!.total).toBe(4);
  });

  it('rejects manifests with unsafe paths before any download', async () => {
    const host = createMemoryModelPackInstallerHost();
    const manifest = manifestFor([
      { path: '../escape.txt', url: 'https://example.com/escape', sha256: 'a'.repeat(64), sizeBytes: 1 },
    ]);

    await expect(runInstall(host, manifest)).rejects.toThrow('model_pack_invalid_path');
    expect(host.requestedUrls()).not.toContain('https://example.com/escape');
  });

  it.each([
    [['models', 'models/encoder.onnx'], 'model_pack_path_file_directory_conflict'],
    [['models/encoder.onnx', 'models/Encoder.onnx'], 'model_pack_path_alias'],
    [['models/encoder.onnx:alternate-stream'], 'model_pack_invalid_path'],
    [['models/S.txt', 'models/ſ.txt'], 'model_pack_invalid_path'],
    [['models/Σ.txt', 'models/ς.txt'], 'model_pack_invalid_path'],
    [['.reſume-plan.json'], 'model_pack_invalid_path'],
  ] as const)('rejects non-portable or aliasing file topology before staging/network: %j', async (paths, code) => {
    const host = createMemoryModelPackInstallerHost();
    const manifest = manifestFor(paths.map((path, index) => ({
      path,
      url: `https://example.com/${index}`,
      sha256: String(index + 1).repeat(64),
      sizeBytes: 1,
    })));

    await expect(runInstall(host, manifest)).rejects.toThrow(code);
    expect(host.requestedUrls()).toEqual([]);
    expect(host.leftovers()).toEqual([]);
  });

  // SD-M3: refuse to download/promote a pack we cannot verify.
  it('refuses a manifest file lacking a sha256 digest before any download', async () => {
    const host = createMemoryModelPackInstallerHost();
    const manifest = manifestFor([
      // Schema-shaped but with a non-hex placeholder digest.
      { path: 'model.onnx', url: 'https://example.com/model.onnx', sha256: 'not-a-real-digest', sizeBytes: 4 },
    ]);

    await expect(runInstall(host, manifest)).rejects.toThrow('model_pack_missing_digest');
    expect(host.requestedUrls()).toEqual([]);
  });

  it('refuses a manifest file with a non-positive declared size before any download', async () => {
    const host = createMemoryModelPackInstallerHost();
    const manifest = manifestFor([
      { path: 'model.onnx', url: 'https://example.com/model.onnx', sha256: 'a'.repeat(64), sizeBytes: 0 },
    ]);

    await expect(runInstall(host, manifest)).rejects.toThrow('model_pack_missing_size');
    expect(host.requestedUrls()).toEqual([]);
  });

  // SD-L5: only https (+ optional host allowlist).
  it('refuses a non-https download URL before any download', async () => {
    const host = createMemoryModelPackInstallerHost();
    const manifest = manifestFor([
      { path: 'model.onnx', url: 'http://example.com/model.onnx', sha256: 'a'.repeat(64), sizeBytes: 4 },
    ]);

    await expect(runInstall(host, manifest)).rejects.toThrow('model_pack_url_insecure_scheme');
    expect(host.requestedUrls()).toEqual([]);
  });

  it('refuses a download URL whose host is not on the allowlist', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const host = createMemoryModelPackInstallerHost();
    host.serveFile('https://evil.example/model.onnx', bytes);
    const manifest = manifestFor([
      { path: 'model.onnx', url: 'https://evil.example/model.onnx', sha256: sha256Hex(bytes), sizeBytes: bytes.length },
    ]);

    await expect(runInstall(host, manifest, { urlPolicy: { allowedHosts: ['github.com'] } })).rejects.toThrow(
      'model_pack_url_host_not_allowed',
    );
    expect(host.requestedUrls()).toEqual([]);
  });

  it('accepts a download URL whose host is on the allowlist', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const host = createMemoryModelPackInstallerHost();
    host.serveFile('https://github.com/model.onnx', bytes);
    const manifest = manifestFor([
      { path: 'model.onnx', url: 'https://github.com/model.onnx', sha256: sha256Hex(bytes), sizeBytes: bytes.length },
    ]);

    const result = await runInstall(host, manifest, { urlPolicy: { allowedHosts: ['github.com'] } });
    expect(result.packId).toBe('example');
    expect(host.read('example/model.onnx')).toEqual(bytes);
  });
});

// Keep the state type referenced so test-host typing stays in sync.
export type { MemoryHostState };

describe('model-pack transfer intents from PR 560', () => {
  it('reports final staging cleanup failures without hiding a successful install', async () => {
    const memory = createMemoryModelPackInstallerHost();
    const bytes = new Uint8Array([1]);
    const url = 'https://example.com/model';
    memory.serveFile(url, bytes);
    const failure = new Error('temporary_directory_delete_failed');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await installModelPackWithHost({ host: { ...memory.host, beginStaging: async (...args) => ({
        ...await memory.host.beginStaging(...args), cleanup: async () => { throw failure; },
      }) }, packId: 'example', manifest: manifestFor([{ path: 'model.bin', url, sha256: sha256Hex(bytes), sizeBytes: 1 }]), signal: new AbortController().signal });
      expect(memory.read('example/model.bin')).toEqual(bytes);
      expect(warning.mock.calls.flat()).toContain(failure);
    } finally { warning.mockRestore(); }
  });

  it('resumes a network read failure from retained prefix bytes', async () => {
    const memory = createMemoryModelPackInstallerHost();
    const bytes = new Uint8Array([1, 2, 3]);
    const url = 'https://example.com/model';
    memory.serveFile(url, bytes);
    let attempts = 0;
    let cancelled = false;
    await installModelPackWithHost({ host: { ...memory.host, openDownload: async request => {
      attempts += 1;
      if (attempts === 1) {
        let reads = 0;
        return { contentLength: 3, isPartial: false,
          read: async () => { if (reads++ === 0) return bytes.slice(0, 1); throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }); },
          cancel: async () => { cancelled = true; },
        };
      }
      expect(cancelled).toBe(true);
      expect(request.rangeStart).toBe(1);
      expect(request.url).not.toBe(url);
      return memory.host.openDownload({ ...request, url });
    } }, packId: 'example', manifest: manifestFor([{ path: 'model.bin', url, sha256: sha256Hex(bytes), sizeBytes: 3 }]), signal: new AbortController().signal });
    expect(attempts).toBe(2);
    expect(memory.read('example/model.bin')).toEqual(bytes);
  });

  it.each([
    new Error('Unable to download file: Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."'),
    new Error('Unable to download file: Error Domain=NSURLErrorDomain Code=-1009 "The Internet connection appears to be offline."'),
    new Error('Unable to download file: Error Domain=NSURLErrorDomain Code=-1001 "The request timed out."'),
    new Error('Unable to resolve host "example.com": No address associated with hostname'),
    new Error('timeout'),
    Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }),
    new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) }),
  ])('retries platform transport errors without losing their cause: %s', async (failure) => {
    const memory = createMemoryModelPackInstallerHost();
    const bytes = new Uint8Array([1]);
    const url = 'https://example.com/model';
    memory.serveFile(url, bytes);
    let attempts = 0;
    await installModelPackWithHost({ host: { ...memory.host, openDownload: async request => {
      if (attempts++ === 0) throw failure;
      return memory.host.openDownload({ ...request, url });
    } }, packId: 'example', manifest: manifestFor([{ path: 'model.bin', url, sha256: sha256Hex(bytes), sizeBytes: 1 }]), signal: new AbortController().signal });
    expect(attempts).toBe(2);
    expect(memory.read('example/model.bin')).toEqual(bytes);
  });

  it.each([
    new Error('Unable to download file: Error Domain=NSURLErrorDomain Code=-3003 "Cannot write to file"'),
    new Error('write failed: ENOSPC (No space left on device)'),
    new Error('native_start_failed'),
  ])('does not retry permanent native failures: %s', async failure => {
    const memory = createMemoryModelPackInstallerHost();
    const bytes = new Uint8Array([1]);
    let attempts = 0;
    await expect(installModelPackWithHost({ host: { ...memory.host, openDownload: async () => { attempts += 1; throw failure; } },
      packId: 'example', manifest: manifestFor([{ path: 'model.bin', url: 'https://example.com/model', sha256: sha256Hex(bytes), sizeBytes: 1 }]), signal: new AbortController().signal })).rejects.toBe(failure);
    expect(attempts).toBe(1);
  });

  it('reports verification progress after the transfer has delivered every byte', async () => {
    const memory = createMemoryModelPackInstallerHost();
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const url = 'https://example.com/model.onnx';
    memory.serveFile(url, bytes, { chunks: [bytes.slice(0, 2), bytes.slice(2, 4), bytes.slice(4)] });
    const progress: Array<{ loaded: number; total: number; verified: number; filesDone: number; filesTotal: number }> = [];
    await installModelPackWithHost({
      host: { ...memory.host, openDownload: async (request) => {
        // Native hosts finish the transfer before the core reads the file back to verify it.
        request.onProgress?.(bytes.length);
        return memory.host.openDownload(request);
      } },
      packId: 'example', manifest: manifestFor([{ path: 'model.onnx', url, sha256: sha256Hex(bytes), sizeBytes: bytes.length }]),
      signal: new AbortController().signal,
      onProgress: (p) => { progress.push({ loaded: p.loaded, total: p.total, verified: p.verified, filesDone: p.filesDone, filesTotal: p.filesTotal }); },
    });
    expect(progress.some((p) => p.loaded === bytes.length && p.verified > 0 && p.verified < bytes.length && p.filesDone === 0)).toBe(true);
    expect(progress.at(-1)).toEqual({ loaded: bytes.length, total: bytes.length, verified: bytes.length, filesDone: 1, filesTotal: 1 });
  });

  it('keeps verification progress monotonic when a retry rehashes the kept prefix', async () => {
    const memory = createMemoryModelPackInstallerHost();
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const url = 'https://example.com/model.onnx';
    memory.serveFile(url, bytes);
    let opened = 0;
    const verified: number[] = [];
    await installModelPackWithHost({
      host: { ...memory.host, beginStaging: async (packId, plan) => {
        const handle = await memory.host.beginStaging(packId, plan);
        // Real hosts read the kept prefix back in bounded chunks rather than in one buffer.
        return { ...handle, streamPartial: (filePath, onChunk) => handle.streamPartial(filePath, async (chunk) => {
          for (let offset = 0; offset < chunk.byteLength; offset += 1) await onChunk(chunk.slice(offset, offset + 1));
        }) };
      }, openDownload: async (request) => {
        opened += 1;
        if (opened > 1) return memory.host.openDownload({ ...request, url });
        const chunks = [bytes.slice(0, 2), bytes.slice(2, 4)];
        return { contentLength: bytes.length, isPartial: false, read: async () => {
          const chunk = chunks.shift();
          if (!chunk) throw new Error('model_pack_download_failed:503');
          return chunk;
        } };
      } },
      packId: 'example', manifest: manifestFor([{ path: 'model.onnx', url, sha256: sha256Hex(bytes), sizeBytes: bytes.length }]),
      signal: new AbortController().signal,
      onProgress: (p) => { verified.push(p.verified); },
    });
    expect(opened).toBe(2);
    expect(verified).toEqual([...verified].sort((a, b) => a - b));
    expect(verified.at(-1)).toBe(bytes.length);
  });

  it('starts the largest files first so they transfer alongside the small ones', async () => {
    const memory = createMemoryModelPackInstallerHost();
    const small = new Uint8Array([1]);
    const medium = new Uint8Array(16).fill(2);
    const large = new Uint8Array(64).fill(3);
    const smallFiles = Array.from({ length: 8 }, (_, index) => ({
      path: `espeak-ng-data/f${index}`, url: `https://example.com/f${index}`, sha256: sha256Hex(small), sizeBytes: small.length,
    }));
    for (const entry of smallFiles) memory.serveFile(entry.url, small);
    memory.serveFile('https://example.com/large', large);
    memory.serveFile('https://example.com/medium', medium);
    await runInstall(memory, manifestFor([
      ...smallFiles,
      { path: 'model.onnx', url: 'https://example.com/large', sha256: sha256Hex(large), sizeBytes: large.length },
      { path: 'voices.bin', url: 'https://example.com/medium', sha256: sha256Hex(medium), sizeBytes: medium.length },
    ]));
    expect(memory.requestedUrls().slice(0, 2)).toEqual(['https://example.com/large', 'https://example.com/medium']);
  });

  it.each(['valid', 'missing', 'wrong digest', 'truncated'] as const)('reuses unchanged installed bytes only after verification: %s', async (state) => {
    const memory = createMemoryModelPackInstallerHost();
    const bytes = new Uint8Array([1, 2, 3]);
    const changed = new Uint8Array([4, 5, 6]);
    const stable = { path: 'stable.bin', url: 'https://example.com/stable', sha256: sha256Hex(bytes), sizeBytes: bytes.length };
    const entry = { path: 'changed.bin', url: 'https://example.com/changed', sha256: sha256Hex(changed), sizeBytes: changed.length };
    const prior = manifestFor([stable, { ...entry, sha256: '0'.repeat(64) }]);
    const remote = { ...manifestFor([stable, entry]), version: 'v2' };
    const installed: Record<string, Uint8Array> = state === 'missing' ? {} : { 'stable.bin': state === 'truncated' ? bytes.slice(0, 1) : state === 'wrong digest' ? changed : bytes };
    memory.seedInstalled('example', { ...installed, 'changed.bin': bytes, 'dropped.bin': bytes }, prior);
    memory.serveFile(stable.url, bytes);
    memory.serveFile(entry.url, changed);
    await installModelPackWithHost({ host: memory.host, packId: 'example', manifest: remote, priorManifest: prior, signal: new AbortController().signal });
    expect(memory.requestedUrls()).toContain(entry.url);
    expect(memory.requestedUrls().includes(stable.url)).toBe(state !== 'valid');
    expect(memory.read('example/stable.bin')).toEqual(bytes);
    expect(memory.read('example/changed.bin')).toEqual(changed);
    expect(memory.read('example/dropped.bin')).toBeUndefined();
    expect(memory.rangeRequestsFor(stable.url)).toEqual([]);
  });

  it('waits for aborted sibling responses to settle and preserves the first fatal failure', async () => {
    const memory = createMemoryModelPackInstallerHost();
    const bytes = new Uint8Array([1, 2, 3]);
    const files = ['fatal', 'slow'].map(path => ({ path, url: `https://example.com/${path}`, sha256: sha256Hex(bytes), sizeBytes: bytes.length }));
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const siblingStarted = new Promise<void>(resolve => { started = resolve; });
    let settled = false;
    let siblingAborted = false;
    const outcome = installModelPackWithHost({ host: { ...memory.host, openDownload: async request => {
      if (request.url.endsWith('/fatal')) { await siblingStarted; throw new Error('model_pack_download_failed:404'); }
      request.signal.addEventListener('abort', () => { siblingAborted = true; }, { once: true });
      started();
      await waiting;
      throw new Error('aborted');
    } }, packId: 'example', manifest: manifestFor(files), signal: new AbortController().signal }).catch(error => { settled = true; return error; });
    await siblingStarted;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(siblingAborted).toBe(true);
    expect(settled).toBe(false);
    release();
    expect(await outcome).toMatchObject({ message: 'model_pack_download_failed:404' });
    expect(memory.read('example/pack.json')).toBeUndefined();
  });

  it('cancels retry backoff promptly without another transfer', async () => {
    const memory = createMemoryModelPackInstallerHost();
    const bytes = new Uint8Array([1]);
    const controller = new AbortController();
    let attempts = 0;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => { controller.abort(); });
    try {
      await expect(installModelPackWithHost({ host: { ...memory.host, openDownload: async () => { attempts += 1; throw new Error('model_pack_download_failed:503'); } },
        packId: 'example', manifest: manifestFor([{ path: 'model.bin', url: 'https://example.com/model', sha256: sha256Hex(bytes), sizeBytes: 1 }]), signal: controller.signal })).rejects.toThrow('aborted');
      expect(attempts).toBe(1);
    } finally { warning.mockRestore(); }
  });

  it('does not retry local writes even when their error resembles a network failure', async () => {
    const memory = createMemoryModelPackInstallerHost();
    const bytes = new Uint8Array([1]);
    const url = 'https://example.com/model';
    memory.serveFile(url, bytes);
    await expect(installModelPackWithHost({ host: { ...memory.host, beginStaging: async (...args) => ({
      ...await memory.host.beginStaging(...args), appendDownloadedChunk: async () => { throw new Error('connection reset'); },
    }) }, packId: 'example', manifest: manifestFor([{ path: 'model.bin', url, sha256: sha256Hex(bytes), sizeBytes: 1 }]), signal: new AbortController().signal })).rejects.toThrow('connection reset');
    expect(memory.requestedUrls()).toEqual([url]);
  });

  it('downloads independent files concurrently and reports verified file counts', async () => {
    const memory = createMemoryModelPackInstallerHost();
    const bytes = new Uint8Array([1, 2, 3]);
    const files = Array.from({ length: 12 }, (_, index) => ({
      path: `lang/f${index}`, url: `https://example.com/f${index}`,
      sha256: sha256Hex(bytes), sizeBytes: bytes.length,
    }));
    for (const entry of files) memory.serveFile(entry.url, bytes);
    let active = 0;
    let peak = 0;
    let finalProgress: unknown;
    await installModelPackWithHost({
      host: {
        ...memory.host,
        openDownload: async (request) => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise(resolve => setTimeout(resolve, 5));
          active -= 1;
          return memory.host.openDownload(request);
        },
      },
      packId: 'example', manifest: manifestFor(files), signal: new AbortController().signal,
      onProgress: progress => { finalProgress = progress; },
    });
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(6);
    expect(finalProgress).toMatchObject({ loaded: 36, total: 36, filesDone: 12, filesTotal: 12 });
    for (const entry of files) expect(memory.read(`example/${entry.path}`)).toEqual(bytes);
  });

  it('retries a transient HTTP response using a cache-distinct URL', async () => {
    const memory = createMemoryModelPackInstallerHost();
    const bytes = new Uint8Array([1, 2, 3]);
    const url = 'https://example.com/model.bin?v=one';
    memory.serveFile(url, bytes);
    const requests: string[] = [];
    await installModelPackWithHost({
      host: {
        ...memory.host,
        openDownload: async (request) => {
          requests.push(request.url);
          if (requests.length === 1) throw new Error('model_pack_download_failed:503');
          return memory.host.openDownload({ ...request, url });
        },
      },
      packId: 'example', manifest: manifestFor([{ path: 'model.bin', url, sha256: sha256Hex(bytes), sizeBytes: bytes.length }]),
      signal: new AbortController().signal,
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]).not.toBe(url);
    expect(new URL(requests[1]!).searchParams.get('v')).toBe('one');
    expect(memory.read('example/model.bin')).toEqual(bytes);
  });
});
