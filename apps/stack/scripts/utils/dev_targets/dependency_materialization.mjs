import { lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { collectWorkspacePackageJsonPaths, isYarnWorkspace } from '../proc/workspace_package_manifests.mjs';

function unmeasured(target, packageManager, repoDir) {
  // Older checkout-owned admission records expose the identity and snapshot,
  // rather than the current owner's installIdentity. This diagnostic does not
  // create a persisted identity or decide whether an installation is ready.
  const identity = target.installIdentity ?? createHash('sha256')
    .update(JSON.stringify({ identity: target.dependencyIdentity, inputs: target.inputSnapshot })).digest('hex');
  return { requiredAdditionalBytes: 0, warnings: [{ code: 'HSTACK_DEPENDENCY_FOOTPRINT_UNMEASURED',
    packageManager, identity, missingReference: 'matching-admitted-copy', referenceParent: dirname(repoDir) }] };
}

async function file(path) {
  return await lstat(path).catch(error => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  });
}

async function measureMissingPackageFiles(baseline, destination) {
  let bytes = 0;
  const visit = async (source, target) => {
    const info = await lstat(source);
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      for (const entry of await readdir(source)) await visit(join(source, entry), join(target, entry));
    } else if (info.isFile()) {
      const resident = await file(target);
      // Yarn 1.22.22 skips only matching size+mtime. Otherwise it unlinks the
      // old path before copy: credit only blocks that unlink can actually free,
      // never another link's shared allocation. This is net growth, not peak.
      if (resident?.isFile() && resident.size === info.size && resident.mtimeMs === info.mtimeMs) return;
      const reclaimable = resident?.isFile() && resident.nlink === 1 ? resident.blocks * 512 : 0;
      bytes += Math.max(0, info.size - reclaimable);
    }
  };
  // Root caches, admission markers and workspace links are not installed
  // package copies. Yarn classic's default installer copies package files;
  // unlike pnpm's store links, every missing destination path is new demand.
  const packages = async (source, target) => {
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const path = join(source, entry.name), destination = join(target, entry.name);
      if (entry.name.startsWith('@')) await packages(path, destination);
      else if ((await file(join(path, 'package.json')))?.isFile()) await visit(path, destination);
    }
  };
  await packages(join(baseline, 'node_modules'), join(destination, 'node_modules'));
  for (const manifest of await collectWorkspacePackageJsonPaths(baseline)) {
    const workspace = relative(baseline, dirname(manifest));
    const source = join(baseline, workspace, 'node_modules');
    if ((await file(source))?.isDirectory()) await packages(source, join(destination, workspace, 'node_modules'));
  }
  if (!Number.isSafeInteger(bytes)) throw new Error('Yarn copy byte measurement exceeds the supported integer range');
  return bytes;
}

// Placement remains the launcher's responsibility. This owner supplies only
// measured copy demand to the existing disk admission/reclamation owner.
// A resident pnpm closure is not a reservation: its actual import can reuse the
// content-addressed store, and no additional-write peak has been established.
export async function measureColdDependencyBytes({ repoDir, env = process.env }) {
  const manifest = JSON.parse(await readFile(join(repoDir, 'package.json'), 'utf8'));
  const empty = { requiredAdditionalBytes: 0, warnings: [] };
  if (!isYarnWorkspace(manifest)) return empty;
  const ownerPath = join(repoDir, 'apps/stack/scripts/utils/proc/dependency_refresh.mjs');
  const { inspectDependencyRefresh } = await import(pathToFileURL(ownerPath).href);
  const inspect = installDir => inspectDependencyRefresh({ installDir, componentDir: join(installDir, 'apps/stack'), env });
  const target = await inspect(repoDir);
  if (target.required === false) return empty;
  if (target.required !== true) return unmeasured(target, manifest.packageManager, repoDir);
  const lockfile = await readFile(join(repoDir, 'yarn.lock'));
  for (const entry of await readdir(dirname(repoDir), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(dirname(repoDir), entry.name);
    if (candidate === repoDir) continue;
    try {
      if (!(await file(join(candidate, 'node_modules')))?.isDirectory()) continue;
      if (!(await readFile(join(candidate, 'yarn.lock'))).equals(lockfile)) continue;
      const reference = await inspect(candidate);
      if (reference.required !== false || !isDeepStrictEqual(reference.dependencyIdentity, target.dependencyIdentity)
        || !isDeepStrictEqual(reference.inputSnapshot, target.inputSnapshot)) continue;
      return { requiredAdditionalBytes: await measureMissingPackageFiles(candidate, repoDir), warnings: [] };
    } catch (error) {
      // An inaccessible, malformed or retired neighbor is not an admitted
      // reference. Its absence cannot impose a new refusal on this checkout.
      if (error instanceof SyntaxError || ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) continue;
      throw error;
    }
  }
  return unmeasured(target, manifest.packageManager, repoDir);
}
