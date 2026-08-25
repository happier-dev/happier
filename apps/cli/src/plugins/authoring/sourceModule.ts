import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';

import {
  formatPluginManifestIngestionDiagnostics,
  ingestPluginManifestV2,
  type ParsedPluginManifestV2,
} from '@happier-dev/protocol';
import {
  normalizePluginAccountCollectionMigrationRuntimeProjection,
  normalizePluginDaemonDatabaseRuntimeProjection,
  type PluginAccountCollectionMigrationRuntimeProjection,
  type PluginDaemonDatabaseRuntimeProjection,
} from '@happier-dev/plugin-sdk';
import { serializeCanonicalPluginManifest } from '@/plugins/manifest/serialize';
import {
  createPluginTypeScriptGenerationScope,
  loadPluginAuthorSourceModule,
  loadVerifiedPluginModule,
  resolvePluginModuleCandidatePaths,
  type PluginModuleNamespace,
} from '@/plugins/runtime/loadPluginModule';
import type { PluginRelativeModuleResolution } from '@/plugins/runtime/activationSources';
import {
  createPreparedPluginActivationGraph,
  type PreparedPluginActivationGraph,
} from '@/plugins/runtime/types';
import {
  resolveActivationExport,
  type ActivationExport,
} from '@/plugins/runtime/lifecycle/activation/source';
import { resolvePluginAuthorTypeScriptConfigBoundary } from './typescriptConfigBoundary';
import {
  resolveLocalPathPluginSource,
  type ResolvedLocalPathPluginSourceFailure,
  type ResolvedLocalPathPluginSourceSuccess,
} from '@/plugins/discovery/sources/localPath';
import {
  expandHomeDirPath,
  isCanonicalAbsolutePathInsideRoot,
} from '@/utils/path/expandHomeDirPath';

export type PluginAuthorSourceEntry = Readonly<{
  kind: 'singleFile' | 'packageRoot';
  locator: string;
  packageRoot: string;
  entryPath: string;
}>;

export type ProjectedPluginAuthorModule = Readonly<{
  manifest: ParsedPluginManifestV2;
  canonicalManifestJson: string;
  module: Readonly<{
    activate: ActivationExport;
    daemonDatabases: PluginDaemonDatabaseRuntimeProjection;
    collectionMigrations: PluginAccountCollectionMigrationRuntimeProjection;
  }>;
}>;

export type EvaluatedPluginAuthorSource = ProjectedPluginAuthorModule & Readonly<{
  entry: PluginAuthorSourceEntry;
  /** The author-published frozen Action identity projection, when exported. */
  actionContracts: unknown;
}>;

export type ResolvedPluginAuthoringSource =
  | Readonly<{ ok: true; kind: 'manifest'; source: ResolvedLocalPathPluginSourceSuccess }>
  | Readonly<{ ok: true; kind: 'code'; entry: PluginAuthorSourceEntry }>
  | ResolvedLocalPathPluginSourceFailure;

type PluginAuthorSourceErrorCode =
  | 'plugin_author_source_missing'
  | 'plugin_author_entry_missing'
  | 'plugin_author_entry_ambiguous'
  | 'plugin_author_entry_kind_unsupported'
  | 'plugin_author_module_invalid'
  | 'plugin_author_manifest_invalid';

export class PluginAuthorSourceError extends Error {
  readonly code: PluginAuthorSourceErrorCode;

  constructor(code: PluginAuthorSourceErrorCode, message: string) {
    super(message);
    this.name = 'PluginAuthorSourceError';
    this.code = code;
  }
}

async function regularFileExists(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return false;
    throw error;
  }
}

function assertAuthorEntryExtension(entryPath: string): void {
  const extension = extname(entryPath).toLowerCase();
  if (extension === '.ts' || extension === '.mts') return;
  throw new PluginAuthorSourceError(
    'plugin_author_entry_kind_unsupported',
    `Plugin author entry must be a .ts or .mts daemon module: ${entryPath}`,
  );
}

export async function resolvePluginAuthorSourceEntrypoint(
  locator: string,
): Promise<PluginAuthorSourceEntry> {
  const resolvedLocator = resolve(expandHomeDirPath(locator.trim()));
  let locatorStats: Awaited<ReturnType<typeof lstat>>;
  try {
    locatorStats = await lstat(resolvedLocator);
  } catch (error) {
    throw new PluginAuthorSourceError(
      'plugin_author_source_missing',
      `Plugin author source is unavailable: ${error instanceof Error ? error.message : resolvedLocator}`,
    );
  }

  if (locatorStats.isFile()) {
    const entryPath = await realpath(resolvedLocator);
    assertAuthorEntryExtension(entryPath);
    return Object.freeze({
      kind: 'singleFile',
      locator: entryPath,
      packageRoot: await realpath(dirname(entryPath)),
      entryPath,
    });
  }
  if (!locatorStats.isDirectory()) {
    throw new PluginAuthorSourceError(
      'plugin_author_source_missing',
      `Plugin author source must be a regular file or directory: ${resolvedLocator}`,
    );
  }

  const packageRoot = await realpath(resolvedLocator);
  const srcEntryPath = join(packageRoot, 'src', 'index.ts');
  const rootEntryPath = join(packageRoot, 'index.ts');
  const [hasSrcEntry, hasRootEntry] = await Promise.all([
    regularFileExists(srcEntryPath),
    regularFileExists(rootEntryPath),
  ]);
  if (hasSrcEntry && hasRootEntry) {
    throw new PluginAuthorSourceError(
      'plugin_author_entry_ambiguous',
      `Plugin author source is ambiguous because both src/index.ts and index.ts exist: ${packageRoot}`,
    );
  }
  const entryPath = hasSrcEntry ? srcEntryPath : hasRootEntry ? rootEntryPath : null;
  if (!entryPath) {
    throw new PluginAuthorSourceError(
      'plugin_author_entry_missing',
      `Plugin author directory must contain exactly one of src/index.ts or index.ts: ${packageRoot}`,
    );
  }
  return Object.freeze({
    kind: 'packageRoot',
    locator: packageRoot,
    packageRoot,
    entryPath: await realpath(entryPath),
  });
}

export async function resolvePluginAuthoringSource(
  locator: string,
): Promise<ResolvedPluginAuthoringSource> {
  const expandedLocator = expandHomeDirPath(String(locator ?? '').trim());
  if (!expandedLocator) {
    const source = await resolveLocalPathPluginSource({ locator });
    return source.ok ? { ok: true, kind: 'manifest', source } : source;
  }
  const absoluteLocator = resolve(expandedLocator);
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(absoluteLocator);
  } catch {
    const source = await resolveLocalPathPluginSource({ locator });
    return source.ok ? { ok: true, kind: 'manifest', source } : source;
  }

  const extension = extname(absoluteLocator).toLowerCase();
  const isCodeFile = metadata.isFile() && (extension === '.ts' || extension === '.mts');
  const hasCanonicalManifest = metadata.isDirectory()
    && (await regularFileExists(join(absoluteLocator, '.happier-plugin', 'plugin.json'))
      || basename(absoluteLocator) === '.happier-plugin'
        && await regularFileExists(join(absoluteLocator, 'plugin.json')));
  if (isCodeFile) {
    return {
      ok: true,
      kind: 'code',
      entry: await resolvePluginAuthorSourceEntrypoint(absoluteLocator),
    };
  }
  if (metadata.isDirectory() && !hasCanonicalManifest) {
    try {
      return {
        ok: true,
        kind: 'code',
        entry: await resolvePluginAuthorSourceEntrypoint(absoluteLocator),
      };
    } catch (error) {
      if (!(error instanceof PluginAuthorSourceError)
        || error.code !== 'plugin_author_entry_missing') {
        throw error;
      }
    }
  }

  const source = await resolveLocalPathPluginSource({ locator: absoluteLocator });
  return source.ok ? { ok: true, kind: 'manifest', source } : source;
}

function invalidManifestMessage(
  result: Exclude<ReturnType<typeof ingestPluginManifestV2>, { ok: true }>,
): string {
  return formatPluginManifestIngestionDiagnostics(result.diagnostics);
}

export function projectPluginAuthorModule(
  namespace: Readonly<Record<string, unknown>>,
): ProjectedPluginAuthorModule {
  const activation = resolveActivationExport(namespace);
  if (!Object.prototype.hasOwnProperty.call(namespace, 'manifest')
    || !Object.prototype.hasOwnProperty.call(namespace, 'activate')
    || activation.status !== 'found') {
    throw new PluginAuthorSourceError(
      'plugin_author_module_invalid',
      'Plugin author module must expose named manifest and activate exports',
    );
  }
  const manifestResult = ingestPluginManifestV2(namespace.manifest);
  if (!manifestResult.ok) {
    throw new PluginAuthorSourceError(
      'plugin_author_manifest_invalid',
      `Plugin author manifest is invalid: ${invalidManifestMessage(manifestResult)}`,
    );
  }
  let daemonDatabases: PluginDaemonDatabaseRuntimeProjection;
  try {
    daemonDatabases = normalizePluginDaemonDatabaseRuntimeProjection(
      namespace.daemonDatabases,
      manifestResult.manifest.contributes.daemonDatabases,
    );
  } catch (error) {
    throw new PluginAuthorSourceError(
      'plugin_author_module_invalid',
      `Plugin author daemon database callbacks are invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let collectionMigrations: PluginAccountCollectionMigrationRuntimeProjection;
  try {
    collectionMigrations = normalizePluginAccountCollectionMigrationRuntimeProjection(
      namespace.collectionMigrations,
      manifestResult.manifest.contributes.accountCollections,
    );
  } catch (error) {
    throw new PluginAuthorSourceError(
      'plugin_author_module_invalid',
      `Plugin author Collection migration callbacks are invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const module = Object.freeze({
    activate: activation.activate,
    daemonDatabases,
    collectionMigrations,
  });
  return Object.freeze({
    manifest: manifestResult.manifest,
    canonicalManifestJson: serializeCanonicalPluginManifest(manifestResult.manifest),
    module,
  });
}

export async function evaluatePluginAuthorSource(input: Readonly<{
  locator: string;
  loadModule?: (entryPath: string) => Promise<PluginModuleNamespace>;
}>): Promise<EvaluatedPluginAuthorSource> {
  const entry = await resolvePluginAuthorSourceEntrypoint(input.locator);
  const typeScriptConfig = await resolvePluginAuthorTypeScriptConfigBoundary({
    packageRootPath: entry.packageRoot,
    entryPath: entry.entryPath,
  });
  const namespace = input.loadModule
    ? await input.loadModule(entry.entryPath)
    : await loadPluginAuthorSourceModule(entry.entryPath, { aliases: typeScriptConfig.aliases });
  return Object.freeze({
    entry,
    actionContracts: namespace.actionContracts,
    ...projectPluginAuthorModule(namespace),
  });
}

export async function evaluateOwnedPluginAuthorGeneration(input: Readonly<{
  locator: string;
  immutableGenerationId: string;
  rootPath: string;
}>): Promise<Readonly<{
  evaluated: EvaluatedPluginAuthorSource;
  graph: PreparedPluginActivationGraph;
}>> {
  const entry = await resolvePluginAuthorSourceEntrypoint(input.locator);
  const typeScriptConfig = await resolvePluginAuthorTypeScriptConfigBoundary({
    packageRootPath: entry.packageRoot,
    entryPath: entry.entryPath,
  });
  const generationScope = createPluginTypeScriptGenerationScope({
    aliases: typeScriptConfig.aliases,
  });
  const namespace = await loadVerifiedPluginModule({
    entryPath: entry.entryPath,
    loadMode: 'source-ts',
    generationScope,
  });
  const evaluated = Object.freeze({
    entry,
    actionContracts: namespace.actionContracts,
    ...projectPluginAuthorModule(namespace),
  });
  return Object.freeze({
    evaluated,
    graph: createPreparedPluginActivationGraph({
      module: evaluated.module,
      generationScope,
      immutableGenerationId: input.immutableGenerationId,
      rootPath: input.rootPath,
      entryPath: entry.entryPath,
    }),
  });
}

export async function resolveOwnedPluginAuthorGenerationModule(input: Readonly<{
  graph: PreparedPluginActivationGraph;
  module: string;
}>): Promise<PluginRelativeModuleResolution<Record<string, unknown>>> {
  const rootPath = await realpath(resolve(input.graph.rootPath));
  const entryPath = await realpath(resolve(input.graph.entryPath));
  const candidateBase = resolve(dirname(entryPath), input.module);
  const candidates = resolvePluginModuleCandidatePaths({
    candidateBase,
    loadMode: 'source-ts',
  });
  let modulePath: string | null = null;
  for (const candidate of candidates) {
    try {
      const metadata = await lstat(candidate);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Runner module '${input.module}' must be a real author source file`);
      }
      if (!metadata.isFile()) continue;
      modulePath = await realpath(candidate);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error;
    }
  }
  if (!modulePath) {
    throw new Error(`Runner module '${input.module}' was not found in the owned author generation`);
  }
  const relativeModulePath = relative(rootPath, modulePath);
  if (
    modulePath === rootPath
    || !isCanonicalAbsolutePathInsideRoot(rootPath, modulePath)
  ) {
    throw new Error(`Runner module '${input.module}' escapes the owned author generation`);
  }
  if (modulePath === entryPath) {
    throw new Error(`Runner module '${input.module}' must be a leaf distinct from the plugin activation entry`);
  }
  return Object.freeze({
    module: await loadVerifiedPluginModule({
      entryPath: modulePath,
      loadMode: 'source-ts',
      generationScope: input.graph.generationScope,
    }),
    normalizedModulePath: relativeModulePath.split(sep).join('/'),
    loadMode: 'source-ts',
  });
}

export function projectEvaluatedPluginDevelopmentSource(
  evaluated: EvaluatedPluginAuthorSource,
): ProjectedPluginAuthorModule {
  const relativeEntryPath = relative(
    evaluated.entry.packageRoot,
    evaluated.entry.entryPath,
  ).replaceAll('\\', '/');
  const manifestResult = ingestPluginManifestV2({
    ...evaluated.manifest,
    entrypoints: {
      ...evaluated.manifest.entrypoints,
      development: `./${relativeEntryPath}`,
    },
  });
  if (!manifestResult.ok) {
    throw new PluginAuthorSourceError(
      'plugin_author_manifest_invalid',
      `Plugin development manifest projection is invalid: ${invalidManifestMessage(manifestResult)}`,
    );
  }
  return Object.freeze({
    manifest: manifestResult.manifest,
    canonicalManifestJson: serializeCanonicalPluginManifest(manifestResult.manifest),
    module: evaluated.module,
  });
}
