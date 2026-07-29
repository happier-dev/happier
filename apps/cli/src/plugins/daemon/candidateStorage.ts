import { lstat, mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

import {
  resolvePluginStorePaths,
  type PluginStorePaths,
} from '@/plugins/store/paths';

export type DaemonPluginCandidateKind = 'development' | 'archive' | 'npm';

type CandidateRootDefinition = Readonly<{
  parentPath: string;
  prefix: string;
}>;

function resolveCandidateRootDefinition(params: Readonly<{
  paths: PluginStorePaths;
  kind: DaemonPluginCandidateKind;
}>): CandidateRootDefinition {
  if (params.kind === 'development') {
    return Object.freeze({
      parentPath: join(params.paths.cacheDir, 'development-candidates'),
      prefix: 'candidate-',
    });
  }
  return Object.freeze({
    parentPath: params.paths.cacheDir,
    prefix: params.kind === 'archive'
      ? 'plugin-archive-candidate-'
      : 'plugin-npm-candidate-',
  });
}

function unsafeCandidateStoragePath(path: string): Error & { code: string } {
  return Object.assign(
    new Error(`Unsafe daemon plugin candidate storage path: ${path}`),
    { code: 'ERR_UNSAFE_DAEMON_PLUGIN_CANDIDATE_STORAGE_PATH' },
  );
}

async function assertCanonicalDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw unsafeCandidateStoragePath(path);
  }
  const physicalPath = await realpath(path);
  if (relative(path, physicalPath) !== '') {
    throw unsafeCandidateStoragePath(path);
  }
}

async function resolvePhysicalHappyHome(happyHomeDir: string): Promise<string> {
  const physicalHappyHomeDir = await realpath(happyHomeDir);
  await assertCanonicalDirectory(physicalHappyHomeDir);
  return physicalHappyHomeDir;
}

function resolveCandidateParentChain(
  paths: PluginStorePaths,
  kind: DaemonPluginCandidateKind,
): readonly string[] {
  const chain = [
    dirname(paths.rootDir),
    paths.rootDir,
    paths.cacheDir,
  ];
  if (kind === 'development') {
    chain.push(join(paths.cacheDir, 'development-candidates'));
  }
  return Object.freeze(chain);
}

async function ensureCanonicalCandidateParent(params: Readonly<{
  paths: PluginStorePaths;
  kind: DaemonPluginCandidateKind;
}>): Promise<void> {
  for (const path of resolveCandidateParentChain(params.paths, params.kind)) {
    try {
      await mkdir(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await assertCanonicalDirectory(path);
  }
}

async function validateExistingCanonicalCandidateParent(params: Readonly<{
  paths: PluginStorePaths;
  kind: DaemonPluginCandidateKind;
}>): Promise<boolean> {
  for (const path of resolveCandidateParentChain(params.paths, params.kind)) {
    try {
      await assertCanonicalDirectory(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
  return true;
}

export async function createDaemonPluginCandidateOperationRoot(params: Readonly<{
  happyHomeDir: string;
  kind: DaemonPluginCandidateKind;
}>): Promise<string> {
  const physicalHappyHomeDir = await resolvePhysicalHappyHome(params.happyHomeDir);
  const paths = resolvePluginStorePaths({ happyHomeDir: physicalHappyHomeDir });
  await ensureCanonicalCandidateParent({ paths, kind: params.kind });
  const definition = resolveCandidateRootDefinition({ paths, kind: params.kind });
  return await mkdtemp(join(definition.parentPath, definition.prefix));
}

async function cleanupCandidateRootsForDefinition(
  definition: CandidateRootDefinition,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(definition.parentPath, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory() || !entry.name.startsWith(definition.prefix)) return;
    await rm(join(definition.parentPath, entry.name), { recursive: true, force: true });
  }));
}

/**
 * Removes only roots created by the daemon candidate materializers. The caller
 * must exclusively own the happy home so no live process can still own a
 * matching root.
 */
export async function cleanupStaleDaemonPluginCandidateRoots(
  happyHomeDir: string,
): Promise<void> {
  const physicalHappyHomeDir = await resolvePhysicalHappyHome(happyHomeDir);
  const paths = resolvePluginStorePaths({ happyHomeDir: physicalHappyHomeDir });
  const definitions = await Promise.all(
    (['development', 'archive', 'npm'] as const).map(async (kind) => {
      const parentExists = await validateExistingCanonicalCandidateParent({ paths, kind });
      return parentExists
        ? resolveCandidateRootDefinition({ paths, kind })
        : null;
    }),
  );
  await Promise.all(
    definitions.map(async (definition) => {
      if (definition) await cleanupCandidateRootsForDefinition(definition);
    }),
  );
}
