import { readdir, readFile, realpath } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import { startFileWatcher } from '@/integrations/watcher/startFileWatcher';
import { resolvePluginDaemonEntryPath } from '@/plugins/manifest/daemonEntry';
import { readPluginManifest } from '@/plugins/manifest/read';

export type PluginDevelopmentSourceRequest = Readonly<{
  kind: 'development';
  pluginId: string;
  projectRoot: string;
  sdkRegistryOrigin?: string;
}>;

export type PluginDevelopmentSourceDiagnostic = Readonly<{
  code:
    | 'plugin_dev_project_missing'
    | 'plugin_dev_manifest_invalid'
    | 'plugin_dev_entry_missing'
    | 'plugin_dev_entry_outside_project'
    | 'plugin_dev_package_invalid'
    | 'plugin_dev_observation_failed';
  message: string;
}>;

export type PluginDevelopmentSourceObservation =
  | Readonly<{
      ok: true;
      request: PluginDevelopmentSourceRequest;
      developmentEntryPath: string;
      observedRelativePaths: readonly string[];
      declaredDependencies: Readonly<Record<string, string>>;
      observedDirectoryPaths: readonly string[];
    }>
  | Readonly<{
      ok: false;
      diagnostics: readonly PluginDevelopmentSourceDiagnostic[];
    }>;

export type StartWatchingPluginDirectory = (
  directoryPath: string,
  onChange: (changedPath: string) => void,
) => () => void;

export type PluginDevelopmentSourceObserverHandle = Readonly<{
  stop(): void;
}>;

const EXCLUDED_DIRECTORY_NAMES = new Set(['.git', 'dist', 'node_modules']);

function toPortableRelativePath(rootPath: string, path: string): string {
  return relative(rootPath, path).split(sep).join('/');
}

function diagnostic(
  code: PluginDevelopmentSourceDiagnostic['code'],
  message: string,
): PluginDevelopmentSourceDiagnostic {
  return { code, message };
}

async function readDeclaredDependencies(
  packageJsonPath: string,
): Promise<Readonly<Record<string, string>>> {
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as unknown;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT') return {};
    throw new Error(`Invalid package.json: ${error instanceof Error ? error.message : 'unknown parse failure'}`);
  }
  if (!packageJson || typeof packageJson !== 'object' || Array.isArray(packageJson)) {
    throw new Error('Invalid package.json: expected a JSON object');
  }

  const result: Record<string, string> = {};
  for (const field of ['dependencies', 'devDependencies'] as const) {
    const value = (packageJson as Readonly<Record<string, unknown>>)[field];
    if (value === undefined) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Invalid package.json: ${field} must be an object`);
    }
    for (const [name, specifier] of Object.entries(value)) {
      if (typeof specifier !== 'string') {
        throw new Error(`Invalid package.json: ${field}.${name} must be a string`);
      }
      result[name] = specifier;
    }
  }
  return Object.freeze(result);
}

async function inventoryProject(rootPath: string): Promise<Readonly<{
  files: readonly string[];
  directories: readonly string[];
}>> {
  const files: string[] = [];
  const directories: string[] = [];
  const pending = [rootPath];

  while (pending.length > 0) {
    const directoryPath = pending.pop()!;
    directories.push(directoryPath);
    const entries = await readdir(directoryPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const entryPath = join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORY_NAMES.has(entry.name)) pending.push(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  }

  return {
    files: files.sort(),
    directories: directories.sort(),
  };
}

export async function inspectPluginDevelopmentSource(input: Readonly<{
  projectRoot: string;
  sdkRegistryOrigin?: string;
}>): Promise<PluginDevelopmentSourceObservation> {
  let projectRoot: string;
  try {
    projectRoot = await realpath(resolve(input.projectRoot));
  } catch (error) {
    return {
      ok: false,
      diagnostics: [diagnostic(
        'plugin_dev_project_missing',
        `Plugin project is unavailable: ${error instanceof Error ? error.message : input.projectRoot}`,
      )],
    };
  }

  const manifestPath = join(projectRoot, '.happier-plugin', 'plugin.json');
  const manifestResult = await readPluginManifest({ manifestPath });
  if (!manifestResult.ok) {
    return {
      ok: false,
      diagnostics: manifestResult.diagnostics.map((entry) => diagnostic(
        'plugin_dev_manifest_invalid',
        entry.message,
      )),
    };
  }

  const developmentEntrypoint = manifestResult.manifest.entrypoints?.development;
  if (!developmentEntrypoint) {
    return {
      ok: false,
      diagnostics: [diagnostic(
        'plugin_dev_entry_missing',
        'Plugin manifest must declare entrypoints.development for happier plugins dev.',
      )],
    };
  }
  const entryResolution = await resolvePluginDaemonEntryPath({
    pluginRootPath: projectRoot,
    manifest: manifestResult.manifest,
    resolveDevEntrypoint: true,
  });
  if (!entryResolution.ok) {
    const code = entryResolution.diagnostic.code === 'plugin_source_missing'
      ? 'plugin_dev_entry_missing'
      : entryResolution.diagnostic.code === 'plugin_manifest_semantic_invalid'
        ? 'plugin_dev_entry_outside_project'
        : 'plugin_dev_manifest_invalid';
    return {
      ok: false,
      diagnostics: [diagnostic(
        code,
        entryResolution.diagnostic.message,
      )],
    };
  }
  const developmentEntryPath = entryResolution.devDaemonEntryPath;
  if (!developmentEntryPath) {
    return {
      ok: false,
      diagnostics: [diagnostic(
        'plugin_dev_entry_missing',
        `Plugin development entrypoint is unavailable: ${developmentEntrypoint}`,
      )],
    };
  }

  let declaredDependencies: Readonly<Record<string, string>>;
  try {
    declaredDependencies = await readDeclaredDependencies(join(projectRoot, 'package.json'));
  } catch (error) {
    return {
      ok: false,
      diagnostics: [diagnostic(
        'plugin_dev_package_invalid',
        error instanceof Error ? error.message : 'Plugin package metadata is invalid.',
      )],
    };
  }

  try {
    const inventory = await inventoryProject(projectRoot);
    return {
      ok: true,
      request: {
        kind: 'development',
        pluginId: manifestResult.manifest.id,
        projectRoot,
        ...(input.sdkRegistryOrigin ? { sdkRegistryOrigin: input.sdkRegistryOrigin } : {}),
      },
      developmentEntryPath,
      observedRelativePaths: inventory.files.map((path) => toPortableRelativePath(projectRoot, path)),
      declaredDependencies,
      observedDirectoryPaths: inventory.directories,
    };
  } catch (error) {
    return {
      ok: false,
      diagnostics: [diagnostic(
        'plugin_dev_observation_failed',
        `Unable to inspect plugin source: ${error instanceof Error ? error.message : 'unknown filesystem failure'}`,
      )],
    };
  }
}

const defaultStartWatchingDirectory: StartWatchingPluginDirectory = (directoryPath, onChange) => {
  return startFileWatcher(directoryPath, onChange, { emitInitial: false });
};

export async function startPluginDevelopmentSourceObserver(input: Readonly<{
  projectRoot: string;
  sdkRegistryOrigin?: string;
  onObservation(observation: PluginDevelopmentSourceObservation): void | Promise<void>;
  debounceMs?: number;
  startWatchingDirectory?: StartWatchingPluginDirectory;
}>): Promise<PluginDevelopmentSourceObserverHandle> {
  const startWatchingDirectory = input.startWatchingDirectory ?? defaultStartWatchingDirectory;
  const stops = new Map<string, () => void>();
  const debounceMs = input.debounceMs ?? 75;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let refreshing = false;
  let refreshAgain = false;

  const reconcileDirectories = (directoryPaths: readonly string[]): void => {
    if (stopped) return;
    const nextDirectories = new Set(directoryPaths);
    for (const [directoryPath, stop] of stops) {
      if (nextDirectories.has(directoryPath)) continue;
      stop();
      stops.delete(directoryPath);
    }
    for (const directoryPath of nextDirectories) {
      if (stops.has(directoryPath)) continue;
      stops.set(directoryPath, startWatchingDirectory(directoryPath, () => scheduleRefresh()));
    }
  };

  const reconcileWatches = (observation: PluginDevelopmentSourceObservation): void => {
    if (!observation.ok) return;
    reconcileDirectories(observation.observedDirectoryPaths);
  };

  const reconcileProjectWatches = async (): Promise<void> => {
    if (stopped) return;
    try {
      const projectRoot = await realpath(resolve(input.projectRoot));
      const inventory = await inventoryProject(projectRoot);
      reconcileDirectories(inventory.directories);
    } catch {
      // The observation below owns user-facing filesystem diagnostics. A later
      // parent-directory event can recreate the project only when its root is
      // still watchable, so there is no safe synthetic watch to add here.
    }
  };

  const refresh = async (): Promise<void> => {
    if (stopped) return;
    if (refreshing) {
      refreshAgain = true;
      return;
    }
    refreshing = true;
    try {
      await reconcileProjectWatches();
      const observation = await inspectPluginDevelopmentSource({
        projectRoot: input.projectRoot,
        ...(input.sdkRegistryOrigin ? { sdkRegistryOrigin: input.sdkRegistryOrigin } : {}),
      });
      reconcileWatches(observation);
      await input.onObservation(observation);
    } finally {
      refreshing = false;
      if (refreshAgain && !stopped) {
        refreshAgain = false;
        scheduleRefresh();
      }
    }
  };

  function scheduleRefresh(): void {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void refresh();
    }, debounceMs);
  }

  await refresh();

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      for (const stop of stops.values()) stop();
      stops.clear();
    },
  };
}
