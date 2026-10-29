import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { basename, dirname, join, delimiter as PATH_DELIMITER } from 'node:path';

import type { InstallableDependencyDescriptor } from '@happier-dev/protocol';
import {
  installPypiWheelAsset,
  PypiWheelAssetError,
  isPypiWheelAssetVersionSatisfied,
  normalizePypiProjectName,
  readInstalledPypiWheelAsset,
  resolvePypiWheelAssetHostCompatibility,
  resolveHappyHomeDirFromEnvironment,
  resolveManagedToolsRoot,
  type PypiWheelAssetHostCompatibility,
} from '@happier-dev/cli-common/agents';
import { ExecFileTerminationError, resolveWindowsCommandOnPath } from '@happier-dev/cli-common/process';

import { configuration } from '@/configuration';
import type { RuntimeInstallableAdapter, RuntimeInstallableInstallErrorCode, RuntimeInstallableInstallOptions, RuntimeInstallableInstallResult } from '../registry';

type ManagedPypiWheelAssetDescriptor = InstallableDependencyDescriptor & Readonly<{
  source: Extract<InstallableDependencyDescriptor['source'], { kind: 'managed_pypi_wheel_asset' }>;
}>;

function isManagedPypiWheelAssetDescriptor(
  descriptor: InstallableDependencyDescriptor,
): descriptor is ManagedPypiWheelAssetDescriptor {
  return descriptor.source.kind === 'managed_pypi_wheel_asset';
}

function primaryCommand(descriptor: InstallableDependencyDescriptor): string {
  const command = descriptor.binary.commands[0]?.trim();
  if (!command) {
    throw new Error(`Installable "${descriptor.key}" has no binary command`);
  }
  return command;
}

function managedInstallDir(descriptor: InstallableDependencyDescriptor, env?: NodeJS.ProcessEnv): string {
  return join(resolveManagedToolsRoot(env ?? { ...process.env, HAPPIER_HOME_DIR: configuration.happyHomeDir }), descriptor.key);
}

type SupportedHostCompatibility = Extract<PypiWheelAssetHostCompatibility, { ok: true }>;

function unsupportedHostMessage(
  descriptor: ManagedPypiWheelAssetDescriptor,
  host: Extract<PypiWheelAssetHostCompatibility, { ok: false }>,
): string {
  return `${descriptor.display.name} is not supported on this host (${host.message})`;
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

async function resolveManagedBinPath(
  descriptor: ManagedPypiWheelAssetDescriptor,
  host: SupportedHostCompatibility,
  installOwnerId: string,
  env?: NodeJS.ProcessEnv,
): Promise<string | null> {
  const installed = await readInstalledPypiWheelAsset(managedInstallDir(descriptor, env));
  const expectedAssetPath = descriptor.source.assetPathByPlatform[host.platform];
  const expectedProbeId = descriptor.source.compatibilityProbe ?? null;
  if (
    !installed
    || installed.metadata.installOwnerId !== installOwnerId
    || installed.metadata.platform !== host.platform
    || normalizePypiProjectName(installed.metadata.distribution)
      !== normalizePypiProjectName(descriptor.source.distribution)
    || !isPypiWheelAssetVersionSatisfied(
      installed.metadata.version,
      descriptor.source.versionSpecifier,
    )
    || installed.metadata.assetPath !== expectedAssetPath
    || basename(installed.executablePath) !== basename(expectedAssetPath.replace(/\\/g, '/'))
    || installed.metadata.compatibilityProbe?.id !== expectedProbeId
    || installed.metadata.compatibilityProbe.ok !== true
  ) return null;
  const accessMode = host.platform.startsWith('win32') ? fsConstants.F_OK : fsConstants.X_OK;
  try {
    await access(installed.executablePath, accessMode);
    return installed.executablePath;
  } catch {
    return null;
  }
}

async function writeInstallLog(params: Readonly<{ logPath: string; lines: readonly string[] }>): Promise<void> {
  await mkdir(dirname(params.logPath), { recursive: true });
  await writeFile(params.logPath, `${params.lines.join('\n')}\n`, 'utf8');
}

async function installManagedPypiWheelAsset(
  descriptor: ManagedPypiWheelAssetDescriptor,
  installOwnerId: string,
  options: RuntimeInstallableInstallOptions = {},
): Promise<RuntimeInstallableInstallResult> {
  const logPath = join(options.env ? join(resolveHappyHomeDirFromEnvironment(options.env), 'logs') : configuration.logsDir, `install-${descriptor.key}-${Date.now()}.log`);
  const host = resolvePypiWheelAssetHostCompatibility();
  if (!host.ok) {
    const errorMessage = unsupportedHostMessage(descriptor, host);
    await writeInstallLog({ logPath, lines: [errorMessage] }).catch(() => undefined);
    return { ok: false, errorMessage, logPath };
  }

  try {
    options.signal?.throwIfAborted();
    const installed = await installPypiWheelAsset({
      signal: options.signal,
      onProgress: options.onProgress,
      installRoot: managedInstallDir(descriptor, options.env),
      installOwnerId,
      distribution: descriptor.source.distribution,
      versionSpecifier: descriptor.source.versionSpecifier,
      assetPathByPlatform: descriptor.source.assetPathByPlatform,
      executable: descriptor.source.executable,
      platform: host.platform,
      ...(host.linuxLibc ? { linuxLibc: host.linuxLibc } : {}),
      ...(descriptor.source.compatibilityProbe ? { compatibilityProbe: descriptor.source.compatibilityProbe } : {}),
      ...(descriptor.source.trustedPublisher ? { trustedPublisher: descriptor.source.trustedPublisher } : {}),
      ...(descriptor.source.maxWheelSizeBytes ? { maxWheelSizeBytes: descriptor.source.maxWheelSizeBytes } : {}),
      ...(descriptor.source.maxAssetSizeBytes ? { maxAssetSizeBytes: descriptor.source.maxAssetSizeBytes } : {}),
    });
    await writeInstallLog({
      logPath,
      lines: [
        '# source: managed_pypi_wheel_asset',
        `# key: ${descriptor.key}`,
        `# distribution: ${descriptor.source.distribution}`,
        `# version: ${installed.version}`,
      ],
    });
    return { ok: true, logPath };
  } catch (error) {
    if (error instanceof ExecFileTerminationError) throw error;
    if (!(error instanceof PypiWheelAssetError)
      && ((options.signal?.aborted && error === options.signal.reason)
        || (error instanceof Error && error.name === 'AbortError'))) throw error;
    const errorMessage = error instanceof Error ? error.message : 'Install failed';
    await writeInstallLog({ logPath, lines: [errorMessage] }).catch(() => undefined);
    let errorCode: RuntimeInstallableInstallErrorCode | undefined;
    if (error instanceof PypiWheelAssetError) {
      if (error.code === 'wheel_download_failed') errorCode = 'download-failed';
      else if (error.code === 'wheel_digest_mismatch' || error.code === 'wheel_size_exceeded'
        || error.code === 'compatibility_probe_failed' || error.code.startsWith('wheel_asset_')) {
        errorCode = 'verification-failed';
      }
    }
    return {
      ok: false,
      errorMessage,
      logPath,
      ...(errorCode ? { errorCode } : {}),
    };
  }
}

export function createManagedPypiWheelAssetRuntimeInstallable(
  descriptor: ManagedPypiWheelAssetDescriptor,
  installOwnerId: string,
): RuntimeInstallableAdapter {
  return {
    key: descriptor.key,
    capabilityId: descriptor.capabilityId,
    detectLaunchResolution: async (params = {}) => {
      const host = resolvePypiWheelAssetHostCompatibility();
      if (!host.ok) {
        return {
          availability: { ok: false, errorMessage: unsupportedHostMessage(descriptor, host) },
          canAutoInstall: false,
          canBackgroundAutoUpdate: false,
        };
      }

      const command = primaryCommand(descriptor);
      const env = params.env ?? process.env;
      const systemBinPath = descriptor.binary.systemFirst === false ? null : await resolveCommandOnPath(command, env);
      const managedPath = descriptor.binary.managedFallback === false
        ? null
        : await resolveManagedBinPath(descriptor, host, installOwnerId, params.env);
      const resolvedPath = systemBinPath ?? managedPath;
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
        canBackgroundAutoUpdate: resolvedPath === managedPath,
      };
    },
    resolveLaunchCommand: async (params = {}) => {
      const host = resolvePypiWheelAssetHostCompatibility();
      if (!host.ok) {
        return {
          ok: false,
          errorMessage: unsupportedHostMessage(descriptor, host),
          canAutoInstall: false,
        };
      }
      const command = primaryCommand(descriptor);
      const env = params.env ?? process.env;
      const preferManaged = params.sourcePreference === 'managed-first';
      const systemBinPath = descriptor.binary.systemFirst === false ? null : await resolveCommandOnPath(command, env);
      const managedPath = descriptor.binary.managedFallback === false
        ? null
        : await resolveManagedBinPath(descriptor, host, installOwnerId, params.env);
      const resolvedPath = preferManaged ? managedPath ?? systemBinPath : systemBinPath ?? managedPath;
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
    installOrUpgrade: (options) => installManagedPypiWheelAsset(
      descriptor,
      installOwnerId,
      options,
    ),
    removeManagedInstall: async () => {
      await rm(managedInstallDir(descriptor), { recursive: true, force: true });
    },
    runBackgroundAutoUpdateCheck: async () => {
      if (descriptor.source.autoUpdateMode !== 'auto') return;
      if (descriptor.consent.update === 'required') return;
      const host = resolvePypiWheelAssetHostCompatibility();
      if (!host.ok) return;
      const binPath = await resolveManagedBinPath(
        descriptor,
        host,
        installOwnerId,
      );
      if (!binPath) return;
      await installManagedPypiWheelAsset(descriptor, installOwnerId);
    },
  };
}

export async function getManagedPypiWheelAssetRuntimeInstallableAdapter(
  descriptor: InstallableDependencyDescriptor,
  installOwnerId: string,
): Promise<RuntimeInstallableAdapter | null> {
  if (!isManagedPypiWheelAssetDescriptor(descriptor)) return null;
  return createManagedPypiWheelAssetRuntimeInstallable(
    descriptor,
    installOwnerId,
  );
}
