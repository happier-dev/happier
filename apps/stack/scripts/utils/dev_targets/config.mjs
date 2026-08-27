import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveStackEnvPath } from '../paths/paths.mjs';

const TARGET_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const SSH_TARGET_RE = /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9._-]+$/;
const LIMA_INSTANCE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

function requireNonEmptyString(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`[dev-targets] ${label} is required`);
  if (/[\0\r\n]/.test(normalized)) throw new Error(`[dev-targets] invalid ${label}`);
  return normalized;
}

function normalizeRemotePath(raw, platform, name) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`[dev-targets] target ${name}: remotePath must be an array`);
  }
  const normalized = [];
  for (const entry of raw) {
    const path = requireNonEmptyString(entry, `target ${name} remotePath entry`);
    const valid = platform === 'windows'
      ? (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')) && !path.includes(';')
      : path.startsWith('/') && !path.includes(':');
    if (!valid) {
      throw new Error(`[dev-targets] target ${name}: invalid remotePath entry: ${JSON.stringify(path)}`);
    }
    if (!normalized.includes(path)) normalized.push(path);
  }
  return normalized;
}

function normalizeTarget(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`[dev-targets] target ${index + 1} must be an object`);
  }
  const name = requireNonEmptyString(raw.name, `target ${index + 1} name`).toLowerCase();
  if (!TARGET_NAME_RE.test(name)) {
    throw new Error(`[dev-targets] invalid target name: ${JSON.stringify(name)}`);
  }
  const platform = requireNonEmptyString(raw.platform, `target ${name} platform`).toLowerCase();
  if (platform !== 'posix' && platform !== 'windows') {
    throw new Error(`[dev-targets] target ${name}: platform must be "posix" or "windows"`);
  }
  const ssh = requireNonEmptyString(raw.ssh, `target ${name} ssh`);
  if (!SSH_TARGET_RE.test(ssh)) {
    throw new Error(`[dev-targets] target ${name}: invalid SSH target`);
  }
  const sshConfigFile =
    raw.sshConfigFile == null || String(raw.sshConfigFile).trim() === ''
      ? null
      : requireNonEmptyString(raw.sshConfigFile, `target ${name} sshConfigFile`);
  if (
    sshConfigFile != null &&
    !sshConfigFile.startsWith('/') &&
    !/^[A-Za-z]:[\\/]/.test(sshConfigFile)
  ) {
    throw new Error(`[dev-targets] target ${name}: sshConfigFile must be an absolute local path`);
  }
  const limaInstance =
    raw.limaInstance == null || String(raw.limaInstance).trim() === ''
      ? null
      : requireNonEmptyString(raw.limaInstance, `target ${name} limaInstance`);
  const limaHome =
    raw.limaHome == null || String(raw.limaHome).trim() === ''
      ? null
      : requireNonEmptyString(raw.limaHome, `target ${name} limaHome`);
  if (Boolean(limaInstance) !== Boolean(limaHome)) {
    throw new Error(`[dev-targets] target ${name}: limaInstance and limaHome must be configured together`);
  }
  if (limaInstance && !LIMA_INSTANCE_RE.test(limaInstance)) {
    throw new Error(`[dev-targets] target ${name}: invalid limaInstance`);
  }
  if (limaHome && !limaHome.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(limaHome)) {
    throw new Error(`[dev-targets] target ${name}: limaHome must be an absolute local path`);
  }
  if (limaInstance && platform !== 'posix') {
    throw new Error(`[dev-targets] target ${name}: Lima targets must use platform "posix"`);
  }
  const repoDir = requireNonEmptyString(raw.repoDir, `target ${name} repoDir`);
  if (repoDir === '/' || repoDir === '\\' || /^[A-Za-z]:[\\/]?$/.test(repoDir)) {
    throw new Error(`[dev-targets] target ${name}: unsafe repoDir`);
  }
  const cliHomeDir = requireNonEmptyString(raw.cliHomeDir, `target ${name} cliHomeDir`);
  const remotePath = normalizeRemotePath(raw.remotePath, platform, name);
  const remoteServerPortRaw = raw.remoteServerPort;
  const remoteServerPort =
    remoteServerPortRaw == null || String(remoteServerPortRaw).trim() === ''
      ? null
      : Number(remoteServerPortRaw);
  if (
    remoteServerPort != null &&
    (!Number.isInteger(remoteServerPort) || remoteServerPort < 1024 || remoteServerPort > 65535)
  ) {
    throw new Error(`[dev-targets] target ${name}: remoteServerPort must be an integer from 1024 to 65535`);
  }
  return {
    name,
    platform,
    ssh,
    ...(sshConfigFile ? { sshConfigFile } : {}),
    ...(limaInstance ? { limaInstance, limaHome } : {}),
    repoDir,
    cliHomeDir,
    ...(remotePath.length ? { remotePath } : {}),
    remoteServerPort,
  };
}

export function parseDevTargetsConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('[dev-targets] configuration must be an object');
  }
  if (raw.version !== 1) {
    throw new Error(`[dev-targets] unsupported configuration version: ${String(raw.version)}`);
  }
  if (!Array.isArray(raw.targets)) {
    throw new Error('[dev-targets] targets must be an array');
  }
  const targets = raw.targets.map(normalizeTarget);
  const seen = new Set();
  for (const target of targets) {
    if (seen.has(target.name)) {
      throw new Error(`[dev-targets] duplicate target name: ${target.name}`);
    }
    seen.add(target.name);
  }
  return { version: 1, targets };
}

export function resolveDevTargetsConfigPath({ stackName, env = process.env }) {
  const resolvedStack = requireNonEmptyString(stackName, 'stackName');
  return join(resolveStackEnvPath(resolvedStack, env).baseDir, 'dev-targets.json');
}

export async function loadDevTargetsConfig({ stackName, env = process.env, allowMissing = true }) {
  const path = resolveDevTargetsConfigPath({ stackName, env });
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    return { path, config: parseDevTargetsConfig(raw) };
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') {
      return { path, config: { version: 1, targets: [] } };
    }
    if (error instanceof SyntaxError) {
      throw new Error(`[dev-targets] invalid JSON at ${path}: ${error.message}`);
    }
    throw error;
  }
}
