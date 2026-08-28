import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { resolveManagedLimaProfile, validateManagedLimaInstanceName } from '../managed_lima/profiles.mjs';
import { resolveManagedLimaPressureProfile } from '../managed_lima/pressure_profiles.mjs';
import { getHappyStacksHomeDir } from '../paths/paths.mjs';
import { retireExecutionHostCandidateMirrors } from './candidate_repository.mjs';

const PROFILE_FILE = 'execution-host.json';
const FIELDS = new Set([
  'version',
  'mode',
  'activation',
  'instance',
  'limaHome',
  'profile',
  'pressureProfile',
  'guestWorkspaceDir',
  'mirrorWorkspaceDir',
  'controllerEntrypoint',
  'workspaces',
  'autoMount',
  'hostMountDir',
]);
const WORKSPACE_FIELDS = new Set(['id', 'stackName', 'hostSourceDir', 'hostMirrorDir', 'guestDir']);
const WORKSPACE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const WORKSPACE_STACK_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function requireAbsolutePath(value, field) {
  const path = String(value ?? '').trim();
  if (!path.startsWith('/') || /[\0\r\n]/.test(path)) {
    throw new Error(`[execution-host] ${field} must be an absolute path`);
  }
  return path;
}

function pathContains(parent, candidate) {
  const suffix = relative(resolve(parent), resolve(candidate));
  return suffix === '' || (!suffix.startsWith('..') && !isAbsolute(suffix));
}

function normalizeNamedWorkspaces(raw, { guestWorkspaceDir, mirrorWorkspaceDir }) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('[execution-host] workspaces must be a non-empty array');
  }
  const ids = new Set();
  const workspaces = raw.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`[execution-host] workspaces[${index}] must be an object`);
    }
    for (const key of Object.keys(entry)) {
      if (!WORKSPACE_FIELDS.has(key)) throw new Error(`[execution-host] unknown workspace field: ${key}`);
    }
    const id = String(entry.id ?? '').trim();
    if (!WORKSPACE_ID_RE.test(id)) throw new Error(`[execution-host] invalid workspace id: ${JSON.stringify(id)}`);
    if (ids.has(id)) throw new Error(`[execution-host] duplicate workspace id: ${id}`);
    ids.add(id);
    const workspace = {
      id,
      ...(entry.stackName != null ? (() => {
        const stackName = String(entry.stackName).trim();
        if (!WORKSPACE_STACK_RE.test(stackName)) {
          throw new Error(`[execution-host] invalid workspace Stack name: ${JSON.stringify(stackName)}`);
        }
        return { stackName };
      })() : {}),
      hostSourceDir: requireAbsolutePath(entry.hostSourceDir, `workspaces[${index}].hostSourceDir`),
      hostMirrorDir: requireAbsolutePath(entry.hostMirrorDir, `workspaces[${index}].hostMirrorDir`),
      guestDir: requireAbsolutePath(entry.guestDir, `workspaces[${index}].guestDir`),
    };
    if (!pathContains(mirrorWorkspaceDir, workspace.hostMirrorDir)) {
      throw new Error(`[execution-host] workspaces[${index}].hostMirrorDir must be inside mirrorWorkspaceDir`);
    }
    if (!pathContains(guestWorkspaceDir, workspace.guestDir)) {
      throw new Error(`[execution-host] workspaces[${index}].guestDir must be inside guestWorkspaceDir`);
    }
    return workspace;
  });

  const hostPaths = workspaces.flatMap((workspace) => [workspace.hostSourceDir, workspace.hostMirrorDir]);
  for (let left = 0; left < hostPaths.length; left += 1) {
    for (let right = left + 1; right < hostPaths.length; right += 1) {
      if (pathContains(hostPaths[left], hostPaths[right]) || pathContains(hostPaths[right], hostPaths[left])) {
        throw new Error('[execution-host] overlapping host workspace paths are not allowed');
      }
    }
  }
  for (let left = 0; left < workspaces.length; left += 1) {
    for (let right = left + 1; right < workspaces.length; right += 1) {
      if (pathContains(workspaces[left].guestDir, workspaces[right].guestDir)
        || pathContains(workspaces[right].guestDir, workspaces[left].guestDir)) {
        throw new Error('[execution-host] overlapping guest workspace paths are not allowed');
      }
    }
  }
  return workspaces;
}

function normalizeExecutionHostProfile(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('[execution-host] profile must be an object');
  }
  for (const key of Object.keys(raw)) {
    if (!FIELDS.has(key)) throw new Error(`[execution-host] unknown field: ${key}`);
  }
  if (raw.version !== 1 && raw.version !== 2) throw new Error('[execution-host] unsupported profile version');
  if (raw.mode !== 'managed-lima') throw new Error('[execution-host] unsupported execution host mode');
  if (raw.activation !== 'candidate' && raw.activation !== 'active') {
    throw new Error('[execution-host] activation must be candidate or active');
  }
  const instance = validateManagedLimaInstanceName(raw.instance);
  const profile = resolveManagedLimaProfile(raw.profile).name;
  const pressureProfile = resolveManagedLimaPressureProfile(raw.pressureProfile ?? 'none').name;
  const guestWorkspaceDir = requireAbsolutePath(raw.guestWorkspaceDir, 'guestWorkspaceDir');
  const mirrorWorkspaceDir = requireAbsolutePath(raw.mirrorWorkspaceDir, 'mirrorWorkspaceDir');
  const common = {
    version: raw.version,
    mode: 'managed-lima',
    activation: raw.activation,
    instance,
    limaHome: requireAbsolutePath(raw.limaHome, 'limaHome'),
    profile,
    pressureProfile,
    guestWorkspaceDir,
    mirrorWorkspaceDir,
    ...(raw.autoMount != null ? {
      autoMount: (() => {
        if (typeof raw.autoMount !== 'boolean') throw new Error('[execution-host] autoMount must be a boolean');
        return raw.autoMount;
      })(),
    } : {}),
    ...(raw.hostMountDir != null ? {
      hostMountDir: requireAbsolutePath(raw.hostMountDir, 'hostMountDir'),
    } : {}),
  };
  if (raw.version === 1) {
    if (raw.controllerEntrypoint != null || raw.workspaces != null) {
      throw new Error('[execution-host] version 1 profiles cannot define named workspaces');
    }
    return common;
  }
  return {
    ...common,
    controllerEntrypoint: requireAbsolutePath(raw.controllerEntrypoint, 'controllerEntrypoint'),
    workspaces: normalizeNamedWorkspaces(raw.workspaces, { guestWorkspaceDir, mirrorWorkspaceDir }),
  };
}

export function resolveExecutionHostProfilePath(env = process.env) {
  return join(getHappyStacksHomeDir(env), PROFILE_FILE);
}

export function resolveExecutionHostSetupConfiguration({ current, requested = {}, defaults = {} }) {
  if (current?.activation === 'active') {
    throw new Error('[execution-host] cannot reconfigure an active execution host through candidate setup');
  }
  const choose = (field) => {
    const requestedValue = requested[field];
    const hasRequestedValue = requestedValue != null
      && !(typeof requestedValue === 'string' && requestedValue.trim() === '');
    return hasRequestedValue ? requestedValue : current?.[field] ?? defaults[field];
  };
  const requestedWorkspaces = Array.isArray(requested.workspaces) ? requested.workspaces : [];
  const currentWorkspaces = current?.version === 2 ? current.workspaces : [];
  return {
    instance: choose('instance'),
    limaHome: choose('limaHome'),
    profile: choose('profile'),
    pressureProfile: choose('pressureProfile'),
    guestWorkspaceDir: choose('guestWorkspaceDir'),
    mirrorWorkspaceDir: choose('mirrorWorkspaceDir'),
    ...(choose('autoMount') != null ? { autoMount: choose('autoMount') } : {}),
    ...(choose('hostMountDir') != null ? { hostMountDir: choose('hostMountDir') } : {}),
    workspaces: requestedWorkspaces.length > 0 ? requestedWorkspaces : currentWorkspaces,
  };
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
  const retiredCandidateMirrors = await retireExecutionHostCandidateMirrors({ profile: current, env });
  const latest = readExecutionHostProfile(env);
  if (!latest || latest.activation !== 'candidate' || JSON.stringify(latest) !== JSON.stringify(current)) {
    throw new Error('[execution-host] candidate profile changed while candidate mirrors were retired; activation aborted');
  }
  return {
    profile: await writeExecutionHostProfile({ ...latest, activation: 'active' }, env),
    retiredCandidateMirrors,
  };
}

export async function configureExecutionHostWorkspaceMount({ enabled, mountDir }, env = process.env) {
  const current = readExecutionHostProfile(env);
  if (!current) throw new Error('[execution-host] no execution host profile exists');
  if (typeof enabled !== 'boolean') throw new Error('[execution-host] mount enabled state must be a boolean');
  return writeExecutionHostProfile({
    ...current,
    autoMount: enabled,
    hostMountDir: requireAbsolutePath(mountDir, 'hostMountDir'),
  }, env);
}

export function validateExecutionHostProfile(raw) {
  return normalizeExecutionHostProfile(raw);
}
