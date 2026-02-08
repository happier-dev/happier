import { mkdirSync, readdirSync, rmSync, statfsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { projectLogsDir } from './paths';

function safeSegment(value: string): string {
  return value
    .trim()
    .replaceAll(/[^a-zA-Z0-9._-]+/g, '-')
    .replaceAll(/-+/g, '-')
    .replaceAll(/(^-|-$)/g, '')
    .slice(0, 120);
}

export type RunDirs = {
  runId: string;
  runDir: string;
  testDir: (testName: string) => string;
};

function resolveRunLogsKeepCount(): number {
  const raw = (
    process.env.HAPPIER_E2E_RUN_LOG_KEEP_COUNT ??
    process.env.HAPPY_E2E_RUN_LOG_KEEP_COUNT ??
    ''
  ).trim();
  if (!raw) return 200;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 200;
  return Math.min(parsed, 10_000);
}

function resolveMinFreeDiskMb(): number {
  const raw = (
    process.env.HAPPIER_E2E_MIN_FREE_DISK_MB ??
    process.env.HAPPY_E2E_MIN_FREE_DISK_MB ??
    ''
  ).trim();
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(parsed, 10_000_000);
}

function assertRunLogsFreeDisk(params: { logsDir: string }): void {
  const minFreeMb = resolveMinFreeDiskMb();
  if (minFreeMb <= 0) return;

  let freeBytes = 0n;
  try {
    const stats = statfsSync(params.logsDir, { bigint: true });
    freeBytes = stats.bsize * stats.bavail;
  } catch {
    return;
  }

  const minFreeBytes = BigInt(minFreeMb) * 1024n * 1024n;
  if (freeBytes >= minFreeBytes) return;

  const freeMb = Number(freeBytes / (1024n * 1024n));
  throw new Error(
    `Insufficient disk space for provider run logs: have ~${freeMb} MiB, require at least ${minFreeMb} MiB (set HAPPIER_E2E_MIN_FREE_DISK_MB to adjust).`,
  );
}

function pruneRunDirsForLabel(params: { logsDir: string; label: string; keepCount: number }): void {
  const labelNeedle = `-${params.label}-`;
  const dirs = readdirSync(params.logsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.includes(labelNeedle))
    .map((entry) => entry.name)
    .sort();

  const overflow = dirs.length - params.keepCount;
  if (overflow <= 0) return;

  for (const name of dirs.slice(0, overflow)) {
    try {
      rmSync(resolve(params.logsDir, name), { recursive: true, force: true });
    } catch {
      // Best-effort retention only.
    }
  }
}

export function createRunDirs(opts?: { runLabel?: string; logsDir?: string }): RunDirs {
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const label = opts?.runLabel ? safeSegment(opts.runLabel) : 'run';
  const runId = `${stamp}-${label}-${randomUUID().slice(0, 8)}`;
  const logsDir = resolve(opts?.logsDir ?? projectLogsDir());
  mkdirSync(logsDir, { recursive: true });
  assertRunLogsFreeDisk({ logsDir });
  const runDir = resolve(logsDir, runId);
  mkdirSync(runDir, { recursive: true });
  pruneRunDirsForLabel({
    logsDir,
    label,
    keepCount: resolveRunLogsKeepCount(),
  });

  return {
    runId,
    runDir,
    testDir: (testName: string) => {
      const dir = resolve(runDir, safeSegment(testName));
      mkdirSync(dir, { recursive: true });
      return dir;
    },
  };
}
