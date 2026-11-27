import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { cp, link, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { mountCapturedWorkspaceDependencies, readBuildInputDependencies, withBuildInputDependencies } from '../../../../scripts/workspaces/buildInputConvergence.mjs';
import { readWorkspacePackages } from '../../../../packages/cli-common/sourceRuntimeEntries.mjs';
import { withJsonOwnerFileLock } from '../utils/proc/jsonOwnerFileLock.mjs';
import { inspectDependencyRefresh, resolveDependencyInstallRoot } from '../utils/proc/dependency_refresh.mjs';
import { CURRENT_GENERATION_LINK, createDependencyGeneration, readCurrentDependencyGeneration, resolveDependencyGenerationContainer } from '../utils/proc/dependency_generations.mjs';
import { resolveServerGeneratedClients } from './server_generated_clients.mjs';

/**
 * The one owner of a source revision's dependency installation, for revision
 * trees (a base mounts it) and revision bundles (a capture mounts, derives and
 * captures from it). An installation is keyed by the revision's dependency
 * identity (the refresh owner's identity of its manifests, lockfile, patches and
 * runtime), so a revision never borrows the moving checkout's tools when its
 * own lockfile pins different ones (2c8b5a872a: Prisma 6 schema, checkout Prisma 7, P1012).
 */
export const INSTALLS = 'installs';
export const REVISION_DEPENDENCIES_MISMATCH_CODE = 'HAPPIER_SOURCE_REVISION_DEPENDENCIES_MISMATCH';
/** Shared with the base marker name. */
const INSTALL_MARKER = '.happier-revision-tree.json';

/** Host-wide root for revision bases and installations, beside the shared source bundles. */
export function sourceRevisionTreesRoot(stackBaseDir) {
  return join(dirname(resolve(stackBaseDir)), 'source-revision-trees');
}

/** The paths whose bytes form a revision's dependency identity (the refresh owner's inputs). */
export function isRevisionDependencyInput(path) {
  return path === 'pnpm-lock.yaml' || path === 'pnpm-workspace.yaml' || path === 'package.json' || path.endsWith('/package.json')
    || path.startsWith('patches/');
}

/** The installation directory of a published identity. */
export function revisionInstallDir(treesRoot, identity) {
  return join(resolve(treesRoot), INSTALLS, identity);
}

/**
 * A revision's tracked bytes, from Git objects only: `git archive <revision>` from
 * a checkout that has them, or (`archivePath`) the controller's archive of the same
 * revision on a host whose mirror has no Git objects. Unpacked into outputDir with
 * tar, which every supported OS ships.
 */
export async function extractRevision({ repoDir, revision, outputDir, archivePath, paths = [] }) {
  const { spawn } = await import('node:child_process');
  await new Promise((resolvePromise, reject) => {
    const archive = archivePath ? null : spawn('git', ['--literal-pathspecs', '-C', repoDir, 'archive', '--format=tar', revision, '--', ...paths], { stdio: ['ignore', 'pipe', 'pipe'] });
    const tar = spawn('tar', archivePath ? ['-xzf', archivePath, '-C', outputDir] : ['-x', '-C', outputDir],
      { stdio: [archive ? 'pipe' : 'ignore', 'ignore', 'pipe'] });
    const errors = [];
    archive?.stderr.on('data', chunk => errors.push(chunk));
    tar.stderr.on('data', chunk => errors.push(chunk));
    archive?.stdout.pipe(tar.stdin);
    let pending = archive ? 2 : 1;
    const settle = name => code => {
      if (code !== 0) reject(new Error(`[source-tree] ${name} of ${revision} failed (${code}): ${Buffer.concat(errors).toString().trim()}`));
      else if (--pending === 0) resolvePromise();
    };
    archive?.once('error', reject); tar.once('error', reject);
    archive?.once('close', settle('git archive')); tar.once('close', settle('tar extract'));
  });
}


/**
 * One installation per dependency identity per host, keyed like the shared
 * checkout's refresh marker (the base's own manifests, lockfile, patches and
 * runtime). When the checkout's published installation has exactly that
 * identity it is reused as a hardlink snapshot (the root and every workspace
 * `node_modules`, without the workspace links a base mounts itself; a refresh
 * replaces installed files, never rewrites them). Otherwise the revision's own
 * lockfile is installed frozen into a dependency generation laid out from the
 * base, so another lane's uncommitted dependency edit never reaches a base.
 * @returns {Promise<{ dir: string, identity: string }>}
 */
export async function prepareRevisionInstall({ repoDir, baseDir, treesRoot, workspaceDirs, env, signal }) {
  const { installIdentity: identity } = await inspectDependencyRefresh({ installDir: baseDir, env });
  const dir = join(resolve(treesRoot), INSTALLS, identity);
  await mkdir(dirname(dir), { recursive: true });
  return await withBaseLock(dir, signal, async () => {
    if (existsSync(join(dir, INSTALL_MARKER))) return { dir, identity };
    const staging = `${dir}.tmp-${randomUUID()}`;
    try {
      // This is an optional snapshot of an already published installation, not
      // a request to install the moving checkout's dependency inputs. A dirty
      // manifest must never trigger its remote refresh while preparing a revision.
      const snapshotEnv = { ...env, HAPPIER_STACK_DISABLE_REFRESH_DEPS: '1' };
      const workspaceLinks = {};
      const linkLayout = { staging, workspaceDirs, workspaceLinks };
      const snapshotted = await withBuildInputDependencies({ sourceDir: repoDir, env: snapshotEnv, signal }, async (_env, publication) => {
        if (publication.state.identity !== identity) return false;
        const generation = readCurrentDependencyGeneration(repoDir);
        const installedRoot = generation ? join(resolveDependencyGenerationContainer(repoDir), generation) : repoDir;
        for (const workspaceDir of ['', ...workspaceDirs]) {
          const installed = await realpath(join(repoDir, workspaceDir, 'node_modules')).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
          if (!installed) continue;
          const target = join(staging, workspaceDir, 'node_modules');
          await cloneTree(installed, target, { base: installed, clone: target,
            skip: ['@happier-dev', '.pnpm-task-run-state-v1', CURRENT_GENERATION_LINK],
            projectedRoot: generation && workspaceDir === '' ? join(installedRoot, 'node_modules') : null,
            rewriteLink: (from, to, value) => layRevisionInstallLink({ ...linkLayout, from, to, value, roots: [installedRoot, repoDir] }) });
        }
        await publication.assertCurrent();
        return true;
      });
      if (!snapshotted) await installRevisionDependencies({ baseDir, ...linkLayout, env, signal });
      await verifyRevisionInstallLinks(staging);
      await writeFile(join(staging, INSTALL_MARKER), JSON.stringify({ installIdentity: identity, builtAt: new Date().toISOString(), workspaceLinks }));
      await rm(dir, { recursive: true, force: true });
      await rename(staging, dir);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
    // Never chmod it: a snapshot's files share inodes with the checkout's installation.
    return { dir, identity };
  });
}

/** Workspace source paths belong to the selected tree. The installation retains only
 * dependency files and relative paths for rebuilding workspace links at mount. */
function layRevisionInstallLink({ staging, workspaceDirs, workspaceLinks, from, to, value, roots }) {
  const named = resolve(dirname(from), value);
  for (const root of roots) {
    if (!isInsideDir(root, named)) continue;
    const path = relative(root, named);
    if (path.split(sep).includes('node_modules')) return relative(dirname(to), join(staging, path));
    if (workspaceDirs.some(workspace => isInsideDir(join(root, workspace), named))) {
      workspaceLinks[relative(staging, to)] = path;
      return null;
    }
  }
  return value;
}

async function visitRevisionInstallLinks(dir, visit) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) await visit(path);
    else if (entry.isDirectory()) await visitRevisionInstallLinks(path, visit);
  }
}

async function verifyRevisionInstallLinks(staging) {
  await visitRevisionInstallLinks(staging, async path => {
    try { await stat(path); }
    catch (cause) {
      throw new Error(`[source-tree] revision install contains an unresolved link: ${relative(staging, path)} -> ${await readlink(path)}`, { cause });
    }
  });
}

/** Frozen install of the base's lockfile in a generation shadow (its project
 * paths real, every other entry linked to the base), then only the installed
 * trees stay: the shadow's source links and workspace links are dropped, so an
 * installation shared by bases never points into one base's sources. */
async function installRevisionDependencies({ baseDir, staging, workspaceDirs, workspaceLinks, env, signal }) {
  const { projects } = await createDependencyGeneration(baseDir, { genRoot: staging });
  const { ensureUiPostinstallOutputs, installFrozenDependencies } = await import('../utils/proc/pm.mjs');
  // Lifecycle scripts (the CLI's unpack-tools) run from their real location in
  // the base and load installed tools from there: lend the base this
  // installation's trees while pnpm runs. A base's own physical entries (its
  // generated server clients) are held aside and restored afterwards.
  const lent = [];
  try {
    for (const dir of ['', ...projects]) {
      const modules = join(baseDir, dir, 'node_modules');
      const held = await lstat(modules).then(() => `${modules}.held-${randomUUID()}`, error => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (held) await rename(modules, held);
      lent.push({ modules, held });
      await mkdir(join(staging, dir, 'node_modules'), { recursive: true });
      await symlink(join(staging, dir, 'node_modules'), modules, process.platform === 'win32' ? 'junction' : 'dir');
    }
    await installFrozenDependencies(staging, { env, signal });
  } finally {
    for (const { modules, held } of lent.toReversed()) {
      if ((await lstat(modules).catch(() => null))?.isSymbolicLink()) await rm(modules, { force: true });
      if (held && !existsSync(modules)) await rename(held, modules);
    }
  }
  const keepInstalledTrees = async dir => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.name === 'node_modules' && entry.isDirectory()) {
        await rm(join(path, '@happier-dev'), { recursive: true, force: true });
        await rm(join(path, '.pnpm-task-run-state-v1'), { recursive: true, force: true });
      } else if (entry.isDirectory()) await keepInstalledTrees(path);
      else await rm(path, { force: true });
    }
  };
  await keepInstalledTrees(staging);
  await visitRevisionInstallLinks(staging, async path => {
    const value = await readlink(path);
    const laid = layRevisionInstallLink({ staging, workspaceDirs, workspaceLinks, from: path, to: path, value, roots: [staging, baseDir] });
    if (laid === value) return;
    await rm(path);
    if (laid !== null) await symlink(laid, path);
  });
  // The UI's installed outputs (vendored WASM, worker bundles) are written by
  // tools that resolve their own real location: run from the shadow, whose
  // tools link into the base, they would write into the base and leave the
  // installation unpatched. Run them from the base with this installation
  // mounted, then remove what the mount added (the base's physical generated
  // clients stay) so the base mounts the published installation.
  const uiDir = join(baseDir, 'apps', 'ui');
  if (!existsSync(join(uiDir, 'package.json'))) return;
  const before = new Map();
  for (const dir of ['', ...workspaceDirs]) {
    const modules = join(baseDir, dir, 'node_modules');
    before.set(modules, existsSync(modules) ? new Set(await readdir(modules)) : null);
  }
  await mountCapturedWorkspaceDependencies({ sourceDir: staging, captureDir: baseDir, workspaceDirs });
  try {
    await ensureUiPostinstallOutputs(uiDir, baseDir, { env, quiet: true, force: true });
    const ready = join(baseDir, 'node_modules', '.happier-ui-postinstall-ready');
    if (existsSync(ready)) await rename(ready, join(staging, 'node_modules', '.happier-ui-postinstall-ready'));
  } finally {
    for (const [modules, kept] of before) {
      if (kept === null) { await rm(modules, { recursive: true, force: true }); continue; }
      for (const name of await readdir(modules)) if (!kept.has(name)) await rm(join(modules, name), { recursive: true, force: true });
    }
  }
}

export async function readRevisionInstallWorkspaceLinks(dir) {
  const marker = JSON.parse(await readFile(join(dir, INSTALL_MARKER), 'utf8'));
  const links = marker.workspaceLinks ?? {};
  for (const [link, target] of Object.entries(links)) {
    if (typeof target !== 'string' || !isInsideDir(dir, resolve(dir, link)) || !isInsideDir(dir, resolve(dir, target))) {
      throw new Error(`[source-tree] invalid revision workspace link in ${dir}: ${link} -> ${target}`);
    }
  }
  return links;
}

/** Mount the revision's links at the base's actual depth before lending installed tools. */
export async function mountRevisionWorkspaceDependencies({ sourceDir, captureDir, workspaceDirs, workspaceLinks }) {
  for (const [link, path] of Object.entries(workspaceLinks)) {
    const target = resolve(captureDir, path);
    const destination = resolve(captureDir, link);
    const info = await stat(target).catch(cause => {
      throw new Error(`[source-tree] revision workspace link target is unresolved: ${link} -> ${target}`, { cause });
    });
    await mkdir(dirname(destination), { recursive: true });
    await symlink(target, destination, info.isDirectory() ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file');
  }
  await mountCapturedWorkspaceDependencies({ sourceDir, captureDir, workspaceDirs });
}

/** Installation snapshots no remaining base names go with the base sweep (the newest is kept). */
export async function sweepUnreferencedInstalls({ treesRoot, keep }) {
  const root = join(treesRoot, INSTALLS);
  const entries = (await readdir(root, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error)))
    .filter(entry => entry.isDirectory() && !entry.name.includes('.tmp-') && existsSync(join(root, entry.name, INSTALL_MARKER)));
  if (entries.length < 2) return;
  const dated = await Promise.all(entries.map(async entry => ({ name: entry.name, at: (await lstat(join(root, entry.name))).mtimeMs })));
  keep.add(dated.sort((a, b) => b.at - a.at)[0].name);
  // A revision bundle's server graph links into its own installation.
  for (const name of await readBundleInstallReferences(treesRoot)) keep.add(name);
  for (const { name } of dated) {
    if (keep.has(name)) continue;
    await withBaseLock(join(root, name), undefined, () => rm(join(root, name), { recursive: true, force: true }));
  }
}

/** Installations named by retained revision bundles (`dependencyRootDir` in
 * their record), in the shared bundle store beside the trees root. */
async function readBundleInstallReferences(treesRoot) {
  const installs = join(resolve(treesRoot), INSTALLS);
  const bundleRoot = join(dirname(resolve(treesRoot)), 'source-bundles');
  const names = new Set();
  for (const entry of await readdir(bundleRoot, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))) {
    if (!entry.isDirectory()) continue;
    const record = await readFile(join(bundleRoot, entry.name, 'source-bundle.json'), 'utf8')
      .then(JSON.parse, error => error.code === 'ENOENT' || error.code === 'ENOTDIR' ? null : Promise.reject(error));
    const dir = typeof record?.dependencyRootDir === 'string' ? resolve(record.dependencyRootDir) : null;
    if (dir && dirname(dir) === installs) names.add(basename(dir));
  }
  return names;
}

/** One base per revision on this host; concurrent requests for it build it once. */
export function withBaseLock(baseDir, signal, run) {
  return withJsonOwnerFileLock(run, { lockPath: `${baseDir}.lock`, timeoutMs: Infinity, staleAfterMs: Infinity, signal,
    errorLabel: 'source revision base lock' });
}

/** Hardlink files and recreate links in the clone's own directories. */
export async function cloneTree(from, to, roots = { base: from, clone: to }) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (roots.skip?.includes(entry.name) && from === roots.base) continue;
    let source = join(from, entry.name);
    const target = join(to, entry.name);
    let info = entry;
    if (from === roots.base && roots.projectedRoot && entry.isSymbolicLink()) {
      // A checkout projects the generation's root entries while retaining its
      // own readiness files. Read a projected link at its original depth.
      const projected = resolve(from, await readlink(source));
      if (isInsideDir(roots.projectedRoot, projected)) {
        source = projected;
        info = await lstat(source);
      }
    }
    if (info.isSymbolicLink()) {
      let value = await readlink(source);
      if (roots.rewriteLink) value = roots.rewriteLink(source, target, value);
      else if (isAbsolute(value) && value.startsWith(roots.base + sep)) value = join(roots.clone, relative(roots.base, value));
      if (value !== null) await symlink(value, target);
    } else if (info.isDirectory()) await cloneTree(source, target, roots);
    else await link(source, target);
  }
}

async function writeRevisionDependencyInputs({ descriptor, outputDir }) {
  const paths = new Set([...Object.keys(descriptor.tree), ...Object.keys(descriptor.overlay)].filter(isRevisionDependencyInput));
  for (const path of paths) {
    // Declared overlay bytes are the selected manifest; null deletes it.
    const bytes = Object.hasOwn(descriptor.overlay, path) || Object.hasOwn(descriptor.blobs, path) ? descriptor.blobs[path] ?? null : undefined;
    if (bytes === undefined) {
      throw new Error(`[source-revision] descriptor ${descriptor.key} lacks dependency input ${path}; describe the revision with current stack source`);
    }
    await rm(join(outputDir, path), { force: true });
    if (bytes === null) continue;
    await mkdir(dirname(join(outputDir, path)), { recursive: true });
    await writeFile(join(outputDir, path), bytes);
  }
}

async function readRevisionDependencyIdentity({ descriptor, inputsDir, env }) {
  await mkdir(inputsDir, { recursive: true });
  await writeRevisionDependencyInputs({ descriptor, outputDir: inputsDir });
  const { installIdentity } = await inspectDependencyRefresh({ installDir: inputsDir, env });
  return installIdentity;
}

/** The revision's dependency identity and, when already available, its root:
 * the checkout when its published installation has that identity, or the
 * published installation of that identity. `root: null` means it must be installed. */
async function inspectRevisionDependencies({ repoDir, descriptor, treesRoot, scratch, env }) {
  const identity = await readRevisionDependencyIdentity({ descriptor, inputsDir: join(scratch, 'inputs'), env });
  // A checkout no refresh owner has published (no marker) is installed from its own current inputs.
  const checkout = (await readBuildInputDependencies({ sourceDir: repoDir, env })).identity
    ?? (await inspectDependencyRefresh({ installDir: resolveDependencyInstallRoot(repoDir), env })).installIdentity;
  if (checkout === identity) return { identity, root: repoDir };
  const dir = revisionInstallDir(treesRoot, identity);
  return { identity, root: existsSync(join(dir, INSTALL_MARKER)) ? dir : null };
}

function revisionScratch(treesRoot) {
  return join(resolve(treesRoot), INSTALLS, `.tmp-revision-${randomUUID()}`);
}

async function hasRevisionObjects(repoDir, revision) {
  const { execFile } = await import('node:child_process');
  return await new Promise(done => execFile('git', ['-C', repoDir, 'cat-file', '-e', `${revision}^{commit}`], error => done(!error)));
}

/**
 * The dependency root a revision bundle mounts, derives its generated clients
 * with and captures runtime dependencies from. A revision whose dependency
 * identity is the checkout's published installation uses the checkout (no
 * copy, no install). Any other identity uses that identity's own installation,
 * prepared once per host from the revision's tracked tree (its lifecycle
 * scripts run from there: Git objects, or `archivePath` on a mirror without
 * them) and reused by every later revision with that identity.
 * @returns {Promise<string>} the dependency root directory
 */
export async function resolveRevisionDependencyRoot({ repoDir, descriptor, treesRoot, archivePath, requestBaseArchive, env = process.env, signal }) {
  repoDir = resolve(repoDir);
  const scratch = revisionScratch(treesRoot);
  let requestedArchive;
  try {
    const { identity, root } = await inspectRevisionDependencies({ repoDir, descriptor, treesRoot, scratch, env });
    if (root) return root;
    if (!archivePath && !await hasRevisionObjects(repoDir, descriptor.revision)) {
      requestedArchive = await requestRevisionInstallArchive({ repoDir, descriptor, treesRoot, requestBaseArchive, env, signal });
      archivePath = requestedArchive;
      if (!archivePath) throw Object.assign(new Error(`[source-revision] ${descriptor.revision} needs its own installation (identity ${identity}), and this host has no Git objects or revision archive for it; prepare it through the controller's reload`), { code: REVISION_DEPENDENCIES_MISMATCH_CODE });
    }
    const baseDir = join(scratch, 'tree');
    await mkdir(baseDir, { recursive: true });
    await extractRevision({ repoDir, revision: descriptor.revision, outputDir: baseDir, archivePath });
    await writeRevisionDependencyInputs({ descriptor, outputDir: baseDir });
    const workspaces = await readWorkspacePackages(baseDir);
    const workspaceDirs = [...workspaces.values()].map(workspace => relative(baseDir, workspace.root)).filter(Boolean);
    const install = await prepareRevisionInstall({ repoDir, baseDir, treesRoot, workspaceDirs, env, signal });
    if (install.identity !== identity) {
      throw new Error(`[source-revision] ${descriptor.revision} installed identity ${install.identity}, but its dependency inputs name ${identity}`);
    }
    console.error(`[source-revision] revision=${descriptor.revision} uses its own installation identity=${identity}`);
    return install.dir;
  } finally {
    if (requestedArchive) await rm(requestedArchive, { force: true });
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * A mirror without Git objects asks the controller for the revision archive
 * (the revision trees' `requestBaseArchive` transport) only when the revision
 * needs an installation this host has not published yet.
 * @returns {Promise<string | null>} the archive path for resolveRevisionDependencyRoot, or null
 */
export async function requestRevisionInstallArchive({ repoDir, descriptor, treesRoot, requestBaseArchive, env = process.env, signal }) {
  if (typeof requestBaseArchive !== 'function' || await hasRevisionObjects(repoDir, descriptor.revision)) return null;
  const scratch = revisionScratch(treesRoot);
  try {
    if ((await inspectRevisionDependencies({ repoDir: resolve(repoDir), descriptor, treesRoot, scratch, env })).root) return null;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  const path = join(resolve(treesRoot), INSTALLS, `.tmp-archive-${randomUUID()}.tar.gz`);
  await requestBaseArchive({ revision: descriptor.revision, path, signal });
  return path;
}

/** The server's own Prisma layout owner. A revision that has it places its default
 * client itself, also for a borrowed installation (612af8e5162 and later). */
const SERVER_PRISMA_LAYOUT_OWNER = 'apps/server/scripts/prismaInstallLayout.mjs';
const PRISMA_CLIENT_PACKAGE = '@prisma/client';

function isInsideDir(root, path) {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * A revision without its own layout owner generates its default client where Prisma
 * puts one for a schema without `output`: beside the `@prisma/client` its server
 * resolves. In a capture that package is a link into the (shared) installation, so
 * generation would write into the installation. The capture takes a private copy of
 * the package at the server's resolution point first: the client is then generated,
 * stamped and carried inside the capture. Revisions with the owner are unchanged.
 * Call with the installation mounted.
 * @returns {Promise<string | null>} the capture-relative package directory it made physical
 */
export async function prepareRevisionServerClientLayout({ captureDir }) {
  if (existsSync(join(captureDir, SERVER_PRISMA_LAYOUT_OWNER))) return null;
  // Node's lookup from the server package: the first node_modules that has the package.
  let modulesDir = null;
  for (let dir = 'apps/server'; ; dir = dirname(dir)) {
    const candidate = join(dir === '.' ? '' : dir, 'node_modules');
    if (existsSync(join(captureDir, candidate, PRISMA_CLIENT_PACKAGE, 'package.json'))) { modulesDir = candidate; break; }
    if (dir === '.' || dir === '') break;
  }
  if (modulesDir === null) return null;
  const scope = join(captureDir, modulesDir, dirname(PRISMA_CLIENT_PACKAGE));
  if ((await lstat(scope)).isSymbolicLink()) {
    // A mounted scope is one link; keep its other packages linked, own only the client.
    const target = await realpath(scope);
    await rm(scope, { force: true });
    await mkdir(scope);
    for (const name of await readdir(target)) {
      await symlink(join(target, name), join(scope, name), process.platform === 'win32' ? 'junction' : 'dir');
    }
  }
  const client = join(captureDir, modulesDir, PRISMA_CLIENT_PACKAGE);
  if ((await lstat(client)).isSymbolicLink()) {
    const target = await realpath(client);
    await rm(client, { force: true });
    await cp(target, client, { recursive: true, verbatimSymlinks: true });
  }
  return join(modulesDir, PRISMA_CLIENT_PACKAGE).split(sep).join('/');
}

/**
 * The capture-relative directories a capture-owned Prisma layout adds to the server's
 * generated inputs: the private `@prisma/client` copy and every client the layout
 * places inside the capture (from each schema's generator output, or beside that
 * package). Empty when the installation owns the package: the standard generated
 * roots then hold every client.
 * @returns {string[]}
 */
export function readRevisionServerClientRoots(captureDir) {
  const root = realpathSync(captureDir);
  let packageDir;
  try { packageDir = dirname(createRequire(join(root, 'apps/server/package.json')).resolve(`${PRISMA_CLIENT_PACKAGE}/package.json`)); }
  catch (error) { if (error.code === 'MODULE_NOT_FOUND' || error.code === 'ENOENT') return []; throw error; }
  if (!isInsideDir(root, packageDir)) return [];
  const clients = resolveServerGeneratedClients({ repoDir: root })
    .filter(({ schema }) => existsSync(join(root, schema))).map(({ client }) => join(root, client))
    .filter(path => isInsideDir(root, path));
  return [...new Set([packageDir, ...clients].map(path => relative(root, path).split(sep).join('/')))];
}
