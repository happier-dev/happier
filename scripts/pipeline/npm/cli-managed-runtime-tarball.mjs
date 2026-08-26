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

/**
 * Validates the real npm tarball at the one publication boundary shared by
 * release preparation and publication admission. Source checkouts deliberately
 * do not carry the generated Go runtime archives, so this must never become a
 * prerequisite for ordinary developer packs.
 *
 * @param {string} tarballPath
 */
export function assertCliManagedRuntimeTarballPublication(tarballPath) {
  let listedEntries;
  try {
    listedEntries = String(execFileSync('tar', ['-tzf', tarballPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[npm-publish] Unable to inspect CLI tarball contents: ${message}`);
  }

  const entries = String(listedEntries ?? '')
    .split(/\r?\n/u)
    .map((entry) => entry.trim().replaceAll('\\', '/').replace(/^(?:\.\/)+/u, '').replace(/\/+$/u, ''))
    .filter(Boolean);
  const entryCounts = new Map();
  for (const entry of entries) {
    entryCounts.set(entry, (entryCounts.get(entry) ?? 0) + 1);
  }
  const entryCount = (entryPath) => entryCounts.get(entryPath) ?? 0;
  const unpackedPrefix = `${TAR_PACKAGE_ROOT}/tools/unpacked`;
  if (entries.some((entry) => entry === unpackedPrefix || entry.startsWith(`${unpackedPrefix}/`))) {
    throw new Error('[npm-publish] CLI tarball must not contain tools/unpacked runtime content; publish checksummed tools/archives only');
  }

  const archivesPrefix = `${TAR_PACKAGE_ROOT}/tools/archives`;
  const checksumPath = `${archivesPrefix}/${RUNTIME_ASSET_CHECKSUM_MANIFEST_NAME}`;
  if (entryCount(checksumPath) !== 1) {
    throw new Error(`[npm-publish] CLI tarball must contain exactly one ${checksumPath}`);
  }

  let checksums;
  try {
    const rawChecksumManifest = execFileSync('tar', ['-xOf', tarballPath, checksumPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    checksums = parseChecksumManifestContents(String(rawChecksumManifest));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[npm-publish] Unable to read CLI runtime archive checksum inventory: ${message}`);
  }

  for (const runtimeAsset of getCliRuntimeAssetArchiveManifest()) {
    const archivePath = `${archivesPrefix}/${runtimeAsset.archiveName}`;
    if (entryCount(archivePath) !== 1) {
      throw new Error(
        `[npm-publish] CLI tarball is missing exactly one managed runtime archive for ${runtimeAsset.platformDir}: ${runtimeAsset.archiveName}`,
      );
    }
    const expectedChecksum = checksums?.get(runtimeAsset.archiveName);
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
      throw new Error(
        `[npm-publish] CLI managed runtime archive checksum mismatch for ${runtimeAsset.archiveName} `
        + `(recorded ${expectedChecksum}, actual ${actualChecksum})`,
      );
    }
  }
}
