import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { ensureModelPackInstalled } from '@/voice/modelPacks/installer.native';
import { createMemFs } from '@/voice/modelPacks/installerTestFs';

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

describe('modelPacks installer (native) atomicity', () => {
  it('keeps the previously-installed pack intact when an update download fails', async () => {
    const { fs, files } = createMemFs();
    const packDir = 'file:///docs/happier/voice/modelPacks/example';

    const oldBytes = new Uint8Array([1, 2, 3, 4]);
    const oldSha = sha256Hex(oldBytes);
    const oldManifest = {
      packId: 'example',
      kind: 'tts_sherpa',
      model: 'kokoro',
      version: 'v1',
      files: [{ path: 'model.onnx', url: 'https://example.com/model.onnx', sha256: oldSha, sizeBytes: oldBytes.length }],
    };

    // Seed an installed pack: live model file + meta.
    files.set(`${packDir}/model.onnx`, oldBytes);
    files.set(`${packDir}/pack.json`, new TextEncoder().encode(JSON.stringify({ manifest: oldManifest })));

    // Remote manifest v2 differs (forces refresh) but its download fails.
    const newSha = sha256Hex(new Uint8Array([9, 9, 9, 9]));
    const fetchImpl = async (url: string) => {
      if (url.includes('manifest.json')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            packId: 'example',
            kind: 'tts_sherpa',
            model: 'kokoro',
            version: 'v2',
            files: [{ path: 'model.onnx', url: 'https://example.com/model-v2.onnx', sha256: newSha, sizeBytes: 4 }],
          }),
        } as any;
      }
      // The new file download fails — this is the data-loss trigger.
      return { ok: false, status: 500 } as any;
    };

    await expect(
      ensureModelPackInstalled(
        {
          packId: 'example',
          mode: 'download_if_missing',
          updatePolicy: 'manual_update_if_available',
          manifestUrl: 'https://example.com/manifest.json',
          timeoutMs: 5000,
          signal: new AbortController().signal,
        },
        { fs, fetch: fetchImpl as any },
      ),
    ).rejects.toThrow();

    // DATA-LOSS GUARD: the live pack must still be present and unchanged.
    const survivingMeta = files.get(`${packDir}/pack.json`);
    expect(survivingMeta, 'live pack.json must survive a failed update').toBeDefined();
    const parsed = JSON.parse(new TextDecoder().decode(survivingMeta!));
    expect(parsed?.manifest?.version).toBe('v1');

    const survivingModel = files.get(`${packDir}/model.onnx`);
    expect(survivingModel, 'live model file must survive a failed update').toBeDefined();
    expect(Array.from(survivingModel!)).toEqual(Array.from(oldBytes));

    // No staging/backup leftovers should remain in the packs root.
    const leftovers = Array.from(files.keys()).filter(
      (k) => k.includes('.staging-') || k.includes('.backup-'),
    );
    expect(leftovers).toEqual([]);
  });

  it('atomically swaps to the new pack on a successful update', async () => {
    const { fs, files } = createMemFs();
    const packDir = 'file:///docs/happier/voice/modelPacks/example';

    const oldBytes = new Uint8Array([1, 2, 3, 4]);
    const oldSha = sha256Hex(oldBytes);
    const oldManifest = {
      packId: 'example',
      kind: 'tts_sherpa',
      model: 'kokoro',
      version: 'v1',
      files: [{ path: 'model.onnx', url: 'https://example.com/model.onnx', sha256: oldSha, sizeBytes: oldBytes.length }],
    };
    files.set(`${packDir}/model.onnx`, oldBytes);
    files.set(`${packDir}/pack.json`, new TextEncoder().encode(JSON.stringify({ manifest: oldManifest })));

    const newBytes = new Uint8Array([5, 6, 7, 8]);
    const newSha = sha256Hex(newBytes);
    const fetchImpl = async (url: string) => {
      if (url.includes('manifest.json')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            packId: 'example',
            kind: 'tts_sherpa',
            model: 'kokoro',
            version: 'v2',
            files: [{ path: 'model.onnx', url: 'https://example.com/model-v2.onnx', sha256: newSha, sizeBytes: newBytes.length }],
          }),
        } as any;
      }
      return {
        ok: true,
        status: 200,
        headers: { get: (k: string) => (k.toLowerCase() === 'content-length' ? String(newBytes.length) : null) },
        body: {
          getReader() {
            let done = false;
            return {
              async read() {
                if (done) return { done: true, value: undefined };
                done = true;
                return { done: false, value: newBytes };
              },
            };
          },
        },
      } as any;
    };

    const result = await ensureModelPackInstalled(
      {
        packId: 'example',
        mode: 'download_if_missing',
        updatePolicy: 'manual_update_if_available',
        manifestUrl: 'https://example.com/manifest.json',
        timeoutMs: 5000,
        signal: new AbortController().signal,
      },
      { fs, fetch: fetchImpl as any },
    );

    expect(result.manifest.version).toBe('v2');

    const meta = files.get(`${packDir}/pack.json`);
    expect(meta).toBeDefined();
    expect(JSON.parse(new TextDecoder().decode(meta!))?.manifest?.version).toBe('v2');

    const model = files.get(`${packDir}/model.onnx`);
    expect(model).toBeDefined();
    expect(Array.from(model!)).toEqual(Array.from(newBytes));

    // No staging/backup leftovers after a successful swap.
    const leftovers = Array.from(files.keys()).filter(
      (k) => k.includes('.staging-') || k.includes('.backup-'),
    );
    expect(leftovers).toEqual([]);
  });
});
