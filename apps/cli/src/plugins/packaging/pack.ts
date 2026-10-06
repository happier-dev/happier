import { createHash } from 'node:crypto';
import { access, copyFile, cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import * as tar from 'tar';

import { createMarketplaceNpmDiscoveryProjectionV1 } from '@happier-dev/protocol/marketplace/marketplaceIndexV1';
import { createPluginCompatibilityProjectionV1 } from '@happier-dev/protocol/plugins/availability/v1';
import type { PluginUiArtifactsManifestV2 } from '@happier-dev/protocol/plugins/ui';
import { PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1 } from '@happier-dev/plugin-sdk/ui/build';

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
import { PLUGIN_SDK_PACKAGE_NAME } from '../authoring/hostSdkResolution';
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
import {
  cleanupPluginDaemonOutputManifest,
  isPluginDaemonOutputManifestPath,
} from '../authoring/daemonOutputManifest';
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

function canonicalPluginSdkSpecifier(): string {
  const specifier = PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.dependencies[PLUGIN_SDK_PACKAGE_NAME];
  if (typeof specifier !== 'string' || specifier.trim().length === 0) {
    throw new Error('The public toolchain compatibility packet does not declare a Plugin SDK dependency');
  }
  return specifier;
}

type PluginSdkDependencyDeclaration = Readonly<{
  status: 'absent' | 'declared';
  specifier: string | null;
}>;

async function readPluginSdkRuntimeDependencyDeclaration(
  packageRootPath: string,
): Promise<PluginSdkDependencyDeclaration | null> {
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(await readFile(join(packageRootPath, 'package.json'), 'utf8'));
  } catch {
    // No readable package manifest: a literal standalone file has no package
    // dependency owner and is rejected later by the pack package contract.
    return null;
  }
  if (!isRecord(packageJson)) return null;
  if (!isRecord(packageJson.dependencies)) return { status: 'absent', specifier: null };
  const specifier = packageJson.dependencies[PLUGIN_SDK_PACKAGE_NAME];
  if (typeof specifier !== 'string') return { status: 'absent', specifier: null };
  return { status: 'declared', specifier };
}

function isForbiddenDistributableSdkSpecifier(specifier: string): boolean {
  return /^(?:file|link|workspace):/i.test(specifier)
    || specifier.startsWith('.')
    || specifier.startsWith('/')
    || specifier.startsWith('~')
    || /^[a-zA-Z]:[\\/]/u.test(specifier);
}

/**
 * Typed, actionable pack rejection for the public SDK dependency contract.
 * A packed package is a distributable artifact: it must declare the public
 * Plugin SDK in its canonical runtime dependency field with the exact
 * supported specifier from the toolchain compatibility packet, so consumers
 * resolve it through normal package semantics. Host SDK resolution is never
 * used to make pack pass.
 */
function createPluginSdkDependencyDiagnostic(
  declaration: PluginSdkDependencyDeclaration,
  failure?: Readonly<{ cause: string }>,
): PluginCompatibilityDiagnostic {
  const canonicalSpecifier = canonicalPluginSdkSpecifier();
  if (declaration.status === 'absent' || declaration.specifier === null) {
    return {
      code: 'plugin_pack_sdk_dependency_invalid',
      message: `Plugin pack requires '${PLUGIN_SDK_PACKAGE_NAME}': '${canonicalSpecifier}' in package.json dependencies`
        + ' so the packed plugin resolves the public SDK through normal package semantics',
    };
  }
  if (isForbiddenDistributableSdkSpecifier(declaration.specifier)) {
    return {
      code: 'plugin_pack_sdk_dependency_invalid',
      message: `Plugin pack rejects the '${PLUGIN_SDK_PACKAGE_NAME}' dependency specifier '${declaration.specifier}'`
        + ' because local, workspace, and link forms cannot ship in a distributable plugin package;'
        + ` declare '${canonicalSpecifier}' in package.json dependencies`,
    };
  }
  if (declaration.specifier !== canonicalSpecifier) {
    return {
      code: 'plugin_pack_sdk_dependency_invalid',
      message: `Plugin pack requires the '${PLUGIN_SDK_PACKAGE_NAME}' dependency to use the supported specifier '${canonicalSpecifier}'`
        + ` but package.json declares '${declaration.specifier}'; update package.json dependencies`,
    };
  }
  return {
    code: 'plugin_pack_sdk_dependency_invalid',
    message: `Plugin pack declares '${PLUGIN_SDK_PACKAGE_NAME}': '${declaration.specifier}' but it could not be resolved from the isolated pack environment`
      + `${failure ? `: ${failure.cause}` : ''};`
      + ' prepare the declared dependency closure and pack again',
  };
}

async function validatePackPluginSdkDependency(
  operationRootPath: string,
): Promise<PluginCompatibilityDiagnostic | null> {
  const declaration = await readPluginSdkRuntimeDependencyDeclaration(operationRootPath);
  if (declaration === null) return null;
  if (
    declaration.status === 'absent'
    || declaration.specifier === null
    || isForbiddenDistributableSdkSpecifier(declaration.specifier)
    || declaration.specifier !== canonicalPluginSdkSpecifier()
  ) {
    return createPluginSdkDependencyDiagnostic(declaration);
  }
  return null;
}

async function createPluginSdkEvaluationFailureDiagnostic(
  packageRootPath: string,
  error: unknown,
): Promise<PluginCompatibilityDiagnostic | null> {
  const message = error instanceof Error ? error.message : String(error);
  // Only an actual unresolved import of the bare SDK specifier upgrades to the
  // SDK contract diagnostic; other resolution failures keep their own message.
  if (!/@happier-dev\/plugin-sdk(?![\w./-])/.test(message)) return null;
  const declaration = await readPluginSdkRuntimeDependencyDeclaration(packageRootPath);
  if (declaration === null) return null;
  return createPluginSdkDependencyDiagnostic(declaration, { cause: message });
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

async function selectAuthorOwnedPackFiles(params: Readonly<{
  packageRootPath: string;
  selectors: readonly string[];
  generatedDaemonEntrypoint: string | null;
}>): Promise<readonly string[]> {
  if (!params.generatedDaemonEntrypoint) return params.selectors;
  const generatedDaemonEntrypoint = params.generatedDaemonEntrypoint.replace(/^\.\//u, '');
  const authorOwnedSelectors: string[] = [];
  for (const selector of params.selectors) {
    const selectsGeneratedDaemonOutput = generatedDaemonEntrypoint === selector
      || generatedDaemonEntrypoint.startsWith(`${selector}/`);
    if (
      selectsGeneratedDaemonOutput
      && !(await pathExists(join(params.packageRootPath, ...selector.split('/'))))
    ) {
      // Code-defined packages name their generated daemon directory in
      // `package.json#files` before it exists (the canonical scaffold uses
      // `dist`). The pack owner emits that output directly into staging below
      // and rewrites `files` from its exact outputs. Only defer this proven
      // generated selector; every author-owned selector still receives the
      // ordinary existence and symbolic-link validation.
      continue;
    }
    authorOwnedSelectors.push(selector);
  }
  return Object.freeze(authorOwnedSelectors);
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
  const generatedUiArtifacts: PluginUiArtifactsManifestV2 =
    await readGeneratedPluginUiArtifactsManifest(params.stagedRootPath)
    ?? { version: 2, entries: [] };
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
    // An author source that imports the SDK without a resolvable canonical
    // runtime dependency must fail with the SDK contract diagnostic, not a
    // bare module-resolution error. The host alias never applies here, so a
    // package cannot borrow host resolution to make pack pass.
    if (sourceResolution.kind === 'code') {
      const sdkDiagnostic = await createPluginSdkEvaluationFailureDiagnostic(
        sourceResolution.entry.packageRoot,
        error,
      );
      if (sdkDiagnostic) {
        return { ok: false, diagnostics: [sdkDiagnostic] };
      }
    }
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
  if (operation.authoringKind !== 'code') return null;

  // A literal standalone file has no package dependency owner. A single-file
  // locator inside a package still resolves through that package's copied
  // manifest and therefore needs the same SDK/dependency preparation as a
  // package-root locator before evaluation.
  if (operation.authoringEntryKind === 'singleFile') {
    try {
      await access(join(operation.operationRootPath, 'package.json'));
    } catch {
      return null;
    }
  }

  // The public SDK dependency contract is verified before any dependency
  // preparation so the author receives the actionable declaration error
  // instead of an installer or module-resolution failure.
  const sdkDependencyDiagnostic = await validatePackPluginSdkDependency(operation.operationRootPath);
  if (sdkDependencyDiagnostic) return [sdkDependencyDiagnostic];

  const preparation = await preparePluginAuthorDependencies({
    projectRoot: operation.operationRootPath,
    ...(sdkRegistryOrigin ? { sdkRegistryOrigin } : {}),
  });
  if (!preparation.ok) return [createDiagnostic(preparation.diagnostic.message)];

  // Retire only outputs claimed by the preceding daemon bundle before the
  // current source evaluation and archive selection. This preserves
  // author-owned and UI files that share `dist` while preventing a prior
  // daemon/chunk graph from entering the new archive ahead of the freshly
  // staged runtime below.
  await cleanupPluginDaemonOutputManifest(preparation.projectRoot);
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
    } else {
      // The Plugin UI builder consumes the canonical source manifest. A cold
      // code-defined package has no authored JSON file, so publish the already
      // evaluated canonical manifest into the isolated operation copy before
      // invoking that existing builder. The author tree remains untouched and
      // archive staging below rewrites the same canonical bytes.
      await writeStagedCanonicalManifest({
        manifest: resolvedSource.manifest,
        stagedManifestPath: join(
          operation.operationRootPath,
          '.happier-plugin',
          'plugin.json',
        ),
      });
      const uiBuild = await runPluginUiArtifactBuild({
        projectRoot: operation.operationRootPath,
      });
      if (!uiBuild.ok) {
        return {
          ok: false,
          diagnostics: uiBuild.diagnostics.map((diagnostic) => (
            createDiagnostic(diagnostic.message)
          )),
        };
      }
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
      const authorOwnedSelectors = await selectAuthorOwnedPackFiles({
        packageRootPath: resolvedSource.pluginRootPath,
        selectors: packageContract.files,
        generatedDaemonEntrypoint: resolvedSource.authorEntryPath === null
          ? null
          : (resolvedSource.manifest.entrypoints?.daemon ?? null),
      });
      const selectedFiles = await collectSelectedFiles({
        packageRootPath: resolvedSource.pluginRootPath,
        selectors: authorOwnedSelectors,
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
