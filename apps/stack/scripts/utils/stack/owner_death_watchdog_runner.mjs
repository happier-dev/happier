import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { readEnvObjectFromFile } from '../env/read.mjs';
import {
  createBoundedLogWriteStream,
  DEFAULT_BOUNDED_LOG_MAX_BYTES,
} from '../proc/boundedLog.mjs';
import { isPidAlive } from '../proc/pids.mjs';
import { stopStackWithEnv } from './stop.mjs';
import { readStackRuntimeStateFile } from './runtime_state.mjs';
import { normalizeStackRuntimeOwnerStartedAt } from './runtime_owner_incarnation.mjs';

function parseFlagValue(flag) {
  const entry = process.argv.slice(2).find((arg) => arg.startsWith(`${flag}=`));
  return entry ? entry.slice(flag.length + 1) : '';
}

function parsePositiveInt(value, fallback) {
  const parsed = Number(String(value ?? '').trim());
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function countKilledProcesses(actions) {
  const directKills = Array.isArray(actions?.processes?.killed) ? actions.processes.killed.length : 0;
  const sweepKills = Array.isArray(actions?.sweep?.pids) ? actions.sweep.pids.length : 0;
  const expoDevKills = Array.isArray(actions?.expoDev) ? actions.expoDev.length : 0;
  const uiDevKills = Array.isArray(actions?.uiDev) ? actions.uiDev.length : 0;
  const mobileKills = Array.isArray(actions?.mobile) ? actions.mobile.length : 0;
  return directKills + sweepKills + expoDevKills + uiDevKills + mobileKills;
}

const rootDir = parseFlagValue('--root-dir');
const stackName = parseFlagValue('--stack-name');
const baseDir = parseFlagValue('--base-dir');
const envPath = parseFlagValue('--env-path');
const runtimeStatePath = parseFlagValue('--runtime-state-path');
const ownerPid = parsePositiveInt(parseFlagValue('--owner-pid'), 0);
const ownerStartedAtRaw = parseFlagValue('--owner-started-at');
const ownerStartedAt = normalizeStackRuntimeOwnerStartedAt(ownerStartedAtRaw);
const pollMs = parsePositiveInt(parseFlagValue('--poll-ms'), 1000);
const logFile = parseFlagValue('--log-file');
const logMaxBytes = parsePositiveInt(
  parseFlagValue('--log-max-bytes'),
  DEFAULT_BOUNDED_LOG_MAX_BYTES,
);
const ownerDeathStopAttribution = {
  requestedBy: 'owner death watchdog',
  reason: 'lifecycle owner exited; sweeping stack-owned runtime',
};

let pollTimer = null;
let stopping = false;
let logStream = null;

async function writeLogLine(line) {
  if (!logFile) return;
  try {
    await mkdir(dirname(logFile), { recursive: true });
    if (!logStream) {
      logStream = createBoundedLogWriteStream(logFile, logMaxBytes);
      logStream.on('error', () => {});
    }
    await new Promise((resolve) => logStream.write(line, resolve));
  } catch {
    // Logging is diagnostic and must not take lifecycle cleanup down with it.
  }
}

async function writeLog(message) {
  await writeLogLine(`[owner-watchdog] ${message}\n`);
}

async function writeStructuredLog(payload) {
  await writeLogLine(`[owner-watchdog-json] ${JSON.stringify(payload)}\n`);
}

function summarizeStopActions(actions) {
  return {
    stopAttribution: actions?.stopAttribution ?? null,
    stopAuthorization: actions?.stopAuthorization ?? null,
    runner: actions?.runner ?? null,
    daemonSessionsStopped: actions?.daemonSessionsStopped ?? null,
    daemonStopped: actions?.daemonStopped === true,
    processes: actions?.processes ?? null,
    sweep: actions?.sweep ?? null,
    expoDev: Array.isArray(actions?.expoDev) ? actions.expoDev : [],
    uiDev: Array.isArray(actions?.uiDev) ? actions.uiDev : [],
    mobile: Array.isArray(actions?.mobile) ? actions.mobile : [],
    infra: actions?.infra ?? null,
    errors: Array.isArray(actions?.errors) ? actions.errors : [],
  };
}

function finalize(code = 0) {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  process.exit(code);
}

async function buildStackEnv() {
  const stackEnv = envPath ? await readEnvObjectFromFile(envPath) : {};
  return {
    ...process.env,
    ...stackEnv,
    ...(stackName ? { HAPPIER_STACK_STACK: stackName } : {}),
    ...(envPath ? { HAPPIER_STACK_ENV_FILE: envPath } : {}),
  };
}

async function sweepOwnedRuntime(runtimeState = null) {
  if (stopping) return;
  stopping = true;

  await writeLog(`owner pid ${ownerPid} is gone; sweeping stack-owned runtime`);
  const env = await buildStackEnv();
  const preserveDaemon = runtimeState?.stopRequest?.preserveDaemon === true;
  const expectedOwnerPid = ownerPid;
  const expectedOwnerStartedAt = ownerStartedAt;
  try {
    const actions = await stopStackWithEnv({
      rootDir,
      stackName,
      baseDir,
      env,
      json: true,
      aggressive: false,
      sweepOwned: true,
      autoSweep: true,
      preserveDaemon,
      expectedOwnerPid,
      expectedOwnerStartedAt,
      stopAttribution: ownerDeathStopAttribution,
    });
    const killedCount = countKilledProcesses(actions);
    const errorCount = Array.isArray(actions?.errors) ? actions.errors.length : 0;
    if (actions?.stopAuthorization?.authorized === false) {
      await writeStructuredLog({
        event: 'owner_death_sweep_noop',
        timestamp: new Date().toISOString(),
        stackName,
        baseDir,
        ownerPid,
        killedCount,
        errorCount,
        preserveDaemon,
        actions: summarizeStopActions(actions),
      });
      const reason = actions.stopAuthorization.reason;
      await writeLog(
        reason === 'successor_owner'
          ? 'successor runtime detected; no-op'
          : `runtime stop not authorized (${reason}); no-op`,
      );
      finalize(errorCount > 0 ? 1 : 0);
      return;
    }
    await writeStructuredLog({
      event: 'owner_death_sweep_complete',
      timestamp: new Date().toISOString(),
      stackName,
      baseDir,
      ownerPid,
      killedCount,
      errorCount,
      preserveDaemon,
      actions: summarizeStopActions(actions),
    });
    await writeLog(`sweep complete (killed=${killedCount}, errors=${errorCount})`);
    finalize(errorCount > 0 ? 1 : 0);
  } catch (error) {
    await writeStructuredLog({
      event: 'owner_death_sweep_failed',
      timestamp: new Date().toISOString(),
      stackName,
      baseDir,
      ownerPid,
      error: error instanceof Error ? error.message : String(error),
    });
    await writeLog(`sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    finalize(1);
  }
}

async function tick() {
  if (stopping) return;

  if (!ownerStartedAt) {
    const description = ownerStartedAtRaw ? 'invalid' : 'missing';
    await writeStructuredLog({
      event: 'owner_death_sweep_noop',
      timestamp: new Date().toISOString(),
      stackName,
      baseDir,
      ownerPid,
      killedCount: 0,
      errorCount: 0,
      preserveDaemon: false,
      actions: {
        stopAttribution: ownerDeathStopAttribution,
        stopAuthorization: { authorized: false, reason: 'invalid_expected_owner_incarnation' },
      },
    });
    await writeLog(`watched owner startedAt ${description}; no-op`);
    finalize(0);
    return;
  }

  const runtimeState = runtimeStatePath ? await readStackRuntimeStateFile(runtimeStatePath) : null;
  if (!runtimeState) {
    await writeLog('runtime state missing; exiting');
    finalize(0);
    return;
  }

  const recordedOwnerPid = parsePositiveInt(runtimeState?.ownerPid, 0);
  if (recordedOwnerPid > 1 && recordedOwnerPid !== ownerPid) {
    await writeLog(`runtime owner changed to pid=${recordedOwnerPid}; exiting`);
    finalize(0);
    return;
  }
  const recordedOwnerStartedAt = normalizeStackRuntimeOwnerStartedAt(runtimeState?.startedAt);
  if (!recordedOwnerStartedAt || recordedOwnerStartedAt !== ownerStartedAt) {
    const reason = recordedOwnerStartedAt
      ? 'successor_owner_incarnation'
      : runtimeState?.startedAt == null || runtimeState.startedAt === ''
        ? 'runtime_owner_incarnation_missing'
        : 'runtime_owner_incarnation_invalid';
    await writeStructuredLog({
      event: 'owner_death_sweep_noop',
      timestamp: new Date().toISOString(),
      stackName,
      baseDir,
      ownerPid,
      killedCount: 0,
      errorCount: 0,
      preserveDaemon: runtimeState?.stopRequest?.preserveDaemon === true,
      actions: {
        stopAttribution: ownerDeathStopAttribution,
        stopAuthorization: { authorized: false, reason },
      },
    });
    await writeLog(`runtime stop not authorized (${reason}); no-op`);
    finalize(0);
    return;
  }

  if (ownerPid > 1 && isPidAlive(ownerPid)) {
    return;
  }

  await sweepOwnedRuntime(runtimeState);
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => finalize(0));
}

await writeLog(`watching owner pid=${ownerPid}`);
await tick();
pollTimer = setInterval(() => {
  void tick();
}, pollMs);
