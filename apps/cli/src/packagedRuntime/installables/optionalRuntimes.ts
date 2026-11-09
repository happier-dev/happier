import { access, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import {
  getFirstPartyComponentCatalogEntry,
  ensureInstalledFirstPartyComponent,
  resolveFirstPartyVersionInstallPath,
} from '@happier-dev/cli-common/firstPartyRuntime';
import { BUILT_IN_INSTALLABLES_REGISTRY } from '@happier-dev/protocol/installables';
import { INSTALLABLE_KEYS } from '@happier-dev/protocol/installables/keys';
import type { InstallableDependencyDescriptor } from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import { readSettings } from '@/persistence';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { logger } from '@/ui/logger';
import { resolveAuthoritativePackagedRuntimeProjectRoot } from '@/packagedRuntime/resolvePackagedRuntimeEntrypoint';

import { ensureRuntimeInstallablesForLaunch } from './ensureForLaunch';
import type { RuntimeInstallableAdapter, RuntimeInstallableInstallResult } from './registry';

export type OptionalRuntimeKey =
  | typeof INSTALLABLE_KEYS.LOCAL_EMBEDDINGS
  | typeof INSTALLABLE_KEYS.LOCAL_VOICE_RUNTIME
  | typeof INSTALLABLE_KEYS.DIFFTASTIC;

function componentIdFor(key: OptionalRuntimeKey) {
  const source = BUILT_IN_INSTALLABLES_REGISTRY.descriptorsByKey[key]?.descriptor.source;
  if (source?.kind !== 'first_party_runtime') throw new Error(`No first-party runtime descriptor exists for "${key}"`);
  return source.componentId;
}

function installParameters(key: OptionalRuntimeKey) {
  return {
    componentId: componentIdFor(key),
    versionId: configuration.currentCliVersion,
    channel: configuration.publicReleaseRing,
    processEnv: { ...process.env, HAPPIER_HOME_DIR: configuration.happyHomeDir },
  };
}

function resolveEntryPath(key: OptionalRuntimeKey, root: string): string {
  const component = getFirstPartyComponentCatalogEntry(componentIdFor(key));
  if (component.nodeEntrypointRelativePath) return join(root, component.nodeEntrypointRelativePath);
  return join(root, `${component.binaryRelativePath}${process.platform === 'win32' ? '.exe' : ''}`);
}

async function resolveInstalledOptionalRuntimeLocation(key: OptionalRuntimeKey) {
  // Source bundles already retain the CLI's pinned native dependency tree. Their
  // package version is not a published release identity, so use that tree through
  // the same owner as detection, explicit installation and first-use loading.
  if (key === INSTALLABLE_KEYS.LOCAL_VOICE_RUNTIME) {
    const runtime = resolveAuthoritativePackagedRuntimeProjectRoot({ moduleUrl: import.meta.url });
    if (runtime?.provenance === 'source-module' || runtime?.provenance === 'source-snapshot') {
      const entry = getFirstPartyComponentCatalogEntry(componentIdFor(key)).nodeEntrypointRelativePath;
      if (entry) {
        try {
          const binPath = createRequire(join(runtime.root, 'package.json')).resolve(entry.replace(/^node_modules\//, ''));
          await access(binPath, constants.F_OK);
          return { binPath, installDir: runtime.root };
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'MODULE_NOT_FOUND' && code !== 'ENOENT' && code !== 'EACCES') throw error;
        }
      }
    }
  }
  const installDir = resolveFirstPartyVersionInstallPath(installParameters(key));
  const path = resolveEntryPath(key, installDir);
  try {
    await access(path, key === INSTALLABLE_KEYS.DIFFTASTIC && process.platform !== 'win32' ? constants.X_OK : constants.F_OK);
    return { binPath: path, installDir };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'EACCES') return null;
    throw error;
  }
}

export async function resolveInstalledOptionalRuntime(key: OptionalRuntimeKey): Promise<string | null> {
  return (await resolveInstalledOptionalRuntimeLocation(key))?.binPath ?? null;
}

function installLogPath(key: OptionalRuntimeKey): string {
  return join(configuration.logsDir, `install-dep-${key}-${configuration.currentCliVersion}.log`);
}

// The same explicit install and first-use callers share the existing installable operation.
// Scope includes the home and CLI version because independent runtimes can coexist.
const installs = new Map<string, Promise<RuntimeInstallableInstallResult>>();
const installSuccessListeners = new Set<(key: OptionalRuntimeKey) => void>();

export function subscribeOptionalRuntimeInstallSuccess(
  listener: (key: OptionalRuntimeKey) => void,
): () => void {
  installSuccessListeners.add(listener);
  return () => installSuccessListeners.delete(listener);
}

function publishOptionalRuntimeInstallSuccess(key: OptionalRuntimeKey): void {
  for (const listener of installSuccessListeners) {
    try {
      listener(key);
    } catch (error) {
      logger.warn(`[optional-runtime] ${key} install-success listener failed: ${String(error)}`);
    }
  }
}

function operationKey(key: OptionalRuntimeKey): string {
  return JSON.stringify([key, configuration.happyHomeDir, configuration.currentCliVersion, configuration.publicReleaseRing]);
}

export function isOptionalRuntimeInstalling(key: OptionalRuntimeKey): boolean {
  return installs.has(operationKey(key));
}

export function installOptionalRuntime(key: OptionalRuntimeKey): Promise<RuntimeInstallableInstallResult> {
  const identity = operationKey(key);
  const existing = installs.get(identity);
  if (existing) return existing;
  const promise = (async (): Promise<RuntimeInstallableInstallResult> => {
    const logPath = installLogPath(key);
    try {
      await mkdir(dirname(logPath), { recursive: true });
      await writeFile(logPath, `Installing ${key} for CLI ${configuration.currentCliVersion}\n`);
      if (!await resolveInstalledOptionalRuntime(key)) {
        await ensureInstalledFirstPartyComponent({
          ...installParameters(key),
          exactVersion: true,
          validatePayload: async (root) => {
            await access(resolveEntryPath(key, root), key === INSTALLABLE_KEYS.DIFFTASTIC && process.platform !== 'win32' ? constants.X_OK : constants.F_OK);
          },
        });
      }
      if (!await resolveInstalledOptionalRuntime(key)) throw new Error(`Installed ${key} has no usable runtime entry point`);
      await writeFile(logPath, `Installed ${key} for CLI ${configuration.currentCliVersion}\n`);
      publishOptionalRuntimeInstallSuccess(key);
      return { ok: true, logPath };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn(`[optional-runtime] ${key} installation failed: ${errorMessage}`);
      await writeFile(logPath, `${errorMessage}\n`).catch((logError: unknown) => {
        logger.warn(`[optional-runtime] Could not write install log: ${String(logError)}`);
      });
      return { ok: false, errorMessage, logPath };
    }
  })().finally(() => {
    if (installs.get(identity) === promise) installs.delete(identity);
  });
  installs.set(identity, promise);
  return promise;
}

export async function getOptionalRuntimeStatus(key: OptionalRuntimeKey) {
  const location = await resolveInstalledOptionalRuntimeLocation(key);
  const binPath = location?.binPath ?? null;
  const logPath = installLogPath(key);
  const hasLog = await access(logPath).then(() => true, () => false);
  return {
    installed: binPath !== null,
    installDir: location?.installDir ?? resolveFirstPartyVersionInstallPath(installParameters(key)),
    binPath,
    installedVersion: binPath ? configuration.currentCliVersion : null,
    sourceKind: 'first_party_runtime' as const,
    lastInstallLogPath: hasLog ? logPath : null,
    lastBackgroundUpdateCheckAtMs: null,
    runtimeState: isOptionalRuntimeInstalling(key) ? 'downloading' : binPath ? 'ready' : 'unavailable',
  };
}

export function createOptionalRuntimeInstallable(key: OptionalRuntimeKey): RuntimeInstallableAdapter {
  return {
    key,
    capabilityId: `dep.${key}`,
    detectCapabilityStatus: () => getOptionalRuntimeStatus(key),
    detectLaunchResolution: async () => ({
      availability: await resolveInstalledOptionalRuntime(key)
        ? { ok: true }
        : { ok: false, errorMessage: `${key} is not installed for CLI ${configuration.currentCliVersion}; install it in machine settings before offline use.` },
      canAutoInstall: true,
      canBackgroundAutoUpdate: false,
    }),
    installOrUpgrade: () => installOptionalRuntime(key),
    // Optional components are pinned to the invoking CLI, not a rolling tool release.
    runBackgroundAutoUpdateCheck: async () => {},
  };
}

export async function ensureOptionalRuntime(key: OptionalRuntimeKey): Promise<string> {
  const existing = await resolveInstalledOptionalRuntime(key);
  if (existing) return existing;
  const accountSettings = getActiveAccountSettingsSnapshot();
  if (!accountSettings || accountSettings.source === 'none') {
    throw new Error(`${key} automatic installation is deferred until account settings are available`);
  }
  const machineId = (await readSettings()).machineId ?? '';
  const result = await ensureRuntimeInstallablesForLaunch({
    installableKeys: [key],
    settings: accountSettings.settings,
    machineId,
  });
  if (!result.ok) throw new Error(result.logPath ? `${result.errorMessage} (install log: ${result.logPath})` : result.errorMessage);
  const installed = await resolveInstalledOptionalRuntime(key);
  if (!installed) throw new Error(`${key} installation did not provide its runtime entry point`);
  return installed;
}

export function getOptionalRuntimeInstallableAdapter(descriptor: InstallableDependencyDescriptor): RuntimeInstallableAdapter | null {
  const key = descriptor.key;
  if (descriptor.source.kind !== 'first_party_runtime') return null;
  if (
    key !== INSTALLABLE_KEYS.LOCAL_EMBEDDINGS
    && key !== INSTALLABLE_KEYS.LOCAL_VOICE_RUNTIME
    && key !== INSTALLABLE_KEYS.DIFFTASTIC
  ) return null;
  if (descriptor.source.componentId !== componentIdFor(key)) return null;
  return createOptionalRuntimeInstallable(key);
}
