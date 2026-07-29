import { copyFile, lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  normalizePluginSdkRegistryOrigin,
  runManagedPluginPnpm,
  type ManagedPluginPnpmRunResult,
} from '@/plugins/authoring/toolchain';
import { createDaemonPluginCandidateOperationRoot } from './candidateStorage';

const EXCLUDED_SOURCE_DIRECTORY_NAMES = new Set(['.git', 'dist', 'node_modules']);
const EXCLUDED_PACKAGE_MANAGER_FILE_NAMES = new Set([
  '.pnpmfile.cjs',
  '.pnpmfile.js',
  '.yarnrc',
  '.yarnrc.yml',
  'pnpm-workspace.yaml',
]);
const INSTALL_ONLY_FILE_NAMES = new Set(['.npmrc', 'pnpm-lock.yaml']);

export type MaterializedPluginDevelopmentCandidate = Readonly<{
  rootPath: string;
  cleanup: () => Promise<void>;
}>;

export type RunManagedPluginPnpmBoundary = (params: Readonly<{
  projectRoot: string;
  args: readonly string[];
  sdkRegistryOrigin?: string | null;
}>) => Promise<ManagedPluginPnpmRunResult>;

function isPathInsideRoot(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath);
  return relativePath === ''
    || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

async function copySelectedSourceTree(params: Readonly<{
  sourceRootPath: string;
  candidateRootPath: string;
}>): Promise<void> {
  const pending = [{ source: params.sourceRootPath, destination: params.candidateRootPath }];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const entries = await readdir(directory.source, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (EXCLUDED_SOURCE_DIRECTORY_NAMES.has(entry.name)) continue;
      if (EXCLUDED_PACKAGE_MANAGER_FILE_NAMES.has(entry.name)) continue;
      const sourcePath = join(directory.source, entry.name);
      const destinationPath = join(directory.destination, entry.name);
      const stats = await lstat(sourcePath);
      if (stats.isSymbolicLink()) {
        throw new Error(`Plugin development source contains an unsupported symbolic link: ${sourcePath}`);
      }
      if (stats.isDirectory()) {
        await mkdir(destinationPath);
        pending.push({ source: sourcePath, destination: destinationPath });
        continue;
      }
      if (!stats.isFile()) {
        throw new Error(`Plugin development source contains an unsupported filesystem entry: ${sourcePath}`);
      }
      await copyFile(sourcePath, destinationPath);
    }
  }
}

async function removeInstallationInputs(rootPath: string): Promise<void> {
  const pending = [rootPath];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = join(directory, entry.name);
      if (INSTALL_ONLY_FILE_NAMES.has(entry.name)) {
        await rm(entryPath, { recursive: true, force: true });
      } else if (entry.isDirectory()) {
        pending.push(entryPath);
      }
    }
  }
}

async function removeUnusedPackageExecutables(rootPath: string): Promise<void> {
  // Daemon activation imports the installed production dependency closure but
  // never executes dependency package bins. pnpm represents those bins as
  // symlinks, so discard the unused surface before enforcing the regular-file
  // immutable-generation contract below.
  await rm(join(rootPath, 'node_modules', '.bin'), { recursive: true, force: true });
}

async function verifyRegularContainedTree(rootPath: string): Promise<void> {
  const canonicalRootPath = await realpath(rootPath);
  const pending = [canonicalRootPath];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = join(directory, entry.name);
      const stats = await lstat(entryPath);
      if (stats.isSymbolicLink()) {
        throw new Error(`Plugin development candidate contains an unsupported symbolic link: ${entryPath}`);
      }
      const canonicalEntryPath = await realpath(entryPath);
      if (!isPathInsideRoot(canonicalRootPath, canonicalEntryPath)) {
        throw new Error(`Plugin development candidate escapes its owned root: ${entryPath}`);
      }
      if (stats.isDirectory()) {
        pending.push(entryPath);
      } else if (!stats.isFile()) {
        throw new Error(`Plugin development candidate contains an unsupported filesystem entry: ${entryPath}`);
      }
    }
  }
}

export async function materializePluginDevelopmentCandidate(
  params: Readonly<{
    happyHomeDir: string;
    sourceRootPath: string;
    sdkRegistryOrigin?: string | null;
  }>,
  dependencies: Readonly<{
    runManagedPluginPnpm?: RunManagedPluginPnpmBoundary;
  }> = {},
): Promise<MaterializedPluginDevelopmentCandidate> {
  const sourceRootPath = await realpath(resolve(params.sourceRootPath));
  const operationRootPath = await createDaemonPluginCandidateOperationRoot({
    happyHomeDir: params.happyHomeDir,
    kind: 'development',
  });
  const candidateRootPath = join(operationRootPath, 'plugin');
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    await rm(operationRootPath, { recursive: true, force: true });
  };

  try {
    await mkdir(candidateRootPath);
    await copySelectedSourceTree({ sourceRootPath, candidateRootPath });
    const managedPnpm = await (dependencies.runManagedPluginPnpm ?? runManagedPluginPnpm)({
      projectRoot: candidateRootPath,
      args: [
        'install',
        '--prod',
        '--ignore-scripts',
        '--frozen-lockfile',
        '--config.node-linker=hoisted',
        '--package-import-method=copy',
      ],
      sdkRegistryOrigin: normalizePluginSdkRegistryOrigin(params.sdkRegistryOrigin),
    });
    if (!managedPnpm.ok) throw new Error(managedPnpm.message);
    if (managedPnpm.result.exitCode !== 0 || managedPnpm.result.signal !== null) {
      const detail = `${managedPnpm.result.stderr}\n${managedPnpm.result.stdout}`.trim();
      throw new Error(`Plugin development dependency materialization failed${detail ? `: ${detail}` : ''}`);
    }
    await removeInstallationInputs(candidateRootPath);
    await removeUnusedPackageExecutables(candidateRootPath);
    await verifyRegularContainedTree(candidateRootPath);
    return Object.freeze({
      rootPath: candidateRootPath,
      cleanup,
    });
  } catch (error) {
    await cleanup();
    throw error;
  }
}
