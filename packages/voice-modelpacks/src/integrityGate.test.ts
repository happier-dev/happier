import { describe, expect, it } from 'vitest';

import type { ModelPackManifest } from '@happier-dev/protocol';

import { assertManifestIntegrityVerifiable } from './integrityGate.js';

function manifestWith(files: ModelPackManifest['files']): ModelPackManifest {
  return { packId: 'p', kind: 'tts_sherpa', model: 'm', version: 'v1', files };
}

describe('assertManifestIntegrityVerifiable', () => {
  it('accepts files with a 64-hex digest and positive size', () => {
    expect(() =>
      assertManifestIntegrityVerifiable(
        manifestWith([{ path: 'm.onnx', url: 'https://x/y', sha256: 'a'.repeat(64), sizeBytes: 10 }]),
      ),
    ).not.toThrow();
  });

  it('refuses a missing/short/invalid digest', () => {
    expect(() =>
      assertManifestIntegrityVerifiable(
        manifestWith([{ path: 'm.onnx', url: 'https://x/y', sha256: 'abc', sizeBytes: 10 }]),
      ),
    ).toThrow('model_pack_missing_digest');
  });

  it('refuses a zero or negative size', () => {
    expect(() =>
      assertManifestIntegrityVerifiable(
        manifestWith([{ path: 'm.onnx', url: 'https://x/y', sha256: 'a'.repeat(64), sizeBytes: 0 }]),
      ),
    ).toThrow('model_pack_missing_size');
  });

  it('refuses an empty file list', () => {
    expect(() => assertManifestIntegrityVerifiable(manifestWith([]))).toThrow('model_pack_no_files');
  });
});
