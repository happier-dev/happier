import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeStackRuntimeOwnerStartedAt } from './runtime_owner_incarnation.mjs';

const ownerDeathWatchdogRunnerPath = fileURLToPath(new URL('./owner_death_watchdog_runner.mjs', import.meta.url));

function parsePositiveInt(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 1 ? Math.floor(parsed) : fallback;
}

export function spawnStackOwnerDeathWatchdog({
  rootDir,
  stackName,
  baseDir,
  envPath,
  runtimeStatePath,
  ownerPid,
  ownerStartedAt,
  env = process.env,
  pollMs,
  logFile,
  logMaxBytes,
} = {}) {
  const ownerPidNum = parsePositiveInt(ownerPid);
  const ownerStartedAtValue = normalizeStackRuntimeOwnerStartedAt(ownerStartedAt);
  const rootDirValue = String(rootDir ?? '').trim();
  const stackNameValue = String(stackName ?? '').trim();
  const baseDirValue = String(baseDir ?? '').trim();
  const envPathValue = String(envPath ?? '').trim();
  const runtimeStatePathValue = String(runtimeStatePath ?? '').trim();

  if (!ownerPidNum || !ownerStartedAtValue || !rootDirValue || !stackNameValue || !baseDirValue || !runtimeStatePathValue) {
    return null;
  }

  const effectivePollMs = parsePositiveInt(pollMs, 1000);
  const effectiveLogMaxBytes = parsePositiveInt(logMaxBytes);
  const effectiveLogFile =
    typeof logFile === 'string' && logFile.trim()
      ? logFile.trim()
      : join(baseDirValue, 'logs', 'owner-death-watchdog.log');

  try {
    mkdirSync(dirname(effectiveLogFile), { recursive: true });
  } catch {
    // ignore
  }

  const child = spawn(
    process.execPath,
    [
      ownerDeathWatchdogRunnerPath,
      `--root-dir=${rootDirValue}`,
      `--stack-name=${stackNameValue}`,
      `--base-dir=${baseDirValue}`,
      `--runtime-state-path=${runtimeStatePathValue}`,
      `--owner-pid=${ownerPidNum}`,
      `--owner-started-at=${ownerStartedAtValue}`,
      `--poll-ms=${effectivePollMs}`,
      ...(envPathValue ? [`--env-path=${envPathValue}`] : []),
      ...(effectiveLogFile ? [`--log-file=${effectiveLogFile}`] : []),
      ...(effectiveLogMaxBytes ? [`--log-max-bytes=${effectiveLogMaxBytes}`] : []),
    ],
    {
      env: {
        ...env,
        ...(stackNameValue ? { HAPPIER_STACK_STACK: stackNameValue } : {}),
        ...(envPathValue ? { HAPPIER_STACK_ENV_FILE: envPathValue } : {}),
      },
      stdio: 'ignore',
      shell: false,
      detached: process.platform !== 'win32',
    },
  );
  child.unref?.();
  return child;
}
