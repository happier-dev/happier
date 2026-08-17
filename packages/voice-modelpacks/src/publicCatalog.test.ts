import { describe, expect, it } from 'vitest';

import type { VoiceModelPackContributionV1 } from '@happier-dev/protocol';

import {
  admitVoiceModelPackContributionV1,
  assertVoiceModelPackStoredIdentityV1,
  buildVoiceModelPackInstallUrlPolicyV1,
  deriveVoiceModelPackDirectoryKeyV1,
  deriveVoiceModelPackLicenseTextDigestV1,
  deriveVoiceModelPackManifestDigestV1,
  type InstalledPluginVoiceModelPackSourceV1,
} from './publicCatalog.js';

function contribution(overrides: Partial<VoiceModelPackContributionV1> = {}): VoiceModelPackContributionV1 {
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
        platforms: ['darwin'],
        architectures: ['arm64'],
      },
      provenance: { source: 'https://models.example.test/english-small', publisher: 'Acme' },
      license: {
        id: 'Apache-2.0',
        title: 'Apache License 2.0',
        url: 'https://licenses.example.test/apache-2.0',
        requiresAcceptance: false,
      },
      files: ['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt'].map((path, index) => ({
        path,
        url: `https://models.example.test/english-small/${path}`,
        sha256: String(index + 1).repeat(64),
        sizeBytes: 1024,
      })),
    },
    ...overrides,
  };
}

function source(overrides: Partial<InstalledPluginVoiceModelPackSourceV1> = {}): InstalledPluginVoiceModelPackSourceV1 {
  return {
    pluginId: 'acme.speech',
    pluginVersion: '2.0.0',
    artifactBinding: {
      kind: 'sourceIntegrity',
      integrity: `sha512-${'b'.repeat(86)}==`,
    },
    enabled: true,
    authorization: { outcome: 'visible', code: 'plugin_final_available', requiresCurrentIntent: false },
    grantedNetworkOrigins: ['https://models.example.test', 'https://licenses.example.test'],
    ...overrides,
  };
}

const daemonHost = {
  executionHost: 'daemon' as const,
  hostVersion: '1.5.0',
  platform: 'darwin' as const,
  architecture: 'arm64' as const,
  runtimeFamilies: { sherpa_zipformer_streaming: { abiVersion: 1 } },
};

describe('public voice model-pack identity', () => {
  it('derives the specified collision-resistant filesystem key deterministically', () => {
    expect(deriveVoiceModelPackDirectoryKeyV1({ pluginId: 'acme.speech', packId: 'english-small' }))
      .toBe('vp-913ea0f37ce34d846482a7bc402048d20d9ce60370caf1a12e485a5c6fa4fc3a');
  });

  it('keeps delimiter-ambiguous and Unicode-distinct structured identities in separate cache directories', () => {
    expect(deriveVoiceModelPackDirectoryKeyV1({ pluginId: 'a', packId: 'b.c' }))
      .not.toBe(deriveVoiceModelPackDirectoryKeyV1({ pluginId: 'a.b', packId: 'c' }));
    expect(deriveVoiceModelPackDirectoryKeyV1({ pluginId: 'caf\u00e9', packId: 'voice' }))
      .not.toBe(deriveVoiceModelPackDirectoryKeyV1({ pluginId: 'cafe\u0301', packId: 'voice' }));
  });

  it('rejects oversized identity components before hashing', () => {
    expect(() => deriveVoiceModelPackDirectoryKeyV1({ pluginId: 'x'.repeat(1025), packId: 'pack' }))
      .toThrow('voice_model_pack_identity_component_too_large');
  });

  it('fails closed when persisted metadata does not match the requested structured identity', () => {
    expect(() => assertVoiceModelPackStoredIdentityV1(
      { pluginId: 'acme.speech', packId: 'english-small' },
      { pluginId: 'other.speech', packId: 'english-small' },
    )).toThrow('voice_model_pack_directory_identity_mismatch');
  });

  it('derives a stable domain-separated digest from manifest semantics rather than object key order', () => {
    const manifest = contribution().manifest;
    const reordered = {
      files: manifest.files,
      license: manifest.license,
      provenance: manifest.provenance,
      runtime: manifest.runtime,
      version: manifest.version,
      model: manifest.model,
      kind: manifest.kind,
      schemaVersion: manifest.schemaVersion,
    } as typeof manifest;
    const digest = deriveVoiceModelPackManifestDigestV1(manifest);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(deriveVoiceModelPackManifestDigestV1(reordered)).toBe(digest);
    expect(deriveVoiceModelPackManifestDigestV1({ ...manifest, version: '1.0.1' })).not.toBe(digest);
  });
});

describe('public voice model-pack support artifacts', () => {
  it('admits exact support files through the same artifact owner as schema admission', () => {
    const base = contribution();
    const support = { type: 'file' as const, kind: 'notice' as const, path: 'THIRD_PARTY_NOTICES.txt' };
    const withSupport: VoiceModelPackContributionV1 = {
      ...base,
      manifest: {
        ...base.manifest,
        supportArtifacts: [support],
        files: [...base.manifest.files, {
          path: support.path,
          url: 'https://models.example.test/english-small/THIRD_PARTY_NOTICES.txt',
          sha256: 'f'.repeat(64),
          sizeBytes: 128,
        }],
      },
    };
    expect(admitVoiceModelPackContributionV1({
      contribution: withSupport,
      source: source(),
      host: daemonHost,
    }).status).toBe('available');
  });
});

describe('public voice model-pack host admission', () => {
  it('admits a trusted compatible descriptor and preserves structured identity', () => {
    const result = admitVoiceModelPackContributionV1({ source: source(), contribution: contribution(), host: daemonHost });
    expect(result).toMatchObject({
      status: 'available',
      identity: { pluginId: 'acme.speech', packId: 'english-small' },
      pluginVersion: '2.0.0',
      artifactBinding: source().artifactBinding,
    });
  });

  it('binds consent to the exact source-integrity value rather than a digest-shaped plugin alias', () => {
    const licensed = contribution({
      manifest: {
        ...contribution().manifest,
        license: {
          ...contribution().manifest.license,
          requiresAcceptance: true,
          text: 'Exact source-bound model terms.',
        },
      },
    });
    const artifactBinding = Object.freeze({
      kind: 'sourceIntegrity' as const,
      integrity: `sha512-${'a'.repeat(86)}==`,
    });
    const acceptedLicense = {
      accountId: 'account-a',
      executionHost: 'daemon' as const,
      hostId: 'machine-a',
      pluginId: 'acme.speech',
      packId: licensed.id,
      packVersion: licensed.manifest.version,
      licenseId: licensed.manifest.license.id,
      licenseSourceUrl: licensed.manifest.license.url,
      licenseTextDigest: deriveVoiceModelPackLicenseTextDigestV1(licensed.manifest.license.text!),
      artifactBinding,
    };
    const sourceWithBinding = {
      ...source(),
      artifactBinding,
    };

    expect(admitVoiceModelPackContributionV1({
      source: sourceWithBinding,
      contribution: licensed,
      host: daemonHost,
      licenseScope: { accountId: 'account-a', executionHost: 'daemon', hostId: 'machine-a' },
      acceptedLicense,
    })).toMatchObject({ status: 'available' });

    expect(admitVoiceModelPackContributionV1({
      source: {
        ...sourceWithBinding,
        artifactBinding: Object.freeze({
          kind: 'sourceIntegrity' as const,
          integrity: `sha512-${'c'.repeat(86)}==`,
        }),
      },
      contribution: licensed,
      host: daemonHost,
      licenseScope: { accountId: 'account-a', executionHost: 'daemon', hostId: 'machine-a' },
      acceptedLicense,
    })).toMatchObject({ status: 'blocked', reason: 'license_acceptance_required' });
  });

  it('rejects a declaration that advertises the unimplemented native-device host', () => {
    expect(admitVoiceModelPackContributionV1({
      source: source(),
      contribution: contribution({ executionHosts: ['daemon', 'native_device'] }),
      host: daemonHost,
    })).toMatchObject({ status: 'incompatible', reason: 'declared_execution_host_unsupported' });
  });

  it('blocks a malformed semantic artifact mapping even when a caller bypasses schema parsing', () => {
    const valid = contribution();
    const malformed = {
      ...valid,
      manifest: {
        ...valid.manifest,
        runtime: {
          ...valid.manifest.runtime,
          artifacts: {
            ...valid.manifest.runtime.artifacts,
            tokens: { type: 'file' as const, path: 'encoder.onnx' },
          },
        },
      },
    };
    expect(admitVoiceModelPackContributionV1({ source: source(), contribution: malformed, host: daemonHost }))
      .toMatchObject({ status: 'blocked', reason: 'artifact_mapping_invalid' });
  });

  it.each([
    ['missing id', undefined],
    ['non-string id', { nested: true }],
    ['oversized id', 'x'.repeat(129)],
  ])('returns a bounded blocked descriptor without deriving identity for %s', (_label, id) => {
    const malformed = { ...contribution(), id } as unknown as VoiceModelPackContributionV1;

    expect(() => admitVoiceModelPackContributionV1({
      source: source(),
      contribution: malformed,
      host: daemonHost,
    })).not.toThrow();
    expect(admitVoiceModelPackContributionV1({
      source: source(),
      contribution: malformed,
      host: daemonHost,
    })).toEqual({
      status: 'blocked',
      reason: 'artifact_mapping_invalid',
      identity: null,
      directoryKey: null,
      pluginVersion: '2.0.0',
      artifactBinding: null,
      contribution: null,
    });
  });

  it.each([
    ['null input', null],
    ['primitive input', 42],
    ['array input', [contribution()]],
    ['prototype-backed input', Object.create(contribution())],
    ['an accessor-backed id', Object.defineProperty(
      { ...contribution() },
      'id',
      { enumerable: true, get: () => { throw new Error('malicious_id_getter'); } },
    )],
  ])('rejects %s without executing identity derivation or throwing', (_label, malformed) => {
    const result = admitVoiceModelPackContributionV1({
      source: source(),
      contribution: malformed as VoiceModelPackContributionV1,
      host: daemonHost,
    });

    expect(result).toEqual({
      status: 'blocked',
      reason: 'artifact_mapping_invalid',
      identity: null,
      directoryKey: null,
      pluginVersion: '2.0.0',
      artifactBinding: null,
      contribution: null,
    });
  });

  it.each([
    ['non-object binding', 42],
    ['unknown binding variant', { kind: 'unknown', integrity: 'not-a-binding' }],
  ])('returns a bounded blocked descriptor without accepting %s', (_label, artifactBinding) => {
    const malformedSource = {
      ...source(),
      artifactBinding,
    } as unknown as InstalledPluginVoiceModelPackSourceV1;

    const result = admitVoiceModelPackContributionV1({
      source: malformedSource,
      contribution: contribution(),
      host: daemonHost,
    });
    expect(result).toEqual({
      status: 'blocked',
      reason: 'artifact_binding_invalid',
      identity: null,
      directoryKey: null,
      pluginVersion: '2.0.0',
      artifactBinding: null,
      contribution: null,
    });
    expect(() => buildVoiceModelPackInstallUrlPolicyV1(result)).toThrow('voice_model_pack_not_installable');
  });

  it('rejects an accessor-backed source artifact binding without throwing or exposing source data', () => {
    const malformedSource = Object.defineProperty(
      { ...source() },
      'artifactBinding',
      { enumerable: true, get: () => { throw new Error('malicious_binding_getter'); } },
    ) as InstalledPluginVoiceModelPackSourceV1;

    expect(admitVoiceModelPackContributionV1({
      source: malformedSource,
      contribution: contribution(),
      host: daemonHost,
    })).toEqual({
      status: 'blocked',
      reason: 'artifact_binding_invalid',
      identity: null,
      directoryKey: null,
      pluginVersion: '2.0.0',
      artifactBinding: null,
      contribution: null,
    });
  });

  it.each([
    ['oversized source plugin id', { ...source(), pluginId: 'x'.repeat(1025) }],
    ['accessor-backed source plugin id', Object.defineProperty(
      { ...source() },
      'pluginId',
      { enumerable: true, get: () => { throw new Error('malicious_plugin_id_getter'); } },
    )],
  ])('rejects %s before deriving structured identity', (_label, malformedSource) => {
    expect(admitVoiceModelPackContributionV1({
      source: malformedSource as InstalledPluginVoiceModelPackSourceV1,
      contribution: contribution(),
      host: daemonHost,
    })).toEqual({
      status: 'blocked',
      reason: 'artifact_mapping_invalid',
      identity: null,
      directoryKey: null,
      pluginVersion: '2.0.0',
      artifactBinding: null,
      contribution: null,
    });
  });

  it('rejects accessor-backed source policy facts without executing post-parse raw rereads', () => {
    for (const key of [
      'pluginVersion',
      'enabled',
      'authorization',
      'grantedNetworkOrigins',
    ] as const) {
      const malformedSource = Object.defineProperty(
        { ...source() },
        key,
        { enumerable: true, get: () => { throw new Error(`malicious_${key}_getter`); } },
      ) as InstalledPluginVoiceModelPackSourceV1;

      expect(() => admitVoiceModelPackContributionV1({
        source: malformedSource,
        contribution: contribution(),
        host: daemonHost,
      }), key).not.toThrow();
      expect(admitVoiceModelPackContributionV1({
        source: malformedSource,
        contribution: contribution(),
        host: daemonHost,
      }), key).toEqual({
        status: 'blocked',
        reason: 'artifact_mapping_invalid',
        identity: null,
        directoryKey: null,
        pluginVersion: key === 'pluginVersion' ? '' : '2.0.0',
        artifactBinding: null,
        contribution: null,
      });
    }

    for (const pluginVersion of [42, '', 'x'.repeat(129)]) {
      const admitted = admitVoiceModelPackContributionV1({
        source: { ...source(), pluginVersion } as unknown as InstalledPluginVoiceModelPackSourceV1,
        contribution: contribution(),
        host: daemonHost,
      });
      expect(admitted).toMatchObject({
        status: 'blocked',
        reason: 'artifact_mapping_invalid',
        identity: null,
        contribution: null,
      });
      expect(admitted.pluginVersion.length).toBeLessThanOrEqual(128);
    }

    const accessorBackedOrigins = Object.defineProperty(
      ['https://models.example.test', 'https://licenses.example.test'],
      '0',
      { enumerable: true, get: () => { throw new Error('malicious_origin_getter'); } },
    );
    expect(admitVoiceModelPackContributionV1({
      source: source({ grantedNetworkOrigins: accessorBackedOrigins }),
      contribution: contribution(),
      host: daemonHost,
    })).toEqual({
      status: 'blocked',
      reason: 'artifact_mapping_invalid',
      identity: null,
      directoryKey: null,
      pluginVersion: '2.0.0',
      artifactBinding: null,
      contribution: null,
    });
  });

  it('rejects inherited and accessor-backed nested manifest facts without executing raw getters', () => {
    const accessorCase = (
      label: string,
      build: (valid: VoiceModelPackContributionV1, getter: <T>(value: T) => T) => VoiceModelPackContributionV1,
    ) => {
      let getterCalls = 0;
      const getter = <T,>(value: T): T => {
        getterCalls += 1;
        return value;
      };
      const malformed = build(contribution(), getter);
      const admitted = admitVoiceModelPackContributionV1({
        source: source(),
        contribution: malformed,
        host: daemonHost,
      });
      expect(getterCalls, label).toBe(0);
      expect(admitted, label).toEqual({
        status: 'blocked',
        reason: 'artifact_mapping_invalid',
        identity: null,
        directoryKey: null,
        pluginVersion: '2.0.0',
        artifactBinding: null,
        contribution: null,
      });
    };

    const cases: ReadonlyArray<Readonly<{
      label: string;
      build: Parameters<typeof accessorCase>[1];
    }>> = [
      {
        label: 'manifest accessor',
        build: (valid, getter) => Object.defineProperty(
          { ...valid },
          'manifest',
          { enumerable: true, get: () => getter(valid.manifest) },
        ) as VoiceModelPackContributionV1,
      },
      {
        label: 'inherited provenance source',
        build: (valid) => ({
          ...valid,
          manifest: {
            ...valid.manifest,
            provenance: Object.create(valid.manifest.provenance) as VoiceModelPackContributionV1['manifest']['provenance'],
          },
        }),
      },
      {
        label: 'provenance source accessor',
        build: (valid, getter) => ({
          ...valid,
          manifest: {
            ...valid.manifest,
            provenance: Object.defineProperty(
              { ...valid.manifest.provenance },
              'source',
              { enumerable: true, get: () => getter(valid.manifest.provenance.source) },
            ) as VoiceModelPackContributionV1['manifest']['provenance'],
          },
        }),
      },
      {
        label: 'oversized provenance source',
        build: (valid) => ({
          ...valid,
          manifest: {
            ...valid.manifest,
            provenance: { ...valid.manifest.provenance, source: `https://models.example.test/${'x'.repeat(2049)}` },
          },
        }),
      },
      {
        label: 'license acceptance accessor',
        build: (valid, getter) => ({
          ...valid,
          manifest: {
            ...valid.manifest,
            license: Object.defineProperty(
              { ...valid.manifest.license },
              'requiresAcceptance',
              { enumerable: true, get: () => getter(valid.manifest.license.requiresAcceptance) },
            ) as VoiceModelPackContributionV1['manifest']['license'],
          },
        }),
      },
      {
        label: 'oversized license title',
        build: (valid) => ({
          ...valid,
          manifest: {
            ...valid.manifest,
            license: { ...valid.manifest.license, title: 'x'.repeat(257) },
          },
        }),
      },
      {
        label: 'artifact path accessor',
        build: (valid, getter) => ({
          ...valid,
          manifest: {
            ...valid.manifest,
            runtime: {
              ...valid.manifest.runtime,
              artifacts: {
                ...valid.manifest.runtime.artifacts,
                encoder: Object.defineProperty(
                  { ...valid.manifest.runtime.artifacts.encoder },
                  'path',
                  { enumerable: true, get: () => getter(valid.manifest.runtime.artifacts.encoder.path) },
                ),
              },
            },
          },
        }) as VoiceModelPackContributionV1,
      },
      {
        label: 'oversized artifact path',
        build: (valid) => ({
          ...valid,
          manifest: {
            ...valid.manifest,
            runtime: {
              ...valid.manifest.runtime,
              artifacts: {
                ...valid.manifest.runtime.artifacts,
                encoder: { ...valid.manifest.runtime.artifacts.encoder, path: 'x'.repeat(513) },
              },
            },
          },
        }) as VoiceModelPackContributionV1,
      },
      {
        label: 'manifest file accessor',
        build: (valid, getter) => ({
          ...valid,
          manifest: {
            ...valid.manifest,
            files: valid.manifest.files.map((file, index) => index === 0
              ? Object.defineProperty(
                  { ...file },
                  'url',
                  { enumerable: true, get: () => getter(file.url) },
                )
              : file),
          },
        }),
      },
      {
        label: 'manifest files array element accessor',
        build: (valid, getter) => {
          const files = [...valid.manifest.files];
          Object.defineProperty(files, '0', {
            enumerable: true,
            get: () => getter(valid.manifest.files[0]),
          });
          return { ...valid, manifest: { ...valid.manifest, files } };
        },
      },
    ];

    for (const testCase of cases) accessorCase(testCase.label, testCase.build);

    const throwingProxy = new Proxy(contribution(), {
      getPrototypeOf: () => { throw new Error('malicious_contribution_proxy'); },
    });
    expect(() => admitVoiceModelPackContributionV1({
      source: source(),
      contribution: throwingProxy,
      host: daemonHost,
    })).not.toThrow();
    expect(admitVoiceModelPackContributionV1({
      source: source(),
      contribution: throwingProxy,
      host: daemonHost,
    })).toMatchObject({ status: 'blocked', reason: 'artifact_mapping_invalid', identity: null });

    let proxyGetCalls = 0;
    const transparentProxy = new Proxy(contribution(), {
      get: () => {
        proxyGetCalls += 1;
        throw new Error('raw_proxy_get_must_not_execute');
      },
    });
    expect(admitVoiceModelPackContributionV1({
      source: source(),
      contribution: transparentProxy,
      host: daemonHost,
    })).toMatchObject({ status: 'available' });
    expect(proxyGetCalls).toBe(0);
  });

  it.each([
    ['support directory prefix', {
      supportArtifacts: [{ type: 'directory_prefix', kind: 'notice', path: 'support' }],
      files: [{
        path: 'support/NOTICE.txt',
        url: 'https://models.example.test/english-small/support/NOTICE.txt',
        sha256: 'f'.repeat(64),
        sizeBytes: 128,
      }],
    }],
    ['forbidden support kind', {
      supportArtifacts: [{ type: 'file', kind: 'executable', path: 'NOTICE.txt' }],
      files: [{
        path: 'NOTICE.txt',
        url: 'https://models.example.test/english-small/NOTICE.txt',
        sha256: 'f'.repeat(64),
        sizeBytes: 128,
      }],
    }],
    ['unknown support kind', {
      supportArtifacts: [{ type: 'file', kind: 'documentation', path: 'NOTICE.txt' }],
      files: [{
        path: 'NOTICE.txt',
        url: 'https://models.example.test/english-small/NOTICE.txt',
        sha256: 'f'.repeat(64),
        sizeBytes: 128,
      }],
    }],
    ['extra support field', {
      supportArtifacts: [{ type: 'file', kind: 'notice', path: 'NOTICE.txt', executable: true }],
      files: [{
        path: 'NOTICE.txt',
        url: 'https://models.example.test/english-small/NOTICE.txt',
        sha256: 'f'.repeat(64),
        sizeBytes: 128,
      }],
    }],
    ['wrong support artifact type', {
      supportArtifacts: [{ type: 'file', kind: 'notice', path: 42 }],
      files: [],
    }],
    ['non-array support artifacts', { supportArtifacts: { type: 'file', kind: 'notice', path: 'NOTICE.txt' }, files: [] }],
  ])('blocks malformed %s when a typed caller bypasses schema parsing', (_label, malformedSupport) => {
    const valid = contribution();
    const malformed = {
      ...valid,
      manifest: {
        ...valid.manifest,
        supportArtifacts: malformedSupport.supportArtifacts,
        files: [...valid.manifest.files, ...malformedSupport.files],
      },
    } as unknown as VoiceModelPackContributionV1;

    expect(admitVoiceModelPackContributionV1({ source: source(), contribution: malformed, host: daemonHost }))
      .toMatchObject({ status: 'blocked', reason: 'artifact_mapping_invalid' });
  });

  it('blocks a missing runtime role when every remaining manifest file has exactly one owner', () => {
    const valid = contribution();
    const { tokens, ...artifacts } = valid.manifest.runtime.artifacts;
    const malformed = {
      ...valid,
      manifest: {
        ...valid.manifest,
        runtime: { ...valid.manifest.runtime, artifacts },
        files: valid.manifest.files.filter((file) => file.path !== tokens.path),
      },
    } as unknown as VoiceModelPackContributionV1;

    expect(admitVoiceModelPackContributionV1({ source: source(), contribution: malformed, host: daemonHost }))
      .toMatchObject({ status: 'blocked', reason: 'artifact_mapping_invalid' });
  });

  it.each([
    ['unknown runtime role', {
      encoder: { type: 'file', path: 'encoder.onnx' },
      decoder: { type: 'file', path: 'decoder.onnx' },
      joiner: { type: 'file', path: 'joiner.onnx' },
      tokens: { type: 'file', path: 'tokens.txt' },
      extra: { type: 'file', path: 'NOTICE.txt' },
    }],
    ['wrong runtime artifact type', {
      encoder: { type: 'directory_prefix', path: 'encoder.onnx' },
      decoder: { type: 'file', path: 'decoder.onnx' },
      joiner: { type: 'file', path: 'joiner.onnx' },
      tokens: { type: 'file', path: 'tokens.txt' },
    }],
    ['wrong runtime artifact path type', {
      encoder: { type: 'file', path: ['encoder.onnx'] },
      decoder: { type: 'file', path: 'decoder.onnx' },
      joiner: { type: 'file', path: 'joiner.onnx' },
      tokens: { type: 'file', path: 'tokens.txt' },
    }],
    ['extra runtime artifact field', {
      encoder: { type: 'file', path: 'encoder.onnx', mode: 'executable' },
      decoder: { type: 'file', path: 'decoder.onnx' },
      joiner: { type: 'file', path: 'joiner.onnx' },
      tokens: { type: 'file', path: 'tokens.txt' },
    }],
    ['non-object runtime artifacts', []],
  ])('blocks malformed %s when a typed caller bypasses schema parsing', (_label, artifacts) => {
    const valid = contribution();
    const malformed = {
      ...valid,
      manifest: {
        ...valid.manifest,
        runtime: { ...valid.manifest.runtime, artifacts },
        files: artifacts && !Array.isArray(artifacts) && 'extra' in artifacts
          ? [...valid.manifest.files, {
              path: 'NOTICE.txt',
              url: 'https://models.example.test/english-small/NOTICE.txt',
              sha256: 'f'.repeat(64),
              sizeBytes: 128,
            }]
          : valid.manifest.files,
      },
    } as unknown as VoiceModelPackContributionV1;

    expect(admitVoiceModelPackContributionV1({ source: source(), contribution: malformed, host: daemonHost }))
      .toMatchObject({ status: 'blocked', reason: 'artifact_mapping_invalid' });
  });

  it.each([
    ['unknown runtime key', (valid: VoiceModelPackContributionV1) => ({
      ...valid,
      manifest: {
        ...valid.manifest,
        runtime: { ...valid.manifest.runtime, extra: true },
      },
    })],
    ['malformed runtime platforms', (valid: VoiceModelPackContributionV1) => ({
      ...valid,
      manifest: {
        ...valid.manifest,
        runtime: { ...valid.manifest.runtime, platforms: 'darwin' },
      },
    })],
    ['malformed runtime ABI', (valid: VoiceModelPackContributionV1) => ({
      ...valid,
      manifest: {
        ...valid.manifest,
        runtime: { ...valid.manifest.runtime, abiVersion: { value: 1 } },
      },
    })],
    ['unknown manifest key', (valid: VoiceModelPackContributionV1) => ({
      ...valid,
      manifest: { ...valid.manifest, executable: true },
    })],
    ['unknown contribution key', (valid: VoiceModelPackContributionV1) => ({
      ...valid,
      installHook: 'run-me',
    })],
  ])('blocks malformed %s at canonical typed admission', (_label, mutate) => {
    const malformed = mutate(contribution()) as unknown as VoiceModelPackContributionV1;

    expect(admitVoiceModelPackContributionV1({ source: source(), contribution: malformed, host: daemonHost }))
      .toMatchObject({ status: 'blocked', reason: 'artifact_mapping_invalid' });
  });

  it.each(['ſ.txt', 'Σ.txt', 'ς.txt', '.reſume-plan.json'])(
    'blocks Unicode paths when a typed caller bypasses public schema parsing: %s',
    (path) => {
      const valid = contribution();
      const malformed = {
        ...valid,
        manifest: {
          ...valid.manifest,
          runtime: {
            ...valid.manifest.runtime,
            artifacts: {
              ...valid.manifest.runtime.artifacts,
              encoder: { type: 'file' as const, path },
            },
          },
          files: valid.manifest.files.map((file) => (
            file.path === 'encoder.onnx' ? { ...file, path } : file
          )),
        },
      };
      expect(admitVoiceModelPackContributionV1({ source: source(), contribution: malformed, host: daemonHost }))
        .toMatchObject({ status: 'blocked', reason: 'artifact_mapping_invalid' });
    },
  );

  it.each([
    ['plugin_policy_denied', source({ authorization: { outcome: 'denied', code: 'plugin_final_package_untrusted', requiresCurrentIntent: false } })],
    ['artifact_binding_invalid', source({ artifactBinding: { kind: 'unknown' } as never })],
    ['network_origin_not_granted', source({ grantedNetworkOrigins: ['https://licenses.example.test'] })],
  ])('blocks %s', (reason, sourceInput) => {
    expect(admitVoiceModelPackContributionV1({ source: sourceInput, contribution: contribution(), host: daemonHost }))
      .toMatchObject({ status: 'blocked', reason });
  });

  it.each([
    ['execution_host_unsupported', { ...daemonHost, executionHost: 'native_device' as const }],
    ['host_version_too_old', { ...daemonHost, hostVersion: '1.1.9' }],
    ['platform_unsupported', { ...daemonHost, platform: 'linux' as const }],
    ['architecture_unsupported', { ...daemonHost, architecture: 'x64' as const }],
    ['runtime_family_unsupported', { ...daemonHost, runtimeFamilies: {} }],
    ['runtime_abi_mismatch', { ...daemonHost, runtimeFamilies: { sherpa_zipformer_streaming: { abiVersion: 2 } } }],
  ])('marks %s incompatible', (reason, host) => {
    expect(admitVoiceModelPackContributionV1({ source: source(), contribution: contribution(), host }))
      .toMatchObject({ status: 'incompatible', reason });
  });

  it('marks disabled plugin packs orphaned', () => {
    expect(admitVoiceModelPackContributionV1({ source: source({ enabled: false }), contribution: contribution(), host: daemonHost }))
      .toMatchObject({ status: 'orphaned', reason: 'plugin_disabled' });
  });

  it('requires separate license acceptance for the exact plugin/pack/version', () => {
    const gated = contribution({
      manifest: {
        ...contribution().manifest,
        license: { ...contribution().manifest.license, requiresAcceptance: true, text: 'Exact Apache terms' },
      },
    });
    expect(admitVoiceModelPackContributionV1({ source: source(), contribution: gated, host: daemonHost }))
      .toMatchObject({ status: 'blocked', reason: 'license_acceptance_required' });
    expect(admitVoiceModelPackContributionV1({
      source: source(),
      contribution: gated,
      host: daemonHost,
      licenseScope: { accountId: 'account-a', executionHost: 'daemon', hostId: 'machine-a' },
      acceptedLicense: {
        accountId: 'account-a',
        executionHost: 'daemon',
        hostId: 'machine-a',
        pluginId: 'acme.speech',
        packId: 'english-small',
        packVersion: '1.0.0',
        licenseId: 'Apache-2.0',
        licenseSourceUrl: gated.manifest.license.url,
        licenseTextDigest: deriveVoiceModelPackLicenseTextDigestV1(gated.manifest.license.text!),
        artifactBinding: source().artifactBinding,
      },
    })).toMatchObject({ status: 'available' });

    expect(admitVoiceModelPackContributionV1({
      source: source(),
      contribution: gated,
      host: daemonHost,
      licenseScope: { accountId: 'account-a', executionHost: 'daemon', hostId: 'machine-a' },
      acceptedLicense: {
        accountId: 'account-a',
        executionHost: 'daemon',
        hostId: 'machine-a',
        pluginId: 'acme.speech',
        packId: 'english-small',
        packVersion: '1.0.0',
        licenseId: 'Apache-2.0',
        licenseSourceUrl: gated.manifest.license.url,
        licenseTextDigest: deriveVoiceModelPackLicenseTextDigestV1(gated.manifest.license.text!),
        artifactBinding: { kind: 'sourceIntegrity', integrity: `sha512-${'c'.repeat(86)}==` },
      },
    })).toMatchObject({ status: 'blocked', reason: 'license_acceptance_required' });
  });

  it('fails closed without executing accessor-backed or inherited license policy facts', () => {
    const gated = contribution({
      manifest: {
        ...contribution().manifest,
        license: { ...contribution().manifest.license, requiresAcceptance: true, text: 'Exact Apache terms' },
      },
    });
    const scope = { accountId: 'account-a', executionHost: 'daemon' as const, hostId: 'machine-a' };
    const acceptance = {
      ...scope,
      pluginId: 'acme.speech',
      packId: 'english-small',
      packVersion: '1.0.0',
      licenseId: 'Apache-2.0',
      licenseSourceUrl: gated.manifest.license.url,
      licenseTextDigest: deriveVoiceModelPackLicenseTextDigestV1(gated.manifest.license.text!),
      artifactBinding: source().artifactBinding,
    };
    let getterCalls = 0;
    const accessorAcceptance = Object.defineProperty(
      { ...acceptance },
      'licenseId',
      { enumerable: true, get: () => { getterCalls += 1; return acceptance.licenseId; } },
    );
    const accessorScope = Object.defineProperty(
      { ...scope },
      'hostId',
      { enumerable: true, get: () => { getterCalls += 1; return scope.hostId; } },
    );

    for (const policy of [
      { licenseScope: scope, acceptedLicense: accessorAcceptance },
      { licenseScope: accessorScope, acceptedLicense: acceptance },
      { licenseScope: scope, acceptedLicense: Object.create(acceptance) as typeof acceptance },
    ]) {
      expect(() => admitVoiceModelPackContributionV1({
        source: source(),
        contribution: gated,
        host: daemonHost,
        ...policy,
      })).not.toThrow();
      expect(admitVoiceModelPackContributionV1({
        source: source(),
        contribution: gated,
        host: daemonHost,
        ...policy,
      })).toMatchObject({ status: 'blocked', reason: 'license_acceptance_required' });
    }
    expect(getterCalls).toBe(0);
  });

  it('fails closed for legacy or differently-scoped license acceptance records', () => {
    const gated = contribution({
      manifest: {
        ...contribution().manifest,
        license: { ...contribution().manifest.license, requiresAcceptance: true, text: 'Exact Apache terms' },
      },
    });
    const exact = {
      accountId: 'account-a',
      executionHost: 'daemon' as const,
      hostId: 'machine-a',
      pluginId: 'acme.speech',
      packId: 'english-small',
      packVersion: '1.0.0',
      licenseId: 'Apache-2.0',
      licenseSourceUrl: gated.manifest.license.url,
      licenseTextDigest: deriveVoiceModelPackLicenseTextDigestV1(gated.manifest.license.text!),
      artifactBinding: source().artifactBinding,
    };
    const admit = (acceptedLicense: typeof exact | Record<string, string>) => admitVoiceModelPackContributionV1({
      source: source(),
      contribution: gated,
      host: daemonHost,
      licenseScope: { accountId: 'account-a', executionHost: 'daemon', hostId: 'machine-a' },
      acceptedLicense: acceptedLicense as typeof exact,
    });

    expect(admit(exact)).toMatchObject({ status: 'available' });
    expect(admit({
      pluginId: exact.pluginId,
      packId: exact.packId,
      packVersion: exact.packVersion,
      licenseId: exact.licenseId,
      artifactBinding: exact.artifactBinding,
    })).toMatchObject({ status: 'blocked', reason: 'license_acceptance_required' });
    expect(admit({ ...exact, accountId: 'account-b' })).toMatchObject({
      status: 'blocked', reason: 'license_acceptance_required',
    });
    expect(admit({ ...exact, hostId: 'machine-b' })).toMatchObject({
      status: 'blocked', reason: 'license_acceptance_required',
    });
    expect(admit({ ...exact, executionHost: 'native_device' })).toMatchObject({
      status: 'blocked', reason: 'license_acceptance_required',
    });
    expect(admit({ ...exact, licenseSourceUrl: 'https://licenses.example.test/changed' })).toMatchObject({
      status: 'blocked', reason: 'license_acceptance_required',
    });
    expect(admit({ ...exact, licenseTextDigest: `sha256:${'c'.repeat(64)}` })).toMatchObject({
      status: 'blocked', reason: 'license_acceptance_required',
    });
    expect(admit({
      ...exact,
      artifactBinding: { kind: 'sourceIntegrity', integrity: `sha512-${'d'.repeat(86)}==` },
    })).toMatchObject({
      status: 'blocked', reason: 'license_acceptance_required',
    });
  });

  it('enforces declared resource limits before download', () => {
    const oversized = contribution({
      manifest: {
        ...contribution().manifest,
        files: contribution().manifest.files.map((file, index) => (
          index === 0 ? { ...file, sizeBytes: 2048 } : file
        )),
      },
    });
    expect(admitVoiceModelPackContributionV1({
      source: source(),
      contribution: oversized,
      host: daemonHost,
      resourcePolicy: { maxFiles: 4, maxFileBytes: 1024, maxTotalBytes: 4096 },
    })).toMatchObject({ status: 'blocked', reason: 'file_size_limit_exceeded' });
  });

  it('orders semver prerelease numeric identifiers correctly for host compatibility', () => {
    const prereleasePack = contribution({
      manifest: {
        ...contribution().manifest,
        runtime: { ...contribution().manifest.runtime, minHostVersion: '1.2.0-rc.2' },
      },
    });
    expect(admitVoiceModelPackContributionV1({
      source: source(),
      contribution: prereleasePack,
      host: { ...daemonHost, hostVersion: '1.2.0-rc.10' },
    })).toMatchObject({ status: 'available' });
  });

  it('orders semver numeric prereleases without losing integer precision', () => {
    const prereleasePack = contribution({
      manifest: {
        ...contribution().manifest,
        runtime: {
          ...contribution().manifest.runtime,
          minHostVersion: '1.2.0-rc.9007199254740993',
        },
      },
    });
    expect(admitVoiceModelPackContributionV1({
      source: source(),
      contribution: prereleasePack,
      host: { ...daemonHost, hostVersion: '1.2.0-rc.9007199254740992' },
    })).toMatchObject({ status: 'incompatible', reason: 'host_version_too_old' });
  });

  it('builds a non-widening redirect/DNS policy only for admitted packs', () => {
    const admitted = admitVoiceModelPackContributionV1({ source: source(), contribution: contribution(), host: daemonHost });
    expect(buildVoiceModelPackInstallUrlPolicyV1(admitted)).toEqual({
      allowedOrigins: ['https://licenses.example.test', 'https://models.example.test'],
      requireResolvedAddresses: true,
    });
    const blocked = admitVoiceModelPackContributionV1({
      source: source({ authorization: { outcome: 'denied', code: 'plugin_final_package_untrusted', requiresCurrentIntent: false } }),
      contribution: contribution(),
      host: daemonHost,
    });
    expect(() => buildVoiceModelPackInstallUrlPolicyV1(blocked)).toThrow('voice_model_pack_not_installable');
  });
});
