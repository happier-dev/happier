import type { ManagedDependencyDescriptor } from '@happier-dev/plugin-sdk/managed-services';
import { ManagedDependencyDescriptorSchema } from '@happier-dev/plugin-sdk/managed-services';

import {
  resolveCodexAcpSpawnWithOptions,
  type ResolveCodexAcpSpawnDeps,
  type ResolveCodexAcpSpawnOptions,
} from '../acp/command.js';
import {
  validateCodexAcpSpawnAvailability,
  type CodexAcpAvailabilityResult,
  type CodexAcpSpawnSpec,
} from '../acp/availability.js';

export type CodexAcpReleaseAsset = Readonly<{
  name: string;
  url: string;
  digest: string | null;
  tag: string | null;
  version: string | null;
}>;

export const CODEX_ACP_GITHUB_REPO = 'zed-industries/codex-acp';

export function parseCodexAcpVersionFromTag(tag: string | null | undefined): string | null {
  const value = typeof tag === 'string' ? tag.trim() : '';
  if (!value) return null;
  return /^v?(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)$/.exec(value)?.[1] ?? null;
}

function detectLinuxLibcFamily(): 'gnu' | 'musl' {
  if (process.platform !== 'linux') return 'gnu';
  try {
    const report = (process as NodeJS.Process & { report?: { getReport?: () => unknown } }).report?.getReport?.();
    const header = report && typeof report === 'object' && 'header' in report
      ? (report as { header?: { glibcVersionRuntime?: unknown } }).header
      : undefined;
    if (typeof header?.glibcVersionRuntime === 'string' && header.glibcVersionRuntime.trim().length > 0) {
      return 'gnu';
    }
  } catch {
  }
  return 'musl';
}

function codexAcpTargetTriple(): string {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'aarch64-apple-darwin';
  if (process.platform === 'darwin' && process.arch === 'x64') return 'x86_64-apple-darwin';
  if (process.platform === 'win32' && process.arch === 'arm64') return 'aarch64-pc-windows-msvc';
  if (process.platform === 'win32' && process.arch === 'x64') return 'x86_64-pc-windows-msvc';
  const libc = detectLinuxLibcFamily();
  if (process.platform === 'linux' && process.arch === 'arm64') return libc === 'musl' ? 'aarch64-unknown-linux-musl' : 'aarch64-unknown-linux-gnu';
  if (process.platform === 'linux' && process.arch === 'x64') return libc === 'musl' ? 'x86_64-unknown-linux-musl' : 'x86_64-unknown-linux-gnu';
  throw new Error(`Unsupported codex-acp platform: ${process.platform}/${process.arch}`);
}

export function resolveCodexAcpReleaseAsset(release: unknown): CodexAcpReleaseAsset {
  const parsed = release && typeof release === 'object'
    ? release as { tag_name?: unknown; assets?: unknown }
    : {};
  const tag = typeof parsed.tag_name === 'string' && parsed.tag_name.trim().length > 0
    ? parsed.tag_name.trim()
    : null;
  const version = parseCodexAcpVersionFromTag(tag);
  const targetTriple = codexAcpTargetTriple();
  const extension = process.platform === 'win32' ? '.zip' : '.tar.gz';
  const preferredName = version ? `codex-acp-${version}-${targetTriple}${extension}` : null;
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
    ?? assets.find((asset) => asset.name.includes(targetTriple) && asset.name.endsWith(extension));
  if (!selected) throw new Error(`No codex-acp release asset found for ${targetTriple}`);
  return { ...selected, tag, version };
}

/**
 * Codex owns the Agent-specific launch semantics. The host-owned Codex ACP
 * installable adapter calls these helpers for the one `codex-acp` installable.
 */
export const CODEX_ACP_RUNTIME_LAUNCH_HELPERS = Object.freeze({
  resolveSpawnSpec: (
    opts: ResolveCodexAcpSpawnOptions = {},
    deps: ResolveCodexAcpSpawnDeps = {},
  ): CodexAcpSpawnSpec => resolveCodexAcpSpawnWithOptions(opts, deps),
  validateAvailability: (
    spec: CodexAcpSpawnSpec,
    opts?: Readonly<{
      env?: NodeJS.ProcessEnv;
      existsSyncFn?: typeof import('node:fs').existsSync;
      accessSyncFn?: typeof import('node:fs').accessSync;
    }>,
  ): CodexAcpAvailabilityResult => validateCodexAcpSpawnAvailability(spec, opts),
});

const codexAcpInstallableDescriptorBase = ManagedDependencyDescriptorSchema.parse({
  id: 'codex-acp',
  key: 'codex-acp',
  kind: 'dep',
  version: '1',
  capabilityId: 'dep.codex-acp',
  display: {
    name: 'Codex ACP',
  },
  description: 'Codex ACP dependency used by the Codex ACP backend',
  source: {
    kind: 'github_release_binary',
    repo: 'zed-industries/codex-acp',
    distTag: 'latest',
  },
  binary: {
    commands: ['codex-acp'],
    systemFirst: true,
    managedFallback: true,
  },
  defaultPolicy: {
    autoInstallWhenNeeded: true,
    autoUpdateMode: 'auto',
  },
  consent: {
    install: 'not_required',
    update: 'not_required',
  },
  ui: {
    iconName: 'swap-horizontal-outline',
  },
  stability: {
    experimental: true,
    supported: true,
  },
});

export const CODEX_ACP_INSTALLABLE_DESCRIPTOR: ManagedDependencyDescriptor =
  codexAcpInstallableDescriptorBase;

/** Pure Codex-owned release/layout policy; the host retains download, extraction and promotion custody. */
export const CODEX_ACP_RUNTIME_INSTALLABLE_POLICY = Object.freeze({
  sourceRepo: CODEX_ACP_GITHUB_REPO,
  archiveLayout: 'single_executable' as const,
  selectReleaseAsset: resolveCodexAcpReleaseAsset,
});

export function hasCodexAcpRuntimeInstallableAdapterPolicy(
  descriptor: Readonly<Pick<ManagedDependencyDescriptor, 'source'>>,
): boolean {
  return descriptor.source.kind === 'github_release_binary'
    && descriptor.source.repo === CODEX_ACP_RUNTIME_INSTALLABLE_POLICY.sourceRepo;
}
