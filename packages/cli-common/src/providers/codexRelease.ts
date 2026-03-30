type GitHubReleaseAsset = Readonly<{
  name: string;
  browser_download_url: string;
  digest?: string | null;
}>;

type GitHubReleasePayload = Readonly<{
  tag_name?: unknown;
  assets?: unknown;
}>;

export type CodexReleaseAsset = Readonly<{
  name: string;
  url: string;
  digest: string;
  tag: string | null;
  version: string | null;
}>;

function normalizeTag(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
}

function parseCodexVersionFromTag(tag: string | null | undefined): string | null {
  const value = typeof tag === 'string' ? tag.trim() : '';
  const match = /^rust-v?(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)$/.exec(value);
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

function preferredCodexAssetNames(): string[] {
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return ['codex-aarch64-apple-darwin.tar.gz'];
  }
  if (process.platform === 'darwin' && process.arch === 'x64') {
    return ['codex-x86_64-apple-darwin.tar.gz'];
  }
  if (process.platform === 'linux' && process.arch === 'arm64') {
    return ['codex-aarch64-unknown-linux-musl.tar.gz', 'codex-aarch64-unknown-linux-gnu.tar.gz'];
  }
  if (process.platform === 'linux' && process.arch === 'x64') {
    return ['codex-x86_64-unknown-linux-musl.tar.gz', 'codex-x86_64-unknown-linux-gnu.tar.gz'];
  }
  if (process.platform === 'win32' && process.arch === 'arm64') {
    return ['codex-aarch64-pc-windows-msvc.exe.zip'];
  }
  if (process.platform === 'win32' && process.arch === 'x64') {
    return ['codex-x86_64-pc-windows-msvc.exe.zip'];
  }
  throw new Error(`Unsupported codex platform: ${process.platform}/${process.arch}`);
}

export function resolveCodexReleaseAsset(release: unknown): CodexReleaseAsset {
  const parsed = (release && typeof release === 'object' ? release : {}) as GitHubReleasePayload;
  const tag = normalizeTag(parsed.tag_name);
  const version = parseCodexVersionFromTag(tag);
  const assets = normalizeAssets(parsed.assets);
  const selected = preferredCodexAssetNames()
    .map((name) => assets.find((asset) => asset.name === name))
    .find(Boolean);
  if (!selected) {
    throw new Error(`No codex release asset found for ${process.platform}/${process.arch}`);
  }
  if (!selected.digest) {
    throw new Error(`Codex release asset ${selected.name} is missing a required digest`);
  }
  return {
    name: selected.name,
    url: selected.browser_download_url,
    digest: selected.digest,
    tag,
    version,
  };
}
