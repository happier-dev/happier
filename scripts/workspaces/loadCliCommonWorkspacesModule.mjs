import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ensureWorkspacePackagesBuiltByName as ensureWorkspacePackagesBuiltByNameDefault,
} from './ensureWorkspacePackagesBuilt.mjs';

const loaderRunId = `${process.pid}-${randomUUID()}`;
const WORKSPACES_GRAPH_HELPER_RELATIVE_PATH = 'workspaceRuntimeDependencies.mjs';
const WORKSPACES_GRAPH_ENTRY_RELATIVE_PATH = 'dist/workspaces/index.js';
const WORKSPACES_GRAPH_SOURCE_MAP_RELATIVE_PATH = 'dist/workspaces/index.js.map';

function readFileIfPresent(path) {
  return existsSync(path) ? readFileSync(path) : null;
}

function createWorkspacesGraphFingerprint(files) {
  const hash = createHash('sha256');
  for (const [relativePath, contents] of files) {
    hash.update(relativePath);
    hash.update('\0');
    if (contents === null) {
      hash.update('missing\0');
      continue;
    }
    hash.update(String(contents.byteLength));
    hash.update('\0');
    hash.update(contents);
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function importCliCommonWorkspacesGraph(
  repoRoot,
  packageDir,
  packageJsonPath,
  modulePath,
) {
  const graphFiles = [
    ['package.json', readFileIfPresent(packageJsonPath)],
    [
      WORKSPACES_GRAPH_HELPER_RELATIVE_PATH,
      readFileIfPresent(resolve(packageDir, WORKSPACES_GRAPH_HELPER_RELATIVE_PATH)),
    ],
    [WORKSPACES_GRAPH_ENTRY_RELATIVE_PATH, readFileSync(modulePath)],
    [
      WORKSPACES_GRAPH_SOURCE_MAP_RELATIVE_PATH,
      readFileIfPresent(`${modulePath}.map`),
    ],
  ];
  const fingerprint = createWorkspacesGraphFingerprint(graphFiles);
  const runRoot = resolve(
    repoRoot,
    '.project',
    'tmp',
    `cli-common-workspaces-loader.${loaderRunId}`,
  );
  const snapshotPackageDir = resolve(runRoot, fingerprint);

  for (const [relativePath, contents] of graphFiles) {
    if (contents === null) continue;
    const snapshotPath = resolve(snapshotPackageDir, relativePath);
    mkdirSync(dirname(snapshotPath), { recursive: true });
    writeFileSync(snapshotPath, contents);
  }

  try {
    return await import(
      pathToFileURL(resolve(snapshotPackageDir, WORKSPACES_GRAPH_ENTRY_RELATIVE_PATH)).href
    );
  } finally {
    rmSync(snapshotPackageDir, { recursive: true, force: true });
    try {
      rmdirSync(runRoot);
    } catch {
      // A concurrent load may still own another content-addressed snapshot.
    }
  }
}

export async function loadCliCommonWorkspacesModule(
  repoRoot,
  env = process.env,
  ensureWorkspacePackagesBuiltByName = ensureWorkspacePackagesBuiltByNameDefault,
  { force = false, includeDevDependencies = false, quiet = false } = {},
) {
  const packageJsonPath = resolve(repoRoot, 'packages', 'cli-common', 'package.json');
  if (existsSync(packageJsonPath)) {
    JSON.parse(String(readFileSync(packageJsonPath, 'utf8')));
  }

  const modulePath = resolve(repoRoot, 'packages', 'cli-common', 'dist', 'workspaces', 'index.js');
  await ensureWorkspacePackagesBuiltByName(repoRoot, ['@happier-dev/cli-common'], {
    quiet,
    env,
    ...(force ? { force: true } : {}),
    ...(includeDevDependencies ? {} : { includeDevDependencies: false }),
  });

  if (!existsSync(modulePath)) {
    throw new Error(`Missing cli-common workspaces build helpers: ${modulePath}`);
  }

  return await importCliCommonWorkspacesGraph(
    repoRoot,
    resolve(repoRoot, 'packages', 'cli-common'),
    packageJsonPath,
    modulePath,
  );
}
