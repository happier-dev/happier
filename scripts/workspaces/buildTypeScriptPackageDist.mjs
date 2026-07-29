#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { assertNoMissingLocalImports } from './distLocalImports.mjs';
import { resolveTypeScriptCliInvocation } from './resolveTypeScriptCliInvocation.mjs';
import { withWorkspaceBundleLock } from './workspaceBundleLock.mjs';
import { resolveWorkspacePackageBuildLockPath } from './workspacePackageBuildLock.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function rand() {
  return Math.random().toString(16).slice(2);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function collectTargetStrings(value, acc) {
  if (typeof value === 'string') {
    acc.push(value);
    return;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return;
  }
  for (const nested of Object.values(value)) {
    collectTargetStrings(nested, acc);
  }
}

function collectExpectedPackageTargets(packageJson) {
  const targets = [];
  for (const key of ['main', 'module', 'types']) {
    const value = packageJson?.[key];
    if (typeof value === 'string' && value.trim()) {
      targets.push(value.trim());
    }
  }
  collectTargetStrings(packageJson?.exports ?? {}, targets);
  return [...new Set(targets.map((target) => String(target).trim()).filter(Boolean))];
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
    const path = resolveTargetPath({ packageDir, outputDir, target });
    try {
      const info = await stat(path);
      await chmod(path, info.mode | 0o111);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function resolveTargetPath({ packageDir, outputDir, target }) {
  const normalized = String(target ?? '').replace(/^\.\//, '');
  if (normalized === 'dist') {
    return outputDir;
  }
  if (normalized.startsWith('dist/')) {
    return join(outputDir, normalized.slice('dist/'.length));
  }
  return resolve(packageDir, normalized);
}

function verifyStagedExportTargets({ packageDir, outputDir, packageJson }) {
  const missing = collectExpectedPackageTargets(packageJson)
    .filter((target) => target.startsWith('./') || target.startsWith('dist/'))
    .map((target) => ({
      target,
      path: resolveTargetPath({ packageDir, outputDir, target }),
    }))
    .filter(({ path }) => !existsSync(path));

  if (missing.length === 0) return;

  throw new Error(
    `Staged TypeScript package build is missing declared package export files:\n` +
      missing.map(({ target }) => `- ${target}`).join('\n'),
  );
}

async function verifyStagedRuntimeImportClosure({ packageDir, outputDir, packageJson }) {
  const entryTargets = collectExpectedPackageTargets(packageJson)
    .filter((target) => target.startsWith('./') || target.startsWith('dist/'))
    .filter((target) => /\.(?:mjs|cjs|js)$/.test(target));

  for (const target of entryTargets) {
    await assertNoMissingLocalImports({
      distDir: outputDir,
      entryPath: resolveTargetPath({ packageDir, outputDir, target }),
      label: `${packageJson?.name ?? packageDir} staged dist build`,
    });
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

export async function buildTypeScriptPackageDist({
  packageDir = process.cwd(),
  args = process.argv.slice(2),
  outputDir = process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR,
  env = process.env,
  stdio = 'inherit',
  runCommandImpl = spawnSync,
  resolveTypeScriptCliInvocationImpl = resolveTypeScriptCliInvocation,
  withWorkspaceBundleLockImpl = withWorkspaceBundleLock,
} = {}) {
  const resolvedPackageDir = resolve(packageDir);
  const packageJson = readJson(join(resolvedPackageDir, 'package.json'));
  const explicitOutputDir = typeof outputDir === 'string' && outputDir.trim();
  const distDir = join(resolvedPackageDir, 'dist');
  const buildId = `${Date.now()}.${process.pid}.${rand()}`;
  const stagedDistDir = resolve(explicitOutputDir || join(resolvedPackageDir, `.dist.build.${buildId}`));
  const backupDir = join(resolvedPackageDir, `.dist.backup.${buildId}`);
  const tsBuildInfoFile = join(resolvedPackageDir, `.tsbuildinfo.build.${buildId}`);
  const commandEnv = { ...process.env, ...env };

  const runBuild = async (buildEnv) => {
    await rm(stagedDistDir, { recursive: true, force: true });
    await mkdir(stagedDistDir, { recursive: true });
    await rm(backupDir, { recursive: true, force: true });
    try {
      const compilerArgs = withOutputCompilerArgs(Array.isArray(args) ? args : [], stagedDistDir, tsBuildInfoFile);
      const invocation = resolveTypeScriptCliInvocationImpl({
        repoRoot,
        workspaceDir: resolvedPackageDir,
        processExecPath: process.execPath,
      });
      runChecked(
        invocation.command,
        [...(invocation.argsPrefix ?? []), ...compilerArgs],
        {
          cwd: resolvedPackageDir,
          env: buildEnv,
          stdio,
          ...(invocation.windowsVerbatimArguments
            ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments }
            : {}),
        },
        runCommandImpl,
      );

      verifyStagedExportTargets({ packageDir: resolvedPackageDir, outputDir: stagedDistDir, packageJson });
      await verifyStagedRuntimeImportClosure({ packageDir: resolvedPackageDir, outputDir: stagedDistDir, packageJson });

      if (explicitOutputDir) {
        await markBinTargetsExecutable({ packageDir: resolvedPackageDir, outputDir: stagedDistDir, packageJson });
        return { outputDir: stagedDistDir, promoted: false };
      }

      await replaceDistWithStagedBuild({ distDir, stagedDistDir, backupDir });
      await markBinTargetsExecutable({ packageDir: resolvedPackageDir, outputDir: distDir, packageJson });
      return { outputDir: distDir, promoted: true };
    } finally {
      await rm(tsBuildInfoFile, { force: true }).catch(() => {});
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
