import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { builtinModules, createRequire } from 'node:module';
import { join, resolve } from 'node:path';

import type ts from 'typescript';

import {
  resolveAuthoritativePackagedRuntimeProjectRoot,
  type AuthoritativePackagedRuntimeProjectRoot,
} from '@/packagedRuntime/resolvePackagedRuntimeEntrypoint';
import {
  findRepoRoot,
  resolveWorkspaceBundlesFromPackageJson,
} from '@happier-dev/cli-common/workspaces';
import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';

import { resolveSameInstallNodeModulesRoot } from './packageInstallationRoot';

/**
 * The one resolver for the running host's public Plugin SDK package. It owns
 * the shipped binary-safe closure proof (the CLI must already declare and
 * physically bundle the SDK) and projects exact public specifier aliases for
 * the narrow dependency-free single-file development loader. Package-root
 * development shares the bundled-package resolver for prepublication
 * dependency preparation, but never consumes the single-file aliases.
 */
export const PLUGIN_SDK_PACKAGE_NAME = '@happier-dev/plugin-sdk';

export type RuntimePackageJson = Readonly<{
  name?: unknown;
  dependencies?: unknown;
  optionalDependencies?: unknown;
  bundleDependencies?: unknown;
  bundledDependencies?: unknown;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function readPackageJsonRecord(packageJsonPath: string, description: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  if (!isRecord(parsed)) {
    throw new Error(`${description} must be a JSON object`);
  }
  return parsed;
}

export function isSourceWorkspaceAuthoringAuthority(authority: AuthoritativePackagedRuntimeProjectRoot): boolean {
  return (authority.provenance === 'source-module' || authority.provenance === 'source-snapshot')
    && resolveSourceBundleAuthorNodeModulesRoot(authority.root) === null;
}

function resolveSourceBundleAuthorNodeModulesRoot(runtimeRoot: string): string | null {
  const recordPath = resolve(runtimeRoot, '../..', 'source-bundle.json');
  let record: Record<string, unknown>;
  try {
    record = readPackageJsonRecord(recordPath, 'The source CLI bundle record');
  } catch (error) {
    if (error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT') return null;
    throw error;
  }
  // Source-runtime provenance remains unchanged. The finite producer record,
  // not a repository search or a moving dependency tree, owns author packages.
  if (typeof record.runtimeDir !== 'string' || typeof record.cliDir !== 'string'
    || realpathSync(record.runtimeDir) !== realpathSync(runtimeRoot)
    || realpathSync(record.cliDir) !== realpathSync(runtimeRoot)) {
    throw new Error('The source CLI bundle record does not own its runtime root');
  }
  return join(runtimeRoot, 'authoring', 'node_modules');
}

export function readRuntimePackageJson(runtimeRoot: string): RuntimePackageJson {
  const packageJsonPath = realpathSync(join(runtimeRoot, 'package.json'));
  if (!isCanonicalAbsolutePathInsideRoot(runtimeRoot, packageJsonPath)) {
    throw new Error('The running Happier CLI package manifest escapes its runtime root');
  }
  return readPackageJsonRecord(packageJsonPath, 'The running Happier CLI package manifest') as RuntimePackageJson;
}

export function assertPluginAuthorPrepublicationRuntimeDeclarations(
  runtimeRoot: string,
  packageNames: readonly string[] = [PLUGIN_SDK_PACKAGE_NAME],
): void {
  const packageJson = readRuntimePackageJson(runtimeRoot);
  const dependencies = packageJson.dependencies;
  const declaredDependencies = dependencies
    && typeof dependencies === 'object'
    && !Array.isArray(dependencies)
    ? (dependencies as Record<string, unknown>)
    : {};
  const bundledDependencies = new Set(
    Array.isArray(packageJson.bundledDependencies)
      ? packageJson.bundledDependencies.filter((value): value is string => typeof value === 'string')
      : [],
  );
  if (packageJson.name !== '@happier-dev/cli') {
    throw new Error('The running Happier CLI package manifest is invalid');
  }
  for (const packageName of packageNames) {
    const declaredVersion = declaredDependencies[packageName];
    if (
      (typeof declaredVersion !== 'string' || declaredVersion.trim().length === 0)
      && !bundledDependencies.has(packageName)
    ) {
      throw new Error(`The running Happier CLI does not declare its '${packageName}' runtime dependency`);
    }
  }
}

export function resolvePhysicalBundledWorkspacePackageRoot(params: Readonly<{
  candidatePath: string;
  allowedRootPath: string;
  packageName: string;
}>): string | null {
  try {
    const candidateStats = lstatSync(params.candidatePath);
    if (!candidateStats.isDirectory() || candidateStats.isSymbolicLink()) return null;
    const physicalPackageRoot = realpathSync(params.candidatePath);
    const physicalAllowedRoot = realpathSync(params.allowedRootPath);
    if (!isCanonicalAbsolutePathInsideRoot(physicalAllowedRoot, physicalPackageRoot)) return null;
    const packageJsonPath = realpathSync(join(physicalPackageRoot, 'package.json'));
    if (!isCanonicalAbsolutePathInsideRoot(physicalPackageRoot, packageJsonPath) || !statSync(packageJsonPath).isFile()) {
      return null;
    }
    const packageJson = readPackageJsonRecord(
      packageJsonPath,
      `Bundled workspace package '${params.packageName}' manifest`,
    );
    return packageJson.name === params.packageName ? physicalPackageRoot : null;
  } catch {
    return null;
  }
}

export function resolvePackagedCliBundledWorkspacePackageRoot(
  runtimeRoot: string,
  packageName: string,
): string {
  const sourceAuthorRoot = resolveSourceBundleAuthorNodeModulesRoot(runtimeRoot);
  if (sourceAuthorRoot) {
    const packageRoot = resolvePhysicalBundledWorkspacePackageRoot({
      candidatePath: join(sourceAuthorRoot, ...packageName.split('/')),
      allowedRootPath: runtimeRoot,
      packageName,
    });
    if (packageRoot) return packageRoot;
    throw new Error(`The source CLI has no physical bundled '${packageName}' author dependency`);
  }
  const candidateRoots: Array<Readonly<{ candidatePath: string; allowedRootPath: string }>> = [{
    candidatePath: join(runtimeRoot, 'node_modules', ...packageName.split('/')),
    // Managed code artifacts link this entire tree to their shared support
    // payload. Packages must remain physical children of that owned tree,
    // not necessarily of the separate code artifact.
    allowedRootPath: join(runtimeRoot, 'node_modules'),
  }];
  const sameInstallNodeModulesRoot = resolveSameInstallNodeModulesRoot(runtimeRoot);
  if (sameInstallNodeModulesRoot) {
    candidateRoots.push({
      candidatePath: join(sameInstallNodeModulesRoot, ...packageName.split('/')),
      allowedRootPath: sameInstallNodeModulesRoot,
    });
  }
  for (const candidate of candidateRoots) {
    const packageRoot = resolvePhysicalBundledWorkspacePackageRoot({ ...candidate, packageName });
    if (packageRoot) return packageRoot;
  }
  throw new Error(`The running Happier CLI has no physical bundled '${packageName}' dependency`);
}

/**
 * Resolves the package root of the public Plugin SDK owned by the *running*
 * host, whether the CLI executes from a source checkout or a packaged binary.
 * The shipped-closure declaration owner must already accept the runtime, so a
 * binary whose bundled closure lost the SDK fails closed instead of falling
 * back to some other resolution.
 */
export function resolveHostPluginSdkPackageRoot(
  options: Readonly<{ runtimeModuleUrl?: string }> = {},
): string {
  const runtimeAuthority = resolveAuthoritativePackagedRuntimeProjectRoot(
    options.runtimeModuleUrl === undefined ? {} : { moduleUrl: options.runtimeModuleUrl },
  );
  if (!runtimeAuthority) {
    throw new Error('The running Happier CLI runtime root is unavailable for Plugin SDK resolution');
  }
  const runtimeRoot = realpathSync(runtimeAuthority.root);
  assertPluginAuthorPrepublicationRuntimeDeclarations(runtimeRoot, [PLUGIN_SDK_PACKAGE_NAME]);
  if (isSourceWorkspaceAuthoringAuthority(runtimeAuthority)) {
    const repoRoot = findRepoRoot(runtimeRoot);
    const workspaceBundle = resolveWorkspaceBundlesFromPackageJson({
      repoRoot,
      hostPackageDir: runtimeRoot,
    }).find((bundle) => bundle.packageName === PLUGIN_SDK_PACKAGE_NAME);
    const packageRoot = workspaceBundle
      ? resolvePhysicalBundledWorkspacePackageRoot({
        candidatePath: workspaceBundle.srcDir,
        allowedRootPath: repoRoot,
        packageName: PLUGIN_SDK_PACKAGE_NAME,
      })
      : null;
    if (!packageRoot) {
      throw new Error(`The running Happier CLI source workspace does not bundle '${PLUGIN_SDK_PACKAGE_NAME}'`);
    }
    return packageRoot;
  }
  return resolvePackagedCliBundledWorkspacePackageRoot(runtimeRoot, PLUGIN_SDK_PACKAGE_NAME);
}

const PRIVATE_PLUGIN_SDK_SUBPATH_PREFIXES = Object.freeze([
  `${PLUGIN_SDK_PACKAGE_NAME}/host`,
  `${PLUGIN_SDK_PACKAGE_NAME}/first-party`,
  `${PLUGIN_SDK_PACKAGE_NAME}/testing`,
]);

function isNodeBuiltinSpecifier(specifier: string): boolean {
  return specifier.startsWith('node:')
    || builtinModules.includes(specifier)
    || builtinModules.includes(specifier.replace(/^node:/, ''));
}

function isPrivatePluginSdkSpecifier(specifier: string): boolean {
  return PRIVATE_PLUGIN_SDK_SUBPATH_PREFIXES.some((prefix) => (
    specifier === prefix || specifier.startsWith(`${prefix}/`)
  ));
}

function isPluginSdkSpecifier(specifier: string): boolean {
  return specifier === PLUGIN_SDK_PACKAGE_NAME || specifier.startsWith(`${PLUGIN_SDK_PACKAGE_NAME}/`);
}

/**
 * Establishes the intentionally narrow host resolution exception for literal
 * single-file development. Every import in the file is classified statically:
 * public plugin SDK specifiers are remembered for host aliasing, host-private
 * SDK subpaths and foreign packages are rejected with package-root guidance,
 * and relative or standard-library specifiers are left to normal resolution.
 * Package roots never call this boundary and keep resolving their declared
 * dependency closure through package semantics.
 */
export async function preparePluginSingleFileDevelopmentLoad(
  entryPath: string,
  options: Readonly<{ runtimeModuleUrl?: string }> = {},
): Promise<Readonly<Record<string, string>>> {
  const sourceText = await readFile(resolve(entryPath), 'utf8');
  const { default: ts } = await import('typescript');
  const source = ts.createSourceFile(
    resolve(entryPath),
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const sdkSpecifiers = new Set<string>();
  const inspectSpecifier = (node: ts.Expression | undefined): void => {
    if (!node) return;
    if (!ts.isStringLiteralLike(node)) {
      throw new Error('Dependency-free single-file development requires literal string import specifiers');
    }
    const specifier = node.text;
    if (
      specifier.startsWith('.')
      || specifier.startsWith('/')
      || isNodeBuiltinSpecifier(specifier)
    ) {
      return;
    }
    if (!isPluginSdkSpecifier(specifier)) {
      throw new Error(
        `Dependency-free single-file development may import only the public plugin SDK; rejected '${specifier}'.`
          + " Create a package root and declare its dependencies to use other packages.",
      );
    }
    if (isPrivatePluginSdkSpecifier(specifier)) {
      throw new Error(`Dependency-free single-file development cannot import host-private plugin SDK module '${specifier}'`);
    }
    sdkSpecifiers.add(specifier);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      inspectSpecifier(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (!ts.isExternalModuleReference(node.moduleReference)) {
        throw new Error('Dependency-free single-file development cannot use internal import aliases');
      }
      inspectSpecifier(node.moduleReference.expression);
    } else if (
      ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || ts.isIdentifier(node.expression) && node.expression.text === 'require')
    ) {
      inspectSpecifier(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (sdkSpecifiers.size === 0) {
    return Object.freeze({});
  }

  // A resolvable local copy always wins: normal package resolution owns the
  // import graph and the host must not shadow a declared or locally prepared
  // dependency.
  try {
    createRequire(entryPath).resolve(PLUGIN_SDK_PACKAGE_NAME);
    return Object.freeze({});
  } catch {
    // No local copy resolves; the host's public SDK build may serve the file.
  }

  const sdkPackageRoot = resolveHostPluginSdkPackageRoot(options);
  const sdkRequire = createRequire(join(sdkPackageRoot, 'package.json'));
  const aliases: Record<string, string> = {};
  for (const specifier of sdkSpecifiers) {
    try {
      aliases[specifier] = sdkRequire.resolve(specifier);
    } catch (error) {
      throw new Error(
        `The running Happier CLI public plugin SDK build could not resolve '${specifier}'`
          + ` from '${PLUGIN_SDK_PACKAGE_NAME}': ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  return Object.freeze(aliases);
}
