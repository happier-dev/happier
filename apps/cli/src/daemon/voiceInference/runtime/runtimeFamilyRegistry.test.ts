import { describe, expect, it } from 'vitest';

import { getModelPackCatalogEntry } from '@happier-dev/protocol';

import {
  assertDaemonVoiceRuntimeManifestCompatible,
  isDaemonVoiceRuntimeFamilySupported,
  resolveDaemonVoiceRuntimeFamilyCapabilities,
  resolveDaemonVoiceRuntimePackAdapter,
} from './runtimeFamilyRegistry';

function manifest(packId: string, kind: 'stt_sherpa' | 'tts_sherpa', paths: readonly string[]) {
  return {
    packId,
    kind,
    model: packId,
    version: '1.0.0',
    files: paths.map((path, index) => ({
      path,
      url: `https://models.example.test/${index}`,
      sha256: String(index + 1).repeat(64),
      sizeBytes: 1,
    })),
  };
}

const ZIPFORMER_PACK_ID = 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17';

function zipformerCatalogManifest() {
  const entry = getModelPackCatalogEntry(ZIPFORMER_PACK_ID);
  if (!entry || entry.runtimeFamily !== 'sherpa_zipformer_streaming') {
    throw new Error('expected canonical Zipformer catalog entry');
  }
  const runtimePaths = Object.values(entry.runtimeArtifacts).map((artifact) => artifact.path);
  const omittedRuntimePath = runtimePaths[0];
  if (!omittedRuntimePath) {
    throw new Error('expected canonical Zipformer runtime artifacts');
  }
  return {
    manifest: manifest(entry.packId, entry.kind, [
      ...runtimePaths,
      ...(entry.supportArtifacts ?? []).map((artifact) => artifact.path),
    ]),
    omittedRuntimePath,
  };
}

describe('daemon voice runtime-family registry', () => {
  it('owns the advertised ABI capability map for every supported runtime family', () => {
    const capabilities = resolveDaemonVoiceRuntimeFamilyCapabilities();
    expect(capabilities).toEqual({
      sherpa_zipformer_streaming: { abiVersion: 1 },
      sherpa_kokoro_offline: { abiVersion: 1 },
    });
    expect(Object.isFrozen(capabilities)).toBe(true);
    expect(Object.values(capabilities).every((entry) => Object.isFrozen(entry))).toBe(true);
    expect(isDaemonVoiceRuntimeFamilySupported('sherpa_zipformer_streaming')).toBe(true);
    expect(isDaemonVoiceRuntimeFamilySupported('sherpa_kokoro_offline')).toBe(true);
    expect(isDaemonVoiceRuntimeFamilySupported('sherpa_parakeet_offline')).toBe(false);
  });

  it('admits verified Zipformer support files but resolves only executable runtime paths', () => {
    const { manifest: published } = zipformerCatalogManifest();
    expect(() => assertDaemonVoiceRuntimeManifestCompatible(ZIPFORMER_PACK_ID, published)).not.toThrow();
    expect(resolveDaemonVoiceRuntimePackAdapter(ZIPFORMER_PACK_ID, '/models/zipformer', published)).toEqual({
      runtimeFamily: 'sherpa_zipformer_streaming',
      files: {
        encoder: '/models/zipformer/encoder.onnx',
        decoder: '/models/zipformer/decoder.onnx',
        joiner: '/models/zipformer/joiner.onnx',
        tokens: '/models/zipformer/tokens.txt',
      },
    });
  });
  it('resolves supported family file roles from the catalog semantic artifact declaration', () => {
    const { manifest: zipformerManifest } = zipformerCatalogManifest();
    expect(resolveDaemonVoiceRuntimePackAdapter(
      ZIPFORMER_PACK_ID,
      '/models/zipformer',
      zipformerManifest,
    )).toEqual({
      runtimeFamily: 'sherpa_zipformer_streaming',
      files: {
        encoder: '/models/zipformer/encoder.onnx',
        decoder: '/models/zipformer/decoder.onnx',
        joiner: '/models/zipformer/joiner.onnx',
        tokens: '/models/zipformer/tokens.txt',
      },
    });
    expect(resolveDaemonVoiceRuntimePackAdapter('kokoro-82m-v1.0-onnx-q8-wasm', '/models/kokoro', manifest(
      'kokoro-82m-v1.0-onnx-q8-wasm',
      'tts_sherpa',
      [
        'LICENSES/Apache-2.0.txt',
        'LICENSES/GPL-3.0.txt',
        'LICENSES/README.txt',
        'THIRD_PARTY_NOTICES.txt',
        'model.onnx',
        'voices.bin',
        'tokens.txt',
        'espeak-ng-data/en_dict',
      ],
    ))).toEqual({
      runtimeFamily: 'sherpa_kokoro_offline',
      files: {
        model: '/models/kokoro/model.onnx',
        voices: '/models/kokoro/voices.bin',
        tokens: '/models/kokoro/tokens.txt',
        dataDir: '/models/kokoro/espeak-ng-data',
      },
    });
  });

  it('resolves a qualified public pack from its declared runtime contract instead of a built-in id', () => {
    const entry = getModelPackCatalogEntry(ZIPFORMER_PACK_ID);
    if (!entry || entry.runtimeFamily !== 'sherpa_zipformer_streaming') {
      throw new Error('expected canonical Zipformer catalog entry');
    }
    const { manifest: published } = zipformerCatalogManifest();

    expect(resolveDaemonVoiceRuntimePackAdapter(
      'dev.happier.fixture.voice.zipformer/zipformer-en-20m',
      '/models/public-zipformer',
      published,
      {
        family: entry.runtimeFamily,
        artifacts: entry.runtimeArtifacts,
        abiVersion: 1,
        minHostVersion: '0.2.10',
        platforms: ['darwin', 'linux', 'win32'],
        architectures: ['arm64', 'x64'],
      },
      entry.supportArtifacts,
    )).toEqual({
      runtimeFamily: 'sherpa_zipformer_streaming',
      files: {
        encoder: '/models/public-zipformer/encoder.onnx',
        decoder: '/models/public-zipformer/decoder.onnx',
        joiner: '/models/public-zipformer/joiner.onnx',
        tokens: '/models/public-zipformer/tokens.txt',
      },
    });
  });

  it('resolves the staged Parakeet adapter without advertising the family before release gates pass', () => {
    expect(isDaemonVoiceRuntimeFamilySupported('sherpa_parakeet_offline')).toBe(false);
    expect(resolveDaemonVoiceRuntimePackAdapter(
      'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8',
      '/models/parakeet',
      manifest('sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8', 'stt_sherpa', [
        'encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt',
      ]),
    )).toEqual({
      runtimeFamily: 'sherpa_parakeet_offline',
      files: {
        encoder: '/models/parakeet/encoder.int8.onnx',
        decoder: '/models/parakeet/decoder.int8.onnx',
        joiner: '/models/parakeet/joiner.int8.onnx',
        tokens: '/models/parakeet/tokens.txt',
      },
    });
  });

  it('keeps Moonshine unavailable until a verified catalog pack and executable adapter land together', () => {
    expect(isDaemonVoiceRuntimeFamilySupported('sherpa_moonshine_offline')).toBe(false);
    expect(resolveDaemonVoiceRuntimePackAdapter(
      'sherpa-onnx-moonshine-tiny-en-int8',
      '/models/moonshine',
      manifest('sherpa-onnx-moonshine-tiny-en-int8', 'stt_sherpa', ['model.onnx', 'tokens.txt']),
    )).toBeNull();
  });

  it('fails closed when installed metadata omits one catalog-declared runtime file', () => {
    const baseline = zipformerCatalogManifest();
    const missingRuntimeFile = {
      ...baseline.manifest,
      files: baseline.manifest.files.filter((file) => file.path !== baseline.omittedRuntimePath),
    };
    expect(resolveDaemonVoiceRuntimePackAdapter(
      ZIPFORMER_PACK_ID,
      '/models/zipformer',
      missingRuntimeFile,
    )).toBeNull();
  });

});
