import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve } from 'node:path';

import { coerceHappyMonorepoRootFromPath } from '../paths/paths.mjs';
import { collectWorkspacePackageJsonPaths } from './workspace_package_manifests.mjs';

const STACK_TOOLING_FALLBACK_PACKAGE_NAMES = ['typescript', 'tsx', 'prisma'];
const NODE_BACKED_BIN_FILE_EXTENSIONS = /\.(?:[cm]?[jt]sx?)$/i;

function unique(values) {
  return [...new Set((values ?? []).map((value) => String(value ?? '').trim()).filter(Boolean))];
}

function resolveNodeModulesBinDirs(dir) {
  const candidateDirs = [];
  const monorepoRoot = coerceHappyMonorepoRootFromPath(dir);
  if (monorepoRoot) candidateDirs.push(join(monorepoRoot, 'node_modules', '.bin'));
  candidateDirs.push(join(resolve(dir), 'node_modules', '.bin'));
  return unique(candidateDirs);
}

function createPackageRequire(dir) {
  try {
    return createRequire(join(resolve(dir), 'package.json'));
  } catch {
    return createRequire(import.meta.url);
  }
}

function resolvePackageBinRecord(packageJson) {
  const binField = packageJson?.bin;
  if (!binField) {
    return {};
  }
  if (typeof binField === 'string') {
    const packageName = typeof packageJson?.name === 'string' ? packageJson.name.trim() : '';
    return packageName ? { [packageName]: binField } : {};
  }
  if (typeof binField !== 'object') {
    return {};
  }
  return Object.fromEntries(
    Object.entries(binField)
      .map(([name, target]) => [String(name ?? '').trim(), typeof target === 'string' ? target.trim() : ''])
      .filter(([name, target]) => name && target),
  );
}

async function readPackageDependencyNames(dir) {
  const packageJsonPath = join(resolve(dir), 'package.json');
  if (!existsSync(packageJsonPath)) {
    return [];
  }
  try {
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf-8'));
    const sections = [packageJson?.dependencies, packageJson?.devDependencies, packageJson?.optionalDependencies];
    return unique(
      sections
        .filter((section) => section && typeof section === 'object')
        .flatMap((section) => Object.keys(section)),
    );
  } catch {
    return [];
  }
}

async function resolveWorkspaceToolCommandSpecs(dir, { outputBinDir = null } = {}) {
  const monorepoRoot = coerceHappyMonorepoRootFromPath(dir);
  const isolatedOutputBinDir = outputBinDir ? resolve(outputBinDir) : null;
  const resolutionRoots = unique([dir, monorepoRoot]);
  const candidatePackageNames = unique(
    [
      ...(await Promise.all(resolutionRoots.map((resolutionRoot) => readPackageDependencyNames(resolutionRoot)))).flat(),
      ...STACK_TOOLING_FALLBACK_PACKAGE_NAMES,
    ],
  );
  const specs = [];
  const seenEntries = new Set();

  for (const resolutionRoot of resolutionRoots) {
    const req = createPackageRequire(resolutionRoot);
    for (const packageName of candidatePackageNames) {
      let packageJsonPath = '';
      try {
        packageJsonPath = req.resolve(`${packageName}/package.json`);
      } catch {
        continue;
      }
      const packageDir = dirname(packageJsonPath);
      const packageJson = req(packageJsonPath);
      const binRecord = resolvePackageBinRecord(packageJson);
      const packageNodeModulesDir = dirname(packageDir);
      const binDir = isolatedOutputBinDir ?? join(packageNodeModulesDir, '.bin');
      for (const [commandName, relativeTarget] of Object.entries(binRecord)) {
        const targetPath = resolve(packageDir, relativeTarget);
        if (!existsSync(targetPath)) continue;
        const entryKey = `${binDir}:${commandName}`;
        if (seenEntries.has(entryKey)) continue;
        seenEntries.add(entryKey);
        specs.push({
          binDir,
          commandName,
          targetPath,
        });
      }
    }
  }

  if (monorepoRoot) {
    const workspaceBinDir = isolatedOutputBinDir ?? join(monorepoRoot, 'node_modules', '.bin');
    const candidatePackageNameSet = new Set(candidatePackageNames);
    for (const packageJsonPath of await collectWorkspacePackageJsonPaths(monorepoRoot)) {
      let packageJson = null;
      try {
        packageJson = JSON.parse(await readFile(packageJsonPath, 'utf-8'));
      } catch {
        continue;
      }
      const packageName = typeof packageJson?.name === 'string' ? packageJson.name.trim() : '';
      if (!candidatePackageNameSet.has(packageName)) continue;

      const packageDir = dirname(packageJsonPath);
      for (const [commandName, relativeTarget] of Object.entries(resolvePackageBinRecord(packageJson))) {
        const targetPath = resolve(packageDir, relativeTarget);
        if (!existsSync(targetPath)) continue;
        const entryKey = `${workspaceBinDir}:${commandName}`;
        if (seenEntries.has(entryKey)) continue;
        seenEntries.add(entryKey);
        specs.push({
          binDir: workspaceBinDir,
          commandName,
          targetPath,
        });
      }
    }
  }

  return specs;
}

async function writeCommandShim({ binDir, commandName, targetPath }) {
  const launchMode = await resolveCommandTargetLaunchMode(targetPath);
  await mkdir(binDir, { recursive: true });
  const unixShimPath = join(binDir, commandName);
  const unixBody = [
    '#!/bin/sh',
    launchMode === 'node'
      ? `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(targetPath)} "$@"`
      : `exec ${JSON.stringify(targetPath)} "$@"`,
    '',
  ].join('\n');
  await writeExecutableFileAtomically(unixShimPath, unixBody);

  if (process.platform === 'win32') {
    const cmdShimPath = join(binDir, `${commandName}.cmd`);
    const cmdBody = [
      '@echo off',
      launchMode === 'node'
        ? `${JSON.stringify(process.execPath)} ${JSON.stringify(targetPath)} %*`
        : /^(?:\.cmd|\.bat)$/i.test(extname(targetPath))
        ? `call ${JSON.stringify(targetPath)} %*`
        : `${JSON.stringify(targetPath)} %*`,
      '',
    ].join('\r\n');
    await writeTextFileAtomically(cmdShimPath, cmdBody);
  }
}

async function renameReplacing(sourcePath, targetPath) {
  try {
    await rename(sourcePath, targetPath);
  } catch (error) {
    if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') {
      throw error;
    }
    await rm(targetPath, { force: true });
    await rename(sourcePath, targetPath);
  }
}

function createTempSiblingPath(targetPath) {
  return `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function writeExecutableFileAtomically(targetPath, contents) {
  const existing = await readRegularTextFile(targetPath);
  if (existing?.contents === contents && (existing.mode & 0o111) !== 0) {
    return;
  }
  const tempPath = createTempSiblingPath(targetPath);
  try {
    await writeFile(tempPath, contents, { encoding: 'utf-8', mode: 0o755 });
    await chmod(tempPath, 0o755);
    await renameReplacing(tempPath, targetPath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

async function writeTextFileAtomically(targetPath, contents) {
  const existing = await readRegularTextFile(targetPath);
  if (existing?.contents === contents) {
    return;
  }
  const tempPath = createTempSiblingPath(targetPath);
  try {
    await writeFile(tempPath, contents, 'utf-8');
    await renameReplacing(tempPath, targetPath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

async function readRegularTextFile(path) {
  try {
    const fileStat = await lstat(path);
    if (!fileStat.isFile()) {
      return null;
    }
    return {
      contents: await readFile(path, 'utf-8'),
      mode: fileStat.mode,
    };
  } catch {
    return null;
  }
}

async function resolveCommandTargetLaunchMode(targetPath) {
  if (NODE_BACKED_BIN_FILE_EXTENSIONS.test(targetPath)) {
    return 'node';
  }

  try {
    const source = await readFile(targetPath, 'utf-8');
    const firstLine = source.split(/\r?\n/, 1)[0] ?? '';
    if (/^#!.*\bnode(?:\s|$)/i.test(firstLine)) {
      return 'node';
    }
  } catch {
    // Fall through to direct execution if we cannot inspect the target.
  }

  return 'direct';
}

async function ensureWorkspaceToolBins(dir, options = {}) {
  const commandSpecs = await resolveWorkspaceToolCommandSpecs(dir, options);
  if (commandSpecs.length === 0) {
    return [];
  }

  for (const spec of commandSpecs) {
    await writeCommandShim({
      binDir: spec.binDir,
      commandName: spec.commandName,
      targetPath: spec.targetPath,
    });
  }
  return unique(commandSpecs.map((spec) => spec.binDir));
}

export async function resolveWorkspaceToolBinDirs(dir, { outputBinDir = null } = {}) {
  const isolatedOutputBinDir = outputBinDir ? resolve(outputBinDir) : null;
  const createdBinDirs = await ensureWorkspaceToolBins(dir, {
    outputBinDir: isolatedOutputBinDir,
  });
  const candidateDirs = isolatedOutputBinDir
    ? [isolatedOutputBinDir]
    : [...createdBinDirs, ...resolveNodeModulesBinDirs(dir)];
  return unique(candidateDirs).filter((candidate) => existsSync(candidate));
}
