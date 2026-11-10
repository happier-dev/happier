import type { PluginAgentCliMetadata } from '../../plugins/contributions/agentCliMetadata.js';
import type { PluginManagedDependencyContributionV2 } from '../../plugins/contributions/managedDependencies.js';

export type AgentSetupPlatform = Readonly<{ supported: true }> | Readonly<{ supported: false; reason: 'os' | 'arch' }>;
export type AgentSetupInstall = Readonly<{
  available: boolean;
  mode: 'managed' | 'vendor_recipe' | 'manual' | 'none';
  /** Known required archive download bytes for this target; null when the declared size is unknown. */
  sizeBytes: number | null;
  guideUrl: string | null;
}>;
export type AgentSetupMetadataInput = Readonly<{
  cli: Pick<PluginAgentCliMetadata, 'install'> | null | undefined;
  /** Only dependencies required by this Agent's runtime, selected from its owning plugin manifest. */
  dependencies?: readonly PluginManagedDependencyContributionV2[];
  platform: string;
  arch: string;
}>;

type HostPlatform = 'darwin' | 'linux' | 'win32';

/** Shared with CLI install planning; unsupported host operating systems never admit setup. */
export function resolveAgentSetupHostPlatform(platform: string): HostPlatform | null {
  return platform === 'darwin' || platform === 'linux' || platform === 'win32' ? platform : null;
}

function resolveAssetPlatform(assets: Readonly<Record<string, unknown>>, platform: HostPlatform, arch: string): AgentSetupPlatform {
  if (assets[`${platform}-${arch}`]) return { supported: true };
  return { supported: false, reason: Object.keys(assets).some((key) => key.startsWith(`${platform}-`)) ? 'arch' : 'os' };
}

function resolveDependencyPlatform(
  dependency: PluginManagedDependencyContributionV2,
  platform: HostPlatform,
  arch: string,
): AgentSetupPlatform {
  const declaredPlatform = platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : 'linux';
  if (dependency.platforms && !dependency.platforms.includes(declaredPlatform)) return { supported: false, reason: 'os' };
  if (dependency.architectures && !dependency.architectures.includes(arch)) return { supported: false, reason: 'arch' };
  const sources = dependency.sources.map((source): AgentSetupPlatform => {
    if (source.kind === 'system') return { supported: true };
    if (source.kind === 'pinnedArchive') return resolveAssetPlatform(source.assetsByPlatform, platform, arch);
    if (source.kind === 'managedPypiWheelAsset') return resolveAssetPlatform(source.assetPathByPlatform, platform, arch);
    // Manual declarations have no runtime executable source adapter.
    return { supported: false, reason: 'os' };
  });
  if (sources.some((source) => source.supported)) return { supported: true };
  return { supported: false, reason: sources.some((source) => !source.supported && source.reason === 'arch') ? 'arch' : 'os' };
}

export function resolveAgentSetupPlatform(params: AgentSetupMetadataInput): AgentSetupPlatform {
  const platform = resolveAgentSetupHostPlatform(params.platform);
  if (!platform) return { supported: false, reason: 'os' };
  const install = params.cli?.install;
  if (install?.managed?.kind === 'github_release_binary') {
    if (params.arch !== 'x64' && params.arch !== 'arm64') return { supported: false, reason: 'arch' };
    if (install.managed.assetNameByPlatform && !install.managed.assetNameByPlatform[platform]?.[params.arch]) {
      return { supported: false, reason: 'arch' };
    }
  } else if (install && !install.managed && install.manual.kind !== 'none' && install.manual.recipes && !install.manual.recipes[platform]?.length) {
    return { supported: false, reason: 'os' };
  }
  for (const dependency of params.dependencies ?? []) {
    const support = resolveDependencyPlatform(dependency, platform, params.arch);
    if (!support.supported) return support;
  }
  return { supported: true };
}

function resolveRequiredArchiveBytes(params: AgentSetupMetadataInput): number | null {
  if (!params.dependencies?.length) return null;
  let total = 0;
  for (const dependency of params.dependencies) {
    const source = dependency.sources.find((candidate) => candidate.kind === 'pinnedArchive'
      && resolveAssetPlatform(candidate.assetsByPlatform, params.platform as HostPlatform, params.arch).supported);
    if (source?.kind !== 'pinnedArchive') return null;
    const asset = source.assetsByPlatform[`${params.platform}-${params.arch}` as keyof typeof source.assetsByPlatform];
    if (asset?.sizeBytes === undefined) return null;
    total += asset.sizeBytes;
  }
  return total;
}

export function resolveAgentSetupInstall(params: AgentSetupMetadataInput): AgentSetupInstall {
  const install = params.cli?.install;
  const guideUrl = install?.guideUrl ?? install?.docsUrl ?? null;
  if (!resolveAgentSetupPlatform(params).supported || !install) {
    return { available: false, mode: 'none', sizeBytes: null, guideUrl };
  }
  if (install.managed) return { available: true, mode: 'managed', sizeBytes: null, guideUrl };
  const recipes = install.manual.kind === 'none' ? undefined : install.manual.recipes;
  const recipe = params.platform === 'darwin' ? recipes?.darwin : params.platform === 'linux' ? recipes?.linux : recipes?.win32;
  return recipe?.length
    ? { available: true, mode: 'vendor_recipe', sizeBytes: resolveRequiredArchiveBytes(params), guideUrl }
    : { available: false, mode: install.manual.kind !== 'none' || guideUrl ? 'manual' : 'none', sizeBytes: null, guideUrl };
}
