import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve } from 'node:path';

import { coerceHappyMonorepoRootFromPath } from '../paths/paths.mjs';

const STACK_TOOLING_FALLBACK_PACKAGE_NAMES = ['typescript', 'tsx', 'prisma'];
const NODE_BACKED_BIN_FILE_EXTENSIONS = /\.(?:[cm]?[jt]sx?)$/i;

function sha256Hex(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf-8').digest('hex');
}

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

async function resolveWorkspaceToolCommandSpecs(dir) {
  const resolutionRoots = unique([dir, coerceHappyMonorepoRootFromPath(dir)]);
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
      const binDir = join(packageNodeModulesDir, '.bin');
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
  const tempPath = createTempSiblingPath(targetPath);
  try {
    await writeFile(tempPath, contents, 'utf-8');
    await renameReplacing(tempPath, targetPath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
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

async function ensureWorkspaceToolBins(dir) {
  const commandSpecs = await resolveWorkspaceToolCommandSpecs(dir);
  if (commandSpecs.length === 0) {
    return [];
  }

  const shimFingerprint = sha256Hex(
    commandSpecs
      .map((spec) => `${spec.binDir}:${spec.commandName}:${spec.targetPath}`)
      .sort()
      .join('\n'),
  );
  for (const spec of commandSpecs) {
    await writeCommandShim({
      binDir: spec.binDir,
      commandName: spec.commandName,
      targetPath: spec.targetPath,
    });
  }
  void shimFingerprint;
  return unique(commandSpecs.map((spec) => spec.binDir));
}

export async function resolveWorkspaceToolBinDirs(dir) {
  const createdBinDirs = await ensureWorkspaceToolBins(dir);
  return unique([...createdBinDirs, ...resolveNodeModulesBinDirs(dir)]).filter((candidate) => existsSync(candidate));
}
