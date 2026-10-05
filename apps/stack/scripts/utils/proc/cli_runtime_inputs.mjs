import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { lstat, readdir, readlink } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';

import { resolveWorkspaceBundlesFromPackageJson } from '@happier-dev/cli-common/workspaces';
import { isDevRuntimeReloadIgnoredPath } from '../dev/watchSignature.mjs';
import { forgetCachedFileDigest, readCachedFileDigest } from '../fs/cached_file_digest.mjs';
import { resolveWorkspaceBuildInputWatchPaths } from '../fs/workspaceBuildInputs.mjs';

export function collectHappyCliRuntimePackageDirs({
  cliDir,
  repoRoot = resolve(cliDir, '..', '..'),
}) {
  return resolveWorkspaceBundlesFromPackageJson({ repoRoot, hostPackageDir: cliDir }).map((bundle) => ({
    id: bundle.packageName.split('/')[1] ?? bundle.packageName,
    dir: bundle.srcDir,
  }));
}

export function resolveHappyCliRuntimeInputGroups({
  cliDir,
  existsSyncImpl = existsSync,
  includeShippedFiles = false,
} = {}) {
  const lexicalCliDir = resolve(cliDir);
  let resolvedCliDir = lexicalCliDir;
  try {
    resolvedCliDir = realpathSync.native(lexicalCliDir);
  } catch {
    // Descriptor construction also supports not-yet-materialized fixture paths.
  }
  const repoRoot = resolve(resolvedCliDir, '..', '..');
  const runtimePackages = collectHappyCliRuntimePackageDirs({
    cliDir: resolvedCliDir,
    repoRoot,
  });
  const groups = [
    {
      id: 'daemon:cli',
      target: 'daemon',
      paths: [
        join(resolvedCliDir, 'src'),
        join(resolvedCliDir, 'bin'),
        join(resolvedCliDir, 'codex'),
        join(resolvedCliDir, 'scripts'),
        join(resolvedCliDir, 'package.json'),
        join(resolvedCliDir, 'tsconfig.json'),
        join(resolvedCliDir, 'tsconfig.build.json'),
        join(resolvedCliDir, 'pkgroll.config.mjs'),
      ],
    },
    {
      id: 'build:workspace',
      target: 'daemon',
      paths: [
        join(repoRoot, 'scripts', 'workspaces'),
        join(repoRoot, 'package.json'),
        join(repoRoot, 'yarn.lock'),
      ],
    },
    ...runtimePackages.map(({ id, dir }) => ({
      // The matching server descriptor promotes a shared package to both consumers when
      // descriptors are merged; a CLI-only package remains daemon-only.
      id: `shared:${id}`,
      target: 'daemon',
      paths: resolveWorkspaceBuildInputWatchPaths(dir, { existsSyncImpl, includeShippedFiles }),
    })),
  ];

  return groups
    .map((group) => ({ ...group, paths: group.paths.filter((path) => existsSyncImpl(path)) }))
    .filter((group) => group.paths.length > 0);
}

export function resolveHappyCliRuntimeInputPaths(options) {
  return resolveHappyCliRuntimeInputGroups(options).flatMap((group) => group.paths);
}

export async function readHappyCliRuntimeInputFreshness(cliDir, {
  identityRepoDir = process.env.HAPPIER_STACK_RUNTIME_IDENTITY_REPO_DIR,
  includeShippedFiles = false,
} = {}) {
  const repoRoot = resolve(cliDir, '..', '..');
  let newestMtimeNs = null;
  const fingerprint = createHash('sha256');
  const visit = async (path) => {
    if (!includeShippedFiles && isDevRuntimeReloadIgnoredPath(path)) return;
    let fileStat;
    try {
      fileStat = await lstat(path, { bigint: true });
    } catch {
      forgetCachedFileDigest(path);
      return;
    }
    newestMtimeNs = newestMtimeNs === null || fileStat.mtimeNs > newestMtimeNs
      ? fileStat.mtimeNs
      : newestMtimeNs;
    const nodeType = fileStat.isDirectory() ? 'dir' : fileStat.isFile() ? 'file' : 'other';
    // A dedicated build checkout reads its own bytes, but retains the original
    // producer path labels in the existing fingerprint recipe.
    fingerprint.update(identityRepoDir ? join(identityRepoDir, relative(repoRoot, path)) : path);
    fingerprint.update('\0');
    fingerprint.update(nodeType);
    fingerprint.update('\0');
    if (fileStat.isDirectory()) {
      let names;
      try {
        names = (await readdir(path)).sort((left, right) => left.localeCompare(right));
      } catch {
        return;
      }
      for (const name of names) await visit(join(path, name));
      return;
    }
    fingerprint.update(String(fileStat.size));
    fingerprint.update('\0');
    if (fileStat.isFile()) {
      fingerprint.update(await readCachedFileDigest(path, fileStat));
      fingerprint.update('\0');
      return;
    }
    // Source transfer preserves link contents, not filesystem timestamps.
    // Ordinary development freshness retains its existing metadata behavior.
    if (includeShippedFiles && fileStat.isSymbolicLink()) {
      fingerprint.update(await readlink(path));
      fingerprint.update('\0');
      return;
    }
    fingerprint.update(String(fileStat.mtimeNs));
    fingerprint.update('\0');
    fingerprint.update(String(fileStat.ctimeNs));
    fingerprint.update('\0');
  };

  // Resolving the runtime inputs is a build-configuration decision: it fails
  // when the host package.json is unreadable or its bundled workspace closure is
  // incomplete, and it names the exact package that is missing. Callers render a
  // null result as "must be a non-empty fingerprint", so that error has to reach
  // them. Only the traversal below tolerates failure, because a file removed
  // mid-walk genuinely means the inputs are not currently fingerprintable.
  const inputPaths = resolveHappyCliRuntimeInputPaths({ cliDir, includeShippedFiles });
  try {
    for (const path of inputPaths) await visit(path);
  } catch {
    return null;
  }
  return {
    fingerprint: fingerprint.digest('hex'),
    newestMtimeNs,
  };
}

export function happyCliRuntimeInputFreshnessEqual(left, right) {
  return left?.fingerprint === right?.fingerprint;
}
