#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import {
  chmod,
  cp,
  lstat,
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
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { assertNoMissingLocalImports } from './distLocalImports.mjs';
import {
  collectPackageBuildOutputTargets,
  isLocalPackageBuildOutputTarget,
  resolvePackageBuildOutputTargetMatches,
  resolvePackageBuildOutputTargetPath,
} from './packageBuildOutputTargets.mjs';
import { resolveYarnCommandInvocation } from './execYarnCommand.mjs';
import { resolveTypeScriptCliInvocation } from './resolveTypeScriptCliInvocation.mjs';
import { withWorkspaceBundleLock } from './workspaceBundleLock.mjs';
import { resolveWorkspacePackageBuildLockPath } from './workspacePackageBuildLock.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STAGED_OUTPUT_SCRIPT_FLAG = '--happier-staged-output-script';
const PERSISTENT_COMPILER_WORK_DIR_NAME = '.happier';
const PERSISTENT_COMPILER_WORK_SUBDIR = 'typescript-package-build';

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

function verifyStagedExportTargets({ packageDir, outputDir, packageJson }) {
  const missing = collectPackageBuildOutputTargets(packageJson)
    .filter(isLocalPackageBuildOutputTarget)
    .filter((target) => resolvePackageBuildOutputTargetMatches({
      packageDir,
      outputDir,
      target,
    }).length === 0)
    .map((target) => ({ target }));

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

  for (const target of entryTargets) {
    await assertNoMissingLocalImports({
      distDir: outputDir,
      entryPath: resolvePackageBuildOutputTargetPath({ packageDir, outputDir, target }),
      label: `${packageJson?.name ?? packageDir} staged dist build`,
    });
  }
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

function runStagedOutputScripts({
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
    const result = runCommandImpl(invocation.command, invocation.args, {
      cwd: packageDir,
      env,
      stdio,
      ...(invocation.windowsVerbatimArguments
        ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments }
        : {}),
    });
    if (result?.error) throw result.error;
    if ((result?.status ?? 0) !== 0) {
      throw new Error(
        `Staged package output script "${scriptName}" failed with code ${result?.status ?? 'unknown'}`,
      );
    }
  }
}

function runChecked(command, args, options, runCommandImpl) {
  const result = runCommandImpl(command, args, options);
  if (result?.error) throw result.error;
  if ((result?.status ?? 0) !== 0) {
    throw new Error(`TypeScript package build failed with code ${result?.status ?? 'unknown'}`);
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

function resolveCompilerProjectPath(args, packageDir) {
  const values = Array.isArray(args) ? args : [];
  for (let index = 0; index < values.length; index += 1) {
    const value = String(values[index] ?? '');
    if (value === '-p' || value === '--project') {
      const rawProjectPath = String(values[index + 1] ?? '').trim();
      if (rawProjectPath) return resolve(packageDir, rawProjectPath);
    }
    if (value.startsWith('--project=')) {
      const rawProjectPath = value.slice('--project='.length).trim();
      if (rawProjectPath) return resolve(packageDir, rawProjectPath);
    }
  }
  return join(packageDir, 'tsconfig.json');
}

function resolvePersistentCompilerWorkTree({ packageDir, compilerArgs, outputMode }) {
  const projectPath = resolveCompilerProjectPath(compilerArgs, packageDir);
  const cacheKey = createHash('sha256')
    .update(JSON.stringify({
      project: relative(packageDir, projectPath).replaceAll('\\', '/'),
      compilerArgs: compilerArgs.map((arg) => String(arg)),
      outputMode,
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

function compilerCacheNeedsReset({ packageDir, projectPath, compilerOutputDir, tsBuildInfoFile }) {
  if (!existsSync(tsBuildInfoFile)) {
    return existsSync(compilerOutputDir);
  }
  if (!existsSync(compilerOutputDir)) return true;

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

async function preparePersistentCompilerWorkTree(compilerWorkTree, { packageDir }) {
  if (compilerCacheNeedsReset({
    packageDir,
    projectPath: compilerWorkTree.projectPath,
    compilerOutputDir: compilerWorkTree.outputDir,
    tsBuildInfoFile: compilerWorkTree.tsBuildInfoFile,
  })) {
    await rm(compilerWorkTree.workDir, { recursive: true, force: true });
  }
  await mkdir(compilerWorkTree.outputDir, { recursive: true });
}

async function copyDirectoryContents(sourceDir, destinationDir) {
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    await cp(join(sourceDir, entry.name), join(destinationDir, entry.name), {
      recursive: entry.isDirectory(),
      force: true,
    });
  }
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

async function directoryTreesMatch(leftDir, rightDir) {
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
      if (!await directoryTreesMatch(leftPath, rightPath)) return false;
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
  runCommandImpl = spawnSync,
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
  const compilerWorkTree = resolvePersistentCompilerWorkTree({
    packageDir: resolvedPackageDir,
    compilerArgs: parsedArgs.compilerArgs,
    outputMode: explicitOutputDir ? 'staged' : 'promoted',
  });
  const commandEnv = { ...process.env, ...env };

  const runBuild = async (buildEnv) => {
    await rm(stagedDistDir, { recursive: true, force: true });
    await mkdir(stagedDistDir, { recursive: true });
    await rm(backupDir, { recursive: true, force: true });
    try {
      await preparePersistentCompilerWorkTree(compilerWorkTree, {
        packageDir: resolvedPackageDir,
      });
      const stagedBuildEnv = {
        ...buildEnv,
        HAPPIER_WORKSPACE_DIST_OUTPUT_DIR: stagedDistDir,
      };
      const compilerArgs = withOutputCompilerArgs(
        parsedArgs.compilerArgs,
        compilerWorkTree.outputDir,
        compilerWorkTree.tsBuildInfoFile,
      );
      const invocation = resolveTypeScriptCliInvocationImpl({
        repoRoot,
        workspaceDir: resolvedPackageDir,
        processExecPath: process.execPath,
      });
      try {
        runChecked(
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

      runStagedOutputScripts({
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
      await rm(backupDir, { recursive: true, force: true }).catch(() => {});
    }
  };

  if (explicitOutputDir) {
    return await runBuild(commandEnv);
  }

  const lockPath = resolveWorkspacePackageBuildLockPath(resolvedPackageDir, packageJson);
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
  await buildTypeScriptPackageDist();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exit(1);
  });
}
