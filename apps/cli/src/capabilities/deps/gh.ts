import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { basename, dirname, join, delimiter as PATH_DELIMITER } from 'node:path';

import {
  GH_BINARY_NAME,
  GH_DEP_ID,
  GH_GITHUB_REPO,
  INSTALLABLE_KEYS,
} from '@happier-dev/protocol/installables';
import {
  createManagedToolScratchDir,
  downloadGitHubReleaseAsset,
  promoteManagedCurrentInstall,
} from '@happier-dev/cli-common/agents';
import { extractReleasePayloadRootFromArchive } from '@happier-dev/cli-common/firstPartyRuntime';
import { resolveWindowsCommandOnPath } from '@happier-dev/cli-common/process';
import { fetchGitHubLatestRelease } from '@happier-dev/release-runtime/github';

import { configuration } from '@/configuration';
import { runCliCommandBestEffort } from '@/capabilities/cliAuth/shared';
import { readRuntimeInstallableLastCheckAtMs } from '@/packagedRuntime/installables/updateState';

type GhState = Readonly<{
  installedVersion: string | null;
  lastInstallLogPath: string | null;
}>;

type GhCommandResult = Readonly<{
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}>;

type GhReleaseAsset = Readonly<{
  name: string;
  url: string;
  digest: string | null;
  tag: string | null;
  version: string | null;
}>;

type LatestVersionCheck =
  | Readonly<{ ok: true; latestVersion: string | null; label: string | null }>
  | Readonly<{ ok: false; errorMessage: string }>;

type GhStatusDeps = Readonly<{
  resolveSystemGhBinPath: (env?: NodeJS.ProcessEnv) => Promise<string | null>;
  resolveManagedGhBinPath: (env?: NodeJS.ProcessEnv) => Promise<string | null>;
  runGhCommand: (params: Readonly<{ binPath: string; args: readonly string[]; timeoutMs?: number }>) => Promise<GhCommandResult>;
  readState: () => Promise<GhState>;
  readLastBackgroundUpdateCheckAtMs: () => Promise<number | null>;
}>;

type GhInstallDeps = Readonly<{
  fetchLatestRelease: typeof fetchGitHubLatestRelease;
  downloadGitHubReleaseAsset: typeof downloadGitHubReleaseAsset;
  extractReleasePayloadRootFromArchive: typeof extractReleasePayloadRootFromArchive;
}>;

const githubFetchImpl = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined;

export type GhDepData = Readonly<{
  installed: boolean;
  capabilityId: typeof GH_DEP_ID;
  installDir: string;
  binPath: string | null;
  managedBinPath: string | null;
  installedVersion: string | null;
  sourceKind: 'github_release_binary';
  resolvedSource: 'system' | 'managed' | null;
  authenticated: boolean | null;
  authStatus: 'authenticated' | 'missing_auth' | 'unknown';
  remediationReason: 'install_required' | 'auth_required' | 'unsupported' | null;
  lastInstallLogPath: string | null;
  lastBackgroundUpdateCheckAtMs: number | null;
  latestVersionCheck?: LatestVersionCheck;
}>;

export const ghInstallDir = () => join(configuration.happyHomeDir, 'tools', INSTALLABLE_KEYS.GH);

export const ghBinPath = () => {
  const binaryName = process.platform === 'win32' ? 'gh.exe' : GH_BINARY_NAME;
  return join(ghInstallDir(), 'current', 'bin', binaryName);
};

const ghStatePath = () => join(ghInstallDir(), 'install-state.json');

async function readGhState(): Promise<GhState> {
  try {
    const raw = await readFile(ghStatePath(), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      installedVersion: typeof parsed?.installedVersion === 'string' ? parsed.installedVersion : null,
      lastInstallLogPath: typeof parsed?.lastInstallLogPath === 'string' ? parsed.lastInstallLogPath : null,
    };
  } catch {
    return { installedVersion: null, lastInstallLogPath: null };
  }
}

async function writeGhState(next: GhState): Promise<void> {
  await mkdir(ghInstallDir(), { recursive: true });
  await writeFile(ghStatePath(), JSON.stringify(next, null, 2), 'utf8');
}

function parseVersionFromGhOutput(stdout: string): string | null {
  const match = /\bgh version\s+([0-9]+(?:\.[0-9]+){1,3}(?:[-+][A-Za-z0-9.-]+)?)/i.exec(stdout);
  return match?.[1] ?? null;
}

function parseGhVersionFromTag(tag: string | null | undefined): string | null {
  const value = typeof tag === 'string' ? tag.trim() : '';
  if (!value) return null;
  const match = /^v?(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)$/.exec(value);
  return match?.[1] ?? null;
}

function ghAssetPlatformPart(): string {
  if (process.platform === 'darwin') return 'macOS';
  if (process.platform === 'linux') return 'linux';
  if (process.platform === 'win32') return 'windows';
  throw new Error(`Unsupported gh platform: ${process.platform}/${process.arch}`);
}

function ghAssetArchPart(): string {
  if (process.arch === 'arm64') return 'arm64';
  if (process.arch === 'x64') return 'amd64';
  throw new Error(`Unsupported gh platform: ${process.platform}/${process.arch}`);
}

function isGhManagedInstallSupported(): boolean {
  try {
    ghAssetPlatformPart();
    ghAssetArchPart();
    return true;
  } catch {
    return false;
  }
}

function normalizeReleaseAssets(raw: unknown): Array<Readonly<{ name: string; url: string; digest: string | null }>> {
  if (!Array.isArray(raw)) return [];
  const assets: Array<Readonly<{ name: string; url: string; digest: string | null }>> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const name = typeof (entry as { name?: unknown }).name === 'string'
      ? (entry as { name: string }).name.trim()
      : '';
    const url = typeof (entry as { browser_download_url?: unknown }).browser_download_url === 'string'
      ? (entry as { browser_download_url: string }).browser_download_url.trim()
      : '';
    const digest = typeof (entry as { digest?: unknown }).digest === 'string'
      ? (entry as { digest: string }).digest.trim()
      : null;
    if (!name || !url) continue;
    assets.push({ name, url, digest });
  }
  return assets;
}

export function resolveGhReleaseAsset(release: unknown): GhReleaseAsset {
  const parsed = release && typeof release === 'object'
    ? release as { tag_name?: unknown; assets?: unknown }
    : {};
  const tag = typeof parsed.tag_name === 'string' && parsed.tag_name.trim().length > 0
    ? parsed.tag_name.trim()
    : null;
  const version = parseGhVersionFromTag(tag);
  const platform = ghAssetPlatformPart();
  const arch = ghAssetArchPart();
  const extension = process.platform === 'linux' ? '.tar.gz' : '.zip';
  const preferredName = version ? `gh_${version}_${platform}_${arch}${extension}` : null;
  const assets = normalizeReleaseAssets(parsed.assets);
  const selected = (preferredName ? assets.find((asset) => asset.name === preferredName) : undefined)
    ?? assets.find((asset) => asset.name.includes(`_${platform}_${arch}`) && asset.name.endsWith(extension));

  if (!selected) {
    throw new Error(`No gh release asset found for ${platform}/${arch}`);
  }

  return {
    name: selected.name,
    url: selected.url,
    digest: selected.digest,
    tag,
    version,
  };
}

async function writeInstallLog(params: Readonly<{ logPath: string; lines: readonly string[] }>): Promise<void> {
  await mkdir(dirname(params.logPath), { recursive: true });
  await writeFile(params.logPath, `${params.lines.join('\n')}\n`, 'utf8');
}

async function installLatestGhRelease(logPath: string, deps: GhInstallDeps): Promise<Readonly<{ version: string | null }>> {
  const release = await deps.fetchLatestRelease({
    githubRepo: GH_GITHUB_REPO,
    userAgent: 'happier-cli',
    githubToken: process.env.GITHUB_TOKEN,
    ...(githubFetchImpl ? { fetchImpl: githubFetchImpl } : {}),
  });
  const asset = resolveGhReleaseAsset(release);
  const installRoot = ghInstallDir();
  const scratchDir = await createManagedToolScratchDir({
    installDir: installRoot,
    prefix: 'gh',
  });
  try {
    const archivePath = join(scratchDir, basename(asset.name));
    const extractDir = join(scratchDir, 'extract');
    const candidateDir = join(scratchDir, 'candidate');
    const candidateBinPath = join(candidateDir, 'bin', process.platform === 'win32' ? 'gh.exe' : GH_BINARY_NAME);

    await deps.downloadGitHubReleaseAsset({
      url: asset.url,
      destinationPath: archivePath,
      digest: asset.digest,
      userAgent: 'happier-cli',
    });

    const payloadRoot = await deps.extractReleasePayloadRootFromArchive({
      archivePath,
      archiveName: asset.name,
      extractDir,
    });
    const payloadBinPath = join(payloadRoot, 'bin', process.platform === 'win32' ? 'gh.exe' : GH_BINARY_NAME);
    await mkdir(dirname(candidateBinPath), { recursive: true });
    await rename(payloadBinPath, candidateBinPath);
    if (process.platform !== 'win32') {
      await access(candidateBinPath, fsConstants.X_OK);
    }

    await writeInstallLog({
      logPath,
      lines: [
        '# source: github_release_binary',
        `# repo: ${GH_GITHUB_REPO}`,
        `# asset: ${asset.name}`,
        `# releaseTag: ${asset.tag ?? 'unknown'}`,
        `# version: ${asset.version ?? 'unknown'}`,
      ],
    });
    await promoteManagedCurrentInstall({
      installRoot,
      candidatePath: candidateDir,
    });
    return { version: asset.version };
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

/**
 * Marker required to authorize a `dep.gh` install. Callers must obtain this token
 * from the user-confirmed install consent path (FD-0054 `consent.install: 'required'`).
 * The string is opaque — it exists so an installable cannot be triggered by accident
 * from a non-consent code path. Do NOT log or persist this token.
 */
export const INSTALL_GH_CONSENT_TOKEN: unique symbol = Symbol('happier:dep.gh:install-consent') as never;
export type InstallGhConsentToken = typeof INSTALL_GH_CONSENT_TOKEN;

export async function installGh(
  consent: InstallGhConsentToken,
  depsOverrides: Partial<GhInstallDeps> = {},
): Promise<{ ok: true; logPath: string } | { ok: false; errorMessage: string; logPath: string }> {
  if (consent !== INSTALL_GH_CONSENT_TOKEN) {
    throw new Error('installGh requires INSTALL_GH_CONSENT_TOKEN; route the call through the user-confirmed dep.gh install consent flow.');
  }
  const deps: GhInstallDeps = {
    fetchLatestRelease: depsOverrides.fetchLatestRelease ?? fetchGitHubLatestRelease,
    downloadGitHubReleaseAsset: depsOverrides.downloadGitHubReleaseAsset ?? downloadGitHubReleaseAsset,
    extractReleasePayloadRootFromArchive:
      depsOverrides.extractReleasePayloadRootFromArchive ?? extractReleasePayloadRootFromArchive,
  };
  const logPath = join(configuration.logsDir, `install-dep-gh-${Date.now()}.log`);
  try {
    const installed = await installLatestGhRelease(logPath, deps);
    await writeGhState({
      installedVersion: installed.version,
      lastInstallLogPath: logPath,
    });
    return { ok: true, logPath };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Install failed';
    try {
      await writeInstallLog({ logPath, lines: [errorMessage] });
      await writeGhState({
        installedVersion: (await readGhState()).installedVersion,
        lastInstallLogPath: logPath,
      });
    } catch {
    }
    return { ok: false, errorMessage, logPath };
  }
}

async function resolveCommandOnPath(command: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const pathRaw = typeof env.PATH === 'string' ? env.PATH.trim() : '';
  if (!pathRaw) return null;

  if (process.platform === 'win32') {
    return resolveWindowsCommandOnPath(command, env);
  }

  const segments = pathRaw
    .split(PATH_DELIMITER)
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const dir of segments) {
    const candidate = join(dir, command);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // continue
    }
  }
  return null;
}

async function resolveSystemGhBinPath(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  return resolveCommandOnPath(GH_BINARY_NAME, env);
}

async function resolveManagedGhBinPath(): Promise<string | null> {
  const candidate = ghBinPath();
  const accessMode = process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK;
  try {
    await access(candidate, accessMode);
    return candidate;
  } catch {
    return null;
  }
}

async function runGhCommand(params: Readonly<{ binPath: string; args: readonly string[]; timeoutMs?: number }>): Promise<GhCommandResult> {
  return runCliCommandBestEffort({
    resolvedPath: params.binPath,
    args: [...params.args],
    timeoutMs: params.timeoutMs ?? 2_000,
  });
}

async function detectLatestVersionCheck(): Promise<LatestVersionCheck> {
  try {
    const release = await fetchGitHubLatestRelease({
      githubRepo: GH_GITHUB_REPO,
      userAgent: 'happier-cli',
      githubToken: process.env.GITHUB_TOKEN,
      ...(githubFetchImpl ? { fetchImpl: githubFetchImpl } : {}),
    });
    const asset = resolveGhReleaseAsset(release);
    return { ok: true, latestVersion: asset.version, label: asset.tag };
  } catch (error) {
    return {
      ok: false,
      errorMessage: error instanceof Error ? error.message : 'Failed to resolve latest gh release',
    };
  }
}

async function probeGh(params: Readonly<{
  binPath: string;
  source: 'system' | 'managed';
  deps: GhStatusDeps;
}>): Promise<Pick<GhDepData, 'binPath' | 'resolvedSource' | 'installedVersion' | 'authenticated' | 'authStatus' | 'remediationReason'>> {
  const versionResult = await params.deps.runGhCommand({ binPath: params.binPath, args: ['--version'] });
  const authResult = await params.deps.runGhCommand({
    binPath: params.binPath,
    args: ['auth', 'status', '--hostname', 'github.com'],
  });
  const authenticated = authResult.ok === true;

  return {
    binPath: params.binPath,
    resolvedSource: params.source,
    installedVersion: parseVersionFromGhOutput(versionResult.stdout),
    authenticated,
    authStatus: authenticated ? 'authenticated' : 'missing_auth',
    remediationReason: authenticated ? null : 'auth_required',
  };
}

export async function getGhDepStatus(
  opts: Readonly<{ includeLatestVersion?: boolean; onlyIfInstalled?: boolean }> = {},
  depsOverrides: Partial<GhStatusDeps> = {},
): Promise<GhDepData> {
  const deps: GhStatusDeps = {
    resolveSystemGhBinPath: depsOverrides.resolveSystemGhBinPath ?? resolveSystemGhBinPath,
    resolveManagedGhBinPath: depsOverrides.resolveManagedGhBinPath ?? resolveManagedGhBinPath,
    runGhCommand: depsOverrides.runGhCommand ?? runGhCommand,
    readState: depsOverrides.readState ?? readGhState,
    readLastBackgroundUpdateCheckAtMs:
      depsOverrides.readLastBackgroundUpdateCheckAtMs
      ?? (() => readRuntimeInstallableLastCheckAtMs(INSTALLABLE_KEYS.GH)),
  };

  const [state, systemBinPath, managedBinPath, lastBackgroundUpdateCheckAtMs] = await Promise.all([
    deps.readState(),
    deps.resolveSystemGhBinPath(process.env),
    deps.resolveManagedGhBinPath(process.env),
    deps.readLastBackgroundUpdateCheckAtMs(),
  ]);

  const systemProbe = systemBinPath
    ? await probeGh({ binPath: systemBinPath, source: 'system', deps })
    : null;
  const managedProbe = managedBinPath
    ? await probeGh({ binPath: managedBinPath, source: 'managed', deps })
    : null;
  const selected = systemProbe?.authenticated === true
    ? systemProbe
    : managedProbe?.authenticated === true
      ? managedProbe
      : systemProbe ?? managedProbe ?? null;
  const installed = selected !== null;
  const managedInstallSupported = isGhManagedInstallSupported();
  const includeLatestVersion = opts.includeLatestVersion === true;
  const onlyIfInstalled = opts.onlyIfInstalled === true;
  const latestVersionCheck = includeLatestVersion && (!onlyIfInstalled || installed)
    ? await detectLatestVersionCheck()
    : undefined;

  return {
    installed,
    capabilityId: GH_DEP_ID,
    installDir: ghInstallDir(),
    binPath: selected?.binPath ?? null,
    managedBinPath,
    installedVersion: selected?.installedVersion ?? state.installedVersion,
    sourceKind: 'github_release_binary',
    resolvedSource: selected?.resolvedSource ?? null,
    authenticated: selected?.authenticated ?? null,
    authStatus: selected?.authStatus ?? 'unknown',
    remediationReason: selected?.remediationReason ?? (managedInstallSupported ? 'install_required' : 'unsupported'),
    lastInstallLogPath: state.lastInstallLogPath,
    lastBackgroundUpdateCheckAtMs,
    ...(latestVersionCheck ? { latestVersionCheck } : {}),
  };
}
