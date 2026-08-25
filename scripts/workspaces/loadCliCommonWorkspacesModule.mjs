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
const WORKSPACES_GRAPH_ENTRY_RELATIVE_PATH = 'dist/workspaces/index.js';
const WORKSPACES_GRAPH_SOURCE_MAP_RELATIVE_PATH = 'dist/workspaces/index.js.map';
// `dist/workspaces/index.js` reaches its root-level siblings as `../../<name>.mjs`. tsc emits the
// specifier verbatim, so the entry's own bytes are the authority on which helpers the snapshot must
// carry. Deriving them beats naming them here: a hand-maintained list silently omits the next helper
// someone adds, which is exactly how this defect family recurs.
const ROOT_HELPER_SPECIFIER_PATTERN =
  /(?:from|import)\s*\(?\s*['"]\.\.\/\.\.\/([A-Za-z0-9._-]+\.[cm]js)['"]/gu;

function readFileIfPresent(path) {
  return existsSync(path) ? readFileSync(path) : null;
}

function findGraphEntryRootHelperRelativePaths(entryContents) {
  const specifiers = new Set();
  for (const match of String(entryContents).matchAll(ROOT_HELPER_SPECIFIER_PATTERN)) {
    specifiers.add(match[1]);
  }
  // Sorted by code unit: the staged order feeds a cross-machine content address.
  return [...specifiers].sort((left, right) => (left === right ? 0 : (left < right ? -1 : 1)));
}

/**
 * A helper the entry imports is a required input; only the source map is optional. Skipping one that
 * read as absent — a workspace install can briefly unlink it — stages a snapshot that is wrong but
 * complete-looking, then defers the honest failure into `Cannot find module <temp snapshot path>`,
 * which nobody traces back here. Refuse now, naming the input, before anything is written or
 * content-addressed.
 */
function assertGraphEntryRootHelpersReadable(packageDir, rootHelperFiles) {
  const unreadable = rootHelperFiles
    .filter(([, contents]) => contents === null)
    .map(([relativePath]) => relativePath);
  if (unreadable.length === 0) return;
  throw new Error(
    'cli-common workspaces loader cannot stage its graph: '
    + `${unreadable.length === 1 ? 'a required input' : 'required inputs'} imported by `
    + `${WORKSPACES_GRAPH_ENTRY_RELATIVE_PATH} could not be read from ${packageDir}: `
    + `${unreadable.join(', ')}. Re-run once the workspace install has settled.`,
  );
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
  packageJsonContents,
  modulePath,
) {
  const entryContents = readFileSync(modulePath);
  const rootHelperFiles = findGraphEntryRootHelperRelativePaths(entryContents).map(
    (relativePath) => [relativePath, readFileIfPresent(resolve(packageDir, relativePath))],
  );
  assertGraphEntryRootHelpersReadable(packageDir, rootHelperFiles);

  const graphFiles = [
    ['package.json', packageJsonContents],
    ...rootHelperFiles,
    [WORKSPACES_GRAPH_ENTRY_RELATIVE_PATH, entryContents],
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
  { force = false, includeDevDependencies = false, publicationMode = '', quiet = false } = {},
) {
  const packageJsonPath = resolve(repoRoot, 'packages', 'cli-common', 'package.json');
  // Read once and stage those exact bytes. A second read at staging time could disagree with the
  // one that was validated here, which is the same transient-read hazard guarded below.
  const packageJsonContents = readFileIfPresent(packageJsonPath);
  if (packageJsonContents !== null) {
    JSON.parse(String(packageJsonContents));
  }

  const modulePath = resolve(repoRoot, 'packages', 'cli-common', 'dist', 'workspaces', 'index.js');
  await ensureWorkspacePackagesBuiltByName(repoRoot, ['@happier-dev/cli-common'], {
    quiet,
    env,
    ...(publicationMode ? { publicationMode } : {}),
    ...(force ? { force: true } : {}),
    ...(includeDevDependencies ? {} : { includeDevDependencies: false }),
  });

  if (!existsSync(modulePath)) {
    throw new Error(`Missing cli-common workspaces build helpers: ${modulePath}`);
  }

  return await importCliCommonWorkspacesGraph(
    repoRoot,
    resolve(repoRoot, 'packages', 'cli-common'),
    packageJsonContents,
    modulePath,
  );
}
