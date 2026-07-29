import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { build as EsbuildBuild } from 'esbuild';
import semver from 'semver';

import {
  resolveAuthoritativePackagedRuntimeProjectRoot,
  type AuthoritativePackagedRuntimeProjectRoot,
} from '@/packagedRuntime/resolvePackagedRuntimeEntrypoint';
import { resolvePortablePluginRelativePath } from '@/plugins/manifest/portableRelativePath';
import { readPluginManifest } from '@/plugins/manifest/read';

function isPathInsideRoot(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  return relativePath === ''
    || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

async function realpathNearestExistingAncestor(targetPath: string): Promise<string> {
  let candidatePath = targetPath;
  while (true) {
    try {
      return await realpath(candidatePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error;
      const parentPath = dirname(candidatePath);
      if (parentPath === candidatePath) throw error;
      candidatePath = parentPath;
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

function resolveSameInstallNodeModulesRoot(packageRoot: string): string | null {
  const packageParent = dirname(packageRoot);
  if (basename(packageParent) === 'node_modules') {
    return packageParent;
  }
  const scopeParent = dirname(packageParent);
  return basename(packageParent).startsWith('@') && basename(scopeParent) === 'node_modules'
    ? scopeParent
    : null;
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
          if (packageJson.name !== 'esbuild' || packageJson.main !== 'lib/main.js') {
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
  deps: Readonly<{ build?: typeof EsbuildBuild }> = {},
): Promise<void> {
  const projectRoot = await realpath(resolve(projectRootInput));
  const manifestResult = await readPluginManifest({
    manifestPath: join(projectRoot, '.happier-plugin', 'plugin.json'),
  });
  if (!manifestResult.ok) {
    throw new Error(manifestResult.diagnostics.map((diagnostic) => diagnostic.message).join('; '));
  }
  const developmentEntrypoint = manifestResult.manifest.entrypoints?.development;
  const daemonEntrypoint = manifestResult.manifest.entrypoints?.daemon;
  if (!developmentEntrypoint || !daemonEntrypoint) {
    throw new Error('Plugin build requires both entrypoints.development and entrypoints.daemon');
  }
  const sourceResolution = resolvePortablePluginRelativePath({
    rootPath: projectRoot,
    value: developmentEntrypoint,
    label: 'entrypoints.development',
  });
  if (!sourceResolution.ok) throw new Error(sourceResolution.message);
  const outputResolution = resolvePortablePluginRelativePath({
    rootPath: projectRoot,
    value: daemonEntrypoint,
    label: 'entrypoints.daemon',
  });
  if (!outputResolution.ok) throw new Error(outputResolution.message);
  const sourcePath = sourceResolution.path;
  const outputPath = outputResolution.path;
  const sourceRealPath = await realpath(sourcePath);
  const sourceStat = await lstat(sourceRealPath);
  if (!isPathInsideRoot(projectRoot, sourceRealPath) || !sourceStat.isFile()) {
    throw new Error('entrypoints.development must resolve to a contained regular file');
  }
  const outputParentPath = dirname(outputPath);
  const existingOutputAncestorRealPath = await realpathNearestExistingAncestor(outputParentPath);
  if (!isPathInsideRoot(projectRoot, existingOutputAncestorRealPath)) {
    throw new Error('entrypoints.daemon must resolve inside the plugin project');
  }
  await mkdir(outputParentPath, { recursive: true });
  const outputParentRealPath = await realpath(outputParentPath);
  if (!isPathInsideRoot(projectRoot, outputParentRealPath)) {
    throw new Error('entrypoints.daemon must resolve inside the plugin project');
  }
  let outputRealPath: string | null = null;
  let outputStat: Awaited<ReturnType<typeof lstat>> | null = null;
  try {
    outputStat = await lstat(outputPath);
    if (outputStat.isSymbolicLink() || !outputStat.isFile()) {
      throw new Error('entrypoints.daemon must be a contained regular file');
    }
    outputRealPath = await realpath(outputPath);
    if (!isPathInsideRoot(projectRoot, outputRealPath)) {
      throw new Error('entrypoints.daemon must resolve inside the plugin project');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error;
  }
  if (
    outputStat !== null
    && outputRealPath !== null
    && regularFilesMayAlias({
      sourcePath: sourceRealPath,
      sourceIdentity: sourceStat,
      outputPath: outputRealPath,
      outputIdentity: outputStat,
    })
  ) {
    throw new Error('entrypoints.daemon must not overwrite entrypoints.development');
  }
  const build = deps.build ?? loadPluginAuthorBundlerBuild();
  await build({
    entryPoints: [sourceRealPath],
    outfile: outputPath,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    packages: 'bundle',
    sourcemap: false,
    logLevel: 'silent',
  });
}
