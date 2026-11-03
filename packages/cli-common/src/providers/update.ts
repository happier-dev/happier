import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type {
  AgentId,
  ProviderCliInstallSource,
  ProviderCliRuntimeInstallPlatform as ProviderCliInstallPlatform,
} from '@happier-dev/agents';
import {
  getProviderCliRuntimeSpec,
  resolveProviderCliLatestVersionSource,
  resolveProviderCliNpmPackageName,
} from '@happier-dev/agents';
import { fetchGitHubLatestRelease, requestJson } from '@happier-dev/release-runtime';

import { compareVersions } from '../update/index.js';
import { readManagedPnpmMinimumReleaseAgeMs } from './managedPnpm.js';

import { resolveHomeDirFromEnvironment, type ProviderCliResolutionSource } from './resolution.js';

export type ProviderCliUpdateFacts = Readonly<{
  installSource: ProviderCliInstallSource;
  /** Happier can run the update itself (managed reinstall, or the verified vendor updater). */
  updateSupported: boolean;
  /** The command a person can run to update this install, when one is known. */
  updateCommand: string | null;
  /** Arguments for the vendor updater, run against the resolved executable. */
  nativeUpdateArgs: ReadonlyArray<string> | null;
  /** Proven npm package identity, retained for the owner's latest-version lookup. */
  npmPackageName?: string;
}>;

const OTHER: ProviderCliUpdateFacts = {
  installSource: 'other',
  updateSupported: false,
  updateCommand: null,
  nativeUpdateArgs: null,
};

function toComparablePath(path: string, platform: ProviderCliInstallPlatform): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isSameOrWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function quoteCommandPath(path: string, platform: ProviderCliInstallPlatform): string {
  if (!/[\s'"&;|()$`]/.test(path)) return path;
  if (platform === 'win32') return `& "${path.replaceAll('"', '`"')}"`;
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

function packageManagerFacts(
  installSource: Extract<ProviderCliInstallSource, 'npm' | 'pnpm' | 'bun' | 'brew'>,
  updateCommand: string,
  npmPackageName?: string,
): ProviderCliUpdateFacts {
  // Happier does not spawn package managers from product runtime paths; the
  // owner's command is surfaced for the person to run.
  return { installSource, updateSupported: false, updateCommand, nativeUpdateArgs: null,
    ...(npmPackageName ? { npmPackageName } : {}) };
}

/**
 * Attributes an installed agent CLI to the owner that can update it, from the
 * exact executable the detect owner resolved (and its real path) plus catalog
 * facts. Anything unproven stays `other` with no command, so Happier never runs
 * or suggests an updater that does not own the install.
 */
export function classifyProviderCliInstall(params: Readonly<{
  providerId: AgentId;
  command: string;
  source: ProviderCliResolutionSource;
  platform: ProviderCliInstallPlatform;
  env?: NodeJS.ProcessEnv;
}>): ProviderCliUpdateFacts {
  const spec = getProviderCliRuntimeSpec(params.providerId);
  if (params.source === 'managed') {
    return {
      installSource: 'managed',
      updateSupported: spec.managedInstall !== null,
      updateCommand: null,
      nativeUpdateArgs: null,
    };
  }
  if (params.source === 'override') return OTHER;

  const env = params.env ?? process.env;
  const platform = params.platform;
  const realPath = (() => {
    try {
      return realpathSync(params.command);
    } catch {
      return params.command;
    }
  })();
  const paths = [params.command, realPath].map((path) => toComparablePath(path, platform));
  const home = toComparablePath(resolveHomeDirFromEnvironment(env), platform);

  const nativeUpdate = spec.nativeUpdate ?? null;
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

  const packages = [...new Set([resolveProviderCliNpmPackageName(spec), spec.npmPackageName])]
    .flatMap((packageName) => packageName ? [{
      packageName,
      insidePackage: paths.some((path) => `${path}/`.includes(`/node_modules/${toComparablePath(packageName, platform)}/`)),
      // POSIX npm links into the package; Windows shims sit beside node_modules.
      windowsShimProof: existsSync(join(dirname(params.command), 'node_modules', ...packageName.split('/'), 'package.json')),
    }] : []);
  // Prove the package before using a generic manager-directory hint. A legacy
  // package's real path must win over the current catalog's package name.
  const installedPackage = packages.find((entry) => entry.insidePackage)
    ?? packages.find((entry) => entry.windowsShimProof) ?? packages[0];
  if (installedPackage) {
    const { packageName, insidePackage, windowsShimProof } = installedPackage;
    const allowBuild = spec.managedInstall?.kind === 'managed_package'
      && spec.managedInstall.packageName === packageName && spec.managedInstall.allowBuild === true;
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

export type ProviderCliLatestVersionFacts = Readonly<{
  /** The newest version this install's owner would install now; `null` = unknown. */
  latestVersion: string | null;
  /** A newer published version the owner's release-age rule still holds back. */
  heldVersion: Readonly<{ version: string; minimumReleaseAgeMs: number }> | null;
}>;

type LatestVersionDeps = Readonly<{
  fetchJson?: (url: string) => Promise<unknown>;
  fetchGitHubLatestRelease?: typeof fetchGitHubLatestRelease;
  readMinimumReleaseAgeMs?: (env: NodeJS.ProcessEnv) => Promise<number | null>;
}>;

async function defaultFetchJson(url: string): Promise<unknown> {
  return await requestJson<unknown>({ url, headers: { accept: 'application/json', 'user-agent': 'happier-cli' } });
}

/**
 * The managed installer (`pnpm add <pkg>`) resolves the `latest` tag but, under pnpm's
 * release-age rule, installs the newest stable version up to it that is at least that old.
 */
function selectManagedPackageVersion(params: Readonly<{
  packument: unknown;
  minimumReleaseAgeMs: number;
  nowMs: number;
}>): ProviderCliLatestVersionFacts {
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
 * The newest version the owner of this install would install. A Happier-managed package
 * follows the managed installer's release-age rule; npm, native and other installs report
 * the catalog's latest-version source (GitHub latest release or the npm `latest` tag).
 * Rejects on transport/registry failure so callers can decide what to cache.
 */
export async function fetchProviderCliLatestVersion(params: Readonly<{
  providerId: AgentId;
  installSource: ProviderCliInstallSource;
  npmPackageName?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  deps?: LatestVersionDeps;
}>): Promise<ProviderCliLatestVersionFacts> {
  const spec = getProviderCliRuntimeSpec(params.providerId);
  const source = params.installSource !== 'managed' && params.npmPackageName
    ? { kind: 'npm' as const, packageName: params.npmPackageName }
    : resolveProviderCliLatestVersionSource(spec);
  if (!source) return { latestVersion: null, heldVersion: null };
  const env = params.env ?? process.env;
  const fetchJson = params.deps?.fetchJson ?? defaultFetchJson;

  if (source.kind === 'github_release') {
    const release = await (params.deps?.fetchGitHubLatestRelease ?? fetchGitHubLatestRelease)({
      githubRepo: source.githubRepo,
      userAgent: 'happier-cli',
      githubToken: env.GITHUB_TOKEN,
    });
    const tag = isRecord(release) ? release.tag_name : null;
    return { latestVersion: extractVersion(tag), heldVersion: null };
  }

  if (params.installSource === 'managed' && spec.managedInstall?.kind === 'managed_package') {
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
