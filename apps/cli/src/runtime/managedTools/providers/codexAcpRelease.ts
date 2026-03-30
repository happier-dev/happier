type GitHubReleaseAsset = Readonly<{
  name: string;
  browser_download_url: string;
  digest?: string | null;
}>;

type GitHubReleasePayload = Readonly<{
  tag_name?: unknown;
  assets?: unknown;
}>;

export type CodexAcpReleaseAsset = Readonly<{
  name: string;
  url: string;
  digest: string | null;
  tag: string | null;
  version: string | null;
}>;

export const CODEX_ACP_GITHUB_REPO = 'zed-industries/codex-acp';

function normalizeTag(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
}

export function parseCodexAcpVersionFromTag(tag: string | null | undefined): string | null {
  const value = typeof tag === 'string' ? tag.trim() : '';
  if (!value) return null;
  const match = /^v?(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)$/.exec(value);
  return match?.[1] ?? null;
}

function getTargetTriple(): string {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin';
  if (platform === 'darwin' && arch === 'x64') return 'x86_64-apple-darwin';
  if (platform === 'win32' && arch === 'arm64') return 'aarch64-pc-windows-msvc';
  if (platform === 'win32' && arch === 'x64') return 'x86_64-pc-windows-msvc';

  const libc = detectLinuxLibcFamily();
  if (platform === 'linux' && arch === 'arm64') return libc === 'musl' ? 'aarch64-unknown-linux-musl' : 'aarch64-unknown-linux-gnu';
  if (platform === 'linux' && arch === 'x64') return libc === 'musl' ? 'x86_64-unknown-linux-musl' : 'x86_64-unknown-linux-gnu';

  throw new Error(`Unsupported codex-acp platform: ${platform}/${arch}`);
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

export function resolveCodexAcpReleaseAsset(release: unknown): CodexAcpReleaseAsset {
  const parsed = (release && typeof release === 'object' ? release : {}) as GitHubReleasePayload;
  const tag = normalizeTag(parsed.tag_name);
  const version = parseCodexAcpVersionFromTag(tag);
  const targetTriple = getTargetTriple();
  const extension = process.platform === 'win32' ? '.zip' : '.tar.gz';
  const preferredName = version
    ? `codex-acp-${version}-${targetTriple}${extension}`
    : null;

  const assets = normalizeAssets(parsed.assets);
  const selected = (preferredName ? assets.find((asset) => asset.name === preferredName) : undefined)
    ?? assets.find((asset) => asset.name.includes(targetTriple) && asset.name.endsWith(extension));

  if (!selected) {
    throw new Error(`No codex-acp release asset found for ${targetTriple}`);
  }

  return {
    name: selected.name,
    url: selected.browser_download_url,
    digest: selected.digest ?? null,
    tag,
    version,
  };
}
