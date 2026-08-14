import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { CLI_RUNTIME_SIDECAR_ENTRIES } from './cliRuntimeSidecars.mjs';
import cliDistBuildManifest from './cliDistBuildManifest.cjs';

export const PINNED_RUNNER_LAYOUT_VERSION = 'package-dist-v4';
export const PINNED_RUNNER_MANAGED_PROVIDER_RUNTIME_RELATIVE_PATH = Object.freeze([
  'tools',
  'unpacked',
  `happier-cliproxyapi-managed${process.platform === 'win32' ? '.exe' : ''}`,
]);
export const PINNED_RUNNER_NO_MANAGED_PROVIDER_RUNTIME_SHA256 = createHash('sha256')
  .update('happier:pinned-runner:no-managed-provider-runtime:v1')
  .digest('hex');

const SNAPSHOT_IDENTITY_PATTERN = new RegExp(
  `^([a-f0-9]{16})-([a-f0-9]{64})-([a-f0-9]{64})-${PINNED_RUNNER_LAYOUT_VERSION}$`,
  'u',
);
const PINNED_RUNNER_REQUIRED_ASSET_RELATIVE_PATHS = [
  ...CLI_RUNTIME_SIDECAR_ENTRIES.map((relativePath) => ['scripts', ...relativePath]),
  ['tools', 'unpacked'],
];

function isRelativePathInsideRoot(relativePath) {
  return Boolean(
    relativePath
      && relativePath !== '..'
      && !relativePath.startsWith('../')
      && !relativePath.startsWith('..\\')
      && !relativePath.startsWith('/')
      && !relativePath.startsWith('\\'),
  );
}

function readReadyMarker(snapshotRoot, fingerprint, workspaceRuntimeIdentity) {
  try {
    return (
      readFileSync(join(snapshotRoot, '.fingerprint'), 'utf8').trim() === fingerprint
      && readFileSync(join(snapshotRoot, '.workspace-runtime-identity'), 'utf8').trim()
        === workspaceRuntimeIdentity
    );
  } catch {
    return false;
  }
}

export function isPinnedRunnerSnapshotStructurallyReady(location) {
  if (
    !readReadyMarker(
      location.snapshotRoot,
      location.fingerprint,
      location.workspaceRuntimeIdentity,
    )
    || !existsSync(location.snapshotEntrypoint)
  ) {
    return false;
  }
  const manifest = cliDistBuildManifest.readCliDistBuildManifest(location.snapshotEntrypoint);
  if (!manifest.ok || manifest.fingerprint !== location.fingerprint) return false;
  return cliDistBuildManifest.readCliDistClosure(location.snapshotEntrypoint, {
    outputDir: dirname(location.snapshotEntrypoint),
  }).ok === true;
}

function hasPinnedRunnerSnapshotRuntimeAssets(snapshotRoot) {
  return PINNED_RUNNER_REQUIRED_ASSET_RELATIVE_PATHS.every((relativePath) => (
    existsSync(join(snapshotRoot, ...relativePath))
  ));
}

export function resolvePinnedRunnerSnapshotManagedProviderRuntimeIdentity({
  entrypoint,
  runtimeRoot,
  manifest = {},
} = {}) {
  if (manifest?.runtimeAsset === undefined) {
    return PINNED_RUNNER_NO_MANAGED_PROVIDER_RUNTIME_SHA256;
  }
  const integrity = cliDistBuildManifest.readCliRuntimeAssetIntegrity({
    runtimeRoot,
    relativePath: PINNED_RUNNER_MANAGED_PROVIDER_RUNTIME_RELATIVE_PATH.join('/'),
    entrypoint,
  });
  const runtimeAssetSha256 = String(integrity.expected?.sha256 ?? '').trim().toLowerCase();
  return integrity.ok === true && /^[a-f0-9]{64}$/u.test(runtimeAssetSha256)
    ? runtimeAssetSha256
    : null;
}

// This is the canonical runnable decision. A snapshot may have a valid immutable dist closure
// but still be unable to serve daemon subprocesses without its runtime sidecars or recorded
// managed provider runtime.
export function isPinnedRunnerSnapshotReady(location) {
  if (
    !isPinnedRunnerSnapshotStructurallyReady(location)
    || !hasPinnedRunnerSnapshotRuntimeAssets(location.snapshotRoot)
  ) {
    return false;
  }
  const manifest = cliDistBuildManifest.readCliDistBuildManifest(location.snapshotEntrypoint);
  if (!manifest.ok || manifest.fingerprint !== location.fingerprint) return false;
  return resolvePinnedRunnerSnapshotManagedProviderRuntimeIdentity({
    entrypoint: location.snapshotEntrypoint,
    runtimeRoot: location.snapshotRoot,
    manifest: manifest.manifest ?? {},
  }) === location.runtimeAssetIdentity;
}

export function listReadyPinnedRunnerSnapshots(
  entrypoint,
  { fingerprint = null, validateSnapshot = null, snapshotsDir: snapshotsDirOverride = null } = {},
) {
  const distRoot = dirname(entrypoint);
  const entrypointRelativePath = relative(distRoot, entrypoint);
  if (!isRelativePathInsideRoot(entrypointRelativePath)) return [];
  const snapshotsDir = typeof snapshotsDirOverride === 'string' && snapshotsDirOverride.trim()
    ? snapshotsDirOverride.trim()
    : join(dirname(distRoot), '.runner-snapshots');
  let entries;
  try {
    entries = readdirSync(snapshotsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const requiredFingerprint = String(fingerprint ?? '').trim().toLowerCase();
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const match = SNAPSHOT_IDENTITY_PATTERN.exec(entry.name);
      if (!match) return null;
      const [, candidateFingerprint, runtimeAssetIdentity, workspaceRuntimeIdentity] = match;
      if (requiredFingerprint && candidateFingerprint !== requiredFingerprint) return null;
      const snapshotRoot = join(snapshotsDir, entry.name);
      const location = {
        snapshotsDir,
        snapshotIdentity: entry.name,
        snapshotRoot,
        snapshotEntrypoint: join(snapshotRoot, 'package-dist', entrypointRelativePath),
        fingerprint: candidateFingerprint,
        runtimeAssetIdentity,
        workspaceRuntimeIdentity,
      };
      if (!isPinnedRunnerSnapshotReady(location)) return null;
      if (typeof validateSnapshot === 'function' && validateSnapshot(location) !== true) return null;
      let mtimeMs = 0;
      try {
        mtimeMs = Number(statSync(snapshotRoot).mtimeMs) || 0;
      } catch {
        mtimeMs = 0;
      }
      return { location, mtimeMs };
    })
    .filter((candidate) => candidate !== null);
}

export function resolveNewestReadyPinnedRunnerSnapshot(entrypoint, options = {}) {
  const candidates = listReadyPinnedRunnerSnapshots(entrypoint, options)
    .sort((left, right) => (
      right.mtimeMs - left.mtimeMs
      || left.location.snapshotIdentity.localeCompare(right.location.snapshotIdentity)
    ));
  return candidates[0]?.location ?? null;
}
