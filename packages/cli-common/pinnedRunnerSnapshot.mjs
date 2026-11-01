import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { findUnservableBundledPluginPackageResources } from './bundledPluginResources.mjs';
import { CLI_RUNTIME_SIDECAR_ENTRIES } from './cliRuntimeSidecars.mjs';
import { assertHostCanExcludeBundledPlugin, BUNDLED_PLUGIN_PUBLICATION_FAILURES_RELATIVE_PATH, parseBundledPluginPublicationFailures } from './bundledPluginPublicationPolicy.mjs';
import cliDistBuildManifest from './cliDistBuildManifest.cjs';

export const PINNED_RUNNER_LAYOUT_VERSION = 'package-dist-v7';
export const PINNED_RUNNER_MANAGED_PROVIDER_RUNTIME_RELATIVE_PATH = Object.freeze([
  'tools',
  'unpacked',
  `happier-cliproxyapi-managed${process.platform === 'win32' ? '.exe' : ''}`,
]);
export const PINNED_RUNNER_NO_MANAGED_PROVIDER_RUNTIME_SHA256 = createHash('sha256')
  .update('happier:pinned-runner:no-managed-provider-runtime:v1')
  .digest('hex');

const SNAPSHOT_IDENTITY_PATTERN = new RegExp(
  `^([a-f0-9]{16})-([a-f0-9]{64})-([a-f0-9]{64})-([a-f0-9]{64})-${PINNED_RUNNER_LAYOUT_VERSION}$`,
  'u',
);
const PINNED_RUNNER_REQUIRED_ASSET_RELATIVE_PATHS = [
  ['package.json'],
  ...CLI_RUNTIME_SIDECAR_ENTRIES.map((relativePath) => ['scripts', ...relativePath]),
  ['tools', 'unpacked'],
  [BUNDLED_PLUGIN_PUBLICATION_FAILURES_RELATIVE_PATH],
];

function readPinnedRunnerSnapshotPublicationState(runtimeRoot) {
  try {
    const bytes = readFileSync(join(runtimeRoot, BUNDLED_PLUGIN_PUBLICATION_FAILURES_RELATIVE_PATH));
    const failures = parseBundledPluginPublicationFailures(bytes.toString('utf8'));
    for (const failure of failures) assertHostCanExcludeBundledPlugin('', failure.packageName, new Error(failure.diagnostic.message));
    return { identity: createHash('sha256').update(bytes).digest('hex'), failures };
  } catch {
    // Absent or invalid publication state supplies no healthy-plugin claim.
    return null;
  }
}

export function readPinnedRunnerSnapshotPublicationIdentity(runtimeRoot) {
  return readPinnedRunnerSnapshotPublicationState(runtimeRoot)?.identity ?? null;
}

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

function explainPinnedRunnerSnapshotStructuralUnreadiness(location) {
  if (
    !readReadyMarker(
      location.snapshotRoot,
      location.fingerprint,
      location.workspaceRuntimeIdentity,
    )
  ) {
    return 'its .fingerprint / .workspace-runtime-identity markers do not match the admitted closure';
  }
  if (!existsSync(location.snapshotEntrypoint)) {
    return `its entrypoint is missing: ${location.snapshotEntrypoint}`;
  }
  const manifest = cliDistBuildManifest.readCliDistBuildManifest(location.snapshotEntrypoint);
  if (!manifest.ok || manifest.fingerprint !== location.fingerprint) {
    return `its dist build manifest does not record fingerprint ${location.fingerprint}`;
  }
  return cliDistBuildManifest.readCliDistClosure(location.snapshotEntrypoint, {
    outputDir: dirname(location.snapshotEntrypoint),
  }).ok === true
    ? null
    : 'its immutable dist closure is incomplete';
}

export function isPinnedRunnerSnapshotStructurallyReady(location) {
  return explainPinnedRunnerSnapshotStructuralUnreadiness(location) === null;
}

function findPinnedRunnerSnapshotMissingRuntimeAssets(snapshotRoot) {
  return PINNED_RUNNER_REQUIRED_ASSET_RELATIVE_PATHS
    .filter((relativePath) => !existsSync(join(snapshotRoot, ...relativePath)))
    .map((relativePath) => relativePath.join('/'));
}

function findPinnedRunnerSnapshotPluginResourceProblems(snapshotRoot, failures) {
  const failedPackageNames = new Set(failures.map((failure) => failure.packageName));
  const packageScopeRoot = join(snapshotRoot, 'node_modules', '@happier-dev');
  let packageEntries;
  try {
    packageEntries = readdirSync(packageScopeRoot, { withFileTypes: true });
  } catch {
    // Minimal test fixtures and runners without bundled workspace dependencies have no scope.
    return [];
  }

  const problems = [];
  for (const packageEntry of packageEntries) {
    if (!packageEntry.isDirectory() || !packageEntry.name.startsWith('plugins-')) continue;
    if (failedPackageNames.has(`@happier-dev/${packageEntry.name}`)) continue;
    const packageRoot = join(packageScopeRoot, packageEntry.name);
    for (const problem of findUnservableBundledPluginPackageResources(packageRoot)) {
      problems.push(`@happier-dev/${packageEntry.name}/${problem}`);
    }
  }
  return problems;
}

export function resolvePinnedRunnerSnapshotManagedProviderRuntimeIdentity({
  entrypoint,
  runtimeRoot,
  manifest = {},
} = {}) {
  if (manifest?.runtimeAsset === undefined && manifest?.runtimeAssets === undefined) {
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
//
// It reports *why* rather than only *that* it refuses: every refusal here surfaces to an
// operator as one typed immutable-closure error, and each cause names a precisely knowable
// condition — an absent file, a recorded identity — that is otherwise unrecoverable from the
// error alone.
export function explainPinnedRunnerSnapshotUnreadiness(location) {
  const structural = explainPinnedRunnerSnapshotStructuralUnreadiness(location);
  if (structural) return structural;

  const missingRuntimeAssets = findPinnedRunnerSnapshotMissingRuntimeAssets(location.snapshotRoot);
  if (missingRuntimeAssets.length > 0) {
    return `it is missing required runtime assets: ${missingRuntimeAssets.join(', ')}`;
  }

  const publicationIdentity = SNAPSHOT_IDENTITY_PATTERN.exec(location.snapshotIdentity)?.[4];
  const publication = readPinnedRunnerSnapshotPublicationState(location.snapshotRoot);
  if (!publicationIdentity || publication?.identity !== publicationIdentity) {
    return 'its bundled plugin publication state is unknown or differs from its pinned identity';
  }

  const pluginResourceProblems = findPinnedRunnerSnapshotPluginResourceProblems(
    location.snapshotRoot,
    publication.failures,
  );
  if (pluginResourceProblems.length > 0) {
    return [
      'it cannot serve plugin resources its own bundled manifests declare:',
      ...pluginResourceProblems.map((problem) => `  - ${problem}`),
    ].join('\n');
  }

  const manifest = cliDistBuildManifest.readCliDistBuildManifest(location.snapshotEntrypoint);
  if (!manifest.ok || manifest.fingerprint !== location.fingerprint) {
    return `its dist build manifest does not record fingerprint ${location.fingerprint}`;
  }
  const runtimeAssetIdentity = resolvePinnedRunnerSnapshotManagedProviderRuntimeIdentity({
    entrypoint: location.snapshotEntrypoint,
    runtimeRoot: location.snapshotRoot,
    manifest: manifest.manifest ?? {},
  });
  return runtimeAssetIdentity === location.runtimeAssetIdentity
    ? null
    : `its managed provider runtime identity is ${runtimeAssetIdentity ?? 'unreadable'}, `
      + `not the admitted ${location.runtimeAssetIdentity}`;
}

export function isPinnedRunnerSnapshotReady(location) {
  return explainPinnedRunnerSnapshotUnreadiness(location) === null;
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
      const location = resolvePublishedPinnedRunnerSnapshotById(entrypoint, entry.name, { snapshotsDir });
      if (!location || (requiredFingerprint && location.fingerprint !== requiredFingerprint)) return null;
      if (!isPinnedRunnerSnapshotReady(location)) return null;
      if (typeof validateSnapshot === 'function' && validateSnapshot(location) !== true) return null;
      let mtimeMs = 0;
      try {
        mtimeMs = Number(statSync(location.snapshotRoot).mtimeMs) || 0;
      } catch {
        mtimeMs = 0;
      }
      return { location, mtimeMs };
    })
    .filter((candidate) => candidate !== null);
}

/** Resolve an exact atomically published snapshot without rehashing its full closure. */
export function resolvePublishedPinnedRunnerSnapshotById(
  entrypoint,
  snapshotId,
  { snapshotsDir: snapshotsDirOverride = null } = {},
) {
  const distRoot = dirname(entrypoint);
  const entrypointRelativePath = relative(distRoot, entrypoint);
  if (!isRelativePathInsideRoot(entrypointRelativePath)) return null;
  const snapshotsDir = typeof snapshotsDirOverride === 'string' && snapshotsDirOverride.trim()
    ? snapshotsDirOverride.trim()
    : join(dirname(distRoot), '.runner-snapshots');
  const match = SNAPSHOT_IDENTITY_PATTERN.exec(snapshotId);
  if (!match) return null;
  const [, fingerprint, runtimeAssetIdentity, workspaceRuntimeIdentity] = match;
  const snapshotRoot = join(snapshotsDir, snapshotId);
  const location = {
    snapshotsDir,
    snapshotIdentity: snapshotId,
    snapshotRoot,
    snapshotEntrypoint: join(snapshotRoot, 'package-dist', entrypointRelativePath),
    fingerprint,
    runtimeAssetIdentity,
    workspaceRuntimeIdentity,
  };
  return readReadyMarker(snapshotRoot, fingerprint, workspaceRuntimeIdentity)
    && existsSync(location.snapshotEntrypoint)
    ? location
    : null;
}

export function resolveNewestReadyPinnedRunnerSnapshot(entrypoint, options = {}) {
  const candidates = listReadyPinnedRunnerSnapshots(entrypoint, options)
    .sort((left, right) => (
      right.mtimeMs - left.mtimeMs
      || left.location.snapshotIdentity.localeCompare(right.location.snapshotIdentity)
    ));
  return candidates[0]?.location ?? null;
}
