import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveManagedLimaProfile, validateManagedLimaInstanceName } from '../managed_lima/profiles.mjs';
import { getHappyStacksHomeDir } from '../paths/paths.mjs';

const PROFILE_FILE = 'execution-host.json';
const FIELDS = new Set([
  'version',
  'mode',
  'activation',
  'instance',
  'limaHome',
  'profile',
  'guestWorkspaceDir',
  'mirrorWorkspaceDir',
]);

function requireAbsolutePath(value, field) {
  const path = String(value ?? '').trim();
  if (!path.startsWith('/') || /[\0\r\n]/.test(path)) {
    throw new Error(`[execution-host] ${field} must be an absolute path`);
  }
  return path;
}

function normalizeExecutionHostProfile(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('[execution-host] profile must be an object');
  }
  for (const key of Object.keys(raw)) {
    if (!FIELDS.has(key)) throw new Error(`[execution-host] unknown field: ${key}`);
  }
  if (raw.version !== 1) throw new Error('[execution-host] unsupported profile version');
  if (raw.mode !== 'managed-lima') throw new Error('[execution-host] unsupported execution host mode');
  if (raw.activation !== 'candidate' && raw.activation !== 'active') {
    throw new Error('[execution-host] activation must be candidate or active');
  }
  const instance = validateManagedLimaInstanceName(raw.instance);
  const profile = resolveManagedLimaProfile(raw.profile).name;
  return {
    version: 1,
    mode: 'managed-lima',
    activation: raw.activation,
    instance,
    limaHome: requireAbsolutePath(raw.limaHome, 'limaHome'),
    profile,
    guestWorkspaceDir: requireAbsolutePath(raw.guestWorkspaceDir, 'guestWorkspaceDir'),
    mirrorWorkspaceDir: requireAbsolutePath(raw.mirrorWorkspaceDir, 'mirrorWorkspaceDir'),
  };
}

export function resolveExecutionHostProfilePath(env = process.env) {
  return join(getHappyStacksHomeDir(env), PROFILE_FILE);
}

export function readExecutionHostProfile(env = process.env) {
  const path = resolveExecutionHostProfilePath(env);
  if (!existsSync(path)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`[execution-host] failed to read ${path}: ${String(error?.message ?? error)}`);
  }
  return normalizeExecutionHostProfile(parsed);
}

async function writeExecutionHostProfile(profile, env) {
  const normalized = normalizeExecutionHostProfile(profile);
  const path = resolveExecutionHostProfilePath(env);
  const directory = getHappyStacksHomeDir(env);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
  return normalized;
}

export async function writeCandidateExecutionHostProfile(profile, env = process.env) {
  const normalized = normalizeExecutionHostProfile(profile);
  if (normalized.activation !== 'candidate') {
    throw new Error('[execution-host] ordinary profile writes require candidate activation');
  }
  return writeExecutionHostProfile(normalized, env);
}

export async function activateExecutionHostProfile(env = process.env) {
  const current = readExecutionHostProfile(env);
  if (!current) throw new Error('[execution-host] no candidate profile exists to activate');
  if (current.activation !== 'candidate') {
    throw new Error('[execution-host] only an existing candidate profile can be activated');
  }
  return writeExecutionHostProfile({ ...current, activation: 'active' }, env);
}

export function validateExecutionHostProfile(raw) {
  return normalizeExecutionHostProfile(raw);
}
