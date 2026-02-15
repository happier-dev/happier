import { describe, expect, it } from 'vitest';

import { ensureModelPackInstalled, getModelPackInstallSummary, removeModelPack } from '@/voice/modelPacks/installer.native';

describe('modelPacks installer (native)', () => {
  it('reports progress without exceeding total (streaming body)', async () => {
    const { createHash } = await import('node:crypto');
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];
    const expectedSha = createHash('sha256').update(Buffer.concat(chunks.map((c) => Buffer.from(c)))).digest('hex');

    const writes = new Map<string, Uint8Array[]>();

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
      uri: string;
      constructor(...uris: any[]) {
        const [base, name] = uris;
        if (base?.uri && typeof name === 'string') {
          this.uri = `${String(base.uri).replace(/\/$/, '')}/${name}`;
        } else if (typeof base === 'string' && typeof name === 'string') {
          this.uri = `${base.replace(/\/$/, '')}/${name}`;
        } else if (typeof uris[0] === 'string') {
          this.uri = uris[0];
        } else {
          this.uri = 'file:///docs/happier/voice/modelPacks/example/pack.json';
        }
      }
      get exists() {
        return writes.has(this.uri);
      }
      create() {
        if (!writes.has(this.uri)) writes.set(this.uri, []);
      }
      writableStream() {
        const uri = this.uri;
        return new WritableStream({
          write(chunk: Uint8Array) {
            const arr = writes.get(uri) ?? [];
            arr.push(new Uint8Array(chunk));
            writes.set(uri, arr);
          },
        });
      }
      async bytes() {
        const arr = writes.get(this.uri) ?? [];
        const total = arr.reduce((acc, b) => acc + b.length, 0);
        const out = new Uint8Array(total);
        let off = 0;
        for (const b of arr) {
          out.set(b, off);
          off += b.length;
        }
        return out;
      }
      async text() {
        const buf = await this.bytes();
        return new TextDecoder().decode(buf);
      }
      write(data: string | Uint8Array) {
        const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        writes.set(this.uri, [new Uint8Array(buf)]);
      }
      delete() {
        writes.delete(this.uri);
      }
      arrayBuffer() {
        return this.bytes().then((b) => b.buffer);
      }
    }

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
        fs: { Directory, File, Paths: { document: 'file:///docs/' } } as any,
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
    const files = new Map<string, Uint8Array>();
    const sha256Byte1 = '4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a';

    class Directory {
      uri: string;
      constructor(...uris: any[]) {
        const packId = String(uris[uris.length - 1] ?? '');
        this.uri = `file:///docs/happier/voice/modelPacks/${packId || 'example'}`;
      }
      create() {}
      delete() {
        // Wipe all tracked files in this directory.
        for (const key of Array.from(files.keys())) {
          if (key.startsWith(this.uri)) files.delete(key);
        }
      }
    }

    class File {
      uri: string;
      constructor(...uris: any[]) {
        const [base, name] = uris;
        if (typeof base === 'string' && typeof name === 'string') {
          this.uri = `${base.replace(/\/$/, '')}/${name}`;
        } else if (base?.uri && typeof name === 'string') {
          this.uri = `${String(base.uri).replace(/\/$/, '')}/${name}`;
        } else if (typeof uris[0] === 'string') {
          this.uri = uris[0];
        } else {
          this.uri = 'file:///docs/happier/voice/modelPacks/example/pack.json';
        }
      }
      get exists() {
        return files.has(this.uri);
      }
      async text() {
        const buf = files.get(this.uri) ?? new Uint8Array();
        return new TextDecoder().decode(buf);
      }
      async bytes() {
        return files.get(this.uri) ?? new Uint8Array();
      }
      write(data: string | Uint8Array) {
        const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        files.set(this.uri, new Uint8Array(buf));
      }
      create() {
        if (!files.has(this.uri)) files.set(this.uri, new Uint8Array());
      }
      delete() {
        files.delete(this.uri);
      }
    }

    // Seed an installed pack.json with manifest A.
    const installedMeta = new File('file:///docs/happier/voice/modelPacks/example', 'pack.json');
    installedMeta.write(
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
        fs: { Directory, File, Paths: { document: 'file:///docs/' } } as any,
        fetch: fetchImpl as any,
      },
    );

    // pack.json should now contain version v2.
    const parsed = JSON.parse(await installedMeta.text());
    expect(parsed?.manifest?.version).toBe('v2');
  });

  it('throws when packs are required but not installed', async () => {
    await expect(
      ensureModelPackInstalled(
        {
          packId: 'kokoro-tts-en-v1',
          mode: 'require_installed',
          manifestUrl: null,
          timeoutMs: 5000,
          signal: new AbortController().signal,
        },
        {
          fs: {
            Directory: class {
              uri: string;
              exists = false;
              constructor(..._uris: any[]) {
                this.uri = 'file:///docs/happier/voice/modelPacks/kokoro-tts-en-v1';
              }
              create() {}
              list() {
                return [];
              }
            },
            File: class {
              exists = false;
              uri = 'file:///docs/happier/voice/modelPacks/kokoro-tts-en-v1/pack.json';
              constructor(..._uris: any[]) {}
              async text() {
                return '';
              }
              write() {}
            },
            Paths: { document: 'file:///docs/' },
          },
        },
      ),
    ).rejects.toThrow(/model_pack_not_installed/);
  });

  it('throws when download is requested but manifestUrl is missing', async () => {
    await expect(
      ensureModelPackInstalled(
        {
          packId: 'kokoro-tts-en-v1',
          mode: 'download_if_missing',
          manifestUrl: null,
          timeoutMs: 5000,
          signal: new AbortController().signal,
        },
        {
          fs: {
            Directory: class {
              uri: string;
              exists = false;
              constructor(..._uris: any[]) {
                this.uri = 'file:///docs/happier/voice/modelPacks/kokoro-tts-en-v1';
              }
              create() {}
              list() {
                return [];
              }
            },
            File: class {
              exists = false;
              uri = 'file:///docs/happier/voice/modelPacks/kokoro-tts-en-v1/pack.json';
              constructor(..._uris: any[]) {}
              async text() {
                return '';
              }
              write() {}
            },
            Paths: { document: 'file:///docs/' },
          },
        },
      ),
    ).rejects.toThrow(/model_pack_manifest_url_missing/);
  });

  it('reports not installed when pack.json is missing', async () => {
    const summary = await getModelPackInstallSummary(
      { packId: 'kokoro-tts-en-v1' },
      {
        fs: {
          Directory: class {
            uri: string;
            exists = false;
            constructor(..._uris: any[]) {
              this.uri = 'file:///docs/happier/voice/modelPacks/kokoro-tts-en-v1';
            }
            create() {}
          },
          File: class {
            exists = false;
            uri = 'file:///docs/happier/voice/modelPacks/kokoro-tts-en-v1/pack.json';
            constructor(..._uris: any[]) {}
            async text() {
              return '';
            }
          },
          Paths: { document: 'file:///docs/' },
        },
      },
    );

    expect(summary.installed).toBe(false);
    expect(summary.manifest).toBe(null);
  });

  it('removes without throwing when the directory is missing', async () => {
    await expect(
      removeModelPack(
        { packId: 'kokoro-tts-en-v1' },
        {
          fs: {
            Directory: class {
              exists = false;
              uri = 'file:///docs/happier/voice/modelPacks/kokoro-tts-en-v1';
              constructor(..._uris: any[]) {}
              delete() {}
            },
            File: class {
              exists = false;
              uri = 'file:///docs/happier/voice/modelPacks/kokoro-tts-en-v1/pack.json';
              constructor(..._uris: any[]) {}
            },
            Paths: { document: 'file:///docs/' },
          },
        },
      ),
    ).resolves.toBeUndefined();
  });
});
