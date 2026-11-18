import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, readlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, readdir, readlink, rename, rm, symlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { observePidLiveness } from './pids.mjs';
import { collectWorkspacePackageJsonPaths } from './workspace_package_manifests.mjs';

// Atomic dependency installs (owner ruling 2026-11-17). Each installation is a
// generation: a shadow workspace under `<root>/.happier/deps/node_modules/<generation>/`
// whose project directories link the real sources, with its own installed
// `node_modules` trees. Every nested `<project>/node_modules` path of the checkout
// is a relative symlink into the current generation. The root `node_modules`
// stays a real directory (pnpm 12 refuses `pnpm run`/`exec` when it is a link:
// its task-run state lives there); each of its installation entries (`.bin`,
// `.modules.yaml`, every hoisted package or scope) is a symlink into the
// generation instead. Every path flips by renaming a temporary symlink over it
// (atomic per path), so each always names one complete generation. Node loads
// modules by real path, so a module loaded from generation N resolves its
// dependencies inside N even while paths flip. The container lives under
// `.happier/` (ignored by Git and by every Mutagen session, so a mirror-only
// generation is never a sync deletion) and is named `node_modules`, so source
// globs skip it by their existing rules.
const CONTAINER = join('.happier', 'deps', 'node_modules');
const GENERATION_NAME = /^g[0-9a-z]{9}-[0-9a-f]{8}$/u;
const SKIPPED_ROOT_ENTRIES = new Set(['node_modules', '.happier', '.git']);
// The root `node_modules` entry naming the current generation; flipped last.
export const CURRENT_GENERATION_LINK = '.happier-dependency-generation';
// Root `node_modules` entries that belong to the checkout, not to an
// installation: pnpm's task-run state (it refuses a linked one), tool caches and
// Happier's readiness markers. They stay real and survive a switch, as they did
// an in-place install; a generation's own copy is never linked over them.
const CHECKOUT_STATE_ENTRY = /^\.(?:pnpm-task-run-state|cache$|vite|vitest|happier-|ignored$)/u;
// What pnpm itself writes at the root: adoption moves only these into the first
// generation, so other dot entries (leftovers of other writers) stay checkout state.
const PNPM_ROOT_ENTRIES = new Set(['.bin', '.modules.yaml', '.pnpm', '.pnpm-workspace-state-v1.json']);

export function resolveDependencyGenerationContainer(installDir) {
  return join(resolve(installDir), CONTAINER);
}

function isInside(root, path) {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/** The generation the checkout's root `node_modules` currently names, or null
 * for an in-place (not generation-managed) installation. */
export function readCurrentDependencyGeneration(installDir) {
  const modulesDir = join(resolve(installDir), 'node_modules');
  let target;
  try { target = readlinkSync(join(modulesDir, CURRENT_GENERATION_LINK)); }
  catch (error) { if (['ENOENT', 'EINVAL', 'ENOTDIR', 'UNKNOWN'].includes(error.code)) return null; throw error; }
  const rel = relative(resolveDependencyGenerationContainer(installDir), resolve(modulesDir, target)).split(sep);
  return rel.length === 2 && GENERATION_NAME.test(rel[0]) && rel[1] === 'node_modules' ? rel[0] : null;
}

export function isDependencyGenerationManaged(installDir) {
  return readCurrentDependencyGeneration(installDir) !== null;
}

async function readProjectDirs(installDir) {
  const root = resolve(installDir);
  const dirs = (await collectWorkspacePackageJsonPaths(root)).map(path => relative(root, dirname(resolve(path))))
    .filter(dir => dir && isInside(root, join(root, dir)));
  return [...new Set(dirs)].sort();
}

/** Lay out a new, empty generation: real directories along every project path,
 * with every other entry linked to the checkout's own (so installed lifecycle
 * scripts read and write the real sources). `genRoot` lays it out elsewhere
 * (a revision base installs from its own manifests and lockfile). */
export async function createDependencyGeneration(installDir, { genRoot: target } = {}) {
  const root = resolve(installDir);
  const name = `g${Date.now().toString(36).padStart(9, '0')}-${randomUUID().slice(0, 8)}`;
  const genRoot = target ? resolve(target) : join(resolveDependencyGenerationContainer(root), name);
  const projects = await readProjectDirs(root);
  const spine = new Set(['']);
  for (const project of projects) {
    for (let dir = project; dir && dir !== '.'; dir = dirname(dir)) spine.add(dir);
  }
  for (const dir of [...spine].sort()) {
    await mkdir(join(genRoot, dir), { recursive: true });
    for (const entry of await readdir(join(root, dir))) {
      if (entry === 'node_modules' || (dir === '' && SKIPPED_ROOT_ENTRIES.has(entry))) continue;
      const child = dir ? join(dir, entry) : entry;
      if (spine.has(child)) continue;
      await symlink(join(root, child), join(genRoot, child));
    }
  }
  return { name, genRoot, projects };
}

async function replaceWithSymlink(linkPath, target) {
  const temp = `${linkPath}.flip-${randomUUID().slice(0, 8)}`;
  await symlink(target, temp);
  try { await rename(temp, linkPath); }
  catch (error) { await rm(temp, { force: true }); throw error; }
}

async function listModulesEntries(modulesDir) {
  const entries = [];
  for (const entry of await readdir(modulesDir).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))) {
    if (entry.startsWith('@')) {
      for (const scoped of await readdir(join(modulesDir, entry)).catch(() => [])) entries.push(join(modulesDir, entry, scoped));
    } else entries.push(join(modulesDir, entry));
  }
  return entries;
}

/** pnpm links workspace packages to the generation's project directories. Point
 * them at the real projects instead, so files created after the generation was
 * laid out (a fresh `dist`, a new source dir) resolve too. */
export async function retargetGenerationWorkspaceLinks(installDir, { genRoot, projects }) {
  const root = resolve(installDir);
  for (const project of ['', ...projects]) {
    for (const link of await listModulesEntries(join(genRoot, project, 'node_modules'))) {
      const info = await lstat(link);
      if (!info.isSymbolicLink()) continue;
      const target = resolve(dirname(link), await readlink(link));
      if (!isInside(genRoot, target) || relative(genRoot, target).split(sep).includes('node_modules')) continue;
      await replaceWithSymlink(link, relative(dirname(link), join(root, relative(genRoot, target))));
    }
  }
}

const lstatOrNull = path => lstat(path).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));

/** Link `path` to `target`. A real entry an in-place writer left there (a plain
 * `pnpm install`) is replaced by the installation's own: it moves aside into
 * the container's trash, which the next prune removes. */
async function linkInstalledEntry(installDir, path, target) {
  const existing = await lstatOrNull(path);
  if (existing && !existing.isSymbolicLink()) {
    await rename(path, join(resolveDependencyGenerationContainer(installDir), `.trash-checkout-${randomUUID().slice(0, 8)}`));
  }
  await replaceWithSymlink(path, target);
}

/** Switch the checkout to the generation: every project's `node_modules`, then
 * every installation entry of the real root `node_modules` (stale ones that name
 * an older generation are removed), then the current-generation link. */
export async function flipDependencyGeneration(installDir, { genRoot, projects }) {
  const root = resolve(installDir);
  for (const project of projects) {
    const generationModules = join(genRoot, project, 'node_modules');
    await mkdir(generationModules, { recursive: true });
    await linkInstalledEntry(root, join(root, project, 'node_modules'), relative(join(root, project), generationModules));
  }
  const rootModules = join(root, 'node_modules');
  const generationModules = join(genRoot, 'node_modules');
  await mkdir(rootModules, { recursive: true });
  await mkdir(generationModules, { recursive: true });
  const installed = (await readdir(generationModules)).filter(name => !CHECKOUT_STATE_ENTRY.test(name)).sort();
  for (const name of installed) {
    await linkInstalledEntry(root, join(rootModules, name), relative(rootModules, join(generationModules, name)));
  }
  const container = resolveDependencyGenerationContainer(root);
  const keep = new Set([...installed, CURRENT_GENERATION_LINK]);
  for (const name of await readdir(rootModules)) {
    if (keep.has(name)) continue;
    const path = join(rootModules, name);
    if (!(await lstat(path)).isSymbolicLink() || !isInside(container, resolve(rootModules, await readlink(path)))) continue;
    await rm(path, { force: true });
  }
  // It names the generation's installed tree, not its shadow root: a crawler
  // that follows it must not find a second copy of the workspace sources.
  await replaceWithSymlink(join(rootModules, CURRENT_GENERATION_LINK), relative(rootModules, generationModules));
}

/** One-time migration under full writer exclusion: move each project's in-place
 * `node_modules`, and each pnpm entry of the root one, into a first generation
 * (rename, same device), each linked back at once; then switch to it. */
export async function moveInPlaceInstallationIntoGeneration(installDir) {
  const root = resolve(installDir);
  if (process.platform === 'win32') {
    throw Object.assign(new Error('Dependency generations need atomic symlink replacement, which Windows directory junctions do not provide'),
      { code: 'HAPPIER_DEPENDENCY_GENERATION_UNSUPPORTED' });
  }
  const generation = await createDependencyGeneration(root);
  const moveAndLink = async (path, target) => {
    await rename(path, target);
    await symlink(relative(dirname(path), target), path);
  };
  for (const project of generation.projects) {
    const modules = join(root, project, 'node_modules');
    if ((await lstatOrNull(modules))?.isDirectory()) await moveAndLink(modules, join(generation.genRoot, project, 'node_modules'));
  }
  const rootModules = join(root, 'node_modules');
  if ((await lstatOrNull(rootModules))?.isDirectory()) {
    await mkdir(join(generation.genRoot, 'node_modules'), { recursive: true });
    for (const name of await readdir(rootModules)) {
      if (name.startsWith('.') && !PNPM_ROOT_ENTRIES.has(name)) continue;
      await moveAndLink(join(rootModules, name), join(generation.genRoot, 'node_modules', name));
    }
  }
  await retargetGenerationWorkspaceLinks(root, generation);
  await flipDependencyGeneration(root, generation);
  return generation;
}

// A running Stack on the checkout loads modules lazily and holds no custody: a
// retention record keeps the generation it runs on until its process exits.
// Unlike reader records, writers never drain them.
const RETENTION_RECORD = /^retain-\d+-/u;

/** Retain `generation` for each live process (a Stack running on it). */
export function retainDependencyGeneration(readersDir, generation, pids) {
  mkdirSync(readersDir, { recursive: true });
  for (const pid of pids) {
    writeFileSync(join(readersDir, `retain-${pid}-${randomUUID()}.json`), JSON.stringify({ pid, generation }), { flag: 'wx' });
  }
}

function readReaderRecords(readersDir) {
  const records = [];
  for (const name of readdirSync(readersDir, { withFileTypes: false }).filter(entry => /^reader-\d+-/.test(entry) || RETENTION_RECORD.test(entry))) {
    try {
      const record = JSON.parse(readFileSync(join(readersDir, name), 'utf8'));
      if (observePidLiveness(record.pid).status !== 'dead') records.push(record);
      else if (RETENTION_RECORD.test(name)) unlinkSync(join(readersDir, name));
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  }
  return records;
}

/** Live processes that already hold a reader or retention record: they keep the
 * generation they registered on, so a switch adds nothing for them. */
export function readRegisteredDependencyProcesses(readersDir) {
  try { return new Set(readReaderRecords(readersDir).map(record => record.pid)); }
  catch (error) { if (error.code === 'ENOENT') return new Set(); throw error; }
}

/** Remove every generation no live record names, except the current one. A
 * record pins only the generation it registered on, never the newer ones (a
 * long-running Stack pinned all 18 on 2026-11-18). A reader record without a
 * generation (an older client) retains all of them. Returns the removed names. */
export async function pruneDependencyGenerations(installDir, { readersDir }) {
  const container = resolveDependencyGenerationContainer(installDir);
  const current = readCurrentDependencyGeneration(installDir);
  if (current === null) return [];
  const entries = await readdir(container).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  if (entries.every(entry => entry === current)) return [];
  let records;
  try { records = readReaderRecords(readersDir); }
  catch (error) { if (error.code === 'ENOENT') records = []; else throw error; }
  if (records.some(record => typeof record.generation !== 'string')) return [];
  const retained = new Set(records.map(record => record.generation));
  const removed = [];
  for (const entry of entries) {
    const stale = entry.startsWith('.trash-');
    if (!stale && (!GENERATION_NAME.test(entry) || entry === current || retained.has(entry))) continue;
    // Rename first: a removal interrupted midway leaves only trash, never a
    // half-deleted generation under its own name.
    const trash = stale ? join(container, entry) : join(container, `.trash-${entry}`);
    if (!stale) {
      try { await rename(join(container, entry), trash); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      removed.push(entry);
    }
    await rm(trash, { recursive: true, force: true });
  }
  return removed;
}
