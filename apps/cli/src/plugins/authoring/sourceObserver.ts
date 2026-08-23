import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import { startFileWatcher } from '@/integrations/watcher/startFileWatcher';
import { PLUGIN_DEVELOPMENT_DEPENDENCY_INPUT_PATHS } from '@/plugins/authoring/developmentDependencyInputs';
import { resolvePluginDaemonEntryPath } from '@/plugins/manifest/daemonEntry';
import { resolvePluginAuthoringSource } from './sourceModule';

export type PluginDevelopmentSourceRequest = Readonly<{
  kind: 'development';
  pluginId?: string;
  projectRoot: string;
  changedPaths?: readonly string[];
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
      sourceKind: 'singleFile' | 'packageRoot';
      /**
       * Both code-defined and legacy manifest roots are observed here only;
       * the daemon owns their development closure and UI artifact production.
       */
      authoringKind?: 'code' | 'manifest';
      sourceRootPath: string;
      request: PluginDevelopmentSourceRequest;
      /**
       * Absent for a built manifest root that declares no
       * `entrypoints.development`: the daemon owns that source's development
       * closure, and nothing on the CLI side reads this path.
       */
      developmentEntryPath?: string;
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

/**
 * The observer keeps its signature baseline only after the sole development
 * candidate owner has accepted the observed source view. Retaining the prior
 * baseline makes the next observation include every still-unadopted input,
 * which prevents a source-only retry from being mistaken for a safe
 * dependency-preserving update.
 */
export type PluginDevelopmentSourceObservationDelivery = 'adopted' | 'retained';

const EXCLUDED_DIRECTORY_NAMES = new Set(['.git', 'dist', 'node_modules']);

async function readDependencyInputSignatures(
  projectRoot: string,
): Promise<ReadonlyMap<string, string | null>> {
  const entries = await Promise.all(PLUGIN_DEVELOPMENT_DEPENDENCY_INPUT_PATHS.map(async (relativePath) => {
    try {
      const contents = await readFile(join(projectRoot, relativePath));
      return [relativePath, createHash('sha256').update(contents).digest('hex')] as const;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
        return [relativePath, null] as const;
      }
      const code = (error as NodeJS.ErrnoException | null)?.code ?? 'unknown';
      return [relativePath, `unreadable:${code}`] as const;
    }
  }));
  return new Map(entries);
}

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

async function readObservedFileSignatures(
  observation: Extract<PluginDevelopmentSourceObservation, { ok: true }>,
): Promise<ReadonlyMap<string, string>> {
  const entries = await Promise.all(observation.observedRelativePaths.map(async (relativePath) => {
    const absolutePath = join(observation.sourceRootPath, ...relativePath.split('/'));
    try {
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink() || !metadata.isFile()) return null;
      return [
        relativePath,
        `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`,
      ] as const;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null;
      throw error;
    }
  }));
  return new Map(entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null));
}

function diffObservedFileSignatures(
  previous: ReadonlyMap<string, string>,
  next: ReadonlyMap<string, string>,
): string[] {
  return [...new Set([...previous.keys(), ...next.keys()])]
    .filter((relativePath) => previous.get(relativePath) !== next.get(relativePath))
    .sort();
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

  const sourceResolution = await resolvePluginAuthoringSource(projectRoot);
  if (!sourceResolution.ok) {
    return {
      ok: false,
      diagnostics: sourceResolution.diagnostics.map((entry) => diagnostic(
        'plugin_dev_manifest_invalid',
        entry.message,
      )),
    };
  }

  if (sourceResolution.kind === 'code') {
    const { entry } = sourceResolution;
    try {
      const inventory = entry.kind === 'singleFile'
        ? { files: [entry.entryPath], directories: [entry.entryPath] }
        : await inventoryProject(entry.packageRoot);
      const declaredDependencies = entry.kind === 'singleFile'
        ? Object.freeze({})
        : await readDeclaredDependencies(join(entry.packageRoot, 'package.json'));
      return {
        ok: true,
        sourceKind: entry.kind,
        authoringKind: 'code',
        sourceRootPath: entry.packageRoot,
        request: {
          kind: 'development',
          projectRoot: entry.locator,
          ...(input.sdkRegistryOrigin ? { sdkRegistryOrigin: input.sdkRegistryOrigin } : {}),
        },
        developmentEntryPath: entry.entryPath,
        observedRelativePaths: inventory.files.map((path) => toPortableRelativePath(entry.packageRoot, path)),
        declaredDependencies,
        observedDirectoryPaths: inventory.directories,
      };
    } catch (error) {
      return {
        ok: false,
        diagnostics: [diagnostic(
          'plugin_dev_package_invalid',
          error instanceof Error ? error.message : 'Plugin package metadata is invalid.',
        )],
      };
    }
  }

  const resolvedSource = sourceResolution.source;
  projectRoot = resolvedSource.pluginRootPath;
  const manifestResult = resolvedSource;

  // A built manifest root has no `entrypoints.development`: its development
  // entry is the TypeScript source the daemon compiles into an owned
  // generation. The daemon change preparer accepts exactly that shape, and the
  // watch loop only observes and submits edits, so requiring the declaration
  // here refused a source the owner downstream already handles. When the
  // manifest does declare one, it is still resolved so an escaping or missing
  // dev entry is reported to the author before the daemon round trip.
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
      sourceKind: 'packageRoot',
      authoringKind: 'manifest',
      sourceRootPath: projectRoot,
      request: {
        kind: 'development',
        pluginId: manifestResult.manifest.id,
        projectRoot,
        ...(input.sdkRegistryOrigin ? { sdkRegistryOrigin: input.sdkRegistryOrigin } : {}),
      },
      ...(developmentEntryPath ? { developmentEntryPath } : {}),
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
  return startFileWatcher(directoryPath, onChange, {
    emitInitial: false,
    reportEventPath: true,
  });
};

export async function startPluginDevelopmentSourceObserver(input: Readonly<{
  projectRoot: string;
  sdkRegistryOrigin?: string;
  onObservation(
    observation: PluginDevelopmentSourceObservation,
  ): PluginDevelopmentSourceObservationDelivery | Promise<PluginDevelopmentSourceObservationDelivery>;
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
  let dependencyInputSignatures: ReadonlyMap<string, string | null> | undefined;
  let observedFileSignatures: ReadonlyMap<string, string> | undefined;

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

  const refresh = async (): Promise<void> => {
    if (stopped) return;
    if (refreshing) {
      refreshAgain = true;
      return;
    }
    refreshing = true;
    try {
      let observation = await inspectPluginDevelopmentSource({
        projectRoot: input.projectRoot,
        ...(input.sdkRegistryOrigin ? { sdkRegistryOrigin: input.sdkRegistryOrigin } : {}),
      });
      let nextObservedFileSignatures: ReadonlyMap<string, string> | undefined;
      let nextDependencyInputSignatures: ReadonlyMap<string, string | null> | undefined;
      if (observation.ok) {
        const previousObservedFileSignatures = observedFileSignatures;
        nextObservedFileSignatures = await readObservedFileSignatures(observation);
        nextDependencyInputSignatures = observation.sourceKind === 'singleFile'
          ? new Map<string, string | null>()
          : await readDependencyInputSignatures(observation.sourceRootPath);
        const portableChangedPaths = previousObservedFileSignatures
          ? diffObservedFileSignatures(previousObservedFileSignatures, nextObservedFileSignatures)
          : [];
        if (dependencyInputSignatures) {
          for (const [relativePath, signature] of nextDependencyInputSignatures) {
            if (dependencyInputSignatures.get(relativePath) !== signature) {
              portableChangedPaths.push(relativePath);
            }
          }
        }
        portableChangedPaths.sort();
        if (previousObservedFileSignatures) {
          observation = {
            ...observation,
            request: {
              ...observation.request,
              changedPaths: Object.freeze([...new Set(portableChangedPaths)]),
            },
          };
        }
      }
      reconcileWatches(observation);
      if (observation.ok && observation.request.changedPaths?.length === 0) {
        return;
      }
      // A refresh already in flight when the handle is stopped must not deliver:
      // the caller has released the observer and no longer owns the consequences
      // of a change request raised on its behalf.
      if (stopped) return;
      const delivery = await input.onObservation(observation);
      if (
        observation.ok
        && delivery === 'adopted'
        && nextObservedFileSignatures
        && nextDependencyInputSignatures
      ) {
        observedFileSignatures = nextObservedFileSignatures;
        dependencyInputSignatures = nextDependencyInputSignatures;
      }
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
