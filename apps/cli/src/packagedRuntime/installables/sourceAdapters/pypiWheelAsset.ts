import { access, mkdir, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, join, delimiter as PATH_DELIMITER } from 'node:path';

import type { InstallableDependencyDescriptor } from '@happier-dev/protocol';
import {
  installPypiWheelAsset,
  readInstalledPypiWheelAsset,
  resolvePypiWheelAssetHostCompatibility,
  type PypiWheelAssetHostCompatibility,
} from '@happier-dev/cli-common/agents';
import { resolveWindowsCommandOnPath } from '@happier-dev/cli-common/process';

import { configuration } from '@/configuration';
import { runCliCommandBestEffort } from '@/capabilities/cliAuth/shared';
import type { RuntimeInstallableAdapter } from '../registry';

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

function managedInstallDir(descriptor: InstallableDependencyDescriptor): string {
  return join(configuration.happyHomeDir, 'tools', descriptor.key);
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
): Promise<string | null> {
  const installed = await readInstalledPypiWheelAsset(managedInstallDir(descriptor));
  if (!installed || installed.metadata.platform !== host.platform) return null;
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

async function runCompatibilityProbe(params: Readonly<{
  executablePath: string;
  probeId: string;
}>): Promise<Readonly<{ ok: true } | { ok: false; errorMessage?: string }>> {
  if (params.probeId !== 'antigravity-localharness-v1') {
    return { ok: false, errorMessage: `Unsupported compatibility probe: ${params.probeId}` };
  }
  const result = await runCliCommandBestEffort({
    resolvedPath: params.executablePath,
    args: ['--version'],
    timeoutMs: 2_000,
  });
  return result.ok
    ? { ok: true }
    : { ok: false, errorMessage: result.stderr.trim() || `probe exited with ${result.exitCode ?? 'unknown status'}` };
}

async function installManagedPypiWheelAsset(
  descriptor: ManagedPypiWheelAssetDescriptor,
): Promise<Readonly<{ ok: true; logPath: string } | { ok: false; errorMessage: string; logPath: string }>> {
  const logPath = join(configuration.logsDir, `install-${descriptor.key}-${Date.now()}.log`);
  const host = resolvePypiWheelAssetHostCompatibility();
  if (!host.ok) {
    const errorMessage = unsupportedHostMessage(descriptor, host);
    await writeInstallLog({ logPath, lines: [errorMessage] }).catch(() => undefined);
    return { ok: false, errorMessage, logPath };
  }

  try {
    const installed = await installPypiWheelAsset({
      installRoot: managedInstallDir(descriptor),
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
      probeExecutable: runCompatibilityProbe,
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
    const errorMessage = error instanceof Error ? error.message : 'Install failed';
    await writeInstallLog({ logPath, lines: [errorMessage] }).catch(() => undefined);
    return { ok: false, errorMessage, logPath };
  }
}

export function createManagedPypiWheelAssetRuntimeInstallable(
  descriptor: ManagedPypiWheelAssetDescriptor,
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
      const managedPath = descriptor.binary.managedFallback === false ? null : await resolveManagedBinPath(descriptor, host);
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
      const managedPath = descriptor.binary.managedFallback === false ? null : await resolveManagedBinPath(descriptor, host);
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
    installOrUpgrade: () => installManagedPypiWheelAsset(descriptor),
    runBackgroundAutoUpdateCheck: async () => {
      if (descriptor.source.autoUpdateMode !== 'auto') return;
      if (descriptor.consent.update === 'required') return;
      const host = resolvePypiWheelAssetHostCompatibility();
      if (!host.ok) return;
      const binPath = await resolveManagedBinPath(descriptor, host);
      if (!binPath) return;
      await installManagedPypiWheelAsset(descriptor);
    },
  };
}

export async function getManagedPypiWheelAssetRuntimeInstallableAdapter(
  descriptor: InstallableDependencyDescriptor,
): Promise<RuntimeInstallableAdapter | null> {
  if (!isManagedPypiWheelAssetDescriptor(descriptor)) return null;
  return createManagedPypiWheelAssetRuntimeInstallable(descriptor);
}
