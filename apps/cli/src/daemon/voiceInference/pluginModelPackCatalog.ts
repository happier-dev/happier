import {
  evaluatePluginFinalPolicy,
  type VoiceModelPackContributionV1,
} from '@happier-dev/protocol';
import {
  admitVoiceModelPackContributionV1,
  decideInstalledVoiceModelPackLifecycleV1,
  deriveVoiceModelPackManifestDigestV1,
  deriveVoiceModelPackLicenseTextDigestV1,
  voiceModelPackArtifactBindingsEqualV1,
  voiceModelPackSha256DigestsEqualV1,
  type EffectiveVoiceModelPackDescriptorV1,
  type InstalledVoiceModelPackLifecycleDecisionV1,
  type InstalledVoiceModelPackMetadataV1,
  type VoiceModelPackHostCapabilitiesV1,
  type VoiceModelPackArtifactBindingV1,
  type VoiceModelPackLicenseAcceptanceV1,
  type VoiceModelPackLicenseScopeV1,
  type VoiceModelPackResourcePolicyV1,
} from '@happier-dev/voice-modelpacks';

import type { PluginCatalogEntry } from '@/plugins/projection/catalog/installed';
import {
  resolvePluginFinalPolicyAuthorizationFacts,
  resolveRequiredPluginNetworkOrigins,
  type PluginFinalPolicyCurrentGeneration,
} from '@/plugins/runtime/policy/facts';

/**
 * Trusted, process-local input from the installed-plugin loader. Public plugin
 * manifests only supply `contributions`; trust, grants, and enablement are host
 * facts and must never be read from contribution data.
 */
export type DaemonVoiceModelPackPluginRecordV1 = Readonly<{
  pluginId: string;
  pluginVersion: string;
  artifactBinding: VoiceModelPackArtifactBindingV1;
  enabled: boolean;
  authorization: ReturnType<typeof evaluatePluginFinalPolicy>;
  grantedNetworkOrigins: readonly string[];
  contributions: readonly VoiceModelPackContributionV1[];
}>;

function resolveInstalledVoiceModelPackArtifactBinding(
  plugin: PluginCatalogEntry,
  current: PluginFinalPolicyCurrentGeneration,
): VoiceModelPackArtifactBindingV1 | null {
  if (plugin.source.kind === 'path') {
    return Object.freeze({
      kind: 'materialization',
      immutableGenerationId: current.immutableGenerationId,
    });
  }
  if (
    plugin.source.kind !== 'package'
    && plugin.source.kind !== 'archive'
    && plugin.source.kind !== 'marketplace'
  ) {
    // No bundled Voice model-pack route exists today. Do not invent a
    // package/tree digest for a future bundled contribution.
    return null;
  }
  return plugin.admittedIntegrity
    ? Object.freeze({ kind: 'sourceIntegrity', integrity: plugin.admittedIntegrity })
    : null;
}

export type DaemonVoiceModelPackCatalogEntryV1 = EffectiveVoiceModelPackDescriptorV1 & Readonly<{
  sourceLabel: Readonly<{ pluginId: string; pluginVersion: string }>;
  installable: boolean;
  loadable: boolean;
  installed: boolean;
  lifecycleState: InstalledVoiceModelPackLifecycleDecisionV1['state'] | null;
  lifecycleReason: InstalledVoiceModelPackLifecycleDecisionV1['reason'];
}>;

export type DaemonInstalledVoiceModelPackPlacementV1 = InstalledVoiceModelPackLifecycleDecisionV1 & Readonly<{
  identity: InstalledVoiceModelPackMetadataV1['identity'];
  directoryKey: string;
  pluginVersion: string;
  packVersion: string;
  verifiedAtMs: number;
}>;

/**
 * Cross-process projection seam from normalized installed manifests into the
 * daemon-owned effective catalog. Trust and grant decisions are mandatory host inputs;
 * raw manifest data cannot assert its own trust, grants, or revocation state.
 */
export async function projectInstalledDaemonPluginVoiceModelPackCatalogV1(params: Readonly<{
  installedPlugins: readonly PluginCatalogEntry[];
  currentPluginGenerations: ReadonlyMap<string, PluginFinalPolicyCurrentGeneration>;
  host: VoiceModelPackHostCapabilitiesV1;
  acceptedLicenses?: readonly VoiceModelPackLicenseAcceptanceV1[];
  licenseScope?: VoiceModelPackLicenseScopeV1;
  resourcePolicy?: VoiceModelPackResourcePolicyV1;
  installedMetadata?: readonly InstalledVoiceModelPackMetadataV1[];
}>): Promise<readonly DaemonVoiceModelPackCatalogEntryV1[]> {
  const records: DaemonVoiceModelPackPluginRecordV1[] = [];
  for (const plugin of params.installedPlugins) {
    if (!plugin.manifest) continue;
    const current = params.currentPluginGenerations.get(plugin.pluginId) ?? null;
    if (!current || plugin.desiredGeneration !== current.immutableGenerationId) continue;
    const artifactBinding = resolveInstalledVoiceModelPackArtifactBinding(plugin, current);
    if (!artifactBinding) continue;
    const authorization = evaluatePluginFinalPolicy({
      ...resolvePluginFinalPolicyAuthorizationFacts({
        pluginId: plugin.pluginId,
        current,
      }),
      serviceAvailability: Object.freeze([]),
      currentIntent: 'notRequired',
    });
    records.push({
      pluginId: plugin.pluginId,
      pluginVersion: plugin.version,
      artifactBinding,
      enabled: plugin.enabled,
      authorization,
      grantedNetworkOrigins: resolveRequiredPluginNetworkOrigins({
        required: plugin.manifest.hostAccess.required,
      }),
      contributions: Object.freeze([...(plugin.manifest.contributes.voiceModelPacks ?? [])]),
    });
  }
  return projectDaemonPluginVoiceModelPackCatalogV1({
    plugins: records,
    host: params.host,
    ...(params.acceptedLicenses ? { acceptedLicenses: params.acceptedLicenses } : {}),
    ...(params.licenseScope ? { licenseScope: params.licenseScope } : {}),
    ...(params.resourcePolicy ? { resourcePolicy: params.resourcePolicy } : {}),
    ...(params.installedMetadata ? { installedMetadata: params.installedMetadata } : {}),
  });
}

export function projectDaemonPluginVoiceModelPackCatalogV1(params: Readonly<{
  plugins: readonly DaemonVoiceModelPackPluginRecordV1[];
  host: VoiceModelPackHostCapabilitiesV1;
  acceptedLicenses?: readonly VoiceModelPackLicenseAcceptanceV1[];
  licenseScope?: VoiceModelPackLicenseScopeV1;
  resourcePolicy?: VoiceModelPackResourcePolicyV1;
  installedMetadata?: readonly InstalledVoiceModelPackMetadataV1[];
}>): readonly DaemonVoiceModelPackCatalogEntryV1[] {
  const identities = new Set<string>();
  const pluginIds = new Set<string>();
  const projected: DaemonVoiceModelPackCatalogEntryV1[] = [];

  for (const plugin of params.plugins) {
    // Host integrity, not an authoring defect: the installed-plugin catalog
    // cannot hold two records for one plugin id, so a repeated record means the
    // caller assembled a malformed record set and no projection of it is
    // trustworthy. This stays fail-closed.
    if (pluginIds.has(plugin.pluginId)) throw new Error('duplicate_voice_model_pack_plugin_identity');
    pluginIds.add(plugin.pluginId);
    for (const contribution of plugin.contributions) {
      // Reserved-identity refusal is owned by `admitVoiceModelPackContributionV1`
      // so a single mis-authored contribution cannot abort this catalog.
      const identityKey = JSON.stringify([plugin.pluginId, contribution.id]);
      const duplicateIdentity = identities.has(identityKey);
      identities.add(identityKey);

      const acceptedLicense = params.acceptedLicenses?.find((acceptance) => (
        acceptance.pluginId === plugin.pluginId
        && acceptance.packId === contribution.id
        && acceptance.packVersion === contribution.manifest.version
        && acceptance.licenseId === contribution.manifest.license.id
        && acceptance.licenseSourceUrl === contribution.manifest.license.url
        && typeof contribution.manifest.license.text === 'string'
        && voiceModelPackSha256DigestsEqualV1(
          acceptance.licenseTextDigest,
          deriveVoiceModelPackLicenseTextDigestV1(contribution.manifest.license.text),
        )
        && voiceModelPackArtifactBindingsEqualV1(acceptance.artifactBinding, plugin.artifactBinding)
        && params.licenseScope !== undefined
        && acceptance.accountId === params.licenseScope.accountId
        && acceptance.executionHost === params.licenseScope.executionHost
        && acceptance.hostId === params.licenseScope.hostId
      ));
      const admittedContribution = admitVoiceModelPackContributionV1({
        source: plugin,
        contribution,
        host: params.host,
        ...(acceptedLicense ? { acceptedLicense } : {}),
        ...(params.licenseScope ? { licenseScope: params.licenseScope } : {}),
        ...(params.resourcePolicy ? { resourcePolicy: params.resourcePolicy } : {}),
      });
      // A manifest that declares the same pack id twice would otherwise produce
      // two entries sharing one directory key. The first declaration wins (the
      // manifest array order is stable, so the winner is deterministic and both
      // claimants belong to the same plugin) and every later repeat is refused
      // in the vocabulary the admission owner already uses.
      // A contribution the admission owner already rejected outright carries no
      // identity and is blocked already; there is nothing left to refuse.
      const admitted: EffectiveVoiceModelPackDescriptorV1
        = duplicateIdentity && admittedContribution.identity !== null
          ? Object.freeze({
              ...admittedContribution,
              status: 'blocked' as const,
              reason: 'duplicate_voice_model_pack_identity',
            })
          : admittedContribution;
      const active = admitted.status === 'available';
      const installed = params.installedMetadata?.find((metadata) => (
        metadata.identity.pluginId === plugin.pluginId
        && metadata.identity.packId === contribution.id
      ));
      const lifecycle = installed
        ? decideInstalledVoiceModelPackLifecycleV1({
            metadata: installed,
            source: {
              enabled: plugin.enabled,
              trusted: plugin.authorization.outcome === 'visible',
              pluginVersion: plugin.pluginVersion,
              artifactBinding: plugin.artifactBinding,
              packVersion: contribution.manifest.version,
              manifestDigest: deriveVoiceModelPackManifestDigestV1(contribution.manifest),
            },
          })
        : null;
      projected.push(Object.freeze({
        ...admitted,
        sourceLabel: Object.freeze({ pluginId: plugin.pluginId, pluginVersion: plugin.pluginVersion }),
        installable: active,
        installed: Boolean(installed),
        lifecycleState: lifecycle?.state ?? null,
        lifecycleReason: lifecycle?.reason ?? null,
        loadable: active && lifecycle?.loadable === true,
      }));
    }
  }

  return Object.freeze(projected.sort((left, right) => {
    if (!left.identity || !right.identity) {
      if (left.identity) return -1;
      if (right.identity) return 1;
      return left.sourceLabel.pluginId.localeCompare(right.sourceLabel.pluginId)
        || String(left.reason).localeCompare(String(right.reason));
    }
    return left.identity.pluginId.localeCompare(right.identity.pluginId)
      || left.identity.packId.localeCompare(right.identity.packId);
  }));
}

/**
 * Projects durable host placement independently from the currently installed
 * plugin catalog so disabled, uninstalled, or declaration-removed packs remain
 * visible and removable after restart. This is pure host state; it does not
 * establish plugin authenticity or expose an install/load RPC.
 */
export function projectDaemonInstalledVoiceModelPackPlacementsV1(params: Readonly<{
  installedMetadata: readonly InstalledVoiceModelPackMetadataV1[];
  plugins: readonly DaemonVoiceModelPackPluginRecordV1[];
}>): readonly DaemonInstalledVoiceModelPackPlacementV1[] {
  const pluginsById = new Map<string, DaemonVoiceModelPackPluginRecordV1>();
  for (const plugin of params.plugins) {
    if (pluginsById.has(plugin.pluginId)) throw new Error('duplicate_voice_model_pack_plugin_identity');
    pluginsById.set(plugin.pluginId, plugin);
  }
  return Object.freeze(params.installedMetadata.map((metadata) => {
    const plugin = pluginsById.get(metadata.identity.pluginId);
    const contribution = plugin?.contributions.find((candidate) => candidate.id === metadata.identity.packId);
    const lifecycleSource = plugin && contribution
      ? {
          enabled: plugin.enabled,
          trusted: plugin.authorization.outcome === 'visible',
          pluginVersion: plugin.pluginVersion,
          artifactBinding: plugin.artifactBinding,
          packVersion: contribution?.manifest.version ?? metadata.packVersion,
          manifestDigest: contribution
            ? deriveVoiceModelPackManifestDigestV1(contribution.manifest)
            : metadata.manifestDigest,
        }
      : null;
    const lifecycle = decideInstalledVoiceModelPackLifecycleV1({
      metadata,
      source: lifecycleSource,
    });
    const resolved = plugin && !contribution
      ? Object.freeze({ ...lifecycle, reason: 'pack_absent' as const })
      : lifecycle;
    return Object.freeze({
      ...resolved,
      identity: metadata.identity,
      directoryKey: metadata.directoryKey,
      pluginVersion: metadata.pluginVersion,
      packVersion: metadata.packVersion,
      verifiedAtMs: metadata.verifiedAtMs,
    });
  }).sort((left, right) => (
    left.identity.pluginId.localeCompare(right.identity.pluginId)
    || left.identity.packId.localeCompare(right.identity.packId)
  )));
}
