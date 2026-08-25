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

const sourceIntegrity = (integrity = `sha512-${'b'.repeat(86)}==`) => ({
  kind: 'sourceIntegrity' as const,
  integrity,
});

const materialization = (immutableGenerationId = 'generation-local-7') => ({
  kind: 'materialization' as const,
  immutableGenerationId,
});

function installedCatalogEntry(options?: Readonly<{
  optionalNetwork?: boolean;
  requiresLicenseAcceptance?: boolean;
  sourceKind?: 'package' | 'path';
  admittedIntegrity?: string | null;
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
    source: { kind: options?.sourceKind ?? 'package' } as never,
    admittedIntegrity: options?.admittedIntegrity === undefined
      ? `sha512-${'b'.repeat(86)}==`
      : options.admittedIntegrity,
    install: {
      mode: 'managed_install',
      manifestVersion: '2.0.0',
      trust: createPluginTrustRecord({ pluginId: 'acme.speech', distribution, approvedAtMs: 1 }),
      optionalAccess: [],
    },
    compatibility: { status: 'compatible', diagnostics: [] },
    manifestPath: '/plugins/acme.speech/.happier-plugin/plugin.json',
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
  overrides: Partial<PluginFinalPolicyCurrentGeneration> = {},
): PluginFinalPolicyCurrentGeneration {
  const immutableGenerationId = overrides.immutableGenerationId ?? 'generation-7';
  const applied = overrides.applied ?? true;
  return Object.freeze({
    immutableGenerationId,
    desiredImmutableGenerationId: overrides.desiredImmutableGenerationId ?? immutableGenerationId,
    appliedImmutableGenerationId: overrides.appliedImmutableGenerationId
      ?? (applied ? immutableGenerationId : null),
    applied,
    selectedAccess: Object.freeze([]),
    ...overrides,
  });
}

describe('daemon public voice model-pack catalog projection', () => {
  it('refuses the exact q8 pack id reserved by the active built-in without admitting it', () => {
    const packId = 'kokoro-82m-v1.0-onnx-q8-wasm';
    const [projected] = projectDaemonPluginVoiceModelPackCatalogV1({
      plugins: [{
        pluginId: 'acme.speech',
        pluginVersion: '1.0.0',
        artifactBinding: sourceIntegrity(),
        enabled: true,
        authorization: { outcome: 'visible', code: 'plugin_final_available', requiresCurrentIntent: false },
        grantedNetworkOrigins: ['https://models.example.test'],
        contributions: [pack(packId)],
      }],
      host,
    });
    expect(projected).toMatchObject({
      status: 'blocked',
      reason: 'voice_model_pack_identity_reserved',
      installable: false,
      loadable: false,
    });
  });

  it('isolates one mis-authored plugin instead of emptying the catalog for every plugin', () => {
    const projected = projectDaemonPluginVoiceModelPackCatalogV1({
      plugins: [
        {
          pluginId: 'bad.speech',
          pluginVersion: '1.0.0',
          artifactBinding: sourceIntegrity(),
          enabled: true,
          authorization: { outcome: 'visible', code: 'plugin_final_available', requiresCurrentIntent: false },
          grantedNetworkOrigins: ['https://models.example.test'],
          // Two authoring defects at once: a reserved built-in id and a
          // duplicate id inside the same manifest.
          contributions: [pack('kokoro-82m-v1.0-onnx-q8-wasm'), pack('dup'), pack('dup')],
        },
        {
          pluginId: 'good.speech',
          pluginVersion: '1.0.0',
          artifactBinding: sourceIntegrity(),
          enabled: true,
          authorization: { outcome: 'visible', code: 'plugin_final_available', requiresCurrentIntent: false },
          grantedNetworkOrigins: ['https://models.example.test'],
          contributions: [pack('good-en')],
        },
      ],
      host,
    });
    expect(projected.find((entry) => entry.identity?.pluginId === 'good.speech'))
      .toMatchObject({ status: 'available', installable: true });
    // Every refused contribution stays visible and attributable rather than
    // silently vanishing, and each refusal names its own cause.
    const refused = projected.filter((entry) => (
      entry.sourceLabel.pluginId === 'bad.speech' && entry.status === 'blocked'
    ));
    expect(refused.map((entry) => entry.reason).sort())
      .toEqual(['duplicate_voice_model_pack_identity', 'voice_model_pack_identity_reserved']);
    expect(refused.every((entry) => entry.installable === false && entry.loadable === false)).toBe(true);
    // The first of the two duplicate declarations still works: only the repeat
    // is refused, so a manifest typo does not cost the plugin its good packs.
    expect(projected.filter((entry) => (
      entry.sourceLabel.pluginId === 'bad.speech' && entry.status === 'available'
    ))).toHaveLength(1);
  });

  it('does not reserve the unpublished canonical Kokoro id as a hidden alias', () => {
    const [projected] = projectDaemonPluginVoiceModelPackCatalogV1({
      plugins: [{
        pluginId: 'acme.speech',
        pluginVersion: '1.0.0',
        artifactBinding: sourceIntegrity(),
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
      currentPluginGenerations: new Map([[entry.pluginId, currentGeneration()]]),
      host,
    });
    expect(projected[0]).toMatchObject({ status: 'available', installable: true });
    expect(projected[0]?.loadable).toBe(false);
  });

  it('fails closed for an external plugin when installed-catalog acquisition integrity is unavailable', async () => {
    const entry = installedCatalogEntry({ admittedIntegrity: null });
    await expect(projectInstalledDaemonPluginVoiceModelPackCatalogV1({
      installedPlugins: [entry],
      currentPluginGenerations: new Map([[entry.pluginId, currentGeneration()]]),
      host,
    })).resolves.toEqual([]);
  });

  it('fails closed when installed source-integrity facts do not belong to the current immutable generation', async () => {
    const entry = installedCatalogEntry();
    await expect(projectInstalledDaemonPluginVoiceModelPackCatalogV1({
      installedPlugins: [entry],
      currentPluginGenerations: new Map([[entry.pluginId, currentGeneration({
        immutableGenerationId: 'generation-8',
      })]]),
      host,
    })).resolves.toEqual([]);
  });

  it('does not treat an optional network declaration as a selected runtime origin', async () => {
    const entry = installedCatalogEntry({ optionalNetwork: true });
    const projected = await projectInstalledDaemonPluginVoiceModelPackCatalogV1({
      installedPlugins: [entry],
      currentPluginGenerations: new Map([[entry.pluginId, currentGeneration()]]),
      host,
    });
    expect(projected[0]).toMatchObject({
      status: 'blocked',
      reason: 'network_origin_not_granted',
      installable: false,
    });
  });

  it('rejects an installed pack when the canonical generation is not applied', async () => {
    const entry = installedCatalogEntry();
    const projected = await projectInstalledDaemonPluginVoiceModelPackCatalogV1({
      installedPlugins: [entry],
      currentPluginGenerations: new Map([[entry.pluginId, currentGeneration({ applied: false })]]),
      host,
    });

    expect(projected[0]).toMatchObject({ status: 'blocked', reason: 'plugin_policy_denied' });
  });

  it('preserves acceptance across a new generation with the same acquisition SRI, then invalidates it when the SRI changes', async () => {
    const oldIntegrity = `sha512-${'c'.repeat(86)}==`;
    const newIntegrity = `sha512-${'d'.repeat(86)}==`;
    const entry = installedCatalogEntry({
      requiresLicenseAcceptance: true,
      admittedIntegrity: oldIntegrity,
    });
    const contribution = entry.manifest!.contributes.voiceModelPacks![0]!;
    const licenseScope = { accountId: 'account-a', executionHost: 'daemon' as const, hostId: 'machine-a' };
    const acceptedLicenses = [{
      ...licenseScope,
      pluginId: entry.pluginId,
      packId: contribution.id,
      packVersion: contribution.manifest.version,
      licenseId: contribution.manifest.license.id,
      licenseSourceUrl: contribution.manifest.license.url,
      licenseTextDigest: deriveVoiceModelPackLicenseTextDigestV1(contribution.manifest.license.text!),
      artifactBinding: sourceIntegrity(oldIntegrity),
    }];
    const installedMetadata: InstalledVoiceModelPackMetadataV1[] = [{
      schemaVersion: 1,
      identity: { pluginId: entry.pluginId, packId: contribution.id },
      directoryKey: deriveVoiceModelPackDirectoryKeyV1({ pluginId: entry.pluginId, packId: contribution.id }),
      pluginVersion: entry.version,
      artifactBinding: sourceIntegrity(oldIntegrity),
      packVersion: contribution.manifest.version,
      manifestDigest: deriveVoiceModelPackManifestDigestV1(contribution.manifest),
      verifiedAtMs: 1,
    }];

    const sameSourceNewGeneration = await projectInstalledDaemonPluginVoiceModelPackCatalogV1({
      installedPlugins: [{
        ...entry,
        desiredGeneration: 'generation-8',
        appliedGeneration: 'generation-8',
      }],
      currentPluginGenerations: new Map([[entry.pluginId, currentGeneration({
        immutableGenerationId: 'generation-8',
      })]]),
      host,
      licenseScope,
      acceptedLicenses,
      installedMetadata,
    });

    expect(sameSourceNewGeneration[0]).toMatchObject({
      status: 'available',
      artifactBinding: sourceIntegrity(oldIntegrity),
      installed: true,
      lifecycleState: 'active',
      loadable: true,
    });

    const changedSource = await projectInstalledDaemonPluginVoiceModelPackCatalogV1({
      installedPlugins: [{
        ...entry,
        desiredGeneration: 'generation-9',
        appliedGeneration: 'generation-9',
        admittedIntegrity: newIntegrity,
      }],
      currentPluginGenerations: new Map([[entry.pluginId, currentGeneration({
        immutableGenerationId: 'generation-9',
      })]]),
      host,
      licenseScope,
      acceptedLicenses,
      installedMetadata,
    });

    expect(changedSource[0]).toMatchObject({
      status: 'blocked',
      reason: 'license_acceptance_required',
      artifactBinding: sourceIntegrity(newIntegrity),
      installed: true,
      lifecycleState: 'orphaned',
      lifecycleReason: 'artifact_binding_changed',
      loadable: false,
    });
  });

  it('binds local/path consent and installed lifecycle to immutable materialization generation', async () => {
    const entry = installedCatalogEntry({
      sourceKind: 'path',
      admittedIntegrity: null,
      requiresLicenseAcceptance: true,
    });
    const contribution = entry.manifest!.contributes.voiceModelPacks![0]!;
    const oldBinding = materialization('generation-7');
    const licenseScope = { accountId: 'account-a', executionHost: 'daemon' as const, hostId: 'machine-a' };
    const acceptedLicenses = [{
      ...licenseScope,
      pluginId: entry.pluginId,
      packId: contribution.id,
      packVersion: contribution.manifest.version,
      licenseId: contribution.manifest.license.id,
      licenseSourceUrl: contribution.manifest.license.url,
      licenseTextDigest: deriveVoiceModelPackLicenseTextDigestV1(contribution.manifest.license.text!),
      artifactBinding: oldBinding,
    }];
    const installedMetadata: InstalledVoiceModelPackMetadataV1[] = [{
      schemaVersion: 1,
      identity: { pluginId: entry.pluginId, packId: contribution.id },
      directoryKey: deriveVoiceModelPackDirectoryKeyV1({ pluginId: entry.pluginId, packId: contribution.id }),
      pluginVersion: entry.version,
      artifactBinding: oldBinding,
      packVersion: contribution.manifest.version,
      manifestDigest: deriveVoiceModelPackManifestDigestV1(contribution.manifest),
      verifiedAtMs: 1,
    }];

    const current = await projectInstalledDaemonPluginVoiceModelPackCatalogV1({
      installedPlugins: [entry],
      currentPluginGenerations: new Map([[entry.pluginId, currentGeneration()]]),
      host,
      licenseScope,
      acceptedLicenses,
      installedMetadata,
    });
    expect(current[0]).toMatchObject({
      status: 'available',
      artifactBinding: oldBinding,
      lifecycleState: 'active',
      loadable: true,
    });

    const rematerialized = await projectInstalledDaemonPluginVoiceModelPackCatalogV1({
      installedPlugins: [{
        ...entry,
        desiredGeneration: 'generation-local-8',
        appliedGeneration: 'generation-local-8',
      }],
      currentPluginGenerations: new Map([[entry.pluginId, currentGeneration({
        immutableGenerationId: 'generation-local-8',
      })]]),
      host,
      licenseScope,
      acceptedLicenses,
      installedMetadata,
    });
    expect(rematerialized[0]).toMatchObject({
      status: 'blocked',
      reason: 'license_acceptance_required',
      artifactBinding: materialization('generation-local-8'),
      lifecycleState: 'orphaned',
      lifecycleReason: 'artifact_binding_changed',
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
      artifactBinding: sourceIntegrity(),
    };
    const [projected] = projectDaemonPluginVoiceModelPackCatalogV1({
      plugins: [{
        pluginId: 'acme.speech',
        pluginVersion: '2.0.0',
        artifactBinding: exact.artifactBinding,
        enabled: true,
        authorization: { outcome: 'visible', code: 'plugin_final_available', requiresCurrentIntent: false },
        grantedNetworkOrigins: ['https://models.example.test'],
        contributions: [licensed],
      }],
      host,
      licenseScope: { accountId: 'account-a', executionHost: 'daemon', hostId: 'machine-a' },
      acceptedLicenses: [
        { ...exact, artifactBinding: sourceIntegrity(`sha512-${'d'.repeat(86)}==`) },
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
        artifactBinding: sourceIntegrity(),
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
      artifactBinding: unknown,
    ): DaemonVoiceModelPackPluginRecordV1 => ({
      pluginId,
      pluginVersion: '2.0.0',
      artifactBinding: artifactBinding as DaemonVoiceModelPackPluginRecordV1['artifactBinding'],
      enabled: true,
      authorization: { outcome: 'visible', code: 'plugin_final_available', requiresCurrentIntent: false },
      grantedNetworkOrigins: ['https://models.example.test'],
      contributions: [pack(packId)],
    });

    const projected = projectDaemonPluginVoiceModelPackCatalogV1({
      plugins: [
        plugin('zeta.speech', 'rejected-zeta', { kind: 'unknown' }),
        plugin('middle.speech', 'available-middle', sourceIntegrity()),
        plugin('alpha.speech', 'rejected-alpha', { kind: 'unknown' }),
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
        reason: 'artifact_binding_invalid',
        installable: false,
        loadable: false,
      },
      {
        identity: null,
        sourcePluginId: 'zeta.speech',
        reason: 'artifact_binding_invalid',
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
        artifactBinding: sourceIntegrity(),
        enabled: false,
        authorization: { outcome: 'visible', code: 'plugin_final_available', requiresCurrentIntent: false },
        grantedNetworkOrigins: ['https://models.example.test'],
        contributions: [pack('english')],
      }],
      host,
    });
    expect(projected).toMatchObject({ status: 'orphaned', installable: false, loadable: false });
  });

  it('fails closed when the host supplies two records for one plugin identity', () => {
    const plugin = {
      pluginId: 'acme.speech',
      pluginVersion: '2.0.0',
      artifactBinding: sourceIntegrity(),
      enabled: true,
      authorization: { outcome: 'visible', code: 'plugin_final_available', requiresCurrentIntent: false },
      grantedNetworkOrigins: ['https://models.example.test'],
      contributions: [pack('english')],
    } as const;
    // A repeated plugin record is a malformed host record set, not a plugin
    // authoring defect, so it stays fail-closed for the whole projection.
    expect(() => projectDaemonPluginVoiceModelPackCatalogV1({ plugins: [plugin, plugin], host }))
      .toThrow('duplicate_voice_model_pack_plugin_identity');
  });

  it('marks a pack loadable only for exact verified persisted metadata', () => {
    const contribution = pack('english');
    const identity = { pluginId: 'acme.speech', packId: contribution.id } as const;
    const installed: InstalledVoiceModelPackMetadataV1 = {
      schemaVersion: 1,
      identity,
      directoryKey: deriveVoiceModelPackDirectoryKeyV1(identity),
      pluginVersion: '2.0.0',
      artifactBinding: sourceIntegrity(),
      packVersion: contribution.manifest.version,
      manifestDigest: deriveVoiceModelPackManifestDigestV1(contribution.manifest),
      verifiedAtMs: 100,
    };
    const plugin = {
      pluginId: 'acme.speech',
      pluginVersion: '2.0.0',
      artifactBinding: sourceIntegrity(),
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
      artifactBinding: sourceIntegrity(),
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
        artifactBinding: sourceIntegrity(),
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
      artifactBinding: sourceIntegrity(),
      packVersion: contribution.manifest.version,
      manifestDigest: deriveVoiceModelPackManifestDigestV1(contribution.manifest),
      verifiedAtMs: 100,
    };
    expect(projectDaemonInstalledVoiceModelPackPlacementsV1({
      installedMetadata: [metadata],
      plugins: [{
        pluginId: 'acme.speech',
        pluginVersion: '2.0.0',
        artifactBinding: sourceIntegrity(),
        enabled: true,
        authorization: { outcome: 'visible', code: 'plugin_final_available', requiresCurrentIntent: false },
        grantedNetworkOrigins: [],
        contributions: [],
      }],
    })[0]).toMatchObject({ state: 'orphaned', reason: 'pack_absent', loadable: false });
  });
});
