import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  VOICE_MODEL_PACK_CONTRIBUTION_MAX_FILES_V1,
  type ModelPackManifest,
} from '@happier-dev/protocol';

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
      artifactBinding: { kind: 'materialization', immutableGenerationId: 'generation-local-1' },
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
