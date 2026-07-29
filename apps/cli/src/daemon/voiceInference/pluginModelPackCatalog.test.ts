import { describe, expect, it } from 'vitest';

import type { VoiceModelPackContributionV1 } from '@happier-dev/protocol';
import {
  deriveVoiceModelPackDirectoryKeyV1,
  deriveVoiceModelPackLicenseTextDigestV1,
  deriveVoiceModelPackManifestDigestV1,
  type InstalledVoiceModelPackMetadataV1,
} from '@happier-dev/voice-modelpacks';
import {
  createNpmPluginDistributionIdentity,
  createPluginTrustRecord,
} from '@/plugins/store/install/trustIdentity';
import type { PluginCatalogEntry } from '@/plugins/projection/catalog/installed';
import type { PluginFinalPolicyCurrentGeneration } from '@/plugins/runtime/policy/facts';

import {
  type DaemonVoiceModelPackPluginRecordV1,
  projectDaemonPluginVoiceModelPackCatalogV1,
  projectDaemonInstalledVoiceModelPackPlacementsV1,
  projectInstalledDaemonPluginVoiceModelPackCatalogV1,
} from './pluginModelPackCatalog.js';

function pack(id: string, origin = 'https://models.example.test'): VoiceModelPackContributionV1 {
  return {
    id,
    schemaVersion: 1,
    executionHosts: ['daemon'],
    manifest: {
      schemaVersion: 1,
      kind: 'stt_sherpa',
      model: `model-${id}`,
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
      provenance: { source: `${origin}/${id}`, publisher: 'Acme' },
      license: {
        id: 'Apache-2.0',
        title: 'Apache License 2.0',
        url: `${origin}/license`,
        requiresAcceptance: false,
      },
      files: ['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt'].map((path, index) => ({
        path,
        url: `${origin}/${id}/${path}`,
        sha256: String(index + 1).repeat(64),
        sizeBytes: 4,
      })),
    },
  };
}

const host = {
  executionHost: 'daemon' as const,
  hostVersion: '1.5.0',
  platform: 'darwin' as const,
  architecture: 'arm64' as const,
  runtimeFamilies: { sherpa_zipformer_streaming: { abiVersion: 1 } },
};

function installedCatalogEntry(options?: Readonly<{
  optionalNetwork?: boolean;
  requiresLicenseAcceptance?: boolean;
}>): PluginCatalogEntry {
  const distribution = createNpmPluginDistributionIdentity({
    registryOrigin: 'https://registry.npmjs.org',
    packageName: '@acme/speech',
  });
  const access = {
    id: 'models',
    capability: 'network',
    scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://models.example.test' }] },
    reason: 'Download models',
  } as const;
  const contribution = pack('english');
  const licensedContribution: VoiceModelPackContributionV1 = options?.requiresLicenseAcceptance
    ? {
        ...contribution,
        manifest: {
          ...contribution.manifest,
          license: {
            ...contribution.manifest.license,
            requiresAcceptance: true,
            text: 'Exact installed plugin license terms.',
          },
        },
      }
    : contribution;
  return {
    pluginId: 'acme.speech',
    desiredGeneration: 'generation-7',
    appliedGeneration: 'generation-7',
    title: 'Acme Speech',
    description: null,
    version: '2.0.0',
    enabled: true,
    source: {} as never,
    install: {
      mode: 'managed_install',
      manifestVersion: '2.0.0',
      trust: createPluginTrustRecord({ pluginId: 'acme.speech', distribution, approvedAtMs: 1 }),
      optionalAccess: [],
    },
    compatibility: { status: 'compatible', diagnostics: [] },
    manifestPath: '/plugins/acme.speech/.happier-plugin/plugin.json',
    manifestDigest: `sha256:${'b'.repeat(64)}`,
    manifest: {
      hostAccess: {
        required: options?.optionalNetwork ? [] : [access],
        optional: options?.optionalNetwork ? [access] : [],
      },
      contributes: { voiceModelPacks: [licensedContribution] },
    } as never,
    contributionIntrospection: {} as never,
    diagnostics: [],
  };
}

function currentGeneration(
  entry: PluginCatalogEntry,
  overrides: Partial<PluginFinalPolicyCurrentGeneration> = {},
): PluginFinalPolicyCurrentGeneration {
  return Object.freeze({
    immutableGenerationId: 'generation-7',
    manifestDigest: entry.manifestDigest!,
    packageDigest: `sha256:${'c'.repeat(64)}`,
    distribution: 'test',
    applied: true,
    selectedAccess: Object.freeze([]),
    ...overrides,
  });
}

describe('daemon public voice model-pack catalog projection', () => {
  it('rejects the exact q8 pack id reserved by the active built-in', () => {
    const packId = 'kokoro-82m-v1.0-onnx-q8-wasm';
    expect(() => projectDaemonPluginVoiceModelPackCatalogV1({
      plugins: [{
        pluginId: 'acme.speech',
        pluginVersion: '1.0.0',
        pluginSourceDigest: 'b'.repeat(64),
        enabled: true,
        authorization: { outcome: 'visible', code: 'plugin_final_available', requiresCurrentIntent: false },
        grantedNetworkOrigins: ['https://models.example.test'],
        contributions: [pack(packId)],
      }],
      host,
    })).toThrow('voice_model_pack_identity_reserved');
  });

  it('does not reserve the unpublished canonical Kokoro id as a hidden alias', () => {
    const [projected] = projectDaemonPluginVoiceModelPackCatalogV1({
      plugins: [{
        pluginId: 'acme.speech',
        pluginVersion: '1.0.0',
        pluginSourceDigest: 'b'.repeat(64),
        enabled: true,
        authorization: { outcome: 'visible', code: 'plugin_final_available', requiresCurrentIntent: false },
        grantedNetworkOrigins: ['https://models.example.test'],
        contributions: [pack('kokoro-tts-en-v1')],
      }],
      host,
    });

    expect(projected?.identity?.packId).toBe('kokoro-tts-en-v1');
  });
  it('projects normalized installed manifests using host-owned trust and grant facts', async () => {
    const entry = installedCatalogEntry();
    const projected = await projectInstalledDaemonPluginVoiceModelPackCatalogV1({
      installedPlugins: [entry],
      currentPluginGenerations: new Map([[entry.pluginId, currentGeneration(entry)]]),
      host,
    });
    expect(projected[0]).toMatchObject({ status: 'available', installable: true });
    expect(projected[0]?.loadable).toBe(false);
  });

  it('does not treat an optional network declaration as a selected runtime origin', async () => {
    const entry = installedCatalogEntry({ optionalNetwork: true });
    const projected = await projectInstalledDaemonPluginVoiceModelPackCatalogV1({
      installedPlugins: [entry],
      currentPluginGenerations: new Map([[entry.pluginId, currentGeneration(entry)]]),
      host,
    });
    expect(projected[0]).toMatchObject({
      status: 'blocked',
      reason: 'network_origin_not_granted',
      installable: false,
    });
  });

  it('consumes the shared final policy instead of recomputing trust from catalog records', async () => {
    const entry = installedCatalogEntry();
    const projected = await projectInstalledDaemonPluginVoiceModelPackCatalogV1({
      installedPlugins: [entry],
      currentPluginGenerations: new Map([[entry.pluginId, currentGeneration(entry, {
        manifestDigest: `sha256:${'d'.repeat(64)}`,
      })]]),
      host,
    });

    expect(projected[0]).toMatchObject({ status: 'blocked', reason: 'plugin_policy_denied' });
  });

  it('rejects an installed pack when the canonical generation is not applied', async () => {
    const entry = installedCatalogEntry();
    const projected = await projectInstalledDaemonPluginVoiceModelPackCatalogV1({
      installedPlugins: [entry],
      currentPluginGenerations: new Map([[entry.pluginId, currentGeneration(entry, { applied: false })]]),
      host,
    });

    expect(projected[0]).toMatchObject({ status: 'blocked', reason: 'plugin_policy_denied' });
  });

  it('binds license and installed source lifecycle to the exact package digest when the manifest is unchanged', async () => {
    const entry = installedCatalogEntry({ requiresLicenseAcceptance: true });
    const contribution = entry.manifest!.contributes.voiceModelPacks![0]!;
    const oldPackageDigest = `sha256:${'c'.repeat(64)}`;
    const newPackageDigest = `sha256:${'d'.repeat(64)}`;
    const licenseScope = { accountId: 'account-a', executionHost: 'daemon' as const, hostId: 'machine-a' };
    const acceptedLicenses = [{
      ...licenseScope,
      pluginId: entry.pluginId,
      packId: contribution.id,
      packVersion: contribution.manifest.version,
      licenseId: contribution.manifest.license.id,
      licenseSourceUrl: contribution.manifest.license.url,
      licenseTextDigest: deriveVoiceModelPackLicenseTextDigestV1(contribution.manifest.license.text!),
      artifactDigest: oldPackageDigest,
    }];
    const installedMetadata: InstalledVoiceModelPackMetadataV1[] = [{
      schemaVersion: 1,
      identity: { pluginId: entry.pluginId, packId: contribution.id },
      directoryKey: deriveVoiceModelPackDirectoryKeyV1({ pluginId: entry.pluginId, packId: contribution.id }),
      pluginVersion: entry.version,
      pluginSourceDigest: oldPackageDigest,
      packVersion: contribution.manifest.version,
      manifestDigest: deriveVoiceModelPackManifestDigestV1(contribution.manifest),
      verifiedAtMs: 1,
    }];

    const projected = await projectInstalledDaemonPluginVoiceModelPackCatalogV1({
      installedPlugins: [entry],
      currentPluginGenerations: new Map([[entry.pluginId, currentGeneration(entry, {
        packageDigest: newPackageDigest,
      })]]),
      host,
      licenseScope,
      acceptedLicenses,
      installedMetadata,
    });

    expect(projected[0]).toMatchObject({
      status: 'blocked',
      reason: 'license_acceptance_required',
      sourceDigest: newPackageDigest,
      installed: true,
      lifecycleState: 'orphaned',
      lifecycleReason: 'source_digest_changed',
      loadable: false,
    });
  });

  it('selects the exact source-and-host-bound license acceptance regardless of record order', () => {
    const base = pack('licensed');
    const licensed: VoiceModelPackContributionV1 = {
      ...base,
      manifest: {
        ...base.manifest,
        license: { ...base.manifest.license, requiresAcceptance: true, text: 'Exact Apache terms' },
      },
    };
    const exact = {
      accountId: 'account-a',
      executionHost: 'daemon' as const,
      hostId: 'machine-a',
      pluginId: 'acme.speech',
      packId: 'licensed',
      packVersion: '1.0.0',
      licenseId: 'Apache-2.0',
      licenseSourceUrl: licensed.manifest.license.url,
      licenseTextDigest: deriveVoiceModelPackLicenseTextDigestV1(licensed.manifest.license.text!),
      artifactDigest: `sha256:${'b'.repeat(64)}`,
    };
    const [projected] = projectDaemonPluginVoiceModelPackCatalogV1({
      plugins: [{
        pluginId: 'acme.speech',
        pluginVersion: '2.0.0',
        pluginSourceDigest: exact.artifactDigest,
        enabled: true,
        authorization: { outcome: 'visible', code: 'plugin_final_available', requiresCurrentIntent: false },
        grantedNetworkOrigins: ['https://models.example.test'],
        contributions: [licensed],
      }],
      host,
      licenseScope: { accountId: 'account-a', executionHost: 'daemon', hostId: 'machine-a' },
      acceptedLicenses: [
        { ...exact, artifactDigest: `sha256:${'d'.repeat(64)}` },
        exact,
      ],
    });
    expect(projected).toMatchObject({ status: 'available', installable: true });
  });

  it('projects only pure installed-plugin descriptors and labels their source identity', () => {
    const projected = projectDaemonPluginVoiceModelPackCatalogV1({
      plugins: [{
        pluginId: 'acme.speech',
        pluginVersion: '2.0.0',
        pluginSourceDigest: `sha256:${'b'.repeat(64)}`,
        enabled: true,
        authorization: { outcome: 'visible', code: 'plugin_final_available', requiresCurrentIntent: false },
        grantedNetworkOrigins: ['https://models.example.test'],
        contributions: [pack('english')],
      }],
      host,
    });

    expect(projected).toHaveLength(1);
    expect(projected[0]?.reason).toBe(null);
    expect(projected[0]).toMatchObject({
      status: 'available',
      identity: { pluginId: 'acme.speech', packId: 'english' },
      sourceLabel: { pluginId: 'acme.speech', pluginVersion: '2.0.0' },
    });
    expect(projected[0]).not.toHaveProperty('register');
  });

  it('sorts parsed identities before bounded rejected descriptors without dereferencing nullable identity', () => {
    const plugin = (
      pluginId: string,
      packId: string,
      pluginSourceDigest: string,
    ): DaemonVoiceModelPackPluginRecordV1 => ({
      pluginId,
      pluginVersion: '2.0.0',
      pluginSourceDigest,
      enabled: true,
      authorization: { outcome: 'visible', code: 'plugin_final_available', requiresCurrentIntent: false },
      grantedNetworkOrigins: ['https://models.example.test'],
      contributions: [pack(packId)],
    });

    const projected = projectDaemonPluginVoiceModelPackCatalogV1({
      plugins: [
        plugin('zeta.speech', 'rejected-zeta', 'malformed-zeta-digest'),
        plugin('middle.speech', 'available-middle', `sha256:${'b'.repeat(64)}`),
        plugin('alpha.speech', 'rejected-alpha', 'malformed-alpha-digest'),
      ],
      host,
    });

    expect(projected.map((entry) => ({
      identity: entry.identity,
      sourcePluginId: entry.sourceLabel.pluginId,
      reason: entry.reason,
      installable: entry.installable,
      loadable: entry.loadable,
    }))).toEqual([
      {
        identity: { pluginId: 'middle.speech', packId: 'available-middle' },
        sourcePluginId: 'middle.speech',
        reason: null,
        installable: true,
        loadable: false,
      },
      {
        identity: null,
        sourcePluginId: 'alpha.speech',
        reason: 'plugin_source_digest_invalid',
        installable: false,
        loadable: false,
      },
      {
        identity: null,
        sourcePluginId: 'zeta.speech',
        reason: 'plugin_source_digest_invalid',
        installable: false,
        loadable: false,
      },
    ]);
  });

  it('keeps disabled packs visible as orphaned but not installable', () => {
    const [projected] = projectDaemonPluginVoiceModelPackCatalogV1({
      plugins: [{
        pluginId: 'acme.speech',
        pluginVersion: '2.0.0',
        pluginSourceDigest: `sha256:${'b'.repeat(64)}`,
        enabled: false,
        authorization: { outcome: 'visible', code: 'plugin_final_available', requiresCurrentIntent: false },
        grantedNetworkOrigins: ['https://models.example.test'],
        contributions: [pack('english')],
      }],
      host,
    });
    expect(projected).toMatchObject({ status: 'orphaned', installable: false, loadable: false });
  });

  it('fails closed when two records claim the same structured identity', () => {
    const plugin = {
      pluginId: 'acme.speech',
      pluginVersion: '2.0.0',
      pluginSourceDigest: `sha256:${'b'.repeat(64)}`,
      enabled: true,
      authorization: { outcome: 'visible', code: 'plugin_final_available', requiresCurrentIntent: false },
      grantedNetworkOrigins: ['https://models.example.test'],
      contributions: [pack('english')],
    } as const;
    expect(() => projectDaemonPluginVoiceModelPackCatalogV1({ plugins: [plugin, plugin], host }))
      .toThrow('duplicate_voice_model_pack_identity');
  });

  it('marks a pack loadable only for exact verified persisted metadata', () => {
    const contribution = pack('english');
    const identity = { pluginId: 'acme.speech', packId: contribution.id } as const;
    const installed: InstalledVoiceModelPackMetadataV1 = {
      schemaVersion: 1,
      identity,
      directoryKey: deriveVoiceModelPackDirectoryKeyV1(identity),
      pluginVersion: '2.0.0',
      pluginSourceDigest: `sha256:${'b'.repeat(64)}`,
      packVersion: contribution.manifest.version,
      manifestDigest: deriveVoiceModelPackManifestDigestV1(contribution.manifest),
      verifiedAtMs: 100,
    };
    const plugin = {
      pluginId: 'acme.speech',
      pluginVersion: '2.0.0',
      pluginSourceDigest: `sha256:${'b'.repeat(64)}`,
      enabled: true,
      authorization: { outcome: 'visible', code: 'plugin_final_available', requiresCurrentIntent: false },
      grantedNetworkOrigins: ['https://models.example.test'],
      contributions: [contribution],
    } as const;

    expect(projectDaemonPluginVoiceModelPackCatalogV1({
      plugins: [plugin], host, installedMetadata: [installed],
    })[0]).toMatchObject({ installed: true, lifecycleState: 'active', loadable: true });
    expect(projectDaemonPluginVoiceModelPackCatalogV1({
      plugins: [plugin],
      host,
      installedMetadata: [{ ...installed, manifestDigest: `sha256:${'d'.repeat(64)}` }],
    })[0]).toMatchObject({
      installed: true,
      lifecycleState: 'quarantined',
      lifecycleReason: 'manifest_digest_changed',
      loadable: false,
    });
  });

  it('keeps absent and disabled installed packs visible as removable placements across restart projection', () => {
    const contribution = pack('english');
    const identity = { pluginId: 'acme.speech', packId: contribution.id } as const;
    const metadata: InstalledVoiceModelPackMetadataV1 = {
      schemaVersion: 1,
      identity,
      directoryKey: deriveVoiceModelPackDirectoryKeyV1(identity),
      pluginVersion: '2.0.0',
      pluginSourceDigest: `sha256:${'b'.repeat(64)}`,
      packVersion: contribution.manifest.version,
      manifestDigest: deriveVoiceModelPackManifestDigestV1(contribution.manifest),
      verifiedAtMs: 100,
    };

    expect(projectDaemonInstalledVoiceModelPackPlacementsV1({
      installedMetadata: [metadata],
      plugins: [],
    })[0]).toMatchObject({
      identity,
      state: 'orphaned',
      reason: 'plugin_absent',
      removable: true,
      loadable: false,
    });
    expect(projectDaemonInstalledVoiceModelPackPlacementsV1({
      installedMetadata: [metadata],
      plugins: [{
        pluginId: 'acme.speech',
        pluginVersion: '2.0.0',
        pluginSourceDigest: `sha256:${'b'.repeat(64)}`,
        enabled: false,
        authorization: { outcome: 'visible', code: 'plugin_final_available', requiresCurrentIntent: false },
        grantedNetworkOrigins: ['https://models.example.test'],
        contributions: [contribution],
      }],
    })[0]).toMatchObject({ state: 'orphaned', reason: 'plugin_disabled', loadable: false });
  });

  it('treats a removed declaration as orphaned without inventing Voice-local revocation authority', () => {
    const contribution = pack('english');
    const identity = { pluginId: 'acme.speech', packId: contribution.id } as const;
    const metadata: InstalledVoiceModelPackMetadataV1 = {
      schemaVersion: 1,
      identity,
      directoryKey: deriveVoiceModelPackDirectoryKeyV1(identity),
      pluginVersion: '2.0.0',
      pluginSourceDigest: `sha256:${'b'.repeat(64)}`,
      packVersion: contribution.manifest.version,
      manifestDigest: deriveVoiceModelPackManifestDigestV1(contribution.manifest),
      verifiedAtMs: 100,
    };
    expect(projectDaemonInstalledVoiceModelPackPlacementsV1({
      installedMetadata: [metadata],
      plugins: [{
        pluginId: 'acme.speech',
        pluginVersion: '2.0.0',
        pluginSourceDigest: `sha256:${'b'.repeat(64)}`,
        enabled: true,
        authorization: { outcome: 'visible', code: 'plugin_final_available', requiresCurrentIntent: false },
        grantedNetworkOrigins: [],
        contributions: [],
      }],
    })[0]).toMatchObject({ state: 'orphaned', reason: 'pack_absent', loadable: false });
  });
});
