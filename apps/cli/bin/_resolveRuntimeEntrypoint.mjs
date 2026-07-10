import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLI_DIST_BUILD_MANIFEST = '.build-manifest.json';

const require = createRequire(import.meta.url);
const { isJsonOwnerBuildLockActive } = require(resolveJsonOwnerBuildLockStateModulePath());

function resolveJsonOwnerBuildLockStateModulePath() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const sourcePath = resolve(repoRoot, 'packages', 'cli-common', 'jsonOwnerBuildLockState.cjs');
  const isRepoSource = existsSync(resolve(repoRoot, 'package.json')) && existsSync(resolve(repoRoot, 'yarn.lock'));
  return isRepoSource && existsSync(sourcePath) ? sourcePath : '@happier-dev/cli-common/jsonOwnerBuildLockState';
}

function isWithinDirectory(candidatePath, directoryPath) {
  const relativePath = relative(directoryPath, candidatePath);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
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
  if (!entrypoint || !existsSync(entrypoint)) return null;

  try {
    const manifest = JSON.parse(readFileSync(join(outputDir, CLI_DIST_BUILD_MANIFEST), 'utf8'));
    const fingerprint = String(manifest?.fingerprint ?? '').trim();
    if (!/^[a-f0-9]{16}$/i.test(fingerprint)) return null;
    return manifest;
  } catch {
    return null;
  }
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

function collectRelativeImportSpecifiers(text) {
  const matches = text.matchAll(
    /(?:import|export)\s+(?:[^'"`]*?\s+from\s+)?["'](\.{1,2}\/[^"'`]+)["']|import\(\s*["'](\.{1,2}\/[^"'`]+)["']\s*\)|require\(\s*["'](\.{1,2}\/[^"'`]+)["']\s*\)/g,
  );

  const specifiers = new Set();
  for (const match of matches) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier) specifiers.add(specifier);
  }
  return Array.from(specifiers);
}

function resolveRelativeImport(outputDir, fromFilePath, specifier) {
  const basePath = resolve(dirname(fromFilePath), specifier);
  if (!isWithinDirectory(basePath, outputDir)) return null;

  const candidates = [
    basePath,
    `${basePath}.mjs`,
    `${basePath}.cjs`,
    join(basePath, 'index.mjs'),
    join(basePath, 'index.cjs'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return false;
}

export function isReachableImportClosureComplete(outputDir, entrypointPath) {
  const queue = [entrypointPath];
  const seen = new Set();

  while (queue.length > 0) {
    const nextPath = queue.shift();
    if (!nextPath || seen.has(nextPath)) continue;
    seen.add(nextPath);

    if (!isWithinDirectory(nextPath, outputDir)) continue;
    if (!existsSync(nextPath)) return false;
    if (!/\.(?:mjs|cjs)$/.test(nextPath)) continue;

    let text;
    try {
      text = readFileSync(nextPath, 'utf8');
    } catch {
      return false;
    }

    for (const specifier of collectRelativeImportSpecifiers(text)) {
      const resolvedImport = resolveRelativeImport(outputDir, nextPath, specifier);
      if (resolvedImport === false) return false;
      if (resolvedImport) queue.push(resolvedImport);
    }
  }

  return true;
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
