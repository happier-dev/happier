import type { AcpRegistryAgentV1, RegistryProvenanceV1 } from '../../../registries/registryItemsV1.js';
import { deriveRegistrySourceIdV1 } from '../../../registries/registrySourcesV1.js';
import { PinnedArchiveAssetsByPlatformSchema } from '../../../installables/sourceKind.js';
import { AcpBackendDefinitionV1Schema, type AcpBackendDefinitionV1, type AcpBackendLaunchV1 } from '../settingsV1.js';

/** One distribution choice for admission and previews; it never varies by machine. */
export function selectAcpRegistryDistributionV1(distributions: AcpRegistryAgentV1['distributions']) {
  if (distributions.npm) return { kind: 'npm' as const, distribution: distributions.npm };
  if (distributions.binary && Object.values(distributions.binary).some(Boolean)) return { kind: 'archive' as const, distribution: distributions.binary };
  if (distributions.uv) return { kind: 'uv' as const, distribution: distributions.uv };
  return null;
}

/** Archive recognition shared by ACP mapping and platform-fit projection. */
export function isAcpRegistryArchiveUrlV1(archiveUrl: string): boolean {
  return /\.(?:zip|tar\.gz|tgz|tar\.xz|tar\.bz2|tbz2)$/i.test(new URL(archiveUrl).pathname);
}

/** The only ACP URL → archive/raw executable conversion, shared by mapping and platform fit. */
export function mapAcpRegistryBinaryAssetsV1(
  binary: NonNullable<AcpRegistryAgentV1['distributions']['binary']>,
): ReturnType<typeof PinnedArchiveAssetsByPlatformSchema.safeParse> {
  return PinnedArchiveAssetsByPlatformSchema.safeParse(Object.fromEntries(Object.entries(binary).map(([platform, asset]) => [platform, {
    archiveUrl: asset.archiveUrl, ...(asset.sha256 ? { sha256: asset.sha256 } : {}),
    kind: isAcpRegistryArchiveUrlV1(asset.archiveUrl) ? 'archive' : 'executable',
    executableSubpath: asset.command.replace(/\\/g, '/').replace(/^\.\//, ''), args: asset.args,
  }])));
}

export function mapAcpRegistryAgentToDefinitionV1(input: Readonly<{
  agent: AcpRegistryAgentV1; provenance: RegistryProvenanceV1; existing?: AcpBackendDefinitionV1; nowMs: number;
}>): Readonly<{ ok: true; definition: AcpBackendDefinitionV1 } | { ok: false; code: 'no_supported_distribution' }> {
  if (input.provenance.format !== 'acp-registry' || input.provenance.itemId !== input.agent.id
    || input.provenance.ref.kind !== 'version' || input.provenance.ref.version !== input.agent.version) {
    return { ok: false, code: 'no_supported_distribution' };
  }
  const selected = selectAcpRegistryDistributionV1(input.agent.distributions);
  if (!selected) return { ok: false, code: 'no_supported_distribution' };
  let launch: AcpBackendLaunchV1;
  let env: AcpBackendDefinitionV1['env'] = {};
  if (selected.kind === 'archive') {
    const assets = mapAcpRegistryBinaryAssetsV1(selected.distribution);
    if (!assets.success) return { ok: false, code: 'no_supported_distribution' };
    launch = { kind: 'archive', version: input.agent.version, assetsByPlatform: assets.data, args: [],
      envByPlatform: Object.fromEntries(Object.entries(selected.distribution).map(([platform, asset]) => [platform, asset.env])) };
  } else {
    const distribution = selected.distribution;
    launch = { kind: selected.kind, package: distribution.package, version: distribution.version, args: distribution.args };
    env = Object.fromEntries(Object.entries(distribution.env).map(([key, value]) => [key, { t: 'literal' as const, v: value }]));
  }
  const id = `registry-${deriveRegistrySourceIdV1(input.provenance.sourceUrl).slice('registry:'.length)}-${input.agent.id}`;
  const definition = AcpBackendDefinitionV1Schema.safeParse({
    id, name: id, title: input.agent.name, description: input.agent.description, env,
    createdAt: input.nowMs, ...input.existing, launch, updatedAt: input.nowMs,
    origin: { kind: 'registry', provenance: input.provenance,
      ...(input.agent.iconUrl ? { iconUrl: input.agent.iconUrl } : {}),
      ...(input.agent.authors?.length ? { publisher: input.agent.authors.join(', ') } : {}),
      ...(input.agent.license ? { license: input.agent.license } : {}),
      ...(input.agent.repository ? { repository: input.agent.repository } : {}),
      ...(input.agent.website ? { website: input.agent.website } : {}) },
  });
  return definition.success ? { ok: true, definition: definition.data } : { ok: false, code: 'no_supported_distribution' };
}
