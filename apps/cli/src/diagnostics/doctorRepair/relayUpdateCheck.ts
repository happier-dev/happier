import { join } from 'node:path';

import { readUpdateCache, writeUpdateCache } from '@happier-dev/cli-common/update';
import { fetchGitHubReleaseByTag } from '@happier-dev/release-runtime/github';
import type { PublicReleaseRingLabel } from '@happier-dev/release-runtime/releaseRings';

import { configuration } from '@/configuration';
import {
  resolveHappierGithubRepo,
  resolveRelayReleaseTag,
} from '@/capabilities/systemTasks/relayRuntime/_releaseTagsAndRepo';

import { extractSemverFromReleaseJson, withTimeout } from './_updateCheck';

/**
 * Resolve the latest published relay version for a channel.
 *
 * Caching: same on-disk shape as the CLI auto-update check (`UpdateCache`
 * from `@happier-dev/cli-common/update`), scoped to a relay-specific file.
 *
 * By default during `doctor repair` the caller passes `forceRefresh: true` to
 * do a live GitHub fetch; the cache is just a fallback when the network call
 * fails or times out. Scripted/preflight consumers can pass `skipNetwork: true`
 * to stay purely offline.
 *
 * GitHub tag + repo resolution is shared with `liveRelayRuntime.ts` via
 * `capabilities/systemTasks/relayRuntime/_releaseTagsAndRepo.ts`.
 */
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const DEFAULT_FETCH_TIMEOUT_MS = 2_500;

function relayUpdateCacheFilePath(channel: PublicReleaseRingLabel): string {
  const fileName = channel === 'stable'
    ? 'update.relay.json'
    : `update.relay.${channel}.json`;
  return join(configuration.happyHomeDir, 'cache', fileName);
}

export async function readLatestRelayVersion(
  channel: PublicReleaseRingLabel,
  opts: Readonly<{
    maxAgeMs?: number;
    fetchTimeoutMs?: number;
    skipNetwork?: boolean;
    forceRefresh?: boolean;
  }> = {},
): Promise<string | null> {
  const maxAge = opts.maxAgeMs ?? DEFAULT_CACHE_TTL_MS;
  const cachePath = relayUpdateCacheFilePath(channel);
  const cache = readUpdateCache(cachePath);
  const checkedAt = cache?.checkedAt ?? 0;
  const cached = cache?.latest ?? null;

  if (opts.skipNetwork) return cached;

  const cacheFresh = cached !== null && checkedAt > 0 && Date.now() - checkedAt < maxAge;
  if (cacheFresh && !opts.forceRefresh) return cached;

  const release = await withTimeout(
    fetchGitHubReleaseByTag({
      githubRepo: resolveHappierGithubRepo(),
      tag: resolveRelayReleaseTag(channel),
      userAgent: 'happier-cli/doctor-repair',
    }),
    opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
  );

  const latest = extractSemverFromReleaseJson(release);
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
