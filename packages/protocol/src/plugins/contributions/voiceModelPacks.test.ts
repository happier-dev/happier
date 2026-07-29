import { describe, expect, it } from 'vitest';

import { VOICE_MODEL_PACK_CONTRIBUTION_MAX_FILES_V1 } from '../../voice/modelPacks/contributionV1.js';
import { PluginContributesV2Schema } from './v2.js';

function validVoiceModelPack() {
  return {
    id: 'english-small',
    schemaVersion: 1,
    executionHosts: ['daemon'],
    manifest: {
      schemaVersion: 1,
      kind: 'stt_sherpa',
      model: 'acme-english-small',
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
        minHostVersion: '1.2.0',
        platforms: ['darwin', 'linux'],
        architectures: ['arm64', 'x64'],
      },
      provenance: {
        source: 'https://models.example.test/english-small',
        publisher: 'Acme Speech',
      },
      license: {
        id: 'Apache-2.0',
        title: 'Apache License 2.0',
        url: 'https://www.apache.org/licenses/LICENSE-2.0',
        requiresAcceptance: false,
      },
      files: ['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt'].map((path, index) => ({
        path,
        url: `https://models.example.test/english-small/${path}`,
        sha256: String(index + 1).repeat(64),
        sizeBytes: 1024,
      })),
    },
  } as const;
}

function kokoroVoiceModelPackWithFileCount(fileCount: number) {
  const contribution = validVoiceModelPack();
  const runtimeFiles = [
    { path: 'model.onnx', digit: '1' },
    { path: 'voices.bin', digit: '2' },
    { path: 'tokens.txt', digit: '3' },
  ];
  const dataFiles = Array.from({ length: fileCount - runtimeFiles.length }, (_, index) => ({
    path: `espeak-ng-data/voices/v${String(index).padStart(4, '0')}`,
    digit: String((index % 9) + 1),
  }));
  return {
    ...contribution,
    manifest: {
      ...contribution.manifest,
      kind: 'tts_sherpa',
      runtime: {
        ...contribution.manifest.runtime,
        family: 'sherpa_kokoro_offline',
        artifacts: {
          model: { type: 'file', path: 'model.onnx' },
          voices: { type: 'file', path: 'voices.bin' },
          tokens: { type: 'file', path: 'tokens.txt' },
          data: { type: 'directory_prefix', path: 'espeak-ng-data' },
        },
      },
      files: [...runtimeFiles, ...dataFiles].map(({ path, digit }) => ({
        path,
        url: `https://models.example.test/kokoro/${path}`,
        sha256: digit.repeat(64),
        sizeBytes: 1,
      })),
    },
  };
}

describe('contributes.voiceModelPacks', () => {
  it('parses a declarative V1 model-pack contribution and defaults the family', () => {
    expect(PluginContributesV2Schema.parse({}).voiceModelPacks).toEqual([]);
    expect(PluginContributesV2Schema.parse({ voiceModelPacks: [validVoiceModelPack()] }).voiceModelPacks)
      .toEqual([validVoiceModelPack()]);
  });

  it('rejects duplicate local ids within one plugin', () => {
    expect(PluginContributesV2Schema.safeParse({
      voiceModelPacks: [validVoiceModelPack(), validVoiceModelPack()],
    }).success).toBe(false);
  });

  it('requires bounded reviewable license text when acceptance is required', () => {
    const contribution = validVoiceModelPack();
    const requiringAcceptance = {
      ...contribution,
      manifest: {
        ...contribution.manifest,
        license: {
          ...contribution.manifest.license,
          requiresAcceptance: true,
        },
      },
    };

    expect(PluginContributesV2Schema.safeParse({
      voiceModelPacks: [requiringAcceptance],
    }).success).toBe(false);
    expect(PluginContributesV2Schema.safeParse({
      voiceModelPacks: [{
        ...requiringAcceptance,
        manifest: {
          ...requiringAcceptance.manifest,
          license: {
            ...requiringAcceptance.manifest.license,
            text: 'Exact license terms shown before installation.',
          },
        },
      }],
    }).success).toBe(true);
  });

  it('rejects a missing required role when every remaining manifest file has exactly one owner', () => {
    const contribution = validVoiceModelPack();
    const { tokens, ...artifacts } = contribution.manifest.runtime.artifacts;
    expect(PluginContributesV2Schema.safeParse({
      voiceModelPacks: [{
        ...contribution,
        manifest: {
          ...contribution.manifest,
          runtime: { ...contribution.manifest.runtime, artifacts },
          files: contribution.manifest.files.filter((file) => file.path !== tokens.path),
        },
      }],
    }).success).toBe(false);
  });

  it.each([
    ['unknown roles', {
      ...validVoiceModelPack().manifest.runtime.artifacts,
      vocabulary: { type: 'file', path: 'vocab.txt' },
    }],
    ['duplicate role paths', {
      ...validVoiceModelPack().manifest.runtime.artifacts,
      tokens: { type: 'file', path: 'encoder.onnx' },
    }],
  ])('rejects %s before a pack can be admitted', (_label, artifacts) => {
    const contribution = validVoiceModelPack();
    expect(PluginContributesV2Schema.safeParse({
      voiceModelPacks: [{
        ...contribution,
        manifest: {
          ...contribution.manifest,
          runtime: { ...contribution.manifest.runtime, artifacts },
        },
      }],
    }).success).toBe(false);
  });

  it('rejects non-canonical artifact paths that alias the same filesystem target', () => {
    const contribution = validVoiceModelPack();
    expect(PluginContributesV2Schema.safeParse({
      voiceModelPacks: [{
        ...contribution,
        manifest: {
          ...contribution.manifest,
          runtime: {
            ...contribution.manifest.runtime,
            artifacts: {
              ...contribution.manifest.runtime.artifacts,
              encoder: { type: 'file', path: 'models//encoder.onnx' },
            },
          },
          files: contribution.manifest.files.map((file) => (
            file.path === 'encoder.onnx'
              ? { ...file, path: 'models//encoder.onnx' }
              : file
          )),
        },
      }],
    }).success).toBe(false);
  });

  it('rejects a manifest where one file path is the parent directory of another role', () => {
    const contribution = validVoiceModelPack();
    expect(PluginContributesV2Schema.safeParse({
      voiceModelPacks: [{
        ...contribution,
        manifest: {
          ...contribution.manifest,
          runtime: {
            ...contribution.manifest.runtime,
            artifacts: {
              encoder: { type: 'file', path: 'models' },
              decoder: { type: 'file', path: 'models/decoder.onnx' },
              joiner: { type: 'file', path: 'joiner.onnx' },
              tokens: { type: 'file', path: 'tokens.txt' },
            },
          },
          files: [
            { ...contribution.manifest.files[0], path: 'models' },
            { ...contribution.manifest.files[1], path: 'models/decoder.onnx' },
            contribution.manifest.files[2],
            contribution.manifest.files[3],
          ],
        },
      }],
    }).success).toBe(false);
  });

  it.each([
    'models/encoder.onnx:alternate-stream',
    'models/CON',
    'models/com1.bin',
    'models/encoder\u0001.onnx',
  ])('rejects filesystem-portability hazards before download: %s', (unsafePath) => {
    const contribution = validVoiceModelPack();
    expect(PluginContributesV2Schema.safeParse({
      voiceModelPacks: [{
        ...contribution,
        manifest: {
          ...contribution.manifest,
          runtime: {
            ...contribution.manifest.runtime,
            artifacts: {
              ...contribution.manifest.runtime.artifacts,
              encoder: { type: 'file', path: unsafePath },
            },
          },
          files: contribution.manifest.files.map((file) => (
            file.path === 'encoder.onnx' ? { ...file, path: unsafePath } : file
          )),
        },
      }],
    }).success).toBe(false);
  });

  it('rejects case and Unicode-normalization aliases between manifest file paths', () => {
    const contribution = validVoiceModelPack();
    const artifacts = {
      encoder: { type: 'file' as const, path: 'models/Encoder.onnx' },
      decoder: { type: 'file' as const, path: 'models/encoder.onnx' },
      joiner: { type: 'file' as const, path: 'joiner.onnx' },
      tokens: { type: 'file' as const, path: 'tokens.txt' },
    };
    expect(PluginContributesV2Schema.safeParse({
      voiceModelPacks: [{
        ...contribution,
        manifest: {
          ...contribution.manifest,
          runtime: { ...contribution.manifest.runtime, artifacts },
          files: [
            { ...contribution.manifest.files[0], path: artifacts.encoder.path },
            { ...contribution.manifest.files[1], path: artifacts.decoder.path },
            contribution.manifest.files[2],
            contribution.manifest.files[3],
          ],
        },
      }],
    }).success).toBe(false);

    const decomposed = 'models/cafe\u0301.onnx';
    expect(PluginContributesV2Schema.safeParse({
      voiceModelPacks: [{
        ...contribution,
        manifest: {
          ...contribution.manifest,
          runtime: {
            ...contribution.manifest.runtime,
            artifacts: {
              ...contribution.manifest.runtime.artifacts,
              encoder: { type: 'file', path: decomposed },
            },
          },
          files: contribution.manifest.files.map((file) => (
            file.path === 'encoder.onnx' ? { ...file, path: decomposed } : file
          )),
        },
      }],
    }).success).toBe(false);
  });

  it.each(['ſ.txt', 'Σ.txt', 'ς.txt', '.reſume-plan.json'])(
    'rejects non-ASCII runtime, support, and manifest paths at public schema admission: %s',
    (unsafePath) => {
      const contribution = validVoiceModelPack();
      expect(PluginContributesV2Schema.safeParse({
        voiceModelPacks: [{
          ...contribution,
          manifest: {
            ...contribution.manifest,
            runtime: {
              ...contribution.manifest.runtime,
              artifacts: {
                ...contribution.manifest.runtime.artifacts,
                encoder: { type: 'file', path: unsafePath },
              },
            },
            supportArtifacts: [{ type: 'file', kind: 'notice', path: unsafePath }],
            files: contribution.manifest.files.map((file) => (
              file.path === 'encoder.onnx' ? { ...file, path: unsafePath } : file
            )),
          },
        }],
      }).success).toBe(false);
    },
  );

  it('requires Kokoro files and its directory prefix to own every declared manifest path', () => {
    const contribution = validVoiceModelPack();
    const kokoro = {
      ...contribution,
      manifest: {
        ...contribution.manifest,
        kind: 'tts_sherpa',
        runtime: {
          ...contribution.manifest.runtime,
          family: 'sherpa_kokoro_offline',
          artifacts: {
            model: { type: 'file', path: 'model.onnx' },
            voices: { type: 'file', path: 'voices.bin' },
            tokens: { type: 'file', path: 'tokens.txt' },
            data: { type: 'directory_prefix', path: 'espeak-ng-data' },
          },
        },
        files: [
          ['model.onnx', '1'],
          ['voices.bin', '2'],
          ['tokens.txt', '3'],
          ['espeak-ng-data/en_dict', '4'],
        ].map(([path, digit]) => ({
          path,
          url: `https://models.example.test/kokoro/${path}`,
          sha256: digit!.repeat(64),
          sizeBytes: 1,
        })),
      },
    };
    expect(PluginContributesV2Schema.safeParse({ voiceModelPacks: [kokoro] }).success).toBe(true);
    expect(PluginContributesV2Schema.safeParse({
      voiceModelPacks: [{
        ...kokoro,
        manifest: {
          ...kokoro.manifest,
          files: [...kokoro.manifest.files, {
            path: 'unowned.bin',
            url: 'https://models.example.test/kokoro/unowned.bin',
            sha256: '5'.repeat(64),
            sizeBytes: 1,
          }],
        },
      }],
    }).success).toBe(false);

    expect(PluginContributesV2Schema.safeParse({
      voiceModelPacks: [{
        ...kokoro,
        manifest: {
          ...kokoro.manifest,
          runtime: {
            ...kokoro.manifest.runtime,
            artifacts: {
              ...kokoro.manifest.runtime.artifacts,
              data: { type: 'directory_prefix', path: 'espeak-Σ-data' },
            },
          },
          files: kokoro.manifest.files.map((file) => (
            file.path.startsWith('espeak-ng-data/')
              ? { ...file, path: file.path.replace('espeak-ng-data/', 'espeak-Σ-data/') }
              : file
          )),
        },
      }],
    }).success).toBe(false);
  });

  it('admits the canonical 362-file Kokoro graph with bounded headroom and rejects limit + 1', () => {
    expect(VOICE_MODEL_PACK_CONTRIBUTION_MAX_FILES_V1).toBe(384);
    expect(PluginContributesV2Schema.safeParse({
      voiceModelPacks: [kokoroVoiceModelPackWithFileCount(362)],
    }).success).toBe(true);
    expect(PluginContributesV2Schema.safeParse({
      voiceModelPacks: [kokoroVoiceModelPackWithFileCount(VOICE_MODEL_PACK_CONTRIBUTION_MAX_FILES_V1)],
    }).success).toBe(true);
    expect(PluginContributesV2Schema.safeParse({
      voiceModelPacks: [kokoroVoiceModelPackWithFileCount(VOICE_MODEL_PACK_CONTRIBUTION_MAX_FILES_V1 + 1)],
    }).success).toBe(false);
  });

  it('admits exact declarative support files', () => {
    const contribution = validVoiceModelPack();
    const supportArtifacts = [
      { type: 'file' as const, kind: 'license' as const, path: 'LICENSES/Apache-2.0.txt' },
      { type: 'file' as const, kind: 'license' as const, path: 'LICENSES/GPL-3.0.txt' },
      { type: 'file' as const, kind: 'provenance' as const, path: 'LICENSES/README.txt' },
      { type: 'file' as const, kind: 'notice' as const, path: 'THIRD_PARTY_NOTICES.txt' },
    ];
    expect(PluginContributesV2Schema.safeParse({
      voiceModelPacks: [{
        ...contribution,
        manifest: {
          ...contribution.manifest,
          supportArtifacts,
          files: [
            ...contribution.manifest.files,
            ...supportArtifacts.map((artifact, index) => ({
              path: artifact.path,
              url: `https://models.example.test/english-small/${artifact.path}`,
              sha256: String(index + 5).repeat(64),
              sizeBytes: 128,
            })),
          ],
        },
      }],
    }).success).toBe(true);
  });

  it.each([
    ['missing support file', [{ type: 'file', kind: 'license', path: 'LICENSES/missing.txt' }]],
    ['duplicate support path', [
      { type: 'file', kind: 'license', path: 'LICENSES/Apache-2.0.txt' },
      { type: 'file', kind: 'notice', path: 'LICENSES/Apache-2.0.txt' },
    ]],
    ['runtime overlap', [{ type: 'file', kind: 'license', path: 'encoder.onnx' }]],
    ['unknown support kind', [{ type: 'file', kind: 'executable', path: 'support.bin' }]],
  ])('rejects unsafe support-artifact ownership: %s', (_label, supportArtifacts) => {
    const contribution = validVoiceModelPack();
    expect(PluginContributesV2Schema.safeParse({
      voiceModelPacks: [{
        ...contribution,
        manifest: { ...contribution.manifest, supportArtifacts },
      }],
    }).success).toBe(false);
  });

  it('rejects parent-child overlap between support and runtime file owners', () => {
    const contribution = validVoiceModelPack();
    expect(PluginContributesV2Schema.safeParse({
      voiceModelPacks: [{
        ...contribution,
        manifest: {
          ...contribution.manifest,
          runtime: {
            ...contribution.manifest.runtime,
            artifacts: {
              ...contribution.manifest.runtime.artifacts,
              encoder: { type: 'file', path: 'models/encoder.onnx' },
            },
          },
          supportArtifacts: [{ type: 'file', kind: 'license', path: 'models' }],
          files: contribution.manifest.files.map((file) => file.path === 'encoder.onnx'
            ? { ...file, path: 'models/encoder.onnx' }
            : file),
        },
      }],
    }).success).toBe(false);
  });

  it.each([
    ['callbacks', { ...validVoiceModelPack(), register: () => undefined }],
    ['unsupported execution hosts', { ...validVoiceModelPack(), executionHosts: ['server'] }],
    ['missing immutable digest', {
      ...validVoiceModelPack(),
      manifest: {
        ...validVoiceModelPack().manifest,
        files: [{ ...validVoiceModelPack().manifest.files[0], sha256: undefined }],
      },
    }],
    ['zero-byte files', {
      ...validVoiceModelPack(),
      manifest: {
        ...validVoiceModelPack().manifest,
        files: [{ ...validVoiceModelPack().manifest.files[0], sizeBytes: 0 }],
      },
    }],
    ['credentials in source URLs', {
      ...validVoiceModelPack(),
      manifest: {
        ...validVoiceModelPack().manifest,
        files: [{ ...validVoiceModelPack().manifest.files[0], url: 'https://user:pass@models.example.test/file' }],
      },
    }],
    ['malformed provenance URLs', {
      ...validVoiceModelPack(),
      manifest: {
        ...validVoiceModelPack().manifest,
        provenance: { ...validVoiceModelPack().manifest.provenance, source: 'not a URL' },
      },
    }],
    ['credential-bearing query URLs', {
      ...validVoiceModelPack(),
      manifest: {
        ...validVoiceModelPack().manifest,
        files: [{
          ...validVoiceModelPack().manifest.files[0],
          url: 'https://models.example.test/file?api_key=secret-value',
        }],
      },
    }],
    ['private literal download destinations', {
      ...validVoiceModelPack(),
      manifest: {
        ...validVoiceModelPack().manifest,
        files: [{ ...validVoiceModelPack().manifest.files[0], url: 'https://10.0.0.1/model' }],
      },
    }],
    ['invalid semver numeric prereleases', {
      ...validVoiceModelPack(),
      manifest: { ...validVoiceModelPack().manifest, version: '1.0.0-01' },
    }],
    ['duplicate target platforms', {
      ...validVoiceModelPack(),
      manifest: {
        ...validVoiceModelPack().manifest,
        runtime: { ...validVoiceModelPack().manifest.runtime, platforms: ['darwin', 'darwin'] },
      },
    }],
    ['runtime-family and speech-role mismatches', {
      ...validVoiceModelPack(),
      manifest: {
        ...validVoiceModelPack().manifest,
        kind: 'tts_sherpa',
      },
    }],
    ['duplicate voice ids', {
      ...validVoiceModelPack(),
      manifest: {
        ...validVoiceModelPack().manifest,
        voices: [
          { id: 'default', title: 'Default' },
          { id: 'default', title: 'Duplicate' },
        ],
      },
    }],
    ['executable data hidden in a voice row', {
      ...validVoiceModelPack(),
      manifest: {
        ...validVoiceModelPack().manifest,
        voices: [{ id: 'default', title: 'Default', resolve: () => 'callback' }],
      },
    }],
    ['path traversal', {
      ...validVoiceModelPack(),
      manifest: {
        ...validVoiceModelPack().manifest,
        files: [{ ...validVoiceModelPack().manifest.files[0], path: '../encoder.onnx' }],
      },
    }],
    ['host defaults', { ...validVoiceModelPack(), defaultFor: 'stt_sherpa' }],
  ])('rejects %s', (_label, contribution) => {
    expect(PluginContributesV2Schema.safeParse({ voiceModelPacks: [contribution] }).success).toBe(false);
  });
});
