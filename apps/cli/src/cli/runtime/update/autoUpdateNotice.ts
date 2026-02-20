import { join } from 'node:path';

import {
  acquireSingleFlightLock,
  formatUpdateNotice,
  readUpdateCache,
  shouldNotifyUpdate,
  spawnDetachedNode,
  writeUpdateCache,
} from '@happier-dev/cli-common/update';

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CHECK_LOCK_TTL_MS = 2 * 60 * 1000;

function envNumber(env: NodeJS.ProcessEnv, key: string): number | null {
  const raw = String(env[key] ?? '').trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function updateChecksEnabled(env: NodeJS.ProcessEnv): boolean {
  return String(env.HAPPIER_CLI_UPDATE_CHECK ?? '1').trim() !== '0';
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

export function maybeAutoUpdateNotice(params: Readonly<{
  argv: string[];
  isTTY: boolean;
  homeDir: string;
  cliRootDir: string;
  env: NodeJS.ProcessEnv;
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

  const cachePath = join(params.homeDir, 'cache', 'update.json');
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

  const updateAvailable = Boolean(cached?.updateAvailable);
  const latest = typeof cached?.latest === 'string' ? cached.latest : null;
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
    const msg = formatUpdateNotice({ toolName: 'happier', from, to: latest ?? 'latest', updateCommand: 'happier self update' });
    console.error(msg);
    writeUpdateCache(cachePath, { ...cached, notifiedAt: now });
  }

  if (!shouldCheck) return;

  const entry = join(params.cliRootDir, 'dist', 'index.mjs');
  const spawnImpl = params.spawnDetached ?? spawnDetachedNode;
  const lockTtlMs = envNumber(env, 'HAPPIER_CLI_UPDATE_CHECK_LOCK_TTL_MS') ?? DEFAULT_CHECK_LOCK_TTL_MS;
  const lockPath = join(params.homeDir, 'cache', 'update.check.lock.json');
  if (!acquireSingleFlightLock({ lockPath, nowMs: now, ttlMs: lockTtlMs, pid: process.pid })) return;
  try {
    spawnImpl({
      script: entry,
      args: ['self', 'check', '--quiet'],
      cwd: params.cliRootDir,
      env: { ...env, HAPPIER_CLI_UPDATE_CHECK_SPAWNED: '1' },
    });
  } catch {
    // Best-effort: update checks must never crash the CLI.
  }
}
