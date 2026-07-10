type GitHubReleaseAsset = Readonly<{
  name: string;
  browser_download_url: string;
  digest?: string | null;
}>;

type GitHubReleasePayload = Readonly<{
  tag_name?: unknown;
  assets?: unknown;
}>;

export type PnpmReleaseAsset = Readonly<{
  name: string;
  url: string;
  digest: string;
  tag: string | null;
  version: string | null;
}>;

export const PNPM_GITHUB_REPO = 'pnpm/pnpm';

function normalizeTag(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
}

export function parsePnpmVersionFromTag(tag: string | null | undefined): string | null {
  const value = typeof tag === 'string' ? tag.trim() : '';
  if (!value) return null;
  const match = /^v?(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)$/.exec(value);
  return match?.[1] ?? null;
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

function detectLinuxLibcFamily(): 'gnu' | 'musl' {
  if (process.platform !== 'linux') return 'gnu';
  try {
    const report = (process as NodeJS.Process & { report?: { getReport?: () => unknown } }).report?.getReport?.();
    const header = report && typeof report === 'object' && 'header' in report
      ? (report as { header?: { glibcVersionRuntime?: unknown } }).header
      : undefined;
    const glibcVersionRuntime = header?.glibcVersionRuntime;
    if (typeof glibcVersionRuntime === 'string' && glibcVersionRuntime.trim().length > 0) {
      return 'gnu';
    }
  } catch {
  }
  return 'musl';
}

function getPreferredAssetNames(): string[] {
  if (process.platform === 'darwin' && process.arch === 'arm64') return ['pnpm-darwin-arm64.tar.gz', 'pnpm-macos-arm64'];
  if (process.platform === 'darwin' && process.arch === 'x64') return ['pnpm-darwin-x64.tar.gz', 'pnpm-macos-x64'];
  if (process.platform === 'linux' && process.arch === 'arm64') {
    return detectLinuxLibcFamily() === 'musl'
      ? ['pnpm-linux-arm64-musl.tar.gz', 'pnpm-linuxstatic-arm64', 'pnpm-linux-arm64.tar.gz']
      : ['pnpm-linux-arm64.tar.gz', 'pnpm-linuxstatic-arm64', 'pnpm-linux-arm64-musl.tar.gz'];
  }
  if (process.platform === 'linux' && process.arch === 'x64') {
    return detectLinuxLibcFamily() === 'musl'
      ? ['pnpm-linux-x64-musl.tar.gz', 'pnpm-linuxstatic-x64', 'pnpm-linux-x64.tar.gz']
      : ['pnpm-linux-x64.tar.gz', 'pnpm-linuxstatic-x64', 'pnpm-linux-x64-musl.tar.gz'];
  }
  if (process.platform === 'win32' && process.arch === 'arm64') return ['pnpm-win32-arm64.zip', 'pnpm-win-arm64.exe'];
  if (process.platform === 'win32' && process.arch === 'x64') return ['pnpm-win32-x64.zip', 'pnpm-win-x64.exe'];
  throw new Error(`Unsupported pnpm platform: ${process.platform}/${process.arch}`);
}

export function resolvePnpmReleaseAsset(release: unknown): PnpmReleaseAsset {
  const parsed = (release && typeof release === 'object' ? release : {}) as GitHubReleasePayload;
  const tag = normalizeTag(parsed.tag_name);
  const version = parsePnpmVersionFromTag(tag);
  const preferredNames = getPreferredAssetNames();
  const assets = normalizeAssets(parsed.assets);
  const selected = preferredNames
    .map((name) => assets.find((asset) => asset.name === name) ?? null)
    .find((asset): asset is GitHubReleaseAsset => asset !== null);
  if (!selected) {
    throw new Error(`No pnpm release asset found for ${process.platform}/${process.arch}`);
  }
  if (!selected.digest) {
    throw new Error(`pnpm release asset ${selected.name} is missing a required digest`);
  }
  return {
    name: selected.name,
    url: selected.browser_download_url,
    digest: selected.digest,
    tag,
    version,
  };
}
