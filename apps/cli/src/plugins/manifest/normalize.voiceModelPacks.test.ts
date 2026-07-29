import { describe, expect, it } from 'vitest';

import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

import { readCanonicalPluginManifest } from './normalize.js';

describe('canonical voice model-pack contributions', () => {
  it('preserves validated pure descriptors through installed-plugin normalization', () => {
    const voiceModelPack = {
      id: 'english-small',
      schemaVersion: 1,
      executionHosts: ['daemon'],
      manifest: {
        schemaVersion: 1,
        kind: 'stt_sherpa',
        model: 'english-small',
        version: '1.0.0',
        runtime: {
          family: 'sherpa_zipformer_streaming',
          artifacts: {
            encoder: { type: 'file', path: 'encoder.onnx' },
            decoder: { type: 'file', path: 'decoder.onnx' },
            joiner: { type: 'file', path: 'joiner.onnx' },
            tokens: { type: 'file', path: 'tokens.txt' },
          },
          abiVersion: 1,
          minHostVersion: '1.0.0',
          platforms: ['darwin'],
          architectures: ['arm64'],
        },
        provenance: { source: 'https://models.example.test/english-small', publisher: 'Acme' },
        license: {
          id: 'Apache-2.0',
          title: 'Apache License 2.0',
          url: 'https://models.example.test/license',
          requiresAcceptance: false,
        },
        files: ['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt'].map((path, index) => ({
          path,
          url: `https://models.example.test/english-small/${path}`,
          sha256: String(index + 1).repeat(64),
          sizeBytes: 4,
        })),
      },
    };
    const manifest = readCanonicalPluginManifest(createPluginManifestV2Fixture({
      id: 'acme.speech',
      contributes: { voiceModelPacks: [voiceModelPack] },
      hostAccess: {
        required: [{
          id: 'model-downloads',
          capability: 'network',
          scope: {
            targets: [{ kind: 'fixedOrigin', origin: 'https://models.example.test' }],
          },
          reason: 'Download model assets',
        }],
        optional: [],
      },
    }));

    expect(manifest?.contributes.voiceModelPacks).toEqual([voiceModelPack]);
  });
});
