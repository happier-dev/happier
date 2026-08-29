import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveStackEnvPath } from '../paths/paths.mjs';
import {
  normalizeManagedLimaArchitecture,
  resolveManagedLimaProfile,
} from '../managed_lima/profiles.mjs';

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

function normalizeManagedRuntime(raw, { name, platform }) {
  if (raw == null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`[dev-targets] target ${name}: managedRuntime must be an object`);
  }
  if (platform !== 'posix') {
    throw new Error(`[dev-targets] target ${name}: managed Lima runtimes must use platform "posix"`);
  }
  const kind = requireNonEmptyString(raw.kind, `target ${name} managedRuntime kind`).toLowerCase();
  if (kind !== 'lima') {
    throw new Error(`[dev-targets] target ${name}: managedRuntime kind must be "lima"`);
  }
  const instance = requireNonEmptyString(raw.instance, `target ${name} managedRuntime instance`);
  if (!LIMA_INSTANCE_RE.test(instance)) {
    throw new Error(`[dev-targets] target ${name}: invalid managed Lima instance`);
  }
  const limaHome = requireNonEmptyString(raw.limaHome, `target ${name} managedRuntime limaHome`);
  if (!limaHome.startsWith('/')) {
    throw new Error(`[dev-targets] target ${name}: managedRuntime limaHome must be an absolute POSIX path`);
  }
  const profile = resolveManagedLimaProfile(
    requireNonEmptyString(raw.profile, `target ${name} managedRuntime profile`),
  ).name;
  const architecture = normalizeManagedLimaArchitecture(raw.architecture ?? 'aarch64');
  if (!raw.host || typeof raw.host !== 'object' || Array.isArray(raw.host)) {
    throw new Error(`[dev-targets] target ${name}: managedRuntime host must be an object`);
  }
  const hostKind = requireNonEmptyString(raw.host.kind, `target ${name} managedRuntime host kind`).toLowerCase();
  let host;
  if (hostKind === 'local') {
    host = { kind: 'local' };
  } else if (hostKind === 'ssh') {
    const ssh = requireNonEmptyString(raw.host.ssh, `target ${name} outer-host SSH alias`);
    if (!/^[A-Za-z0-9._-]+$/.test(ssh)) {
      throw new Error(`[dev-targets] target ${name}: invalid outer-host SSH alias`);
    }
    const sshConfigFile = requireNonEmptyString(
      raw.host.sshConfigFile,
      `target ${name} outer-host SSH config`,
    );
    if (!sshConfigFile.startsWith('/')) {
      throw new Error(`[dev-targets] target ${name}: outer-host SSH config must be an absolute path`);
    }
    const remotePath = normalizeRemotePath(raw.host.remotePath, 'posix', `${name} managedRuntime host`);
    host = {
      kind: 'ssh',
      ssh,
      sshConfigFile,
      ...(remotePath.length ? { remotePath } : {}),
    };
  } else {
    throw new Error(`[dev-targets] target ${name}: managedRuntime host kind must be "local" or "ssh"`);
  }
  return { kind, host, instance, limaHome, profile, architecture };
}

function normalizeTarget(raw, index, version) {
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
  if (version === 3 && (raw.limaInstance != null || raw.limaHome != null)) {
    throw new Error(`[dev-targets] target ${name}: legacy Lima fields are not allowed in version 3`);
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
  const managedRuntime = version === 3
    ? normalizeManagedRuntime(raw.managedRuntime, { name, platform })
    : null;
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
    ...(managedRuntime ? { managedRuntime } : {}),
    repoDir,
    cliHomeDir,
    ...(remotePath.length ? { remotePath } : {}),
    remoteServerPort,
  };
}

const LOCAL_PLACEMENT = Object.freeze({ mode: 'local' });
const DEFAULT_LOAD_PROBE_TTL_MS = 15_000;
const DEFAULT_UNAVAILABLE_PROBE_TTL_MS = 120_000;

function normalizePlacement(
  raw,
  {
    label,
    targetNames,
    canonicalFallback = 'local',
    acceptedFallbacks = new Set(['local']),
  },
) {
  if (raw == null) return { ...LOCAL_PLACEMENT };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`[dev-targets] ${label} must be an object`);
  }
  const mode = requireNonEmptyString(raw.mode, `${label} mode`).toLowerCase();
  if (mode === 'local') return { ...LOCAL_PLACEMENT };
  if (mode !== 'prefer-target') {
    throw new Error(`[dev-targets] ${label} mode must be "local" or "prefer-target"`);
  }
  const target = requireNonEmptyString(raw.target, `${label} target`).toLowerCase();
  if (!targetNames.has(target)) {
    throw new Error(`[dev-targets] ${label} references unknown target: ${target}`);
  }
  const fallback = String(raw.fallback ?? canonicalFallback).trim().toLowerCase();
  if (!acceptedFallbacks.has(fallback)) {
    throw new Error(
      `[dev-targets] ${label} fallback must be ${[...acceptedFallbacks].map((value) => `"${value}"`).join(' or ')}`,
    );
  }
  return { mode, target, fallback: canonicalFallback };
}

function normalizeDaemonPlacement(raw, { targetNames }) {
  if (raw?.mode !== 'local-and-targets') {
    return normalizePlacement(raw, { label: 'runtimePlacement.daemon', targetNames });
  }
  if (!Array.isArray(raw.targets) || raw.targets.length === 0) {
    throw new Error('[dev-targets] runtimePlacement.daemon targets must be a non-empty array');
  }
  const targets = [];
  for (const rawTarget of raw.targets) {
    const target = requireNonEmptyString(rawTarget, 'runtimePlacement.daemon target').toLowerCase();
    if (!targetNames.has(target)) {
      throw new Error(`[dev-targets] runtimePlacement.daemon references unknown target: ${target}`);
    }
    if (!targets.includes(target)) targets.push(target);
  }
  return { mode: 'local-and-targets', targets };
}

function normalizeDurationMs(raw, fallback, label) {
  if (raw == null || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1_000 || value > 30 * 60_000) {
    throw new Error(`[dev-targets] ${label} must be an integer from 1000 to 1800000`);
  }
  return value;
}

function automaticCommandExecution(targets, overrides = {}) {
  return {
    mode: 'auto',
    targets: overrides.targets ?? targets.map((target) => target.name),
    includeLocal: overrides.includeLocal === true,
    fallback: overrides.fallback ?? 'local',
    loadProbeTtlMs: overrides.loadProbeTtlMs ?? DEFAULT_LOAD_PROBE_TTL_MS,
    unavailableProbeTtlMs:
      overrides.unavailableProbeTtlMs ?? DEFAULT_UNAVAILABLE_PROBE_TTL_MS,
  };
}

function normalizeCommandExecution(raw, { targets, targetNames }) {
  if (raw == null) {
    return targets.length > 0 ? automaticCommandExecution(targets) : { ...LOCAL_PLACEMENT };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('[dev-targets] commandExecution must be an object');
  }
  const mode = requireNonEmptyString(raw.mode, 'commandExecution mode').toLowerCase();
  if (mode === 'local') return { ...LOCAL_PLACEMENT };
  if (mode === 'prefer-target') {
    return normalizePlacement(raw, { label: 'commandExecution', targetNames });
  }
  if (mode !== 'auto') {
    throw new Error('[dev-targets] commandExecution mode must be "local", "prefer-target", or "auto"');
  }
  const selectedTargets = raw.targets == null
    ? targets.map((target) => target.name)
    : (() => {
        if (!Array.isArray(raw.targets) || raw.targets.length === 0) {
          throw new Error('[dev-targets] commandExecution targets must be a non-empty array');
        }
        const result = [];
        for (const rawTarget of raw.targets) {
          const target = requireNonEmptyString(rawTarget, 'commandExecution target').toLowerCase();
          if (!targetNames.has(target)) {
            throw new Error(`[dev-targets] commandExecution references unknown target: ${target}`);
          }
          if (!result.includes(target)) result.push(target);
        }
        return result;
      })();
  const fallback = String(raw.fallback ?? 'local').trim().toLowerCase();
  if (fallback !== 'local' && fallback !== 'error') {
    throw new Error('[dev-targets] commandExecution fallback must be "local" or "error"');
  }
  return automaticCommandExecution(targets, {
    targets: selectedTargets,
    includeLocal: raw.includeLocal === true,
    fallback,
    loadProbeTtlMs: normalizeDurationMs(
      raw.loadProbeTtlMs,
      DEFAULT_LOAD_PROBE_TTL_MS,
      'commandExecution loadProbeTtlMs',
    ),
    unavailableProbeTtlMs: normalizeDurationMs(
      raw.unavailableProbeTtlMs,
      DEFAULT_UNAVAILABLE_PROBE_TTL_MS,
      'commandExecution unavailableProbeTtlMs',
    ),
  });
}

function normalizePlacedConfig(raw, targets) {
  const targetNames = new Set(targets.map((target) => target.name));
  const runtimePlacementRaw = raw.runtimePlacement;
  if (
    runtimePlacementRaw != null
    && (!runtimePlacementRaw || typeof runtimePlacementRaw !== 'object' || Array.isArray(runtimePlacementRaw))
  ) {
    throw new Error('[dev-targets] runtimePlacement must be an object');
  }
  const runtimePlacement = {
    server: normalizePlacement(runtimePlacementRaw?.server, {
      label: 'runtimePlacement.server',
      targetNames,
      canonicalFallback: 'error',
      acceptedFallbacks: new Set(['error', 'local']),
    }),
    expo: normalizePlacement(runtimePlacementRaw?.expo, {
      label: 'runtimePlacement.expo',
      targetNames,
    }),
    daemon: normalizeDaemonPlacement(runtimePlacementRaw?.daemon, { targetNames }),
  };
  const commandExecution = normalizeCommandExecution(raw.commandExecution, { targets, targetNames });
  return { version: raw.version, targets, runtimePlacement, commandExecution };
}

export function parseDevTargetsConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('[dev-targets] configuration must be an object');
  }
  if (raw.version !== 1 && raw.version !== 2 && raw.version !== 3) {
    throw new Error(`[dev-targets] unsupported configuration version: ${String(raw.version)}`);
  }
  if (!Array.isArray(raw.targets)) {
    throw new Error('[dev-targets] targets must be an array');
  }
  const targets = raw.targets.map((target, index) => normalizeTarget(target, index, raw.version));
  const seen = new Set();
  for (const target of targets) {
    if (seen.has(target.name)) {
      throw new Error(`[dev-targets] duplicate target name: ${target.name}`);
    }
    seen.add(target.name);
  }
  if (raw.version === 1) return { version: 1, targets };
  return normalizePlacedConfig(raw, targets);
}

export function upgradeDevTargetsConfigToVersion3(config) {
  const parsed = parseDevTargetsConfig(config);
  const placed = parsed.version === 1
    ? {
        version: 2,
        targets: parsed.targets,
        runtimePlacement: {
          server: { mode: 'local' },
          expo: { mode: 'local' },
          daemon: parsed.targets.length
            ? { mode: 'local-and-targets', targets: parsed.targets.map((target) => target.name) }
            : { mode: 'local' },
        },
        commandExecution: parsed.targets.length ? { mode: 'auto' } : { mode: 'local' },
      }
    : parsed;
  if (placed.version === 3) return placed;
  return parseDevTargetsConfig({
    ...placed,
    version: 3,
    targets: placed.targets.map((target) => {
      const { limaInstance, limaHome, ...rest } = target;
      return limaInstance
        ? {
            ...rest,
            managedRuntime: {
              kind: 'lima',
              host: { kind: 'local' },
              instance: limaInstance,
              limaHome,
              profile: 'worker-balanced',
              architecture: 'aarch64',
            },
          }
        : rest;
    }),
  });
}

export function resolveDevTargetExecutionPolicy(
  config,
  { targetsEnabled = true, serverRequested = false } = {},
) {
  let policy;
  if (config?.version === 1) {
    policy = {
      server: { mode: 'local' },
      expo: { mode: 'local' },
      daemons: config.targets.length
        ? { mode: 'local-and-targets', targets: config.targets.map((target) => target.name) }
        : { mode: 'local' },
      commands: config.targets.length > 0
        ? automaticCommandExecution(config.targets)
        : { mode: 'local' },
    };
  } else if (config?.version !== 2 && config?.version !== 3) {
    throw new Error(`[dev-targets] unsupported configuration version: ${String(config?.version)}`);
  } else {
    policy = {
      server: { ...config.runtimePlacement.server },
      expo: { ...config.runtimePlacement.expo },
      daemons: { ...config.runtimePlacement.daemon },
      commands: { ...config.commandExecution },
    };
  }
  if (targetsEnabled !== false) return policy;
  if (serverRequested && policy.server.mode === 'prefer-target') {
    throw new Error(
      '[dev-targets] --no-dev-targets cannot bypass persisted remote server placement; '
      + 'keep target execution enabled or set runtimePlacement.server to local',
    );
  }
  return {
    server: { mode: 'local' },
    expo: { mode: 'local' },
    daemons: { mode: 'local' },
    commands: { mode: 'local' },
  };
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
