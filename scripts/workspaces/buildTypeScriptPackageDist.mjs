#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import {
  chmod,
  cp,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { exitWithCommandResult, runCommand } from '../../apps/stack/scripts/utils/proc/proc.mjs';
import { resolveRemoteCommandPolicy } from '../../apps/stack/scripts/utils/dev_targets/remote_commands.mjs';

import { assertNoMissingLocalImports } from './distLocalImports.mjs';
import { copyDirectoryContents } from './copyDirectoryContents.mjs';
import {
  WORKSPACE_PACKAGE_BUILD_INPUT_RECORD,
  collectPackageBuildOutputTargets,
  isLocalPackageBuildOutputTarget,
  resolvePackageBuildOutputTargetMatches,
  resolvePackageBuildOutputTargetPath,
} from './packageBuildOutputTargets.mjs';
import { resolveYarnCommandInvocation } from './execYarnCommand.mjs';
import { resolveTypeScriptCliInvocation } from './resolveTypeScriptCliInvocation.mjs';
import { resolveTypeScriptProjectPathFromArgs } from './prepareTypeScriptProjectBuild.mjs';
import { resolveWorkspaceBuildMode, resolveWorkspaceTypeScriptCompilerArgs, WORKSPACE_DIST_CHECK_ONLY_ENV } from './workspaceChildBuildEnv.mjs';
import { withWorkspaceBundleLock } from './workspaceBundleLock.mjs';
import { resolveWorkspacePackageBuildLockPath } from './workspacePackageBuildLock.mjs';
import {
  createWorkspaceLockLeaseValue,
  parseWorkspaceLockLeaseValue,
} from '../../packages/cli-common/workspaceLockLease.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STAGED_OUTPUT_SCRIPT_FLAG = '--happier-staged-output-script';
const DIST_BUILD_ADMISSION_ENTERED_ENV = 'HAPPIER_WORKSPACE_DIST_BUILD_ADMISSION_ENTERED';
const PERSISTENT_COMPILER_WORK_DIR_NAME = '.happier';
const PERSISTENT_COMPILER_WORK_SUBDIR = 'typescript-package-build';
const DIST_TEST_EXCLUDES = ['test', 'spec', 'testSupport', 'test-d']
  .flatMap((kind) => [`**/*.${kind}.ts`, `**/*.${kind}.tsx`]);
const DIST_TEST_SOURCE_PATTERN = /\.(?:test|spec|testSupport|test-d)\.tsx?$/u;

function rand() {
  return Math.random().toString(16).slice(2);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function collectBinTargets(packageJson) {
  const bin = packageJson?.bin;
  const targets = [];
  if (typeof bin === 'string' && bin.trim()) {
    targets.push(bin.trim());
  } else if (bin && typeof bin === 'object') {
    for (const value of Object.values(bin)) {
      if (typeof value === 'string' && value.trim()) {
        targets.push(value.trim());
      }
    }
  }
  return [...new Set(targets)];
}

// tsc writes emitted files as 0644, stripping the executable bit from `bin`
// entry points (the shebang is preserved, the +x is not). npm restores it when
// installing a published/packed package, but a `file:` dependency links
// straight at this dist tree, so an un-chmod'd bin fails with "Permission
// denied" for local-development consumers (e.g. scaffolded plugins running
// `happier-plugin-build-ui`). Mark declared bin targets executable so both the
// packed and the file: install paths agree.
async function markBinTargetsExecutable({ packageDir, outputDir, packageJson }) {
  for (const target of collectBinTargets(packageJson)) {
    const path = resolvePackageBuildOutputTargetPath({ packageDir, outputDir, target });
    try {
      const info = await stat(path);
      await chmod(path, info.mode | 0o111);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function collectMissingStagedExportTargets({ packageDir, outputDir, packageJson }) {
  return collectPackageBuildOutputTargets(packageJson)
    .filter(isLocalPackageBuildOutputTarget)
    .filter((target) => resolvePackageBuildOutputTargetMatches({
      packageDir,
      outputDir,
      target,
    }).length === 0)
    .map((target) => ({ target }));
}

function verifyStagedExportTargets({ packageDir, outputDir, packageJson }) {
  const missing = collectMissingStagedExportTargets({ packageDir, outputDir, packageJson });

  if (missing.length === 0) return;

  throw new Error(
    `Staged TypeScript package build is missing declared package export files:\n` +
      missing.map(({ target }) => `- ${target}`).join('\n'),
  );
}

async function verifyStagedRuntimeImportClosure({ packageDir, outputDir, packageJson }) {
  const entryTargets = collectPackageBuildOutputTargets(packageJson)
    .filter(isLocalPackageBuildOutputTarget)
    .filter((target) => !target.includes('*'))
    .filter((target) => /\.(?:mjs|cjs|js)$/.test(target));

  await assertNoMissingLocalImports({
    distDir: outputDir,
    entryPaths: entryTargets.map(target => resolvePackageBuildOutputTargetPath({ packageDir, outputDir, target })),
    label: `${packageJson?.name ?? packageDir} staged dist build`,
  });
}

function parseBuildArgs(args) {
  const compilerArgs = [];
  const stagedOutputScripts = [];
  const values = Array.isArray(args) ? args : [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value !== STAGED_OUTPUT_SCRIPT_FLAG) {
      compilerArgs.push(value);
      continue;
    }

    const scriptName = String(values[index + 1] ?? '').trim();
    if (!scriptName) {
      throw new Error(`${STAGED_OUTPUT_SCRIPT_FLAG} requires a package script name`);
    }
    stagedOutputScripts.push(scriptName);
    index += 1;
  }
  return { compilerArgs, stagedOutputScripts: [...new Set(stagedOutputScripts)] };
}

function validateStagedOutputScripts({ packageJson, stagedOutputScripts }) {
  const scripts = packageJson?.scripts;
  for (const scriptName of stagedOutputScripts) {
    if (scriptName === 'build') {
      throw new Error(`${STAGED_OUTPUT_SCRIPT_FLAG} cannot invoke the package build script recursively`);
    }
    if (typeof scripts?.[scriptName] !== 'string' || !scripts[scriptName].trim()) {
      throw new Error(
        `${STAGED_OUTPUT_SCRIPT_FLAG} references missing package script "${scriptName}"`,
      );
    }
  }
}

async function runStagedOutputScripts({
  packageDir,
  stagedOutputScripts,
  env,
  stdio,
  runCommandImpl,
  resolveYarnCommandInvocationImpl,
}) {
  for (const scriptName of stagedOutputScripts) {
    const invocation = resolveYarnCommandInvocationImpl(['-s', scriptName], {
      npmExecPath: env.npm_execpath,
    });
    const result = await runCommandImpl(invocation.command, invocation.args, {
      ownedProcessGroup: true,
      cwd: packageDir,
      env,
      stdio,
      ...(invocation.windowsVerbatimArguments
        ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments }
        : {}),
    });
    if (result?.error) throw result.error;
    if (result?.signal || (result?.status ?? 0) !== 0) {
      const error = new Error(
        `Staged package output script "${scriptName}" failed with code ${result?.status ?? 'unknown'}`,
      );
      error.exitCode = result?.status;
      error.signal = result?.signal;
      throw error;
    }
  }
}

async function runChecked(command, args, options, runCommandImpl) {
  const result = await runCommandImpl(command, args, { ...options, ownedProcessGroup: true });
  if (result?.error) throw result.error;
  if (result?.signal || (result?.status ?? 0) !== 0) {
    const error = new Error(`TypeScript package build failed with code ${result?.status ?? 'unknown'}`);
    error.exitCode = result?.status;
    error.signal = result?.signal;
    throw error;
  }
}

async function replaceDistWithStagedBuild({ distDir, stagedDistDir, backupDir }) {
  let hadExisting = false;
  await rm(backupDir, { recursive: true, force: true });
  try {
    await rename(distDir, backupDir);
    hadExisting = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  try {
    await rename(stagedDistDir, distDir);
  } catch (error) {
    if (hadExisting) {
      await rename(backupDir, distDir).catch((restoreError) => {
        if (error && typeof error === 'object') {
          error.restoreError = restoreError;
        }
      });
    }
    throw error;
  }

  if (hadExisting) {
    await rm(backupDir, { recursive: true, force: true }).catch(() => {});
  }
}

function withOutputCompilerArgs(args, outputDir, tsBuildInfoFile) {
  return [
    ...args,
    '--outDir',
    outputDir,
    '--tsBuildInfoFile',
    tsBuildInfoFile,
  ];
}

export async function withDistProjectCompilerArgs(args, compilerWorkTree) {
  const { projectPath, workDir, compilerOptions = {} } = compilerWorkTree;
  const projectDir = dirname(projectPath);
  // The retained TypeScript API owns config parsing and effective type roots.
  // Compilation and option validation use resolveTypeScriptCliInvocation.
  const config = ts.getParsedCommandLineOfConfigFile(projectPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic(diagnostic) {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    },
  });
  const exclude = config.raw.exclude ?? [
    'node_modules', 'bower_components', 'jspm_packages',
    ...(config.options.outDir ? [config.options.outDir] : []),
  ];
  const distConfig = {
    extends: projectPath,
    // An isolated compiler tree lives outside the package. Default @types
    // lookup follows the top-level config, so anchor it to the original project.
    // Explicit roots retain the path base of the config that defines them.
    compilerOptions: {
      ...(!config.options.typeRoots ? {
        typeRoots: ts.getEffectiveTypeRoots(config.options, {
          getCurrentDirectory: () => projectDir,
        }),
      } : {}),
      ...compilerOptions,
      ...(compilerOptions.paths ? {
        paths: {
          ...Object.fromEntries(Object.entries(config.options.paths ?? {}).map(([key, targets]) => [key,
            targets.map(target => resolve(config.options.baseUrl ?? config.options.pathsBasePath ?? projectDir, target))])),
          ...compilerOptions.paths,
        },
      } : {}),
    },
    exclude: [...exclude, ...DIST_TEST_EXCLUDES].map((path) => resolve(projectDir, path)),
    // Explicit roots are not affected by exclude; preserve production roots
    // while removing test roots even when a package uses a files list.
    ...(Array.isArray(config.raw.files) ? {
      files: config.raw.files
        .filter((path) => !DIST_TEST_SOURCE_PATTERN.test(path))
        .map((path) => resolve(projectDir, path)),
    } : {}),
  };
  const distProjectPath = join(workDir, 'tsconfig.dist.json');
  const contents = `${JSON.stringify(distConfig, null, 2)}\n`;
  if (!existsSync(distProjectPath) || readFileSync(distProjectPath, 'utf8') !== contents) {
    await writeFile(distProjectPath, contents);
  }
  const compilerArgs = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '-p' || value === '--project') {
      index += 1;
    } else if (!value.startsWith('--project=')) {
      compilerArgs.push(value);
    }
  }
  // Declaration inference still constructs checkers under --noCheck. Keep
  // every dist emitter (including source author closures) within one checker
  // unless the caller sizes it explicitly; Protocol replicas dominate RSS.
  return [...compilerArgs,
    ...(compilerArgs.includes('--singleThreaded') ? [] : ['--singleThreaded']),
    '--project', distProjectPath];
}

function resolvePersistentCompilerWorkTree({ packageDir, compilerArgs, outputMode }) {
  const projectPath = resolveTypeScriptProjectPathFromArgs(compilerArgs, { cwd: packageDir })
    || join(packageDir, 'tsconfig.json');
  const cacheKey = createHash('sha256')
    .update(JSON.stringify({
      project: relative(packageDir, projectPath).replaceAll('\\', '/'),
      compilerArgs: compilerArgs.map((arg) => String(arg)),
      outputMode,
      exclude: DIST_TEST_EXCLUDES,
    }))
    .digest('hex')
    .slice(0, 20);
  const workDir = join(
    packageDir,
    PERSISTENT_COMPILER_WORK_DIR_NAME,
    PERSISTENT_COMPILER_WORK_SUBDIR,
    cacheKey,
  );
  return {
    workDir,
    outputDir: join(workDir, 'dist'),
    tsBuildInfoFile: join(workDir, '.tsbuildinfo'),
    projectPath,
  };
}

function workspaceLockLeaseTargetsPath(lockPath, leaseValue) {
  const lease = parseWorkspaceLockLeaseValue(leaseValue);
  if (!lease) return false;
  const normalizedLockPath = parseWorkspaceLockLeaseValue(createWorkspaceLockLeaseValue({
    lockPath,
    ownerToken: 'path-comparison',
  }))?.path;
  return lease.path === normalizedLockPath;
}

async function createIsolatedCompilerWorkTree(compilerWorkTree) {
  // A staged build that does not hold this package's lock owns an ephemeral
  // compiler cache. Keep it outside the package tree: Metro watches workspace
  // package roots in stack runs and can otherwise retain a watcher while this
  // build's mandatory cleanup removes the isolated directory.
  const workDir = await mkdtemp(join(tmpdir(), 'happier-typescript-package-build-'));
  return {
    ...compilerWorkTree,
    workDir,
    outputDir: join(workDir, 'dist'),
    tsBuildInfoFile: join(workDir, '.tsbuildinfo'),
  };
}

function isDescendantPath(parentPath, candidatePath) {
  const relation = relative(parentPath, candidatePath);
  return relation === '' || (
    relation !== '..'
    && !relation.startsWith(`..${sep}`)
    && !isAbsolute(relation)
  );
}

function isTypeScriptSourcePath(path) {
  return /\.(?:cts|mts|tsx?|json)$/u.test(path);
}

function compilerCacheNeedsReset({
  packageDir,
  packageJson,
  projectPath,
  compilerOutputDir,
  tsBuildInfoFile,
}) {
  if (!existsSync(tsBuildInfoFile)) {
    return existsSync(compilerOutputDir);
  }
  if (!existsSync(compilerOutputDir)) return true;
  // Concrete declared targets must be present for a build-info cache to be
  // reusable. Wildcards can be owned by a later staged producer (for example,
  // plugin UI artifacts), so their final completeness remains the verifier's
  // responsibility after all producers have run.
  if (collectMissingStagedExportTargets({
    packageDir,
    outputDir: compilerOutputDir,
    packageJson,
  }).some(({ target }) => !target.includes('*'))) {
    return true;
  }

  try {
    const projectStat = statSync(projectPath, { bigint: true });
    const cacheStat = statSync(tsBuildInfoFile, { bigint: true });
    const projectChangedAt = projectStat.ctimeNs > projectStat.mtimeNs
      ? projectStat.ctimeNs
      : projectStat.mtimeNs;
    const cacheChangedAt = cacheStat.ctimeNs > cacheStat.mtimeNs
      ? cacheStat.ctimeNs
      : cacheStat.mtimeNs;
    if (projectChangedAt > cacheChangedAt) return true;
  } catch {
    return true;
  }

  let buildInfo;
  try {
    buildInfo = JSON.parse(readFileSync(tsBuildInfoFile, 'utf8'));
  } catch {
    return true;
  }
  if (!Array.isArray(buildInfo?.fileNames)) return true;

  const sourcePathBases = [
    dirname(tsBuildInfoFile),
    dirname(projectPath),
    packageDir,
  ];
  for (const fileName of buildInfo.fileNames) {
    if (typeof fileName !== 'string' || !isTypeScriptSourcePath(fileName)) continue;
    const localCandidates = [...new Set(sourcePathBases
      .map((basePath) => resolve(basePath, fileName))
      .filter((candidatePath) => isDescendantPath(packageDir, candidatePath)))];
    if (localCandidates.length > 0 && localCandidates.every((candidatePath) => !existsSync(candidatePath))) {
      return true;
    }
  }
  return false;
}

async function preparePersistentCompilerWorkTree(compilerWorkTree, { packageDir, packageJson }) {
  if (compilerCacheNeedsReset({
    packageDir,
    packageJson,
    projectPath: compilerWorkTree.projectPath,
    compilerOutputDir: compilerWorkTree.outputDir,
    tsBuildInfoFile: compilerWorkTree.tsBuildInfoFile,
  })) {
    await rm(compilerWorkTree.workDir, { recursive: true, force: true });
  }
  await mkdir(compilerWorkTree.outputDir, { recursive: true });
}

async function rewritePromotedTypeScriptSourceMap({
  compilerMapPath,
  promotedMapPath,
  finalMapPath,
  packageDir,
  packageRealPath,
}) {
  let sourceMap;
  try {
    sourceMap = JSON.parse(await readFile(promotedMapPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `TypeScript emitted an invalid source map at ${relative(packageDir, compilerMapPath)}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!sourceMap || typeof sourceMap !== 'object' || Array.isArray(sourceMap)) {
    throw new Error(
      `TypeScript emitted a non-object source map at ${relative(packageDir, compilerMapPath)}`,
    );
  }
  if (!Array.isArray(sourceMap.sources)) return;

  const sourceRoot = typeof sourceMap.sourceRoot === 'string' ? sourceMap.sourceRoot : '';
  const sources = [];
  const sourcesContent = [];
  for (const source of sourceMap.sources) {
    if (typeof source !== 'string') {
      throw new Error(
        `TypeScript emitted a non-string source-map source at ${relative(packageDir, compilerMapPath)}`,
      );
    }
    const sourcePath = resolve(dirname(compilerMapPath), sourceRoot, source);
    let sourceRealPath;
    try {
      sourceRealPath = await realpath(sourcePath);
    } catch (error) {
      throw new Error(
        `TypeScript source map references an unreadable source at ${relative(packageDir, compilerMapPath)}: ${source}`,
        { cause: error },
      );
    }
    if (!isDescendantPath(packageRealPath, sourceRealPath)) {
      throw new Error(
        `TypeScript emitted a source map that escapes its package at ${relative(packageDir, compilerMapPath)}: ${source}`,
      );
    }

    let sourceContents;
    try {
      sourceContents = await readFile(sourceRealPath, 'utf8');
    } catch (error) {
      throw new Error(
        `TypeScript source map references an unreadable source at ${relative(packageDir, compilerMapPath)}: ${source}`,
        { cause: error },
      );
    }
    const packageRelativeSourcePath = relative(packageRealPath, sourceRealPath);
    const logicalSourcePath = join(packageDir, packageRelativeSourcePath);
    sources.push(relative(dirname(finalMapPath), logicalSourcePath).replaceAll('\\', '/'));
    sourcesContent.push(sourceContents);
  }

  sourceMap.sources = sources;
  sourceMap.sourcesContent = sourcesContent;
  delete sourceMap.sourceRoot;
  await writeFile(promotedMapPath, JSON.stringify(sourceMap), 'utf8');
}

async function rewritePromotedTypeScriptSourceMaps({
  compilerOutputDir,
  promotedOutputDir,
  finalOutputDir,
  packageDir,
  packageRealPath = null,
  relativeDir = '',
}) {
  const resolvedPackageRealPath = packageRealPath ?? await realpath(packageDir);
  const compilerDir = join(compilerOutputDir, relativeDir);
  for (const entry of await readdir(compilerDir, { withFileTypes: true })) {
    const relativePath = join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      await rewritePromotedTypeScriptSourceMaps({
        compilerOutputDir,
        promotedOutputDir,
        finalOutputDir,
        packageDir,
        packageRealPath: resolvedPackageRealPath,
        relativeDir: relativePath,
      });
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.map')) continue;

    await rewritePromotedTypeScriptSourceMap({
      compilerMapPath: join(compilerOutputDir, relativePath),
      promotedMapPath: join(promotedOutputDir, relativePath),
      finalMapPath: join(finalOutputDir, relativePath),
      packageDir,
      packageRealPath: resolvedPackageRealPath,
    });
  }
}

async function directoryTreesMatch(leftDir, rightDir, atDistRoot = true) {
  let leftEntries;
  let rightEntries;
  try {
    [leftEntries, rightEntries] = await Promise.all([
      readdir(leftDir, { withFileTypes: true }),
      readdir(rightDir, { withFileTypes: true }),
    ]);
  } catch {
    return false;
  }

  if (atDistRoot) {
    // The package admission owner, not the compiler, writes this receipt.
    // Identical emitted bytes must retain it; its owner still checks source
    // and dependency currentness. Any changed emitted tree replaces dist and
    // drops the old receipt as before. Nested files remain ordinary output.
    const isCompilerOutput = (entry) => entry.name !== WORKSPACE_PACKAGE_BUILD_INPUT_RECORD || !entry.isFile();
    leftEntries = leftEntries.filter(isCompilerOutput);
    rightEntries = rightEntries.filter(isCompilerOutput);
  }

  leftEntries.sort((left, right) => left.name.localeCompare(right.name));
  rightEntries.sort((left, right) => left.name.localeCompare(right.name));
  if (leftEntries.length !== rightEntries.length) return false;

  for (let index = 0; index < leftEntries.length; index += 1) {
    const leftEntry = leftEntries[index];
    const rightEntry = rightEntries[index];
    if (leftEntry.name !== rightEntry.name) return false;

    const leftPath = join(leftDir, leftEntry.name);
    const rightPath = join(rightDir, rightEntry.name);
    const [leftInfo, rightInfo] = await Promise.all([lstat(leftPath), lstat(rightPath)]);
    if ((leftInfo.mode & 0o777) !== (rightInfo.mode & 0o777)) return false;

    if (leftInfo.isDirectory() && rightInfo.isDirectory()) {
      if (!await directoryTreesMatch(leftPath, rightPath, false)) return false;
      continue;
    }
    if (leftInfo.isFile() && rightInfo.isFile()) {
      if (leftInfo.size !== rightInfo.size) return false;
      const [leftContents, rightContents] = await Promise.all([readFile(leftPath), readFile(rightPath)]);
      if (!leftContents.equals(rightContents)) return false;
      continue;
    }
    if (leftInfo.isSymbolicLink() && rightInfo.isSymbolicLink()) {
      const [leftTarget, rightTarget] = await Promise.all([readlink(leftPath), readlink(rightPath)]);
      if (leftTarget !== rightTarget) return false;
      continue;
    }
    return false;
  }

  return true;
}

export async function buildTypeScriptPackageDist({
  packageDir = process.cwd(),
  args = process.argv.slice(2),
  outputDir = process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR,
  env = process.env,
  stdio = 'inherit',
  runCommandImpl = runCommand,
  resolveTypeScriptCliInvocationImpl = resolveTypeScriptCliInvocation,
  resolveYarnCommandInvocationImpl = resolveYarnCommandInvocation,
  withWorkspaceBundleLockImpl = withWorkspaceBundleLock,
} = {}) {
  const resolvedPackageDir = resolve(packageDir);
  const packageJson = readJson(join(resolvedPackageDir, 'package.json'));
  const parsedArgs = parseBuildArgs(args);
  validateStagedOutputScripts({
    packageJson,
    stagedOutputScripts: parsedArgs.stagedOutputScripts,
  });
  const explicitOutputDir = typeof outputDir === 'string' && outputDir.trim();
  const distDir = join(resolvedPackageDir, 'dist');
  const buildId = `${Date.now()}.${process.pid}.${rand()}`;
  const stagedDistDir = resolve(explicitOutputDir || join(resolvedPackageDir, `.dist.build.${buildId}`));
  const backupDir = join(resolvedPackageDir, `.dist.backup.${buildId}`);
  const commandEnv = { ...process.env, ...env };
  const buildMode = resolveWorkspaceBuildMode({ env: commandEnv });
  // Only the package admission owner requests this after proving the existing
  // emitted tree's current input, dependency and complete output digests.
  const checkOnly = commandEnv[WORKSPACE_DIST_CHECK_ONLY_ENV] === '1';
  if (checkOnly && (buildMode !== 'strict' || !explicitOutputDir)) {
    throw new Error('Checking existing package output requires strict staged package admission');
  }
  // Source runtimes consume emitted JS and declarations. Their dependency
  // refresh must not repeat the full checker owned by strict/package builds.
  // Include these options in the existing cache identity so checked and
  // emit-only compilations never share incremental state.
  const effectiveCompilerArgs = resolveWorkspaceTypeScriptCompilerArgs({
    compilerArgs: parsedArgs.compilerArgs, env: commandEnv, checkOnly,
  });
  const persistentCompilerWorkTree = resolvePersistentCompilerWorkTree({
    packageDir: resolvedPackageDir,
    compilerArgs: effectiveCompilerArgs,
    outputMode: explicitOutputDir ? 'staged' : 'promoted',
  });
  const lockPath = resolveWorkspacePackageBuildLockPath(resolvedPackageDir, packageJson);
  const stagedBuildTargetsPackageLock = explicitOutputDir && workspaceLockLeaseTargetsPath(
    lockPath,
    commandEnv.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD,
  );
  // Canonical outer publishers authenticate reentry into this package lock and
  // may safely reuse its incremental compiler tree. A standalone staged build
  // has no owner serializing that mutable tree, so keep its compiler state
  // private to the build instead of racing another staged publisher.
  const isolateCompilerState = explicitOutputDir && !stagedBuildTargetsPackageLock;
  const compilerWorkTree = isolateCompilerState
    ? await createIsolatedCompilerWorkTree(persistentCompilerWorkTree)
    : persistentCompilerWorkTree;

  const runBuild = async (buildEnv) => {
    if (!checkOnly) await rm(stagedDistDir, { recursive: true, force: true });
    await mkdir(stagedDistDir, { recursive: true });
    await rm(backupDir, { recursive: true, force: true });
    try {
      if (checkOnly) await mkdir(compilerWorkTree.workDir, { recursive: true });
      else await preparePersistentCompilerWorkTree(compilerWorkTree, {
        packageDir: resolvedPackageDir, packageJson,
      });
      const stagedBuildEnv = {
        ...buildEnv,
        HAPPIER_WORKSPACE_DIST_OUTPUT_DIR: stagedDistDir,
      };
      const compilerArgs = withOutputCompilerArgs(
        await withDistProjectCompilerArgs(effectiveCompilerArgs, compilerWorkTree),
        compilerWorkTree.outputDir,
        compilerWorkTree.tsBuildInfoFile,
      );
      const invocation = resolveTypeScriptCliInvocationImpl({
        repoRoot,
        workspaceDir: resolvedPackageDir,
        processExecPath: process.execPath,
        env: stagedBuildEnv,
        admissionClass: resolveRemoteCommandPolicy(
          [process.execPath, fileURLToPath(import.meta.url), ...effectiveCompilerArgs],
          { cwd: relative(repoRoot, resolvedPackageDir).replaceAll('\\', '/') },
        ).heavyClass,
      });
      try {
        await runChecked(
          invocation.command,
          [...(invocation.argsPrefix ?? []), ...compilerArgs],
          {
            cwd: resolvedPackageDir,
            env: stagedBuildEnv,
            stdio,
            ...(invocation.windowsVerbatimArguments
              ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments }
              : {}),
          },
          runCommandImpl,
        );
      } catch (error) {
        // A failed compiler can leave a syntactically valid but incomplete
        // incremental tree. It is ignored state, so discard it without ever
        // touching the published last-green dist.
        await rm(compilerWorkTree.workDir, { recursive: true, force: true });
        throw error;
      }

      if (checkOnly) return { outputDir: stagedDistDir, promoted: false, checked: true };

      await copyDirectoryContents(compilerWorkTree.outputDir, stagedDistDir);
      // HAPPIER_WORKSPACE_DIST_OUTPUT_DIR is an outer publisher's temporary
      // destination. Its tree is renamed into `dist`, so source-map paths must
      // describe that final package location rather than this transient stage.
      // Published packages intentionally ship dist without authored sources;
      // retain the exact source text so packed consumers can still debug maps.
      await rewritePromotedTypeScriptSourceMaps({
        compilerOutputDir: compilerWorkTree.outputDir,
        promotedOutputDir: stagedDistDir,
        finalOutputDir: distDir,
        packageDir: resolvedPackageDir,
      });

      await runStagedOutputScripts({
        packageDir: resolvedPackageDir,
        stagedOutputScripts: parsedArgs.stagedOutputScripts,
        env: stagedBuildEnv,
        stdio,
        runCommandImpl,
        resolveYarnCommandInvocationImpl,
      });

      verifyStagedExportTargets({ packageDir: resolvedPackageDir, outputDir: stagedDistDir, packageJson });
      await verifyStagedRuntimeImportClosure({ packageDir: resolvedPackageDir, outputDir: stagedDistDir, packageJson });
      await markBinTargetsExecutable({ packageDir: resolvedPackageDir, outputDir: stagedDistDir, packageJson });

      if (explicitOutputDir) {
        return { outputDir: stagedDistDir, promoted: false };
      }

      if (await directoryTreesMatch(stagedDistDir, distDir)) {
        return { outputDir: distDir, promoted: false };
      }

      await replaceDistWithStagedBuild({ distDir, stagedDistDir, backupDir });
      return { outputDir: distDir, promoted: true };
    } finally {
      if (!explicitOutputDir) {
        await rm(stagedDistDir, { recursive: true, force: true }).catch(() => {});
      }
      if (isolateCompilerState) {
        await rm(compilerWorkTree.workDir, { recursive: true, force: true }).catch(() => {});
      }
      await rm(backupDir, { recursive: true, force: true }).catch(() => {});
    }
  };

  if (explicitOutputDir) {
    if (!stagedBuildTargetsPackageLock) return await runBuild(commandEnv);
    return await withWorkspaceBundleLockImpl(
      ({ heldLockValue }) => runBuild({
        ...commandEnv,
        HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue,
      }),
      {
        lockPath,
        heldLockValue: commandEnv.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD,
        errorLabel: `${packageJson?.name ?? resolvedPackageDir} workspace dist build lock`,
      },
    );
  }

  return await withWorkspaceBundleLockImpl(
    ({ heldLockValue }) => runBuild({
      ...commandEnv,
      HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue,
    }),
    {
      lockPath,
      heldLockValue: commandEnv.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD,
      errorLabel: `${packageJson?.name ?? resolvedPackageDir} workspace dist build lock`,
    },
  );
}

export async function main() {
  const env = process.env;
  const requiresAdmission = process.platform === 'linux'
    && (!env.CI || env.HAPPIER_DEV_TARGET_EXECUTION === '1'
      || Boolean(env.HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN));
  if (requiresAdmission && env[DIST_BUILD_ADMISSION_ENTERED_ENV] !== '1') {
    const args = process.argv.slice(2);
    const admissionClass = resolveRemoteCommandPolicy(
      [process.execPath, fileURLToPath(import.meta.url), ...args],
      { cwd: relative(repoRoot, process.cwd()).replaceAll('\\', '/') || '.' },
    ).heavyClass;
    const result = await runCommand(
      resolve(repoRoot, 'apps/stack/bin/hstack-exec'),
      [
        '--heavyweight-admission',
        `--class=${admissionClass}`,
        `--machine=${env.HAPPIER_DEV_TARGET_EXECUTION === '1' ? 'worker' : 'local'}`,
        '--',
        process.execPath,
        fileURLToPath(import.meta.url),
        ...args,
      ],
      {
        cwd: process.cwd(),
        env: { ...env, [DIST_BUILD_ADMISSION_ENTERED_ENV]: '1' },
        stdio: 'inherit',
        ownedProcessGroup: true,
      },
    );
    exitWithCommandResult(result);
    return;
  }
  await buildTypeScriptPackageDist();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error?.stack || error);
    exitWithCommandResult({ status: error?.exitCode ?? 1, signal: error?.signal });
  });
}
