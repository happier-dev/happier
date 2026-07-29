import { createHash } from 'node:crypto';

import type { ModelPackManifest } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { verifyInstalledModelPackWithHost } from './installedIntegrity.js';

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fixture(bytes: Uint8Array): ModelPackManifest {
  return {
    packId: 'installed-integrity',
    kind: 'tts_sherpa',
    model: 'kokoro',
    version: 'v1',
    files: [{
      path: 'model.bin',
      url: 'https://models.example/model.bin',
      sha256: digest(bytes),
      sizeBytes: bytes.byteLength,
    }],
  } as ModelPackManifest;
}

describe('installed model-pack integrity', () => {
  it('streams and accepts every artifact bound by the installed manifest', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const manifest = fixture(bytes);
    await expect(verifyInstalledModelPackWithHost({
      packId: manifest.packId,
      expectedManifest: manifest,
      actualManifest: manifest,
      host: {
        streamFile: async (_packId, _path, onChunk) => {
          await onChunk(bytes.subarray(0, 2));
          await onChunk(bytes.subarray(2));
          return bytes.byteLength;
        },
      },
    })).resolves.toBeUndefined();
  });

  it('rejects a changed installed manifest before reading artifacts', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const expected = fixture(bytes);
    const actual = { ...expected, version: 'tampered' } as ModelPackManifest;
    let streamed = false;
    await expect(verifyInstalledModelPackWithHost({
      packId: expected.packId,
      expectedManifest: expected,
      actualManifest: actual,
      host: { streamFile: async () => { streamed = true; return 0; } },
    })).rejects.toThrow('model_pack_installed_manifest_mismatch');
    expect(streamed).toBe(false);
  });

  it('rejects same-size artifact tampering by digest', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const tampered = new Uint8Array([4, 3, 2, 1]);
    const manifest = fixture(bytes);
    await expect(verifyInstalledModelPackWithHost({
      packId: manifest.packId,
      expectedManifest: manifest,
      actualManifest: manifest,
      host: {
        streamFile: async (_packId, _path, onChunk) => {
          await onChunk(tampered);
          return tampered.byteLength;
        },
      },
    })).rejects.toThrow('model_pack_installed_sha256_mismatch');
  });
});
