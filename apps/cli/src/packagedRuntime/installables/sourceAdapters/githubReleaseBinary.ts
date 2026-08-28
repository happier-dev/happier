import { access, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { basename, dirname, join, delimiter as PATH_DELIMITER } from 'node:path';

import type { InstallableDependencyDescriptor } from '@happier-dev/protocol';
import { GH_INSTALLABLE_DESCRIPTOR, GH_RUNTIME_INSTALLABLE_POLICY } from '@happier-dev/protocol';
import {
  CODEX_ACP_RUNTIME_INSTALLABLE_POLICY,
  hasCodexAcpRuntimeInstallableAdapterPolicy,
} from '@happier-dev/plugins-codex/agent/installables/codexAcp';
import {
  createManagedToolScratchDir,
  downloadGitHubReleaseAsset,
  extractGitHubReleaseAsset,
  promoteManagedCurrentInstall,
} from '@happier-dev/cli-common/agents';
import { extractReleasePayloadRootFromArchive } from '@happier-dev/cli-common/firstPartyRuntime';
import { resolveWindowsCommandOnPath } from '@happier-dev/cli-common/process';
import { fetchGitHubLatestRelease } from '@happier-dev/release-runtime/github';

import { configuration } from '@/configuration';
import { createGhRuntimeInstallableAdapter } from '../ghRuntimeInstallable';
import { createCodexAcpRuntimeInstallableAdapter } from './codexAcpRuntimeInstallable';
import type { RuntimeInstallableAdapter } from '../registry';
import { runCliCommandBestEffort } from '@/capabilities/cliAuth/shared';
import { writeRuntimeInstallableLastCheckAtMs } from '../updateState';

type GitHubReleaseAsset = Readonly<{
  name: string;
  url: string;
  digest: string | null;
  tag: string | null;
  version: string | null;
}>;

type GitHubReleaseBinaryInstallableDescriptor = InstallableDependencyDescriptor & Readonly<{
  source: Extract<InstallableDependencyDescriptor['source'], { kind: 'github_release_binary' }>;
}>;

type GitHubReleaseBinaryInstallPolicy = Readonly<{
  archiveLayout: 'bin_directory' | 'single_executable';
  selectReleaseAsset: (
    release: unknown,
    runtime: Readonly<{ platform: string; arch: string }>,
  ) => GitHubReleaseAsset;
}>;

const currentReleaseRuntime = () => ({ platform: process.platform, arch: process.arch });

const githubFetchImpl = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined;

function primaryCommand(descriptor: InstallableDependencyDescriptor): string {
  const command = descriptor.binary.commands[0]?.trim();
  if (!command) {
    throw new Error(`Installable "${descriptor.key}" has no binary command`);
  }
  return command;
}

function managedInstallDir(descriptor: InstallableDependencyDescriptor): string {
  return join(configuration.happyHomeDir, 'tools', descriptor.key);
}

function managedBinPath(descriptor: InstallableDependencyDescriptor): string {
  const command = primaryCommand(descriptor);
  return join(managedInstallDir(descriptor), 'current', 'bin', process.platform === 'win32' && !command.endsWith('.exe')
    ? `${command}.exe`
    : command);
}

async function resolveCommandOnPath(command: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const pathRaw = typeof env.PATH === 'string' ? env.PATH.trim() : '';
  if (!pathRaw) return null;

  if (process.platform === 'win32') {
    return resolveWindowsCommandOnPath(command, env);
  }

  for (const dir of pathRaw.split(PATH_DELIMITER).map((entry) => entry.trim()).filter(Boolean)) {
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

async function resolveManagedBinPath(descriptor: InstallableDependencyDescriptor): Promise<string | null> {
  const candidate = managedBinPath(descriptor);
  const accessMode = process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK;
  try {
    await access(candidate, accessMode);
    return candidate;
  } catch {
    return null;
  }
}

function parseVersionFromOutput(command: string, stdout: string): string | null {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const commandMatch = new RegExp(`\\b${escaped}\\s+version\\s+([0-9]+(?:\\.[0-9]+){1,3}(?:[-+][A-Za-z0-9.-]+)?)`, 'i').exec(stdout);
  if (commandMatch?.[1]) return commandMatch[1];
  const genericMatch = /\bversion\s+([0-9]+(?:\.[0-9]+){1,3}(?:[-+][A-Za-z0-9.-]+)?)/i.exec(stdout);
  return genericMatch?.[1] ?? null;
}

async function readInstalledVersion(descriptor: InstallableDependencyDescriptor, binPath: string): Promise<string | null> {
  const result = await runCliCommandBestEffort({
    resolvedPath: binPath,
    args: ['--version'],
    timeoutMs: 2_000,
  });
  return result.ok ? parseVersionFromOutput(primaryCommand(descriptor), result.stdout) : null;
}

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

function selectReleaseAsset(release: unknown): GitHubReleaseAsset {
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

async function writeInstallLog(params: Readonly<{ logPath: string; lines: readonly string[] }>): Promise<void> {
  await mkdir(dirname(params.logPath), { recursive: true });
  await writeFile(params.logPath, `${params.lines.join('\n')}\n`, 'utf8');
}

type ManagedInstallState = Readonly<{
  installedVersion: string | null;
  lastInstallLogPath: string | null;
}>;

function installStatePath(descriptor: InstallableDependencyDescriptor): string {
  return join(managedInstallDir(descriptor), 'install-state.json');
}

async function readManagedInstallState(descriptor: InstallableDependencyDescriptor): Promise<ManagedInstallState> {
  try {
    const parsed = JSON.parse(await readFile(installStatePath(descriptor), 'utf8')) as Partial<ManagedInstallState>;
    return {
      installedVersion: typeof parsed.installedVersion === 'string' ? parsed.installedVersion : null,
      lastInstallLogPath: typeof parsed.lastInstallLogPath === 'string' ? parsed.lastInstallLogPath : null,
    };
  } catch {
    return { installedVersion: null, lastInstallLogPath: null };
  }
}

async function writeManagedInstallState(
  descriptor: InstallableDependencyDescriptor,
  state: ManagedInstallState,
): Promise<void> {
  await mkdir(managedInstallDir(descriptor), { recursive: true });
  await writeFile(installStatePath(descriptor), JSON.stringify(state, null, 2), 'utf8');
}

function isGitHubReleaseBinaryDescriptor(
  descriptor: InstallableDependencyDescriptor,
): descriptor is GitHubReleaseBinaryInstallableDescriptor {
  return descriptor.source.kind === 'github_release_binary';
}

async function installGitHubReleaseBinary(
  descriptor: GitHubReleaseBinaryInstallableDescriptor,
  policy: GitHubReleaseBinaryInstallPolicy,
): Promise<Readonly<{ ok: true; logPath: string } | { ok: false; errorMessage: string; logPath: string }>> {
  const logPath = join(configuration.logsDir, `install-${descriptor.key}-${Date.now()}.log`);
  try {
    const release = await fetchGitHubLatestRelease({
      githubRepo: descriptor.source.repo,
      userAgent: 'happier-cli',
      githubToken: process.env.GITHUB_TOKEN,
      ...(githubFetchImpl ? { fetchImpl: githubFetchImpl } : {}),
    });
    const asset = policy.selectReleaseAsset(release, currentReleaseRuntime());
    const installRoot = managedInstallDir(descriptor);
    const scratchDir = await createManagedToolScratchDir({
      installDir: installRoot,
      prefix: descriptor.key,
    });
    try {
      const archivePath = join(scratchDir, basename(asset.name));
      const extractDir = join(scratchDir, 'extract');
      const candidateDir = join(scratchDir, 'candidate');
      const candidateBinPath = join(candidateDir, 'bin', process.platform === 'win32' && !primaryCommand(descriptor).endsWith('.exe')
        ? `${primaryCommand(descriptor)}.exe`
        : primaryCommand(descriptor));

      await downloadGitHubReleaseAsset({
        url: asset.url,
        destinationPath: archivePath,
        digest: asset.digest,
        userAgent: 'happier-cli',
      });
      await mkdir(dirname(candidateBinPath), { recursive: true });
      if (policy.archiveLayout === 'single_executable') {
        await extractGitHubReleaseAsset({
          archivePath,
          archiveName: asset.name,
          extractDir,
          outputPath: candidateBinPath,
        });
      } else {
        const payloadRoot = await extractReleasePayloadRootFromArchive({
          archivePath,
          archiveName: asset.name,
          extractDir,
        });
        const payloadBinPath = join(payloadRoot, 'bin', process.platform === 'win32' && !primaryCommand(descriptor).endsWith('.exe')
          ? `${primaryCommand(descriptor)}.exe`
          : primaryCommand(descriptor));
        await rename(payloadBinPath, candidateBinPath);
      }
      if (process.platform !== 'win32') {
        await chmod(candidateBinPath, 0o755);
      }
      await writeInstallLog({
        logPath,
        lines: [
          '# source: github_release_binary',
          `# key: ${descriptor.key}`,
          `# repo: ${descriptor.source.repo}`,
          `# asset: ${asset.name}`,
          `# releaseTag: ${asset.tag ?? 'unknown'}`,
          `# version: ${asset.version ?? 'unknown'}`,
        ],
      });
      await promoteManagedCurrentInstall({
        installRoot,
        candidatePath: candidateDir,
      });
      await rm(join(installRoot, 'node_modules'), { recursive: true, force: true });
      await rm(join(installRoot, 'package.json'), { force: true });
      await rm(join(installRoot, 'package-lock.json'), { force: true });
      await writeManagedInstallState(descriptor, {
        installedVersion: asset.version,
        lastInstallLogPath: logPath,
      });
      return { ok: true, logPath };
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Install failed';
    try {
      await writeInstallLog({ logPath, lines: [errorMessage] });
      await writeManagedInstallState(descriptor, {
        installedVersion: (await readManagedInstallState(descriptor)).installedVersion,
        lastInstallLogPath: logPath,
      });
    } catch {
    }
    return { ok: false, errorMessage, logPath };
  }
}

function createGenericGitHubReleaseBinaryRuntimeInstallable(
  descriptor: GitHubReleaseBinaryInstallableDescriptor,
  policy: GitHubReleaseBinaryInstallPolicy = {
    archiveLayout: 'bin_directory',
    selectReleaseAsset,
  },
): RuntimeInstallableAdapter {
  return {
    key: descriptor.key,
    capabilityId: descriptor.capabilityId,
    detectLaunchResolution: async (params = {}) => {
      const command = primaryCommand(descriptor);
      const env = params.env ?? process.env;
      const systemBinPath = descriptor.binary.systemFirst === false
        ? null
        : await resolveCommandOnPath(command, env);
      const managedBinPath = descriptor.binary.managedFallback === false
        ? null
        : await resolveManagedBinPath(descriptor);
      const resolvedPath = systemBinPath ?? managedBinPath;
      if (!resolvedPath) {
        return {
          availability: { ok: false, errorMessage: `${descriptor.display.name} is not installed` },
          canAutoInstall: descriptor.binary.managedFallback !== false,
          canBackgroundAutoUpdate: false,
        };
      }
      return {
        availability: { ok: true },
        canAutoInstall: false,
        canBackgroundAutoUpdate: resolvedPath === managedBinPath,
      };
    },
    resolveLaunchCommand: async (params = {}) => {
      const command = primaryCommand(descriptor);
      const env = params.env ?? process.env;
      const preferManaged = params.sourcePreference === 'managed-first';
      const systemBinPath = descriptor.binary.systemFirst === false
        ? null
        : await resolveCommandOnPath(command, env);
      const managedPath = descriptor.binary.managedFallback === false
        ? null
        : await resolveManagedBinPath(descriptor);
      const resolvedPath = preferManaged
        ? managedPath ?? systemBinPath
        : systemBinPath ?? managedPath;
      if (!resolvedPath) {
        return {
          ok: false,
          errorMessage: `${descriptor.display.name} is not installed`,
          canAutoInstall: descriptor.binary.managedFallback !== false,
        };
      }
      return {
        ok: true,
        command: resolvedPath,
        args: [],
        source: resolvedPath === managedPath ? 'managed' : 'system',
      };
    },
    installOrUpgrade: () => installGitHubReleaseBinary(descriptor, policy),
    runBackgroundAutoUpdateCheck: async () => {
      const binPath = await resolveManagedBinPath(descriptor);
      if (!binPath) return;
      const installedVersion = await readInstalledVersion(descriptor, binPath);
      const release = await fetchGitHubLatestRelease({
        githubRepo: descriptor.source.repo,
        userAgent: 'happier-cli',
        githubToken: process.env.GITHUB_TOKEN,
        ...(githubFetchImpl ? { fetchImpl: githubFetchImpl } : {}),
      });
      const latestVersion = policy.selectReleaseAsset(release, currentReleaseRuntime()).version;
      await writeRuntimeInstallableLastCheckAtMs(descriptor.key, Date.now());
      if (!installedVersion || !latestVersion || installedVersion === latestVersion) return;
      await installGitHubReleaseBinary(descriptor, policy);
    },
  };
}

export async function getGitHubReleaseBinaryRuntimeInstallableAdapter(
  descriptor: InstallableDependencyDescriptor,
): Promise<RuntimeInstallableAdapter | null> {
  if (!isGitHubReleaseBinaryDescriptor(descriptor)) {
    return null;
  }
  if (hasCodexAcpRuntimeInstallableAdapterPolicy(descriptor)) {
    const hostAdapter = createGenericGitHubReleaseBinaryRuntimeInstallable(
      descriptor,
      CODEX_ACP_RUNTIME_INSTALLABLE_POLICY,
    );
    return createCodexAcpRuntimeInstallableAdapter(descriptor, hostAdapter);
  }
  if (descriptor.key === GH_INSTALLABLE_DESCRIPTOR.key) {
    const hostAdapter = createGenericGitHubReleaseBinaryRuntimeInstallable(
      descriptor,
      GH_RUNTIME_INSTALLABLE_POLICY,
    );
    return createGhRuntimeInstallableAdapter(hostAdapter);
  }
  return createGenericGitHubReleaseBinaryRuntimeInstallable(descriptor);
}
