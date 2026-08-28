import type { CapabilityId } from '../../capabilities/index.js';
import { InstallableDependencyDescriptorSchema } from '../descriptor.js';

export const GH_INSTALLABLE_KEY = 'gh' as const;
export const GH_DEP_ID = 'dep.gh' as const satisfies CapabilityId;
export const GH_GITHUB_REPO = 'cli/cli' as const;
export const GH_DIST_TAG = 'latest' as const;
export const GH_BINARY_NAME = 'gh' as const;

export type GitHubCliReleaseRuntime = Readonly<{
  platform: string;
  arch: string;
}>;

export type GitHubCliReleaseAsset = Readonly<{
  name: string;
  url: string;
  digest: string | null;
  tag: string | null;
  version: string | null;
}>;

function parseGhVersionFromTag(tag: string | null | undefined): string | null {
  const value = typeof tag === 'string' ? tag.trim() : '';
  return value ? /^v?(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)$/.exec(value)?.[1] ?? null : null;
}

function ghAssetPlatformPart(runtime: GitHubCliReleaseRuntime): string {
  if (runtime.platform === 'darwin') return 'macOS';
  if (runtime.platform === 'linux') return 'linux';
  if (runtime.platform === 'win32') return 'windows';
  throw new Error(`Unsupported gh platform: ${runtime.platform}/${runtime.arch}`);
}

function ghAssetArchPart(runtime: GitHubCliReleaseRuntime): string {
  if (runtime.arch === 'arm64') return 'arm64';
  if (runtime.arch === 'x64') return 'amd64';
  throw new Error(`Unsupported gh platform: ${runtime.platform}/${runtime.arch}`);
}

export function resolveGitHubCliReleaseAsset(
  release: unknown,
  runtime: GitHubCliReleaseRuntime,
): GitHubCliReleaseAsset {
  const parsed = release && typeof release === 'object'
    ? release as { tag_name?: unknown; assets?: unknown }
    : {};
  const tag = typeof parsed.tag_name === 'string' && parsed.tag_name.trim().length > 0
    ? parsed.tag_name.trim()
    : null;
  const version = parseGhVersionFromTag(tag);
  const platform = ghAssetPlatformPart(runtime);
  const arch = ghAssetArchPart(runtime);
  const extension = runtime.platform === 'linux' ? '.tar.gz' : '.zip';
  const preferredName = version ? `gh_${version}_${platform}_${arch}${extension}` : null;
  const assets = Array.isArray(parsed.assets)
    ? parsed.assets.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const raw = entry as { name?: unknown; browser_download_url?: unknown; digest?: unknown };
      const name = typeof raw.name === 'string' ? raw.name.trim() : '';
      const url = typeof raw.browser_download_url === 'string' ? raw.browser_download_url.trim() : '';
      if (!name || !url) return [];
      return [{ name, url, digest: typeof raw.digest === 'string' ? raw.digest.trim() : null }];
    })
    : [];
  const selected = (preferredName ? assets.find((asset) => asset.name === preferredName) : undefined)
    ?? assets.find((asset) => asset.name.includes(`_${platform}_${arch}`) && asset.name.endsWith(extension));
  if (!selected) throw new Error(`No gh release asset found for ${platform}/${arch}`);
  return { ...selected, tag, version };
}

export function isGitHubCliReleaseRuntimeSupported(runtime: GitHubCliReleaseRuntime): boolean {
  try {
    ghAssetPlatformPart(runtime);
    ghAssetArchPart(runtime);
    return true;
  } catch {
    return false;
  }
}

/** GH-owned selection/layout policy; the host retains all installation side effects. */
export const GH_RUNTIME_INSTALLABLE_POLICY = Object.freeze({
  archiveLayout: 'bin_directory' as const,
  selectReleaseAsset: resolveGitHubCliReleaseAsset,
  isRuntimeSupported: isGitHubCliReleaseRuntimeSupported,
});

export const GH_INSTALLABLE_DESCRIPTOR = InstallableDependencyDescriptorSchema.parse({
  id: GH_INSTALLABLE_KEY,
  key: GH_INSTALLABLE_KEY,
  kind: 'dep',
  version: '1',
  capabilityId: GH_DEP_ID,
  display: {
    name: 'GitHub CLI',
    subtitle: 'Optional dependency for GitHub repository and pull request workflows',
  },
  description: 'GitHub CLI dependency used by source-control provider adapters when explicitly enabled.',
  source: {
    kind: 'github_release_binary',
    repo: GH_GITHUB_REPO,
    distTag: GH_DIST_TAG,
  },
  binary: {
    commands: [GH_BINARY_NAME],
    systemFirst: true,
    managedFallback: true,
    platforms: ['darwin', 'linux', 'win32'],
    arches: ['arm64', 'x64'],
  },
  defaultPolicy: {
    autoInstallWhenNeeded: false,
    autoUpdateMode: 'notify',
  },
  consent: {
    install: 'required',
    update: 'required',
  },
  ui: {
    setupUrl: 'https://cli.github.com/',
    iconName: 'logo-github',
  },
  stability: {
    experimental: false,
    supported: true,
  },
});
