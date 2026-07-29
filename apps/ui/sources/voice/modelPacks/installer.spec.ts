import { describe, expect, it } from 'vitest';

import { ensureModelPackInstalled, getModelPackInstallSummary, removeModelPack } from '@/voice/modelPacks/installer.native';
import { createMemFs } from '@/voice/modelPacks/installerTestFs';

describe('modelPacks installer (native)', () => {
  it('rejects pack ids that attempt to escape the model packs root directory', async () => {
    class Directory {
      uri: string;
      exists = true;
      constructor(...uris: any[]) {
        const packId = String(uris[uris.length - 1] ?? '');
        this.uri = `file:///docs/happier/voice/modelPacks/${packId}`;
      }
      create() {}
      delete() {}
    }

    class File {
      uri = 'file:///docs/happier/voice/modelPacks/example/pack.json';
      get exists() {
        return false;
      }
      create() {}
      writableStream() {
        return new WritableStream();
      }
      async bytes() {
        return new Uint8Array();
      }
      async text() {
        return '';
      }
      write() {}
      delete() {}
      arrayBuffer() {
        return Promise.resolve(new ArrayBuffer(0));
      }
    }

    await expect(
      ensureModelPackInstalled(
        {
          packId: '../escape',
          mode: 'download_if_missing',
          manifestUrl: 'https://example.com/manifest.json',
          timeoutMs: 5000,
          signal: new AbortController().signal,
        },
        {
          fs: { Directory, File, Paths: { document: 'file:///docs/' } } as any,
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
      {
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
      {
        fs: fs as any,
        fetch: fetchImpl as any,
      },
    );

    expect(requestedFileUrls).toEqual([fileUrl]);
  });

  it('rejects pack manifests that contain unsafe paths', async () => {
    class Directory {
      uri: string;
      exists = false;
      constructor(..._uris: any[]) {
        this.uri = 'file:///docs/happier/voice/modelPacks/example';
      }
      create() {}
      delete() {}
    }
    class File {
      exists = false;
      uri = 'file:///docs/happier/voice/modelPacks/example/pack.json';
      constructor(..._uris: any[]) {}
      async text() {
        return '';
      }
      write() {}
      create() {}
      delete() {}
      async bytes() {
        return new Uint8Array();
      }
      writableStream() {
        return new WritableStream();
      }
    }

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
        {
          fs: { Directory, File, Paths: { document: 'file:///docs/' } } as any,
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
      {
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

  it('removes without throwing when the directory is missing', async () => {
    await expect(
      removeModelPack({ packId: 'kokoro-82m-v1.0-onnx-q8-wasm' }, { fs: createMemFs().fs }),
    ).resolves.toBeUndefined();
  });
});
