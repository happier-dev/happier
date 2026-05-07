type GitHubReleaseAsset = Readonly<{
  name: string;
  browser_download_url: string;
  digest?: string | null;
}>;

type GitHubReleasePayload = Readonly<{
  tag_name?: unknown;
  assets?: unknown;
}>;

export type GhReleaseAsset = Readonly<{
  name: string;
  url: string;
  digest: string | null;
  tag: string | null;
  version: string | null;
}>;

export const GH_GITHUB_REPO = 'cli/cli';

function normalizeTag(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
}

export function parseGhVersionFromTag(tag: string | null | undefined): string | null {
  const value = typeof tag === 'string' ? tag.trim() : '';
  if (!value) return null;
  const match = /^v?(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)$/.exec(value);
  return match?.[1] ?? null;
}

function getTargetParts(): Readonly<{ platform: string; arch: string; extension: string }> {
  const arch = process.arch === 'x64' ? 'amd64' : process.arch;
  if (arch !== 'amd64' && arch !== 'arm64') {
    throw new Error(`Unsupported gh architecture: ${process.arch}`);
  }

  if (process.platform === 'darwin') return { platform: 'macOS', arch, extension: '.zip' };
  if (process.platform === 'linux') return { platform: 'linux', arch, extension: '.tar.gz' };
  if (process.platform === 'win32') return { platform: 'windows', arch, extension: '.zip' };
  throw new Error(`Unsupported gh platform: ${process.platform}`);
}

function normalizeAssets(raw: unknown): GitHubReleaseAsset[] {
  if (!Array.isArray(raw)) return [];
  const assets: GitHubReleaseAsset[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const name = typeof (entry as { name?: unknown }).name === 'string' ? (entry as { name: string }).name.trim() : '';
    const url = typeof (entry as { browser_download_url?: unknown }).browser_download_url === 'string'
      ? (entry as { browser_download_url: string }).browser_download_url.trim()
      : '';
    const digest = typeof (entry as { digest?: unknown }).digest === 'string'
      ? (entry as { digest: string }).digest.trim()
      : null;
    if (!name || !url) continue;
    assets.push({ name, browser_download_url: url, digest });
  }
  return assets;
}

export function resolveGhReleaseAsset(release: unknown): GhReleaseAsset {
  const parsed = (release && typeof release === 'object' ? release : {}) as GitHubReleasePayload;
  const tag = normalizeTag(parsed.tag_name);
  const version = parseGhVersionFromTag(tag);
  const target = getTargetParts();
  const preferredName = version
    ? `gh_${version}_${target.platform}_${target.arch}${target.extension}`
    : null;
  const assets = normalizeAssets(parsed.assets);
  const selected = (preferredName ? assets.find((asset) => asset.name === preferredName) : undefined)
    ?? assets.find((asset) =>
      asset.name.startsWith('gh_')
      && asset.name.includes(`_${target.platform}_${target.arch}`)
      && asset.name.endsWith(target.extension));

  if (!selected) {
    throw new Error(`No gh release asset found for ${target.platform}/${target.arch}`);
  }

  return {
    name: selected.name,
    url: selected.browser_download_url,
    digest: selected.digest ?? null,
    tag,
    version,
  };
}
