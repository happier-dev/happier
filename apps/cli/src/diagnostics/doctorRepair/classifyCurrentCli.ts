import { join } from 'node:path';

import packageJson from '../../../package.json';
import {
  readNpmDistTagVersion,
  readUpdateCache,
  resolveNpmPackageNameOverride,
  writeUpdateCache,
} from '@happier-dev/cli-common/update';
import type { PublicReleaseRingLabel } from '@happier-dev/release-runtime/releaseRings';

import { configuration } from '@/configuration';

import { semverLessThan } from './_shared';
import { withTimeout } from './_updateCheck';
import type { CliSelfUpdateAvailable, RepairFinding } from './types';

/**
 * Detect whether a newer CLI is published on the user's release channel.
 *
 * Mechanism:
 *  - `@happier-dev/cli` is distributed via npm, so the canonical "latest for
 *    channel" source is the npm dist-tag (`latest` for stable, `next`
 *    otherwise). This matches what `happier self check` / `happier self update`
 *    use.
 *  - Result is cached in the SAME `~/.happier/cache/update{.channel}.json`
 *    file used by the background auto-update notice — no parallel cache.
 *  - During `doctor repair` we prefer a live refresh (`forceRefresh: true`)
 *    so the user sees the current state, not a stale hint. The network call
 *    is bounded by a short timeout and falls back to the cache on failure.
 */
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const DEFAULT_FETCH_TIMEOUT_MS = 2_500;

function cliUpdateCacheFilePath(channel: PublicReleaseRingLabel): string {
  const fileName = channel === 'stable' ? 'update.json' : `update.${channel}.json`;
  return join(configuration.happyHomeDir, 'cache', fileName);
}

function cliNpmDistTag(channel: PublicReleaseRingLabel): 'latest' | 'next' {
  return channel === 'stable' ? 'latest' : 'next';
}

function cliUpdatePackageName(): string {
  return resolveNpmPackageNameOverride({
    envValue: process.env.HAPPIER_CLI_UPDATE_PACKAGE_NAME,
    fallback: String((packageJson as { name?: unknown }).name ?? '').trim(),
  });
}

async function readLatestCliVersion(
  channel: PublicReleaseRingLabel,
  opts: Readonly<{ forceRefresh?: boolean; maxAgeMs?: number; fetchTimeoutMs?: number }>,
): Promise<string | null> {
  const maxAge = opts.maxAgeMs ?? DEFAULT_CACHE_TTL_MS;
  const cachePath = cliUpdateCacheFilePath(channel);
  const cache = readUpdateCache(cachePath);
  const checkedAt = cache?.checkedAt ?? 0;
  const cached = cache?.latest ?? null;

  const cacheFresh = cached !== null && checkedAt > 0 && Date.now() - checkedAt < maxAge;
  if (cacheFresh && !opts.forceRefresh) return cached;

  const pkgName = cliUpdatePackageName();
  if (!pkgName) return cached;
  const distTag = cliNpmDistTag(channel);

  const latest = await withTimeout(
    Promise.resolve().then(() => readNpmDistTagVersion({
      packageName: pkgName,
      distTag,
      cwd: process.cwd(),
      env: process.env,
    })),
    opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
  );

  if (latest) {
    writeUpdateCache(cachePath, {
      checkedAt: Date.now(),
      latest,
      current: cache?.current ?? null,
      runtimeVersion: cache?.runtimeVersion ?? null,
      invokerVersion: cache?.invokerVersion ?? null,
      updateAvailable: true,
      notifiedAt: cache?.notifiedAt ?? null,
    });
    return latest;
  }
  return cached;
}

export async function classifyCurrentCli(params: Readonly<{
  currentCliReleaseChannel: PublicReleaseRingLabel;
  currentCliVersion: string;
  forceRefresh?: boolean;
  onMigration?: boolean;
}>): Promise<readonly RepairFinding[]> {
  const latest = await readLatestCliVersion(params.currentCliReleaseChannel, {
    forceRefresh: params.forceRefresh,
  });
  if (!latest || !params.currentCliVersion) return [];
  if (!semverLessThan(params.currentCliVersion, latest)) return [];

  const finding: CliSelfUpdateAvailable = {
    kind: 'cli_self_update_available',
    severity: 'info',
    // Self-update is material; users should always confirm. Never auto-apply.
    autoApplyWithoutPrompt: false,
    releaseChannel: params.currentCliReleaseChannel,
    currentVersion: params.currentCliVersion,
    latestVersion: latest,
  };
  return [finding];
}
