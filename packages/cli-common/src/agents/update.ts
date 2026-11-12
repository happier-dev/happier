import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { AgentCliInstallPlatform } from '@happier-dev/agents';
import { fetchGitHubLatestRelease } from '@happier-dev/release-runtime';

import { compareVersions } from '../update/index.js';
import { readManagedPnpmMinimumReleaseAgeMs } from './managedPnpm.js';

import type { AgentCliResolutionSource, AgentCliRuntimeDescriptor } from './resolution.js';

/**
 * Who owns an installed agent CLI, derived from the executable the detect owner resolved and the
 * agent's manifest facts (`cli.install.managed`, `npmPackageName`, `nativeUpdate`). Only `managed`
 * and `native` (with a declared vendor updater) can be updated by Happier; the package-manager
 * sources are surfaced with a copyable command instead (contract K6).
 */
export type AgentCliInstallSource = 'managed' | 'native' | 'npm' | 'pnpm' | 'bun' | 'brew' | 'other';

export type AgentCliUpdateFacts = Readonly<{
  installSource: AgentCliInstallSource;
  /** Happier can run the update itself (managed reinstall, or the declared vendor updater). */
  updateSupported: boolean;
  /** The command a person can run to update this install, when one is known. */
  updateCommand: string | null;
  /** Arguments for the vendor updater, run against the resolved executable. */
  nativeUpdateArgs: ReadonlyArray<string> | null;
  /** Proven npm package identity, retained for the owner's latest-version lookup. */
  npmPackageName?: string;
}>;

export type AgentCliLatestVersionSource =
  | Readonly<{ kind: 'npm'; packageName: string }>
  | Readonly<{ kind: 'github_release'; githubRepo: string; releaseTag?: string }>;

const OTHER: AgentCliUpdateFacts = {
  installSource: 'other',
  updateSupported: false,
  updateCommand: null,
  nativeUpdateArgs: null,
};

function toComparablePath(path: string, platform: AgentCliInstallPlatform): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isSameOrWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function quoteCommandPath(path: string, platform: AgentCliInstallPlatform): string {
  if (!/[\s'"&;|()$`]/.test(path)) return path;
  if (platform === 'win32') return `& "${path.replaceAll('"', '`"')}"`;
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

function resolveUserHomeDir(env: NodeJS.ProcessEnv, platform: AgentCliInstallPlatform): string {
  const fromEnv = platform === 'win32'
    ? (env.USERPROFILE ?? env.HOME ?? '')
    : (env.HOME ?? env.USERPROFILE ?? '');
  return fromEnv.trim() || homedir();
}

function packageManagerFacts(
  installSource: Extract<AgentCliInstallSource, 'npm' | 'pnpm' | 'bun' | 'brew'>,
  updateCommand: string,
  npmPackageName?: string,
): AgentCliUpdateFacts {
  // Happier does not spawn package managers from product runtime paths; the owner's command is
  // surfaced for the person to run.
  return { installSource, updateSupported: false, updateCommand, nativeUpdateArgs: null,
    ...(npmPackageName ? { npmPackageName } : {}) };
}

/** The default npm package candidate: the managed package, else the vendor's. */
export function resolveAgentCliNpmPackageName(runtimeSpec: AgentCliRuntimeDescriptor): string | null {
  if (runtimeSpec.managedInstall?.kind === 'managed_package') return runtimeSpec.managedInstall.packageName;
  return runtimeSpec.npmPackageName ?? null;
}

/**
 * Where "latest" comes from: a proven external package, otherwise the declared managed source
 * or vendor npm package. `null` means the manifest declares no verified latest source.
 */
export function resolveAgentCliLatestVersionSource(
  runtimeSpec: AgentCliRuntimeDescriptor,
  install?: Pick<AgentCliUpdateFacts, 'installSource' | 'npmPackageName'>,
): AgentCliLatestVersionSource | null {
  if (install?.installSource !== 'managed' && install?.npmPackageName) {
    return { kind: 'npm', packageName: install.npmPackageName };
  }
  if (runtimeSpec.managedInstall?.kind === 'github_release_binary') {
    return {
      kind: 'github_release',
      githubRepo: runtimeSpec.managedInstall.githubRepo,
      ...(runtimeSpec.managedInstall.releaseTag !== undefined ? { releaseTag: runtimeSpec.managedInstall.releaseTag } : {}),
    };
  }
  const packageName = resolveAgentCliNpmPackageName(runtimeSpec);
  return packageName ? { kind: 'npm', packageName } : null;
}

/**
 * Attributes an installed agent CLI to the owner that can update it, from the exact executable
 * the detect owner resolved (and its real path) plus manifest facts. Anything unproven stays
 * `other` with no command, so Happier never runs or suggests an updater that does not own the
 * install.
 */
export function classifyAgentCliInstall(params: Readonly<{
  runtimeSpec: AgentCliRuntimeDescriptor;
  command: string;
  source: AgentCliResolutionSource;
  readOnly?: true;
  platform: AgentCliInstallPlatform;
  env?: NodeJS.ProcessEnv;
}>): AgentCliUpdateFacts {
  const { runtimeSpec, platform } = params;
  if (params.source === 'managed') {
    return {
      installSource: 'managed',
      updateSupported: params.readOnly !== true && runtimeSpec.managedInstall !== null,
      updateCommand: null,
      nativeUpdateArgs: null,
    };
  }
  if (params.source === 'override') return OTHER;

  const env = params.env ?? process.env;
  const realPath = (() => {
    try {
      return realpathSync(params.command);
    } catch {
      return params.command;
    }
  })();
  const paths = [params.command, realPath].map((path) => toComparablePath(path, platform));
  const home = toComparablePath(resolveUserHomeDir(env, platform), platform);

  const nativeUpdate = runtimeSpec.nativeUpdate ?? null;
  if (nativeUpdate) {
    const roots = nativeUpdate.installPaths.map((relative) => toComparablePath(`${home}/${relative}`, platform));
    if (paths.some((path) => roots.some((root) => isSameOrWithin(path, root)))) {
      return {
        installSource: 'native',
        updateSupported: true,
        updateCommand: [quoteCommandPath(params.command, platform), ...nativeUpdate.args].join(' '),
        nativeUpdateArgs: [...nativeUpdate.args],
      };
    }
  }

  const packages = [...new Set([resolveAgentCliNpmPackageName(runtimeSpec), runtimeSpec.npmPackageName])]
    .flatMap((packageName) => packageName ? [{
      packageName,
      insidePackage: paths.some((path) => `${path}/`.includes(`/node_modules/${toComparablePath(packageName, platform)}/`)),
      // POSIX npm links into the package; Windows shims sit beside node_modules.
      windowsShimProof: existsSync(join(dirname(params.command), 'node_modules', ...packageName.split('/'), 'package.json')),
    }] : []);
  // Prove the package before using a generic manager-directory hint. A legacy
  // package's real path must win over the manifest's current managed package.
  const installedPackage = packages.find((entry) => entry.insidePackage)
    ?? packages.find((entry) => entry.windowsShimProof) ?? packages[0];
  if (installedPackage) {
    const { packageName, insidePackage, windowsShimProof } = installedPackage;
    const allowBuild = runtimeSpec.managedInstall?.kind === 'managed_package'
      && runtimeSpec.managedInstall.packageName === packageName && runtimeSpec.managedInstall.allowBuild === true;
    if (insidePackage && paths.some((path) => path.includes('/.bun/install/global/'))) {
      return packageManagerFacts('bun', `bun add -g ${allowBuild ? '--trust ' : ''}${packageName}@latest`, packageName);
    }
    const pnpmHome = typeof env.PNPM_HOME === 'string' && env.PNPM_HOME.trim()
      ? toComparablePath(env.PNPM_HOME.trim(), platform)
      : null;
    if (
      (insidePackage && paths.some((path) => path.includes('/pnpm/global/')))
      || (pnpmHome !== null && toComparablePath(dirname(params.command), platform) === pnpmHome)
    ) {
      return packageManagerFacts('pnpm', `pnpm add -g ${allowBuild ? `--allow-build=${packageName} ` : ''}${packageName}@latest`, packageName);
    }
    if (insidePackage || windowsShimProof) {
      return packageManagerFacts('npm', `npm install -g ${packageName}@latest`, packageName);
    }
  }

  const keg = /\/(Cellar|Caskroom)\/([^/]+)\//i.exec(toComparablePath(realPath, platform));
  if (keg) {
    const name = keg[2]!;
    return packageManagerFacts('brew', keg[1]!.toLowerCase() === 'caskroom' ? `brew upgrade --cask ${name}` : `brew upgrade ${name}`);
  }

  return OTHER;
}

function extractVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(value);
  return match?.[0] ?? null;
}

function buildNpmPackageUrl(packageName: string): string {
  return `https://registry.npmjs.org/${packageName.replace('/', '%2F')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type AgentCliLatestVersionFacts = Readonly<{
  /** The newest version this install's owner would install now; `null` = unknown. */
  latestVersion: string | null;
  /** A newer published version the owner's release-age rule still holds back. */
  heldVersion: Readonly<{ version: string; minimumReleaseAgeMs: number }> | null;
}>;

/**
 * The managed installer (`pnpm add <pkg>`) resolves the `latest` tag but, under pnpm's
 * release-age rule, installs the newest stable version up to it that is at least that old.
 */
function selectManagedPackageVersion(params: Readonly<{
  packument: unknown;
  minimumReleaseAgeMs: number;
  nowMs: number;
}>): AgentCliLatestVersionFacts {
  const packument = isRecord(params.packument) ? params.packument : {};
  const distTags = isRecord(packument['dist-tags']) ? packument['dist-tags'] : {};
  const latest = extractVersion(distTags.latest);
  const times = isRecord(packument.time) ? packument.time : {};
  if (!latest) return { latestVersion: null, heldVersion: null };
  const cutoff = params.nowMs - params.minimumReleaseAgeMs;
  const publishedAt = (version: string): number => {
    const raw = times[version];
    return typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
  };
  const latestPublishedAt = publishedAt(latest);
  if (!Number.isFinite(latestPublishedAt) || latestPublishedAt <= cutoff) {
    return { latestVersion: latest, heldVersion: null };
  }
  const installable = Object.keys(times)
    .filter((version) => /^\d+\.\d+\.\d+$/.test(version))
    .filter((version) => compareVersions(version, latest) < 0 && publishedAt(version) <= cutoff)
    .sort(compareVersions)
    .at(-1) ?? null;
  return {
    latestVersion: installable,
    heldVersion: { version: latest, minimumReleaseAgeMs: params.minimumReleaseAgeMs },
  };
}

/**
 * The newest version the owner of this install would install. Happier-managed installs follow
 * their declared release tag or package release-age rule. Independently owned installs retain
 * the vendor's GitHub latest release or npm `latest` tag. Rejects on
 * transport/registry failure so callers can decide what to cache.
 */
export async function fetchAgentCliLatestVersion(params: Readonly<{
  runtimeSpec: AgentCliRuntimeDescriptor;
  installSource: AgentCliInstallSource;
  npmPackageName?: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  deps?: Readonly<{
    fetchImpl?: typeof fetch;
    fetchGitHubLatestRelease?: typeof fetchGitHubLatestRelease;
    readMinimumReleaseAgeMs?: (env: NodeJS.ProcessEnv) => Promise<number | null>;
  }>;
}>): Promise<AgentCliLatestVersionFacts> {
  params.signal?.throwIfAborted();
  const source = resolveAgentCliLatestVersionSource(params.runtimeSpec, params);
  if (!source) return { latestVersion: null, heldVersion: null };
  const env = params.env ?? process.env;

  if (source.kind === 'github_release') {
    // The managed installer follows this declaration, not GitHub's latest.
    // Inventory refreshes need no network observation to rediscover that pin.
    if (params.installSource === 'managed' && source.releaseTag !== undefined) {
      return { latestVersion: extractVersion(source.releaseTag), heldVersion: null };
    }
    const releaseRequest = {
      githubRepo: source.githubRepo,
      userAgent: 'happier-cli',
      githubToken: env.GITHUB_TOKEN,
      signal: params.signal,
    };
    const release = await (params.deps?.fetchGitHubLatestRelease ?? fetchGitHubLatestRelease)(releaseRequest);
    const tag = isRecord(release) ? release.tag_name : null;
    return { latestVersion: extractVersion(tag), heldVersion: null };
  }

  const fetchImpl = params.deps?.fetchImpl ?? globalThis.fetch;
  const fetchJson = async (url: string): Promise<unknown> => {
    const response = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': 'happier-cli' }, signal: params.signal });
    if (!response.ok) {
      throw new Error(`[npm] failed to resolve latest ${source.packageName} (${response.status})`);
    }
    return await response.json();
  };

  if (params.installSource === 'managed' && params.runtimeSpec.managedInstall?.kind === 'managed_package') {
    const minimumReleaseAgeMs = await (params.deps?.readMinimumReleaseAgeMs ?? readManagedPnpmMinimumReleaseAgeMs)(env);
    if (minimumReleaseAgeMs) {
      return selectManagedPackageVersion({
        packument: await fetchJson(buildNpmPackageUrl(source.packageName)),
        minimumReleaseAgeMs,
        nowMs: (params.now ?? Date.now)(),
      });
    }
  }

  const payload = await fetchJson(`${buildNpmPackageUrl(source.packageName)}/latest`);
  return { latestVersion: extractVersion(isRecord(payload) ? payload.version : null), heldVersion: null };
}
