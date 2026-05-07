import { join } from 'node:path';
import { existsSync } from 'node:fs';

import {
  acquireSingleFlightLock,
  formatUpdateNotice,
  readUpdateCache,
  shouldNotifyUpdate,
  spawnDetachedNode,
  writeUpdateCache,
} from '@happier-dev/cli-common/update';
import { resolveManagedCliToolNameForRing } from '@happier-dev/cli-common/firstPartyRuntime';
import { getReleaseRingPublicLabel, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CHECK_LOCK_TTL_MS = 2 * 60 * 1000;

/**
 * The `next` npm dist-tag is shared between preview and dev channels — a
 * cached `latest` may have been fetched from the other channel. Reject
 * cross-channel versions so we don't announce bogus updates (e.g. dev 0.2.5
 * "updating" to preview 0.2.2). The cache self-heals on next `self check`.
 */
function doesVersionMatchRing(version: string | null, ring: PublicReleaseRingId): boolean {
  const v = String(version ?? '').trim();
  if (!v) return false;
  const dashIndex = v.indexOf('-');
  const prerelease = dashIndex >= 0 ? v.slice(dashIndex + 1) : '';
  if (ring === 'stable') return prerelease === '';
  if (ring === 'preview') return prerelease.startsWith('preview.') || prerelease === 'preview';
  return prerelease.startsWith('dev.') || prerelease === 'dev';
}

function envNumber(env: NodeJS.ProcessEnv, key: string): number | null {
  const raw = String(env[key] ?? '').trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function updateChecksEnabled(env: NodeJS.ProcessEnv): boolean {
  return String(env.HAPPIER_CLI_UPDATE_CHECK ?? '1').trim() !== '0';
}

function resolvePublicReleaseRingSuffix(ring: PublicReleaseRingId): 'stable' | 'preview' | 'dev' {
  return getReleaseRingPublicLabel(ring);
}

function resolveUpdateCacheFileName(ring: PublicReleaseRingId): string {
  const suffix = resolvePublicReleaseRingSuffix(ring);
  return suffix === 'stable' ? 'update.json' : `update.${suffix}.json`;
}

function resolveUpdateCheckLockFileName(ring: PublicReleaseRingId): string {
  const suffix = resolvePublicReleaseRingSuffix(ring);
  return suffix === 'stable' ? 'update.check.lock.json' : `update.check.${suffix}.lock.json`;
}

function resolveSelfChannelArgs(ring: PublicReleaseRingId): string[] {
  if (ring === 'preview') return ['--preview'];
  if (ring === 'publicdev') return ['--dev'];
  return [];
}

function resolveUpdateCommand(ring: PublicReleaseRingId): string {
  return `${resolveManagedCliToolNameForRing(ring)} self update`;
}

const LONG_FLAGS_WITH_VALUE = new Set([
  '--config',
  '--server',
  '--server-url',
  '--webapp-url',
  '--public-server-url',
]);

function getCmdFromArgv(argv: string[]): string {
  // Heuristic: treat leading "--flag value" pairs as global options so we can
  // reliably identify the command for update-notice suppression (e.g. `self`).
  let skipNext = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (!token) continue;
    if (token.startsWith('--')) {
      // Handle "--flag=value" as a single token.
      if (!token.includes('=') && LONG_FLAGS_WITH_VALUE.has(token)) skipNext = true;
      continue;
    }
    if (token.startsWith('-')) {
      // Handle "-f value" pairs as global options.
      // We intentionally avoid trying to parse combined flags (e.g. "-abc").
      if (/^-[A-Za-z]$/.test(token)) {
        const next = argv[i + 1];
        if (typeof next === 'string' && next.length > 0 && !next.startsWith('-')) {
          skipNext = true;
        }
      }
      continue;
    }
    return token;
  }
  return 'help';
}

function isVersionInvocation(argv: string[]): boolean {
  return argv.includes('--version') || argv.includes('-v');
}

function resolveUpdateCheckEntrypoint(cliRootDir: string): string {
  const normalizedRoot = String(cliRootDir ?? '').trim();
  const packageDistEntrypoint = join(normalizedRoot, 'package-dist', 'index.mjs');
  if (existsSync(packageDistEntrypoint)) {
    return packageDistEntrypoint;
  }
  return join(normalizedRoot, 'dist', 'index.mjs');
}

export function maybeAutoUpdateNotice(params: Readonly<{
  argv: string[];
  isTTY: boolean;
  homeDir: string;
  cliRootDir: string;
  env: NodeJS.ProcessEnv;
  publicReleaseRing?: PublicReleaseRingId;
  nowMs?: number;
  notifyIntervalMs?: number;
  checkIntervalMs?: number;
  spawnDetached?: (args: { script: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }) => void;
}>): void {
  const env = params.env;
  if (!updateChecksEnabled(env)) return;
  if (!params.isTTY) return;
  if (String(env.HAPPIER_CLI_UPDATE_CHECK_SPAWNED ?? '').trim() === '1') return;
  if (isVersionInvocation(params.argv)) return;

  const cmd = getCmdFromArgv(params.argv);
  const now = params.nowMs ?? Date.now();
  const publicReleaseRing = params.publicReleaseRing ?? 'stable';

  const cachePath = join(params.homeDir, 'cache', resolveUpdateCacheFileName(publicReleaseRing));
  const cached = readUpdateCache(cachePath);
  const checkedAt = typeof cached?.checkedAt === 'number' ? cached.checkedAt : 0;

  const checkInterval =
    params.checkIntervalMs ??
    envNumber(env, 'HAPPIER_CLI_UPDATE_CHECK_INTERVAL_MS') ??
    DEFAULT_INTERVAL_MS;
  const notifyInterval =
    params.notifyIntervalMs ??
    envNumber(env, 'HAPPIER_CLI_UPDATE_NOTIFY_INTERVAL_MS') ??
    DEFAULT_INTERVAL_MS;

  const shouldCheck = !checkedAt || (Number.isFinite(checkInterval) && now - checkedAt > checkInterval);

  const cachedLatest = typeof cached?.latest === 'string' ? cached.latest : null;
  // Cross-channel cache entries can exist if the cache was populated before
  // the `self check` filter was added. Suppress the notice; it'll self-heal.
  const latestMatchesRing = doesVersionMatchRing(cachedLatest, publicReleaseRing);
  const updateAvailable = Boolean(cached?.updateAvailable) && latestMatchesRing;
  const latest = latestMatchesRing ? cachedLatest : null;
  const current = typeof cached?.current === 'string' ? cached.current : null;
  const notifiedAt = typeof cached?.notifiedAt === 'number' ? cached.notifiedAt : null;

  const shouldNotify = shouldNotifyUpdate({
    isTTY: params.isTTY,
    cmd,
    updateAvailable,
    latest,
    notifiedAt,
    notifyIntervalMs: notifyInterval,
    nowMs: now,
  });

  if (shouldNotify && cached) {
    const from = current || cached.runtimeVersion || cached.invokerVersion || 'current';
    const msg = formatUpdateNotice({
      toolName: resolveManagedCliToolNameForRing(publicReleaseRing),
      from,
      to: latest ?? 'latest',
      updateCommand: resolveUpdateCommand(publicReleaseRing),
    });
    console.error(msg);
    writeUpdateCache(cachePath, { ...cached, notifiedAt: now });
  }

  if (!shouldCheck) return;

  const entry = resolveUpdateCheckEntrypoint(params.cliRootDir);
  const spawnImpl = params.spawnDetached ?? spawnDetachedNode;
  const lockTtlMs = envNumber(env, 'HAPPIER_CLI_UPDATE_CHECK_LOCK_TTL_MS') ?? DEFAULT_CHECK_LOCK_TTL_MS;
  const lockPath = join(params.homeDir, 'cache', resolveUpdateCheckLockFileName(publicReleaseRing));
  if (!acquireSingleFlightLock({ lockPath, nowMs: now, ttlMs: lockTtlMs, pid: process.pid })) return;
  try {
    spawnImpl({
      script: entry,
      args: ['self', 'check', '--quiet', ...resolveSelfChannelArgs(publicReleaseRing)],
      cwd: params.cliRootDir,
      env: { ...env, HAPPIER_CLI_UPDATE_CHECK_SPAWNED: '1' },
    });
  } catch {
    // Best-effort: update checks must never crash the CLI.
  }
}
