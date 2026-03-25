import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  env = process.env,
  pollMs,
  logFile,
} = {}) {
  const ownerPidNum = parsePositiveInt(ownerPid);
  const rootDirValue = String(rootDir ?? '').trim();
  const stackNameValue = String(stackName ?? '').trim();
  const baseDirValue = String(baseDir ?? '').trim();
  const envPathValue = String(envPath ?? '').trim();
  const runtimeStatePathValue = String(runtimeStatePath ?? '').trim();

  if (!ownerPidNum || !rootDirValue || !stackNameValue || !baseDirValue || !runtimeStatePathValue) {
    return null;
  }

  const effectivePollMs = parsePositiveInt(pollMs, 1000);
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
      `--poll-ms=${effectivePollMs}`,
      ...(envPathValue ? [`--env-path=${envPathValue}`] : []),
      ...(effectiveLogFile ? [`--log-file=${effectiveLogFile}`] : []),
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
