import { createHash } from 'node:crypto';
import { copyFile, cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import * as tar from 'tar';

import {
  createMarketplaceNpmDiscoveryProjectionV1,
  createPluginCompatibilityProjectionV1,
} from '@happier-dev/protocol';

import {
  type ResolvedLocalPathPluginSourceSuccess,
} from '@/plugins/discovery/sources/localPath';
import { serializeCanonicalPluginManifest } from '@/plugins/manifest/serialize';
import type { CanonicalPluginManifest } from '@/plugins/manifest/types';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import {
  expandHomeDirPath,
  isCanonicalAbsolutePathInsideRoot,
} from '@/utils/path/expandHomeDirPath';

import { normalizeNpmPackageName } from '../distribution/npm/normalize';
import { readPortableNpmPackageFiles } from '../distribution/npm/packageFiles';
import {
  cleanupStagedNpmArtifactCandidate,
  stageDownloadedNpmArtifactCandidate,
} from '../distribution/npm/stage';
import { readGeneratedPluginUiArtifactsManifest } from '../install/ui/generatedArtifacts';
import { archiveSha256IntegrityFromDigest } from '../distribution/archive/integrity';
import {
  resolvePluginAuthoringSource,
} from '../authoring/sourceModule';
import {
  stagePluginDaemonRuntime,
} from '../authoring/bundleDaemonRuntime';
import { evaluatePluginAuthorRuntimeStagingSource } from '../authoring/runtimeStagingSource';
import {
  cleanupPluginAuthorGeneratedArtifacts,
  normalizePluginSdkRegistryOrigin,
  preparePluginAuthorDependencies,
  runPluginUiArtifactBuild,
} from '../authoring/toolchain';
import { isPluginDaemonOutputManifestPath } from '../authoring/daemonOutputManifest';
import { generatePluginActionContracts } from '../authoring/actionContracts';
import type { ValidatedAgentSessionRunnerFactoryFactV1 } from '../runtime/activationSources';

export type PackLocalPluginResult =
  | Readonly<{
      ok: true;
      pluginId: string;
      title: string;
      version: string;
      packageRootPath: string;
      /**
       * The author-declared manifest source. For a code-defined plugin this is
       * the author entry module, not manifest JSON, so consumers read
       * `manifest` rather than re-parsing this path.
       */
      manifestPath: string;
      manifest: CanonicalPluginManifest;
      archivePath: string;
      archiveDigest: string;
      archiveIntegrity: string;
      digestPath: string;
      archiveSizeBytes: number;
    }>
  | Readonly<{
      ok: false;
      diagnostics: readonly PluginCompatibilityDiagnostic[];
    }>;

function createDiagnostic(message: string): PluginCompatibilityDiagnostic {
  return {
    code: 'plugin_manifest_invalid',
    message,
  };
}

function sanitizeArchiveSegment(value: string): string {
  const sanitized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return sanitized || 'plugin';
}

function defaultArchiveFileName(pluginId: string, version: string): string {
  return `${sanitizeArchiveSegment(pluginId)}-${sanitizeArchiveSegment(version)}.happier-plugin.tgz`;
}

const PACK_OPERATION_EXCLUDED_SOURCE_ENTRIES = new Set(['.git', 'node_modules']);

function isPackOperationExcludedSourceEntry(entryName: string): boolean {
  return PACK_OPERATION_EXCLUDED_SOURCE_ENTRIES.has(entryName)
    || entryName.startsWith('.happier-plugin-pack-');
}

async function copyPackOperationSourceTree(params: Readonly<{
  sourceRootPath: string;
  destinationRootPath: string;
}>): Promise<void> {
  const pending = [{ sourcePath: params.sourceRootPath, destinationPath: params.destinationRootPath }];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const entries = await readdir(directory.sourcePath, { withFileTypes: true });
    entries.sort((left, right) => compareCodeUnits(left.name, right.name));
    for (const entry of entries) {
      if (isPackOperationExcludedSourceEntry(entry.name)) continue;
      const sourcePath = join(directory.sourcePath, entry.name);
      const destinationPath = join(directory.destinationPath, entry.name);
      const stats = await lstat(sourcePath);
      if (stats.isSymbolicLink()) {
        throw new Error(`Plugin pack source contains an unsupported symbolic link: ${sourcePath}`);
      }
      if (stats.isDirectory()) {
        await mkdir(destinationPath);
        pending.push({ sourcePath, destinationPath });
        continue;
      }
      if (!stats.isFile()) {
        throw new Error(`Plugin pack source contains an unsupported filesystem entry: ${sourcePath}`);
      }
      await copyFile(sourcePath, destinationPath);
    }
  }
}

type PackOperationSource = Readonly<{
  originalRootPath: string;
  operationRootPath: string;
  locator: string;
  authoringKind: 'code' | 'manifest';
  authoringEntryKind?: 'singleFile' | 'packageRoot';
  cleanup: () => Promise<void>;
}>;

async function createPackOperationSource(locator: string): Promise<
  | Readonly<{ ok: true; source: PackOperationSource }>
  | Readonly<{ ok: false; diagnostics: readonly PluginCompatibilityDiagnostic[] }>
> {
  const sourceResolution = await resolvePluginAuthoringSource(locator);
  if (!sourceResolution.ok) return sourceResolution;

  const originalRootPath = sourceResolution.kind === 'manifest'
    ? sourceResolution.source.pluginRootPath
    : sourceResolution.entry.packageRoot;
  // The operation copy must stay outside the author tree: a remote one-way
  // replica owns that tree and can remove process-created sibling directories.
  // Package-root dependency preparation stays scoped to this copied project;
  // unpublished SDKs use the existing supplied-registry seam.
  // Canonicalize the copy root: the operation maps its resolved paths back to
  // the author tree with `relative(operationRootPath, ...)`, and every path the
  // copy resolves is already canonical. `tmpdir()` is a symlink on macOS, so an
  // uncanonicalized copy root makes that mapping escape the package root.
  const operationParentPath = await realpath(
    await mkdtemp(join(tmpdir(), 'happier-plugin-pack-source-')),
  );
  const operationRootPath = join(operationParentPath, 'package');
  try {
    await mkdir(operationRootPath);
    await copyPackOperationSourceTree({
      sourceRootPath: originalRootPath,
      destinationRootPath: operationRootPath,
    });
    const operationLocator = sourceResolution.kind === 'manifest'
      ? operationRootPath
      : sourceResolution.entry.kind === 'packageRoot'
        ? operationRootPath
        : join(
            operationRootPath,
            relative(originalRootPath, sourceResolution.entry.entryPath),
          );
    return {
      ok: true,
      source: Object.freeze({
        originalRootPath,
        operationRootPath,
        locator: operationLocator,
        authoringKind: sourceResolution.kind,
        ...(sourceResolution.kind === 'code'
          ? { authoringEntryKind: sourceResolution.entry.kind }
          : {}),
        cleanup: async () => await rm(operationParentPath, { recursive: true, force: true }),
      }),
    };
  } catch (error) {
    await rm(operationParentPath, { recursive: true, force: true }).catch(() => undefined);
    return {
      ok: false,
      diagnostics: [createDiagnostic(error instanceof Error ? error.message : 'Plugin pack source isolation failed')],
    };
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function resolveArchivePath(params: Readonly<{
  outPath?: string | null;
  defaultFileName: string;
  defaultDirectory: string;
}>): Promise<string> {
  const rawOutPath = String(params.outPath ?? '').trim();
  if (!rawOutPath) {
    return resolve(params.defaultDirectory, params.defaultFileName);
  }

  const resolved = resolve(expandHomeDirPath(rawOutPath));
  try {
    const outputStat = await lstat(resolved);
    if (outputStat.isDirectory()) {
      return join(resolved, params.defaultFileName);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code !== 'ENOENT') {
      throw error;
    }
  }
  return resolved;
}

async function resolvePhysicalDestinationPath(destinationPath: string): Promise<string> {
  const missingParentSegments: string[] = [];
  let existingParentPath = dirname(destinationPath);

  while (true) {
    try {
      const physicalParentPath = await realpath(existingParentPath);
      return resolve(
        physicalParentPath,
        ...missingParentSegments.reverse(),
        basename(destinationPath),
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      const parentPath = dirname(existingParentPath);
      if (code !== 'ENOENT' || parentPath === existingParentPath) {
        throw error;
      }
      missingParentSegments.push(basename(existingParentPath));
      existingParentPath = parentPath;
    }
  }
}

function hashArchive(bytes: Buffer): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function sriSha512(bytes: Buffer): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

type PackPackageContract = Readonly<{
  name: string;
  version: string;
  files: readonly string[];
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readPackPackageContract(params: Readonly<{
  packageRootPath: string;
  pluginVersion: string;
}>): Promise<PackPackageContract> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(params.packageRootPath, 'package.json'), 'utf8'));
  } catch {
    throw new Error('Plugin pack requires a valid package.json');
  }
  if (!isRecord(value)) throw new Error('Plugin package.json must contain an object');
  if (typeof value.name !== 'string' || !value.name.trim()) {
    throw new Error('Plugin package.json must declare a package name');
  }
  const packageName = normalizeNpmPackageName(value.name);
  if (value.version !== params.pluginVersion) {
    throw new Error('Plugin package.json version must match the canonical plugin manifest version');
  }
  const declaresPublicKeyword = Array.isArray(value.keywords)
    && value.keywords.every((keyword) => typeof keyword === 'string')
    && value.keywords.includes('happier-plugin');
  const declaresPublicManifest = isRecord(value.happier)
    && value.happier.manifest === '.happier-plugin/plugin.json';
  if (!declaresPublicKeyword) {
    throw new Error('Plugin package.json must declare the happier-plugin keyword');
  }
  if (!declaresPublicManifest) {
    throw new Error('Plugin package.json happier.manifest must be exactly .happier-plugin/plugin.json');
  }
  const files = readPortableNpmPackageFiles(value.files);
  return Object.freeze({
    name: packageName,
    version: params.pluginVersion,
    files,
  });
}

async function collectSelectedFiles(params: Readonly<{
  packageRootPath: string;
  selectors: readonly string[];
}>): Promise<readonly string[]> {
  const selected = new Set<string>();

  async function visit(relativePath: string): Promise<void> {
    const segments = relativePath.split('/');
    let absolutePath = params.packageRootPath;
    let stat: Awaited<ReturnType<typeof lstat>> | undefined;
    for (const segment of segments) {
      absolutePath = join(absolutePath, segment);
      try {
        stat = await lstat(absolutePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
          throw new Error(`package.json files entry does not exist: ${relativePath}`);
        }
        throw error;
      }
      if (stat.isSymbolicLink()) {
        throw new Error(`Plugin selected files contain unsupported symbolic link '${relativePath}'`);
      }
    }
    if (!stat) throw new Error(`package.json files entry does not exist: ${relativePath}`);
    if (stat.isFile()) {
      selected.add(relativePath);
      return;
    }
    if (!stat.isDirectory()) {
      throw new Error(`Plugin selected path is not a regular file or directory: ${relativePath}`);
    }
    const entries = await readdir(absolutePath, { withFileTypes: true });
    for (const entry of entries) {
      await visit(`${relativePath}/${entry.name}`);
    }
  }

  await visit('package.json');
  for (const selector of params.selectors) await visit(selector);
  return Object.freeze([...selected].sort(compareCodeUnits));
}

function isInternalPluginPackPath(relativePath: string): boolean {
  const normalizedPath = relativePath.replaceAll('\\', '/');
  // Toolchain metadata is never a public plugin artifact. Keep this
  // exclusion independent of executable-vs-descriptor classification so a
  // code-defined package selecting its whole .happier-plugin directory cannot
  // publish the authoring transition record. All other selected paths are
  // author-owned unless an exact prior-bundle manifest removed them earlier.
  return isPluginDaemonOutputManifestPath(normalizedPath);
}

function filterInternalPluginPackFiles(params: Readonly<{
  selectedFiles: readonly string[];
}>): Readonly<{ files: readonly string[]; filtered: boolean }> {
  const files = params.selectedFiles.filter((relativePath) => (
    !isInternalPluginPackPath(relativePath)
  ));
  return Object.freeze({
    files: Object.freeze(files),
    filtered: files.length !== params.selectedFiles.length,
  });
}

async function collectStagedArchiveEntries(stagingDir: string): Promise<readonly string[]> {
  const entries: string[] = [];

  async function visit(relativePath: string): Promise<void> {
    entries.push(relativePath);
    const absolutePath = join(stagingDir, ...relativePath.split('/'));
    const stat = await lstat(absolutePath);
    if (!stat.isDirectory()) return;
    for (const child of await readdir(absolutePath, { withFileTypes: true })) {
      await visit(`${relativePath}/${child.name}`);
    }
  }

  await visit('package');
  return Object.freeze(entries.sort(compareCodeUnits));
}

async function writeStagedCanonicalManifest(params: Readonly<{
  manifest: CanonicalPluginManifest;
  stagedManifestPath: string;
}>): Promise<void> {
  await mkdir(dirname(params.stagedManifestPath), { recursive: true });
  await writeFile(
    params.stagedManifestPath,
    serializeCanonicalPluginManifest(params.manifest),
    'utf8',
  );
}

function canonicalManifestDigest(manifest: CanonicalPluginManifest): `sha256:${string}` {
  return `sha256:${createHash('sha256')
    .update(serializeCanonicalPluginManifest(manifest))
    .digest('hex')}`;
}

async function writeStagedPackageFiles(params: Readonly<{
  stagedRootPath: string;
  selectedFiles: readonly string[];
  manifest: CanonicalPluginManifest;
  generatedRuntimeSelectors?: readonly string[];
  rewriteSelectedFiles?: boolean;
}>): Promise<void> {
  const packageJsonPath = join(params.stagedRootPath, 'package.json');
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as Record<string, unknown>;
  if (params.generatedRuntimeSelectors || params.rewriteSelectedFiles) {
    packageJson.files = [...new Set([
      ...params.selectedFiles.filter((path) => path !== 'package.json'),
      '.happier-plugin/plugin.json',
      ...(params.generatedRuntimeSelectors ?? []),
    ])].sort(compareCodeUnits);
  }
  if (!isRecord(packageJson.happier) || packageJson.happier.manifest !== '.happier-plugin/plugin.json') {
    throw new Error('Plugin pack requires a public package.json happier.manifest contract');
  }
  const generatedUiArtifacts = await readGeneratedPluginUiArtifactsManifest(params.stagedRootPath)
    ?? { version: 1 as const, entries: [] as const };
  const compatibilityProjection = createPluginCompatibilityProjectionV1({
    manifest: params.manifest,
    uiArtifacts: generatedUiArtifacts,
  });
  packageJson.happier = {
    ...packageJson.happier,
    compatibilityProjection,
    marketplaceDiscovery: createMarketplaceNpmDiscoveryProjectionV1({
      compatibility: compatibilityProjection,
      manifestDigest: canonicalManifestDigest(params.manifest),
    }),
  };
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
}

type ResolvedPackSource = Readonly<{
  pluginRootPath: string;
  manifestPath: string;
  manifest: CanonicalPluginManifest;
  authorEntryPath: string | null;
  actionContracts: unknown;
  sessionRunnerFactories: readonly ValidatedAgentSessionRunnerFactoryFactV1[];
}>;

function projectLocalPackSource(
  resolvedSource: ResolvedLocalPathPluginSourceSuccess,
): Readonly<{ ok: true; source: ResolvedPackSource }> {
  return {
    ok: true,
    source: {
      pluginRootPath: resolvedSource.pluginRootPath,
      manifestPath: resolvedSource.manifestPath,
      manifest: resolvedSource.manifest,
      authorEntryPath: null,
      actionContracts: undefined,
      sessionRunnerFactories: Object.freeze([]),
    },
  };
}

async function resolvePackSource(locator: string): Promise<
  | Readonly<{ ok: true; source: ResolvedPackSource }>
  | Readonly<{ ok: false; diagnostics: readonly PluginCompatibilityDiagnostic[] }>
> {
  const sourceResolution = await resolvePluginAuthoringSource(locator);
  if (!sourceResolution.ok) return sourceResolution;
  if (sourceResolution.kind === 'manifest') {
    return projectLocalPackSource(sourceResolution.source);
  }

  try {
    const runtimeSource = await evaluatePluginAuthorRuntimeStagingSource({
      locator: sourceResolution.entry.locator,
      immutableGenerationId: 'plugin-author-pack',
      rootPath: sourceResolution.entry.packageRoot,
    });
    const { evaluated, sessionRunnerFactories } = runtimeSource;
    if (evaluated.entry.kind === 'singleFile' && sessionRunnerFactories.length > 0) {
      throw new Error(
        'One-file plugin authoring is limited to simple plugins; Session Agents require a package root with a distinct named runner leaf',
      );
    }
    return {
      ok: true,
      source: {
        pluginRootPath: evaluated.entry.packageRoot,
        manifestPath: evaluated.entry.entryPath,
        manifest: evaluated.manifest,
        authorEntryPath: evaluated.entry.entryPath,
        actionContracts: evaluated.actionContracts,
        sessionRunnerFactories,
      },
    };
  } catch (error) {
    return {
      ok: false,
      diagnostics: [createDiagnostic(error instanceof Error ? error.message : 'Plugin author source evaluation failed')],
    };
  }
}

async function preparePackOperationAuthoringSource(
  operation: PackOperationSource,
  sdkRegistryOrigin: string | null,
): Promise<readonly PluginCompatibilityDiagnostic[] | null> {
  // Package-root author projects prepare only the operation copy. That keeps
  // dependency resolution, author evaluation, declared UI output, runtime
  // bundling, and archive traversal on one immutable-for-the-operation view.
  if (operation.authoringKind !== 'code' || operation.authoringEntryKind !== 'packageRoot') {
    return null;
  }

  const preparation = await preparePluginAuthorDependencies({
    projectRoot: operation.operationRootPath,
    ...(sdkRegistryOrigin ? { sdkRegistryOrigin } : {}),
  });
  if (!preparation.ok) return [createDiagnostic(preparation.diagnostic.message)];

  const uiBuild = await runPluginUiArtifactBuild({
    projectRoot: preparation.projectRoot,
  });
  if (!uiBuild.ok) return uiBuild.diagnostics.map((diagnostic) => createDiagnostic(diagnostic.message));
  return null;
}

function readManifestDisplayName(manifest: CanonicalPluginManifest): string {
  return typeof manifest.displayName === 'string'
    ? manifest.displayName
    : manifest.displayName.fallback;
}

export async function packLocalPlugin(params: Readonly<{
  locator: string;
  outPath?: string | null;
  sdkRegistryOrigin?: string | null;
}>): Promise<PackLocalPluginResult> {
  let sdkRegistryOrigin: string | null;
  try {
    sdkRegistryOrigin = normalizePluginSdkRegistryOrigin(params.sdkRegistryOrigin);
  } catch (error) {
    return {
      ok: false,
      diagnostics: [createDiagnostic(error instanceof Error ? error.message : 'Plugin SDK registry is invalid')],
    };
  }
  const operationResolution = await createPackOperationSource(params.locator);
  if (!operationResolution.ok) return operationResolution;
  const operation = operationResolution.source;

  try {
    // Evaluation, canonical projection, generated runtime/UI work, selected-file
    // traversal, and archive assembly all begin from this one operation-local
    // copy. No later phase rereads the mutable author tree.
    const authoringPreparationDiagnostics = await preparePackOperationAuthoringSource(operation, sdkRegistryOrigin);
    if (authoringPreparationDiagnostics) {
      return { ok: false, diagnostics: authoringPreparationDiagnostics };
    }
    const sourceResolution = await resolvePackSource(operation.locator);
    if (!sourceResolution.ok) return sourceResolution;
    const resolvedSource = sourceResolution.source;
    // Manifest-only/UI-only sources do not run the executable author build, so
    // remove reserved outputs from the isolated pack copy before selected-file
    // traversal. The author tree itself remains untouched.
    if (resolvedSource.authorEntryPath === null) {
      await cleanupPluginAuthorGeneratedArtifacts(operation.operationRootPath);
    }

    const archivePath = await resolveArchivePath({
      outPath: params.outPath,
      defaultDirectory: dirname(operation.originalRootPath),
      defaultFileName: defaultArchiveFileName(resolvedSource.manifest.id, resolvedSource.manifest.version),
    });
    const resolvedArchivePath = resolve(archivePath);
    const physicalArchivePath = await resolvePhysicalDestinationPath(resolvedArchivePath);
    const digestPath = `${resolvedArchivePath}.sha256`;

    if (!resolvedArchivePath.endsWith('.tgz') && !resolvedArchivePath.endsWith('.tar.gz')) {
      return {
        ok: false,
        diagnostics: [
          createDiagnostic(`Plugin pack output must use a .tgz or .tar.gz archive path: ${resolvedArchivePath}`),
        ],
      };
    }

    if (isCanonicalAbsolutePathInsideRoot(operation.originalRootPath, physicalArchivePath)) {
      return {
        ok: false,
        diagnostics: [
          createDiagnostic('Plugin pack output must be outside the plugin package root'),
        ],
      };
    }

    if (await pathExists(resolvedArchivePath)) {
      return {
        ok: false,
        diagnostics: [
          createDiagnostic(`Plugin pack output already exists: ${resolvedArchivePath}`),
        ],
      };
    }

    if (await pathExists(digestPath)) {
      return {
        ok: false,
        diagnostics: [
          createDiagnostic(`Plugin pack digest output already exists: ${digestPath}`),
        ],
      };
    }

    const outputDir = dirname(resolvedArchivePath);
    await mkdir(outputDir, { recursive: true });
    const stagingDir = await mkdtemp(join(outputDir, '.happier-plugin-pack-'));
    const stagedRoot = join(stagingDir, 'package');
    try {
      if (resolvedSource.authorEntryPath !== null) {
        // Pack reruns the same canonical projection against the already
        // evaluated author value so selected files cannot carry stale output;
        // this is an idempotent verification/current-output step, not a
        // second declaration producer.
        await generatePluginActionContracts({
          projectRoot: resolvedSource.pluginRootPath,
          manifest: resolvedSource.manifest,
          actionContracts: resolvedSource.actionContracts,
        });
      }
      const packageContract = await readPackPackageContract({
        packageRootPath: resolvedSource.pluginRootPath,
        pluginVersion: resolvedSource.manifest.version,
      });
      const selectedFiles = await collectSelectedFiles({
        packageRootPath: resolvedSource.pluginRootPath,
        selectors: packageContract.files,
      });
      const filteredPackFiles = filterInternalPluginPackFiles({
        selectedFiles,
      });
      for (const selectedFile of filteredPackFiles.files) {
        const destination = join(stagedRoot, ...selectedFile.split('/'));
        await mkdir(dirname(destination), { recursive: true });
        await cp(join(resolvedSource.pluginRootPath, ...selectedFile.split('/')), destination, { force: true });
      }
      const stagedManifestPath = join(stagedRoot, '.happier-plugin', 'plugin.json');
      if (resolvedSource.authorEntryPath === null && !selectedFiles.includes('.happier-plugin/plugin.json')) {
        throw new Error('package.json files must select .happier-plugin/plugin.json');
      }
      await writeStagedCanonicalManifest({
        manifest: resolvedSource.manifest,
        stagedManifestPath,
      });
      let generatedRuntimeSelectors: readonly string[] | undefined;
      if (resolvedSource.authorEntryPath !== null) {
        const daemonEntrypoint = resolvedSource.manifest.entrypoints?.daemon;
        if (!daemonEntrypoint) {
          throw new Error('Code-defined plugin pack requires entrypoints.daemon');
        }
        const stagedRuntime = await stagePluginDaemonRuntime({
          sourceRootPath: resolvedSource.pluginRootPath,
          sourceEntryPath: resolvedSource.authorEntryPath,
          stagedRootPath: stagedRoot,
          daemonEntrypoint,
          sessionRunnerFactories: resolvedSource.sessionRunnerFactories,
        });
        generatedRuntimeSelectors = stagedRuntime.outputRelativePaths;
      }
      await writeStagedPackageFiles({
        stagedRootPath: stagedRoot,
        selectedFiles: filteredPackFiles.files,
        manifest: resolvedSource.manifest,
        ...(generatedRuntimeSelectors ? { generatedRuntimeSelectors } : {}),
        ...(filteredPackFiles.filtered ? { rewriteSelectedFiles: true } : {}),
      });
      const archiveEntries = await collectStagedArchiveEntries(stagingDir);
      await tar.c({
        gzip: true,
        file: resolvedArchivePath,
        cwd: stagingDir,
        portable: true,
        noDirRecurse: true,
      }, [...archiveEntries]);

      const archiveBytes = await readFile(resolvedArchivePath);
      const validationParentPath = join(stagingDir, 'validation');
      await mkdir(validationParentPath);
      const staged = await stageDownloadedNpmArtifactCandidate({
        candidate: Object.freeze({
          source: Object.freeze({
            kind: 'npm',
            registryOrigin: 'https://local-pack.invalid',
            packageName: packageContract.name,
            version: packageContract.version,
            integrity: sriSha512(archiveBytes),
            tarballUrl: pathToFileURL(resolvedArchivePath).href,
          }),
          artifactPath: resolvedArchivePath,
          byteLength: archiveBytes.byteLength,
          archiveDigestSha256: hashArchive(archiveBytes),
          registrySignature: Object.freeze({ status: 'absent' }),
          provenance: Object.freeze({ status: 'absent' }),
        }),
        stagingParentPath: validationParentPath,
      });
      if (!staged.ok) {
        throw new Error(`Packed npm candidate rejected (${staged.rejection.code}): ${staged.rejection.message}`);
      }
      await cleanupStagedNpmArtifactCandidate(staged.candidate);
    } catch (error) {
      await rm(resolvedArchivePath, { force: true }).catch(() => undefined);
      return {
        ok: false,
        diagnostics: [
          createDiagnostic(error instanceof Error ? error.message : 'Plugin pack failed'),
        ],
      };
    } finally {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    }

    const archiveBytes = await readFile(resolvedArchivePath);
    const archiveDigest = hashArchive(archiveBytes);
    await writeFile(digestPath, `${archiveDigest}  ${basename(resolvedArchivePath)}\n`, 'utf8');
    const manifestPath = join(
      operation.originalRootPath,
      relative(operation.operationRootPath, resolvedSource.manifestPath),
    );

    return {
      ok: true,
      pluginId: resolvedSource.manifest.id,
      title: readManifestDisplayName(resolvedSource.manifest),
      version: resolvedSource.manifest.version,
      packageRootPath: operation.originalRootPath,
      manifestPath,
      manifest: resolvedSource.manifest,
      archivePath: resolvedArchivePath,
      archiveDigest,
      archiveIntegrity: archiveSha256IntegrityFromDigest(archiveDigest),
      digestPath,
      archiveSizeBytes: archiveBytes.byteLength,
    };
  } finally {
    await operation.cleanup().catch(() => undefined);
  }
}
