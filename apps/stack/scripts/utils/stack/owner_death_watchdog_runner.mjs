import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { readEnvObjectFromFile } from '../env/read.mjs';
import { isPidAlive } from '../proc/pids.mjs';
import { stopStackWithEnv } from './stop.mjs';
import { readStackRuntimeStateFile } from './runtime_state.mjs';

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
const pollMs = parsePositiveInt(parseFlagValue('--poll-ms'), 1000);
const logFile = parseFlagValue('--log-file');

let pollTimer = null;
let stopping = false;

async function writeLog(message) {
  if (!logFile) return;
  const line = `[owner-watchdog] ${message}\n`;
  try {
    await mkdir(dirname(logFile), { recursive: true });
  } catch {
    // ignore
  }
  await appendFile(logFile, line, 'utf-8').catch(() => {});
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
    });
    const killedCount = countKilledProcesses(actions);
    const errorCount = Array.isArray(actions?.errors) ? actions.errors.length : 0;
    await writeLog(`sweep complete (killed=${killedCount}, errors=${errorCount})`);
    finalize(errorCount > 0 ? 1 : 0);
  } catch (error) {
    await writeLog(`sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    finalize(1);
  }
}

async function tick() {
  if (stopping) return;

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
