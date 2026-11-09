import { resolvePypiWheelAssetHostCompatibility } from './pypiWheelAsset/platform.js';

export type ManagedDependencyReleaseDeclaration = Readonly<{
  assetNamePrefix: string;
  targetByPlatform: Readonly<Record<string, string>>;
}>;

export type ManagedDependencyReleaseAsset = Readonly<{
  name: string;
  url: string;
  digest: string | null;
  tag: string | null;
  version: string | null;
}>;

function releaseAssetPlatformAliases(): readonly string[] {
  if (process.platform === 'darwin') return ['macOS', 'darwin'];
  if (process.platform === 'linux') return ['linux'];
  if (process.platform === 'win32') return ['windows', 'win32'];
  throw new Error(`Unsupported github_release_binary platform: ${process.platform}/${process.arch}`);
}

function releaseAssetArchAliases(): readonly string[] {
  if (process.arch === 'arm64') return ['arm64', 'aarch64'];
  if (process.arch === 'x64') return ['amd64', 'x86_64', 'x64'];
  throw new Error(`Unsupported github_release_binary platform: ${process.platform}/${process.arch}`);
}

function parseVersionFromTag(tag: string | null | undefined): string | null {
  const value = typeof tag === 'string' ? tag.trim() : '';
  if (!value) return null;
  return /^v?(.+)$/.exec(value)?.[1] ?? null;
}

function normalizeReleaseAssets(raw: unknown): Array<Readonly<{ name: string; url: string; digest: string | null }>> {
  if (!Array.isArray(raw)) return [];
  const assets: Array<Readonly<{ name: string; url: string; digest: string | null }>> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const rawEntry = entry as { name?: unknown; browser_download_url?: unknown; digest?: unknown };
    const name = typeof rawEntry.name === 'string' ? rawEntry.name.trim() : '';
    const url = typeof rawEntry.browser_download_url === 'string' ? rawEntry.browser_download_url.trim() : '';
    const digest = typeof rawEntry.digest === 'string' ? rawEntry.digest.trim() : null;
    if (name && url) assets.push({ name, url, digest });
  }
  return assets;
}

function selectGenericReleaseAsset(release: unknown): ManagedDependencyReleaseAsset {
  const parsed = release && typeof release === 'object'
    ? release as { tag_name?: unknown; assets?: unknown }
    : {};
  const tag = typeof parsed.tag_name === 'string' && parsed.tag_name.trim().length > 0
    ? parsed.tag_name.trim()
    : null;
  const version = parseVersionFromTag(tag);
  const platforms = releaseAssetPlatformAliases();
  const arches = releaseAssetArchAliases();
  const archiveExtensions = process.platform === 'linux'
    ? ['.tar.gz', '.tgz']
    : ['.zip', '.tar.gz', '.tgz'];
  const assets = normalizeReleaseAssets(parsed.assets);
  const selected = assets.find((asset) => {
    const lowerName = asset.name.toLowerCase();
    return platforms.some((platform) => lowerName.includes(platform.toLowerCase()))
      && arches.some((arch) => lowerName.includes(arch.toLowerCase()))
      && archiveExtensions.some((extension) => lowerName.endsWith(extension));
  });

  if (!selected) {
    throw new Error(`No github_release_binary asset found for ${process.platform}/${process.arch}`);
  }

  return {
    name: selected.name,
    url: selected.url,
    digest: selected.digest,
    tag,
    version,
  };
}

export function selectManagedDependencyReleaseAsset(
  release: unknown,
  declaration?: ManagedDependencyReleaseDeclaration,
): ManagedDependencyReleaseAsset {
  if (!declaration) return selectGenericReleaseAsset(release);
  const platformKey = process.platform === 'linux'
    ? `${process.platform}-${process.arch}-${resolvePypiWheelAssetHostCompatibility().linuxLibc === 'glibc' ? 'gnu' : 'musl'}`
    : `${process.platform}-${process.arch}`;
  const target = declaration.targetByPlatform[platformKey];
  if (!target) throw new Error(`Unsupported ${declaration.assetNamePrefix} platform: ${process.platform}/${process.arch}`);
  const parsed = release && typeof release === 'object' ? release as { tag_name?: unknown; assets?: unknown } : {};
  const tag = typeof parsed.tag_name === 'string' && parsed.tag_name.trim() ? parsed.tag_name.trim() : null;
  const version = tag ? /^v?(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)$/.exec(tag)?.[1] ?? null : null;
  const extension = process.platform === 'win32' ? '.zip' : '.tar.gz';
  const assets = normalizeReleaseAssets(parsed.assets);
  const preferredName = version ? `${declaration.assetNamePrefix}-${version}-${target}${extension}` : null;
  const selected = (preferredName ? assets.find((asset) => asset.name === preferredName) : undefined)
    ?? assets.find((asset) => asset.name.includes(target) && asset.name.endsWith(extension));
  if (!selected) throw new Error(`No ${declaration.assetNamePrefix} release asset found for ${target}`);
  return { ...selected, tag, version };
}
