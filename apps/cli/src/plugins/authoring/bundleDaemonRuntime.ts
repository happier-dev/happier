import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { lstat, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, extname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';

import type { build as EsbuildBuild, Plugin as EsbuildPlugin } from 'esbuild';
import type { Metafile as EsbuildMetafile } from 'esbuild';
import semver from 'semver';

import {
  resolveAuthoritativePackagedRuntimeProjectRoot,
  type AuthoritativePackagedRuntimeProjectRoot,
} from '@/packagedRuntime/resolvePackagedRuntimeEntrypoint';
import { resolvePortablePluginRelativePath } from '@/plugins/manifest/portableRelativePath';
import type { ValidatedAgentSessionRunnerFactoryFactV1 } from '@/plugins/runtime/activationSources';
import type { CanonicalPluginManifest } from '@/plugins/manifest/types';
import { serializeCanonicalPluginManifest } from '@/plugins/manifest/serialize';
import { isCanonicalAbsolutePathInsideRoot as isPathInsideRoot } from '@/utils/path/expandHomeDirPath';
import { writePluginDaemonOutputManifest } from './daemonOutputManifest';
import { realpathNearestExistingAncestor } from '@/utils/path/physicalAncestorPath';
import { resolveSameInstallNodeModulesRoot } from './packageInstallationRoot';
import {
  assertPluginDaemonEntryOutsideTypeScriptEmit,
  resolvePluginAuthorTypeScriptConfigBoundary,
} from './typescriptConfigBoundary';
import { evaluatePluginAuthorRuntimeStagingSource } from './runtimeStagingSource';
import { projectPackedSessionRunnerModulePath } from './projectPackedSessionRunnerModulePath';
export { projectPackedSessionRunnerModulePath } from './projectPackedSessionRunnerModulePath';

export const GENERATED_PLUGIN_MANIFEST_RELATIVE_PATH = '.happier-plugin/plugin.json';

/**
 * esbuild labels every bundled module with a `// <path>` header rendered relative to the
 * build working directory. The plugin bundler builds from a staged directory, so a module
 * resolved outside it is labelled by walking up to the filesystem root — which stamps the
 * author's absolute checkout path into the shipped bundle and makes the same source emit
 * different bytes on two machines.
 *
 * The portable label is the module's path relative to the root that already spans this
 * build: the plugin source root and the canonical workspace package roots it resolves
 * against. A module outside that span is labelled from its last `node_modules` segment,
 * and anything else by file name; all three are properties of the module, never of where
 * the checkout happens to live.
 */
function resolvePortableModulePathRoot(
  sourceRoot: string,
  canonicalWorkspacePackageRoots: Readonly<Record<string, string>> | undefined,
): string | undefined {
  const spannedRoots = [sourceRoot, ...Object.values(canonicalWorkspacePackageRoots ?? {})]
    .map((root) => {
      const resolvedRoot = resolve(root);
      try {
        return realpathSync(resolvedRoot);
      } catch {
        return resolvedRoot;
      }
    });
  let commonSegments = spannedRoots[0]?.split(sep) ?? [];
  for (const root of spannedRoots.slice(1)) {
    const segments = root.split(sep);
    let shared = 0;
    while (shared < commonSegments.length && shared < segments.length && commonSegments[shared] === segments[shared]) {
      shared += 1;
    }
    commonSegments = commonSegments.slice(0, shared);
  }
  // A span that reaches the filesystem root labels nothing portably.
  if (commonSegments.filter((segment) => segment.length > 0).length === 0) return undefined;
  return commonSegments.join(sep);
}

function portableModulePathLabel(
  inputKey: string,
  options: Readonly<{ buildWorkingDirectory: string; portableRoot: string | undefined }>,
): string {
  // Keys that do not escape the build working directory are already checkout-independent.
  if (!inputKey.startsWith('../') && !isAbsolute(inputKey)) {
    return inputKey.replace(
      /^node_modules\/@happier-dev-canonical-workspace\/([^/]+)\//u,
      '$1/',
    );
  }
  const absolutePath = resolve(options.buildWorkingDirectory, inputKey);
  if (options.portableRoot && isPathInsideRoot(options.portableRoot, absolutePath)) {
    return relative(options.portableRoot, absolutePath).split(sep).join('/');
  }
  const segments = absolutePath.split(sep);
  const lastNodeModulesIndex = segments.lastIndexOf('node_modules');
  if (lastNodeModulesIndex >= 0) return segments.slice(lastNodeModulesIndex).join('/');
  return segments[segments.length - 1] ?? inputKey;
}

/**
 * esbuild writes each module key twice: once as a `// <key>` comment, and — for every module
 * it wraps in `__commonJS`/`__esm` — again as the registry object's property name, which is an
 * executable string literal in the shipped bundle. Both carry the same non-portable label.
 *
 * The registry entry is emitted as `  "<key>"(<params>) {`. It names the wrapper function for
 * stack traces only; each wrapper object holds exactly one key, so relabelling it cannot
 * collide with a sibling or change which module the bundle loads.
 */
const ESBUILD_MODULE_REGISTRY_KEY_INDENT = '  ';

function rewriteEsbuildModuleRegistryKeyLine(
  line: string,
  portableLabelsByInputKey: ReadonlyMap<string, string>,
): string {
  if (!line.startsWith(`${ESBUILD_MODULE_REGISTRY_KEY_INDENT}"`)) return line;
  const keyStart = ESBUILD_MODULE_REGISTRY_KEY_INDENT.length;
  let cursor = keyStart + 1;
  while (cursor < line.length && line[cursor] !== '"') {
    cursor += line[cursor] === '\\' ? 2 : 1;
  }
  // Only an immediately following parameter list is a module-registry entry; anything else
  // is an ordinary string the author's own code may own.
  if (line[cursor] !== '"' || line[cursor + 1] !== '(') return line;
  let inputKey: unknown;
  try {
    inputKey = JSON.parse(line.slice(keyStart, cursor + 1));
  } catch {
    return line;
  }
  if (typeof inputKey !== 'string') return line;
  const portableLabel = portableLabelsByInputKey.get(inputKey);
  if (portableLabel === undefined) return line;
  return `${ESBUILD_MODULE_REGISTRY_KEY_INDENT}${JSON.stringify(portableLabel)}${line.slice(cursor + 1)}`;
}

/**
 * Rewrites only lines that exactly reproduce a module key esbuild reported for this build,
 * so an author's own comment or string is never touched.
 */
export function rewriteEsbuildModulePathLabels(
  source: string,
  portableLabelsByInputKey: ReadonlyMap<string, string>,
): string {
  if (portableLabelsByInputKey.size === 0) return source;
  return source
    .split('\n')
    .map((line) => {
      if (!line.startsWith('// ')) return rewriteEsbuildModuleRegistryKeyLine(line, portableLabelsByInputKey);
      const portableLabel = portableLabelsByInputKey.get(line.slice(3));
      return portableLabel === undefined ? line : `// ${portableLabel}`;
    })
    .join('\n');
}

// The banner supplies one lexical resolver per emitted file. Injection gives
// esbuild an unbound require reference so its name hygiene reserves that global
// name even when every author reference is locally bound. The unused export is
// tree-shaken; static CommonJS requires still follow esbuild's normal bundling.
const BUNDLED_PLUGIN_DAEMON_ESM_REQUIRE_BANNER = 'const require = (await import("node:module")).createRequire(import.meta.url);';
const BUNDLED_PLUGIN_DAEMON_REQUIRE_INJECTION = '<happier-daemon-require>';
const bundledPluginDaemonRequirePlugin: EsbuildPlugin = {
  name: 'happier-daemon-require',
  setup(build) {
    build.onResolve({ filter: /^<happier-daemon-require>$/ }, () => ({
      path: 'require',
      namespace: BUNDLED_PLUGIN_DAEMON_REQUIRE_INJECTION,
    }));
    build.onLoad({ filter: /.*/, namespace: BUNDLED_PLUGIN_DAEMON_REQUIRE_INJECTION }, () => ({
      contents: 'export const __happierReservedRequire = require;',
      loader: 'js',
    }));
  },
};

function isRelativeOrAbsoluteImportSpecifier(specifier: string): boolean {
  return specifier === '.'
    || specifier === '..'
    || specifier.startsWith('./')
    || specifier.startsWith('../')
    || specifier.startsWith('.\\')
    || specifier.startsWith('..\\')
    || isAbsolute(specifier)
    || /^[a-zA-Z]:[\\/]/u.test(specifier)
    || specifier.startsWith('\\\\');
}

const FIRST_PARTY_WORKSPACE_PACKAGE_PREFIX = '@happier-dev/';
const CANONICAL_WORKSPACE_ALIAS_SCOPE = '@happier-dev-canonical-workspace';
const CANONICAL_WORKSPACE_RESOLUTION_DIRECTORY = '.happier-canonical-workspace-resolution';

function getFirstPartyWorkspacePackageName(specifier: string): string | null {
  if (!specifier.startsWith(FIRST_PARTY_WORKSPACE_PACKAGE_PREFIX)) return null;
  const [scope, packageSegment] = specifier.split('/');
  if (scope !== '@happier-dev' || !packageSegment || packageSegment === '.' || packageSegment === '..') {
    return null;
  }
  return `${scope}/${packageSegment}`;
}

function resolveFirstPartyPackagedWorkspaceExternals(params: Readonly<{
  sourceRoot: string;
  canonicalWorkspacePackageRoots: Readonly<Record<string, string>> | undefined;
  externalPackages: readonly string[] | undefined;
}>): readonly string[] {
  if (!params.externalPackages || params.externalPackages.length === 0) return [];
  if (!params.canonicalWorkspacePackageRoots) {
    throw new Error('First-party packaged workspace externals require the canonical packaged CLI workspace closure');
  }

  let sourcePackageName: string | undefined;
  try {
    const packageJson = JSON.parse(readFileSync(join(params.sourceRoot, 'package.json'), 'utf8')) as {
      name?: unknown;
    };
    sourcePackageName = typeof packageJson.name === 'string' ? packageJson.name : undefined;
  } catch {
    // The ordinary package validation below remains authoritative. This read is
    // only needed to reject an external that would recurse into the plugin itself.
  }

  const packageNames = [...new Set(params.externalPackages)];
  for (const packageName of packageNames) {
    if (getFirstPartyWorkspacePackageName(packageName) !== packageName) {
      throw new Error(`Invalid first-party packaged workspace external '${packageName}'`);
    }
    if (!Object.hasOwn(params.canonicalWorkspacePackageRoots, packageName)) {
      throw new Error(
        `First-party packaged workspace external '${packageName}' is not in the canonical packaged CLI workspace closure`,
      );
    }
    if (packageName === sourcePackageName) {
      throw new Error(`First-party plugin package '${packageName}' cannot externalize itself`);
    }
  }

  return Object.freeze(packageNames.flatMap((packageName) => [packageName, `${packageName}/*`]));
}

function resolveAncestorNodeModulesRoots(roots: readonly string[]): string[] {
  const result = new Set<string>();
  for (const root of roots) {
    let current = resolve(root);
    for (;;) {
      const candidate = join(current, 'node_modules');
      if (existsSync(candidate)) result.add(candidate);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return [...result];
}

type CanonicalWorkspaceImportResolver = Readonly<{
  aliases: Readonly<Record<string, string>>;
  plugin: EsbuildPlugin;
  resolutionRoot: string;
  nodePaths: string[];
  dispose(): Promise<void>;
}>;

async function createCanonicalWorkspaceImportResolver(
  canonicalWorkspacePackageRoots: Readonly<Record<string, string>> | undefined,
  stagedRoot: string,
  externalPackageNames: readonly string[] = [],
): Promise<CanonicalWorkspaceImportResolver | undefined> {
  if (!canonicalWorkspacePackageRoots) return undefined;

  const canonicalPackages = Object.entries(canonicalWorkspacePackageRoots)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([packageName, configuredRoot]) => {
      if (getFirstPartyWorkspacePackageName(packageName) !== packageName) {
        throw new Error(`Canonical workspace package root has an invalid package name '${packageName}'`);
      }
      if (typeof configuredRoot !== 'string' || configuredRoot.trim().length === 0) {
        throw new Error(`Canonical workspace package '${packageName}' has no package root`);
      }

      const physicalRoot = realpathSync(resolve(configuredRoot));
      if (!statSync(physicalRoot).isDirectory()) {
        throw new Error(`Canonical workspace package '${packageName}' root is not a directory`);
      }
      const packageJsonPath = realpathSync(join(physicalRoot, 'package.json'));
      if (!isPathInsideRoot(physicalRoot, packageJsonPath)) {
        throw new Error(`Canonical workspace package '${packageName}' package.json escapes its package root`);
      }
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as Readonly<{ name?: unknown }>;
      if (packageJson.name !== packageName) {
        throw new Error(`Canonical workspace package root does not match '${packageName}'`);
      }

      const packageSegment = packageName.slice(FIRST_PARTY_WORKSPACE_PACKAGE_PREFIX.length);
      return Object.freeze({
        aliasPackageName: `${CANONICAL_WORKSPACE_ALIAS_SCOPE}/${packageSegment}`,
        packageName,
        physicalRoot,
      });
    });
  const packageNames = new Set(canonicalPackages.map(({ packageName }) => packageName));
  const resolutionRoot = join(stagedRoot, CANONICAL_WORKSPACE_RESOLUTION_DIRECTORY);
  if (existsSync(resolutionRoot)) {
    throw new Error('Canonical workspace import resolution directory already exists in staged plugin package');
  }
  const aliasScopeRoot = join(resolutionRoot, 'node_modules', CANONICAL_WORKSPACE_ALIAS_SCOPE);
  await mkdir(aliasScopeRoot, { recursive: true });
  try {
    for (const { aliasPackageName, physicalRoot } of canonicalPackages) {
      const aliasPath = join(resolutionRoot, 'node_modules', ...aliasPackageName.split('/'));
      await symlink(physicalRoot, aliasPath, process.platform === 'win32' ? 'junction' : 'dir');
    }
  } catch (error) {
    await rm(resolutionRoot, { recursive: true, force: true });
    throw error;
  }

  const externalPackages = new Set(externalPackageNames);
  const aliases = Object.freeze(Object.fromEntries(canonicalPackages
    .filter(({ packageName }) => !externalPackages.has(packageName))
    .map(({
      aliasPackageName,
      packageName,
    }) => [packageName, aliasPackageName])));
  const nodePaths = resolveAncestorNodeModulesRoots([
    stagedRoot,
    ...canonicalPackages.map(({ physicalRoot }) => physicalRoot),
  ]);

  return {
    aliases,
    resolutionRoot,
    nodePaths,
    plugin: {
      name: 'happier-canonical-workspace-imports',
      setup(build) {
        build.onResolve({ filter: /^@happier-dev\// }, (args) => {
          const packageName = getFirstPartyWorkspacePackageName(args.path);
          if (!packageName) {
            return {
              errors: [{ text: `Invalid first-party workspace import '${args.path}'` }],
            };
          }

          if (!packageNames.has(packageName)) {
            return {
              errors: [{
                text: `Unable to resolve first-party import '${args.path}': First-party import '${packageName}' is not in the canonical workspace dependency closure`,
              }],
            };
          }

          // Let esbuild's own resolver preserve exports, side-effect, and module-kind facts.
          return undefined;
        });
      },
    },
    async dispose() {
      await rm(resolutionRoot, { recursive: true, force: true });
    },
  };
}

type VirtualEsbuildInput = Readonly<{ namespace: string; path: string; suffix: string }>;

async function validateContainedPackSourceImports(params: Readonly<{
  sourceRoot: string;
  resolutionRoot: string;
  metafile: EsbuildMetafile;
  virtualInputs: ReadonlyMap<string, VirtualEsbuildInput>;
}>): Promise<void> {
  const physicalInputs = new Map<string, string>();
  for (const inputPath of Object.keys(params.metafile.inputs)) {
    if (inputPath.startsWith('<') || params.virtualInputs.has(inputPath)) continue;
    const logicalInputPath = resolve(params.resolutionRoot, inputPath);
    physicalInputs.set(inputPath, await realpath(logicalInputPath));
  }

  for (const [inputPath, input] of Object.entries(params.metafile.inputs)) {
    const physicalInputPath = physicalInputs.get(inputPath);
    if (!physicalInputPath) continue;
    if (!isPathInsideRoot(params.sourceRoot, physicalInputPath)) continue;

    const imports = [...input.imports];
    const visitedVirtualInputs = new Set<string>();
    for (let index = 0; index < imports.length; index += 1) {
      const imported = imports[index]!;
      if (imported.external) continue;
      const physicalImportedPath = physicalInputs.get(imported.path);
      if (physicalImportedPath && isPathInsideRoot(params.sourceRoot, physicalImportedPath)) continue;
      if (imported.original && !isRelativeOrAbsoluteImportSpecifier(imported.original)) continue;
      if (params.virtualInputs.has(imported.path)) {
        if (visitedVirtualInputs.has(imported.path)) continue;
        visitedVirtualInputs.add(imported.path);
        const virtualInput = params.metafile.inputs[imported.path];
        if (virtualInput) {
          // A generated wrapper has no file to realpath, but it must not hide
          // an escaping physical dependency behind a relative author import.
          imports.push(...virtualInput.imports);
          continue;
        }
      }

      throw new Error(
        `Plugin author source import '${imported.original ?? imported.path}' resolves outside the package root`,
      );
    }
  }
}

interface RegularFileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly nlink: number;
}

interface PluginAuthorBundlerRuntime {
  readonly mainPath: string;
  readonly nativeBinaryPath: string;
}

export class PluginAuthorBundlerUnavailableError extends Error {
  readonly code = 'plugin_author_bundler_unavailable';

  constructor() {
    super('Plugin author bundler physical packaged runtime dependency is unavailable');
    this.name = 'PluginAuthorBundlerUnavailableError';
  }
}

function resolvePluginAuthorBundlerNativeBinary(params: Readonly<{
  packageRoot: string;
  packageJson: Readonly<{
    version?: unknown;
    optionalDependencies?: unknown;
  }>;
}>): string {
  const optionalDependencies = params.packageJson.optionalDependencies;
  if (
    typeof params.packageJson.version !== 'string'
    || !optionalDependencies
    || typeof optionalDependencies !== 'object'
    || Array.isArray(optionalDependencies)
  ) {
    throw new PluginAuthorBundlerUnavailableError();
  }

  const dependencyRoot = dirname(params.packageRoot);
  for (const [packageName, expectedVersion] of Object.entries(optionalDependencies)) {
    if (
      typeof expectedVersion !== 'string'
      || !packageName.startsWith('@esbuild/')
    ) {
      continue;
    }
    for (const nativePackageCandidate of [
      join(params.packageRoot, 'node_modules', ...packageName.split('/')),
      join(dependencyRoot, ...packageName.split('/')),
    ]) {
      try {
        const nativePackageRoot = realpathSync(nativePackageCandidate);
        const isNestedDependency = isPathInsideRoot(params.packageRoot, nativePackageRoot);
        const isSiblingDependency = isPathInsideRoot(dependencyRoot, nativePackageRoot);
        if (!isNestedDependency && !isSiblingDependency) continue;
        const nativePackageJsonPath = realpathSync(join(nativePackageRoot, 'package.json'));
        if (!isPathInsideRoot(nativePackageRoot, nativePackageJsonPath)) {
          continue;
        }
        const nativePackageJson = JSON.parse(readFileSync(nativePackageJsonPath, 'utf8')) as {
          name?: unknown;
          version?: unknown;
          os?: unknown;
          cpu?: unknown;
          bin?: unknown;
        };
        if (
          nativePackageJson.name !== packageName
          || nativePackageJson.version !== expectedVersion
          || nativePackageJson.version !== params.packageJson.version
          || !Array.isArray(nativePackageJson.os)
          || !nativePackageJson.os.includes(process.platform)
          || !Array.isArray(nativePackageJson.cpu)
          || !nativePackageJson.cpu.includes(process.arch)
        ) {
          continue;
        }

        const declaredBin = typeof nativePackageJson.bin === 'string'
          ? nativePackageJson.bin
          : (
              nativePackageJson.bin
              && typeof nativePackageJson.bin === 'object'
              && !Array.isArray(nativePackageJson.bin)
            )
            ? Object.values(nativePackageJson.bin).find((value): value is string => typeof value === 'string')
            : undefined;
        const binaryRelativePath = declaredBin
          ?? (process.platform === 'win32' ? 'esbuild.exe' : join('bin', 'esbuild'));
        const nativeBinaryPath = realpathSync(join(nativePackageRoot, binaryRelativePath));
        const nativeBinaryStat = statSync(nativeBinaryPath);
        if (
          !isPathInsideRoot(nativePackageRoot, nativeBinaryPath)
          || !nativeBinaryStat.isFile()
          || (process.platform !== 'win32' && (nativeBinaryStat.mode & 0o111) === 0)
        ) {
          continue;
        }
        return nativeBinaryPath;
      } catch {
        // Only an exact, contained, platform-matching optional package counts.
      }
    }
  }
  throw new PluginAuthorBundlerUnavailableError();
}

function resolvePluginAuthorBundlerRuntime(params: Readonly<{
  runtimeAuthority?: AuthoritativePackagedRuntimeProjectRoot | null;
}> = {}): PluginAuthorBundlerRuntime {
  const runtimeAuthority = params.runtimeAuthority === undefined
    ? resolveAuthoritativePackagedRuntimeProjectRoot()
    : params.runtimeAuthority;
  if (runtimeAuthority) {
    try {
      const physicalRuntimeRoot = realpathSync(runtimeAuthority.root);
      const packageRootCandidates = [join(physicalRuntimeRoot, 'node_modules', 'esbuild')];
      let sameInstallNodeModulesRoot: string | null = null;
      let declaredEsbuildRange: string | null = null;
      // Source checkouts use the package manager's ordinary hoisted dependency
      // resolution, but still converge on the same exact physical main file.
      const isSourceRuntime = runtimeAuthority.provenance === 'source-module'
        || runtimeAuthority.provenance === 'source-snapshot';
      if (isSourceRuntime) {
        try {
          const requireFromSourcePackage = createRequire(join(physicalRuntimeRoot, 'package.json'));
          const packageJsonSpecifier = ['esbuild', 'package.json'].join('/');
          packageRootCandidates.push(dirname(requireFromSourcePackage.resolve(packageJsonSpecifier)));
        } catch {
          // The exact physical candidate check below remains authoritative.
        }
      } else {
        try {
          const runtimePackageJsonPath = realpathSync(join(physicalRuntimeRoot, 'package.json'));
          const runtimePackageJson = JSON.parse(readFileSync(runtimePackageJsonPath, 'utf8')) as {
            name?: unknown;
            dependencies?: unknown;
          };
          const dependencies = runtimePackageJson.dependencies;
          const declaredRange = dependencies
            && typeof dependencies === 'object'
            && !Array.isArray(dependencies)
            ? (dependencies as Record<string, unknown>).esbuild
            : undefined;
          const installNodeModulesRoot = resolveSameInstallNodeModulesRoot(physicalRuntimeRoot);
          if (
            isPathInsideRoot(physicalRuntimeRoot, runtimePackageJsonPath)
            && runtimePackageJson.name === '@happier-dev/cli'
            && typeof declaredRange === 'string'
            && declaredRange.trim().length > 0
            && installNodeModulesRoot
          ) {
            sameInstallNodeModulesRoot = realpathSync(installNodeModulesRoot);
            declaredEsbuildRange = declaredRange.trim();
            packageRootCandidates.push(join(sameInstallNodeModulesRoot, 'esbuild'));
          }
        } catch {
          // Only a declared dependency in the exact physical npm install tree
          // of the launched CLI package may be considered.
        }
      }

      for (const packageRootCandidate of new Set(packageRootCandidates)) {
        try {
          const packageRoot = realpathSync(packageRootCandidate);
          const packageJsonPath = realpathSync(join(packageRoot, 'package.json'));
          const mainPath = realpathSync(join(packageRoot, 'lib', 'main.js'));
          if (
            !isPathInsideRoot(packageRoot, packageJsonPath)
            || !isPathInsideRoot(packageRoot, mainPath)
          ) {
            continue;
          }
          const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
            name?: unknown;
            main?: unknown;
            version?: unknown;
            optionalDependencies?: unknown;
          };
          if (
            packageJson.name !== 'esbuild'
            || packageJson.main !== 'lib/main.js'
            || typeof packageJson.version !== 'string'
            || semver.valid(packageJson.version) === null
          ) {
            continue;
          }
          const isDirectPackagedDependency = isPathInsideRoot(physicalRuntimeRoot, packageRoot);
          const isSourceDependency = isSourceRuntime
            && packageRootCandidate !== join(physicalRuntimeRoot, 'node_modules', 'esbuild');
          const isSameInstallDependency = sameInstallNodeModulesRoot !== null
            && declaredEsbuildRange !== null
            && isPathInsideRoot(sameInstallNodeModulesRoot, packageRoot)
            && semver.satisfies(String(packageJson.version ?? ''), declaredEsbuildRange);
          if (!isDirectPackagedDependency && !isSourceDependency && !isSameInstallDependency) {
            continue;
          }
          return {
            mainPath,
            nativeBinaryPath: resolvePluginAuthorBundlerNativeBinary({
              packageRoot,
              packageJson,
            }),
          };
        } catch {
          // Continue to the next exact candidate.
        }
      }
    } catch {
      // Only a complete contained physical esbuild package in the launched
      // runtime is authoritative for plugin authoring.
    }
  }
  throw new PluginAuthorBundlerUnavailableError();
}

export function resolvePluginAuthorBundlerMainPath(params: Readonly<{
  runtimeAuthority?: AuthoritativePackagedRuntimeProjectRoot | null;
}> = {}): string {
  return resolvePluginAuthorBundlerRuntime(params).mainPath;
}

let cachedPluginAuthorBundlerBuild: typeof EsbuildBuild | null = null;

function loadPluginAuthorBundlerBuild(): typeof EsbuildBuild {
  if (cachedPluginAuthorBundlerBuild) {
    return cachedPluginAuthorBundlerBuild;
  }
  const { mainPath, nativeBinaryPath } = resolvePluginAuthorBundlerRuntime();
  const requireFromBundler = createRequire(mainPath);
  delete requireFromBundler.cache[mainPath];
  const previousBinaryOverride = process.env.ESBUILD_BINARY_PATH;
  let module: { build?: unknown };
  try {
    process.env.ESBUILD_BINARY_PATH = nativeBinaryPath;
    module = requireFromBundler(mainPath) as { build?: unknown };
  } finally {
    if (previousBinaryOverride === undefined) {
      delete process.env.ESBUILD_BINARY_PATH;
    } else {
      process.env.ESBUILD_BINARY_PATH = previousBinaryOverride;
    }
  }
  if (typeof module.build !== 'function') {
    throw new PluginAuthorBundlerUnavailableError();
  }
  cachedPluginAuthorBundlerBuild = module.build as typeof EsbuildBuild;
  return cachedPluginAuthorBundlerBuild;
}

export function regularFilesMayAlias(params: {
  sourcePath: string;
  sourceIdentity: RegularFileIdentity;
  outputPath: string;
  outputIdentity: RegularFileIdentity;
}): boolean {
  if (params.sourcePath === params.outputPath) return true;
  const identitiesAreAvailable = params.sourceIdentity.dev !== 0
    && params.sourceIdentity.ino !== 0
    && params.outputIdentity.dev !== 0
    && params.outputIdentity.ino !== 0;
  if (!identitiesAreAvailable) {
    return params.sourceIdentity.nlink > 1 && params.outputIdentity.nlink > 1;
  }
  return params.sourceIdentity.dev === params.outputIdentity.dev
    && params.sourceIdentity.ino === params.outputIdentity.ino;
}

export async function bundlePluginDaemonRuntime(
  projectRootInput: string,
): Promise<void> {
  const projectRoot = await realpath(resolve(projectRootInput));
  const runtimeSource = await evaluatePluginAuthorRuntimeStagingSource({
    locator: projectRoot,
    rootPath: projectRoot,
  });
  const daemonEntrypoint = runtimeSource.evaluated.manifest.entrypoints?.daemon;
  const staged = daemonEntrypoint
    ? await stagePluginDaemonRuntime({
        sourceRootPath: projectRoot,
        sourceEntryPath: runtimeSource.evaluated.entry.entryPath,
        stagedRootPath: projectRoot,
        daemonEntrypoint,
        sessionRunnerFactories: runtimeSource.sessionRunnerFactories,
      })
    : { outputRelativePaths: [] as readonly string[] };
  const generatedManifestPath = join(projectRoot, GENERATED_PLUGIN_MANIFEST_RELATIVE_PATH);
  const generatedManifestDirectory = dirname(generatedManifestPath);
  await mkdir(generatedManifestDirectory, { recursive: true });
  const physicalManifestDirectory = await realpath(generatedManifestDirectory);
  if (!isPathInsideRoot(projectRoot, physicalManifestDirectory)) {
    throw new Error('Plugin generated manifest directory escaped its physical project root');
  }
  let generatedManifest = false;
  try {
    const manifestStat = await lstat(generatedManifestPath);
    if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
      throw new Error('Plugin manifest path must be a regular file');
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
    await writeFile(generatedManifestPath, runtimeSource.evaluated.canonicalManifestJson, {
      encoding: 'utf8',
      flag: 'wx',
    });
    generatedManifest = true;
  }
  await writePluginDaemonOutputManifest({
    projectRoot,
    outputRelativePaths: [
      ...staged.outputRelativePaths,
      ...(generatedManifest ? [GENERATED_PLUGIN_MANIFEST_RELATIVE_PATH] : []),
    ],
  });
}

/**
 * Bundles an already-evaluated author module into an isolated package staging
 * root. Packing owns this path; it never writes generated bytes back into the
 * author's source tree.
 */
export type StagedPluginDaemonRuntime = Readonly<{
  outputRelativePaths: readonly string[];
}>;

export async function stagePluginDaemonRuntime(
  params: Readonly<{
    sourceRootPath: string;
    sourceEntryPath: string;
    stagedRootPath: string;
    daemonEntrypoint: string;
    /** Already projected by the pack owner from reviewed publication fields. */
    effectiveManifest?: CanonicalPluginManifest;
    sessionRunnerFactories?: readonly ValidatedAgentSessionRunnerFactoryFactV1[];
    /**
     * First-party packaged runtimes resolve workspace imports from the host's
     * declared package closure, independent of mutable nested development
     * dependency copies. Ordinary author builds omit this map.
     */
    canonicalWorkspacePackageRoots?: Readonly<Record<string, string>>;
    /**
     * Private first-party publication may resolve these exact workspace packages
     * from the packaged CLI closure. Ordinary/public author packs omit this and
     * remain self-contained.
     */
    firstPartyPackagedWorkspaceExternals?: readonly string[];
  }>,
  deps: Readonly<{ build?: typeof EsbuildBuild }> = {},
): Promise<StagedPluginDaemonRuntime> {
  const sourceRoot = await realpath(resolve(params.sourceRootPath));
  const sourceRealPath = await realpath(resolve(params.sourceEntryPath));
  const sourceStat = await lstat(sourceRealPath);
  if (!isPathInsideRoot(sourceRoot, sourceRealPath) || !sourceStat.isFile()) {
    throw new Error('Plugin author entry must resolve to a contained regular file');
  }
  const typeScriptConfig = await resolvePluginAuthorTypeScriptConfigBoundary({
    packageRootPath: sourceRoot,
    entryPath: sourceRealPath,
  });

  const stagedRoot = await realpath(resolve(params.stagedRootPath));
  const declaredDaemonExtension = posix.extname(params.daemonEntrypoint.replaceAll('\\', '/')).toLowerCase();
  if (declaredDaemonExtension !== '.js' && declaredDaemonExtension !== '.mjs') {
    throw new Error('Code-defined plugin daemon staging emits ESM and requires a .mjs entrypoint or .js in a type:module package');
  }
  if (declaredDaemonExtension === '.js') {
    let packageJson: unknown;
    try {
      packageJson = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'));
    } catch {
      throw new Error('Code-defined plugin daemon .js entrypoint requires a valid type:module package.json');
    }
    if (
      typeof packageJson !== 'object'
      || packageJson === null
      || Array.isArray(packageJson)
      || (packageJson as Readonly<Record<string, unknown>>).type !== 'module'
    ) {
      throw new Error('Code-defined plugin daemon .js entrypoint requires package.json type:module');
    }
  }
  const outputResolution = resolvePortablePluginRelativePath({
    rootPath: stagedRoot,
    value: params.daemonEntrypoint,
    label: 'entrypoints.daemon',
  });
  if (!outputResolution.ok) throw new Error(outputResolution.message);
  const outputPath = outputResolution.path;
  // Staging may write into an isolated packaging root, so the two facts are
  // compared as package-root-relative paths: the emit directory is relative to
  // the author's source root, the daemon entry to the root receiving it.
  assertPluginDaemonEntryOutsideTypeScriptEmit({
    daemonRelativePath: relative(stagedRoot, outputPath).split(sep).join('/'),
    emitOutputRelativePath: typeScriptConfig.emitOutputRelativePath,
  });
  const outputParentPath = dirname(outputPath);
  const existingOutputAncestorRealPath = await realpathNearestExistingAncestor(outputParentPath);
  if (!isPathInsideRoot(stagedRoot, existingOutputAncestorRealPath)) {
    throw new Error('entrypoints.daemon must resolve inside the staged plugin package');
  }
  await mkdir(outputParentPath, { recursive: true });
  const outputParentRealPath = await realpath(outputParentPath);
  if (!isPathInsideRoot(stagedRoot, outputParentRealPath)) {
    throw new Error('entrypoints.daemon must resolve inside the staged plugin package');
  }
  try {
    const outputStat = await lstat(outputPath);
    if (outputStat.isSymbolicLink() || !outputStat.isFile()) {
      throw new Error('entrypoints.daemon must be a contained regular file');
    }
    const outputRealPath = await realpath(outputPath);
    if (!isPathInsideRoot(stagedRoot, outputRealPath)) {
      throw new Error('entrypoints.daemon must resolve inside the staged plugin package');
    }
    if (regularFilesMayAlias({
      sourcePath: sourceRealPath,
      sourceIdentity: sourceStat,
      outputPath: outputRealPath,
      outputIdentity: outputStat,
    })) {
      throw new Error('entrypoints.daemon must not overwrite the plugin author entry');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error;
  }

  const sessionRunnerEntries = new Map<string, string>();
  for (const factory of params.sessionRunnerFactories ?? []) {
    const locatorModule = factory.locator.module;
    if (factory.loadMode !== 'source-ts') {
      throw new Error(`Session runner module '${locatorModule}' must come from the current author source generation`);
    }
    const runnerSourceResolution = resolvePortablePluginRelativePath({
      rootPath: sourceRoot,
      value: factory.normalizedModulePath,
      label: 'Validated Agent session runner source module',
    });
    if (!runnerSourceResolution.ok) throw new Error(runnerSourceResolution.message);
    const runnerSourcePath = await realpath(runnerSourceResolution.path);
    const runnerStat = await lstat(runnerSourcePath);
    if (!runnerStat.isFile() || !isPathInsideRoot(sourceRoot, runnerSourcePath)) {
      throw new Error(`Session runner module '${locatorModule}' was not found as a contained author source file`);
    }
    if (runnerSourcePath === sourceRealPath) {
      throw new Error(`Session runner module '${locatorModule}' must be a leaf distinct from the plugin activation entry`);
    }
    const packedRelativePath = projectPackedSessionRunnerModulePath({
      daemonEntrypoint: params.daemonEntrypoint,
      locatorModule,
    });
    const packedResolution = resolvePortablePluginRelativePath({
      rootPath: stagedRoot,
      value: packedRelativePath,
      label: 'Agent session runner factory module',
    });
    if (!packedResolution.ok) throw new Error(packedResolution.message);
    if (packedResolution.path === outputPath) {
      throw new Error(
        `Session runner module '${locatorModule}' must not collide with the packed plugin activation entry`,
      );
    }
    const existing = sessionRunnerEntries.get(packedRelativePath);
    if (existing && existing !== runnerSourcePath) {
      throw new Error(`Session runner modules collide at packed path '${packedRelativePath}'`);
    }
    sessionRunnerEntries.set(packedRelativePath, runnerSourcePath);
  }

  const build = deps.build ?? loadPluginAuthorBundlerBuild();
  const { createZodMiniEnglishLocaleCompilerPlugin } = await import('@happier-dev/plugin-sdk/ui/build');
  const firstPartyPackagedWorkspaceExternals = resolveFirstPartyPackagedWorkspaceExternals({
    sourceRoot,
    canonicalWorkspacePackageRoots: params.canonicalWorkspacePackageRoots,
    externalPackages: params.firstPartyPackagedWorkspaceExternals,
  });
  const canonicalWorkspaceImportResolver = await createCanonicalWorkspaceImportResolver(
    params.canonicalWorkspacePackageRoots,
    stagedRoot,
    firstPartyPackagedWorkspaceExternals.filter((specifier) => !specifier.endsWith('/*')),
  );
  const portableRoot = resolvePortableModulePathRoot(
    sourceRoot,
    params.canonicalWorkspacePackageRoots,
  );
  const buildWorkingDirectory = canonicalWorkspaceImportResolver?.resolutionRoot ?? sourceRoot;
  const daemonRelativePath = relative(stagedRoot, outputPath).split(sep).join('/');
  const daemonExtension = extname(daemonRelativePath);
  const logicalSourceRoot = canonicalWorkspaceImportResolver
    ? join(buildWorkingDirectory, '__happier-author-source')
    : sourceRoot;
  if (canonicalWorkspaceImportResolver) {
    await symlink(sourceRoot, logicalSourceRoot, process.platform === 'win32' ? 'junction' : 'dir');
  }
  const logicalSourcePath = canonicalWorkspaceImportResolver
    ? join(logicalSourceRoot, relative(sourceRoot, sourceRealPath))
    : sourceRealPath;
  const publicationEntry = 'happier-publication-entry';
  const effectiveManifest = params.effectiveManifest;
  const publicationEntryPlugin: EsbuildPlugin = {
    name: 'happier-plugin-publication-entry',
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /^happier-publication-entry$/ }, () => ({
        path: publicationEntry,
        namespace: publicationEntry,
      }));
      if (!effectiveManifest) return;
      pluginBuild.onLoad({ filter: /.*/, namespace: publicationEntry }, () => ({
        contents: [
          `export * from ${JSON.stringify(logicalSourcePath)};`,
          `export const manifest = JSON.parse(${JSON.stringify(serializeCanonicalPluginManifest(effectiveManifest))});`,
        ].join('\n'),
        loader: 'js',
        resolveDir: sourceRoot,
      }));
    },
  };
  const entryPoints = Object.fromEntries([
    [daemonRelativePath.slice(0, -daemonExtension.length), params.effectiveManifest ? publicationEntry : logicalSourcePath],
    ...[...sessionRunnerEntries].map(([packedPath, sourcePath]) => [
      packedPath.slice(0, -extname(packedPath).length),
      canonicalWorkspaceImportResolver
        ? join(logicalSourceRoot, relative(sourceRoot, sourcePath))
        : sourcePath,
    ] as const),
  ]);
  // esbuild owns module namespaces. Observe them before any loader handles a
  // module instead of guessing whether a colon is a namespace or a drive path.
  const virtualInputs = new Map<string, VirtualEsbuildInput>();
  const inputNamespacesPlugin: EsbuildPlugin = {
    name: 'happier-plugin-daemon-input-namespaces',
    setup(pluginBuild) {
      pluginBuild.onLoad({ filter: /.*/ }, (args) => {
        if (args.namespace && args.namespace !== 'file') {
          virtualInputs.set(`${args.namespace}:${args.path}${args.suffix}`, {
            namespace: args.namespace,
            path: args.path,
            suffix: args.suffix,
          });
        }
        return undefined;
      });
    },
  };
  try {
    const buildResult = await build({
      entryPoints,
      outdir: stagedRoot,
      absWorkingDir: buildWorkingDirectory,
      bundle: true,
      preserveSymlinks: true,
      format: 'esm',
      banner: { js: BUNDLED_PLUGIN_DAEMON_ESM_REQUIRE_BANNER },
      inject: [BUNDLED_PLUGIN_DAEMON_REQUIRE_INJECTION],
      plugins: [
        inputNamespacesPlugin,
        ...(params.effectiveManifest ? [publicationEntryPlugin] : []),
        createZodMiniEnglishLocaleCompilerPlugin(),
        bundledPluginDaemonRequirePlugin,
        ...(canonicalWorkspaceImportResolver ? [canonicalWorkspaceImportResolver.plugin] : []),
      ],
      splitting: sessionRunnerEntries.size > 0,
      platform: 'node',
      target: 'node20',
      packages: 'bundle',
      ...(firstPartyPackagedWorkspaceExternals.length > 0
        ? { external: [...firstPartyPackagedWorkspaceExternals] }
        : {}),
      entryNames: '[dir]/[name]',
      chunkNames: `${posix.dirname(daemonRelativePath)}/.happier-chunks/[name]-[hash]`,
      outExtension: { '.js': daemonExtension },
      sourcemap: false,
      logLevel: 'silent',
      metafile: true,
      tsconfigRaw: typeScriptConfig.bundlerTsconfigRaw,
      ...(canonicalWorkspaceImportResolver
        ? {
          alias: canonicalWorkspaceImportResolver.aliases,
          nodePaths: canonicalWorkspaceImportResolver.nodePaths,
        }
        : {}),
    });
    if (!buildResult.metafile) {
      throw new Error('Plugin daemon runtime build did not return its requested metafile');
    }
    const metafile = buildResult.metafile;
    await validateContainedPackSourceImports({
      sourceRoot,
      resolutionRoot: buildWorkingDirectory,
      metafile,
      virtualInputs,
    });

    const emittedOutputs = Object.keys(metafile.outputs).map((outputKey) => {
      const absoluteOutputPath = resolve(buildWorkingDirectory, outputKey);
      if (!isPathInsideRoot(stagedRoot, absoluteOutputPath)) {
        throw new Error(`Staged plugin daemon runtime output escaped its package root: '${outputKey}'`);
      }
      return Object.freeze({ outputKey, absoluteOutputPath });
    });

    const portableLabelsByInputKey = new Map(
      Object.keys(metafile.inputs)
        .map((inputKey) => {
          const virtualInput = virtualInputs.get(inputKey);
          const portablePath = portableModulePathLabel(virtualInput?.path ?? inputKey, {
            buildWorkingDirectory, portableRoot,
          });
          return [inputKey, virtualInput ? `${virtualInput.namespace}:${portablePath}${virtualInput.suffix}` : portablePath] as const;
        })
        .filter(([inputKey, portableLabel]) => inputKey !== portableLabel),
    );

    for (const { absoluteOutputPath } of emittedOutputs) {
      const emittedPath = absoluteOutputPath;
      const emittedSource = await readFile(emittedPath, 'utf8');
      const rewrittenSource = rewriteEsbuildModulePathLabels(
        emittedSource,
        portableLabelsByInputKey,
      );
      if (rewrittenSource !== emittedSource) {
        await writeFile(emittedPath, rewrittenSource, 'utf8');
      }
    }

    const outputRelativePaths = emittedOutputs.map(({ absoluteOutputPath }) => {
      return relative(stagedRoot, absoluteOutputPath).split(sep).join('/');
    });
    outputRelativePaths.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    return Object.freeze({
      outputRelativePaths: Object.freeze(outputRelativePaths),
    });
  } finally {
    await canonicalWorkspaceImportResolver?.dispose();
  }
}
