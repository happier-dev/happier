// @ts-check

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const requireFromScript = createRequire(import.meta.url);
const {
  getCliRuntimeAssetArchiveManifest,
  parseChecksumManifestContents,
  RUNTIME_ASSET_CHECKSUM_MANIFEST_NAME,
} = requireFromScript('../../../apps/cli/scripts/unpack-tools.cjs');

const TAR_PACKAGE_ROOT = 'package';
const MANAGED_RUNTIME_ARCHIVE_PREFIX = 'happier-cliproxyapi-managed-';

function inspectCliManagedRuntimeTarball(tarballPath) {
  let entries;
  try {
    entries = String(execFileSync('tar', ['-tzf', tarballPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    }))
      .split(/\r?\n/u)
      .map((entry) => entry.trim().replaceAll('\\', '/').replace(/^(?:\.\/)+/u, '').replace(/\/+$/u, ''))
      .filter(Boolean);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[npm-publish] Unable to inspect CLI tarball contents: ${message}`);
  }
  const entryCounts = new Map();
  for (const entry of entries) entryCounts.set(entry, (entryCounts.get(entry) ?? 0) + 1);
  const entryCount = (entryPath) => entryCounts.get(entryPath) ?? 0;
  const packageJsonPath = `${TAR_PACKAGE_ROOT}/package.json`;
  if (entryCount(packageJsonPath) !== 1) {
    throw new Error(`[npm-publish] CLI tarball must contain exactly one ${packageJsonPath}`);
  }
  let metadata;
  try {
    const packageJson = JSON.parse(String(execFileSync('tar', ['-xOf', tarballPath, packageJsonPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    })));
    metadata = packageJson?.happier?.managedRuntimePublication;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[npm-publish] Unable to read CLI managed runtime publication metadata: ${message}`);
  }
  return { entries, entryCount, metadata };
}

function expectedUnavailableProviderRefs(runtimeAssets) {
  const refs = [];
  const seen = new Set();
  for (const runtimeAsset of runtimeAssets) {
    const pluginId = String(runtimeAsset?.managedProviderRef?.pluginId ?? '').trim();
    const providerId = String(runtimeAsset?.managedProviderRef?.providerId ?? '').trim();
    if (!pluginId || !providerId) {
      throw new Error(`[npm-publish] Runtime asset '${String(runtimeAsset?.asset ?? runtimeAsset?.archiveName ?? '')}' has no managed provider reference`);
    }
    const key = `${pluginId}\u0000${providerId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ pluginId, providerId });
  }
  return refs;
}

function validatePublicationMetadata(metadata) {
  if (
    !metadata
    || typeof metadata !== 'object'
    || Array.isArray(metadata)
    || metadata.v !== 1
    || (metadata.mode !== 'complete' && metadata.mode !== 'source-only')
    || !Array.isArray(metadata.unavailableProviderRefs)
    || Object.keys(metadata).sort().join(',') !== 'mode,unavailableProviderRefs,v'
  ) {
    throw new Error('[npm-publish] CLI managed runtime tarball must carry exact publication metadata');
  }
  const seen = new Set();
  for (const ref of metadata.unavailableProviderRefs) {
    if (
      !ref
      || typeof ref !== 'object'
      || Array.isArray(ref)
      || Object.keys(ref).sort().join(',') !== 'pluginId,providerId'
      || typeof ref.pluginId !== 'string'
      || ref.pluginId.trim() !== ref.pluginId
      || !ref.pluginId
      || typeof ref.providerId !== 'string'
      || ref.providerId.trim() !== ref.providerId
      || !ref.providerId
    ) {
      throw new Error('[npm-publish] CLI managed runtime unavailable Provider references must be exact');
    }
    const key = `${ref.pluginId}\u0000${ref.providerId}`;
    if (seen.has(key)) {
      throw new Error('[npm-publish] CLI managed runtime unavailable Provider references must not contain duplicates');
    }
    seen.add(key);
  }
  return metadata;
}

function assertNoUnpackedRuntime(entries) {
  const unpackedPrefix = `${TAR_PACKAGE_ROOT}/tools/unpacked`;
  if (entries.some((entry) => entry === unpackedPrefix || entry.startsWith(`${unpackedPrefix}/`))) {
    throw new Error('[npm-publish] CLI tarball must not contain tools/unpacked runtime content; publish checksummed tools/archives only');
  }
}

function assertSourceOnlyTarball({ entries, entryCount, metadata }, runtimeAssets) {
  const expectedRefs = expectedUnavailableProviderRefs(runtimeAssets);
  if (
    metadata.unavailableProviderRefs.length !== expectedRefs.length
    || metadata.unavailableProviderRefs.some((ref, index) => (
      ref.pluginId !== expectedRefs[index]?.pluginId
      || ref.providerId !== expectedRefs[index]?.providerId
    ))
  ) {
    throw new Error('[npm-publish] Source-only CLI tarball must name the exact unavailable managed Provider references');
  }
  const archivesPrefix = `${TAR_PACKAGE_ROOT}/tools/archives`;
  const checksumPath = `${archivesPrefix}/${RUNTIME_ASSET_CHECKSUM_MANIFEST_NAME}`;
  if (entryCount(checksumPath) !== 0) {
    throw new Error('[npm-publish] Source-only CLI tarball must not contain the managed runtime checksum manifest');
  }
  const managedPrefix = `${archivesPrefix}/${MANAGED_RUNTIME_ARCHIVE_PREFIX}`;
  const managedArchives = entries.filter((entry) => entry.startsWith(managedPrefix));
  if (managedArchives.length > 0) {
    throw new Error(`[npm-publish] Source-only CLI tarball must not contain managed runtime archives: ${managedArchives.join(', ')}`);
  }
}

function assertCompleteTarball(tarballPath, { entries, entryCount, metadata }, runtimeAssets) {
  if (metadata.mode !== 'complete' || metadata.unavailableProviderRefs.length !== 0) {
    throw new Error('[npm-publish] Complete CLI managed runtime tarball must carry exact complete publication metadata');
  }
  const archivesPrefix = `${TAR_PACKAGE_ROOT}/tools/archives`;
  const checksumPath = `${archivesPrefix}/${RUNTIME_ASSET_CHECKSUM_MANIFEST_NAME}`;
  if (entryCount(checksumPath) !== 1) {
    throw new Error(`[npm-publish] CLI tarball must contain exactly one ${checksumPath}`);
  }
  let checksums;
  try {
    checksums = parseChecksumManifestContents(String(execFileSync('tar', ['-xOf', tarballPath, checksumPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    })));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[npm-publish] Unable to read CLI runtime archive checksum inventory: ${message}`);
  }
  const expectedArchiveNames = new Set(runtimeAssets.map((runtimeAsset) => runtimeAsset.archiveName));
  const unexpectedChecksumNames = [...checksums.keys()].filter((name) => !expectedArchiveNames.has(name)).sort();
  if (unexpectedChecksumNames.length > 0) {
    throw new Error(`[npm-publish] CLI runtime archive checksum inventory contains unexpected entries: ${unexpectedChecksumNames.join(', ')}`);
  }
  const runtimeArchivePrefix = `${archivesPrefix}/${MANAGED_RUNTIME_ARCHIVE_PREFIX}`;
  const unexpectedRuntimeArchives = entries
    .filter((entry) => entry.startsWith(runtimeArchivePrefix) && !expectedArchiveNames.has(entry.slice(archivesPrefix.length + 1)))
    .sort();
  if (unexpectedRuntimeArchives.length > 0) {
    throw new Error(`[npm-publish] CLI tarball contains unexpected managed runtime archives: ${unexpectedRuntimeArchives.join(', ')}`);
  }
  for (const runtimeAsset of runtimeAssets) {
    const archivePath = `${archivesPrefix}/${runtimeAsset.archiveName}`;
    if (entryCount(archivePath) !== 1) {
      throw new Error(`[npm-publish] CLI tarball is missing exactly one managed runtime archive for ${runtimeAsset.platformDir}: ${runtimeAsset.archiveName}`);
    }
    const expectedChecksum = checksums.get(runtimeAsset.archiveName);
    if (!expectedChecksum) {
      throw new Error(`[npm-publish] CLI tarball is missing a checksum inventory entry for ${runtimeAsset.archiveName}`);
    }
    let archiveBytes;
    try {
      archiveBytes = execFileSync('tar', ['-xOf', tarballPath, archivePath], {
        encoding: 'buffer',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`[npm-publish] Unable to read CLI managed runtime archive ${runtimeAsset.archiveName}: ${message}`);
    }
    const actualChecksum = crypto.createHash('sha256').update(archiveBytes).digest('hex');
    if (actualChecksum !== expectedChecksum) {
      throw new Error(`[npm-publish] CLI managed runtime archive checksum mismatch for ${runtimeAsset.archiveName} (recorded ${expectedChecksum}, actual ${actualChecksum})`);
    }
  }
}

/** Validates either honest source-only bytes or a complete installable archive set. */
export function assertCliManagedRuntimeTarballCoherence(tarballPath) {
  const inspected = inspectCliManagedRuntimeTarball(tarballPath);
  const metadata = validatePublicationMetadata(inspected.metadata);
  const runtimeAssets = getCliRuntimeAssetArchiveManifest();
  assertNoUnpackedRuntime(inspected.entries);
  if (metadata.mode === 'source-only') {
    assertSourceOnlyTarball({ ...inspected, metadata }, runtimeAssets);
    return;
  }
  assertCompleteTarball(tarballPath, { ...inspected, metadata }, runtimeAssets);
}

/** Validates the exact complete npm-publication artifact. Ordinary developer packs use the coherence assertion. */
export function assertCliManagedRuntimeTarballPublication(tarballPath) {
  const inspected = inspectCliManagedRuntimeTarball(tarballPath);
  const metadata = validatePublicationMetadata(inspected.metadata);
  const runtimeAssets = getCliRuntimeAssetArchiveManifest();
  assertNoUnpackedRuntime(inspected.entries);
  assertCompleteTarball(tarballPath, { ...inspected, metadata }, runtimeAssets);
}
