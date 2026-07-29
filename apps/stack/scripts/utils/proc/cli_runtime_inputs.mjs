import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { resolveWorkspaceBundlesFromPackageJson } from '@happier-dev/cli-common/workspaces';
import { isDevRuntimeReloadIgnoredPath } from '../dev/watchSignature.mjs';

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
      paths: [
        join(dir, 'src'),
        join(dir, 'package.json'),
        join(dir, 'tsconfig.json'),
        join(dir, 'tsconfig.build.json'),
      ],
    })),
  ];

  return groups
    .map((group) => ({ ...group, paths: group.paths.filter((path) => existsSyncImpl(path)) }))
    .filter((group) => group.paths.length > 0);
}

export function resolveHappyCliRuntimeInputPaths(options) {
  return resolveHappyCliRuntimeInputGroups(options).flatMap((group) => group.paths);
}

export async function readHappyCliRuntimeInputFreshness(cliDir) {
  let newestMtimeNs = null;
  const fingerprint = createHash('sha256');
  const visit = async (path) => {
    if (isDevRuntimeReloadIgnoredPath(path)) return;
    let fileStat;
    try {
      fileStat = await lstat(path, { bigint: true });
    } catch {
      return;
    }
    newestMtimeNs = newestMtimeNs === null || fileStat.mtimeNs > newestMtimeNs
      ? fileStat.mtimeNs
      : newestMtimeNs;
    const nodeType = fileStat.isDirectory() ? 'dir' : fileStat.isFile() ? 'file' : 'other';
    fingerprint.update(path);
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
    fingerprint.update(String(fileStat.mtimeNs));
    fingerprint.update('\0');
    // A same-size rewrite can restore mtime (for example, by a preserving copy)
    // while still changing the runtime bytes. ctime remains an inexpensive
    // owner-local identity signal for that replacement without hashing the
    // complete CLI source closure on every stack currentness check.
    fingerprint.update(String(fileStat.ctimeNs));
    fingerprint.update('\0');
  };

  try {
    for (const path of resolveHappyCliRuntimeInputPaths({ cliDir })) await visit(path);
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
