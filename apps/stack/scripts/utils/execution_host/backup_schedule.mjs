import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { buildLaunchdPath, buildLaunchdPlistXml } from '@happier-dev/cli-common/service';

import { getHappyStacksHomeDir } from '../paths/paths.mjs';
import { runCaptureResult } from '../proc/proc.mjs';
import {
  createExecutionHostBackup,
  inspectExecutionHostBackup,
  resolveExecutionHostBackupPaths,
  resolveExecutionHostBackupRetention,
} from './backup.mjs';

const SCHEDULE_VERSION = 1;
const SCHEDULE_LABEL = 'dev.happier.stack.dev-vm-backup';
const SCHEDULE_FILE = 'schedule.json';
const DEFAULT_RETENTION = 3;
const STACK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

function requireAbsolutePath(value, label) {
  const path = String(value ?? '').trim();
  if (!path.startsWith('/') || /[\0\r\n]/.test(path)) {
    throw new Error(`[dev-vm] ${label} must be an absolute path`);
  }
  return resolve(path);
}

function requireSafeStackNames(stackNames) {
  if (!Array.isArray(stackNames) || stackNames.length === 0) {
    throw new Error('[dev-vm] backup schedule requires at least one Stack name');
  }
  const seen = new Set();
  return stackNames.map((value) => {
    const stackName = String(value ?? '').trim();
    if (!STACK_NAME_RE.test(stackName)) {
      throw new Error('[dev-vm] backup schedule Stack names must be safe path segments');
    }
    if (seen.has(stackName)) {
      throw new Error(`[dev-vm] backup schedule has a duplicate Stack name: ${stackName}`);
    }
    seen.add(stackName);
    return stackName;
  });
}

function requireIntervalHours(value) {
  const intervalHours = Number(value);
  if (!Number.isSafeInteger(intervalHours) || intervalHours < 1 || intervalHours > Math.floor(Number.MAX_SAFE_INTEGER / 3600)) {
    throw new Error('[dev-vm] backup schedule interval must be a positive whole number of hours');
  }
  return intervalHours;
}

function requireInstance(profile) {
  const instance = String(profile?.instance ?? '').trim();
  if (!STACK_NAME_RE.test(instance)) throw new Error('[dev-vm] backup schedule requires a managed Lima instance name');
  return instance;
}

function defaultBoundary(env) {
  return {
    capture: (command, args) => runCaptureResult(command, args, { env }),
  };
}

function launchctlTarget(uid) {
  if (!Number.isInteger(uid) || uid < 0) throw new Error('[dev-vm] backup schedule could not determine the macOS user id');
  return `gui/${uid}/${SCHEDULE_LABEL}`;
}

function commandFailure(prefix, result) {
  const detail = String(result?.err ?? result?.out ?? '').trim();
  return new Error(`${prefix}${detail ? `: ${detail}` : ''}`);
}

async function writeAtomically(path, contents, mode) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, contents, { encoding: 'utf8', mode, flag: 'wx' });
  try {
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function encodeSchedule(schedule) {
  return `${JSON.stringify({ version: SCHEDULE_VERSION, ...schedule }, null, 2)}\n`;
}

function disableRunAtLoad(plist) {
  const enabled = '    <key>RunAtLoad</key>\n    <true/>';
  const disabled = '    <key>RunAtLoad</key>\n    <false/>';
  if (!plist.includes(enabled)) {
    throw new Error('[dev-vm] could not render a non-eager backup LaunchAgent');
  }
  return plist.replace(enabled, disabled);
}

function buildSchedulePlist({ paths, programArgs, env, intervalHours }) {
  const plist = buildLaunchdPlistXml({
    label: SCHEDULE_LABEL,
    programArgs,
    env: {
      HAPPIER_STACK_HOME_DIR: getHappyStacksHomeDir(env),
      PATH: buildLaunchdPath({ execPath: programArgs[0], basePath: env.PATH }),
    },
    stdoutPath: paths.stdoutPath,
    stderrPath: paths.stderrPath,
    workingDirectory: paths.scheduleRoot,
    keepAliveOnFailure: false,
    startIntervalSec: intervalHours * 3600,
  });
  return disableRunAtLoad(plist);
}

function normalizeProgramArgs(programArgs) {
  if (!Array.isArray(programArgs) || programArgs.length === 0) {
    throw new Error('[dev-vm] backup schedule requires the installed hstack launcher');
  }
  const normalized = programArgs.map((argument) => String(argument ?? '').trim());
  if (!normalized.every(Boolean) || !isAbsolute(normalized[0]) || normalized.some((argument) => /[\0\r\n]/.test(argument))) {
    throw new Error('[dev-vm] backup schedule received unsafe hstack launcher arguments');
  }
  return normalized;
}

export function resolveExecutionHostBackupSchedulePaths({ profile, env = process.env, homeDir = homedir() } = {}) {
  const instance = requireInstance(profile);
  const scheduleRoot = join(getHappyStacksHomeDir(env), 'vm-backups', instance);
  return {
    label: SCHEDULE_LABEL,
    scheduleRoot,
    configPath: join(scheduleRoot, SCHEDULE_FILE),
    logsDir: join(scheduleRoot, 'logs'),
    stdoutPath: join(scheduleRoot, 'logs', 'schedule.out.log'),
    stderrPath: join(scheduleRoot, 'logs', 'schedule.err.log'),
    plistPath: join(requireAbsolutePath(homeDir, 'macOS home directory'), 'Library', 'LaunchAgents', `${SCHEDULE_LABEL}.plist`),
  };
}

export function resolveExecutionHostBackupSchedule({
  profile,
  env = process.env,
  stackNames,
  destinationRoot,
  intervalHours,
  retention = DEFAULT_RETENTION,
} = {}) {
  const instance = requireInstance(profile);
  const normalizedStackNames = requireSafeStackNames(stackNames);
  const normalizedDestinationRoot = requireAbsolutePath(destinationRoot, 'backup destination root');
  const normalizedIntervalHours = requireIntervalHours(intervalHours);
  const normalizedRetention = resolveExecutionHostBackupRetention(retention);
  for (const stackName of normalizedStackNames) {
    resolveExecutionHostBackupPaths({
      profile,
      env,
      stackName,
      destination: join(normalizedDestinationRoot, stackName),
    });
  }
  return {
    instance,
    stackNames: normalizedStackNames,
    destinationRoot: normalizedDestinationRoot,
    intervalHours: normalizedIntervalHours,
    retention: normalizedRetention,
  };
}

async function readScheduleFile(paths, { profile, env }) {
  let raw;
  try {
    raw = await readFile(paths.configPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`[dev-vm] backup schedule configuration is invalid: ${paths.configPath}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.version !== SCHEDULE_VERSION) {
    throw new Error(`[dev-vm] backup schedule configuration is unsupported: ${paths.configPath}`);
  }
  const expectedKeys = new Set(['version', 'instance', 'stackNames', 'destinationRoot', 'intervalHours', 'retention']);
  if (Object.keys(parsed).some((key) => !expectedKeys.has(key))) {
    throw new Error(`[dev-vm] backup schedule configuration has unsupported fields: ${paths.configPath}`);
  }
  const schedule = resolveExecutionHostBackupSchedule({
    profile,
    env,
    stackNames: parsed.stackNames,
    destinationRoot: parsed.destinationRoot,
    intervalHours: parsed.intervalHours,
    retention: parsed.retention,
  });
  if (parsed.instance !== schedule.instance) {
    throw new Error(`[dev-vm] backup schedule targets ${String(parsed.instance ?? '') || 'an unknown VM'}, not ${schedule.instance}`);
  }
  return schedule;
}

export async function readExecutionHostBackupSchedule({ profile, env = process.env, homeDir = homedir() } = {}) {
  const paths = resolveExecutionHostBackupSchedulePaths({ profile, env, homeDir });
  return { paths, schedule: await readScheduleFile(paths, { profile, env }) };
}

export async function installExecutionHostBackupSchedule({
  profile,
  env = process.env,
  homeDir = homedir(),
  platform = process.platform,
  uid = process.getuid?.(),
  boundary,
  programArgs,
  stackNames,
  destinationRoot,
  intervalHours,
  retention = DEFAULT_RETENTION,
} = {}) {
  if (platform !== 'darwin') throw new Error('[dev-vm] backup scheduling is supported only by macOS user LaunchAgents');
  const paths = resolveExecutionHostBackupSchedulePaths({ profile, env, homeDir });
  const schedule = resolveExecutionHostBackupSchedule({
    profile,
    env,
    stackNames,
    destinationRoot,
    intervalHours,
    retention,
  });
  const launchArgs = normalizeProgramArgs(programArgs);
  const processBoundary = boundary ?? defaultBoundary(env);
  if (!processBoundary?.capture) throw new Error('[dev-vm] backup schedule requires a macOS process boundary');

  await Promise.all([
    mkdir(paths.scheduleRoot, { recursive: true, mode: 0o700 }),
    mkdir(paths.logsDir, { recursive: true, mode: 0o700 }),
    mkdir(dirname(paths.plistPath), { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([
    chmod(paths.scheduleRoot, 0o700),
    chmod(paths.logsDir, 0o700),
  ]);
  await writeAtomically(paths.configPath, encodeSchedule(schedule), 0o600);
  await writeAtomically(paths.plistPath, buildSchedulePlist({ paths, programArgs: launchArgs, env, intervalHours: schedule.intervalHours }), 0o644);

  const target = launchctlTarget(uid);
  await processBoundary.capture('launchctl', ['bootout', target]);
  const bootstrap = await processBoundary.capture('launchctl', ['bootstrap', `gui/${uid}`, paths.plistPath]);
  if (bootstrap.exitCode !== 0) throw commandFailure('[dev-vm] could not register the backup LaunchAgent', bootstrap);
  const enabled = await processBoundary.capture('launchctl', ['enable', target]);
  if (enabled.exitCode !== 0) throw commandFailure('[dev-vm] could not enable the backup LaunchAgent', enabled);

  return { schedule, paths, launchAgent: { label: SCHEDULE_LABEL, loaded: true } };
}

export async function removeExecutionHostBackupSchedule({
  profile,
  env = process.env,
  homeDir = homedir(),
  platform = process.platform,
  uid = process.getuid?.(),
  boundary,
} = {}) {
  if (platform !== 'darwin') throw new Error('[dev-vm] backup scheduling is supported only by macOS user LaunchAgents');
  const paths = resolveExecutionHostBackupSchedulePaths({ profile, env, homeDir });
  const processBoundary = boundary ?? defaultBoundary(env);
  if (!processBoundary?.capture) throw new Error('[dev-vm] backup schedule requires a macOS process boundary');
  await processBoundary.capture('launchctl', ['bootout', launchctlTarget(uid)]);
  await Promise.all([
    rm(paths.plistPath, { force: true }),
    rm(paths.configPath, { force: true }),
  ]);
  return { removed: true, paths, launchAgent: { label: SCHEDULE_LABEL, loaded: false } };
}

export async function inspectExecutionHostBackupSchedule({
  profile,
  env = process.env,
  homeDir = homedir(),
  platform = process.platform,
  uid = process.getuid?.(),
  boundary,
} = {}) {
  const { paths, schedule } = await readExecutionHostBackupSchedule({ profile, env, homeDir });
  if (!schedule) {
    return {
      configured: false,
      paths,
      schedule: null,
      stacks: [],
      launchAgent: { label: SCHEDULE_LABEL, loaded: false },
      health: { ok: false, code: 'not_configured' },
    };
  }
  const processBoundary = boundary ?? defaultBoundary(env);
  let loaded = false;
  if (platform === 'darwin' && processBoundary?.capture) {
    const result = await processBoundary.capture('launchctl', ['print', launchctlTarget(uid)]).catch(() => null);
    loaded = result?.exitCode === 0;
  }
  const stacks = await Promise.all(schedule.stackNames.map((stackName) => inspectExecutionHostBackup({
    profile,
    env,
    stackName,
    destination: join(schedule.destinationRoot, stackName),
    boundary: processBoundary,
  })));
  const missingStack = stacks.find((stack) => stack.health.ok !== true);
  return {
    configured: true,
    paths,
    schedule,
    stacks,
    launchAgent: { label: SCHEDULE_LABEL, loaded },
    health: !loaded
      ? { ok: false, code: 'not_loaded' }
      : missingStack
        ? { ok: false, code: `stack_${missingStack.health.code}` }
        : { ok: true, code: 'ready' },
  };
}

export async function runExecutionHostBackupSchedule({
  profile,
  executor,
  boundary,
  env = process.env,
  homeDir = homedir(),
} = {}) {
  const { paths, schedule } = await readExecutionHostBackupSchedule({ profile, env, homeDir });
  if (!schedule) throw new Error('[dev-vm] backup schedule is not configured');
  if (!executor?.capture) throw new Error('[dev-vm] managed Lima executor is required for backup scheduling');
  const stacks = [];
  for (const stackName of schedule.stackNames) {
    try {
      const backup = await createExecutionHostBackup({
        profile,
        executor,
        boundary,
        env,
        stackName,
        destination: join(schedule.destinationRoot, stackName),
        retention: schedule.retention,
      });
      stacks.push({ stackName, backup, health: { ok: true, code: 'ready' } });
    } catch (error) {
      stacks.push({
        stackName,
        error: error instanceof Error ? error.message : String(error),
        health: { ok: false, code: 'failed' },
      });
    }
  }
  const failed = stacks.some((stack) => stack.health.ok !== true);
  return {
    paths,
    schedule,
    stacks,
    health: failed ? { ok: false, code: 'failed' } : { ok: true, code: 'ready' },
  };
}
