import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { TsconfigRaw } from 'esbuild';
import ts from 'typescript';
import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';
import { realpathNearestExistingAncestor } from './physicalAncestorPath';

function formatConfigDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
  return diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')).join('; ');
}

async function assertConfigPathContained(params: Readonly<{
  packageRoot: string;
  label: string;
  targetPath: string;
}>): Promise<void> {
  const physicalAncestor = await realpathNearestExistingAncestor(resolve(params.targetPath));
  if (!isCanonicalAbsolutePathInsideRoot(params.packageRoot, physicalAncestor)) {
    throw new Error(
      `Plugin author TypeScript config ${params.label} resolves outside the physical package root`,
    );
  }
}

async function assertAliasTreeContained(params: Readonly<{
  packageRoot: string;
  pattern: string;
  target: string;
  targetRootPath: string;
}>): Promise<void> {
  const pendingPaths = [params.targetRootPath];
  const visitedDirectories = new Set<string>();

  while (pendingPaths.length > 0) {
    const currentPath = pendingPaths.pop()!;
    let currentStats: Awaited<ReturnType<typeof lstat>>;
    try {
      currentStats = await lstat(currentPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') continue;
      throw error;
    }

    const physicalPath = await realpath(currentPath);
    if (!isCanonicalAbsolutePathInsideRoot(params.packageRoot, physicalPath)) {
      throw new Error(
        `Plugin author TypeScript config paths['${params.pattern}'] target '${params.target}' resolves outside the physical package root`,
      );
    }

    const physicalStats = currentStats.isSymbolicLink() ? await stat(physicalPath) : currentStats;
    if (!physicalStats.isDirectory() || visitedDirectories.has(physicalPath)) continue;
    visitedDirectories.add(physicalPath);
    const children = await readdir(physicalPath);
    for (const child of children) pendingPaths.push(join(physicalPath, child));
  }
}

export type PluginAuthorTypeScriptConfigBoundary = Readonly<{
  tsconfigPath: string | null;
  aliases: Readonly<Record<string, string>>;
  bundlerTsconfigRaw: TsconfigRaw;
  /**
   * The package-root-relative directory this author's TypeScript compiler emits
   * JavaScript into, or `null` when the config emits none. Only a declared
   * `outDir` inside the package is reported: without one the compiler writes
   * beside each source file, which no daemon entry has ever been declared to
   * occupy, and an `outDir` outside the package is rejected by containment.
   */
  emitOutputRelativePath: string | null;
}>;

/**
 * The one directory a plugin daemon entry may never occupy: the author's own
 * TypeScript output. Both the compiler and the daemon bundler write whole files
 * there, so a shared path has two producers and the compiler's re-export module
 * silently replaces a self-contained bundle — which still resolves in a source
 * checkout through linked workspaces, and fails only once the plugin is packed.
 */
export function assertPluginDaemonEntryOutsideTypeScriptEmit(params: Readonly<{
  daemonRelativePath: string;
  emitOutputRelativePath: string | null;
}>): void {
  const emitOutputRelativePath = params.emitOutputRelativePath;
  if (emitOutputRelativePath === null) return;
  const daemonRelativePath = params.daemonRelativePath
    .replaceAll('\\', '/')
    .replace(/^\.\//u, '');
  if (
    daemonRelativePath !== emitOutputRelativePath
    && !daemonRelativePath.startsWith(`${emitOutputRelativePath}/`)
  ) return;
  throw new Error(
    `entrypoints.daemon must not resolve inside the TypeScript output directory `
    + `'${emitOutputRelativePath}/': the author TypeScript compiler and the plugin daemon `
    + `bundler would both produce '${daemonRelativePath}', and a compiler emit replaces the `
    + 'daemon bundle with a re-export module',
  );
}

function resolveEmitOutputRelativePath(params: Readonly<{
  packageRoot: string;
  options: ts.CompilerOptions;
}>): string | null {
  const options = params.options;
  if (options.noEmit === true || options.emitDeclarationOnly === true) return null;
  const outDir = options.outDir;
  if (typeof outDir !== 'string' || outDir.length === 0) return null;
  const relativeOutDir = relative(params.packageRoot, resolve(outDir));
  if (relativeOutDir.length === 0 || relativeOutDir === '..'
    || relativeOutDir.startsWith(`..${sep}`) || isAbsolute(relativeOutDir)) return null;
  return relativeOutDir.split(sep).join('/');
}

export async function resolvePluginAuthorTypeScriptConfigBoundary(params: Readonly<{
  packageRootPath: string;
  entryPath: string;
}>): Promise<PluginAuthorTypeScriptConfigBoundary> {
  const packageRoot = await realpath(resolve(params.packageRootPath));
  const entryPath = await realpath(resolve(params.entryPath));
  const configPath = ts.findConfigFile(dirname(entryPath), ts.sys.fileExists, 'tsconfig.json');
  if (!configPath || !isCanonicalAbsolutePathInsideRoot(packageRoot, resolve(configPath))) {
    return Object.freeze({
      tsconfigPath: null,
      aliases: Object.freeze({}),
      bundlerTsconfigRaw: Object.freeze({}),
      emitOutputRelativePath: null,
    });
  }
  const physicalConfigPath = await realpath(configPath);
  if (!isCanonicalAbsolutePathInsideRoot(packageRoot, physicalConfigPath)) {
    throw new Error('Plugin author TypeScript config file resolves outside the physical package root');
  }

  const rootConfig = ts.readConfigFile(physicalConfigPath, ts.sys.readFile);
  if (rootConfig.error) {
    throw new Error(
      `Plugin author TypeScript config is invalid: ${formatConfigDiagnostics([rootConfig.error])}`,
    );
  }

  const unrecoverableDiagnostics: ts.Diagnostic[] = [];
  const parsed = ts.getParsedCommandLineOfConfigFile(physicalConfigPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic(diagnostic) {
      unrecoverableDiagnostics.push(diagnostic);
    },
  });
  const configErrors = [
    ...unrecoverableDiagnostics,
    ...(parsed?.errors ?? []),
  ].filter((diagnostic) => (
    diagnostic.category === ts.DiagnosticCategory.Error
    && diagnostic.code !== 18002
    && diagnostic.code !== 18003
  ));
  if (!parsed || configErrors.length > 0) {
    const detail = formatConfigDiagnostics(configErrors) || 'configuration could not be parsed';
    throw new Error(`Plugin author TypeScript config is invalid: ${detail}`);
  }

  const configSourceFile = (parsed.options as ts.CompilerOptions & Readonly<{
    configFile?: ts.TsConfigSourceFile;
  }>).configFile;
  const rootDeclaresExtends = typeof rootConfig.config?.extends === 'string'
    || Array.isArray(rootConfig.config?.extends);
  const extendedSourceFiles = configSourceFile?.extendedSourceFiles;
  if (rootDeclaresExtends && !extendedSourceFiles) {
    throw new Error('Plugin author TypeScript config extends chain could not be verified');
  }
  for (const extendedSourceFile of extendedSourceFiles ?? []) {
    const physicalExtendedSourceFile = await realpath(resolve(extendedSourceFile));
    if (!isCanonicalAbsolutePathInsideRoot(packageRoot, physicalExtendedSourceFile)) {
      throw new Error('Plugin author TypeScript config extends chain resolves outside the physical package root');
    }
  }

  if (parsed.options.baseUrl) {
    await assertConfigPathContained({
      packageRoot,
      label: 'baseUrl',
      targetPath: parsed.options.baseUrl,
    });
  }

  const pathsBasePath = parsed.options.baseUrl
    ?? (typeof parsed.options.pathsBasePath === 'string'
      ? parsed.options.pathsBasePath
      : dirname(physicalConfigPath));
  const aliases: Record<string, string> = {};
  const bundlerPaths: Record<string, string[]> = {};
  for (const [pattern, targets] of Object.entries(parsed.options.paths ?? {})) {
    if (targets.length !== 1) {
      throw new Error(
        `Plugin author TypeScript config paths['${pattern}'] must declare exactly one target`,
      );
    }
    const [target] = targets;
    const wildcardIndex = target.indexOf('*');
    const staticPrefix = wildcardIndex === -1 ? target : target.slice(0, wildcardIndex);
    if (wildcardIndex !== -1 && !staticPrefix.endsWith('/') && !staticPrefix.endsWith('\\')) {
      throw new Error(
        `Plugin author TypeScript config paths['${pattern}'] target '${target}' has an unsafe wildcard root that can resolve outside the physical package root`,
      );
    }
    if (!pattern.endsWith('/*')
      || pattern.indexOf('*') !== pattern.length - 1
      || !target.endsWith('/*')
      || target.indexOf('*') !== target.length - 1) {
      throw new Error(
        `Plugin author TypeScript config paths['${pattern}'] must use one terminal '/*' mapping supported by author evaluation`,
      );
    }
    const targetRootPath = resolve(pathsBasePath, staticPrefix || '.');
    await assertConfigPathContained({
      packageRoot,
      label: `paths['${pattern}'] target '${target}'`,
      targetPath: targetRootPath,
    });
    await assertAliasTreeContained({
      packageRoot,
      pattern,
      target,
      targetRootPath,
    });
    const absoluteTarget = resolve(pathsBasePath, target);
    aliases[pattern.slice(0, -1)] = absoluteTarget.slice(0, -1);
    bundlerPaths[pattern] = [absoluteTarget];
  }
  const bundlerTsconfigRaw: TsconfigRaw = Object.keys(bundlerPaths).length > 0
    ? { compilerOptions: { paths: bundlerPaths } }
    : {};
  return Object.freeze({
    tsconfigPath: physicalConfigPath,
    aliases: Object.freeze(aliases),
    bundlerTsconfigRaw: Object.freeze(bundlerTsconfigRaw),
    emitOutputRelativePath: resolveEmitOutputRelativePath({
      packageRoot,
      options: parsed.options,
    }),
  });
}
