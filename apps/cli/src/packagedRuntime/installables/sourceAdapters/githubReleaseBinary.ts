import { access, chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { basename, dirname, join, delimiter as PATH_DELIMITER } from 'node:path';

import type { InstallableDependencyDescriptor } from '@happier-dev/protocol';
import { GH_INSTALLABLE_DESCRIPTOR, GH_RUNTIME_INSTALLABLE_POLICY } from '@happier-dev/protocol/installables/definitions/gh';
import {
  createManagedToolScratchDir,
  downloadGitHubReleaseAsset,
  AgentCliDownloadError,
  extractGitHubReleaseAsset,
  promoteManagedCurrentInstall,
  resolveHappyHomeDirFromEnvironment,
  selectManagedDependencyReleaseAsset,
  type ManagedDependencyReleaseAsset,
} from '@happier-dev/cli-common/agents';
import { extractReleasePayloadRootFromArchive } from '@happier-dev/cli-common/firstPartyRuntime';
import { removeHappierTempDirAsync } from '@happier-dev/cli-common/tempDirs';
import { ExecFileTerminationError, resolveWindowsCommandOnPath } from '@happier-dev/cli-common/process';
import { GitHubReleaseRateLimitError } from '@happier-dev/release-runtime/github';
import { fetchGitHubLatestRelease } from '@/capabilities/cliUpdate/githubReleaseLookup';
import { ArchiveExtractionTimeoutError } from '@happier-dev/release-runtime/archiveExtraction';

import { configuration } from '@/configuration';
import { createGhRuntimeInstallableAdapter } from '../ghRuntimeInstallable';
import { createConfiguredBinaryRuntimeInstallableAdapter } from './configuredBinary';
import {
  managedBinaryInstallDir as managedInstallDir,
  readManagedBinaryState as readManagedInstallState,
  writeManagedBinaryState as writeManagedInstallState,
  resolveExistingManagedBinaryPath as resolveManagedBinPath,
} from '@/capabilities/deps/managedBinary';
import type { RuntimeInstallableAdapter, RuntimeInstallableInstallErrorCode, RuntimeInstallableInstallOptions, RuntimeInstallableInstallResult } from '../registry';
import { runCliCommandBestEffort } from '@/capabilities/cliAuth/shared';
import { parseInstalledVersionFromOutput } from '../installedVersion';
import { writeRuntimeInstallableLastCheckAtMs } from '../updateState';

type GitHubReleaseBinaryInstallableDescriptor = InstallableDependencyDescriptor & Readonly<{
  source: Extract<InstallableDependencyDescriptor['source'], { kind: 'github_release_binary' }>;
}>;

type GitHubReleaseBinaryInstallPolicy = Readonly<{
  archiveLayout: 'bin_directory' | 'single_executable';
  selectReleaseAsset: (
    release: unknown,
    runtime: Readonly<{ platform: string; arch: string }>,
  ) => ManagedDependencyReleaseAsset;
}>;

const currentReleaseRuntime = () => ({ platform: process.platform, arch: process.arch });

const githubFetchImpl = typeof globalThis.fetch === 'function' ? globalThis.fetch : undefined;

function primaryCommand(descriptor: InstallableDependencyDescriptor): string {
  const command = descriptor.binary.commands[0]?.trim();
  if (!command) {
    throw new Error(`Installable "${descriptor.key}" has no binary command`);
  }
  return command;
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

async function readInstalledVersion(descriptor: InstallableDependencyDescriptor, binPath: string): Promise<string | null> {
  const result = await runCliCommandBestEffort({
    resolvedPath: binPath,
    args: ['--version'],
    timeoutMs: 2_000,
  });
  return result.ok ? parseInstalledVersionFromOutput(primaryCommand(descriptor), result.stdout) : null;
}

async function writeInstallLog(params: Readonly<{ logPath: string; lines: readonly string[] }>): Promise<void> {
  await mkdir(dirname(params.logPath), { recursive: true });
  await writeFile(params.logPath, `${params.lines.join('\n')}\n`, 'utf8');
}

function isGitHubReleaseBinaryDescriptor(
  descriptor: InstallableDependencyDescriptor,
): descriptor is GitHubReleaseBinaryInstallableDescriptor {
  return descriptor.source.kind === 'github_release_binary';
}

async function installGitHubReleaseBinary(
  descriptor: GitHubReleaseBinaryInstallableDescriptor,
  policy: GitHubReleaseBinaryInstallPolicy,
  options: RuntimeInstallableInstallOptions = {},
): Promise<RuntimeInstallableInstallResult> {
  const logPath = join(options.env ? join(resolveHappyHomeDirFromEnvironment(options.env), 'logs') : configuration.logsDir, `install-${descriptor.key}-${Date.now()}.log`);
  let errorCode: RuntimeInstallableInstallErrorCode | undefined = 'download-failed';
  try {
    options.signal?.throwIfAborted();
    const release = await fetchGitHubLatestRelease({
      signal: options.signal,
      githubRepo: descriptor.source.repo,
      userAgent: 'happier-cli',
      githubToken: (options.env ?? process.env).GITHUB_TOKEN,
      ...(githubFetchImpl ? { fetchImpl: githubFetchImpl } : {}),
    });
    options.signal?.throwIfAborted();
    errorCode = undefined;
    const asset = policy.selectReleaseAsset(release, currentReleaseRuntime());
    const installRoot = managedInstallDir(descriptor, options.env);
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

      errorCode = 'download-failed';
      await downloadGitHubReleaseAsset({
        signal: options.signal,
        onProgress: options.onProgress,
        url: asset.url,
        destinationPath: archivePath,
        digest: asset.digest,
        userAgent: 'happier-cli',
      });
      options.signal?.throwIfAborted();
      errorCode = 'verification-failed';
      await mkdir(dirname(candidateBinPath), { recursive: true });
      if (policy.archiveLayout === 'single_executable') {
        await extractGitHubReleaseAsset({
          signal: options.signal,
          archivePath,
          archiveName: asset.name,
          extractDir,
          outputPath: candidateBinPath,
        });
      } else {
        const payloadRoot = await extractReleasePayloadRootFromArchive({
          signal: options.signal,
          archivePath,
          archiveName: asset.name,
          extractDir,
        });
        options.signal?.throwIfAborted();
        const payloadBinPath = join(payloadRoot, 'bin', process.platform === 'win32' && !primaryCommand(descriptor).endsWith('.exe')
          ? `${primaryCommand(descriptor)}.exe`
          : primaryCommand(descriptor));
        await rename(payloadBinPath, candidateBinPath);
      }
      options.signal?.throwIfAborted();
      if (process.platform !== 'win32') {
        await chmod(candidateBinPath, 0o755);
      }
      errorCode = undefined;
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
        signal: options.signal,
        installRoot,
        candidatePath: candidateDir,
      });
      await rm(join(installRoot, 'node_modules'), { recursive: true, force: true });
      await rm(join(installRoot, 'package.json'), { force: true });
      await rm(join(installRoot, 'package-lock.json'), { force: true });
      await writeManagedInstallState(descriptor, {
        installedVersion: asset.version,
        lastInstallLogPath: logPath,
      }, options.env);
      return { ok: true, logPath };
    } finally {
      await removeHappierTempDirAsync(scratchDir);
    }
  } catch (error) {
    if (error instanceof ExecFileTerminationError) throw error;
    if (!(error instanceof AgentCliDownloadError) && !(error instanceof ArchiveExtractionTimeoutError)
      && ((options.signal?.aborted && error === options.signal.reason)
        || (error instanceof Error && error.name === 'AbortError'))) throw error;
    const errorMessage = error instanceof Error ? error.message : 'Install failed';
    try {
      await writeInstallLog({ logPath, lines: [errorMessage] });
      await writeManagedInstallState(descriptor, {
        installedVersion: (await readManagedInstallState(descriptor, options.env)).installedVersion,
        lastInstallLogPath: logPath,
      }, options.env);
    } catch {
    }
    return {
      ok: false,
      errorMessage,
      logPath,
      ...(error instanceof ArchiveExtractionTimeoutError
        ? { errorCode: 'command-timed-out' as const }
        : error instanceof GitHubReleaseRateLimitError ? { errorCode: 'rate-limited' as const }
        : error instanceof AgentCliDownloadError ? { errorCode: error.errorCode } : errorCode ? { errorCode } : {}),
    };
  }
}

function createGenericGitHubReleaseBinaryRuntimeInstallable(
  descriptor: GitHubReleaseBinaryInstallableDescriptor,
  policy: GitHubReleaseBinaryInstallPolicy = {
    archiveLayout: 'bin_directory',
    selectReleaseAsset: (release) => selectManagedDependencyReleaseAsset(release),
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
        : await resolveManagedBinPath(descriptor, params.env);
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
        : await resolveManagedBinPath(descriptor, params.env);
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
    installOrUpgrade: (options) => installGitHubReleaseBinary(descriptor, policy, options),
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
  const source = descriptor.source;
  let hostAdapter: RuntimeInstallableAdapter;
  if (source.assetNamePrefix && source.targetByPlatform) {
    const assetNamePrefix = source.assetNamePrefix;
    const targetByPlatform = source.targetByPlatform;
    hostAdapter = createGenericGitHubReleaseBinaryRuntimeInstallable(
      descriptor,
      {
        archiveLayout: source.archiveLayout ?? 'bin_directory',
        selectReleaseAsset: (release) => selectManagedDependencyReleaseAsset(release, { assetNamePrefix, targetByPlatform }),
      },
    );
  } else if (descriptor.key === GH_INSTALLABLE_DESCRIPTOR.key) {
    hostAdapter = createGhRuntimeInstallableAdapter(createGenericGitHubReleaseBinaryRuntimeInstallable(
      descriptor,
      GH_RUNTIME_INSTALLABLE_POLICY,
    ));
  } else {
    hostAdapter = createGenericGitHubReleaseBinaryRuntimeInstallable(descriptor);
  }
  return source.launch?.kind === 'configured_binary'
    ? createConfiguredBinaryRuntimeInstallableAdapter(descriptor, hostAdapter)
    : hostAdapter;
}
