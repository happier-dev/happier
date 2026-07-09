import { cp, mkdir, mkdtemp, readdir, stat, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';

import type { PluginSourceSpecV1 } from '@happier-dev/protocol';
import { extractReleasePayloadRootFromArchive } from '@happier-dev/cli-common/firstPartyRuntime';

import { createPluginStateStore, type PluginStateRecord } from '@/plugins/store/state';
import { resolveInstalledPluginCurrentPath } from '@/plugins/store/installPaths';
import { resolveLocalPathPluginSource } from '@/plugins/discovery/sources/localPath';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import { downloadRemoteArchiveToTempFile } from './archive/download';
import { resolveLocalPluginInstallTrust } from './trustPolicy';

export type PluginInstallKind = 'path' | 'archive';

export type InstallPluginFromSourceResult =
  | Readonly<{
      ok: true;
      alreadyInstalled: boolean;
      pluginId: string;
      sourceKind: PluginInstallKind;
      source: PluginSourceSpecV1;
      manifestVersion: string;
      manifestPath: string;
      manifestDigest: string;
      installedPath: string | null;
    }>
  | Readonly<{
      ok: false;
      errorCode: 'plugin_source_invalid' | 'plugin_install_failed' | 'plugin_already_installed';
      errorMessage: string;
    }>;

function inferPluginInstallKind(locator: string): PluginInstallKind {
  const normalizedLocator = locator.trim();
  if (!normalizedLocator) {
    return 'path';
  }

  if (isRemoteArchiveLocator(normalizedLocator)) {
    const remotePathname = new URL(normalizedLocator).pathname.toLowerCase();
    if (remotePathname.endsWith('.tar.gz') || remotePathname.endsWith('.tgz') || remotePathname.endsWith('.tar.xz') || remotePathname.endsWith('.zip')) {
      return 'archive';
    }
  }

  const normalized = normalizedLocator.toLowerCase();
  if (normalized.endsWith('.tar.gz') || normalized.endsWith('.tgz') || normalized.endsWith('.tar.xz') || normalized.endsWith('.zip')) {
    return 'archive';
  }
  return 'path';
}

function isRemoteArchiveLocator(locator: string): boolean {
  try {
    const parsed = new URL(locator);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function createEnabledPluginState(
  pluginSource: PluginSourceSpecV1,
  installMode: PluginStateRecord['install']['mode'],
  manifestVersion: string,
  manifestDigest: string,
  installedPath: string | null,
  diagnostics: readonly PluginCompatibilityDiagnostic[] = [],
): PluginStateRecord {
  return {
    source: pluginSource as PluginStateRecord['source'],
    compatibility: {
      status: 'compatible',
      diagnostics: [...diagnostics],
    },
    install: {
      mode: installMode,
      manifestVersion,
      manifestDigest,
      installedPath,
    },
    state: {
      enabled: true,
      lastLoadedAtMs: Date.now(),
      lastError: null,
    },
  };
}

function verifyExpectedManifestDigest(actualDigest: string, expectedDigest?: string | null): void {
  const normalizedExpected = typeof expectedDigest === 'string' ? expectedDigest.trim() : '';
  if (!normalizedExpected) {
    return;
  }
  if (actualDigest !== normalizedExpected) {
    throw new Error(`Marketplace descriptor digest mismatch: expected ${normalizedExpected}, received ${actualDigest}`);
  }
}

async function assertDirectoryTreeContainsNoSymbolicLinks(rootPath: string): Promise<void> {
  const pending = [rootPath];

  while (pending.length > 0) {
    const currentPath = pending.pop();
    if (!currentPath) {
      continue;
    }

    const entries = await readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(currentPath, entry.name);
      if (entry.isSymbolicLink()) {
        const relativePath = relative(rootPath, entryPath) || entry.name;
        throw new Error(`Plugin archive payload contains unsupported symbolic link '${relativePath}'`);
      }
      if (entry.isDirectory()) {
        pending.push(entryPath);
      }
    }
  }
}

async function materializeArchivePluginRoot(params: Readonly<{
  happyHomeDir: string;
  archivePath: string;
  archiveName?: string;
}>): Promise<Readonly<{ pluginRootPath: string; stagingDir: string }>> {
  const store = createPluginStateStore({ happyHomeDir: params.happyHomeDir });
  await mkdir(store.paths.cacheDir, { recursive: true });
  const stagingDir = await mkdtemp(join(store.paths.cacheDir, 'plugin-install-'));
  try {
    const archiveName = params.archiveName ?? basename(params.archivePath);
    const pluginRootPath = await extractReleasePayloadRootFromArchive({
      archivePath: params.archivePath,
      archiveName,
      extractDir: stagingDir,
    });
    return {
      pluginRootPath,
      stagingDir,
    };
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function installPluginFromSource(params: Readonly<{
  happyHomeDir: string;
  locator: string;
  sourceKind?: PluginInstallKind;
  sourceSpecOverride?: PluginSourceSpecV1;
  skipIfInstalled?: boolean;
  dryRun?: boolean;
  dev?: boolean;
  workspaceRoot?: string;
  expectedManifestDigest?: string | null;
}>): Promise<InstallPluginFromSourceResult> {
  const sourceKind = params.sourceKind ?? inferPluginInstallKind(params.locator);
  const stateStore = createPluginStateStore({ happyHomeDir: params.happyHomeDir });
  const initialState = await stateStore.read();
  const dryRun = params.dryRun ?? false;

  try {
    if (sourceKind === 'path') {
      const resolvedSource = await resolveLocalPathPluginSource({ locator: params.locator });
      if (!resolvedSource.ok) {
        return {
          ok: false,
          errorCode: 'plugin_source_invalid',
          errorMessage: resolvedSource.diagnostics.map((diagnostic) => diagnostic.message).join('\n') || 'Invalid plugin source',
        };
      }

      const pluginId = resolvedSource.manifest.id;
      if (params.skipIfInstalled && initialState.plugins[pluginId]) {
        const existingRecord = initialState.plugins[pluginId]!;
        const installedPath = existingRecord.install.installedPath ?? null;
        const manifestDigest = existingRecord.install.manifestDigest ?? resolvedSource.manifestDigest ?? null;
        verifyExpectedManifestDigest(manifestDigest, params.expectedManifestDigest);
        return {
          ok: true,
          alreadyInstalled: true,
          pluginId,
          sourceKind,
          source: existingRecord.source,
          manifestVersion: existingRecord.install.manifestVersion,
          manifestPath: existingRecord.source.manifestPath,
          manifestDigest,
          installedPath,
        };
      }

      const trust = await resolveLocalPluginInstallTrust({
        dev: params.dev,
        pluginRootPath: resolvedSource.pluginRootPath,
        workspaceRoot: params.workspaceRoot,
        sourceSpecOverride: params.sourceSpecOverride,
        defaultTrustPolicy: resolvedSource.sourceSpec.trustPolicy,
        defaultInstallPolicy: resolvedSource.sourceSpec.installPolicy,
      });
      const source: PluginSourceSpecV1 = {
        ...resolvedSource.sourceSpec,
        kind: 'path',
        locator: params.sourceSpecOverride?.kind === 'path' && params.sourceSpecOverride.locator.trim().length > 0
          ? params.sourceSpecOverride.locator.trim()
          : resolvedSource.sourceSpec.locator,
        trustPolicy: trust.trustPolicy,
        installPolicy: trust.installPolicy,
        resolvedPath: resolvedSource.pluginRootPath,
        manifestPath: resolvedSource.manifestPath,
        resolvedVersion: resolvedSource.manifest.version,
        resolvedDigest: resolvedSource.manifestDigest,
        installedAt: Date.now(),
        ...(trust.devWatch ? { devWatch: true } : {}),
      };
      verifyExpectedManifestDigest(resolvedSource.manifestDigest, params.expectedManifestDigest);

      if (!dryRun) {
        await stateStore.update(async (state) => ({
          ...state,
          plugins: {
            ...state.plugins,
            [pluginId]: createEnabledPluginState(
              source,
              'link',
              resolvedSource.manifest.version,
              resolvedSource.manifestDigest,
              null,
              trust.diagnostics,
            ),
          },
        }));
      }
      return {
        ok: true,
        alreadyInstalled: false,
        pluginId,
        sourceKind,
        source,
        manifestVersion: resolvedSource.manifest.version,
        manifestPath: resolvedSource.manifestPath,
        manifestDigest: resolvedSource.manifestDigest,
        installedPath: null,
      };
    }

    let downloadedArchiveTempDir: string | null = null;
    const archivePath = await (async () => {
      if (isRemoteArchiveLocator(params.locator)) {
        const archiveUrl = new URL(params.locator).toString();
        const archiveName = basename(new URL(archiveUrl).pathname) || 'plugin-archive.tar.gz';
        const downloaded = await downloadRemoteArchiveToTempFile({
          happyHomeDir: params.happyHomeDir,
          archiveUrl,
          archiveName,
        });
        downloadedArchiveTempDir = downloaded.tempDir;
        return downloaded.archivePath;
      }

      const resolvedLocator = resolve(params.locator.trim());
      try {
        await stat(resolvedLocator);
        return resolvedLocator;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code === 'ENOENT') {
          return null;
        }
        throw error;
      }
    })();
    if (!archivePath) {
      return {
        ok: false,
        errorCode: 'plugin_source_invalid',
        errorMessage: `Plugin archive does not exist: ${params.locator}`,
      };
    }

    const archiveName = isRemoteArchiveLocator(params.locator)
      ? basename(new URL(params.locator).pathname) || basename(archivePath)
      : basename(archivePath);

    const { pluginRootPath, stagingDir } = await materializeArchivePluginRoot({
      happyHomeDir: params.happyHomeDir,
      archivePath,
      archiveName,
    });
    try {
      const resolvedSource = await resolveLocalPathPluginSource({ locator: pluginRootPath });
      if (!resolvedSource.ok) {
        return {
          ok: false,
          errorCode: 'plugin_source_invalid',
          errorMessage: resolvedSource.diagnostics.map((diagnostic) => diagnostic.message).join('\n') || 'Invalid plugin archive source',
        };
      }

      const pluginId = resolvedSource.manifest.id;
      if (params.skipIfInstalled && initialState.plugins[pluginId]) {
        const existingRecord = initialState.plugins[pluginId]!;
        const installedPath = existingRecord.install.installedPath ?? null;
        const manifestDigest = existingRecord.install.manifestDigest ?? resolvedSource.manifestDigest ?? null;
        verifyExpectedManifestDigest(manifestDigest, params.expectedManifestDigest);
        return {
          ok: true,
          alreadyInstalled: true,
          pluginId,
          sourceKind,
          source: existingRecord.source,
          manifestVersion: existingRecord.install.manifestVersion,
          manifestPath: existingRecord.source.manifestPath,
          manifestDigest,
          installedPath,
        };
      }

      const installedPath = resolveInstalledPluginCurrentPath(stateStore.paths.installedDir, pluginId);
      const installedManifestPath = join(installedPath, '.happier-plugin', 'plugin.json');
      const sourceLocator = isRemoteArchiveLocator(params.locator)
        ? params.locator.trim()
        : archivePath;
      const archiveSourceOverride = params.sourceSpecOverride?.kind === 'archive'
        ? params.sourceSpecOverride
        : null;
      const trustPolicy = archiveSourceOverride?.trustPolicy
        ?? (isRemoteArchiveLocator(params.locator) ? 'prompt' : 'local_trusted');
      await assertDirectoryTreeContainsNoSymbolicLinks(resolvedSource.pluginRootPath);
      if (!dryRun) {
        await rm(dirname(installedPath), { recursive: true, force: true });
        await mkdir(dirname(installedPath), { recursive: true });
        await cp(resolvedSource.pluginRootPath, installedPath, {
          recursive: true,
          force: true,
        });
      }
      verifyExpectedManifestDigest(resolvedSource.manifestDigest, params.expectedManifestDigest);

      const source: PluginSourceSpecV1 = {
        ...resolvedSource.sourceSpec,
        kind: 'archive',
        locator: archiveSourceOverride?.locator?.trim()
          ? archiveSourceOverride.locator.trim()
          : sourceLocator,
        trustPolicy,
        installPolicy: archiveSourceOverride?.installPolicy ?? 'managed_install',
        resolvedPath: installedPath,
        manifestPath: installedManifestPath,
        resolvedVersion: resolvedSource.manifest.version,
        resolvedDigest: resolvedSource.manifestDigest,
        installedAt: Date.now(),
      };

      if (!dryRun) {
        await stateStore.update(async (state) => ({
          ...state,
          plugins: {
            ...state.plugins,
            [pluginId]: createEnabledPluginState(
              source,
              'managed_install',
              resolvedSource.manifest.version,
              resolvedSource.manifestDigest,
              installedPath,
            ),
          },
        }));
      }
      return {
        ok: true,
        alreadyInstalled: false,
        pluginId,
        sourceKind,
        source,
        manifestVersion: resolvedSource.manifest.version,
        manifestPath: installedManifestPath,
        manifestDigest: resolvedSource.manifestDigest,
        installedPath,
      };
    } finally {
      await rm(stagingDir, { recursive: true, force: true });
      if (downloadedArchiveTempDir) {
        await rm(downloadedArchiveTempDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  } catch (error) {
    return {
      ok: false,
      errorCode: 'plugin_install_failed',
      errorMessage: error instanceof Error ? error.message : 'Plugin installation failed',
    };
  }
}
