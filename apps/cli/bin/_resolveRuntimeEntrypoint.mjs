import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { isJsonOwnerBuildLockActive } = require(resolveCliCommonBootstrapModulePath(
  'jsonOwnerBuildLockState.cjs',
  '@happier-dev/cli-common/jsonOwnerBuildLockState',
));
const cliDistBuildManifest = require(resolveCliCommonBootstrapModulePath(
  'cliDistBuildManifest.cjs',
  '@happier-dev/cli-common/cliDistBuildManifest',
));

export const CLI_DIST_BUILD_MANIFEST = cliDistBuildManifest.CLI_DIST_BUILD_MANIFEST;

function resolveCliCommonBootstrapModulePath(sourceFileName, packageExport) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const sourcePath = resolve(repoRoot, 'packages', 'cli-common', sourceFileName);
  const isRepoSource = existsSync(resolve(repoRoot, 'package.json')) && existsSync(resolve(repoRoot, 'yarn.lock'));
  return isRepoSource && existsSync(sourcePath) ? sourcePath : packageExport;
}

function runtimeEntrypointCandidates(projectRoot, relativePath) {
  return [
    { outputDir: join(projectRoot, 'dist'), entrypoint: join(projectRoot, 'dist', relativePath) },
    { outputDir: join(projectRoot, 'package-dist'), entrypoint: join(projectRoot, 'package-dist', relativePath) },
    {
      outputDir: join(projectRoot, '.dist.hstack-backup'),
      entrypoint: join(projectRoot, '.dist.hstack-backup', relativePath),
    },
  ];
}

export function readRuntimeSnapshotBuildManifest(entrypoint, outputDir) {
  const integrity = cliDistBuildManifest.readCliDistBuildManifest(entrypoint, { outputDir });
  return integrity.ok ? integrity.manifest : null;
}

export function resolveValidRuntimeSnapshot(projectRoot, relativePath) {
  for (const candidate of runtimeEntrypointCandidates(projectRoot, relativePath)) {
    const manifest = readRuntimeSnapshotBuildManifest(candidate.entrypoint, candidate.outputDir);
    if (manifest) return { ...candidate, manifest };
  }
  return null;
}

export function resolveValidRuntimeEntrypoint(projectRoot, relativePath) {
  return resolveValidRuntimeSnapshot(projectRoot, relativePath)?.entrypoint ?? null;
}

export function isReachableImportClosureComplete(outputDir, entrypointPath) {
  return cliDistBuildManifest.readCliDistClosureFingerprint(entrypointPath, { outputDir }).ok;
}

function findRepoRoot(projectRoot) {
  let dir = resolve(projectRoot);
  for (let index = 0; index < 5; index += 1) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'yarn.lock'))) {
      return dir;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(projectRoot, '..', '..');
}

function isAnyCliDistBuildLockActive(projectRoot) {
  const repoRoot = findRepoRoot(projectRoot);
  const candidates = [
    join(repoRoot, '.project', 'tmp', 'cli-dist-build.lock'),
    join(projectRoot, '.dist.hstack-build.lock'),
  ];
  return candidates.some((candidate) => isJsonOwnerBuildLockActive(candidate));
}

export function resolveRuntimeEntrypoint(projectRoot, relativePath) {
  const validSnapshot = resolveValidRuntimeSnapshot(projectRoot, relativePath);
  if (validSnapshot) return validSnapshot.entrypoint;

  // Published packages created before the build-manifest corridor retain the legacy
  // closure-aware selection path. Repo-local preparation requires a manifest-backed snapshot.
  const [distCandidate, packageDistCandidate, backupCandidate] = runtimeEntrypointCandidates(projectRoot, relativePath);
  const activeDistBuildLock = isAnyCliDistBuildLockActive(projectRoot);
  const shouldPreferBackup =
    existsSync(backupCandidate.entrypoint)
    && (
      activeDistBuildLock
      || !isReachableImportClosureComplete(distCandidate.outputDir, distCandidate.entrypoint)
    );
  const candidates = shouldPreferBackup
    ? [backupCandidate, distCandidate, packageDistCandidate]
    : [distCandidate, packageDistCandidate, backupCandidate];

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!existsSync(candidate.entrypoint)) continue;

    const hasExistingFallback = candidates.slice(index + 1).some((fallback) => existsSync(fallback.entrypoint));
    if (!hasExistingFallback || isReachableImportClosureComplete(candidate.outputDir, candidate.entrypoint)) {
      return candidate.entrypoint;
    }
  }

  return join(projectRoot, 'dist', relativePath);
}
